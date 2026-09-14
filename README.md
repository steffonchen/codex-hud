# Codex HUD

A standalone terminal dashboard for Codex sessions. See context usage, tokens, tool activity, agents, and plan progress while you work.

**English** | [简体中文](README.zh-CN.md) | [中文操作手册](docs/USER_GUIDE.zh-CN.md)

Run the HUD in a second terminal or a split pane alongside Codex. Choose the information you need; the layout adapts to the available space and session data.

[Quick start](#quick-start) · [Features](#features) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Current limitations](#current-limitations)

## Preview

The built-in demo at 80 columns with the default configuration:

```text
GPT-5.6 Sol · xhigh
Context 74% · 191K/258K
5h 91% · 7d 72%
Agents 3
Tools 58
Plan 8/10
main *
Token Input 119K · Output 18K · Cache 101K
```

This is **demo data**, including quota, plan, and Git values. Live Git metadata is not connected yet. The CLI and HUD default to English. Run `codex-hud language` to select English or Simplified Chinese with the arrow keys and Enter.

## Quick start

### 一行安装（macOS / Linux）

需要 Node.js **20.19+（20.x）或 22.12+**、npm、Bash、curl 和 tar，并能访问公开的 GitHub 仓库及 npm 依赖下载源。Node 版本要求来自当前锁定的源码构建依赖：

```bash
curl -fsSL https://raw.githubusercontent.com/steffonchen/codex-hud/main/install.sh | bash
codex-hud
```

安装完成后，在需要观察的项目目录运行 `codex-hud`。程序安装到 `~/.local/share/codex-hud`，命令位于 `~/.local/bin`。重跑安装命令可更新，已有 HUD 配置会保留。PATH 配置、自定义安装位置及下载失败处理见[中文安装说明](README.zh-CN.md#curl-install)。下面保留源码安装方式。

### 1. Build from source

Requirements:

- Node.js **20.19+（20.x）或 22.12+**，以及 npm；这是当前源码构建依赖的要求。
- Readable local session data for rollout observation. App Server connections additionally require Codex CLI on `PATH`; the demo needs neither Codex CLI nor a session.
- An interactive terminal for setup and the continuously updating HUD.

Clone or download this repository, open its root directory, then run:

```bash
npm ci
npm run build
node dist/cli/index.js demo --width 80 --height 24
```

The package is marked `private` in [package.json](package.json). These instructions use the local checkout and do not depend on a published npm package.

### 2. Make the command available

Optional, from the repository root:

```bash
npm link
```

This creates a global npm link to this checkout. Keep the checkout in place and ensure npm's global executable directory is on `PATH`.

If you skip linking, replace `codex-hud` in the examples below with:

```bash
node /absolute/path/to/codex-hud/dist/cli/index.js
```

Replace the example path with your actual checkout path. The absolute path lets you start the HUD from the project you want to observe.

### 3. Start alongside Codex

Use Codex as usual in one terminal. In a second terminal, open the **same project directory** and run:

```bash
cd /path/to/your/project
codex-hud
```

On first launch, setup detects capabilities and offers recommended or custom module selection. Use **↑/↓** to move, **Space** to toggle modules, and **Enter** to save. The HUD then starts. Press **Ctrl+C** to stop and restore the terminal.

Without an explicit thread identity, the HUD selects the latest main session with an exactly matching working directory, or the latest main session overall if none matches. This selects recorded history; it does not establish a live connection to the running Codex process. See [session selection](docs/USER_GUIDE.zh-CN.md#session-selection) for `CODEX_HOME`, `CODEX_THREAD_ID`, and multiple-session behavior.

## Features

Modules appear when enabled, supported by the available data, and able to fit on screen.

| Information | What it tells you |
| --- | --- |
| Model and reasoning | Reported model, reasoning effort, and fast-mode indicator when available |
| Context | Estimated occupancy from the latest usage snapshot and reported window size |
| Tokens and cache | Input/output/cached-input totals and cache hit rates when sufficient data exists |
| Usage limits | Reported quota consumption and reset times, including 5-hour and weekly windows |
| Tools and activity | Running calls, recent results, failures, and a current-activity summary |
| Agents | Parent/child relationships, status, and independent usage/activity where reported |
| Plans | Confirmed execution steps and completion counts, with proposal state kept separate |
| MCP and skills | Discovered configuration and capabilities, plus explicitly observed runtime state |
| Session and runtime | Duration, turn counts, selected source, connection ownership, and fallback state |

The registry has 17 modules. Built-in defaults enable 11; setup filters its recommendations by detected capabilities. MCP, skills, cost estimates, current activity, session details, and runtime status are opt-in. The [complete module reference](docs/USER_GUIDE.zh-CN.md#modules) includes availability rules and the reserved Git module.

## Commands

| Command | Purpose |
| --- | --- |
| `codex-hud` | Configure on first launch, then start; reuse an existing valid configuration |
| `codex-hud setup` | Select modules and save configuration without starting the continuous HUD |
| `codex-hud language` | Open the display-language selection menu |
| `codex-hud start` | Start directly; use in-memory defaults if no configuration exists |
| `codex-hud config` | Show the language, enabled/disabled modules, and configuration location |
| `codex-hud doctor` | Inspect the local environment, sources, capabilities, and configuration |
| `codex-hud debug --width 80 --height 24` | Print one real snapshot, with diagnostics on stderr |
| `codex-hud debug --verbose` | Add bounded, redacted diagnostic details |
| `codex-hud demo --width 80 --height 24` | Preview the layout with demo data |
| `codex-hud version` | Show the version; `--version` also works |
| `codex-hud --help` | Show help; `help <command>` shows command-specific help |

`--width` and `--height` accept positive integers and apply only to `debug` and `demo`. With non-TTY stdout, `start` prints one real snapshot and exits. `doctor` reports failed checks in its output; its exit code alone is not a complete health check.

## Configuration

Run `codex-hud setup` to configure the display. Settings are stored at:

```text
~/.codex-hud/config.toml
```

This path is independent of `CODEX_HOME`. The following reproduces the built-in display and behavior defaults; omitted runtime settings also use their defaults:

```toml
version = 1

[display]
language = "en"
enabled = [
  "model", "reasoning", "context", "five-hour-usage", "weekly-usage",
  "agents", "tools", "plan", "git", "token-details", "cache"
]

[behavior]
refresh_ms = 150
auto_compact = true
hide_when_idle = false

[providers]
prefer_app_server = true
use_rollout_fallback = true
```

- `display.language` accepts `en` (default) or `zh-CN`. Existing files without this field also use English.
- `display.order` controls ordering. It does not enable modules or override their priority when space runs out.
- `refresh_ms` controls render throttling, not the session-file polling interval.
- Missing data stays unavailable; it is not replaced with zero. Explicitly reported zero values are retained.
- Restart the HUD after configuration changes. Unknown fields, duplicate module IDs, and invalid values are rejected.
- Setup's “restore recommended” choice preserves the language and resets the other settings. For an invalid file, [back it up and move it aside before running setup](docs/USER_GUIDE.zh-CN.md#config-recovery).

Run `codex-hud language` in an interactive terminal; no language argument is needed. Use **↑/↓** to select and **Enter** to save, or **Ctrl+C** to cancel without writing. The menu selects the current language initially. Switching languages preserves the other settings; selecting the current language leaves an existing file unchanged. If no file exists, saving creates a default configuration; run `codex-hud setup` to customize its modules. Saving uses the same TOML serialization as setup and does not preserve comments.

Restart a running HUD after changing languages. Built-in help, setup, status labels, and diagnostics follow the selection. Original task text, tool names, file names, and paths retain their source language.

See the [Chinese operation manual](docs/USER_GUIDE.zh-CN.md#configuration) for every option, ordering, and source-policy examples.

## How it works

```text
Codex App Server → verified connection → normalized events ─┐
                                                          ├→ session state → terminal HUD
Local rollout JSONL → incremental reading → normalized events ┘
```

The default policy prefers a verified App Server connection and retains rollout data for history and fallback. A live connection requires explicit thread identity and confirmation that the runtime serves that thread. Otherwise, the HUD can follow recorded rollout updates.

Defaults permit starting a HUD-owned stdio App Server when discovery and identity conditions are satisfied. External attachment may start an official proxy process. Automatic managed-daemon startup is **off by default**. On exit, the HUD cleans up its own transport processes and does not terminate an external runtime.

Set `providers.prefer_app_server = false` to use rollout as the session-event source without opening an App Server connection. Local CLI/version and capability checks still run. See [runtime policies](docs/USER_GUIDE.zh-CN.md#runtime-policy).

### Data handling

The HUD reads local session logs, selected Codex configuration, and relevant skill definitions. App Server mode also performs protocol requests and observes notifications; it does not submit model turns or approve requests for you. Attachment can use `thread/resume` after confirming the thread is loaded; the current protocol has no separate observer-only resume.

Diagnostics use field filtering, bounded summaries, and redaction. Names and task summaries can still contain project information. Review output before sharing it; these protections do not guarantee that arbitrary project text has been anonymized.

## Troubleshooting

| Symptom | First step |
| --- | --- |
| `codex-hud: command not found` | 一行安装后检查 `~/.local/bin` 是否在 PATH；源码安装使用 `npm link` 或 Node 入口的绝对路径 |
| Setup requires an interactive terminal | Run it directly with interactive stdin and stdout |
| Waiting for a session or observing the wrong one | Check the launch directory, `CODEX_HOME`, and inherited thread variables |
| An enabled module is missing | Check `doctor`, available data, terminal space, and the saved selection |
| App Server unavailable | Read the fallback reason in `doctor` or `debug`; rollout can continue if enabled |
| Invalid configuration | Follow the [backup and recovery procedure](docs/USER_GUIDE.zh-CN.md#config-recovery) |

For a real snapshot with details:

```bash
codex-hud doctor
codex-hud debug --verbose --width 140 --height 30
```

These commands inspect their own invocation, not a separate running HUD. With valid configuration, they use its runtime policy and may connect or start permitted helper processes. If configuration is invalid, `doctor` continues with built-in defaults, including App Server preference; restore a valid rollout-only configuration first if you need to disable those connections. More cases are covered in the [manual](docs/USER_GUIDE.zh-CN.md#troubleshooting).

## Current limitations

Version **0.1.0** has a working rollout observation path; further live-runtime validation is pending. remains **PARTIAL**:

- Real rollout observation was verified on macOS arm64 with Codex CLI 0.154.0 and Desktop rollout writer 0.153.4. This is a recorded environment, not a minimum-version or cross-platform compatibility guarantee.
- The full recorded regression run had 18 Unix-socket permission failures. Real shared App Server attachment, restart, and source handoff were not fully verified. Process identity checks are implemented only for macOS/Linux, so Windows App Server attachment is currently unsupported; Windows rollout observation has not been validated.
- Nonempty quota windows, actual monetary comparisons, MCP lifecycle, skill activity, and current-version execution plans lack complete real-runtime evidence. Display depends on fields actually provided by the source.
- Context is a snapshot estimate. Cost is a **standard API-equivalent estimate**, not a Codex subscription bill; unknown pricing or incomplete usage can make it unavailable.
- Git rendering accepts demo/state inputs; live repository metadata is not collected yet.

## Development

From the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev -- demo --width 80 --height 24
```

`npm run dev -- <command>` directly executes the TypeScript entry; it is not a watch command. To observe another project, launch the built entry from that project's directory. Socket-related tests need an environment permitting local Unix sockets and process inspection; permission failures are not successful test results.

| Path | Contents |
| --- | --- |
| `src/cli/`, `src/config/` | Commands and configuration |
| `src/providers/codex/` | Session discovery, rollout parsing, and App Server integration |
| `src/core/` | Normalized state, trackers, usage accounting, and diagnostics |
| `src/runtime/`, `src/terminal/` | Refresh scheduling, lifecycle, and terminal control |
| `src/renderer/` | Display modules and adaptive layout |
| `tests/` | Automated tests and fixtures |
| `docs/` | Operation manual, design notes, and validation reports |

## License

Licensed under the [MIT License](LICENSE).
