#!/usr/bin/env node
// Probe of the core's sandbox check (internal.runSandboxCheck) with the real
// codex provider module and the real Codex CLI from PATH, in a synthetic Git
// repository in the system temporary directory, for both task modes. Prints
// the CLI version, uname -a, the result of each mode (pass, or the stop code
// and message) and the raw result of the codex sandbox call the core made
// (argv, exit code, stdout, stderr; no environment). Exit code 0 only when
// both modes pass. Not part of npm test and not in the npm package
// (scripts/probes/.npmignore); run by .github/workflows/codex-sandbox.yml.
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { createProcessRunner, internal } from '../agent-review-loop-lib.mjs';
import codex from '../providers/codex.mjs';

const execFileAsync = promisify(execFile);
const MODES = ['implementation', 'analysis'];
// Linux settings that decide whether an unprivileged process may create user
// namespaces (used by sandboxes such as bubblewrap).
const LINUX_SETTINGS = [
  '/proc/sys/kernel/unprivileged_userns_clone',
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
  '/proc/sys/user/max_user_namespaces',
];

async function output(program, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(program, args, {
      ...options,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (error) {
    return `unavailable (${error.code ?? error.message})`;
  }
}

async function onPath(name, path) {
  for (const directory of (path ?? '').split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, name), fsConstants.X_OK);
      return join(directory, name);
    } catch {
      // Not in this directory.
    }
  }
  return 'not found';
}

// The argv without the text of the check script, which is the core's own.
function printableArgs(args) {
  return args.map((value, index) => (args[index - 1] === '-e' ? '<check script>' : value));
}

function printBlock(label, text) {
  console.log(`${label}:`);
  console.log(text === '' ? '  (empty)' : text.replace(/\n$/, '').replace(/^/gm, '  '));
}

async function runMode({ taskMode, repositoryRoot, tempRoot, env }) {
  const base = createProcessRunner();
  const calls = [];
  const runner = {
    ...base,
    async run(program, args, options) {
      const call = { program, args: [...args] };
      calls.push(call);
      try {
        call.result = await base.run(program, args, options);
        return call.result;
      } catch (error) {
        call.error = error;
        throw error;
      }
    },
  };
  let passed = false;
  console.log(`\n== mode: ${taskMode}`);
  try {
    await internal.runSandboxCheck({
      runner,
      adapter: codex,
      taskMode,
      repositoryRoot,
      tempRoot,
      env,
      round: 1,
    });
    passed = true;
    console.log('result: pass');
  } catch (error) {
    console.log(`result: STOP ${error?.code ?? 'ERROR'}`);
    console.log(`message: ${error?.message ?? String(error)}`);
  }
  for (const call of calls) {
    console.log(`argv: ${JSON.stringify([call.program, ...printableArgs(call.args)])}`);
    if (call.error) {
      console.log(`run error: ${call.error.code ?? ''} ${call.error.message}`);
      continue;
    }
    const { code, signal, timedOut, stdout, stderr } = call.result;
    console.log(`exit code: ${code}${signal ? ` (signal ${signal})` : ''}${timedOut ? ' (timed out)' : ''}`);
    printBlock('stdout', String(stdout ?? ''));
    printBlock('stderr', String(stderr ?? ''));
  }
  if (calls.length === 0) console.log('codex sandbox: not started');
  return passed;
}

async function main() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ringi-sandbox-probe-')));
  try {
    const repositoryRoot = join(base, 'repo');
    const tempRoot = join(base, 'temp');
    await mkdir(repositoryRoot);
    await mkdir(tempRoot, { mode: 0o700 });
    const git = await output('git', ['init', '--quiet', repositoryRoot], {
      env: {
        PATH: process.env.PATH,
        HOME: base,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
    if (git.startsWith('unavailable')) throw new Error(`git init: ${git}`);
    // The round's isolated environment; runSandboxCheck replaces CODEX_HOME
    // with an empty directory of its own. The guard directory is left out:
    // the check command is the absolute path of node.
    const env = await internal.createIsolatedCodexEnvironment({
      tempRoot,
      source: process.env,
      corepackHome: join(base, 'corepack'),
    });
    const versionHome = join(base, 'version-home');
    await mkdir(versionHome, { mode: 0o700 });

    console.log(`codex --version: ${await output('codex', ['--version'], { env: { ...env, CODEX_HOME: versionHome } })}`);
    console.log(`codex path: ${await onPath('codex', env.PATH)}`);
    console.log(`uname -a: ${await output('uname', ['-a'])}`);
    console.log(`node: ${process.version} (${process.platform} ${process.arch})`);
    if (process.platform === 'linux') {
      for (const path of LINUX_SETTINGS) {
        const value = await readFile(path, 'utf8').then(
          (text) => text.trim(),
          (error) => `unavailable (${error.code ?? error.message})`,
        );
        console.log(`${path}: ${value}`);
      }
      console.log(`bwrap path: ${await onPath('bwrap', env.PATH)}`);
    }

    const results = {};
    for (const taskMode of MODES)
      results[taskMode] = await runMode({ taskMode, repositoryRoot, tempRoot, env });
    console.log('\n== summary');
    for (const taskMode of MODES)
      console.log(`${taskMode}: ${results[taskMode] ? 'pass' : 'STOP'}`);
    return MODES.every((taskMode) => results[taskMode]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

main().then(
  (passed) => {
    process.exitCode = passed ? 0 : 1;
  },
  (error) => {
    console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
