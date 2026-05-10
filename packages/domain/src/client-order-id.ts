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
