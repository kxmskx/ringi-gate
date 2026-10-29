#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE } from './agent-review-profile.mjs';
import {
  AgentWorkflowError,
  createProcessRunner,
  redactSensitive,
  runAgentReviewLoop,
} from './agent-review-loop-lib.mjs';
import {
  createTerminalDashboard,
  formatAgentUsage,
  formatErrorDiagnostic,
  parseAgentArguments,
} from './agent-review-dashboard.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Options, usage and messages follow the profile (roles and locale).
const parsed = parseAgentArguments(process.argv.slice(2), PROFILE);
const usage = formatAgentUsage(PROFILE);

if (parsed.error) {
  console.error(`${parsed.error}\n${usage}`);
  process.exitCode = 2;
} else {
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
  const present = async (method, ...args) => {
    try {
      await presenters?.[method]?.(...args);
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

  try {
    if (!parsed.dryRun) dashboard.start();
    const report = await runAgentReviewLoop({
      profile: PROFILE,
      runner,
      output: process.stdout,
      repositoryRoot,
      invocationCwd: process.cwd(),
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
    process.exitCode = error instanceof AgentWorkflowError ? 1 : 2;
  } finally {
    dashboard.dispose();
    await present('flush');
    await present('dispose');
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}
