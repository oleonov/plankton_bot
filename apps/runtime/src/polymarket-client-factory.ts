import { BuilderConfig as RelayerBuilderConfig } from "@polymarket/builder-signing-sdk";
import type { WalletMode } from "@plankton/domain";
import {
  parseRelayerConfigJson,
  resolveRelayerSignatureType,
  type PolymarketRelayerConfig,
} from "./relayer-config.js";

export interface PolymarketClientConfig {
  polyApiKey: string | undefined;
  polyApiSecret: string | undefined;
  polyPassphrase: string | undefined;
  // HMAC creds — required by @polymarket/builder-relayer-client@0.0.8 RelayClient.
  // V2 CLOB no longer uses them for order signing — see `polyBuilderCode`.
  polyBuilderApiKey: string | undefined;
  polyBuilderSecret: string | undefined;
  polyBuilderPassphrase: string | undefined;
  // V2 CLOB builder attribution — bytes32 from Polymarket Builder Profile.
  polyBuilderCode: string | undefined;
  polyPrivateKey: string | undefined;
  polymarketRelayerUrl: string;
  polygonRpcUrl: string;
  polygonRpcFallbackUrl?: string | undefined;
}

export interface PolymarketClientFactoryInput {
  runtimeMode: "paper" | "live-lite";
  config: PolymarketClientConfig;
  walletMode?: WalletMode | null;
  relayerJson?: string | null;
  host?: string;
  chainId?: number;
}

export interface SettlementClientLike {
  execute(txns: unknown[], metadata: string): Promise<unknown>;
}

export interface ClobClientCtorOptions {
  host: string;
  chain: number;
  signer?: unknown;
  creds?: { key: string; secret: string; passphrase: string };
  signatureType?: 1 | 2;
  funderAddress?: string;
  builderConfig?: { builderCode: string };
}

export interface PolymarketClientFactoryDeps {
  createBuilderConfig?: (config: ConstructorParameters<typeof RelayerBuilderConfig>[0]) => unknown;
  createClobClient?: (options: ClobClientCtorOptions) => unknown;
  createWallet?: (privateKey: string) => unknown;
  createSettlementClient?: (config: {
    relayerUrl: string;
    chainId: number;
    privateKey: string;
    rpcUrl: string;
    builderConfig?: unknown;
    walletType: "proxy" | "gnosis-safe";
  }) => Promise<SettlementClientLike> | SettlementClientLike;
}

export interface PolymarketClientResult {
  client: unknown;
  settlementClient: SettlementClientLike | null;
  relayerConfig: PolymarketRelayerConfig | null;
  traderAddress: string | null;
  userWsAuth: {
    apiKey: string;
    secret: string;
    passphrase: string;
  } | null;
}

