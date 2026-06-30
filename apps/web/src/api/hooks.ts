import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost, apiPut, apiPatch, apiDelete } from "./client.ts";
import type {
  StatusData,
  SystemHealthData,
  MetricsData,
  DashboardKpiData,
  CoverageMetricsData,
  PnlDataPoint,
  PortfolioSeriesResponse,
  PositionDTO,
  OrderDTO,
  FillDTO,
  RiskEventDTO,
  Paginated,
  ProfilesResponse,
  ProfileDetailDTO,
  ProfileSettingsDTO,
  AuditEntryDTO,
  SwitchResponse,
  ControlOverviewDTO,
  TradingActivitySnapshot,
  SelectionRule,
  SelectionRuleType,
  PreviewBuckets,
  MatchResult,
  EventMetric,
  ExecutionPolicyDTO,
  ExecutionPolicyResponse,
  R23MetricsData,
  PositionCyclesResponseDTO,
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
      apiFetch<{
        status: string;
        sha: string | null;
        deployVersion: number | null;
        deployedAt: string | null;
      }>("/api/v1/health"),
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

export function useSystemHealth() {
  return useQuery({
    queryKey: ["system-health"],
    queryFn: () => apiFetch<SystemHealthData>("/api/v1/system-health"),
    refetchInterval: 15_000,
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

export function useCoverageMetrics() {
  return useQuery({
    queryKey: ["metrics", "coverage"],
    queryFn: () => apiFetch<CoverageMetricsData>("/api/v1/metrics/coverage"),
    refetchInterval: 10_000,
  });
}

export function useDashboardKpi() {
  return useQuery({
    queryKey: ["dashboard", "kpi"],
    queryFn: () => apiFetch<DashboardKpiData>("/api/v1/dashboard/kpi"),
    refetchInterval: 30_000,
  });
}

export function useR23Metrics() {
  return useQuery({
    queryKey: ["metrics", "r23"],
    queryFn: () => apiFetch<R23MetricsData>("/api/v1/metrics/r23"),
    refetchInterval: 10_000,
  });
}

export function usePnlSeries(days = 14) {
  return useQuery({
    queryKey: ["pnl-series", days],
    queryFn: () => apiFetch<{ items: PnlDataPoint[] }>(`/api/v1/metrics/pnl-series?days=${days}`),
    placeholderData: (previousData) => previousData,
  });
}

export function usePortfolioSeries(interval: string) {
  return useQuery({
    queryKey: ["portfolio-series", interval],
    queryFn: () =>
      apiFetch<PortfolioSeriesResponse>(
        withParams("/api/v1/metrics/portfolio-series", { interval }),
      ),
    refetchInterval: 60_000,
    placeholderData: (previousData) => previousData,
  });
}

export interface PositionCycleFilters {
  period?: string;
  status?: string;
  pnl?: string;
  source?: string;
  band?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export function usePositionCycles(filters: PositionCycleFilters = {}) {
  return useQuery({
    queryKey: ["position-cycles", filters],
    queryFn: () =>
      apiFetch<PositionCyclesResponseDTO>(
        withParams("/api/v1/pnl/position-cycles", {
          period: filters.period,
          status: filters.status,
          pnl: filters.pnl,
          source: filters.source,
          band: filters.band,
          sort: filters.sort,
          page: filters.page,
          pageSize: filters.pageSize,
        }),
      ),
    placeholderData: (previousData) => previousData,
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

// ─── Positions ──────────────────────────────────────────────────

interface PositionFilters {
  dust?: boolean;
  status?: string;
  sort?: string;
  limit?: number;
  cursor?: string;
  page?: number;
}

export function usePositions(filters: PositionFilters = {}) {
  return useQuery({
    queryKey: ["positions", filters],
    queryFn: () =>
      apiFetch<Paginated<PositionDTO> & { totalCount: number }>(
        withParams("/api/v1/positions", {
          dust: filters.dust || undefined,
          status: filters.status,
          sort: filters.sort,
          limit: filters.limit,
          cursor: filters.cursor,
          page: filters.page,
        }),
      ),
  });
}

// Aggregating fetcher — walks cursor pages until `nextCursor` is null so that
// client-side filters/search/counts/pagination see the complete ledger, not
// just the first page. Caps iterations at `maxPages * pageSize` to keep a
// broken backend from pinning the browser.
interface AllPositionsResult {
  items: PositionDTO[];
  totalCount: number;
  truncated: boolean;
}

export function useAllPositions(opts: { pageSize?: number; maxPages?: number } = {}) {
  const pageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? 20;
  return useQuery({
    queryKey: ["positions-all", { pageSize, maxPages }],
    queryFn: async (): Promise<AllPositionsResult> => {
      const items: PositionDTO[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < maxPages; i++) {
        const batch = await apiFetch<Paginated<PositionDTO> & { totalCount: number }>(
          withParams("/api/v1/positions", { limit: pageSize, cursor }),
        );
        items.push(...batch.items);
        if (!batch.nextCursor) {
          return { items, totalCount: items.length, truncated: false };
        }
        cursor = batch.nextCursor;
      }
      return { items, totalCount: items.length, truncated: true };
    },
  });
}

// ─── Orders ─────────────────────────────────────────────────────

interface OrderFilters {
  status?: string;
  limit?: number;
  cursor?: string;
  page?: number;
}

export function useOrders(filters: OrderFilters = {}) {
  return useQuery({
    queryKey: ["orders", filters],
    queryFn: () =>
      apiFetch<Paginated<OrderDTO>>(
        withParams("/api/v1/orders", {
          status: filters.status,
          limit: filters.limit,
          cursor: filters.cursor,
          page: filters.page,
        }),
      ),
  });
}

// ─── Fills ──────────────────────────────────────────────────────

interface FillFilters {
  since?: string;
  limit?: number;
  cursor?: string;
  page?: number;
  tokenId?: string;
}

export function useFills(filters: FillFilters = {}) {
  return useQuery({
    queryKey: ["fills", filters],
    queryFn: () =>
      apiFetch<Paginated<FillDTO>>(
        withParams("/api/v1/fills", {
          since: filters.since,
          limit: filters.limit,
          cursor: filters.cursor,
          page: filters.page,
          tokenId: filters.tokenId,
        }),
      ),
  });
}

// ─── Risk Events ────────────────────────────────────────────────

interface RiskEventFilters {
  eventType?: string;
  limit?: number;
  cursor?: string;
  page?: number;
}

export function useRiskEvents(filters: RiskEventFilters = {}) {
  return useQuery({
    queryKey: ["risk-events", filters],
    queryFn: () =>
      apiFetch<Paginated<RiskEventDTO>>(
        withParams("/api/v1/risk-events", {
          event_type: filters.eventType,
          limit: filters.limit,
          cursor: filters.cursor,
          page: filters.page,
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
      walletMode?: "eoa" | "relayer";
      minOrderUsdc?: number;
      relayerJson?: string;
    }) => apiPut<ProfileSettingsDTO>(`/api/v1/profiles/${profileId}/settings`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      void qc.invalidateQueries({ queryKey: ["profiles", profileId] });
    },
  });
}

// ─── Execution Policy (ADR-015) ───────────────────────────────────────

export function useExecutionPolicy(profileId: string | null) {
  return useQuery({
    queryKey: ["profiles", profileId, "execution-policy"],
    queryFn: () =>
      apiFetch<ExecutionPolicyResponse>(`/api/v1/profiles/${profileId}/execution-policy`),
    enabled: !!profileId,
  });
}

export function useUpdateExecutionPolicy(profileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<ExecutionPolicyDTO>) =>
      apiPatch<ExecutionPolicyResponse>(`/api/v1/profiles/${profileId}/execution-policy`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["profiles", profileId, "execution-policy"] });
    },
  });
}

// ─── Profile-scoped ledger hooks ──────────────────────────────────────

export function useProfileOrders(profileId: string | undefined, filters: OrderFilters = {}) {
  return useQuery({
    queryKey: ["profiles", profileId, "orders", filters],
    queryFn: () =>
      apiFetch<Paginated<OrderDTO>>(
        withParams(`/api/v1/profiles/${profileId}/orders`, {
          status: filters.status,
          limit: filters.limit,
          cursor: filters.cursor,
          page: filters.page,
        }),
      ),
    enabled: !!profileId,
  });
}

export function useProfilePositions(profileId: string | undefined, filters: PositionFilters = {}) {
  return useQuery({
    queryKey: ["profiles", profileId, "positions", filters],
    queryFn: () =>
      apiFetch<PositionDTO[]>(
        withParams(`/api/v1/profiles/${profileId}/positions`, {
          dust: filters.dust || undefined,
          status: filters.status,
          sort: filters.sort,
        }),
      ),
    enabled: !!profileId,
  });
}

export function useProfileFills(profileId: string | undefined, filters: FillFilters = {}) {
  return useQuery({
    queryKey: ["profiles", profileId, "fills", filters],
    queryFn: () =>
      apiFetch<Paginated<FillDTO>>(
        withParams(`/api/v1/profiles/${profileId}/fills`, {
          since: filters.since,
          limit: filters.limit,
          cursor: filters.cursor,
          page: filters.page,
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
  page?: number;
  type?: string;
  profile?: string;
  entityId?: string;
}

export function useAudit(filters: AuditFilters = {}) {
  return useQuery({
    queryKey: ["audit", filters],
    queryFn: () =>
      apiFetch<Paginated<AuditEntryDTO>>(
        withParams("/api/v1/audit", {
          limit: filters.limit,
          cursor: filters.cursor,
          page: filters.page,
          type: filters.type,
          profile: filters.profile,
          entityId: filters.entityId,
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

// ─── Selection Rules ──────────────────────────────────────────────────

export function useSelectionRules(profileId: string) {
  return useQuery({
    queryKey: ["selection-rules", profileId],
    queryFn: () =>
      apiFetch<{ rules: SelectionRule[] }>(`/api/v1/selection-rules?profileId=${profileId}`),
    select: (d) => d.rules,
    enabled: Boolean(profileId),
  });
}

export function useCreateSelectionRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      profileId: string;
      ruleType: SelectionRuleType;
      pattern: string;
      note?: string | null;
    }) => apiPost<{ rule: SelectionRule }>("/api/v1/selection-rules", input),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["selection-rules", vars.profileId] });
      void qc.invalidateQueries({ queryKey: ["selection-preview", vars.profileId] });
    },
  });
}

export function useUpdateSelectionRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      ruleId,
      patch,
    }: {
      ruleId: string;
      profileId: string;
      patch: { enabled?: boolean; note?: string | null };
    }) => apiPatch<{ rule: SelectionRule }>(`/api/v1/selection-rules/${ruleId}`, patch),
    onSuccess: (_data, { profileId }) => {
      void qc.invalidateQueries({ queryKey: ["selection-rules", profileId] });
      void qc.invalidateQueries({ queryKey: ["selection-preview", profileId] });
    },
  });
}

export function useDeleteSelectionRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId }: { ruleId: string; profileId: string }) =>
      apiDelete<{ deleted: boolean; ruleId: string }>(`/api/v1/selection-rules/${ruleId}`),
    onSuccess: (_data, { profileId }) => {
      void qc.invalidateQueries({ queryKey: ["selection-rules", profileId] });
      void qc.invalidateQueries({ queryKey: ["selection-preview", profileId] });
    },
  });
}

