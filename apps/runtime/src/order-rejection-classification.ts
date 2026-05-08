import type { RuntimeEventMap } from "@plankton/domain";

export type OrderRejectedEvent = RuntimeEventMap["OrderRejected"];

export function isGatewayOrderReject(event: OrderRejectedEvent): boolean {
  return event.exchangeErrorMessage != null || event.exchangeErrorDetails != null;
}
