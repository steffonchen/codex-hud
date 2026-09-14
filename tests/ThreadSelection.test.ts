import { afterEach, describe, expect, it } from "vitest";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexDiscoveryProvider } from "../src/providers/codex/CodexDiscoveryProvider.js";
import { cleanupRuntimeFixtures, makeHome } from "./runtime-authority/helpers.js";

afterEach(cleanupRuntimeFixtures);
async function rollout(home: string, id: string, modified: number) {
  await mkdir(path.join(home, "sessions"), { recursive: true }); const file = path.join(home, "sessions", `rollout-${id}.jsonl`);
  await writeFile(file, JSON.stringify({ type: "session_meta", payload: { id, cli_version: "0.153.4", source: "cli", cwd: "/project" } }) + "\n");
  await utimes(file, modified, modified); return file;
}
describe("实时线程与历史 rollout 选择分离", () => {
  it("同一 home 的环境 ID 优先于修改时间", async () => {
    const home = await makeHome(), expected = await rollout(home, "active", 1); await rollout(home, "recent", 2);
    const result = await new CodexDiscoveryProvider({ codexHome: home, cwd: "/project", env: { PATH: "", CODEX_HOME: home,
      CODEX_THREAD_ID: "active", CODEX_SESSION_ID: "active" } }).discover();
    expect(result).toMatchObject({ activeThreadId: "active", currentSessionId: "active", currentRolloutPath: expected, selection: "environment" });
  });
  it("明确线程没有 rollout 时不回放别的历史", async () => {
    const home = await makeHome(); await rollout(home, "recent", 2);
    const result = await new CodexDiscoveryProvider({ codexHome: home, env: { PATH: "", CODEX_HOME: home, CODEX_THREAD_ID: "new-thread" } }).discover();
    expect(result).toMatchObject({ activeThreadId: "new-thread", currentSessionId: "new-thread" }); expect(result.currentRolloutPath).toBeUndefined();
  });
  it("没有明确身份时只显示历史，不按时间推断 live thread", async () => {
    const home = await makeHome(); await rollout(home, "recent", 2);
    const result = await new CodexDiscoveryProvider({ codexHome: home, cwd: "/project", env: { PATH: "" } }).discover();
    expect(result.currentSessionId).toBe("recent"); expect(result.activeThreadId).toBeUndefined();
  });
  it.each(["different-home", "conflict", "invalid"])("%s 环境不能提供附着依据", async invalid => {
    const home = await makeHome(), other = await makeHome(); await rollout(home, "recent", 2);
    const result = await new CodexDiscoveryProvider({ codexHome: home, env: { PATH: "", CODEX_HOME: invalid === "different-home" ? other : home,
      CODEX_THREAD_ID: invalid === "invalid" ? "bad\nSECRET" : "active", CODEX_SESSION_ID: invalid === "conflict" ? "other" : undefined } }).discover();
    expect(result.activeThreadId).toBeUndefined(); expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("调用方明确选择优先于环境，并验证 ID 格式", async () => {
    const home = await makeHome(); await rollout(home, "chosen", 1);
    const result = await new CodexDiscoveryProvider({ codexHome: home, threadId: "chosen", env: { PATH: "", CODEX_HOME: home, CODEX_THREAD_ID: "other" } }).discover();
    expect(result).toMatchObject({ activeThreadId: "chosen", selection: "explicit" });
    expect(() => new CodexDiscoveryProvider({ threadId: "invalid/id" })).toThrow("thread ID format");
  });
});