function requireString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required for live Polymarket client setup`);
  return value;
}

function resolveWalletAddress(wallet: unknown): string | null {
  if (!wallet || typeof wallet !== "object") return null;
  const candidate = Reflect.get(wallet, "address");
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

// Builds BuilderConfig from @polymarket/builder-signing-sdk for the relayer
// settlement client (RelayClient still requires HMAC builder auth in v0.0.8).
// CLOB V2 order-signing no longer uses this — it uses `polyBuilderCode` instead.
function createRelayerBuilderConfig(
  config: PolymarketClientConfig,
  relayerConfig: PolymarketRelayerConfig,
  deps: PolymarketClientFactoryDeps,
): unknown {
  const createConfig = deps.createBuilderConfig ?? ((config) => new RelayerBuilderConfig(config));

  if (relayerConfig.builder?.mode === "local") {
    return createConfig({
      localBuilderCreds: {
        key: relayerConfig.builder.key,
        secret: relayerConfig.builder.secret,
        passphrase: relayerConfig.builder.passphrase,
      },
    });
  }

  if (relayerConfig.builder?.mode === "remote") {
    return createConfig({
      remoteBuilderConfig: {
        url: relayerConfig.builder.url,
        ...(relayerConfig.builder.token ? { token: relayerConfig.builder.token } : {}),
      },
    });
  }

  if (config.polyBuilderApiKey && config.polyBuilderSecret && config.polyBuilderPassphrase) {
    return createConfig({
      localBuilderCreds: {
        key: config.polyBuilderApiKey,
        secret: config.polyBuilderSecret,
        passphrase: config.polyBuilderPassphrase,
      },
    });
  }

  throw new Error(
    "builder credentials are required for relayer mode: configure relayer_json.builder or POLY_BUILDER_API_KEY/POLY_BUILDER_SECRET/POLY_BUILDER_PASSPHRASE",
  );
}

function createUserApiCreds(config: PolymarketClientConfig): {
  key: string;
  secret: string;
  passphrase: string;
} {
  return {
    key: requireString(config.polyApiKey, "POLY_API_KEY"),
    secret: requireString(config.polyApiSecret, "POLY_API_SECRET"),
    passphrase: requireString(config.polyPassphrase, "POLY_PASSPHRASE"),
  };
}

export async function createPolymarketClient(
  input: PolymarketClientFactoryInput,
  deps: PolymarketClientFactoryDeps = {},
): Promise<PolymarketClientResult> {
  const host = input.host ?? "https://clob-v2.polymarket.com";
  const chainId = input.chainId ?? 137;

  if (!deps.createClobClient || !deps.createWallet) {
    const { ClobClient } = await import("@polymarket/clob-client-v2");
    const { Wallet } = await import("ethers");
    const ClobClientCtor = ClobClient as unknown as new (options: unknown) => unknown;
    deps = {
      ...deps,
      createClobClient: deps.createClobClient ?? ((options) => new ClobClientCtor(options)),
      createWallet: deps.createWallet ?? ((privateKey) => new Wallet(privateKey)),
    };
  }

  const builderCodeOption = input.config.polyBuilderCode
    ? { builderConfig: { builderCode: input.config.polyBuilderCode } }
    : {};

  if (input.runtimeMode === "paper") {
    return {
      client: deps.createClobClient!({ host, chain: chainId, ...builderCodeOption }),
      settlementClient: null,
      relayerConfig: null,
      traderAddress: null,
      userWsAuth: null,
    };
  }

  const signer = deps.createWallet!(requireString(input.config.polyPrivateKey, "POLY_PRIVATE_KEY"));
  const creds = createUserApiCreds(input.config);

  if ((input.walletMode ?? "eoa") !== "relayer") {
    return {
      client: deps.createClobClient!({
        host,
        chain: chainId,
        signer,
        creds,
        ...builderCodeOption,
      }),
      settlementClient: null,
      relayerConfig: null,
      traderAddress: resolveWalletAddress(signer),
      userWsAuth: {
        apiKey: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
    };
  }

  const parsed = parseRelayerConfigJson(input.relayerJson);
  if (!parsed.ok || !parsed.value) {
    throw new Error(parsed.errors.join("; "));
  }

  const relayerConfig = parsed.value;
  // RelayerBuilderConfig from @polymarket/builder-signing-sdk — only used by
  // RelayClient (settlement). Not passed to V2 ClobClient.
  const relayerBuilderConfig = createRelayerBuilderConfig(input.config, relayerConfig, deps);
  const settlementClient = await createSettlementClient(
    {
      relayerUrl: input.config.polymarketRelayerUrl,
      chainId,
      privateKey: requireString(input.config.polyPrivateKey, "POLY_PRIVATE_KEY"),
      rpcUrl: input.config.polygonRpcUrl,
      rpcFallbackUrl: input.config.polygonRpcFallbackUrl,
      builderConfig: relayerBuilderConfig,
      walletType: relayerConfig.walletType,
    },
    deps,
  );

  return {
    client: deps.createClobClient!({
      host,
      chain: chainId,
      signer,
      creds,
      signatureType: resolveRelayerSignatureType(relayerConfig),
      funderAddress: relayerConfig.funderAddress,
      ...builderCodeOption,
    }),
    settlementClient,
    relayerConfig,
    traderAddress: relayerConfig.funderAddress,
    userWsAuth: {
      apiKey: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
  };
}

async function createSettlementClient(
  config: {
    relayerUrl: string;
    chainId: number;
    privateKey: string;
    rpcUrl: string;
    rpcFallbackUrl?: string | undefined;
    builderConfig?: unknown;
    walletType: "proxy" | "gnosis-safe";
  },
  deps: PolymarketClientFactoryDeps,
): Promise<SettlementClientLike> {
  if (deps.createSettlementClient) {
    return deps.createSettlementClient(config);
  }

  const [
    { RelayClient, RelayerTxType },
    { createWalletClient, http, fallback },
    { privateKeyToAccount },
    { polygon },
  ] = await Promise.all([
    import("@polymarket/builder-relayer-client"),
    import("viem"),
    import("viem/accounts"),
    import("viem/chains"),
  ]);

  const transport =
    config.rpcFallbackUrl && config.rpcFallbackUrl !== config.rpcUrl
      ? fallback([http(config.rpcUrl), http(config.rpcFallbackUrl)])
      : http(config.rpcUrl);

  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport,
  });

  return new RelayClient(
    config.relayerUrl,
    config.chainId,
    walletClient,
    config.builderConfig as RelayerBuilderConfig | undefined,
    config.walletType === "proxy" ? RelayerTxType.PROXY : RelayerTxType.SAFE,
  );
}
