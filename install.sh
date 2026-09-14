#!/usr/bin/env bash
set -euo pipefail

# 将入口放在完整函数之后，避免 curl 管道只收到部分脚本时提前开始安装。
install_codex_hud() {
  if ! command -v node >/dev/null 2>&1; then
    printf '安装失败：需要 Node.js 20.19+（20.x）或 22.12+ 及 npm，请先安装 Node.js。\n' >&2
    return 1
  fi
  local hud_node_version
  if ! hud_node_version="$(node -p 'process.versions.node')"; then
    printf '安装失败：无法读取 Node.js 版本。\n' >&2
    return 1
  fi
  if [[ ! "$hud_node_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] ||
    ! (( (BASH_REMATCH[1] == 20 && BASH_REMATCH[2] >= 19) ||
         (BASH_REMATCH[1] == 22 && BASH_REMATCH[2] >= 12) || BASH_REMATCH[1] > 22 )); then
    printf '安装失败：源码构建需要 Node.js 20.19+（20.x）或 22.12+，当前版本为 %s。\n' "$hud_node_version" >&2
    return 1
  fi

  # Node 已是运行依赖；使用它处理跨平台路径、原子重命名和失败回滚。
  exec node --input-type=commonjs - "$@" <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const sourceUrl = "https://github.com/steffonchen/codex-hud/archive/refs/heads/main.tar.gz";
const ownerMarker = "codex-hud/install.sh:v1\n";
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const exists = value => fs.existsSync(value) || fs.lstatSync(value, { throwIfNoEntry: false }) !== undefined;
let interruptedBy, cancelCurrentCommand;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interruptedBy ??= signal;
    cancelCurrentCommand?.(signal);
  });
}

function run(command, args, options = {}) {
  if (interruptedBy) throw new Error(`收到 ${interruptedBy}，安装已中断。`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      // 每条命令独立成组，中断时仅终止本次安装启动的命令及其后代。
      detached: true,
    });
    const stdout = [], stderr = [];
    let bytes = 0, failure, killTimer, stopping = false;
    const signalGroup = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) {
        // ESRCH 表示进程组已经退出，无需再次终止。
        if (error.code !== "ESRCH") failure ??= new Error(`无法终止 ${command}：${error.message}`);
      }
    };
    const stop = signal => {
      stopping = true;
      signalGroup(signal);
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 3000);
    };
    cancelCurrentCommand = stop;
    const collect = chunks => chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        if (!failure) {
          failure = new Error(`${command} 的输出超过 16 MiB，已停止执行。`);
          stop("SIGTERM");
        }
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("error", error => { failure ??= new Error(`无法执行 ${command}：${error.message}`); });
    child.on("close", (code, signal) => {
      // npm 可能先于构建子进程退出；不要把仍存活的后代留在临时目录中。
      if (stopping) signalGroup("SIGKILL");
      clearTimeout(killTimer);
      cancelCurrentCommand = undefined;
      const messages = [];
      if (interruptedBy) messages.push(`收到 ${interruptedBy}，安装已中断。`);
      if (failure) messages.push(failure.message);
      if (!messages.length && code !== 0) messages.push(`${command} 执行失败（${signal || `退出码 ${code}`}）。`);
      if (messages.length) {
        if (stderr.length) process.stderr.write(Buffer.concat(stderr));
        reject(new Error(messages.join("\n")));
      } else resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function parseOptions() {
  const options = { prefix: path.join(os.homedir(), ".local"), archive: undefined };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log("用法：bash install.sh [--prefix 安装前缀] [--archive 本地源码.tar.gz]");
      console.log("默认安装到 ~/.local/share/codex-hud，命令位于 ~/.local/bin/codex-hud。");
      console.log("--archive 用于安装或验证本地源码归档；省略时下载公开仓库的 main 分支。");
      return null;
    }
    if (argument !== "--prefix" && argument !== "--archive") throw new Error(`未知选项：${argument}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 需要一个路径。`);
    options[argument === "--prefix" ? "prefix" : "archive"] = path.resolve(value);
  }
  options.prefix = path.resolve(options.prefix);
  if (options.prefix === path.parse(options.prefix).root) throw new Error("安装前缀不能是文件系统根目录。");
  return options;
}

