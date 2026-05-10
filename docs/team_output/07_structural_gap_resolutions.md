# 07 Structural Gap Resolutions

Date: 2026-03-13
Status: Pre-implementation fix
Input: Review findings on 00-06 team outputs

---

## Finding 1: Domain types diverge between runtime and persistence

### Problem

Runtime document (03) models entities through `tokenId` (Polymarket CLOB token ID) and `size` (share quantity):

```typescript
// 03_runtime_flows.md
interface NormalizedMarket { tokenId: TokenId; ... }
interface Signal { tokenId: TokenId; suggestedSize: number; ... }
interface Position { tokenId: TokenId; size: number; ... }
```

Persistence document (04) models through `market_id` (opaque string) and `size_usdc` (dollar value):

```typescript
// 04_domain_persistence.md
interface Market { market_id: MarketId; /* no token_id */ }
interface Signal { market_id: MarketId; size_usdc: number; ... }
interface Order { market_id: MarketId; size: number; size_usdc: number; ... }
```

The `markets` table has no `token_id` column at all. These cannot implement against a single `@krabs/domain`.

### Root cause

Polymarket's CLOB uses two different identifiers:

- **condition_id** — identifies the market/question
- **token_id** — identifies a specific outcome token (YES or NO side); this is what the order API requires

The persistence doc used `market_id` as an opaque alias for one of these but didn't decide which. The runtime doc correctly used `tokenId` for execution but didn't propagate it to the market entity.

### Resolution

**One canonical Market type with both identifiers:**

```typescript
export interface Market {
  conditionId: string; // Polymarket condition ID (identifies the question)
  tokenId: string; // Polymarket CLOB token ID (identifies YES/NO outcome)
  slug: string;
  question: string;
  outcome: "YES" | "NO";
  familyId: FamilyId | null;
  familyKey: string | null;
  regime: Regime | null;
  horizon: string | null;
  endDate: string | null; // ISO timestamp
  active: boolean;
  tickSize: number; // minimum price increment (from CLOB)
  negRisk: boolean; // neg-risk flag (required for order signing)
  createdAt: string;
  updatedAt: string;
}
```

**Primary key strategy:** Use `tokenId` as the primary key in the `markets` table. Each condition has two tokens (YES/NO), so one Polymarket "market" becomes two rows. This matches how the CLOB API works — orders are placed on a specific token, not on a condition.

**Naming convention:** Use `tokenId` consistently everywhere. Drop `MarketId` branded type — use `TokenId` instead. The `conditionId` field exists on the Market entity for grouping but is never used as a foreign key.

**Size fields:** Use two fields explicitly:

- `size` — share quantity (what the exchange deals in)
- `sizeUsdc` — USDC notional (= size × price, for risk/inventory)

Both exist on Order and Fill. Signal uses `suggestedSize` (shares) and `suggestedSizeUsdc` (notional). Position tracks `size` (shares) and `costBasisUsdc` (notional cost).

**SQL migration fix — `markets` table:**

```sql
CREATE TABLE IF NOT EXISTS markets (
  token_id      TEXT PRIMARY KEY,      -- CLOB token ID, one per outcome
  condition_id  TEXT NOT NULL,          -- groups YES/NO tokens
  slug          TEXT NOT NULL,
  question      TEXT NOT NULL,
  outcome       TEXT NOT NULL,          -- 'YES' | 'NO'
  family_id     TEXT,
  family_key    TEXT,
  regime        TEXT,
  horizon       TEXT,
  end_date      TEXT,
  tick_size     REAL NOT NULL DEFAULT 0.01,
  neg_risk      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_markets_condition ON markets(condition_id);
CREATE INDEX IF NOT EXISTS idx_markets_family_id ON markets(family_id);
CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active);
```

**FK updates:** All tables that currently reference `market_id` should reference `token_id` instead. The column name in orders/fills/positions/inventory_lots changes from `market_id` to `token_id`.

### Files to update

- `04_domain_persistence.md`: Market type, Signal type, Order type, all repository interfaces, SQL schema
- `03_runtime_flows.md`: Already uses tokenId — keep but align naming convention
- `00_synthesis_implementation_package.md`: Note in key interfaces section

