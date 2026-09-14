import { describe, expect, it } from "vitest";
import { redact, redactText } from "../src/core/Redaction.js";
import { debugState, formatFailure } from "../src/cli/Diagnostics.js";
import { parseConfig } from "../src/config/Config.js";

describe("诊断脱敏", () => {
  it("递归隐藏凭证字段，保留 Token 统计字段", () => {
    const source = { access_token: "secret-a", nested: [{ authorization: "secret-b", cookie: "secret-c", clientSecret: "secret-d" }], tokenUsage: { totalTokens: 100 } };
    const output = JSON.stringify(redact(source));
    expect(output).toContain('"totalTokens":100');
    for (const value of ["secret-a", "secret-b", "secret-c", "secret-d"]) expect(output).not.toContain(value);
  });

  it.each(["token", "api_key", "password", "secret", "credential", "cookie", "authorization"])("隐藏命令参数 --%s 的值", key => {
    expect(redactText(`command --${key} "private argument" --other visible`)).not.toContain("private argument");
    expect(redactText(`command --${key}=private-value`)).not.toContain("private-value");
  });

  it("带服务前缀的环境变量与 credentials 对象也脱敏", () => {
    const source = 'MY_API_TOKEN=private-env AWS_SECRET_ACCESS_KEY=private-key x-api-key: private-header';
    expect(redactText(source)).not.toMatch(/private-env|private-key|private-header/u);
    expect(JSON.stringify(redact({ credentials: "private-credentials", servicePassword: "private-password", totalTokens: 42 })))
      .toBe("{\"credentials\":\"[redacted]\",\"servicePassword\":\"[redacted]\",\"totalTokens\":42}");
  });

  it("camelCase 凭证和重复脱敏保持一致，Token 统计字段不受影响", () => {
    const source = 'servicePassword="private-value" apiKey=private-key totalTokens=123';
    const once = redactText(source);
    expect(once).not.toMatch(/private-value|private-key/u);
    expect(once).toContain("totalTokens=123");
    expect(redactText(once)).toBe(once);
  });

  it("覆盖 header、Cookie、API key、JWT、URL 凭证及终端控制序列", () => {
    const source = [
      "Authorization: Bearer abc123", "Cookie: session=private; other=hidden",
      'api_key="test-key"', "refresh_token=refresh-value", "sk-proj-private-key",
      "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0.signature", "https://user:pass@example.test?token=url-token",
      "-----BEGIN PRIVATE KEY-----\nprivate key contents\n-----END PRIVATE KEY-----", "\x1b[2J正文",
    ].join("\n");
    const output = redactText(source);
    for (const value of ["abc123", "private", "hidden", "test-key", "refresh-value", "eyJ", "url-token", "user:pass", "\x1b"]) expect(output).not.toContain(value);
    expect(output).toContain("正文");
  });

  it("debug 仅允许当前阶段的归一化字段", () => {
    const state = { model: "gpt-6-astra", context: { usedTokens: 1, raw: "私密正文" }, tools: { counts: { hidden: 1 } }, rawPayload: "私密正文" };
    const output = JSON.stringify(debugState(state));
    expect(output).toContain('"usedTokens":1');
    expect(output).not.toContain("私密正文");
    expect(output).not.toContain("hidden");
    expect(output).not.toContain("counts");
  });

  it("顶层错误及 cause 都经过脱敏", () => {
    const output = formatFailure(new Error("失败 api_key=top-private", { cause: new Error("Authorization: Bearer cause-private") }));
    expect(output).toContain("失败");
    expect(output).not.toContain("top-private");
    expect(output).not.toContain("cause-private");
  });

  it("多项清理失败分别可见且全部经过脱敏", () => {
    const output = formatFailure(new AggregateError([new Error("关闭监听失败 EIO"), new Error("恢复终端失败 api_key=cleanup-secret")], "HUD 资源清理失败"));
    expect(output).toContain("关闭监听失败 EIO");
    expect(output).toContain("恢复终端失败");
    expect(output).not.toContain("cleanup-secret");
  });

  it("前一项错误的认证 header 不会吞掉后续独立清理错误", () => {
    const output = formatFailure(new AggregateError([new Error("请求失败 Authorization: Bearer demo-only"), new Error("恢复终端失败 EIO")], "清理失败"));
    expect(output).toContain("恢复终端失败 EIO");
    expect(output).not.toContain("demo-only");
    expect(redactText(output)).toContain("恢复终端失败 EIO");
  });

  it("TOML 语法错误保留行列定位，不携带配置原文", () => {
    let output = "";
    try { parseConfig('api_key = "arbitrary-private-value" trailing\n'); }
    catch (error) { output = formatFailure(error); }
    expect(output).toContain("Invalid TOML syntax (line 1");
    expect(output).not.toContain("arbitrary-private-value");
  });
});
