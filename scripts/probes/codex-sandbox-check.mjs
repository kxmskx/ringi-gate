#!/usr/bin/env node
// Probe of the core's sandbox check (internal.runSandboxCheck) with the real
// codex provider module and the real Codex CLI from PATH, in a synthetic Git
// repository in the system temporary directory, for both task modes. Prints
// the CLI version, uname -a, the result of each mode (pass, or the stop code
// and message) and the raw result of the codex sandbox call the core made
// (argv, exit code, stdout, stderr; no environment). Not part of npm test
// and not in the npm package (scripts/probes/.npmignore); run by
// .github/workflows/codex-sandbox.yml.
//
// --expect pass (the default): exit code 0 only when both modes pass.
// --expect stop: exit code 0 only when both modes stop because the sandbox
// did not start (see expectedStop); any pass, or a stop for another reason,
// gives 1, so that a host whose sandbox starts shows up as a failure.
//
// With --diagnose or RINGI_PROBE_DIAGNOSE=1 the probe then runs codex
// sandbox directly in a few diagnostic variants (see DIAGNOSTIC_VARIANTS).
// Diagnostics only: the variants are not used by the module or the core,
// and they do not change the exit code.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, lstatSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { createProcessRunner, internal } from '../agent-review-loop-lib.mjs';
import { msg } from '../messages/index.mjs';
import codex from '../providers/codex.mjs';

const execFileAsync = promisify(execFile);
const MODES = ['implementation', 'analysis'];
const EXPECTATIONS = ['pass', 'stop'];
// Linux settings that decide whether an unprivileged process may create user
// namespaces (used by sandboxes such as bubblewrap).
const LINUX_SETTINGS = [
  '/proc/sys/kernel/unprivileged_userns_clone',
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
  '/proc/sys/user/max_user_namespaces',
];
const NETWORK_OFF = 'sandbox_workspace_write.network_access=false';

// Diagnostic variants of codex sandbox, each from the module's argv for a
// mode; null when the variant does not apply to that mode. They show why the
// sandbox does or does not start on a host and are never used elsewhere.
const DIAGNOSTIC_VARIANTS = [
  // Reference: the module's argv unchanged, as the core runs it.
  { name: 'module argv', modes: MODES, args: (args) => args },
  // The landlock sandbox of the CLI instead of bubblewrap.
  {
    name: 'features.use_legacy_landlock=true',
    modes: MODES,
    args: ([subcommand, ...rest]) => [subcommand, '-c', 'features.use_legacy_landlock=true', ...rest],
  },
  // Network access on, so that the sandbox needs no network namespace of
  // its own: shows whether the failure is limited to setting up the
  // network in the namespace.
  {
    name: 'sandbox_workspace_write.network_access=true',
    modes: ['implementation'],
    args: (args) =>
      args.includes(NETWORK_OFF)
        ? args.map((value) => (value === NETWORK_OFF ? 'sandbox_workspace_write.network_access=true' : value))
        : null,
  },
];

// The canary command of the diagnostics, the same attempts as the core's
// check: an exclusive write outside the writable roots and one in the Git
// directory, then a connection to a listener on 127.0.0.1.
const DIAGNOSTIC_SCRIPT = [
  "const fs = require('node:fs');",
  "const net = require('node:net');",
  'const [outside, git, port] = process.argv.slice(1);',
  'const write = (path) => {',
  "  try { fs.writeFileSync(path, '', { flag: 'wx' }); return 'written'; }",
  "  catch (error) { return String(error.code || 'error'); }",
  '};',
  'const result = { outside: write(outside), git: write(git) };',
  'const socket = net.connect({ host: "127.0.0.1", port: Number(port) });',
  'const finish = (network) => {',
  '  socket.destroy();',
  '  result.network = network;',
  '  console.log(`RINGI-DIAGNOSE ${JSON.stringify(result)}`);',
  '  process.exit(0);',
  '};',
  "socket.once('connect', () => finish('connected'));",
  "socket.once('error', (error) => finish(String(error.code || 'error')));",
  "socket.setTimeout(5000, () => finish('timeout'));",
].join('\n');

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

// The stop of a sandbox that did not start: the core's single codex sandbox
// call exited with code 1 (no signal, no timeout) without printing a result
// line, and the core stopped with IMPLEMENTER_PREFLIGHT_FAILED and the reason
// "exit 1". Any other stop (Git directory, listener, argv, a written canary,
// a connection, a timeout, another exit code) does not match.
function expectedStop(error, calls) {
  if (error?.code !== 'IMPLEMENTER_PREFLIGHT_FAILED' || error.stage !== 'preflight') return false;
  const reason = msg('preflight.sandboxUnconfirmed', { id: codex.id, round: 1, reason: 'exit 1' });
  if (error.message !== reason || calls.length !== 1) return false;
  const [{ error: runError, result }] = calls;
  return (
    !runError &&
    result?.code === 1 &&
    !result.signal &&
    !result.timedOut &&
    !String(result.stdout ?? '')
      .split(/\r?\n/)
      .some((line) => line.startsWith('RINGI-SANDBOX-CHECK '))
  );
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
  let stopError;
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
    stopError = error;
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
  if (passed) return 'pass';
  return expectedStop(stopError, calls) ? 'stop: sandbox did not start' : 'stop: other';
}

