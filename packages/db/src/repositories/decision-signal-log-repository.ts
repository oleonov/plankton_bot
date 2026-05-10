import type Database from "better-sqlite3";
import type { DecisionSignalLogRepository, DecisionSignalLog } from "@krabs/domain";

export class SqliteDecisionSignalLogRepository implements DecisionSignalLogRepository {
  private readonly insertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO decision_signal_log
       (signal_id, token_id, condition_id, side, decision_rule_id, sizing_rule_id,
        notional_bucket, state, price, buy_count, time_since_last_seconds, signal_timestamp,
        is_add, add_age_ms, add_age_bucket, add_price_change_pct, add_price_change_bucket,
        nth_buy_at_emit,
        is_exit, is_first_sell, holding_time_ms, holding_time_bucket,
        exit_pnl_pct, exit_pnl_bucket, sold_bought_ratio, sold_bought_ratio_bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  insert(signal: DecisionSignalLog): void {
    this.insertStmt.run(
      signal.signalId,
      signal.tokenId,
      signal.conditionId,
      signal.side,
      signal.decisionRuleId,
      signal.sizingRuleId,
      signal.notionalBucket,
      signal.state,
      signal.price,
      signal.buyCount,
      signal.timeSinceLastSeconds,
      signal.signalTimestamp,
      signal.isAdd,
      signal.addAgeMs,
      signal.addAgeBucket,
      signal.addPriceChangePct,
      signal.addPriceChangeBucket,
      signal.nthBuyAtEmit,
      signal.isExit,
      signal.isFirstSell,
      signal.holdingTimeMs,
      signal.holdingTimeBucket,
      signal.exitPnlPct,
      signal.exitPnlBucket,
      signal.soldBoughtRatio,
      signal.soldBoughtRatioBucket,
    );
  }
}
