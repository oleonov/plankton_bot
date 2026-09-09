import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { Status } from "../../pages/status/Status.tsx";
import { Layout } from "../../components/Layout.tsx";
import { mockSystemHealth } from "../../test/handlers.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

describe("Status nav", () => {
  it("renders a Status nav item positioned after Settings", () => {
    const { container } = renderWithProviders(<Layout />);
    const status = screen.getByRole("link", { name: "Status" });
    const settings = screen.getByRole("button", { name: /Settings/ });
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute("href", "/status");
    // Status must come AFTER the Settings control in DOM order.
    const order = settings.compareDocumentPosition(status);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container).toBeTruthy();
  });
});

describe("Status page", () => {
  it("renders hero, modules, dependencies, db and shadow registry", async () => {
    const { container } = renderWithProviders(<Status />);

    // hero verdict (mock is all-ok) — query the verdict node specifically since
    // the dependency pills also render "OK".
    await screen.findByText("All systems nominal — no active problems");
    expect(container.querySelector(".hero .st")).toHaveTextContent("OK");

    // sections
    expect(screen.getByText("System modules")).toBeInTheDocument();
    expect(screen.getByText("scanner")).toBeInTheDocument();
    expect(screen.getByText("External dependencies")).toBeInTheDocument();
    expect(screen.getByText("Database & storage")).toBeInTheDocument();

    // shadow registry — name + added date only
    expect(screen.getByText("Entry fresh-edge shadow")).toBeInTheDocument();
    expect(screen.getByText("added Jun 21")).toBeInTheDocument();
    expect(screen.queryByText("Two-lane entry shadow")).not.toBeInTheDocument();
    expect(screen.getByText(`${mockSystemHealth.shadow.length} registered`)).toBeInTheDocument();
  });

  it("is read-only — renders no trading/action buttons", async () => {
    const { container } = renderWithProviders(<Status />);
    await screen.findByText("All systems nominal — no active problems");
    const page = container.querySelector(".status-page")!;
    expect(page.querySelectorAll("button")).toHaveLength(0);
    expect(page.querySelectorAll("input,select,textarea")).toHaveLength(0);
  });

  it("renders unmeasured fields honestly as n/a, never as a healthy zero", async () => {
    const { container } = renderWithProviders(<Status />);
    await screen.findByText("All systems nominal — no active problems");
    const text = container.querySelector(".status-page")!.textContent ?? "";
    expect(text).toContain("SQLite locked n/a");
    expect(text).toContain("acct warnings n/a · UNKNOWN n/a");
    expect(text).toContain("n/a err"); // dependency error-rate is unmeasured
    expect(text).toContain("not sampled"); // dependency latency is unmeasured (Phase 2)
    expect(text).not.toContain("reachable"); // no longer claims more than it measures
    expect(text).not.toContain("SQLite locked ×0");
    expect(text).not.toContain("acct warnings 0");
  });

  it("renders unknown uptime as — instead of a fabricated 100%", async () => {
    server.use(
      http.get("/api/v1/system-health", () => ok({ ...mockSystemHealth, uptimePct: null })),
    );
    const { container } = renderWithProviders(<Status />);
    await screen.findByText("All systems nominal — no active problems");
    const uptoday = container.querySelector(".uptoday")!.textContent ?? "";
    expect(uptoday).toContain("—");
    expect(uptoday).not.toContain("100%");
  });

  it("warns when runtime error coverage is missing and does not render zeroes as healthy", async () => {
    server.use(
      http.get("/api/v1/system-health", () =>
        ok({
          ...mockSystemHealth,
          errors: { ...mockSystemHealth.errors, coverage: undefined },
        }),
      ),
    );
    const { container } = renderWithProviders(<Status />);

    await screen.findByText("Runtime error collection coverage incomplete");
    expect(screen.getByText(/Incomplete coverage · runtime only/)).toBeInTheDocument();
    expect(screen.getByText("No recorded errors; coverage is incomplete.")).toBeInTheDocument();
    expect(container.querySelectorAll(".errstat .n")[0]).toHaveTextContent("—");
    expect(container.querySelectorAll(".errstat .n")[1]).toHaveTextContent("—");
    expect(screen.queryByText("All systems nominal — no active problems")).not.toBeInTheDocument();
  });

  it("shadow section carries no verdict text or status/lane badges", async () => {
    const { container } = renderWithProviders(<Status />);
    await screen.findByText("Entry fresh-edge shadow");
    const exps = container.querySelector(".exps")!;
    const text = exps.textContent ?? "";
    for (const badge of ["SHADOW", "LIVE", "RESEARCH", "SCHEDULED REMOVAL"]) {
      expect(text).not.toContain(badge);
    }
    // no colored status dots in the registry rows
    expect(exps.querySelectorAll(".ed, .etag")).toHaveLength(0);
  });

  it("hides the global StatusBar and AlertStrip on /status", () => {
    renderWithProviders(<Layout />, { initialEntries: ["/status"] });
    expect(screen.queryByText(/uptime:/)).toBeNull();
  });

  it("keeps the global StatusBar on a normal page", async () => {
    renderWithProviders(<Layout />, { initialEntries: ["/overview"] });
    expect(await screen.findByText(/uptime:/)).toBeInTheDocument();
  });

  it("a paused bot shows an amber PAUSED hero, not a critical outage", async () => {
    server.use(
      http.get("/api/v1/system-health", () =>
        ok({
          ...mockSystemHealth,
          paused: true,
          pauseReason: "risk circuit breaker",
          tradingState: "PAUSED",
        }),
      ),
    );
    const { container } = renderWithProviders(<Status />);
    await screen.findByText(/Trading paused by operator/);
    const hero = container.querySelector(".hero")!;
    expect(hero.querySelector(".st")).toHaveTextContent("PAUSED");
    expect(hero.querySelector(".st")).not.toHaveTextContent("CRITICAL");
    expect(hero.getAttribute("data-sev")).toBe("WARNING"); // amber, not red
  });
});
