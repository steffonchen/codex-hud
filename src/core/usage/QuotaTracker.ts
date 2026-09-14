export interface QuotaWindow {
  usedPercent?: number;
  remainingPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
  source?: "measured" | "unknown";
}

export interface QuotaState {
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
  // 旧调用方的窗口接口仅投影真实时长匹配的窗口。
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
  planType?: string;
  limitId?: string;
  limitName?: string;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null };
  rateLimitReachedType?: string | null;
  spendControlReached?: boolean | null;
  scope?: "global";
  source?: "rollout" | "protocol" | "unknown";
  availability?: "available" | "partial" | "empty" | "unavailable" | "unreliable";
  timestamp?: number;
}

export class QuotaTracker {
  private state?: QuotaState;
  private ordinal?: number;
  private timestamp?: number;

  reset(): void { this.state = undefined; this.ordinal = undefined; this.timestamp = undefined; }

  apply(state: QuotaState | undefined, ordinal?: number, at?: number): boolean {
    if ((ordinal !== undefined && (!Number.isSafeInteger(ordinal) || ordinal < 0)) || (at !== undefined && (!Number.isFinite(at) || at < 0))) return false;
    if (ordinal !== undefined ? this.ordinal !== undefined && ordinal <= this.ordinal : at !== undefined && this.timestamp !== undefined && at < this.timestamp) return false;
    this.ordinal = ordinal ?? this.ordinal;
    this.timestamp = at ?? this.timestamp;
    this.state = state && structuredClone({ ...state, timestamp: at });
    return true;
  }

  snapshot(): QuotaState | undefined { return this.state && structuredClone(this.state); }
}
