/**
 * Static API key auth middleware.
 *
 * All routes except GET /health require `Authorization: Bearer <key>`.
 * SSE endpoint also accepts `?token=<key>`.
 *
 * Fail-closed: if PLANKTON_API_KEY is not configured, all protected
 * routes return 401. Auth is never silently disabled.
 */

import type { FastifyRequest, FastifyReply } from "fastify";

const FAIL_CLOSED_ERROR = {
  ok: false,
  data: null,
  error: { code: "AUTH_NOT_CONFIGURED", message: "PLANKTON_API_KEY is not set — API is locked" },
  ts: "",
};

export function createAuthHook(apiKey: string | undefined) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Fail-closed: no key configured = reject everything
    if (!apiKey) {
      reply.status(401).send({ ...FAIL_CLOSED_ERROR, ts: new Date().toISOString() });
      return;
    }

    const header = request.headers.authorization;
    const queryToken = (request.query as Record<string, string>)?.token;

    const token = header?.startsWith("Bearer ")
      ? header.slice(7)
      : queryToken;

    if (!token || token !== apiKey) {
      reply.status(401).send({
        ok: false,
        data: null,
        error: { code: "UNAUTHORIZED", message: "invalid or missing API key" },
        ts: new Date().toISOString(),
      });
    }
  };
}
