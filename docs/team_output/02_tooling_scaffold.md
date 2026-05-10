# 02 Tooling Scaffold -- Monorepo & Tooling Engineering Output

Date: 2026-03-13
Input: `docs/superpowers/specs/2026-03-13-phase1-bootstrap-monorepo-design.md`

---

## 1. Review of Existing Phase 1 Spec

The Phase 1 design spec is solid and covers the core scaffold well. Below are gaps and corrections.

### Gaps Found

| #   | Gap                                                                                                                                                                                                                   | Severity | Resolution                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| 1   | **No `.env` loading strategy** -- the v1 dev plan lists "env loading" as a must-have for Phase 1, but the spec only has `.env.example` with no library choice or loading pattern                                      | Medium   | Use `dotenv` (see Section 8)                                            |
| 2   | **No logging library chosen** -- Phase 5 requires structured logging, but nothing is installed in Phase 1. The base should be available early for debugging                                                           | Medium   | Install `pino` at root (see Section 8)                                  |
| 3   | **No YAML parsing library specified** -- `@krabs/config` lists `yaml` as a dep but does not specify which npm package                                                                                                 | Low      | Use `yaml` (the `yaml` npm package, YAML 1.2 compliant)                 |
| 4   | **`typecheck` task in turbo.json has no `dependsOn: ["^build"]`** -- type-checking a downstream package requires upstream `.d.ts` files to exist first                                                                | High     | Add `dependsOn: ["^build"]` to `typecheck` task                         |
| 5   | **`test` task should also depend on `^build`** -- vitest resolving workspace imports works, but `tsc -b` outputs are needed for packages that import compiled siblings                                                | Medium   | Add `dependsOn: ["^build"]` to `test` task                              |
| 6   | **Missing `@types/better-sqlite3`** -- `better-sqlite3` is a native addon with no built-in types                                                                                                                      | Low      | Add to `@krabs/db` devDependencies                                      |
| 7   | **`outDir` and `rootDir` in `tsconfig.base.json`** -- these should not be in the base config because each package overrides them anyway, and leaving them in the base causes confusing errors when tsc is run at root | Low      | Remove from base, set per-package only                                  |
| 8   | **No `composite: true`** in base tsconfig -- required for `tsc -b` (project references) to work                                                                                                                       | High     | Add `composite: true` to `tsconfig.base.json`                           |
| 9   | **`apps/web` framework not specified** -- spec says "placeholder" but does not state whether this will be a Next.js app, Vite+React, or plain TS. Matters for package.json shape                                      | Low      | Defer to Phase 13. For now, plain TS placeholder with no framework deps |
| 10  | **No `turbo.json` `pipeline` for `dev` script** -- during development, `turbo run dev` is useful for apps                                                                                                             | Low      | Add `dev` task (persistent, no cache)                                   |
| 11  | **Missing `engines` field in root package.json** -- should enforce Node 24                                                                                                                                            | Low      | Add `engines: { "node": ">=24.0.0" }`                                   |

### Corrections

1. **`pnpm-workspace.yaml` syntax** -- pnpm 10.x uses the `packages:` key (confirmed correct in spec).
2. **`eslint.config.js` not `.mjs`** -- spec correctly notes this since the project is `"type": "module"`. Confirmed correct.
3. **`research/` instead of `research/python/`** -- spec intentionally deviates from arch doc. This is fine; Python-only directory does not need `/python/` nesting.

---

## 2. Root Config Checklist

Every file below lives at the monorepo root (`poly_plankton/`).

### 2.1 `package.json`

```json
{
  "private": true,
  "name": "krabs",
  "type": "module",
  "packageManager": "pnpm@10.6.1",
  "engines": {
    "node": ">=24.0.0"
  },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "dev": "turbo run dev",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@eslint/js": "^9.22.0",
    "@types/node": "^22.13.0",
    "@vitest/coverage-v8": "^3.0.0",
    "eslint": "^9.22.0",
    "eslint-config-prettier": "^10.1.0",
    "prettier": "^3.5.0",
    "tsx": "^4.19.0",
    "turbo": "^2.4.0",
    "typescript": "^5.8.0",
    "typescript-eslint": "^8.28.0",
    "vitest": "^3.0.0"
  }
}
```

