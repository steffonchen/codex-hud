import type { HudState } from "../core/HudState.js";
import type { HudDensity, HudModule } from "./modules/HudModule.js";
import { WidthPolicy, type TerminalSize } from "./WidthPolicy.js";
import { selectActiveTool } from "../core/ActivityTracker.js";

export interface HudLayout {
  density: HudDensity;
  moduleIds: string[];
  hiddenModuleIds: string[];
  lines: string[];
}

interface Block {
  ids: string[];
  lines: string[];
}

export class LayoutEngine {
  constructor(private readonly widthPolicy = new WidthPolicy()) {}

  layout(state: HudState, terminal: TerminalSize, modules: readonly HudModule[], autoCompact = true, now = Date.now()): HudLayout {
    const size = this.widthPolicy.normalize(terminal);
    const budget = this.widthPolicy.rowBudget(size, autoCompact);
    const densities: HudDensity[] = ["full", "compact", "minimal"];
    const initial = autoCompact ? this.widthPolicy.density(size.width) : "full";
    const candidates = autoCompact ? densities.slice(densities.indexOf(initial)) : [initial];
    const selected = [...modules];

    const result = (density: HudDensity, blocks: Block[], lines: string[]): HudLayout => {
      const ids = blocks.flatMap(block => block.ids);
      return {
        density,
        moduleIds: ids,
        hiddenModuleIds: modules.filter(module => !ids.includes(module.id)).map(module => module.id),
        lines: lines.map(line => this.widthPolicy.fitLine(line, size.width)),
      };
    };

    if (!budget || !size.width) return result(initial, [], []);
    for (const density of candidates) {
      const blocks = this.blocks(state, selected, density, size.width, now, size.height, budget);
      for (const spacing of density === "full" ? [true, false] : [false]) {
        const lines = this.lines(blocks, spacing);
        if (lines.length <= budget && lines.every(line => this.widthPolicy.measure(line) <= size.width)) {
          return result(density, blocks, lines);
        }
      }
    }

    const density = candidates.at(-1)!;
    // 先减少信息密度；仍然放不下时，按重要性移除整个模块，保持剩余模块的显示顺序。
    const removalOrder = selected.map((module, index) => ({ module, index }))
      .sort((a, b) => a.module.priority - b.module.priority || b.index - a.index);
    let blocks = this.blocks(state, selected, density, size.width, now, size.height, budget);
    while (this.lines(blocks, false).length > budget && removalOrder.length) {
      const { module } = removalOrder.shift()!;
      selected.splice(selected.indexOf(module), 1);
      blocks = this.blocks(state, selected, density, size.width, now, size.height, budget);
    }
    return result(density, blocks, this.lines(blocks, false));
  }

  private blocks(state: HudState, modules: readonly HudModule[], density: HudDensity, width: number, now: number, height: number, budget: number): Block[] {
    const blocks: Block[] = [];
    const current = modules.find(module => module.id === "current-activity");
    const currentActivityToolId = current?.render(state, { width, density, now, height, maxRows: budget }).trim()
      ? selectActiveTool(state.tools?.active)?.id ?? state.activity?.toolId : undefined;
    for (const module of modules) {
      const lines = module.render(state, { width, density, now, height, maxRows: budget, currentActivityToolId }).split("\n").map(line => line.trimEnd()).filter(Boolean);
      if (!lines.length) continue;
      const previous = blocks.at(-1);
      const pair = previous?.ids.length === 1 ? new Set([previous.ids[0], module.id]) : new Set<string>();
      const identity = pair.has("model") && pair.has("reasoning");
      const quota = density !== "full" && width >= 40 && pair.has("five-hour-usage") && pair.has("weekly-usage");
      if (previous?.lines.length === 1 && lines.length === 1 && (identity || quota)) {
        const combined = `${previous.lines[0]} · ${lines[0]}`;
        if (this.widthPolicy.measure(combined) <= width) {
          previous.lines[0] = combined;
          previous.ids.push(module.id);
          continue;
        }
      }
      blocks.push({ ids: [module.id], lines });
    }
    const expandable = blocks.filter(block => block.ids.length === 1 && ((block.ids[0] === "agents" && state.agentSummary)
      || (block.ids[0] === "plan" && state.planSummary)));
    const fixedRows = blocks.reduce((total, block) => total + (expandable.includes(block) ? 0 : block.lines.length), 0);
    let remaining = budget - fixedRows;
    const ordered = [...expandable].sort((a, b) => modules.find(module => module.id === b.ids[0])!.priority - modules.find(module => module.id === a.ids[0])!.priority);
    for (const [index, block] of ordered.entries()) {
      block.lines = modules.find(module => module.id === block.ids[0])!.render(state, {
        width, density, now, height, maxRows: Math.max(1, remaining - (ordered.length - index - 1)),
      }).split("\n").filter(Boolean);
      remaining -= block.lines.length;
    }
    return blocks;
  }

  private lines(blocks: Block[], spacing: boolean): string[] {
    return blocks.flatMap((block, index) => spacing && index > 0 ? ["", ...block.lines] : block.lines);
  }
}
