# Descope MCP Agent Authentication Demo

This repository accompanies a developer walkthrough for protecting a remote Model Context Protocol (MCP) server with Descope.

The implementation uses:

- Node.js 24
- Express
- @descope/mcp-express 1.6.0
- Streamable HTTP
- MCP Inspector 2.5.0
- Descope OAuth
- Client ID Metadata Document (CIMD)
- tool-level scopes
- progressive authorization

## Architecture

The MCP server runs as an OAuth resource server. Descope is the authorization server.

The demo starts with:

- weather:read for the initial authorization
- weather:alerts when the client calls the protected alert tool

MCP Inspector is the reader-facing client.

## Environment variables

Copy .env.example to .env and supply your Descope MCP Server values.

SERVER_URL must be the exact public MCP Server URL configured in Descope and must end in /mcp.

Example values:

SERVER_URL=https://your-service.onrender.com/mcp
DESCOPE_MCP_SERVER_WELL_KNOWN_URL=https://api.descope.com/v1/apps/agentic/<project-id>/<mcp-server-id>/.well-known/openid-configuration
PORT=3001

Do not commit .env.

## Install

Run:

npm ci

## Run

Run:

npm start

## Descope configuration

Create an MCP Server in the Descope Console.

Configure its MCP Server URL to match SERVER_URL exactly.

Add these scopes:

weather:read
Read current weather information
Mandatory: Yes

weather:alerts
Create weather alerts
Mandatory: No

Enable Client ID Metadata Document support for the MCP Server.

The public CIMD document is stored in docs/client-metadata.json.

## Progressive authorization

@descope/mcp-express 1.6.0 enforces scopes declared on individual tools.

In the tested version, a missing tool scope is returned as an MCP tool error. MCP Inspector needs an HTTP 403 insufficient_scope challenge to initiate automatic step-up authorization.

For that reason, server.js contains a small HTTP challenge layer before the MCP request handler. The SDK tool-level scope check remains the authorization boundary.

## Deployment

The tested remote deployment uses Render.

Build command:

npm ci

Start command:

npm start

Set the same environment variables shown in .env.example.

The public service URL configured in Descope must match SERVER_URL exactly, including /mcp.

## Status

This branch is the technical validation build. The final tutorial implementation will replace the disposable hello and create_alert_test tools with the canonical weather tools after the architecture is frozen.
