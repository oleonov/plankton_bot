# V1 Implementation Package — Team Synthesis

Date: 2026-03-13
Status: Ready for review (rev 2 — structural gaps resolved, see 07_structural_gap_resolutions.md)
Sources: 01-07 team output documents, arch_tmp.md, validated_strategy_rulebook.md, family_rules_schema_v1.md, v1_development_plan.md

---

## 1. Final Monorepo Structure

```
poly_plankton/
├── package.json                    # private, pnpm 10.x, turbo scripts
├── pnpm-workspace.yaml             # apps/*, packages/*
├── turbo.json                      # build/test/lint/typecheck/dev tasks
├── tsconfig.base.json              # strict, composite, ESM NodeNext
├── vitest.config.ts                # project-based test config
├── eslint.config.js                # flat config + typescript-eslint
├── .prettierrc
├── .npmrc
├── .node-version                   # 24
├── .env.example
├── .gitignore
│
├── apps/
│   ├── runtime/                    # main trading bot process
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── main.ts             # entry point
│   │       └── modules/
│   │           ├── supervisor/     # startup/shutdown orchestration
│   │           ├── market-data/    # REST polling, snapshot publishing
│   │           ├── normalization/  # raw -> family-classified market
│   │           ├── strategy/       # scanner loop, signal generation
│   │           ├── risk-inventory/ # pre-trade gates, tail health, state
│   │           ├── execution/      # command dedup, gateway dispatch
│   │           ├── reconciliation/ # startup + periodic diff
│   │           └── shared/         # rate-limiter, logger setup
│   │
│   ├── api/                        # REST + SSE for operator dashboard
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── server.ts           # Fastify instance
│   │       ├── routes/             # health, families, positions, orders, fills, metrics, actions
│   │       └── sse/                # event-stream publisher
│   │
│   └── web/                        # operator dashboard (Vite + React)
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── pages/              # Overview, Positions, Orders, Families, Risk
│           └── api/                # client, hooks, SSE consumer
│
├── packages/
│   ├── domain/                     # pure types, enums, events, commands, interfaces
│   ├── config/                     # YAML/env loading + zod validation
│   ├── event-bus/                  # typed in-process pub/sub
│   ├── db/                         # repository implementations (SQLite v1)
│   ├── exchange/                   # ExchangeGateway (Live + Simulation)
│   └── family-rules/              # family config loading + state resolution
│
├── research/                       # Python analysis pipeline (stays as-is)
│   ├── fetch_plankton_trades.py
│   ├── analyze.py / analyze_deep.py / ...
│   ├── data/                       # plankton_trades.db (~158MB, gitignored)
│   └── reports/                    # analysis_report.txt, etc.
│
└── docs/                           # architecture, strategy, schemas
```

---

## 2. Package Responsibility Table

| Package | Responsibility | Workspace deps | External deps |
|---|---|---|---|
| `@plankton/domain` | Pure types, enums, event defs, command defs, repository/gateway interfaces | (none) | (none) |
| `@plankton/config` | YAML + env loading, zod validation | (none) | `zod`, `yaml`, `dotenv` |
| `@plankton/event-bus` | Typed in-process pub/sub with async handlers | `domain` | (none) |
| `@plankton/db` | SQLite repos, migrations, connection management | `domain` | `better-sqlite3` |
| `@plankton/exchange` | ExchangeGateway implementations (Live + Sim) | `domain` | `@polymarket/clob-client` |
| `@plankton/family-rules` | Family YAML loading, validation, resolution | `domain`, `config` | (none) |
| `apps/runtime` | Trading bot: supervisor, all internal modules | all packages | `pino` |
| `apps/api` | REST + SSE server, operator actions | `domain`, `db`, `config` | `fastify` |
| `apps/web` | React SPA dashboard | `domain` | `react`, `react-router`, `@tanstack/react-query` |

### Dependency Direction (strictly enforced)

```
@plankton/domain          ← leaf, zero deps
    ↑
    ├── @plankton/config
    ├── @plankton/event-bus
    ├── @plankton/db
    ├── @plankton/exchange
    └── @plankton/family-rules ← also depends on config
         ↑
    apps/runtime  ← depends on all packages
    apps/api      ← depends on domain, db, config
    apps/web      ← depends on domain only
```

