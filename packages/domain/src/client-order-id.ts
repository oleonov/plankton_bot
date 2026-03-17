// ─── buildClientOrderId ───────────────────────────────────────────────────────
//
// Node-only utility — uses node:crypto. NOT exported from the main "@plankton/domain"
// entry point. Import from "@plankton/domain/node" instead.
//
// Deterministic, retry-safe client order ID.
//
// Inputs are hashed with SHA-256 and truncated to 16 hex chars.
// The `sequenceInTick` field (F3 resolution) prevents collisions when the
// strategy scanner emits multiple signals for the same token in one tick,
// which is required for HR6 (2–3 buys) and HR7 (heavy campaigns).
//
// Format: `plk_<16-char-hex>`

import { createHash } from "node:crypto";
import type { FamilyId, TokenId, ClientOrderId } from "./ids.js";
import type { OrderSide } from "./enums.js";

export interface ClientOrderIdParts {
  familyId: FamilyId;
  tokenId: TokenId;
  side: OrderSide;
  intentEpochMs: number;
  /** 0-based counter within this tick for the same family+token+side triple. */
  sequenceInTick: number;
}

export function buildClientOrderId(parts: ClientOrderIdParts): ClientOrderId {
  const raw = [
    parts.familyId,
    parts.tokenId,
    parts.side,
    parts.intentEpochMs.toString(),
    parts.sequenceInTick.toString(),
  ].join("|");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `plk_${hash}` as ClientOrderId;
}
