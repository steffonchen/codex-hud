import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cleanupRuntimeFixtures, makeHome } from "./runtime-authority/helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/runtime-process.mjs", import.meta.url));
const children: ChildProcessWithoutNullStreams[] = [], ownedPids = new Set<number>();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error;
} };
afterEach(async () => {
  for (const child of children.splice(0).reverse()) if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL"); await new Promise<void>(resolve => child.once("exit", () => resolve()));
  }
  for (const pid of ownedPids) if (alive(pid)) process.kill(pid, "SIGKILL");
  ownedPids.clear(); await cleanupRuntimeFixtures();
});
async function start(mode: string, endpoint: string, home: string, pid?: number) {
  const child = spawn(process.execPath, ["--import", "tsx", fixture, mode, endpoint, home, String(pid ?? "")], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child); let output = "", stderr = "";
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-2000); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const ready = await new Promise<{ pid?: number; childPid?: number; ownership?: string; runtimeId?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("合成进程启动超时")), 4000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", data => {
      output += data;
      const newline = output.indexOf("\n"); if (newline < 0) return;
      try { const result = JSON.parse(output.slice(0, newline)); clearTimeout(timeout); resolve(result); }
      catch (error) { clearTimeout(timeout); reject(error); }
    });
    void exit.then(() => { clearTimeout(timeout); reject(new Error(`合成进程在就绪前退出：${stderr}`)); });
  });
  if (ready.childPid) ownedPids.add(ready.childPid);
  return { child, ready, exit };
}

describe("真实 OS 子进程安全（合成 server，非 Codex runtime 验收）", () => {
  it.each(["SIGINT", "SIGTERM", "uncaughtException", "stop"])("external 模式 %s 退出只终止自有 proxy，外部服务仍可重新附着", async action => {
    const home = await makeHome(), endpoint = path.join(home, "external.sock");
    const external = await start("external", endpoint, home), hud = await start("hud-external", endpoint, home, external.child.pid);
    expect(hud.ready.ownership).toBe("external"); expect(alive(hud.ready.childPid!)).toBe(true);
    if (action === "uncaughtException") hud.child.stdin.write("crash\n");
    else if (action === "stop") hud.child.stdin.write("stop\n");
    else hud.child.kill(action as NodeJS.Signals);
    const result = await hud.exit; expect(result.code).toBe(action === "uncaughtException" ? 1 : 0);
    await vi.waitFor(() => expect(alive(hud.ready.childPid!)).toBe(false));
    expect(alive(external.child.pid!)).toBe(true);
    const restarted = await start("hud-external", endpoint, home, external.child.pid);
    expect(restarted.ready.runtimeId).toBe(hud.ready.runtimeId);
    restarted.child.stdin.write("stop\n"); await restarted.exit;
    expect(alive(external.child.pid!)).toBe(true);
  }, 10000);
  it.each(["SIGINT", "SIGTERM", "uncaughtException"])("owned 模式 %s 退出终止自有 server", async action => {
    const home = await makeHome(), hud = await start("hud-owned", "unused", home);
    expect(hud.ready.ownership).toBe("owned"); expect(alive(hud.ready.childPid!)).toBe(true);
    if (action === "uncaughtException") hud.child.stdin.write("crash\n"); else hud.child.kill(action as NodeJS.Signals);
    await hud.exit; await vi.waitFor(() => expect(alive(hud.ready.childPid!)).toBe(false));
  }, 10000);
});
