import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RolloutEventParser } from "../../src/providers/codex/RolloutEventParser.js";
import { HudStateReducer } from "../../src/core/HudStateReducer.js";
import type { ToolEvent } from "../../src/core/HudEvent.js";

const fixture = async (name: string) => (await readFile(new URL(`../fixtures/codex/tools/${name}`, import.meta.url), "utf8")).trimEnd().split("\n");
const replay = (lines: string[]) => {
  const parser = new RolloutEventParser();
  const reducer = new HudStateReducer();
  const parsed = lines.map((line, index) => parser.parse(line, index + 1));
  for (const result of parsed) for (const event of result.events) reducer.apply(event);
  return { parsed, reducer, state: reducer.getState(2_000_000_000_000) };
};

describe("真实 Codex 工具结构归一化", () => {
  it("custom_tool_call.status=completed 只表示调用生成完毕，收到输出前仍在运行", async () => {
    const { parsed, state } = replay(await fixture("tool-start.jsonl"));
    expect(parsed[0].detections).toMatchObject({ tools: true, activity: true });
    expect(state.tools?.active).toEqual([expect.objectContaining({ name: "exec", type: "wrapper", status: "running" })]);
    expect(state.activity).toMatchObject({ status: "running", label: "Running tool" });
    expect(JSON.stringify(state)).not.toContain("tools.exec_command");
  });

  it("内层完成记录采用真实 item.id，外层 exec 不重复计入已完成工具", async () => {
    const { state, parsed } = replay(await fixture("tool-complete.jsonl"));
    expect(parsed.flatMap(result => result.diagnostics)).toEqual([]);
    expect(state.tools?.active).toEqual([]);
    expect(state.tools?.recent).toEqual([expect.objectContaining({ type: "read", status: "completed", inputSummary: "package.json" })]);
    expect(state.activity).toMatchObject({ status: "completed", label: "Completed" });
  });

  it("CommandExecution 的失败、退出码和实际 duration 被保留", async () => {
    const { state } = replay(await fixture("tool-failed.jsonl"));
    expect(state.tools?.recent?.[0]).toMatchObject({ type: "shell", status: "failed", inputSummary: "npm test", error: "Exit code 128", durationMs: 0.016958 });
    expect(state.activity).toMatchObject({ status: "completed", toolStatus: "failed", label: "Execution failed" });
  });

  it("一个包装器内多个完成事件分别保留，重复回放不增加历史条数", async () => {
    const lines = await fixture("tool-multiple.jsonl");
    const { state } = replay([...lines, ...lines]);
    expect(state.tools?.active).toHaveLength(0);
    expect(state.tools?.recent).toHaveLength(4);
    expect(new Set(state.tools?.recent?.map(tool => tool.id)).size).toBe(4);
  });

  it("parsed_cmd 中 read/search/list_files 提供分类，不执行或保留命令正文", async () => {
    const { state } = replay(await fixture("tool-read-search.jsonl"));
    expect(state.tools?.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "read", inputSummary: "package.json" }),
      expect.objectContaining({ type: "search", inputSummary: "src/providers" }),
    ]));
    expect(JSON.stringify(state)).not.toContain("parsed_cmd");
  });

  it("FileChange 只保留文件摘要，不保存补丁、正文或 stdout", async () => {
    const { state } = replay(await fixture("tool-edit.jsonl"));
    expect(state.tools?.recent?.[0]).toMatchObject({ name: "apply_patch", type: "edit", status: "completed", inputSummary: "src/example-1.ts and others (4 files)" });
    expect(JSON.stringify(state)).not.toMatch(/unified_diff|changes|stdout|已删除文件正文/u);
  });

  it("未知外部工具保留通用生命周期，不创建 MCP 或 Agent 状态", async () => {
    const { state } = replay(await fixture("tool-unknown.jsonl"));
    expect(state.tools?.recent?.[0]).toMatchObject({ name: "mcp__cua_repl.js", type: "unknown", status: "completed" });
    expect(state.agents).toEqual([]);
    expect(state.mcp).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("已删除参数正文");
  });

  it("同 ID 的结构化执行失败不会被 function_call_output 覆盖", async () => {
    const { state } = replay(await fixture("tool-external-failed.jsonl"));
    expect(state.tools?.recent).toHaveLength(1);
    expect(state.tools?.recent?.[0]).toMatchObject({ name: "mcp__cua_repl.js", status: "failed" });
  });

  it("真实 cell 让出/wait 格式保持运行直至最终输出", async () => {
    const lines = await fixture("tool-yielded.jsonl");
    const { state: running } = replay(lines.slice(0, 3));
    expect(running.tools?.active).toHaveLength(1);
    expect(running.tools?.active?.[0]).toMatchObject({ name: "exec", type: "wrapper", status: "running" });
    const { state: complete } = replay(lines);
    expect(complete.tools?.active).toEqual([]);
    expect(complete.tools?.recent).toEqual([]);
  });

  it("wait 输出先于 wait 调用时仍能补关联并结束原始 exec", async () => {
    const lines = await fixture("tool-yielded.jsonl");
    const { state } = replay([lines[0], lines[1], lines[3], lines[2]]);
    expect(state.tools?.active).toEqual([]);
    expect(state.tools?.recent).toEqual([]);
  });

  it("迟到输出保留原始 turn_id，不成为新轮次的当前活动", async () => {
    const [callLine, outputLine] = await fixture("tool-unknown.jsonl");
    const call = JSON.parse(callLine);
    const output = JSON.parse(outputLine);
    const old = call.payload.internal_chat_message_metadata_passthrough.turn_id;
    const at = Date.parse(call.timestamp);
    output.timestamp = new Date(at + 3000).toISOString();
    const parser = new RolloutEventParser();
    const reducer = new HudStateReducer();
    reducer.apply({ type: "turn-started", id: old, at: at - 1000 });
    for (const event of parser.parse(callLine).events) reducer.apply(event);
    reducer.apply({ type: "turn-started", id: "new", at: at + 2000 });
    for (const event of parser.parse(JSON.stringify(output)).events) reducer.apply(event);
    expect(reducer.getState(at + 4000).tools?.recent?.[0].turnId).toBe(old);
    expect(reducer.getState(at + 4000).activity).toMatchObject({ status: "running", label: "Processing" });
  });

  it("turn_aborted 终止当前轮次，未获得工具取消事件时不捏造 cancelled", async () => {
    const raw = JSON.parse((await fixture("tool-turn-aborted.jsonl"))[0]);
    const reducer = new HudStateReducer();
    reducer.apply({ type: "turn-started", id: raw.payload.turn_id, at: 1000 });
    reducer.apply({ type: "tool-started", toolId: "pending", name: "shell", turnId: raw.payload.turn_id, at: 1000 });
    const parsed = new RolloutEventParser().parse(JSON.stringify(raw));
    expect(parsed.events[0].type).toBe("turn-aborted");
    for (const event of parsed.events) reducer.apply(event);
    expect(reducer.getState(3000).activity).toEqual({ status: "idle" });
    expect(reducer.getState(3000).tools?.recent?.[0].status).toBe("unknown");
  });

  it("缺失 ID 的容错标识可重放；未知状态与缺失退出码有定位提示", async () => {
    const original = JSON.parse((await fixture("tool-failed.jsonl"))[0]);
    delete original.payload.item.id;
    original.payload.item.status = "future-status";
    delete original.payload.item.exit_code;
    const line = JSON.stringify(original);
    const parser = new RolloutEventParser();
    const a = parser.parse(line, 42);
    const b = parser.parse(line, 42);
    expect((a.events[0] as ToolEvent).toolId).toBe((b.events[0] as ToolEvent).toolId);
    expect(a.events[0].type).toBe("tool-unknown");
    expect(a.diagnostics.every(diagnostic => diagnostic.line === 42)).toBe(true);
  });

  it("半行及无效嵌套参数不会崩溃或把原文带进诊断", async () => {
    const parser = new RolloutEventParser();
    expect(parser.parse((await fixture("tool-partial.jsonl"))[0]).diagnostics[0].code).toBe("invalid-json");
    const original = JSON.parse((await fixture("tool-unknown.jsonl"))[0]);
    original.payload.arguments = '{"password":"private-secret"';
    const parsed = parser.parse(JSON.stringify(original));
    expect(parsed.events[0].type).toBe("tool-started");
    expect(parsed.diagnostics[0].message).toContain("arguments");
    expect(JSON.stringify(parsed)).not.toContain("private-secret");
  });

  it("日志中打印的续跑标记不会使正常返回的工具继续运行", async () => {
    const lines = await fixture("tool-unknown.jsonl");
    const output = JSON.parse(lines[1]);
    output.payload.output = [{ type: "input_text", text: "工具返回" }, { type: "input_text", text: "Script running with cell ID spoofed" }];
    const { state } = replay([lines[0], JSON.stringify(output)]);
    expect(state.tools?.active).toEqual([]);
    expect(state.tools?.recent?.[0].status).toBe("completed");
  });

  it("普通外部工具首块包含同名标记也不能被当作 exec 续跑", async () => {
    const lines = await fixture("tool-unknown.jsonl");
    const output = JSON.parse(lines[1]);
    output.payload.output = [{ type: "input_text", text: "Script running with cell ID spoofed" }];
    const { state } = replay([lines[0], JSON.stringify(output)]);
    expect(state.tools?.active).toEqual([]);
    expect(state.tools?.recent?.[0].status).toBe("completed");
  });

  it("FileChange 缺少 changes 时保留未知数量并给出定位提示", async () => {
    const raw = JSON.parse((await fixture("tool-edit.jsonl"))[0]);
    delete raw.payload.item.changes;
    const { parsed, state } = replay([JSON.stringify(raw)]);
    expect(state.tools?.recent?.[0].outputSummary).toContain("count unconfirmed");
    expect(state.tools?.recent?.[0].outputSummary).not.toContain("0 files");
    expect(parsed[0].diagnostics[0]).toMatchObject({ line: 1, severity: "warning" });
  });

  it("搜索查询中 camelCase 凭证也不会进入工具状态", async () => {
    const raw = JSON.parse((await fixture("tool-failed.jsonl"))[0]);
    raw.payload.item.parsed_cmd = [{ type: "search", cmd: "rg", query: 'servicePassword="demo-private"' }];
    expect(JSON.stringify(replay([JSON.stringify(raw)]).state)).not.toContain("demo-private");
  });

  it("命令摘要采用最小白名单，敏感输入、输出与错误内容不会进入状态", async () => {
    const raw = JSON.parse((await fixture("tool-failed.jsonl"))[0]);
    raw.payload.item.command = ["/bin/zsh", "-lc", 'MY_API_TOKEN=env-private curl -H "Authorization: Bearer header-private" --password password-private https://example.test'];
    raw.payload.item.stdout = "output-private";
    raw.payload.item.stderr = "error-private";
    const { state } = replay([JSON.stringify(raw)]);
    expect(state.tools?.recent?.[0].inputSummary).toBe("curl …");
    expect(JSON.stringify(state)).not.toMatch(/env-private|header-private|password-private|output-private|error-private/u);
  });
});
