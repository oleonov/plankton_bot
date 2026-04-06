import { useState, useEffect, useRef, useCallback } from "react";
import { usePortfolioSeries, usePnlSeries } from "../api/hooks.ts";
import type { PortfolioDataPoint, PnlDataPoint } from "../api/types.ts";

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore — localStorage may be unavailable in tests or SSR
  }
}

const WIDTH = 700;
const HEIGHT = 200;
const PAD = { top: 10, right: 10, bottom: 30, left: 60 };

const INTERVALS = ["1d", "1w", "1m", "all"] as const;
type Interval = (typeof INTERVALS)[number];

const INTERVAL_TO_DAYS: Record<Interval, number> = {
  "1d": 1,
  "1w": 7,
  "1m": 30,
  all: 90,
};

type ChartMode = "portfolio" | "realized";

interface ChartPoint {
  value: number;
  label: string;
}

function portfolioToChartPoints(items: PortfolioDataPoint[], baseline: number): ChartPoint[] {
  return items.map((d) => ({
    value: d.equityUsdc - baseline,
    label: d.capturedAt.slice(5, 16).replace("T", " "),
  }));
}

function pnlToChartPoints(items: PnlDataPoint[]): ChartPoint[] {
  return items.map((d) => ({
    value: d.realizedPnl,
    label: d.date.slice(5),
  }));
}

const tabBase: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};

interface AreaChartProps {
  points: ChartPoint[];
  onHover?: (point: ChartPoint | null, index: number | null) => void;
}

function AreaChart({ points, onHover }: AreaChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (points.length === 0 || !svgRef.current) return;
      const svg = svgRef.current;
      const rect = svg.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * WIDTH;

      const plotW = WIDTH - PAD.left - PAD.right;
      const ratio = Math.max(0, Math.min(1, (svgX - PAD.left) / plotW));
      const idx = Math.round(ratio * (points.length - 1));
      setHoverIdx(idx);
      onHover?.(points[idx] ?? null, idx);
    },
    [onHover, points],
  );

  const handleMouseLeave = useCallback(() => {
    setHoverIdx(null);
    onHover?.(null, null);
  }, [onHover]);

  if (points.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: 40, color: "var(--text-dim)" }}>No data yet</div>
    );
  }

  const values = points.map((p) => p.value);
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const rangeY = Math.max(maxY - minY, 2);

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const x = (i: number) => PAD.left + (i / Math.max(points.length - 1, 1)) * plotW;
  const y = (v: number) => PAD.top + plotH - ((v - minY) / rangeY) * plotH;

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(" ");

  // Close the area path along the bottom
  const lastX = x(points.length - 1).toFixed(1);
  const firstX = x(0).toFixed(1);
  const bottomY = (PAD.top + plotH).toFixed(1);
  const areaPath = `${linePath} L${lastX},${bottomY} L${firstX},${bottomY} Z`;

  // Y-axis ticks
  const yTicks = 4;
  const yStep = rangeY / yTicks;

  return (
    <svg
      ref={svgRef}
      width="100%"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block", cursor: "crosshair" }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <defs>
        <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--blue)" stopOpacity={0.3} />
          <stop offset="100%" stopColor="var(--blue)" stopOpacity={0.02} />
        </linearGradient>
      </defs>

      {/* Grid lines + Y labels */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = minY + i * yStep;
        return (
          <g key={i}>
            <line
              x1={PAD.left}
              y1={y(val)}
              x2={WIDTH - PAD.right}
              y2={y(val)}
              stroke="var(--border)"
              strokeWidth={0.5}
            />
            <text
              x={PAD.left - 8}
              y={y(val) + 3}
              textAnchor="end"
              fill="var(--text-dim)"
              fontSize={9}
            >
              ${val.toFixed(0)}
            </text>
          </g>
        );
      })}

      {/* X-axis labels */}
      {points.map((p, i) => {
        if (points.length > 10 && i % Math.ceil(points.length / 7) !== 0 && i !== points.length - 1)
          return null;
        return (
          <text
            key={`${p.label}-${i}`}
            x={x(i)}
            y={HEIGHT - 5}
            textAnchor="middle"
            fill="var(--text-dim)"
            fontSize={9}
          >
            {p.label}
          </text>
        );
      })}

      {/* Area fill */}
      <path d={areaPath} fill="url(#equityGradient)" />

      {/* Line */}
      <path d={linePath} fill="none" stroke="var(--blue)" strokeWidth={2} />

      {/* Invisible overlay to capture mouse events across full chart area */}
      <rect
        x={PAD.left}
        y={PAD.top}
        width={plotW}
        height={plotH}
        fill="transparent"
        style={{ pointerEvents: "all" }}
      />

      {/* Crosshair line + dot on hover */}
      {hoverIdx != null && points[hoverIdx] && (
        <g>
          <line
            x1={x(hoverIdx)}
            y1={PAD.top}
            x2={x(hoverIdx)}
            y2={PAD.top + plotH}
            stroke="var(--text-dim)"
            strokeWidth={1}
            strokeDasharray="3,3"
            style={{ pointerEvents: "none" }}
          />
          <circle
            cx={x(hoverIdx)}
            cy={y(points[hoverIdx]!.value)}
            r={4}
            fill="var(--blue)"
            stroke="#fff"
            strokeWidth={2}
            style={{ pointerEvents: "none" }}
          />
        </g>
      )}
    </svg>
  );
}