export function useSelectionPreview(profileId: string) {
  return useQuery({
    queryKey: ["selection-preview", profileId],
    queryFn: () =>
      apiFetch<PreviewBuckets>(`/api/v1/selection-rules/preview?profileId=${profileId}`),
    enabled: Boolean(profileId),
  });
}

export function useSelectionMatch(
  profileId: string,
  eventSlug: string,
  marketSlug: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["selection-match", profileId, eventSlug, marketSlug],
    queryFn: () =>
      apiFetch<MatchResult>(
        `/api/v1/selection-rules/match?profileId=${profileId}&eventSlug=${encodeURIComponent(eventSlug)}&marketSlug=${encodeURIComponent(marketSlug)}`,
      ),
    enabled,
  });
}

export function useEventSlugOptions(profileId: string) {
  return useQuery({
    queryKey: ["event-slugs", profileId],
    queryFn: () =>
      apiFetch<{ eventSlugs: string[] }>(`/api/v1/markets/event-slugs?profileId=${profileId}`),
    select: (d) => d.eventSlugs,
    enabled: Boolean(profileId),
  });
}

export function useMetricsEvents(profileId: string, limit = 20) {
  return useQuery({
    queryKey: ["metrics-events", profileId, limit],
    queryFn: () =>
      apiFetch<{ events: EventMetric[] }>(
        `/api/v1/metrics/events?profileId=${profileId}&limit=${limit}`,
      ),
    select: (d) => d.events,
  });
}
