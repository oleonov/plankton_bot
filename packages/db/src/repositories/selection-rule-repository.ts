import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { normalizeSelectionPattern } from "@plankton/domain";
import type { SelectionRule, SelectionRuleType } from "@plankton/domain";

export interface SelectionRuleInsert {
  profileId: string;
  ruleType: SelectionRuleType;
  pattern: string;
  enabled: boolean;
  note: string | null;
}

export interface SelectionRulePatch {
  enabled?: boolean;
  note?: string | null;
}

interface Row {
  rule_id: string;
  profile_id: string;
  rule_type: SelectionRuleType;
  pattern: string;
  enabled: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export class SelectionRuleRepository {
  constructor(private readonly db: Database.Database) {}

  private toDomain(r: Row): SelectionRule {
    return {
      ruleId: r.rule_id,
      profileId: r.profile_id,
      ruleType: r.rule_type,
      pattern: r.pattern,
      enabled: r.enabled === 1,
      note: r.note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  insert(input: SelectionRuleInsert): SelectionRule {
    const ruleId = randomUUID();
    const pattern = normalizeSelectionPattern(input.pattern);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO selection_rules (rule_id, profile_id, rule_type, pattern, enabled, note)
           VALUES (@rule_id, @profile_id, @rule_type, @pattern, @enabled, @note)`,
        )
        .run({
          rule_id: ruleId,
          profile_id: input.profileId,
          rule_type: input.ruleType,
          pattern,
          enabled: input.enabled ? 1 : 0,
          note: input.note,
        });
      this.bumpVersion();
    });
    tx();
    return this.findById(ruleId)!;
  }

  patch(ruleId: string, patch: SelectionRulePatch): SelectionRule | null {
    const sets: string[] = [];
    const params: Record<string, unknown> = { rule_id: ruleId };
    if (patch.enabled !== undefined) {
      sets.push("enabled = @enabled");
      params.enabled = patch.enabled ? 1 : 0;
    }
    if (patch.note !== undefined) {
      sets.push("note = @note");
      params.note = patch.note;
    }
    if (sets.length === 0) return this.findById(ruleId);
    sets.push("updated_at = datetime('now')");
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(`UPDATE selection_rules SET ${sets.join(", ")} WHERE rule_id = @rule_id`)
        .run(params);
      if (info.changes > 0) this.bumpVersion();
    });
    tx();
    return this.findById(ruleId);
  }

  delete(ruleId: string): boolean {
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare("DELETE FROM selection_rules WHERE rule_id = @rule_id")
        .run({ rule_id: ruleId });
      if (info.changes > 0) this.bumpVersion();
      return info.changes > 0;
    });
    return tx();
  }

  list(profileId: string): SelectionRule[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM selection_rules WHERE profile_id = ? ORDER BY rule_type, pattern",
      )
      .all(profileId) as Row[];
    return rows.map((r) => this.toDomain(r));
  }

  findById(ruleId: string): SelectionRule | null {
    const row = this.db
      .prepare("SELECT * FROM selection_rules WHERE rule_id = ?")
      .get(ruleId) as Row | undefined;
    return row ? this.toDomain(row) : null;
  }

  getVersion(): number {
    const row = this.db
      .prepare(
        "SELECT selection_rules_version AS v FROM runtime_control_state WHERE id = 1",
      )
      .get() as { v: number } | undefined;
    return row?.v ?? 0;
  }

  private bumpVersion(): void {
    this.db
      .prepare(
        `UPDATE runtime_control_state
         SET selection_rules_version = selection_rules_version + 1
         WHERE id = 1`,
      )
      .run();
  }
}
