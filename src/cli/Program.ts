import { messages, t, type MessageKey } from "../i18n/Messages.js";
import { currentLanguage, defaultLanguage, isLanguage, withLanguage, type Language } from "../i18n/Language.js";
import { readFileSync } from "node:fs";
import { Command, Help, InvalidArgumentError, type ParseOptions } from "commander";
import { CapabilityDetector, diagnosticText } from "../capabilities/CapabilityDetector.js";
import { configPath, createDefaultConfig, loadConfig, saveConfig, type HudConfig } from "../config/Config.js";
import { mockState } from "../demo/mockState.js";
import { HudRenderer } from "../renderer/HudRenderer.js";
import { ModuleRegistry } from "../renderer/modules/ModuleRegistry.js";
import { formatCapabilities, runSetup, terminalPrompter, type SetupPrompter } from "./Setup.js";
import { runHud, terminalSize, type HudOutput, type HudProvider } from "./RunHud.js";
import { writeOutput } from "./Output.js";
import { CodexSessionProvider, hasUsableAppServer, type CodexSessionSnapshot } from "../providers/codex/CodexSessionProvider.js";
import { redactText } from "../core/Redaction.js";
import { debugState, formatDebug, formatRuntimeChecks, formatWatcherProbe } from "./Diagnostics.js";
import { languageName, promptLanguage, type LanguagePrompter } from "./Language.js";

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

function dimension(value: string): number {
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new InvalidArgumentError(t("尺寸必须是正整数"));
  }
  return Number(value);
}

function localizedError(message: string): string {
  if (currentLanguage() === "en") return message;
  return message.replace(/^error: /u, t("参数错误："))
    .replace(/unknown option /gu, t("未知选项 "))
    .replace(/unknown command /gu, t("未知命令 "))
    .replace(/too many arguments[^\n]*/gu, t("参数数量过多"))
    .replace(/argument missing/gu, t("缺少参数"))
    .replace(/option (.+) argument (.+) is invalid\./gu, t("选项 $1 的参数 $2 无效。"))
    .replace(/\boption\b/gu, t("选项"))
    .replace(/\(Did you mean ([^)]+)\?\)/gu, t("（是否要使用 $1？）"));
}

export class HudCommand extends Command {
  language: Language = defaultLanguage;
  private configuration: HudConfig | null = null;
  private configurationError?: unknown;

  constructor(private readonly configFile: string) { super(); }

  getConfig(): HudConfig | null {
    if (this.configurationError) throw this.configurationError;
    return this.configuration;
  }

  override async parseAsync(argv?: readonly string[], options?: ParseOptions): Promise<this> {
    this.configurationError = undefined;
    this.configuration = null;
    this.language = defaultLanguage;
    try {
      this.configuration = await loadConfig(this.configFile);
      this.language = this.configuration?.display.language ?? defaultLanguage;
    } catch (error) {
      // 帮助和版本不依赖有效配置；配置错误仍由实际命令报告，doctor 可继续其余检查。
      this.configurationError = error;
    }
    return withLanguage(this.language, () => super.parseAsync(argv, options));
  }
}

function helpDescription(value: string): string {
  return Object.hasOwn(messages, value) ? t(value as MessageKey) : value;
}

