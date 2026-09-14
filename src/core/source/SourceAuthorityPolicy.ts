import type { DataSourceKind } from "./DataSource.js";

// 优先级在来源层执行。共享身份不足时，已确认的同轮状态优先于强行切换来源。
export class SourceAuthorityPolicy {
  constructor(readonly preferAppServer = true, readonly useRolloutFallback = true) {}

  get preferred(): DataSourceKind { return this.preferAppServer ? "app-server" : "rollout"; }
  accepts(source: DataSourceKind): boolean {
    return source === "app-server" ? this.preferAppServer : !this.preferAppServer || this.useRolloutFallback;
  }
}
