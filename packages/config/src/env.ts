import path from "node:path";
import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const runtimeModeSchema = z.enum(["simulation", "paper", "live-lite"]);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const envSchema = z
  .object({
    RUNTIME_MODE: runtimeModeSchema.default("simulation"),
    LOG_LEVEL: logLevelSchema.default("info"),
    DB_PATH: z.string().default("./apps/runtime/data/plankton.db"),
    FAMILY_RULES_PATH: z.string().default("./config/family_rules.yaml"),
    MARKET_DATA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    MARKET_DATA_STALE_THRESHOLD_MS: z.coerce.number().int().positive().default(120_000),
    POLY_API_KEY: z.string().optional(),
    POLY_API_SECRET: z.string().optional(),
    POLY_PASSPHRASE: z.string().optional(),
    PLANKTON_API_KEY: z.string().optional(),
    LIVE_LITE_CONFIRM: z.string().optional(),
    PLANKTON_API_PORT: z.coerce.number().int().positive().default(3100),
  })
  .superRefine((data, ctx) => {
    if (data.RUNTIME_MODE === "live-lite" || data.RUNTIME_MODE === "paper") {
      for (const field of [
        "POLY_API_KEY",
        "POLY_API_SECRET",
        "POLY_PASSPHRASE",
      ] as const) {
        if (!data[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required when RUNTIME_MODE is "${data.RUNTIME_MODE}"`,
          });
        }
      }
    }

    if (data.RUNTIME_MODE === "live-lite" && data.LIVE_LITE_CONFIRM !== "true") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LIVE_LITE_CONFIRM"],
        message: "LIVE_LITE_CONFIRM=true is required when RUNTIME_MODE is \"live-lite\" — this is a safety gate to prevent accidental live trading",
      });
    }
  });

export interface AppConfig {
  runtimeMode: "simulation" | "paper" | "live-lite";
  logLevel: "debug" | "info" | "warn" | "error";
  dbPath: string;
  familyRulesPath: string;
  marketDataPollIntervalMs: number;
  marketDataStaleThresholdMs: number;
  polyApiKey: string | undefined;
  polyApiSecret: string | undefined;
  polyPassphrase: string | undefined;
  planktonApiKey: string | undefined;
  planktonApiPort: number;
}

function findMonorepoRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function loadEnv(envPath?: string): AppConfig {
  if (envPath !== undefined) {
    loadDotenv({ path: envPath });
  } else {
    loadDotenv();
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const messages = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${messages}`);
  }

  const env = result.data;
  const root = findMonorepoRoot();

  return {
    runtimeMode: env.RUNTIME_MODE,
    logLevel: env.LOG_LEVEL,
    dbPath: path.resolve(root, env.DB_PATH),
    familyRulesPath: path.resolve(root, env.FAMILY_RULES_PATH),
    marketDataPollIntervalMs: env.MARKET_DATA_POLL_INTERVAL_MS,
    marketDataStaleThresholdMs: env.MARKET_DATA_STALE_THRESHOLD_MS,
    polyApiKey: env.POLY_API_KEY,
    polyApiSecret: env.POLY_API_SECRET,
    polyPassphrase: env.POLY_PASSPHRASE,
    planktonApiKey: env.PLANKTON_API_KEY,
    planktonApiPort: env.PLANKTON_API_PORT,
  };
}
