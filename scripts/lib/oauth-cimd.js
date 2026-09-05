import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

export const DEFAULT_CIMD_CLIENT_ID =
  "https://sersand.github.io/descope-agent-auth-demo/client-metadata.json";

export const DEFAULT_REDIRECT_URI =
  "http://127.0.0.1:6274/oauth/callback";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} from ${url}: ${text}`,
    );
  }

  return {
    response,
    body,
  };
}

export async function discoverOAuth(serverUrl) {
  const server = new URL(serverUrl);

  const resourceMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource",
    server.origin,
  ).href;

  const { body: resourceMetadata } =
    await fetchJson(resourceMetadataUrl);

  const authorizationServer =
    resourceMetadata.authorization_servers?.[0];

  if (!authorizationServer) {
    throw new Error(
      "Protected Resource Metadata did not advertise an authorization server",
    );
  }

  const discoveryUrl =
    `${authorizationServer.replace(/\/+$/, "")}` +
    "/.well-known/openid-configuration";

  const { body: authorizationMetadata } =
    await fetchJson(discoveryUrl);

  if (!authorizationMetadata.authorization_endpoint) {
    throw new Error(
      "Authorization metadata is missing authorization_endpoint",
    );
  }

  if (!authorizationMetadata.token_endpoint) {
    throw new Error(
      "Authorization metadata is missing token_endpoint",
    );
  }

  return {
    resourceMetadataUrl,
    resourceMetadata,
    authorizationServer,
    discoveryUrl,
    authorizationMetadata,
  };
}

function openBrowser(url) {
  let child;

  if (process.platform === "win32") {
    child = spawn(
      "rundll32",
      ["url.dll,FileProtocolHandler", url],
      {
        detached: true,
        stdio: "ignore",
      },
    );
  } else if (process.platform === "darwin") {
    child = spawn("open", [url], {
      detached: true,
      stdio: "ignore",
    });
  } else {
    child = spawn("xdg-open", [url], {
      detached: true,
      stdio: "ignore",
    });
  }

  child.unref();
}

async function waitForAuthorizationCode({
  redirectUri,
  expectedState,
}) {
  const redirect = new URL(redirectUri);

  let resolveCode;
  let rejectCode;

  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(
      req.url,
      `${redirect.protocol}//${redirect.host}`,
    );

    if (requestUrl.pathname !== redirect.pathname) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Not found");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    const errorDescription =
      requestUrl.searchParams.get("error_description");

    if (error) {
      res.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("OAuth authorization failed");
      rejectCode(
        new Error(
          `${error}: ${errorDescription ?? "No description"}`,
        ),
      );
      return;
    }

    const state = requestUrl.searchParams.get("state");
    const code = requestUrl.searchParams.get("code");

    if (state !== expectedState) {
      res.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("OAuth state mismatch");
      rejectCode(new Error("OAuth state mismatch"));
      return;
    }

    if (!code) {
      res.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Missing authorization code");
      rejectCode(
        new Error("OAuth callback did not include a code"),
      );
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(
      "Authorization complete. You can return to the terminal.",
    );

    resolveCode(code);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      Number(redirect.port),
      redirect.hostname,
      resolve,
    );
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(
      () => reject(
        new Error("Timed out waiting for OAuth callback"),
      ),
      300000,
    );
  });

  try {
    return await Promise.race([
      codePromise,
      timeoutPromise,
    ]);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }
}

export async function authorizeWithCimd({
  serverUrl,
  clientId = DEFAULT_CIMD_CLIENT_ID,
  redirectUri = DEFAULT_REDIRECT_URI,
  scopes = ["openid", "weather:read"],
}) {
  const discovery = await discoverOAuth(serverUrl);

  const codeVerifier = base64url(
    crypto.randomBytes(32),
  );

  const codeChallenge = base64url(
    crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest(),
  );

  const state = base64url(
    crypto.randomBytes(24),
  );

  const authorizationUrl = new URL(
    discovery.authorizationMetadata.authorization_endpoint,
  );

  authorizationUrl.searchParams.set(
    "response_type",
    "code",
  );
  authorizationUrl.searchParams.set(
    "client_id",
    clientId,
  );
  authorizationUrl.searchParams.set(
    "redirect_uri",
    redirectUri,
  );
  authorizationUrl.searchParams.set(
    "scope",
    scopes.join(" "),
  );
  authorizationUrl.searchParams.set(
    "code_challenge",
    codeChallenge,
  );
  authorizationUrl.searchParams.set(
    "code_challenge_method",
    "S256",
  );
  authorizationUrl.searchParams.set(
    "state",
    state,
  );
  authorizationUrl.searchParams.set(
    "resource",
    serverUrl,
  );

  const callbackPromise =
    waitForAuthorizationCode({
      redirectUri,
      expectedState: state,
    });

  console.log(
    `Opening authorization in your browser:\n${authorizationUrl.href}`,
  );

  openBrowser(authorizationUrl.href);

  const code = await callbackPromise;

  const tokenRequest = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    resource: serverUrl,
  });

  const { body: tokenResponse } =
    await fetchJson(
      discovery.authorizationMetadata.token_endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body: tokenRequest,
      },
    );

  if (!tokenResponse.access_token) {
    throw new Error(
      "Token endpoint did not return an access token",
    );
  }

  return {
    ...discovery,
    clientId,
    redirectUri,
    scopes,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? null,
    tokenResponse,
  };
}

export function decodeJwtPayload(token) {
  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error(
      "Access token is not a three-part JWT",
    );
  }

  return JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  );
}

export async function initializeMcp(
  serverUrl,
  accessToken,
) {
  const response = await fetch(serverUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "descope-auth-validation",
          version: "1.0.0",
        },
      },
    }),
  });

  return {
    status: response.status,
    wwwAuthenticate:
      response.headers.get("www-authenticate"),
    body: await response.text(),
  };
}

export async function refreshAccessToken({
  tokenEndpoint,
  clientId,
  refreshToken,
  serverUrl,
}) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource: serverUrl,
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded",
    },
    body,
  });

  return {
    status: response.status,
    ok: response.ok,
    body: await response.text(),
  };
}

export function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}