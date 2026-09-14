import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexDiscoveryProvider } from "../../src/providers/codex/CodexDiscoveryProvider.js";

let directory: string;
let home: string;
let bin: string;
const version = vi.fn(async () => "codex-cli 0.154.0\n");
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-discovery-"));
  home = path.join(directory, "home");
  bin = path.join(directory, "bin");
  await mkdir(path.join(home, "sessions", "2026", "09", "11"), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(bin, "codex"), "", { mode: 0o755 });
  version.mockClear();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function provider(extra: ConstructorParameters<typeof CodexDiscoveryProvider>[0] = {}) {
  return new CodexDiscoveryProvider({ env: { PATH: bin, CODEX_HOME: home }, cwd: directory, readVersion: version, ...extra });
}

async function rollout(id: string, modified: number, extra: Record<string, unknown> = {}) {
  const file = path.join(home, "sessions", "2026", "09", "11", `rollout-${id}.jsonl`);
  await writeFile(file, JSON.stringify({ timestamp: "2026-09-11T04:30:25.592Z", type: "session_meta", payload: {
    id, session_id: id, cwd: directory, source: "cli", cli_version: "0.154.0", ...extra,
  } }) + "\n");
  await utimes(file, modified, modified);
  return file;
}

describe("CodexDiscoveryProvider", () => {
  it("从 PATH 和 CODEX_HOME 发现运行环境，并保留 rollout 写入版本", async () => {
    const file = await rollout("main", 10, { cli_version: "0.153.4" });
    const runtime = await provider().discover();
    expect(runtime).toMatchObject({ codexHome: home, codexBinary: path.join(bin, "codex"), version: "codex-cli 0.154.0",
      currentSessionId: "main", currentRolloutPath: file, rolloutVersion: "0.153.4", selection: "working-directory" });
    expect(runtime.checks.filter(check => check.id !== "thread-context").every(check => check.ok)).toBe(true);
    expect(runtime.activeThreadId).toBeUndefined();
    expect(version).toHaveBeenCalledWith(path.join(bin, "codex"));
  });

  it("优先当前目录主会话，忽略更晚的其他目录和子代理", async () => {
    await rollout("older", 10);
    const file = await rollout("main", 20);
    await rollout("other", 30, { cwd: path.join(directory, "other") });
    await rollout("child", 40, { session_id: "main", source: { subagent: { thread_spawn: { parent_thread_id: "main" } } } });
    await rollout("child-parent", 50, { parent_thread_id: "main" });
    expect((await provider().discover()).currentRolloutPath).toBe(file);
  });

  it("当前目录没有主会话时采用最近主会话，自身 id 与 session_id 不混用", async () => {
    await rollout("other-main", 10, { cwd: "/other", session_id: "different" });
    const runtime = await provider().discover();
    expect(runtime.currentSessionId).toBe("other-main");
    expect(runtime.selection).toBe("recent");
  });

  it("忽略 sessions 中的符号链接目录，避免越界遍历", async () => {
    const elsewhere = path.join(directory, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(home, "sessions", "linked"));
    await writeFile(path.join(elsewhere, "rollout-hidden.jsonl"), '{"type":"session_meta","payload":{"id":"outside"}}\n');
    expect((await provider().discover()).currentRolloutPath).toBeUndefined();
  });

  it("binary 缺失不会阻止读取已有会话", async () => {
    await rollout("main", 10);
    const runtime = await provider({ env: { CODEX_HOME: home, PATH: "" } }).discover();
    expect(runtime.currentSessionId).toBe("main");
    expect(runtime.codexBinary).toBeUndefined();
    expect(version).not.toHaveBeenCalled();
    expect(runtime.checks.find(check => check.id === "binary")?.ok).toBe(false);
  });

  it("缺少 home、sessions 或 rollout 时返回逐项检查结果", async () => {
    const runtime = await provider({ codexHome: path.join(directory, "missing") }).discover();
    expect(runtime.currentRolloutPath).toBeUndefined();
    expect(runtime.checks.filter(check => !check.ok).map(check => check.id)).toEqual(["home", "sessions", "active-rollout", "thread-context"]);
  });

  it("不可执行的 PATH 文件不会被选中", async () => {
    await chmod(path.join(bin, "codex"), 0o600);
    expect((await provider().discover()).codexBinary).toBeUndefined();
  });

  it("版本错误保持可见，错误正文与凭证不进入诊断", async () => {
    await rollout("main", 10);
    const runtime = await provider({ readVersion: async () => { throw Object.assign(new Error("api_key=秘密"), { code: "EACCES" }); } }).discover();
    expect(runtime.currentSessionId).toBe("main");
    expect(runtime.diagnostics).toEqual([expect.objectContaining({ code: "version-read", message: "Codex version query failed (EACCES)" })]);
    expect(JSON.stringify(runtime)).not.toContain("秘密");
  });

  it("损坏、半写入或缺少 id 的首行被诊断并跳过", async () => {
    const valid = await rollout("main", 10);
    const invalid = await rollout("invalid", 20);
    await writeFile(invalid, '{"type":"session_meta","payload":"api_key=秘密"');
    const runtime = await provider().discover();
    expect(runtime.currentRolloutPath).toBe(valid);
    expect(runtime.diagnostics.some(item => item.code === "session-metadata")).toBe(true);
    expect(JSON.stringify(runtime)).not.toContain("秘密");
  });
});
