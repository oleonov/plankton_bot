import { createConditionId } from "@krabs/domain";

import type {
  ExecutionProfileStateRecord,
  Profile,
  ProfileReduction,
  ProfileState,
  ReducerEvent,
} from "./types.js";

const TERMINAL_STATES = new Set<ProfileState>(["ABANDONED", "CLOSED"]);

export function reduceProfileState(
  current: ExecutionProfileStateRecord | null,
  event: ReducerEvent,
): ProfileReduction {
  const to = nextState(current?.state ?? null, event.type);
  if (to == null) {
    return {
      next: current,
      transition: null,
      effects: [],
      rejected: true,
      rejectionReason: "invalid_transition",
    };
  }
  if (current?.state === to) {
    return { next: current, transition: null, effects: [], rejected: false };
  }

  const occurredAt = new Date(event.occurredAtMs).toISOString();
  const next =
    current == null
      ? createInitialState(event, to, occurredAt)
      : updateState(current, to, occurredAt);
  return {
    next,
    transition: {
      from: current?.state ?? null,
      to,
      occurredAt,
    },
    effects: [
      {
        type: "persist_state",
        name: "execution_profile_state",
        payload: { tokenId: event.tokenId, state: to },
      },
      {
        type: "publish_event",
        name: "profile_state_changed",
        payload: { tokenId: event.tokenId, from: current?.state ?? null, to },
      },
      {
        type: "increment_counter",
        name: "track_execution_profile_state_transition",
        payload: { from: current?.state ?? "null", to },
      },
    ],
    rejected: false,
  };
}

function nextState(
  current: ProfileState | null,
  eventType: ReducerEvent["type"],
): ProfileState | null {
  if (
    current === "ABANDONED_DORMANT" &&
    eventType !== "qd_handoff_started" &&
    eventType !== "position_closed" &&
    eventType !== "position_settled"
  ) {
    return null;
  }
  if (
    current != null &&
    TERMINAL_STATES.has(current) &&
    eventType !== "position_closed" &&
    eventType !== "position_settled"
  ) {
    return null;
  }
  switch (eventType) {
    case "position_adopted":
      return current == null || current === "SCANNING" ? "EXITING" : null;
    case "buy_fill_received":
      if (current == null || current === "SCANNING") return "PROBING";
      if (current === "PROBING") return "ACCUMULATING";
      if (current === "ACCUMULATING") return "ACCUMULATING";
      if (current === "HARVESTING") return "HARVESTING";
      return null;
    case "harvest_lifecycle_activated":
      if (current === "PROBING" || current === "ACCUMULATING" || current === "HARVESTING") {
        return "HARVESTING";
      }
      return null;
    case "sell_lifecycle_activated":
      return current === "PROBING" || current === "ACCUMULATING" || current === "HARVESTING"
        ? "EXITING"
        : null;
    case "qd_handoff_started":
      return current === "PROBING" ||
        current === "ACCUMULATING" ||
        current === "HARVESTING" ||
        current === "EXITING" ||
        current === "ABANDONED_DORMANT"
        ? "QD_HANDOFF"
        : null;
    case "abandonment_triggered":
      return current === "PROBING" || current === "ACCUMULATING" || current === "HARVESTING"
        ? "ABANDONED_DORMANT"
        : null;
    case "position_closed":
    case "position_settled":
      return current === "CLOSED" ? "CLOSED" : "CLOSED";
  }
}

function createInitialState(
  event: ReducerEvent,
  state: ProfileState,
  occurredAt: string,
): ExecutionProfileStateRecord {
  const payload = event.payload ?? {};
  return {
    tokenId: event.tokenId,
    conditionId: createConditionId(stringPayload(payload.conditionId, "")),
    profile: profilePayload(payload.profile, "medium"),
    state,
    assumedAt: occurredAt,
    lastAvgEntry: numberPayload(payload.avgEntry, 0),
    lastTransitionAt: occurredAt,
    activeLadderId: stringPayload(payload.activeLadderId, null),
    handoffStartedAt: state === "QD_HANDOFF" ? occurredAt : null,
    addCount: numberPayload(payload.addCount, 0),
    lastBuyAtMs: numberOrNullPayload(payload.lastBuyAtMs),
    initialProbeSizeUsd: numberOrNullPayload(payload.initialProbeSizeUsd),
    metadata: objectPayload(payload.metadata),
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function updateState(
  current: ExecutionProfileStateRecord,
  state: ProfileState,
  occurredAt: string,
): ExecutionProfileStateRecord {
  return {
    ...current,
    state,
    lastTransitionAt: occurredAt,
    handoffStartedAt:
      state === "QD_HANDOFF" ? (current.handoffStartedAt ?? occurredAt) : current.handoffStartedAt,
    updatedAt: occurredAt,
  };
}

function stringPayload(value: unknown, fallback: string): string;
function stringPayload(value: unknown, fallback: string | null): string | null;
function stringPayload(value: unknown, fallback: string | null): string | null {
  return typeof value === "string" ? value : fallback;
}

function numberPayload(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNullPayload(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function profilePayload(value: unknown, fallback: Profile): Profile {
  return value === "cheap" || value === "medium" || value === "expensive" ? value : fallback;
}

function objectPayload(value: unknown): Readonly<Record<string, unknown>> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
