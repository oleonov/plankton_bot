import pino, { type LoggerOptions, type SerializerFn } from "pino";

export type Logger = pino.Logger;

// Compact error serializer that whitelists the fields operators actually need.
// pino.stdSerializers.err iterates `for (key in err)` and adds every enumerable
// own property back, which for native DOMException means re-inflating the 25
// enum constants (INDEX_SIZE_ERR..DATA_CLONE_ERR). We keep only name, message,
// stack, code, cause (recursive), and aggregated errors — everything else is
// ballast.
export const compactErrSerializer: SerializerFn = (err: unknown) => {
  return serializeErr(err, new WeakSet());
};

function serializeErr(err: unknown, seen: WeakSet<object>): unknown {
  if (err == null || typeof err !== "object") return err;
  if (seen.has(err)) return "[Circular]";
  seen.add(err);
  const e = err as Record<string, unknown> & { constructor?: { name?: string } };
  const out: Record<string, unknown> = {
    type: e.constructor?.name ?? "Error",
    message: typeof e.message === "string" ? e.message : undefined,
    stack: typeof e.stack === "string" ? e.stack : undefined,
  };
  if (e.code != null) out.code = e.code;
  if (e.cause != null) out.cause = serializeErr(e.cause, seen);
  if (Array.isArray(e.errors)) {
    out.errors = e.errors.map((sub) => serializeErr(sub, seen));
  }
  return out;
}

const REDACT_PATHS = [
  "authorization",
  "Authorization",
  "headers.authorization",
  "headers.Authorization",
  "headers.cookie",
  "headers.Cookie",
  "headers.POLY_API_KEY",
  "headers.POLY_API_SECRET",
  "headers.POLY_PASSPHRASE",
  "headers.POLY_SIGNATURE",
  "headers.POLY_TIMESTAMP",
  "headers.POLY_BUILDER_API_KEY",
  "headers.POLY_BUILDER_SECRET",
  "headers.POLY_BUILDER_PASSPHRASE",
  "headers.POLY_BUILDER_SIGNATURE",
  "headers.POLY_BUILDER_TIMESTAMP",
  "headers.POLY_PRIVATE_KEY",
  "headers.KRABS_API_KEY",
  "err.config.headers.authorization",
  "err.config.headers.Authorization",
  "err.config.headers.cookie",
  "err.config.headers.Cookie",
  "err.config.headers.POLY_API_KEY",
  "err.config.headers.POLY_API_SECRET",
  "err.config.headers.POLY_PASSPHRASE",
  "err.config.headers.POLY_SIGNATURE",
  "err.config.headers.POLY_TIMESTAMP",
  "err.config.headers.POLY_BUILDER_API_KEY",
  "err.config.headers.POLY_BUILDER_SECRET",
  "err.config.headers.POLY_BUILDER_PASSPHRASE",
  "err.config.headers.POLY_BUILDER_SIGNATURE",
  "err.config.headers.POLY_BUILDER_TIMESTAMP",
  "err.config.headers.POLY_PRIVATE_KEY",
  "err.config.headers.KRABS_API_KEY",
  "alert.details.headers.authorization",
  "alert.details.headers.Authorization",
  "alert.details.headers.POLY_API_KEY",
  "alert.details.headers.POLY_API_SECRET",
  "alert.details.headers.POLY_PASSPHRASE",
  "alert.details.headers.POLY_SIGNATURE",
  "alert.details.headers.POLY_BUILDER_API_KEY",
  "alert.details.headers.POLY_BUILDER_SECRET",
  "alert.details.headers.POLY_BUILDER_PASSPHRASE",
  "alert.details.headers.POLY_BUILDER_SIGNATURE",
  "alert.details.headers.POLY_PRIVATE_KEY",
  "alert.details.headers.KRABS_API_KEY",
] as const;

export function createLogger(level: string, mode?: string): Logger {
  const opts: LoggerOptions = {
    level,
    redact: { paths: [...REDACT_PATHS], censor: "********" },
    // Custom err serializer — whitelist type/message/stack/code/cause/errors.
    // pino.stdSerializers.err would re-add native DOMException's 25 enum
    // constants (INDEX_SIZE_ERR..DATA_CLONE_ERR) via its for-in loop, which
    // inflates every scan-timeout log by ~600 B.
    serializers: { err: compactErrSerializer },
    ...(mode ? { base: { mode } } : {}),
  };

  if (process.env.NODE_ENV !== "production") {
    opts.transport = { target: "pino-pretty", options: { colorize: true } };
  }

  return pino(opts);
}
