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
    LIVE_LITE_FAMILY_ALLOWLIST: z.string().optional(),
    LIVE_LITE_MAX_FAMILIES: z.coerce.number().int().positive().optional(),
    LIVE_LITE_MAX_OPEN_VALUE_USDC: z.coerce.number().positive().optional(),
    LIVE_LITE_MAX_ORDER_USDC: z.coerce.number().positive().optional(),
    LIVE_LITE_MAX_ACTIVE_MARKETS: z.coerce.number().int().positive().optional(),
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

    if (data.RUNTIME_MODE === "live-lite") {
      for (const field of [
        "LIVE_LITE_FAMILY_ALLOWLIST",
        "LIVE_LITE_MAX_FAMILIES",
        "LIVE_LITE_MAX_OPEN_VALUE_USDC",
        "LIVE_LITE_MAX_ORDER_USDC",
        "LIVE_LITE_MAX_ACTIVE_MARKETS",
      ] as const) {
        if (!data[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required when RUNTIME_MODE is "live-lite"`,
          });
        }
      }

      if (data.LIVE_LITE_FAMILY_ALLOWLIST && data.LIVE_LITE_MAX_FAMILIES) {
        const allowlist = data.LIVE_LITE_FAMILY_ALLOWLIST.split(",").map(s => s.trim()).filter(Boolean);
        if (allowlist.length > data.LIVE_LITE_MAX_FAMILIES) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["LIVE_LITE_FAMILY_ALLOWLIST"],
            message: `allowlist length ${allowlist.length} exceeds maxFamilies ${data.LIVE_LITE_MAX_FAMILIES}`,
          });
        }
      }
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
  liveLite?: {
    familyAllowlist: string[];
    maxFamilies: number;
    maxOpenValueUsdc: number;
    maxOrderUsdc: number;
    maxActiveMarkets: number;
  };
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

  const liveLite = env.RUNTIME_MODE === "live-lite" && env.LIVE_LITE_FAMILY_ALLOWLIST
    ? {
        familyAllowlist: env.LIVE_LITE_FAMILY_ALLOWLIST.split(",").map(s => s.trim()).filter(Boolean),
        maxFamilies: env.LIVE_LITE_MAX_FAMILIES!,
        maxOpenValueUsdc: env.LIVE_LITE_MAX_OPEN_VALUE_USDC!,
        maxOrderUsdc: env.LIVE_LITE_MAX_ORDER_USDC!,
        maxActiveMarkets: env.LIVE_LITE_MAX_ACTIVE_MARKETS!,
      }
    : undefined;

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
    liveLite,
  };
}
