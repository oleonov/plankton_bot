/**
 * Dual-mechanism auth hook: session cookie OR Bearer API key.
 *
 * Bypass list (no auth required):
 *   GET  /api/v1/health
 *   POST /api/v1/auth/login
 *   POST /api/v1/auth/logout
 *
 * Fail-closed: if neither session auth nor API key is configured,
 * all protected routes return 401.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import crypto from "node:crypto";
import { fail } from "./errors.js";

/**
 * Resolve the actor identity for audit attribution.
 *   - Session auth → username from session (set at login)
 *   - Bearer API key → "api_key"
 *   - Fallback → "operator"
 */
export function getActor(request: FastifyRequest): string {
  // Session auth — username stored at login
  const sessionUser = request.session?.get("username") as string | undefined;
  if (sessionUser) return sessionUser;

  // Bearer API key auth
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return "api_key";

  return "operator";
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

interface AuthConfig {
  apiKey: string | undefined;
  authPasswordConfigured: boolean;
}

const BYPASS_ROUTES: Array<{ method: string; url: string }> = [
  { method: "GET", url: "/api/v1/health" },
  { method: "GET", url: "/api/v1/auth/config" },
  { method: "POST", url: "/api/v1/auth/login" },
  { method: "POST", url: "/api/v1/auth/logout" },
];

export function createAuthHook(config: AuthConfig) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.url.startsWith("/api/")) return;

    // Check bypass list using registered route pattern + method
    // Fastify auto-generates HEAD handlers for GET routes, so treat HEAD as GET
    const routeUrl = request.routeOptions?.url;
    const method = request.method === "HEAD" ? "GET" : request.method;
    if (routeUrl && BYPASS_ROUTES.some((r) => r.method === method && r.url === routeUrl)) {
      return;
    }

    // 1. Check session cookie — only valid when password auth is configured
    if (config.authPasswordConfigured && request.session?.get("authenticated") === true) {
      return;
    }

    // 2. Check Bearer token
    if (config.apiKey) {
      const header = request.headers.authorization;
      if (header?.startsWith("Bearer ") && constantTimeEqual(header.slice(7), config.apiKey)) {
        return;
      }
    }

    // 3. Fail-closed
    if (!config.apiKey && !config.authPasswordConfigured) {
      reply
        .status(401)
        .send(
          fail("AUTH_NOT_CONFIGURED", "no authentication method is configured — API is locked"),
        );
      return;
    }

    reply.status(401).send(fail("UNAUTHORIZED", "invalid or missing credentials"));
  };
}
