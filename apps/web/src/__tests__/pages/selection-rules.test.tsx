/**
 * SelectionRules page — MSW-backed integration tests.
 * Covers: create, toggle enable/disable, delete, empty state, and error state.
 */
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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
    it("renders active slug rules and hides deprecated prefix rows", async () => {
      setup();

      await screen.findByTestId("rules-table");
      expect(screen.getByText("bitcoin-to-150k-by-2025")).toBeInTheDocument();
      expect(screen.queryByText("bitcoin-")).not.toBeInTheDocument();
      expect(screen.queryByText("elon-musk-")).not.toBeInTheDocument();
      expect(screen.queryByTestId("ignored-rules-notice")).not.toBeInTheDocument();
    });

    it("does not render legacy preview or match-debugger controls", async () => {
      setup();

      await screen.findByTestId("rules-table");
      expect(screen.queryByTestId("preview-toggle")).not.toBeInTheDocument();
      expect(screen.queryByTestId("match-debugger-form")).not.toBeInTheDocument();
    });

    it("shows empty state when no rules exist", async () => {
      server.use(http.get("/api/v1/selection-rules", () => ok({ rules: [] })));
      setup();

      await screen.findByTestId("rules-empty");
      expect(screen.getByText(/No manual market exclusions yet/)).toBeInTheDocument();
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
    it("submits a new exclude_slug rule and clears the form", async () => {
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
              ruleType: "exclude_slug",
              pattern: "crypto-market",
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

      expect(screen.queryByTestId("rule-type-select")).not.toBeInTheDocument();
      await user.type(screen.getByTestId("pattern-input"), "crypto-market");
      await user.type(screen.getByTestId("note-input"), "Test rule");
      await user.click(screen.getByTestId("submit-create"));

      await waitFor(() => {
        expect(createdRules).toHaveLength(1);
      });

      expect(createdRules[0]).toMatchObject({
        ruleType: "exclude_slug",
        pattern: "crypto-market",
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
              ruleType: "exclude_slug",
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

      await user.type(screen.getByTestId("pattern-input"), "BITCOIN-MARKET");
      await user.click(screen.getByTestId("submit-create"));

      await waitFor(() => {
        expect(createdPatterns).toHaveLength(1);
      });

      expect(createdPatterns[0]).toBe("bitcoin-market");
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

      await user.click(screen.getByTestId("toggle-rule-2"));

      await waitFor(() => {
        expect(patchedRuleIds).toContain("rule-2");
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
      await user.click(screen.getByTestId("delete-rule-2"));

      await waitFor(() => {
        expect(deletedRuleIds).toContain("rule-2");
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
      await user.click(screen.getByTestId("delete-rule-2"));

      // Give time for any async effects
      await waitFor(() => {}, { timeout: 200 });
      expect(deletedRuleIds).toHaveLength(0);

      window.confirm = originalConfirm;
    });
  });
});
