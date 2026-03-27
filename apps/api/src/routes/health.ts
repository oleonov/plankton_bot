import type { FastifyPluginAsync } from "fastify";
import { readFileSync } from "node:fs";
import { ok } from "../errors.js";

let gitSha: string | null = null;
try {
  gitSha = readFileSync("/app/GIT_SHA", "utf-8").trim();
} catch {
  // Not in Docker or file missing — fine
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    return ok({ status: "ok", uptime: process.uptime(), ...(gitSha ? { sha: gitSha } : {}) });
  });
};
