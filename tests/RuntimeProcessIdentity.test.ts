import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { RuntimeDiscoveryProvider, verifyRuntimeProcess } from "../src/providers/codex/runtime/RuntimeDiscoveryProvider.js";
import { candidate, cleanupRuntimeFixtures, codexRuntime, discovery, makeHome } from "./runtime-authority/helpers.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }) }));
afterEach(async () => { execute.mockReset(); await cleanupRuntimeFixtures(); });

describe("连接前重新核验进程身份（合成 ps/lsof）", () => {
  it.each(["stable", "pid-reused", "wrong-command", "wrong-socket", "bad-format"])("%s 不会被拼接成可信旧身份", async scenario => {
    const home = await makeHome(), executable = path.join(home, "codex"); await writeFile(executable, "合成 executable", { mode: 0o755 });
    const endpoint = path.join(home, "test.sock"), startedAt = "Sun Sep 13 08:00:00 2099";
    let afterSocket = false;
    execute.mockImplementation(async (command: string, args: string[]) => {
      if (command === "lsof") { afterSocket = true; return { stdout: `p101\nn${scenario === "wrong-socket" ? "/other.sock" : endpoint}\n` }; }
      if (args.at(-1)?.includes("lstart")) return { stdout: scenario === "bad-format" ? "无法识别的 ps 输出" :
        `101 1 ${process.getuid!()} ${scenario === "pid-reused" && afterSocket ? "Sun Sep 13 09:00:00 2099" : startedAt} ${executable}\n` };
      return { stdout: `101 ${executable} ${scenario === "wrong-command" ? "exec app-server" : "app-server --listen unix://" + endpoint}\n` };
    });
    const operation = verifyRuntimeProcess(candidate({ executable, endpoint, processStartedAt: startedAt }));
    if (scenario === "bad-format") await expect(operation).rejects.toThrow("Process table format unconfirmed");
    else expect(await operation).toBe(scenario === "stable");
  });
  it("binary 在进程出生后被替换时不采用旧版本证据，也不读取命令行", async () => {
    const home = await makeHome(), executable = path.join(home, "codex"); await writeFile(executable, "新 binary", { mode: 0o755 });
    expect(await verifyRuntimeProcess(candidate({ executable, processStartedAt: "Sun Sep 13 08:00:00 2009" }))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it("实际帮助输出决定命令能力，发现不执行 start/bootstrap/status", async () => {
    const home = await makeHome();
    execute.mockImplementation(async (_binary: string, args: string[]) => ({ stdout: args.includes("daemon")
      ? "  start  启动\n  stop  停止\n  version  版本\n" : "  --stdio\n  proxy  代理\n  daemon  管理\n" }));
    const result = await new RuntimeDiscoveryProvider({ runtime: codexRuntime(home), processes: async () => [] }).discover();
    expect(result.commands).toEqual(discovery().commands);
    expect(execute.mock.calls.map(([, args]) => args)).toEqual([["app-server", "--help"], ["app-server", "daemon", "--help"]]);
  });
  it("达到扫描总时间上限时返回 error，不把截断结果当作完整发现", async () => {
    const home = await makeHome(); let now = 0;
    const result = await new RuntimeDiscoveryProvider({ runtime: codexRuntime(home), now: () => now,
      commands: async () => { now = 16000; return discovery().commands; }, processes: async () => [] }).discover();
    expect(result.status).toBe("error"); expect(result.issues).toContain("Runtime discovery reached the total time limit of 15 seconds");
  });
});
