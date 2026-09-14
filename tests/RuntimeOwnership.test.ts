import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AppServerProtocol } from "../src/providers/codex/app-server/AppServerProtocol.js";

const clients: AppServerProtocol[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.stop())); vi.useRealTimers(); });
function transport(holdWrite = false) {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: holdWrite ? new Writable({ write() {} }) : new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((_signal: NodeJS.Signals) => { child.exitCode = 0; queueMicrotask(() => child.emit("close", 0, null)); return true; }) });
  const spawnFake = () => { queueMicrotask(() => child.emit("spawn")); return child as unknown as ChildProcessWithoutNullStreams; };
  const client = new AppServerProtocol({ spawn: spawnFake as unknown as typeof spawn }); clients.push(client); return { child, client };
}
describe("协议 transport 清理上界", () => {
  it("pending write 在 stop 时立即拒绝，不残留 timer", async () => {
    vi.useFakeTimers(); const { child, client } = transport(true); await client.start();
    const pending = client.notify("initialized").catch(error => error); expect(client.getDiagnostics().pendingWrites).toBe(1);
    await client.stop(); expect(await pending).toMatchObject({ kind: "transport", code: "stopped" });
    expect(client.getDiagnostics()).toMatchObject({ pending: 0, pendingWrites: 0 }); expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });
  it("子进程已 exit 但 stdio 未 close 时仍受退出期限约束", async () => {
    vi.useFakeTimers(); const before = process.listenerCount("exit"), { child, client } = transport(); await client.start();
    child.exitCode = 0;
    const stopped = client.stop().catch(error => error); await vi.advanceTimersByTimeAsync(3500);
    expect(await stopped).toMatchObject({ kind: "timeout", code: "child-exit" });
    expect(child.kill).not.toHaveBeenCalled(); expect(child.stdout.destroyed).toBe(true); expect(child.stderr.destroyed).toBe(true);
    expect(process.listenerCount("exit")).toBe(before); expect(vi.getTimerCount()).toBe(0);
  });
});
