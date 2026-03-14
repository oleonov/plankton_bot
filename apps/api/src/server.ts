/**
 * Fastify server factory — builds and configures the API server.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { createAuthHook } from "./auth.js";
import { fail } from "./errors.js";
import { healthRoutes } from "./routes/health.js";
import { statusRoutes } from "./routes/status.js";
import { familyRoutes } from "./routes/families.js";
import { positionRoutes } from "./routes/positions.js";
import { orderRoutes } from "./routes/orders.js";
import { fillRoutes } from "./routes/fills.js";
import { metricsRoutes } from "./routes/metrics.js";
import { actionRoutes } from "./routes/actions.js";
import { eventsRoutes } from "./routes/events.js";
import { riskEventsRoutes } from "./routes/risk-events.js";

export interface ServerDeps {
  config: AppConfig;
  conn: DbConnection;
}

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  // Auth hook — skip for /api/v1/health
  const authenticate = createAuthHook(deps.config.planktonApiKey);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/api/v1/health") return;
    await authenticate(request, reply);
  });

  // Error handler
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    const status = error.statusCode ?? 500;
    const code = (error as any).code ?? (status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR");
    reply.status(status).send(fail(code, error.message));
  });

  // Routes
  const db = deps.conn.db;
  await app.register(healthRoutes, { prefix: "/api/v1" });
  const staleMs = deps.config.marketDataStaleThresholdMs;
  await app.register(statusRoutes, { prefix: "/api/v1", db, marketDataStaleThresholdMs: staleMs });
  await app.register(familyRoutes, { prefix: "/api/v1", db });
  await app.register(positionRoutes, { prefix: "/api/v1", db });
  await app.register(orderRoutes, { prefix: "/api/v1", db });
  await app.register(fillRoutes, { prefix: "/api/v1", db });
  await app.register(metricsRoutes, { prefix: "/api/v1", db });
  await app.register(actionRoutes, { prefix: "/api/v1", db });
  await app.register(eventsRoutes, { prefix: "/api/v1", db, apiKey: deps.config.planktonApiKey, marketDataStaleThresholdMs: staleMs });
  await app.register(riskEventsRoutes, { prefix: "/api/v1", db });

  return app;
}
