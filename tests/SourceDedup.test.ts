import { describe, expect, it } from "vitest";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import type { HudEvent } from "../src/core/HudEvent.js";
import { SourceDeduplicator } from "../src/core/source/SourceDeduplicator.js";
import { SourceAuthorityPolicy } from "../src/core/source/SourceAuthorityPolicy.js";
import { eventIdentity } from "../src/core/source/EventIdentity.js";
import { tokenEvent } from "./app-server/helpers.js";

const setup = (limit = 2048) => {
  const source = new SourceDeduplicator(new SourceAuthorityPolicy(), limit), reducer = new HudStateReducer();
  reducer.apply({ type: "session", id: "thread-a" });
  const apply = (event: HudEvent) => source.consume(event).forEach(accepted => reducer.apply(accepted));
  const live = (value: boolean) => source.setAppServerLive(value).forEach(accepted => reducer.apply(accepted));
  const state = () => reducer.getState(0);
  return { source, apply, live, state };
};
const plan = (source: "rollout" | "app-server", name: string, ordinal: number, generation = 1): HudEvent => ({ type: "plan-updated", source,
  threadId: "thread-a", turnId: "turn-a", eventId: `${source}-${generation}-${ordinal}`, ordinal, sourceOrdinal: ordinal, generation,
  phase: source === "rollout" ? "history" : "live", steps: [{ title: name, status: "pending" }] });

