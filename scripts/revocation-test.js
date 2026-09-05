import "dotenv/config";
import { createInterface } from "node:readline/promises";

import {
  DEFAULT_CIMD_CLIENT_ID,
  authorizeWithCimd,
  decodeJwtPayload,
  initializeMcp,
  refreshAccessToken,
} from "./lib/oauth-cimd.js";

const serverUrl = process.env.SERVER_URL;

if (!serverUrl) {
  throw new Error("SERVER_URL is required");
}

const clientId =
  process.env.CIMD_CLIENT_ID ??
  DEFAULT_CIMD_CLIENT_ID;

console.log("=== CIMD REVOCATION TEST ===");

const auth = await authorizeWithCimd({
  serverUrl,
  clientId,
  scopes: ["openid", "weather:read"],
});

if (!auth.refreshToken) {
  throw new Error(
    "Authorization did not return a refresh token",
  );
}

const claims = decodeJwtPayload(
  auth.accessToken,
);

console.log(
  JSON.stringify(
    {
      subject: claims.sub ?? null,
      audience: claims.aud,
      scope: claims.scope,
      expires_at: claims.exp,
      refresh_token_issued: true,
    },
    null,
    2,
  ),
);

const before = await initializeMcp(
  serverUrl,
  auth.accessToken,
);

console.log(
  `MCP request before revocation: HTTP ${before.status}`,
);

if (before.status !== 200) {
  throw new Error(
    `Expected HTTP 200 before revocation, got ${before.status}`,
  );
}

const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
});

await readline.question(
  "\nIn Descope Agentic Identity, revoke the newest " +
    '"Weather MCP Inspector Client" access created by this run. ' +
    "Then press Enter here.",
);

readline.close();

const afterAccess = await initializeMcp(
  serverUrl,
  auth.accessToken,
);

console.log(
  `Original access token after revocation: HTTP ${afterAccess.status}`,
);

const refresh = await refreshAccessToken({
  tokenEndpoint:
    auth.authorizationMetadata.token_endpoint,
  clientId,
  refreshToken: auth.refreshToken,
  serverUrl,
});

console.log(
  `Refresh after revocation: HTTP ${refresh.status}`,
);
console.log(refresh.body);

if (afterAccess.status !== 200) {
  throw new Error(
    "Expected the already-issued access token to remain valid " +
      "until its expiry window ends",
  );
}

if (refresh.ok) {
  throw new Error(
    "Expected refresh to fail after delegated consent revocation",
  );
}

console.log("REVOCATION TEST PASS");