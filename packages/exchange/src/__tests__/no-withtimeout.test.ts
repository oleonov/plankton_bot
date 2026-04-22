/**
 * Regression fence: Task 6 (socket-leak fix plan 2026-04-22).
 *
 * The old `withTimeout` helper was a `Promise.race` wrapper that rejected the
 * JS-level promise on timer expiry but did NOT abort the underlying axios
 * request — the HTTP socket kept streaming into the kernel Recv-Q, causing the
 * sock-memory leak documented in the plan. This test asserts the helper is gone
 * and cannot silently re-appear.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const GATEWAY_PATH = resolve(import.meta.dirname, "../live/market-data-gateway.ts");

describe("no-withtimeout regression fence", () => {
  it("market-data-gateway.ts must not contain withTimeout", () => {
    const source = readFileSync(GATEWAY_PATH, "utf8");
    expect(source).not.toContain("withTimeout");
  });
});
