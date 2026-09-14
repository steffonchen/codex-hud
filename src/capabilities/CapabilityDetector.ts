import { t } from "../i18n/Messages.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HudState } from "../core/HudState.js";
import { ModuleRegistry } from "../renderer/modules/ModuleRegistry.js";
import { plainText } from "../renderer/WidthPolicy.js";
import { redactText } from "../core/Redaction.js";
import { hasUsableAppServer, type CodexSessionSnapshot } from "../providers/codex/CodexSessionProvider.js";

const execute = promisify(execFile);

export type ProtocolSchemas = Record<string, unknown>;

export interface CodexProbe {
  version?: string;
  schemas?: ProtocolSchemas;
  diagnostics: string[];
}

export interface ModuleCapability {
  id: string;
  available: boolean;
  protocolSupported: boolean | null;
  reason?: string;
  evidence: string[];
}

export interface CapabilityReport {
  source: "mock" | "rollout" | "app-server" | "discovery" | "none";
  codexVersion?: string;
  modules: ModuleCapability[];
  diagnostics: string[];
}

const schemaFiles = [
  "ClientRequest.json", "ServerNotification.json", "v2/ThreadReadResponse.json",
  "v2/ModelListResponse.json", "v2/GetAccountRateLimitsResponse.json",
  "v2/ListMcpServerStatusResponse.json", "v2/SkillsListResponse.json",
  "v2/GetAccountTokenUsageResponse.json",
];

const responseMethods: Record<string, string> = {
  "v2/ThreadReadResponse.json": "thread/read",
  "v2/ModelListResponse.json": "model/list",
  "v2/GetAccountRateLimitsResponse.json": "account/rateLimits/read",
  "v2/ListMcpServerStatusResponse.json": "mcpServerStatus/list",
  "v2/SkillsListResponse.json": "skills/list",
  "v2/GetAccountTokenUsageResponse.json": "account/usage/read",
};

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function methods(schema: unknown): Set<string> {
  return new Set(array(object(schema).oneOf).flatMap(variant => {
    const method = object(object(object(variant).properties).method);
    return [...array(method.enum), method.const].filter((value): value is string => typeof value === "string");
  }));
}

function definition(schema: unknown, name: string): unknown {
  return object(object(schema).definitions)[name];
}

function hasFields(value: unknown, ...fields: string[]): boolean {
  const properties = object(object(value).properties);
  return fields.every(field => Object.hasOwn(properties, field));
}

function hasVariant(value: unknown, name: string): boolean {
  return array(object(value).oneOf).some(variant => {
    const type = object(object(object(variant).properties).type);
    return type.const === name || array(type.enum).includes(name);
  });
}

