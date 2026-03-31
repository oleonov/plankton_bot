/**
 * Fastify server factory — builds and configures the API server.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import secureSession from "@fastify/secure-session";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import type { AppConfig } from "@plankton/config";
import type { LedgerPool } from "./ledger-pool.js";
import { createAuthHook } from "./auth.js";
import { fail } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
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
import { pnlSeriesRoutes } from "./routes/pnl-series.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { configRoutes } from "./routes/config.js";
import { profileRoutes } from "./routes/profiles.js";
import { auditRoutes } from "./routes/audit.js";

export interface ServerDeps {
  config: AppConfig;
  controlDb: Database.Database;
  ledgerDb: Database.Database;
  ledgerPool: LedgerPool;
}

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: false, trustProxy: deps.config.trustProxy });

  await app.register(cors, { origin: true });

  // Session auth — only registered if password is configured
  if (deps.config.planktonSessionSecret) {
    await app.register(secureSession, {
      cookieName: "plankton_session",
      key: Buffer.from(deps.config.planktonSessionSecret, "hex"),
      expiry: 15 * 24 * 60 * 60,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/api",
        maxAge: 15 * 24 * 60 * 60,
      },
    });
  }

  await app.register(rateLimit, { global: false });

  // Auth hook — dual mechanism (session cookie OR Bearer API key)
  const authenticate = createAuthHook({
    apiKey: deps.config.planktonApiKey,
    authPasswordConfigured: !!deps.config.planktonAuthPassword,
  });
  app.addHook("onRequest", authenticate);

  // Error handler
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    const status = error.statusCode ?? 500;
    const code = (error as any).code ?? (status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR");
    reply.status(status).send(fail(code, error.message));
  });

  // Routes — each receives only the DB(s) it needs
  await app.register(authRoutes, {
    prefix: "/api/v1",
    username: deps.config.planktonAuthUsername,
    password: deps.config.planktonAuthPassword,
  });
  await app.register(healthRoutes, { prefix: "/api/v1" });

  const staleMs = deps.config.marketDataStaleThresholdMs;

  // Control-only routes
  await app.register(actionRoutes, { prefix: "/api/v1", db: deps.controlDb });
  await app.register(configRoutes, { prefix: "/api/v1", controlDb: deps.controlDb });

  // Status — ledger for metrics, control for current profile
  await app.register(statusRoutes, {
    prefix: "/api/v1",
    db: deps.ledgerDb,
    controlDb: deps.controlDb,
    marketDataStaleThresholdMs: staleMs,
  });
  await app.register(positionRoutes, { prefix: "/api/v1", db: deps.ledgerDb });
  await app.register(orderRoutes, { prefix: "/api/v1", db: deps.ledgerDb });
  await app.register(fillRoutes, { prefix: "/api/v1", db: deps.ledgerDb });
  await app.register(eventsRoutes, {
    prefix: "/api/v1",
    controlDb: deps.controlDb,
    ledgerDb: deps.ledgerDb,
    marketDataStaleThresholdMs: staleMs,
  });
  await app.register(riskEventsRoutes, { prefix: "/api/v1", db: deps.ledgerDb });
  await app.register(pnlSeriesRoutes, { prefix: "/api/v1", db: deps.ledgerDb });

  // Mixed routes — pass both
  await app.register(familyRoutes, {
    prefix: "/api/v1",
    controlDb: deps.controlDb,
    ledgerDb: deps.ledgerDb,
  });
  await app.register(discoveryRoutes, {
    prefix: "/api/v1",
    controlDb: deps.controlDb,
    ledgerDb: deps.ledgerDb,
  });
  await app.register(metricsRoutes, {
    prefix: "/api/v1",
    controlDb: deps.controlDb,
    ledgerDb: deps.ledgerDb,
  });
  await app.register(profileRoutes, {
    prefix: "/api/v1",
    controlDb: deps.controlDb,
    ledgerDb: deps.ledgerDb,
    ledgerPool: deps.ledgerPool,
  });
  await app.register(auditRoutes, { prefix: "/api/v1", controlDb: deps.controlDb });

  // Serve web UI static files in production
  const webDistPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: "/",
      wildcard: false,
    });

    // SPA fallback — serve index.html for non-API routes
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.status(404).send(fail("NOT_FOUND", `route ${request.url} not found`));
      } else {
        reply.sendFile("index.html");
      }
    });
  }

  return app;
}
