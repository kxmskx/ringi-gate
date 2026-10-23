// Tests of the ringi command (bin/ringi.mjs): init, doctor and run, on
// synthetic repositories in the system temporary directory, with stand-in
// scripts for the agent CLIs (they answer --version only). No model, no
// network, no installation; pnpm runs offline from the local Corepack cache
// in the run test only. Imported by agent-review-loop.test.mjs, so npm test
// runs it without a change of scripts.test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  internal,
  validateTaskMarkdown,
} from './agent-review-loop-lib.mjs';
import { formatDoctorTable, runDoctor } from './ringi-doctor.mjs';
import {
  EXAMPLE_TASK,
  EXAMPLE_TASK_PATH,
  inferGates,
  profileSource,
} from './ringi-init.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const runnerRoot = join(scriptDirectory, '..');
const ringiBin = join(runnerRoot, 'bin', 'ringi.mjs');
const PACKAGE_MANAGER = 'pnpm@11.20.0';
const PNPM_VERSION = '11.20.0';
const CODEX_VERSION = 'codex-cli 0.147.0';
const CLAUDE_VERSION = '2.1.290 (Claude Code)';

function which(name) {
  const found = spawnSync('which', ['-a', name], {
    encoding: 'utf8',
    shell: false,
  })
    .stdout.split(/\r?\n/)
    .find((path) => path && !path.includes('/guard-bin/'));
  assert.ok(found, `${name} not found`);
  return found;
}

const realGit = which('git');
const gitEnvironment = {
  PATH: `${dirname(realGit)}:/usr/bin:/bin`,
  HOME: process.env.HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, args) {
  const child = spawnSync(realGit, args, {
    cwd,
    encoding: 'utf8',
    env: gitEnvironment,
    shell: false,
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

async function writeFiles(directory, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}

// A Git repository with the given files committed, on a working branch.
async function createProject({ branch = 'feat/ringi-test', files = {} } = {}) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'ringi-cli-project-')),
  );
  git(directory, ['init', '--quiet', '--initial-branch', 'main']);
  git(directory, ['config', 'user.name', 'Synthetic Tester']);
  git(directory, ['config', 'user.email', 'tester@example.invalid']);
  git(directory, ['config', 'commit.gpgsign', 'false']);
  await writeFiles(directory, files);
  git(directory, ['add', '-A']);
  git(directory, ['commit', '--quiet', '--allow-empty', '-m', 'test: baseline']);
  if (branch !== 'main') git(directory, ['switch', '--quiet', '-c', branch]);
  return directory;
}

// Stand-in programs: git (the real one), and agent CLIs that only answer
// --version.
async function createStubBin(versions = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ringi-cli-bin-')));
  const script = (body) => `#!/bin/sh\n${body}\n`;
  await writeFile(
    join(directory, 'git'),
    script(`exec ${JSON.stringify(realGit)} "$@"`),
  );
  await chmod(join(directory, 'git'), 0o755);
  for (const [name, version] of Object.entries(versions)) {
    await writeFile(
      join(directory, name),
      script(
        `if [ "$1" = "--version" ]; then echo ${JSON.stringify(version)}; exit 0; fi\nexit 64`,
      ),
    );
    await chmod(join(directory, name), 0o755);
  }
  return directory;
}

async function createCorepackHome({ version = PNPM_VERSION } = {}) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'ringi-cli-corepack-')),
  );
  if (version) {
    await mkdir(join(directory, 'v1', 'pnpm', version), { recursive: true });
    await writeFile(join(directory, 'v1', 'pnpm', version, '.corepack'), '{}');
  }
  return directory;
}

function ringi(cwd, args, env) {
  return spawnSync(process.execPath, [ringiBin, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
  });
}

const healthyFiles = () => ({
  'package.json': `${JSON.stringify(
    {
      name: 'synthetic-project',
      private: true,
      packageManager: PACKAGE_MANAGER,
      scripts: { test: 'node --test' },
    },
    null,
    2,
  )}\n`,
  'AGENTS.md': '# Agents\n\nSynthetic rules.\n',
  'CLAUDE.md': '# Claude\n\nSynthetic rules.\n',
  'ringi.config.mjs': profileSource(inferGates({ scripts: { test: 'x' } })),
});

