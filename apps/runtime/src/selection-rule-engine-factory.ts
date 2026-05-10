import { SelectionRuleEngine } from "@krabs/domain";
import type { SelectionRuleRepository } from "@krabs/db";

/**
 * Wraps SelectionRuleEngine with version-polled hot reload.
 *
 * Each runtime tick calls refreshIfStale(); if selection_rules_version in
 * runtime_control_state has advanced since the last refresh the engine is
 * rebuilt from the current rule set. No concurrent refresh is possible in
 * the single-threaded Node event loop — a simple "if changed, reload"
 * pattern is sufficient.
 */
export class RefreshableSelectionRuleEngine {
  private engine: SelectionRuleEngine;
  private version: number;

  constructor(
    private readonly repo: SelectionRuleRepository,
    private readonly profileId: string,
  ) {
    this.version = repo.getVersion();
    this.engine = new SelectionRuleEngine(repo.list(profileId));
  }

  /** Call once per tick; rebuilds the engine when the DB version has advanced. */
  refreshIfStale(): void {
    const current = this.repo.getVersion();
    if (current === this.version) return;
    this.version = current;
    this.engine = new SelectionRuleEngine(this.repo.list(this.profileId));
  }

  /** Delegate to the current engine's resolve. */
  resolve(
    ...args: Parameters<SelectionRuleEngine["resolve"]>
  ): ReturnType<SelectionRuleEngine["resolve"]> {
    return this.engine.resolve(...args);
  }

  /** Expose the current engine instance for callers that need to pass it to evaluatePreEntry. */
  get current(): SelectionRuleEngine {
    return this.engine;
  }
}