export function inspectProtocol(schemas: ProtocolSchemas): Record<string, { supported: boolean; evidence: string[] }> {
  const requests = methods(schemas["ClientRequest.json"]);
  const notificationsSchema = schemas["ServerNotification.json"];
  const notifications = methods(notificationsSchema);
  const thread = definition(schemas["v2/ThreadReadResponse.json"], "Thread");
  const model = definition(schemas["v2/ModelListResponse.json"], "Model");
  const tokenUsage = definition(notificationsSchema, "ThreadTokenUsage");
  const tokenBreakdown = definition(notificationsSchema, "TokenUsageBreakdown");
  const items = definition(notificationsSchema, "ThreadItem");
  const tokens = notifications.has("thread/tokenUsage/updated");
  const itemLifecycle = notifications.has("item/started") && notifications.has("item/completed");
  const quota = requests.has("account/rateLimits/read") && hasFields(
    definition(schemas["v2/GetAccountRateLimitsResponse.json"], "RateLimitWindow"), "usedPercent", "windowDurationMins",
  );
  const capability = (supported: boolean, ...evidence: string[]) => ({ supported, evidence: supported ? evidence : [] });

  return {
    model: capability(
      (requests.has("thread/read") && hasFields(thread, "model")) || (requests.has("model/list") && hasFields(model, "model")),
      t("thread/read 或 model/list：模型字段"),
    ),
    reasoning: capability(
      (requests.has("thread/read") && hasFields(thread, "reasoningEffort"))
        || (requests.has("model/list") && hasFields(model, "defaultReasoningEffort")),
      t("thread/read 或 model/list：推理强度字段"),
    ),
    context: capability(tokens && hasFields(tokenUsage, "last", "modelContextWindow") && hasFields(tokenBreakdown, "totalTokens"),
      t("thread/tokenUsage/updated：last.totalTokens、modelContextWindow；尚未验证实时上下文计算语义")),
    "five-hour-usage": capability(quota, t("account/rateLimits/read：按 windowDurationMins=300 区分窗口；未查询账户")),
    "weekly-usage": capability(quota, t("account/rateLimits/read：按 windowDurationMins=10080 区分窗口；未查询账户")),
    agents: capability(itemLifecycle && (hasVariant(items, "collabAgentToolCall") || hasVariant(items, "subAgentActivity")),
      t("item/started、item/completed：子代理活动变体")),
    tools: capability(itemLifecycle && hasVariant(items, "commandExecution"), t("item/started、item/completed：工具生命周期")),
    "current-activity": capability(notifications.has("thread/status/changed")
      && hasFields(definition(notificationsSchema, "ThreadStatusChangedNotification"), "status"), "thread/status/changed"),
    plan: capability(notifications.has("turn/plan/updated")
      && hasFields(definition(notificationsSchema, "TurnPlanUpdatedNotification"), "plan")
      && hasFields(definition(notificationsSchema, "TurnPlanStep"), "step", "status"), t("turn/plan/updated：结构化步骤通知")),
    session: capability(requests.has("thread/read") && hasFields(thread, "id", "createdAt"), t("thread/read：任务 ID、创建时间")),
    mcp: capability(requests.has("mcpServerStatus/list")
      && hasFields(definition(schemas["v2/ListMcpServerStatusResponse.json"], "McpServerStatus"), "name", "tools"), "mcpServerStatus/list"),
    skills: capability(requests.has("skills/list")
      && hasFields(definition(schemas["v2/SkillsListResponse.json"], "SkillMetadata"), "name", "enabled"), "skills/list"),
    "token-details": capability(tokens && hasFields(tokenBreakdown, "inputTokens", "outputTokens"), "thread/tokenUsage/updated：TokenUsageBreakdown"),
    cost: capability(requests.has("account/usage/read")
      && hasFields(definition(schemas["v2/GetAccountTokenUsageResponse.json"], "ThreadUsage"), "estimatedUsageUsdMicros"),
      t("account/usage/read：可空的 estimatedUsageUsdMicros；未查询账户")),
    cache: capability(tokens && hasFields(tokenBreakdown, "cachedInputTokens"), "thread/tokenUsage/updated：cachedInputTokens"),
  };
}

export async function readProtocolSchemas(directory: string): Promise<ProtocolSchemas> {
  const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(path.join(directory, file), "utf8"));
  const roots = await Promise.all(schemaFiles.slice(0, 2).map(async file => {
    try {
      const schema = await read(file);
      if (!Array.isArray(object(schema).oneOf)) throw new Error(t("无法识别协议根结构，缺少 oneOf"));
      return [file, schema] as const;
    } catch (error) {
      throw new Error(t("无法读取 Codex 协议定义：{0}；{1}", file, error instanceof Error ? error.message : String(error)), { cause: error });
    }
  }));
  const requests = methods(roots[0][1]);
  const responses = await Promise.all(schemaFiles.slice(2).map(async file => {
    try {
      return [file, await read(file)] as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !requests.has(responseMethods[file])) return [file, {}] as const;
      throw new Error(t("协议已声明 {0}，但其定义文件无法读取：{1}；{2}", responseMethods[file], file, error instanceof Error ? error.message : String(error)), { cause: error });
    }
  }));
  return Object.fromEntries([...roots, ...responses]);
}

