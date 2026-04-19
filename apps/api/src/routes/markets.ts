import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok, fail } from "../errors.js";
import type { LedgerPool } from "../ledger-pool.js";

interface MarketsOpts {
  ledgerDb: Database.Database;
  ledgerPool: LedgerPool;
}

export const marketsRoutes: FastifyPluginAsync<MarketsOpts> = async (app, opts) => {
  const { ledgerPool } = opts;

  // ── GET /markets/event-slugs ──────────────────────────────────────────
  // Returns the distinct event slugs from the profile's ledger.
  // Used by the UI's selection-rule filter dropdowns.
  app.get("/markets/event-slugs", async (req, reply) => {
    const { profileId } = req.query as { profileId?: string };
    if (!profileId) return reply.code(400).send(fail("BAD_REQUEST", "profileId required"));
    const ledger = ledgerPool.get(profileId);
    if (!ledger)
      return reply.code(404).send(fail("LEDGER_NOT_FOUND", `no ledger for profile ${profileId}`));
    const rows = ledger
      .prepare(
        "SELECT DISTINCT event_slug FROM markets WHERE event_slug IS NOT NULL ORDER BY event_slug",
      )
      .all() as Array<{ event_slug: string }>;
    return reply.send(ok({ eventSlugs: rows.map((r) => r.event_slug) }));
  });
};
