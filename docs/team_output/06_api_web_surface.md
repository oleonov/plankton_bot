# API and Web Surface Design v1

Date: 2026-03-13

## 1. API Endpoint Catalog

Base path: `/api/v1`

All responses follow a uniform envelope:

```json
{
  "ok": true,
  "data": { ... },
  "error": null,
  "ts": "2026-03-13T14:00:00.000Z"
}
```

Error responses:

```json
{
  "ok": false,
  "data": null,
  "error": { "code": "FAMILY_NOT_FOUND", "message": "..." },
  "ts": "2026-03-13T14:00:00.000Z"
}
```

### 1.1 Health and Status

| Method | Path      | Description                                                                                                                                                             |
| ------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health` | Liveness probe. Returns `{ "status": "ok" }`. No auth required.                                                                                                         |
| GET    | `/status` | Bot runtime status: mode, uptime, last reconciliation, market data freshness, open order count, active family count, current runtime mode (simulation/paper/live-lite). |

`GET /status` response shape:

```json
{
  "runtime_mode": "live-lite",
  "uptime_seconds": 84201,
  "paused": false,
  "last_reconciliation_at": "2026-03-13T13:45:00Z",
  "market_data_stale": false,
  "market_data_last_update_at": "2026-03-13T13:59:58Z",
  "active_family_count": 28,
  "open_order_count": 12,
  "open_position_count": 41,
  "total_open_value_usdc": 1284.5,
  "total_tail_cost_usdc": 87.3
}
```

### 1.2 Families

| Method | Path                            | Description                                                                             |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| GET    | `/families`                     | List all families with runtime state. Supports `?state=probe,scaled,quarantine` filter. |
| GET    | `/families/:familyId`           | Single family detail: identity, evidence, rules, runtime state.                         |
| GET    | `/families/:familyId/positions` | Positions belonging to a specific family.                                               |
| GET    | `/families/:familyId/orders`    | Orders belonging to a specific family.                                                  |

`GET /families` response shape (array):

```json
{
  "family_id": "bitcoin-above:threshold:daily",
  "family_key": "bitcoin-above",
  "regime": "threshold",
  "horizon": "daily",
  "strategy_profile": "scalp",
  "promotion_state": "scaled",
  "runtime_mode": "active",
  "enabled": true,
  "action": "trade",
  "open_value_usdc": 42.5,
  "open_position_count": 3,
  "open_dust_count": 1,
  "current_tail_cost_usdc": 8.2,
  "tail_adjusted_pnl_live": 690.31,
  "active_market_count": 4,
  "max_open_value_usdc": 75.0,
  "max_active_markets": 10,
  "max_dust_positions": 3,
  "quarantine_reason": null
}
```

`GET /families/:familyId` adds identity, evidence, and full rules layers to the above.

### 1.3 Positions

| Method | Path                     | Description                                                                  |
| ------ | ------------------------ | ---------------------------------------------------------------------------- |
| GET    | `/positions`             | All open positions. Supports `?family_id=`, `?dust=true`, `?sort=tail_cost`. |
| GET    | `/positions/:positionId` | Single position detail with lot-level inventory.                             |

Position shape:

```json
{
  "position_id": "pos_abc123",
  "family_id": "bitcoin-above:threshold:daily",
  "market_id": "0xabc...",
  "market_title": "Bitcoin above 100k on March 14?",
  "side": "YES",
  "size": 150,
  "avg_entry_price": 0.08,
  "current_price": 0.12,
  "notional_usdc": 12.0,
  "unrealized_pnl_usdc": 6.0,
  "is_dust": false,
  "buy_count": 2,
  "opened_at": "2026-03-12T16:30:00Z",
  "last_fill_at": "2026-03-12T18:00:00Z"
}
```

### 1.4 Orders

| Method | Path               | Description                                                                                  |
| ------ | ------------------ | -------------------------------------------------------------------------------------------- |
| GET    | `/orders`          | Orders list. Supports `?status=open,filled,cancelled`, `?family_id=`, `?limit=`, `?cursor=`. |
| GET    | `/orders/:orderId` | Single order detail.                                                                         |

Order shape:

```json
{
  "order_id": "ord_def456",
  "client_order_id": "co_xyz789",
  "family_id": "bitcoin-above:threshold:daily",
  "market_id": "0xabc...",
  "side": "BUY",
  "price": 0.07,
  "size": 100,
  "filled_size": 0,
  "status": "open",
  "created_at": "2026-03-13T14:01:00Z",
  "updated_at": "2026-03-13T14:01:00Z"
}
```

### 1.5 Fills

| Method | Path     | Description                                                             |
| ------ | -------- | ----------------------------------------------------------------------- |
| GET    | `/fills` | Recent fills. Supports `?family_id=`, `?limit=`, `?cursor=`, `?since=`. |

Fill shape:

```json
{
  "fill_id": "fill_ghi012",
  "order_id": "ord_def456",
  "family_id": "bitcoin-above:threshold:daily",
  "market_id": "0xabc...",
  "side": "BUY",
  "price": 0.07,
  "size": 100,
  "fee_usdc": 0.014,
  "filled_at": "2026-03-13T14:02:00Z"
}
```

### 1.6 Metrics

| Method | Path                | Description                                                                                                                      |
| ------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/metrics`          | Aggregate runtime metrics: total realized PnL, total tail cost, family health distribution, fill count today, order count today. |
| GET    | `/metrics/families` | Per-family metric summary: realized PnL, tail cost, position count, dust count.                                                  |