**Forbidden**: packages depending on apps, db↔exchange cross-deps, web importing db/exchange.

---

## 3. Key Interfaces (must design first)

These 12 interfaces in `@plankton/domain` gate all implementation. Design before writing business logic.

| # | Interface | Why critical |
|---|---|---|
| 1 | `ExchangeGateway` | Execution + reconciliation: placeOrder (with tickSize/negRisk), cancelOrder, getOpenOrders, getFills, getBalances |
| 2 | `MarketDataGateway` | Market-data module: getMarkets, getOrderBook, getTickSize. **Separate from ExchangeGateway** (see 07_structural_gap_resolutions.md F2) |
| 3 | `EventBus` | Every module communicates through this |
| 4 | `OrderRepository` | Execution + reconciliation persistence |
| 5 | `PositionRepository` | Risk/inventory + reconciliation |
| 6 | `FamilyStateRepository` | Risk/inventory reads/writes runtime family state |
| 7 | `FamilyRulesProvider` | Strategy, risk, execution need family rules |
| 8 | `RiskGate` | Strategy→Risk approval boundary |
| 9 | `MarketRepository` | Normalization writes, strategy reads. **PK is tokenId, not market_id** (see F1) |
| 10 | `RuntimeModule` | Supervisor lifecycle contract (start/stop/healthCheck) |
| 11 | `FillRepository` | Reconciliation + P&L computation |
| 12 | `OperatorCommandRepository` | API→runtime command queue (see F4) |

**Critical naming decision (F1):** The primary market identifier is `tokenId` (Polymarket CLOB token ID), not `market_id`. Each Polymarket condition has two tokens (YES/NO). `conditionId` groups them but is not the FK. See `07_structural_gap_resolutions.md` Finding 1.

---

## 4. Phase 1-3 Implementation Backlog

### Phase 1: Bootstrap Monorepo (this week, 2-3 days)

| # | Task | Owner | Acceptance |
|---|---|---|---|
| 1.1 | Move Python files to `research/`, create `research/data/`, `research/reports/` | Tooling | All Python scripts accessible from new paths |
| 1.2 | Create root configs: package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json, vitest.config.ts, eslint.config.js, .prettierrc, .npmrc, .node-version, .gitignore, .env.example | Tooling | Files match 02_tooling_scaffold.md spec |
| 1.3 | Create all package directories + package.json + tsconfig.json | Tooling | Per spec in 02_tooling_scaffold.md Section 3 |
| 1.4 | Create placeholder `src/index.ts` in every package/app | Tooling | Minimal exports, no business logic |
| 1.5 | apps/runtime imports type from @plankton/domain | Tooling | Proves cross-package resolution |
| 1.6 | `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test` all pass | Tooling | Green across all packages |

**Critical fixes vs existing Phase 1 spec:**
- Add `composite: true` to tsconfig.base.json
- Remove `outDir`/`rootDir` from base tsconfig (per-package only)
- Add `dependsOn: ["^build"]` to `typecheck` and `test` in turbo.json
- Add `@types/better-sqlite3` to `@plankton/db` devDeps
- Add `isolatedModules: true`, `verbatimModuleSyntax: true` to base tsconfig

### Phase 2: Domain Contracts (this week, 2-3 days)

| # | Task | Owner | Acceptance |
|---|---|---|---|
| 2.1 | Define all enums in `packages/domain/src/enums.ts` | Domain | 15 enum types per 04_domain_persistence.md |
| 2.2 | Define all domain types in `packages/domain/src/types.ts` | Domain | Market, FamilyIdentity, FamilyEvidence, FamilyRules (all sub-blocks), FamilyState, Signal, RiskDecision, Order, Fill, Position, InventoryLot, OperatorAction |
| 2.3 | Define events + commands in `packages/domain/src/events.ts` | Domain | DomainEvent union, DomainCommand union |
| 2.4 | Define repository interfaces in `packages/domain/src/repositories.ts` | Domain | MarketRepository, OrderRepository, FillRepository, PositionRepository, FamilyRulesRepository, FamilyStateRepository |
| 2.5 | Define ExchangeGateway interface in `packages/domain/src/gateway.ts` | Runtime | Per 03_runtime_flows.md Section 4 |
| 2.6 | Define EventBus interface in `packages/domain/src/bus.ts` | Runtime | Typed publish/subscribe with RuntimeEventMap |
| 2.7 | Define RuntimeModule interface | Runtime | start(), stop(), healthCheck() |
| 2.8 | Define RiskGate interface | Strategy | evaluate(signal): RiskDecision |
| 2.9 | Barrel export from `packages/domain/src/index.ts` | Domain | All types importable via `@plankton/domain` |
| 2.10 | Unit tests for branded ID helpers, enum validation | Domain | Tests pass |

