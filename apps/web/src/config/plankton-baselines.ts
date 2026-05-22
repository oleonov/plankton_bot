/**
 * 30-day baselines computed from the Plankton trade history.
 * Numbers are pinned by `research_plankton/plankton_winrate_baseline_2026-05-22.md`
 * and the design handoff (`design_handoff_dashboard_kpi_cards/README.md`).
 */
export const PLANKTON_BASELINES = {
  winrate: 84.92,
  winrateSellClosed: 97.47,
  winrateResolved: 48.74,
  exitMultipleMedian: 3.0,
  exitMultipleP90: 5.59,
  makerRatio: 91.42,
  makerRatioBuy: 96.35,
  makerRatioSell: 83.04,
  fillsPerPositionPerDay: 0.75,
  sellFillsPerPositionPerDay: 0.37,
};

/**
 * Per-KPI green/yellow thresholds. Below `yellow` is `crit`.
 * `fillsRate` constants are 0.7x and 0.3x of the `fillsPerPositionPerDay` baseline.
 */
export const KPI_THRESHOLDS = {
  winrate: { green: 80, yellow: 65 },
  exitMultiple: { green: 2.5, yellow: 1.5 },
  fillsRate: { green: 0.52, yellow: 0.22 },
  makerRatio: { green: 88, yellow: 75 },
};

/** Sub-metric thresholds shown inside the Winrate card breakdown rows. */
export const SUB_METRIC_THRESHOLDS = {
  sellClosed: { green: 95, yellow: 90 },
  resolvedClosed: { green: 60, yellow: 40 },
};
