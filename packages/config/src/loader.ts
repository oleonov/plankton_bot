import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  familyYamlSchema,
  familyRulesFileSchema,
  type FamilyConfig,
  type GlobalConfig,
} from "./schemas.js";

export interface LoadedFamilyRules {
  global: GlobalConfig;
  families: FamilyConfig[];
}

// ─── camelCase conversion ───────────────────────────────────────────────────

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function transformKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(transformKeys);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[snakeToCamel(key)] = transformKeys(value);
    }
    return result;
  }
  return obj;
}

// ─── Loader ─────────────────────────────────────────────────────────────────

function transformFamily(validated: { family_id: string; [k: string]: unknown }): FamilyConfig {
  const familyId = validated.family_id;
  const now = new Date().toISOString();

  const transformed = transformKeys(validated) as Record<string, Record<string, unknown>>;

  // Inject familyId into sub-objects
  transformed["identity"]!["familyId"] = familyId;
  transformed["evidence"]!["familyId"] = familyId;
  transformed["rules"]!["familyId"] = familyId;

  if (transformed["runtimeState"]) {
    transformed["runtimeState"]["familyId"] = familyId;
    transformed["runtimeState"]["updatedAt"] = now;
  }

  return transformed as unknown as FamilyConfig;
}

function parseSingleFamily(raw: unknown, index: number): FamilyConfig {
  const parsed = familyYamlSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  [${i.path.join(".")}] ${i.message}`)
      .join("\n");
    throw new Error(`Schema validation failed for family at index ${index}:\n${details}`);
  }

  return transformFamily(parsed.data);
}

export function loadFamilyRulesYaml(filePath: string): LoadedFamilyRules {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read family rules file "${filePath}": ${msg}`);
  }

  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid YAML in "${filePath}": ${msg}`);
  }

  if (doc === null || typeof doc !== "object") {
    throw new Error(`Family rules file "${filePath}" must contain a YAML object`);
  }

  const record = doc as Record<string, unknown>;

  // Multi-family format: validate top-level schema (version + families array)
  if (Array.isArray(record["families"])) {
    const parsed = familyRulesFileSchema.safeParse(doc);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => `  [${i.path.join(".")}] ${i.message}`)
        .join("\n");
      throw new Error(`Schema validation failed for multi-family file "${filePath}":\n${details}`);
    }
    return {
      global: transformKeys(parsed.data.global) as GlobalConfig,
      families: parsed.data.families.map((f) => transformFamily(f)),
    };
  }

  // Single-family file (like the template)
  if (typeof record["family_id"] === "string") {
    if (record["global"] !== undefined) {
      throw new Error(
        `"global" section is not supported in single-family format. ` +
          `Use the multi-family format (with "families" array) to set global config.`,
      );
    }
    return {
      global: { initialBalanceUsdc: 10_000 },
      families: [parseSingleFamily(doc, 0)],
    };
  }

  throw new Error(
    `Family rules file "${filePath}" must have a "families" array or be a single-family document with "family_id"`,
  );
}
