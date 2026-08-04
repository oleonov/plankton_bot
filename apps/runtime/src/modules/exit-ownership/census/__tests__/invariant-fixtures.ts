import { BOUNCE_EXIT_TARGET_RULE_ID } from "@krabs/domain";

import { AFTER_CUTOFF, WHITELISTED_CONDITION, seedSql } from "./fixtures.js";

/**
 * §7 test 3's fixture vocabulary — ONE seed per invariant class, shared by the two suites that need it:
 * `invariants.test.ts` (does each invariant FIRE on its class, and does the report NAME the rows?) and
 * `export-invariant-identity.test.ts` (§9a.6 test 8: are the exported rows the ones `@krabs/db`'s own
 * definition produces against the real ledger, on those same classes?).
 *
 * They live here rather than inline because the second suite is specified against "the §7 test-3
 * fixtures": a second copy would let the two drift, and the identity comparison would then be pinning
 * seeds that no longer resemble the ones the invariants are tested on.
 *
 * Every seed below is COMPOSABLE — no two share a `position_id`, an `order_id` or a `token_id` (apart
 * from the deliberate `tok-clean` reuse), so `withClean(A, B, C)` seeds one ledger carrying all three
 * classes at once and each class's expected violations simply add up. The real migrations carry
 * `UNIQUE(token_id) WHERE status='open'`, so distinct tokens are also what makes the union seedable.
 */

/** One clean, whitelisted, bounce-bound target — so every fixture below is a real run, not a bare row set. */
export const CLEAN_TARGET = seedSql({
  markets: [{ tokenId: "tok-clean", conditionId: WHITELISTED_CONDITION }],
  positions: [
    {
      positionId: "pos-clean",
      tokenId: "tok-clean",
      conditionId: WHITELISTED_CONDITION,
      entryLane: "R23",
    },
  ],
  legStates: [{ tokenId: "tok-clean", firstTradeAt: AFTER_CUTOFF }],
});

export const withClean = (...parts: readonly string[]): string =>
  [CLEAN_TARGET, ...parts].join("\n");

/**
 * `nullOwners` — ONE row and nothing else. `repairing` is schema-legal (`positions.status` has no CHECK)
 * and is NOT in the census's enumerated target set, so no decision covers it and the projection cannot
 * mask it; every other invariant is clean on it by construction (I1/I2/I3/I5 all need an active SELL and
 * there is none, I4 needs a second nonclosed row on the token and there is none).
 *
 * Under an enumerated `nullOwners` the whole run reads clean while `findActiveByTokenId` already treats the
 * row as active and the executor's legacy path admits a NULL-owner SELL against it.
 */
export const UNCOVERED_NULL_OWNER = seedSql({
  positions: [{ positionId: "pos-lonely", tokenId: "tok-lonely", status: "repairing" }],
});

/**
 * I1 — no `position_id`: the legacy unbound SELL the executor's identity check never revisits once it is
 * resting on the exchange.
 */
export const UNBOUND_SELL = seedSql({
  orders: [{ orderId: "o-unbound", tokenId: "tok-clean", side: "sell", status: "open" }],
});

/**
 * I2, the cross-token form. §5.1.2 exports ALL nonclosed positions, so `pos-b` IS in the manifest —
 * which is precisely what lets a token-blind predicate resolve the pointer and report clean. Had `pos-b`
 * been absent, the weak form would have caught this by accident and the test would have passed for the
 * wrong reason.
 *
 * `pos-b` is already owned, so it is NOT a target — it reaches the evaluator through §5.1.2 alone.
 */
export const CROSS_TOKEN_STALE = seedSql({
  markets: [{ tokenId: "tok-a", conditionId: WHITELISTED_CONDITION }],
  positions: [
    {
      positionId: "pos-a",
      tokenId: "tok-a",
      conditionId: WHITELISTED_CONDITION,
      entryLane: "R23",
    },
    { positionId: "pos-b", tokenId: "tok-b", exitOwner: "profile" },
  ],
  legStates: [{ tokenId: "tok-a", firstTradeAt: AFTER_CUTOFF }],
  // A SELL on token A pointing at a nonclosed position of token B.
  orders: [
    { orderId: "o-stale", tokenId: "tok-a", positionId: "pos-b", side: "sell", status: "open" },
  ],
});

/**
 * I2's other half — the pointer resolves to a row that EXISTS and is `closed`. It is the one class where
 * the two sides of §9a.6 test 8 see different DATA: the real ledger holds a closed row, the manifest
 * carries none (§5.1.2 exports `status <> 'closed'`). `NOT EXISTS (… AND p.status <> 'closed')` is what
 * makes both readings agree; an `EXISTS(… status='closed')` spelling would not.
 */