### 2.2 `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### 2.3 `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "lint": {},
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

Key change vs spec: `typecheck` and `test` now depend on `^build` so that upstream declaration files exist before downstream packages are checked/tested.

### 2.4 `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  }
}
```

Changes vs spec:

- **Removed** `outDir` and `rootDir` -- set per-package only.
- **Added** `composite: true` -- required for `tsc -b` project references.
- **Added** `isolatedModules: true` -- ensures compatibility with esbuild/swc transpilers and vitest.
- **Added** `verbatimModuleSyntax: true` -- enforces explicit `import type` for type-only imports (pure ESM best practice, avoids runtime import of type-only modules).

### 2.5 `vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
  },
});
```

Each package that has tests provides its own `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

### 2.6 `eslint.config.js`

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "research/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": "warn",
    },
  },
);
```

### 2.7 `.prettierrc`

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

### 2.8 `.npmrc`

```
strict-peer-dependencies=true
resolve-peers-from-workspace-root=true
```

### 2.9 `.node-version`

```
24
```

### 2.10 `.gitignore`

```gitignore
node_modules/
dist/
*.tsbuildinfo
.turbo/
coverage/
__pycache__/
*.pyc
.DS_Store
.env
*.db-wal
*.db-shm
```

Note: `*.db` files are NOT ignored globally because the research SQLite DB is tracked. The `.db-wal` and `.db-shm` are WAL artifacts and should be ignored.

### 2.11 `.env.example`

```env
# Polymarket CLOB credentials
POLY_API_KEY=
POLY_API_SECRET=
POLY_PASSPHRASE=

# Runtime mode: simulation | paper | live
RUNTIME_MODE=simulation

# Logging level: debug | info | warn | error
LOG_LEVEL=info

# SQLite database path (relative to apps/runtime)
DB_PATH=./data/krabs.db