export function createProgram(options: {
  configFile?: string;
  output?: HudOutput;
  errorOutput?: NodeJS.WritableStream;
  prompt?: SetupPrompter;
  languagePrompt?: LanguagePrompter;
  detector?: CapabilityDetector;
  provider?: HudProvider;
} = {}): HudCommand {
  const filePath = options.configFile ?? configPath();
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const registry = new ModuleRegistry();
  const detector = options.detector ?? new CapabilityDetector();
  const makeProvider = (config: HudConfig): HudProvider => options.provider ?? new CodexSessionProvider({ providers: config.providers, runtime: config.runtime });
  const write = (text: string) => writeOutput(output, redactText(text));
  const writeError = (text: string) => writeOutput(errorOutput, redactText(text));
  const program = new HudCommand(filePath);
  const help = new Help();
  program.name("codex-hud").description("Codex HUD：按所选信息自动布局的终端面板")
    .version(version, "-V, --version", "查看版本")
    .helpOption("-h, --help", "查看帮助")
    .addHelpCommand("help [command]", "查看指定命令的帮助")
    .showSuggestionAfterError(false)
    .configureHelp({
      commandDescription: command => helpDescription(help.commandDescription(command)),
      subcommandDescription: command => helpDescription(help.subcommandDescription(command)),
      optionDescription: option => helpDescription(help.optionDescription(option)),
      argumentDescription: argument => helpDescription(help.argumentDescription(argument)),
      formatHelp: (command, helper) => new Help().formatHelp(command, helper)
        .replace(/^Usage: /gmu, t("用法："))
        .replace(/^Options:/gmu, t("选项："))
        .replace(/^Commands:/gmu, t("命令："))
        .replace(/\[options\]/gu, t("[选项]"))
        .replace(/\[command\]/gu, t("[命令]")),
    })
    .configureOutput({ writeOut: text => { output.write(redactText(text)); }, writeErr: text => { errorOutput.write(redactText(text)); }, outputError: (text, writeError) => writeError(localizedError(text)) })
    .exitOverride();

  const setup = async () => {
    if (!options.prompt && (!process.stdin.isTTY || !output.isTTY)) {
      throw new Error(t("配置需要交互终端，请在终端运行 codex-hud setup；查看真实快照可运行 codex-hud debug，查看演示可运行 codex-hud demo"));
    }
    const provider = makeProvider(program.getConfig() ?? createDefaultConfig());
    let capabilities;
    try { capabilities = detector.detectRollout(await provider.refresh(), registry); }
    finally { await provider.stop?.(); }
    return runSetup({ filePath, capabilities, prompt: options.prompt ?? terminalPrompter(), write, registry });
  };

  program.command("setup").description("选择显示模块，保存或重新配置 HUD").action(async () => { await setup(); });

  program.command("language").description("选择显示语言").action(async () => {
    const current = program.getConfig();
    const config = structuredClone(current ?? createDefaultConfig());
    if (!options.languagePrompt && (!process.stdin.isTTY || !output.isTTY)) {
      throw new Error(t("语言设置需要交互终端，请在终端运行 codex-hud language"));
    }
    const selected = await (options.languagePrompt ?? (language => promptLanguage(language, output)))(config.display.language);
    if (!isLanguage(selected)) throw new Error(t("无效的语言选项"));
    config.display.language = selected;
    const changed = !current || current.display.language !== selected;
    if (changed) await saveConfig(config, filePath);
    program.language = selected;
    await withLanguage(selected, () => write(changed
      ? t("语言已设置为 {0}，配置已保存：{1}。重启 HUD 后生效。\n", languageName(selected), filePath)
      : t("当前语言已是 {0}，配置未更改。\n", languageName(selected))));
  });

  program.command("start").description("启动实时 HUD，自动跟随真实 Codex 会话").action(async () => {
    const config = program.getConfig() ?? createDefaultConfig();
    await runHud(config, output, errorOutput, makeProvider(config));
  });

  program.command("config").description("查看当前配置").action(async () => {
    const current = program.getConfig();
    const config = current ?? createDefaultConfig();
    await write(t("当前语言：{0}；运行 codex-hud language 修改。\n", languageName(config.display.language)));
    await write(t("Codex HUD 配置\n\n{0}\n\n已启用：\n", current ? t("配置文件：{0}", filePath) : t("尚无配置文件；以下为默认模块。")));
    const enabled = registry.resolve(config.display.enabled, config.display.order);
    await write(enabled.length ? enabled.map(module => `✓ ${module.label}`).join("\n") + "\n" : t("（无）\n"));
    await write(t("\n已关闭：\n"));
    const disabled = registry.all().filter(module => !config.display.enabled.includes(module.id));
    await write(disabled.length ? disabled.map(module => `○ ${module.label}`).join("\n") + "\n" : t("（无）\n"));
    await write(t("\n运行 codex-hud setup 修改设置。\n"));
  });

  program.command("doctor").description("检查本地 Codex、rollout 数据与配置").action(async () => {
    await write(t("Codex HUD 环境检查\nHUD：{0}\nNode：{1}\n平台：{2}\n\n", version, process.version, process.platform));
    let configStatus: string;
    let renderConfig = createDefaultConfig();
    try {
      const current = program.getConfig();
      renderConfig = current ?? renderConfig;
      configStatus = current ? t("✓ 配置已读取并通过校验") : t("✗ 尚未创建配置，请运行 codex-hud setup");
    } catch (error) { configStatus = t("✗ 配置：{0}", diagnosticText(error instanceof Error ? error.message : t("读取失败"))); }
    const provider = makeProvider(renderConfig);
    try {
      let snapshot: CodexSessionSnapshot | undefined;
      try { snapshot = await provider.refresh(); }
      catch (error) { await write(t("✗ 会话来源：{0}\n", diagnosticText(error instanceof Error ? error.message : t("读取失败")))); }
      if (snapshot) {
        await write(formatRuntimeChecks(snapshot, output));
        await write(formatCapabilities(detector.detectRollout(snapshot, registry), registry));
      }
      if (provider.probeWatcher) {
        try { await write(formatWatcherProbe(await provider.probeWatcher())); }
        catch (error) { await write(t("✗ 文件监听检查：{0}\n", diagnosticText(error instanceof Error ? error.message : t("检测失败")))); }
      }
      await write(`\n${configStatus}\n`);
      await write(t("计划显示：{0}；由 HUD 配置决定，不改变 Codex 模式。\n", renderConfig.display.enabled.includes("plan") ? t("已启用") : t("已关闭（disabled）")));
      try {
        const renderer = new HudRenderer();
        renderer.render(snapshot?.state ?? {}, terminalSize(output), renderConfig);
        if (renderer.getIssues().length) throw new Error(renderer.getIssues().join("；"));
        await write(snapshot ? t("✓ Renderer：已完成当前快照的布局与渲染检查\n") : t("⚠ Renderer：空状态渲染通过，真实快照未取得\n"));
      } catch (error) {
        await write(`✗ Renderer：${diagnosticText(error instanceof Error ? error.message : t("渲染失败"))}\n`);
      }
    } finally { await provider.stop?.(); }
  });

  for (const name of ["debug", "demo"]) {
    const command = program.command(name).description(name === "debug" ? "读取真实会话快照，输出脱敏诊断与 HUD" : "显示本地 HUD 演示")
      .option("--width <columns>", "模拟终端列数", dimension)
      .option("--height <rows>", "模拟终端行数", dimension);
    if (name === "debug") command.option("--verbose", "显示经过脱敏的计划、MCP、技能清单及路径摘要");
    command.action(async (dimensions: { width?: number; height?: number; verbose?: boolean }) => {
      const config = program.getConfig() ?? createDefaultConfig();
      const provider = name === "debug" ? makeProvider(config) : undefined;
      try {
        const actual = terminalSize(output);
        const terminal = { width: dimensions.width ?? actual.width, height: dimensions.height ?? actual.height };
        const snapshot = await provider?.refresh();
        const renderer = new HudRenderer(), renderStarted = performance.now();
        const rendered = renderer.render(snapshot ? debugState(snapshot.state) : mockState(), terminal, config);
        provider?.telemetry?.rendered(renderStarted);
        if (snapshot) {
          snapshot.hudDiagnostics = provider?.getHudDiagnostics?.() ?? snapshot.hudDiagnostics;
          for (const message of renderer.getIssues()) snapshot.diagnostics.push({ code: "renderer", severity: "error", message });
          await writeError(formatDebug(snapshot, { config, terminal, isTTY: output.isTTY === true, verbose: dimensions.verbose }));
        } else await writeError(t("演示数据：终端 {0} × {1}；仅用于检查布局。\n", terminal.width, terminal.height));
        if (rendered) await write(`${rendered}\n`);
        else if (snapshot) await writeError(config.display.enabled.length ? t("当前没有可显示的真实数据。\n") : t("未启用显示模块，可运行 codex-hud setup 修改。\n"));
        if (snapshot && ((snapshot.read.status === "error" && !hasUsableAppServer(snapshot))
          || snapshot.diagnostics.some(item => item.severity === "error" && !(hasUsableAppServer(snapshot) && item.code === "rollout-read")))) {
          throw new Error(t("真实数据包含读取或解析错误，请查看上方诊断"));
        }
      } finally { await provider?.stop?.(); }
    });
  }

  program.command("version").description("查看版本").action(() => write(`${version}\n`));
  program.action(async () => {
    const config = program.getConfig() ?? await setup();
    await runHud(config, output, errorOutput, makeProvider(config));
  });
  return program;
}