function checkDestination(installDir, binPath) {
  if (exists(installDir)) {
    const info = fs.lstatSync(installDir);
    const marker = path.join(installDir, ".codex-hud-install");
    if (!info.isDirectory() || !fs.lstatSync(marker, { throwIfNoEntry: false })?.isFile()
      || fs.readFileSync(marker, "utf8") !== ownerMarker) {
      throw new Error(`安装目录不是本安装器管理的目录，请先自行处理：${installDir}`);
    }
  }
  if (exists(binPath)) {
    if (!fs.lstatSync(binPath).isSymbolicLink() || fs.readlinkSync(binPath) !== path.join(installDir, "codex-hud")) {
      throw new Error(`命令路径已被其他文件占用，请先自行处理：${binPath}`);
    }
  }
}

async function extractSource(archive, destination) {
  const names = (await run("tar", ["-tzf", archive], { capture: true })).trimEnd().split("\n");
  let root;
  for (const name of names) {
    const parts = name.split("/");
    if (!name || path.posix.isAbsolute(name) || parts.includes("..") || parts[0] === "." || name.includes("\r")) {
      throw new Error("源码归档包含不安全的路径。");
    }
    root ??= parts[0];
    if (parts[0] !== root) throw new Error("源码归档必须只有一个顶层目录。");
  }
  // GitHub 源码归档只需普通文件和目录，拒绝链接，避免解压时写入归档之外。
  const details = (await run("tar", ["-tvzf", archive], { capture: true })).trimEnd().split("\n");
  if (details.some(line => !/^[d-]/u.test(line))) throw new Error("源码归档不能包含符号链接、硬链接或特殊文件。");
  fs.mkdirSync(destination);
  await run("tar", ["-xzf", archive, "--strip-components=1", "--no-same-owner", "-C", destination]);
  for (const required of ["package.json", "package-lock.json", "tsconfig.json"]) {
    if (!fs.statSync(path.join(destination, required), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`源码归档缺少 ${required}。`);
    }
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(destination, "package.json"), "utf8"));
  if (metadata.name !== "codex-hud" || typeof metadata.version !== "string" || !metadata.version.trim()) {
    throw new Error("源码归档不是有效的 codex-hud 项目。");
  }
  return metadata.version;
}

async function checkVersion(command, args, expected) {
  const actual = (await run(command, args, { capture: true })).trim();
  if (actual !== expected) throw new Error(`启动检查失败：期望版本 ${expected}，实际输出为 ${JSON.stringify(actual)}。`);
}

function findCommand() {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.resolve(directory || ".", "codex-hud");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // PATH 中不存在或不可执行的文件不参与命令选择。
    }
  }
  return undefined;
}

