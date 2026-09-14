import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

// 合成 transport 测试进程；不是 Codex，也不是 runtime verification 证据。
const pending = [];
const lifecycle = JSON.parse(readFileSync(new URL("./lifecycle.json", import.meta.url), "utf8"));
let serverReplies = 0;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === "server-request") {
    serverReplies++; return;
  }
  if (request.method === "hold") return;
  const responses = { initialize: lifecycle.initialize, "thread/read": lifecycle.threadRead, "thread/resume": lifecycle.threadResume,
    "thread/loaded/list": { data: ["thread-a"], nextCursor: null }, "thread/turns/list": lifecycle.reconnect.before };
  if (Object.hasOwn(responses, request.method)) { send({ id: request.id, result: responses[request.method] }); return; }
  if (request.method === "reverse") {
    pending.push(request);
    if (pending.length === 2) for (const item of pending.reverse()) send({ id: item.id, result: item.params });
    return;
  }
  if (request.method === "malformed") process.stdout.write('{"SECRET":\n');
  if (request.method === "large") process.stdout.write("x".repeat(2048) + "\n");
  if (request.method === "fragment") {
    const text = JSON.stringify({ id: request.id, result: "中文分块" });
    const bytes = Buffer.from(text + "\n"); process.stdout.write(bytes.subarray(0, bytes.length - 5));
    setTimeout(() => process.stdout.write(bytes.subarray(bytes.length - 5)), 5); return;
  }
  if (request.method === "serverRequest") {
    serverReplies = 0;
    send({ id: "server-request", method: "item/commandExecution/requestApproval", params: { threadId: "thread-a", turnId: "turn-a", itemId: "tool-a", command: "SECRET" } });
    setTimeout(() => send({ id: request.id, result: { replies: serverReplies } }), 25); return;
  }
  if (request.method === "failure") { send({ id: request.id, error: { code: -32601, message: "SECRET", data: { prompt: "SECRET" } } }); return; }
  if (request.method === "notification") send({ method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "idle" } } });
  if (request.method === "partialClose") { process.stdout.write('{"SECRET":'); process.exitCode = 0; process.stdin.destroy(); return; }
  if (request.method === "stderrClose") { process.stderr.write("sqlite database: permission denied SECRET\n"); process.exitCode = 1; process.stdin.destroy(); return; }
  if (request.id !== undefined) send({ id: request.id, result: "ok" });
});
