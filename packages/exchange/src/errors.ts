import type { ExchangeErrorCode } from "@plankton/domain";
import { sanitizeErrorMessage } from "./redaction.js";

/**
 * Classify an unknown error into a domain ExchangeErrorCode.
 * Used by live adapters to map SDK/HTTP errors.
 */
export function classifyError(err: unknown): { code: ExchangeErrorCode; message: string } {
  const message = sanitizeErrorMessage(err);
  const lower = message.toLowerCase();

  if (lower.includes("insufficient") || lower.includes("not enough")) {
    return { code: "INSUFFICIENT_BALANCE", message };
  }
  if (lower.includes("invalid price") || lower.includes("price must")) {
    return { code: "INVALID_PRICE", message };
  }
  if (
    lower.includes("invalid size") ||
    lower.includes("size must") ||
    lower.includes("min order size")
  ) {
    return { code: "INVALID_SIZE", message };
  }
  if (lower.includes("duplicate") || lower.includes("already exists")) {
    return { code: "DUPLICATE_CLIENT_ORDER_ID", message };
  }
  if (lower.includes("order not found") || lower.includes("order_not_found")) {
    return { code: "ORDER_NOT_FOUND", message };
  }
  if (lower.includes("market not found")) {
    return { code: "MARKET_NOT_FOUND", message };
  }
  if (lower.includes("market closed") || lower.includes("closed_only")) {
    return { code: "MARKET_CLOSED", message };
  }
  if (lower.includes("rate limit") || lower.includes("too many")) {
    return { code: "RATE_LIMITED", message };
  }
  if (lower.includes("nonce")) {
    return { code: "NONCE_ERROR", message };
  }
  if (
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed")
  ) {
    return { code: "NETWORK_ERROR", message };
  }
  if (
    lower.includes("auth") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    return { code: "AUTHENTICATION_FAILED", message };
  }

  return { code: "UNKNOWN", message };
}