async function install(options) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("安装脚本支持 macOS 和 Linux；其他平台请参考源码安装说明。");
  }
  await run("npm", ["--version"], { capture: true });
  await run("tar", ["--version"], { capture: true });
  if (!options.archive) await run("curl", ["--version"], { capture: true });
  else if (!fs.statSync(options.archive, { throwIfNoEntry: false })?.isFile()) throw new Error("本地源码归档不存在或不是文件。");

  const shareDir = path.join(options.prefix, "share");
  const installDir = path.join(shareDir, "codex-hud");
  const binDir = path.join(options.prefix, "bin");
  const binPath = path.join(binDir, "codex-hud");
  const lockDir = path.join(shareDir, ".codex-hud-install.lock");
  checkDestination(installDir, binPath);
  fs.mkdirSync(shareDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  try { fs.mkdirSync(lockDir, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`存在安装锁。请确认没有安装任务运行，再检查并清理遗留锁目录：${lockDir}`);
    throw error;
  }

  let workDir, commandDir, previousDir, sourceDir, version;
  let previousMoved = false, newInstalled = false, binChanged = false;
  let keepBackup = false;
  const hadBin = exists(binPath);
  const errors = [];
  try {
    workDir = fs.mkdtempSync(path.join(shareDir, ".codex-hud-stage-"));
    previousDir = path.join(workDir, "previous");
    sourceDir = path.join(workDir, "source");
    const archive = path.join(workDir, "source.tar.gz");
    if (options.archive) fs.copyFileSync(options.archive, archive);
    else {
      console.log("正在下载 Codex HUD 源码…");
      await run("curl", ["--fail", "--show-error", "--silent", "--location", "--proto", "=https", "--proto-redir", "=https",
        "--connect-timeout", "15", "--max-time", "120", "--retry", "2", "--output", archive, sourceUrl]);
    }
    version = await extractSource(archive, sourceDir);
    console.log("正在安装依赖并构建 Codex HUD…");
    await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], { cwd: sourceDir });
    await run("npm", ["run", "build"], { cwd: sourceDir });
    await run("npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"], { cwd: sourceDir });
    await checkVersion(process.execPath, [path.join(sourceDir, "dist/cli/index.js"), "--version"], version);
    fs.writeFileSync(path.join(sourceDir, ".codex-hud-install"), ownerMarker);
    const launcher = "#!/bin/sh\nexec node " + shellQuote(path.join(installDir, "dist/cli/index.js")) + ' "$@"\n';
    fs.writeFileSync(path.join(sourceDir, "codex-hud"), launcher, { mode: 0o755 });
    // 临时命令与最终入口处于同一文件系统，bin 指向其他磁盘时也可原子替换。
    commandDir = fs.mkdtempSync(path.join(binDir, ".codex-hud-stage-"));
    const nextLink = path.join(commandDir, "next-command");
    fs.symlinkSync(path.join(installDir, "codex-hud"), nextLink);

    // 旧版本在下载、构建和预检查期间保持可用，仅在最后阶段替换。
    checkDestination(installDir, binPath);
    if (exists(installDir)) {
      fs.renameSync(installDir, previousDir);
      previousMoved = true;
    }
    fs.renameSync(sourceDir, installDir);
    newInstalled = true;
    fs.renameSync(nextLink, binPath);
    binChanged = true;
    await checkVersion(binPath, ["--version"], version);
  } catch (error) {
    errors.push(error.message);
    try {
      if (binChanged && !hadBin) fs.unlinkSync(binPath);
      if (newInstalled) fs.rmSync(installDir, { recursive: true });
      if (previousMoved) fs.renameSync(previousDir, installDir);
    } catch (rollbackError) {
      keepBackup = true;
      errors.push(`恢复旧安装失败：${rollbackError.message}。请保留并检查 ${workDir}`);
    }
  } finally {
    try { if (commandDir) fs.rmSync(commandDir, { recursive: true, force: true }); }
    catch (error) { errors.push(`清理临时命令目录失败：${error.message}`); }
    try { if (workDir && !keepBackup) fs.rmSync(workDir, { recursive: true, force: true }); }
    catch (error) { errors.push(`清理临时目录失败：${error.message}`); }
    try { fs.rmdirSync(lockDir); }
    catch (error) { errors.push(`清理安装锁失败：${error.message}`); }
  }
  if (errors.length) throw new Error(errors.join("\n"));

  console.log(`Codex HUD ${version} 安装完成。`);
  console.log(`安装目录：${installDir}`);
  console.log(`命令路径：${binPath}`);
  const active = findCommand();
  if (!active || fs.realpathSync(active) !== fs.realpathSync(binPath)) {
    console.log(active ? `当前 PATH 优先找到另一份命令：${active}` : "安装目录尚未加入 PATH。");
    console.log(`在 bash/zsh 中执行以下命令；如需长期生效，可添加到对应的 shell 配置文件：`);
    console.log(`export PATH=${shellQuote(binDir)}:"$PATH"`);
  }
  console.log("在需要观察的项目目录中运行 codex-hud；首次运行会进入配置向导。");
  console.log("再次运行安装命令即可更新。已有 ~/.codex-hud/config.toml 配置会保留。");
}

async function main() {
  const options = parseOptions();
  if (options) await install(options);
}

main().catch(error => {
  console.error(`安装失败：${error.message}`);
  process.exitCode = interruptedBy === "SIGINT" ? 130 : interruptedBy === "SIGTERM" ? 143 : 1;
});
NODE
}

install_codex_hud "$@"