export const CLOSED_POINTER = seedSql({
  positions: [{ positionId: "pos-gone", tokenId: "tok-clean", status: "closed" }],
  orders: [
    {
      orderId: "o-closed",
      tokenId: "tok-clean",
      positionId: "pos-gone",
      side: "sell",
      status: "open",
    },
  ],
});

/**
 * I3's per-order zero floor, and it takes TWO orders to see: with one order a floored and an unfloored
 * implementation agree on every input where the sum is non-negative, and an over-filled single order only
 * makes I3 *more* likely to reject. The floor is observable only when a NEGATIVE remainder is available to
 * cancel a positive one from a sibling on the same token.
 *
 *   floored (correct)   max(0, 5−8) + max(0, 11−0) = 11 > 10  ⇒ violation
 *   unfloored (defect)         (5−8) +      (11−0) =  8 ≤ 10  ⇒ clean
 *
 * The violation deliberately sits on an ALREADY-OWNED, non-target position: that row class reaches the
 * evaluator solely through §5.1.2, so this is the one fixture that fails if §5.1.2 stops carrying `size`.
 *
 * 11 rather than the more obvious 12 because sqlite 3.37.2 renders `printf('%!.17g', 12.0)` as
 * "11.999999999999999", which JSON.parse maps to 11.999999999999998 — see the §5.1.10 finding.
 */
export const OVERCOMMIT_FLOOR = seedSql({
  positions: [{ positionId: "pos-owned", tokenId: "tok-owned", exitOwner: "profile", size: 10 }],
  orders: [
    // Over-filled but still WORKING — exactly the state a partial fill on a live order produces.
    {
      orderId: "o-over",
      tokenId: "tok-owned",
      positionId: "pos-owned",
      side: "sell",
      status: "open",
      size: 5,
    },
    {
      orderId: "o-rest",
      tokenId: "tok-owned",
      positionId: "pos-owned",
      side: "sell",
      status: "open",
      size: 11,
    },
  ],
  fills: [
    { fillId: "f-1", orderId: "o-over", tokenId: "tok-owned", size: 5 },
    { fillId: "f-2", orderId: "o-over", tokenId: "tok-owned", size: 3 },
  ],
});

/**
 * I3 in the PASSING direction, which no blocked-direction fixture can cover: dropping the fill data only
 * inflates remaining shares, so a manifest carrying no fills at all keeps every "must block" case green.
 * `size` ALONE would overcommit (12 > 10) and `size − SUM(fills.size)` does not (7 ≤ 10), so the run must
 * proceed — and `fills: false` is the negative control that shows the fills are what makes the difference.
 *
 * This is also §9a.6 test 8(d)'s A13 pin: the difference has to fall in the PASSING direction, or a
 * materialized ledger that lost `filled_size` would be merely over-strict on it and look correct.
 */
export function partialFillSeed(options: { readonly fills: boolean }): string {
  return seedSql({
    positions: [{ positionId: "pos-p", tokenId: "tok-p", exitOwner: "profile", size: 10 }],
    orders: [
      {
        orderId: "o-partial",
        tokenId: "tok-p",
        positionId: "pos-p",
        side: "sell",
        status: "open",
        size: 12,
      },
    ],
    fills: options.fills
      ? [{ fillId: "f-p", orderId: "o-partial", tokenId: "tok-p", size: 5 }]
      : [],
  });
}

/**
 * I4 — `open` + `open` is NOT the fixture: the real migrations carry a partial UNIQUE index on
 * `(token_id) WHERE status='open'`, so that seed raises SQLITE_CONSTRAINT — a test that cannot be seeded
 * is a test that cannot fail. `dust` sits outside the index's WHERE, and I4 ranges over NONCLOSED rows.
 */
export const DUPLICATE_TOKEN = seedSql({
  markets: [{ tokenId: "tok-dup", conditionId: WHITELISTED_CONDITION }],
  positions: [
    {
      positionId: "pos-open",
      tokenId: "tok-dup",
      conditionId: WHITELISTED_CONDITION,
      entryLane: "R23",
    },
    {
      positionId: "pos-dust",
      tokenId: "tok-dup",
      conditionId: WHITELISTED_CONDITION,
      status: "dust",
      entryLane: "R23",
    },
  ],
  legStates: [{ tokenId: "tok-dup", firstTradeAt: AFTER_CUTOFF }],
});

/**
 * I5 on an ALREADY-OWNED position — a resting `bounce`-ruled SELL against a `profile`-owned position. On a
 * recovery run the offending position is already owned, so restricting I5 to this run's targets would let
 * it through on the second pass.
 */
export const WRONG_OWNER_SELL = seedSql({
  positions: [
    { positionId: "pos-i5-owned", tokenId: "tok-i5-owned", status: "dust", exitOwner: "profile" },
  ],
  orders: [
    {
      orderId: "o-i5-owned",
      tokenId: "tok-i5-owned",
      positionId: "pos-i5-owned",
      side: "sell",
      status: "open",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
    },
  ],
});
