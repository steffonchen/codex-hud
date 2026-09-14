import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import stringWidth from "string-width";
import { TerminalController, type HudOutput } from "../../src/terminal/TerminalController.js";

function capture(isTTY = true) {
  const writes: string[] = [];
  const output: HudOutput = new Writable({ write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); } });
  Object.assign(output, { isTTY, columns: 120, rows: 15 });
  return { output, writes, terminal: new TerminalController(output) };
}

describe("TerminalController", () => {
  it("只重写改变的行，不清整屏，不重复写相同内容", async () => {
    const { terminal, writes } = capture();
    await terminal.start();
    expect(writes[0]).toBe("\x1b[?1049h\x1b[?25l");
    await terminal.render("模型 A\n上下文 10%\nToken 10000");
    await terminal.render("模型 A\n上下文 20%\nToken 10000");
    expect(writes[2]).toContain("\x1b[2;1H\x1b[2K上下文 20%");
    expect(writes[2]).not.toContain("模型 A");
    expect(writes.join("")).not.toContain("\x1b[2J");
    await terminal.render("模型 A\n上下文 20%\nToken 10000");
    expect(writes).toHaveLength(3);
    await terminal.clearHud();
    expect(writes.at(-1)).toContain("\x1b[3;1H\x1b[2K");
    await terminal.dispose();
    await terminal.dispose();
    expect(writes.at(-1)).toBe("\x1b[?25h\x1b[?1049l");
    expect(writes.filter(text => text.includes("\x1b[?1049l"))).toHaveLength(1);
  });

  it("非 TTY 输出不含任何控制序列", async () => {
    const { terminal, writes } = capture(false);
    await terminal.start();
    await terminal.render("模型 A\n上下文 20%");
    await terminal.dispose();
    expect(writes).toEqual(["模型 A\n上下文 20%\n"]);
  });

  it.each([[140, 20], [120, 15], [80, 10], [60, 8], [50, 5], [40, 4]])("%i × %i 不越过可见区域", async (width, height) => {
    const { terminal, output, writes } = capture();
    output.columns = width;
    output.rows = height;
    await terminal.start();
    await terminal.render(Array.from({ length: 30 }, () => "中文👨‍👩‍👧‍👦".repeat(100)).join("\n"));
    const rows = [...writes.at(-1)!.matchAll(/\x1b\[(\d+);1H\x1b\[2K([^\x1b]*)/gu)];
    expect(rows).toHaveLength(height);
    expect(rows.every(match => Number(match[1]) <= height && stringWidth(match[2]) <= width)).toBe(true);
    await terminal.dispose();
  });

  it("resize 重建可见行，订阅可以完整移除", async () => {
    const { terminal, output, writes } = capture();
    const events = { resize: vi.fn(), close: vi.fn(), error: vi.fn() };
    const unsubscribe = terminal.subscribe(events);
    await terminal.start();
    await terminal.render("行 A\n行 B");
    output.columns = 40;
    output.rows = 4;
    output.emit("resize");
    await terminal.render("行 A");
    expect(events.resize).toHaveBeenCalledOnce();
    expect(writes.at(-1)).toContain("\x1b[4;1H\x1b[2K");
    await terminal.dispose();
    unsubscribe();
    for (const event of ["resize", "close", "error"]) expect(output.listenerCount(event)).toBe(0);
  });

  it("异常退出可同步恢复一次，之后 dispose 不重复恢复", async () => {
    const { terminal, writes } = capture();
    await terminal.start();
    terminal.restoreSync();
    terminal.restoreSync();
    await terminal.dispose();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("\x1b[?25h\x1b[?1049l");
  });

  it("异步输出失败不会伪装成功", async () => {
    const output: HudOutput = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("终端断开")); } });
    output.isTTY = true;
    const terminal = new TerminalController(output);
    await expect(terminal.start()).rejects.toThrow("Terminal output failed");
    await terminal.dispose();
  });

  it("写入尚未回调时关闭输出也会结算，不永久等待", async () => {
    let acknowledge!: (error?: Error | null) => void;
    const output: HudOutput = new Writable({ write(_chunk, _encoding, callback) { acknowledge = callback; } });
    output.isTTY = true;
    const terminal = new TerminalController(output);
    const starting = terminal.start();
    const rejected = expect(starting).rejects.toThrow("Output stream closed");
    output.destroy();
    await rejected;
    acknowledge();
    await terminal.dispose();
  });
});
