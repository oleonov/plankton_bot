import { describe, expect, it } from "vitest";
import { redactSensitive, redactText, sanitizeErrorMessage } from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive nested SDK request config fields", () => {
    const redacted = redactSensitive({
      config: {
        headers: {
          POLY_API_KEY: "api-key-value",
          POLY_PASSPHRASE: "passphrase-value",
          POLY_SIGNATURE: "signature-value",
          POLY_BUILDER_API_KEY: "builder-key-value",
          Authorization: "Bearer bearer-value",
          tokenID: "market-token-id",
        },
      },
      amount: 43.13,
    }) as {
      config: { headers: Record<string, unknown> };
      amount: number;
    };

    expect(redacted.config.headers.POLY_API_KEY).toBe("********");
    expect(redacted.config.headers.POLY_PASSPHRASE).toBe("********");
    expect(redacted.config.headers.POLY_SIGNATURE).toBe("********");
    expect(redacted.config.headers.POLY_BUILDER_API_KEY).toBe("********");
    expect(redacted.config.headers.Authorization).toBe("********");
    expect(redacted.config.headers.tokenID).toBe("market-token-id");
    expect(redacted.amount).toBe(43.13);
  });

  it("redacts stringified headers without masking useful ids and amounts", () => {
    const text =
      "Authorization: Bearer bearer-value POLY_API_KEY: secret-value tokenID: 123456789 conditionId: 0xabc amount: 43.13 orderID: ord-1";

    const redacted = redactText(text);

    expect(redacted).toContain("Authorization: ********");
    expect(redacted).not.toContain("bearer-value");
    expect(redacted).toContain("POLY_API_KEY: ********");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).toContain("tokenID: 123456789");
    expect(redacted).toContain("conditionId: 0xabc");
    expect(redacted).toContain("amount: 43.13");
    expect(redacted).toContain("orderID: ord-1");
  });

  it("sanitizes axios-like errors while preserving exchange error data", () => {
    const err = new Error("Request failed");
    Object.assign(err, {
      response: {
        status: 400,
        data: {
          error:
            "not enough balance / allowance: balance: 43130000, sum of active orders: 43130000",
        },
      },
      config: {
        headers: {
          POLY_API_KEY: "api-key-value",
          POLY_BUILDER_SIGNATURE: "builder-signature-value",
        },
      },
    });

    const sanitized = sanitizeErrorMessage(err);

    expect(sanitized).toContain("not enough balance / allowance");
    expect(sanitized).toContain("43130000");
    expect(sanitized).not.toContain("api-key-value");
    expect(sanitized).not.toContain("builder-signature-value");
  });
});
