import type { AuthorityReason, RuntimeCandidate, RuntimeDiscoveryResult } from "./RuntimeCandidate.js";
import { defaultRuntimePolicy, type RuntimePolicy } from "./RuntimePolicy.js";

export interface RuntimeAuthority {
  status: "selected" | "fallback" | "ambiguous";
  candidate?: RuntimeCandidate;
  reason: AuthorityReason;
  maySpawn: boolean;
}

export class RuntimeAuthorityResolver {
  resolve(discovery: RuntimeDiscoveryResult, threadId?: string, policy: RuntimePolicy = { ...defaultRuntimePolicy }): RuntimeAuthority {
    const fallback = (reason: AuthorityReason = "fallback-rollout", maySpawn = false): RuntimeAuthority => ({ status: "fallback", reason, maySpawn });
    if (!threadId) return fallback("thread-authority-unknown");
    if (discovery.status === "error") return fallback();
    const eligible = discovery.candidates.filter(candidate => candidate.state === "running" && candidate.owner === "verified"
      && candidate.process === "verified" && candidate.homeMatch === true && candidate.health !== "unhealthy"
      && ["compatible", "compatible-with-fallback"].includes(candidate.compatibility)
      && (candidate.ownership === "owned" || policy.allow_external_attach && candidate.ownership === "external"
        && candidate.permissions === "verified" && candidate.endpointVerified && !!candidate.codexVersion
        && !!candidate.pid && !!candidate.executable && !!candidate.processStartedAt)
      && (candidate.thread === "loaded" || candidate.ownership === "owned" && candidate.thread === "stored"));
    const rank = (candidate: RuntimeCandidate): number[] => [candidate.thread === "loaded" ? 1 : 0,
      policy.prefer_shared && candidate.ownership === "external" ? 1 : 0,
      policy.prefer_managed && candidate.kind === "managed-daemon" ? 1 : 0,
      candidate.health === "healthy" ? 1 : 0, candidate.compatibility === "compatible" ? 1 : 0];
    const compare = (a: RuntimeCandidate, b: RuntimeCandidate): number => {
      const left = rank(a), right = rank(b);
      for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return right[i] - left[i];
      return 0;
    };
    eligible.sort((a, b) => compare(a, b) || a.id.localeCompare(b.id));
    if (eligible.length > 1 && compare(eligible[0], eligible[1]) === 0) return { status: "ambiguous", reason: "ambiguous-runtime", maySpawn: false };
    const candidate = eligible[0];
    if (candidate) return { status: "selected", candidate, maySpawn: false, reason: candidate.ownership === "owned" ? "standalone-owned-by-hud"
      : candidate.kind === "managed-daemon" ? "managed-daemon-active" : "existing-compatible-runtime" };
    // 不把失败的外部身份核验变成另启一份 runtime 的理由。
    const maySpawn = policy.allow_spawn && discovery.processScan === "complete"
      && (!policy.allow_external_attach || discovery.candidates.length === 0);
    return fallback(policy.allow_external_attach ? "fallback-rollout" : "external-attach-disabled", maySpawn);
  }
}
