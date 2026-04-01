import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, apiPut } from "./client.ts";
import type {
  StatusData,
  MetricsData,
  PnlDataPoint,
  FamilyMetric,
  PositionDTO,
  OrderDTO,
  FillDTO,
  FamilyDTO,
  FamilyEvidenceDTO,
  TransitionDTO,
  RiskEventDTO,
  CandidateDTO,
  CandidateDetailDTO,
  DiscoveryStatusDTO,
  DiscoveryRunDTO,
  ProposalDTO,
  Paginated,
  ProfilesResponse,
  ProfileDetailDTO,
  ProfileSettingsDTO,
  AuditEntryDTO,
  SwitchResponse,
  ControlOverviewDTO,
  TradingActivitySnapshot,
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

// ─── Build Info ─────────────────────────────────────────────────

export function useBuildInfo() {
  return useQuery({
    queryKey: ["build-info"],
    queryFn: () =>
      apiFetch<{ status: string; sha: string | null; deployVersion: number | null; deployedAt: string | null }>(
        "/api/v1/health",
      ),
    staleTime: 5 * 60_000, // cache 5 min — rarely changes
  });
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

export function useTradingActivity(days = 14) {
  return useQuery({
    queryKey: ["trading-activity", days],
    queryFn: () =>
      apiFetch<{ items: TradingActivitySnapshot[] }>(
        `/api/v1/metrics/trading-activity?days=${days}`,
      ),
    refetchInterval: 60_000,
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
  limit?: number;
  cursor?: string;
}

export function usePositions(filters: PositionFilters = {}) {
  return useQuery({
    queryKey: ["positions", filters],
    queryFn: () =>
      apiFetch<Paginated<PositionDTO> & { totalCount: number }>(
        withParams("/api/v1/positions", {
          family_id: filters.familyId,
          dust: filters.dust || undefined,
          status: filters.status,
          sort: filters.sort,
          limit: filters.limit,
          cursor: filters.cursor,
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["status"] }),
  });
}

export function useResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) => apiPost("/api/v1/actions/resume", { reason }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["status"] }),
  });
}

export function useFamilyEvidence(familyId: string) {
  return useQuery({
    queryKey: ["families", familyId, "evidence"],
    queryFn: () => apiFetch<FamilyEvidenceDTO | null>(`/api/v1/families/${familyId}/evidence`),
    enabled: !!familyId,
  });
}

export function useFamilyTransitions(familyId: string) {
  return useQuery({
    queryKey: ["families", familyId, "transitions"],
    queryFn: () => apiFetch<TransitionDTO[]>(`/api/v1/families/${familyId}/transitions`),
    enabled: !!familyId,
  });
}

// ─── Discovery ─────────────────────────────────────────────────

interface CandidateFilters {
  status?: string;
  recommendation?: string;
  confidence?: string;
  cadence?: string;
}

export function useCandidates(filters: CandidateFilters & { cursor?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["discovery", "candidates", filters],
    queryFn: () =>
      apiFetch<Paginated<CandidateDTO>>(
        withParams("/api/v1/discovery/candidates", {
          status: filters.status,
          recommendation: filters.recommendation,
          confidence: filters.confidence,
          cadence: filters.cadence,
          limit: filters.limit ?? 50,
          cursor: filters.cursor,
        }),
      ),
  });
}

export function useCandidateTransitions(candidateId: string | null) {
  return useQuery({
    queryKey: ["discovery", "candidates", candidateId, "transitions"],
    queryFn: () =>
      apiFetch<TransitionDTO[]>(`/api/v1/discovery/candidates/${candidateId}/transitions`),
    enabled: !!candidateId,
  });
}

export function useCandidateDetail(candidateId: string | null) {
  return useQuery({
    queryKey: ["discovery", "candidates", candidateId],
    queryFn: () =>
      apiFetch<CandidateDetailDTO>(`/api/v1/discovery/candidates/${candidateId}`),
    enabled: !!candidateId,
  });
}

export function useDiscoveryStatus() {
  return useQuery({
    queryKey: ["discovery", "status"],
    queryFn: () => apiFetch<DiscoveryStatusDTO>("/api/v1/discovery/status"),
    // Always poll: 5s when scan active (fast feedback), 30s when idle (detect worker offline).
    // SSE only tracks discovery_runs changes, not worker heartbeat metric.
    refetchInterval: (query) => (query.state.data?.activeRun ? 5_000 : 30_000),
  });
}

export function useDiscoveryRuns(limit = 10) {
  return useQuery({
    queryKey: ["discovery", "runs", limit],
    queryFn: () => apiFetch<DiscoveryRunDTO[]>(`/api/v1/discovery/runs?limit=${limit}`),
  });
}

export function useTriggerScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<{ runId: number; status: string; alreadyActive: boolean }>(
        "/api/v1/discovery/scan",
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["discovery"] }),
  });
}

export function useProposals() {
  return useQuery({
    queryKey: ["families", "proposals"],
    queryFn: () => apiFetch<ProposalDTO[]>("/api/v1/families/proposals"),
  });
}

