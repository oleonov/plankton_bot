import { afterEach, expect, it, vi } from "vitest";
import { installConsoleRedaction } from "../console-redaction.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("redacts serialized CLOB L2 headers before the SDK writes them to stderr", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  installConsoleRedaction();
  const installedError = console.error;
  installConsoleRedaction();
  expect(console.error).toBe(installedError);

  console.error(
    "[CLOB Client] request error",
    '{"headers":{"POLY_API_KEY":"api-key","POLY_SIGNATURE":"signature"}}',
  );
  console.warn({ headers: { POLY_PASSPHRASE: "passphrase" } });

  expect(error).toHaveBeenCalledOnce();
  expect(JSON.stringify(error.mock.calls[0])).not.toContain("api-key");
  expect(JSON.stringify(error.mock.calls[0])).not.toContain("signature");
  expect(JSON.stringify(error.mock.calls[0])).toContain("********");
  expect(warn).toHaveBeenCalledWith({ headers: { POLY_PASSPHRASE: "********" } });
});
