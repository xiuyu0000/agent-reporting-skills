import { readFile } from "node:fs/promises";
import process from "node:process";
import { runConsumeCommand } from "./consume.js";
import { runInitCommand } from "./init.js";
import { runRecordUsageCommand } from "./record-usage.js";
import { runRenderCommand } from "./render.js";
import { runValidateCommand } from "./validate.js";

const HELP_TEXT = [
  "Usage: node <skill>/scripts/review-delivery.mjs <command> [...options]",
  "",
  "Commands:",
  "  init",
  "  render",
  "  validate",
  "  consume",
  "  record-usage",
  "",
  "See ../SKILL.md and ../references/review-protocols.md for command options and workflow rules.",
  "",
].join("\n");

const COMMAND_ERROR = Object.freeze({
  code: "ARGUMENT_INVALID",
  path: "/arguments/command",
  blockId: null,
  message: "The CLI command is missing or unsupported.",
  hint: "Use --help and choose init, render, validate, consume, or record-usage.",
} as const);

const APPROVAL_TEMPLATE_ERROR = Object.freeze({
  code: "INTERNAL_ERROR",
  path: "/runtime/approvalTemplateBytes",
  blockId: null,
  message: "The installed approval template could not be loaded.",
  hint: "Reinstall the complete v0.2 Skill directory and retry.",
} as const);

const UNEXPECTED_ERROR = Object.freeze({
  code: "INTERNAL_ERROR",
  path: "",
  blockId: null,
  message: "The CLI stopped because of an unexpected internal error.",
  hint: "Retry from verified inputs; if the failure repeats, reinstall or inspect the local Skill.",
} as const);

type CliAssemblyError = typeof COMMAND_ERROR | typeof APPROVAL_TEMPLATE_ERROR | typeof UNEXPECTED_ERROR;

interface CliFailure {
  status: "failed";
  phase: "cli";
  mutated: false;
  recoveryRequired: false;
  errors: readonly [CliAssemblyError];
}

export interface CliExecution {
  exitCode: number;
  stdout: string;
  stderr: "";
}

export interface CliMainRuntime {
  loadApprovalTemplateBytes?: () => Uint8Array | Promise<Uint8Array>;
}

function cliFailure(error: CliAssemblyError, exitCode: 2 | 70): CliExecution {
  const result: CliFailure = {
    status: "failed",
    phase: "cli",
    mutated: false,
    recoveryRequired: false,
    errors: [error],
  };
  return { exitCode, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
}

function jsonExecution(exitCode: number, result: unknown): CliExecution {
  return { exitCode, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
}

function defaultLoadApprovalTemplateBytes(): Promise<Uint8Array> {
  return readFile(new URL("../assets/review-workbench.template.html", import.meta.url));
}

async function loadApprovalTemplateBytes(
  runtime: CliMainRuntime,
): Promise<Uint8Array | undefined> {
  const loader = runtime.loadApprovalTemplateBytes ?? defaultLoadApprovalTemplateBytes;
  try {
    const bytes = await loader();
    return bytes instanceof Uint8Array ? Uint8Array.from(bytes) : undefined;
  } catch {
    return undefined;
  }
}

export async function executeCli(
  argv: readonly string[],
  runtime: CliMainRuntime = {},
): Promise<CliExecution> {
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      return { exitCode: 0, stdout: HELP_TEXT, stderr: "" };
    }
    const [command, ...commandArguments] = argv;
    if (
      command !== "init"
      && command !== "render"
      && command !== "validate"
      && command !== "consume"
      && command !== "record-usage"
    ) {
      return cliFailure(COMMAND_ERROR, 2);
    }

    if (command === "init") {
      const outcome = await runInitCommand(commandArguments);
      return jsonExecution(outcome.exitCode, outcome.result);
    }
    if (command === "record-usage") {
      return jsonExecution(0, await runRecordUsageCommand(commandArguments));
    }
    if (command === "render") {
      const templateBytes = await loadApprovalTemplateBytes(runtime);
      if (templateBytes === undefined) return cliFailure(APPROVAL_TEMPLATE_ERROR, 70);
      const outcome = await runRenderCommand(commandArguments, { approvalTemplateBytes: templateBytes });
      return jsonExecution(outcome.exitCode, outcome.result);
    }
    if (command === "validate") {
      const mode = commandArguments[0];
      if (mode === "delivery" || mode === "batch") {
        const templateBytes = await loadApprovalTemplateBytes(runtime);
        if (templateBytes === undefined) return cliFailure(APPROVAL_TEMPLATE_ERROR, 70);
        const outcome = await runValidateCommand(commandArguments, { approvalTemplateBytes: templateBytes });
        return jsonExecution(outcome.exitCode, outcome.result);
      }
      const outcome = await runValidateCommand(commandArguments);
      return jsonExecution(outcome.exitCode, outcome.result);
    }

    const loader = runtime.loadApprovalTemplateBytes ?? defaultLoadApprovalTemplateBytes;
    try {
      const outcome = await runConsumeCommand(commandArguments, {
        loadApprovalTemplateBytes: loader,
      });
      return jsonExecution(outcome.exitCode, outcome.result);
    } catch {
      return cliFailure(APPROVAL_TEMPLATE_ERROR, 70);
    }
  } catch {
    return cliFailure(UNEXPECTED_ERROR, 70);
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  runtime: CliMainRuntime = {},
): Promise<void> {
  const execution = await executeCli(argv, runtime);
  process.stdout.write(execution.stdout);
  process.exitCode = execution.exitCode;
}
