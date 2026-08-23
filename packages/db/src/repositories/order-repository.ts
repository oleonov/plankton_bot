import type Database from "better-sqlite3";
import type {
  OrderRepository,
  Order,
  OrderCancelTelemetry,
  CancelAgeBucket,
  MakerCaptureRepriceIntent,
  MakerCaptureRepriceIntentStatus,
  MakerCaptureChainUsage,
  MakerCaptureLineageV1,
  MakerCaptureBookDecisionProofV1,
  MakerCaptureSubmitProofV1,
  BounceAskCaptureIntent,
  BounceAskCaptureIntentStatus,
  BounceAskCaptureBookDecisionProofV1,
  BounceAskCaptureSubmitProofV1,
} from "@krabs/domain";
import { nowIso } from "../db-timestamp.js";
import type {
  OrderId,
  TokenId,
  ClientOrderId,
  OrderStatus,
  OrderSide,
  OrderType,
} from "@krabs/domain";
import {
  createOrderId,
  createTokenId,
  createConditionId,
  createPositionId,
  createBotRunId,
  parseMakerCaptureRepriceProofV1,
  parseBounceAskCaptureProofV1,
} from "@krabs/domain";

export class SqliteOrderRepository implements OrderRepository {
  constructor(private readonly db: Database.Database) {}

