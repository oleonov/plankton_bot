import type { PnlDataPoint } from "../api/types.ts";

const WIDTH = 700;
const HEIGHT = 200;
const PAD = { top: 20, right: 80, bottom: 30, left: 60 };

export function PnlChart({ data, tailCostUsdc }: { data: PnlDataPoint[]; tailCostUsdc: number }) {
  if (data.length === 0) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--text-dim)" }}>
        No PnL data yet
      </div>
    );
  }

  const values = data.map((d) => d.realizedPnl);
  const minY = Math.min(0, ...values);
  const maxY = Math.max(0, ...values);
  const rangeY = maxY - minY || 1;

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const x = (i: number) => PAD.left + (i / Math.max(data.length - 1, 1)) * plotW;
  const y = (v: number) => PAD.top + plotH - ((v - minY) / rangeY) * plotH;

  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(d.realizedPnl)}`)
    .join(" ");

  // Tail cost annotation at right edge
  const lastPnl = values[values.length - 1]!;
  const tailAdjusted = lastPnl - tailCostUsdc;
  const tailY = y(tailAdjusted);

  // Y-axis ticks
  const yTicks = 5;
  const yStep = rangeY / yTicks;

  return (
    <div className="card">
      <div className="label" style={{ marginBottom: 8 }}>
        Cumulative Realized PnL (14d)
      </div>
      <svg width={WIDTH} height={HEIGHT} style={{ display: "block" }}>
        {/* Grid lines */}
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
        {data.map((d, i) => {
          if (data.length > 10 && i % Math.ceil(data.length / 7) !== 0 && i !== data.length - 1)
            return null;
          return (
            <text
              key={d.date}
              x={x(i)}
              y={HEIGHT - 5}
              textAnchor="middle"
              fill="var(--text-dim)"
              fontSize={9}
            >
              {d.date.slice(5)}
            </text>
          );
        })}

        {/* PnL line */}
        <path d={linePath} fill="none" stroke="var(--green)" strokeWidth={2} />

        {/* Tail cost annotation */}
        {tailCostUsdc > 0 && (
          <>
            <line
              x1={x(data.length - 1) - 20}
              y1={tailY}
              x2={WIDTH - PAD.right}
              y2={tailY}
              stroke="var(--orange)"
              strokeWidth={1}
              strokeDasharray="4,3"
            />
            <text x={WIDTH - PAD.right + 4} y={tailY + 3} fill="var(--orange)" fontSize={9}>
              tail-adj: ${tailAdjusted.toFixed(0)}
            </text>
            <text x={WIDTH - PAD.right + 4} y={y(lastPnl) + 3} fill="var(--green)" fontSize={9}>
              realized: ${lastPnl.toFixed(0)}
            </text>
          </>
        )}

        {/* Legend (top-right) */}
        <g transform={`translate(${WIDTH - PAD.right - 120}, ${PAD.top})`}>
          <line x1={0} y1={0} x2={16} y2={0} stroke="var(--green)" strokeWidth={2} />
          <text x={20} y={4} fill="var(--text-muted)" fontSize={9}>
            Realized PnL
          </text>
          {tailCostUsdc > 0 && (
            <>
              <line
                x1={0}
                y1={14}
                x2={16}
                y2={14}
                stroke="var(--orange)"
                strokeWidth={1}
                strokeDasharray="4,3"
              />
              <text x={20} y={18} fill="var(--text-muted)" fontSize={9}>
                Tail-adjusted (today)
              </text>
            </>
          )}
        </g>
      </svg>
    </div>
  );
}
