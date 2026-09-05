import "dotenv/config";
import express from "express";
import {
  createMcpServerHandler,
  descopeMcpAuthRouter,
  defineTool,
  DescopeMcpProvider,
} from "@descope/mcp-express";
import { z } from "zod";

const app = express();

app.use(express.json({ limit: "1mb" }));

const rawServerUrl = process.env.SERVER_URL;
const discoveryUrl =
  process.env.DESCOPE_MCP_SERVER_WELL_KNOWN_URL;

if (!rawServerUrl) {
  throw new Error("SERVER_URL is required");
}

if (!discoveryUrl) {
  throw new Error(
    "DESCOPE_MCP_SERVER_WELL_KNOWN_URL is required",
  );
}

const serverUrl = rawServerUrl.replace(/\/+$/, "");

if (!serverUrl.endsWith("/mcp")) {
  throw new Error("SERVER_URL must end with /mcp");
}

const TOOL_SCOPES = Object.freeze({
  hello: ["weather:read"],
  create_alert_test: ["weather:alerts"],
});

const provider = new DescopeMcpProvider({
  serverUrl,
  descopeMcpServerWellKnownUrl: discoveryUrl,

  // @descope/mcp-express 1.6.0 currently accepts
  // a single audience value at runtime.
  verifyTokenOptions: {
    audience: serverUrl,
  },

  // The SDK also uses these values when publishing
  // Protected Resource Metadata.
  dynamicClientRegistrationOptions: {
    attributeScopes: [],
    permissionScopes: [
      {
        name: "weather:read",
        description: "Read current weather information",
      },
      {
        name: "weather:alerts",
        description: "Create weather alerts",
      },
    ],
  },
});

const hello = defineTool({
  name: "hello",
  description: "Test weather read access",
  input: {
    name: z.string().optional(),
  },
  scopes: TOOL_SCOPES.hello,
  handler: async ({ name }, extra) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          message: `Hello ${name ?? "there"}`,
          scopes: extra.authInfo.scopes,
        }),
      },
    ],
  }),
});

const createAlertTest = defineTool({
  name: "create_alert_test",
  description:
    "Test progressive authorization for weather alerts",
  input: {
    city: z.string(),
  },
  scopes: TOOL_SCOPES.create_alert_test,
  handler: async ({ city }, extra) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          message: `Alert created for ${city}`,
          scopes: extra.authInfo.scopes,
        }),
      },
    ],
  }),
});

function progressiveScopeChallenge(req, res, next) {
  if (
    !req.body ||
    Array.isArray(req.body) ||
    req.body.method !== "tools/call"
  ) {
    return next();
  }

  const toolName = req.body?.params?.name;
  const requiredScopes = TOOL_SCOPES[toolName] ?? [];
  const grantedScopes = req.auth?.scopes ?? [];

  const missingScopes = requiredScopes.filter(
    (scope) => !grantedScopes.includes(scope),
  );

  if (!missingScopes.length) {
    return next();
  }

  const requestedScopes = [
    ...new Set([...grantedScopes, ...requiredScopes]),
  ];

  const resourceMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource",
    serverUrl,
  ).href;

  res.setHeader(
    "WWW-Authenticate",
    `Bearer error="insufficient_scope", ` +
      `error_description="Additional authorization required", ` +
      `scope="${requestedScopes.join(" ")}", ` +
      `resource_metadata="${resourceMetadataUrl}"`,
  );

  return res.status(403).json({
    error: "insufficient_scope",
    error_description:
      `Missing required scopes: ${missingScopes.join(" ")}`,
  });
}

const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:6274",
  "http://localhost:6274",
]);

app.use("/mcp", (req, res, next) => {
  const origin = req.headers.origin;

  res.vary("Origin");

  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({
        error: "origin_not_allowed",
      });
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, GET, DELETE, OPTIONS",
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    [
      "Authorization",
      "Content-Type",
      "MCP-Protocol-Version",
      "MCP-Session-Id",
      "Last-Event-ID",
      "Accept",
    ].join(", "),
  );

  res.setHeader(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate",
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Resource-server metadata and bearer authentication.
// Descope remains the authorization server.
app.use(descopeMcpAuthRouter(undefined, provider));

const mcpHandler = createMcpServerHandler(
  {
    name: "descope-mcp-server",
    version: "1.0.0",
  },
  (server) => {
    hello(server);
    createAlertTest(server);
  },
  provider.options,
);

app.post(
  "/mcp",
  progressiveScopeChallenge,
  mcpHandler,
);

app.all("/mcp", (req, res) => {
  res.setHeader("Allow", "POST, OPTIONS");

  return res.status(405).json({
    error: "method_not_allowed",
    error_description:
      `Method "${req.method}" is not supported by this stateless MCP endpoint`,
  });
});

const port = process.env.PORT || 3001;

app.listen(port, "0.0.0.0", () => {
  console.log(`MCP server listening on port ${port}`);
  console.log(`MCP resource: ${serverUrl}`);
});
