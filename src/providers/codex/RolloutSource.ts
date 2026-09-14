import { t } from "../../i18n/Messages.js";
import type { HudEvent } from "../../core/HudEvent.js";
import { ROLLOUT_CAPABILITIES, type DataSource } from "../../core/source/DataSource.js";
import { eventIdentity } from "../../core/source/EventIdentity.js";
import { RolloutEventParser, type RolloutParseResult } from "./RolloutEventParser.js";
import { RolloutReader, type RolloutReadResult, type RolloutResetReason } from "./RolloutReader.js";

// 文件读取、顺序与来源元数据留在这里；既有 parser 和 tracker 的语义保持独立。
export class RolloutSource implements DataSource {
  readonly kind = "rollout" as const;
  readonly capabilities = ROLLOUT_CAPABILITIES;
  private readonly parser = new RolloutEventParser();
  private listeners = new Set<(event: HudEvent) => void>();
  private available = false;
  private generation = 0;
  private threadId?: string;
  private turnId?: string;
  private reading?: Promise<RolloutReadResult>;
  private stopWatch?: () => void;

  constructor(readonly reader = new RolloutReader()) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> { this.stopWatch?.(); this.stopWatch = undefined; await this.reading; this.available = false; }
  isAvailable(): boolean { return this.available; }
  getThreadId(): string | undefined { return this.threadId; }
  getTurnId(): string | undefined { return this.turnId; }
  onEvent(listener: (event: HudEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  read(filePath: string | undefined, handlers: { onReset?: (reason: RolloutResetReason) => void; onParsed?: (result: RolloutParseResult) => void } = {}): Promise<RolloutReadResult> {
    let history = !this.available;
    this.reading = this.reader.read(filePath, {
      onReset: reason => {
        this.generation++; this.parser.reset(); this.threadId = undefined; this.turnId = undefined; history = true;
        handlers.onReset?.(reason);
      },
      onLine: line => {
        let result: RolloutParseResult;
        try { result = this.parser.parse(line.text, line.number); }
        catch { result = { events: [], detections: { tokenCount: false, contextWindow: false, rateLimits: false, tools: false, activity: false },
          diagnostics: [{ code: "event-normalization", severity: "error", line: line.number, message: t("rollout 事件归一化失败，已跳过该行") }] }; }
        result.events = result.events.map((event, index) => {
          if (event.type === "session") this.threadId = event.id;
          if (event.type === "turn-started") this.turnId = event.id;
          return { ...event, source: "rollout", threadId: event.threadId ?? this.threadId,
            turnId: event.turnId ?? (event.type.startsWith("agent-") ? undefined : this.turnId), phase: history ? "history" : "live",
            sourceOrdinal: line.number, generation: this.generation,
            eventId: event.eventId ?? eventIdentity("rollout", this.threadId, line.number, index) } as HudEvent;
        });
        handlers.onParsed?.(result);
        for (const event of result.events) for (const listener of this.listeners) listener(event);
      },
    }).then(result => { this.available = result.status === "ready"; return result; });
    return this.reading;
  }

  watch(...args: Parameters<RolloutReader["watch"]>): () => void {
    this.stopWatch?.();
    const stop = this.reader.watch(...args);
    let stopped = false;
    this.stopWatch = () => { if (!stopped) { stopped = true; stop(); } };
    return this.stopWatch;
  }
}
