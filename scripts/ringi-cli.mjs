// The ringi command: init, doctor and run. `ringi run` is the runner of
// scripts/agent-review-loop.mjs with two differences: the profile comes from
// ringi.config.mjs at the root of the Git repository of the current
// directory (loadProjectProfile, fingerprinted; it runs only when committed),
// and that root is the repository the run works on. Options go to the same parser
// (parseAgentArguments); the loop, the report, the events and the exit
// codes are the same. scripts/agent-review-loop.mjs itself is unchanged.
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentWorkflowError,
  createProcessRunner,
  loadProjectProfile,
  redactSensitive,
  resolveReviewProfile,
  runAgentReviewLoop,
} from './agent-review-loop-lib.mjs';
import {
  createTerminalDashboard,
  formatErrorDiagnostic,
  parseAgentArguments,
  resolveAgentRoles,
  TASK_MODE_USAGE,
} from './agent-review-dashboard.mjs';
import {
  assertProfileCommitted,
  findRepositoryRoot,
  formatDoctorTable,
  runDoctor,
} from './ringi-doctor.mjs';
import { runInit } from './ringi-init.mjs';

const RUNNER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const HELP = `Usage: ringi <command> [options]

Commands:
  init     Create ringi.config.mjs and tasks/example-task.md in the repository root
  doctor   Check the repository and this machine before a run (read-only)
  run      Run the writer, the gates and the independent review on a task

Options:
  -h, --help     Show this help (or the help of a command)
  --version      Show the version

Run \`ringi <command> --help\` for the options of a command.
`;

export const COMMAND_HELP = {
  init: `Usage: ringi init [--dry-run]

Creates ringi.config.mjs (gates inferred from the scripts check, lint and test
of package.json, plus git diff --check) and tasks/example-task.md in the root
of the current Git repository. Existing files are never overwritten;
AGENTS.md and CLAUDE.md are never created. No Git command that changes state
is run: commit ringi.config.mjs before ringi run.

Options:
  --dry-run   Print what would be created; write nothing
  -h, --help  Show this help
`,
  doctor: `Usage: ringi doctor [--json]

Checks Node.js, Git, the branch, staged changes, package.json and the pnpm
Corepack cache, AGENTS.md and CLAUDE.md, ringi.config.mjs and its providers,
and the agent CLIs (their --version only), with the runner's own preflight
functions. Read-only; no model calls, no network.

Options:
  --json      Print the result as JSON
  -h, --help  Show this help

Exit code: 0 when no check fails, 1 when a check fails, 2 for invalid options.
`,
  run: `Usage: ringi run <path/to/task.md> [options]

Runs the task on the Git repository of the current directory with the profile
from its ringi.config.mjs. The task path is relative to the repository root.
ringi.config.mjs and the modules it imports must be committed and match HEAD;
otherwise the run stops with PROFILE_UNCOMMITTED before any agent starts.

Options:
  --dry-run                     Run the preflight and print the plan; start no agent
  --task-mode implementation|analysis
  --review-profile <name>       A review profile of the profile's reviewer
  --implementer-model <id>      The implementer's model
  --implementer-effort <effort> The implementer's effort (profile allowlist)
  --verbose                     Show agent and gate output
  --no-animation                Plain, appended output
  --json                        Print the final report as JSON on stdout
  -h, --help                    Show this help

Exit code: 0 for a completed run, 1 for a stopped run, 2 for invalid arguments
or an error outside the runner.
`,
};

const write = (stream, text) => stream.write(text.endsWith('\n') ? text : `${text}\n`);

function usageError(message, help) {
  write(process.stderr, `ringi: ${message}\n\n${help}`);
  return 2;
}

async function version() {
  const packageJson = JSON.parse(
    await readFile(join(RUNNER_ROOT, 'package.json'), 'utf8'),
  );
  return packageJson.version;
}

const isHelp = (argument) => argument === '--help' || argument === '-h';

// findRepositoryRoot refused GIT_DIR or GIT_WORK_TREE.
const gitLocationError = (error) =>
  error instanceof AgentWorkflowError && error.code === 'INVALID_CONFIGURATION';