function present(path) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) ? 'yes' : 'no';
  } catch (error) {
    return `unknown (${error.code ?? error.message})`;
  }
}

// One diagnostic variant in one mode: codex sandbox run directly, with the
// same environment and an empty CODEX_HOME, then the exit code, the raw
// output and whether each attempt was refused.
async function runDiagnosticVariant({ variant, taskMode, repositoryRoot, tempRoot, env }) {
  console.log(`\n-- diagnose: ${variant.name} (${taskMode})`);
  const nonce = randomBytes(8).toString('hex');
  const directory = join(tempRoot, `diagnose-${nonce}`);
  const codexHome = join(directory, 'home');
  const outside = join(directory, 'outside', 'canary');
  const git = join(repositoryRoot, '.git', `ringi-diagnose-${nonce}`);
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(join(directory, 'outside'), { mode: 0o700 });
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  try {
    const port = await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port));
    });
    const command = [process.execPath, '-e', DIAGNOSTIC_SCRIPT, outside, git, String(port)];
    const args = variant.args(codex.implementer.sandboxCheckArgs({ taskMode, command: [...command] }));
    if (!args) {
      console.log('not applicable');
      return;
    }
    console.log(`argv: ${JSON.stringify([codex.program, ...printableArgs(args)])}`);
    let result;
    try {
      result = await createProcessRunner().run(codex.program, args, {
        cwd: repositoryRoot,
        env: { ...env, CODEX_HOME: codexHome },
        timeoutMs: 30_000,
        stage: 'preflight',
      });
    } catch (error) {
      console.log(`run error: ${error?.code ?? ''} ${error?.message ?? String(error)}`);
      return;
    }
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const { code, signal, timedOut, stdout, stderr } = result;
    console.log(`exit code: ${code}${signal ? ` (signal ${signal})` : ''}${timedOut ? ' (timed out)' : ''}`);
    printBlock('stdout', String(stdout ?? ''));
    printBlock('stderr', String(stderr ?? ''));
    const line = String(stdout ?? '')
      .split(/\r?\n/)
      .find((text) => text.startsWith('RINGI-DIAGNOSE '));
    let report = {};
    try {
      report = line ? JSON.parse(line.slice('RINGI-DIAGNOSE '.length)) : {};
    } catch {
      // Printed above as raw output.
    }
    console.log(`outside write: ${report.outside ?? 'no result'} (file left: ${present(outside)})`);
    console.log(`git write: ${report.git ?? 'no result'} (file left: ${present(git)})`);
    console.log(`local connection: ${report.network ?? 'no result'} (connections received: ${connections})`);
  } finally {
    server.close();
    await Promise.allSettled([
      rm(git, { force: true }),
      rm(directory, { recursive: true, force: true }),
    ]);
  }
}

async function diagnose(context) {
  console.log('\n== diagnostics (do not change the exit code)');
  for (const variant of DIAGNOSTIC_VARIANTS) {
    for (const taskMode of variant.modes) {
      try {
        await runDiagnosticVariant({ ...context, variant, taskMode });
      } catch (error) {
        console.log(`diagnose error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

async function main({ diagnostics, expect }) {
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
    const wanted = expect === 'pass' ? 'pass' : 'stop: sandbox did not start';
    const met = MODES.every((taskMode) => results[taskMode] === wanted);
    console.log('\n== summary');
    for (const taskMode of MODES) console.log(`${taskMode}: ${results[taskMode]}`);
    console.log(`expected: ${wanted} (${met ? 'met' : 'not met'})`);
    if (diagnostics) await diagnose({ repositoryRoot, tempRoot, env });
    return met;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const USAGE = 'usage: codex-sandbox-check.mjs [--diagnose] [--expect <pass|stop>]';
const options = process.argv.slice(2);
let diagnostics = process.env.RINGI_PROBE_DIAGNOSE === '1';
let expect;
for (let index = 0; index < options.length; index += 1) {
  if (options[index] === '--diagnose') diagnostics = true;
  else if (options[index] === '--expect' && expect === undefined && EXPECTATIONS.includes(options[index + 1]))
    expect = options[(index += 1)];
  else {
    console.error(USAGE);
    process.exit(2);
  }
}

main({ diagnostics, expect: expect ?? 'pass' }).then(
  (met) => {
    process.exitCode = met ? 0 : 1;
  },
  (error) => {
    console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
