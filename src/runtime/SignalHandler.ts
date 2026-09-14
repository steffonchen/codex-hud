import type { EventEmitter } from "node:events";

export class SignalHandler {
  private cleanup?: () => void;

  constructor(private readonly signals: Pick<EventEmitter, "on" | "off"> = process) {}

  start(stop: () => void, restore: () => void): void {
    if (this.cleanup) return;
    this.signals.on("SIGINT", stop);
    this.signals.on("SIGTERM", stop);
    this.signals.on("exit", restore);
    this.cleanup = () => {
      this.signals.off("SIGINT", stop);
      this.signals.off("SIGTERM", stop);
      this.signals.off("exit", restore);
    };
  }

  stop(): void {
    this.cleanup?.();
    this.cleanup = undefined;
  }
}
