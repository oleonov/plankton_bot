import path from "node:path";
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const runtimeModeSchema = z.enum(["simulation", "paper", "live-lite"]);
const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const commaSeparatedUrlsSchema = z.preprocess((value) => {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}, z.array(z.string().url()).min(1).optional());

const envSchema = z
  .object({
    RUNTIME_MODE: runtimeModeSchema.optional(),
    LOG_LEVEL: logLevelSchema.default("info"),
    DB_PATH: z.string().default("./apps/runtime/data/krabs.db"),
    MARKET_DATA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    MARKET_DATA_STALE_THRESHOLD_MS: z.coerce.number().int().positive().default(120_000),
    MARKET_SCAN_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),
    MARKET_SCAN_HINT_MIN_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),
    RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
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
    EXECUTION_SELL_BALANCE_REJECT_BLOCK_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    EXECUTION_SELL_BALANCE_REJECT_BLOCK_MS: z.coerce.number().int().min(1_000).default(60_000),
    EXECUTION_SELL_EXCHANGE_RESERVED_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    SELL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60_000)
      .optional(),
    POLY_API_KEY: z.string().optional(),
    POLY_API_SECRET: z.string().optional(),
    POLY_PASSPHRASE: z.string().optional(),
    POLY_BUILDER_API_KEY: z.string().optional(),
    POLY_BUILDER_SECRET: z.string().optional(),
    POLY_BUILDER_PASSPHRASE: z.string().optional(),
    // V2 CLOB builder attribution — bytes32 from Polymarket Builder Profile.
    // Replaces HMAC builder credentials for order signing in V2.
    // Empty string (POLY_BUILDER_CODE= in .env templates) is normalized to
    // undefined so the regex doesn't fire before live-lite preflight can
    // surface a friendly LIVE_BUILDER_CODE_MISSING error.
    POLY_BUILDER_CODE: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, "POLY_BUILDER_CODE must be a 0x-prefixed 32-byte hex value")
        .optional(),
    ),
    POLY_PRIVATE_KEY: z.string().optional(),
    POLYMARKET_RELAYER_URL: z.string().url().default("https://relayer-v2.polymarket.com"),
    POLYGON_RPC_URL: z.string().url().default("https://polygon-rpc.com"),
    POLYGON_RPC_URLS: commaSeparatedUrlsSchema,
    POLYGON_RPC_FALLBACK_URL: z.string().url().optional(),
    KRABS_API_KEY: z.string().optional(),
    KRABS_API_PORT: z.coerce.number().int().positive().default(3100),
    // LIVE_LITE_* env vars removed — envelope caps now come from profile_settings in control.db
    // Kept as optional for backward compat during migration; ignored by runtime.
    KRABS_AUTH_USERNAME: z.string().optional(),
    KRABS_AUTH_PASSWORD: z.string().optional(),
    KRABS_SESSION_SECRET: z.string().optional(),
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Task 1 — bounded pricing universe
    MARKET_DATA_MAX_TRACKED_TOKENS: z.coerce.number().int().min(100).max(5_000).default(1_000),
    MARKET_DATA_MAX_WS_SHARDS: z.coerce.number().int().min(1).max(20).default(2),
    WS_WORKER_COUNT: z.coerce.number().int().min(0).max(8).default(4),
    MARKET_DATA_DISCOVERY_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(600_000)
      .default(5 * 60_000),
    MARKET_DATA_DISCOVERY_BATCH_SIZE: z.coerce.number().int().min(50).max(500).default(50),
    // Task 2 — CLOB axios agent pool bounds
    CLOB_AXIOS_MAX_SOCKETS: z.coerce.number().int().min(1).max(32).default(8),
    CLOB_AXIOS_MAX_FREE_SOCKETS: z.coerce.number().int().min(0).max(16).default(2),
    CLOB_AXIOS_IDLE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
    // Task 3 — bounded ingress queue
    MARKET_DATA_INGRESS_QUEUE_MAX: z.coerce.number().int().min(32).max(2_048).default(256),
    MARKET_DATA_INGRESS_LAG_WARN_MS: z.coerce.number().int().min(500).max(10_000).default(2_000),
    MARKET_DATA_INGRESS_OVERFLOW_POLICY: z
      .enum(["drop-oldest", "reconnect"])
      .default("drop-oldest"),
    // Task 4 — reconnect backoff + breakers
    MARKET_DATA_RECONNECT_BASE_MS: z.coerce.number().int().min(100).max(10_000).default(1_000),
    MARKET_DATA_RECONNECT_MAX_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    MARKET_DATA_SHARD_BREAKER_RECONNECTS_PER_MIN: z.coerce
      .number()
      .int()
      .min(3)
      .max(60)
      .default(10),
    MARKET_DATA_SHARD_BREAKER_OPEN_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(600_000)
      .default(120_000),
    MARKET_DATA_SHARD_BREAKER_OPEN_MAX_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(1_800_000)
      .default(600_000),
    MARKET_DATA_CIRCUIT_SHARD_OPEN_PERCENT: z.coerce.number().int().min(20).max(100).default(50),
    MARKET_DATA_CIRCUIT_OPEN_SHARD_FLOOR: z.coerce.number().int().min(1).max(20).default(3),
    MARKET_DATA_CIRCUIT_OPEN_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
    MARKET_DATA_STREAM_STABLE_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
    // Task 5 — capped rolling poll fallback
    MARKET_DATA_FALLBACK_BATCH_SIZE: z.coerce.number().int().min(100).max(1_000).default(500),
    MARKET_DATA_FALLBACK_POLL_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(50),
    MARKET_DATA_FALLBACK_POLL_RATE_PER_SEC: z.coerce.number().min(0.1).max(100).default(5),
    MARKET_DATA_STALE_TOKEN_AGE_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    // Phase E.2 — decision evaluation worker pool.
    ALGO_DECISION_WORKER_COUNT: z.coerce
      .number()
      .int()
      .min(0)
      .max(32)
      .default(Math.max(1, cpus().length - 1)),
    ALGO_DECISION_WORKER_BATCH_SIZE: z.coerce.number().int().min(10).max(1_000).default(100),
    // ADR-015 — DEAD_SIDE_GUARD_* and EXECUTION_PRICING_* env vars were removed.
    // Dead-side guard + pricing policy now live in `profile_settings.execution_policy_json`
    // and hot-reload via `runtime_control_state.execution_policy_version`. See
    // docs/adr/015-db-backed-execution-policy.md.
    // ADR-018 (Step 1) — Universe-filter funnel log cadence (post-normalization).
    UNIVERSE_FUNNEL_LOG_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(3_600_000)
      .default(60_000),
    // v063 — ledger DB size guard. Safety net that pauses the bot if the ledger
    // file outgrows the disk faster than retention can sweep it (see
    // research_plankton/krabs_russia_ticker_rate_investigation_2026-05-24.md).
    DB_SIZE_GUARD_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    DB_SIZE_GUARD_THRESHOLD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 1024 * 1024 * 1024),
    DB_SIZE_GUARD_CHECK_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
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
  marketScanHintMinIntervalMs: number;
  reconciliationIntervalMs: number;
  gammaTagId?: number | undefined;
  strategyScanIntervalMs: number;
  fillPollIntervalMs: number;
  inventorySweepIntervalMs?: number;
  enableInventoryAutoMerge: boolean;
  executionMaxConcurrency: number;
  executionWalletBufferPct: number;
  executionWalletBufferMinUsdc: number;
  allowSellSizeClamp: boolean;
  executionSellBalanceRejectBlockEnabled: boolean;
  executionSellBalanceRejectBlockMs: number;
  executionSellExchangeReservedEnabled: boolean;
  sellTimeoutMs?: number | undefined;
  polyApiKey: string | undefined;
  polyApiSecret: string | undefined;
  polyPassphrase: string | undefined;
  polyBuilderApiKey?: string | undefined;
  polyBuilderSecret?: string | undefined;
  polyBuilderPassphrase?: string | undefined;
  polyBuilderCode?: string | undefined;
  polyPrivateKey: string | undefined;
  polymarketRelayerUrl?: string | undefined;
  polygonRpcUrl?: string | undefined;
  polygonRpcUrls?: string[] | undefined;
  polygonRpcFallbackUrl?: string | undefined;
  krabsApiKey: string | undefined;
  krabsApiPort: number;
  krabsAuthUsername: string | undefined;
  krabsAuthPassword: string | undefined;
  krabsSessionSecret: string | undefined;
  trustProxy: boolean;
  // Task 1
  marketDataMaxTrackedTokens: number;
  marketDataMaxWsShards: number;
  wsWorkerCount: number;
  marketDataDiscoveryPollIntervalMs: number;
  marketDataDiscoveryBatchSize: number;
  // Task 2
  clobAxiosMaxSockets: number;
  clobAxiosMaxFreeSockets: number;
  clobAxiosIdleTimeoutMs: number;
  // Task 3
  marketDataIngressQueueMax: number;
  marketDataIngressLagWarnMs: number;
  marketDataIngressOverflowPolicy: "drop-oldest" | "reconnect";
  // Task 4
  marketDataReconnectBaseMs: number;
  marketDataReconnectMaxMs: number;
  marketDataShardBreakerReconnectsPerMin: number;
  marketDataShardBreakerOpenMs: number;
  marketDataShardBreakerOpenMaxMs: number;
  marketDataCircuitShardOpenPercent: number;
  marketDataCircuitOpenShardFloor: number;
  marketDataCircuitOpenMs: number;
  marketDataStreamStableMs: number;
  // Task 5
  marketDataFallbackBatchSize: number;
  marketDataFallbackPollConcurrency: number;
  marketDataFallbackPollRatePerSec: number;
  marketDataStaleTokenAgeMs: number;
  algoDecisionWorkerCount?: number;
  algoDecisionWorkerBatchSize?: number;
  // ADR-018 (Step 1)
  universeFunnelLogIntervalMs: number;
  // v063 — ledger DB size guard
  dbSizeGuard: {
    enabled: boolean;
    thresholdBytes: number;
    checkIntervalMs: number;
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
    marketScanHintMinIntervalMs: env.MARKET_SCAN_HINT_MIN_INTERVAL_MS,
    reconciliationIntervalMs: env.RECONCILIATION_INTERVAL_MS,
    gammaTagId: env.GAMMA_TAG_ID,
    strategyScanIntervalMs: env.STRATEGY_SCAN_INTERVAL_MS,
    fillPollIntervalMs: env.FILL_POLL_INTERVAL_MS,
    inventorySweepIntervalMs: env.INVENTORY_SWEEP_INTERVAL_MS,
    enableInventoryAutoMerge: env.ENABLE_INVENTORY_AUTO_MERGE,
    executionMaxConcurrency: env.EXECUTION_MAX_CONCURRENCY,
    executionWalletBufferPct: env.EXECUTION_WALLET_BUFFER_PCT,
    executionWalletBufferMinUsdc: env.EXECUTION_WALLET_BUFFER_MIN_USDC,
    allowSellSizeClamp: env.ALLOW_SELL_SIZE_CLAMP,
    executionSellBalanceRejectBlockEnabled: env.EXECUTION_SELL_BALANCE_REJECT_BLOCK_ENABLED,
    executionSellBalanceRejectBlockMs: env.EXECUTION_SELL_BALANCE_REJECT_BLOCK_MS,
    executionSellExchangeReservedEnabled: env.EXECUTION_SELL_EXCHANGE_RESERVED_ENABLED,
    sellTimeoutMs: env.SELL_TIMEOUT_MS,
    polyApiKey: env.POLY_API_KEY,
    polyApiSecret: env.POLY_API_SECRET,
    polyPassphrase: env.POLY_PASSPHRASE,
    polyBuilderApiKey: env.POLY_BUILDER_API_KEY,
    polyBuilderSecret: env.POLY_BUILDER_SECRET,
    polyBuilderPassphrase: env.POLY_BUILDER_PASSPHRASE,
    polyBuilderCode: env.POLY_BUILDER_CODE,
    polyPrivateKey: env.POLY_PRIVATE_KEY,
    polymarketRelayerUrl: env.POLYMARKET_RELAYER_URL,
    polygonRpcUrl: env.POLYGON_RPC_URL,
    polygonRpcUrls: [...new Set(env.POLYGON_RPC_URLS ?? [env.POLYGON_RPC_URL])],
    polygonRpcFallbackUrl: env.POLYGON_RPC_FALLBACK_URL,
    krabsApiKey: env.KRABS_API_KEY,
    krabsApiPort: env.KRABS_API_PORT,
    krabsAuthUsername: env.KRABS_AUTH_USERNAME,
    krabsAuthPassword: env.KRABS_AUTH_PASSWORD,
    krabsSessionSecret: env.KRABS_SESSION_SECRET,
    trustProxy: env.TRUST_PROXY,
    marketDataMaxTrackedTokens: env.MARKET_DATA_MAX_TRACKED_TOKENS,
    marketDataMaxWsShards: env.MARKET_DATA_MAX_WS_SHARDS,
    wsWorkerCount: env.WS_WORKER_COUNT,
    marketDataDiscoveryPollIntervalMs: env.MARKET_DATA_DISCOVERY_POLL_INTERVAL_MS,
    marketDataDiscoveryBatchSize: env.MARKET_DATA_DISCOVERY_BATCH_SIZE,
    clobAxiosMaxSockets: env.CLOB_AXIOS_MAX_SOCKETS,
    clobAxiosMaxFreeSockets: env.CLOB_AXIOS_MAX_FREE_SOCKETS,
    clobAxiosIdleTimeoutMs: env.CLOB_AXIOS_IDLE_TIMEOUT_MS,
    marketDataIngressQueueMax: env.MARKET_DATA_INGRESS_QUEUE_MAX,
    marketDataIngressLagWarnMs: env.MARKET_DATA_INGRESS_LAG_WARN_MS,
    marketDataIngressOverflowPolicy: env.MARKET_DATA_INGRESS_OVERFLOW_POLICY,
    marketDataReconnectBaseMs: env.MARKET_DATA_RECONNECT_BASE_MS,
    marketDataReconnectMaxMs: env.MARKET_DATA_RECONNECT_MAX_MS,
    marketDataShardBreakerReconnectsPerMin: env.MARKET_DATA_SHARD_BREAKER_RECONNECTS_PER_MIN,
    marketDataShardBreakerOpenMs: env.MARKET_DATA_SHARD_BREAKER_OPEN_MS,
    marketDataShardBreakerOpenMaxMs: env.MARKET_DATA_SHARD_BREAKER_OPEN_MAX_MS,
    marketDataCircuitShardOpenPercent: env.MARKET_DATA_CIRCUIT_SHARD_OPEN_PERCENT,
    marketDataCircuitOpenShardFloor: env.MARKET_DATA_CIRCUIT_OPEN_SHARD_FLOOR,
    marketDataCircuitOpenMs: env.MARKET_DATA_CIRCUIT_OPEN_MS,
    marketDataStreamStableMs: env.MARKET_DATA_STREAM_STABLE_MS,
    marketDataFallbackBatchSize: env.MARKET_DATA_FALLBACK_BATCH_SIZE,
    marketDataFallbackPollConcurrency: env.MARKET_DATA_FALLBACK_POLL_CONCURRENCY,
    marketDataFallbackPollRatePerSec: env.MARKET_DATA_FALLBACK_POLL_RATE_PER_SEC,
    marketDataStaleTokenAgeMs: env.MARKET_DATA_STALE_TOKEN_AGE_MS,
    algoDecisionWorkerCount: env.ALGO_DECISION_WORKER_COUNT,
    algoDecisionWorkerBatchSize: env.ALGO_DECISION_WORKER_BATCH_SIZE,
    universeFunnelLogIntervalMs: env.UNIVERSE_FUNNEL_LOG_INTERVAL_MS,
    dbSizeGuard: {
      enabled: env.DB_SIZE_GUARD_ENABLED,
      thresholdBytes: env.DB_SIZE_GUARD_THRESHOLD_BYTES,
      checkIntervalMs: env.DB_SIZE_GUARD_CHECK_INTERVAL_MS,
    },
  };
}