### Phase 3: Config + Family Rules + Event Bus (next week, 3-4 days)

| # | Task | Owner | Acceptance |
|---|---|---|---|
| 3.1 | Implement zod schemas for family rules YAML in `packages/config` | Domain | Validates against family_rules_template_v1.yaml |
| 3.2 | Implement YAML loader in `packages/config/src/loader.ts` | Domain | Loads + validates family YAML |
| 3.3 | Implement env loader in `packages/config/src/env.ts` | Tooling | dotenv + zod validation of env vars |
| 3.4 | Implement family rules resolver in `packages/family-rules` | Domain | `family_key:regime:horizon` → FamilyRule |
| 3.5 | Implement family state resolution (probe/scaled/reduce-only/quarantine) | Domain | State enum works, transitions match 05_strategy_compliance.md |
| 3.6 | Implement FamilyRulesProvider interface | Domain | getRule(), isEnabled(), getLimits() |
| 3.7 | Implement typed EventBus in `packages/event-bus` | Runtime | publish/subscribe with RuntimeEventMap, async handlers, drain() |
| 3.8 | Unit tests for config loading, family rules resolution, event bus | All | Tests pass for each package |

---

## 5. Identified Risks and Blockers

### Blockers (must resolve before Phase 3+)

| # | Issue | Impact | Resolution |
|---|---|---|---|
| B1 | **Leg/campaign not modeled** — HR6/HR7 require tracking buy count per leg, but "leg" is not a domain concept yet | Can't enforce scale-in caps | Define Leg as first-class domain type: sequence of related buys on one side of one market, terminated by full exit |
| B2 | **FIFO cost-basis not specified** — HR11 says "realized_pnl_fifo" but architecture doesn't mandate FIFO as the cost method | Wrong health scores | Add InventoryLot type (done in 04), mandate FIFO in persistence |
| B3 | **Family-to-market mapping heuristic undefined** — HR1 requires every market mapped to family, but no classification rules exist yet | Can't normalize markets | Define regime classification rules in config; unmapped markets default to `action=monitor` |

### Structural gaps (resolved in 07_structural_gap_resolutions.md)

| # | Gap | Resolution |
|---|---|---|
| F1 | **tokenId vs market_id divergence** — runtime and persistence use incompatible identifiers | Canonical Market type with both `conditionId` and `tokenId`; `tokenId` is PK everywhere; drop `MarketId` branded type |
| F2 | **ExchangeGateway missing market catalog** — no tickSize, negRisk, top-of-book | Split into `MarketDataGateway` (market catalog, pricing) + `ExchangeGateway` (order lifecycle); add tickSize/negRisk to PlaceOrderParams |
| F3 | **client_order_id collision on multi-buy** — same hash for two buys in one tick | Add `sequenceInTick` to hash input and Signal type |
| F4 | **operator_commands table missing** — API write-path has no persistence schema | Add `operator_commands` table + `OperatorCommandRepository`; keep `operator_actions` as audit log |
| F5 | **DB path and .gitignore contradictions** — risk of committing live DB, path mismatch between runtime and API | Explicit .gitignore per directory; DB_PATH resolved to absolute at startup; monorepo-root-relative .env |

### Risks (can proceed but need attention)

