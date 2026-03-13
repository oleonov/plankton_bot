// apps/runtime — main trading bot process
// This import proves cross-package resolution works.
import type { PlaceholderType } from "@plankton/domain";

const proof: PlaceholderType = { _brand: "PlanktonDomain" as const };

// eslint-disable-next-line no-console
console.log("runtime placeholder", proof._brand);