export function diagnosticText(value: string): string {
  return plainText(redactText(value)).slice(0, 1500);
}

export async function probeCodex(): Promise<CodexProbe> {
  const result: CodexProbe = { diagnostics: [] };
  let directory: string | undefined;
  let step = t("读取版本");
  try {
    const version = await execute("codex", ["--version"], { timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8" });
    result.version = plainText(version.stdout);
    if (!result.version) throw new Error(t("Codex 没有返回版本信息"));
    step = t("创建能力检测临时目录");
    directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-capabilities-"));
    step = t("导出协议 schema");
    // 仅运行离线协议导出命令，不建立 app-server 连接，也不读取会话或账户数据。
    await execute("codex", ["app-server", "generate-json-schema", "--out", directory], {
      timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8",
    });
    result.schemas = await readProtocolSchemas(directory);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string };
    if (failure.code === "ENOENT" && failure.syscall?.startsWith("spawn")) result.diagnostics.push(t("未找到 Codex CLI，请确认 codex 已安装并位于 PATH 中"));
    else if (failure.killed) result.diagnostics.push(t("Codex {0}超时，相关能力无法确认", step));
    else {
      const detail = diagnosticText(failure.stderr?.trim() || failure.message);
      result.diagnostics.push(t("Codex {0}失败{1}：{2}", step, failure.code === undefined ? "" : `（${failure.code}）`, detail));
    }
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        result.diagnostics.push(t("无法清理协议检测临时目录：{0}（{1}）", directory, (error as NodeJS.ErrnoException).code ?? t("未知错误")));
      }
    }
  }
  return result;
}

export class CapabilityDetector {
  constructor(private readonly probe: () => Promise<CodexProbe> = probeCodex) {}

