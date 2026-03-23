/**
 * Auth routes: login, logout, session check.
 */

import type { FastifyPluginAsync } from "fastify";
import { ok, fail } from "../errors.js";
import { constantTimeEqual } from "../auth.js";

interface AuthRoutesOpts {
  username: string | undefined;
  password: string | undefined;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOpts> = async (app, opts) => {
  app.post<{ Body: { username?: string; password: string } }>(
    "/auth/login",
    {
      config: {
        rateLimit: { max: 5, timeWindow: 60_000 },
      },
    },
    async (request, reply) => {
      if (!opts.password) {
        return reply
          .status(501)
          .send(fail("LOGIN_NOT_CONFIGURED", "web login is not configured — set PLANKTON_AUTH_PASSWORD"));
      }

      const { username, password } = request.body ?? {};

      if (opts.username && (!username || !constantTimeEqual(username, opts.username))) {
        return reply.status(401).send(fail("INVALID_CREDENTIALS", "invalid credentials"));
      }

      if (!password || !constantTimeEqual(password, opts.password)) {
        return reply.status(401).send(fail("INVALID_CREDENTIALS", "invalid credentials"));
      }

      request.session.set("authenticated", true);
      return reply.send(ok({ authenticated: true }));
    },
  );

  app.get("/auth/config", async (_request, reply) => {
    return reply.send(ok({ usernameRequired: !!opts.username }));
  });

  app.post("/auth/logout", async (request, reply) => {
    // Guard: session plugin may not be registered in API-key-only mode
    if (request.session) request.session.delete();
    return reply.send(ok(null));
  });

  app.get("/auth/me", async (request, reply) => {
    // Auth hook already ran — if we get here, session is valid
    return reply.send(ok({ authenticated: true }));
  });
};