// A valid profile that writes a marker file when it is imported: no marker,
// no import.
const markingProfile = (marker) =>
  [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'imported\\n');`,
    healthyFiles()['ringi.config.mjs'],
  ].join('\n');

async function cleanup(...paths) {
  for (const path of paths)
    if (path) await rm(path, { recursive: true, force: true });
}

// SHA-256 of the canonical Apache License 2.0 text (apache.org) and of the
// two-line NOTICE (project name and copyright line). LICENSE is the canonical
// text with only the copyright line of its appendix filled in.
const LICENSE_COPYRIGHT_LINE = '   Copyright 2026 Daniel Komór';
const LICENSE_PLACEHOLDER_LINE = '   Copyright [yyyy] [name of copyright owner]';
const LICENSE_SHA256 =
  'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const NOTICE_SHA256 =
  '32aa49413ef42688ad6d1fc153d9ff26d0c9342b10f752a947472e0743871fbf';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('name and license: package.json, LICENSE and NOTICE', async () => {
  const packageJson = JSON.parse(
    await readFile(join(runnerRoot, 'package.json'), 'utf8'),
  );
  assert.equal(packageJson.name, 'ringi-gate');
  assert.equal(packageJson.license, 'Apache-2.0');
  // Unreleased (`private: true`, 0.0.0) or a release (`private: false`).
  assert.equal(packageJson.private, packageJson.version === '0.0.0');
  assert.deepEqual(packageJson.bin, { ringi: 'bin/ringi.mjs' });
  const lock = JSON.parse(
    await readFile(join(runnerRoot, 'package-lock.json'), 'utf8'),
  );
  assert.equal(lock.name, 'ringi-gate');
  assert.equal(lock.packages[''].name, 'ringi-gate');
  const license = (await readFile(join(runnerRoot, 'LICENSE'))).toString('utf8');
  assert.equal(license.split(LICENSE_COPYRIGHT_LINE).length, 2);
  assert.equal(
    sha256(Buffer.from(license.replace(LICENSE_COPYRIGHT_LINE, LICENSE_PLACEHOLDER_LINE), 'utf8')),
    LICENSE_SHA256,
  );
  const notice = await readFile(join(runnerRoot, 'NOTICE'));
  assert.equal(sha256(notice), NOTICE_SHA256);
  assert.match(notice.toString('utf8'), /^Ringi Gate\nCopyright 2026 [^\n]+\n$/u);
});

test('name and license scan: no provisional project name or undecided license left in the repository', async () => {
  // The patterns use \s+ so that this file does not match itself. LICENSE is
  // checked against the canonical text above.
  const patterns = [
    /working\s+name/iu,
    /to\s+be\s+decided/iu,
    /no\s+license/iu,
    /licen[cs]e\s+is\s+not\s+decided/iu,
    /license[-:\s]+TBD/iu,
  ];
  const files = (await readdir(runnerRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(runnerRoot, join(entry.parentPath, entry.name)).split('\\').join('/'),
    )
    .filter(
      (path) =>
        path !== 'LICENSE' &&
        path !== '.git' &&
        !path.startsWith('.git/') &&
        !path.startsWith('node_modules/'),
    )
    .sort();
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('NOTICE'));
  const found = [];
  for (const path of files) {
    const text = await readFile(join(runnerRoot, path), 'utf8');
    for (const pattern of patterns)
      if (pattern.test(text)) found.push(`${path}: ${pattern}`);
  }
  assert.deepEqual(found, []);
});

test('ringi CLI: help, version, unknown command and unknown option', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ringi-cli-help-')));
  try {
    const env = { PATH: '/usr/bin:/bin', NO_COLOR: '1' };
    const help = ringi(cwd, ['--help'], env);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: ringi <command> \[options\]/);
    for (const command of ['init', 'doctor', 'run']) {
      const commandHelp = ringi(cwd, [command, '--help'], env);
      assert.equal(commandHelp.status, 0, command);
      assert.match(commandHelp.stdout, new RegExp(`^Usage: ringi ${command}`));
    }
    const version = ringi(cwd, ['--version'], env);
    assert.equal(version.status, 0);
    const packageJson = JSON.parse(
      await readFile(join(runnerRoot, 'package.json'), 'utf8'),
    );
    assert.equal(version.stdout, `ringi (Ringi Gate) ${packageJson.version}\n`);
    assert.deepEqual(packageJson.bin, { ringi: 'bin/ringi.mjs' });
    for (const args of [
      [],
      ['deploy'],
      ['--force'],
      ['init', '--force'],
      ['init', 'extra'],
      ['doctor', '--fix'],
    ]) {
      const child = ringi(cwd, args, env);
      assert.equal(child.status, 2, args.join(' '));
      assert.equal(child.stdout, '');
      assert.match(child.stderr, /^ringi: /);
      assert.match(child.stderr, /Usage: ringi/);
    }
  } finally {
    await cleanup(cwd);
  }
});

test('ringi init: empty project gets a valid profile and task; nothing else changes', async (t) => {
  const project = await createProject();
  const bin = await createStubBin();
  try {
    const env = { PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: '1' };
    const head = git(project, ['rev-parse', 'HEAD']);
    const index = await readFile(join(project, '.git', 'index'));
    const dryRun = ringi(project, ['init', '--dry-run'], env);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(
      dryRun.stdout,
      [
        'ringi init --dry-run: nothing is written.',
        'create   ringi.config.mjs (gates: git diff --check)',
        'create   tasks/example-task.md',
        'note     package.json is missing: only `git diff --check` was added as a gate.',
        'note     AGENTS.md is missing at the repository root; the runner requires it (ringi init does not create it).',
        'note     CLAUDE.md is missing at the repository root; the runner requires it (ringi init does not create it).',
        'next     commit ringi.config.mjs before ringi run (ringi init commits nothing; doctor and run refuse an uncommitted profile)',
        'next     ringi doctor',
        '',
      ].join('\n'),
    );
    t.diagnostic(`$ ringi init --dry-run\n${dryRun.stdout}`);
    await assert.rejects(lstat(join(project, 'ringi.config.mjs')), /ENOENT/);
    await assert.rejects(lstat(join(project, 'tasks')), /ENOENT/);

    const created = ringi(project, ['init'], env);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /^created  ringi\.config\.mjs \(gates: git diff --check\)$/m);
    assert.match(created.stdout, /^created  tasks\/example-task\.md$/m);
    for (const name of ['AGENTS.md', 'CLAUDE.md'])
      await assert.rejects(lstat(join(project, name)), /ENOENT/);
    // No Git state changed: same HEAD, same index bytes, only new files.
    assert.equal(git(project, ['rev-parse', 'HEAD']), head);
    assert.deepEqual(await readFile(join(project, '.git', 'index')), index);
    assert.equal(
      git(project, ['status', '--porcelain', '--untracked-files=all']),
      '?? ringi.config.mjs\n?? tasks/example-task.md\n',
    );
    // The generated profile passes the core validation; the task passes the
    // core parser with that profile.
    const module = await import(
      `${pathToFileURL(join(project, 'ringi.config.mjs')).href}?init-test`
    );
    const resolved = internal.resolveRunnerProfile(module.PROFILE);
    assert.deepEqual(Object.keys(resolved.checks), ['git diff --check']);
    const markdown = await readFile(join(project, EXAMPLE_TASK_PATH), 'utf8');
    assert.equal(markdown, EXAMPLE_TASK);
    const parsed = validateTaskMarkdown(markdown, 'implementation', module.PROFILE);
    assert.deepEqual(parsed.checks, ['git diff --check']);
  } finally {
    await cleanup(project, bin);
  }
});

test('ringi init: gates from package.json scripts, existing files never overwritten', async () => {
  const project = await createProject({
    files: {
      'package.json': `${JSON.stringify({
        packageManager: PACKAGE_MANAGER,
        scripts: { test: 'node --test', lint: 'eslint .', check: 'tsc', build: 'x' },
      })}\n`,
      'AGENTS.md': '# Agents\n',
      'CLAUDE.md': '# Claude\n',
    },
  });
  const bin = await createStubBin();
  try {
    const env = { PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: '1' };
    const first = ringi(project, ['init'], env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(
      first.stdout,
      [
        'created  ringi.config.mjs (gates: pnpm run check, pnpm run lint, pnpm run test, git diff --check)',
        'created  tasks/example-task.md',
        'next     commit ringi.config.mjs before ringi run (ringi init commits nothing; doctor and run refuse an uncommitted profile)',
        'next     ringi doctor',
        '',
      ].join('\n'),
    );
    const module = await import(
      `${pathToFileURL(join(project, 'ringi.config.mjs')).href}?init-gates`
    );
    const resolved = internal.resolveRunnerProfile(module.PROFILE);
    assert.deepEqual(resolved.checkSets.base, [
      'pnpm run check',
      'pnpm run lint',
      'pnpm run test',
      'git diff --check',
    ]);
    assert.deepEqual(resolved.checks['pnpm run lint'].args, ['run', 'lint']);
    assert.deepEqual(
      validateTaskMarkdown(EXAMPLE_TASK, 'implementation', module.PROFILE).checks,
      ['pnpm run check', 'pnpm run lint', 'pnpm run test', 'git diff --check'],
    );
    // The template uses the canonical names of the 'en' task schema.
    assert.deepEqual(
      [...EXAMPLE_TASK.matchAll(/^## (.+)$/gm)].map(([, title]) => title.toLowerCase()),
      resolved.taskSchema.requiredSections,
    );
    assert.deepEqual(
      Object.keys(validateTaskMarkdown(EXAMPLE_TASK, 'implementation', module.PROFILE).sections),
      resolved.taskSchema.requiredSections,
    );

    // Existing files (and a symbolic link in place of the profile) stay.
    await writeFile(join(project, EXAMPLE_TASK_PATH), 'my task\n');
    await rm(join(project, 'ringi.config.mjs'));
    await symlink('missing-target.mjs', join(project, 'ringi.config.mjs'));
    for (const args of [['init', '--dry-run'], ['init']]) {
      const again = ringi(project, args, env);
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /^skip     ringi\.config\.mjs: already exists, not overwritten$/m);
      assert.match(again.stdout, /^skip     tasks\/example-task\.md: already exists, not overwritten$/m);
      assert.doesNotMatch(again.stdout, /^create/m);
    }
    assert.equal(await readFile(join(project, EXAMPLE_TASK_PATH), 'utf8'), 'my task\n');
    assert.equal((await lstat(join(project, 'ringi.config.mjs'))).isSymbolicLink(), true);

    // Outside the repository root or outside Git: an error, nothing written.
    const nested = join(project, 'nested');
    await mkdir(nested);
    const inSubdirectory = ringi(nested, ['init'], env);
    assert.equal(inSubdirectory.status, 1);
    assert.match(inSubdirectory.stderr, /root of the Git repository/);
    await assert.rejects(lstat(join(nested, 'ringi.config.mjs')), /ENOENT/);
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'ringi-cli-nogit-')));
    try {
      const noGit = ringi(outside, ['init'], env);
      assert.equal(noGit.status, 1);
      assert.match(noGit.stderr, /not inside a Git repository/);
      await assert.rejects(lstat(join(outside, 'ringi.config.mjs')), /ENOENT/);
    } finally {
      await cleanup(outside);
    }
  } finally {
    await cleanup(project, bin);
  }
});

// Doctor on a healthy synthetic project, then one broken condition at a
// time: the check fails, the exit code is 1.
test('ringi doctor: every check ok, then each check fails on its own condition', async (t) => {
  const corepack = await createCorepackHome();
  const emptyCorepack = await createCorepackHome({ version: null });
  const bin = await createStubBin({ codex: CODEX_VERSION, claude: CLAUDE_VERSION });
  const binWithoutAgents = await createStubBin();
  const binWithoutClaude = await createStubBin({ codex: CODEX_VERSION });
  const binOldClaude = await createStubBin({ claude: '2.1.200 (Claude Code)' });
  const env = (extra = {}) => ({
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: process.env.HOME,
    COREPACK_HOME: corepack,
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...extra,
  });
  const ids = [
    'node',
    'git-repository',
    // The runner (this checkout) lies outside the test repositories: ok.
    'runner-location',
    'branch',
    'staged-changes',
    'package-manager',
    'corepack-cache',
    'agents-md',
    'claude-md',
    // Before the import of the profile (it was after it, as a warning).
    'profile-committed',
    'profile',
    'providers',
    'repository-layout',
    'implementer-cli',
    'reviewer-cli',
  ];
  const doctor = (cwd, extra) => {
    const child = ringi(cwd, ['doctor', '--json'], env(extra));
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.checks.map(({ id }) => id), ids);
    return { child, result, check: (id) => result.checks.find((c) => c.id === id) };
  };
  const contractPath = join(runnerRoot, 'scripts', 'providers', 'contract.mjs');
  const claudeImplementer = (base) =>
    base.replace(
      'export const PROFILE = {',
      "export const PROFILE = {\n  implementer: { provider: 'claude', model: 'claude-opus-5', effort: 'high', allowedEfforts: ['medium', 'high', 'xhigh'] },",
    );
  const cases = [
    {
      name: 'git-repository',
      outside: true,
      failed: ['git-repository'],
    },
    {
      name: 'git-repository (GIT_DIR set)',
      gitDirectory: true,
      failed: ['git-repository'],
      code: 'INVALID_CONFIGURATION',
      hint: /^Unset GIT_DIR and GIT_WORK_TREE\.$/,
    },
    { name: 'branch main', branch: 'main', failed: ['branch'], code: 'PROTECTED_BRANCH' },
    {
      name: 'branch detached',
      detached: true,
      failed: ['branch'],
      code: 'DETACHED_HEAD',
    },
    { name: 'staged-changes', staged: true, failed: ['staged-changes'], code: 'STAGED_CHANGES' },
    {
      name: 'package-manager',
      files: { 'package.json': '{"name":"synthetic"}\n' },
      failed: ['package-manager'],
      code: 'INVALID_PACKAGE_MANAGER',
    },
    {
      name: 'corepack-cache',
      env: { COREPACK_HOME: emptyCorepack },
      failed: ['corepack-cache'],
      code: 'PNPM_CACHE_MISSING',
    },
    { name: 'agents-md', remove: ['AGENTS.md'], failed: ['agents-md'] },
    { name: 'claude-md', remove: ['CLAUDE.md'], failed: ['claude-md'] },
    {
      name: 'profile missing',
      remove: ['ringi.config.mjs'],
      failed: ['profile'],
      code: 'INVALID_CONFIGURATION',
      hint: /ringi init/,
    },
    {
      name: 'profile invalid',
      files: { 'ringi.config.mjs': "export const PROFILE = { title: 'X', unknown: true };\n" },
      failed: ['profile'],
      code: 'INVALID_CONFIGURATION',
    },
    {
      name: 'providers (role rules)',
      provider: true,
      failed: ['profile', 'providers'],
      code: 'PROVIDER_ROLE_NOT_ALLOWED',
    },
    {
      name: 'repository-layout (claude implementer, submodules)',
      claude: true,
      files: { '.gitmodules': '' },
      failed: ['repository-layout'],
      code: 'IMPLEMENTER_PREFLIGHT_FAILED',
    },
    {
      name: 'implementer-cli missing',
      env: { PATH: `${binWithoutAgents}:/usr/bin:/bin` },
      failed: ['implementer-cli'],
      code: 'PROCESS_ERROR',
    },
    {
      name: 'implementer-cli version (claude implementer)',
      claude: true,
      env: { PATH: `${binOldClaude}:/usr/bin:/bin` },
      failed: ['implementer-cli'],
      code: 'IMPLEMENTER_PREFLIGHT_FAILED',
    },
    {
      name: 'reviewer-cli missing',
      env: { PATH: `${binWithoutClaude}:/usr/bin:/bin` },
      failed: ['reviewer-cli'],
    },
  ];
  try {
    await t.test('healthy: all ok, table and JSON, exit 0', async (st) => {
      const project = await createProject({ files: healthyFiles() });
      try {
        const { child, result } = doctor(project);
        assert.equal(child.status, 0, child.stdout);
        assert.equal(result.status, 'ok');
        assert.deepEqual(result.summary, { ok: ids.length, warn: 0, fail: 0 });
        assert.ok(result.checks.every((check) => check.hint === null));
        const table = ringi(join(project), ['doctor'], env());
        assert.equal(table.status, 0);
        assert.equal(table.stdout, formatDoctorTable(result));
        assert.match(table.stdout, /^STATUS  CHECK +DETAIL$/m);
        assert.match(table.stdout, /^ok +implementer-cli +codex: codex-cli 0\.147\.0$/m);
        assert.match(table.stdout, /^ok +reviewer-cli +claude: 2\.1\.290 \(Claude Code\)$/m);
        assert.match(table.stdout, /^ok +runner-location +runner installed outside the repository$/m);
        assert.match(table.stdout, /ringi doctor: 15 ok, 0 warn, 0 fail\n$/);
        assert.match(
          table.stdout,
          /^ok +profile-committed +ringi\.config\.mjs is committed and matches HEAD \(checked before the import\)$/m,
        );
        const profileHash = createHash('sha256')
          .update(JSON.stringify([{
            path: 'ringi.config.mjs',
            sha256: createHash('sha256').update(healthyFiles()['ringi.config.mjs']).digest('hex'),
          }]))
          .digest('hex');
        assert.match(
          table.stdout,
          new RegExp(`^ok +profile +ringi\\.config\\.mjs valid; 1 module\\(s\\), sha256 ${profileHash.slice(0, 12)}$`, 'm'),
        );
        st.diagnostic(`$ ringi doctor\n${table.stdout}`);
        // The same project on main: one failed check, exit 1.
        git(project, ['switch', '--quiet', 'main']);
        const failing = ringi(project, ['doctor'], env());
        assert.equal(failing.status, 1);
        assert.match(failing.stdout, /^fail +branch +on main; the runner refuses main and master$/m);
        st.diagnostic(`$ ringi doctor   # on main\n${failing.stdout}`);
        git(project, ['switch', '--quiet', 'feat/ringi-test']);
        // Read-only: nothing new in the working tree.
        assert.equal(git(project, ['status', '--porcelain', '--untracked-files=all']), '');
      } finally {
        await cleanup(project);
      }
    });
    // Changed behaviour: profile-committed was a warning after the import;
    // now it fails before it and the profile is not imported.
    await t.test('profile-committed: an uncommitted ringi.config.mjs fails without its import; an uncommitted local module fails profile; exit 1', async () => {
      const { 'ringi.config.mjs': _profile, ...files } = healthyFiles();
      const project = await createProject({ files });
      const markers = await realpath(await mkdtemp(join(tmpdir(), 'ringi-cli-marker-')));
      const marker = join(markers, 'imported');
      try {
        const profile = `import './ringi/extra.mjs';\n${markingProfile(marker)}`;
        const expectNotImported = (failed) => {
          const { child, result, check } = doctor(project);
          assert.equal(child.status, 1, child.stdout);
          assert.deepEqual(
            result.checks.filter(({ status }) => status === 'fail').map(({ id }) => id),
            failed,
          );
          const entry = check('profile-committed');
          assert.equal(entry.code, 'PROFILE_UNCOMMITTED');
          assert.match(
            entry.detail,
            /^PROFILE_UNCOMMITTED: Not committed or different from HEAD \(untracked, changed in the working tree or in the index, flagged skip-worktree or assume-unchanged\): ringi\.config\.mjs\. .*ringi\.config\.mjs was not imported\.$/,
          );
          assert.match(entry.hint, /^Review the change \(git diff HEAD -- ringi\.config\.mjs\) and commit it/);
          for (const id of ['profile', 'providers', 'repository-layout', 'implementer-cli', 'reviewer-cli'])
            assert.equal(check(id).detail, 'not checked: profile-committed failed', id);
        };
        // Untracked.
        await writeFiles(project, { 'ringi.config.mjs': profile, 'ringi/extra.mjs': 'export {};\n' });
        expectNotImported(['profile-committed']);
        // Added to the index only.
        git(project, ['add', 'ringi.config.mjs']);
        expectNotImported(['staged-changes', 'profile-committed']);
        git(project, ['commit', '--quiet', '-m', 'test: profile']);
        // Changed in the working tree, then in the index.
        await writeFile(join(project, 'ringi.config.mjs'), `${profile}// edit\n`);
        expectNotImported(['profile-committed']);
        git(project, ['add', 'ringi.config.mjs']);
        expectNotImported(['staged-changes', 'profile-committed']);
        await assert.rejects(lstat(marker), /ENOENT/);
        git(project, ['checkout', '--quiet', 'HEAD', '--', 'ringi.config.mjs']);
        // Committed, with an untracked local module: the load ran (its code
        // and that of its imports), the check after it fails profile.
        const { child, result, check } = doctor(project);
        assert.equal(child.status, 1, child.stdout);
        assert.equal(check('profile-committed').status, 'ok');
        assert.deepEqual(
          result.checks.filter(({ status }) => status === 'fail').map(({ id }) => id),
          ['profile'],
        );
        assert.equal(check('profile').code, 'PROFILE_UNCOMMITTED');
        assert.match(check('profile').detail, /: ringi\/extra\.mjs\. .*the modules it imports were loaded, no agent was started\.$/);
        assert.match(check('profile').hint, /commit it before a run/);
        await lstat(marker);
        git(project, ['add', 'ringi/extra.mjs']);
        git(project, ['commit', '--quiet', '-m', 'test: extra']);
        const committed = doctor(project);
        assert.equal(committed.child.status, 0, committed.child.stdout);
        assert.deepEqual(committed.result.summary, { ok: ids.length, warn: 0, fail: 0 });
      } finally {
        await cleanup(project, markers);
      }
    });
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        let files = healthyFiles();
        if (scenario.claude) files['ringi.config.mjs'] = claudeImplementer(files['ringi.config.mjs']);
        files = { ...files, ...scenario.files };
        for (const name of scenario.remove ?? []) delete files[name];
        const project = scenario.outside
          ? await realpath(await mkdtemp(join(tmpdir(), 'ringi-cli-nogit-')))
          : await createProject({ branch: scenario.branch, files });
        try {
          if (scenario.provider) {
            const providerFile = join(project, 'ringi', 'provider.mjs');
            const fromProvider = (path) => relative(join(project, 'ringi'), path);
            await writeFiles(project, {
              // A plain module object (defineProvider would refuse it on
              // import), so the core's role rules refuse it in validation.
              'ringi/provider.mjs': [
                `import { PROVIDER_ROLES } from ${JSON.stringify(fromProvider(contractPath))};`,
                `import base from ${JSON.stringify(fromProvider(join(runnerRoot, 'examples', 'providers', 'example-provider.mjs')))};`,
                'export default { ...base, roles: [...PROVIDER_ROLES], implementer: { ...base.implementer,',
                "  security: { ...base.implementer.security, sandboxByMode: { status: 'not-supported', reason: 'Synthetic.' } } } };",
                '',
              ].join('\n'),
              'ringi.config.mjs': files['ringi.config.mjs']
                .replace(
                  'export const PROFILE = {',
                  "import provider from './ringi/provider.mjs';\nexport const PROFILE = {\n  providerModules: [provider],\n  implementer: { provider: 'example-agent', model: 'example-large-1', effort: 'medium', allowedEfforts: ['medium'] },",
                ),
            });
            await lstat(providerFile);
            git(project, ['add', '-A']);
            git(project, ['commit', '--quiet', '-m', 'test: provider']);
          }
          if (scenario.detached)
            git(project, ['switch', '--quiet', '--detach', 'HEAD']);
          if (scenario.staged) {
            await writeFile(join(project, 'staged.txt'), 'staged\n');
            git(project, ['add', 'staged.txt']);
          }
          const { child, result, check } = doctor(
            project,
            scenario.gitDirectory ? { GIT_DIR: join(project, '.git') } : scenario.env,
          );
          assert.equal(child.status, 1, child.stdout);
          assert.equal(result.status, 'fail');
          const failed = result.checks
            .filter(({ status }) => status === 'fail')
            .map(({ id }) => id);
          assert.deepEqual(failed, scenario.failed, JSON.stringify(result.checks));
          const first = check(scenario.failed.at(-1));
          assert.equal(typeof first.hint, 'string');
          assert.ok(first.hint.length > 0);
          if (scenario.code) assert.equal(check(scenario.failed[0]).code, scenario.code);
          if (scenario.hint) assert.match(check(scenario.failed[0]).hint, scenario.hint);
          for (const entry of result.checks) {
            if (entry.status === 'ok') assert.equal(entry.hint, null, entry.id);
            if (entry.status === 'warn') assert.match(entry.detail, /^not checked: /);
          }
        } finally {
          await cleanup(project);
        }
      });
    }
    await t.test('node below 24 fails (same checks, in process)', async () => {
      const project = await createProject({ files: healthyFiles() });
      try {
        const result = await runDoctor({
          cwd: project,
          nodeVersion: '22.11.0',
          environment: { COREPACK_HOME: corepack },
          runner: {
            async run(program, args, options = {}) {
              if (program === 'git') {
                const child = spawnSync(realGit, args, {
                  cwd: options.cwd,
                  env: options.env ?? gitEnvironment,
                  encoding: 'utf8',
                });
                return { code: child.status, signal: null, stdout: child.stdout, stderr: child.stderr, timedOut: false };
              }
              const versions = { codex: CODEX_VERSION, claude: CLAUDE_VERSION };
              return { code: 0, signal: null, stdout: `${versions[program]}\n`, stderr: '', timedOut: false };
            },
            isCancelled: () => false,
          },
        });
        assert.equal(result.status, 'fail');
        assert.deepEqual(
          result.checks.filter(({ status }) => status !== 'ok').map(({ id }) => id),
          ['node'],
        );
        assert.equal(result.checks[0].detail, 'Node.js 22.11.0');
      } finally {
        await cleanup(project);
      }
    });
  } finally {
    await cleanup(corepack, emptyCorepack, bin, binWithoutAgents, binWithoutClaude, binOldClaude);
  }
});

