const ALCHEMY_POLYGON_BASE = "https://polygon-mainnet.g.alchemy.com/v2";
const PUBLIC_POLYGON_RPC = "https://polygon-rpc.com";

export interface PolygonRpcInput {
  /** Alchemy API keys (not URLs). Highest precedence; mapped to primary URLs. */
  alchemyPolygonKeys?: readonly string[] | undefined;
  /** Legacy full primary URLs. Used only when no Alchemy keys are set. */
  polygonRpcUrls?: readonly string[] | undefined;
  /** Legacy single primary URL. Used only when neither keys nor the list are set. */
  polygonRpcUrl?: string | undefined;
  /** Non-Alchemy fallback (e.g. dRPC). Stays out of the round-robin circle. */
  polygonRpcFallbackUrl?: string | undefined;
}

export interface ResolvedPolygonRpc {
  /** Round-robin circle (Alchemy keys → URLs, or legacy URLs, or the public default). */
  primaryUrls: string[];
  /** Last-resort tier, tried only after all primaries return 429 (read-path). */
  fallbackUrls: string[];
}

export function buildAlchemyPolygonUrl(key: string): string {
  return `${ALCHEMY_POLYGON_BASE}/${key}`;
}

function resolvePrimaryUrls(input: PolygonRpcInput): string[] {
  if (input.alchemyPolygonKeys && input.alchemyPolygonKeys.length > 0) {
    return input.alchemyPolygonKeys.map(buildAlchemyPolygonUrl);
  }
  if (input.polygonRpcUrls && input.polygonRpcUrls.length > 0) {
    return [...input.polygonRpcUrls];
  }
  if (input.polygonRpcUrl) {
    return [input.polygonRpcUrl];
  }
  return [PUBLIC_POLYGON_RPC];
}

export function resolvePolygonRpcConfig(input: PolygonRpcInput): ResolvedPolygonRpc {
  const primaryUrls = [...new Set(resolvePrimaryUrls(input))];
  const fallbackUrls =
    input.polygonRpcFallbackUrl && !primaryUrls.includes(input.polygonRpcFallbackUrl)
      ? [input.polygonRpcFallbackUrl]
      : [];
  return { primaryUrls, fallbackUrls };
}
