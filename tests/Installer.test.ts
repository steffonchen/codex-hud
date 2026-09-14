import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const installer = fileURLToPath(new URL("../install.sh", import.meta.url));
const supported = process.platform === "darwin" || process.platform === "linux";
let directory: string;
let prefix: string;
let project: string;
let configuration: string;
let archiveSequence = 0;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "codex-hud-installer-test-")));
  prefix = path.join(directory, "installed");
  project = path.join(directory, "observed-project");
  configuration = path.join(directory, "existing-config.toml");
  await mkdir(project);
  await writeFile(configuration, "version = 1\n# 保留用户配置\n");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_config_cache: path.join(directory, "npm-cache"),
    INSTALLER_TEST_CONFIG: configuration,
    ...extra,
  };
}

async function sourceArchive(version: string, options: { brokenBuild?: boolean; link?: boolean; pauseBuild?: boolean } = {}) {
  const container = path.join(directory, `archive-${archiveSequence++}`);
  const source = path.join(container, "codex-hud-source");
  await mkdir(source, { recursive: true });
  const metadata = {
    name: "codex-hud", version, private: true, type: "module",
    scripts: { build: "node build.mjs" },
  };
  await writeFile(path.join(source, "package.json"), JSON.stringify(metadata));
  await writeFile(path.join(source, "package-lock.json"), JSON.stringify({
    name: metadata.name, version, lockfileVersion: 3, requires: true,
    packages: { "": { name: metadata.name, version } },
  }));
  await writeFile(path.join(source, "tsconfig.json"), "{}");
  // 模拟拒绝正常退出的后代进程，验证安装器会终止整组进程再清理目录。
  const pause = [
    'process.on("SIGINT", () => {});',
    'process.on("SIGTERM", () => {});',
    'fs.writeFileSync(process.env.INSTALLER_TEST_READY, String(process.pid));',
    'await new Promise(() => { setInterval(() => {}, 1000); });',
  ].join("\n");
  const entry = [
    'import fs from "node:fs";',
    'if (process.env.INSTALLER_TEST_FAIL_PATH === process.argv[1]) { console.error("测试启动失败"); process.exit(9); }',
    `if (process.env.INSTALLER_TEST_PAUSE_PATH === process.argv[1]) {\n${pause}\n}`,
    `if (process.argv[2] === "--version") console.log(${JSON.stringify(version)});`,
    'else if (process.argv[2] === "setup") fs.writeFileSync(process.env.INSTALLER_TEST_CONFIG, "已覆盖");',
    'else console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));',
  ].join("\n");
  const build = options.brokenBuild ? 'console.error("测试构建失败"); process.exit(7);' : [
    'import fs from "node:fs";',
    options.pauseBuild ? pause : "",
    'fs.mkdirSync("dist/cli", { recursive: true });',
    `fs.writeFileSync("dist/cli/index.js", ${JSON.stringify(entry)});`,
  ].join("\n");
  await writeFile(path.join(source, "build.mjs"), build);
  if (options.link) await symlink(project, path.join(source, "outside"));
  const archive = path.join(container, "source.tar.gz");
  await execute("tar", ["-czf", archive, "-C", container, "codex-hud-source"]);
  return archive;
}

function install(archive?: string, extra: NodeJS.ProcessEnv = {}) {
  return execute("/bin/bash", [installer, "--prefix", prefix, ...(archive ? ["--archive", archive] : [])], {
    cwd: project, env: environment(extra), timeout: 30_000, maxBuffer: 1024 * 1024,
  });
}

function installedCommand(args: string[]) {
  return execute(path.join(prefix, "bin/codex-hud"), args, { cwd: project, env: environment(), timeout: 10_000 });
}

async function expectNoStagingFiles() {
  for (const location of ["share", "bin"]) {
    const entries = await readdir(path.join(prefix, location));
    expect(entries.filter(entry => entry.startsWith(".codex-hud-"))).toEqual([]);
  }
}

