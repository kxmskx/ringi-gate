// Tests of the npm package: the file list of `npm pack` and an installation
// of the packed tarball in synthetic projects in the system temporary
// directory. No network: npm runs with --offline and an empty cache of its
// own, pnpm runs offline from the local Corepack cache; the tarball has no
// dependencies, so nothing is fetched. Imported by agent-review-loop.test.mjs,
// so npm test runs it without a change of scripts.test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { internal } from './agent-review-loop-lib.mjs';
import { PROFILE as DEFAULT_PROFILE } from './agent-review-profile.mjs';
import { EXAMPLE_TASK, EXAMPLE_TASK_PATH } from './ringi-init.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const runnerRoot = join(scriptDirectory, '..');
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
const realNpm = which('npm');

function git(cwd, args) {
  const child = spawnSync(realGit, args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: `${dirname(realGit)}:/usr/bin:/bin`,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    shell: false,
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

async function temporaryDirectory(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function writeFiles(directory, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}

// npm offline, with its own empty cache, user configuration and home: the
// machine's npm configuration and cache are not used.
async function createNpmEnvironment(directory) {
  await mkdir(join(directory, 'home'), { recursive: true });
  await writeFile(join(directory, 'npmrc'), '');
  return {
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    HOME: join(directory, 'home'),
    npm_config_cache: join(directory, 'npm-cache'),
    npm_config_userconfig: join(directory, 'npmrc'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    NO_COLOR: '1',
  };
}

function npm(cwd, args, env) {
  const child = spawnSync(realNpm, args, { cwd, env, encoding: 'utf8', shell: false });
  assert.equal(child.status, 0, `npm ${args.join(' ')}\n${child.stdout}\n${child.stderr}`);
  return child.stdout;
}

function parsePack(stdout) {
  const [pack, ...rest] = JSON.parse(stdout);
  assert.equal(rest.length, 0);
  return pack;
}

const ROOT_FILES = ['CHANGELOG.md', 'LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'package.json'];
const PACKAGE_DIRECTORIES = ['bin', 'docs', 'examples', 'scripts'];
const REQUIRED_FILES = [
  'bin/ringi.mjs',
  'scripts/ringi-cli.mjs',
  'scripts/ringi-init.mjs',
  'scripts/ringi-doctor.mjs',
  'scripts/agent-review-loop.mjs',
  'scripts/agent-review-loop-lib.mjs',
  'scripts/agent-review-dashboard.mjs',
  'scripts/agent-review-prompts.mjs',
  'scripts/agent-review-providers.mjs',
  'scripts/agent-review-profile.mjs',
  'scripts/messages/index.mjs',
  'scripts/messages/en.mjs',
  'scripts/messages/pl.mjs',
  'scripts/providers/contract.mjs',
  'scripts/providers/codex.mjs',
  'scripts/providers/claude.mjs',
  'scripts/providers/conformance.mjs',
  ...ROOT_FILES,
];
// Names such as SHA-256 have the shape of a work item identifier and are
// allowed; any other match in a packaged file fails the test. The second
// alternative catches identifiers with digits in the prefix (such as X1Y-Z2).
// A-Z0 is the start of the regular expression range [A-Z0-9] in the runner.
const IDENTIFIER_SHAPE = /\b(?:(?:[A-Z]{2,}(?:-[A-Z]{2,})*|P\d+)-\d+|[A-Z][A-Z0-9]*-[A-Z]*\d+)\b/g;
const ALLOWED_IDENTIFIER_SHAPES = new Set(['SHA-1', 'SHA-256', 'UTF-8', 'LICENSE-2', 'A-Z0']);

// The files the package must contain, from the working tree: everything under
// bin/, docs/, examples/ and scripts/ except tests, scripts/fixtures/ and
// dotfiles, plus the root files.
async function expectedPackageFiles() {
  const files = [...ROOT_FILES];
  for (const directory of PACKAGE_DIRECTORIES) {
    for (const entry of await readdir(join(runnerRoot, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const path = relative(runnerRoot, join(entry.parentPath, entry.name))
        .split('\\')
        .join('/');
      if (
        path.endsWith('.test.mjs') ||
        path.startsWith('scripts/fixtures/') ||
        path.split('/').some((segment) => segment.startsWith('.'))
      )
        continue;
      files.push(path);
    }
  }
  return files.sort();
}

// Static imports, re-exports and dynamic imports with a literal specifier.
function moduleSpecifiers(path, sourceText) {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

// The manifest is valid in two states: unreleased (`private: true`, version
// 0.0.0) or a release (`private: false`, any other version). The fields the
// package needs do not depend on the state.
function assertPackageManifest(packageJson) {
  assert.equal(packageJson.name, 'ringi-gate');
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.deepEqual(packageJson.bin, { ringi: 'bin/ringi.mjs' });
  assert.ok(Array.isArray(packageJson.files), 'files');
  for (const entry of ['bin/', 'scripts/', 'docs/', 'examples/', 'LICENSE', 'NOTICE', 'README.md'])
    assert.ok(packageJson.files.includes(entry), `files: ${entry}`);
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof packageJson.private, 'boolean', 'private');
  assert.equal(
    packageJson.private,
    packageJson.version === '0.0.0',
    `private: ${packageJson.private} with version ${packageJson.version}`,
  );
  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'git+https://github.com/kxmskx/ringi-gate.git',
  });
  assert.equal(packageJson.homepage, 'https://github.com/kxmskx/ringi-gate#readme');
  assert.deepEqual(packageJson.bugs, { url: 'https://github.com/kxmskx/ringi-gate/issues' });
  // No runtime dependencies: installing the package fetches nothing else.
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies'])
    assert.equal(Object.hasOwn(packageJson, field), false, field);
}

test('package manifest: the release variant (version 0.1.0, private: false) passes, a mixed state does not', async () => {
  const workspace = await temporaryDirectory('ringi-package-release-');
  try {
    const packageJson = JSON.parse(await readFile(join(runnerRoot, 'package.json'), 'utf8'));
    assertPackageManifest(packageJson);
    const release = { ...packageJson, version: '0.1.0', private: false };
    await writeFile(join(workspace, 'package.json'), `${JSON.stringify(release, null, 2)}\n`);
    assertPackageManifest(JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')));
    for (const mixed of [
      { ...release, version: '0.0.0' },
      { ...release, private: true },
      { ...packageJson, version: '0.0.0', private: false },
    ])
      assert.throws(() => assertPackageManifest(mixed), assert.AssertionError);
    const withoutPrivate = { ...release };
    delete withoutPrivate.private;
    assert.throws(() => assertPackageManifest(withoutPrivate), assert.AssertionError);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('package contents: npm pack lists the runner, its docs and examples, without tests, snapshots or repository files', async (t) => {
  const workspace = await temporaryDirectory('ringi-package-list-');
  try {
    const packageJson = JSON.parse(await readFile(join(runnerRoot, 'package.json'), 'utf8'));
    assertPackageManifest(packageJson);

    const pack = parsePack(
      npm(
        runnerRoot,
        ['pack', '--dry-run', '--json', '--ignore-scripts'],
        await createNpmEnvironment(workspace),
      ),
    );
    assert.equal(pack.name, 'ringi-gate');
    assert.equal(pack.version, packageJson.version);
    assert.deepEqual(pack.bundled, []);
    const files = pack.files.map(({ path }) => path).sort();
    t.diagnostic(`${files.length} files, ${pack.size} bytes packed, ${pack.unpackedSize} bytes unpacked`);

    for (const path of REQUIRED_FILES) assert.ok(files.includes(path), `missing ${path}`);
    for (const path of files) {
      assert.doesNotMatch(path, /\.test\.mjs$/, path);
      assert.doesNotMatch(path, /^scripts\/fixtures\//, path);
      assert.doesNotMatch(path, /(?:^|\/)(?:\.github|\.git|node_modules)(?:\/|$)/, path);
      assert.doesNotMatch(path, /(?:^|\/)\./, path);
      assert.doesNotMatch(path, IDENTIFIER_SHAPE, path);
    }
    assert.deepEqual(files, await expectedPackageFiles());
    assert.equal(pack.files.find(({ path }) => path === 'bin/ringi.mjs').mode & 0o111, 0o111);

    // Every file a packaged module imports is packaged; bare specifiers are
    // Node.js built-ins only.
    const missing = [];
    for (const path of files.filter((name) => name.endsWith('.mjs'))) {
      for (const specifier of moduleSpecifiers(path, await readFile(join(runnerRoot, path), 'utf8'))) {
        if (specifier.startsWith('node:')) continue;
        if (!specifier.startsWith('.')) {
          missing.push(`${path}: ${specifier}`);
          continue;
        }
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!files.includes(target)) missing.push(`${path}: ${specifier}`);
      }
    }
    assert.deepEqual(missing, []);
    // The import graph of bin/ringi.mjs reaches the runner modules (the
    // default profile and the conformance kit are imported by the earlier
    // entry point and by provider tests, not by the ringi command).
    const reach = async (entries) => {
      const reached = new Set();
      const pending = [...entries];
      while (pending.length > 0) {
        const path = pending.pop();
        if (reached.has(path)) continue;
        reached.add(path);
        for (const specifier of moduleSpecifiers(path, await readFile(join(runnerRoot, path), 'utf8')))
          if (specifier.startsWith('.'))
            pending.push(posix.normalize(posix.join(posix.dirname(path), specifier)));
      }
      return reached;
    };
    const reached = await reach(['bin/ringi.mjs']);
    for (const path of REQUIRED_FILES.filter(
      (name) =>
        name.endsWith('.mjs') &&
        !/agent-review-(?:loop|profile)\.mjs$|conformance\.mjs$/.test(name),
    ))
      assert.ok(reached.has(path), `bin/ringi.mjs does not reach ${path}`);
    // The runner fingerprint (RUNNER_MODIFIED) covers exactly the import
    // graph of both entry points, as a TypeScript parse finds it.
    assert.deepEqual(
      internal.readRunnerFingerprint().files.map(({ path }) => path),
      [...(await reach(['bin/ringi.mjs', 'scripts/agent-review-loop.mjs']))].sort(),
    );

    // The default profile only points to documents the package contains.
    for (const [name, taskClass] of Object.entries(DEFAULT_PROFILE.taskClasses))
      assert.ok(files.includes(taskClass.policy), `${name}: ${taskClass.policy}`);

    // No packaged file contains an identifier of a work item.
    const identifiers = [];
    for (const path of files) {
      const text = await readFile(join(runnerRoot, path), 'utf8');
      for (const [match] of text.matchAll(IDENTIFIER_SHAPE))
        if (!ALLOWED_IDENTIFIER_SHAPES.has(match)) identifiers.push(`${path}: ${match}`);
    }
    assert.deepEqual(identifiers, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// A text check of the workflows, not a YAML parser: actions pinned to a
// commit, no privileged trigger, no secrets, read-only token by default.
test('workflows: actions pinned to a commit SHA, no pull_request_target, no secrets, read-only token', async () => {
  const directory = join(runnerRoot, '.github', 'workflows');
  assert.deepEqual((await readdir(directory)).sort(), ['release.yml', 'test.yml']);
  const read = async (name) => readFile(join(directory, name), 'utf8');
  for (const name of ['release.yml', 'test.yml']) {
    const text = await read(name);
    assert.doesNotMatch(text, /\t/, name);
    assert.doesNotMatch(text, /pull_request_target|secrets\.|NPM_TOKEN:|workflow_run/, name);
    assert.match(text, /^permissions:\n {2}contents: read\n\n/m, name);
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(.+)$/gm)].map(([, value]) => value);
    assert.ok(uses.length >= 2, name);
    for (const value of uses)
      assert.match(
        value,
        /^actions\/(?:checkout|setup-node)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        `${name}: ${value}`,
      );
    assert.match(text, /corepack install -g --cache-only pnpm@11\.20\.0/, name);
    // The release job holds id-token: write, so no install scripts run there.
    assert.match(
      text,
      name === 'release.yml' ? /^\s+- run: npm ci --ignore-scripts$/m : /^\s+- run: npm ci$/m,
      name,
    );
    assert.match(text, /^\s+- run: npm test$/m, name);
  }
  const testWorkflow = await read('test.yml');
  assert.match(testWorkflow, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n\n/m);
  assert.match(testWorkflow, /os: \[ubuntu-latest, macos-latest\]/);
  assert.doesNotMatch(testWorkflow, /id-token|write/);
  const release = await read('release.yml');
  assert.match(release, /^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\n\n/m);
  assert.match(release, /^ {4}environment: release$/m);
  assert.match(release, /^ {4}permissions:\n {6}contents: read\n {6}id-token: write\n {4}steps:/m);
  assert.equal([...release.matchAll(/write/g)].length, 1);
  assert.match(release, /registry-url: 'https:\/\/registry\.npmjs\.org'/);
  assert.match(release, /^ {6}- run: npm publish --provenance --access public$/m);
});

// Stand-in programs: git and node (the real ones), and agent CLIs that only
// answer --version.
async function createStubBin(directory, versions = {}) {
  await mkdir(directory, { recursive: true });
  const script = (body) => `#!/bin/sh\n${body}\n`;
  const programs = {
    git: script(`exec ${JSON.stringify(realGit)} "$@"`),
    node: script(`exec ${JSON.stringify(process.execPath)} "$@"`),
  };
  for (const [name, version] of Object.entries(versions))
    programs[name] = script(
      `if [ "$1" = "--version" ]; then echo ${JSON.stringify(version)}; exit 0; fi\nexit 64`,
    );
  for (const [name, content] of Object.entries(programs)) {
    await writeFile(join(directory, name), content);
    await chmod(join(directory, name), 0o755);
  }
  return directory;
}

test('package installation: the packed tarball installs offline and ringi runs from node_modules (version, init, doctor with runner-location warn, run --dry-run; a writer changing the runner in node_modules: RUNNER_MODIFIED)', async (t) => {
  const workspace = await temporaryDirectory('ringi-package-install-');
  try {
    const { version: packageVersion } = JSON.parse(
      await readFile(join(runnerRoot, 'package.json'), 'utf8'),
    );
    const npmEnvironment = await createNpmEnvironment(join(workspace, 'npm'));
    await mkdir(join(workspace, 'pack'));
    const pack = parsePack(
      npm(
        runnerRoot,
        ['pack', '--json', '--ignore-scripts', '--pack-destination', join(workspace, 'pack')],
        npmEnvironment,
      ),
    );
    const tarball = join(workspace, 'pack', pack.filename);
    assert.equal(pack.filename, `ringi-gate-${packageVersion}.tgz`);
    t.diagnostic(`${pack.filename}: ${pack.size} bytes, ${pack.entryCount} files`);

    // npm: install the tarball as a dev dependency, then npx-style execution.
    const npmProject = join(workspace, 'npm-project');
    await writeFiles(npmProject, {
      'package.json': `${JSON.stringify({ name: 'synthetic-npm-project', private: true }, null, 2)}\n`,
    });
    npm(
      npmProject,
      ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--save-dev', tarball],
      npmEnvironment,
    );
    const npmManifest = JSON.parse(await readFile(join(npmProject, 'package.json'), 'utf8'));
    assert.ok(npmManifest.devDependencies['ringi-gate'].startsWith('file:'));
    assert.ok(npmManifest.devDependencies['ringi-gate'].endsWith(`/${pack.filename}`));
    assert.equal(
      npm(npmProject, ['exec', '--offline', '--', 'ringi', '--version'], npmEnvironment),
      `ringi (Ringi Gate) ${packageVersion}\n`,
    );
    const installedFiles = (
      await readdir(join(npmProject, 'node_modules', 'ringi-gate'), { recursive: true, withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(join(npmProject, 'node_modules', 'ringi-gate'), join(entry.parentPath, entry.name))
          .split('\\')
          .join('/'),
      )
      .sort();
    assert.deepEqual(installedFiles, pack.files.map(({ path }) => path).sort());

    // pnpm (the package manager the runner requires in a target repository):
    // the tarball as a dev dependency, installed offline from the local
    // Corepack cache, in a Git repository on a working branch.
    const project = join(workspace, 'project');
    const installEnvironment = join(workspace, 'pnpm-install');
    await mkdir(join(installEnvironment, 'home'), { recursive: true });
    await mkdir(join(installEnvironment, 'xdg-data'), { recursive: true });
    await writeFile(join(installEnvironment, 'npmrc'), '');
    await writeFiles(project, {
      '.gitignore': 'node_modules/\n.agent-review-loop/\n',
      'pnpm-workspace.yaml': 'packages: []\n',
      'package.json': `${JSON.stringify(
        {
          name: 'synthetic-installed-ringi',
          private: true,
          packageManager: PACKAGE_MANAGER,
          scripts: { test: 'node -e ""' },
          devDependencies: { 'ringi-gate': `file:${tarball}` },
        },
        null,
        2,
      )}\n`,
      'AGENTS.md': '# Agents\n\nSynthetic rules.\n',
      'CLAUDE.md': '# Claude\n\nSynthetic rules.\n',
    });
    const corepackHome = internal.resolveCorepackHome(process.env);
    const install = spawnSync(
      join(corepackHome, 'v1', 'pnpm', PNPM_VERSION, 'bin', 'pnpm.mjs'),
      ['install', '--offline', '--ignore-scripts'],
      {
        cwd: project,
        encoding: 'utf8',
        shell: false,
        env: {
          PATH: `${dirname(realGit)}:${dirname(process.execPath)}:${process.env.PATH}`,
          HOME: join(installEnvironment, 'home'),
          XDG_DATA_HOME: join(installEnvironment, 'xdg-data'),
          NPM_CONFIG_USERCONFIG: join(installEnvironment, 'npmrc'),
          COREPACK_HOME: corepackHome,
          COREPACK_ENABLE_NETWORK: '0',
          NO_COLOR: '1',
        },
      },
    );
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const installedRunner = await realpath(join(project, 'node_modules', 'ringi-gate'));
    assert.ok(installedRunner.startsWith(join(project, 'node_modules', '.pnpm') + '/'), installedRunner);
    git(project, ['init', '--quiet', '--initial-branch', 'main']);
    git(project, ['config', 'user.name', 'Synthetic Tester']);
    git(project, ['config', 'user.email', 'tester@example.invalid']);
    git(project, ['config', 'commit.gpgsign', 'false']);
    git(project, ['add', '-A']);
    git(project, ['commit', '--quiet', '-m', 'test: baseline']);
    git(project, ['switch', '--quiet', '-c', 'feat/installed-ringi']);

    // The pnpm bin link of the package, with stand-in agent CLIs or none.
    const bin = await createStubBin(join(workspace, 'bin'), {
      codex: CODEX_VERSION,
      claude: CLAUDE_VERSION,
    });
    const binWithoutAgents = await createStubBin(join(workspace, 'bin-without-agents'));
    const ringiLink = join(project, 'node_modules', '.bin', 'ringi');
    const env = (path) => ({
      PATH: `${path}:/usr/bin:/bin`,
      HOME: process.env.HOME,
      COREPACK_HOME: corepackHome,
      NO_COLOR: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    });
    const ringi = (args, path = bin) =>
      spawnSync(ringiLink, args, { cwd: project, env: env(path), encoding: 'utf8', shell: false });

    const version = ringi(['--version']);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, `ringi (Ringi Gate) ${packageVersion}\n`);

    const dryRun = ringi(['init', '--dry-run']);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /^ringi init --dry-run: nothing is written\.$/m);
    assert.match(dryRun.stdout, /^create   ringi\.config\.mjs \(gates: pnpm run test, git diff --check\)$/m);
    assert.equal(git(project, ['status', '--porcelain', '--untracked-files=all']), '');

    const init = ringi(['init']);
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /^created  ringi\.config\.mjs \(gates: pnpm run test, git diff --check\)$/m);
    assert.equal(await readFile(join(project, EXAMPLE_TASK_PATH), 'utf8'), EXAMPLE_TASK);
    assert.equal(
      git(project, ['status', '--porcelain', '--untracked-files=all']),
      `?? ringi.config.mjs\n?? ${EXAMPLE_TASK_PATH}\n`,
    );
    git(project, ['add', 'ringi.config.mjs', EXAMPLE_TASK_PATH]);
    git(project, ['commit', '--quiet', '-m', 'Add ringi profile']);

    // Doctor: without the agent CLIs only their checks are not ok (the
    // reviewer check is not run when the implementer check fails).
    const doctor = (path) => {
      const child = ringi(['doctor', '--json'], path);
      return { child, result: JSON.parse(child.stdout) };
    };
    const withoutAgents = doctor(binWithoutAgents);
    assert.equal(withoutAgents.child.status, 1, withoutAgents.child.stderr);
    const statuses = Object.fromEntries(
      withoutAgents.result.checks.map(({ id, status }) => [id, status]),
    );
    assert.deepEqual(statuses, {
      node: 'ok',
      'git-repository': 'ok',
      // The runner lives in node_modules of the repository.
      'runner-location': 'warn',
      branch: 'ok',
      'staged-changes': 'ok',
      'package-manager': 'ok',
      'corepack-cache': 'ok',
      'agents-md': 'ok',
      'claude-md': 'ok',
      'profile-committed': 'ok',
      profile: 'ok',
      providers: 'ok',
      'repository-layout': 'ok',
      'implementer-cli': 'fail',
      'reviewer-cli': 'warn',
    });
    assert.match(
      withoutAgents.result.checks.find(({ id }) => id === 'implementer-cli').hint,
      /codex/,
    );
    const location = withoutAgents.result.checks.find(({ id }) => id === 'runner-location');
    assert.match(location.detail, /^runner installed inside the repository \(node_modules\/\.pnpm\/ringi-gate@[^)]+\/node_modules\/ringi-gate\)$/);
    assert.match(location.hint, /^Install the runner outside the repository \(globally, or run it with npx from the npm cache\)/);
    const withAgents = doctor(bin);
    assert.equal(withAgents.child.status, 0, withAgents.child.stdout);
    assert.deepEqual(
      withAgents.result.checks.filter(({ status }) => status !== 'ok').map(({ id }) => id),
      ['runner-location'],
    );

    // run --dry-run: the preflight with the real pnpm and the stand-in CLIs.
    const runEnvironment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: '1' };
    delete runEnvironment.CI;
    // node --test sets FORCE_COLOR for a terminal; with NO_COLOR Node warns
    // on stderr, which the test expects empty.
    delete runEnvironment.FORCE_COLOR;
    const run = spawnSync(ringiLink, ['run', EXAMPLE_TASK_PATH, '--dry-run'], {
      cwd: project,
      env: runEnvironment,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    const plan = JSON.parse(run.stdout);
    assert.equal(plan.status, 'DRY_RUN_OK');
    assert.deepEqual(plan.checks, ['pnpm run test', 'git diff --check']);
    assert.equal(plan.projectProfile.path, 'ringi.config.mjs');
    assert.equal(plan.projectProfile.committed, true);
    assert.deepEqual(
      plan.runner.files.map(({ path }) => path),
      internal.readRunnerFingerprint().files.map(({ path }) => path),
    );
    assert.equal(git(project, ['status', '--porcelain', '--untracked-files=all']), '');

    // A writer that changes a runner file in node_modules during its round
    // (and then fails): the run stops with RUNNER_MODIFIED, the round's own
    // failure is kept as an integrity violation.
    const changedFile = join(installedRunner, 'scripts', 'agent-review-loop-lib.mjs');
    const writerBin = await createStubBin(join(workspace, 'bin-writer'), { claude: CLAUDE_VERSION });
    await writeFile(
      join(writerBin, 'codex'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${JSON.stringify(CODEX_VERSION)}; exit 0; fi\nprintf '\\n// changed by the writer\\n' >> ${JSON.stringify(changedFile)}\nexit 1\n`,
    );
    await chmod(join(writerBin, 'codex'), 0o755);
    const realRun = spawnSync(ringiLink, ['run', EXAMPLE_TASK_PATH, '--json'], {
      cwd: project,
      env: { ...runEnvironment, PATH: `${writerBin}:${process.env.PATH}` },
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(realRun.status, 1, realRun.stderr);
    const stopped = JSON.parse(realRun.stdout);
    assert.equal(stopped.code, 'RUNNER_MODIFIED', stopped.error);
    assert.equal(stopped.stage, 'post-codex');
    assert.match(stopped.error, /"scripts\/agent-review-loop-lib\.mjs"/);
    assert.ok(stopped.integrityViolations.length > 0);
    assert.deepEqual(stopped.runner, plan.runner);
    assert.match(await readFile(changedFile, 'utf8'), /\/\/ changed by the writer\n$/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
