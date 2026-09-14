import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import type { HudDensity } from "./modules/HudModule.js";

export interface TerminalSize {
  width: number;
  height: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const cleanLine = (value: string): string => stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");

export function plainText(value: string): string {
  return cleanLine(value).trim();
}

export class WidthPolicy {
  normalize(terminal: TerminalSize): TerminalSize {
    const dimension = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    return { width: dimension(terminal.width), height: dimension(terminal.height) };
  }

  measure(value: string): number {
    return stringWidth(cleanLine(value));
  }

  density(width: number): HudDensity {
    if (width >= 100) return "full";
    if (width >= 60) return "compact";
    return "minimal";
  }

  rowBudget(terminal: TerminalSize, autoCompact = true): number {
    const { width, height } = this.normalize(terminal);
    if (width < 8) return 0;
    if (!autoCompact || width >= 100) return height;
    return Math.min(height, width >= 60 ? 8 : 4);
  }

  fitLine(value: string, width: number): string {
    const limit = this.normalize({ width, height: 1 }).width;
    if (!limit) return "";
    const clean = cleanLine(value).trimEnd();
    if (this.measure(clean) <= limit) return clean;

    let result = "";
    let columns = 0;
    for (const { segment } of graphemes.segment(clean)) {
      const size = stringWidth(segment);
      if (columns + size > limit - 1) break;
      result += segment;
      columns += size;
    }
    return `${result.trimEnd()}…`;
  }
}
