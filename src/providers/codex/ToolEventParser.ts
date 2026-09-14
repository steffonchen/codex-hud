import { t } from "../../i18n/Messages.js";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ToolEvent } from "../../core/HudEvent.js";
import { redactSummary } from "../../core/Redaction.js";
import { record, type CodexDiagnostic } from "./Diagnostics.js";
import { McpEventParser } from "./McpEventParser.js";

const identifier = (value: unknown): string | undefined => typeof value === "string" && value.trim() && value.length <= 512 ? value : undefined;
const time = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : undefined;
const summary = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? redactSummary(value) : undefined;

function commandText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every(part => typeof part === "string")) return undefined;
  const shell = path.basename(value[0] ?? "");
  return /^(?:ba|z|fi|da|k)?sh$/u.test(shell) && value.some(part => /^-[a-z]*c[a-z]*$/u.test(part))
    ? value.at(-1) : value.join(" ");
}

export function shellSummary(value: unknown): string | undefined {
  const command = commandText(value);
  if (!command) return undefined;
  // 只展示程序及常见任务名；任意命令参数、脚本正文和环境赋值不进入 HUD。
  const clean = command.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)\s+)*/u, "");
  const words = clean.match(/^[^\s;&|<>`]+(?:\s+[^\s;&|<>`]+){0,2}/u)?.[0].split(/\s+/u) ?? [];
  const executable = path.basename(words[0] ?? "").replace(/^["']|["']$/gu, "");
  if (!/^[\p{L}\p{N}_.+-]+$/u.test(executable)) return t("执行命令");
  const task = words[1];
  if (/^(?:npm|pnpm|yarn|bun)$/u.test(executable) && task && /^(?:run|test|build|lint|typecheck|check|install|ci|exec)$/u.test(task)) {
    const script = task === "run" && /^[a-z0-9:_-]+$/iu.test(words[2] ?? "") ? ` ${words[2]}` : "";
    return `${executable} ${task}${script}`;
  }
  if (executable === "git" && task && /^(?:status|diff|log|show|rev-parse|ls-files)$/u.test(task)) return `git ${task}`;
  return redactSummary(executable + (clean.length > (words[0]?.length ?? 0) ? " …" : ""));
}

function commandSummary(item: Record<string, unknown>): { toolType: string; inputSummary?: string } {
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map(record).filter(value => value !== undefined) : [];
  const entry = parsed.find(value => value.type === "search") ?? parsed.find(value => value.type === "read")
    ?? parsed.find(value => value.type === "list_files");
  if (entry?.type === "read") return { toolType: "read", inputSummary: summary(entry.path) ?? summary(entry.name) ?? t("读取文件") };
  if (entry?.type === "search" || entry?.type === "list_files") {
    return { toolType: "search", inputSummary: summary(entry.path) ?? summary(entry.query) ?? t("搜索文件") };
  }
  return { toolType: "shell", inputSummary: shellSummary(item.command) };
}

function outputTexts(value: unknown): string[] {
  if (typeof value === "string") return [value.slice(0, 4096)];
  return Array.isArray(value) ? value.slice(0, 32).flatMap(block => {
    const item = record(block);
    return item?.type === "input_text" && typeof item.text === "string" ? [item.text.slice(0, 4096)] : [];
  }) : [];
}

export class ToolEventParser {
  private readonly mcp = new McpEventParser();
  parse(root: Record<string, unknown>, at: number | undefined, line: string, lineNumber?: number): {
    events: ToolEvent[]; detected: boolean; diagnostics: CodexDiagnostic[];
  } {
    const result: { events: ToolEvent[]; detected: boolean; diagnostics: CodexDiagnostic[] } = { events: [], detected: false, diagnostics: [] };
    const payload = record(root.payload);
    if (!payload) return result;
    const warning = (field: string) => result.diagnostics.push({ code: "unknown-tool-field", severity: "warning",
      message: t("工具字段 {0} 缺失或无法识别；仅保留已确认的信息", field), line: lineNumber });
    const stableId = (value: unknown) => {
      const id = identifier(value);
      if (id) return id;
      warning("id");
      return `event-${createHash("sha256").update(line).digest("hex").slice(0, 24)}`;
    };

    if (root.type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
      result.detected = true;
      const name = identifier(payload.name);
      if (!name) warning("name");
      const namespace = identifier(payload.namespace);
      const wrapper = payload.type === "custom_tool_call" && name === "exec";
      let args: Record<string, unknown> | undefined;
      if (typeof payload.arguments === "string" && payload.arguments.length <= 128 * 1024) {
        try { args = record(JSON.parse(payload.arguments)); }
        catch { warning("arguments"); }
      }
      const normalized: ToolEvent = { type: "tool-started", toolId: stableId(payload.call_id ?? payload.id),
        name: summary(namespace ? `${namespace}.${name ?? t("未知工具")}` : name) ?? t("未知工具"),
        toolType: wrapper ? "wrapper" : "unknown", at,
        turnId: identifier(record(payload.internal_chat_message_metadata_passthrough)?.turn_id),
        inputSummary: wrapper ? t("工具调用") : summary(name) };
      // call item 的 completed 表示模型已生成调用，执行结果必须等待 *_output。
      if (name === "wait" && identifier(args?.cell_id)) normalized.continuationId = `cell:${args!.cell_id}`;
      result.events.push(normalized);
    } else if (root.type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
      result.detected = true;
      const texts = outputTexts(payload.output);
      const yielded = /^Script running with cell ID ([a-z0-9_-]+)(?:\s|$)/iu.exec(texts[0] ?? "");
      result.events.push({ type: yielded ? "tool-updated" : "tool-completed", toolId: stableId(payload.call_id ?? payload.id), at,
        resultSource: "call",
        turnId: identifier(record(payload.internal_chat_message_metadata_passthrough)?.turn_id),
        continuationId: yielded ? `cell:${yielded[1]}` : undefined,
        outputSummary: yielded ? t("执行尚未结束") : t("已返回工具结果") });
    } else if (root.type === "event_msg" && payload.type === "item_completed") {
      const item = record(payload.item);
      if (!item || !["CommandExecution", "FileChange", "McpToolCall"].includes(String(item.type))) return result;
      result.detected = true;
      const end = time(payload.completed_at_ms) ?? at;
      const start = time(payload.started_at_ms);
      let type: ToolEvent["type"] = item.status === "failed" ? "tool-failed" : item.status === "completed" ? "tool-completed" : "tool-unknown";
      if (type === "tool-unknown") warning("item.status");
      const common: ToolEvent = { type, toolId: stableId(item.id), at: end, startedAt: start, turnId: identifier(payload.turn_id), resultSource: "execution" };
      if (item.type === "CommandExecution") {
        const exitCode = typeof item.exit_code === "number" && Number.isSafeInteger(item.exit_code) ? item.exit_code : undefined;
        if (exitCode !== undefined && exitCode !== 0) common.type = "tool-failed";
        else if (exitCode === undefined && common.type === "tool-completed") { common.type = "tool-unknown"; warning("item.exit_code"); }
        const duration = record(item.duration);
        if (Number.isSafeInteger(duration?.secs) && Number.isSafeInteger(duration?.nanos)
          && (duration!.secs as number) >= 0 && (duration!.nanos as number) >= 0 && (duration!.nanos as number) < 1_000_000_000) {
          common.durationMs = time((duration!.secs as number) * 1000 + (duration!.nanos as number) / 1_000_000);
        }
        Object.assign(common, { name: "shell", ...commandSummary(item),
          outputSummary: exitCode === undefined ? t("退出码未确认") : t("退出码 {0}", exitCode),
          error: common.type === "tool-failed" ? exitCode === undefined ? t("命令执行失败") : t("退出码 {0}", exitCode) : undefined });
      } else if (item.type === "FileChange") {
        const changes = record(item.changes);
        const files = changes ? Object.keys(changes) : [];
        if (!changes) warning("item.changes");
        common.name = "apply_patch";
        common.toolType = "edit";
        common.inputSummary = files.length ? `${redactSummary(files[0], 200)}${files.length > 1 ? t(" 等 {0} 个文件", files.length) : ""}` : t("文件修改");
        common.outputSummary = common.type === "tool-completed" ? changes ? t("已修改 {0} 个文件", files.length) : t("文件修改已完成，数量未确认") : t("文件修改结果未确认");
        if (common.type === "tool-failed") common.error = t("文件修改失败");
      } else {
        const reference = this.mcp.parse(item);
        common.mcp = reference;
        common.toolType = reference ? "mcp" : "unknown";
        if (reference) {
          common.name = `${reference.serverName}.${reference.toolName}`;
          common.inputSummary = `MCP ${common.name}`;
        }
        if (record(item.result)?.isError === true) common.type = "tool-failed";
        const duration = record(item.duration);
        if (Number.isSafeInteger(duration?.secs) && Number.isSafeInteger(duration?.nanos)
          && (duration!.secs as number) >= 0 && (duration!.nanos as number) >= 0 && (duration!.nanos as number) < 1_000_000_000) {
          common.durationMs = time((duration!.secs as number) * 1000 + (duration!.nanos as number) / 1_000_000);
        }
        common.outputSummary = common.type === "tool-failed" ? t("外部工具执行失败") : t("已收到外部工具结果");
        if (common.type === "tool-failed") common.error = t("外部工具执行失败");
      }
      result.events.push(common);
    }
    return result;
  }
}
