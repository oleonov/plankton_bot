import type { ExchangeErrorCode } from "@plankton/domain";
import { sanitizeErrorDetails, sanitizeErrorMessage } from "./redaction.js";

/**
 * Classify an unknown error into a domain ExchangeErrorCode.
 * Used by live adapters to map SDK/HTTP errors.
 */
export function classifyError(err: unknown): {
  code: ExchangeErrorCode;
  message: string;
  details: Readonly<Record<string, unknown>>;
} {
  const message = sanitizeErrorMessage(err);
  const details = sanitizeErrorDetails(err);
  const lower = message.toLowerCase();

  if (lower.includes("insufficient") || lower.includes("not enough")) {
    return { code: "INSUFFICIENT_BALANCE", message, details };
  }
  if (lower.includes("invalid price") || lower.includes("price must")) {
    return { code: "INVALID_PRICE", message, details };
  }
  if (
    lower.includes("invalid size") ||
    lower.includes("size must") ||
    lower.includes("min order size") ||
    lower.includes("lower than the minimum")
  ) {
    return { code: "INVALID_SIZE", message, details };
  }
  if (lower.includes("duplicate") || lower.includes("already exists")) {
    return { code: "DUPLICATE_CLIENT_ORDER_ID", message, details };
  }
  if (lower.includes("order not found") || lower.includes("order_not_found")) {
    return { code: "ORDER_NOT_FOUND", message, details };
  }
  if (lower.includes("market not found")) {
    return { code: "MARKET_NOT_FOUND", message, details };
  }
  if (lower.includes("market closed") || lower.includes("closed_only")) {
    return { code: "MARKET_CLOSED", message, details };
  }
  if (lower.includes("rate limit") || lower.includes("too many")) {
    return { code: "RATE_LIMITED", message, details };
  }
  if (lower.includes("nonce")) {
    return { code: "NONCE_ERROR", message, details };
  }
  if (
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed")
  ) {
    return { code: "NETWORK_ERROR", message, details };
  }
  if (
    lower.includes("auth") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    return { code: "AUTHENTICATION_FAILED", message, details };
  }

  return { code: "UNKNOWN", message, details };
}
