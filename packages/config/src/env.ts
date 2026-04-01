import path from "node:path";
import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const runtimeModeSchema = z.enum(["simulation", "paper", "live-lite"]);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const envSchema = z
  .object({
    RUNTIME_MODE: runtimeModeSchema.optional(),
    LOG_LEVEL: logLevelSchema.default("info"),
    DB_PATH: z.string().default("./apps/runtime/data/plankton.db"),
    BOOTSTRAP_FAMILY_RULES_PATH: z.string().optional(),
    FAMILY_RULES_PATH: z.string().default("./config/family_rules.yaml"),
    MARKET_DATA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    MARKET_DATA_STALE_THRESHOLD_MS: z.coerce.number().int().positive().default(120_000),
    STRATEGY_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    FILL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    EXECUTION_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),
    POLY_API_KEY: z.string().optional(),
    POLY_API_SECRET: z.string().optional(),
    POLY_PASSPHRASE: z.string().optional(),
    POLY_PRIVATE_KEY: z.string().optional(),
    PLANKTON_API_KEY: z.string().optional(),
    PLANKTON_API_PORT: z.coerce.number().int().positive().default(3100),
    // LIVE_LITE_* env vars removed — envelope caps now come from profile_settings in control.db
    // Kept as optional for backward compat during migration; ignored by runtime.
    PLANKTON_AUTH_USERNAME: z.string().optional(),
    PLANKTON_AUTH_PASSWORD: z.string().optional(),
    PLANKTON_SESSION_SECRET: z.string().optional(),
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .superRefine((data, ctx) => {
    // When RUNTIME_MODE is undefined, mode comes from control.db — skip env validation
    if (!data.RUNTIME_MODE) return;

    if (data.RUNTIME_MODE === "live-lite" || data.RUNTIME_MODE === "paper") {
      for (const field of ["POLY_API_KEY", "POLY_API_SECRET", "POLY_PASSPHRASE"] as const) {
        if (!data[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required when RUNTIME_MODE is "${data.RUNTIME_MODE}"`,
          });
        }
      }
    }

    if (data.RUNTIME_MODE === "live-lite") {
      for (const field of ["POLY_PRIVATE_KEY"] as const) {
        if (!data[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required when RUNTIME_MODE is "live-lite"`,
          });
        }
      }

      if (data.POLY_PRIVATE_KEY && !/^0x[0-9a-fA-F]{64}$/.test(data.POLY_PRIVATE_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["POLY_PRIVATE_KEY"],
          message: "POLY_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key",
        });
      }
    }
  });

export interface AppConfig {
  runtimeMode: "simulation" | "paper" | "live-lite" | undefined;
  logLevel: "debug" | "info" | "warn" | "error";
  dbPath: string;
  familyRulesPath: string;
  marketDataPollIntervalMs: number;
  marketDataStaleThresholdMs: number;
  strategyScanIntervalMs: number;
  fillPollIntervalMs: number;
  executionMaxConcurrency: number;
  polyApiKey: string | undefined;
  polyApiSecret: string | undefined;
  polyPassphrase: string | undefined;
  polyPrivateKey: string | undefined;
  planktonApiKey: string | undefined;
  planktonApiPort: number;
  planktonAuthUsername: string | undefined;
  planktonAuthPassword: string | undefined;
  planktonSessionSecret: string | undefined;
  trustProxy: boolean;
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
  const root = findMonorepoRoot();

  if (envPath !== undefined) {
    loadDotenv({ path: envPath });
  } else {
    loadDotenv({ path: path.join(root, ".env") });
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const messages = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${messages}`);
  }

  const env = result.data;

  return {
    runtimeMode: env.RUNTIME_MODE,
    logLevel: env.LOG_LEVEL,
    dbPath: path.resolve(root, env.DB_PATH),
    familyRulesPath: path.resolve(root, env.BOOTSTRAP_FAMILY_RULES_PATH ?? env.FAMILY_RULES_PATH),
    marketDataPollIntervalMs: env.MARKET_DATA_POLL_INTERVAL_MS,
    marketDataStaleThresholdMs: env.MARKET_DATA_STALE_THRESHOLD_MS,
    strategyScanIntervalMs: env.STRATEGY_SCAN_INTERVAL_MS,
    fillPollIntervalMs: env.FILL_POLL_INTERVAL_MS,
    executionMaxConcurrency: env.EXECUTION_MAX_CONCURRENCY,
    polyApiKey: env.POLY_API_KEY,
    polyApiSecret: env.POLY_API_SECRET,
    polyPassphrase: env.POLY_PASSPHRASE,
    polyPrivateKey: env.POLY_PRIVATE_KEY,
    planktonApiKey: env.PLANKTON_API_KEY,
    planktonApiPort: env.PLANKTON_API_PORT,
    planktonAuthUsername: env.PLANKTON_AUTH_USERNAME,
    planktonAuthPassword: env.PLANKTON_AUTH_PASSWORD,
    planktonSessionSecret: env.PLANKTON_SESSION_SECRET,
    trustProxy: env.TRUST_PROXY,
  };
}
