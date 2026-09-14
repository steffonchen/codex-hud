import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityDetector, diagnosticText, inspectProtocol, probeCodex, readProtocolSchemas } from "../src/capabilities/CapabilityDetector.js";
import { mockState } from "../src/demo/mockState.js";
import { protocolSchemas, testSessionSnapshot } from "./fixtures.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: executeMock }),
}));

const directories: string[] = [];
beforeEach(() => { executeMock.mockReset(); });
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function exportFixture(directory: string) {
  for (const [name, schema] of Object.entries(protocolSchemas())) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), JSON.stringify(schema));
  }
}

describe("能力检测", () => {
  it("真实 rollout 能力由实际状态决定，不调用 App Server 协议探测", async () => {
    const probe = vi.fn(async () => ({ diagnostics: ["不应调用"] }));
    const detector = new CapabilityDetector(probe);
    const snapshot = await testSessionSnapshot();
    const report = detector.detectRollout(snapshot);
    expect(probe).not.toHaveBeenCalled();
    expect(report.source).toBe("rollout");
    expect(report.modules.filter(module => module.available).map(module => module.id)).toEqual(["model", "reasoning", "context", "five-hour-usage", "weekly-usage", "current-activity", "session", "token-details", "cost", "cache", "runtime-status"]);
    snapshot.read.status = "missing";
    expect(detector.detectRollout(snapshot).modules.filter(module => module.id !== "runtime-status").every(module => !module.available)).toBe(true);
  });

  it("按协议方法、字段与变体检测结构支持", () => {
    const detected = inspectProtocol(protocolSchemas());
    expect(Object.values(detected).every(capability => capability.supported)).toBe(true);
    expect(detected["five-hour-usage"].evidence.join()).toContain("300");
    expect(detected["weekly-usage"].evidence.join()).toContain("10080");
  });

  it("不能仅凭描述里的关键词或不完整字段报告支持", () => {
    const schemas = protocolSchemas();
    schemas["ClientRequest.json"] = { oneOf: [], description: "account/rateLimits/read thread/read model/list" };
    const detected = inspectProtocol(schemas);
    expect(detected.model.supported).toBe(false);
    expect(detected["five-hour-usage"].supported).toBe(false);
    const incomplete = protocolSchemas();
    incomplete["v2/GetAccountRateLimitsResponse.json"] = { definitions: { RateLimitWindow: { properties: { usedPercent: {} } } } };
    expect(inspectProtocol(incomplete)["weekly-usage"].supported).toBe(false);
  });

  it("协议支持与当前数据可用性分开，mock 计划不能变成可靠来源", async () => {
    const detector = new CapabilityDetector(async () => ({ version: "测试版本", schemas: protocolSchemas(), diagnostics: [] }));
    const report = await detector.detect(mockState(0));
    expect(report.source).toBe("mock");
    expect(report.modules.find(module => module.id === "model")?.available).toBe(true);
    expect(report.modules.find(module => module.id === "plan")).toMatchObject({ protocolSupported: true, available: false });
    expect(report.modules.find(module => module.id === "cost")).toMatchObject({ protocolSupported: true, available: false });
    const empty = await detector.detect({});
    expect(empty.modules.some(module => module.available)).toBe(false);
  });

  it("无法确认 Codex 时禁用相关模块并保留诊断，不影响有数据的本地 Git 模块", async () => {
    const detector = new CapabilityDetector(async () => ({ diagnostics: ["Codex 导出失败"] }));
    const report = await detector.detect(mockState(0));
    expect(report.diagnostics).toEqual(["Codex 导出失败"]);
    expect(report.modules.filter(module => module.available).map(module => module.id)).toEqual(["git"]);
    expect(report.modules.find(module => module.id === "model")?.protocolSupported).toBeNull();
  });

  it("只执行版本查询和离线 schema 导出，完成后清理临时目录", async () => {
    let exported = "";
    executeMock.mockImplementation(async (_command, args: string[]) => {
      if (args[0] === "--version") return { stdout: "codex-cli 测试版本\n", stderr: "" };
      exported = args.at(-1)!;
      await exportFixture(exported);
      return { stdout: "", stderr: "" };
    });
    const probe = await probeCodex();
    expect(probe.version).toBe("codex-cli 测试版本");
    expect(probe.diagnostics).toEqual([]);
    expect(probe.schemas).toBeDefined();
    expect(executeMock.mock.calls.map(call => call[1].slice(0, 3))).toEqual([["--version"], ["app-server", "generate-json-schema", "--out"]]);
    await expect(stat(exported)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("找不到 Codex 时提供明确诊断", async () => {
    executeMock.mockRejectedValueOnce(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT", syscall: "spawn codex" }));
    const probe = await probeCodex();
    expect(probe.version).toBeUndefined();
    expect(probe.diagnostics.join()).toContain("Codex CLI not found");
  });

  it.each(["失败", "超时"])("导出%s可见并清理目录", async kind => {
    executeMock.mockResolvedValueOnce({ stdout: "codex-cli 测试版本", stderr: "" });
    const error = kind === "超时"
      ? Object.assign(new Error("被终止"), { killed: true, signal: "SIGTERM" })
      : Object.assign(new Error("导出出错"), { code: 2, stderr: "不支持参数 --out；api_key=sk-secret123" });
    executeMock.mockRejectedValueOnce(error);
    const probe = await probeCodex();
    expect(probe.schemas).toBeUndefined();
    expect(probe.diagnostics.join()).toContain(kind === "失败" ? "failed" : "timed out");
    if (kind === "失败") {
      expect(probe.diagnostics.join()).toContain("不支持参数");
      expect(probe.diagnostics.join()).not.toContain("sk-secret123");
    }
    const directory = executeMock.mock.calls[1][1].at(-1);
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("已声明方法却缺少导出文件时报告错误，不能伪装成协议不支持", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-schema-test-"));
    directories.push(directory);
    await exportFixture(directory);
    await rm(path.join(directory, "v2/GetAccountRateLimitsResponse.json"));
    await expect(readProtocolSchemas(directory)).rejects.toThrow("Protocol declares account/rateLimits/read");
    const root = JSON.parse(await readFile(path.join(directory, "ClientRequest.json"), "utf8"));
    root.oneOf = root.oneOf.filter((item: { properties: { method: { enum: string[] } } }) => !item.properties.method.enum.includes("account/rateLimits/read"));
    await writeFile(path.join(directory, "ClientRequest.json"), JSON.stringify(root));
    expect(inspectProtocol(await readProtocolSchemas(directory))["weekly-usage"].supported).toBe(false);
  });

  it("导出根结构损坏时给出文件位置", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-schema-invalid-"));
    directories.push(directory);
    await exportFixture(directory);
    await writeFile(path.join(directory, "ServerNotification.json"), "{}");
    await expect(readProtocolSchemas(directory)).rejects.toThrow("ServerNotification.json");
  });

  it("诊断保留错误上下文并隐藏常见凭证格式", () => {
    const message = diagnosticText('失败：Authorization: Bearer abc123 api_key="test-key" password=foo sk-test123');
    expect(message).toContain("失败");
    for (const value of ["abc123", "test-key", "foo", "sk-test123"]) expect(message).not.toContain(value);
  });
});
