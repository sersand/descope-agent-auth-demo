import "dotenv/config";

import {
  DEFAULT_CIMD_CLIENT_ID,
  authorizeWithCimd,
  decodeJwtPayload,
  initializeMcp,
  sleep,
} from "./lib/oauth-cimd.js";

const serverUrl = process.env.SERVER_URL;

if (!serverUrl) {
  throw new Error("SERVER_URL is required");
}

const clientId =
  process.env.CIMD_CLIENT_ID ??
  DEFAULT_CIMD_CLIENT_ID;

console.log("=== CIMD EXPIRY TEST ===");

const auth = await authorizeWithCimd({
  serverUrl,
  clientId,
  scopes: ["openid", "weather:read"],
});

const claims = decodeJwtPayload(
  auth.accessToken,
);

const lifetimeSeconds =
  typeof claims.exp === "number" &&
  typeof claims.iat === "number"
    ? claims.exp - claims.iat
    : null;

console.log(
  JSON.stringify(
    {
      issuer: claims.iss,
      audience: claims.aud,
      scope: claims.scope,
      issued_at: claims.iat,
      expires_at: claims.exp,
      lifetime_seconds: lifetimeSeconds,
      token_endpoint_expires_in:
        auth.tokenResponse.expires_in ?? null,
      refresh_token_issued:
        Boolean(auth.refreshToken),
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
  `MCP request before expiry: HTTP ${before.status}`,
);

if (before.status !== 200) {
  throw new Error(
    `Expected HTTP 200 before expiry, got ${before.status}`,
  );
}

if (typeof claims.exp !== "number") {
  throw new Error(
    "JWT did not contain a numeric exp claim",
  );
}

const waitMs = Math.max(
  0,
  claims.exp * 1000 -
    Date.now() +
    15000,
);

console.log(
  `Waiting ${Math.ceil(waitMs / 1000)} seconds ` +
    "to pass token expiry and validation tolerance...",
);

await sleep(waitMs);

const after = await initializeMcp(
  serverUrl,
  auth.accessToken,
);

console.log(
  `Same access token after expiry: HTTP ${after.status}`,
);

console.log(
  `WWW-Authenticate: ${after.wwwAuthenticate}`,
);

if (after.status !== 401) {
  throw new Error(
    `Expected HTTP 401 after expiry, got ${after.status}`,
  );
}

console.log("EXPIRY TEST PASS");