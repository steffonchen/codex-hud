import { describe, expect, it } from "vitest";
import { RuntimeAuthorityResolver } from "../src/providers/codex/runtime/RuntimeAuthorityResolver.js";
import { defaultRuntimePolicy } from "../src/providers/codex/runtime/RuntimePolicy.js";
import type { RuntimeCandidate } from "../src/providers/codex/runtime/RuntimeCandidate.js";
import { candidate, discovery } from "./runtime-authority/helpers.js";

const resolver = new RuntimeAuthorityResolver();
describe("Runtime authority 的证据与策略", () => {
  it("没有明确线程时不选择 runtime，也不允许 spawn", () => {
    expect(resolver.resolve(discovery([candidate()]))).toEqual({ status: "fallback", reason: "thread-authority-unknown", maySpawn: false });
  });
  it("已验证且承载当前线程的 shared runtime 优先于 owned", () => {
    const external = candidate(), owned = candidate({ id: "owned", ownership: "owned", transport: "stdio" });
    expect(resolver.resolve(discovery([owned, external]), "thread-a").candidate?.id).toBe(external.id);
  });
  it("managed 只有满足线程 authority 后才优先", () => {
    const shared = candidate(), daemon = candidate({ id: "managed", kind: "managed-daemon" });
    expect(resolver.resolve(discovery([shared, daemon]), "thread-a").reason).toBe("managed-daemon-active");
    daemon.thread = "stored";
    expect(resolver.resolve(discovery([daemon, shared]), "thread-a").candidate?.id).toBe(shared.id);
  });
  it("同等候选顺序或 PID 不决定选择，无法消歧就回退", () => {
    const a = candidate(), b = candidate({ id: "runtime-b", pid: 2 });
    for (const candidates of [[a, b], [b, a]]) expect(resolver.resolve(discovery(candidates), "thread-a")).toMatchObject({ status: "ambiguous", maySpawn: false });
  });
  it.each<Partial<RuntimeCandidate>>([{ owner: "unknown" }, { permissions: "denied" }, { process: "unknown" }, { endpointVerified: false },
    { codexVersion: undefined }, { homeMatch: false }, { compatibility: "incompatible" }, { health: "unhealthy" }, { thread: "stored" }, { thread: "missing" }])(
    "证据缺失或不一致 %j 禁止附着及重复 spawn", patch => {
      expect(resolver.resolve(discovery([candidate(patch)]), "thread-a")).toMatchObject({ status: "fallback", maySpawn: false });
    });
  it("external attach 关闭后仅可使用 owned；allow_spawn=false 同时禁止新进程", () => {
    const policy = { ...defaultRuntimePolicy, allow_external_attach: false };
    expect(resolver.resolve(discovery([candidate()]), "thread-a", policy)).toMatchObject({ reason: "external-attach-disabled", maySpawn: true });
    expect(resolver.resolve(discovery(), "thread-a", { ...policy, allow_spawn: false }).maySpawn).toBe(false);
  });
  it("完整发现为空时才允许 owned，扫描错误时不启动", () => {
    expect(resolver.resolve(discovery(), "thread-a").maySpawn).toBe(true);
    expect(resolver.resolve(discovery([], { status: "error" }), "thread-a").maySpawn).toBe(false);
    expect(resolver.resolve(discovery([candidate()], { status: "error" }), "thread-a").status).toBe("fallback");
  });
  it("版本不一致但 capability 兼容仍允许 current thread authority", () => {
    expect(resolver.resolve(discovery([candidate({ codexVersion: "0.153.4", compatibility: "compatible-with-fallback" })]), "thread-a").status).toBe("selected");
  });
});
