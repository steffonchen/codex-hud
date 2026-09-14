import { t } from "../i18n/Messages.js";
import type { Writable } from "node:stream";
import { writeOutput } from "../cli/Output.js";
import { WidthPolicy, type TerminalSize } from "../renderer/WidthPolicy.js";

export type HudOutput = Writable & { isTTY?: boolean; columns?: number; rows?: number };

export interface TerminalEvents {
  resize: () => void;
  close: () => void;
  error: (error: Error) => void;
}

export interface HudTerminal {
  readonly isTTY: boolean;
  getSize(): TerminalSize;
  subscribe(events: TerminalEvents): () => void;
  start(): Promise<void>;
  render(content: string): Promise<void>;
  dispose(): Promise<void>;
  restoreSync(): void;
}

const ansi = {
  enter: "\x1b[?1049h",
  leave: "\x1b[?1049l",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  save: "\x1b7",
  restore: "\x1b8",
  clearLine: "\x1b[2K",
  row: (row: number) => `\x1b[${row};1H`,
};

export function terminalSize(output: HudOutput): TerminalSize {
  return new WidthPolicy().normalize({ width: output.columns ?? 80, height: output.rows ?? 24 });
}

export class TerminalController implements HudTerminal {
  private active = false;
  private lines: string[] = [];
  private size?: TerminalSize;
  private readonly widthPolicy = new WidthPolicy();

  constructor(private readonly output: HudOutput = process.stdout) {}

  get isTTY(): boolean { return this.output.isTTY === true; }

  getSize(): TerminalSize { return terminalSize(this.output); }

  subscribe(events: TerminalEvents): () => void {
    this.output.on("resize", events.resize);
    this.output.on("close", events.close);
    this.output.on("error", events.error);
    return () => {
      this.output.off("resize", events.resize);
      this.output.off("close", events.close);
      this.output.off("error", events.error);
    };
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (!this.output.writable || this.output.destroyed || this.output.writableEnded) throw new Error(t("终端 stdout 不可写"));
    this.active = true;
    this.lines = [];
    this.size = undefined;
    if (this.isTTY) await writeOutput(this.output, ansi.enter + ansi.hideCursor);
  }

  async render(content: string): Promise<void> {
    if (!this.active) return;
    const size = this.getSize();
    const lines = content ? content.split("\n").slice(0, size.height).map(line => this.widthPolicy.fitLine(line, size.width)) : [];
    const resized = this.size !== undefined && (this.size.width !== size.width || this.size.height !== size.height);
    if (!resized && lines.length === this.lines.length && lines.every((line, index) => line === this.lines[index])) return;
    if (!this.isTTY) {
      if (lines.length) await writeOutput(this.output, `${lines.join("\n")}\n`);
    } else {
      const changes: string[] = [];
      // resize 可能使终端重排旧行，因此重置当前可见行；常规更新只写变化的行。
      const rows = resized ? size.height : Math.min(size.height, Math.max(lines.length, this.lines.length));
      for (let index = 0; index < rows; index++) {
        if (resized || lines[index] !== this.lines[index]) {
          changes.push(ansi.row(index + 1), ansi.clearLine, lines[index] ?? "");
        }
      }
      if (changes.length) await writeOutput(this.output, ansi.save + changes.join("") + ansi.restore);
    }
    this.lines = lines;
    this.size = size;
  }

  async clearHud(): Promise<void> { await this.render(""); }

  async hideCursor(): Promise<void> {
    if (this.isTTY && this.active) await writeOutput(this.output, ansi.hideCursor);
  }

  async showCursor(): Promise<void> {
    if (this.isTTY && this.active) await writeOutput(this.output, ansi.showCursor);
  }

  async dispose(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.isTTY && !this.output.destroyed && !this.output.writableEnded) {
      await writeOutput(this.output, ansi.showCursor + ansi.leave);
    }
  }

  restoreSync(): void {
    if (!this.active) return;
    this.active = false;
    if (!this.isTTY || this.output.destroyed || this.output.writableEnded) return;
    try { this.output.write(ansi.showCursor + ansi.leave); }
    catch {
      // exit 阶段无法等待异步清理，恢复失败仍以非零退出码报告。
      process.exitCode = 1;
    }
  }
}
