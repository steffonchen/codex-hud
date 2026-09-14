import { t } from "../i18n/Messages.js";
import type { HudState } from "./HudState.js";
import { emptyHudState } from "./HudState.js";

export const MAX_PENDING_NOTIFICATIONS = 64;
export const MAX_REENTRANT_NOTIFICATIONS = 256;

export class StateStore {
  private state: HudState = emptyHudState();
  private listeners = new Set<(state: HudState) => void | Promise<void>>();
  private notificationErrors = { count: 0, lastMessage: "" };
  private notifying = false;
  private pendingNotifications: HudState[] = [];

  get(): HudState {
    return structuredClone(this.state);
  }

  replace(state: HudState = emptyHudState()): HudState {
    this.state = structuredClone(state);
    return this.notify();
  }

  patch(patch: Partial<HudState>): HudState {
    patch = structuredClone(patch);
    this.state = {
      ...this.state,
      ...patch,
      context: patch.context
        ? { ...this.state.context, ...patch.context }
        : this.state.context,
      quota: patch.quota
        ? { ...this.state.quota, ...patch.quota }
        : this.state.quota,
      session: patch.session
        ? { ...this.state.session, ...patch.session }
        : this.state.session,
      tools: patch.tools
        ? { ...this.state.tools, ...patch.tools }
        : this.state.tools,
      git: patch.git
        ? { ...this.state.git, ...patch.git }
        : this.state.git,
    };

    return this.notify();
  }

  subscribe(listener: (state: HudState) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getNotificationErrors(): { count: number; lastMessage: string } {
    return { ...this.notificationErrors };
  }
  getResourceCounts(): Record<string, number> { return { stateSubscribers: this.listeners.size, pendingStateNotifications: this.pendingNotifications.length }; }

  private notify(): HudState {
    const snapshot = this.get();
    if (this.pendingNotifications.length >= MAX_PENDING_NOTIFICATIONS) {
      this.pendingNotifications[this.pendingNotifications.length - 1] = snapshot;
      this.recordNotificationError(new Error(t("StateStore 待通知队列达到上限，已合并为最新快照")));
    } else this.pendingNotifications.push(snapshot);
    if (this.notifying) return snapshot;
    this.notifying = true;
    try {
      // 重入更新排到当前通知之后，避免订阅者先收到新快照，再收到旧快照。
      let delivered = 0;
      while (this.pendingNotifications.length) {
        if (++delivered > MAX_REENTRANT_NOTIFICATIONS) {
          this.pendingNotifications = [];
          this.recordNotificationError(new Error(t("StateStore 重入通知超过安全上限，已停止本轮通知；最新状态仍可读取")));
          break;
        }
        const current = this.pendingNotifications.shift()!;
        for (const listener of [...this.listeners]) {
          if (!this.listeners.has(listener)) continue;
          try {
            const result = listener(structuredClone(current));
            if (result) void result.catch(error => this.recordNotificationError(error));
          } catch (error) { this.recordNotificationError(error); }
        }
      }
    } finally { this.notifying = false; }
    return snapshot;
  }

  private recordNotificationError(error: unknown): void {
    this.notificationErrors.count++;
    this.notificationErrors.lastMessage = error instanceof Error ? error.message.slice(0, 1000) : t("订阅回调抛出了非 Error 异常");
  }
}