export async function main(argv) {
  const [command, ...args] = argv;
  if (command === undefined) return usageError('missing command.', HELP);
  if (isHelp(command)) {
    write(process.stdout, HELP);
    return 0;
  }
  if (command === '--version') {
    write(process.stdout, `ringi (Ringi Gate) ${await version()}`);
    return 0;
  }
  if (command.startsWith('-'))
    return usageError(`unknown option ${JSON.stringify(command)}.`, HELP);
  if (!Object.hasOwn(COMMAND_HELP, command))
    return usageError(`unknown command ${JSON.stringify(command)}.`, HELP);
  if (args.some(isHelp)) {
    write(process.stdout, COMMAND_HELP[command]);
    return 0;
  }
  if (command === 'init') return initCommand(args);
  if (command === 'doctor') return doctorCommand(args);
  return runCommand(args);
}

async function initCommand(args) {
  const unknown = args.find((argument) => argument !== '--dry-run');
  if (unknown !== undefined)
    return usageError(
      `unknown option or argument ${JSON.stringify(unknown)} for init.`,
      COMMAND_HELP.init,
    );
  const runner = createProcessRunner({ output: { write() {} } });
  let root;
  try {
    root = await findRepositoryRoot(runner, process.cwd());
  } catch (error) {
    write(
      process.stderr,
      gitLocationError(error)
        ? `ringi init: ${error.message}`
        : 'ringi init: not inside a Git repository. Run `git init` first.',
    );
    return 1;
  }
  if ((await realpath(process.cwd())) !== root) {
    write(
      process.stderr,
      'ringi init: run it in the root of the Git repository (the directory that contains .git).',
    );
    return 1;
  }
  const lines = await runInit({ root, dryRun: args.includes('--dry-run') });
  write(process.stdout, lines.join('\n'));
  return 0;
}

async function doctorCommand(args) {
  const unknown = args.find((argument) => argument !== '--json');
  if (unknown !== undefined)
    return usageError(
      `unknown option or argument ${JSON.stringify(unknown)} for doctor.`,
      COMMAND_HELP.doctor,
    );
  const result = await runDoctor();
  write(
    process.stdout,
    args.includes('--json')
      ? JSON.stringify(result, null, 2)
      : formatDoctorTable(result),
  );
  return result.status === 'fail' ? 1 : 0;
}

// A stop before the runner starts (profile not committed, not loadable or
// invalid): the
// same diagnostic as a stopped dry-run, and the JSON report with --json.
function stopBeforeRun(error, args) {
  const report = {
    schemaVersion: 1,
    status: 'STOPPED',
    code: error instanceof AgentWorkflowError ? error.code : 'UNEXPECTED_ERROR',
    stage: error instanceof AgentWorkflowError ? error.stage : 'preflight',
    error: redactSensitive(error instanceof Error ? error.message : String(error)),
    resume:
      (error instanceof AgentWorkflowError ? error.resume : undefined) ??
      'Fix ringi.config.mjs (see docs/profile.md); `ringi doctor` checks it. Then run the task again.',
  };
  if (args.includes('--json'))
    process.stdout.write(`${JSON.stringify(report)}\n`);
  process.stderr.write(`${formatErrorDiagnostic(report, redactSensitive)}\n`);
  return error instanceof AgentWorkflowError ? 1 : 2;
}

