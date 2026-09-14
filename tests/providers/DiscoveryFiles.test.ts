import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DiscoveryFiles, DiscoveryFormatError } from "../../src/providers/codex/DiscoveryFiles.js";

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), open: openMock }));
let directory: string, file: string, files: DiscoveryFiles;
beforeEach(async () => {
  openMock.mockReset().mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open);
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-discovery-files-"));
  file = path.join(directory, "source"); await writeFile(file, "example"); files = new DiscoveryFiles();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("能力文件缓存边界", () => {
  it("EMFILE 恢复后重新读取未变化文件", async () => {
    openMock.mockRejectedValueOnce(Object.assign(new Error("临时读取失败"), { code: "EMFILE" }));
    const parse = vi.fn((text: string) => ({ name: text }));
    expect(await files.read(file, 100, parse)).toMatchObject({ status: "error", reason: expect.stringContaining("EMFILE") });
    expect(await files.read(file, 100, parse)).toMatchObject({ status: "ready", value: { name: "example" } });
    expect(openMock).toHaveBeenCalledTimes(2); expect(parse).toHaveBeenCalledOnce();
  });
  it("缓存不跨解析器复用白名单结果", async () => {
    expect(await files.read(file, 100, text => ({ name: text }))).toMatchObject({ value: { name: "example" } });
    expect(await files.read(file, 100, text => [text])).toMatchObject({ value: ["example"] });
    expect(openMock).toHaveBeenCalledTimes(2);
  });
  it("读取界限和头部模式改变时重新校验", async () => {
    const parse = (text: string) => text;
    expect((await files.read(file, 100, parse)).status).toBe("ready");
    expect((await files.read(file, 2, parse)).status).toBe("error");
    expect((await files.read(file, 2, parse, true)).status).toBe("ready");
  });
  it("稳定文件的解析失败可缓存且不保留原文", async () => {
    const parse = vi.fn(() => { throw new DiscoveryFormatError("无法解析来源"); });
    await files.read(file, 100, parse); const result = await files.read(file, 100, parse);
    expect(openMock).toHaveBeenCalledOnce(); expect(parse).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "error", reason: "无法解析来源" }); expect(result.value).toBeUndefined();
  });
});