describe.skipIf(!supported)("curl 安装器", () => {
  it("安装到含特殊字符的路径，保留工作目录、参数和已有配置，并可重复更新", async () => {
    prefix = path.join(directory, "安装 'quoted' $(touch injected) `touch quoted`");
    const initial = await install(await sourceArchive("0.1.0"));
    expect(initial.stdout).toContain("Codex HUD 0.1.0 安装完成");
    expect((await lstat(path.join(prefix, "bin/codex-hud"))).isSymbolicLink()).toBe(true);
    const args = ["demo", "含 空格", "$(touch argument-injected)"];
    expect(JSON.parse((await installedCommand(args)).stdout)).toEqual({ cwd: project, args });
    expect(await readdir(project)).toEqual([]);
    expect(await readFile(configuration, "utf8")).toBe("version = 1\n# 保留用户配置\n");

    const updated = await install(await sourceArchive("0.2.0"));
    expect(updated.stdout).toContain("Codex HUD 0.2.0 安装完成");
    expect((await installedCommand(["--version"])).stdout.trim()).toBe("0.2.0");
    expect(await readFile(configuration, "utf8")).toBe("version = 1\n# 保留用户配置\n");
    await expectNoStagingFiles();
  }, 30_000);

  it("命令目录是目录链接时仍能安装，并清理命令旁的临时文件", async () => {
    const commands = path.join(directory, "commands");
    await mkdir(commands);
    await mkdir(prefix);
    await symlink(commands, path.join(prefix, "bin"));
    await install(await sourceArchive("0.1.0"));
    expect((await installedCommand(["--version"])).stdout.trim()).toBe("0.1.0");
    expect(await readdir(commands)).toEqual(["codex-hud"]);
    await expectNoStagingFiles();
  });

  it("构建失败时保留旧安装并返回失败", async () => {
    await install(await sourceArchive("0.1.0"));
    const archive = await sourceArchive("0.2.0", { brokenBuild: true });
    await expect(install(archive)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("测试构建失败") });
    expect((await installedCommand(["--version"])).stdout.trim()).toBe("0.1.0");
    await expectNoStagingFiles();
  }, 30_000);

  it.each([
    { stage: "构建", signal: "SIGINT", code: 130, upgrade: true },
    { stage: "启动检查", signal: "SIGTERM", code: 143, upgrade: true },
    { stage: "构建", signal: "SIGTERM", code: 143, upgrade: false },
  ] as const)("$stage 中收到 $signal 后回滚并终止后代进程（更新：$upgrade）", async ({ stage, signal, code, upgrade }) => {
    if (upgrade) await install(await sourceArchive("0.1.0"));
    const ready = path.join(directory, "child-ready");
    const archive = await sourceArchive("0.2.0", { pauseBuild: stage === "构建" });
    const pending = install(archive, {
      INSTALLER_TEST_READY: ready,
      ...(stage === "启动检查" ? { INSTALLER_TEST_PAUSE_PATH: path.join(prefix, "share/codex-hud/dist/cli/index.js") } : {}),
    });
    const completion = pending.then(output => ({ output, error: undefined }), error => ({ output: undefined, error }));
    try {
      await expect.poll(() => readFile(ready, "utf8"), { timeout: 10_000 }).toMatch(/^\d+$/u);
      expect(pending.child.kill(signal)).toBe(true);
      expect((await completion).error).toMatchObject({ code, stderr: expect.stringContaining(`收到 ${signal}`) });
      const childPid = Number(await readFile(ready, "utf8"));
      await expect.poll(() => {
        try { process.kill(childPid, 0); return true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      }, { timeout: 5_000 }).toBe(false);
      if (upgrade) expect((await installedCommand(["--version"])).stdout.trim()).toBe("0.1.0");
      else {
        await expect(lstat(path.join(prefix, "bin/codex-hud"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(path.join(prefix, "share/codex-hud"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expectNoStagingFiles();
    } finally {
      if (pending.child.exitCode === null && pending.child.signalCode === null) pending.child.kill("SIGTERM");
      await completion;
    }
  }, 30_000);

  it("公开源码下载失败时保留旧版本并清理临时目录", async () => {
    await install(await sourceArchive("0.1.0"));
    const tools = path.join(directory, "download-tools");
    await mkdir(tools);
    const curl = path.join(tools, "curl");
    await writeFile(curl, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo curl-test; exit 0; fi\necho "测试下载失败" >&2\nexit 22\n');
    await chmod(curl, 0o755);
    await expect(install(undefined, { PATH: `${tools}${path.delimiter}${process.env.PATH}` }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("测试下载失败") });
    expect((await installedCommand(["--version"])).stdout.trim()).toBe("0.1.0");
    await expectNoStagingFiles();
  }, 30_000);

  it("替换后启动检查失败时恢复旧程序及命令入口", async () => {
    await install(await sourceArchive("0.1.0"));
    await expect(install(await sourceArchive("0.2.0"), {
      INSTALLER_TEST_FAIL_PATH: path.join(prefix, "share/codex-hud/dist/cli/index.js"),
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("测试启动失败") });
    expect((await installedCommand(["--version"])).stdout.trim()).toBe("0.1.0");
    await expectNoStagingFiles();
  }, 30_000);

  it("首次安装的启动检查失败时撤销新命令及程序", async () => {
    await expect(install(await sourceArchive("0.1.0"), {
      INSTALLER_TEST_FAIL_PATH: path.join(prefix, "share/codex-hud/dist/cli/index.js"),
    })).rejects.toMatchObject({ code: 1 });
    await expect(lstat(path.join(prefix, "bin/codex-hud"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(prefix, "share/codex-hud"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoStagingFiles();
  }, 30_000);

  it.each(["file", "symlink"])("拒绝覆盖其他安装的命令入口：%s", async kind => {
    const bin = path.join(prefix, "bin");
    const other = path.join(directory, "other-program");
    await mkdir(bin, { recursive: true });
    await writeFile(other, "原有程序");
    if (kind === "file") await writeFile(path.join(bin, "codex-hud"), "原有命令");
    else await symlink(other, path.join(bin, "codex-hud"));
    await expect(install(await sourceArchive("0.1.0"))).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("命令路径已被其他文件占用"),
    });
    expect(await readFile(other, "utf8")).toBe("原有程序");
    expect(await readFile(path.join(bin, "codex-hud"), "utf8")).toBe(kind === "file" ? "原有命令" : "原有程序");
  });

  it("拒绝覆盖未经安装器管理的同名目录", async () => {
    const target = path.join(prefix, "share/codex-hud");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "keep.txt"), "保留");
    await expect(install(await sourceArchive("0.1.0"))).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("不是本安装器管理的目录"),
    });
    expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("保留");
  });

  it.each(["missing", "18.20.8", "20.18.3", "21.7.3", "22.11.0", "invalid"])("在写入安装目录前拒绝不满足要求的 Node：%s", async version => {
    const tools = path.join(directory, "runtime-tools");
    await mkdir(tools);
    if (version !== "missing") {
      await writeFile(path.join(tools, "node"), `#!/bin/sh\nprintf '${version}\\n'\n`);
      await chmod(path.join(tools, "node"), 0o755);
    }
    await expect(install(undefined, { PATH: tools })).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("需要 Node.js 20"),
    });
    await expect(lstat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("拒绝包含链接的源码归档", async () => {
    await expect(install(await sourceArchive("0.1.0", { link: true }))).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("不能包含符号链接"),
    });
    expect(await readdir(project)).toEqual([]);
    await expectNoStagingFiles();
  });

  it("已有安装锁时不抢占或删除该锁", async () => {
    const lock = path.join(prefix, "share/.codex-hud-install.lock");
    await mkdir(lock, { recursive: true });
    await expect(install(await sourceArchive("0.1.0"))).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining("存在安装锁"),
    });
    expect((await lstat(lock)).isDirectory()).toBe(true);
    await expect(lstat(path.join(prefix, "share/codex-hud"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("未知参数和缺失参数返回失败，帮助不安装文件", async () => {
    for (const args of [["--unknown"], ["--prefix"]]) {
      await expect(execute("/bin/bash", [installer, ...args], { env: environment() })).rejects.toMatchObject({ code: 1 });
    }
    const help = await execute("/bin/bash", [installer, "--help"], { env: environment() });
    expect(help.stdout).toContain("用法：");
    await expect(lstat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
