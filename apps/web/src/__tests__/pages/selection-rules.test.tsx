/**
 * SelectionRules page — MSW-backed integration tests.
 * Covers: create, toggle enable/disable, delete, preview panel, match debugger,
 * empty state, and error state.
 */
import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { SelectionRules } from "../../pages/SelectionRules.tsx";
import { mockSelectionRules } from "../../test/handlers.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setup() {
  return renderWithProviders(<SelectionRules />);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SelectionRules page", () => {
  describe("rules table", () => {
    it("renders all seeded rules in the table", async () => {
      setup();

      await screen.findByTestId("rules-table");
      expect(screen.getByText("bitcoin-")).toBeInTheDocument();
      expect(screen.getByText("bitcoin-to-150k-by-2025")).toBeInTheDocument();
      expect(screen.getByText("elon-musk-")).toBeInTheDocument();
    });

    it("shows empty state when no rules exist", async () => {
      server.use(http.get("/api/v1/selection-rules", () => ok({ rules: [] })));
      setup();

      await screen.findByTestId("rules-empty");
      expect(screen.getByText(/No selection rules yet/)).toBeInTheDocument();
    });

    it("shows error state when API fails", async () => {
      server.use(
        http.get("/api/v1/selection-rules", () =>
          HttpResponse.json(
            { ok: false, data: null, error: { code: "ERR", message: "Server error" }, ts: "" },
            { status: 500 },
          ),
        ),
      );

      setup();

      await screen.findByTestId("error-state");
      expect(screen.getByText(/Server error/)).toBeInTheDocument();
    });
  });

  describe("create form", () => {
    it("submits a new include_prefix rule and clears the form", async () => {
      const user = userEvent.setup();
      const createdRules: unknown[] = [];

      server.use(
        http.post("/api/v1/selection-rules", async ({ request }) => {
          const body = await request.json();
          createdRules.push(body);
          return ok({
            rule: {
              ruleId: "rule-new",
              profileId: "simulation",
              ruleType: "include_prefix",
              pattern: "crypto-",
              enabled: true,
              note: "Test rule",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          });
        }),
      );

      setup();
      await screen.findByTestId("create-form");

      await user.selectOptions(screen.getByTestId("rule-type-select"), "include_prefix");
      await user.type(screen.getByTestId("pattern-input"), "crypto-");
      await user.type(screen.getByTestId("note-input"), "Test rule");
      await user.click(screen.getByTestId("submit-create"));

      await waitFor(() => {
        expect(createdRules).toHaveLength(1);
      });

      expect(createdRules[0]).toMatchObject({
        ruleType: "include_prefix",
        pattern: "crypto-",
        note: "Test rule",
      });
    });

    it("normalizes pattern to lowercase on submit", async () => {
      const user = userEvent.setup();
      const createdPatterns: string[] = [];

      server.use(
        http.post("/api/v1/selection-rules", async ({ request }) => {
          const body = (await request.json()) as { pattern: string };
          createdPatterns.push(body.pattern);
          return ok({
            rule: {
              ruleId: "rule-new",
              profileId: "simulation",
              ruleType: "include_prefix",
              pattern: body.pattern,
              enabled: true,
              note: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          });
        }),
      );

      setup();
      await screen.findByTestId("create-form");

      await user.type(screen.getByTestId("pattern-input"), "BITCOIN-");
      await user.click(screen.getByTestId("submit-create"));

      await waitFor(() => {
        expect(createdPatterns).toHaveLength(1);
      });

      expect(createdPatterns[0]).toBe("bitcoin-");
    });

    it("shows normalization preview when pattern has uppercase", async () => {
      const user = userEvent.setup();
      setup();
      await screen.findByTestId("create-form");

      await user.type(screen.getByTestId("pattern-input"), "Bitcoin-");

      await screen.findByTestId("normalized-preview");
      expect(screen.getByTestId("normalized-preview")).toHaveTextContent("bitcoin-");
    });

    it("disables submit when pattern is empty", async () => {
      setup();
      await screen.findByTestId("create-form");

      const submitBtn = screen.getByTestId("submit-create");
      expect(submitBtn).toBeDisabled();
    });
  });

  describe("enable/disable toggle", () => {
    it("sends PATCH with enabled=false when toggling an enabled rule", async () => {
      const patchedRuleIds: string[] = [];
      const patchedPayloads: unknown[] = [];

      server.use(
        http.patch("/api/v1/selection-rules/:ruleId", async ({ params, request }) => {
          patchedRuleIds.push(String(params.ruleId));
          const body = await request.json();
          patchedPayloads.push(body);
          const rule = mockSelectionRules.find((r) => r.ruleId === params.ruleId);
          return ok({ rule: { ...rule, enabled: false } });
        }),
      );

      const user = userEvent.setup();
      setup();

      await screen.findByTestId("rules-table");

      // rule-1 is "bitcoin-" with enabled=true
      await user.click(screen.getByTestId("toggle-rule-1"));

      await waitFor(() => {
        expect(patchedRuleIds).toContain("rule-1");
      });

      expect(patchedPayloads[0]).toMatchObject({ enabled: false });
    });

    it("sends PATCH with enabled=true when toggling a disabled rule", async () => {
      const disabledRules = mockSelectionRules.map((r) =>
        r.ruleId === "rule-2" ? { ...r, enabled: false } : r,
      );
      server.use(http.get("/api/v1/selection-rules", () => ok({ rules: disabledRules })));

      const patchedPayloads: unknown[] = [];
      server.use(
        http.patch("/api/v1/selection-rules/:ruleId", async ({ params, request }) => {
          const body = await request.json();
          patchedPayloads.push(body);
          const rule = disabledRules.find((r) => r.ruleId === params.ruleId)!;
          return ok({ rule: { ...rule, ...(body as object) } });
        }),
      );

      const user = userEvent.setup();
      setup();

      await screen.findByTestId("rules-table");

      // rule-2 is now disabled → clicking toggle should enable it
      await user.click(screen.getByTestId("toggle-rule-2"));

      await waitFor(() => {
        expect(patchedPayloads).toHaveLength(1);
      });

      expect(patchedPayloads[0]).toMatchObject({ enabled: true });
    });
  });

  describe("delete", () => {
    it("calls DELETE endpoint after confirmation", async () => {
      const deletedRuleIds: string[] = [];

      server.use(
        http.delete("/api/v1/selection-rules/:ruleId", ({ params }) => {
          deletedRuleIds.push(String(params.ruleId));
          return ok({ deleted: true, ruleId: params.ruleId });
        }),
      );

      // Mock window.confirm to return true
      const originalConfirm = window.confirm;
      window.confirm = () => true;

      const user = userEvent.setup();
      setup();

      await screen.findByTestId("rules-table");
      await user.click(screen.getByTestId("delete-rule-1"));

      await waitFor(() => {
        expect(deletedRuleIds).toContain("rule-1");
      });

      window.confirm = originalConfirm;
    });

    it("does not call DELETE when confirmation is cancelled", async () => {
      const deletedRuleIds: string[] = [];

      server.use(
        http.delete("/api/v1/selection-rules/:ruleId", ({ params }) => {
          deletedRuleIds.push(String(params.ruleId));
          return ok({ deleted: true, ruleId: params.ruleId });
        }),
      );

      const originalConfirm = window.confirm;
      window.confirm = () => false;

      const user = userEvent.setup();
      setup();

      await screen.findByTestId("rules-table");
      await user.click(screen.getByTestId("delete-rule-1"));

      // Give time for any async effects
      await waitFor(() => {}, { timeout: 200 });
      expect(deletedRuleIds).toHaveLength(0);

      window.confirm = originalConfirm;
    });
  });

  describe("preview panel", () => {
    it("toggles the preview panel open and shows bucket counts", async () => {
      const user = userEvent.setup();
      setup();

      await screen.findByTestId("preview-toggle");

      // Panel is collapsed by default
      expect(screen.queryByText("Matched Include")).not.toBeInTheDocument();

      await user.click(screen.getByTestId("preview-toggle"));

      // Now open — should show bucket headers
      await screen.findByText("Matched Include (1)");
      expect(screen.getByText("Matched Exclude (1)")).toBeInTheDocument();
      expect(screen.getByText("Step-2 Fallback Include (0)")).toBeInTheDocument();
      expect(screen.getByText("Fallback Exclude (0)")).toBeInTheDocument();
    });

    it("shows INCLUDE count in toggle button label", async () => {
      setup();
      await screen.findByTestId("preview-toggle");
      // Preview data from handler: 1 matchedInclude + 0 step2 = 1 INCLUDE
      // 1 matchedExclude + 0 fallback = 1 EXCLUDE
      await waitFor(() => {
        expect(screen.getByTestId("preview-toggle")).toHaveTextContent("1 INCLUDE · 1 EXCLUDE");
      });
    });

    it("shows market slug in the correct bucket", async () => {
      const user = userEvent.setup();
      setup();
      await screen.findByTestId("preview-toggle");
      await user.click(screen.getByTestId("preview-toggle"));

      await screen.findByText("bitcoin-above-100k");
    });
  });

  describe("match debugger", () => {
    it("tests a market slug and shows match result", async () => {
      server.use(
        http.get("/api/v1/selection-rules/match", () =>
          ok({
            decision: "include",
            winningRuleId: "rule-1",
            finalStatus: "INCLUDE",
            step2Fallback: false,
          }),
        ),
      );

      const user = userEvent.setup();
      setup();

      await screen.findByTestId("match-debugger-form");

      await user.type(screen.getByTestId("event-slug-input"), "bitcoin-price-2026");
      await user.type(screen.getByTestId("market-slug-input"), "bitcoin-above-100k");
      await user.click(screen.getByTestId("match-test-button"));

      await screen.findByTestId("match-result");
      expect(screen.getByTestId("match-result")).toHaveTextContent("INCLUDE");
      expect(screen.getByTestId("match-result")).toHaveTextContent("rule-1");
    });

    it("shows EXCLUDE result for excluded slug", async () => {
      server.use(
        http.get("/api/v1/selection-rules/match", () =>
          ok({
            decision: "exclude",
            winningRuleId: "rule-2",
            finalStatus: "EXCLUDE",
            step2Fallback: false,
          }),
        ),
      );

      const user = userEvent.setup();
      setup();

      await screen.findByTestId("match-debugger-form");

      await user.type(screen.getByTestId("event-slug-input"), "bitcoin-price-2026");
      await user.type(screen.getByTestId("market-slug-input"), "bitcoin-to-150k-by-2025");
      await user.click(screen.getByTestId("match-test-button"));

      await screen.findByTestId("match-result");
      expect(screen.getByTestId("match-result")).toHaveTextContent("EXCLUDE");
    });

    it("shows step-2 fallback label when step2Fallback is true", async () => {
      server.use(
        http.get("/api/v1/selection-rules/match", () =>
          ok({
            decision: "no_match",
            winningRuleId: null,
            finalStatus: "INCLUDE",
            step2Fallback: true,
          }),
        ),
      );

      const user = userEvent.setup();
      setup();

      await screen.findByTestId("match-debugger-form");

      await user.type(screen.getByTestId("market-slug-input"), "some-unique-market");
      await user.click(screen.getByTestId("match-test-button"));

      await screen.findByTestId("match-result");
      expect(screen.getByTestId("match-result")).toHaveTextContent("Step-2 fallback applied");
    });

    it("disables Test button when market slug is empty", async () => {
      setup();
      await screen.findByTestId("match-debugger-form");

      const testBtn = screen.getByTestId("match-test-button");
      expect(testBtn).toBeDisabled();
    });

    it("populates event slug autocomplete options from API", async () => {
      setup();
      await screen.findByTestId("match-debugger-form");

      // Event slugs are loaded in the background; wait for them
      await waitFor(() => {
        const datalist = document.getElementById("event-slugs-list");
        expect(datalist).not.toBeNull();
        const options = datalist?.querySelectorAll("option");
        expect(options?.length).toBeGreaterThan(0);
      });

      const datalist = document.getElementById("event-slugs-list");
      const optionValues = Array.from(datalist?.querySelectorAll("option") ?? []).map(
        (o) => o.value,
      );
      expect(optionValues).toContain("bitcoin-price-2026");
    });

    it("fires match query only after Test button is clicked, not on every keystroke", async () => {
      const matchRequests: string[] = [];
      server.use(
        http.get("/api/v1/selection-rules/match", ({ request }) => {
          matchRequests.push(request.url);
          return ok({
            decision: "include",
            winningRuleId: "rule-1",
            finalStatus: "INCLUDE",
            step2Fallback: false,
          });
        }),
      );

      const user = userEvent.setup();
      setup();
      await screen.findByTestId("match-debugger-form");

      await user.type(screen.getByTestId("market-slug-input"), "bitcoin-above");

      // No requests yet (query is disabled until Test is clicked)
      expect(matchRequests).toHaveLength(0);

      // Now click Test
      fireEvent.click(screen.getByTestId("match-test-button"));
      await screen.findByTestId("match-result");
      expect(matchRequests).toHaveLength(1);
    });
  });
});
