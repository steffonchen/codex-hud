import { t } from "../../../i18n/Messages.js";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { AppServerError, type AppServerClient } from "../app-server/AppServerProtocol.js";
import { record } from "../Diagnostics.js";
import { unknownCapabilities, type RuntimeCandidate, type RuntimeCapabilities } from "./RuntimeCandidate.js";

export async function runtimeDeadline<T>(operation: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppServerError("timeout", code)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export const unsupportedMethod = (error: unknown): boolean => error instanceof AppServerError && error.kind === "request" && error.code === -32601;
export interface RuntimeProbeResult {
  candidate: RuntimeCandidate;
  capabilities: RuntimeCapabilities;
  initialized: boolean;
  loadedThreads: string[];
}

export class RuntimeProbe {
  constructor(private readonly options: { codexHome: string; cliVersion?: string; connectTimeoutMs?: number; requestTimeoutMs?: number; totalTimeoutMs?: number }) {}

  async probe(original: RuntimeCandidate, client: AppServerClient, threadId?: string): Promise<RuntimeProbeResult> {
    const candidate = structuredClone(original), capabilities = unknownCapabilities();
    const result: RuntimeProbeResult = { candidate, capabilities, initialized: false, loadedThreads: [] };
    let transportIssue: AppServerError | undefined;
    const unsubscribeIssue = client.onIssue(issue => {
      if (issue.kind === "transport" && ["database-permission", "invalid-argument", "EACCES", "EPERM", "EMFILE"].includes(String(issue.code))) transportIssue = issue;
    });
    let active = true;
    const check = () => { if (!active) throw new AppServerError("transport", "probe-cancelled"); };
    const request = async (method: string, params?: unknown) => {
      check();
      const value = await runtimeDeadline(client.request(method, params), this.options.requestTimeoutMs ?? 5000, "probe-request");
      check(); return value;
    };
    try {
      if (candidate.ownership === "external" && (candidate.owner !== "verified" || candidate.permissions !== "verified"
        || candidate.process !== "verified" || !candidate.endpointVerified || !candidate.pid || !candidate.executable
        || !candidate.processStartedAt)) throw new AppServerError("transport", "unverified-runtime");
      await runtimeDeadline((async () => {
        await runtimeDeadline(client.start(), this.options.connectTimeoutMs ?? 3000, "connect"); check();
        const initialized = record(await request("initialize", { clientInfo: { name: "codex-hud", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false } }));
        if (!initialized || typeof initialized.userAgent !== "string" || typeof initialized.codexHome !== "string"
          || !path.isAbsolute(initialized.codexHome)) throw new AppServerError("protocol", "initialize");
        const [expectedHome, actualHome] = await Promise.all([realpath(this.options.codexHome), realpath(initialized.codexHome)]);
        check(); candidate.homeMatch = expectedHome === actualHome;
        if (!candidate.homeMatch) throw new AppServerError("protocol", "home-mismatch");
        await runtimeDeadline(client.notify("initialized"), this.options.requestTimeoutMs ?? 5000, "initialized"); check();
        result.initialized = true;
        if (candidate.pid !== undefined && candidate.ownership === "external") {
          try {
            const diagnostics = record(await request("server/diagnostics", {}));
            if (record(diagnostics?.process)?.id !== candidate.pid) throw new AppServerError("protocol", "process-mismatch");
          } catch (error) { throw unsupportedMethod(error) ? new AppServerError("protocol", "process-unverified") : error; }
        }
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 32; page++) {
          let response;
          try { response = record(await request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) })); }
          catch (error) { if (unsupportedMethod(error)) { capabilities.loadedThreads = "unsupported"; break; } throw error; }
          if (!response || !Array.isArray(response.data) || response.data.length > 4096
            || response.data.some(id => typeof id !== "string" || !/^[\w-]{1,128}$/u.test(id))) throw new AppServerError("protocol", "loaded-threads");
          result.loadedThreads.push(...response.data as string[]);
          capabilities.loadedThreads = "supported";
          if (response.nextCursor === null) break;
          if (typeof response.nextCursor !== "string" || !response.nextCursor || response.nextCursor.length > 8192
            || cursors.has(response.nextCursor) || page === 31) throw new AppServerError("protocol", "loaded-cursor");
          cursor = response.nextCursor; cursors.add(cursor);
        }
        if (threadId) {
          try {
            const response = record(await request("thread/read", { threadId, includeTurns: false }));
            const thread = record(response?.thread);
            if (thread?.id !== threadId) throw new AppServerError("protocol", "thread-mismatch");
            capabilities.threadRead = "supported";
            const status = record(thread.status)?.type;
            candidate.thread = result.loadedThreads.includes(threadId) && ["active", "idle"].includes(String(status)) ? "loaded" : "stored";
          } catch (error) {
            if (error instanceof AppServerError && error.kind === "request") {
              candidate.thread = "missing"; candidate.reason = t("目标线程读取失败，未附着其他线程");
              if (unsupportedMethod(error)) capabilities.threadRead = "unsupported";
            } else throw error;
          }
        } else candidate.thread = "unknown";
        candidate.state = "running";
        candidate.compatibility = capabilities.threadRead === "unsupported" ? "incompatible"
          : capabilities.loadedThreads === "unsupported" || !candidate.codexVersion
            || this.options.cliVersion?.replace(/^codex-cli\s+/u, "") !== candidate.codexVersion ? "compatible-with-fallback" : "compatible";
        candidate.health = candidate.thread === "loaded" ? "healthy" : "degraded";
      })(), this.options.totalTimeoutMs ?? 15_000, "probe");
      return result;
    } catch (error) {
      active = false;
      candidate.state = "unavailable"; candidate.health = "unhealthy";
      candidate.compatibility = error instanceof AppServerError && error.kind === "protocol" ? "incompatible" : "unknown";
      candidate.reason = transportIssue?.message ?? (error instanceof AppServerError ? error.message : t("Runtime probe 失败，未确认协议或 home"));
      return result;
    } finally {
      active = false;
      unsubscribeIssue();
      if (candidate.state === "unavailable") await client.stop();
    }
  }
}
