# 01 Architect Package Map

Date: 2026-03-13
Status: Final for v1
References: arch_tmp.md, v1_development_plan.md, Phase 1 bootstrap spec

---

## 1. Final Package Map

### Shared Packages (under `packages/`)

| Package                  | Responsibility                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@plankton/domain`       | Pure types, enums, event definitions, command definitions, and repository/gateway interfaces. Zero runtime dependencies. The single source of truth for every cross-boundary contract.                     |
| `@plankton/config`       | YAML/env config loading and zod validation. Exposes typed, validated config objects. Knows nothing about what consumes the config.                                                                         |
| `@plankton/event-bus`    | Typed in-process pub/sub bus. Accepts `@plankton/domain` event types. Replaceable later with Redis/NATS without changing consumers.                                                                        |
| `@plankton/db`           | Repository interface implementations (SQLite in v1). Owns connection management, migrations, WAL setup. Exposes only repository interfaces defined in `@plankton/domain`.                                  |
| `@plankton/exchange`     | Exchange gateway implementations (`LiveExchangeGateway`, `SimulationExchangeGateway`). Wraps Polymarket CLOB SDK. Exposes only the `ExchangeGateway` interface defined in `@plankton/domain`.              |
| `@plankton/family-rules` | Family rule loading, validation, resolution (`family_key:regime:horizon` -> `FamilyRule`). Owns the family config file format. Depends on `@plankton/domain` for types and `@plankton/config` for loading. |

### Applications (under `apps/`)

| App            | Responsibility                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime` | The trading bot process. Composes all packages and internal modules into a running system. Owns the supervisor, startup/shutdown sequences, and the main loop. |
| `apps/api`     | REST + SSE server for operator dashboard. Reads from DB repositories. Accepts operator commands. Contains no trading logic.                                    |
| `apps/web`     | Operator dashboard UI. Talks only to `apps/api`. Contains no domain logic beyond display.                                                                      |

### Not a Package (stays separate)

| Directory   | Note                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `research/` | Python scripts for offline analysis. Not part of the TypeScript build graph. Communicates with the runtime only through file artifacts (YAML configs, SQLite snapshots). |

---

## 2. Dependency Graph

```
@plankton/domain          (depends on: nothing)
    ^
    |
    +--- @plankton/config         (depends on: nothing from workspace)
    |
    +--- @plankton/event-bus      (depends on: domain)
    |
    +--- @plankton/db             (depends on: domain)
    |
    +--- @plankton/exchange       (depends on: domain)
    |
    +--- @plankton/family-rules   (depends on: domain, config)
         ^
         |
apps/runtime  (depends on: domain, config, event-bus, db, exchange, family-rules)
apps/api      (depends on: domain, db, config)
apps/web      (depends on: domain only -- for shared types)
```

Text summary of allowed edges:

```
domain         -> (nothing)
config         -> (nothing from workspace; external: zod, yaml)
event-bus      -> domain
db             -> domain
exchange       -> domain
family-rules   -> domain, config
apps/runtime   -> all packages
apps/api       -> domain, db, config
apps/web       -> domain
```

---

## 3. Dependency Direction Rules

### Allowed

- Every package may depend on `@plankton/domain`.
- `@plankton/family-rules` may depend on `@plankton/config` (it needs the loader).
- Apps may depend on any package.
- `apps/api` may depend on `@plankton/db` (it reads repositories directly in v1).

### Forbidden

- No package may depend on another package except through `@plankton/domain` types (with the single exception of `family-rules -> config`).
- No package may depend on any app.
- `@plankton/db` must NOT depend on `@plankton/exchange` or vice versa.
- `@plankton/event-bus` must NOT depend on `@plankton/db` or `@plankton/exchange`.
- `@plankton/domain` must have ZERO workspace dependencies. It is the leaf.
- `apps/web` must NOT depend on `@plankton/db` or `@plankton/exchange` (it talks to `apps/api` over HTTP).
- `apps/api` must NOT depend on `@plankton/exchange` (it does not talk to the exchange).

### Enforcement

These rules should be enforced by workspace `package.json` dependencies. If a package does not list a workspace dep, it cannot import it. TypeScript project references (`tsconfig.json` `references` array) must mirror the same graph.

---

## 4. Package vs Runtime-Internal Module Clarification

The architecture defines ~10 runtime "modules." Some are packages, some are internal to `apps/runtime`. The split:

### Extracted as Shared Packages

These are packages because they are either (a) needed by multiple apps, or (b) have a clear independent responsibility worth isolating:

| Module from arch_tmp.md | Package                  |
| ----------------------- | ------------------------ |
| Event bus               | `@plankton/event-bus`    |
| Persistence             | `@plankton/db`           |
| Exchange gateway        | `@plankton/exchange`     |
| Family rules engine     | `@plankton/family-rules` |
| Config loading          | `@plankton/config`       |
| Shared domain model     | `@plankton/domain`       |

### Internal to `apps/runtime`

These live as modules inside `apps/runtime/src/modules/` (or similar). They are NOT separate packages because they are only used by the runtime process and have tight coupling to the runtime lifecycle:

| Module                 | Location                                   | Why internal                                                         |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| Market data            | `apps/runtime/src/modules/market-data/`    | Runtime-only concern. Lifecycle tied to supervisor.                  |
| Normalization          | `apps/runtime/src/modules/normalization/`  | Tightly coupled to market data ingest. Could merge with market-data. |
| Strategy / Scanner     | `apps/runtime/src/modules/strategy/`       | Runtime-only. Consumes events, produces signals.                     |
| Risk + Inventory       | `apps/runtime/src/modules/risk-inventory/` | Runtime-only. Central bounded context.                               |
| Execution engine       | `apps/runtime/src/modules/execution/`      | Runtime-only. Sole order actor.                                      |
| Reconciliation         | `apps/runtime/src/modules/reconciliation/` | Runtime-only. Periodic + startup job.                                |
| Supervisor / Lifecycle | `apps/runtime/src/modules/supervisor/`     | Runtime-only. Owns startup/shutdown sequences.                       |
| Rate limiter           | `apps/runtime/src/modules/rate-limiter/`   | Runtime-only utility. Could move to a package later if api needs it. |