`GET /metrics` response shape:

```json
{
  "total_realized_pnl_usdc": 4280.5,
  "total_open_tail_cost_usdc": 312.4,
  "total_tail_adjusted_pnl_usdc": 3968.1,
  "total_open_value_usdc": 1284.5,
  "fills_today": 34,
  "orders_today": 52,
  "families_active": 28,
  "families_quarantined": 3,
  "families_reduce_only": 5
}
```

### 1.7 Risk Events

| Method | Path           | Description                                                                                                             |
| ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/risk-events` | Recent risk events: rejections, quarantine triggers, threshold breaches. Supports `?family_id=`, `?limit=`, `?cursor=`. |

Risk event shape:

```json
{
  "event_id": "rev_jkl345",
  "type": "entry_rejected",
  "family_id": "elon-musk-of-tweets:social-activity:weekly-window",
  "reason": "max_dust_positions_exceeded",
  "details": { "current": 3, "limit": 3 },
  "occurred_at": "2026-03-13T14:05:00Z"
}
```

### 1.8 Reconciliation

| Method | Path              | Description                                                               |
| ------ | ----------------- | ------------------------------------------------------------------------- |
| GET    | `/reconciliation` | Last reconciliation result: timestamp, mismatches found, repairs applied. |

---

## 2. Operator Actions API

All operator actions are POST requests. They mutate runtime state.

| Method | Path                                    | Description                                                                                              |
| ------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| POST   | `/actions/pause`                        | Pause the bot. Stops new scanning and signal generation. Open orders remain unless explicitly cancelled. |
| POST   | `/actions/resume`                       | Resume the bot from paused state.                                                                        |
| POST   | `/actions/family/:familyId/reduce-only` | Set a family to `reduce-only` mode. No new entries; exits allowed.                                       |
| POST   | `/actions/family/:familyId/quarantine`  | Quarantine a family. No entries, no exits. All open orders in family are cancelled.                      |
| POST   | `/actions/family/:familyId/activate`    | Remove `reduce-only` or `quarantine` override, return family to its configured runtime mode.             |

### Request/response shapes

`POST /actions/pause`

Request body: none required.

```json
{ "reason": "manual operator pause" }
```

Response:

```json
{ "ok": true, "data": { "paused": true, "paused_at": "2026-03-13T14:10:00Z" } }
```

`POST /actions/family/:familyId/reduce-only`

```json
{ "reason": "tail cost growing too fast" }
```

Response:

```json
{
  "ok": true,
  "data": {
    "family_id": "elon-musk-of-tweets:social-activity:weekly-window",
    "previous_mode": "active",
    "current_mode": "reduce-only",
    "reason": "tail cost growing too fast",
    "applied_at": "2026-03-13T14:12:00Z"
  }
}
```

`POST /actions/family/:familyId/quarantine`

```json
{ "reason": "suspected market anomaly" }
```

Response: same shape as reduce-only, with `current_mode: "quarantine"`.

`POST /actions/family/:familyId/activate`

Request body: none required.

Response: same shape, with `current_mode` restored to configured default.

### Communication mechanism

Operator actions do NOT go through the API's own SQLite writes. The API sends commands to the runtime process. In v1 there are two viable patterns:

1. **Shared SQLite with command table** (recommended for v1). The API inserts a row into an `operator_commands` table. The runtime polls this table on a short interval (1-2 seconds) and processes pending commands. Simple, no IPC needed, fits single-machine v1 topology.

2. **Direct IPC** (alternative). If runtime and API run in the same Node.js process, the API module can call runtime methods directly through an injected interface.

Recommended for v1: option 1 (command table). It keeps API and runtime decoupled and works regardless of whether they run in the same or separate processes.

`operator_commands` table schema:

```sql
CREATE TABLE operator_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,       -- 'pause', 'resume', 'family_reduce_only', 'family_quarantine', 'family_activate'
  target_id   TEXT,                -- family_id for family-scoped actions, null for global
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'applied', 'rejected'
  created_at  TEXT NOT NULL,
  applied_at  TEXT
);
```

---

## 3. Live Updates Design

### Recommendation: SSE (Server-Sent Events) for v1

Rationale:

- SSE is simpler to implement than WebSocket in both server and client.
- The data flow is unidirectional: server pushes updates to dashboard. The dashboard sends commands via REST POST, not through the event stream.
- SSE works over standard HTTP, passes through proxies and load balancers without issues.
- SSE supports automatic reconnection natively in browsers.
- WebSocket adds complexity (heartbeat, reconnection logic, binary framing) that is unnecessary for an operator dashboard with a single user.

### SSE endpoint

`GET /events`

Supports query parameter `?types=status,position,order,fill,family,risk` to filter event types.

### Event types

| Event type             | Trigger                                                          | Payload                               |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `status`               | Bot pause/resume, mode change, reconciliation complete           | Same shape as `GET /status`           |
| `position:updated`     | Position opened, closed, size changed, dust status changed       | Position object                       |
| `order:created`        | New order placed                                                 | Order object                          |
| `order:filled`         | Order fully or partially filled                                  | Order object with updated filled_size |
| `order:cancelled`      | Order cancelled                                                  | Order object with status=cancelled    |
| `fill:new`             | New fill recorded                                                | Fill object                           |
| `family:state_changed` | Family runtime mode changed (quarantine, reduce-only, activated) | Family summary object                 |
| `risk:event`           | Risk rejection, quarantine trigger, threshold breach             | Risk event object                     |
| `metrics:snapshot`     | Periodic (every 30s) aggregate metrics push                      | Same shape as `GET /metrics`          |

### SSE message format

```
event: fill:new
data: {"fill_id":"fill_ghi012","order_id":"ord_def456","family_id":"bitcoin-above:threshold:daily","side":"BUY","price":0.07,"size":100,"filled_at":"2026-03-13T14:02:00Z"}

