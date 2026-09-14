# Codex HUD 中文操作手册

适用版本：**0.1.0**。本手册说明安装、日常使用、配置和故障处理；项目介绍见[中文 README](../README.zh-CN.md)，英文介绍见 [English README](../README.md)。

示例命令使用 macOS/Linux 的 Bash 或 Zsh。`/path/to/your/project` 和 `/absolute/path/to/codex-hud` 是路径占位符，执行前替换为实际路径。当前真实验收环境为 macOS；进程身份核验仅实现于 macOS/Linux，Windows 当前不支持 App Server 附着，Windows rollout 观察尚未验收。

## 目录

- [1. 先了解运行方式](#overview)
- [2. 安装与首次启动](#installation)
- [3. 日常操作](#daily-use)
- [4. 选择要观察的会话](#session-selection)
- [5. 命令参考](#commands)
- [6. 模块与指标解读](#modules)
- [7. 配置文件参考](#configuration)
- [8. 数据源与运行时策略](#runtime-policy)
- [9. 故障排查](#troubleshooting)
- [10. 更新与移除本机命令](#maintenance)
- [11. 数据处理与验证边界](#limitations)
- [12. 技术文档索引](#technical-docs)

<a id="overview"></a>

## 1. 先了解运行方式

Codex HUD 是独立终端程序。通常一个终端运行 Codex，另一个终端或分屏运行 HUD；面板不会嵌入 Codex 的输入框，也不提供网页界面。

它可以读取本地 rollout 会话记录，或在通过身份与能力核验后连接 Codex App Server。HUD 用于观察，不替你发送模型请求、执行计划步骤或批准 Codex 请求。需要审批或输入时，回到原来的 Codex 界面处理。

终端宽度不足时，布局会变紧凑或隐藏优先级较低的模块。模块缺少可靠数据时也会隐藏，因此实际面板不一定与演示相同。

<a id="installation"></a>

## 2. 安装与首次启动

### 2.1 检查环境

需要 Node.js 20 或更高版本和 npm。读取已有 rollout 需要可读的本地会话数据；连接 App Server 还需要 `PATH` 中可用的 Codex CLI。先在终端检查：

```bash
node --version
npm --version
codex --version
```

如果只是观察已有 rollout，`codex --version` 提示命令不存在不会阻止日志读取；App Server 连接则需要先解决 CLI 可用性。持续 HUD 和配置向导需要交互终端。仅运行 `demo` 时不需要 Codex CLI 或会话，但需要项目依赖和有效的 HUD 配置（如果配置文件已经存在）。

本项目没有声明 Codex CLI 的最低兼容版本。已有验收记录使用 CLI 0.154.0、Desktop rollout writer 0.153.4，不能据此推断所有版本均兼容。

### 2.2 安装依赖并构建

克隆或下载本仓库，在 **codex-hud 源码根目录**执行：

```bash
npm ci
npm run build
node dist/cli/index.js version
node dist/cli/index.js demo --width 80 --height 24
```

成功时版本命令输出 `0.1.0`，演示命令输出模拟面板，并在 stderr 标注 `Demo data`（中文模式为“演示数据”）。`npm ci` 依据锁文件安装依赖；项目没有自动构建安装钩子，因此需要单独运行 `npm run build`。

当前包的 `private` 字段为 `true`。安装说明采用本地源码，不假设存在可用的公开 npm 发布包。

### 2.3 选择启动方式

| 方式 | 操作 | 适用情况 |
| --- | --- | --- |
| 注册 `codex-hud` 命令 | 在源码根目录运行 `npm link` | 经常从不同项目目录启动 |
| 使用 Node 绝对路径 | `node /absolute/path/to/codex-hud/dist/cli/index.js` | 不希望创建全局 npm 链接 |
| 直接运行 TypeScript | 在源码根目录运行 `npm run dev -- demo` 等 | 开发和本项目内调试 |

`npm link` 会写入 npm 全局链接，指向当前源码目录；请保持目录位置稳定，并确保 npm 的全局可执行文件目录在 `PATH` 中。权限不足时可使用绝对路径方式。

后文统一使用 `codex-hud`。未注册命令时，将它替换为上述 Node 绝对路径入口，后面的参数保持不变。例如：

```bash
node /absolute/path/to/codex-hud/dist/cli/index.js setup
```

`npm run dev` 会从包目录启动。若要观察其他项目，使用全局命令或构建入口的绝对路径，并从目标项目目录启动。

### 2.4 首次配置

先在 Codex 中正常使用一次目标项目，使本地产生可读取的会话数据。随后在另一个终端中运行：

```bash
cd /path/to/your/project
codex-hud
```

没有配置文件时，会先检测能力，再进入向导：

程序默认使用英文，下列选项说明使用中文。需要切换时可运行 `codex-hud language`，具体操作见[语言设置](#language)。如果先保存了语言配置，裸命令会直接启动；运行 `codex-hud setup` 可继续选择模块。

1. 选择“使用推荐配置”或“自定义”。推荐项根据本次检测结果筛选。
2. 自定义时用 ↑/↓ 移动、空格勾选、Enter 保存。当前不可用项会显示原因，通常不能勾选。
3. 配置保存到 `~/.codex-hud/config.toml`，随后进入 HUD。

保存前按 Ctrl+C 取消，不会覆盖原配置。若只运行 `codex-hud setup`，保存后退出向导；还需要执行 `codex-hud start` 才进入持续 HUD。

没有真实来源时，推荐配置可能很少甚至为空。先用 `demo` 检查布局，待真实会话可读后重新运行 setup。

<a id="daily-use"></a>

## 3. 日常操作

### 3.1 双终端工作

终端 A：在目标项目中正常启动 Codex。

```bash
cd /path/to/your/project
codex
```

终端 B：进入完全相同的目录，启动 HUD。

```bash
cd /path/to/your/project
codex-hud start
```

`start` 直接运行。没有配置文件时使用内存默认值，不进入向导，也不创建配置文件。已有有效配置时，裸命令 `codex-hud` 与直接启动的效果相同。

HUD 根据数据变化和终端尺寸变化刷新。按 Ctrl+C 停止，恢复光标和原来的终端屏幕。Codex 结束后，HUD 可能继续保留最后快照并寻找后续会话；面板仍有内容不代表模型仍在工作。

### 3.2 修改显示内容

先退出当前 HUD，再执行：

```bash
codex-hud setup
codex-hud config
codex-hud start
```

已有配置时，向导提供以下选项：

| 选项 | 效果 |
| --- | --- |
| 保留当前配置 | 不重写文件 |
| 自定义 | 调整显示模块，保留现有行为和运行时设置 |
| 恢复推荐配置 | 保留当前语言，按本次能力重新生成模块选择，行为、运行时设置和排序恢复默认 |

自定义保存时，当前不可用的旧模块可能被移除，界面会先提示；已有启用的 Token、Cache、Cost 和额度模块有保留例外。需要保留原文件时，可以取消。保存会重新序列化 TOML，不保留手写注释。

`config` 概览当前语言、启用与关闭模块，不是完整 TOML 导出。查看全部行为和运行时参数，需要打开配置文件。配置修改后重新启动 HUD。

### 3.3 单次查看与布局预览

```bash
codex-hud debug --width 80 --height 24
codex-hud debug --verbose --width 140 --height 30
codex-hud demo --width 30 --height 24
```

`debug` 使用真实来源：HUD 写入 stdout，诊断写入 stderr。`demo` 使用固定的模拟状态，但同样读取 HUD 配置，已关闭的模块不会自动打开。

当 stdout 被重定向、接入管道或处于非 TTY 环境时，`start` 只输出一次真实快照后退出，不保持刷屏。首次裸命令需要 setup 时，仍要求交互终端。

<a id="language"></a>

### 3.4 设置显示语言

在交互终端运行：

```bash
codex-hud language
```

命令直接打开选择菜单，无需输入语言参数。用 **↑/↓** 选择英文或简体中文，按 **Enter** 保存；默认选中当前语言，首次为英文。英文菜单的两项显示为 `English` 和 `Simplified Chinese`。

按 **Ctrl+C** 取消，不会创建或覆盖配置。切换语言只改变 `display.language`，保留模块、顺序、行为和运行时策略；选择当前语言不会重写已有文件。没有文件时保存会创建默认配置，之后用 `codex-hud setup` 自定义模块。保存采用 TOML 重序列化，不保留原注释。

保存后重启 HUD 生效。帮助、配置向导、内置状态和诊断跟随语言设置；任务文本、工具名称、文件名、路径等原始内容保持原文。旧配置缺少语言字段时使用英文。语言命令要求 stdin/stdout 均为 TTY，不适用于管道或重定向。

<a id="session-selection"></a>

## 4. 选择要观察的会话

### 4.1 两种目录不要混淆

| 目录 | 用途 |
| --- | --- |
| codex-hud 源码目录 | 安装依赖、构建、开发和注册命令 |
| 正在使用 Codex 的项目目录 | 启动 HUD，帮助选择要观察的会话 |

如果一直从 codex-hud 源码目录运行，可能观察到该目录的旧会话，而不是正在开发的其他项目。

### 4.2 选择规则

主会话按以下规则选择：

1. 有同一 Codex home 下的有效 `CODEX_THREAD_ID` 时，优先使用明确线程；如果同时存在 `CODEX_SESSION_ID`，两者必须一致。
2. 没有明确线程时，优先取工作目录与 HUD 启动目录完全匹配的最新主 rollout。
3. 没有目录匹配项时，取最近的主 rollout；子代理日志不参与主会话候选。

明确线程没有对应 rollout 时，不会自动改为回放其他线程。没有明确线程的目录/时间选择只用于历史；其后可以继续读取日志新增内容，但不足以授权实时 App Server 附着。同一项目多任务并行时，“最近记录”也不一定是你想看的任务。

### 4.3 环境变量

| 变量 | 含义 |
| --- | --- |
| `CODEX_HOME` | Codex 数据目录；未设置时使用 `~/.codex`，会话位于其 `sessions/` 下 |
| `CODEX_THREAD_ID` | 目标任务的真实线程 ID，用于明确线程选择 |
| `CODEX_SESSION_ID` | 若与线程 ID 同时存在，必须一致；单独设置它不能指定线程 |
| `PATH` | 用于找到 Codex CLI；使用全局链接时也需能找到 `codex-hud` |

HUD 配置始终位于 `~/.codex-hud/config.toml`，不随 `CODEX_HOME` 切换。两个 Codex home 因而可能共用同一份 HUD 显示配置。

使用非默认 Codex 数据目录时，可以只为本次命令指定：

```bash
CODEX_HOME="/absolute/path/to/codex-home" codex-hud start
```

只有已从目标任务环境或明确的会话元数据取得真实线程 ID 时，才指定：

```bash
CODEX_THREAD_ID="目标任务的真实线程ID" codex-hud start
```

上面的文字需要替换成真实值，并保证 home 一致。不要拿诊断里缩短后的 ID 代替完整线程 ID。检查是否继承了其他任务的 `CODEX_THREAD_ID` 或冲突的 `CODEX_SESSION_ID`；当前 CLI 没有 `--thread`、`--project`、`--cwd` 或交互会话选择器。

Desktop 产生的本地 rollout 也可能被读取；这不表示 HUD 会嵌入桌面应用，或自动实时附着任意已打开任务。

<a id="commands"></a>

## 5. 命令参考

| 命令 | 专用参数 | 说明 |
| --- | --- | --- |
| `codex-hud` | 无 | 缺配置则先引导，随后启动 |
| `codex-hud setup` | 无 | 能力检测、交互选择和保存配置 |
| `codex-hud language` | 无 | 打开英文/简体中文选择菜单并保存 |
| `codex-hud start` | 无 | 持续 HUD；非 TTY 时输出一次快照 |
| `codex-hud config` | 无 | 显示当前语言、模块选择与配置位置 |
| `codex-hud doctor` | 无 | 检查来源、能力、监听、配置、渲染等 |
| `codex-hud debug` | `--width`、`--height`、`--verbose` | 一次真实快照与诊断 |
| `codex-hud demo` | `--width`、`--height` | 一次模拟数据预览 |
| `codex-hud version` | 无 | 版本号；也可用 `-V` 或 `--version` |
| `codex-hud help <command>` | 命令名 | 指定命令帮助；各命令也支持 `-h`、`--help` |

宽高必须是正的十进制安全整数；省略时使用检测到的终端尺寸，无可用尺寸时回落到 80×24。`--verbose` 只用于 debug。

不存在 `run` 子命令，也没有 `--config`、`--mode`、`--socket` 参数。布局自动决定，配置文件路径固定，运行时策略通过 TOML 设置。

普通错误一般退出码为 1，配置向导或语言选择取消为 130。`doctor` 会尽量完成各项检查，即使打印了失败项也可能正常退出；应读取检查结果，不能只把退出码当健康状态。无数据或未观测能力本身也不一定导致失败退出。

<a id="modules"></a>

## 6. 模块与指标解读

### 6.1 完整模块列表

“内置默认”表示没有显式模块选择时的默认值；setup 的推荐项还会按能力筛选。配置启用不等于当前一定显示。

| 模块 ID | 名称 | 内置默认 | 显示条件或边界 |
| --- | --- | --- | --- |
| `model` | 模型 | 开 | 有模型字段；宽屏可显示来源提供的快速模式 |
| `reasoning` | 推理强度 | 开 | 有明确的 reasoning effort |
| `context` | 上下文 | 开 | 同时具有最近用量和有效窗口容量 |
| `five-hour-usage` | 5 小时额度 | 开 | 有可识别的额度窗口和比例 |
| `weekly-usage` | 每周额度 | 开 | 有可识别的额度窗口和比例 |
| `agents` | 子代理 | 开 | 有代理事件或状态，缺少数据时隐藏 |
| `tools` | 工具 | 开 | 有工具活动或近期结果 |
| `current-activity` | 当前活动 | 关 | 有值得显示的当前活动；空闲时隐藏 |
| `plan` | 计划 | 开 | 有执行清单、提案或计划模式信息 |
| `session` | 会话 | 关 | 有可用的会话信息 |
| `git` | Git | 开 | 仅有渲染与演示接口，真实 Git 数据尚未采集 |
| `mcp` | MCP | 关 | 有发现的配置或明确运行信息 |
| `skills` | 技能 | 关 | 有目录发现或当前任务技能信息 |
| `token-details` | Token 明细 | 开 | 有累计用量数据，并区分实测与估算 |
| `cost` | 费用估算 | 关 | 用量、价格和计费映射足以计算 |
| `cache` | 缓存 | 开 | 有缓存用量或可计算命中率 |
| `runtime-status` | 运行时状态 | 关 | 有当前数据源和连接归属信息 |

Current Activity 出现时，Tools 会避免重复展示同一调用。MCP 和 Skills 可以基于静态发现供选择，但静态配置不等于服务已连接，磁盘上有技能文件也不等于它正在执行。

### 6.2 上下文、Token、缓存、额度和费用

| 指标 | 正确理解 |
| --- | --- |
| 上下文占用 | 最近 Token 快照除以窗口容量的估算，不是累计会话消耗；压缩后可能暂时等待新快照 |
| 累计 Token | 使用来源累计快照，不把多次累计值相加；主线程不直接累加子代理用量 |
| 缓存输入 | 属于 input 的子集，不能再加一次得到总 Token；reasoning 同样属于 output 分项 |
| 缓存命中率 | 最近请求和会话统计分别处理；零输入时命中率未定义，完整会话统计需要足够的请求记录 |
| 额度 | 来源上报的全局已用比例，不是当前项目单独消耗；缺失不补成 0%，重置时刻到达后等待新快照 |
| 费用 | 标准 API 等价估算，不是订阅账单；最近请求可计算并不代表整场会话都可计算 |

未知周期的额度窗口可能显示“额度”或“额度2”，不会一律硬套成 5 小时/每周。价格未知、记录不完整或缓存写入计费映射不确定时，费用会不可用；没有费用数值不表示免费。程序内登记的价格也不表示每次运行都联网复核了定价。

### 6.3 代理和计划状态

| 符号 | 代理含义 | 计划步骤含义 |
| --- | --- | --- |
| `◷` | 启动中 | 不使用 |
| `●` | 运行中 | 执行中 |
| `○` | 等待 | 待执行 |
| `✓` | 已完成 | 已完成 |
| `✗` | 失败 | 失败 |
| `⊘` | 已取消 | 已取消 |
| `?` | 状态未知 | 状态未知 |

真实代理树的计数包含主代理，不能把标题中的总数全部当成子代理数。未知上下文可能显示 `—`；父子关系依赖明确的线程关联，不按时间相近猜测。

计划比例只计算 `completed` 步骤。`in_progress` 不计为完成；计划模式、提案和执行清单相互独立。“计划提案 · 生成中/待确认”不表示步骤正在执行，普通执行清单也不自动证明用户已经批准。没有来源提供的清单时，不把对话文本或工具活动编成进度。

### 6.4 终端大小与隐藏规则

默认 `auto_compact = true` 时：

| 宽度 | 布局 |
| --- | --- |
| 100 列及以上 | 完整信息，行数受终端高度限制 |
| 60–99 列 | 紧凑信息，最多 8 行 |
| 8–59 列 | 精简信息，最多 4 行 |
| 小于 8 列 | 不显示无法阅读的 HUD 内容 |

高度不足时，布局会进一步压缩或隐藏模块。`display.order` 调整展示顺序，但不改变空间不足时的隐藏优先级。若想查看完整信息，先放大终端；CLI 没有固定布局模式选项。

<a id="configuration"></a>

## 7. 配置文件参考

### 7.1 路径与完整默认值

配置路径固定为 `~/.codex-hud/config.toml`。修改时使用 UTF-8 无 BOM 编码，并在之后重启 HUD。以下是完整内置默认配置；它与 setup 按来源筛选后的文件可能不同：

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

[runtime]
prefer_managed = true
prefer_shared = true
allow_spawn = true
allow_external_attach = true
auto_reconnect = true
auto_start_managed = false
```

最小合法文件只有 `version = 1`；其余表缺失时补内存默认值。已有显式 `display.enabled` 会保留，不会因为新增模块而自动补选。

### 7.2 显示与行为

| 配置项 | 默认值 | 规则 |
| --- | --- | --- |
| `version` | 必须填写 `1` | 其他版本拒绝读取 |
| `display.language` | `"en"` | `en` 为英文，`zh-CN` 为简体中文；省略时使用英文 |
| `display.enabled` | 上述 11 个模块 | 合法、无重复的模块 ID 数组；允许 `[]` |
| `display.order` | 不设置 | 可选排序数组；未列出的已启用模块按注册顺序追加 |
| `behavior.refresh_ms` | `150` | 1–60000 的整数，单位毫秒，只控制渲染节流 |
| `behavior.auto_compact` | `true` | 自动降低信息密度；设为 false 后仍受终端宽高限制 |
| `behavior.hide_when_idle` | `false` | 根活动明确空闲、无活动子代理且来源未降级时才隐藏 |

调整 `enabled` 数组本身的排列不能可靠控制显示顺序，请使用 `order`。下面是只关注上下文、代理、工具和计划的完整配置示例，未写出的设置使用默认值：

```toml
version = 1

[display]
enabled = ["model", "reasoning", "context", "agents", "tools", "plan"]
order = ["context", "model", "reasoning", "agents", "tools", "plan"]
```

未知字段、未知模块、重复 ID、非法类型都会报错。旧的 `mode` 配置不再支持；语言设置位于 `[display]` 表内。空闲隐藏不会仅凭“一段时间没更新”触发。

### 7.3 数据源与运行时字段

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `providers.prefer_app_server` | `true` | 优先尝试经核验的 App Server；false 时使用 rollout |
| `providers.use_rollout_fallback` | `true` | 偏好 App Server 时，是否保留 rollout 历史/回退来源 |
| `runtime.prefer_managed` | `true` | 候选选择时优先受管运行时，不是启动开关 |
| `runtime.prefer_shared` | `true` | 候选选择时优先共享运行时，不是附着许可开关 |
| `runtime.allow_spawn` | `true` | 条件满足时允许创建 HUD 自有 stdio App Server |
| `runtime.allow_external_attach` | `true` | 允许附着经核验的外部运行时 |
| `runtime.auto_reconnect` | `true` | 允许有界自动重连 |
| `runtime.auto_start_managed` | `false` | 显式允许尝试官方 daemon 启动命令，仍需满足发现和能力条件 |

`allow_spawn = false` 只限制自有 stdio server，不单独阻止 proxy 进程或显式启用的 managed daemon 启动。只想读取 rollout 时，使用下一节的第一种方案。

保存配置采用同目录临时文件与原子替换，文件以 `0600` 权限创建，新建目录模式为 `0700`；这些是 POSIX 权限语义，不构成 Windows 权限保证。程序不会为了补齐新默认字段而自动改写旧配置。

<a id="runtime-policy"></a>

## 8. 数据源与运行时策略

下列 TOML 都是完整的最小示例。已有配置时，只修改对应表中的字段，保留自己的显示和行为设置；不要重复追加同名表。

### 8.1 仅使用 rollout 会话事件

适合优先查看本地会话记录、不需要 App Server 附着的场景：

```toml
version = 1

[providers]
prefer_app_server = false
use_rollout_fallback = true
```

不会建立 App Server 连接，也不会通过该来源启动 server/proxy；仍会进行本地 CLI 版本、配置和能力检查。`prefer_app_server = false` 时，rollout 就是主来源，此时即使把 `use_rollout_fallback` 设为 false 也不会关闭 rollout。

rollout 使用目录监听并保留默认约 3 秒的增量补查；Provider 也定期重新发现会话。`refresh_ms = 150` 不表示日志每 150 毫秒扫描一次。

### 8.2 允许附着，禁止创建自有 server 和自动启动 daemon

```toml
version = 1

[providers]
prefer_app_server = true
use_rollout_fallback = true

[runtime]
allow_external_attach = true
allow_spawn = false
auto_start_managed = false
```

附着仍可能创建 HUD 自己的官方 proxy 进程。外部运行时必须通过用户归属、权限、socket、进程身份、home、协议及线程承载关系核验；同等候选无法消歧时回退。

没有明确线程身份，不会仅凭工作目录或日志更新时间实时附着，也不会因此自动创建独立 server。新启动的独立实例不能自动观察其他实例中未加载的线程。

### 8.3 仅接受 App Server 来源

```toml
version = 1

[providers]
prefer_app_server = true
use_rollout_fallback = false
```

该配置关闭 rollout 业务事件读取和持续监听；发现阶段仍可能读取会话元数据，`doctor` 也可能对已发现的 rollout 做短时监听探测。实时连接失败时无法依靠 rollout 补偿；App Server 历史也不包含全部 Token 或执行清单数据，面板可能缺项。只在明确需要这一行为时使用。

### 8.4 连接、重试与退出

默认不会自动启动 managed daemon。显式开启 `auto_start_managed` 后，还需官方 CLI 支持、目标线程明确、没有已有 runtime 等条件，才可能尝试启动。

当前外部连接实现支持经过核验的 Unix socket 和官方 proxy；发现 WebSocket 端点不表示能附着。只对确认已加载且状态适合的线程 rejoin，可能发送 `thread/resume`；当前协议缺少独立的只观察式 resume，线程在检查后卸载仍存在竞态。

默认重连采用有上限的退避，连续失败最多 8 次，间隔上限 30 秒。长期无业务事件可能标为 `stale`，不直接判定断线；正常空闲不会仅因没新消息而反复重连。达到重试上限或清理失败时，先看诊断、处理原因，再重新启动 HUD。

退出时只清理 HUD 创建的连接与传输进程，不终止外部 Codex 或共享 daemon。

<a id="troubleshooting"></a>

## 9. 故障排查

### 9.1 先运行诊断

```bash
codex-hud doctor
codex-hud debug --verbose --width 140 --height 30
```

重点查看：Codex binary/版本、home、选中会话、读取与解析状态、模块能力、数据来源、authority、ownership、fallback 和配置错误。

`debug --verbose` 增加有数量限制的请求、计划、MCP 和技能摘要，并经过脱敏。它读取本次快照，不查询另一个持续运行的 HUD 的监听或性能状态。`doctor` 的监听探测也只是本次短时检查，“未报错”不等于已证明事件能够送达。

这些真实诊断入口使用相同 Provider，配置有效时遵循其中的连接和进程策略。配置无效时，`doctor` 会用内置默认策略继续检查，其中包括优先尝试 App Server；损坏文件中的禁用设置不会生效。需要禁止 App Server 时，应先恢复合法的 [rollout 配置](#runtime-policy)。分享日志前检查任务标题、文件名和项目摘要，避免直接提交原始会话文件。

### 9.2 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 找不到 `codex-hud` | 检查 `npm link` 和 `PATH`，或使用构建入口绝对路径 |
| 找不到 `dist/cli/index.js` | 回到源码根目录执行 `npm ci`、`npm run build`，核对路径 |
| setup 要求交互终端 | 不通过管道或重定向运行向导，确保 stdin/stdout 都是 TTY |
| 一直等待会话 | 确认 Codex 已产生可读会话，检查 `CODEX_HOME`、权限、线程 ID 和 doctor |
| 显示其他项目或旧任务 | 按[会话选择规则](#session-selection)检查启动目录和继承的线程变量 |
| 配置模块已开启却不显示 | 检查是否有真实数据、是否被终端空间隐藏，以及 setup 实际保存了哪些项 |
| 额度或费用为空 | 查看来源字段、价格和请求记录是否充分；不要把缺失当成 0 或免费 |
| MCP 显示“已配置”而非“已连接” | 两者语义不同；仅配置发现不能证明运行连接成功 |
| Skills 显示“目录发现” | 文件被发现不等于当前任务可用或正在执行 |
| Git 不显示 | 当前未接入真实 Git 来源，demo 中的分支只是模拟值 |
| `EMFILE` 或监听不可用 | 查看是否已切换为约 3 秒的增量补查；读取仍失败时按诊断处理权限或资源限制 |
| App Server 回退或重连失败 | 核对明确线程、home、端点和进程检查权限；保留回退可继续观察 rollout |
| 开了 `hide_when_idle` 仍不隐藏 | 需要明确 idle、无活动子代理且来源未降级；仅无更新不满足条件 |
| `doctor` 退出码为 0 却有错误 | 以逐项结果为准，该命令不保证把每个检查失败转换为非零退出码 |

<a id="config-recovery"></a>

### 9.3 配置损坏或旧字段导致无法启动

先关闭 HUD，打开 `~/.codex-hud/config.toml`，检查 TOML 语法、`version = 1`、重复表、模块 ID 和不支持的字段。`doctor` 能报告配置问题并继续其他检查，但配置损坏时会使用内置默认运行时策略；若需禁止 App Server，应先手动恢复合法配置。

当前 CLI 会在进入 setup 向导前读取配置，**不能依靠直接运行 setup 修复损坏文件**。优先修正文件；确需重新生成时，确认原文件存在，再执行以下备份和移走操作：

```bash
codex_hud_backup_dir="$(mktemp -d "$HOME/.codex-hud/backup.XXXXXX")" &&
mv "$HOME/.codex-hud/config.toml" "$codex_hud_backup_dir/config.toml" &&
codex-hud setup
```

原文件保存在新建的独立备份目录中。前一步失败时，`&&` 会阻止继续；取消向导后备份仍保留。新的配置成功保存后，再运行 `codex-hud start`。需要恢复时，在 HUD 停止后先检查并修正备份内容，再放回原路径。

<a id="maintenance"></a>

## 10. 更新与移除本机命令

更新前停止 HUD，保留现有配置和本地未提交修改。取得希望使用的新版源码后，在源码根目录执行：

```bash
npm ci
npm run build
node dist/cli/index.js version
```

更新源码不会让旧 `dist` 自动变化，必须重新构建。通过 `npm link` 使用且源码路径不变时，链接继续指向该目录；移动目录后需要重新建立链接。`npm ci` 会重建项目依赖目录。

若要移除之前通过 `npm link` 注册的全局命令，可运行：

```bash
npm uninstall -g codex-hud
```

这会移除 npm 全局安装/链接；源码目录与 `~/.codex-hud/config.toml` 可保留。此操作不负责移除 Codex 本身，也不需要更改其配置。

<a id="limitations"></a>

## 11. 数据处理与验证边界

读取范围包括本地 rollout、相关 Codex 配置、技能定义及当前任务明确引用的能力信息；App Server 模式还会查询协议状态并接收事件。HUD 不通过读取 Codex SQLite/WAL 获取状态，不替你发起模型轮次或作出审批决定。setup 保存的是 HUD 自己的配置。

诊断使用白名单字段、缩短的线程 ID、有界摘要和脱敏处理，但任意业务文本不保证完全匿名。费用只作标准 API 等价估算，内置价格登记不等于实时核价。

[2026-09-13 验收报告](phase10-acceptance.md)仍为 **PARTIAL**：真实 rollout 观察已验证；完整测试中 18 项受 Unix socket 权限限制而失败，真实 App Server 附着、重启与双源交接未完全验证。非空额度、实际费用对照、MCP 运行生命周期、技能活动及当前版本执行计划也缺少完整真实证据。

这份手册描述已实现的操作入口与边界，不把演示或协议夹具当作实际连接成功。其他平台、新 Codex 版本及来源没有提供的字段，仍需在相应环境确认。详细结果见[完成报告](phase10-completion-report.md)。

<a id="technical-docs"></a>

## 12. 技术文档索引

需要了解实现或历史验收时，可按主题查阅；阶段报告反映各自记录时的状态：

| 主题 | 文档 |
| --- | --- |
| 当前架构、错误处理与资源边界 | [生产加固](phase10-production-hardening.md) |
| 当前验收与证据 | [验收矩阵](phase10-acceptance.md)、[完成报告](phase10-completion-report.md)、[证据索引](evidence/phase10/README.md) |
| 性能与长时间运行 | [性能报告](phase10-performance.md) |
| 运行时发现与连接依据 | [运行时发现](phase9-runtime-discovery.md)、[权威矩阵](phase9-authority-matrix.md)、[运行时验收](phase9-runtime-authority.md) |
| App Server 接入与来源一致性 | [接入报告](phase8-app-server.md)、[能力矩阵](phase8-capability-matrix.md)、[来源对照](phase8-source-parity.md) |
| Token、缓存、额度和费用 | [用量说明](phase7-usage-economics.md)、[字段调查](phase7-usage-discovery.md) |
| 计划与执行进度 | [计划说明](phase6-plan.md)、[计划来源](phase6-plan-discovery.md) |
| MCP 与技能 | [能力说明](phase5-mcp-skills.md)、[发现规则](phase5-mcp-skills-discovery.md) |
| 子代理 | [代理说明](phase4-agents.md)、[代理发现](phase4-agent-discovery.md) |
| 工具与活动 | [工具活动链路](phase3-tools-activity.md) |
| rollout 与持续运行 | [来源结构](phase2-rollout-schema.md)、[实时运行记录](phase2-live-runtime.md) |

返回[中文 README](../README.zh-CN.md)或 [English README](../README.md)。
