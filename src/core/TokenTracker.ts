import type { TokenUsage } from "./HudState.js";

/**
 * Tracks the latest cumulative token snapshot.
 *
 * Codex token_count messages are snapshots, not independent deltas.
 * Never sum consecutive cumulative snapshots.
 */
export class TokenTracker {
  private latest?: TokenUsage;

  update(snapshot: TokenUsage): void {
    this.latest = { ...snapshot };
  }

  getCurrent(): TokenUsage | undefined {
    return this.latest ? { ...this.latest } : undefined;
  }

  reset(): void {
    this.latest = undefined;
  }
}
