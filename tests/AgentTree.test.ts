import { describe, expect, it } from "vitest";
import { buildAgentTree, flattenAgentTree, legacyAgentTree } from "../src/core/AgentTree.js";
import type { AgentState } from "../src/core/AgentState.js";

const node = (id: string, parentId?: string): AgentState => ({ id, parentId, status: "running" });
describe("AgentTree 索引与异常父边", () => {
  it("空输入保持空树", () => { expect(buildAgentTree([])).toEqual({ tree: [], orphans: [], issues: [] }); });
  it("真实 ID 可以作为根，不能硬编码 main", () => { expect(buildAgentTree([node("uuid-root")]).tree[0].agent.id).toBe("uuid-root"); });
  it("构造三层树", () => { expect(buildAgentTree([node("a"), node("b", "a"), node("c", "b")]).tree[0].children[0].children[0].agent.id).toBe("c"); });
  it("输入子先父后不影响关系", () => { expect(buildAgentTree([node("child", "root"), node("root")]).tree[0].children[0].agent.id).toBe("child"); });
  it("重复 ID 不生成重复节点", () => { expect(flattenAgentTree(buildAgentTree([node("a"), node("a")]).tree)).toHaveLength(1); });
  it("缺少父节点保留到 orphans 并报告", () => {
    const graph = buildAgentTree([node("child", "missing")]); expect(graph.tree).toEqual([]); expect(graph.orphans[0].agent.id).toBe("child"); expect(graph.issues[0]).toContain("Orphan agent");
  });
  it("子代理缺少 parentId 也不伪装成根", () => { expect(buildAgentTree([{ ...node("a"), isSubagent: true }]).orphans).toHaveLength(1); });
  it("自环不产生循环对象", () => { const graph = buildAgentTree([node("a", "a")]); expect(graph.orphans).toHaveLength(1); expect(() => JSON.stringify(graph)).not.toThrow(); });
  it("多节点环保留每个节点一次", () => {
    const graph = buildAgentTree([node("a", "b"), node("b", "a"), node("c", "a")]);
    expect(flattenAgentTree(graph.orphans).map(entry => entry.agent.id).sort()).toEqual(["a", "b", "c"]); expect(graph.issues).toHaveLength(2);
  });
  it("深树构建和遍历不用递归调用栈", () => {
    const graph = buildAgentTree(Array.from({ length: 1000 }, (_, index) => node(`a${index}`, index ? `a${index - 1}` : undefined)));
    expect(flattenAgentTree(graph.tree)).toHaveLength(1000); expect(flattenAgentTree(graph.tree).at(-1)?.depth).toBe(999);
  });
  it("旧状态接口投影保留父子与 Token", () => {
    const graph = buildAgentTree([node("root"), { ...node("child", "root"), name: "tester", tokens: { totalTokens: 42 } }]);
    expect(legacyAgentTree(graph.tree)[0].children?.[0]).toMatchObject({ id: "child", role: "tester", tokens: { totalTokens: 42 } });
  });
  it("构树不修改输入", () => {
    const input = [node("a"), node("b", "a")]; const original = structuredClone(input); buildAgentTree(input).tree[0].agent.status = "completed"; expect(input).toEqual(original);
  });
});
