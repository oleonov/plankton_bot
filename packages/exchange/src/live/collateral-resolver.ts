/**
 * Collateral resolver for non-NegRisk CTF settlements.
 *
 * Polymarket migrated the V2 Exchange to a new collateral token (pUSD), but a
 * large amount of outstanding outcome positions on the same ConditionalTokens
 * contract are still USDC-collateralised. `@polymarket/clob-client-v2.getContractConfig`
 * always returns pUSD, so blindly using `contracts.collateral` in
 * `CTF.redeemPositions(collateral, parent, conditionId, indexSets)` causes the
 * relayer pre-check to reject batches with `zero position balance` whenever any
 * subcall references a USDC-collateralised position.
 *
 * The fix: resolve collateral per conditionId by recomputing
 * `getPositionId(candidate, collectionId)` for each candidate and matching
 * against the canonical CLOB tokenId. `collectionId` itself comes from a single
 * `eth_call` to `CTF.getCollectionId(parent, conditionId, indexSet)`; results are
 * cached because they are deterministic per (conditionId, indexSet).
 */

import { keccak256, concatHex, type Hex } from "viem";

const GET_COLLECTION_ID_SELECTOR = "0x856296f7"; // getCollectionId(bytes32,bytes32,uint256)
const ZERO_PARENT = "0x" + "00".repeat(32);

export interface CollateralResolverInput {
  conditionId: string;
  canonicalTokenId: string;
  indexSet: bigint;
}

export type CollateralResolver = (input: CollateralResolverInput) => Promise<string | null>;

export interface CreateCollateralResolverOptions {
  rpcUrl?: string;
  rpcUrls?: readonly string[];
  conditionalTokensAddress: string;
  /**
   * Candidate collateral addresses in priority order — typically [USDC, pUSD].
   * The resolver returns the first candidate whose positionId matches the
   * canonical CLOB tokenId.
   */
  candidates: readonly string[];
  /** Optional fetch override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call RPC timeout in ms. Defaults to 8 000 ms. */
  timeoutMs?: number;
  /**
   * Optional logger for diagnostics. Defaults to console.error / console.warn so
   * issues surface in docker log capture.
   */
  logger?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
  };
}

function normalizeHex(hex: string): string {
  return hex.toLowerCase();
}

function computePositionId(collateral: string, collectionId: Hex): bigint {
  // CTHelpers.getPositionId is a pure keccak: keccak256(abi.encodePacked(collateral, collectionId)).
  // abi.encodePacked of address is 20 bytes (NOT 32), so we use the raw 20-byte hex.
  const collateralBytes = collateral.toLowerCase() as Hex;
  const hash = keccak256(concatHex([collateralBytes, collectionId]));
  return BigInt(hash);
}

function uint256Hex(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function encodeGetCollectionIdCall(conditionId: string, indexSet: bigint): string {
  const conditionIdHex = conditionId.startsWith("0x") ? conditionId.slice(2) : conditionId;
  if (conditionIdHex.length !== 64) {
    throw new Error(`conditionId must be 32 bytes (got length ${conditionIdHex.length})`);
  }
  return (
    GET_COLLECTION_ID_SELECTOR +
    ZERO_PARENT.slice(2) +
    conditionIdHex.toLowerCase() +
    uint256Hex(indexSet)
  );
}

function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /(?:\b429\b|too many requests|rate limit|quota exceeded)/i.test(message);
}

function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/");
    const last = parts.at(-1);
    if (last && last.length > 8)
      parts[parts.length - 1] = `${last.slice(0, 4)}...${last.slice(-4)}`;
    parsed.pathname = parts.join("/");
    parsed.search = "";
    return parsed.toString();
  } catch {
    return "<invalid-rpc-url>";
  }
}

function normalizeRpcUrls(
  opts: Pick<CreateCollateralResolverOptions, "rpcUrl" | "rpcUrls">,
): string[] {
  const urls = [...(opts.rpcUrls ?? []), ...(opts.rpcUrl ? [opts.rpcUrl] : [])]
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return [...new Set(urls)];
}

