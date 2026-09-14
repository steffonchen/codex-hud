import { t } from "../../i18n/Messages.js";
import { watch as watchDirectory, type FSWatcher } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { errorCode, type CodexDiagnostic } from "./Diagnostics.js";

export type RolloutResetReason = "initial" | "switch" | "truncated" | "replaced" | "missing" | "error";

export interface RolloutLine {
  text: string;
  number: number;
  offset: number;
}

export interface RolloutReadResult {
  status: "ready" | "missing" | "error";
  bytesRead: number;
  offset: number;
  linesRead: number;
  pendingBytes: number;
  diagnostics: CodexDiagnostic[];
  invalidLines?: number;
}

export interface RolloutWatchStatus {
  mode: "inactive" | "native" | "polling";
  activeWatchers: number;
  fallback: boolean;
  fallbackMs?: number;
  reason?: string;
  diagnosticErrors?: number;
}

interface ReadHandlers {
  onLine: (line: RolloutLine) => void;
  onReset?: (reason: RolloutResetReason) => void;
}

export class RolloutReader {
  private filePath?: string;
  private identity?: string;
  private modifiedAt?: string;
  private offset = 0;
  private lineOffset = 0;
  private lineNumber = 1;
  private fragments: Buffer[] = [];
  private pendingBytes = 0;
  private droppingLine = false;
  private checkpoint = Buffer.alloc(0);
  private invalidated = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly chunkBytes: number;
  private readonly maxLineBytes: number;
  private watchStatus: RolloutWatchStatus = { mode: "inactive", activeWatchers: 0, fallback: false };
  private stopWatching?: () => void;

