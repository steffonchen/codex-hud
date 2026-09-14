import { t } from "../../i18n/Messages.js";
import type { DataSourceState } from "../../core/source/DataSource.js";
import type { CodexCheck } from "./Diagnostics.js";

export function sourceChecks(sources?: DataSourceState): CodexCheck[] {
  if (!sources) return [{ id: "app-server", label: "App Server", ok: false, warning: true, detail: t("已按配置关闭；使用 Rollout") }];
  const app = sources.appServer;
  const runtime = app?.runtime;
  return [{ id: "app-server", label: "App Server", ok: app?.available === true, warning: true,
    detail: app ? `available=${app.available ? "yes" : "no"}；transport=${app.transport}；protocol=${app.protocol}；schema=${app.schema}；connection=${app.state}`
      : `available=no；${sources.issues[0] ?? t("尚未探测")}` },
  { id: "app-server-live", label: t("App Server 实时来源"), ok: app?.live === true, warning: true,
    detail: `connected=${app?.state === "connected" ? "yes" : "no"}；live=${app?.live ? "yes" : "no"}；history=${app?.history ?? "unavailable"}；${app?.reason ?? t("只接收当前线程及明确子线程")}` },
  { id: "app-server-capabilities", label: t("App Server 协议能力"), ok: app?.protocol === "detected", warning: true,
    detail: app ? Object.entries(app.capabilities).map(([name, supported]) => `${name}=${supported ? "yes" : "no"}`).join("；") + t("；协议能力不等于运行已观测")
      : t("运行协议尚未确认") },
  { id: "data-source", label: t("数据来源"), ok: sources.active !== "none", warning: true,
    detail: `preferred=${sources.preferred}；active=${sources.active}；degraded=${sources.degraded ? "yes" : "no"}；deduplicated=${sources.deduplicated}` },
  { id: "runtime-fallback", label: t("Rollout 回退策略"), ok: sources.fallbackEnabled !== false, warning: true,
    detail: sources.fallbackEnabled === false ? t("已关闭") : t("已启用") },
  ...(runtime ? [
    { id: "runtime-discovery", label: t("Runtime 发现"), ok: runtime.discovery === "found", warning: true,
      detail: t("status={0}；候选={1}；{2}", runtime.discovery, runtime.candidateCount, runtime.reason ?? t("按需发现，渲染复用缓存")) },
    { id: "runtime-managed", label: "Managed daemon", ok: runtime.managed === "running", warning: true, detail: runtime.managed },
    { id: "runtime-socket", label: t("共享 Socket"), ok: runtime.socket === "present", warning: true, detail: runtime.socket },
    { id: "runtime-probe", label: "Runtime Probe", ok: runtime.probe === "success", warning: true, detail: runtime.probe },
    { id: "runtime-protocol", label: t("Runtime 兼容性"), ok: runtime.compatibility === "compatible", warning: true,
      detail: t("{0}；服务端版本={1}", runtime.compatibility, runtime.serverVersion ?? t("未确认")) },
    { id: "runtime-ownership", label: t("Runtime 归属"), ok: runtime.ownership !== "unknown", warning: true,
      detail: `${runtime.ownership}；${runtime.transport ?? t("传输未确认")}` },
    { id: "runtime-authority", label: "Runtime Authority", ok: runtime.source === "app-server", warning: true, detail: runtime.authority },
    { id: "runtime-thread", label: t("实时线程附着"), ok: runtime.thread.state === "attached", warning: true,
      detail: t("{0}；依据={1}", runtime.thread.state, runtime.thread.attachmentSource ?? t("未确认")) },
    { id: "runtime-health", label: t("Runtime 健康"), ok: runtime.health === "healthy", warning: true,
      detail: t("{0}；重连尝试={1}；{2}", runtime.health, runtime.reconnectAttempts, runtime.reconnectExhausted ? t("自动重连已停止") : t("未达到重连上限")) },
    { id: "runtime-capabilities", label: t("已探测方法"), ok: runtime.probe === "success", warning: true,
      detail: Object.entries(runtime.capabilities).map(([method, supported]) => `${method}=${supported}`).join("；") },
    { id: "runtime-account", label: t("账户状态"), ok: runtime.authenticated === true, warning: true,
      detail: `authenticated=${runtime.authenticated === undefined ? t("未观测") : runtime.authenticated ? "yes" : "no"}` },
    { id: "runtime-approval", label: t("审批观察"), ok: runtime.approvalRequestsObserved > 0, warning: true,
      detail: runtime.approvalRequestsObserved ? t("已观测 {0}；待处理 {1}；HUD 不作审批决定", runtime.approvalRequestsObserved, runtime.pendingApprovals) : t("未观测（NOT OBSERVED）") },
  ] : [])];
}
