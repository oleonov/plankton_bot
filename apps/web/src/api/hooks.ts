import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost } from "./client.ts";
import type {
  StatusData,
  MetricsData,
  PnlDataPoint,
  FamilyMetric,
  PositionDTO,
  OrderDTO,
  FillDTO,
  FamilyDTO,
  RiskEventDTO,
  Paginated,
} from "./types.ts";

function withParams(
  base: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== false && v !== "") sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

// ─── Status ─────────────────────────────────────────────────────

export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => apiFetch<StatusData>("/api/v1/status"),
    refetchInterval: 30_000,
  });
}

// ─── Metrics ────────────────────────────────────────────────────

export function useMetrics() {
  return useQuery({
    queryKey: ["metrics"],
    queryFn: () => apiFetch<MetricsData>("/api/v1/metrics"),
    refetchInterval: 30_000,
  });
}

export function usePnlSeries(days = 14) {
  return useQuery({
    queryKey: ["pnl-series", days],
    queryFn: () => apiFetch<{ items: PnlDataPoint[] }>(`/api/v1/metrics/pnl-series?days=${days}`),
  });
}

export function useMetricsFamilies() {
  return useQuery({
    queryKey: ["metrics-families"],
    queryFn: () => apiFetch<FamilyMetric[]>("/api/v1/metrics/families"),
  });
}

// ─── Positions ──────────────────────────────────────────────────

interface PositionFilters {
  familyId?: string;
  dust?: boolean;
  status?: string;
  sort?: string;
}

export function usePositions(filters: PositionFilters = {}) {
  return useQuery({
    queryKey: ["positions", filters],
    queryFn: () =>
      apiFetch<PositionDTO[]>(
        withParams("/api/v1/positions", {
          family_id: filters.familyId,
          dust: filters.dust || undefined,
          status: filters.status,
          sort: filters.sort,
        }),
      ),
  });
}

// ─── Orders ─────────────────────────────────────────────────────

interface OrderFilters {
  status?: string;
  familyId?: string;
  limit?: number;
  cursor?: string;
}

export function useOrders(filters: OrderFilters = {}) {
  return useQuery({
    queryKey: ["orders", filters],
    queryFn: () =>
      apiFetch<Paginated<OrderDTO>>(
        withParams("/api/v1/orders", {
          status: filters.status,
          family_id: filters.familyId,
          limit: filters.limit,
          cursor: filters.cursor,
        }),
      ),
  });
}

// ─── Fills ──────────────────────────────────────────────────────

interface FillFilters {
  familyId?: string;
  since?: string;
  limit?: number;
  cursor?: string;
}

export function useFills(filters: FillFilters = {}) {
  return useQuery({
    queryKey: ["fills", filters],
    queryFn: () =>
      apiFetch<Paginated<FillDTO>>(
        withParams("/api/v1/fills", {
          family_id: filters.familyId,
          since: filters.since,
          limit: filters.limit,
          cursor: filters.cursor,
        }),
      ),
  });
}

// ─── Families ───────────────────────────────────────────────────

export function useFamilies() {
  return useQuery({
    queryKey: ["families"],
    queryFn: () => apiFetch<FamilyDTO[]>("/api/v1/families"),
  });
}

export function useFamilyPositions(familyId: string) {
  return useQuery({
    queryKey: ["families", familyId, "positions"],
    queryFn: () => apiFetch<PositionDTO[]>(`/api/v1/families/${familyId}/positions`),
    enabled: !!familyId,
  });
}

export function useFamilyOrders(familyId: string) {
  return useQuery({
    queryKey: ["families", familyId, "orders"],
    queryFn: () => apiFetch<Paginated<OrderDTO>>(`/api/v1/families/${familyId}/orders`),
    enabled: !!familyId,
  });
}

// ─── Risk Events ────────────────────────────────────────────────

interface RiskEventFilters {
  familyId?: string;
  eventType?: string;
  limit?: number;
  cursor?: string;
}

export function useRiskEvents(filters: RiskEventFilters = {}) {
  return useQuery({
    queryKey: ["risk-events", filters],
    queryFn: () =>
      apiFetch<Paginated<RiskEventDTO>>(
        withParams("/api/v1/risk-events", {
          family_id: filters.familyId,
          event_type: filters.eventType,
          limit: filters.limit,
          cursor: filters.cursor,
        }),
      ),
  });
}

// ─── Actions ────────────────────────────────────────────────────

export function usePause() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => apiPost("/api/v1/actions/pause", { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["status"] }),
  });
}

export function useResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => apiPost("/api/v1/actions/resume", { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["status"] }),
  });
}

export function useFamilyAction(
  familyId: string,
  action: "quarantine" | "reduce-only" | "activate",
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      apiPost(`/api/v1/actions/family/${familyId}/${action}`, { reason }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["families"] }),
        qc.invalidateQueries({ queryKey: ["status"] }),
      ]);
    },
  });
}
