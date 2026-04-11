import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadFamilyRulesYaml } from "@plankton/config";
import { applyFamilyConfigImport, bootstrapControlDb, computeConfigChecksum } from "@plankton/db";
import { bootstrapImport, needsBootstrap } from "../apps/runtime/src/bootstrap-import.js";

interface CliOptions {
  readonly controlDbPath: string;
  readonly familyRulesPath: string;
  readonly dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const root = process.cwd();
  let controlDbPath = path.join(root, "apps/runtime/data/control.db");
  let familyRulesPath = path.join(root, "config/family_rules.yaml");
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if ((arg === "--db" || arg === "--control-db") && argv[index + 1]) {
      controlDbPath = path.resolve(root, argv[index + 1]!);
      index += 1;
      continue;
    }
    if ((arg === "--yaml" || arg === "--rules") && argv[index + 1]) {
      familyRulesPath = path.resolve(root, argv[index + 1]!);
      index += 1;
    }
  }

  return { controlDbPath, familyRulesPath, dryRun };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const yamlRaw = readFileSync(options.familyRulesPath, "utf-8");
  const loaded = loadFamilyRulesYaml(options.familyRulesPath);
  const checksum = computeConfigChecksum(yamlRaw);
  const conn = bootstrapControlDb(options.controlDbPath);

  try {
    const bootstrapMode = needsBootstrap(conn.db);
    const result = options.dryRun
      ? applyFamilyConfigImport(conn.db, loaded.families, {
          dryRun: true,
          sourcePath: options.familyRulesPath,
          sourceChecksum: checksum,
          sourceVersion: 1,
          importedBy: "sync-script",
        })
      : conn.db.transaction(() => {
          if (bootstrapMode) {
            bootstrapImport(conn.db, loaded, {
              sourcePath: options.familyRulesPath,
              sourceChecksum: checksum,
              sourceVersion: 1,
              importedBy: "sync-script",
            });
            return {
              added: loaded.families.map((family) => family.identity.familyId),
              updated: [],
              skipped: [],
              conflicts: [],
              unchanged: [],
            };
          }
          return applyFamilyConfigImport(conn.db, loaded.families, {
            dryRun: false,
            sourcePath: options.familyRulesPath,
            sourceChecksum: checksum,
            sourceVersion: 1,
            importedBy: "sync-script",
          });
        })();

    process.stdout.write(
      JSON.stringify(
        {
          dryRun: options.dryRun,
          bootstrapMode: !options.dryRun && bootstrapMode,
          controlDbPath: options.controlDbPath,
          familyRulesPath: options.familyRulesPath,
          checksum,
          familyCount: loaded.families.length,
          result,
          restartRequired: options.dryRun ? false : true,
        },
        null,
        2,
      ) + "\n",
    );

    if (result.conflicts.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    conn.close();
  }
}

void main();