test('ringi run: profile errors stop with INVALID_CONFIGURATION before any process', async (t) => {
  const bin = await createStubBin({ codex: CODEX_VERSION, claude: CLAUDE_VERSION });
  const outsideDirectory = await realpath(await mkdtemp(join(tmpdir(), 'ringi-cli-outside-')));
  const env = { PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  await writeFile(join(outsideDirectory, 'outside.mjs'), 'export const CHECKS = {};\n');
  const base = healthyFiles();
  const importing = (line) =>
    `${line}\n${base['ringi.config.mjs']}`;
  const cases = [
    ['missing', {}, /not found at the repository root\. Run `ringi init`/],
    // The Polish message of an invalid profile, with locale 'pl'.
    ['invalid profile', { 'ringi.config.mjs': "export const PROFILE = { locale: 'pl', title: 7 };\n" }, /Niepoprawny profil runnera/],
    ['invalid profile (en)', { 'ringi.config.mjs': 'export const PROFILE = { title: 7 };\n' }, /Invalid runner profile/],
    ['invalid locale', { 'ringi.config.mjs': "export const PROFILE = { locale: 'de' };\n" }, /Invalid runner profile/],
    ['no export', { 'ringi.config.mjs': 'export const OTHER = 1;\n' }, /must export PROFILE or a default export/],
    ['package import', { 'ringi.config.mjs': importing("import 'typescript';") }, /Node\.js built-ins and relative paths/],
    ['absolute import', { 'ringi.config.mjs': importing(`import ${JSON.stringify(join(outsideDirectory, 'outside.mjs'))};`) }, /Node\.js built-ins and relative paths/],
    ['outside import', { 'ringi.config.mjs': 'OUTSIDE' }, /from outside the repository/],
    ['symlinked import', { 'ringi.config.mjs': importing("import './ringi/linked.mjs';"), 'ringi/real.mjs': 'export {};\n' }, /symbolic links are refused/],
    ['symlinked profile', { 'ringi/real.mjs': base['ringi.config.mjs'] }, /must be a regular file/],
    ['CommonJS module', { 'ringi.config.mjs': importing("import './ringi/legacy.cjs';"), 'ringi/legacy.cjs': 'module.exports = {};\n' }, /must be an ES module or a JSON file/],
  ];
  try {
    for (const [name, files, message] of cases) {
      await t.test(name, async () => {
        const project = await createProject({
          files: {
            'AGENTS.md': base['AGENTS.md'],
            'CLAUDE.md': base['CLAUDE.md'],
            'package.json': base['package.json'],
            ...files,
          },
        });
        try {
          if (files['ringi.config.mjs'] === 'OUTSIDE') {
            const specifier = relative(project, join(outsideDirectory, 'outside.mjs'));
            await writeFile(
              join(project, 'ringi.config.mjs'),
              importing(`import ${JSON.stringify(specifier.startsWith('.') ? specifier : `./${specifier}`)};`),
            );
          }
          if (name === 'symlinked import')
            await symlink('real.mjs', join(project, 'ringi', 'linked.mjs'));
          if (name === 'symlinked profile')
            await symlink('ringi/real.mjs', join(project, 'ringi.config.mjs'));
          // Committed: the stop comes from the load, not from the Git status
          // check before it (PROFILE_UNCOMMITTED).
          if (files['ringi.config.mjs'] === 'OUTSIDE' || name === 'symlinked profile') {
            git(project, ['add', '-A']);
            git(project, ['commit', '--quiet', '-m', 'test: profile']);
          }
          const child = ringi(project, ['run', 'tasks/missing.md', '--dry-run', '--json'], env);
          assert.equal(child.status, 1, child.stderr);
          const report = JSON.parse(child.stdout);
          assert.equal(report.status, 'STOPPED');
          assert.equal(report.code, 'INVALID_CONFIGURATION');
          assert.equal(report.stage, 'preflight');
          assert.match(report.error, message);
          assert.match(child.stderr, /^code=INVALID_CONFIGURATION \| stage=preflight \| error=/);
        } finally {
          await cleanup(project);
        }
      });
    }
    await t.test('outside Git and invalid options: exit 2', async () => {
      const notGit = ringi(outsideDirectory, ['run', 'task.md'], env);
      assert.equal(notGit.status, 2);
      assert.match(notGit.stderr, /ringi run: not inside a Git repository/);
      // The runner's parser message in Polish, with locale 'pl'; the
      // usage of ringi run stays English.
      assert.ok(base['ringi.config.mjs'].includes("  locale: 'en',\n"));
      const project = await createProject({
        files: {
          ...base,
          'ringi.config.mjs': base['ringi.config.mjs'].replace(
            "  locale: 'en',\n",
            "  locale: 'pl',\n",
          ),
        },
      });
      try {
        const child = ringi(project, ['run', 'task.md', '--unknown'], env);
        assert.equal(child.status, 2);
        assert.equal(child.stdout, '');
        assert.match(child.stderr, /Nieznana opcja: --unknown\nUsage: ringi run path\/to\/task\.md \[--task-mode implementation\|analysis\]/);
        assert.match(child.stderr, /critical-opus: model claude-opus-5; effort xhigh; attempts 1; fallback none\./);
      } finally {
        await cleanup(project);
      }
    });
    await t.test('GIT_DIR or GIT_WORK_TREE set: run and init refuse, the profile is not loaded', async () => {
      const project = await createProject({ files: base });
      try {
        for (const extra of [
          { GIT_DIR: join(project, '.git') },
          { GIT_WORK_TREE: project },
          { GIT_DIR: join(project, '.git'), GIT_WORK_TREE: project },
        ]) {
          const names = Object.keys(extra).join(' and ');
          const run = ringi(project, ['run', 'task.md', '--dry-run', '--json'], { ...env, ...extra });
          assert.equal(run.status, 1, run.stderr);
          const report = JSON.parse(run.stdout);
          assert.equal(report.code, 'INVALID_CONFIGURATION');
          assert.match(report.error, new RegExp(`^${names} (is|are) set; ringi finds the repository from the current directory only`));
          assert.match(report.resume, /^Unset GIT_DIR and GIT_WORK_TREE/);
          const init = ringi(project, ['init', '--dry-run'], { ...env, ...extra });
          assert.equal(init.status, 1);
          assert.match(init.stderr, new RegExp(`^ringi init: ${names} (is|are) set`));
        }
      } finally {
        await cleanup(project);
      }
    });
  } finally {
    await cleanup(bin, outsideDirectory);
  }
});

test('ringi run: an uncommitted ringi.config.mjs stops with PROFILE_UNCOMMITTED before its import, an uncommitted local module before any agent', async () => {
  const markers = await realpath(await mkdtemp(join(tmpdir(), 'ringi-cli-marker-')));
  const marker = join(markers, 'imported');
  const agentMarker = join(markers, 'agent');
  // Agent CLIs that leave a marker whenever they are started.
  const bin = await createStubBin();
  for (const name of ['codex', 'claude']) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\necho ${name} >> ${JSON.stringify(agentMarker)}\nexit 64\n`,
    );
    await chmod(join(bin, name), 0o755);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const { 'ringi.config.mjs': _profile, ...files } = healthyFiles();
  const project = await createProject({ files });
  const profile = `import './ringi/local.mjs';\n${markingProfile(marker)}`;
  const stopped = (paths, args = ['--dry-run', '--json']) => {
    const child = ringi(project, ['run', 'tasks/missing.md', ...args], env);
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /^code=PROFILE_UNCOMMITTED \| stage=preflight \| error=Not committed or different from HEAD /m);
    if (!args.includes('--json')) return child.stderr;
    const report = JSON.parse(child.stdout);
    assert.equal(report.status, 'STOPPED');
    assert.equal(report.code, 'PROFILE_UNCOMMITTED');
    assert.equal(report.stage, 'preflight');
    assert.match(
      report.error,
      new RegExp(`^Not committed or different from HEAD \\(untracked, changed in the working tree or in the index, flagged skip-worktree or assume-unchanged\\): ${paths.replaceAll('.', '\\.')}\\. ringi runs only a committed profile; `),
    );
    assert.match(report.resume, /commit ringi\.config\.mjs and the modules it imports first/);
    return report.error;
  };
  try {
    // Untracked, added to the index, changed in the working tree, changed
    // in the index: not imported.
    await writeFiles(project, { 'ringi.config.mjs': profile, 'ringi/local.mjs': 'export {};\n' });
    assert.match(stopped('ringi.config.mjs'), /ringi\.config\.mjs was not imported\.$/);
    assert.match(stopped('ringi.config.mjs', []), /ringi\.config\.mjs was not imported\./);
    git(project, ['add', 'ringi.config.mjs']);
    stopped('ringi.config.mjs');
    git(project, ['commit', '--quiet', '-m', 'test: profile']);
    await writeFile(join(project, 'ringi.config.mjs'), `${profile}// edit\n`);
    stopped('ringi.config.mjs');
    git(project, ['add', 'ringi.config.mjs']);
    stopped('ringi.config.mjs');
    await assert.rejects(lstat(marker), /ENOENT/);
    git(project, ['checkout', '--quiet', 'HEAD', '--', 'ringi.config.mjs']);
    // Committed, with an untracked, then a changed local module: loaded,
    // then stopped before any agent process.
    assert.match(stopped('ringi/local.mjs'), /the modules it imports were loaded, no agent was started\.$/);
    await lstat(marker);
    git(project, ['add', 'ringi/local.mjs']);
    git(project, ['commit', '--quiet', '-m', 'test: local module']);
    await writeFile(join(project, 'ringi', 'local.mjs'), 'export const CHANGED = 1;\n');
    stopped('ringi/local.mjs');
    stopped('ringi/local.mjs', []);
    await assert.rejects(lstat(agentMarker), /ENOENT/);
  } finally {
    await cleanup(project, bin, markers);
  }
});

