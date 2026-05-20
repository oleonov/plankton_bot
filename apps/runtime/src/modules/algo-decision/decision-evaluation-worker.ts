import { parentPort } from "node:worker_threads";
import { evaluateDecisionPlan, type DecisionPlanningInput } from "./decision-planner.js";

if (!parentPort) {
  throw new Error("decision-evaluation-worker requires parentPort");
}

parentPort.on("message", (message: unknown) => {
  const parsed = parseWorkerMessage(message);
  if (!parsed) return;
  const { requestId, inputs } = parsed;
  try {
    const results = inputs.map((input) => evaluateDecisionPlan(input));
    parentPort!.postMessage({ requestId, results });
  } catch (err) {
    parentPort!.postMessage({
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

function parseWorkerMessage(
  message: unknown,
): { requestId: number; inputs: readonly DecisionPlanningInput[] } | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as { requestId?: unknown; inputs?: unknown };
  if (typeof candidate.requestId !== "number") return null;
  if (!Array.isArray(candidate.inputs)) return null;
  return {
    requestId: candidate.requestId,
    inputs: candidate.inputs as DecisionPlanningInput[],
  };
}
