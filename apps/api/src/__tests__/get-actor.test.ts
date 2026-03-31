import { describe, it, expect } from "vitest";
import { getActor } from "../auth.js";
import type { FastifyRequest } from "fastify";

function fakeRequest(opts: {
  sessionUsername?: string;
  bearerToken?: string;
}): FastifyRequest {
  return {
    session: opts.sessionUsername
      ? { get: (key: string) => (key === "username" ? opts.sessionUsername : undefined) }
      : undefined,
    headers: opts.bearerToken
      ? { authorization: `Bearer ${opts.bearerToken}` }
      : {},
  } as unknown as FastifyRequest;
}

describe("getActor", () => {
  it("returns session username when present", () => {
    expect(getActor(fakeRequest({ sessionUsername: "admin" }))).toBe("admin");
  });

  it("session username takes precedence over Bearer token", () => {
    expect(
      getActor(fakeRequest({ sessionUsername: "admin", bearerToken: "key123" })),
    ).toBe("admin");
  });

  it("returns 'api_key' for Bearer token auth without session", () => {
    expect(getActor(fakeRequest({ bearerToken: "key123" }))).toBe("api_key");
  });

  it("returns 'operator' as fallback when no auth identity", () => {
    expect(getActor(fakeRequest({}))).toBe("operator");
  });
});
