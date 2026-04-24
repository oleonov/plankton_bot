import { useCallback, useEffect, useState } from "react";
import type { Density, GroupBy } from "./lib.ts";

export interface Tweaks {
  density: Density;
  groupBy: GroupBy;
  showPhaseBuyCount: boolean;
  showPnLPercent: boolean;
  hideClosedByDefault: boolean;
  hideDust: boolean;
}

export const TWEAKS_STORAGE_KEY = "plankton.positions.tweaks.v1";

export const DEFAULT_TWEAKS: Tweaks = {
  density: "default",
  groupBy: "lastAction",
  showPhaseBuyCount: false,
  showPnLPercent: true,
  hideClosedByDefault: false,
  hideDust: false,
};

function readStored(): Tweaks {
  if (typeof window === "undefined") return DEFAULT_TWEAKS;
  try {
    const raw = window.localStorage.getItem(TWEAKS_STORAGE_KEY);
    if (!raw) return DEFAULT_TWEAKS;
    const parsed = JSON.parse(raw) as Partial<Tweaks>;
    return { ...DEFAULT_TWEAKS, ...parsed };
  } catch {
    return DEFAULT_TWEAKS;
  }
}

function writeStored(next: Tweaks): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TWEAKS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // quota / disabled storage — ignore
  }
}

export function useTweaks(): [Tweaks, (patch: Partial<Tweaks>) => void] {
  const [tweaks, setTweaks] = useState<Tweaks>(() => readStored());

  useEffect(() => {
    writeStored(tweaks);
  }, [tweaks]);

  const update = useCallback((patch: Partial<Tweaks>) => {
    setTweaks((prev) => ({ ...prev, ...patch }));
  }, []);

  return [tweaks, update];
}
