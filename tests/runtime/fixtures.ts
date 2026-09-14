import { vi } from "vitest";
import { StateStore } from "../../src/core/StateStore.js";
import type { CodexSessionHandlers, CodexSessionSnapshot } from "../../src/providers/codex/CodexSessionProvider.js";
import type { HudTerminal, TerminalEvents } from "../../src/terminal/TerminalController.js";

export class FakeTerminal implements HudTerminal {
  readonly isTTY = true;
  size = { width: 140, height: 20 };
  frames: string[] = [];
  events?: TerminalEvents;
  getSize = () => this.size;
  subscribe = (events: TerminalEvents) => { this.events = events; return () => { this.events = undefined; }; };
  start = vi.fn(async () => {});
  render = vi.fn(async (content: string) => { this.frames.push(content); });
  dispose = vi.fn(async () => {});
  restoreSync = vi.fn();
}

export class FakeCodexProvider {
  readonly store = new StateStore();
  handlers?: CodexSessionHandlers;
  constructor(public snapshot: CodexSessionSnapshot) {}
  refresh = vi.fn(async () => this.snapshot);
  start = vi.fn(async (handlers: CodexSessionHandlers) => {
    this.handlers = handlers;
    this.publish(this.snapshot);
  });
  stop = vi.fn(async () => { this.handlers = undefined; });
  publish(snapshot: CodexSessionSnapshot): void {
    this.snapshot = snapshot;
    this.store.replace(snapshot.state);
    this.handlers?.onSnapshot(snapshot);
  }
}
