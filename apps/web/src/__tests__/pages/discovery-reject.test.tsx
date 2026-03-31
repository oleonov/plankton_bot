import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { Discovery } from "../../pages/Discovery.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

const baseCandidate = {
  candidateId: "cand-1",
  familyKey: "btc-above-50k",
  regime: "threshold",
  horizon: "weekly",
  recurrenceScore: 0.85,
  liveViabilityScore: 0.72,
  gateRecommendation: "probe-candidate",
  patternConfidence: "high",
  lastSeenAt: "2026-03-31T00:00:00Z",
  scoresUpdatedAt: "2026-03-31T00:00:00Z",
  materializedAt: null,
};

function setupCandidate(status: string) {
  server.use(
    http.get("/api/v1/discovery/candidates", () =>
      ok({ items: [{ ...baseCandidate, status }], nextCursor: null }),
    ),
  );
}

describe("Discovery reject confirmation", () => {
  it("discovered → Reject → Cancel closes dialog without mutation", async () => {
    setupCandidate("discovered");
    const rejectHandler = vi.fn();
    server.use(
      http.post("/api/v1/discovery/candidates/cand-1/reject", () => {
        rejectHandler();
        return ok({});
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const rejectBtn = await screen.findByRole("button", { name: "Reject" });
    await user.click(rejectBtn);

    expect(screen.getByText("Reject btc-above-50k?")).toBeInTheDocument();
    expect(screen.getByText("This candidate will be hidden for 7 days (cooldown period).")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Reject btc-above-50k?")).not.toBeInTheDocument();
    expect(rejectHandler).not.toHaveBeenCalled();
  });

  it("discovered → Reject → Confirm fires reject mutation", async () => {
    setupCandidate("discovered");
    const rejectHandler = vi.fn();
    server.use(
      http.post("/api/v1/discovery/candidates/cand-1/reject", () => {
        rejectHandler();
        return ok({});
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const rejectBtn = await screen.findByRole("button", { name: "Reject" });
    await user.click(rejectBtn);
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(rejectHandler).toHaveBeenCalledTimes(1));
  });

  it("reviewed → Reject → Confirm fires reject mutation", async () => {
    setupCandidate("reviewed");
    const rejectHandler = vi.fn();
    server.use(
      http.post("/api/v1/discovery/candidates/cand-1/reject", () => {
        rejectHandler();
        return ok({});
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const rejectBtn = await screen.findByRole("button", { name: "Reject" });
    await user.click(rejectBtn);
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(rejectHandler).toHaveBeenCalledTimes(1));
  });
});