event: metrics:snapshot
data: {"total_realized_pnl_usdc":4280.50,"fills_today":35,...}
```

### Implementation in v1

The API process subscribes to runtime events via one of:

1. **Polling runtime tables** with a change-detection query (e.g., `WHERE updated_at > ?`). Simple, fits v1.
2. **SQLite triggers writing to a changes table** that the SSE publisher reads.
3. If API and runtime share a process, the API can subscribe to the in-process event bus directly.

Recommended for v1: option 1 (polling with last-seen timestamp). Interval: 1-2 seconds for orders/fills/positions, 5 seconds for metrics.

---

## 4. Auth Model

### v1: Static API Key via Bearer Token

This is a single-operator system. There is one human watching one bot.

Implementation:

- API key is set via environment variable: `PLANKTON_API_KEY`.
- All endpoints except `GET /health` require the header: `Authorization: Bearer <api_key>`.
- The API key is a random 64-character hex string generated at deploy time.
- SSE endpoint also requires the API key, passed as query parameter `?token=<api_key>` since EventSource does not support custom headers natively.

Middleware pseudocode:

```typescript
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health") return next();
  const token = req.headers.authorization?.replace("Bearer ", "") || req.query.token;
  if (token !== process.env.PLANKTON_API_KEY) {
    return res
      .status(401)
      .json({ ok: false, error: { code: "UNAUTHORIZED", message: "Invalid API key" } });
  }
  next();
}
```

### What is NOT in v1

- No JWT. No token refresh. No user accounts.
- No RBAC. One key = full access.
- No OAuth flows.
- No session management.

### v2 considerations

If multi-operator access or remote access over the internet becomes necessary, upgrade to JWT with short-lived tokens and a login endpoint. But for v1, a static key is sufficient and appropriate for a single-machine operator tool.

---

## 5. Web Dashboard Pages

### 5.1 Overview

**Purpose**: At-a-glance bot health and aggregate metrics. The page an operator sees first.

**Shows**:

- Bot status: running/paused, runtime mode (simulation/paper/live-lite)
- Uptime, last reconciliation timestamp
- Market data freshness indicator
- Aggregate PnL: realized, tail cost, tail-adjusted
- Open value, open position count, open order count
- Family health distribution: how many active, probe, reduce-only, quarantined
- Pause/resume button

**API endpoints used**:

- `GET /status`
- `GET /metrics`
- `POST /actions/pause`
- `POST /actions/resume`
- SSE: `status`, `metrics:snapshot`

### 5.2 Positions

**Purpose**: All open positions with family context and tail visibility.

**Shows**:

- Table of open positions sortable by family, notional value, unrealized PnL, tail cost, age
- Dust positions highlighted
- Filter by family, dust status
- Clicking a position shows lot-level detail

**API endpoints used**:

- `GET /positions` with filters
- `GET /positions/:positionId`
- SSE: `position:updated`

### 5.3 Orders and Fills

**Purpose**: Order flow visibility. What the bot is doing right now and what it did recently.

**Shows**:

- Open orders table with family, market, side, price, size, age
- Recent fills table (last 100) with family, market, side, price, size, fee, timestamp
- Filter by family, side, status
- Cursor-based pagination for history

**API endpoints used**:

- `GET /orders?status=open`
- `GET /orders?status=filled,cancelled&limit=50`
- `GET /fills?limit=100`
- SSE: `order:created`, `order:filled`, `order:cancelled`, `fill:new`

### 5.4 Families

**Purpose**: Family-level operational view. The core control surface.

**Shows**:

- Table of all families with: state, promotion state, enabled, action, open value, tail cost, tail-adjusted PnL, dust count, active markets
- Color-coded runtime mode (green=active, yellow=reduce-only, red=quarantined, gray=probe)
- Click to expand: full rules, evidence layer, positions in family, orders in family
- Operator action buttons per family: set reduce-only, quarantine, activate

**API endpoints used**:

- `GET /families`
- `GET /families/:familyId`
- `GET /families/:familyId/positions`
- `GET /families/:familyId/orders`
- `POST /actions/family/:familyId/reduce-only`
- `POST /actions/family/:familyId/quarantine`
- `POST /actions/family/:familyId/activate`
- SSE: `family:state_changed`

### 5.5 Risk and Quarantine

**Purpose**: Risk event log and quarantine management.

**Shows**:

- List of quarantined families with reason and timestamp
- List of reduce-only families with reason
- Recent risk events: rejections, threshold breaches, auto-quarantine triggers
- Reconciliation status: last run, mismatches found, repairs applied
- Filter by event type, family

**API endpoints used**:

- `GET /families?state=quarantine,reduce-only`
- `GET /risk-events`
- `GET /reconciliation`
- SSE: `risk:event`, `family:state_changed`

---

## 6. API to Runtime Communication

### Architecture in v1

```
runtime-app (writer)
    |
    v
  SQLite (WAL mode)
    ^
    |
  api-app (reader + command inserter)
    ^
    |
  web-app (browser)
