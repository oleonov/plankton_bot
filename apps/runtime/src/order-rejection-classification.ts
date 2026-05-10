import type { RuntimeEventMap } from "@krabs/domain";

export type OrderRejectedEvent = RuntimeEventMap["OrderRejected"];

export function isGatewayOrderReject(event: OrderRejectedEvent): boolean {
  return event.exchangeErrorMessage != null || event.exchangeErrorDetails != null;
}
