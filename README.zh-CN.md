# Codex HUD

Codex 会话的独立终端信息面板。在工作过程中查看上下文占用、Token 用量、工具活动、子代理和计划进度。

[English](README.md) | **简体中文** | [中文操作手册](docs/USER_GUIDE.zh-CN.md)

在 Codex 旁边打开第二个终端或分屏运行 HUD。选择需要的信息，面板会根据可用空间和实际会话数据自动安排布局。

[快速开始](#快速开始) · [功能](#功能) · [配置](#配置) · [故障排查](#故障排查) · [当前限制](#当前限制)

## 效果预览

选择简体中文后，内置默认模块在 80 列终端下的演示输出：

```text
GPT-5.6 Sol · xhigh
上下文 74% · 191K/258K
5h 91% · 7d 72%
子代理 3
工具 58
计划 8/10
main *
Token 输入 119K · 输出 18K · 缓存 101K
```

以上均为**演示数据**，包括额度、计划和 Git 信息。真实 Git 数据尚未接入。CLI 和 HUD 默认使用英文，运行 `codex-hud language`，用方向键和 Enter 选择英文或简体中文。

## 快速开始

<a id="curl-install"></a>

### 一行安装（macOS / Linux）

需要 **Node.js 20.19+（20.x）或 22.12+**、npm、Bash、curl 和 tar，并能访问 GitHub 与 npm 依赖下载源。Node 版本要求来自当前锁定的源码构建依赖。

```bash
curl -fsSL https://raw.githubusercontent.com/steffonchen/codex-hud/main/install.sh | bash
```

脚本下载公开仓库的 `main` 分支，自动安装依赖、构建并检查程序能否启动。安装完成后，在需要观察的项目目录运行：

```bash
codex-hud
```

首次运行会进入配置向导，随后启动 HUD；也可以单独运行 `codex-hud setup`。HUD 在独立终端或分屏中显示。

- 程序目录：`~/.local/share/codex-hud`；命令入口：`~/.local/bin/codex-hud`。
- 安装使用当前用户权限。脚本会检查 PATH，并在需要时提示配置方法。
- 再次执行同一安装命令即可更新。更新先在临时目录构建，通过启动检查后替换旧版本；失败会返回非零退出码。
- 按 Ctrl+C 或收到 SIGTERM 时，脚本终止本次安装启动的进程、恢复旧安装并清理临时目录。强制杀进程或断电可能留下安装锁；确认没有安装任务运行后，按报错中的路径处理。
- 已有 `~/.codex-hud/config.toml` 配置会保留。更新后重新启动正在运行的 HUD。
- 如果同名命令或程序目录由其他方式安装，脚本会报告冲突，交由你处理。

如果提示找不到 `codex-hud`，在 bash/zsh 中执行以下命令；长期使用可将其加入 `~/.zshrc` 或 `~/.bashrc`：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

安装脚本和源码需要公开可访问。HTTP 404 通常表示仓库仍为私有，或 `install.sh` 尚未推送到 `main`。GitHub 下载或 npm 构建失败时，先根据终端中的具体错误修复网络、依赖或源码问题，再重试安装。

需要指定安装位置时，在管道末尾使用 `bash -s -- --prefix "$HOME/.tools"`；程序和命令分别安装到该前缀的 `share/codex-hud` 与 `bin`。查看全部安装参数可在源码目录运行 `bash install.sh --help`。

下面保留源码安装步骤。使用一行安装后，可直接阅读“与 Codex 一起使用”。

### 1. 从源码构建

环境要求：

- Node.js **20.19+（20.x）或 22.12+**，以及 npm；这是当前源码构建依赖的要求。
- rollout 观察需要可读的本地会话数据；App Server 连接还需要 `PATH` 中可用的 Codex CLI。演示不依赖 Codex CLI 或会话。
- 配置向导和持续刷新的 HUD 需要交互终端。

克隆或下载本仓库，进入仓库根目录后执行：

```bash
npm ci
npm run build
node dist/cli/index.js demo --width 80 --height 24
```

当前 [package.json](package.json) 标记为 `private`。这里采用本地源码安装，不依赖已发布的 npm 包。

### 2. 注册本机命令

可选：在仓库根目录执行：

```bash
npm link
```

这会创建指向当前源码目录的 npm 全局链接。请保留源码目录，并确保 npm 全局可执行文件目录位于 `PATH` 中。

如果跳过链接步骤，后文的 `codex-hud` 均可替换为：

```bash
node /absolute/path/to/codex-hud/dist/cli/index.js
```

将示例路径替换为实际源码目录。使用绝对路径，可以在需要观察的项目目录中启动 HUD。

### 3. 与 Codex 一起使用

在一个终端中正常使用 Codex；在第二个终端中进入**同一个项目目录**并运行：

```bash
cd /path/to/your/project
codex-hud
```

首次启动时，向导检测可用能力，并提供推荐配置或自定义模块选择。使用 **↑/↓** 移动、**空格**勾选、**Enter** 保存，随后进入 HUD。按 **Ctrl+C** 停止并恢复终端。

没有明确线程身份时，程序优先选择工作目录完全匹配的最新主会话；没有匹配项则选择最近的主会话。这属于历史会话选择，不能证明已实时连接当前 Codex 进程。`CODEX_HOME`、`CODEX_THREAD_ID` 和多会话行为见[会话选择说明](docs/USER_GUIDE.zh-CN.md#session-selection)。

## 功能

模块需要同时满足已启用、有可用数据、终端空间足够三个条件才会显示。

| 信息 | 可以了解什么 |
| --- | --- |
| 模型与推理 | 来源上报的模型、推理强度，以及可用时的快速模式标记 |
| 上下文 | 根据最近用量快照和窗口容量估算的上下文占用 |
| Token 与缓存 | 输入、输出、缓存输入累计量，以及数据充分时的缓存命中率 |
| 使用额度 | 来源上报的额度消耗与重置时间，包括 5 小时和每周窗口 |
| 工具与当前活动 | 正在执行的调用、近期结果、失败状态和当前活动摘要 |
| 子代理 | 父子关系、代理状态，以及来源提供的独立用量和活动 |
| 计划 | 已确认执行清单的步骤与完成数量，提案状态单独处理 |
| MCP 与技能 | 已发现的配置和能力，以及明确观测到的运行状态 |
| 会话与运行时 | 会话时长、轮数、数据来源、连接归属和回退状态 |

注册表共有 17 个模块，内置默认开启 11 个；setup 会按检测到的能力筛选推荐项。MCP、技能、费用估算、当前活动、会话详情和运行时状态需要主动开启。[完整模块说明](docs/USER_GUIDE.zh-CN.md#modules)列出了各项可用条件及预留的 Git 模块。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `codex-hud` | 首次配置后启动；已有有效配置时直接启动 |
| `codex-hud setup` | 选择模块并保存配置，不启动持续 HUD |
| `codex-hud language` | 打开显示语言选择菜单 |
| `codex-hud start` | 直接启动；没有配置文件时使用内存默认值 |
| `codex-hud config` | 查看当前语言、启用与关闭的模块及配置位置 |
| `codex-hud doctor` | 检查本地环境、来源、能力和配置 |
| `codex-hud debug --width 80 --height 24` | 输出一次真实快照，诊断写入 stderr |
| `codex-hud debug --verbose` | 增加经过脱敏、数量受限的诊断详情 |
| `codex-hud demo --width 80 --height 24` | 使用演示数据预览布局 |
| `codex-hud version` | 查看版本，也支持 `--version` |
| `codex-hud --help` | 查看帮助；`help <command>` 查看指定命令帮助 |

`--width`、`--height` 只用于 `debug` 和 `demo`，参数必须是正整数。stdout 不是 TTY 时，`start` 输出一次真实快照后退出。`doctor` 会在输出中逐项报告问题，不能只根据退出码判断环境完全健康。

## 配置

运行 `codex-hud setup` 选择显示内容，配置保存在：

```text
~/.codex-hud/config.toml
```

此路径不随 `CODEX_HOME` 改变。以下内容对应内置显示与行为默认值；省略的 runtime 设置同样使用默认值：

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

- `display.language` 支持 `en`（默认英文）和 `zh-CN`（简体中文）；旧配置省略该字段时同样使用英文。
- `display.order` 控制顺序，不会启用模块，也不改变空间不足时隐藏模块的优先级。
- `refresh_ms` 控制渲染节流，不是会话文件的轮询间隔。
- 缺失数据保持不可用，不会补成零；来源明确上报的零值会保留。
- 修改配置后重新启动 HUD。未知字段、重复模块 ID 和非法取值会报错。
- setup 的“恢复推荐配置”保留语言，其余设置恢复默认。配置无效时，先[备份并移走损坏文件，再运行 setup](docs/USER_GUIDE.zh-CN.md#config-recovery)。

在交互终端运行 `codex-hud language`，无需追加语言参数。用 **↑/↓** 选择、**Enter** 保存，或 **Ctrl+C** 取消且不写入文件。菜单默认选中当前语言。切换时保留其他设置；选择当前语言不重写已有文件。首次保存会创建默认配置，之后可运行 `codex-hud setup` 自定义模块。保存与 setup 一样重新序列化 TOML，不保留手写注释。

修改后重新启动正在运行的 HUD。内置帮助、配置向导、状态标签和诊断跟随所选语言；任务原文、工具名称、文件名和路径保留来源语言。

全部配置项、模块排序和数据源策略示例见[中文操作手册](docs/USER_GUIDE.zh-CN.md#configuration)。

## 工作方式

```text
Codex App Server → 核验连接 → 归一化事件 ─┐
                                         ├→ 会话状态 → 终端 HUD
本地 rollout JSONL → 增量读取 → 归一化事件 ┘
```

默认优先使用通过核验的 App Server 连接，同时保留 rollout 用于历史恢复与回退。实时连接需要明确的线程身份，并确认运行时实际承载该线程；缺少这些依据时，HUD 可以继续跟随已记录的 rollout 更新。

默认配置允许在发现与身份条件满足时启动 HUD 自有的 stdio App Server；附着外部运行时也可能启动官方 proxy 进程。自动启动 managed daemon **默认关闭**。退出时 HUD 清理自己的传输进程，不终止外部运行时。

设置 `providers.prefer_app_server = false`，可将 rollout 作为会话事件来源，并停止建立 App Server 连接；仍会执行本地 CLI 版本和能力检查。详见[运行时策略](docs/USER_GUIDE.zh-CN.md#runtime-policy)。

### 数据处理

HUD 读取本地会话日志、相关 Codex 配置和技能定义。App Server 模式还会执行协议请求并观察通知；HUD 不替你发起模型轮次或批准请求。确认线程已加载后，附着可能使用 `thread/resume`；当前协议没有独立的只观察式 resume。

诊断采用字段筛选、数量限制和脱敏处理。名称和任务摘要仍可能包含项目信息，分享前应检查输出；这些处理不能保证任意项目文本都已匿名化。

## 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 提示 `codex-hud: command not found` | 一行安装后检查 `~/.local/bin` 是否在 PATH；源码安装使用 `npm link` 或 Node 入口的绝对路径 |
| setup 提示需要交互终端 | 直接在 stdin、stdout 均可交互的终端中运行 |
| 一直等待会话，或显示了其他会话 | 检查启动目录、`CODEX_HOME` 和继承的线程环境变量 |
| 模块已开启却未出现 | 检查 `doctor`、数据是否可用、终端空间及已保存的选择 |
| App Server 不可用 | 在 `doctor` 或 `debug` 中查看回退原因；允许回退时可继续读取 rollout |
| 配置无效 | 按[备份与恢复步骤](docs/USER_GUIDE.zh-CN.md#config-recovery)处理 |

查看真实快照和详细诊断：

```bash
codex-hud doctor
codex-hud debug --verbose --width 140 --height 30
```

这些命令检查本次调用，不查询另一个常驻 HUD 的内部状态。配置有效时，它们遵循其中的运行时策略，可能连接或启动许可的辅助进程；配置无效时，`doctor` 使用内置默认值继续检查，包括优先尝试 App Server。需要禁用该连接时，应先恢复合法的 rollout 配置。更多场景见[操作手册](docs/USER_GUIDE.zh-CN.md#troubleshooting)。

## 当前限制

**0.1.0** 已具备可用的 rollout 观察链路，部分真实运行时验证仍待补齐。总体状态仍为 **PARTIAL**：

- 真实 rollout 观察在 macOS arm64、Codex CLI 0.154.0、Desktop rollout writer 0.153.4 环境中验证。这是已记录的环境，不是最低版本或跨平台兼容性承诺。
- 报告中的完整回归有 18 项因 Unix socket 权限受限而失败；真实共享 App Server 附着、重启及双源交接尚未完整验证。进程身份核验仅实现于 macOS/Linux，因此 Windows 当前不支持 App Server 附着，Windows rollout 观察尚未验收。
- 非空额度、实际金额对照、MCP 生命周期、技能活动和当前版本执行计划缺少完整的真实运行证据；展示取决于来源实际提供的字段。
- 上下文为快照估算；费用为**标准 API 等价估算**，不代表 Codex 订阅账单。价格未知或用量不完整时，费用可能不可用。
- Git 渲染支持演示或已有状态输入，尚未采集真实仓库信息。

## 开发

在仓库根目录执行：

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev -- demo --width 80 --height 24
```

`npm run dev -- <command>` 直接执行 TypeScript 入口，不是文件监听命令。观察其他项目时，应在目标项目目录中启动构建后的入口。socket 相关测试需要允许本地 Unix socket 和进程检查的环境；权限失败不能当作测试通过。

安装器的针对性测试使用临时目录，不修改用户配置：

```bash
npm test -- tests/Installer.test.ts
```

发布前也可用本地源码归档验证完整安装。归档需包含一个顶层目录及完整源码、`package.json`、`package-lock.json` 和 `tsconfig.json`，且不能包含符号链接或特殊文件。以下示例归档的是**已提交的 HEAD**，npm 依赖仍需可获取：

```bash
git archive --format=tar.gz --prefix=codex-hud/ HEAD > /tmp/codex-hud-source.tar.gz
bash install.sh --archive /tmp/codex-hud-source.tar.gz --prefix /tmp/codex-hud-install-check
/tmp/codex-hud-install-check/bin/codex-hud --version
```

| 路径 | 内容 |
| --- | --- |
| `src/cli/`、`src/config/` | 命令和配置 |
| `src/providers/codex/` | 会话发现、rollout 解析、App Server 接入 |
| `src/core/` | 归一化状态、追踪器、用量计量和诊断 |
| `src/runtime/`、`src/terminal/` | 刷新调度、生命周期和终端控制 |
| `src/renderer/` | 展示模块和自适应布局 |
| `tests/` | 自动化测试与样本 |
| `docs/` | 操作手册、设计说明和验收报告 |

## 许可证

采用 [MIT 许可证](LICENSE)。
