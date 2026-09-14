import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rename, rm, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RolloutReader, type RolloutLine } from "../../src/providers/codex/RolloutReader.js";

let directory: string;
let file: string;
const stops: Array<() => void> = [];
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-reader-"));
  file = path.join(directory, "rollout-main.jsonl");
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

function capture() {
  const lines: RolloutLine[] = [];
  const onReset = vi.fn(() => { lines.length = 0; });
  return { lines, onLine: (line: RolloutLine) => { lines.push(line); }, onReset };
}

describe("RolloutReader", () => {
  it("只消费新增字节，不重复返回历史行", async () => {
    const initial = '{"value":1}\n';
    const added = '{"value":2}\n';
    await writeFile(file, initial);
    const reader = new RolloutReader({ chunkBytes: 3 });
    const received = capture();
    expect(await reader.read(file, received)).toMatchObject({ bytesRead: Buffer.byteLength(initial), linesRead: 1 });
    expect(await reader.read(file, received)).toMatchObject({ bytesRead: 0, linesRead: 0 });
    await appendFile(file, added);
    expect(await reader.read(file, received)).toMatchObject({ bytesRead: Buffer.byteLength(added), linesRead: 1, offset: Buffer.byteLength(initial + added) });
    expect(received.lines.map(line => line.text)).toEqual([initial.trim(), added.trim()]);
    expect(received.lines.map(line => line.offset)).toEqual([0, Buffer.byteLength(initial)]);
  });

  it("半行和跨读取的 UTF-8 多字节字符正确拼接", async () => {
    const source = Buffer.from('{"value":"中文🚀"}\n');
    const cut = source.indexOf(Buffer.from("中")) + 1;
    await writeFile(file, source.subarray(0, cut));
    const reader = new RolloutReader({ chunkBytes: 2 });
    const received = capture();
    expect(await reader.read(file, received)).toMatchObject({ linesRead: 0, pendingBytes: cut });
    await appendFile(file, source.subarray(cut, -1));
    expect((await reader.read(file, received)).linesRead).toBe(0);
    await appendFile(file, "\n");
    expect((await reader.read(file, received)).linesRead).toBe(1);
    expect(received.lines[0].text).toBe(source.toString("utf8").trim());
  });

  it("支持 CRLF，保留空行的位置供 parser 判断", async () => {
    await writeFile(file, "{}\r\n\n{}\n");
    const received = capture();
    await new RolloutReader({ chunkBytes: 1 }).read(file, received);
    expect(received.lines.map(line => [line.text, line.number, line.offset])).toEqual([["{}", 1, 0], ["", 2, 4], ["{}", 3, 5]]);
  });

  it("文件变短时清空半行并从头读取", async () => {
    await writeFile(file, '{"before":1000}\n{"partial":');
    const reader = new RolloutReader();
    const received = capture();
    await reader.read(file, received);
    await writeFile(file, "{}\n");
    const result = await reader.read(file, received);
    expect(result).toMatchObject({ offset: 3, pendingBytes: 0 });
    expect(received.onReset).toHaveBeenLastCalledWith("truncated");
    expect(received.lines.map(line => line.text)).toEqual(["{}"]);
  });

  it("原子替换成更大文件时仍从头读取", async () => {
    await writeFile(file, "{}\n");
    const reader = new RolloutReader();
    const received = capture();
    await reader.read(file, received);
    const replacement = path.join(directory, "replacement");
    await writeFile(replacement, '{"new":123}\n');
    await rename(replacement, file);
    await reader.read(file, received);
    expect(received.onReset).toHaveBeenLastCalledWith("replaced");
    expect(received.lines.map(line => line.text)).toEqual(['{"new":123}']);
  });

  it("同 inode 截断后迅速写到更大尺寸也能被有界校验发现", async () => {
    await writeFile(file, '{"old":1}\n');
    const reader = new RolloutReader();
    const received = capture();
    await reader.read(file, received);
    await truncate(file, 0);
    await appendFile(file, '{"new":1000}\n');
    await reader.read(file, received);
    expect(received.onReset).toHaveBeenLastCalledWith("replaced");
    expect(received.lines[0].text).toBe('{"new":1000}');
  });

  it("会话文件切换时不串接旧文件的半行", async () => {
    await writeFile(file, '{"old":');
    const other = path.join(directory, "rollout-other.jsonl");
    await writeFile(other, '{"new":1}\n');
    const reader = new RolloutReader();
    const received = capture();
    await reader.read(file, received);
    await reader.read(other, received);
    expect(received.onReset).toHaveBeenLastCalledWith("switch");
    expect(received.lines).toEqual([{ text: '{"new":1}', number: 1, offset: 0 }]);
  });

  it("同长度重写即使尾部相同，也通过修改时间检测并重放", async () => {
    const suffix = ' '.repeat(100) + '\n';
    await writeFile(file, '{"old":1}' + suffix);
    const reader = new RolloutReader();
    const received = capture();
    await reader.read(file, received);
    await writeFile(file, '{"new":1}' + suffix);
    await utimes(file, 1, 1);
    await reader.read(file, received);
    expect(received.onReset).toHaveBeenLastCalledWith("replaced");
    expect(received.lines[0].text).toContain('"new"');
  });

  it("文件暂时消失时返回 missing，重新出现后恢复", async () => {
    const reader = new RolloutReader();
    const received = capture();
    expect((await reader.read(file, received)).status).toBe("missing");
    await writeFile(file, "{}\n");
    await reader.read(file, received);
    await rm(file);
    expect(await reader.read(file, received)).toMatchObject({ status: "missing", offset: 0 });
    expect(received.lines).toEqual([]);
    await writeFile(file, '{"restored":true}\n');
    expect((await reader.read(file, received)).linesRead).toBe(1);
  });

  it("非文件路径返回可见错误", async () => {
    const result = await new RolloutReader().read(directory, capture());
    expect(result.status).toBe("error");
    expect(result.diagnostics[0].message).toContain("EISDIR");
  });

  it("超大行有内存上限，跨追加跳过到换行后恢复", async () => {
    await writeFile(file, "x".repeat(40));
    const reader = new RolloutReader({ chunkBytes: 3, maxLineBytes: 10 });
    const received = capture();
    const first = await reader.read(file, received);
    expect(first.pendingBytes).toBe(0);
    expect(first.diagnostics.map(item => item.code)).toEqual(["line-too-large"]);
    await appendFile(file, 'x\n{}\n');
    await reader.read(file, received);
    expect(received.lines).toEqual([{ text: "{}", number: 2, offset: 42 }]);
  });

  it("非法 UTF-8 不以替换字符冒充有效数据", async () => {
    await writeFile(file, Buffer.from([0xff, 10, 123, 125, 10]));
    const received = capture();
    const result = await new RolloutReader().read(file, received);
    expect(result.diagnostics[0].code).toBe("invalid-utf8");
    expect(received.lines[0].number).toBe(2);
  });

  it("并发读取串行处理，相同新增行只消费一次", async () => {
    await writeFile(file, "{}\n");
    const reader = new RolloutReader();
    const received = capture();
    const results = await Promise.all([reader.read(file, received), reader.read(file, received)]);
    expect(results.map(result => result.linesRead)).toEqual([1, 0]);
  });

  it("消费者失败向调用方报告，下次读取重放而不是跳过字节", async () => {
    await writeFile(file, "{}\n{}\n");
    const reader = new RolloutReader();
    await expect(reader.read(file, { onLine: () => { throw new Error("消费者失败"); } })).rejects.toThrow("消费者失败");
    const received = capture();
    expect((await reader.read(file, received)).linesRead).toBe(2);
    expect(received.onReset).toHaveBeenLastCalledWith("error");
  });

  it("真实环境通过目录监听或可观察的低频补查发现追加", async () => {
    await writeFile(file, "{}\n");
    const reader = new RolloutReader();
    const received = capture();
    await reader.read(file, received);
    const diagnostics: string[] = [];
    const updated = new Promise<void>(resolve => {
      const stop = reader.watch(file, async () => {
        await reader.read(file, received);
        if (received.lines.length === 2) resolve();
      }, diagnostic => { diagnostics.push(diagnostic.code); }, 1000);
      stops.push(stop);
    });
    await Promise.all([updated, appendFile(file, '{"added":true}\n')]);
    stops[0]();
    stops[0]();
    expect(received.lines.length).toBe(2);
    expect(diagnostics.every(code => code === "watch-unavailable")).toBe(true);
  });

  it("watcher 不可用时报告原因，低频增量补查仍工作", async () => {
    vi.useFakeTimers();
    const absent = path.join(directory, "missing", "rollout.jsonl");
    const change = vi.fn();
    const diagnostic = vi.fn();
    const stop = new RolloutReader().watch(absent, change, diagnostic);
    stops.push(stop);
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "watch-unavailable" }));
    await mkdir(path.dirname(absent));
    await vi.advanceTimersByTimeAsync(3000);
    expect(change).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(change).toHaveBeenCalledTimes(1);
  });
});
