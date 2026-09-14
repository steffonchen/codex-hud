import { readFile } from "node:fs/promises";
import type { NormalizedPlanEvent, PlanEventMetadata } from "../src/core/PlanEvents.js";
import type { PlanStepStatus } from "../src/core/PlanState.js";
import { PlanTracker } from "../src/core/PlanTracker.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { RolloutEventParser } from "../src/providers/codex/RolloutEventParser.js";

export const planMeta = (ordinal = 1, overrides: Partial<PlanEventMetadata> = {}): PlanEventMetadata => ({
  eventId: `plan-test-${ordinal}`, threadId: "thread-a", turnId: "turn-a", source: "rollout", ordinal, at: ordinal * 1000, ...overrides,
});

export function planUpdate(ordinal = 1, statuses: PlanStepStatus[] = ["completed", "in_progress", "pending"]): NormalizedPlanEvent {
  return { ...planMeta(ordinal), type: "plan-updated", steps: statuses.map((status, index) => ({ title: `步骤 ${index + 1}`, status })) };
}

export function planState(statuses?: PlanStepStatus[]) {
  const tracker = new PlanTracker();
  tracker.apply(planUpdate(1, statuses));
  return { planSummary: tracker.getSummary() };
}

export const planFixture = (name: string): Promise<string> => readFile(new URL(`./fixtures/plan/${name}.jsonl`, import.meta.url), "utf8");

export function replayPlan(source: string) {
  const parser = new RolloutEventParser();
  const reducer = new HudStateReducer();
  const results = source.trimEnd().split("\n").map((line, index) => parser.parse(line, index + 1));
  for (const result of results) for (const event of result.events) reducer.apply(event);
  return { parser, reducer, state: reducer.getState(0), events: results.flatMap(result => result.events), diagnostics: results.flatMap(result => result.diagnostics) };
}
