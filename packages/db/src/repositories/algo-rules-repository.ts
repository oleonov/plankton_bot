import type Database from "better-sqlite3";
import type { AlgoRulesRepository } from "@plankton/domain";
import type { AlgoDecisionRule, AlgoSizeRule } from "@plankton/domain";

interface DecisionRow {
  id: number;
  priority: number;
  rule_id: string;
  state_condition: string;
  price_operator: string | null;
  price_value: number | null;
  time_since_last_operator: string | null;
  time_since_last_seconds: number | null;
  buy_count_min: number | null;
  buy_count_max: number | null;
  hold_duration_operator: string | null;
  hold_duration_seconds: number | null;
  action: string;
}

interface SizeRow {
  id: number;
  action_type: string;
  priority: number;
  rule_id: string;
  state_condition: string;
  price_operator: string | null;
  price_value: number | null;
  nth_buy: number | null;
  buy_count_min: number | null;
  buy_count_max: number | null;
  size_usdc: number;
}

function toDecisionRule(row: DecisionRow): AlgoDecisionRule {
  return {
    id: row.id,
    priority: row.priority,
    ruleId: row.rule_id,
    stateCondition: row.state_condition,
    priceOperator: row.price_operator,
    priceValue: row.price_value,
    timeSinceLastOperator: row.time_since_last_operator,
    timeSinceLastSeconds: row.time_since_last_seconds,
    buyCountMin: row.buy_count_min,
    buyCountMax: row.buy_count_max,
    holdDurationOperator: row.hold_duration_operator,
    holdDurationSeconds: row.hold_duration_seconds,
    action: row.action,
  };
}

function toSizeRule(row: SizeRow): AlgoSizeRule {
  return {
    id: row.id,
    actionType: row.action_type,
    priority: row.priority,
    ruleId: row.rule_id,
    stateCondition: row.state_condition,
    priceOperator: row.price_operator,
    priceValue: row.price_value,
    nthBuy: row.nth_buy,
    buyCountMin: row.buy_count_min,
    buyCountMax: row.buy_count_max,
    sizeUsdc: row.size_usdc,
  };
}

export class SqliteAlgoRulesRepository implements AlgoRulesRepository {
  constructor(private readonly db: Database.Database) {}

  getDecisionRules(): AlgoDecisionRule[] {
    const rows = this.db
      .prepare("SELECT * FROM algo_decision_rules ORDER BY priority ASC")
      .all() as DecisionRow[];
    return rows.map(toDecisionRule);
  }

  getSizeRules(actionType: "BUY" | "SELL"): AlgoSizeRule[] {
    const rows = this.db
      .prepare("SELECT * FROM algo_size_rules WHERE action_type = ? ORDER BY priority ASC")
      .all(actionType) as SizeRow[];
    return rows.map(toSizeRule);
  }
}
