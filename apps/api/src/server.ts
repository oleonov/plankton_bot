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
import type { AppConfig } from "@krabs/config";
import type { LedgerPool } from "./ledger-pool.js";
import { createAuthHook } from "./auth.js";
import { fail } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { statusRoutes } from "./routes/status.js";
import { positionRoutes } from "./routes/positions.js";
import { orderRoutes } from "./routes/orders.js";
import { fillRoutes } from "./routes/fills.js";
import { driftRoutes } from "./routes/drift.js";
import { metricsRoutes } from "./routes/metrics.js";
import { actionRoutes } from "./routes/actions.js";
import { eventsRoutes } from "./routes/events.js";
import { riskEventsRoutes } from "./routes/risk-events.js";
import { pnlSeriesRoutes } from "./routes/pnl-series.js";
import { portfolioSeriesRoutes } from "./routes/portfolio-series.js";
import { tradingActivityRoutes } from "./routes/trading-activity.js";
import { profileRoutes } from "./routes/profiles.js";
import { runtimePolicyRoutes } from "./routes/runtime-policy.js";
import { auditRoutes } from "./routes/audit.js";
import { selectionRulesRoutes } from "./routes/selection-rules.js";
import { marketsRoutes } from "./routes/markets.js";
import { scannerRoutes } from "./routes/scanner.js";

export interface ServerDeps {
  config: AppConfig;
  controlDb: Database.Database;
  ledgerDb: Database.Database;
  ledgerPool: LedgerPool;
  defaultInitialBalanceUsdc?: number | null | undefined;
}

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: false, trustProxy: deps.config.trustProxy });

  await app.register(cors, { origin: true });

  // Session auth — only registered if password is configured
  if (deps.config.krabsSessionSecret) {
    await app.register(secureSession, {
      cookieName: "krabs_session",
      key: Buffer.from(deps.config.krabsSessionSecret, "hex"),
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
    apiKey: deps.config.krabsApiKey,
    authPasswordConfigured: !!deps.config.krabsAuthPassword,
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
    username: deps.config.krabsAuthUsername,
    password: deps.config.krabsAuthPassword,
  });
  await app.register(healthRoutes, { prefix: "/api/v1" });

  const staleMs = deps.config.marketDataStaleThresholdMs;

  // Control-only routes
  await app.register(actionRoutes, {
    prefix: "/api/v1",
    db: deps.controlDb,
    controlDb: deps.controlDb,
    ledgerDb: deps.ledgerDb,
    ledgerPool: deps.ledgerPool,
  });
  // Status — resolves active profile's ledger via pool for consistent snapshot
  await app.register(statusRoutes, {
    prefix: "/api/v1",
    db: deps.ledgerDb,
    controlDb: deps.controlDb,
    ledgerPool: deps.ledgerPool,
    marketDataStaleThresholdMs: staleMs,
    envMode: deps.config.runtimeMode,
    defaultInitialBalanceUsdc: deps.defaultInitialBalanceUsdc,
  });
  await app.register(positionRoutes, {
    prefix: "/api/v1",
    db: deps.ledgerDb,
    controlDb: deps.controlDb,
    ledgerPool: deps.ledgerPool,
  });
  await app.register(orderRoutes, {
    prefix: "/api/v1",
    db: deps.ledgerDb,
    controlDb: deps.controlDb,
    ledgerPool: deps.ledgerPool,
  });
  await app.register(fillRoutes, {
    prefix: "/api/v1",
    db: deps.ledgerDb,
    controlDb: deps.controlDb,
    ledgerPool: deps.ledgerPool,
  });
  await app.register(driftRoutes, {
    prefix: "/api/v1",
    db: deps.ledgerDb,
    controlDb: deps.controlDb,
    ledgerPool: deps.ledgerPool,
  });
  await app.register(eventsRoutes, {
    prefix: "/api/v1",
    controlDb: deps.controlDb,
    ledgerDb: deps.ledgerDb,
    ledgerPool: deps.ledgerPool,
    marketDataStaleThresholdMs: staleMs,
  });
  await app.register(riskEventsRoutes, { prefix: "/api/v1", db: deps.ledgerDb });
  await app.register(pnlSeriesRoutes, { prefix: "/api/v1", db: deps.ledgerDb });
  await app.register(portfolioSeriesRoutes, {
    prefix: "/api/v1",
    db: deps.ledgerDb,
    controlDb: deps.controlDb,
    defaultInitialBalanceUsdc: deps.defaultInitialBalanceUsdc,
  });
  await app.register(tradingActivityRoutes, { prefix: "/api/v1", db: deps.ledgerDb });

  // Mixed routes — pass both
  await app.register(metricsRoutes, {
    prefix: "/api/v1",
    ledgerDb: deps.ledgerDb,
    ledgerPool: deps.ledgerPool,
  });
  await app.register(profileRoutes, {
    prefix: "/api/v1",
    controlDb: deps.controlDb,
    ledgerDb: deps.ledgerDb,
    ledgerPool: deps.ledgerPool,
  });
  await app.register(runtimePolicyRoutes, {
    prefix: "/api/v1",
    controlDb: deps.controlDb,
  });
  await app.register(auditRoutes, { prefix: "/api/v1", controlDb: deps.controlDb });
  await app.register(selectionRulesRoutes, {
    prefix: "/api/v1",
    controlDb: deps.controlDb,
    ledgerPool: deps.ledgerPool,
  });
  await app.register(marketsRoutes, {
    prefix: "/api/v1",
    ledgerDb: deps.ledgerDb,
    ledgerPool: deps.ledgerPool,
  });
  await app.register(scannerRoutes, {
    prefix: "/api/v1",
    ledgerDb: deps.ledgerDb,
    controlDb: deps.controlDb,
    ledgerPool: deps.ledgerPool,
  });

  // Serve web UI static files in production
  const webDistPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: "/",
      wildcard: false,
      setHeaders(res, pathName) {
        if (pathName.includes("/assets/")) {
          // Hashed filenames — safe to cache forever
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          // index.html — always revalidate to pick up new asset hashes
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    });

    // SPA fallback — serve index.html for non-API routes
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.status(404).send(fail("NOT_FOUND", `route ${request.url} not found`));
      } else {
        reply.header("Cache-Control", "no-cache");
        reply.sendFile("index.html");
      }
    });
  }

  return app;
}