| # | Risk | Mitigation |
|---|---|---|
| R1 | Polymarket CLOB JS SDK (`@polymarket/clob-client`) maturity unknown for v1 needs | Build SimulationGateway first; defer LiveGateway until SDK verified |
| R2 | SQLite concurrent access (runtime writer + API reader) | WAL mode + read-only API connection; documented in 06_api_web_surface.md |
| R3 | No dust-pruning mechanism yet | Risk module can generate force-sell signals; implement as background task |
| R4 | Promotion criteria not formally defined | Semi-automatic in v1: system computes metrics, operator approves |
| R5 | Session enforcement boundary unclear | Strategy reduces signal rate outside window; Risk enforces as hard gate |

---

## 6. What to Implement First This Week

**Recommended order for the first 5 working days:**

### Day 1-2: Phase 1 (Bootstrap)
1. Move Python files to `research/`
2. Create all root configs (including fixed .gitignore per F5)
3. Create all package scaffolds
4. Verify `pnpm build && pnpm typecheck && pnpm lint && pnpm test` all green

### Day 3-4: Phase 2 (Domain Contracts)
1. Write all enums
2. Write all domain types — **using resolved naming from F1**: `tokenId` as PK, both `size` and `sizeUsdc` on orders/fills
3. Write all event/command types — **Signal includes `sequenceInTick` per F3**
4. Write gateway interfaces — **split MarketDataGateway + ExchangeGateway per F2, PlaceOrderParams includes tickSize/negRisk**
5. Write repository interfaces — **includes OperatorCommandRepository per F4**
6. Barrel export everything

### Day 5: Phase 3 Start (Config + Family Rules)
1. Implement zod schemas for family rules YAML
2. Implement YAML loader + env loader (DB_PATH resolved to absolute per F5)
3. Start family rules resolver
4. Start event bus implementation

**Why this order:** Domain types gate everything. Structural gaps F1-F5 must be baked into the types from day one — retrofitting incompatible identifiers is much harder than getting them right upfront.

---

## 7. Team Consensus Summary

All 6 team roles converged on the following:

| Decision | Status |
|---|---|
| 6 packages + 3 apps + research/ | **Agreed** |
| @plankton/domain as zero-dep leaf | **Agreed** |
| Internal modules inside apps/runtime (not packages) | **Agreed** |
| 12 critical interfaces in domain (updated from 10 after F2/F4) | **Agreed** |
| tokenId as primary market identifier (F1 resolution) | **Agreed** |
| Split MarketDataGateway + ExchangeGateway (F2 resolution) | **Agreed** |
| Pino for logging, YAML for config, dotenv for env | **Agreed** |
| Fastify for API, Vite+React for web | **Agreed** |
| SSE over WebSocket for v1 live updates | **Agreed** |
| Static API key auth for v1 | **Agreed** |
| Operator commands via SQLite command table + OperatorCommandRepository | **Agreed** |
| family_summary SQL view for API reads | **Agreed** |
| Phase 1→2→3 implementation order | **Agreed** |
| Leg/campaign needs to become a domain concept | **Agreed** (identified as blocker B1) |

### Open question (non-blocking)

- Should `risk + inventory` split into two modules later if complexity grows? → **Defer decision. One bounded context for v1.**

---

## Detailed Team Outputs (reference)

| Document | Content |
|---|---|
| `01_architect_package_map.md` | Package boundaries, dependency graph, boundary rules, 10 key interfaces |
| `02_tooling_scaffold.md` | Root configs, per-package templates, build pipeline, dev workflow, deps audit, migration plan |
| `03_runtime_flows.md` | Module layout, event flow, command pipeline, ExchangeGateway/Execution/Reconciliation interfaces, startup/shutdown, rate limiter |
| `04_domain_persistence.md` | All enums, types, events, commands, repository interfaces, SQLite schema, family rules loading |
| `05_strategy_compliance.md` | HR1-HR14 → module mapping, risk engine requirements, strategy requirements, family state machine, compliance checklist, 7 gaps |
| `06_api_web_surface.md` | 16 REST endpoints, operator actions, SSE design, auth, 5 dashboard pages, API↔runtime communication |
| `07_structural_gap_resolutions.md` | 5 structural conflicts found in review: tokenId/market_id divergence, ExchangeGateway gaps, client_order_id collision, operator_commands missing, DB path contradictions. Concrete resolutions with code. |
