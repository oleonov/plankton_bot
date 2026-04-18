/**
 * Universe Migration — placeholder stub.
 *
 * Family-based universe migration was removed in Phase 6 of the
 * "Selection Rules Replace Families" refactor. This module is retained
 * for interface compatibility and is a no-op.
 */

export interface MigrationResult {
  closedCount: number;
  closedPositionIds: string[];
}

export function migrateOrphanedPositions(): MigrationResult {
  return { closedCount: 0, closedPositionIds: [] };
}