async function runCommand(args) {
  const gitRunner = createProcessRunner({ output: { write() {} } });
  let repositoryRoot;
  try {
    repositoryRoot = await findRepositoryRoot(gitRunner, process.cwd());
  } catch (error) {
    if (gitLocationError(error)) return stopBeforeRun(error, args);
    write(process.stderr, 'ringi run: not inside a Git repository.');
    return 2;
  }
  let loaded;
  try {
    // Only a committed profile runs: ringi.config.mjs is checked before its
    // import, the modules it imports after the load, before any agent
    // process and before the dry-run plan (PROFILE_UNCOMMITTED).
    await assertProfileCommitted({ runner: gitRunner, root: repositoryRoot });
    loaded = await loadProjectProfile({ repositoryRoot });
    await assertProfileCommitted({
      runner: gitRunner,
      root: repositoryRoot,
      projectProfile: loaded.projectProfile,
    });
  } catch (error) {
    return stopBeforeRun(error, args);
  }
  const { profile: PROFILE, projectProfile } = loaded;

  // From here on: the flow of scripts/agent-review-loop.mjs.
  const { implementer, reviewer } = resolveAgentRoles(PROFILE);
  const parsed = parseAgentArguments(args, PROFILE);
  const criticalOpus = Object.hasOwn(reviewer.profiles, 'critical-opus')
    ? resolveReviewProfile('critical-opus', reviewer)
    : undefined;
  const [criticalOpusAttempt] = criticalOpus?.attempts ?? [];
  const usage = [
    `Usage: ringi run path/to/task.md [--task-mode ${TASK_MODE_USAGE}] [--implementer-model <id>] [--implementer-effort ${implementer.allowedEfforts.join('|')}] [--review-profile ${Object.keys(reviewer.profiles).join('|')}] [--dry-run] [--verbose] [--no-animation] [--json]`,
    ...(criticalOpus
      ? [
          `critical-opus: model ${criticalOpusAttempt.model}; effort ${criticalOpusAttempt.effort}; attempts ${criticalOpus.attempts.length}; fallback ${criticalOpus.fallbackAllowed ? 'allowed' : 'none'}.`,
        ]
      : []),
  ].join('\n');

  if (parsed.error) {
    console.error(`${parsed.error}\n${usage}`);
    return 2;
  }
  const dashboard = createTerminalDashboard({
    profile: PROFILE,
    output: process.stdout,
    diagnosticOutput: process.stderr,
    taskPath: parsed.taskPath,
    taskMode: parsed.taskMode,
    noAnimation: parsed.noAnimation,
    json: parsed.json,
    verbose: parsed.verbose,
  });
  let presenters;
  try {
    presenters = PROFILE.createPresenters?.({ repositoryRoot, ...parsed });
  } catch {
    /* Optional presentation never changes the report or exit code. */
  }
  const present = async (method, ...presentArgs) => {
    try {
      await presenters?.[method]?.(...presentArgs);
    } catch {
      /* Optional presentation never changes the report or exit code. */
    }
  };
  const presentEvent = (event) => {
    dashboard.event(event);
    void present('event', event, dashboard.state);
  };
  const runner = createProcessRunner({
    output: { write: (text) => dashboard.diagnostic(text) },
  });
  let interruptCount = 0;
  const onInterrupt = (signal) => {
    interruptCount += 1;
    dashboard.dispose();
    if (interruptCount === 1) {
      runner.cancel();
      return;
    }
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    void present('interrupt', dashboard.state).finally(() => {
      process.kill(process.pid, signal);
    });
  };
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  let exitCode = 0;
  try {
    if (!parsed.dryRun) dashboard.start();
    const report = await runAgentReviewLoop({
      profile: PROFILE,
      projectProfile,
      runner,
      output: process.stdout,
      repositoryRoot,
      invocationCwd: process.cwd(),
      taskPath: parsed.taskPath,
      taskMode: parsed.taskMode,
      implementerModel: parsed.implementerModel,
      implementerEffort: parsed.implementerEffort,
      reviewProfile: parsed.reviewProfile,
      dryRun: parsed.dryRun,
      verbose: parsed.verbose,
      onEvent: parsed.dryRun ? undefined : presentEvent,
    });
    if (!parsed.dryRun) {
      void present('beforeFinish', report);
      dashboard.finish(report, report.reportPath);
      void present('afterFinish', dashboard.state);
      if (parsed.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report =
      error instanceof AgentWorkflowError && error.report
        ? error.report
        : {
            schemaVersion: 1,
            status: 'STOPPED',
            code: 'UNEXPECTED_ERROR',
            error: redactSensitive(message),
          };
    void present('beforeFinish', report);
    dashboard.finish(report, report.reportPath);
    if (!parsed.dryRun) void present('afterFinish', dashboard.state);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.stderr.write(
        `${report.code ?? 'STOPPED'}: ${report.stage ?? 'workflow'}\n`,
      );
    } else if (parsed.dryRun) {
      process.stderr.write(
        `${formatErrorDiagnostic(report, redactSensitive, dashboard.state.locale)}\n`,
      );
    }
    exitCode = error instanceof AgentWorkflowError ? 1 : 2;
  } finally {
    dashboard.dispose();
    await present('flush');
    await present('dispose');
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
  return exitCode;
}
