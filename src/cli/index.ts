#!/usr/bin/env node
import { t } from "../i18n/Messages.js";
import { CommanderError } from "commander";
import { createProgram } from "./Program.js";
import { formatFailure } from "./Diagnostics.js";
import { withLanguage } from "../i18n/Language.js";

const program = createProgram();
const reported = new Set<unknown>();
function reportFailure(error: unknown): void {
  const key = error instanceof Error && error.cause ? error.cause : error;
  if (reported.has(key)) return;
  reported.add(key);
  process.stderr.write(withLanguage(program.language, () => formatFailure(error)));
  process.exitCode = 1;
}

process.stdout.on("error", reportFailure);
process.stderr.on("error", error => { reported.add(error); process.exitCode = 1; });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    if (!reported.size) process.exitCode = error.exitCode;
  } else if (error instanceof Error && ["ExitPromptError", "AbortPromptError"].includes(error.name)) {
    process.stderr.write(withLanguage(program.language, () => t("已取消配置，文件未更改。\n")));
    process.exitCode = 130;
  } else {
    reportFailure(error);
  }
}
