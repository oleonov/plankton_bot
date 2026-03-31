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
  status: "discovered",
};

function setupCandidate() {
  server.use(
    http.get("/api/v1/discovery/candidates", () =>
      ok({ items: [{ ...baseCandidate }], nextCursor: null }),
    ),
  );
}

describe("Discovery review confirmation", () => {
  it("Review → Cancel closes dialog without mutation", async () => {
    setupCandidate();
    const reviewHandler = vi.fn();
    server.use(
      http.post("/api/v1/discovery/candidates/cand-1/review", () => {
        reviewHandler();
        return ok({});
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const reviewBtn = await screen.findByRole("button", { name: "Review" });
    await user.click(reviewBtn);

    expect(screen.getByText("Review btc-above-50k?")).toBeInTheDocument();
    expect(
      screen.getByText("This will move the candidate to reviewed status for further evaluation."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Review btc-above-50k?")).not.toBeInTheDocument();
    expect(reviewHandler).not.toHaveBeenCalled();
  });

  it("Review → Confirm fires review mutation", async () => {
    setupCandidate();
    const reviewHandler = vi.fn();
    server.use(
      http.post("/api/v1/discovery/candidates/cand-1/review", () => {
        reviewHandler();
        return ok({});
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const reviewBtn = await screen.findByRole("button", { name: "Review" });
    await user.click(reviewBtn);
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(reviewHandler).toHaveBeenCalledTimes(1));
  });
});