  save(order: Order): void {
    this.db
      .prepare(
        `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type, post_only,
          price, size, size_usdc, status, exchange_order_id, signal_id,
          signal_reason, cancel_reason, cancel_age_ms, cancel_age_bucket,
          fill_progress_shares, market_horizon,
          decision_rule_id, signal_timestamp, exchange_error_code,
          exchange_error_message, exchange_error_payload, exchange_rejection_reason,
          metadata_json, entry_style, position_id, bot_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         -- NB: position_id is OMITTED from DO UPDATE — it is write-once on INSERT
         -- (an order belongs to exactly one position cycle for its whole life).
         ON CONFLICT(order_id) DO UPDATE SET
           status = excluded.status,
           exchange_order_id = excluded.exchange_order_id,
           post_only = excluded.post_only,
           size = excluded.size,
           size_usdc = excluded.size_usdc,
           signal_id = excluded.signal_id,
           signal_reason = excluded.signal_reason,
           cancel_reason = excluded.cancel_reason,
           cancel_age_ms = excluded.cancel_age_ms,
           cancel_age_bucket = excluded.cancel_age_bucket,
           fill_progress_shares = excluded.fill_progress_shares,
           market_horizon = excluded.market_horizon,
           decision_rule_id = excluded.decision_rule_id,
           signal_timestamp = excluded.signal_timestamp,
           exchange_error_code = excluded.exchange_error_code,
           exchange_error_message = excluded.exchange_error_message,
           exchange_error_payload = excluded.exchange_error_payload,
           exchange_rejection_reason = excluded.exchange_rejection_reason,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        order.orderId,
        order.clientOrderId,
        order.tokenId,
        order.conditionId,
        order.side,
        order.orderType,
        order.postOnly === true ? 1 : 0,
        order.price,
        order.size,
        order.sizeUsdc,
        order.status,
        order.exchangeOrderId,
        order.signalId,
        order.signalReason,
        order.cancelReason ?? null,
        order.cancelAgeMs ?? null,
        order.cancelAgeBucket ?? null,
        order.fillProgressShares ?? null,
        order.marketHorizon ?? null,
        order.decisionRuleId ?? null,
        order.signalTimestamp ?? null,
        order.exchangeErrorCode ?? null,
        order.exchangeErrorMessage ?? null,
        order.exchangeErrorPayload ?? null,
        order.exchangeRejectionReason ?? null,
        order.metadata ? JSON.stringify(order.metadata) : null,
        order.entryStyle ?? null,
        order.positionId ?? null,
        order.botRunId,
        order.createdAt,
        order.updatedAt,
      );
  }

  findById(id: OrderId): Order | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE order_id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToOrder(row) : null;
  }

  findByClientOrderId(clientOrderId: string): Order | null {
    const row = this.db
      .prepare("SELECT * FROM orders WHERE client_order_id = ?")
      .get(clientOrderId) as Record<string, unknown> | undefined;
    return row ? this.rowToOrder(row) : null;
  }

  findByExchangeOrderId(exchangeOrderId: string): Order | null {
    const row = this.db
      .prepare("SELECT * FROM orders WHERE exchange_order_id = ?")
      .get(exchangeOrderId) as Record<string, unknown> | undefined;
    return row ? this.rowToOrder(row) : null;
  }

  findOpen(): Order[] {
    const rows = this.db
      .prepare("SELECT * FROM orders WHERE status IN ('pending', 'open', 'partially-filled')")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToOrder(r));
  }

  findStartupExitRecoveryBlocked(): Order[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE metadata_json IS NOT NULL
           AND ((json_valid(metadata_json)
                 AND (json_type(metadata_json, '$.startupExitRecoveryBlockV1') IS NOT NULL
                   OR json_type(metadata_json, '$.exitRecoveryFenceV1') IS NOT NULL))
             OR (NOT json_valid(metadata_json)
                 AND (instr(metadata_json, '"startupExitRecoveryBlockV1"') > 0
                   OR instr(metadata_json, '"exitRecoveryFenceV1"') > 0)))
         ORDER BY created_at ASC, order_id ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToOrder(row));
  }

  findByTokenId(tokenId: TokenId): Order[] {
    const rows = this.db.prepare("SELECT * FROM orders WHERE token_id = ?").all(tokenId) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToOrder(r));
  }

  findRecentByTokenId(tokenId: TokenId, limit: number): Order[] {
    const rows = this.db
      .prepare("SELECT * FROM orders WHERE token_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(tokenId, Math.max(0, Math.trunc(limit))) as Record<string, unknown>[];
    return rows.map((r) => this.rowToOrder(r));
  }

  findFirstByTokenId(tokenId: TokenId): Order | null {
    const row = this.db
      .prepare("SELECT * FROM orders WHERE token_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(tokenId) as Record<string, unknown> | undefined;
    return row ? this.rowToOrder(row) : null;
  }

  findRecentBySignalReasons(
    signalReasons: readonly string[],
    sinceIso: string,
    limit: number,
  ): Order[] {
    if (signalReasons.length === 0 || limit <= 0) return [];
    const placeholders = signalReasons.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE signal_reason IN (${placeholders}) AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...signalReasons, sinceIso, Math.trunc(limit)) as Record<string, unknown>[];
    return rows.map((r) => this.rowToOrder(r));
  }

  updateStatus(
    id: OrderId,
    status: OrderStatus,
    exchangeOrderId?: string,
    cancelReason?: string,
    telemetry?: OrderCancelTelemetry,
  ): void {
    const assignments = ["status = ?", "updated_at = ?"];
    const params: unknown[] = [status, nowIso()];

    if (exchangeOrderId !== undefined) {
      assignments.push("exchange_order_id = ?");
      params.push(exchangeOrderId);
    }

    if (cancelReason !== undefined) {
      assignments.push("cancel_reason = ?");
      params.push(cancelReason);
    }

    if (telemetry !== undefined) {
      assignments.push("cancel_age_ms = ?");
      params.push(telemetry.cancelAgeMs);
      assignments.push("cancel_age_bucket = ?");
      params.push(telemetry.cancelAgeBucket);
      assignments.push("fill_progress_shares = ?");
      params.push(telemetry.fillProgressShares);
      assignments.push("market_horizon = ?");
      params.push(telemetry.marketHorizon);
    }

    params.push(id);
    this.db
      .prepare(
        `UPDATE orders
         SET ${assignments.join(", ")}
         WHERE order_id = ?`,
      )
      .run(...params);
  }

  replacePendingIdentity(currentOrderId: OrderId, replacement: Order): void {
    this.replacePreparedIdentity(currentOrderId, replacement, ["pending", "rejected"]);
  }

  replaceCancelledRecoveryIdentity(
    currentOrderId: OrderId,
    replacement: Order,
    expectedMetadata: Readonly<Record<string, unknown>>,
  ): void {
    this.replacePreparedIdentity(
      currentOrderId,
      replacement,
      ["cancelled"],
      expectedMetadata,
      true,
    );
  }

  private replacePreparedIdentity(
    currentOrderId: OrderId,
    replacement: Order,
    allowedStatuses: readonly OrderStatus[],
    expectedMetadata?: Readonly<Record<string, unknown>>,
    restartLifetime = false,
  ): void {
    const replace = this.db.transaction(() => {
      const current = this.findById(currentOrderId);
      if (!current || !allowedStatuses.includes(current.status)) {
        throw new Error(
          `Prepared identity replacement requires ${allowedStatuses.join("/")} order: ${String(currentOrderId)}`,
        );
      }
      if (
        expectedMetadata &&
        JSON.stringify(current.metadata) !== JSON.stringify(expectedMetadata)
      ) {
        throw new Error("Prepared identity replacement metadata CAS failed");
      }
      if (current.clientOrderId !== replacement.clientOrderId) {
        throw new Error("Prepared identity replacement cannot change client order identity");
      }
      const hasFill = this.db
        .prepare("SELECT 1 FROM fills WHERE order_id = ? LIMIT 1")
        .get(currentOrderId);
      if (hasFill) {
        throw new Error(
          `Pending identity replacement refused for filled order: ${String(currentOrderId)}`,
        );
      }

      const statusPlaceholders = allowedStatuses.map(() => "?").join(", ");
      const metadataPredicate = expectedMetadata ? " AND metadata_json IS ?" : "";
      const result = this.db
        .prepare(
          `UPDATE orders
           SET order_id = ?, exchange_order_id = ?, post_only = ?, price = ?, size = ?, size_usdc = ?,
               status = 'pending', cancel_reason = NULL, cancel_age_ms = NULL, cancel_age_bucket = NULL,
               fill_progress_shares = NULL, market_horizon = NULL, exchange_error_code = NULL,
               exchange_error_message = NULL, exchange_error_payload = NULL,
               exchange_rejection_reason = NULL,
               created_at = CASE WHEN ? THEN ? ELSE created_at END, updated_at = ?
           WHERE order_id = ? AND status IN (${statusPlaceholders}) AND client_order_id = ?
             ${metadataPredicate}
             AND NOT EXISTS (SELECT 1 FROM fills WHERE order_id = orders.order_id)`,
        )
        .run(
          replacement.orderId,
          replacement.exchangeOrderId,
          replacement.postOnly === true ? 1 : 0,
          replacement.price,
          replacement.size,
          replacement.sizeUsdc,
          restartLifetime ? 1 : 0,
          replacement.createdAt,
          replacement.updatedAt,
          currentOrderId,
          ...allowedStatuses,
          replacement.clientOrderId,
          ...(expectedMetadata ? [JSON.stringify(expectedMetadata)] : []),
        );
      if (result.changes !== 1) {
        throw new Error(
          `Prepared identity replacement failed for order: ${String(currentOrderId)}`,
        );
      }
    });
    replace();
  }

  updateMetadata(id: OrderId, metadata: Readonly<Record<string, unknown>>): Order {
    this.runMetadataUpdate(id, metadata);
    const updated = this.findById(id);
    if (!updated) {
      throw new Error(`Order not found after metadata update: ${String(id)}`);
    }
    return updated;
  }

  updateMetadataIfUnchanged(
    id: OrderId,
    expectedMetadata: Readonly<Record<string, unknown>> | null,
    metadata: Readonly<Record<string, unknown>>,
  ): Order | null {
    const result = this.db
      .prepare(
        `UPDATE orders
         SET metadata_json = ?, updated_at = ?
         WHERE order_id = ? AND metadata_json IS ?`,
      )
      .run(
        JSON.stringify(metadata),
        nowIso(),
        id,
        expectedMetadata === null ? null : JSON.stringify(expectedMetadata),
      );
    return result.changes === 1 ? this.findById(id) : null;
  }

  updateMetadataBulk(
    updates: readonly { orderId: OrderId; metadata: Readonly<Record<string, unknown>> }[],
  ): Order[] {
    if (updates.length === 0) return [];
    const apply = this.db.transaction(() => {
      for (const update of updates) {
        this.runMetadataUpdate(update.orderId, update.metadata);
      }
      return updates.map((update) => {
        const updated = this.findById(update.orderId);
        if (!updated) {
          throw new Error(`Order not found after metadata update: ${String(update.orderId)}`);
        }
        return updated;
      });
    });
    return apply();
  }

  sumOpenBuyNotional(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(size_usdc), 0) as total FROM orders WHERE status IN ('pending', 'open', 'partially-filled') AND side = 'buy'",
      )
      .get() as { total: number };
    return row.total;
  }

  claimMakerCaptureRepriceIntent(intent: MakerCaptureRepriceIntent): boolean {
    const proof = parseMakerCaptureRepriceProofV1(intent.proof);
    if (!proof || proof.prepared !== null || proof.submit !== null) return false;
    const proofJson = JSON.stringify(proof);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO maker_capture_reprice_intents
         (intent_id, predecessor_order_id, lifecycle_signal_id, root_order_id, token_id,
          condition_id, replacement_index, status, candidate_price, replacement_size,
          child_order_id, failure, proof_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'cancel_pending', NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        intent.intentId,
        intent.predecessorOrderId,
        intent.lifecycleSignalId,
        intent.rootOrderId,
        intent.tokenId,
        intent.conditionId,
        intent.replacementIndex,
        proofJson,
        intent.createdAt,
        intent.updatedAt,
      );
    return result.changes === 1;
  }

  findRecoverableMakerCaptureRepriceIntents(): MakerCaptureRepriceIntent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM maker_capture_reprice_intents
           WHERE status IN ('cancel_pending', 'ready', 'submitted')
           ORDER BY created_at, intent_id`,
        )
        .all() as Record<string, unknown>[]
    ).map(rowToMakerCaptureIntent);
  }

  findMakerCaptureRepriceIntentBySignal(signalId: string): MakerCaptureRepriceIntent | null {
    return this.findMakerCaptureIntent("lifecycle_signal_id", signalId);
  }

  findMakerCaptureRepriceIntentByChild(childOrderId: OrderId): MakerCaptureRepriceIntent | null {
    return this.findMakerCaptureIntent("child_order_id", childOrderId);
  }

  findMakerCaptureRepriceIntentByPredecessor(
    predecessorOrderId: OrderId,
  ): MakerCaptureRepriceIntent | null {
    return this.findMakerCaptureIntent("predecessor_order_id", predecessorOrderId);
  }

  markMakerCaptureRepriceReady(
    intentId: string,
    candidatePrice: number,
    replacementSize: number,
    preparedProof: MakerCaptureBookDecisionProofV1,
  ): boolean {
    const current = this.readMakerCaptureProofRow(intentId);
    const proof = parseMakerCaptureRepriceProofJson(current?.proof_json);
    const nextProof = parseMakerCaptureRepriceProofV1({
      ...proof,
      prepared: preparedProof,
    });
    if (
      !current ||
      current.status !== "cancel_pending" ||
      !proof ||
      proof.prepared !== null ||
      proof.submit !== null ||
      !nextProof?.prepared ||
      nextProof.prepared.candidatePrice !== candidatePrice ||
      nextProof.prepared.replacementSize !== replacementSize
    )
      return false;
    const nextProofJson = JSON.stringify(nextProof);
    return (
      this.db
        .prepare(
          `UPDATE maker_capture_reprice_intents
           SET status = 'ready', candidate_price = ?, replacement_size = ?, proof_json = ?,
               updated_at = ?
           WHERE intent_id = ? AND status = 'cancel_pending' AND candidate_price IS NULL
             AND replacement_size IS NULL AND child_order_id IS NULL AND proof_json = ?`,
        )
        .run(candidatePrice, replacementSize, nextProofJson, nowIso(), intentId, current.proof_json)
        .changes === 1
    );
  }

  markMakerCaptureRepriceSubmitted(intentId: string, childOrderId: OrderId): boolean {
    const current = this.readMakerCaptureProofRow(intentId);
    const proof = parseMakerCaptureRepriceProofJson(current?.proof_json);
    if (!current || current.status !== "ready" || !proof?.prepared || proof.submit !== null)
      return false;
    return (
      this.db
        .prepare(
          `UPDATE maker_capture_reprice_intents
           SET status = 'submitted', child_order_id = ?, updated_at = ?
           WHERE intent_id = ? AND status = 'ready' AND child_order_id IS NULL AND proof_json = ?`,
        )
        .run(childOrderId, nowIso(), intentId, current.proof_json).changes === 1
    );
  }

  markMakerCaptureRepriceSubmitProof(
    intentId: string,
    childOrderId: OrderId,
    clientOrderId: string,
    submitProof: MakerCaptureSubmitProofV1,
  ): boolean {
    const current = this.readMakerCaptureProofRow(intentId);
    const proof = parseMakerCaptureRepriceProofJson(current?.proof_json);
    const nextProof = parseMakerCaptureRepriceProofV1({ ...proof, submit: submitProof });
    const submit = nextProof?.submit;
    if (
      !current ||
      current.status !== "submitted" ||
      current.child_order_id !== String(childOrderId) ||
      current.child_client_order_id !== clientOrderId ||
      !proof?.prepared ||
      proof.submit !== null ||
      !submit ||
      submit.childOrderId !== String(childOrderId) ||
      submit.clientOrderId !== clientOrderId ||
      submit.candidatePrice !== current.candidate_price ||
      submit.replacementSize !== current.replacement_size
    )
      return false;
    const nextProofJson = JSON.stringify(nextProof);
    return (
      this.db
        .prepare(
          `UPDATE maker_capture_reprice_intents
           SET proof_json = ?, updated_at = ?
           WHERE intent_id = ? AND status = 'submitted' AND child_order_id = ?
             AND proof_json = ?`,
        )
        .run(nextProofJson, nowIso(), intentId, childOrderId, current.proof_json).changes === 1
    );
  }

  markMakerCaptureRepriceTerminal(
    intentId: string,
    status: "completed" | "failed",
    failure: string | null = null,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE maker_capture_reprice_intents
           SET status = ?, failure = ?, updated_at = ?
           WHERE intent_id = ? AND status IN ('cancel_pending', 'ready', 'submitted')`,
        )
        .run(status, status === "failed" ? failure : null, nowIso(), intentId).changes === 1
    );
  }

  claimBounceAskCaptureIntent(intent: BounceAskCaptureIntent): boolean {
    const proof = parseBounceAskCaptureProofV1(intent.proof);
    if (!proof || proof.prepared !== null || proof.submit !== null) return false;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO bounce_ask_capture_reprice_intents
         (intent_id, predecessor_order_id, lifecycle_signal_id, root_order_id, position_id,
          token_id, condition_id, replacement_index, status, candidate_price, replacement_size,
          child_order_id, failure, proof_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cancel_pending', NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        intent.intentId,
        intent.predecessorOrderId,
        intent.lifecycleSignalId,
        intent.rootOrderId,
        intent.positionId,
        intent.tokenId,
        intent.conditionId,
        intent.replacementIndex,
        JSON.stringify(proof),
        intent.createdAt,
        intent.updatedAt,
      );
    return result.changes === 1;
  }

  findRecoverableBounceAskCaptureIntents(): BounceAskCaptureIntent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM bounce_ask_capture_reprice_intents
           WHERE status IN ('cancel_pending', 'ready', 'submitted')
           ORDER BY created_at, intent_id`,
        )
        .all() as Record<string, unknown>[]
    ).map(rowToBounceAskCaptureIntent);
  }

  findBounceAskCaptureIntentBySignal(signalId: string): BounceAskCaptureIntent | null {
    return this.findBounceAskCaptureIntent("lifecycle_signal_id", signalId);
  }

  findBounceAskCaptureIntentByChild(childOrderId: OrderId): BounceAskCaptureIntent | null {
    return this.findBounceAskCaptureIntent("child_order_id", childOrderId);
  }

  findBounceAskCaptureIntentByPredecessor(
    predecessorOrderId: OrderId,
  ): BounceAskCaptureIntent | null {
    return this.findBounceAskCaptureIntent("predecessor_order_id", predecessorOrderId);
  }

  hasNonterminalBounceAskCaptureIntentForPosition(
    positionId: import("@krabs/domain").PositionId,
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM bounce_ask_capture_reprice_intents
           WHERE position_id = ? AND status IN ('cancel_pending', 'ready', 'submitted') LIMIT 1`,
        )
        .get(positionId),
    );
  }

  isOrderManagedByNonterminalBounceAskCaptureIntent(orderId: OrderId): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM bounce_ask_capture_reprice_intents
           WHERE (predecessor_order_id = ? OR child_order_id = ?)
             AND status IN ('cancel_pending', 'ready', 'submitted') LIMIT 1`,
        )
        .get(orderId, orderId),
    );
  }

  markBounceAskCaptureReady(
    intentId: string,
    candidatePrice: number,
    replacementSize: number,
    preparedProof: BounceAskCaptureBookDecisionProofV1,
  ): boolean {
    const current = this.readBounceAskCaptureProofRow(intentId);
    const proof = parseBounceAskCaptureProofJson(current?.proof_json);
    const nextProof = parseBounceAskCaptureProofV1({ ...proof, prepared: preparedProof });
    if (
      !current ||
      current.status !== "cancel_pending" ||
      !proof ||
      proof.prepared !== null ||
      proof.submit !== null ||
      !nextProof?.prepared ||
      nextProof.prepared.candidatePrice !== candidatePrice ||
      nextProof.prepared.replacementSize !== replacementSize
    )
      return false;
    return (
      this.db
        .prepare(
          `UPDATE bounce_ask_capture_reprice_intents
           SET status = 'ready', candidate_price = ?, replacement_size = ?, proof_json = ?,
               updated_at = ?
           WHERE intent_id = ? AND status = 'cancel_pending' AND candidate_price IS NULL
             AND replacement_size IS NULL AND child_order_id IS NULL AND proof_json = ?`,
        )
        .run(
          candidatePrice,
          replacementSize,
          JSON.stringify(nextProof),
          nowIso(),
          intentId,
          current.proof_json,
        ).changes === 1
    );
  }

  markBounceAskCaptureSubmitted(intentId: string, childOrderId: OrderId): boolean {
    const current = this.readBounceAskCaptureProofRow(intentId);
    const proof = parseBounceAskCaptureProofJson(current?.proof_json);
    if (!current || current.status !== "ready" || !proof?.prepared || proof.submit !== null)
      return false;
    return (
      this.db
        .prepare(
          `UPDATE bounce_ask_capture_reprice_intents
           SET status = 'submitted', child_order_id = ?, updated_at = ?
           WHERE intent_id = ? AND status = 'ready' AND child_order_id IS NULL AND proof_json = ?`,
        )
        .run(childOrderId, nowIso(), intentId, current.proof_json).changes === 1
    );
  }

  resetBounceAskCaptureSubmitted(intentId: string, childOrderId: OrderId): boolean {
    const current = this.readBounceAskCaptureProofRow(intentId);
    const proof = parseBounceAskCaptureProofJson(current?.proof_json);
    const resetProof = parseBounceAskCaptureProofV1({ ...proof, submit: null });
    if (
      !current ||
      current.status !== "submitted" ||
      current.child_order_id !== String(childOrderId) ||
      !proof?.prepared ||
      !resetProof?.prepared
    )
      return false;
    const resetProofJson = JSON.stringify(resetProof);
    return (
      this.db
        .prepare(
          `UPDATE bounce_ask_capture_reprice_intents
           SET status = 'ready', child_order_id = NULL, proof_json = ?, updated_at = ?
           WHERE intent_id = ? AND status = 'submitted' AND child_order_id = ?
             AND proof_json = ?`,
        )
        .run(resetProofJson, nowIso(), intentId, childOrderId, current.proof_json).changes === 1
    );
  }

  markBounceAskCaptureSubmitProof(
    intentId: string,
    childOrderId: OrderId,
    clientOrderId: string,
    submitProof: BounceAskCaptureSubmitProofV1,
  ): boolean {
    const current = this.readBounceAskCaptureProofRow(intentId);
    const proof = parseBounceAskCaptureProofJson(current?.proof_json);
    const nextProof = parseBounceAskCaptureProofV1({ ...proof, submit: submitProof });
    const submit = nextProof?.submit;
    if (
      !current ||
      current.status !== "submitted" ||
      current.child_order_id !== String(childOrderId) ||
      current.child_client_order_id !== clientOrderId ||
      !proof?.prepared ||
      proof.submit !== null ||
      !submit ||
      submit.childOrderId !== String(childOrderId) ||
      submit.clientOrderId !== clientOrderId ||
      submit.candidatePrice !== current.candidate_price ||
      submit.replacementSize !== current.replacement_size
    )
      return false;
    return (
      this.db
        .prepare(
          `UPDATE bounce_ask_capture_reprice_intents
           SET proof_json = ?, updated_at = ?
           WHERE intent_id = ? AND status = 'submitted' AND child_order_id = ?
             AND proof_json = ?`,
        )
        .run(JSON.stringify(nextProof), nowIso(), intentId, childOrderId, current.proof_json)
        .changes === 1
    );
  }

  markBounceAskCaptureTerminal(
    intentId: string,
    status: "completed" | "failed" | "dust",
    failure: string | null = null,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE bounce_ask_capture_reprice_intents
           SET status = ?, failure = ?, updated_at = ?
           WHERE intent_id = ? AND status IN ('cancel_pending', 'ready', 'submitted')`,
        )
        .run(status, status === "failed" ? failure : null, nowIso(), intentId).changes === 1
    );
  }

  getMakerBuyWindowUsage(
    activatedAtUtc: string,
    expiresAtUtc: string,
    conditionId: string,
    excludeClientOrderId: string,
  ): import("@krabs/domain").MakerBuyWindowUsage {
    const windowOrders = (
      this.db
        .prepare(
          `SELECT * FROM orders
           WHERE side = 'buy' AND entry_style = 'maker'
             AND created_at >= ? AND created_at < ?`,
        )
        .all(activatedAtUtc, expiresAtUtc) as Record<string, unknown>[]
    ).map((row) => this.rowToOrder(row));
    const accepted = windowOrders.filter((order) => order.status !== "rejected");
    const allByToken = new Map<string, Order[]>();
    const intentsByToken = new Map<string, MakerCaptureRepriceIntent[]>();
    const commitments = new Map<string, { notional: number; conditionId: string }>();
    const fillOrderIds = new Set<string>();
    for (const order of accepted) {
      const tokenKey = String(order.tokenId);
      const allOrders = allByToken.get(tokenKey) ?? this.findByTokenId(order.tokenId);
      const intents =
        intentsByToken.get(tokenKey) ?? this.findMakerCaptureIntentsForToken(order.tokenId);
      allByToken.set(tokenKey, allOrders);
      intentsByToken.set(tokenKey, intents);
      const chain = resolveMakerCaptureChainUsage(this.db, order, allOrders, intents);
      const lineage = parseMakerCaptureLineage(order);
      const isExcluded = String(order.clientOrderId) === excludeClientOrderId;
      const root = chain.rootOrderId
        ? allOrders.find((candidate) => String(candidate.orderId) === String(chain.rootOrderId))
        : null;
      const trustedWindowRoot =
        chain.trusted &&
        root != null &&
        root.createdAt >= activatedAtUtc &&
        root.createdAt < expiresAtUtc;
      if (!isExcluded || (lineage?.replacementIndex ?? 0) > 0) {
        const ids = trustedWindowRoot ? chain.orderIds : [order.orderId];
        for (const id of ids) fillOrderIds.add(String(id));
      }
      if (isExcluded) {
        if (lineage != null && lineage.replacementIndex > 0 && !chain.trusted) {
          commitments.set(`order:${order.orderId}`, {
            notional: order.sizeUsdc,
            conditionId: String(order.conditionId),
          });
        }
        continue;
      }
      if (chain.trusted && chain.rootOrderId) {
        commitments.set(`root:${chain.rootOrderId}`, {
          notional: chain.rootNotionalUsdc,
          conditionId: String(order.conditionId),
        });
      } else {
        commitments.set(`order:${order.orderId}`, {
          notional: order.sizeUsdc,
          conditionId: String(order.conditionId),
        });
      }
    }
    const values = [...commitments.values()];
    const conditionIds = [...new Set(values.map((value) => value.conditionId))];
    const filledUsdc = [...fillOrderIds].reduce(
      (sum, orderId) => sum + sumOrderFillField(this.db, createOrderId(orderId), "size_usdc"),
      0,
    );
    return {
      committedUsdc: values.reduce((sum, value) => sum + value.notional, 0),
      conditionCommittedUsdc: values
        .filter((value) => value.conditionId === conditionId)
        .reduce((sum, value) => sum + value.notional, 0),
      distinctAcceptedConditions: conditionIds.length,
      committedConditionIds: conditionIds,
      filledUsdc,
    };
  }

  getMakerCaptureChainUsage(orderId: OrderId): MakerCaptureChainUsage {
    const target = this.findById(orderId);
    if (!target) return untrustedMakerCaptureChain();
    const orders = this.findByTokenId(target.tokenId);
    const intents = this.findMakerCaptureIntentsForToken(target.tokenId);
    return resolveMakerCaptureChainUsage(this.db, target, orders, intents);
  }

  private runMetadataUpdate(id: OrderId, metadata: Readonly<Record<string, unknown>>): void {
    const result = this.db
      .prepare(
        `UPDATE orders
         SET metadata_json = ?, updated_at = ?
         WHERE order_id = ?`,
      )
      .run(JSON.stringify(metadata), nowIso(), id);
    if (result.changes !== 1) {
      throw new Error(`Order metadata update expected one row for order_id=${String(id)}`);
    }
  }

  private findMakerCaptureIntent(column: string, value: unknown): MakerCaptureRepriceIntent | null {
    const row = this.db
      .prepare(`SELECT * FROM maker_capture_reprice_intents WHERE ${column} = ?`)
      .get(value) as Record<string, unknown> | undefined;
    return row ? rowToMakerCaptureIntent(row) : null;
  }

  private findBounceAskCaptureIntent(
    column: string,
    value: unknown,
  ): BounceAskCaptureIntent | null {
    const row = this.db
      .prepare(`SELECT * FROM bounce_ask_capture_reprice_intents WHERE ${column} = ?`)
      .get(value) as Record<string, unknown> | undefined;
    return row ? rowToBounceAskCaptureIntent(row) : null;
  }

  private readMakerCaptureProofRow(intentId: string):
    | {
        status: string;
        candidate_price: number | null;
        replacement_size: number | null;
        child_order_id: string | null;
        child_client_order_id: string | null;
        proof_json: string;
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT i.status, i.candidate_price, i.replacement_size, i.child_order_id, i.proof_json,
                o.client_order_id AS child_client_order_id
         FROM maker_capture_reprice_intents AS i
         LEFT JOIN orders AS o ON o.order_id = i.child_order_id WHERE i.intent_id = ?`,
      )
      .get(intentId) as ReturnType<SqliteOrderRepository["readMakerCaptureProofRow"]>;
  }

  private readBounceAskCaptureProofRow(intentId: string):
    | {
        status: string;
        candidate_price: number | null;
        replacement_size: number | null;
        child_order_id: string | null;
        child_client_order_id: string | null;
        proof_json: string;
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT i.status, i.candidate_price, i.replacement_size, i.child_order_id, i.proof_json,
                o.client_order_id AS child_client_order_id
         FROM bounce_ask_capture_reprice_intents AS i
         LEFT JOIN orders AS o ON o.order_id = i.child_order_id WHERE i.intent_id = ?`,
      )
      .get(intentId) as ReturnType<SqliteOrderRepository["readBounceAskCaptureProofRow"]>;
  }

  private findMakerCaptureIntentsForToken(tokenId: TokenId): MakerCaptureRepriceIntent[] {
    return (
      this.db
        .prepare("SELECT * FROM maker_capture_reprice_intents WHERE token_id = ?")
        .all(tokenId) as Record<string, unknown>[]
    ).map(rowToMakerCaptureIntent);
  }

  private rowToOrder(row: Record<string, unknown>): Order {
    return {
      orderId: createOrderId(row.order_id as string),
      clientOrderId: row.client_order_id as string as ClientOrderId,
      tokenId: createTokenId(row.token_id as string),
      conditionId: createConditionId(row.condition_id as string),
      positionId: row.position_id ? createPositionId(row.position_id as string) : null,
      side: row.side as OrderSide,
      orderType: row.order_type as OrderType,
      postOnly: row.post_only === 1,
      price: row.price as number,
      size: row.size as number,
      sizeUsdc: row.size_usdc as number,
      status: row.status as OrderStatus,
      cancelReason: (row.cancel_reason as string) ?? null,
      cancelAgeMs: (row.cancel_age_ms as number | null) ?? null,
      cancelAgeBucket: (row.cancel_age_bucket as CancelAgeBucket | null) ?? null,
      fillProgressShares: (row.fill_progress_shares as number | null) ?? null,
      marketHorizon: (row.market_horizon as string | null) ?? null,
      exchangeOrderId: (row.exchange_order_id as string) ?? null,
      signalId: (row.signal_id as string) ?? null,
      signalReason: (row.signal_reason as string) ?? null,
      decisionRuleId: (row.decision_rule_id as string) ?? null,
      signalTimestamp: (row.signal_timestamp as string) ?? null,
      entryStyle: (row.entry_style as "probe" | "maker") ?? null,
      exchangeErrorCode: (row.exchange_error_code as string) ?? null,
      exchangeErrorMessage: (row.exchange_error_message as string) ?? null,
      exchangeErrorPayload: (row.exchange_error_payload as string) ?? null,
      exchangeRejectionReason: (row.exchange_rejection_reason as string) ?? null,
      metadata: parseMetadata(row.metadata_json),
      botRunId: createBotRunId(row.bot_run_id as string),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

function parseMetadata(raw: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function rowToMakerCaptureIntent(row: Record<string, unknown>): MakerCaptureRepriceIntent {
  return {
    intentId: row.intent_id as string,
    predecessorOrderId: createOrderId(row.predecessor_order_id as string),
    lifecycleSignalId: row.lifecycle_signal_id as string,
    rootOrderId: createOrderId(row.root_order_id as string),
    tokenId: createTokenId(row.token_id as string),
    conditionId: createConditionId(row.condition_id as string),
    replacementIndex: row.replacement_index as number,
    status: row.status as MakerCaptureRepriceIntentStatus,
    candidatePrice: (row.candidate_price as number | null) ?? null,
    replacementSize: (row.replacement_size as number | null) ?? null,
    childOrderId: row.child_order_id ? createOrderId(row.child_order_id as string) : null,
    failure: (row.failure as string | null) ?? null,
    proof: parseMakerCaptureRepriceProofJson(row.proof_json),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function parseMakerCaptureRepriceProofJson(raw: unknown) {
  if (typeof raw !== "string") return null;
  try {
    return parseMakerCaptureRepriceProofV1(JSON.parse(raw));
  } catch {
    return null;
  }
}

function rowToBounceAskCaptureIntent(row: Record<string, unknown>): BounceAskCaptureIntent {
  return {
    intentId: row.intent_id as string,
    predecessorOrderId: createOrderId(row.predecessor_order_id as string),
    lifecycleSignalId: row.lifecycle_signal_id as string,
    rootOrderId: createOrderId(row.root_order_id as string),
    positionId: createPositionId(row.position_id as string),
    tokenId: createTokenId(row.token_id as string),
    conditionId: createConditionId(row.condition_id as string),
    replacementIndex: row.replacement_index as number,
    status: row.status as BounceAskCaptureIntentStatus,
    candidatePrice: (row.candidate_price as number | null) ?? null,
    replacementSize: (row.replacement_size as number | null) ?? null,
    childOrderId: row.child_order_id ? createOrderId(row.child_order_id as string) : null,
    failure: (row.failure as string | null) ?? null,
    proof: parseBounceAskCaptureProofJson(row.proof_json),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function parseBounceAskCaptureProofJson(raw: unknown) {
  if (typeof raw !== "string") return null;
  try {
    return parseBounceAskCaptureProofV1(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseMakerCaptureLineage(order: Order): MakerCaptureLineageV1 | null {
  const raw = order.metadata?.makerCaptureLineageV1;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.join("|") !== "predecessorOrderId|replacementIndex|rootNotionalUsdc|rootOrderId|version" ||
    value.version !== 1 ||
    typeof value.rootOrderId !== "string" ||
    (value.predecessorOrderId !== null && typeof value.predecessorOrderId !== "string") ||
    !Number.isSafeInteger(value.replacementIndex) ||
    Number(value.replacementIndex) < 0 ||
    Number(value.replacementIndex) > 5 ||
    typeof value.rootNotionalUsdc !== "number" ||
    !Number.isFinite(value.rootNotionalUsdc) ||
    value.rootNotionalUsdc <= 0
  ) {
    return null;
  }
  return value as unknown as MakerCaptureLineageV1;
}

function resolveMakerCaptureChainUsage(
  db: Database.Database,
  target: Order,
  orders: readonly Order[],
  intents: readonly MakerCaptureRepriceIntent[],
): MakerCaptureChainUsage {
  const targetLineage = parseMakerCaptureLineage(target);
  if (!targetLineage) return untrustedMakerCaptureChain(target);
  const rootId = String(targetLineage.rootOrderId);
  const chain = orders
    .map((order) => ({ order, lineage: parseMakerCaptureLineage(order) }))
    .filter(
      (item): item is { order: Order; lineage: MakerCaptureLineageV1 } =>
        item.lineage != null && String(item.lineage.rootOrderId) === rootId,
    )
    .sort((a, b) => a.lineage.replacementIndex - b.lineage.replacementIndex);
  if (!validMakerCaptureChain(chain, intents, target)) return untrustedMakerCaptureChain(target);
  const root = chain[0]!.order;
  const targetFilledShares = sumOrderFillField(db, target.orderId, "size");
  return {
    trusted: true,
    rootOrderId: root.orderId,
    rootNotionalUsdc: chain[0]!.lineage.rootNotionalUsdc,
    chainFilledUsdc: chain.reduce(
      (sum, item) => sum + sumOrderFillField(db, item.order.orderId, "size_usdc"),
      0,
    ),
    predecessorRemainingShares: Math.max(0, target.size - targetFilledShares),
    replacementIndex: targetLineage.replacementIndex,
    orderIds: chain.map((item) => item.order.orderId),
  };
}

function validMakerCaptureChain(
  chain: readonly { order: Order; lineage: MakerCaptureLineageV1 }[],
  intents: readonly MakerCaptureRepriceIntent[],
  target: Order,
): boolean {
  if (
    chain.length === 0 ||
    !chain.some((item) => String(item.order.orderId) === String(target.orderId))
  ) {
    return false;
  }
  const root = chain[0]!;
  if (
    root.lineage.replacementIndex !== 0 ||
    root.lineage.predecessorOrderId !== null ||
    String(root.lineage.rootOrderId) !== String(root.order.orderId) ||
    Math.abs(root.lineage.rootNotionalUsdc - root.order.sizeUsdc) > 1e-9
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (let index = 0; index < chain.length; index++) {
    const item = chain[index]!;
    const orderId = String(item.order.orderId);
    if (seen.has(orderId) || item.lineage.replacementIndex !== index) return false;
    seen.add(orderId);
    if (
      !isCaptureOrderForRoot(item.order, root.order) ||
      Math.abs(item.lineage.rootNotionalUsdc - root.lineage.rootNotionalUsdc) > 1e-9
    ) {
      return false;
    }
    if (index === 0) continue;
    const predecessor = chain[index - 1]!.order;
    const intent = intents.find(
      (candidate) => String(candidate.childOrderId) === String(item.order.orderId),
    );
    if (
      !intent ||
      (intent.status !== "submitted" && intent.status !== "completed") ||
      predecessor.status !== "cancelled" ||
      String(intent.predecessorOrderId) !== String(predecessor.orderId) ||
      String(intent.rootOrderId) !== String(root.order.orderId) ||
      intent.lifecycleSignalId !== item.order.signalId ||
      String(intent.tokenId) !== String(item.order.tokenId) ||
      String(intent.conditionId) !== String(item.order.conditionId) ||
      intent.replacementIndex !== index ||
      String(item.lineage.predecessorOrderId) !== String(predecessor.orderId) ||
      intent.candidatePrice == null ||
      Math.abs(intent.candidatePrice - item.order.price) > 1e-9 ||
      intent.replacementSize == null ||
      Math.abs(intent.replacementSize - item.order.size) > 1e-9
    ) {
      return false;
    }
  }
  return true;
}

function isCaptureOrderForRoot(order: Order, root: Order): boolean {
  return (
    order.side === "buy" &&
    order.entryStyle === "maker" &&
    order.postOnly === true &&
    order.decisionRuleId === "R23_DIP_TRIGGER" &&
    order.signalReason === "probe-entry" &&
    String(order.tokenId) === String(root.tokenId) &&
    String(order.conditionId) === String(root.conditionId) &&
    order.status !== "rejected"
  );
}

function sumOrderFillField(
  db: Database.Database,
  orderId: OrderId,
  field: "size" | "size_usdc",
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(${field}), 0) AS total FROM fills WHERE order_id = ? AND side = 'buy'`,
    )
    .get(orderId) as { total: number };
  return row.total;
}

function untrustedMakerCaptureChain(target?: Order): MakerCaptureChainUsage {
  return {
    trusted: false,
    rootOrderId: null,
    rootNotionalUsdc: 0,
    chainFilledUsdc: 0,
    predecessorRemainingShares: target?.size ?? 0,
    replacementIndex: -1,
    orderIds: target ? [target.orderId] : [],
  };
}