// git status trusts index flags, core.fsmonitor and .gitattributes; the
// check compares the bytes on disk with the blob in HEAD and runs none of it.
test('ringi run: a profile change hidden from git status (skip-worktree, assume-unchanged, ident, a lying core.fsmonitor) stops with PROFILE_UNCOMMITTED; the fsmonitor is not run', async () => {
  const markers = await realpath(await mkdtemp(join(tmpdir(), 'ringi-cli-marker-')));
  const marker = join(markers, 'imported');
  const agentMarker = join(markers, 'agent');
  const monitorMarker = join(markers, 'fsmonitor');
  const bin = await createStubBin();
  for (const name of ['codex', 'claude']) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\necho ${name} >> ${JSON.stringify(agentMarker)}\nexit 64\n`,
    );
    await chmod(join(bin, name), 0o755);
  }
  // A fsmonitor hook that leaves a marker and reports no change.
  const monitor = join(markers, 'fsmonitor.sh');
  await writeFile(
    monitor,
    `#!/bin/sh\necho run >> ${JSON.stringify(monitorMarker)}\nprintf 'token\\0'\n`,
  );
  await chmod(monitor, 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const { 'ringi.config.mjs': _profile, ...files } = healthyFiles();
  const profile = `import './ringi/local.mjs';\nvoid "$Id$";\n${markingProfile(marker)}`;
  const local = 'export {};\n';
  const project = await createProject({
    files: { ...files, 'ringi.config.mjs': profile, 'ringi/local.mjs': local },
  });
  const run = () => ringi(project, ['run', 'tasks/missing.md', '--dry-run', '--json'], env);
  const stopped = (path) => {
    const child = run();
    assert.equal(child.status, 1, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.code, 'PROFILE_UNCOMMITTED', report.error);
    assert.match(report.error, new RegExp(`\\): ${path.replaceAll('.', '\\.')}\\. `));
    return report.error;
  };
  const statusClean = () =>
    assert.equal(git(project, ['status', '--porcelain', '--untracked-files=all']), '');
  try {
    const cases = [
      ['ringi.config.mjs', `${profile}// edit\n`, ['update-index', '--skip-worktree']],
      ['ringi.config.mjs', `${profile}// edit\n`, ['update-index', '--assume-unchanged']],
      ['ringi/local.mjs', 'export const CHANGED = 1;\n', ['update-index', '--skip-worktree']],
      ['ringi/local.mjs', 'export const CHANGED = 1;\n', ['update-index', '--assume-unchanged']],
    ];
    for (const [path, content, flag] of cases) {
      await writeFile(join(project, path), content);
      git(project, [...flag, '--', path]);
      statusClean();
      const error = stopped(path);
      if (path === 'ringi.config.mjs') {
        assert.match(error, /ringi\.config\.mjs was not imported\.$/);
        await assert.rejects(lstat(marker), /ENOENT/);
      } else {
        assert.match(error, /no agent was started\.$/);
        await rm(marker);
      }
      git(project, [flag[0], flag[1].replace('--', '--no-'), '--', path]);
      git(project, ['checkout', '--quiet', 'HEAD', '--', path]);
    }
    // A .gitattributes conversion: ident hides code inside $Id: ...$ (of
    // the same size as the checked-out file); git status sees no change.
    await writeFile(join(project, '.gitattributes'), 'ringi.config.mjs ident\n');
    git(project, ['add', '.gitattributes']);
    git(project, ['commit', '--quiet', '-m', 'test: ident']);
    await rm(join(project, 'ringi.config.mjs'));
    git(project, ['checkout', '--quiet', 'HEAD', '--', 'ringi.config.mjs']);
    const expanded = await readFile(join(project, 'ringi.config.mjs'), 'utf8');
    const [id] = expanded.match(/\$Id: [0-9a-f]+ \$/);
    const hidden = '$Id: ";globalThis.hidden=1;//';
    await writeFile(
      join(project, 'ringi.config.mjs'),
      expanded.replace(id, `${hidden.padEnd(id.length - 1)}$`),
    );
    statusClean();
    stopped('ringi.config.mjs');
    await assert.rejects(lstat(marker), /ENOENT/);
    git(project, ['rm', '--quiet', '.gitattributes']);
    git(project, ['commit', '--quiet', '-m', 'test: no ident']);
    git(project, ['checkout', '--quiet', 'HEAD', '--', 'ringi.config.mjs']);
    // A lying fsmonitor: never started by the check, for the profile and
    // for a module it imports.
    git(project, ['config', 'core.fsmonitor', monitor]);
    await rm(monitorMarker, { force: true });
    await writeFile(join(project, 'ringi.config.mjs'), `${profile}// edit\n`);
    stopped('ringi.config.mjs');
    await assert.rejects(lstat(marker), /ENOENT/);
    await assert.rejects(lstat(monitorMarker), /ENOENT/);
    await writeFile(join(project, 'ringi.config.mjs'), profile);
    await writeFile(join(project, 'ringi/local.mjs'), 'export const CHANGED = 1;\n');
    stopped('ringi/local.mjs');
    await rm(marker);
    await assert.rejects(lstat(monitorMarker), /ENOENT/);
    // git status does start it: the hook is configured.
    git(project, ['status', '--porcelain']);
    await lstat(monitorMarker);
    git(project, ['config', '--unset', 'core.fsmonitor']);
    git(project, ['checkout', '--quiet', 'HEAD', '--', 'ringi/local.mjs']);
    // Committed and unchanged: imported, past the check as before.
    const child = run();
    const report = JSON.parse(child.stdout);
    assert.notEqual(report.code, 'PROFILE_UNCOMMITTED', report.error);
    await lstat(marker);
    await assert.rejects(lstat(agentMarker), /ENOENT/);
  } finally {
    await cleanup(project, bin, markers);
  }
});

