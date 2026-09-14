import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/core/StateStore.js";

describe("StateStore 订阅", () => {
  it("重入更新按状态产生的先后顺序通知", () => {
    const store = new StateStore();
    const received: string[] = [];
    store.subscribe(state => { if (state.model === "A") store.patch({ model: "B" }); });
    store.subscribe(state => { received.push(state.model!); });
    store.replace({ model: "A" });
    expect(received).toEqual(["A", "B"]);
    expect(store.get().model).toBe("B");
  });

  it("通知多个订阅者，取消订阅后不再通知", () => {
    const store = new StateStore();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = store.subscribe(first);
    store.subscribe(second);
    store.replace({ model: "模型 A" });
    unsubscribe();
    unsubscribe();
    store.patch({ model: "模型 B" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(second.mock.calls[1][0].model).toBe("模型 B");
  });

  it("订阅者及返回快照的修改不影响其他订阅者和 Store", () => {
    const store = new StateStore();
    store.subscribe(state => { state.context!.usedTokens = 999; });
    const other = vi.fn();
    store.subscribe(other);
    const snapshot = store.replace({ context: { usedTokens: 10 } });
    snapshot.context!.usedTokens = 888;
    expect(other.mock.calls[0][0].context.usedTokens).toBe(10);
    expect(store.get().context?.usedTokens).toBe(10);
  });

  it("隔离同步和异步通知异常，诊断保持可查询", async () => {
    const store = new StateStore();
    store.subscribe(() => { throw new Error("同步通知失败"); });
    store.subscribe(async () => { throw new Error("异步通知失败"); });
    const healthy = vi.fn();
    store.subscribe(healthy);
    expect(() => store.replace({ model: "模型 A" })).not.toThrow();
    await Promise.resolve();
    expect(healthy).toHaveBeenCalledOnce();
    expect(store.getNotificationErrors()).toEqual({ count: 2, lastMessage: "异步通知失败" });
  });

  it("通知中取消订阅立即生效，新订阅从下一次更新开始", () => {
    const store = new StateStore();
    const removed = vi.fn();
    const added = vi.fn();
    let remove = () => {};
    store.subscribe(() => { remove(); store.subscribe(added); });
    remove = store.subscribe(removed);
    store.replace();
    expect(removed).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled();
    store.replace();
    expect(added).toHaveBeenCalledOnce();
  });
});