describe("SourceDeduplicator", () => {
  it("身份编码不因分隔符发生碰撞", () => { expect(eventIdentity("a:b", "c")).not.toBe(eventIdentity("a", "b:c")); });
  it("Rollout 基线 → App 实时 → Rollout 镜像只入账一次", () => {
    const h = setup(); h.apply(tokenEvent("rollout", 1, 1)); h.live(true);
    h.apply(tokenEvent("app-server", 1, 1)); h.apply(tokenEvent("app-server", 2, 2)); h.apply(tokenEvent("rollout", 2, 2));
    expect(h.state().usage?.requestCount).toBe(2); expect(h.source.getTokenSource("thread-a")).toBe("app-server");
    expect(h.source.getPendingCount()).toBe(0); expect(h.source.getIssues()).toEqual([]);
  });
  it("先到达的 Rollout 待镜像尾部在断线后只应用一次", () => {
    const h = setup(); h.apply(tokenEvent("rollout", 1, 1)); h.live(true); h.apply(tokenEvent("app-server", 1, 1));
    h.apply(tokenEvent("rollout", 2, 2)); expect(h.state().usage?.requestCount).toBe(1);
    h.live(false); expect(h.state().usage?.requestCount).toBe(2); expect(h.source.getTokenSource("thread-a")).toBe("rollout");
  });
  it("仅卸载子线程时只交接该线程，不中断其他线程的实时权威", () => {
    const source = new SourceDeduplicator(); source.setAppServerLive(true);
    for (const id of ["thread-a", "child-a"]) {
      source.consume({ ...tokenEvent("rollout", 1, 1), threadId: id });
      source.consume({ ...tokenEvent("app-server", 1, 1), threadId: id });
      expect(source.consume({ ...tokenEvent("rollout", 2, 2), threadId: id })).toEqual([]);
    }
    const accepted = source.setAppServerLive(true, ["child-a"]);
    expect(accepted).toHaveLength(1); expect(accepted[0].threadId).toBe("child-a");
    expect(source.getTokenSource("child-a")).toBe("rollout"); expect(source.getTokenSource("thread-a")).toBe("app-server");
    expect(source.consume(tokenEvent("app-server", 2, 2))).toHaveLength(1);
  });
  it("断线时先补齐 App 已采用前缀，再应用 Rollout 新尾部", () => {
    const h = setup(); h.apply(tokenEvent("rollout", 1, 1)); h.live(true); h.apply(tokenEvent("app-server", 1, 1));
    h.apply(tokenEvent("app-server", 2, 2)); h.live(false);
    expect(h.source.getIssues().join()).toContain("catch up in order"); h.apply(tokenEvent("rollout", 2, 2)); h.apply(tokenEvent("rollout", 3, 3));
    expect(h.state().usage?.requestCount).toBe(3); expect(h.source.getIssues()).toEqual([]);
  });
  it("真实权威重算后相同快照再次出现仍可产生新请求", () => {
    const h = setup(); h.live(true);
    h.apply(tokenEvent("app-server", 1, 1)); h.apply(tokenEvent("app-server", 2, 2));
    h.apply(tokenEvent("app-server", 1, 3, 0)); h.apply(tokenEvent("app-server", 2, 4));
    expect(h.state().usage?.requestCount).toBe(3); expect(h.state().usage?.coverage).toBe("partial");
  });
  it("Rollout A→B→A→B 与迟到 App 的完整同序列交接不双计", () => {
    const h = setup(); [1, 2, 1, 2].forEach((n, i) => h.apply(tokenEvent("rollout", n, i + 1)));
    h.live(true); [1, 2, 1, 2].forEach((n, i) => h.apply(tokenEvent("app-server", n, i + 1)));
    expect(h.state().usage?.requestCount).toBe(3); expect(h.source.getTokenSource("thread-a")).toBe("app-server");
  });
  it("重复快照只有末值不足以确认位置，保留 Rollout 来源并报告", () => {
    const h = setup(); [1, 2, 1, 2].forEach((n, i) => h.apply(tokenEvent("rollout", n, i + 1)));
    h.live(true); h.apply(tokenEvent("app-server", 2, 1));
    expect(h.state().usage?.requestCount).toBe(3); expect(h.source.getTokenSource("thread-a")).toBe("rollout"); expect(h.source.getIssues()).not.toHaveLength(0);
  });
  it("迟到的压缩镜像不能清掉 App 压缩之后的新实测", () => {
    const h = setup(); h.live(true);
    h.apply({ type: "context-compacted", source: "app-server", threadId: "thread-a", turnId: "turn-a", sourceOrdinal: 1 });
    h.apply(tokenEvent("app-server", 1, 2));
    h.apply({ type: "context-compacted", source: "rollout", threadId: "thread-a", turnId: "turn-a", sourceOrdinal: 1 });
    h.apply(tokenEvent("rollout", 1, 2)); expect(h.state().usage?.tokens.last?.totalTokens).toBe(110);
  });
  it("迟到 App 历史快照不让 Rollout 累计量倒退", () => {
    const h = setup(); h.apply(tokenEvent("rollout", 1, 1)); h.apply(tokenEvent("rollout", 2, 2)); h.live(true);
    h.apply(tokenEvent("app-server", 1, 1)); h.apply(tokenEvent("app-server", 2, 2));
    expect(h.state().usage?.requestCount).toBe(2); expect(h.state().tokenUsage?.totalTokens).toBe(220);
  });
  it("超过 Tracker 的 512 条窗口后旧源序号仍被拒绝", () => {
    const h = setup(); h.live(true);
    for (let n = 1; n <= 650; n++) { h.apply(tokenEvent("app-server", n, n)); h.apply(tokenEvent("rollout", n, n)); }
    h.apply(tokenEvent("app-server", 1, 1)); h.apply(tokenEvent("rollout", 1, 1)); h.live(false);
    expect(h.state().usage?.requestCount).toBe(650); expect(h.state().usage?.droppedRecords).toBe(138);
    expect(h.state().tokenUsage?.totalTokens).toBe(71500);
  });
  it("重读按物理锚点对齐，A→B→A→B 不在第一个 B 解锁", () => {
    const h = setup();
    for (const generation of [1, 2]) [1, 2, 1, 2].forEach((n, i) => h.apply(tokenEvent("rollout", n, i + 1, 1, generation)));
    expect(h.state().usage?.requestCount).toBe(3);
    h.apply(tokenEvent("rollout", 3, 5, 1, 2)); expect(h.state().usage?.requestCount).toBe(4);
  });
  it("App 首快照之前的 Rollout 历史不能在断线后重新计入", () => {
    const h = setup(); h.live(true); h.apply(tokenEvent("app-server", 2, 1));
    h.apply(tokenEvent("rollout", 1, 1)); h.apply(tokenEvent("rollout", 2, 2)); h.live(false);
    expect(h.state().tokenUsage?.totalTokens).toBe(220); expect(h.state().usage?.requestCount).toBe(0);
    h.apply(tokenEvent("rollout", 3, 3)); expect(h.state().usage?.requestCount).toBe(1);
  });
  it("缺省缓存写入与协议默认零可以对齐，不填充 Rollout 报告值", () => {
    const h = setup(); const event = tokenEvent("rollout", 1, 1);
    if (event.type !== "tokens") throw new Error("fixture 类型");
    delete event.total!.cacheWriteInputTokens; delete event.last!.cacheWriteInputTokens;
    h.apply(event); h.live(true); h.apply(tokenEvent("app-server", 1, 1));
    expect(h.source.getTokenSource("thread-a")).toBe("app-server"); expect(h.state().usage?.tokens.total?.cacheWriteInputTokens).toBeUndefined();
  });
  it("队列有界且溢出明确报告，不能不确定地回退计费", () => {
    const h = setup(8); h.live(true);
    for (let n = 1; n <= 20; n++) h.apply(tokenEvent("app-server", n, n));
    h.live(false); expect(h.source.getPendingCount()).toBe(0); expect(h.source.getIssues().join()).toContain("safety limit");
    h.apply(tokenEvent("rollout", 1, 1)); expect(h.state().usage?.requestCount).toBe(20);
  });
  it("同源 Plan A→B→A 保留三次更新，跨来源同轮不覆盖", () => {
    const h = setup(); h.live(true);
    h.apply(plan("app-server", "A", 1)); h.apply(plan("app-server", "B", 2)); h.apply(plan("app-server", "A", 3)); h.apply(plan("rollout", "旧计划", 20));
    expect(h.state().planSummary?.execution?.steps[0].title).toBe("A"); expect(h.state().planSummary?.eventCount).toBe(3);
  });
  it("Rollout 调用顺序跨 history/live 读取批次仍优先于回执顺序", () => {
    const h = setup(); h.apply({ ...plan("rollout", "新计划", 20), sourceOrdinal: 30 });
    h.apply({ ...plan("rollout", "旧计划", 10), sourceOrdinal: 40, phase: "live" });
    expect(h.state().planSummary?.execution?.steps[0].title).toBe("新计划");
  });
  it("重复 delta 文本计为两段；重连同一条目等待完整结果", () => {
    const h = setup();
    const proposal = (generation: number): HudEvent => ({ type: "plan-proposed", source: "app-server", phase: "live", threadId: "thread-a", turnId: "turn-a",
      itemId: "proposal-a", text: "", complete: false, generation, sourceOrdinal: 1, ordinal: 1, eventId: `start-${generation}` });
    const delta = (generation: number, ordinal: number): HudEvent => ({ type: "plan-delta", source: "app-server", phase: "live", threadId: "thread-a", turnId: "turn-a",
      itemId: "proposal-a", delta: "AB", generation, ordinal, sourceOrdinal: ordinal, eventId: `delta-${generation}-${ordinal}` });
    h.apply(proposal(1)); h.apply(delta(1, 2)); h.apply(delta(1, 3)); expect(h.state().planSummary?.proposal?.streamedCharacters).toBe(4);
    h.apply(proposal(2)); h.apply(delta(2, 2)); expect(h.state().planSummary?.proposal?.streamedCharacters).toBe(4);
    expect(h.source.getIssues().join()).toContain("across disconnections");
    h.apply({ ...proposal(2), sourceOrdinal: 3, ordinal: 3, eventId: "final", type: "plan-proposed", itemId: "proposal-a", turnId: "turn-a", threadId: "thread-a", text: "完整正文", complete: true, source: "app-server" });
    expect(h.state().planSummary?.proposal?.text).toBe("完整正文");
  });
  it("工具 execution 失败优先于 call 成功；不同工具身份不合并", () => {
    const h = setup();
    h.apply({ type: "tool-completed", threadId: "thread-a", turnId: "turn-a", toolId: "a", source: "rollout", resultSource: "call", at: 200 });
    h.apply({ type: "tool-failed", threadId: "thread-a", turnId: "turn-a", toolId: "a", source: "app-server", resultSource: "execution", at: 100 });
    h.apply({ type: "tool-completed", threadId: "thread-a", turnId: "turn-a", toolId: "b", source: "app-server", resultSource: "execution" });
    expect(h.state().tools?.recent?.find(tool => tool.id === "a")?.status).toBe("failed"); expect(h.state().tools?.recent).toHaveLength(2);
  });
});
