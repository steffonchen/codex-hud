import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { AppServerError, AppServerProtocol, type RpcServerRequest } from "../src/providers/codex/app-server/AppServerProtocol.js";

const clients: AppServerProtocol[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.stop())); });
const client = (options = {}) => {
  const value = new AppServerProtocol({ executable: process.execPath, args: [fileURLToPath(new URL("./fixtures/app-server/protocol-child.mjs", import.meta.url))], requestTimeoutMs: 1000, ...options });
  clients.push(value); return value;
};
describe("AppServerProtocol 合成子进程 transport", () => {
  it("响应按 id 匹配，允许反序返回", async () => {
    const rpc = client(); await rpc.start();
    expect(await Promise.all([rpc.request("reverse", { value: "first" }), rpc.request("reverse", { value: "second" })])).toEqual([{ value: "first" }, { value: "second" }]);
    expect(rpc.getDiagnostics().pending).toBe(0);
  });
  it("UTF-8 跨字节分块只生成一个完整响应", async () => {
    const rpc = client(); await rpc.start(); expect(await rpc.request("fragment")).toBe("中文分块");
  });
  it("非法 JSON 和超长行可诊断，后续响应仍正常", async () => {
    const rpc = client({ maxMessageBytes: 256 }); const issues: AppServerError[] = []; rpc.onIssue(error => issues.push(error)); await rpc.start();
    expect(await rpc.request("malformed")).toBe("ok"); expect(await rpc.request("large")).toBe("ok");
    expect(issues.map(error => error.code)).toEqual(["invalid-json", "message-limit"]); expect(JSON.stringify(issues)).not.toContain("SECRET");
  });
  it("服务器错误只暴露数值 code，不回显原始正文", async () => {
    const rpc = client(); await rpc.start(); const error = await rpc.request("failure").catch(error => error);
    if (!(error instanceof AppServerError)) throw new Error("服务器错误未按协议拒绝请求");
    expect(error).toMatchObject({ kind: "request", code: -32601 }); expect(error.message).not.toContain("SECRET");
  });
  it("审批请求只观察身份白名单，不发送批准、拒绝或错误回执", async () => {
    const rpc = client(), observed: RpcServerRequest[] = [];
    rpc.onRequest(request => observed.push(request));
    await rpc.start(); expect(await rpc.request("serverRequest")).toEqual({ replies: 0 });
    expect(observed).toEqual([{ id: "server-request", method: "item/commandExecution/requestApproval", threadId: "thread-a", turnId: "turn-a", itemId: "tool-a" }]);
    expect(JSON.stringify(observed)).not.toContain("SECRET");
  });
  it("超时释放 pending，stop 拒绝所有等待并释放进程", async () => {
    const rpc = client({ requestTimeoutMs: 40 }); await rpc.start();
    await expect(rpc.request("hold")).rejects.toMatchObject({ kind: "timeout" });
    const pending = rpc.request("hold").catch(error => error); await rpc.stop(); expect(await pending).toMatchObject({ kind: "transport" });
    expect(rpc.getDiagnostics().pending).toBe(0);
  });
  it("pending 数量有界，停止后可以重新启动同一 transport", async () => {
    const rpc = client(); await rpc.start(); const pending = Array.from({ length: 64 }, () => rpc.request("hold").catch(error => error));
    await expect(rpc.request("hold")).rejects.toMatchObject({ code: "pending-limit" }); await rpc.stop(); await Promise.all(pending);
    await rpc.start(); expect(await rpc.request("ping")).toBe("ok");
  });
  it("通知消费者和诊断消费者异常可计数，不中断读循环", async () => {
    const rpc = client(); rpc.onNotification(() => { throw new Error("SECRET"); }); rpc.onIssue(() => { throw new Error("SECRET"); });
    await rpc.start(); expect(await rpc.request("notification")).toBe("ok"); expect(rpc.getDiagnostics()).toMatchObject({ issues: 1, listenerErrors: 1 });
  });
  it("EOF 半行可诊断，不把半个响应伪装成功", async () => {
    const rpc = client(); const issues: AppServerError[] = []; rpc.onIssue(error => issues.push(error)); await rpc.start();
    await expect(rpc.request("partialClose")).rejects.toMatchObject({ kind: "transport" });
    expect(issues.some(error => error.code === "incomplete-line")).toBe(true);
  });
  it("异常 stderr 只输出数据库权限分类，不保存或显示正文", async () => {
    const rpc = client(); const issues: AppServerError[] = []; rpc.onIssue(error => issues.push(error)); await rpc.start();
    await expect(rpc.request("stderrClose")).rejects.toMatchObject({ kind: "transport" });
    expect(issues.some(error => error.code === "database-permission")).toBe(true); expect(JSON.stringify(issues)).not.toContain("SECRET");
  });
  it("不存在的 executable 可恢复报告，process exit listener 不泄漏", async () => {
    const before = process.listenerCount("exit"), rpc = client({ executable: "/nonexistent/codex-hud-phase8" });
    await expect(rpc.start()).rejects.toMatchObject({ kind: "transport" }); await rpc.stop(); expect(process.listenerCount("exit")).toBe(before);
  });
});
