/**
 * Formats a ScenarioResult into a human-readable summary string.
 */

import type { ScenarioResult } from "./types.js";

export function formatRunSummary(name: string, result: ScenarioResult): string {
  const lines: string[] = [
    `═══ Scenario: ${name} ═══`,
    "",
    "Signals:",
    `  produced:  ${result.signalCount}`,
    `  approved:  ${result.approvedCount}`,
    `  rejected:  ${result.rejectedCount}`,
    "",
    "Orders:",
    `  placed:    ${result.placedOrderCount}`,
    `  cancelled: ${result.cancelledOrderCount}`,
    `  filled:    ${result.fillCount}`,
    "",
    "Positions:",
    `  open:      ${result.openPositionCount}`,
    `  dust:      ${result.dustPositionCount}`,
    "",
    "Financial:",
    `  realized PnL:  ${result.totalRealizedPnl.toFixed(2)}`,
    `  tail cost:     ${result.totalTailCostUsdc.toFixed(2)}`,
  ];

  lines.push("");
  lines.push(`Reconciliation ran: ${result.reconciliationRan}`);
  lines.push(`Final phase: ${result.finalPhase}`);
  lines.push("═══════════════════════════════════════");

  return lines.join("\n");
}
