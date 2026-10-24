// ringi doctor: read-only checks of the repository and the machine, with
// the runner's own preflight functions (agent-review-loop-lib.mjs); no logic
// of the runner is copied here. It starts no agent round, calls no model,
// uses no network and changes nothing: the only processes are read-only Git
// commands and the agent CLIs' version commands, as in the run's preflight.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  AgentWorkflowError,
  createProcessRunner,
  internal,
  loadProjectProfile,
  redactSensitive,
} from './agent-review-loop-lib.mjs';

export const MIN_NODE_MAJOR = 24;
const STATUSES = ['ok', 'warn', 'fail'];

// Variables with which Git takes the repository or the working tree from
// the environment instead of the current directory.
export const GIT_LOCATION_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE'];

// The root of the Git working tree that contains cwd (read-only). The
// root is where ringi.config.mjs is read from, so it comes from the
// current directory only: GIT_DIR or GIT_WORK_TREE is refused.
export async function findRepositoryRoot(runner, cwd, environment = process.env) {
  const set = GIT_LOCATION_VARIABLES.filter(
    (name) => environment[name] !== undefined,
  );
  if (set.length > 0) {
    throw new AgentWorkflowError(
      `${set.join(' and ')} ${set.length > 1 ? 'are' : 'is'} set; ringi finds the repository from the current directory only. Unset ${set.length > 1 ? 'them' : 'it'} and run ringi inside the repository.`,
      {
        code: 'INVALID_CONFIGURATION',
        stage: 'preflight',
        resume: `Unset ${GIT_LOCATION_VARIABLES.join(' and ')}, change to the repository and run ringi again.`,
      },
    );
  }
  const result = await internal.requiredRun(
    runner,
    'git',
    ['rev-parse', '--show-toplevel'],
    {
      cwd,
      stage: 'preflight',
      timeoutMs: 15_000,
      exactStdoutLimitBytes: 64 * 1024,
    },
    'git rev-parse --show-toplevel',
  );
  return realpath(result.stdout.trim());
}

const PROFILE_FILE = 'ringi.config.mjs';

// ringi runs only a committed profile. Without projectProfile: before the
// import, ringi.config.mjs itself; with it: after the load, every
// fingerprinted module. The bytes of each on disk must hash to the blob of
// HEAD:<path> and of its index entry, a regular file without skip-worktree
// or assume-unchanged (readUncommittedProjectProfileFiles: no git status, no
// fsmonitor, no filters); otherwise, also when Git cannot be read,
// PROFILE_UNCOMMITTED. Returns false when the check is left to the loader
// because the entry is missing or is not a regular file; true when checked.
export async function assertProfileCommitted({ runner, root, projectProfile }) {
  const loaded = projectProfile !== undefined;
  const uncommitted = (message, paths) =>
    new AgentWorkflowError(message, {
      code: 'PROFILE_UNCOMMITTED',
      stage: 'preflight',
      resume: `Review the change (git diff HEAD -- ${paths.join(' ')}), commit ${PROFILE_FILE} and the modules it imports first, then run ringi again.`,
    });
  // A missing ringi.config.mjs, or one that is not a regular file, is left
  // to loadProjectProfile, which refuses it without an import
  // (INVALID_CONFIGURATION); one created meanwhile fails the check after
  // the load.
  if (!loaded) {
    const metadata = await lstat(join(root, PROFILE_FILE)).catch(() => undefined);
    if (!metadata?.isFile()) return false;
  }
  let paths;
  try {
    paths = await internal.readUncommittedProjectProfileFiles({
      runner,
      cwd: root,
      projectProfile: loaded ? projectProfile : { files: [{ path: PROFILE_FILE }] },
    });
  } catch (error) {
    throw uncommitted(
      `Whether ${PROFILE_FILE} is committed cannot be checked (${error instanceof Error ? error.message : String(error)}); ringi runs only a committed profile${loaded ? '' : `, ${PROFILE_FILE} was not imported`}.`,
      [PROFILE_FILE],
    );
  }
  if (paths.length === 0) return true;
  throw uncommitted(
    `Not committed or different from HEAD (untracked, changed in the working tree or in the index, flagged skip-worktree or assume-unchanged): ${paths.join(', ')}. ringi runs only a committed profile; ${loaded ? 'the modules it imports were loaded, no agent was started.' : `${PROFILE_FILE} was not imported.`}`,
    paths,
  );
}