// FIFOs come from mkfifo; Node.js has no API to create one.
const hasMkfifo = spawnSync('mkfifo', ['--version'], { encoding: 'utf8' }).error === undefined;

test('ringi profile loader: a FIFO is refused without blocking; a failed module load and a require through createRequire(fileURLToPath(import.meta.url)) fail the load', async (t) => {
  const libraryUrl = pathToFileURL(join(scriptDirectory, 'agent-review-loop-lib.mjs')).href;
  const profile = healthyFiles()['ringi.config.mjs'];
  const repository = async (files) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'ringi-cli-loader-')));
    await writeFiles(directory, files);
    return directory;
  };
  // In a child process with a time limit: a blocking open would hang it.
  const inChild = (root, body) => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          `const lib = await import(${JSON.stringify(libraryUrl)});`,
          "import { rmSync } from 'node:fs';",
          "import { spawnSync } from 'node:child_process';",
          'try {',
          body,
          "  console.log('no error');",
          '} catch (error) {',
          '  console.log(JSON.stringify({ code: error.code, message: error.message }));',
          '}',
        ].join('\n'),
      ],
      { cwd: root, env: { ...process.env, RINGI_TEST_ROOT: root }, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(child.error, undefined, 'the child finished in time');
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const fifo = (path) => {
    const child = spawnSync('mkfifo', [path], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  };
  const skip = hasMkfifo ? false : 'mkfifo is not available on this platform';

  await t.test('ringi.config.mjs is a FIFO: INVALID_CONFIGURATION', { skip }, async () => {
    const root = await repository({});
    try {
      fifo(join(root, 'ringi.config.mjs'));
      const outcome = inChild(root, '  await lib.loadProjectProfile({ repositoryRoot: process.env.RINGI_TEST_ROOT });');
      assert.equal(outcome.code, 'INVALID_CONFIGURATION');
      assert.match(outcome.message, /must be a regular file/);
    } finally {
      await cleanup(root);
    }
  });
  await t.test('an imported module is a FIFO: INVALID_CONFIGURATION', { skip }, async () => {
    const root = await repository({ 'ringi.config.mjs': `import './ringi/pipe.mjs';\n${profile}` });
    try {
      await mkdir(join(root, 'ringi'));
      fifo(join(root, 'ringi', 'pipe.mjs'));
      const outcome = inChild(root, '  await lib.loadProjectProfile({ repositoryRoot: process.env.RINGI_TEST_ROOT });');
      assert.equal(outcome.code, 'INVALID_CONFIGURATION');
      assert.match(outcome.message, /ringi\/pipe\.mjs is not a readable regular file/);
    } finally {
      await cleanup(root);
    }
  });
  await t.test('a module replaced by a FIFO during the run: PROFILE_MODIFIED, no blocking', { skip }, async () => {
    const root = await repository({
      'ringi.config.mjs': `import './ringi/local.mjs';\n${profile}`,
      'ringi/local.mjs': 'export {};\n',
    });
    try {
      const outcome = inChild(
        root,
        [
          '  const { projectProfile } = await lib.loadProjectProfile({ repositoryRoot: process.env.RINGI_TEST_ROOT });',
          "  const local = process.env.RINGI_TEST_ROOT + '/ringi/local.mjs';",
          '  rmSync(local);',
          "  if (spawnSync('mkfifo', [local]).status !== 0) throw new Error('mkfifo failed');",
          "  await lib.internal.assertProjectProfileUnchanged(projectProfile, 'post-codex');",
        ].join('\n'),
      );
      assert.equal(outcome.code, 'PROFILE_MODIFIED');
      assert.match(outcome.message, /"ringi\/local\.mjs"/);
    } finally {
      await cleanup(root);
    }
  });
  await t.test('a module Node.js cannot load, caught by the profile: INVALID_CONFIGURATION', async () => {
    const root = await repository({
      'ringi.config.mjs': `try { await import('./ringi/data.txt'); } catch {}\n${profile}`,
      'ringi/data.txt': 'text\n',
    });
    try {
      const outcome = inChild(root, '  await lib.loadProjectProfile({ repositoryRoot: process.env.RINGI_TEST_ROOT });');
      assert.equal(outcome.code, 'INVALID_CONFIGURATION');
      assert.match(outcome.message, /ringi\/data\.txt cannot be loaded as a module/);
    } finally {
      await cleanup(root);
    }
  });
  await t.test('require through createRequire(fileURLToPath(import.meta.url)), caught by the profile: INVALID_CONFIGURATION', async () => {
    const root = await repository({
      'ringi.config.mjs': [
        "import { createRequire } from 'node:module';",
        "import { fileURLToPath } from 'node:url';",
        'const require = createRequire(fileURLToPath(import.meta.url));',
        "try { require('./ringi/data.json'); } catch {}",
        profile,
      ].join('\n'),
      'ringi/data.json': '{}\n',
    });
    try {
      const outcome = inChild(root, '  await lib.loadProjectProfile({ repositoryRoot: process.env.RINGI_TEST_ROOT });');
      assert.equal(outcome.code, 'INVALID_CONFIGURATION');
      assert.match(
        outcome.message,
        /^ringi\.config\.mjs requires "\.\/ringi\/data\.json"; profile modules load other modules with import only\.$/,
      );
    } finally {
      await cleanup(root);
    }
  });
});