export function PortfolioChart() {
  const [interval, setIntervalState] = useState<Interval>(
    () => (safeGetItem("portfolio-interval") as Interval) ?? "1d",
  );
  const [mode, setMode] = useState<ChartMode>("portfolio");
  const [hoveredPoint, setHoveredPoint] = useState<ChartPoint | null>(null);

  const { data: portfolio } = usePortfolioSeries(interval);
  const { data: pnlData } = usePnlSeries(INTERVAL_TO_DAYS[interval]);

  useEffect(() => {
    safeSetItem("portfolio-interval", interval);
  }, [interval]);

  useEffect(() => {
    setHoveredPoint(null);
  }, [mode, interval]);

  const points =
    mode === "portfolio"
      ? portfolioToChartPoints(portfolio?.items ?? [], portfolio?.baseline ?? 0)
      : pnlToChartPoints(pnlData?.items ?? []);

  const latestPnl =
    mode === "portfolio"
      ? (portfolio?.portfolioPnl ?? null)
      : pnlData?.items.length
        ? (pnlData.items[pnlData.items.length - 1]?.realizedPnl ?? 0)
        : 0;

  const displayPnl = hoveredPoint ? hoveredPoint.value : latestPnl;
  const displayLabel = hoveredPoint ? hoveredPoint.label : null;

  const handleHover = useCallback((point: ChartPoint | null) => {
    setHoveredPoint(point);
  }, []);

  return (
    <div className="card">
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 8,
        }}
      >
        {/* Left: mode toggle + P/L value */}
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
            <button
              data-testid="mode-portfolio"
              onClick={() => setMode("portfolio")}
              style={{
                ...tabBase,
                fontWeight: mode === "portfolio" ? 700 : 400,
                background: mode === "portfolio" ? "var(--blue)" : "transparent",
                color: mode === "portfolio" ? "#fff" : "var(--text-muted)",
              }}
            >
              Portfolio
            </button>
            <button
              data-testid="mode-realized"
              onClick={() => setMode("realized")}
              style={{
                ...tabBase,
                fontWeight: mode === "realized" ? 700 : 400,
                background: mode === "realized" ? "var(--blue)" : "transparent",
                color: mode === "realized" ? "#fff" : "var(--text-muted)",
              }}
            >
              Realized
            </button>
          </div>
          <div
            data-testid="pnl-value"
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: (displayPnl ?? 0) >= 0 ? "var(--green)" : "var(--red)",
            }}
          >
            {(displayPnl ?? 0) >= 0 ? "+" : "-"}${Math.abs(displayPnl ?? 0).toFixed(2)}
          </div>
          {displayLabel && (
            <div
              data-testid="hover-label"
              style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}
            >
              {displayLabel}
            </div>
          )}
        </div>

        {/* Right: interval tabs */}
        <div style={{ display: "flex", gap: 4 }}>
          {INTERVALS.map((i) => (
            <button
              key={i}
              data-testid={`interval-${i}`}
              onClick={() => setIntervalState(i)}
              style={{
                ...tabBase,
                fontWeight: interval === i ? 700 : 400,
                background: interval === i ? "var(--blue)" : "transparent",
                color: interval === i ? "#fff" : "var(--text-muted)",
              }}
            >
              {i.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <AreaChart points={points} onHover={handleHover} />
    </div>
  );
}
