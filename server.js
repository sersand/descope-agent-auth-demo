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

app.use(express.json());

const provider = new DescopeMcpProvider({
  serverUrl: process.env.SERVER_URL,
  descopeMcpServerWellKnownUrl:
    process.env.DESCOPE_MCP_SERVER_WELL_KNOWN_URL,
  verifyTokenOptions: {
    audience: process.env.SERVER_URL,
  },
});

const hello = defineTool({
  name: "hello",
  description: "Test weather read access",
  input: {
    name: z.string().optional(),
  },
  scopes: ["weather:read"],
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
  description: "Test progressive authorization for weather alerts",
  input: {
    city: z.string(),
  },
  scopes: ["weather:alerts"],
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

const toolScopes = {
  create_alert_test: ["weather:alerts"],
};

function progressiveScopeChallenge(req, res, next) {
  if (req.body?.method !== "tools/call") {
    return next();
  }

  const toolName = req.body?.params?.name;
  const requiredScopes = toolScopes[toolName] ?? [];
  const userScopes = req.auth?.scopes ?? [];

  const missingScopes = requiredScopes.filter(
    (scope) => !userScopes.includes(scope),
  );

  if (!missingScopes.length) {
    return next();
  }

  const resourceMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource",
    process.env.SERVER_URL,
  ).href;

  res.setHeader(
    "WWW-Authenticate",
    `Bearer error="insufficient_scope", ` +
      `error_description="Additional authorization required", ` +
      `scope="${missingScopes.join(" ")}", ` +
      `resource_metadata="${resourceMetadataUrl}"`,
  );

  return res.status(403).json({
    error: "insufficient_scope",
    error_description:
      `Missing required scopes: ${missingScopes.join(" ")}`,
  });
}

/*
 * Inspector runs at http://127.0.0.1:6274.
 * Handle browser CORS before Descope bearer authentication,
 * especially the unauthenticated OPTIONS preflight.
 */
app.use("/mcp", (req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "http://127.0.0.1:6274",
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS",
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
    "WWW-Authenticate, MCP-Session-Id",
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

/*
 * Keep Descope's standard metadata routes.
 *
 * With no toolRegistration callback, this also applies Descope bearer
 * authentication to /mcp and populates req.auth before our custom route.
 */
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

const port = process.env.PORT || 3001;

app.listen(port, "0.0.0.0", () => {
  console.log(`MCP server listening on port ${port}`);
  console.log(`MCP resource: ${process.env.SERVER_URL}`);
});