async function ethCallOnce(
  rpcUrl: string,
  to: string,
  data: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`RPC HTTP ${response.status}: ${response.statusText}${body ? ` ${body}` : ""}`);
  }
  const json = (await response.json()) as { result?: string; error?: { message?: string } };
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message ?? "unknown"}`);
  }
  if (typeof json.result !== "string" || !json.result.startsWith("0x")) {
    throw new Error(`RPC returned unexpected result: ${JSON.stringify(json.result)}`);
  }
  return json.result;
}

async function ethCallWithRotation(
  rpcUrls: readonly string[],
  startIndex: number,
  to: string,
  data: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  logger: CreateCollateralResolverOptions["logger"],
): Promise<{ result: string; rpcIndex: number }> {
  let lastErr: unknown;
  for (let offset = 0; offset < rpcUrls.length; offset += 1) {
    const rpcIndex = (startIndex + offset) % rpcUrls.length;
    const rpcUrl = rpcUrls[rpcIndex]!;
    try {
      const result = await ethCallOnce(rpcUrl, to, data, fetchImpl, timeoutMs);
      return { result, rpcIndex };
    } catch (err) {
      lastErr = err;
      if (offset < rpcUrls.length - 1 && isRateLimitError(err)) {
        logger?.warn("collateral-resolver: rpc rate limited, trying next endpoint", {
          rpcUrl: redactRpcUrl(rpcUrl),
          nextRpcUrl: redactRpcUrl(rpcUrls[(rpcIndex + 1) % rpcUrls.length]!),
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function createCollateralResolver(
  opts: CreateCollateralResolverOptions,
): CollateralResolver {
  const rpcUrls = normalizeRpcUrls(opts);
  if (rpcUrls.length === 0) {
    throw new Error("createCollateralResolver requires at least one Polygon RPC URL");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const logger = opts.logger ?? {
    // eslint-disable-next-line no-console
    warn: (m, meta) => console.warn(m, meta),
    // eslint-disable-next-line no-console
    error: (m, meta) => console.error(m, meta),
  };
  const collectionIdCache = new Map<string, Hex>();
  const collateralCache = new Map<string, string>(); // key: conditionId (lowercase)
  let nextRpcIndex = 0;

  return async ({ conditionId, canonicalTokenId, indexSet }) => {
    const conditionKey = normalizeHex(conditionId);
    const cached = collateralCache.get(conditionKey);
    if (cached) return cached;

    const collectionKey = `${conditionKey}|${indexSet.toString()}`;
    let collectionId = collectionIdCache.get(collectionKey);
    if (!collectionId) {
      try {
        const callData = encodeGetCollectionIdCall(conditionId, indexSet);
        const { result, rpcIndex } = await ethCallWithRotation(
          rpcUrls,
          nextRpcIndex,
          opts.conditionalTokensAddress,
          callData,
          fetchImpl,
          timeoutMs,
          logger,
        );
        nextRpcIndex = (rpcIndex + 1) % rpcUrls.length;
        if (result.length !== 66) {
          throw new Error(`Expected 32-byte collectionId, got ${result}`);
        }
        collectionId = result as Hex;
        collectionIdCache.set(collectionKey, collectionId);
      } catch (err) {
        logger.error("collateral-resolver: getCollectionId failed", {
          conditionId,
          indexSet: indexSet.toString(),
          error: err instanceof Error ? err.message : String(err),
        });
        // Propagate RPC failures (timeouts / 429 / 503 / JSON-RPC errors) so the
        // gateway can route them through its infra-alert classifier. Returning
        // `null` would erase the original cause and prevent the redeem-sweep
        // rate-limit hard-pause from firing. `null` is reserved for the
        // semantic "no candidate matched" branch below.
        throw err;
      }
    }

    const canonical = BigInt(canonicalTokenId);
    for (const candidate of opts.candidates) {
      const positionId = computePositionId(candidate, collectionId);
      if (positionId === canonical) {
        collateralCache.set(conditionKey, candidate);
        return candidate;
      }
    }

    logger.warn("collateral-resolver: no candidate matched canonical tokenId", {
      conditionId,
      canonicalTokenId,
      indexSet: indexSet.toString(),
      candidates: opts.candidates,
    });
    return null;
  };
}

export const __test = { computePositionId, encodeGetCollectionIdCall };
