import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { SelectionRuleEngine, evaluatePreEntry, normalizeSelectionPattern } from "@plankton/domain";
import type { ProfileId, SelectionRuleType } from "@plankton/domain";
import {
  SelectionRuleRepository,
  SqliteMarketRepository,
  SqliteStateTransitionRepository,
} from "@plankton/db";
import { ok, fail } from "../errors.js";
import type { LedgerPool } from "../ledger-pool.js";

interface SelectionRulesOpts {
  controlDb: Database.Database;
  ledgerPool: LedgerPool;
}

const RULE_TYPES: readonly SelectionRuleType[] = [
  "include_prefix",
  "exclude_prefix",
  "include_slug",
  "exclude_slug",
];
const CREATE_RULE_TYPES: readonly SelectionRuleType[] = ["include_slug", "exclude_slug"];
const PREFIX_RULE_TYPES: readonly SelectionRuleType[] = ["include_prefix", "exclude_prefix"];
const DEPRECATED_PREFIX_MESSAGE = "prefix rule types are deprecated since v5.11";

function isPrefixRuleType(ruleType: SelectionRuleType): boolean {
  return PREFIX_RULE_TYPES.includes(ruleType);
}

export const selectionRulesRoutes: FastifyPluginAsync<SelectionRulesOpts> = async (app, opts) => {
  const { controlDb, ledgerPool } = opts;
  const selectionRuleRepo = new SelectionRuleRepository(controlDb);
  const stateTransitionRepo = new SqliteStateTransitionRepository(controlDb);

  // ── GET /selection-rules ──────────────────────────────────────────────
  app.get("/selection-rules", async (req, reply) => {
    const { profileId } = req.query as { profileId?: string };
    if (!profileId) return reply.code(400).send(fail("BAD_REQUEST", "profileId required"));
    return reply.send(ok({ rules: selectionRuleRepo.list(profileId) }));
  });

  // ── POST /selection-rules ─────────────────────────────────────────────
  app.post("/selection-rules", async (req, reply) => {
    const body = req.body as {
      profileId?: string;
      ruleType?: SelectionRuleType;
      pattern?: string;
      note?: string | null;
      enabled?: boolean;
    };
    if (
      !body?.profileId ||
      !body.ruleType ||
      !RULE_TYPES.includes(body.ruleType) ||
      !body.pattern
    ) {
      return reply.code(400).send(fail("BAD_REQUEST", "missing/invalid fields"));
    }
    if (!CREATE_RULE_TYPES.includes(body.ruleType)) {
      return reply.code(400).send(fail("DEPRECATED_RULE_TYPE", DEPRECATED_PREFIX_MESSAGE));
    }
    try {
      const tx = controlDb.transaction(() => {
        const rule = selectionRuleRepo.insert({
          profileId: body.profileId!,
          ruleType: body.ruleType!,
          pattern: normalizeSelectionPattern(body.pattern!),
          enabled: body.enabled ?? true,
          note: body.note ?? null,
        });
        stateTransitionRepo.insert({
          entityType: "selection_rule",
          entityId: rule.ruleId,
          profile: rule.profileId as ProfileId,
          fromState: "absent",
          toState: rule.enabled ? "enabled" : "disabled",
          triggerType: "selection_rule_create",
          initiator: "api",
          reason: body.note ?? "",
          scoresSnapshot: JSON.stringify({ before: null, after: rule }),
        });
        return rule;
      });
      const rule = tx();
      return reply.send(ok({ rule }));
    } catch (e: unknown) {
      if (String(e).includes("UNIQUE")) {
        return reply.code(409).send(fail("DUPLICATE_RULE", "rule with same type+pattern exists"));
      }
      throw e;
    }
  });

  // ── PATCH /selection-rules/:ruleId ────────────────────────────────────
  app.patch("/selection-rules/:ruleId", async (req, reply) => {
    const { ruleId } = req.params as { ruleId: string };
    const patch = req.body as { enabled?: boolean; note?: string | null };
    const before = selectionRuleRepo.findById(ruleId);
    if (!before) return reply.code(404).send(fail("NOT_FOUND", "rule not found"));
    if (patch.enabled === true && isPrefixRuleType(before.ruleType)) {
      return reply.code(400).send(fail("DEPRECATED_RULE_TYPE", DEPRECATED_PREFIX_MESSAGE));
    }
    const patchArgs: import("@plankton/db").SelectionRulePatch = {};
    if (patch.enabled !== undefined) patchArgs.enabled = patch.enabled;
    if (patch.note !== undefined) patchArgs.note = patch.note;
    const tx = controlDb.transaction(() => {
      const after = selectionRuleRepo.patch(ruleId, patchArgs);
      if (!after) return null;
      stateTransitionRepo.insert({
        entityType: "selection_rule",
        entityId: ruleId,
        profile: after.profileId as ProfileId,
        fromState: before.enabled ? "enabled" : "disabled",
        toState: after.enabled ? "enabled" : "disabled",
        triggerType: "selection_rule_update",
        initiator: "api",
        reason: typeof patch.note === "string" ? patch.note : "",
        scoresSnapshot: JSON.stringify({ before, after }),
      });
      return after;
    });
    const after = tx();
    if (!after) return reply.code(404).send(fail("NOT_FOUND", "rule not found"));
    return reply.send(ok({ rule: after }));
  });

  // ── DELETE /selection-rules/:ruleId ───────────────────────────────────
  app.delete("/selection-rules/:ruleId", async (req, reply) => {
    const { ruleId } = req.params as { ruleId: string };
    const before = selectionRuleRepo.findById(ruleId);
    if (!before) return reply.code(404).send(fail("NOT_FOUND", "rule not found"));
    const tx = controlDb.transaction(() => {
      selectionRuleRepo.delete(ruleId);
      stateTransitionRepo.insert({
        entityType: "selection_rule",
        entityId: ruleId,
        profile: before.profileId as ProfileId,
        fromState: before.enabled ? "enabled" : "disabled",
        toState: "deleted",
        triggerType: "selection_rule_delete",
        initiator: "api",
        reason: "",
        scoresSnapshot: JSON.stringify({ before, after: null }),
      });
    });
    tx();
    return reply.send(ok({ deleted: true, ruleId }));
  });

  // ── GET /selection-rules/preview ──────────────────────────────────────
  // Returns current markets bucketed by their persisted selection_status.
  app.get("/selection-rules/preview", async (req, reply) => {
    const { profileId } = req.query as { profileId?: string };
    if (!profileId) return reply.code(400).send(fail("BAD_REQUEST", "profileId required"));
    const ledger = ledgerPool.get(profileId);
    if (!ledger)
      return reply.code(404).send(fail("LEDGER_NOT_FOUND", `no ledger for profile ${profileId}`));
    // markets is token-level (PK = token_id); binary markets persist one row per
    // outcome token but all selection fields are set per-market. Group by
    // condition_id so counts/examples reflect distinct markets, not tokens.
    const rows = ledger
      .prepare(
        `SELECT condition_id,
                MIN(slug) AS slug,
                MIN(event_slug) AS event_slug,
                MIN(event_market_count) AS event_market_count,
                MIN(selection_status) AS selection_status,
                MIN(selection_winning_rule_id) AS selection_winning_rule_id
         FROM markets
         WHERE active = 1
         GROUP BY condition_id`,
      )
      .all() as Array<{
      condition_id: string;
      slug: string;
      event_slug: string | null;
      event_market_count: number;
      selection_status: string;
      selection_winning_rule_id: string | null;
    }>;
    const bucket = (s: string) =>
      rows
        .filter((r) => r.selection_status === s)
        .map((r) => ({
          conditionId: r.condition_id,
          slug: r.slug,
          eventSlug: r.event_slug,
          eventMarketCount: r.event_market_count,
          winningRuleId: r.selection_winning_rule_id,
        }));
    return reply.send(
      ok({
        matchedInclude: bucket("matched_include"),
        matchedExclude: bucket("matched_exclude"),
        step2FallbackInclude: bucket("step2_fallback_include"),
        fallbackExclude: bucket("fallback_exclude"),
      }),
    );
  });

  // ── GET /selection-rules/match ────────────────────────────────────────
  // Evaluates the current rule engine against a specific market slug.
  // eventMarketCount resolution order:
  //   1. explicit query param (caller knows the scenario)
  //   2. ledger lookup via SqliteMarketRepository
  //   3. 400 — refuses to hide missing market-context telemetry
  app.get("/selection-rules/match", async (req, reply) => {
    const { profileId, eventSlug, marketSlug, eventMarketCount } = req.query as {
      profileId?: string;
      eventSlug?: string;
      marketSlug?: string;
      eventMarketCount?: string;
    };
    if (!profileId || !marketSlug) {
      return reply.code(400).send(fail("BAD_REQUEST", "profileId + marketSlug required"));
    }

    let resolvedCount: number | null = null;
    let countSource: "query" | "ledger" = "query";

    if (eventMarketCount !== undefined) {
      const parsed = Number(eventMarketCount);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return reply
          .code(400)
          .send(fail("BAD_REQUEST", "eventMarketCount must be a positive integer"));
      }
      resolvedCount = parsed;
      countSource = "query";
    } else {
      const ledger = ledgerPool.get(profileId);
      if (!ledger) {
        return reply.code(404).send(fail("LEDGER_NOT_FOUND", `no ledger for profile ${profileId}`));
      }
      const marketRepo = new SqliteMarketRepository(ledger);
      resolvedCount = marketRepo.findEventMarketCountBySlug(marketSlug);
      countSource = "ledger";
    }

    if (resolvedCount === null) {
      return reply
        .code(400)
        .send(
          fail(
            "BAD_REQUEST",
            "eventMarketCount unknown for this slug — pass ?eventMarketCount=N explicitly",
          ),
        );
    }

    const engine = new SelectionRuleEngine(selectionRuleRepo.list(profileId));
    const decision = engine.resolve(eventSlug ?? null, marketSlug);
    const evaled = evaluatePreEntry(engine, {
      eventSlug: eventSlug ?? null,
      slug: marketSlug,
      eventMarketCount: resolvedCount,
    });
    return reply.send(
      ok({
        decision: decision.status,
        winningRuleId: decision.winningRuleId,
        finalStatus: evaled.finalStatus,
        selectionStatus: evaled.selectionStatus,
        eventMarketCount: resolvedCount,
        eventMarketCountSource: countSource,
        step2Fallback: evaled.selectionStatus === "step2_fallback_include",
      }),
    );
  });
};
