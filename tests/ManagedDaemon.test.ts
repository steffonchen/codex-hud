import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeDiscoveryProvider, type RuntimeProcess } from "../src/providers/codex/runtime/RuntimeDiscoveryProvider.js";
import { RuntimeConnectionManager } from "../src/providers/codex/runtime/RuntimeConnectionManager.js";
import { RuntimeClient, cleanupRuntimeFixtures, codexRuntime, discovery, makeHome, unixSocket } from "./runtime-authority/helpers.js";

const managers: RuntimeConnectionManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.disconnect())); await cleanupRuntimeFixtures(); });
describe("Managed daemon 的显式策略与发现范围", () => {
  it.each([false, true])("同名 socket 只有在本次 CODEX_HOME 内才可标为 managed（正确 home=%s）", async matching => {
    const home = await makeHome(), other = await makeHome(), socket = await unixSocket(matching ? home : other, "app-server-control/app-server-control.sock");
    const item: RuntimeProcess = { pid: 101, parentPid: 1, uid: process.getuid!(), executable: "/fixture/codex", appServer: true,
      commandReadable: true, transport: "unix-socket", endpoint: socket.endpoint, socketPaths: [socket.endpoint] };
    const status = vi.fn(async () => true);
    const result = await new RuntimeDiscoveryProvider({ runtime: codexRuntime(home), processes: async () => [item],
      commands: async () => discovery().commands, processVersion: async () => "0.154.0", managedStatus: status }).discover();
    expect(result.candidates[0].kind).toBe(matching ? "managed-daemon" : "standalone");
    expect(status).toHaveBeenCalledTimes(matching ? 1 : 0);
  });
  it.each(["default", "unsupported", "disabled-attach", "no-thread", "enabled"])("%s 条件下只按明确许可启动 managed", async scenario => {
    const home = await makeHome(), startManaged = vi.fn(async () => {}), client = new RuntimeClient(home);
    const found = discovery(); if (scenario === "unsupported") found.commands.daemonStart = false;
    const discover = vi.fn(async () => structuredClone(found));
    const manager = new RuntimeConnectionManager({ runtime: codexRuntime(home), startManaged, discovery: { discover }, createClient: () => client,
      policy: { allow_spawn: false, ...(scenario === "default" ? {} : { auto_start_managed: true }), allow_external_attach: scenario !== "disabled-attach" } });
    managers.push(manager); if (scenario !== "no-thread") manager.setSelection("thread-a");
    await manager.open(); await manager.open();
    expect(startManaged).toHaveBeenCalledTimes(scenario === "enabled" ? 1 : 0);
    expect(discover).toHaveBeenCalledTimes(scenario === "enabled" ? 3 : 2);
    expect(client.start).not.toHaveBeenCalled();
  });
  it("自然存在外部候选时不启动第二个 managed", async () => {
    const home = await makeHome(), socket = await unixSocket(home), startManaged = vi.fn(async () => {});
    const manager = new RuntimeConnectionManager({ runtime: codexRuntime(home), policy: { auto_start_managed: true }, startManaged,
      discovery: { discover: async () => discovery([{ ...socket.candidate, permissions: "denied" }]) } });
    managers.push(manager); manager.setSelection("thread-a"); await manager.open(); expect(startManaged).not.toHaveBeenCalled();
  });
});
