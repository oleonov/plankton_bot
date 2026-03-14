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
  const params = new URLSearchParams();
  if (filters.familyId) params.set("family_id", filters.familyId);
  if (filters.dust) params.set("dust", "true");
  if (filters.status) params.set("status", filters.status);
  if (filters.sort) params.set("sort", filters.sort);
  const qs = params.toString();
  return useQuery({
    queryKey: ["positions", filters],
    queryFn: () => apiFetch<PositionDTO[]>(`/api/v1/positions${qs ? `?${qs}` : ""}`),
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
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.familyId) params.set("family_id", filters.familyId);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.cursor) params.set("cursor", filters.cursor);
  const qs = params.toString();
  return useQuery({
    queryKey: ["orders", filters],
    queryFn: () => apiFetch<Paginated<OrderDTO>>(`/api/v1/orders${qs ? `?${qs}` : ""}`),
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
  const params = new URLSearchParams();
  if (filters.familyId) params.set("family_id", filters.familyId);
  if (filters.since) params.set("since", filters.since);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.cursor) params.set("cursor", filters.cursor);
  const qs = params.toString();
  return useQuery({
    queryKey: ["fills", filters],
    queryFn: () => apiFetch<Paginated<FillDTO>>(`/api/v1/fills${qs ? `?${qs}` : ""}`),
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
  const params = new URLSearchParams();
  if (filters.familyId) params.set("family_id", filters.familyId);
  if (filters.eventType) params.set("event_type", filters.eventType);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.cursor) params.set("cursor", filters.cursor);
  const qs = params.toString();
  return useQuery({
    queryKey: ["risk-events", filters],
    queryFn: () => apiFetch<Paginated<RiskEventDTO>>(`/api/v1/risk-events${qs ? `?${qs}` : ""}`),
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

export function useFamilyAction(familyId: string, action: "quarantine" | "reduce-only" | "activate") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      apiPost(`/api/v1/actions/family/${familyId}/${action}`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["families"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
}
