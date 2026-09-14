import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexSessionProvider } from "../../src/providers/codex/CodexSessionProvider.js";
import type { CodexRuntime } from "../../src/providers/codex/CodexDiscoveryProvider.js";
import { RolloutReader, type RolloutReadResult } from "../../src/providers/codex/RolloutReader.js";

const providers: CodexSessionProvider[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  await Promise.allSettled(providers.splice(0).map(provider => provider.stop()));
  vi.useRealTimers();
});
const runtime: CodexRuntime = { codexHome: "/fixture", sessionsPath: "/fixture/sessions", checks: [], diagnostics: [] };
const read: RolloutReadResult = { status: "ready", bytesRead: 0, offset: 0, linesRead: 0, pendingBytes: 0, diagnostics: [] };

describe("Codex Provider 持续生命周期", () => {
  it("首次发现慢于轮询间隔时，start 仍在首次结果后结算", async () => {
    const discovery = { discover: vi.fn(() => new Promise<CodexRuntime>(resolve => { setTimeout(() => resolve(runtime), 4000); })) };
    const provider = new CodexSessionProvider({ discovery });
    providers.push(provider);
    const snapshots = vi.fn();
    let started = false;
    const starting = provider.start({ onSnapshot: snapshots, onDiagnostic: vi.fn() }).then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(4000);
    await starting;
    expect(started).toBe(true);
    expect(snapshots).toHaveBeenCalledOnce();
    const stopping = provider.stop();
    await vi.advanceTimersByTimeAsync(4000);
    await stopping;
    expect(snapshots).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("发现失败可见并继续重试，未要求用户重新启动", async () => {
    const discovery = { discover: vi.fn().mockRejectedValueOnce({ code: "EIO" }).mockResolvedValue(runtime) };
    const provider = new CodexSessionProvider({ discovery });
    providers.push(provider);
    const snapshots = vi.fn();
    const diagnostics = vi.fn();
    let resolveSnapshot!: () => void;
    const snapshotReady = new Promise<void>(resolve => { resolveSnapshot = resolve; });
    await provider.start({ onSnapshot: snapshot => { snapshots(snapshot); resolveSnapshot(); }, onDiagnostic: diagnostics });
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ code: "live-refresh", severity: "error" }));
    expect(snapshots).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    await snapshotReady;
    expect(snapshots).toHaveBeenCalledOnce();
    await provider.stop();
  });

  it("文件通知合并且不重复 Discovery，停止等待在途读取并抑制发布", async () => {
    const discovery = { discover: vi.fn(async () => ({ ...runtime, currentRolloutPath: "/fixture/rollout-a.jsonl" })) };
    const reader = new RolloutReader();
    let changed!: () => void | Promise<void>;
    const close = vi.fn();
    vi.spyOn(reader, "watch").mockImplementation((_file, onChange) => { changed = onChange; return close; });
    const reads = vi.spyOn(reader, "read").mockResolvedValue(read);
    const provider = new CodexSessionProvider({ discovery, reader });
    providers.push(provider);
    const snapshots = vi.fn();
    await provider.start({ onSnapshot: snapshots, onDiagnostic: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    const initialReads = reads.mock.calls.length;
    let finish!: (result: RolloutReadResult) => void;
    reads.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    for (let index = 0; index < 100; index++) void changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveBeenCalledTimes(initialReads + 1);
    expect(discovery.discover).toHaveBeenCalledOnce();
    const published = snapshots.mock.calls.length;
    const storeChanged = vi.fn();
    provider.store.subscribe(storeChanged);
    const stopping = provider.stop();
    finish(read);
    await stopping;
    expect(snapshots).toHaveBeenCalledTimes(published);
    expect(storeChanged).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