# Family rules config path
FAMILY_RULES_PATH=./config/family_rules.yaml
```

---

## 3. Per-Package Config Template

### 3.1 Library package (`packages/*`)

**`package.json`** (example for `@krabs/domain`):

```json
{
  "name": "@krabs/domain",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "test": "vitest run"
  }
}
```

**`tsconfig.json`** (example for `@krabs/domain`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": []
}
```

For packages with workspace dependencies (e.g., `@krabs/event-bus`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../domain" }]
}
```

### 3.2 App package (`apps/*`)

**`package.json`** (example for `apps/runtime`):

```json
{
  "name": "@krabs/runtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "test": "vitest run"
  },
  "dependencies": {
    "@krabs/domain": "workspace:*",
    "@krabs/config": "workspace:*",
    "@krabs/event-bus": "workspace:*",
    "@krabs/db": "workspace:*",
    "@krabs/exchange": "workspace:*",
    "@krabs/family-rules": "workspace:*"
  }
}
```

Apps do NOT use `exports` -- they are entry points, not consumed by other packages.

**`tsconfig.json`** (for `apps/runtime`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    { "path": "../../packages/domain" },
    { "path": "../../packages/config" },
    { "path": "../../packages/event-bus" },
    { "path": "../../packages/db" },
    { "path": "../../packages/exchange" },
    { "path": "../../packages/family-rules" }
  ]
}
```

### 3.3 Package reference map

| Package               | `tsconfig.json` references                         |
| --------------------- | -------------------------------------------------- |
| `@krabs/domain`       | (none)                                             |
| `@krabs/config`       | (none -- uses `zod` and `yaml`, no workspace deps) |
| `@krabs/event-bus`    | `../domain`                                        |
| `@krabs/db`           | `../domain`                                        |
| `@krabs/exchange`     | `../domain`                                        |
| `@krabs/family-rules` | `../domain`, `../config`                           |
| `apps/runtime`        | all six packages                                   |
| `apps/api`            | `../../packages/domain`, `../../packages/db`       |
| `apps/web`            | `../../packages/domain`                            |

---

## 4. Build Pipeline

### 4.1 Turbo task graph

```
build
  ^build means: build my dependencies before building me

Concrete order (turbo resolves automatically):

Layer 0 (no deps):    @krabs/domain, @krabs/config
Layer 1:              @krabs/event-bus, @krabs/db, @krabs/exchange
Layer 2:              @krabs/family-rules
Layer 3:              @krabs/runtime, @krabs/api, @krabs/web
```

Layers 0 and 1 items within the same layer build in parallel.

### 4.2 What each `build` script does

Every package uses `tsc -b` which:

- Reads `tsconfig.json`
- Builds referenced projects first (via `references`)
- Emits `.js`, `.d.ts`, `.d.ts.map`, `.js.map` into `dist/`
- Writes `.tsbuildinfo` for incremental builds

### 4.3 Cache outputs

Turbo caches `dist/**` for `build` tasks. The `typecheck`, `test`, and `lint` tasks are not cached by default (no `outputs` specified), which is correct for v1. Caching lint/test can be added later if CI times grow.

---

## 5. Dev Workflow

### 5.1 First-time setup

```bash
# Install pnpm if not present
corepack enable
corepack prepare pnpm@10.6.1 --activate

# Install all dependencies
pnpm install

# Build all packages (needed once for TS project references)
pnpm build
```

### 5.2 Daily development commands

| Command             | What it does                                 |
| ------------------- | -------------------------------------------- |
| `pnpm build`        | Build all packages via turbo (incremental)   |
| `pnpm test`         | Run all tests via turbo                      |
| `pnpm lint`         | Lint all packages via turbo                  |
| `pnpm typecheck`    | Type-check all packages via turbo            |
| `pnpm format`       | Format all files with prettier               |
| `pnpm format:check` | Check formatting (CI)                        |
| `pnpm dev`          | Start `apps/runtime` in watch mode via turbo |

### 5.3 Single-package development

```bash
# Build only one package
pnpm --filter @krabs/domain build

# Test only one package
pnpm --filter @krabs/db test

# Run runtime in watch mode
pnpm --filter @krabs/runtime dev

# Add a dependency to a specific package
pnpm --filter @krabs/db add better-sqlite3
```

### 5.4 Adding a workspace dependency

```bash
pnpm --filter @krabs/event-bus add @krabs/domain --workspace
```

This adds `"@krabs/domain": "workspace:*"` to the consumer's `package.json`.

---

## 6. Dependencies Audit

### 6.1 Root devDependencies

| Package                  | Version Range | Purpose                      |
| ------------------------ | ------------- | ---------------------------- |
| `typescript`             | `^5.8.0`      | TypeScript compiler          |
| `@types/node`            | `^22.13.0`    | Node.js type definitions     |
| `turbo`                  | `^2.4.0`      | Build orchestration          |
| `vitest`                 | `^3.0.0`      | Test runner                  |
| `@vitest/coverage-v8`    | `^3.0.0`      | Coverage provider            |
| `eslint`                 | `^9.22.0`     | Linter                       |
| `@eslint/js`             | `^9.22.0`     | ESLint recommended rules     |
| `typescript-eslint`      | `^8.28.0`     | TS-aware ESLint rules        |
| `eslint-config-prettier` | `^10.1.0`     | Disables formatting rules    |
| `prettier`               | `^3.5.0`      | Code formatter               |
| `tsx`                    | `^4.19.0`     | TS execution for dev/scripts |

### 6.2 Per-package runtime dependencies

| Package               | Dependency                | Version Range | Purpose                     |
| --------------------- | ------------------------- | ------------- | --------------------------- |
| `@krabs/domain`       | (none)                    | --            | Pure types, zero deps       |
| `@krabs/config`       | `zod`                     | `^3.24.0`     | Schema validation           |
| `@krabs/config`       | `yaml`                    | `^2.7.0`      | YAML parsing (family rules) |
| `@krabs/config`       | `dotenv`                  | `^16.4.0`     | `.env` file loading         |
| `@krabs/db`           | `better-sqlite3`          | `^11.8.0`     | SQLite driver               |
| `@krabs/exchange`     | `@polymarket/clob-client` | `^4.x`        | Polymarket CLOB API client  |
| `@krabs/family-rules` | (none)                    | --            | Uses workspace deps only    |
| `apps/runtime`        | `pino`                    | `^9.6.0`      | Structured logging          |

### 6.3 Per-package devDependencies

| Package     | Dependency              | Version Range | Purpose          |
| ----------- | ----------------------- | ------------- | ---------------- |
| `@krabs/db` | `@types/better-sqlite3` | `^7.6.0`      | Type definitions |

### 6.4 Workspace dependency map

| Consumer              | Workspace Dependencies           |
| --------------------- | -------------------------------- |
| `@krabs/domain`       | (none)                           |
| `@krabs/config`       | (none)                           |
| `@krabs/event-bus`    | `@krabs/domain`                  |
| `@krabs/db`           | `@krabs/domain`                  |
| `@krabs/exchange`     | `@krabs/domain`                  |
| `@krabs/family-rules` | `@krabs/domain`, `@krabs/config` |
| `@krabs/runtime`      | all six `@krabs/*` packages      |
| `@krabs/api`          | `@krabs/domain`, `@krabs/db`     |
| `@krabs/web`          | `@krabs/domain`                  |

### 6.5 Version pinning strategy

- Use caret (`^`) ranges for all dependencies.
- `pnpm-lock.yaml` provides exact reproducibility.
- No pinning to exact versions unless a known regression requires it.

---

## 7. File Migration Plan

### 7.1 Files to move

| Current path                         | New path                                      | Notes                                     |
| ------------------------------------ | --------------------------------------------- | ----------------------------------------- |
| `fetch_plankton_trades.py`           | `research/fetch_plankton_trades.py`           |                                           |
| `analyze.py`                         | `research/analyze.py`                         |                                           |
| `analyze_deep.py`                    | `research/analyze_deep.py`                    |                                           |
| `enrich_analysis.py`                 | `research/enrich_analysis.py`                 |                                           |
| `generate_replication_spec.py`       | `research/generate_replication_spec.py`       |                                           |
| `generate_remote_snapshot_report.py` | `research/generate_remote_snapshot_report.py` |                                           |
| `generate_family_parameter_sheet.py` | `research/generate_family_parameter_sheet.py` |                                           |
| `run_hypothesis_tests.py`            | `research/run_hypothesis_tests.py`            |                                           |
| `plankton_trades.db`                 | `research/data/plankton_trades.db`            | ~158 MB, consider `.gitignore` or Git LFS |
| `plankton_trades.db-shm`             | delete                                        | WAL artifact, .gitignore'd                |
| `plankton_trades.db-wal`             | delete                                        | WAL artifact, .gitignore'd                |
| `analysis_report.txt`                | `research/reports/analysis_report.txt`        |                                           |
| `analysis_deep_report.txt`           | `research/reports/analysis_deep_report.txt`   |                                           |
| `__pycache__/`                       | delete                                        | Add to `.gitignore`                       |

### 7.2 Files that stay

| Path            | Notes                                      |
| --------------- | ------------------------------------------ |
| `docs/*`        | All docs stay. No changes                  |
| `arch_tmp.md`   | Move to `docs/arch_tmp.md` for cleanliness |
| `discussion.md` | Keep at root (working notes)               |
| `.claude/`      | Keep at root (Claude config)               |

### 7.3 New directories to create

```
research/
research/data/
research/reports/
apps/
apps/runtime/src/
apps/api/src/
apps/web/src/
packages/
packages/domain/src/
packages/config/src/
packages/event-bus/src/
packages/db/src/
packages/db/src/sqlite/
packages/db/src/sqlite/repos/
packages/db/src/migrations/
packages/exchange/src/
packages/family-rules/src/
```

### 7.4 Migration execution order

1. Create all new directories.
2. Move Python files into `research/`.
3. Move `plankton_trades.db` into `research/data/`.
4. Move report `.txt` files into `research/reports/`.
5. Delete `__pycache__/`, `.db-wal`, `.db-shm`.
6. Move `arch_tmp.md` into `docs/`.
7. Create all root config files.
8. Create all package.json and tsconfig.json files.
9. Create placeholder source files.
10. Run `pnpm install`.
11. Run `pnpm build` to verify.

### 7.5 Large file warning

`plankton_trades.db` is approximately 158 MB. Options:

- **Option A (recommended for v1):** Add `research/data/*.db` to `.gitignore`. Developers fetch it separately or regenerate with the Python scripts.
- **Option B:** Use Git LFS for `*.db` files.
- **Option C:** Keep tracking it (wastes repo space, slows clones).

Recommendation: **Option A**. Add to `.gitignore`, document how to regenerate.

---

## 8. Specific Tooling Decisions

### 8.1 Environment variable loading

**Decision:** Use `dotenv` (`^16.4.0`) in `@krabs/config`.

**Rationale:**

- The most widely used `.env` loader in the Node.js ecosystem.
- Zero-config, well-understood behavior.
- Node.js 24 has experimental built-in `.env` support via `--env-file` flag, but it is not yet stable and does not support programmatic loading from arbitrary paths. Stick with `dotenv` for now and revisit when the built-in API stabilizes.

**Loading pattern:**

```ts
// packages/config/src/env.ts
import { config } from "dotenv";
import { resolve } from "node:path";

export function loadEnv(envPath?: string): void {
  config({ path: envPath ?? resolve(process.cwd(), ".env") });
}
```

- Call `loadEnv()` once at the top of `apps/runtime/src/index.ts` before any other imports that read `process.env`.
- Validate all env vars with `zod` schemas immediately after loading.
- Never spread `process.env` into config objects -- always go through the validated config layer.

**`.env` file locations:**

- Root `.env` for local development (gitignored).
- Root `.env.example` committed with placeholder values.
- No per-package `.env` files. All env is loaded by the app entry point and passed down.

### 8.2 Logging library

**Decision:** Use `pino` (`^9.6.0`) as the structured logging library. Install `pino-pretty` (`^13.0.0`) as a root devDependency for human-readable dev output.

**Rationale:**

- Pino is the fastest structured JSON logger for Node.js.
- JSON output is production-ready (pipe to any log aggregator).
- `pino-pretty` provides readable dev output without code changes (use via `| pnpm exec pino-pretty` or `transport` in dev mode).
- No configuration-heavy alternatives (winston is heavier, bunyan is unmaintained).
- Pino supports child loggers with context binding, which maps well to per-family or per-module logging.

**Installation location:**

- `pino` as a runtime dependency in `apps/runtime` (and later `apps/api`).
- `pino-pretty` as a root devDependency.

**Usage pattern:**

```ts
// apps/runtime/src/logger.ts
import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  transport: process.env["NODE_ENV"] !== "production" ? { target: "pino-pretty" } : undefined,
});
```

Components receive a child logger:

```ts
const familyLogger = logger.child({ family: familyId });
familyLogger.info({ market: marketId }, "processing market");
```

### 8.3 YAML parsing library

**Decision:** Use `yaml` (`^2.7.0`) -- the npm package named `yaml`.

**Rationale:**

- Full YAML 1.2 spec compliance.
- Pure JavaScript, no native bindings.
- TypeScript types included.
- Actively maintained (formerly `yaml@2`).
- Alternatives considered and rejected:
  - `js-yaml`: YAML 1.1 only, no built-in TS types, less maintained.
  - `yamljs`: Unmaintained.

**Installation location:** `@krabs/config` runtime dependency.

**Usage pattern:**

```ts
import { parse } from "yaml";
import { readFileSync } from "node:fs";

export function loadYaml<T>(filePath: string): T {
  const raw = readFileSync(filePath, "utf8");
  return parse(raw) as T;
}
```

The loaded object is then validated with `zod` before use. Never trust raw YAML output -- always run through the schema.

---

## Summary Checklist for Implementation Agent

The implementation agent should follow this exact order:

- [ ] Move existing Python files into `research/` per Section 7
- [ ] Create root config files per Section 2 (all 11 files)
- [ ] Create all package directories per Section 7.3
- [ ] Create per-package `package.json` files per Section 3
- [ ] Create per-package `tsconfig.json` files per Section 3.3
- [ ] Create per-package `vitest.config.ts` files per Section 2.5
- [ ] Create placeholder `src/index.ts` in every package/app
- [ ] Create `apps/runtime/src/index.ts` with cross-package import proof
- [ ] Run `pnpm install`
- [ ] Run `pnpm build` -- must pass
- [ ] Run `pnpm typecheck` -- must pass
- [ ] Run `pnpm test` -- must pass (empty suites)
- [ ] Run `pnpm lint` -- must pass
- [ ] Run `pnpm format:check` -- must pass
