import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TextDecoder } from "node:util";
import { record } from "../Diagnostics.js";

export interface RpcNotification { method: string; params?: unknown }
export interface RpcServerRequest { method: string; id: string | number; threadId?: string; turnId?: string; itemId?: string }
export class AppServerError extends Error {
  constructor(readonly kind: "transport" | "protocol" | "request" | "timeout", readonly code?: number | string) {
    super(`App Server ${kind}${code === undefined ? "" : `（${String(code).slice(0, 30)}）`}`);
  }
}

export interface AppServerClient {
  start(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(listener: (notification: RpcNotification) => void): () => void;
  onClose(listener: () => void): () => void;
  onIssue(listener: (issue: AppServerError) => void): () => void;
  onRequest?(listener: (request: RpcServerRequest) => void): () => void;
  getProcessId?(): number | undefined;
  getDiagnostics?(): { issues: number; listenerErrors: number; pending: number; pendingWrites: number };
  stop(): Promise<void>;
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export class AppServerProtocol implements AppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private writes = new Set<(error?: Error) => void>();
  private notifications = new Set<(notification: RpcNotification) => void>();
  private closeListeners = new Set<() => void>();
  private issueListeners = new Set<(issue: AppServerError) => void>();
  private requestListeners = new Set<(request: RpcServerRequest) => void>();
  private nextId = 0;
  private stopping?: Promise<void>;
  private closed?: Promise<void>;
  private buffer = Buffer.alloc(0);
  private skipping = false;
  private alive = false;
  private generation = 0;
  private exitListener?: () => void;
  private issueCount = 0;
  private listenerErrorCount = 0;
  private stderrCategories = new Set<"permission" | "database" | "argument">();
  readonly requestTimeoutMs: number;
  readonly maxMessageBytes: number;

  constructor(private readonly options: { executable?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv;
    requestTimeoutMs?: number; connectTimeoutMs?: number; maxMessageBytes?: number; spawn?: typeof spawn } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void { this.notifications.add(listener); return () => this.notifications.delete(listener); }
  onClose(listener: () => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  onIssue(listener: (issue: AppServerError) => void): () => void { this.issueListeners.add(listener); return () => this.issueListeners.delete(listener); }
  onRequest(listener: (request: RpcServerRequest) => void): () => void { this.requestListeners.add(listener); return () => this.requestListeners.delete(listener); }
  getProcessId(): number | undefined { return this.child?.pid; }
  getDiagnostics(): { issues: number; listenerErrors: number; pending: number; pendingWrites: number } {
    return { issues: this.issueCount, listenerErrors: this.listenerErrorCount, pending: this.pending.size, pendingWrites: this.writes.size };
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.alive) return;
    const generation = ++this.generation;
    this.buffer = Buffer.alloc(0); this.skipping = false; this.stderrCategories.clear();
    const child = (this.options.spawn ?? spawn)(this.options.executable ?? "codex", this.options.args ?? ["app-server", "--stdio"],
      { stdio: ["pipe", "pipe", "pipe"], cwd: this.options.cwd, env: this.options.env }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.alive = true;
    this.closed = new Promise(resolve => child.once("close", (code, signal) => {
      if (generation === this.generation) {
        if (this.alive && (code !== 0 || signal)) this.issue(new AppServerError("transport",
          this.stderrCategories.has("database") && this.stderrCategories.has("permission") ? "database-permission"
            : this.stderrCategories.has("argument") ? "invalid-argument" : signal ?? `exit-${code ?? "unknown"}`));
        if (this.buffer.length) this.issue(new AppServerError("protocol", "incomplete-line"));
        this.buffer = Buffer.alloc(0);
        this.alive = false;
        this.rejectPending(new AppServerError("transport", "closed"));
        if (this.exitListener) process.off("exit", this.exitListener);
        this.exitListener = undefined;
        for (const listener of this.closeListeners) this.deliver(listener);
      }
      resolve();
    }));
    // 正常 stop 先发送 SIGTERM；父进程已经进入 exit 时不能再等待异步清理。
    this.exitListener = () => { if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { process.exitCode = 1; }
    } };
    process.on("exit", this.exitListener);
    child.stdout.on("data", (chunk: Buffer) => { if (generation === this.generation) this.receive(chunk); });
    // stderr 可能含认证、路径和工具正文；仅记录固定错误分类，不保存或回显原文。
    child.stderr.on("data", (chunk: Buffer) => {
      if (generation !== this.generation) return;
      const text = chunk.toString("utf8");
      if (/permission denied|operation not permitted|os error (?:1|13)\b/i.test(text)) this.stderrCategories.add("permission");
      if (/sqlite|database/i.test(text)) this.stderrCategories.add("database");
      if (/unexpected argument|unrecognized option|unknown option/i.test(text)) this.stderrCategories.add("argument");
    });
    child.stdout.on("error", () => { if (generation === this.generation) this.issue(new AppServerError("transport", "stdout")); });
    child.stderr.on("error", () => { if (generation === this.generation) this.issue(new AppServerError("transport", "stderr")); });
    child.stdin.on("error", () => { if (generation === this.generation) this.issue(new AppServerError("transport", "stdin")); });
    child.on("error", error => {
      if (generation !== this.generation) return;
      const code = (error as NodeJS.ErrnoException).code;
      const safeCode = code && /^[A-Z0-9_]{1,20}$/.test(code) ? code : "spawn";
      this.issue(new AppServerError("transport", safeCode));
      this.rejectPending(new AppServerError("transport", safeCode));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => { clearTimeout(timer); child.off("spawn", spawned); child.off("error", failed); error ? reject(error) : resolve(); };
        const spawned = () => done();
        const failed = () => done(new AppServerError("transport", "spawn"));
        const timer = setTimeout(() => done(new AppServerError("timeout", "connect")), this.options.connectTimeoutMs ?? 3000);
        child.once("spawn", spawned); child.once("error", failed);
      });
    } catch (error) { await this.stop(); throw error; }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.alive) return Promise.reject(new AppServerError("transport", "closed"));
    if (this.pending.size >= 64) return Promise.reject(new AppServerError("request", "pending-limit"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppServerError("timeout")); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, ...(params === undefined ? {} : { params }) }).catch(error => {
        const pending = this.pending.get(id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error); }
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> { return this.write({ method, ...(params === undefined ? {} : { params }) }); }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.alive = false;
    this.rejectPending(new AppServerError("transport", "stopped"));
    const child = this.child;
    if (!child) return Promise.resolve();
    this.stopping = (async () => {
      const terminate = (signal: NodeJS.Signals) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { if (!child.kill(signal)) this.issue(new AppServerError("transport", "terminate-failed")); }
        catch { this.issue(new AppServerError("transport", "terminate-failed")); }
      };
      if (!child.stdin.destroyed) child.stdin.end();
      terminate("SIGTERM");
      const timer = setTimeout(() => terminate("SIGKILL"), 1500);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.closed, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new AppServerError("timeout", "child-exit")), 3500);
      })]); }
      finally { clearTimeout(timer); if (deadline) clearTimeout(deadline); this.buffer = Buffer.alloc(0);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (child.exitCode !== null || child.signalCode !== null) {
          this.child = undefined;
          if (this.exitListener) process.off("exit", this.exitListener);
          this.exitListener = undefined;
        }
      }
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private write(message: object): Promise<void> {
    const child = this.child;
    if (!this.alive || !child || child.stdin.destroyed) return Promise.reject(new AppServerError("transport", "closed"));
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > 1024 * 1024 || child.stdin.writableLength > 1024 * 1024) return Promise.reject(new AppServerError("request", "write-limit"));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        if (!this.writes.delete(finish)) return;
        clearTimeout(timer); error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new AppServerError("timeout", "write")), this.requestTimeoutMs);
      this.writes.add(finish);
      try { child.stdin.write(line, error => finish(error ? new AppServerError("transport", "write") : undefined)); }
      catch { finish(new AppServerError("transport", "write")); }
    });
  }

  private receive(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.skipping) {
        if (this.buffer.length + end - offset > this.maxMessageBytes) {
          this.buffer = Buffer.alloc(0); this.skipping = true;
          this.issue(new AppServerError("protocol", "message-limit"));
        } else this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
      }
      if (newline < 0) break;
      if (!this.skipping && this.buffer.length) this.line(this.buffer);
      this.buffer = Buffer.alloc(0); this.skipping = false; offset = newline + 1;
    }
  }

  private line(bytes: Buffer): void {
    let message: Record<string, unknown> | undefined;
    try { message = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
    catch { this.issue(new AppServerError("protocol", "invalid-json")); return; }
    if (!message || (message.jsonrpc !== undefined && message.jsonrpc !== "2.0")) { this.issue(new AppServerError("protocol", "envelope")); return; }
    const hasId = Object.hasOwn(message, "id");
    if (typeof message.method === "string") {
      if (hasId) {
        if (!(typeof message.id === "string" && message.id.length <= 128 || typeof message.id === "number" && Number.isSafeInteger(message.id))) {
          this.issue(new AppServerError("protocol", "request-id")); return;
        }
        const params = record(message.params);
        const id = (value: unknown) => typeof value === "string" && /^[\w-]{1,128}$/u.test(value) ? value : undefined;
        const request: RpcServerRequest = { id: message.id, method: message.method.slice(0, 160),
          threadId: id(params?.threadId) ?? id(params?.conversationId), turnId: id(params?.turnId), itemId: id(params?.itemId) ?? id(params?.callId) };
        // 观察者不能发送错误回执代替审批拒绝；决定由原客户端处理。
        for (const listener of this.requestListeners) this.deliver(() => listener(request));
        this.issue(new AppServerError("request", "observed-server-request"));
      } else for (const listener of this.notifications) this.deliver(() => listener({ method: message!.method as string, params: message!.params }));
      return;
    }
    if (!hasId || typeof message.id !== "number") { this.issue(new AppServerError("protocol", "response-id")); return; }
    const pending = this.pending.get(message.id);
    if (!pending) { this.issue(new AppServerError("protocol", "unknown-response")); return; }
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) {
      pending.reject(new AppServerError("protocol", "response")); return;
    }
    const error = record(message.error);
    if (Object.hasOwn(message, "error")) pending.reject(new AppServerError("request", typeof error?.code === "number" ? error.code : "server-error"));
    else pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const finish of this.writes) finish(error);
  }
  private issue(issue: AppServerError): void {
    this.issueCount++;
    for (const listener of this.issueListeners) { try { listener(issue); } catch { this.listenerErrorCount++; } }
  }
  private deliver(callback: () => void): void { try { callback(); } catch { this.issue(new AppServerError("protocol", "listener")); } }
}
