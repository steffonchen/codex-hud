import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { plainText, WidthPolicy } from "../src/renderer/WidthPolicy.js";

const policy = new WidthPolicy();

describe("WidthPolicy", () => {
  it.each([[140, "full"], [80, "compact"], [50, "minimal"], [30, "minimal"]] as const)("%i 列选择内部密度 %s", (width, density) => {
    expect(policy.density(width)).toBe(density);
  });

  it("按实际终端列宽测量中文、组合字符和 emoji，并保留缩进", () => {
    expect(policy.measure("模型")).toBe(4);
    expect(policy.measure("e\u0301")).toBe(1);
    expect(policy.measure("👩‍💻")).toBe(2);
    expect(policy.measure("  ● 子代理")).toBe(10);
    expect(policy.fitLine("  ● 子代理", 20)).toBe("  ● 子代理");
  });

  it("移除 ANSI、OSC 和输入中的终端控制字符", () => {
    const text = "\x1b[31m模型\x1b[0m \x1b]8;;https://example.com\x07链接\x1b]8;;\x07";
    expect(policy.fitLine(text, 20)).toBe("模型 链接");
    expect(plainText("名称\n伪造下一行\r\t\x00")).toBe("名称 伪造下一行");
  });

  it("截断不拆分字素，不让双列字符越界", () => {
    expect(policy.fitLine("👩‍💻👩‍💻abc", 4)).toBe("👩‍💻…");
    expect(policy.fitLine("e\u0301e\u0301abc", 3)).toBe("e\u0301e\u0301…");
    for (let width = 1; width < 15; width++) {
      expect(stringWidth(policy.fitLine("中文👩‍💻e\u0301长分支名字", width))).toBeLessThanOrEqual(width);
    }
  });

  it("行数预算同时受终端宽高限制，极窄时隐藏", () => {
    expect(policy.rowBudget({ width: 140, height: 24 })).toBe(24);
    expect(policy.rowBudget({ width: 80, height: 24 })).toBe(8);
    expect(policy.rowBudget({ width: 50, height: 24 })).toBe(4);
    expect(policy.rowBudget({ width: 30, height: 2 })).toBe(2);
    expect(policy.rowBudget({ width: 30, height: 24 }, false)).toBe(24);
    expect(policy.rowBudget({ width: 7, height: 24 })).toBe(0);
  });

  it("安全处理零、负数、非有限和小数尺寸", () => {
    expect(policy.normalize({ width: 80.9, height: -1 })).toEqual({ width: 80, height: 0 });
    expect(policy.normalize({ width: Infinity, height: NaN })).toEqual({ width: 0, height: 0 });
    expect(policy.fitLine("任何内容", 0)).toBe("");
  });
});
