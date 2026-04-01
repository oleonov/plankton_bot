import type { FastifyPluginAsync } from "fastify";
import { readFileSync } from "node:fs";
import { ok } from "../errors.js";

let gitSha: string | null = null;
try {
  gitSha = readFileSync("/app/GIT_SHA", "utf-8").trim();
} catch {
  // Not in Docker or file missing — fine
}

interface DeployMeta {
  deployVersion: number;
  sha: string;
  deployedAt: string;
}

function readDeployMeta(): DeployMeta | null {
  try {
    const raw = readFileSync("/app/config/deploy-meta.json", "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.deployVersion !== "number" || typeof parsed.sha !== "string") return null;
    return {
      deployVersion: parsed.deployVersion,
      sha: parsed.sha,
      deployedAt: (parsed.deployedAt as string) ?? null,
    };
  } catch {
    return null;
  }
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    const meta = readDeployMeta();
    return ok({
      status: "ok",
      uptime: process.uptime(),
      sha: gitSha ?? meta?.sha ?? null, // prefer immutable image SHA over deploy-meta
      deployVersion: meta?.deployVersion ?? null,
      deployedAt: meta?.deployedAt ?? null,
    });
  });
};
