import { t } from "../i18n/Messages.js";
import { withLanguage } from "../i18n/Language.js";
import type { HudConfig } from "../config/Config.js";
import type { HudState } from "../core/HudState.js";
import { LayoutEngine } from "./LayoutEngine.js";
import { ModuleRegistry } from "./modules/ModuleRegistry.js";
import type { TerminalSize } from "./WidthPolicy.js";

export class HudRenderer {
  private issues = new Set<string>();
  constructor(
    private readonly registry = new ModuleRegistry(),
    private readonly layoutEngine = new LayoutEngine(),
  ) {}

  render(state: HudState, terminal: TerminalSize, config: HudConfig, now = Date.now()): string {
    return withLanguage(config.display.language, () => this.renderLocalized(state, terminal, config, now));
  }

  private renderLocalized(state: HudState, terminal: TerminalSize, config: HudConfig, now: number): string {
    this.issues.clear();
    if (config.behavior.hide_when_idle && state.activity?.status === "idle" && !state.agentSummary?.activeSubagentCount) return "";
    const modules = this.registry.resolve(config.display.enabled, config.display.order)
      .filter(module => {
        try { return module.isAvailable(state); }
        catch { this.issues.add(t("模块 {0} 的可用性检查失败", module.id)); return false; }
      }).map(module => ({ ...module, render: (...args: Parameters<typeof module.render>) => {
        try { return module.render(...args); }
        catch { this.issues.add(t("模块 {0} 渲染失败", module.id)); return ""; }
      } }));
    return this.layoutEngine.layout(state, terminal, modules, config.behavior.auto_compact, now).lines.join("\n");
  }
  getIssues(): string[] { return [...this.issues].slice(0, 20); }
}
