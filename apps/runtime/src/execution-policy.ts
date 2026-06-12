/**
 * ADR-015 — runtime shim over the shared `@krabs/domain` policy parser.
 *
 * Defaults, the parse function, and bounds now live in domain so the api
 * package can PATCH-validate against the same code path. Keep this file as
 * a re-export plus the Logger-aware convenience wrapper; callers that only
 * need the pure parser can depend on `@krabs/domain` directly.
 */
import type { ExecutionPolicy } from "@krabs/domain";
import { parseExecutionPolicyJson } from "@krabs/domain";
import type { Logger } from "./logger.js";

export {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_DEAD_SIDE_GUARD,
  DEFAULT_PRICING_POLICY,
  DEFAULT_TELEMETRY,
  DEFAULT_ORDER_LIFETIME_POLICY,
  DEFAULT_EXIT_REPRICE_ON_DOWNPRICE_POLICY,
  DEFAULT_OPPORTUNISTIC_TAKER_POLICY,
  DEFAULT_TAKER_AT_PROFIT_POLICY,
  parseExecutionPolicyJson,
  serializeExecutionPolicy,
} from "@krabs/domain";
export type { ParseResult } from "@krabs/domain";

/**
 * Convenience wrapper: parse + log one structured error if anything is
 * invalid, then return only the resolved policy. Used by scripts / one-shot
 * code paths where the caller does not have the issues list to surface.
 */
export function parseExecutionPolicyOrDefault(
  jsonString: string | null | undefined,
  log: Logger,
  context: Record<string, unknown> = {},
): ExecutionPolicy {
  const { policy, issues } = parseExecutionPolicyJson(jsonString);
  if (issues.length > 0) {
    log.error({ issues, ...context }, "execution policy JSON invalid; falling back to defaults");
  }
  return policy;
}
