import { redactSummary } from "../../core/Redaction.js";
import { record } from "./Diagnostics.js";

export const agentIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value) ? value : undefined;

export interface AgentMetadata {
  id: string;
  cwd?: string;
  version?: string;
  subagent: boolean;
  taskAgent: boolean;
  parentId?: string;
  sessionId?: string;
  name?: string;
  agentPath?: string;
  agentType?: string;
  relationConflict: boolean;
}

export function parseAgentMetadata(payload: Record<string, unknown>): AgentMetadata | undefined {
  const id = agentIdentifier(payload.id);
  if (!id) return undefined;
  const source = record(payload.source);
  const spawn = record(record(source?.subagent)?.thread_spawn);
  const topParent = agentIdentifier(payload.parent_thread_id);
  const nestedParent = agentIdentifier(spawn?.parent_thread_id);
  const conflict = !!topParent && !!nestedParent && topParent !== nestedParent;
  const clean = (value: unknown, max = 80) => typeof value === "string" && value.trim() ? redactSummary(value, max) : undefined;
  const agentPath = clean(payload.agent_path ?? spawn?.agent_path, 240);
  const taskAgent = !!spawn || payload.thread_source === "subagent";
  return { id, cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    version: clean(payload.cli_version),
    subagent: payload.parent_thread_id != null || payload.source === "subagent" || payload.thread_source === "subagent"
      || Object.hasOwn(source ?? {}, "subagent") || Object.hasOwn(record(payload.thread_source) ?? {}, "subagent"),
    taskAgent: taskAgent && payload.thread_source !== "guardian_review",
    parentId: conflict ? undefined : topParent ?? nestedParent,
    sessionId: agentIdentifier(payload.session_id), relationConflict: conflict,
    agentPath, name: agentPath?.split("/").filter(Boolean).at(-1) ?? clean(payload.agent_nickname ?? spawn?.agent_nickname),
    agentType: clean(payload.agent_role ?? spawn?.agent_role) };
}
