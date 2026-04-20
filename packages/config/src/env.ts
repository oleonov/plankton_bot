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
    MARKET_DATA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    MARKET_DATA_STALE_THRESHOLD_MS: z.coerce.number().int().positive().default(120_000),
    MARKET_SCAN_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 60 * 1000),
    GAMMA_TAG_ID: z.coerce.number().int().positive().optional(),
    STRATEGY_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(12_000),
    FILL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    INVENTORY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
    ENABLE_INVENTORY_AUTO_MERGE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    EXECUTION_MAX_CONCURRENCY: z.coerce.number().int().positive().default(16),
    EXECUTION_WALLET_BUFFER_PCT: z.coerce.number().nonnegative().max(1).default(0.03),
    EXECUTION_WALLET_BUFFER_MIN_USDC: z.coerce.number().nonnegative().default(0.25),
    ALLOW_SELL_SIZE_CLAMP: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    POLY_API_KEY: z.string().optional(),
    POLY_API_SECRET: z.string().optional(),
    POLY_PASSPHRASE: z.string().optional(),
    POLY_BUILDER_API_KEY: z.string().optional(),
    POLY_BUILDER_SECRET: z.string().optional(),
    POLY_BUILDER_PASSPHRASE: z.string().optional(),
    POLY_PRIVATE_KEY: z.string().optional(),
    POLYMARKET_RELAYER_URL: z.string().url().default("https://relayer-v2.polymarket.com"),
    POLYGON_RPC_URL: z.string().url().default("https://polygon-rpc.com"),
    POLYGON_RPC_FALLBACK_URL: z.string().url().optional(),
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
  marketDataPollIntervalMs: number;
  marketDataStaleThresholdMs: number;
  marketScanIntervalMs: number;
  gammaTagId?: number | undefined;
  strategyScanIntervalMs: number;
  fillPollIntervalMs: number;
  inventorySweepIntervalMs?: number;
  enableInventoryAutoMerge: boolean;
  executionMaxConcurrency: number;
  executionWalletBufferPct: number;
  executionWalletBufferMinUsdc: number;
  allowSellSizeClamp: boolean;
  polyApiKey: string | undefined;
  polyApiSecret: string | undefined;
  polyPassphrase: string | undefined;
  polyBuilderApiKey?: string | undefined;
  polyBuilderSecret?: string | undefined;
  polyBuilderPassphrase?: string | undefined;
  polyPrivateKey: string | undefined;
  polymarketRelayerUrl?: string | undefined;
  polygonRpcUrl?: string | undefined;
  polygonRpcFallbackUrl?: string | undefined;
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
    marketDataPollIntervalMs: env.MARKET_DATA_POLL_INTERVAL_MS,
    marketDataStaleThresholdMs: env.MARKET_DATA_STALE_THRESHOLD_MS,
    marketScanIntervalMs: env.MARKET_SCAN_INTERVAL_MS,
    gammaTagId: env.GAMMA_TAG_ID,
    strategyScanIntervalMs: env.STRATEGY_SCAN_INTERVAL_MS,
    fillPollIntervalMs: env.FILL_POLL_INTERVAL_MS,
    inventorySweepIntervalMs: env.INVENTORY_SWEEP_INTERVAL_MS,
    enableInventoryAutoMerge: env.ENABLE_INVENTORY_AUTO_MERGE,
    executionMaxConcurrency: env.EXECUTION_MAX_CONCURRENCY,
    executionWalletBufferPct: env.EXECUTION_WALLET_BUFFER_PCT,
    executionWalletBufferMinUsdc: env.EXECUTION_WALLET_BUFFER_MIN_USDC,
    allowSellSizeClamp: env.ALLOW_SELL_SIZE_CLAMP,
    polyApiKey: env.POLY_API_KEY,
    polyApiSecret: env.POLY_API_SECRET,
    polyPassphrase: env.POLY_PASSPHRASE,
    polyBuilderApiKey: env.POLY_BUILDER_API_KEY,
    polyBuilderSecret: env.POLY_BUILDER_SECRET,
    polyBuilderPassphrase: env.POLY_BUILDER_PASSPHRASE,
    polyPrivateKey: env.POLY_PRIVATE_KEY,
    polymarketRelayerUrl: env.POLYMARKET_RELAYER_URL,
    polygonRpcUrl: env.POLYGON_RPC_URL,
    polygonRpcFallbackUrl: env.POLYGON_RPC_FALLBACK_URL,
    planktonApiKey: env.PLANKTON_API_KEY,
    planktonApiPort: env.PLANKTON_API_PORT,
    planktonAuthUsername: env.PLANKTON_AUTH_USERNAME,
    planktonAuthPassword: env.PLANKTON_AUTH_PASSWORD,
    planktonSessionSecret: env.PLANKTON_SESSION_SECRET,
    trustProxy: env.TRUST_PROXY,
  };
}
