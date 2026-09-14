import { afterEach, describe, expect, it } from "vitest";
import { AppServerError } from "../src/providers/codex/app-server/AppServerProtocol.js";
import { RuntimeProbe } from "../src/providers/codex/runtime/RuntimeProbe.js";
import { RuntimeClient, candidate, cleanupRuntimeFixtures, deferred, makeHome } from "./runtime-authority/helpers.js";

afterEach(cleanupRuntimeFixtures);
describe("Runtime probe 的有界只读握手", () => {
  it("完成 initialize/initialized、home/PID 核验并识别已加载线程", async () => {
    const home = await makeHome(), client = new RuntimeClient(home);
    const result = await new RuntimeProbe({ codexHome: home, cliVersion: "codex-cli 0.154.0" }).probe(candidate(), client, "thread-a");
    expect(result).toMatchObject({ initialized: true, candidate: { state: "running", homeMatch: true, thread: "loaded", compatibility: "compatible" } });
    expect(client.notify).toHaveBeenCalledExactlyOnceWith("initialized");
    expect(client.request).toHaveBeenCalledWith("server/diagnostics", {});
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["initialize", "server/diagnostics", "thread/loaded/list", "thread/read"]);
    expect(client.stop).not.toHaveBeenCalled();
  });
  it.each(["home", "pid", "identity", "handshake"])("%s 不匹配时关闭连接并报告失败", async failure => {
    const home = await makeHome(), other = await makeHome(), client = new RuntimeClient(home);
    client.respond = method => failure === "home" && method === "initialize" ? { userAgent: "Codex", codexHome: other }
      : failure === "pid" && method === "server/diagnostics" ? { process: { id: 999 } }
      : failure === "identity" && method === "thread/read" ? { thread: { id: "thread-b" } }
      : failure === "handshake" && method === "initialize" ? { arbitrary: "SECRET" } : undefined;
    const result = await new RuntimeProbe({ codexHome: home }).probe(candidate(), client, "thread-a");
    expect(result.candidate).toMatchObject({ state: "unavailable", health: "unhealthy", compatibility: "incompatible" });
    expect(client.stop).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("版本不同由实际协议判断，userAgent 不被当作 server 版本", async () => {
    const home = await makeHome(), client = new RuntimeClient(home), probe = new RuntimeProbe({ codexHome: home, cliVersion: "codex-cli 0.154.0" });
    const result = await probe.probe(candidate({ codexVersion: "0.153.4" }), client, "thread-a");
    expect(result.candidate).toMatchObject({ codexVersion: "0.153.4", compatibility: "compatible-with-fallback", state: "running" });
    expect((await probe.probe(candidate({ codexVersion: undefined }), new RuntimeClient(home), "thread-a")).candidate.codexVersion).toBeUndefined();
  });
  it("无法通过服务端 diagnostics 核验 PID 时保守拒绝外部连接", async () => {
    const home = await makeHome(), client = new RuntimeClient(home);
    client.respond = method => { if (method === "server/diagnostics") throw new AppServerError("request", -32601); };
    expect((await new RuntimeProbe({ codexHome: home }).probe(candidate(), client, "thread-a")).candidate).toMatchObject({ state: "unavailable", reason: expect.stringContaining("process-unverified") });
  });
  it("有历史但未加载的线程只标记 stored，不发 resume", async () => {
    const home = await makeHome(), client = new RuntimeClient(home); client.loaded.clear();
    expect((await new RuntimeProbe({ codexHome: home }).probe(candidate(), client, "thread-a")).candidate.thread).toBe("stored");
    expect(client.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
  });
  it("不支持 loaded/list 或 read 的响应分别形成能力证据", async () => {
    const home = await makeHome(), client = new RuntimeClient(home);
    client.respond = method => { if (["thread/loaded/list", "thread/read"].includes(method)) throw new AppServerError("request", -32601); };
    const result = await new RuntimeProbe({ codexHome: home }).probe(candidate(), client, "thread-a");
    expect(result.capabilities).toMatchObject({ loadedThreads: "unsupported", threadRead: "unsupported" });
    expect(result.candidate.compatibility).toBe("incompatible");
  });
  it("loaded/list 循环 cursor 被拒绝，不无限分页", async () => {
    const home = await makeHome(), client = new RuntimeClient(home);
    client.respond = method => method === "thread/loaded/list" ? { data: [], nextCursor: "same" } : undefined;
    const result = await new RuntimeProbe({ codexHome: home }).probe(candidate(), client, "thread-a");
    expect(result.candidate.state).toBe("unavailable");
    expect(client.request.mock.calls.filter(([method]) => method === "thread/loaded/list")).toHaveLength(2);
  });
  it("连接超时会停止 client，迟到 start 不会继续握手", async () => {
    const home = await makeHome(), client = new RuntimeClient(home), pending = deferred<void>();
    client.start.mockReturnValue(pending.promise);
    const result = await new RuntimeProbe({ codexHome: home, connectTimeoutMs: 10 }).probe(candidate(), client, "thread-a");
    pending.resolve(); await Promise.resolve();
    expect(result.candidate).toMatchObject({ state: "unavailable", reason: expect.stringContaining("timeout") });
    expect(client.request).not.toHaveBeenCalled(); expect(client.stop).toHaveBeenCalledOnce();
  });
  it("请求超时和拒绝连接均保持可见且不泄露错误正文", async () => {
    const home = await makeHome(), client = new RuntimeClient(home);
    client.respond = () => new Promise(() => {});
    const result = await new RuntimeProbe({ codexHome: home, requestTimeoutMs: 10 }).probe(candidate(), client, "thread-a");
    expect(result.candidate.reason).toContain("timeout"); expect(client.stop).toHaveBeenCalledOnce();
    const refused = new RuntimeClient(home); refused.start.mockRejectedValue(new AppServerError("transport", "ECONNREFUSED"));
    expect((await new RuntimeProbe({ codexHome: home }).probe(candidate(), refused, "thread-a")).candidate.reason).toContain("ECONNREFUSED");
  });
});
