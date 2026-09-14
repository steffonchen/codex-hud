import { createHash } from "node:crypto";

export type RuntimeOwnership = "owned" | "external" | "unknown";
export type CompatibilityStatus = "compatible" | "compatible-with-fallback" | "incompatible" | "unknown";
export type RuntimeHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type RuntimeCapability = "supported" | "unsupported" | "unknown";
export interface RuntimeCapabilities {
  loadedThreads: RuntimeCapability;
  threadRead: RuntimeCapability;
  turnsList: RuntimeCapability;
  itemsList: RuntimeCapability;
  unsubscribe: RuntimeCapability;
  accountRead: RuntimeCapability;
  rateLimits: RuntimeCapability;
}

export interface RuntimeCandidate {
  id: string;
  kind: "managed-daemon" | "standalone" | "desktop-managed" | "unknown";
  transport: "unix-socket" | "stdio" | "websocket" | "unknown";
  ownership: RuntimeOwnership;
  endpoint?: string;
  pid?: number;
  executable?: string;
  processStartedAt?: string;
  codexVersion?: string;
  versionSource?: "process-binary" | "daemon-command";
  state: "running" | "starting" | "stopped" | "unknown" | "unavailable";
  source: "filesystem" | "process" | "environment" | "probe";
  owner: "verified" | "denied" | "unknown";
  permissions: "verified" | "denied" | "unknown";
  process: "verified" | "mismatch" | "unknown";
  endpointVerified: boolean;
  socketIdentity?: string;
  homeMatch?: boolean;
  compatibility: CompatibilityStatus;
  health: RuntimeHealth;
  thread?: "loaded" | "stored" | "missing" | "unknown";
  reason?: string;
}

export interface RuntimeCommands { stdio: boolean; proxy: boolean; daemon: boolean; daemonStart: boolean; daemonVersion: boolean }
export interface RuntimeDiscoveryResult {
  candidates: RuntimeCandidate[];
  status: "found" | "not-found" | "ambiguous" | "error";
  preferred?: RuntimeCandidate;
  discoveredAt: number;
  commands: RuntimeCommands;
  managed: "running" | "not-running" | "unknown";
  socket: "present" | "absent" | "unknown";
  processScan: "complete" | "unavailable";
  issues: string[];
}

export type AuthorityReason = "managed-daemon-active" | "existing-compatible-runtime" | "standalone-owned-by-hud"
  | "fallback-rollout" | "ambiguous-runtime" | "thread-authority-unknown" | "external-attach-disabled";

export interface RuntimeThreadAttachment {
  state: "detached" | "attaching" | "attached" | "lost" | "reconnecting";
  threadId?: string;
  runtimeId?: string;
  attachmentSource?: "environment" | "explicit" | "rollout";
}

export interface RuntimeSessionState {
  runtimeId?: string;
  runtimeStatus: "disconnected" | "connecting" | "connected" | "degraded";
  kind?: RuntimeCandidate["kind"];
  transport?: RuntimeCandidate["transport"];
  ownership: RuntimeOwnership;
  compatibility: CompatibilityStatus;
  health: RuntimeHealth;
  authority: AuthorityReason;
  source: "app-server" | "rollout" | "none";
  discovery: RuntimeDiscoveryResult["status"];
  candidateCount: number;
  managed: RuntimeDiscoveryResult["managed"];
  socket: RuntimeDiscoveryResult["socket"];
  probe: "success" | "failure" | "not-observed";
  thread: RuntimeThreadAttachment;
  capabilities: RuntimeCapabilities;
  serverVersion?: string;
  authenticated?: boolean;
  lastEventAt?: number;
  eventCount: number;
  pendingApprovals: number;
  approvalRequestsObserved: number;
  reconnectAttempts: number;
  reconnectExhausted: boolean;
  reason?: string;
}

export const unknownCapabilities = (): RuntimeCapabilities => ({ loadedThreads: "unknown", threadRead: "unknown", turnsList: "unknown",
  itemsList: "unknown", unsubscribe: "unknown", accountRead: "unknown", rateLimits: "unknown" });

export function runtimeIdentity(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

export function initialRuntimeState(): RuntimeSessionState {
  return { runtimeStatus: "disconnected", ownership: "unknown", compatibility: "unknown", health: "unknown",
    authority: "fallback-rollout", source: "none", discovery: "not-found", candidateCount: 0, managed: "unknown", socket: "unknown",
    probe: "not-observed", thread: { state: "detached" }, capabilities: unknownCapabilities(), eventCount: 0,
    pendingApprovals: 0, approvalRequestsObserved: 0, reconnectAttempts: 0, reconnectExhausted: false };
}
