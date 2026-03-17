/**
 * API error types and response envelope helper.
 *
 * Error shape matches design doc: { code: string, message: string }
 */

export interface ApiErrorBody {
  code: string;
  message: string;
}

export interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error: ApiErrorBody | null;
  ts: string;
}

export function ok<T>(data: T): ApiEnvelope<T> {
  return { ok: true, data, error: null, ts: new Date().toISOString() };
}

export function fail(code: string, message: string): ApiEnvelope<null> {
  return { ok: false, data: null, error: { code, message }, ts: new Date().toISOString() };
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = "UNKNOWN",
  ) {
    super(message);
    this.name = "ApiError";
  }
}
