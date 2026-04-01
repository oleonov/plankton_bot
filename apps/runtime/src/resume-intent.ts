const RESUME_INTENT_TTL_MS = 15 * 60 * 1000;

export interface ResumeIntentInput {
  intentAt: string | null;
  nowMs: number;
  hasActiveSwitch: boolean;
  desiredProfile: string | null;
  activeProfile: string;
}

export type ResumeIntentResult =
  | { action: "resume"; ageMs: number }
  | { action: "stay_paused"; reason: string; ageMs?: number }
  | { action: "no_intent" };

export function evaluateResumeIntent(input: ResumeIntentInput): ResumeIntentResult {
  if (!input.intentAt) return { action: "no_intent" };

  const ageMs = input.nowMs - new Date(input.intentAt).getTime();

  if (ageMs >= RESUME_INTENT_TTL_MS) {
    return { action: "stay_paused", reason: "intent expired", ageMs };
  }
  if (input.hasActiveSwitch) {
    return { action: "stay_paused", reason: "active profile switch in progress", ageMs };
  }
  if (input.desiredProfile && input.desiredProfile !== input.activeProfile) {
    return { action: "stay_paused", reason: "profile mismatch", ageMs };
  }

  return { action: "resume", ageMs };
}
