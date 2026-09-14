import type { HudState } from "../../core/HudState.js";

export type HudDensity = "full" | "compact" | "minimal";

export interface ModuleRenderContext {
  width: number;
  density: HudDensity;
  now?: number;
  height?: number;
  maxRows?: number;
  currentActivityToolId?: string;
}

export interface HudModule {
  id: string;
  label: string;
  category: string;
  defaultEnabled: boolean;
  priority: number;
  isAvailable(state: HudState): boolean;
  render(state: HudState, context: ModuleRenderContext): string;
}
