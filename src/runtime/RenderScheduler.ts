import { t } from "../i18n/Messages.js";
export class RenderScheduler {
  private active = false;
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  private rendering?: Promise<void>;
  private lastRenderAt = -Infinity;

  constructor(
    private readonly render: () => void | Promise<void>,
    private readonly refreshMs: number,
    private readonly onError: (error: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(refreshMs) || refreshMs < 1 || refreshMs > 60_000) {
      throw new Error(t("渲染间隔必须为 1 至 60000 毫秒的整数"));
    }
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.lastRenderAt = -Infinity;
  }

  invalidate(): void {
    if (!this.active) return;
    this.dirty = true;
    this.schedule();
  }

  async flush(): Promise<void> {
    if (!this.active) return;
    if (this.rendering) {
      await this.rendering;
      if (this.dirty) await this.flush();
      return;
    }
    if (!this.dirty) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
    this.lastRenderAt = this.now();
    const render = Promise.resolve().then(() => this.render()).catch(error => { this.onError(error); });
    this.rendering = render;
    try { await render; }
    finally {
      this.rendering = undefined;
      this.schedule();
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.rendering;
  }

  private schedule(): void {
    if (!this.active || !this.dirty || this.timer || this.rendering) return;
    const delay = Math.max(0, this.lastRenderAt + this.refreshMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }
}
