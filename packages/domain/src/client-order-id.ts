// ─── buildClientOrderId ───────────────────────────────────────────────────────
//
// Node-only utility — uses node:crypto. NOT exported from the main "@krabs/domain"
// entry point. Import from "@krabs/domain/node" instead.
//
// Signal-derived, retry-safe client order ID.
//
// Built from the signal's stable identity (signalId + tokenId + side).
// Same Signal re-delivered produces the same clientOrderId.
// Does NOT depend on familyId, tick timestamp, or processing order.
//
// Format: `krb_<16-char-hex>`

import { createHash } from "node:crypto";
import type { TokenId, ClientOrderId } from "./ids.js";
import type { OrderSide } from "./enums.js";

export interface ClientOrderIdParts {
  signalId: string;
  tokenId: TokenId;
  side: OrderSide;
}

export function buildClientOrderId(parts: ClientOrderIdParts): ClientOrderId {
  const raw = [parts.signalId, parts.tokenId, parts.side].join("|");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `krb_${hash}` as ClientOrderId;
}

// ─── Track S5 P1 partial-exit client order id ──────────────────────────────────
//
// A partial exit is NOT keyed on signalId — the same signal may reprice across
// ticks, and a partial fired twice inside one slot must dedupe at the CLOB. The
// id is namespaced and bucketed into 5-minute epoch slots: two partials in one
// slot share an id (race-safe dedupe); the next slot mints a fresh id so the
// next partial is allowed through.

const PARTIAL_EXIT_SLOT_MS = 300_000;

export interface PartialExitClientOrderIdParts {
  tokenId: TokenId;
  nowMs: number;
}

export function buildPartialExitClientOrderId(parts: PartialExitClientOrderIdParts): ClientOrderId {
  const epochSlot = Math.floor(parts.nowMs / PARTIAL_EXIT_SLOT_MS);
  return `tk:s5:p1:${parts.tokenId}:${epochSlot}` as ClientOrderId;
}
