# Descope Agent Authentication with MCP

This repository contains the working sample for a developer walkthrough that protects a remote Model Context Protocol (MCP) server with Descope.

The sample uses MCP Inspector as the client, a public Client ID Metadata Document (CIMD) for client registration, a remote Streamable HTTP MCP server, and progressive OAuth authorization for tool-level scopes.

## What the sample demonstrates

The MCP server exposes two tools:

- `get_weather` requires `weather:read`
- `create_weather_alert` requires `weather:alerts`

`get_weather` retrieves current conditions from Open-Meteo.

`create_weather_alert` is intentionally a small in-memory demo action. Alerts disappear when the server restarts.

The authorization flow starts with `weather:read`. When a client that has only that scope calls `create_weather_alert`, the server returns an HTTP `403 insufficient_scope` challenge. MCP Inspector reauthorizes with the union of the existing and newly required scopes.

The repository also contains reproducible checks for:

- audience validation
- access-token expiry
- delegated-consent revocation

## Tested configuration

This repository was validated with:

- Node.js 24.19.0 locally
- Node.js 24.x on Render
- `@descope/mcp-express` 1.6.0
- Express 5.2.1
- Zod 4.4.3
- dotenv 17.4.2
- MCP Inspector 2.5.0
- Streamable HTTP
- Descope OAuth
- CIMD

Dependencies used by the sample are pinned in `package-lock.json`.

## Architecture

The MCP application runs as an OAuth resource server. Descope is the authorization server.

The main discovery and authorization path is:

1. MCP Inspector connects to the remote `/mcp` endpoint.
2. An unauthenticated request receives a bearer challenge containing the Protected Resource Metadata URL.
3. Protected Resource Metadata identifies the Descope authorization server and the MCP scopes.
4. MCP Inspector uses the public CIMD document as its OAuth client ID.
5. Descope handles user authorization and consent.
6. Inspector sends the issued bearer token to the MCP server.
7. The MCP server validates the token audience and required tool scope.
8. `get_weather` calls Open-Meteo only after authorization succeeds.

Mermaid source:

- `docs/architecture.mmd`
- `docs/progressive-auth.mmd`

## Prerequisites

You need:

- a Descope account
- Node.js 24.x
- npm
- Git
- a browser
- a code editor
- a GitHub repository if you want to host your own CIMD document
- a remote Node.js host such as Render

The sample was tested on Windows with PowerShell. On other platforms, use the equivalent shell commands.

## Set up the project

Clone the repository and install the locked dependencies:

```bash
git clone https://github.com/sersand/descope-agent-auth-demo.git
cd descope-agent-auth-demo
npm ci
```

Copy the environment template:

```bash
copy .env.example .env
```

On macOS or Linux:

```bash
cp .env.example .env
```

The required values are:

```env
SERVER_URL=https://<your-service>.onrender.com/mcp
DESCOPE_MCP_SERVER_WELL_KNOWN_URL=https://api.descope.com/v1/apps/agentic/<project-id>/<mcp-server-id>/.well-known/openid-configuration
CIMD_CLIENT_ID=https://sersand.github.io/descope-agent-auth-demo/client-metadata.json
PORT=3001
```

`SERVER_URL` is security-sensitive configuration. It is also the audience value expected by the MCP resource server, so use the exact public MCP URL including `/mcp`.

Do not commit `.env`.

## Configure the MCP server in Descope

In the Descope Console, open:

`Agentic Identity Hub` → `MCP Servers`

Create an MCP server for the sample.

Set its MCP Server URL to the exact same value used for `SERVER_URL`.

Add these permission scopes:

### weather:read

Description:

`Read current weather information`

Set this scope as mandatory.

### weather:alerts

Description:

`Create weather alerts`

Leave this scope optional.

Enable Client ID Metadata Document support for the MCP server.

The sample CIMD document is:

`docs/client-metadata.json`

Its published client ID is:

`https://sersand.github.io/descope-agent-auth-demo/client-metadata.json`

If you fork this repository, host your own metadata document over HTTPS and update both `client_id` and `CIMD_CLIENT_ID`.

## Deploy the remote MCP server

The tested deployment uses Render.

Create a Node.js Web Service for the repository.

Use:

```text
Build command: npm ci
Start command: npm start
```

Configure:

```env
SERVER_URL=https://<your-service>.onrender.com/mcp
DESCOPE_MCP_SERVER_WELL_KNOWN_URL=https://api.descope.com/v1/apps/agentic/<project-id>/<mcp-server-id>/.well-known/openid-configuration
```

The Descope MCP Server URL and `SERVER_URL` must match exactly.

The server listens on the `PORT` supplied by the hosting platform.

## Protected Resource Metadata

The Descope MCP middleware publishes Protected Resource Metadata from the resource server.

For this sample it advertises:

```json
{
  "resource": "https://<your-service>.onrender.com/mcp",
  "authorization_servers": [
    "https://api.descope.com/v1/apps/agentic/<project-id>/<mcp-server-id>"
  ],
  "scopes_supported": [
    "openid",
    "weather:read",
    "weather:alerts"
  ],
  "bearer_methods_supported": [
    "header"
  ]
}
```

Authorization Server metadata is discovered from the Descope server identified by `authorization_servers`.

The resource origin does not host a second Authorization Server metadata document.

