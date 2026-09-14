import { t } from "../../i18n/Messages.js";
import { open, realpath, stat } from "node:fs/promises";
import { errorCode } from "./Diagnostics.js";

export class DiscoveryFormatError extends Error {}

export interface DiscoveryFileResult<T> {
  status: "ready" | "missing" | "error";
  canonicalPath?: string;
  value?: T;
  reason?: string;
}

export interface DiscoveryIO { stats: number; filesRead: number; bytesRead: number; directories: number }

// 缓存解析后的白名单数据；原配置、技能正文及环境值不保留在缓存中。
export class DiscoveryFiles {
  private cache = new Map<string, { stamp: string; limit: number; prefixOnly: boolean;
    parser: (text: string) => unknown; result: DiscoveryFileResult<unknown> }>();
  private seen = new Set<string>();
  io: DiscoveryIO = { stats: 0, filesRead: 0, bytesRead: 0, directories: 0 };

  begin(): void { this.seen.clear(); this.io = { stats: 0, filesRead: 0, bytesRead: 0, directories: 0 }; }
  finish(): void { for (const key of this.cache.keys()) if (!this.seen.has(key)) this.cache.delete(key); }

  async read<T>(file: string, limit: number, parser: (text: string) => T, prefixOnly = false): Promise<DiscoveryFileResult<T>> {
    let canonicalPath: string | undefined;
    try {
      this.io.stats++;
      canonicalPath = await realpath(file);
      this.seen.add(canonicalPath);
      const metadata = await stat(canonicalPath);
      if (!metadata.isFile()) throw new DiscoveryFormatError(t("来源不是普通文件"));
      const stamp = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
      const cached = this.cache.get(canonicalPath);
      if (cached?.stamp === stamp && cached.parser === parser && cached.limit === limit && cached.prefixOnly === prefixOnly) {
        return structuredClone(cached.result) as DiscoveryFileResult<T>;
      }
      let result: DiscoveryFileResult<T>;
      let cacheable = !prefixOnly && metadata.size > limit;
      try {
        if (!prefixOnly && metadata.size > limit) throw new DiscoveryFormatError(t("来源超过读取安全上限"));
        const fileHandle = await open(canonicalPath, "r");
        let text: string;
        try {
          const buffer = Buffer.alloc(Math.min(metadata.size, limit));
          let offset = 0;
          while (offset < buffer.length) {
            const read = await fileHandle.read(buffer, offset, buffer.length - offset, offset);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
          }
          this.io.filesRead++; this.io.bytesRead += offset;
          // 技能正文可能在多字节字符中间截断；只解码完整 frontmatter 范围。
          let content = buffer.subarray(0, offset);
          if (prefixOnly) {
            let end = content.indexOf("\n---", 4);
            while (end >= 0 && end + 4 < content.length && content[end + 4] !== 10 && content[end + 4] !== 13) end = content.indexOf("\n---", end + 4);
            if (end >= 0) content = content.subarray(0, end + 4);
            else if (metadata.size > limit) content = content.subarray(0, content.lastIndexOf(10) + 1);
          }
          text = new TextDecoder("utf-8", { fatal: true }).decode(content);
          const after = await fileHandle.stat();
          if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) throw new DiscoveryFormatError(t("读取期间来源发生变化，将在下次刷新重试"));
        } finally { await fileHandle.close(); }
        cacheable = true;
        result = { status: "ready", canonicalPath, value: parser(text) };
      } catch (error) {
        result = { status: "error", canonicalPath, reason: error instanceof DiscoveryFormatError ? error.message : t("来源读取或解析失败（{0}）", errorCode(error)) };
      }
      // 文件未变时仍须重试临时 IO 错误；只缓存稳定读取后的解析结果或大小限制。
      if (cacheable) this.cache.set(canonicalPath, { stamp, limit, prefixOnly, parser, result });
      else this.cache.delete(canonicalPath);
      if (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value!);
      return structuredClone(result);
    } catch (error) {
      if (canonicalPath) this.cache.delete(canonicalPath);
      return { status: ["ENOENT", "ENOTDIR"].includes(errorCode(error)) ? "missing" : "error", canonicalPath,
        reason: error instanceof DiscoveryFormatError ? error.message : t("来源不可读（{0}）", errorCode(error)) };
    }
  }
}
