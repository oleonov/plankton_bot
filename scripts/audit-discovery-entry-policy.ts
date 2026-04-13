import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { loadFamilyRulesYaml } from "../packages/config/src/loader.ts";
import {
  resolveDiscoveryEntryPolicy,
  type EntryRulePreset,
} from "../packages/domain/src/discovery-entry-policy.ts";

interface CliOptions {
  rulesPath: string;
  dbPath: string | null;
}

interface PolicyAuditRow {
  source: string;
  id: string;
  familyKey: string;
  primaryCategory: string;
  regime: string;
  horizon: string;
  strategyProfile: string;
  matchedBy: string;
  tier: string;
  resolved: EntryRulePreset;
  current: EntryRulePreset | null;
  diffs: string[];
}

function querySqlite(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", ["-tabs", "-noheader", dbPath, sql], {
    encoding: "utf8",
  });
}

function getTableColumns(dbPath: string, tableName: string): Set<string> {
  const raw = querySqlite(dbPath, `PRAGMA table_info(${tableName})`);
  if (raw.trim() === "") return new Set();

  return new Set(
    raw
      .trim()
      .split("\n")
      .map((line) => line.split("\t")[1])
      .filter((name): name is string => Boolean(name)),
  );
}

function parseArgs(argv: string[]): CliOptions {
  const root = process.cwd();
  let rulesPath = path.resolve(root, "config/family_rules.yaml");
  let dbPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === "--rules" || arg === "--yaml") && argv[index + 1]) {
      rulesPath = path.resolve(root, argv[index + 1]!);
      index += 1;
      continue;
    }
    if ((arg === "--db" || arg === "--control-db") && argv[index + 1]) {
      dbPath = path.resolve(root, argv[index + 1]!);
      index += 1;
    }
  }

  return { rulesPath, dbPath };
}

function diffPreset(current: EntryRulePreset | null, resolved: EntryRulePreset): string[] {
  if (current == null) return ["current-rules-missing"];

  const diffs: string[] = [];
  if (current.minEntryPrice !== resolved.minEntryPrice) diffs.push("min_entry_price");
  if (current.maxEntryPrice !== resolved.maxEntryPrice) diffs.push("max_entry_price");
  if (current.highPriceThreshold !== resolved.highPriceThreshold)
    diffs.push("high_price_threshold");
  if (current.requireProvenFamilyAbovePrice !== resolved.requireProvenFamilyAbovePrice) {
    diffs.push("require_proven_family_above_price");
  }
  if ((current.preferredEntryBand ?? null) !== (resolved.preferredEntryBand ?? null)) {
    diffs.push("preferred_entry_band");
  }
  return diffs;
}

function auditYamlFamilies(
  rulesPath: string,
  defaultEntryPreset: EntryRulePreset,
): PolicyAuditRow[] {
  const loaded = loadFamilyRulesYaml(rulesPath);
  return loaded.families.map((family) => {
    const resolved = resolveDiscoveryEntryPolicy({
      familyKey: family.identity.familyKey,
      primaryCategory: family.identity.primaryCategory,
      regime: family.identity.regime,
      horizon: family.identity.horizon,
      strategyProfile: family.identity.strategyProfile,
      slugPattern: family.identity.slugPattern,
      defaultEntryPreset,
    });
    const current = {
      minEntryPrice: family.rules.entry.minEntryPrice,
      maxEntryPrice: family.rules.entry.maxEntryPrice,
      highPriceThreshold: family.rules.entry.highPriceThreshold,
      requireProvenFamilyAbovePrice: family.rules.entry.requireProvenFamilyAbovePrice,
      preferredEntryBand: family.rules.entry.preferredEntryBand,
    };
    return {
      source: "yaml",
      id: family.identity.familyId,
      familyKey: family.identity.familyKey,
      primaryCategory: family.identity.primaryCategory,
      regime: family.identity.regime,
      horizon: family.identity.horizon,
      strategyProfile: family.identity.strategyProfile,
      matchedBy: resolved.matchedBy,
      tier: resolved.tier,
      resolved: resolved.preset,
      current,
      diffs: diffPreset(current, resolved.preset),
    };
  });
}

