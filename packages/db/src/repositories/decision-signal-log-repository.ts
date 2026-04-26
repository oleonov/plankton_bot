import type Database from "better-sqlite3";
import type { DecisionSignalLogRepository, DecisionSignalLog } from "@plankton/domain";

export class SqliteDecisionSignalLogRepository implements DecisionSignalLogRepository {
  private readonly insertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO decision_signal_log
       (signal_id, token_id, condition_id, side, decision_rule_id, state, price, buy_count,
        time_since_last_seconds, signal_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  insert(signal: DecisionSignalLog): void {
    this.insertStmt.run(
      signal.signalId,
      signal.tokenId,
      signal.conditionId,
      signal.side,
      signal.decisionRuleId,
      signal.state,
      signal.price,
      signal.buyCount,
      signal.timeSinceLastSeconds,
      signal.signalTimestamp,
    );
  }
}
