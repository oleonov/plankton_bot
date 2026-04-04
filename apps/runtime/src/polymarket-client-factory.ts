import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import type { WalletMode } from "@plankton/domain";
import type { AppConfig } from "@plankton/config";
import {
  parseRelayerConfigJson,
  resolveRelayerSignatureType,
  type PolymarketRelayerConfig,
} from "./relayer-config.js";

export interface PolymarketClientFactoryInput {
  runtimeMode: "paper" | "live-lite";
  config: Pick<AppConfig, "polyApiKey" | "polyApiSecret" | "polyPassphrase" | "polyPrivateKey">;
  walletMode?: WalletMode | null;
  relayerJson?: string | null;
  host?: string;
  chainId?: number;
}

export interface PolymarketClientFactoryDeps {
  createBuilderConfig?: (config: ConstructorParameters<typeof BuilderConfig>[0]) => unknown;
  createClobClient?: (...args: unknown[]) => unknown;
  createWallet?: (privateKey: string) => unknown;
}

export interface PolymarketClientResult {
  client: unknown;
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
  relayerConfig: PolymarketRelayerConfig,
  deps: PolymarketClientFactoryDeps,
): unknown {
  if (!relayerConfig.builder) return undefined;
  const createConfig = deps.createBuilderConfig ?? ((config) => new BuilderConfig(config));

  if (relayerConfig.builder.mode === "local") {
    return createConfig({
      localBuilderCreds: {
        key: relayerConfig.builder.key,
        secret: relayerConfig.builder.secret,
        passphrase: relayerConfig.builder.passphrase,
      },
    });
  }

  return createConfig({
    remoteBuilderConfig: {
      url: relayerConfig.builder.url,
      ...(relayerConfig.builder.token ? { token: relayerConfig.builder.token } : {}),
    },
  });
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
      relayerConfig: null,
      traderAddress: null,
    };
  }

  const signer = deps.createWallet!(requireString(input.config.polyPrivateKey, "POLY_PRIVATE_KEY"));
  const creds = {
    key: requireString(input.config.polyApiKey, "POLY_API_KEY"),
    secret: requireString(input.config.polyApiSecret, "POLY_API_SECRET"),
    passphrase: requireString(input.config.polyPassphrase, "POLY_PASSPHRASE"),
  };

  if ((input.walletMode ?? "eoa") !== "relayer") {
    return {
      client: deps.createClobClient!(host, chainId, signer, creds),
      relayerConfig: null,
      traderAddress: resolveWalletAddress(signer),
    };
  }

  const parsed = parseRelayerConfigJson(input.relayerJson);
  if (!parsed.ok || !parsed.value) {
    throw new Error(parsed.errors.join("; "));
  }

  const relayerConfig = parsed.value;
  const builderConfig = createBuilderConfig(relayerConfig, deps);

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
    relayerConfig,
    traderAddress: relayerConfig.funderAddress,
  };
}