---

## Finding 2: ExchangeGateway missing market catalog and order parameters

### Problem

ExchangeGateway only covers order lifecycle (place/cancel/getOrders/getFills/getBalances). It doesn't expose:

- Market catalog (list active markets, get market details including tokenId/conditionId)
- Top-of-book / order book data for pricing
- `tickSize` and `negRisk` per market (required by CLOB order signing)

Polymarket's `@polymarket/clob-client` requires `tickSize` and `negRisk` as parameters for `createOrder()`. Without these in the gateway interface, the execution engine can't construct valid orders.

### Resolution

**Split into two gateway interfaces:**

```typescript
/**
 * Market data gateway — read-only access to market catalog and pricing.
 * Used by market-data module and normalization.
 */
export interface MarketDataGateway {
  /** Fetch all active markets from CLOB. */
  getMarkets(): Promise<ClobMarket[]>;

  /** Fetch a specific market by condition ID. */
  getMarket(conditionId: string): Promise<ClobMarket | null>;

  /** Fetch current order book / top-of-book for a token. */
  getOrderBook(tokenId: string): Promise<OrderBookSnapshot>;

  /** Fetch tick size for a token (needed for order construction). */
  getTickSize(tokenId: string): Promise<number>;

  /** Lightweight health check. */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}

export interface ClobMarket {
  conditionId: string;
  tokens: Array<{
    tokenId: string;
    outcome: string; // "Yes" | "No"
  }>;
  question: string;
  slug: string;
  endDate: string;
  active: boolean;
  negRisk: boolean;
  tickSize: number; // minimum price increment
}

export interface OrderBookSnapshot {
  tokenId: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  timestamp: number;
}

/**
 * Execution gateway — order lifecycle operations.
 * Used by execution engine and reconciliation.
 */
export interface ExchangeGateway {
  /** Place a limit order. Requires tickSize and negRisk. */
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult>;
  cancelOrder(params: CancelOrderParams): Promise<CancelOrderResult>;
  cancelAllOrders(): Promise<CancelOrderResult>;
  getOpenOrders(): Promise<ExchangeOrder[]>;
  getOpenOrdersForToken(tokenId: string): Promise<ExchangeOrder[]>;
  getFills(sinceMs: number): Promise<ExchangeFill[]>;
  getBalances(): Promise<ExchangeBalance[]>;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}

export interface PlaceOrderParams {
  clientOrderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  size: number; // share quantity
  price: number; // limit price (0-1 for binary)
  orderType: "GTC" | "GTD" | "FOK";
  tickSize: number; // MUST be passed; comes from market catalog
  negRisk: boolean; // MUST be passed; comes from market catalog
  expiration?: number;
}
```

**Why two interfaces, not one:** Market data and execution have different consumers, different rate limit characteristics, and will be called at different frequencies. Keeping them separate makes the dependency graph cleaner: market-data module depends on `MarketDataGateway`, execution depends on `ExchangeGateway`. Both are implemented by the same CLOB client wrapper internally, but consumers don't need to know that.

**Implementation:** `LiveClobClient` wraps `@polymarket/clob-client` and implements both interfaces. `SimulationClobClient` provides in-memory implementations of both.

**Execution engine gets tickSize and negRisk from the normalized market record** (which was populated by market-data via MarketDataGateway). The execution engine never calls MarketDataGateway directly — it receives these values through the PlaceOrderCommand or through a repository lookup.

### Files to update

- `03_runtime_flows.md`: Split ExchangeGateway, add MarketDataGateway, update PlaceOrderParams
- `04_domain_persistence.md`: Add tickSize/negRisk to Market type and markets table
- `01_architect_package_map.md`: Note that @krabs/exchange implements two interfaces

---

## Finding 3: Deterministic client_order_id collides on multi-buy legs

### Problem

Current hash: `familyId|marketTokenId|side|intentEpochMs`

If the strategy scanner emits two BUY signals for the same token in the same tick (e.g., two scale-in steps), both produce identical client_order_id. The execution engine's dedup logic would then drop the second buy, directly violating HR6 (2-3 buys) and HR7 (heavy campaigns).

### Resolution

**Add a sequence number to the hash input:**

