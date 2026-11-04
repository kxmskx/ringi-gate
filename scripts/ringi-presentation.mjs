// The presentation boundary: the one place that calls presenters, shared by
// `ringi run` (scripts/ringi-cli.mjs) and scripts/agent-review-loop.mjs.
//
// On the core's side: the loop, the report, the ledger, the JSON report on
// stdout (--json), the stop diagnostics on stderr and the exit code. On the
// presentation side: the built-in presenter `terminal` (the terminal
// dashboard of scripts/agent-review-dashboard.mjs) and, as an observer, the
// hooks the profile's optional createPresenters returns. Presenters only
// observe:
// - every call is guarded: an exception or a rejected promise of a presenter
//   is swallowed, so it never changes the report, the ledger or the exit code;
// - the profile's hooks receive copies (events, the report, the dashboard's
//   state), never the objects of the core or of the dashboard;
// - the built-in presenter `terminal` receives the original events and
//   report, read-only: it must never change them;
// - no presenter receives the process runner: only the interrupt path below
//   cancels a round;
// - the terminal presenter redacts what it writes as before (redactSensitive
//   and stripAnsi in its feed, summary and --verbose diagnostics); the hooks
//   are code of the profile, trusted like it, and write only on their own.
// The interface is internal (outside docs/contract.md). Presenters come only
// from this module and the profile's createPresenters, never from a file, a
// path, a package, an environment variable or the reviewed tree.
//
// A presenter has the methods start() (before the loop; not with --dry-run),
// event(event), diagnostic(text) (the process runner's output), finish(report,
// reportPath), interrupt() (SIGINT or SIGTERM), dispose() (always, last) and
// view(), its read-only view state, of which the profile's hooks get a copy.
// The presenter must not change the events and the report it receives.
import {
  AgentWorkflowError,
  createProcessRunner,
  internal,
  redactSensitive,
} from './agent-review-loop-lib.mjs';
import {
  createTerminalDashboard,
  formatErrorDiagnostic,
} from './agent-review-dashboard.mjs';

// The built-in presenter `terminal`: the dashboard, its modes (interactive,
// append, json) and their selection unchanged.
export function createTerminalPresenter(options) {
  const dashboard = createTerminalDashboard(options);
  return {
    view: () => dashboard.state,
    start: () => dashboard.start(),
    event: (event) => dashboard.event(event),
    diagnostic: (text) => dashboard.diagnostic(text),
    finish: (report, reportPath) => dashboard.finish(report, reportPath),
    // An interrupt leaves the alternate screen at once.
    interrupt: () => dashboard.dispose(),
    dispose: () => dashboard.dispose(),
  };
}

// A copy for the profile's hooks: what a hook changes in it reaches nothing
// else, and the hook may change it without an error. Events, reports and the
// dashboard's state are plain data; an argument structuredClone cannot copy
// throws, and the hook is skipped for that call (the error is swallowed).
export function presentationSnapshot(value) {
  return structuredClone(value);
}

// The boundary around one presenter and the profile's hooks, in the order
// the CLI has always called them: the presenter first, then the hooks;
// beforeFinish before and afterFinish after the presenter's finish.
export function createPresentation({ presenter, hooks }) {
  const call = (method, ...args) => {
    try {
      presenter[method](...args);
    } catch {
      /* Presentation never changes the report or exit code. */
    }
  };
  // args: evaluated only when the hook exists, so a copy is made for a call.
  const observe = async (method, args = () => []) => {
    try {
      const hook = hooks?.[method];
      if (hook === undefined || hook === null) return;
      await Reflect.apply(hook, hooks, args());
    } catch {
      /* Optional presentation never changes the report or exit code. */
    }
  };
  const view = () => presentationSnapshot(presenter.view());
  return {
    start() {
      call('start');
    },
    event(event) {
      call('event', event);
      void observe('event', () => [presentationSnapshot(event), view()]);
    },
    diagnostic(text) {
      call('diagnostic', text);
    },
    finish(report, reportPath, { afterFinish = true } = {}) {
      void observe('beforeFinish', () => [presentationSnapshot(report)]);
      call('finish', report, reportPath);
      if (afterFinish) void observe('afterFinish', () => [view()]);
    },
    interrupt() {
      call('interrupt');
    },
    // The second interrupt: the hooks' interrupt, before the process is killed.
    lastInterrupt() {
      return observe('interrupt', () => [view()]);
    },
    async dispose() {
      call('dispose');
      await observe('flush');
      await observe('dispose');
    },
  };
}

