import pino, { type LoggerOptions } from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string, mode?: string): Logger {
  const opts: LoggerOptions = { level, ...(mode ? { base: { mode } } : {}) };

  if (process.env.NODE_ENV !== "production") {
    opts.transport = { target: "pino-pretty", options: { colorize: true } };
  }

  return pino(opts);
}
