import { t } from "../i18n/Messages.js";
import { withLanguage } from "../i18n/Language.js";
import type { HudConfig } from "../config/Config.js";
import { redactText } from "../core/Redaction.js";
import { CodexSessionProvider, hasUsableAppServer } from "../providers/codex/CodexSessionProvider.js";
import { HudRenderer } from "../renderer/HudRenderer.js";
import { HudRuntime, type LiveCodexProvider } from "../runtime/HudRuntime.js";
import { TerminalController, terminalSize, type HudOutput } from "../terminal/TerminalController.js";
import { formatDiagnostic } from "./Diagnostics.js";
import { writeOutput } from "./Output.js";

export { terminalSize, type HudOutput } from "../terminal/TerminalController.js";
export type HudProvider = Pick<CodexSessionProvider, "refresh"> & Partial<LiveCodexProvider & Pick<CodexSessionProvider, "probeWatcher">>;

export async function runHud(config: HudConfig, output: HudOutput, errorOutput: NodeJS.WritableStream,
  provider?: HudProvider): Promise<void> {
  return withLanguage(config.display.language, () => runLocalizedHud(config, output, errorOutput,
    provider ?? new CodexSessionProvider({ providers: config.providers, runtime: config.runtime })));
}

async function runLocalizedHud(config: HudConfig, output: HudOutput, errorOutput: NodeJS.WritableStream, provider: HudProvider): Promise<void> {
  if (!output.isTTY) {
    try {
      await writeOutput(errorOutput, t("非交互终端：输出一次真实快照后退出；持续 HUD 请在交互终端运行。\n"));
      const snapshot = await provider.refresh();
      for (const diagnostic of snapshot.diagnostics) await writeOutput(errorOutput, `${formatDiagnostic(diagnostic)}\n`);
      const renderer = new HudRenderer(), started = performance.now();
      const rendered = renderer.render(snapshot.state, terminalSize(output), config);
      provider.telemetry?.rendered(started);
      for (const message of renderer.getIssues()) {
        const diagnostic = { code: "renderer", severity: "error" as const, message };
        snapshot.diagnostics.push(diagnostic); await writeOutput(errorOutput, `${formatDiagnostic(diagnostic)}\n`);
      }
      if (rendered) await writeOutput(output, redactText(`${rendered}\n`));
      else if (!(config.behavior.hide_when_idle && snapshot.state.activity?.status === "idle")) {
        const message = !config.display.enabled.length ? t("未启用显示模块，请运行 codex-hud setup。")
          : snapshot.read.status === "ready" ? t("当前已启用模块没有可显示的真实数据。") : t("正在等待 Codex 会话…");
        await writeOutput(output, `Codex HUD\n${message}\n`);
      }
      if (snapshot.state.dataSources?.degraded) await writeOutput(errorOutput, redactText(t("数据源降级：{0}；{1}\n", snapshot.state.dataSources.active, snapshot.state.dataSources.appServer?.reason ?? snapshot.state.dataSources.issues[0] ?? t("实时连接不可用"))));
      if ((snapshot.read.status === "error" && !hasUsableAppServer(snapshot)) || snapshot.diagnostics.some(item => item.severity === "error"
        && !(hasUsableAppServer(snapshot) && item.code === "rollout-read"))) {
        throw new Error(t("真实数据包含读取或解析错误，请查看上方诊断"));
      }
      return;
    } finally { await provider.stop?.(); }
  }

  if (!provider.store || !provider.start || !provider.stop) throw new Error(t("持续 HUD 需要支持订阅与生命周期的 Codex Provider"));
  const runtime = new HudRuntime(config, { provider: provider as LiveCodexProvider, terminal: new TerminalController(output) });
  try {
    await runtime.start();
    await runtime.waitForStop();
  } finally {
    await runtime.stop();
  }
}
