import { BuilderConfig } from "@polymarket/builder-signing-sdk";
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
  polyBuilderApiKey: string | undefined;
  polyBuilderSecret: string | undefined;
  polyBuilderPassphrase: string | undefined;
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

export interface PolymarketClientFactoryDeps {
  createBuilderConfig?: (config: ConstructorParameters<typeof BuilderConfig>[0]) => unknown;
  createClobClient?: (...args: unknown[]) => unknown;
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

function createBuilderConfig(
  config: PolymarketClientConfig,
  relayerConfig: PolymarketRelayerConfig,
  deps: PolymarketClientFactoryDeps,
): unknown {
  const createConfig = deps.createBuilderConfig ?? ((config) => new BuilderConfig(config));

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

  if (
    config.polyBuilderApiKey &&
    config.polyBuilderSecret &&
    config.polyBuilderPassphrase
  ) {
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
  const host = input.host ?? "https://clob.polymarket.com";
  const chainId = input.chainId ?? 137;

  if (!deps.createClobClient || !deps.createWallet) {
    const { ClobClient } = await import("@polymarket/clob-client");
    const { Wallet } = await import("ethers");
    const ClobClientCtor = ClobClient as unknown as new (...args: unknown[]) => unknown;
    deps = {
      ...deps,
      createClobClient: deps.createClobClient ?? ((...args) => new ClobClientCtor(...args)),
      createWallet: deps.createWallet ?? ((privateKey) => new Wallet(privateKey)),
    };
  }

  if (input.runtimeMode === "paper") {
    return {
      client: deps.createClobClient!(host, chainId),
      settlementClient: null,
      relayerConfig: null,
      traderAddress: null,
    };
  }

  const signer = deps.createWallet!(requireString(input.config.polyPrivateKey, "POLY_PRIVATE_KEY"));
  const creds = createUserApiCreds(input.config);

  if ((input.walletMode ?? "eoa") !== "relayer") {
    return {
      client: deps.createClobClient!(host, chainId, signer, creds),
      settlementClient: null,
      relayerConfig: null,
      traderAddress: resolveWalletAddress(signer),
    };
  }

  const parsed = parseRelayerConfigJson(input.relayerJson);
  if (!parsed.ok || !parsed.value) {
    throw new Error(parsed.errors.join("; "));
  }

  const relayerConfig = parsed.value;
  const builderConfig = createBuilderConfig(input.config, relayerConfig, deps);
  const settlementClient = await createSettlementClient(
    {
      relayerUrl: input.config.polymarketRelayerUrl,
      chainId,
      privateKey: requireString(input.config.polyPrivateKey, "POLY_PRIVATE_KEY"),
      rpcUrl: input.config.polygonRpcUrl,
      rpcFallbackUrl: input.config.polygonRpcFallbackUrl,
      builderConfig,
      walletType: relayerConfig.walletType,
    },
    deps,
  );

  return {
    client: deps.createClobClient!(
      host,
      chainId,
      signer,
      creds,
      resolveRelayerSignatureType(relayerConfig),
      relayerConfig.funderAddress,
      undefined,
      undefined,
      builderConfig,
    ),
    settlementClient,
    relayerConfig,
    traderAddress: relayerConfig.funderAddress,
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

  const [{ RelayClient, RelayerTxType }, { createWalletClient, http, fallback }, { privateKeyToAccount }, { polygon }] =
    await Promise.all([
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
    config.builderConfig as BuilderConfig | undefined,
    config.walletType === "proxy" ? RelayerTxType.PROXY : RelayerTxType.SAFE,
  );
}