```

### Read path

The API reads directly from SQLite operational tables and views. No dedicated read model in v1.

Key tables the API reads from:

| Table                   | Used by                                 |
| ----------------------- | --------------------------------------- |
| `orders`                | `/orders`, `/families/:id/orders`       |
| `fills`                 | `/fills`                                |
| `positions`             | `/positions`, `/families/:id/positions` |
| `family_state`          | `/families` (runtime layer)             |
| `family_rules_snapshot` | `/families/:id` (rules layer)           |
| `family_catalog`        | `/families` (identity layer)            |
| `family_evidence`       | `/families/:id` (evidence layer)        |
| `risk_events`           | `/risk-events`                          |
| `runtime_metrics`       | `/metrics`                              |
| `bot_runs`              | `/status`                               |
| `operator_commands`     | `/actions/*` (write path)               |

SQLite WAL mode allows concurrent reads from the API process while the runtime writes. This is safe as long as:

1. The API opens the database in read-only mode (except for `operator_commands` inserts).
2. The API does not hold long transactions.
3. Query load stays modest (single operator, not a public API).

### Write path (operator commands)

The API inserts into `operator_commands`. The runtime polls this table and applies commands. See section 2 for the table schema.

### Recommended SQL views for the API

Create views in the persistence layer that pre-join common query patterns:

```sql
-- Family summary view joining catalog + state + evidence
CREATE VIEW family_summary AS
SELECT
  fc.family_id, fc.family_key, fc.regime, fc.horizon,
  fc.strategy_profile, fc.primary_category,
  fe.promotion_state, fe.evidence_score, fe.tail_adjusted_pnl,
  fs.runtime_mode, fs.open_value_usdc, fs.open_position_count,
  fs.open_dust_count, fs.current_tail_cost_usdc,
  fs.tail_adjusted_pnl_live, fs.active_market_count,
  fr.enabled, fr.action, fr.max_open_value_usdc,
  fr.max_active_markets, fr.max_dust_positions
FROM family_catalog fc
LEFT JOIN family_evidence fe ON fc.family_id = fe.family_id
LEFT JOIN family_runtime_state fs ON fc.family_id = fs.family_id
LEFT JOIN family_rules fr ON fc.family_id = fr.family_id;
```

### Why not IPC or HTTP between API and runtime in v1

- Shared SQLite is simpler and sufficient for single-machine deployment.
- No serialization overhead for reads.
- No service discovery or port management.
- Upgrade path: when PostgreSQL replaces SQLite, the API just changes its connection string.

---

## 7. v1 Scope Boundary

### In v1

| Capability                                                                              | Notes                           |
| --------------------------------------------------------------------------------------- | ------------------------------- |
| REST API with full read access                                                          | All endpoints in section 1      |
| Operator actions: pause, resume, family reduce-only, family quarantine, family activate | Section 2                       |
| SSE live updates                                                                        | Section 3                       |
| Static API key auth                                                                     | Section 4                       |
| Five dashboard pages: Overview, Positions, Orders/Fills, Families, Risk/Quarantine      | Section 5                       |
| Direct SQLite reads for API                                                             | Section 6                       |
| Command table for operator actions                                                      | Section 6                       |
| Cursor-based pagination for orders and fills                                            | Using `?cursor=` and `?limit=`  |
| Basic filtering on all list endpoints                                                   | By family_id, status, dust flag |
| Uniform error envelope                                                                  | Section 1                       |

### NOT in v1 (deferred)

| Capability                                    | Why deferred                                                       |
| --------------------------------------------- | ------------------------------------------------------------------ |
| WebSocket support                             | SSE is sufficient for single-operator dashboard                    |
| JWT / session-based auth                      | Static API key is adequate for single operator                     |
| RBAC / multi-user                             | Single operator system                                             |
| Dedicated read model / CQRS                   | Direct SQLite reads are fast enough                                |
| Advanced charting / time-series visualization | Not needed for operational control                                 |
| Family rules editor in UI                     | Family rules are YAML files loaded at startup                      |
| Backtesting UI                                | Research stays in Python                                           |
| Alerting / notifications (email, Telegram)    | Operator watches dashboard directly in v1                          |
| Public API / rate limiting                    | Internal tool, single consumer                                     |
| OpenAPI spec generation                       | Can add when API stabilizes                                        |
| Mobile-responsive design                      | Operator uses a desktop monitor                                    |
| Dark mode / theming                           | Operational, not cosmetic                                          |
| Audit log UI                                  | `operator_commands` table serves as audit log; no dedicated UI yet |
| Per-market detail page                        | Family is the unit of control, not individual markets              |
| Signal / rejection log page                   | Risk events cover the critical subset                              |

---

## 8. Tech Stack for API and Web

### API: Fastify

Recommendation: **Fastify** over Express.

Rationale:

- Fastify has built-in schema validation (JSON Schema / TypeBox) that pairs well with the typed domain model.
- Better performance than Express (not critical at v1 scale, but free).
- First-class TypeScript support.
- Built-in plugin system for clean separation of route groups.
- SSE support via `@fastify/sse` or manual response streaming.

If the team is more comfortable with Express, Express is also fine for v1. The API is small enough that framework choice is not load-bearing.

### Web: Vite + React

Recommendation: **Vite + React** over Next.js.

Rationale:

- This is a single-page operator dashboard, not a content site. There is no SEO requirement, no server-side rendering need, no public-facing pages.
- Vite provides fast dev experience and simple build.
- React is standard for dashboard UIs.
- No need for Next.js App Router complexity, server components, or file-based routing for five pages.
- Smaller deployment surface: the web app is a static bundle served by the API process or a simple file server.

Recommended libraries:

| Concern                | Library                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| Routing                | React Router (5 routes, flat)                                                   |
| State / data fetching  | TanStack Query (React Query)                                                    |
| SSE consumption        | Native EventSource API + React Query invalidation                               |
| UI components          | Minimal: plain HTML tables + a small utility CSS approach (Tailwind or similar) |
| Forms (action dialogs) | Native form elements. No form library needed for 3 action forms.                |

### Shared types: `packages/domain`

The API and web app both import types from `packages/domain`. The web app consumes API response shapes that are derived from these domain types. Define response DTOs in the API that re-export or narrow the domain types.

### Deployment shape in v1

```
runtime-app   (Node.js process, writes SQLite)
api-app       (Node.js process, reads SQLite, serves REST + SSE)
web-app       (static files served by api-app or separate static server)
```

The API process can serve the built web assets from a `/` route, making deployment a two-process system:

1. `runtime-app`
2. `api-app` (serves API + static web bundle)

This avoids a third process for v1.

### API project structure

```
apps/api/
  src/
    server.ts              -- Fastify instance, plugin registration
    auth.ts                -- API key middleware
    db.ts                  -- Read-only SQLite connection
    routes/
      health.ts
      status.ts
      families.ts
      positions.ts
      orders.ts
      fills.ts
      metrics.ts
      risk-events.ts
      reconciliation.ts
      actions.ts
    sse/
      event-stream.ts      -- SSE endpoint, polls SQLite for changes
    queries/
      family-queries.ts    -- SQL query functions for family data
      position-queries.ts
      order-queries.ts
      fill-queries.ts
      metrics-queries.ts
      risk-queries.ts
```

### Web project structure

```
apps/web/
  src/
    main.tsx
    App.tsx
    api/
      client.ts            -- fetch wrapper with auth header
      hooks.ts             -- TanStack Query hooks for each endpoint
      sse.ts               -- EventSource connection + query invalidation
    pages/
      Overview.tsx
      Positions.tsx
      OrdersFills.tsx
      Families.tsx
      RiskQuarantine.tsx
    components/
      Layout.tsx            -- nav + page shell
      FamilyRow.tsx
      PositionTable.tsx
      OrderTable.tsx
      FillTable.tsx
      StatusBar.tsx
      ActionButton.tsx      -- confirm-dialog wrapper for operator actions
```

---

## Summary

This design provides a minimal, operator-focused API and dashboard surface for v1. The API reads directly from SQLite operational tables, operator commands flow through a polling-based command table, and live updates use SSE. Auth is a single static API key. The dashboard has five pages covering the essential operational views: bot health, positions, order flow, family state management, and risk monitoring. The tech stack is Fastify for the API and Vite + React for the dashboard, both consuming shared domain types from `packages/domain`.
