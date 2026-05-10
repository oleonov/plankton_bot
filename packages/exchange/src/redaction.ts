import { inspect } from "node:util";

const REDACTION_MARKER = "********";

const SENSITIVE_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|poly_api_key|poly_api_secret|poly_passphrase|poly_signature|poly_timestamp|poly_builder_api_key|poly_builder_secret|poly_builder_passphrase|poly_builder_signature|poly_builder_timestamp|poly_private_key|krabs_api_key)$/i;

// Matches `KEY: value`, `KEY=value`, `"KEY":"value"`, `'KEY':'value'` — the
// optional quote between the key and the colon lets JSON-stringified payloads
// (e.g. Axios/clob-client headers serialized via JSON.stringify before being
// passed to console.error) get redacted along with plain `k: v` text.
const STRING_KEY_VALUE_PATTERN =
  /\b(cookie|set-cookie|POLY_API_KEY|POLY_API_SECRET|POLY_PASSPHRASE|POLY_SIGNATURE|POLY_TIMESTAMP|POLY_BUILDER_API_KEY|POLY_BUILDER_SECRET|POLY_BUILDER_PASSPHRASE|POLY_BUILDER_SIGNATURE|POLY_BUILDER_TIMESTAMP|POLY_PRIVATE_KEY|KRABS_API_KEY)\b["']?\s*[:=]\s*(['"]?)[^'",\s}\]]+\2/gi;

const AUTHORIZATION_BEARER_PATTERN =
  /\b(authorization)\b["']?\s*[:=]\s*(['"]?)Bearer\s+[A-Za-z0-9._~+/=-]+\2/gi;

const BARE_BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactSensitive<T>(value: T): T {
  return redactValue(value, new WeakSet()) as T;
}

export function redactText(text: string): string {
  return text
    .replace(AUTHORIZATION_BEARER_PATTERN, (_match, key: string, quote = "") => {
      return `${key}: ${quote}${REDACTION_MARKER}${quote}`;
    })
    .replace(BARE_BEARER_PATTERN, `Bearer ${REDACTION_MARKER}`)
    .replace(STRING_KEY_VALUE_PATTERN, (_match, key: string, quote = "") => {
      return `${key}: ${quote}${REDACTION_MARKER}${quote}`;
    });
}

export function sanitizeErrorMessage(err: unknown): string {
  const details = extractErrorDetails(err);
  return redactText(details.join(" | "));
}

export function sanitizeErrorDetails(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const maybeRecord = err as Error & {
      code?: unknown;
      response?: { data?: unknown; status?: unknown; statusText?: unknown };
      config?: { url?: unknown; method?: unknown };
    };
    return redactSensitive({
      name: err.name,
      message: err.message,
      code: maybeRecord.code ?? null,
      status: maybeRecord.response?.status ?? null,
      statusText: maybeRecord.response?.statusText ?? null,
      responseBody: maybeRecord.response?.data ?? null,
      method: maybeRecord.config?.method ?? null,
      url: maybeRecord.config?.url ?? null,
    }) as Record<string, unknown>;
  }
  return { value: redactSensitive(err) };
}

export function sanitizeLogArg(arg: unknown): unknown {
  if (typeof arg === "string") return redactText(arg);
  return redactSensitive(arg);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value == null || typeof value !== "object") return value;

  if (value instanceof Error) return redactError(value, seen);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(input)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTION_MARKER : redactValue(nested, seen);
  }
  return output;
}

function redactError(err: Error, seen: WeakSet<object>): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: err.name,
    message: redactText(err.message),
  };
  if (err.stack) output.stack = redactText(err.stack);
  for (const [key, value] of Object.entries(err as unknown as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTION_MARKER : redactValue(value, seen);
  }
  return output;
}

function extractErrorDetails(err: unknown): string[] {
  if (err instanceof Error) {
    const details = [err.message];
    const maybeRecord = err as Error & {
      response?: { data?: unknown; status?: unknown; statusText?: unknown };
      config?: { url?: unknown; method?: unknown };
    };
    if (maybeRecord.response?.status != null)
      details.push(`status ${String(maybeRecord.response.status)}`);
    if (maybeRecord.response?.statusText != null)
      details.push(String(maybeRecord.response.statusText));
    if (maybeRecord.response?.data != null)
      details.push(stringifyUnknown(maybeRecord.response.data));
    if (maybeRecord.config?.method != null || maybeRecord.config?.url != null) {
      details.push(
        `${String(maybeRecord.config.method ?? "")} ${String(maybeRecord.config.url ?? "")}`.trim(),
      );
    }
    return details;
  }
  return [stringifyUnknown(err)];
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  return inspect(redactSensitive(value), { depth: 6, breakLength: Infinity });
}