```typescript
export function buildClientOrderId(parts: {
  familyId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  intentEpochMs: number;
  sequenceInTick: number; // 0-based index within this tick for same family+token+side
}): string {
  const raw = [
    parts.familyId,
    parts.tokenId,
    parts.side,
    parts.intentEpochMs,
    parts.sequenceInTick,
  ].join("|");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `plk_${hash}`;
}
```

**Where does `sequenceInTick` come from?**

The strategy scanner assigns it. When the scanner produces multiple signals for the same token in one tick, it increments the sequence counter:

```typescript
// Inside scanner loop for one tick
const signalsThisTick = new Map<string, number>(); // key -> count

function nextSequence(familyId: string, tokenId: string, side: string): number {
  const key = `${familyId}|${tokenId}|${side}`;
  const seq = signalsThisTick.get(key) ?? 0;
  signalsThisTick.set(key, seq + 1);
  return seq;
}
```

**Alternative considered and rejected:** Using a UUID instead of deterministic hash. This breaks retry safety — if the process crashes after sending the order but before persisting the result, a retry would place a duplicate order with a new UUID. The deterministic hash plus sequence number preserves retry safety while supporting multi-buy legs.

**The Signal type needs a `sequenceInTick` field:**

```typescript
export interface Signal {
  signalId: string;
  familyId: FamilyId;
  tokenId: string;
  side: "BUY" | "SELL";
  suggestedPrice: number;
  suggestedSize: number;
  suggestedSizeUsdc: number;
  reason: string;
  strategyTick: number; // epoch ms of the scanner tick
  sequenceInTick: number; // 0-based within this tick for same family+token+side
  generatedAt: string;
}
```

### Files to update

- `03_runtime_flows.md`: buildClientOrderId function, Signal type
- `04_domain_persistence.md`: Signal type
- `05_strategy_compliance.md`: Note on scale-in compatibility

---

## Finding 4: operator_commands table missing from persistence schema

### Problem

API document (06) defines `operator_commands` as the v1 communication mechanism between API and runtime — the API inserts pending commands, the runtime polls and applies them. But the persistence document (04) only has `operator_actions` as a post-hoc audit log with no `status` or `applied_at` columns. Without a shared schema and repository for pending commands, the API write-path is unimplemented.

### Resolution

**Keep both tables — they serve different purposes:**

1. `operator_commands` — pending command queue (API writes, runtime reads+updates)
2. `operator_actions` — audit log (runtime writes after applying a command)

**Add `operator_commands` to the SQL schema:**

```sql
-- ═══════════ OPERATOR COMMANDS (pending queue) ═══════════

CREATE TABLE IF NOT EXISTS operator_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,              -- 'pause', 'resume', 'family_reduce_only',
                                          -- 'family_quarantine', 'family_activate'
  target_id   TEXT,                       -- family_id for family-scoped, null for global
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'applied', 'rejected'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_operator_commands_status
  ON operator_commands(status) WHERE status = 'pending';
```

**Add `OperatorCommandRepository` to domain interfaces:**

```typescript
export interface OperatorCommand {
  id: number;
  action: "pause" | "resume" | "family_reduce_only" | "family_quarantine" | "family_activate";
  targetId: string | null;
  reason: string | null;
  status: "pending" | "applied" | "rejected";
  createdAt: string;
  appliedAt: string | null;
}

export interface OperatorCommandRepository {
  /** Insert a new pending command (called by API). */
  insert(cmd: Omit<OperatorCommand, "id" | "status" | "appliedAt">): number;

  /** Get all pending commands (called by runtime poller). */
  getPending(): OperatorCommand[];

  /** Mark a command as applied or rejected (called by runtime after processing). */
  updateStatus(id: number, status: "applied" | "rejected", appliedAt: string): void;
}
```

**Runtime polling loop** (inside supervisor module):

```typescript
// apps/runtime/src/modules/supervisor/command-poller.ts
async function pollOperatorCommands(
  repo: OperatorCommandRepository,
  handler: (cmd: OperatorCommand) => Promise<"applied" | "rejected">,
  intervalMs = 2000,
): Promise<() => void> {
  const timer = setInterval(async () => {
    const pending = repo.getPending();
    for (const cmd of pending) {
      const result = await handler(cmd);
      repo.updateStatus(cmd.id, result, new Date().toISOString());
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
```

