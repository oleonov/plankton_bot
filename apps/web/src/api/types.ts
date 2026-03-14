/** API response envelope */
export interface ApiEnvelope<T> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  ts: string;
}

/** GET /status */
export interface StatusData {
  runtimeMode: string;
  uptimeSeconds: number;
  paused: boolean;
  lastReconciliationAt: string | null;
  marketDataStale: boolean;
  marketDataLastUpdateAt: string | null;
  activeFamilyCount: number;
  openOrderCount: number;
  openPositionCount: number;
  totalOpenValueUsdc: number;
  totalTailCostUsdc: number;
  marketDataSource: "live" | "simulation";
  executionMode: "simulation" | "live";
}

/** GET /metrics */
export interface MetricsData {
  positions: Record<string, number>;
  orders: Record<string, number>;
  fills: { count: number; volumeUsdc: number };
  totalRealizedPnl: number;
}

/** GET /metrics/pnl-series */
export interface PnlDataPoint {
  date: string;
  realizedPnl: number;
}

/** GET /metrics/families item */
export interface FamilyMetric {
  familyId: string;
  runtimeMode: string;
  openValueUsdc: number;
  openPositionCount: number;
  tailAdjustedPnlLive: number;
  quarantineReason: string | null;
  updatedAt: string;
}

/** GET /positions item */
export interface PositionDTO {
  positionId: string;
  tokenId: string;
  familyId: string;
  side: string;
  size: number;
  avgEntryPrice: number;
  costBasisUsdc: number;
  currentValueUsdc: number | null;
  realizedPnl: number;
  status: string;
  openedAt: string;
  closedAt: string | null;
  updatedAt: string;
}

/** GET /orders item */
export interface OrderDTO {
  orderId: string;
  clientOrderId: string;
  tokenId: string;
  familyId: string;
  side: string;
  orderType: string;
  price: number;
  size: number;
  sizeUsdc: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /fills item */
export interface FillDTO {
  fillId: string;
  orderId: string;
  tokenId: string;
  familyId: string;
  side: string;
  price: number;
  size: number;
  sizeUsdc: number;
  fee: number;
  filledAt: string;
}

/** GET /families item */
export interface FamilyDTO {
  familyId: string;
  familyKey: string;
  primaryCategory: string;
  regime: string;
  state: {
    runtimeMode: string;
    openValueUsdc: number;
    openPositionCount: number;
    openDustCount: number;
    currentTailCostUsdc: number;
    tailAdjustedPnlLive: number;
    quarantineReason: string | null;
  } | null;
}

/** GET /risk-events item */
export interface RiskEventDTO {
  id: number;
  eventType: string;
  familyId: string | null;
  summary: string;
  severity: "critical" | "warning" | "info";
  createdAt: string;
}

/** Paginated response */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
