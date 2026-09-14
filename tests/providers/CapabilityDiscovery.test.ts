import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CapabilityDiscovery } from "../../src/providers/codex/CapabilityDiscovery.js";
import type { CodexRuntime } from "../../src/providers/codex/CodexDiscoveryProvider.js";
import { capabilityFixture } from "../capabilities.js";

let directory: string;
let runtime: CodexRuntime;
let discovery: CapabilityDiscovery;
let definition: string;
let config: string;
const skillFile = (name: string) => path.join(runtime.userHome!, ".agents", "skills", name, "SKILL.md");
async function putSkill(name: string, text = definition): Promise<string> {
  const file = skillFile(name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); return file;
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-capability-discovery-"));
  runtime = { codexHome: path.join(directory, ".codex"), userHome: directory, workingDirectory: directory,
    sessionsPath: path.join(directory, ".codex", "sessions"), checks: [], diagnostics: [] };
  await mkdir(runtime.codexHome); config = path.join(runtime.codexHome, "config.toml");
  definition = await capabilityFixture("skills", "single-skill.md"); discovery = new CapabilityDiscovery();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("集中能力发现与缓存", () => {
  it("缺失来源与可读空来源不同", async () => {
    expect(await discovery.refresh(runtime, undefined, true)).toMatchObject({ mcp: { status: "missing", servers: [] }, skills: { status: "missing", skills: [] } });
    await writeFile(config, 'model="example"'); await mkdir(path.join(runtime.codexHome, "skills"));
    expect(await discovery.refresh(runtime, undefined, true)).toMatchObject({ mcp: { status: "ready", servers: [] }, skills: { status: "ready", skills: [] } });
  });
  it("配置 A 替换为 B，删除后无旧服务残留", async () => {
    await writeFile(config, '[mcp_servers.a]'); await discovery.refresh(runtime, undefined, true);
    await writeFile(config, '[mcp_servers.b]'); expect((await discovery.refresh(runtime, undefined, true)).mcp.servers.map(server => server.name)).toEqual(["b"]);
    await rm(config); expect((await discovery.refresh(runtime, undefined, true)).mcp.servers).toEqual([]);
  });
  it("损坏配置可观察、无旧数据，修复后清除错误", async () => {
    await writeFile(config, '[mcp_servers.a]'); await discovery.refresh(runtime, undefined, true);
    await writeFile(config, '[mcp_servers. private-secret');
    const failed = await discovery.refresh(runtime, undefined, true);
    expect(failed.mcp).toEqual({ status: "error", servers: [] }); expect(failed.diagnostics[0].code).toBe("mcp-configuration");
    expect(JSON.stringify(failed)).not.toContain("private-secret");
    await writeFile(config, '[mcp_servers.b]'); expect((await discovery.refresh(runtime, undefined, true)).diagnostics).toEqual([]);
  });
  it("不改变配置文件内容", async () => {
    const text = await capabilityFixture("mcp", "multiple-servers.toml"); await writeFile(config, text);
    await discovery.refresh(runtime, undefined, true); expect(await readFile(config, "utf8")).toBe(text);
  });
  it("无变化重复检查不重新读取文件，非发现刷新无 IO", async () => {
    await writeFile(config, '[mcp_servers.a]'); await putSkill("review");
    expect((await discovery.refresh(runtime, undefined, true)).io.filesRead).toBe(2);
    expect((await discovery.refresh(runtime, undefined, true)).io.filesRead).toBe(0);
    expect((await discovery.refresh(runtime, undefined, false)).io).toEqual({ stats: 0, filesRead: 0, bytesRead: 0, directories: 0 });
  });
  it("技能 A 删除后只保留 B", async () => {
    await putSkill("a"); await discovery.refresh(runtime, undefined, true);
    await rm(path.dirname(skillFile("a")), { recursive: true }); await putSkill("b", definition.replace('"openai-docs"', '"review-b"'));
    const result = await discovery.refresh(runtime, undefined, true);
    expect(result.skills.skills.map(skill => skill.name)).toEqual(["review-b"]);
  });
  it("同一文件变化只重新解析对应来源", async () => {
    const file = await putSkill("a"); await writeFile(config, '[mcp_servers.a]'); await discovery.refresh(runtime, undefined, true);
    await writeFile(file, await capabilityFixture("skills", "skill-with-version.md"));
    const result = await discovery.refresh(runtime, undefined, true);
    expect(result.io.filesRead).toBe(1); expect(result.skills.skills[0]).toMatchObject({ name: "archify", version: "2.16", status: "unknown" });
  });
  it("运行目录只为实际列出的定义确认 available", async () => {
    const file = await putSkill("a"); await putSkill("b");
    const result = await discovery.refresh(runtime, [{ name: "listed-a", path: file }], true);
    expect(result.skills.skills.filter(skill => skill.status === "available")).toHaveLength(1);
    expect(result.skills.skills.every(skill => skill.status !== "active")).toBe(true);
  });
  it("运行目录文件消失报告 unavailable，目录替换后清除旧引用", async () => {
    const file = await putSkill("a"); const catalog = [{ name: "a", path: file }]; await discovery.refresh(runtime, catalog, true);
    await rm(file); const gone = await discovery.refresh(runtime, catalog, true);
    expect(gone.skills.skills[0].status).toBe("unavailable"); expect(gone.diagnostics[0].severity).toBe("warning");
    expect((await discovery.refresh(runtime, [], true)).skills.skills).toEqual([]);
  });
  it("损坏技能不假装可用，修复后恢复", async () => {
    const file = await putSkill("a", '---\nname: a\n---\nprivate-body');
    expect((await discovery.refresh(runtime, [{ name: "a", path: file }], true)).skills.skills[0].status).toBe("failed");
    await writeFile(file, definition); const repaired = await discovery.refresh(runtime, [{ name: "a", path: file }], true);
    expect(repaired.skills.skills[0].status).toBe("available"); expect(repaired.diagnostics).toEqual([]);
  });
  it("符号链接和环不会重复读取同一技能", async () => {
    await putSkill("a"); const base = path.dirname(path.dirname(skillFile("a")));
    await symlink(path.dirname(skillFile("a")), path.join(base, "alias")); await symlink(base, path.join(base, "cycle"));
    const result = await discovery.refresh(runtime, undefined, true);
    expect(result.skills.skills).toHaveLength(1); expect(result.io.filesRead).toBe(1);
  });
  it("技能符号链接转向已缓存配置时重新校验 frontmatter", async () => {
    await writeFile(config, '[mcp_servers.a]'); const file = await putSkill("a");
    const catalog = [{ name: "a", path: file }]; await discovery.refresh(runtime, catalog, true);
    await rm(file); await symlink(config, file);
    const result = await discovery.refresh(runtime, catalog, true);
    expect(result.mcp.status).toBe("ready"); expect(result.skills.skills[0].status).toBe("failed");
    expect(result.diagnostics.some(item => item.code === "skill-definition")).toBe(true);
  });
  it("配置符号链接转向已缓存技能时重新校验 TOML", async () => {
    const file = await putSkill("a"); await discovery.refresh(runtime, undefined, true);
    await symlink(file, config); const result = await discovery.refresh(runtime, undefined, true);
    expect(result.mcp).toEqual({ status: "error", servers: [] });
    expect(result.skills.skills[0].status).toBe("unknown");
  });
  it("项目技能使用所选会话 cwd 而非 HUD 启动目录", async () => {
    const a = path.join(directory, "a"), b = path.join(directory, "b");
    for (const item of [a, b]) { await mkdir(path.join(item, ".agents", "skills", "review"), { recursive: true }); await writeFile(path.join(item, ".git"), "边界"); }
    await writeFile(path.join(a, ".agents", "skills", "review", "SKILL.md"), definition);
    await writeFile(path.join(b, ".agents", "skills", "review", "SKILL.md"), await capabilityFixture("skills", "skill-with-version.md"));
    const result = await discovery.refresh({ ...runtime, workingDirectory: a, sessionCwd: b }, undefined, true);
    expect(result.skills.skills.map(skill => skill.name)).toEqual(["archify"]);
  });
  it("只有目录引用才读取插件定义，不遍历整个插件缓存", async () => {
    const file = path.join(runtime.codexHome, "plugins", "cache", "example", "1.0", "SKILL.md");
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, definition);
    expect((await discovery.refresh(runtime, undefined, true)).skills.skills).toEqual([]);
    const result = await discovery.refresh(runtime, [{ name: "example:review", path: file }], true);
    expect(result.skills.skills[0]).toMatchObject({ source: "plugin", status: "available", version: undefined });
  });
  it("读取完整头部后忽略大型或无效 UTF-8 正文", async () => {
    const file = await putSkill("a"); await writeFile(file, Buffer.concat([Buffer.from(definition), Buffer.alloc(100_000, 255)]));
    const result = await discovery.refresh(runtime, undefined, true);
    expect(result.skills.skills[0].status).toBe("unknown"); expect(result.io.bytesRead).toBeLessThanOrEqual(64 * 1024);
  });
  it("超过配置大小界限保留明确诊断", async () => {
    await writeFile(config, "#".repeat(1024 * 1024 + 1)); const result = await discovery.refresh(runtime, undefined, true);
    expect(result.mcp.status).toBe("error"); expect(result.diagnostics[0].message).toContain("safety limit"); expect(result.io.filesRead).toBe(0);
  });
});