## Run MCP Inspector

MCP Inspector is the reader-facing client used by the walkthrough.

Run Inspector in a separate terminal:

```bash
npx -y @modelcontextprotocol/inspector@2.5.0
```

On Windows PowerShell, if the npm PowerShell shim is blocked:

```powershell
npx.cmd -y @modelcontextprotocol/inspector@2.5.0
```

Inspector opens at a loopback address on port `6274`.

Configure the remote server connection with:

```text
Transport: Streamable HTTP
URL: https://<your-service>.onrender.com/mcp
Scopes: openid weather:read
```

Leave per-server Client ID and Client Secret blank.

In Inspector's OAuth client settings, use the Client ID Metadata Document option and set:

```text
https://sersand.github.io/descope-agent-auth-demo/client-metadata.json
```

For insufficient-scope handling, select the option that reauthorizes with the union of existing and newly required scopes.

## Test weather read access

Connect Inspector and authorize the initial request.

Run:

```text
get_weather
city = Chicago
```

A successful result contains current weather data and an authenticated scope list containing `weather:read`.

The tested sample returned fields including:

- city
- region
- country
- condition
- temperature
- apparent temperature
- relative humidity
- precipitation
- wind speed
- observation time
- timezone

## Test progressive authorization

Start from authorization containing only `weather:read`.

Run:

```text
create_weather_alert
city = Chicago
condition = severe thunderstorms
```

The server checks the tool against the single `TOOL_SCOPES` registry.

Because `create_weather_alert` requires `weather:alerts`, the server sends an HTTP `403` challenge with `insufficient_scope`.

The challenge requests the union:

```text
weather:read weather:alerts
```

Inspector displays the existing permission as already granted and `weather:alerts` as new.

After Descope authorization completes, Inspector retries the tool call with both scopes.

The alert is stored only in server memory.

## Why the HTTP scope challenge exists

`@descope/mcp-express` 1.6.0 still declares and enforces the required scope on each tool.

In the tested version, the SDK's tool-level failure is represented inside the MCP response. MCP Inspector needs an HTTP `403 insufficient_scope` bearer challenge to begin its automatic step-up flow.

`server.js` therefore contains a small HTTP challenge layer before the MCP request handler.

The tool definition and the HTTP challenge both read their requirements from `TOOL_SCOPES`, so scope names are not maintained in separate lists.

## Validate audience enforcement

The repository includes a CIMD-based audience test:

```bash
npm run test:audience
```

The helper:

1. authorizes against the remote MCP resource using the public CIMD client
2. confirms the token works against the correct remote audience
3. starts a temporary local MCP resource with a different expected audience
4. sends the same access token to that local resource

The validated result is:

```text
Remote server with correct audience: HTTP 200
Same token against wrong audience: HTTP 401
AUDIENCE TEST PASS
```

No access token is printed.

## Validate token expiry

Run:

```bash
npm run test:expiry
```

The helper obtains an access token through the same CIMD authorization path used by the sample.

The validated token response reported:

```text
lifetime_seconds: 600
token_endpoint_expires_in: 600
```

The helper confirms the token works before expiry, waits past the JWT expiry window and validation tolerance, then sends the exact same token again.

The validated result is:

```text
MCP request before expiry: HTTP 200
Same access token after expiry: HTTP 401
EXPIRY TEST PASS
```

The 600-second value above is the measured value from the tested configuration. It is not presented as a universal Descope default.

## Validate delegated-consent revocation

Run:

```bash
npm run test:revocation
```

The helper obtains an access token and refresh token through CIMD and confirms the access token works.

It then pauses so you can open:

`Agentic Identity Hub` → `Agentic Identity`

Revoke the newest `Weather MCP Inspector Client` access created by that run, then return to the terminal and continue.

The validated result is:

```text
MCP request before revocation: HTTP 200
Original access token after revocation: HTTP 200
Refresh after revocation: HTTP 404
REVOCATION TEST PASS
```

In the tested flow, revoking delegated consent prevents the authorization from being refreshed. The already-issued stateless JWT remains accepted by the MCP resource server until its lifetime ends.

The rejected refresh returned Descope error `E063302`, indicating that the associated consent no longer existed.

## CORS and supported methods

The remote endpoint accepts browser requests from the Inspector loopback origins used by this walkthrough:

```text
http://127.0.0.1:6274
http://localhost:6274
```

The browser preflight advertises:

```text
POST, OPTIONS
```

The sample uses stateless Streamable HTTP and does not claim resumability or server notifications.

## Repository structure

```text
.
|-- .env.example
|-- package.json
|-- package-lock.json
|-- README.md
|-- server.js
|-- docs
|   |-- architecture.mmd
|   |-- client-metadata.json
|   |-- index.md
|   `-- progressive-auth.mmd
`-- scripts
    |-- audience-test.js
    |-- expiry-test.js
    |-- revocation-test.js
    `-- lib
        `-- oauth-cimd.js
```

## Security notes

The repository does not contain Descope secrets or bearer tokens.

CIMD is used as a public OAuth client registration mechanism, so the sample does not place a client secret in MCP Inspector.

The MCP resource validates the configured audience before accepting a bearer token.

Tool scopes are checked before tool execution.

Validation scripts intentionally avoid printing access and refresh tokens.

## License

See the repository license metadata.