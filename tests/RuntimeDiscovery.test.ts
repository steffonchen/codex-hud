import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { RuntimeDiscoveryProvider, inspectRuntimeSocket, parseRuntimeProcesses, type RuntimeProcess } from "../src/providers/codex/runtime/RuntimeDiscoveryProvider.js";
import { RuntimeAuthorityResolver } from "../src/providers/codex/runtime/RuntimeAuthorityResolver.js";
import { cleanupRuntimeFixtures, codexRuntime, discovery, makeHome, unixSocket } from "./runtime-authority/helpers.js";

afterEach(cleanupRuntimeFixtures);
const processFor = (endpoint: string, overrides: Partial<RuntimeProcess> = {}): RuntimeProcess => ({ pid: 101, parentPid: 1,
  uid: process.getuid!(), executable: "/fixture/codex", startedAt: "Sun Sep 13 08:00:00 2026", commandReadable: true,
  appServer: true, transport: "unix-socket", endpoint, socketPaths: [endpoint], ...overrides });
const provider = (home: string, processes: RuntimeProcess[] = []) => new RuntimeDiscoveryProvider({ runtime: codexRuntime(home),
  processes: async () => processes, commands: async () => discovery().commands, processVersion: async () => "0.154.0" });

describe("Runtime discovery 的真实文件与合成进程证据", () => {
  it("未发现 runtime 时返回 not-found，发现过程不创建 daemon 目录", async () => {
    const home = await makeHome(), result = await provider(home).discover();
    expect(result).toMatchObject({ candidates: [], status: "not-found", managed: "not-running", socket: "absent" });
    await expect(stat(path.join(home, "app-server-control"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("socket、进程、owner 与版本共同提供候选证据，尚未 probe 不宣称兼容", async () => {
    const home = await makeHome(), socket = await unixSocket(home);
    const result = await provider(home, [processFor(socket.endpoint)]).discover();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ ownership: "external", process: "verified", endpointVerified: true, owner: "verified",
      permissions: "verified", codexVersion: "0.154.0", compatibility: "unknown" });
    expect(result.candidates[0].homeMatch).toBeUndefined();
  });
  it("PID 文件与真实 socket PID 不同则保持 mismatch，不修改旁证文件", async () => {
    const home = await makeHome(), socket = await unixSocket(home), pidFile = path.join(home, "app-server", "server.pid");
    await writeFile(pidFile, "202\n", { mode: 0o600 });
    expect((await provider(home, [processFor(socket.endpoint)]).discover()).candidates[0].process).toBe("mismatch");
    expect(await readFile(pidFile, "utf8")).toBe("202\n");
  });
  it("普通文件与符号链接不能充当 socket", async () => {
    const home = await makeHome(), file = path.join(home, "fake.sock"); await writeFile(file, "不是 socket");
    await symlink(file, path.join(home, "link.sock"));
    const result = await provider(home).discover();
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every(item => item.permissions === "denied" && !item.endpointVerified)).toBe(true);
  });
  it("宽松权限和不同 owner 均拒绝；发现不执行 chmod", async () => {
    const home = await makeHome(), socket = await unixSocket(home);
    expect((await inspectRuntimeSocket(socket.endpoint, process.getuid!() + 1)).owner).toBe("denied");
    await chmod(socket.endpoint, 0o666);
    const result = await provider(home, [processFor(socket.endpoint)]).discover();
    expect(result.candidates[0].permissions).toBe("denied");
    expect((await stat(socket.endpoint)).mode & 0o777).toBe(0o666);
  });
  it("只有 PID 或外部 stdio 进程不能成为可共享连接", async () => {
    const home = await makeHome(), item = processFor("", { transport: "stdio", socketPaths: [], endpoint: undefined });
    const result = await provider(home, [item]).discover();
    expect(result.candidates[0]).toMatchObject({ transport: "stdio", endpointVerified: false, compatibility: "unknown" });
    expect(new RuntimeAuthorityResolver().resolve(result, "thread-a").maySpawn).toBe(false);
  });
  it("进程表读取受限时报告 error，不把未知当作不存在", async () => {
    const home = await makeHome();
    const result = await new RuntimeDiscoveryProvider({ runtime: codexRuntime(home), commands: async () => discovery().commands,
      processes: async () => { throw Object.assign(new Error("SECRET"), { code: "EPERM" }); } }).discover();
    expect(result).toMatchObject({ processScan: "unavailable", status: "error" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(new RuntimeAuthorityResolver().resolve(result, "thread-a").maySpawn).toBe(false);
  });
  it("目录超出有界扫描范围后禁止 spawn，不将部分发现宣称完整", async () => {
    const home = await makeHome(), directory = path.join(home, "app-server-state"); await mkdir(directory);
    await Promise.all(Array.from({ length: 65 }, (_, i) => writeFile(path.join(directory, `ignored-${i}`), "")));
    const result = await provider(home).discover();
    expect(result).toMatchObject({ status: "error", socket: "unknown", managed: "unknown" });
    expect(new RuntimeAuthorityResolver().resolve(result, "thread-a").maySpawn).toBe(false);
  });
  it("缓存与同时请求合并，force 才重新扫描；调用方不能污染缓存", async () => {
    const home = await makeHome(), processes = vi.fn(async () => []), commands = vi.fn(async () => discovery().commands);
    const source = new RuntimeDiscoveryProvider({ runtime: codexRuntime(home), processes, commands });
    const [a, b] = await Promise.all([source.discover(), source.discover()]);
    a.issues.push("外部修改"); expect(b.issues).toEqual([]);
    await source.discover(); expect(processes).toHaveBeenCalledOnce();
    await source.discover(true); expect(processes).toHaveBeenCalledTimes(2); expect(commands).toHaveBeenCalledOnce();
  });
  it("进程出生信息改变会产生新的 runtime ID", async () => {
    const home = await makeHome(), socket = await unixSocket(home), item = processFor(socket.endpoint), source = provider(home, [item]);
    const before = await source.discover(); item.startedAt = "Sun Sep 13 09:00:00 2026";
    expect((await source.discover(true)).candidates[0].id).not.toBe(before.candidates[0].id);
  });
  it("不推断 PATH CLI 就是外部 server 的版本", async () => {
    const home = await makeHome(), socket = await unixSocket(home);
    const result = await new RuntimeDiscoveryProvider({ runtime: codexRuntime(home), processes: async () => [processFor(socket.endpoint)],
      commands: async () => discovery().commands, processVersion: async () => undefined }).discover();
    expect(result.candidates[0].codexVersion).toBeUndefined();
  });
  it.each(["exec app-server", "app-server proxy --sock /private.sock", "app-server daemon start", "app-server generate-ts --out /tmp"])(
    "进程命令 %s 不被误识别为 server", command => {
      expect(parseRuntimeProcesses(" 101 1 501 Sun Sep 13 08:00:00 2026 /usr/bin/codex", `101 /usr/bin/codex ${command}`)).toEqual([]);
    });
  it("参数原文不保留；缺失或损坏命令行保持 unknown", () => {
    const metadata = " 101 1 501 Sun Sep 13 08:00:00 2026 /usr/bin/codex";
    const result = parseRuntimeProcesses(metadata, '101 /usr/bin/codex -c token=SECRET app-server --listen unix:///tmp/shared.sock');
    expect(result[0]).toMatchObject({ appServer: true, transport: "unix-socket", endpoint: "/tmp/shared.sock" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(parseRuntimeProcesses(metadata, "")[0]).toMatchObject({ commandReadable: false, appServer: false, transport: "unknown" });
    expect(parseRuntimeProcesses(metadata, '101 /usr/bin/codex "unclosed')[0].commandReadable).toBe(false);
  });
});