### Why this split

- Internal modules communicate through the event bus and through injected repository/gateway interfaces.
- They do NOT export anything consumed outside `apps/runtime`.
- If a module is later needed by `apps/api` (e.g., risk state queries), the correct path is: api reads from the DB via `@plankton/db` repositories, not by importing runtime modules.

---

## 5. Boundary Rules

### What CAN cross package boundaries

- **Types and interfaces** defined in `@plankton/domain` (the entire point of the package).
- **Event and command type definitions** (from `@plankton/domain`).
- **Repository interfaces** (defined in `@plankton/domain`, implemented in `@plankton/db`).
- **Gateway interfaces** (defined in `@plankton/domain`, implemented in `@plankton/exchange`).
- **Validated config objects** (from `@plankton/config`).
- **Family rule data** (from `@plankton/family-rules`, as typed objects).

### What CANNOT cross package boundaries

- **Implementation classes.** Consumers depend on interfaces, not concrete implementations. `apps/runtime` wires implementations at startup.
- **DB connections or SQLite handles.** Only `@plankton/db` touches the database driver. Repositories are the boundary.
- **Exchange SDK types or clients.** Only `@plankton/exchange` imports `@polymarket/clob-client`. The rest of the system sees `ExchangeGateway`.
- **Internal module state.** Runtime modules (strategy, risk, execution) do not expose mutable state to other packages. They communicate through events and repositories.
- **Node.js process-level concerns** (timers, intervals, signal handlers). These stay in `apps/runtime/src/modules/supervisor/`.

### Practical test

If you are about to import from `@plankton/db` and the import is not a repository interface instantiation at the composition root, something is wrong. If you are about to import from `@plankton/exchange` and you are not in `apps/runtime`'s composition root, something is wrong.

---

## 6. Key Interfaces That Must Be Designed First

These are the contracts that gate all downstream implementation. They live in `@plankton/domain` (or in the package that owns the contract). Design these before writing any business logic.

### Tier 1: Gate everything

| #   | Interface               | Package            | Why it gates                                                                                                                                                |
| --- | ----------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ExchangeGateway`       | `@plankton/domain` | Execution, reconciliation, market data, and simulation all depend on this. Defines `placeOrder`, `cancelOrder`, `getOpenOrders`, `getFills`, `getBalances`. |
| 2   | `EventBus`              | `@plankton/domain` | Every module communicates through this. Defines `publish<T>`, `subscribe<T>`, event type registry.                                                          |
| 3   | `OrderRepository`       | `@plankton/domain` | Execution and reconciliation persist through this. Defines `save`, `findById`, `findOpen`, `updateStatus`.                                                  |
| 4   | `PositionRepository`    | `@plankton/domain` | Risk/inventory and reconciliation depend on this. Defines `save`, `findByFamily`, `findOpen`, `findDust`.                                                   |
| 5   | `FamilyStateRepository` | `@plankton/domain` | Risk/inventory reads and writes runtime family state. Defines `get`, `save`, `findQuarantined`, `findByMode`.                                               |

### Tier 2: Gate domain modules

| #   | Interface             | Package            | Why it gates                                                                                                                                                             |
| --- | --------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6   | `FamilyRulesProvider` | `@plankton/domain` | Strategy, risk, and execution all need family rules. Defines `getRule(familyId)`, `isEnabled(familyId)`, `getLimits(familyId)`. Implemented by `@plankton/family-rules`. |
| 7   | `RiskGate`            | `@plankton/domain` | Strategy produces signals; risk approves or rejects. Defines `evaluate(signal): RiskDecision`.                                                                           |
| 8   | `MarketRepository`    | `@plankton/domain` | Normalization writes, strategy reads. Defines `save`, `findActive`, `findByFamily`.                                                                                      |

### Tier 3: Gate runtime lifecycle

| #   | Interface        | Package            | Why it gates                                                                                                                        |
| --- | ---------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 9   | `RuntimeModule`  | `@plankton/domain` | Supervisor needs a uniform lifecycle contract. Defines `start()`, `stop()`, `healthCheck()`. Every internal module implements this. |
| 10  | `FillRepository` | `@plankton/domain` | Reconciliation and P&L depend on this. Defines `save`, `findByOrder`, `findRecent`, `findUnreconciled`.                             |

### Design order recommendation

1. Start with `ExchangeGateway` and the event type registry (they constrain everything).
2. Then `OrderRepository`, `FillRepository`, `PositionRepository`, `FamilyStateRepository`, `MarketRepository` (they define the persistence shape).
3. Then `EventBus` interface, `FamilyRulesProvider`, `RiskGate`, `RuntimeModule` (they define the wiring).

All 10 interfaces should be designed and reviewed before any module writes its first line of business logic. They are the API surface that makes the system composable and testable.

---

## Summary

- **6 packages** under `packages/`, all flowing through `@plankton/domain` as the dependency root.
- **8 internal modules** inside `apps/runtime`, communicating through the event bus and repository interfaces.
- **3 apps**: runtime (must-have), api (v1 optional), web (v1 optional).
- **10 critical interfaces** in `@plankton/domain` that must be designed before implementation begins.
- **Strict dependency direction**: domain is the leaf, packages depend only on domain (+ config for family-rules), apps depend on packages, nothing points upward.