function auditCatalogFamilies(
  dbPath: string,
  defaultEntryPreset: EntryRulePreset,
  yamlFamilyIds: Set<string>,
  yamlFamilyKeys: Set<string>,
): PolicyAuditRow[] {
  const catalogColumns = getTableColumns(dbPath, "family_catalog");
  if (catalogColumns.size === 0) return [];

  const hasSourceType = catalogColumns.has("source_type");
  const hasSlugPattern = catalogColumns.has("slug_pattern");
  const query = `
    SELECT
      c.family_id,
      c.family_key,
      c.primary_category,
      c.regime,
      c.horizon,
      c.strategy_profile,
      ${hasSlugPattern ? "COALESCE(c.slug_pattern, '')" : "''"},
      ${hasSourceType ? "c.source_type" : "''"},
      COALESCE(CAST(r.min_entry_price AS TEXT), ''),
      COALESCE(CAST(r.max_entry_price AS TEXT), ''),
      COALESCE(CAST(r.high_price_threshold AS TEXT), ''),
      COALESCE(CAST(r.require_proven_family_above_price AS TEXT), ''),
      COALESCE(r.preferred_entry_band, '')
    FROM family_catalog c
    LEFT JOIN family_rules r ON r.family_id = c.family_id
    ORDER BY c.family_key
  `;
  const raw = querySqlite(dbPath, query);
  const rows = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [
        familyId,
        familyKey,
        primaryCategory,
        regime,
        horizon,
        strategyProfile,
        slugPattern,
        sourceType,
        minEntryPrice,
        maxEntryPrice,
        highPriceThreshold,
        requireProvenFamilyAbovePrice,
        preferredEntryBand,
      ] = line.split("\t");
      return {
        family_id: familyId ?? "",
        family_key: familyKey ?? "",
        primary_category: primaryCategory ?? "",
        regime: regime ?? "",
        horizon: horizon ?? "",
        strategy_profile: strategyProfile ?? "",
        slug_pattern: slugPattern ? slugPattern : null,
        source_type: sourceType ?? "",
        min_entry_price: minEntryPrice === "" ? null : Number(minEntryPrice),
        max_entry_price: maxEntryPrice === "" ? null : Number(maxEntryPrice),
        high_price_threshold: highPriceThreshold === "" ? null : Number(highPriceThreshold),
        require_proven_family_above_price:
          requireProvenFamilyAbovePrice === "" ? null : Number(requireProvenFamilyAbovePrice),
        preferred_entry_band: preferredEntryBand === "" ? null : preferredEntryBand,
      };
    });

  return rows.map((row) => {
    const source =
      row.source_type !== ""
        ? row.source_type
        : yamlFamilyIds.has(row.family_id) || yamlFamilyKeys.has(row.family_key)
          ? "yaml_import"
          : "discovery";
    const resolved = resolveDiscoveryEntryPolicy({
      familyKey: row.family_key,
      primaryCategory: row.primary_category,
      regime: row.regime,
      horizon: row.horizon,
      strategyProfile: row.strategy_profile,
      slugPattern: row.slug_pattern,
      defaultEntryPreset,
    });
    const current =
      row.min_entry_price == null ||
      row.max_entry_price == null ||
      row.high_price_threshold == null ||
      row.require_proven_family_above_price == null
        ? null
        : {
            minEntryPrice: row.min_entry_price,
            maxEntryPrice: row.max_entry_price,
            highPriceThreshold: row.high_price_threshold,
            requireProvenFamilyAbovePrice: row.require_proven_family_above_price,
            preferredEntryBand: row.preferred_entry_band,
          };
    return {
      source,
      id: row.family_id,
      familyKey: row.family_key,
      primaryCategory: row.primary_category,
      regime: row.regime,
      horizon: row.horizon,
      strategyProfile: row.strategy_profile,
      matchedBy: resolved.matchedBy,
      tier: resolved.tier,
      resolved: resolved.preset,
      current,
      diffs: diffPreset(current, resolved.preset),
    };
  });
}

