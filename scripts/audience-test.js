import "dotenv/config";

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CIMD_CLIENT_ID,
  authorizeWithCimd,
  initializeMcp,
  sleep,
} from "./lib/oauth-cimd.js";

const remoteServerUrl =
  process.env.SERVER_URL;

const discoveryUrl =
  process.env
    .DESCOPE_MCP_SERVER_WELL_KNOWN_URL;

if (!remoteServerUrl) {
  throw new Error("SERVER_URL is required");
}

if (!discoveryUrl) {
  throw new Error(
    "DESCOPE_MCP_SERVER_WELL_KNOWN_URL is required",
  );
}

const clientId =
  process.env.CIMD_CLIENT_ID ??
  DEFAULT_CIMD_CLIENT_ID;

const localPort = 3001;

const localServerUrl =
  `http://127.0.0.1:${localPort}/mcp`;

console.log("=== AUDIENCE VALIDATION TEST ===");

const auth = await authorizeWithCimd({
  serverUrl: remoteServerUrl,
  clientId,
  scopes: ["openid", "weather:read"],
});

const positive = await initializeMcp(
  remoteServerUrl,
  auth.accessToken,
);

console.log(
  `Remote server with correct audience: HTTP ${positive.status}`,
);

if (positive.status !== 200) {
  throw new Error(
    `Expected remote HTTP 200, got ${positive.status}`,
  );
}

const serverFile = fileURLToPath(
  new URL("../server.js", import.meta.url),
);

const child = spawn(
  process.execPath,
  [serverFile],
  {
    env: {
      ...process.env,
      SERVER_URL: localServerUrl,
      PORT: String(localPort),
      DESCOPE_MCP_SERVER_WELL_KNOWN_URL:
        discoveryUrl,
    },
    stdio: [
      "ignore",
      "pipe",
      "pipe",
    ],
  },
);

let startupOutput = "";

child.stdout.on("data", (chunk) => {
  startupOutput += chunk.toString();
});

child.stderr.on("data", (chunk) => {
  startupOutput += chunk.toString();
});

const deadline = Date.now() + 10000;

while (
  !startupOutput.includes(
    "MCP server listening on port",
  )
) {
  if (child.exitCode !== null) {
    throw new Error(
      `Local MCP server exited early:\n${startupOutput}`,
    );
  }

  if (Date.now() > deadline) {
    child.kill();
    throw new Error(
      `Timed out starting local MCP server:\n${startupOutput}`,
    );
  }

  await sleep(100);
}

try {
  const negative = await initializeMcp(
    localServerUrl,
    auth.accessToken,
  );

  console.log(
    `Same token against wrong audience: HTTP ${negative.status}`,
  );

  console.log(
    `WWW-Authenticate: ${negative.wwwAuthenticate}`,
  );

  if (negative.status !== 401) {
    throw new Error(
      `Expected HTTP 401 for audience mismatch, got ${negative.status}`,
    );
  }

  console.log("AUDIENCE TEST PASS");
} finally {
  child.kill();
}