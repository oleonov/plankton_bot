// Node-only utilities that depend on node:crypto or other Node built-ins.
// Import from "@krabs/domain/node" — NOT from "@krabs/domain".
export { buildClientOrderId, buildPartialExitClientOrderId } from "./client-order-id.js";
export type { ClientOrderIdParts, PartialExitClientOrderIdParts } from "./client-order-id.js";
