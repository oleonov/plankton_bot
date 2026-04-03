import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { ProposalPanel } from "../../components/ProposalPanel.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

function fail(status: number, code: string, message: string) {
  return HttpResponse.json(
    { ok: false, data: null, error: { code, message }, ts: new Date().toISOString() },
    { status },
  );
}

const proposal = {
  id: 11,
  familyId: "btc-updown-4h:directional-updown:intraday-4h",
  currentState: "probe-only",
  proposedState: "scaled",
  reason: "Auto: recycle=0.87, toxicity=0.00, trades=37",
  scoresSnapshot: JSON.stringify({
    recurrence: null,
    recycle: 0.87,
    liveViability: null,
    toxicity: 0,
  }),
};

function setupProposalPanel(evidence: Record<string, unknown> | null) {
  server.use(
    http.get("/api/v1/families/proposals", () => ok([proposal])),
    http.get("/api/v1/families/:familyId/evidence", () => ok(evidence)),
  );
}

describe("ProposalPanel", () => {
  it("disables approve and shows execution canary blockers when proposal is blocked", async () => {
    setupProposalPanel({
      familyId: proposal.familyId,
      evidenceStatus: "confirmed",
      evidenceScore: 0.8,
      promotionState: "probe-only",
      localTradeCount: 37,
      localMarketCount: 6,
      localRealizedPnlFifo: 4,
      openTailCostUsdc: 1,
      tailAdjustedPnl: 3,
      remoteClosedRealizedPnl: null,
      openPositionCount: 1,
      openDustCount: 0,
      bothSidedEligible: false,
      heavyCampaignEligible: false,
      activeWindowEdgeScore: null,
      recurrenceScore: 0.6,
      recycleScore: 0.87,
      liveViabilityScore: 0.5,
      toxicityPenalty: 0,
      lastValidatedAt: "2026-04-03T04:02:59.525Z",
      probeSubstate: null,
      repricingExitCount: 12,
      promotionBlockers: [],
      executionCanary24h: {
        windowHours: 24,
        required: true,
        eligible: false,
        minTotalFills: 10,
        blockers: [
          { metric: "24h fills", current: 12, required: 10, passed: true },
          { metric: "Maker ratio %", current: 0, required: 100, passed: false },
          { metric: "Unknown fills", current: 12, required: 0, passed: false },
        ],
      },
    });

    renderWithProviders(<ProposalPanel />);

    expect(await screen.findByText(proposal.familyId)).toBeInTheDocument();
    expect(await screen.findByText("Approve Blocked (24h execution canary)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Blocked" })).toBeDisabled();
    expect(screen.getByText("Maker ratio %")).toBeInTheDocument();
    expect(screen.getByText("Unknown fills")).toBeInTheDocument();
  });

  it("shows backend error after confirm instead of failing silently", async () => {
    setupProposalPanel({
      familyId: proposal.familyId,
      evidenceStatus: "confirmed",
      evidenceScore: 0.8,
      promotionState: "probe-only",
      localTradeCount: 37,
      localMarketCount: 6,
      localRealizedPnlFifo: 4,
      openTailCostUsdc: 1,
      tailAdjustedPnl: 3,
      remoteClosedRealizedPnl: null,
      openPositionCount: 1,
      openDustCount: 0,
      bothSidedEligible: false,
      heavyCampaignEligible: false,
      activeWindowEdgeScore: null,
      recurrenceScore: 0.6,
      recycleScore: 0.87,
      liveViabilityScore: 0.5,
      toxicityPenalty: 0,
      lastValidatedAt: "2026-04-03T04:02:59.525Z",
      probeSubstate: null,
      repricingExitCount: 12,
      promotionBlockers: [],
      executionCanary24h: {
        windowHours: 24,
        required: true,
        eligible: true,
        minTotalFills: 10,
        blockers: [],
      },
    });
    server.use(
      http.post(`/api/v1/actions/family/${proposal.familyId}/promote`, () =>
        fail(
          409,
          "PROMOTION_BLOCKED_BY_EXECUTION_CANARY",
          "promotion blocked by execution canary: 0% maker, 12 unknown fills",
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ProposalPanel />);

    expect(await screen.findByText(proposal.familyId)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText(`Promote ${proposal.familyId}?`)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(
      await screen.findByText(
        "Error: promotion blocked by execution canary: 0% maker, 12 unknown fills",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(proposal.familyId)).toBeInTheDocument();
  });
});
