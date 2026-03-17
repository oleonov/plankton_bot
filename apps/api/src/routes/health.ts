import type { FastifyPluginAsync } from "fastify";
import { ok } from "../errors.js";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    return ok({ status: "ok", uptime: process.uptime() });
  });
};