  detectRollout(snapshot: CodexSessionSnapshot, registry = new ModuleRegistry()): CapabilityReport {
    const supported = new Set(["model", "reasoning", "context", "session", "token-details", "five-hour-usage", "weekly-usage", "tools", "current-activity", "agents"]);
    const readable = snapshot.read.status === "ready" || hasUsableAppServer(snapshot);
    const source = snapshot.state.dataSources?.active === "app-server" ? "app-server" : "rollout";
    const modules = registry.all().map((module): ModuleCapability => {
      if (module.id === "runtime-status") {
        const available = module.isAvailable(snapshot.state);
        return { id: module.id, available, protocolSupported: null, reason: available ? undefined : t("尚无运行时或历史来源状态"),
          evidence: available ? [t("缓存的来源与运行时状态；渲染不发起发现或探测")] : [] };
      }
      if (module.id === "mcp" || module.id === "skills") {
        const available = module.isAvailable(snapshot.state);
        const detected = module.id === "mcp" ? snapshot.state.mcpSummary : snapshot.state.skillSummary;
        return { id: module.id, available: !!detected && available, protocolSupported: null,
          reason: detected && available ? undefined : module.id === "mcp" ? t("未配置 MCP，当前会话也未观测到服务") : t("尚未发现技能目录或当前任务技能清单"),
          evidence: detected && available ? [module.id === "mcp" ? t("配置及明确的 MCP 调用元数据；不代表连接成功") : t("技能定义与当前任务目录；不代表已加载或活动")] : [] };
      }
      if (module.id === "agents") {
        const observed = readable && snapshot.state.agentSummary?.capability.eventSupport === true;
        const configured = snapshot.runtime.agentFeatureEnabled === true;
        return { id: module.id, available: observed || configured, protocolSupported: null,
          reason: observed || configured ? undefined : snapshot.runtime.agentFeatureEnabled === false
            ? t("CLI 多代理已关闭，当前尚未检测到代理事件") : t("尚未检测到代理事件，多代理配置未确认"),
          evidence: [observed ? t("已接收 {0} 代理事件", source) : "", configured ? t("CLI 明确启用 multi_agent") : ""].filter(Boolean) };
      }
      if (module.id === "plan") {
        const plan = snapshot.state.planSummary;
        const observed = plan?.capability.available === true;
        const mode = plan?.capability.planMode === "available";
        const available = readable && (observed || mode);
        return { id: module.id, available, protocolSupported: null,
          reason: available ? undefined : !readable ? t("计划来源不可用（unavailable）") : plan?.capability.planEvents === "partial"
            ? t("计划事件结构尚未完整核验（partial）") : t("尚未观测计划数据（not observed），不代表功能不受支持"),
          evidence: available ? [observed ? t("{0} 中已确认的计划", plan?.execution?.source ?? plan?.proposal?.source ?? source) : t("真实 turn_context 中的 collaboration_mode；尚无执行清单")] : [] };
      }
      if (["token-details", "cache", "cost", "five-hour-usage", "weekly-usage"].includes(module.id)) {
        const detected = module.id === "five-hour-usage" || module.id === "weekly-usage" ? snapshot.detections.rateLimits
          : module.id === "token-details" ? snapshot.detections.tokenCount : snapshot.state.usage !== undefined;
        const available = readable && detected;
        return { id: module.id, available, protocolSupported: null,
          reason: available ? undefined : readable ? t("尚未观察到对应的用量来源") : t("当前用量来源不可读"),
          evidence: available ? [module.isAvailable(snapshot.state) ? t("可选择，当前有可显示数据")
            : t("可预先选择，当前数据不可用时隐藏"), ...(module.id === "cost" ? [snapshot.state.usage?.cost.sessionEstimatedCost.reason
              ?? t("标准 API 等价估算，不代表订阅账单")] : [])] : [] };
      }
      const available = readable && supported.has(module.id) && module.isAvailable(snapshot.state);
      const reason = available ? undefined : !supported.has(module.id) ? t("本阶段尚未接入此模块的真实来源")
        : readable ? t("当前来源尚未提供有效数据") : t("当前未发现可读的主会话来源");
      return { id: module.id, available, protocolSupported: null, reason, evidence: available ? [t("{0} 解析后的归一化字段", source)] : [] };
    });
    return { source: readable ? source : modules.some(module => (module.id === "mcp" || module.id === "skills") && module.available) ? "discovery" : "none", codexVersion: snapshot.runtime.version, modules,
      diagnostics: snapshot.diagnostics.map(item => diagnosticText(`${item.message}${item.path ? t("；路径已省略") : ""}${item.line === undefined ? "" : `:${item.line}`}`)) };
  }

  async detect(state: HudState, registry = new ModuleRegistry()): Promise<CapabilityReport> {
    const probe = await this.probe();
    const protocol = probe.schemas ? inspectProtocol(probe.schemas) : {};
    const modules = registry.all().map((module): ModuleCapability => {
      const local = module.id === "git";
      const contract = protocol[module.id];
      const protocolSupported = local || !probe.schemas ? null : contract?.supported === true;
      const supported = local || protocolSupported === true;
      const hasData = module.isAvailable(state);
      const available = supported && hasData && (module.id !== "plan" || state.planSummary?.capability.available === true);
      let reason: string | undefined;
      if (!supported) reason = probe.schemas ? t("当前 Codex 未声明所需协议") : t("无法确认当前 Codex 的能力");
      else if (module.id === "plan" && !available) reason = t("协议声明不等于真实计划数据；当前尚无可靠来源");
      else if (!hasData) reason = t("当前阶段尚未接入此模块的数据来源");
      return { id: module.id, available, protocolSupported, reason, evidence: contract?.evidence ?? [] };
    });
    return { source: "mock", codexVersion: probe.version, modules, diagnostics: probe.diagnostics };
  }
}
