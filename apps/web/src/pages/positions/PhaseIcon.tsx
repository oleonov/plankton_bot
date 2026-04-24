import type { PositionPhase } from "../../api/types.ts";

interface Props {
  phase: PositionPhase;
  size?: number;
}

/** 14px SVG glyphs per phase. Uses currentColor so parent `.phase .ic` sets the hue. */
export function PhaseIcon({ phase, size = 14 }: Props) {
  const common = { width: size, height: size, viewBox: "0 0 14 14", fill: "none" };
  if (phase === "S0") {
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  if (phase === "S1") {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M7 1.5L12 11H2L7 1.5Z" fill="currentColor" />
      </svg>
    );
  }
  if (phase === "S2") {
    return (
      <svg {...common} aria-hidden="true">
        <rect x="1.5" y="7" width="3" height="5" fill="currentColor" />
        <rect x="5.5" y="4" width="3" height="8" fill="currentColor" />
        <rect x="9.5" y="1.5" width="3" height="10.5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true">
      <path d="M2 3.5L7 11L12 3.5H2Z" fill="currentColor" />
    </svg>
  );
}
