import { describe, expect, it } from "vitest";
import { parseSkillMetadata } from "../../src/providers/codex/SkillDiscovery.js";
import { SkillEventParser } from "../../src/providers/codex/SkillEventParser.js";
import { capabilityFixture } from "../capabilities.js";

describe("Skills 定义和真实任务目录", () => {
  it("读取真实必要 frontmatter，忽略技能正文", async () => {
    const result = parseSkillMetadata(await capabilityFixture("skills", "single-skill.md"));
    expect(result.name).toBe("openai-docs"); expect(result.description).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("技能正文"); expect(result.version).toBeUndefined();
  });
  it("版本只取真实 metadata.version", async () => {
    expect(parseSkillMetadata(await capabilityFixture("skills", "skill-with-version.md"))).toMatchObject({ name: "archify", version: "2.16" });
    expect(parseSkillMetadata('---\nname: example\ndescription: example\nversion: "plugin-version"\n---\n').version).toBeUndefined();
  });
  it("支持 CRLF、单引号和行尾注释", () => {
    expect(parseSkillMetadata("---\r\nname: 'it''s-name' # 注释\r\ndescription: 内容 # 注释\r\n---\r\n")).toMatchObject({ name: "it's-name", description: "内容" });
  });
  it("支持实际字符串标量的折行描述", () => {
    expect(parseSkillMetadata('---\nname: example\ndescription: >-\n  第一行\n  第二行\n---\n').description).toBe("第一行 第二行");
  });
  it.each(['name: example', 'description: example', 'name: example\nname: duplicate\ndescription: example',
    'name: [example]\ndescription: example', 'name: true\ndescription: example', 'name: example\ndescription: "未闭合'])
    ("必要字段无效保持可观察错误：%s", value => { expect(() => parseSkillMetadata(`---\n${value}\n---\n`)).toThrow(); });
  it("截断头部不伪造正常定义", () => { expect(() => parseSkillMetadata('---\nname: private-name')).toThrow("Complete skill frontmatter missing"); });
  it.each(['metadata: [', 'metadata:\n  version: "2.16"\n  extra: "未闭合', 'extra: value\n  nested: invalid'])
    ("未使用字段损坏也不能确认可用：%s", value => {
      expect(() => parseSkillMetadata(`---\nname: example\ndescription: example\n${value}\n---\n`)).toThrow();
    });
  it("额外标量映射经过校验但不进入技能状态", () => {
    const result = parseSkillMetadata('---\nname: example\ndescription: example\nmetadata:\n  enabled: true\n  count: 2\n  version: "2.16"\nlicense: MIT\n---\n');
    expect(result).toEqual({ name: "example", description: "example", version: "2.16" });
  });
  it("描述中的凭据和控制字符被移除", () => {
    const value = parseSkillMetadata('---\nname: safe\ndescription: API_KEY=private-key\n---\nprivate-body');
    expect(value.description).toContain("redacted"); expect(JSON.stringify(value)).not.toMatch(/private-key|private-body/u);
  });
  it("真实目录保留 14 项和别名路径，不声明 loaded/active", async () => {
    const result = new SkillEventParser().parse(JSON.parse(await capabilityFixture("skills", "runtime-catalog.jsonl")));
    expect(result.diagnostics).toEqual([]);
    expect(result.events[0]).toMatchObject({ type: "skills-listed" });
    const event = result.events[0];
    if (event.type !== "skills-listed") throw new Error("目录事件缺失");
    expect(event.skills).toHaveLength(14);
    expect(event.skills.find(skill => skill.name === "archify")?.path).toBe("/fixture/skills-root-0/archify/SKILL.md");
    expect(event.skills.find(skill => skill.name === "documents:documents")).toBeDefined();
    expect(JSON.stringify(event)).not.toMatch(/active|loaded|skills_instructions/u);
  });
  it.each(["user", "assistant", "tool"])("不从 %s 消息解析能力目录", async role => {
    const raw = JSON.parse(await capabilityFixture("skills", "runtime-catalog.jsonl")); raw.payload.role = role;
    expect(new SkillEventParser().parse(raw).events).toEqual([]);
  });
  it("未知别名与非 SKILL.md 文件不进入发现列表", async () => {
    const raw = JSON.parse(await capabilityFixture("skills", "runtime-catalog.jsonl"));
    raw.payload.content[0].text = raw.payload.content[0].text.replace('r0/archify/SKILL.md', 'unknown/archify/SKILL.md').replace('r1/imagegen/SKILL.md', 'r1/imagegen/auth.json');
    const result = new SkillEventParser().parse(raw, 3);
    expect(result.diagnostics[0]).toMatchObject({ code: "skill-catalog-format", line: 3 });
    expect(JSON.stringify(result.events)).not.toContain("auth.json");
  });
  it("技能提及与完整正文不是目录事件", () => {
    expect(new SkillEventParser().parse({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Skill archify active" }] } }).events).toEqual([]);
  });
});
