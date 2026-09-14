import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, rename } from "node:fs/promises";
import { RuntimeConnectionManager } from "../src/providers/codex/runtime/RuntimeConnectionManager.js";
import { AppServerSource } from "../src/providers/codex/app-server/AppServerSource.js";
import { AppServerError } from "../src/providers/codex/app-server/AppServerProtocol.js";
import type { RuntimeCandidate } from "../src/providers/codex/runtime/RuntimeCandidate.js";
import { RuntimeClient, candidate, cleanupRuntimeFixtures, codexRuntime, deferred, discovery, makeHome, unixSocket } from "./runtime-authority/helpers.js";

const managers: RuntimeConnectionManager[] = [], sources: AppServerSource[] = [];
afterEach(async () => { await Promise.all(sources.splice(0).map(source => source.stop()));
  await Promise.all(managers.splice(0).map(manager => manager.disconnect())); await cleanupRuntimeFixtures(); });
function manager(options: ConstructorParameters<typeof RuntimeConnectionManager>[0]) {
  const value = new RuntimeConnectionManager(options); managers.push(value); value.setSelection("thread-a", "explicit"); return value;
}

describe("外部附着与连接管理", () => {
  it("共享候选握手一次后直接供 Source 使用，退出只关闭 client", async () => {
    const home = await makeHome(), socket = await unixSocket(home), client = new RuntimeClient(home);
    const discover = vi.fn(async () => discovery([socket.candidate])), createClient = vi.fn(() => client), verifyProcess = vi.fn(async () => true);
    const connection = manager({ runtime: codexRuntime(home), discovery: { discover }, createClient, verifyProcess });
    const source = new AppServerSource({ connectionManager: connection }); sources.push(source);
    await source.selectThread("thread-a", [], new Map(), "environment"); await source.start();
    expect(source.getStatus()).toMatchObject({ live: true, transport: "stdio-proxy", runtime: { ownership: "external", probe: "success",
      thread: { state: "attached", attachmentSource: "environment" }, authenticated: true } });
    expect(client.request.mock.calls.filter(([method]) => method === "initialize")).toHaveLength(1);
    expect(createClient).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ownership: "external" }));
    expect(verifyProcess).toHaveBeenCalledOnce();
    for (let i = 0; i < 100; i++) source.getStatus();
    expect(discover).toHaveBeenCalledOnce();
    await source.stop(); expect(client.stop).toHaveBeenCalledOnce(); expect(socket.server.listening).toBe(true);
    expect(JSON.stringify(source.getStatus())).not.toContain("不得输出@example.test");
  });
  it.each(["socket", "permission", "process"])("连接前 %s 证据变化时拒绝建立 client", async changed => {
    const home = await makeHome(), socket = await unixSocket(home), createClient = vi.fn(() => new RuntimeClient(home));
    if (changed === "socket") await rename(socket.endpoint, `${socket.endpoint}.moved`);
    if (changed === "permission") await chmod(socket.endpoint, 0o666);
    const connection = manager({ runtime: codexRuntime(home), createClient, verifyProcess: async () => changed !== "process" });
    await expect(connection.connectExternal(socket.candidate)).rejects.toBeInstanceOf(AppServerError);
    expect(createClient).not.toHaveBeenCalled();
  });
  it("身份或版本无法确认的 external 不能转为 owned spawn", async () => {
    const home = await makeHome(), socket = await unixSocket(home), client = new RuntimeClient(home), createClient = vi.fn((_item: RuntimeCandidate) => client);
    const connection = manager({ runtime: codexRuntime(home), discovery: { discover: async () => discovery([{ ...socket.candidate, codexVersion: undefined }]) },
      createClient, verifyProcess: async () => true });
    expect(await connection.open()).toBeUndefined(); expect(client.stop).toHaveBeenCalledOnce();
    expect(createClient.mock.calls.every(([item]) => item.ownership === "external")).toBe(true);
  });
  it("未承载指定线程的 shared runtime 不会收到 resume", async () => {
    const home = await makeHome(), socket = await unixSocket(home), client = new RuntimeClient(home); client.loaded.clear();
    const connection = manager({ runtime: codexRuntime(home), discovery: { discover: async () => discovery([socket.candidate]) },
      createClient: () => client, verifyProcess: async () => true });
    expect(await connection.open()).toBeUndefined();
    expect(client.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
  });
  it("禁止外部附着且禁止 spawn 时只做 discovery", async () => {
    const home = await makeHome(), createClient = vi.fn(() => new RuntimeClient(home));
    const connection = manager({ runtime: codexRuntime(home), policy: { allow_external_attach: false, allow_spawn: false },
      discovery: { discover: async () => discovery([candidate()]) }, createClient });
    expect(await connection.open()).toBeUndefined(); expect(createClient).not.toHaveBeenCalled();
  });
  it("旧 open 的 finally 只清理自己的候选，不停止新一代 probe", async () => {
    const home = await makeHome(), first = new RuntimeClient(home), second = new RuntimeClient(home), a = deferred<void>(), b = deferred<void>();
    first.start.mockReturnValue(a.promise); second.start.mockReturnValue(b.promise);
    const clients = [first, second];
    const connection = manager({ runtime: codexRuntime(home), discovery: { discover: async () => discovery() }, createClient: () => clients.shift()! });
    const openingA = connection.open().catch(error => error); await vi.waitFor(() => expect(first.start).toHaveBeenCalled());
    const openingB = connection.open(); await vi.waitFor(() => expect(second.start).toHaveBeenCalled());
    a.resolve(); expect(await openingA).toBeInstanceOf(AppServerError); expect(second.stop).not.toHaveBeenCalled();
    b.resolve(); expect((await openingB)?.client).toBe(second); expect(second.stop).not.toHaveBeenCalled();
    expect(first.stop).toHaveBeenCalledOnce();
  });
  it("旧 disconnect 完成时不覆盖已连接的新状态", async () => {
    const home = await makeHome(), first = new RuntimeClient(home), second = new RuntimeClient(home), stopped = deferred<void>();
    const clients = [first, second];
    const connection = manager({ runtime: codexRuntime(home), discovery: { discover: async () => discovery() }, createClient: () => clients.shift()! });
    await connection.open(); first.stop.mockReturnValue(stopped.promise);
    const stopping = connection.disconnect(); await connection.open(); stopped.resolve(); await stopping;
    expect(connection.getState().runtimeStatus).toBe("connected"); expect(second.stop).not.toHaveBeenCalled();
  });
  it("未选候选的 cleanup 失败保持可见", async () => {
    const home = await makeHome(), client = new RuntimeClient(home); client.loaded.clear(); client.threads.clear();
    client.respond = method => { if (method === "thread/read") throw new AppServerError("request", -32000); };
    client.stop.mockRejectedValueOnce(new Error("SECRET"));
    const connection = manager({ runtime: codexRuntime(home), discovery: { discover: async () => discovery() }, createClient: () => client });
    await expect(connection.open()).rejects.toMatchObject({ code: "cleanup-failed" });
    expect(connection.getState().reason).toContain("cleanup-failed");
  });
});