  constructor(options: { chunkBytes?: number; maxLineBytes?: number } = {}) {
    this.chunkBytes = options.chunkBytes ?? 64 * 1024;
    this.maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
    for (const value of [this.chunkBytes, this.maxLineBytes]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 64 * 1024 * 1024) throw new Error(t("Reader 缓冲区大小必须为 1 至 64 MiB 的整数字节数"));
    }
  }

  read(filePath: string | undefined, handlers: ReadHandlers): Promise<RolloutReadResult> {
    const run = this.queue.then(() => this.readCurrent(filePath, handlers));
    this.queue = run.then(() => undefined, () => { this.invalidated = true; });
    return run;
  }
  invalidate(): void { this.invalidated = true; }

  private reset(reason: RolloutResetReason, handlers: ReadHandlers): void {
    this.identity = undefined;
    this.modifiedAt = undefined;
    this.offset = 0;
    this.lineOffset = 0;
    this.lineNumber = 1;
    this.fragments = [];
    this.pendingBytes = 0;
    this.droppingLine = false;
    this.checkpoint = Buffer.alloc(0);
    this.invalidated = false;
    handlers.onReset?.(reason);
  }

  private async readCurrent(filePath: string | undefined, handlers: ReadHandlers): Promise<RolloutReadResult> {
    const diagnostics: CodexDiagnostic[] = [];
    const omitted = { error: 0, warning: 0 };
    let invalidLines = 0;
    const diagnostic = (item: CodexDiagnostic) => {
      if (item.code === "line-too-large" || item.code === "invalid-utf8") invalidLines++;
      if (diagnostics.length < 48) diagnostics.push(item); else omitted[item.severity]++;
    };
    let bytesRead = 0;
    let linesRead = 0;
    const result = (status: RolloutReadResult["status"]): RolloutReadResult => ({
      status, bytesRead, linesRead, offset: this.offset, pendingBytes: this.pendingBytes, invalidLines,
      diagnostics: [...diagnostics, ...(["error", "warning"] as const).flatMap(severity => omitted[severity] ? [{
        code: "reader-diagnostics-limited", severity, message: t("另有 {0} 条读取诊断，详细记录已限量", omitted[severity]), path: filePath,
      }] : [])],
    });
    if (filePath !== this.filePath) {
      const reason = this.filePath ? "switch" : "initial";
      this.filePath = filePath;
      this.reset(reason, handlers);
    } else if (this.invalidated) this.reset("error", handlers);
    if (!filePath) return result("missing");

    const failed = (error: unknown): RolloutReadResult => {
      const missing = errorCode(error) === "ENOENT";
      this.reset(missing ? "missing" : "error", handlers);
      diagnostic({ code: missing ? "rollout-missing" : "rollout-read", severity: missing ? "warning" : "error",
        message: missing ? t("rollout 暂时不存在，等待重新发现") : t("读取 rollout 失败（{0}）", errorCode(error)), path: filePath });
      return result(missing ? "missing" : "error");
    };
    let file: FileHandle;
    try { file = await open(filePath, "r"); } catch (error) { return failed(error); }
    try {
      let size: number;
      let identity: string;
      let modifiedAt: string;
      try {
        const info = await file.stat();
        if (!info.isFile()) return failed({ code: "EISDIR" });
        size = info.size;
        identity = `${info.dev}:${info.ino}`;
        modifiedAt = `${info.mtimeMs}:${info.ctimeMs}`;
      } catch (error) { return failed(error); }
      if (this.identity && this.identity !== identity) this.reset("replaced", handlers);
      else if (size < this.offset) this.reset("truncated", handlers);
      else if (size === this.offset && this.modifiedAt && this.modifiedAt !== modifiedAt) this.reset("replaced", handlers);
      else if (this.offset && this.checkpoint.length) {
        // 有界校验上次末尾，辅助识别两次读取之间发生的同 inode 截断后重写。
        const probe = Buffer.alloc(this.checkpoint.length);
        try {
          const read = await file.read(probe, 0, probe.length, this.offset - probe.length);
          if (read.bytesRead !== probe.length || !probe.equals(this.checkpoint)) this.reset("replaced", handlers);
        } catch (error) { return failed(error); }
      }
      this.identity = identity;
      this.modifiedAt = modifiedAt;

      // 固定本次读取上限；读取期间新增的字节留给下一次通知。
      while (this.offset < size) {
        const buffer = Buffer.alloc(Math.min(this.chunkBytes, size - this.offset));
        let count: number;
        try { count = (await file.read(buffer, 0, buffer.length, this.offset)).bytesRead; }
        catch (error) { return failed(error); }
        if (!count) {
          this.reset("truncated", handlers);
          diagnostic({ code: "rollout-changed", severity: "warning", message: t("rollout 在读取期间缩短，下一次将从头读取"), path: filePath });
          return result("error");
        }
        const chunk = buffer.subarray(0, count);
        const chunkOffset = this.offset;
        this.offset += count;
        bytesRead += count;
        this.checkpoint = Buffer.from(Buffer.concat([this.checkpoint, chunk]).subarray(-64));
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          const fragment = chunk.subarray(start, end);
          if (!this.droppingLine) {
            if (this.pendingBytes + fragment.length > this.maxLineBytes) {
              this.fragments = [];
              this.pendingBytes = 0;
              this.droppingLine = true;
              diagnostic({ code: "line-too-large", severity: "error", message: t("JSONL 行超过 {0} 字节，已跳过该行", this.maxLineBytes), path: filePath, line: this.lineNumber });
            } else {
              if (fragment.length) this.fragments.push(fragment);
              this.pendingBytes += fragment.length;
            }
          }
          if (newline < 0) break;
          if (!this.droppingLine) {
            const complete = Buffer.concat(this.fragments, this.pendingBytes);
            let text: string | undefined;
            try { text = new TextDecoder("utf-8", { fatal: true }).decode(complete).replace(/\r$/u, ""); }
            catch {
              diagnostic({ code: "invalid-utf8", severity: "error", message: t("JSONL 行不是有效的 UTF-8，已跳过该行"), path: filePath, line: this.lineNumber });
            }
            if (text !== undefined) {
              handlers.onLine({ text, number: this.lineNumber, offset: this.lineOffset });
              linesRead++;
            }
          }
          this.fragments = [];
          this.pendingBytes = 0;
          this.droppingLine = false;
          this.lineNumber++;
          this.lineOffset = chunkOffset + newline + 1;
          start = newline + 1;
        }
      }
      return result("ready");
    } finally {
      await file.close();
    }
  }

  watch(filePath: string, onChange: () => void | Promise<void>, onDiagnostic: (diagnostic: CodexDiagnostic) => void,
    fallbackMs = 3000): () => void {
    if (!Number.isSafeInteger(fallbackMs) || fallbackMs < 1000 || fallbackMs > 2_147_483_647) {
      throw new Error(t("Reader 兜底间隔必须为 1000 至 2147483647 毫秒的整数"));
    }
    this.stopWatching?.();
    this.watchStatus = { mode: "polling", activeWatchers: 0, fallback: true, fallbackMs };
    let watcher: FSWatcher | undefined;
    let closed = false;
    let running = false;
    let dirty = false;
    const report = (diagnostic: CodexDiagnostic) => {
      try { onDiagnostic(diagnostic); }
      catch { this.watchStatus.diagnosticErrors = (this.watchStatus.diagnosticErrors ?? 0) + 1; }
    };
    const notify = async () => {
      if (closed) return;
      dirty = true;
      if (running) return;
      running = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          try { await onChange(); }
          catch (error) {
            report({ code: "watch-consumer", severity: "error", message: t("处理 rollout 变化失败（{0}）", errorCode(error)), path: filePath });
          }
        }
      } finally { running = false; }
    };
    const watchFailed = (error: unknown) => {
      if (closed) return;
      watcher?.close();
      watcher = undefined;
      this.watchStatus = { mode: "polling", activeWatchers: 0, fallback: true, fallbackMs, reason: errorCode(error) };
      report({ code: "watch-unavailable", severity: "warning", message: t("文件监听不可用（{0}），继续使用 {1} 毫秒增量补查", errorCode(error), fallbackMs), path: filePath });
    };
    try {
      watcher = watchDirectory(path.dirname(filePath), (_event, name) => {
        if (name === null || name.toString() === path.basename(filePath)) void notify();
      });
      watcher.on("error", watchFailed);
      this.watchStatus = { mode: "native", activeWatchers: 1, fallback: false, fallbackMs };
    } catch (error) { watchFailed(error); }
    const timer = setInterval(() => { void notify(); }, fallbackMs);
    const stop = () => {
      if (closed) return;
      closed = true;
      dirty = false;
      clearInterval(timer);
      watcher?.close();
      watcher = undefined;
      this.watchStatus = { mode: "inactive", activeWatchers: 0, fallback: false };
      this.stopWatching = undefined;
    };
    this.stopWatching = stop;
    return stop;
  }

  getWatchStatus(): RolloutWatchStatus { return { ...this.watchStatus }; }
}
