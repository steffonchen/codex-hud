import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { modelModule } from "./Model.js";
import { reasoningModule } from "./Reasoning.js";
import { contextModule } from "./Context.js";
import { fiveHourUsageModule } from "./FiveHourUsage.js";
import { weeklyUsageModule } from "./WeeklyUsage.js";
import { agentsModule } from "./Agents.js";
import { toolsModule } from "./Tools.js";
import { currentActivityModule } from "./CurrentActivity.js";
import { planModule } from "./Plan.js";
import { sessionModule } from "./Session.js";
import { gitModule } from "./Git.js";
import { mcpModule } from "./Mcp.js";
import { skillsModule } from "./Skills.js";
import { tokenDetailsModule } from "./TokenDetails.js";
import { costModule } from "./Cost.js";
import { cacheModule } from "./Cache.js";
import { runtimeStatusModule } from "./RuntimeStatus.js";

const builtInModules: HudModule[] = [
  modelModule, reasoningModule, contextModule, fiveHourUsageModule, weeklyUsageModule,
  agentsModule, toolsModule, currentActivityModule, planModule, sessionModule, gitModule,
  mcpModule, skillsModule, tokenDetailsModule, costModule, cacheModule, runtimeStatusModule,
];

export class ModuleRegistry {
  private readonly modules: Map<string, HudModule>;

  constructor(modules: readonly HudModule[] = builtInModules) {
    this.modules = new Map();
    for (const module of modules) {
      if (this.modules.has(module.id)) throw new Error(t("模块重复注册：{0}", module.id));
      this.modules.set(module.id, module);
    }
  }

  all(): HudModule[] {
    return [...this.modules.values()];
  }

  get(id: string): HudModule | undefined {
    return this.modules.get(id);
  }

  defaultEnabled(): string[] {
    return this.all().filter(module => module.defaultEnabled).map(module => module.id);
  }

  resolve(enabled: readonly string[], order: readonly string[] = []): HudModule[] {
    const selected = new Set(enabled);
    for (const id of [...enabled, ...order]) {
      if (!this.modules.has(id)) throw new Error(t("未知显示模块：{0}", id));
    }
    const ids = new Set([...order, ...this.modules.keys()]);
    return [...ids].filter(id => selected.has(id)).map(id => this.modules.get(id)!);
  }
}