function failure(error) {
  return error instanceof AgentWorkflowError
    ? { code: error.code, message: redactSensitive(error.message).slice(0, 500) }
    : {
        code: 'UNEXPECTED_ERROR',
        message: redactSensitive(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 500),
      };
}

export async function runDoctor({
  cwd = process.cwd(),
  runner = createProcessRunner({ output: { write() {} } }),
  nodeVersion = process.versions.node,
  environment = process.env,
  platform = process.platform,
  // The directory of the runner installation (bin/, scripts/).
  runnerRoot = internal.RUNNER_ROOT,
} = {}) {
  const checks = [];
  const add = (id, status, detail, hint = null, error = undefined) =>
    checks.push({
      id,
      status,
      detail,
      hint: status === 'ok' ? null : hint,
      ...(error ? { code: error.code, message: error.message } : {}),
    });
  const notChecked = (id, dependency) =>
    add(id, 'warn', `not checked: ${dependency} failed`, `Fix ${dependency} first.`);
  // Runs a check; returns its value, or undefined after recording a failure.
  const attempt = async (id, action, describe, hint) => {
    try {
      const value = await action();
      add(id, 'ok', describe(value));
      return { value };
    } catch (error) {
      const details = failure(error);
      add(
        id,
        'fail',
        `${details.code}: ${details.message}`,
        typeof hint === 'function' ? hint(details) : hint,
        details,
      );
      return undefined;
    }
  };

  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  add(
    'node',
    major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    `Node.js ${nodeVersion}`,
    `Install Node.js ${MIN_NODE_MAJOR} or newer.`,
  );

  const repository = await attempt(
    'git-repository',
    () => findRepositoryRoot(runner, cwd, environment),
    () => 'inside a Git working tree',
    (details) =>
      details.code === 'INVALID_CONFIGURATION'
        ? `Unset ${GIT_LOCATION_VARIABLES.join(' and ')}.`
        : 'Run ringi inside a Git repository.',
  );
  const root = repository?.value;
  const repositoryChecks = [
    'runner-location',
    'branch',
    'staged-changes',
    'package-manager',
    'corepack-cache',
    'agents-md',
    'claude-md',
    'profile-committed',
    'profile',
    'providers',
    'repository-layout',
    'implementer-cli',
    'reviewer-cli',
  ];
  if (!root) {
    for (const id of repositoryChecks) notChecked(id, 'git-repository');
    return finish(checks);
  }

  // A runner inside the repository (for example node_modules/ringi-gate) is
  // a file the writer can change: a change during a run stops it
  // (RUNNER_MODIFIED), a change made before a run is not detected.
  const runnerLocation = await attempt(
    'runner-location',
    async () => relative(root, await realpath(runnerRoot)),
    () => 'runner installed outside the repository',
    'Check that the runner installation can be read.',
  );
  const location = runnerLocation?.value;
  if (
    location !== undefined &&
    (location === '' ||
      (location !== '..' &&
        !location.startsWith(`..${sep}`) &&
        !isAbsolute(location)))
  ) {
    const entry = checks.at(-1);
    entry.status = 'warn';
    entry.detail = `runner installed inside the repository (${location.split(sep).join('/') || '.'})`;
    entry.hint =
      'Install the runner outside the repository (globally, or run it with npx from the npm cache): a writer can change runner files inside the repository, and a change made before a run is not detected.';
  }

  const branch = await attempt(
    'branch',
    () => internal.readBranch(runner, root),
    (name) => `on ${name}`,
    'Check out a working branch: git switch -c <name>.',
  );
  if (branch && internal.WORKING_BRANCHES_BLOCKED.has(branch.value)) {
    const entry = checks.at(-1);
    entry.status = 'fail';
    entry.detail = `on ${branch.value}; the runner refuses main and master`;
    entry.hint = 'Switch to a working branch: git switch -c <name>.';
    entry.code = 'PROTECTED_BRANCH';
  }
  await attempt(
    'staged-changes',
    () => internal.assertNoStagedChanges(runner, root),
    () => 'nothing staged',
    'Unstage the changes (git restore --staged <path>) before a run.',
  );

  const pinned = await attempt(
    'package-manager',
    () => internal.readPinnedPnpmVersion(root),
    (value) => `packageManager ${value.specification}`,
    'Pin pnpm in package.json: "packageManager": "pnpm@<exact version>".',
  );
  if (pinned) {
    await attempt(
      'corepack-cache',
      async () => {
        const sourceRoot = join(
          internal.resolveCorepackHome(environment),
          'v1',
          'pnpm',
          pinned.value.version,
        );
        await internal.walkCorepackTree({ sourceRoot });
        await internal.validatePinnedCorepackIntegrity(sourceRoot, pinned.value);
      },
      () => `pnpm ${pinned.value.version} in the local Corepack cache`,
      `Cache it once: corepack install -g --cache-only ${pinned.value.specification}.`,
    );
  } else {
    notChecked('corepack-cache', 'package-manager');
  }

  for (const [id, name] of [
    ['agents-md', 'AGENTS.md'],
    ['claude-md', 'CLAUDE.md'],
  ]) {
    // The run reads both files exactly like this (an error there is
    // UNEXPECTED_ERROR); the message here names the file, not its path.
    await attempt(
      id,
      async () => {
        try {
          return await readFile(join(root, name), 'utf8');
        } catch (error) {
          throw new Error(`${name} cannot be read (${error?.code ?? 'error'})`);
        }
      },
      () => `${name} present`,
      `Create ${name} at the repository root (ringi init does not create it).`,
    );
  }

  // As in a run: ringi.config.mjs is imported only when it is committed and
  // matches HEAD (a change a writer left behind is not run).
  const committed = await attempt(
    'profile-committed',
    () => assertProfileCommitted({ runner, root }),
    () => `${PROFILE_FILE} is committed and matches HEAD (checked before the import)`,
    `Review the change (git diff HEAD -- ${PROFILE_FILE}) and commit it; doctor and run do not import an uncommitted profile.`,
  );
  if (!committed) {
    for (const id of [
      'profile',
      'providers',
      'repository-layout',
      'implementer-cli',
      'reviewer-cli',
    ])
      notChecked(id, 'profile-committed');
    return finish(checks);
  }
  if (committed.value === false) {
    const entry = checks.at(-1);
    entry.status = 'warn';
    entry.detail = `not checked: ${PROFILE_FILE} is missing or is not a regular file`;
    entry.hint = `Fix ${PROFILE_FILE} (run ringi init if it is missing); see the profile check.`;
  }
  const loaded = await attempt(
    'profile',
    async () => {
      const value = await loadProjectProfile({ repositoryRoot: root });
      // The run's own checks right after the load (preflight).
      await internal.assertProjectProfileUnchanged(
        value.projectProfile,
        'preflight',
      );
      await assertProfileCommitted({
        runner,
        root,
        projectProfile: value.projectProfile,
      });
      return value;
    },
    ({ projectProfile }) =>
      `${projectProfile.path} valid; ${projectProfile.files.length} module(s), sha256 ${projectProfile.sha256.slice(0, 12)}`,
    (details) =>
      details.code === 'PROFILE_UNCOMMITTED'
        ? 'Review the change of the listed modules (git diff HEAD -- <files>) and commit it before a run.'
        : /not found/.test(details.message)
          ? 'Create it with ringi init.'
          : 'Fix ringi.config.mjs; see docs/profile.md.',
  );
  if (!loaded) {
    const error = checks.at(-1);
    if (error.code === 'PROVIDER_ROLE_NOT_ALLOWED') {
      add(
        'providers',
        'fail',
        `${error.code}: ${error.message}`,
        'A provider module does not meet the role rules; see docs/providers.md.',
        { code: error.code, message: error.message },
      );
    } else {
      notChecked('providers', 'profile');
    }
    for (const id of ['repository-layout', 'implementer-cli', 'reviewer-cli'])
      notChecked(id, 'profile');
    return finish(checks);
  }
  const resolved = internal.resolveRunnerProfile(loaded.value.profile);
  const roles = await attempt(
    'providers',
    () => ({
      implementer: internal.roleProvider(resolved.implementer, 'implementer'),
      reviewer: internal.roleProvider(resolved.reviewer, 'reviewer'),
    }),
    ({ implementer, reviewer }) =>
      `implementer ${implementer.id}, reviewer ${reviewer.id}`,
    'See docs/providers.md.',
  );
  if (!roles) {
    for (const id of ['repository-layout', 'implementer-cli', 'reviewer-cli'])
      notChecked(id, 'providers');
    return finish(checks);
  }
  await attempt(
    'repository-layout',
    () =>
      internal.assertImplementerRepositoryLayout({
        runner,
        cwd: root,
        adapter: roles.value.implementer,
      }),
    () => `layout accepted for implementer ${roles.value.implementer.id}`,
    'This implementer needs a plain repository: no linked worktree, submodule or object alternates.',
  );
  const report = (independentReviewRequired) =>
    internal.environmentReport({
      runner,
      cwd: root,
      reviewProfile: resolved.reviewer.defaultProfile,
      implementerModel: resolved.implementer.model,
      implementerEffort: resolved.implementer.effort,
      independentReviewRequired,
      implementer: resolved.implementer,
      reviewer: resolved.reviewer,
      platform,
    });
  const cliHint = (program) => (details) =>
    details.code === 'IMPLEMENTER_PREFLIGHT_FAILED'
      ? `Use a ${program} version and platform the implementer accepts; see docs/architecture.md.`
      : `Install ${program} and put it on PATH; \`${program} --version\` must succeed.`;
  const implementerCli = await attempt(
    'implementer-cli',
    () => report(false),
    (value) =>
      `${roles.value.implementer.program}: ${String(value.implementer.version).slice(0, 80)}`,
    cliHint(roles.value.implementer.program),
  );
  if (implementerCli) {
    await attempt(
      'reviewer-cli',
      () => report(true),
      (value) =>
        `${roles.value.reviewer.program}: ${String(value.reviewer.version).slice(0, 80)}`,
      cliHint(roles.value.reviewer.program),
    );
  } else {
    notChecked('reviewer-cli', 'implementer-cli');
  }
  return finish(checks);
}

function finish(checks) {
  const summary = Object.fromEntries(
    STATUSES.map((status) => [
      status,
      checks.filter((check) => check.status === status).length,
    ]),
  );
  return {
    schemaVersion: 1,
    status: summary.fail > 0 ? 'fail' : 'ok',
    summary,
    checks,
  };
}

export function formatDoctorTable(result) {
  const width = Math.max(5, ...result.checks.map(({ id }) => id.length));
  const lines = [`STATUS  ${'CHECK'.padEnd(width)}  DETAIL`];
  for (const check of result.checks) {
    lines.push(
      `${check.status.padEnd(6)}  ${check.id.padEnd(width)}  ${check.detail}`,
    );
    if (check.hint)
      lines.push(`${' '.repeat(8 + width + 2)}fix: ${check.hint}`);
  }
  const { ok, warn, fail } = result.summary;
  lines.push('', `ringi doctor: ${ok} ok, ${warn} warn, ${fail} fail`);
  return `${lines.join('\n')}\n`;
}