function auditDiscoveryCandidates(
  dbPath: string,
  defaultEntryPreset: EntryRulePreset,
): PolicyAuditRow[] {
  const candidateColumns = getTableColumns(dbPath, "family_candidates");
  if (candidateColumns.size === 0) return [];

  const query = `
    SELECT
      candidate_id,
      family_key,
      primary_category,
      regime,
      horizon,
      strategy_profile,
      COALESCE(slug_pattern, ''),
      status
    FROM family_candidates
    ORDER BY status, family_key
  `;
  const raw = querySqlite(dbPath, query);
  if (raw.trim() === "") return [];

  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [
        candidateId,
        familyKey,
        primaryCategory,
        regime,
        horizon,
        strategyProfile,
        slugPattern,
        status,
      ] = line.split("\t");
      const resolved = resolveDiscoveryEntryPolicy({
        familyKey: familyKey ?? "",
        primaryCategory: primaryCategory ?? "",
        regime: regime ?? "",
        horizon: horizon ?? "",
        strategyProfile: strategyProfile ?? "",
        slugPattern: slugPattern === "" ? null : (slugPattern ?? null),
        defaultEntryPreset,
      });
      return {
        source: `candidate:${status ?? "unknown"}`,
        id: candidateId ?? "",
        familyKey: familyKey ?? "",
        primaryCategory: primaryCategory ?? "",
        regime: regime ?? "",
        horizon: horizon ?? "",
        strategyProfile: strategyProfile ?? "",
        matchedBy: resolved.matchedBy,
        tier: resolved.tier,
        resolved: resolved.preset,
        current: resolved.preset,
        diffs: [],
      };
    });
}

function printSection(title: string, rows: PolicyAuditRow[]): void {
  const mismatches = rows.filter((row) => row.diffs.length > 0);
  const fallbackRows = rows.filter((row) => row.matchedBy === "fallback");
  process.stdout.write(`\n## ${title}\n`);
  process.stdout.write(
    `rows=${rows.length} mismatches=${mismatches.length} fallback=${fallbackRows.length}\n`,
  );

  if (mismatches.length > 0) {
    process.stdout.write("\nMismatches:\n");
    for (const row of mismatches.slice(0, 25)) {
      process.stdout.write(
        `- ${row.source} ${row.id} tier=${row.tier} matchedBy=${row.matchedBy} diffs=${row.diffs.join(",")}\n`,
      );
    }
  }

  if (fallbackRows.length > 0) {
    process.stdout.write("\nFallbacks:\n");
    for (const row of fallbackRows.slice(0, 25)) {
      process.stdout.write(
        `- ${row.source} ${row.id} familyKey=${row.familyKey} category=${row.primaryCategory} regime=${row.regime}\n`,
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loaded = loadFamilyRulesYaml(options.rulesPath);
  if (loaded.defaults.entry == null) {
    throw new Error(
      `rules file "${options.rulesPath}" does not define defaults.entry; audit requires a canonical default preset`,
    );
  }

  const yamlRows = auditYamlFamilies(options.rulesPath, loaded.defaults.entry);
  printSection("YAML Families", yamlRows);

  if (options.dbPath) {
    const yamlFamilyIds = new Set(loaded.families.map((family) => family.identity.familyId));
    const yamlFamilyKeys = new Set(loaded.families.map((family) => family.identity.familyKey));
    const catalogRows = auditCatalogFamilies(
      options.dbPath,
      loaded.defaults.entry,
      yamlFamilyIds,
      yamlFamilyKeys,
    );
    const yamlImportRows = catalogRows.filter((row) => row.source === "yaml_import");
    const discoveryRows = catalogRows.filter((row) => row.source === "discovery");
    const candidateRows = auditDiscoveryCandidates(options.dbPath, loaded.defaults.entry);
    printSection("DB YAML Imports", yamlImportRows);
    printSection("DB Discovery Families", discoveryRows);
    printSection("DB Discovery Candidates", candidateRows);
  }
}

void main();