// The full preflight of a dry-run needs the real pnpm (offline, from the
// local Corepack cache) and installed dependencies, as in the pnpm runtime
// tests of agent-review-loop.test.mjs.
async function createPnpmProject() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ringi-cli-run-')));
  const installEnvironment = join(directory, '.install-environment');
  await mkdir(join(installEnvironment, 'home'), { recursive: true });
  await mkdir(join(installEnvironment, 'xdg-data'), { recursive: true });
  await writeFile(join(installEnvironment, 'npmrc'), '');
  await writeFiles(directory, {
    'synthetic-dep/package.json': `${JSON.stringify({ name: 'synthetic-dep', version: '1.0.0', main: 'index.js' }, null, 2)}\n`,
    'synthetic-dep/index.js': "module.exports = 'synthetic';\n",
    '.gitignore': 'node_modules/\n.install-environment/\n.agent-review-loop/\n',
    'pnpm-workspace.yaml': 'packages: []\n',
    'package.json': `${JSON.stringify(
      {
        name: 'synthetic-ringi-run',
        private: true,
        packageManager: PACKAGE_MANAGER,
        scripts: { test: 'node -e ""' },
        dependencies: { 'synthetic-dep': 'file:./synthetic-dep' },
      },
      null,
      2,
    )}\n`,
    'AGENTS.md': '# Agents\n\nSynthetic rules.\n',
    'CLAUDE.md': '# Claude\n\nSynthetic rules.\n',
  });
  const pnpm = join(
    internal.resolveCorepackHome(process.env),
    'v1',
    'pnpm',
    PNPM_VERSION,
    'bin',
    'pnpm.mjs',
  );
  const install = spawnSync(pnpm, ['install', '--offline', '--ignore-scripts'], {
    cwd: directory,
    encoding: 'utf8',
    shell: false,
    env: {
      PATH: `${dirname(realGit)}:${process.env.PATH}`,
      HOME: join(installEnvironment, 'home'),
      XDG_DATA_HOME: join(installEnvironment, 'xdg-data'),
      NPM_CONFIG_USERCONFIG: join(installEnvironment, 'npmrc'),
      COREPACK_HOME: internal.resolveCorepackHome(process.env),
      COREPACK_ENABLE_NETWORK: '0',
      NO_COLOR: '1',
    },
  });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  return directory;
}

