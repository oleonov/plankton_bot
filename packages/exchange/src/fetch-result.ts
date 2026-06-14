/**
 * Reliable read-call result primitives.
 *
 * The discriminated {@link FetchResult} and its {@link FetchReason} are part of
 * the `ExchangeGateway` contract, so their canonical home is `@krabs/domain`
 * (the lowest layer). They are re-exported here for ergonomic imports inside
 * `@krabs/exchange`. `FetchParseError` is an exchange-layer concern (raised when
 * a transport-OK payload cannot be parsed) and lives here.
 *
 * Before `FetchResult`, `getOpenOrders`/`getFills` used `catch { return [] }`, so
 * an error was indistinguishable from "no orders" — the root cause of phantom
 * cancellations (#36). Reconciliation now skips its pass on `ok: false` instead
 * of treating a failed fetch as an authoritative empty snapshot.
 */
export type { FetchReason, FetchResult } from "@krabs/domain";

/**
 * Thrown by a fetch body when the upstream responded successfully but the
 * payload could not be parsed into the expected shape (e.g. not an array).
 * Classified as `parse` — a local bug, not a transport fault, so it is NOT
 * retried.
 */
export class FetchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchParseError";
  }
}