export function useCandidateAction(
  candidateId: string,
  action: "review" | "accept" | "reject",
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: Record<string, unknown> | { maxOpenValueUsdc: number; maxActiveMarkets: number; maxDustPositions: number }) =>
      apiPost(`/api/v1/discovery/candidates/${candidateId}/${action}`, body),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["discovery", "candidates"] }),
        qc.invalidateQueries({ queryKey: ["families"] }),
      ]);
    },
  });
}

export function usePromoteFamily(familyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: { reason?: string; maxOpenValueUsdc?: number; maxActiveMarkets?: number; maxDustPositions?: number }) =>
      apiPost(`/api/v1/actions/family/${familyId}/promote`, body),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["families", "proposals"] }),
        qc.invalidateQueries({ queryKey: ["families"] }),
      ]);
    },
  });
}

export function useDismissProposal(proposalId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      apiPost(`/api/v1/families/proposals/${proposalId}/dismiss`, { reason }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["families", "proposals"] }),
  });
}

export function useResetToProbe(familyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      apiPost(`/api/v1/actions/family/${familyId}/reset-to-probe`, { reason }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["families"] }),
        qc.invalidateQueries({ queryKey: ["status"] }),
      ]);
    },
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

// ─── Profiles ─────────────────────────────────────────────────────────

export function useProfiles() {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: () => apiFetch<ProfilesResponse>("/api/v1/profiles"),
    refetchInterval: 30_000,
  });
}

export function useProfileDetail(profileId: string | null) {
  return useQuery({
    queryKey: ["profiles", profileId],
    queryFn: () => apiFetch<ProfileDetailDTO>(`/api/v1/profiles/${profileId}`),
    enabled: !!profileId,
  });
}

export function useProfileSettings(profileId: string | null) {
  return useQuery({
    queryKey: ["profiles", profileId, "settings"],
    queryFn: () => apiFetch<ProfileSettingsDTO>(`/api/v1/profiles/${profileId}/settings`),
    enabled: !!profileId,
  });
}

export function useUpdateProfileSettings(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      initialBalanceUsdc?: number;
      envelopeJson?: string;
      riskCapsJson?: string;
    }) => apiPut<ProfileSettingsDTO>(`/api/v1/profiles/${profileId}/settings`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      void qc.invalidateQueries({ queryKey: ["profiles", profileId] });
    },
  });
}

// ─── Profile-scoped ledger hooks ──────────────────────────────────────

export function useProfileOrders(
  profileId: string | undefined,
  filters: OrderFilters = {},
) {
  return useQuery({
    queryKey: ["profiles", profileId, "orders", filters],
    queryFn: () =>
      apiFetch<Paginated<OrderDTO>>(
        withParams(`/api/v1/profiles/${profileId}/orders`, {
          status: filters.status,
          family_id: filters.familyId,
          limit: filters.limit,
          cursor: filters.cursor,
        }),
      ),
    enabled: !!profileId,
  });
}

export function useProfilePositions(
  profileId: string | undefined,
  filters: PositionFilters = {},
) {
  return useQuery({
    queryKey: ["profiles", profileId, "positions", filters],
    queryFn: () =>
      apiFetch<PositionDTO[]>(
        withParams(`/api/v1/profiles/${profileId}/positions`, {
          family_id: filters.familyId,
          dust: filters.dust || undefined,
          status: filters.status,
          sort: filters.sort,
        }),
      ),
    enabled: !!profileId,
  });
}

export function useProfileFills(
  profileId: string | undefined,
  filters: FillFilters = {},
) {
  return useQuery({
    queryKey: ["profiles", profileId, "fills", filters],
    queryFn: () =>
      apiFetch<Paginated<FillDTO>>(
        withParams(`/api/v1/profiles/${profileId}/fills`, {
          family_id: filters.familyId,
          since: filters.since,
          limit: filters.limit,
          cursor: filters.cursor,
        }),
      ),
    enabled: !!profileId,
  });
}

// ─── Control Overview ─────────────────────────────────────────────────

export function useControlOverview() {
  return useQuery({
    queryKey: ["control", "overview"],
    queryFn: () => apiFetch<ControlOverviewDTO>("/api/v1/control/overview"),
    refetchInterval: 15_000,
  });
}

// ─── Audit ────────────────────────────────────────────────────────────

interface AuditFilters {
  limit?: number;
  cursor?: string;
  type?: string;
  profile?: string;
  familyId?: string;
}

export function useAudit(filters: AuditFilters = {}) {
  return useQuery({
    queryKey: ["audit", filters],
    queryFn: () =>
      apiFetch<Paginated<AuditEntryDTO>>(
        withParams("/api/v1/audit", {
          limit: filters.limit,
          cursor: filters.cursor,
          type: filters.type,
          profile: filters.profile,
          familyId: filters.familyId,
        }),
      ),
  });
}

// ─── Profile Switch ───────────────────────────────────────────────────

export function useSwitchProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { toProfile: string; ledgerResetPolicy?: string; reason?: string }) =>
      apiPost<SwitchResponse>("/api/v1/actions/switch-profile", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      void qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
}
