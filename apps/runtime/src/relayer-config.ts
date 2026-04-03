export type RelayerWalletType = "proxy" | "gnosis-safe";

export interface LocalBuilderConfig {
  mode: "local";
  key: string;
  secret: string;
  passphrase: string;
}

export interface RemoteBuilderConfig {
  mode: "remote";
  url: string;
  token?: string;
}

export type RelayerBuilderConfig = LocalBuilderConfig | RemoteBuilderConfig;

export interface PolymarketRelayerConfig {
  walletType: RelayerWalletType;
  funderAddress: string;
  builder?: RelayerBuilderConfig;
}

export interface ParsedRelayerConfig {
  ok: boolean;
  value?: PolymarketRelayerConfig;
  errors: string[];
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWalletType(value: unknown): RelayerWalletType | null {
  if (value === "proxy") return "proxy";
  if (value === "gnosis-safe" || value === "safe") return "gnosis-safe";
  if (value === 1 || value === "1" || value === "POLY_PROXY") return "proxy";
  if (value === 2 || value === "2" || value === "POLY_GNOSIS_SAFE") return "gnosis-safe";
  return null;
}

function parseBuilderConfig(value: unknown, errors: string[]): RelayerBuilderConfig | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) {
    errors.push("relayer_json.builder must be an object");
    return undefined;
  }

  if (value["mode"] === "local") {
    const key = value["key"];
    const secret = value["secret"];
    const passphrase = value["passphrase"];
    if (typeof key !== "string" || key.length === 0) {
      errors.push("relayer_json.builder.key is required for local builder mode");
    }
    if (typeof secret !== "string" || secret.length === 0) {
      errors.push("relayer_json.builder.secret is required for local builder mode");
    }
    if (typeof passphrase !== "string" || passphrase.length === 0) {
      errors.push("relayer_json.builder.passphrase is required for local builder mode");
    }
    if (errors.length > 0) return undefined;
    return { mode: "local", key, secret, passphrase } as LocalBuilderConfig;
  }

  if (value["mode"] === "remote") {
    const url = value["url"];
    const token = value["token"];
    if (typeof url !== "string" || url.length === 0) {
      errors.push("relayer_json.builder.url is required for remote builder mode");
      return undefined;
    }
    if (token != null && typeof token !== "string") {
      errors.push("relayer_json.builder.token must be a string when provided");
      return undefined;
    }
    return {
      mode: "remote",
      url,
      ...(typeof token === "string" && token.length > 0 ? { token } : {}),
    };
  }

  errors.push("relayer_json.builder.mode must be 'local' or 'remote'");
  return undefined;
}

export function parseRelayerConfigJson(
  relayerJson: string | null | undefined,
): ParsedRelayerConfig {
  if (!relayerJson || relayerJson.trim().length === 0) {
    return { ok: false, errors: ["relayer_json is required when wallet_mode=relayer"] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(relayerJson);
  } catch {
    return { ok: false, errors: ["relayer_json must be valid JSON"] };
  }

  if (!isRecord(parsed)) {
    return { ok: false, errors: ["relayer_json must decode to an object"] };
  }

  const errors: string[] = [];
  const walletType = normalizeWalletType(parsed["walletType"] ?? parsed["signatureType"]);
  const funderAddress = parsed["funderAddress"] ?? parsed["funder"] ?? parsed["profileAddress"];

  if (!walletType) {
    errors.push("relayer_json.walletType must be 'proxy' or 'gnosis-safe'");
  }

  if (typeof funderAddress !== "string" || !EVM_ADDRESS_RE.test(funderAddress)) {
    errors.push("relayer_json.funderAddress must be a 0x-prefixed 20-byte hex address");
  }

  const builder = parseBuilderConfig(parsed["builder"], errors);

  if (errors.length > 0 || !walletType || typeof funderAddress !== "string") {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      walletType,
      funderAddress,
      ...(builder ? { builder } : {}),
    },
    errors: [],
  };
}

export function resolveRelayerSignatureType(config: PolymarketRelayerConfig): 1 | 2 {
  return config.walletType === "proxy" ? 1 : 2;
}
