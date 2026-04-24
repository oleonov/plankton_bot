import { useEffect, useState } from "react";
import type { Density, GroupBy } from "./lib.ts";
import type { Tweaks } from "./useTweaks.ts";

interface Props {
  tweaks: Tweaks;
  onUpdate: (patch: Partial<Tweaks>) => void;
}

const DENSITIES: Density[] = ["compact", "default", "spacious"];
const GROUPS: Array<[GroupBy, string]> = [
  ["lastAction", "Action"],
  ["phase", "Phase"],
  ["pnl", "PnL"],
  ["ends", "Ends"],
];

export function TweaksPanel({ tweaks, onUpdate }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="p2-tweaksFab"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="p2-tweaks-panel"
      >
        Tweaks
      </button>

      {open && (
        <div id="p2-tweaks-panel" className="p2-tweaks" role="dialog" aria-label="Tweaks">
          <header>
            <div className="p2-t">Tweaks</div>
            <button
              type="button"
              className="p2-close"
              onClick={() => setOpen(false)}
              aria-label="Close tweaks"
            >
              ×
            </button>
          </header>
          <div className="p2-sec">
            <div className="p2-lbl">Density</div>
            <div className="p2-seg" role="group" aria-label="Density">
              {DENSITIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={tweaks.density === d ? "on" : ""}
                  onClick={() => onUpdate({ density: d })}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div className="p2-sec">
            <div className="p2-lbl">Group by</div>
            <div className="p2-seg" role="group" aria-label="Group by">
              {GROUPS.map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  className={tweaks.groupBy === k ? "on" : ""}
                  onClick={() => onUpdate({ groupBy: k })}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="p2-sec">
            <div className="p2-lbl">Display</div>
            <label className="p2-check">
              <input
                type="checkbox"
                checked={tweaks.showPhaseBuyCount}
                onChange={(e) => onUpdate({ showPhaseBuyCount: e.target.checked })}
              />
              Phase buy-count dots
            </label>
            <label className="p2-check">
              <input
                type="checkbox"
                checked={tweaks.showPnLPercent}
                onChange={(e) => onUpdate({ showPnLPercent: e.target.checked })}
              />
              PnL % under $
            </label>
            <label className="p2-check">
              <input
                type="checkbox"
                checked={tweaks.hideClosedByDefault}
                onChange={(e) => onUpdate({ hideClosedByDefault: e.target.checked })}
              />
              Hide CLOSED by default
            </label>
            <label className="p2-check">
              <input
                type="checkbox"
                checked={tweaks.hideDust}
                onChange={(e) => onUpdate({ hideDust: e.target.checked })}
              />
              Hide dust positions
            </label>
          </div>
        </div>
      )}
    </>
  );
}