// The flow of both entry points from the parsed arguments to the exit code
// (0 completed, 1 stopped, 2 an error outside the runner). runAgentReviewLoop
// is the entry point's loop; loopOptions are the options only one entry
// point passes (`ringi run`: projectProfile). setExitCode, when given, gets
// the code of a stopped run (1 or 2) as soon as it is known, before the
// hooks' flush and dispose (scripts/agent-review-loop.mjs: process.exitCode);
// a completed run never calls it. The other parameters default to the
// process and exist for tests.
export async function runWithPresentation({
  profile,
  repositoryRoot,
  parsed,
  runAgentReviewLoop,
  loopOptions = {},
  setExitCode,
  stdout = process.stdout,
  stderr = process.stderr,
  environment = process.env,
  signals = process,
  cwd = () => process.cwd(),
  createRunner = createProcessRunner,
  createPresenter = createTerminalPresenter,
}) {
  const presenter = createPresenter({
    profile,
    output: stdout,
    diagnosticOutput: stderr,
    taskPath: parsed.taskPath,
    taskMode: parsed.taskMode,
    noAnimation: parsed.noAnimation,
    json: parsed.json,
    verbose: parsed.verbose,
    environment,
  });
  let hooks;
  try {
    // A copy of the parsed arguments, as before.
    hooks = profile.createPresenters?.({ repositoryRoot, ...parsed });
  } catch {
    /* Optional presentation never changes the report or exit code. */
  }
  const presentation = createPresentation({ presenter, hooks });
  const runner = createRunner({
    output: { write: (text) => presentation.diagnostic(text) },
  });
  let interruptCount = 0;
  const onInterrupt = (signal) => {
    interruptCount += 1;
    presentation.interrupt();
    if (interruptCount === 1) {
      runner.cancel();
      return;
    }
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
    void presentation.lastInterrupt().finally(() => {
      signals.kill(signals.pid, signal);
    });
  };
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');
  signals.on('SIGINT', onSigint);
  signals.on('SIGTERM', onSigterm);

  let exitCode = 0;
  try {
    if (!parsed.dryRun) presentation.start();
    const report = await runAgentReviewLoop({
      profile,
      ...loopOptions,
      runner,
      output: stdout,
      repositoryRoot,
      invocationCwd: cwd(),
      taskPath: parsed.taskPath,
      taskMode: parsed.taskMode,
      implementerModel: parsed.implementerModel,
      implementerEffort: parsed.implementerEffort,
      reviewProfile: parsed.reviewProfile,
      reviewOnly: parsed.reviewOnly,
      checkpoint: parsed.checkpoint,
      resume: parsed.resume,
      dryRun: parsed.dryRun,
      verbose: parsed.verbose,
      onEvent: parsed.dryRun ? undefined : (event) => presentation.event(event),
    });
    if (!parsed.dryRun) {
      presentation.finish(report, report.reportPath);
      if (parsed.json) stdout.write(`${JSON.stringify(report)}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report =
      error instanceof AgentWorkflowError && error.report
        ? error.report
        : {
            schemaVersion: 2,
            status: 'STOPPED',
            code: 'UNEXPECTED_ERROR',
            error: redactSensitive(message),
          };
    presentation.finish(report, report.reportPath, {
      afterFinish: !parsed.dryRun,
    });
    if (parsed.json) {
      stdout.write(`${JSON.stringify(report)}\n`);
      stderr.write(`${report.code ?? 'STOPPED'}: ${report.stage ?? 'workflow'}\n`);
    } else if (parsed.dryRun) {
      // The profile's locale, as the dashboard's (createDashboardState).
      stderr.write(
        `${formatErrorDiagnostic(report, redactSensitive, internal.profileLocale(profile))}\n`,
      );
    }
    exitCode = error instanceof AgentWorkflowError ? 1 : 2;
    // Before the hooks' flush and dispose, as the earlier entry point always
    // set process.exitCode.
    setExitCode?.(exitCode);
  } finally {
    await presentation.dispose();
    signals.off('SIGINT', onSigint);
    signals.off('SIGTERM', onSigterm);
  }
  return exitCode;
}
