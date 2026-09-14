import { describe, expect, it } from "vitest";
import { TokenTracker } from "../src/core/TokenTracker.js";

describe("TokenTracker", () => {
  it("keeps the latest cumulative snapshot instead of summing snapshots", () => {
    const tracker = new TokenTracker();

    tracker.update({ inputTokens: 10_000, totalTokens: 10_000 });
    tracker.update({ inputTokens: 18_000, totalTokens: 18_000 });
    tracker.update({ inputTokens: 25_000, totalTokens: 25_000 });

    expect(tracker.getCurrent()?.totalTokens).toBe(25_000);
  });

  it("supports reset", () => {
    const tracker = new TokenTracker();
    tracker.update({ totalTokens: 10 });
    tracker.reset();
    expect(tracker.getCurrent()).toBeUndefined();
  });
});
