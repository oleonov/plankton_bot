import pino, { type LoggerOptions } from "pino";

export type Logger = pino.Logger;

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
  "headers.PLANKTON_API_KEY",
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
  "err.config.headers.PLANKTON_API_KEY",
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
  "alert.details.headers.PLANKTON_API_KEY",
] as const;

export function createLogger(level: string, mode?: string): Logger {
  const opts: LoggerOptions = {
    level,
    redact: { paths: [...REDACT_PATHS], censor: "********" },
    // Pino's default JSON.stringify of a native DOMException serializes its 25
    // enum constants (INDEX_SIZE_ERR..DATA_CLONE_ERR) + the full cause graph —
    // ~800 B per log. stdSerializers.err keeps only name/message/stack/code.
    serializers: { err: pino.stdSerializers.err },
    ...(mode ? { base: { mode } } : {}),
  };

  if (process.env.NODE_ENV !== "production") {
    opts.transport = { target: "pino-pretty", options: { colorize: true } };
  }

  return pino(opts);
}
