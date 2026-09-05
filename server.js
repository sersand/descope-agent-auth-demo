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
  get_weather: ["weather:read"],
  create_weather_alert: ["weather:alerts"],
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

const weatherDescriptions = Object.freeze({
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
});

async function geocodeCity(city) {
  const url = new URL(
    "https://geocoding-api.open-meteo.com/v1/search",
  );

  url.searchParams.set("name", city);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Geocoding request failed with HTTP ${response.status}`,
    );
  }

  const data = await response.json();
  const location = data.results?.[0];

  if (!location) {
    throw new Error(`No location found for "${city}"`);
  }

  return location;
}

async function fetchCurrentWeather(location) {
  const url = new URL(
    "https://api.open-meteo.com/v1/forecast",
  );

  url.searchParams.set("latitude", location.latitude);
  url.searchParams.set("longitude", location.longitude);
  url.searchParams.set(
    "current",
    [
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "precipitation",
      "weather_code",
      "wind_speed_10m",
    ].join(","),
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", "auto");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Weather request failed with HTTP ${response.status}`,
    );
  }

  const data = await response.json();

  if (!data.current) {
    throw new Error("Weather response did not include current conditions");
  }

  return data;
}

const getWeather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  input: {
    city: z.string().min(2),
  },
  scopes: TOOL_SCOPES.get_weather,
  handler: async ({ city }, extra) => {
    try {
      const location = await geocodeCity(city);
      const weather = await fetchCurrentWeather(location);
      const current = weather.current;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              city: location.name,
              region: location.admin1 ?? null,
              country: location.country ?? null,
              condition:
                weatherDescriptions[current.weather_code] ??
                `Weather code ${current.weather_code}`,
              temperature_f: current.temperature_2m,
              apparent_temperature_f:
                current.apparent_temperature,
              relative_humidity_percent:
                current.relative_humidity_2m,
              precipitation_in: current.precipitation,
              wind_speed_mph: current.wind_speed_10m,
              observed_at: current.time,
              timezone: weather.timezone,
              scopes: extra.authInfo.scopes,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "weather_lookup_failed",
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown weather lookup error",
            }),
          },
        ],
      };
    }
  },
});

const weatherAlerts = [];

const createWeatherAlert = defineTool({
  name: "create_weather_alert",
  description:
    "Create a demo weather alert stored in server memory",
  input: {
    city: z.string().min(2),
    condition: z.string().min(2).optional(),
  },
  scopes: TOOL_SCOPES.create_weather_alert,
  handler: async ({ city, condition }, extra) => {
    const alert = {
      id: weatherAlerts.length + 1,
      city,
      condition: condition ?? "severe weather",
      created_at: new Date().toISOString(),
    };

    weatherAlerts.push(alert);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            message: `Weather alert created for ${city}`,
            alert,
            persistence:
              "In-memory demo only. Alerts are cleared when the server restarts.",
            scopes: extra.authInfo.scopes,
          }),
        },
      ],
    };
  },
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
    "WWW-Authenticate",
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// The resource server publishes Protected Resource Metadata.
// Authorization Server metadata is discovered from the Descope
// issuer listed in that document, not from this resource origin.
app.get(
  "/.well-known/oauth-authorization-server",
  (_req, res) => {
    return res.status(404).json({
      error: "authorization_server_metadata_not_hosted_here",
    });
  },
);

// Resource-server metadata and bearer authentication.
// Descope remains the authorization server.
app.use(descopeMcpAuthRouter(undefined, provider));

const mcpHandler = createMcpServerHandler(
  {
    name: "descope-mcp-server",
    version: "1.0.0",
  },
  (server) => {
    getWeather(server);
    createWeatherAlert(server);
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


