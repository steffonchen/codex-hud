import type { HudEvent } from "../HudEvent.js";
import type { RuntimeSessionState } from "../../providers/codex/runtime/RuntimeCandidate.js";

export type DataSourceKind = "rollout" | "app-server";
export type ConnectionState = "starting" | "connected" | "disconnected" | "reconnecting" | "failed" | "stopped";
export type EventPhase = "history" | "live";

export interface EventMetadata {
  source?: DataSourceKind;
  eventId?: string;
  threadId?: string;
  turnId?: string;
  sourceOrdinal?: number;
  generation?: number;
  phase?: EventPhase;
}

export interface SourceCapabilities {
  liveEvents: boolean;
  history: boolean;
  tokenUsage: boolean;
  plans: boolean;
  tools: boolean;
  agents: boolean;
  quota: boolean;
  context: boolean;
}

export interface SourceStatus {
  runtime?: RuntimeSessionState;
  state: ConnectionState;
  available: boolean;
  live: boolean;
  unloadedThreadIds?: string[];
  transport: "stdio" | "stdio-proxy";
  protocol: "detected" | "unknown";
  schema: "v2";
  threadId?: string;
  history: "pending" | "ready" | "partial" | "unavailable";
  eventCount: number;
  unknownCount: number;
  reconnectCount: number;
  lastEvent?: string;
  lastEventAt?: number;
  connectedAt?: number;
  lastCheckedAt?: number;
  lastReconnectDurationMs?: number;
  invalidCount?: number;
  droppedCount?: number;
  reason?: string;
  capabilities: SourceCapabilities;
}

export interface DataSource {
  readonly kind: DataSourceKind;
  readonly capabilities: SourceCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  isAvailable(): boolean;
  onEvent(listener: (event: HudEvent) => void): () => void;
}

export interface DataSourceState {
  preferred: DataSourceKind;
  active: DataSourceKind | "none";
  degraded: boolean;
  rolloutAvailable: boolean;
  fallbackEnabled?: boolean;
  tokenSource?: DataSourceKind;
  appServer?: SourceStatus;
  deduplicated: number;
  issues: string[];
}

export const ROLLOUT_CAPABILITIES: Readonly<SourceCapabilities> = Object.freeze({ liveEvents: true, history: true,
  tokenUsage: true, plans: true, tools: true, agents: true, quota: true, context: true });
export const APP_SERVER_CAPABILITIES: Readonly<SourceCapabilities> = Object.freeze({ liveEvents: true, history: true,
  tokenUsage: true, plans: true, tools: true, agents: true, quota: true, context: true });
