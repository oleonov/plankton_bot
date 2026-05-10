/* eslint-disable no-console -- wraps console before third-party SDK logs can leak secrets. */
import { sanitizeLogArg } from "@krabs/exchange";

let installed = false;

export function installConsoleRedaction(): void {
  if (installed) return;
  installed = true;

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    originalError(...args.map((arg) => sanitizeLogArg(arg)));
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args.map((arg) => sanitizeLogArg(arg)));
  };
}