**The existing `operator_actions` table stays as-is** — it's the immutable audit trail. After the runtime applies a command, it writes to both: updates `operator_commands.status` and inserts into `operator_actions`.

### Files to update

- `04_domain_persistence.md`: Add operator_commands table, add OperatorCommandRepository
- `03_runtime_flows.md`: Add command poller to supervisor module
- `06_api_web_surface.md`: Reference the shared schema

---

## Finding 5: SQLite file path and .gitignore contradictions

### Problem

Three conflicting statements:

1. `00_synthesis` says `plankton_trades.db` is gitignored in `research/data/`
2. `02_tooling` `.gitignore` explicitly does NOT ignore `*.db` ("because the research SQLite DB is tracked")
3. `.env.example` sets `DB_PATH=./data/krabs.db` (relative to apps/runtime)

Risks:

- If `*.db` is not gitignored, the live runtime DB (which will be at `apps/runtime/data/krabs.db`) gets committed
- Relative path `./data/krabs.db` resolves differently depending on which process's cwd — runtime and API may use different DB files

### Resolution

**A. .gitignore — be explicit about what's ignored:**

```gitignore
# Runtime data (never committed)
apps/runtime/data/

# Research data (too large, regenerate from scripts)
research/data/*.db
research/data/*.db-wal
research/data/*.db-shm
```

Do NOT use a blanket `*.db` rule. The `.gitignore` should name specific paths.

**B. DB_PATH must be absolute at runtime, resolved from a known anchor:**

```typescript
// packages/config/src/schema.ts
import { z } from "zod";
import { resolve } from "node:path";

export const runtimeConfigSchema = z.object({
  dbPath: z.string().transform((p) => resolve(p)),
  // ... other fields
});
```

The `.env` sets a path that gets resolved to absolute at config load time. The `resolve()` call uses `process.cwd()` as the anchor, and both `apps/runtime` and `apps/api` must be launched from the same directory (the monorepo root), or `DB_PATH` must be set as an absolute path.

**C. .env.example — use a monorepo-root-relative path:**

```env
# SQLite database path (relative to monorepo root, resolved to absolute at startup)
DB_PATH=./apps/runtime/data/krabs.db
```

This way both runtime and API resolve to the same file regardless of their own package directory.

**D. API opens DB read-only:**

```typescript
// apps/api/src/db.ts
import Database from "better-sqlite3";

export function openReadonlyDb(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}
```

**E. Create `apps/runtime/data/` directory with a `.gitkeep`:**

```
apps/runtime/data/.gitkeep
```

The data directory is gitignored (rule A), but `.gitkeep` ensures the directory structure exists after clone.

### Files to update

- `02_tooling_scaffold.md`: Fix .gitignore section
- `00_synthesis_implementation_package.md`: Fix .env.example, add DB path note
- `06_api_web_surface.md`: Add read-only DB open example

---

## Summary of all changes

| Finding                       | Resolution                                                                                         | Impact                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1. tokenId vs market_id       | Canonical Market type with both conditionId and tokenId; tokenId is PK; drop MarketId branded type | Domain types, SQL schema, all repos                      |
| 2. ExchangeGateway incomplete | Split into MarketDataGateway + ExchangeGateway; add tickSize/negRisk to PlaceOrderParams           | Gateway interfaces, market-data module, exchange package |
| 3. client_order_id collision  | Add sequenceInTick to hash input and Signal type                                                   | buildClientOrderId, Signal type, scanner                 |
| 4. operator_commands missing  | Add operator_commands table + OperatorCommandRepository; keep operator_actions as audit            | SQL schema, repository interfaces, supervisor            |
| 5. DB path conflicts          | Explicit .gitignore paths; absolute DB_PATH resolved at startup; monorepo-root-relative .env       | .gitignore, config schema, .env.example                  |

### Order of resolution

These should be resolved in domain types first (Finding 1 → 3 → 2 → 4 → 5), since the type changes cascade into everything else. All five should be resolved before Phase 2 implementation begins.