test('ringi run --dry-run: profile from ringi.config.mjs, same plan as scripts/agent-review-loop.mjs', async () => {
  const project = await createPnpmProject();
  const bin = await createStubBin({ codex: CODEX_VERSION, claude: CLAUDE_VERSION });
  try {
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NO_COLOR: '1',
    };
    delete env.CI;
    // node --test sets FORCE_COLOR for a terminal; with NO_COLOR Node warns
    // on stderr, which the test expects empty.
    delete env.FORCE_COLOR;
    git(project, ['init', '--quiet', '--initial-branch', 'main']);
    git(project, ['config', 'user.name', 'Synthetic Tester']);
    git(project, ['config', 'user.email', 'tester@example.invalid']);
    git(project, ['config', 'commit.gpgsign', 'false']);
    const init = ringi(project, ['init'], env);
    assert.equal(init.status, 0, init.stderr);
    // The local import and the runner copy of the old CLI, committed.
    const profile = (await readFile(join(project, 'ringi.config.mjs'), 'utf8')).replace(
      "  requiredGateRules: [],",
      "  requiredGateRules: RULES,",
    );
    await writeFiles(project, {
      'ringi.config.mjs': `import { RULES } from './ringi/rules.mjs';\n${profile}`,
      'ringi/rules.mjs': 'export const RULES = [];\n',
      'scripts/agent-review-profile.mjs': `import { RULES } from '../ringi/rules.mjs';\n${profile}`,
    });
    for (const name of [
      'agent-review-loop.mjs',
      'agent-review-loop-lib.mjs',
      'agent-review-dashboard.mjs',
      'agent-review-prompts.mjs',
      'agent-review-providers.mjs',
      'providers/contract.mjs',
      'providers/codex.mjs',
      'providers/claude.mjs',
      'messages/index.mjs',
      'messages/en.mjs',
      'messages/pl.mjs',
    ]) {
      await mkdir(dirname(join(project, 'scripts', name)), { recursive: true });
      await copyFile(join(scriptDirectory, name), join(project, 'scripts', name));
    }
    git(project, ['add', '-A']);
    git(project, ['commit', '--quiet', '-m', 'test: baseline']);
    git(project, ['switch', '--quiet', '-c', 'feat/ringi-run']);

    // ringi run from a subdirectory: the repository root is found by Git.
    const child = ringi(join(project, 'tasks'), ['run', EXAMPLE_TASK_PATH, '--dry-run'], env);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const plan = JSON.parse(child.stdout);
    assert.equal(plan.status, 'DRY_RUN_OK');
    assert.deepEqual(plan.checks, ['pnpm run test', 'git diff --check']);
    assert.deepEqual(
      plan.projectProfile.files.map(({ path }) => path),
      ['ringi.config.mjs', 'ringi/rules.mjs'],
    );
    assert.equal(plan.projectProfile.path, 'ringi.config.mjs');
    assert.match(plan.projectProfile.sha256, /^[0-9a-f]{64}$/);
    const fileHashes = await Promise.all(
      ['ringi.config.mjs', 'ringi/rules.mjs'].map(async (path) =>
        createHash('sha256')
          .update(await readFile(join(project, path)))
          .digest('hex'),
      ),
    );
    assert.deepEqual(plan.projectProfile.files.map(({ sha256 }) => sha256), fileHashes);
    assert.equal(plan.projectProfile.committed, true);
    assert.deepEqual(plan.projectProfile.uncommitted, []);

    // The old CLI with the same profile as its module: the same plan apart
    // from the run ID and the profile field.
    const legacy = spawnSync(
      process.execPath,
      [join(project, 'scripts', 'agent-review-loop.mjs'), EXAMPLE_TASK_PATH, '--dry-run'],
      { cwd: project, env, encoding: 'utf8', shell: false },
    );
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(legacy.stderr, '');
    const legacyPlan = JSON.parse(legacy.stdout);
    assert.equal(Object.hasOwn(legacyPlan, 'projectProfile'), false);
    // The runner field: ringi fingerprints this checkout (both entry
    // points), the old CLI its copy of scripts/ (its entry point only).
    assert.ok(plan.runner.files.some(({ path }) => path === 'bin/ringi.mjs'));
    assert.equal(legacyPlan.runner.files.some(({ path }) => path === 'bin/ringi.mjs'), false);
    assert.ok(legacyPlan.runner.files.some(({ path }) => path === 'scripts/agent-review-loop-lib.mjs'));
    const comparable = (value) => {
      const copy = { ...value };
      delete copy.runId;
      delete copy.projectProfile;
      delete copy.runner;
      return JSON.stringify(copy);
    };
    assert.equal(comparable(plan), comparable(legacyPlan));
    assert.equal(git(project, ['status', '--porcelain', '--untracked-files=all']), '');
  } finally {
    await cleanup(project, bin);
  }
});
