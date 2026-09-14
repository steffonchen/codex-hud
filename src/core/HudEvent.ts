import type { HudState, TokenUsage } from "./HudState.js";
import type { NormalizedAgentEvent } from "./AgentEvents.js";
import type { McpToolReference } from "./McpToolState.js";
import type { SkillCatalogEntry } from "./SkillState.js";
import type { NormalizedPlanEvent } from "./PlanEvents.js";
import type { TokenSnapshotEvent } from "./usage/UsageState.js";
import type { EventMetadata } from "./source/DataSource.js";

export interface ToolEvent {
  type: "tool-started" | "tool-updated" | "tool-completed" | "tool-failed" | "tool-cancelled" | "tool-unknown";
  toolId: string;
  name?: string;
  toolType?: string;
  at?: number;
  startedAt?: number;
  durationMs?: number;
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
  turnId?: string;
  status?: "pending" | "running";
  continuationId?: string;
  resultSource?: "call" | "execution";
  mcp?: McpToolReference;
}

export type HudEvent = EventMetadata & (ToolEvent | NormalizedAgentEvent | NormalizedPlanEvent | ({ at?: number } & (
  | { type: "skills-listed"; skills: SkillCatalogEntry[] }
  | { type: "session"; id: string; startedAt?: number; version?: string }
  | { type: "model"; model?: string; reasoningEffort?: string; ordinal?: number }
  | { type: "turn-started"; id?: string; contextWindow?: number }
  | { type: "turn-completed" | "turn-aborted"; id?: string }
  | ({ type: "tokens" } & TokenSnapshotEvent)
  | { type: "context-compacted"; ordinal?: number }
  | { type: "quota"; quota?: HudState["quota"]; ordinal?: number }
  | { type: "activity" }
)));
