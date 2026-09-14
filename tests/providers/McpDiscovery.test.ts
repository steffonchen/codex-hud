import { describe, expect, it } from "vitest";
import { parseMcpConfiguration } from "../../src/providers/codex/McpDiscovery.js";
import { capabilityFixture } from "../capabilities.js";

describe("MCP 配置发现", () => {
  it("真实 command 配置只证明 configured", async () => {
    const servers = parseMcpConfiguration(await capabilityFixture("mcp", "configured-servers.toml"));
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: "node_repl", configured: true, status: "configured", transport: "stdio" });
    expect(servers[0].toolCount).toBeUndefined();
  });
  it("保留显式 disabled", async () => {
    expect(parseMcpConfiguration(await capabilityFixture("mcp", "disabled-server.toml"))[0].status).toBe("disabled");
  });
  it("多个真实声明使用稳定且不同的身份", async () => {
    const text = await capabilityFixture("mcp", "multiple-servers.toml");
    const first = parseMcpConfiguration(text);
    expect(first).toEqual(parseMcpConfiguration(text));
    expect(new Set(first.map(server => server.id)).size).toBe(2);
  });
  it("无 MCP 声明返回明确空清单", () => { expect(parseMcpConfiguration('model = "example"')).toEqual([]); });
  it("配置白名单丢弃命令、环境值和嵌套凭据", () => {
    const result = parseMcpConfiguration('[mcp_servers.example]\ncommand="private-command"\nargs=["private-argument"]\nenv={TOKEN="private-token",HOME="private-env"}\n');
    expect(JSON.stringify(result)).not.toMatch(/private-|command|args|env|TOKEN/u);
  });
  it("TOML 错误不泄露错误行正文", () => {
    expect(() => parseMcpConfiguration('api_key="private-key"\n[mcp_servers.')).toThrow("original text omitted");
    try { parseMcpConfiguration('api_key="private-key"\n[mcp_servers.'); } catch (error) { expect(String(error)).not.toContain("private-key"); }
  });
  it.each(['mcp_servers = []', '[mcp_servers.example]\nenabled="false"', '[mcp_servers.example]\nenabled=1', 'mcp_servers = "unknown"'])("拒绝错误类型：%s", value => {
    expect(() => parseMcpConfiguration(value)).toThrow();
  });
  it("重复声明保持可见解析失败", () => { expect(() => parseMcpConfiguration('[mcp_servers.a]\n[mcp_servers.a]')).toThrow(); });
  it("非 command 声明不猜测 transport", () => { expect(parseMcpConfiguration('[mcp_servers.a]')[0]).toMatchObject({ status: "configured", transport: undefined }); });
});
