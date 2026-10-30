// Tests of ringi ci (scripts/ringi-ci.mjs, scripts/ringi-ci-lanes.mjs): the
// ci section of the profile, the classifier on synthetic repositories in the
// system temporary directory (real Git, no agent CLI, no network) and the
// aggregator of the required check. Imported by agent-review-loop.test.mjs,
// so npm test runs it without a change of scripts.test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { internal } from './agent-review-loop-lib.mjs';
import { PROFILE as DEFAULT_PROFILE } from './agent-review-profile.mjs';
import {
  aggregateNeeds,
  ciGitEnvironment,
  classifyDiff,
  classifyRecords,
  parseRawDiff,
} from './ringi-ci-lanes.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const ringiBin = join(scriptDirectory, '..', 'bin', 'ringi.mjs');

function which(name) {
  const found = spawnSync('which', ['-a', name], { encoding: 'utf8', shell: false })
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

const CI = {
  docsPaths: ['README.md', 'docs/'],
  lanes: { docs: ['git diff --check'], full: ['git diff --check', 'pnpm test'] },
};

// The resolved docs candidate policy of the default profile.
const DOCS_POLICY = internal.resolveRunnerProfile(DEFAULT_PROFILE).docsCandidatePolicy;

// extra: further top-level keys of the profile.
const profileSource = (ci = CI, comment = '', extra = {}) =>
  [
    `// Synthetic profile of the ringi ci tests.${comment}`,
    'export const PROFILE = {',
    "  title: 'CI TEST',",
    "  tempPrefix: 'ci-test-',",
    '  checks: {',
    "    'pnpm test': { program: 'pnpm', args: ['test'], timeoutMs: 60_000 },",
    "    'git diff --check': { program: 'git', args: ['diff', '--check'], timeoutMs: 60_000 },",
    '  },',
    "  checkSets: { base: ['pnpm test', 'git diff --check'], docs: ['git diff --check'] },",
    '  requiredGateRules: [],',
    ...(ci ? [`  ci: ${JSON.stringify(ci)},`] : []),
    ...Object.entries(extra).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`),
    '};',
    '',
  ].join('\n');

async function writeFiles(directory, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}

// A repository with the profile, a README, two documents and a source file
// committed; returns its directory and the SHA of that commit.
async function createRepository({ ci = CI, extra = {} } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ringi-ci-repo-')));
  git(directory, ['init', '--quiet', '--initial-branch', 'main']);
  git(directory, ['config', 'user.name', 'Synthetic Tester']);
  git(directory, ['config', 'user.email', 'tester@example.invalid']);
  git(directory, ['config', 'commit.gpgsign', 'false']);
  await writeFiles(directory, {
    'ringi.config.mjs': profileSource(ci, '', extra),
    'README.md': '# Synthetic project\n',
    'docs/guide.md': '# Guide\n',
    'docs/old.md': '# Old\n',
    'src/app.js': 'export const answer = 42;\n',
  });
  git(directory, ['add', '-A']);
  git(directory, ['commit', '--quiet', '-m', 'test: baseline']);
  return { directory, base: head(directory) };
}

const head = (directory) => git(directory, ['rev-parse', 'HEAD']).trim();

// Commits whatever change(directory) made and returns the new HEAD.
async function commitChange(directory, change) {
  await change(directory);
  git(directory, ['add', '-A']);
  git(directory, ['commit', '--quiet', '--allow-empty', '-m', 'test: change']);
  return head(directory);
}

async function ringi(cwd, args) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ringi-ci-home-')));
  try {
    return spawnSync(process.execPath, [ringiBin, ...args], {
      cwd,
      env: {
        PATH: `${dirname(realGit)}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
      },
      encoding: 'utf8',
      shell: false,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function classify(directory, base, headSha) {
  const child = await ringi(directory, [
    'ci',
    'classify',
    '--base',
    base,
    '--head',
    headSha,
    '--json',
  ]);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

// The lane and the reason of every file of one change.
async function classifyChange(change) {
  const { directory, base } = await createRepository();
  try {
    const result = await classify(directory, base, await commitChange(directory, change));
    return {
      lane: result.lane,
      reasons: result.reasons,
      checks: result.checks,
      files: Object.fromEntries(result.files.map((file) => [file.path, file])),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// --- The ci section of the profile -------------------------------------

const withCi = (ci) => ({ ...DEFAULT_PROFILE, ci });
const DEFAULT_CI = {
  docsPaths: ['README.md', './docs/'],
  lanes: { docs: ['git diff --check'], full: ['pnpm check', 'git diff --check'] },
};

test('ci profile: a valid ci section is normalized and frozen; without it the profile has no ci', () => {
  const { ci } = internal.resolveRunnerProfile(withCi(DEFAULT_CI));
  assert.deepEqual(ci, {
    docsPaths: ['README.md', 'docs/'],
    lanes: { docs: ['git diff --check'], full: ['pnpm check', 'git diff --check'] },
  });
  assert.ok(Object.isFrozen(ci) && Object.isFrozen(ci.docsPaths) && Object.isFrozen(ci.lanes));
  assert.ok(Object.isFrozen(ci.lanes.docs) && Object.isFrozen(ci.lanes.full));
  // Resolving again is a no-op.
  assert.deepEqual(
    internal.resolveRunnerProfile(internal.resolveRunnerProfile(withCi(DEFAULT_CI))).ci,
    ci,
  );
  // Without ci nothing is added.
  const resolved = internal.resolveRunnerProfile(DEFAULT_PROFILE);
  assert.equal(Object.hasOwn(resolved, 'ci'), false);
});

test('ci profile: validation is fail-closed, reserved keys included', () => {
  const lanes = DEFAULT_CI.lanes;
  for (const ci of [
    undefined,
    null,
    [],
    'docs/',
    {},
    { lanes },
    { docsPaths: ['docs/'] },
    // Reserved keys of ci and of lanes.
    { ...DEFAULT_CI, review: {} },
    { ...DEFAULT_CI, lanes: { ...lanes, preview: ['git diff --check'] } },
    // docsPaths: the review lane path validator, plus .md for a file.
    { ...DEFAULT_CI, docsPaths: [] },
    { ...DEFAULT_CI, docsPaths: ['docs/*.md'] },
    { ...DEFAULT_CI, docsPaths: ['/docs/'] },
    { ...DEFAULT_CI, docsPaths: ['../docs/'] },
    { ...DEFAULT_CI, docsPaths: ['docs\\guide.md'] },
    { ...DEFAULT_CI, docsPaths: ['docs/', 'docs/'] },
    { ...DEFAULT_CI, docsPaths: ['CHANGELOG'] },
    { ...DEFAULT_CI, docsPaths: ['docs/guide.txt'] },
    { ...DEFAULT_CI, docsPaths: 'docs/' },
    // lanes: names from checks, not empty, no duplicate, docs within full.
    { ...DEFAULT_CI, lanes: { docs: [], full: lanes.full } },
    { ...DEFAULT_CI, lanes: { docs: lanes.docs, full: [] } },
    { ...DEFAULT_CI, lanes: { docs: lanes.docs } },
    { ...DEFAULT_CI, lanes: { full: lanes.full } },
    { ...DEFAULT_CI, lanes: { docs: ['pnpm lint'], full: [...lanes.full, 'pnpm lint'] } },
    { ...DEFAULT_CI, lanes: { docs: lanes.docs, full: ['pnpm check', 'pnpm check'] } },
    { ...DEFAULT_CI, lanes: { docs: ['git diff --check'], full: ['pnpm check'] } },
    { ...DEFAULT_CI, lanes: { docs: 'git diff --check', full: lanes.full } },
  ]) {
    assert.throws(
      () => internal.resolveRunnerProfile(withCi(ci)),
      { code: 'INVALID_CONFIGURATION' },
      JSON.stringify(ci),
    );
  }
  // A getter is never run.
  const getter = { ...DEFAULT_CI };
  Object.defineProperty(getter, 'docsPaths', { enumerable: true, get: () => ['docs/'] });
  assert.throws(() => internal.resolveRunnerProfile(withCi(getter)), {
    code: 'INVALID_CONFIGURATION',
  });
});

// --- The classifier --------------------------------------------------------

test('ci classify: a change of plain documentation only is the docs lane with its checks', async () => {
  const result = await classifyChange(async (directory) => {
    await writeFile(join(directory, 'README.md'), '# Synthetic project\n\nMore.\n');
    await writeFile(join(directory, 'docs/guide.md'), '# Guide\n\nMore.\n');
    await writeFiles(directory, { 'docs/new/page.md': '# Page\n' });
  });
  assert.equal(result.lane, 'docs');
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.checks, ['git diff --check']);
  assert.deepEqual(result.files, {
    'README.md': { path: 'README.md', status: 'modified', reason: 'docs' },
    'docs/guide.md': { path: 'docs/guide.md', status: 'modified', reason: 'docs' },
    'docs/new/page.md': { path: 'docs/new/page.md', status: 'added', reason: 'docs' },
  });
});

test('ci classify: documentation and code together is the full lane', async () => {
  const result = await classifyChange(async (directory) => {
    await writeFile(join(directory, 'docs/guide.md'), '# Guide\n\nMore.\n');
    await writeFile(join(directory, 'src/app.js'), 'export const answer = 43;\n');
  });
  assert.equal(result.lane, 'full');
  assert.deepEqual(result.reasons, ['not-markdown']);
  assert.deepEqual(result.checks, ['git diff --check', 'pnpm test']);
  assert.equal(result.files['docs/guide.md'].reason, 'docs');
  assert.equal(result.files['src/app.js'].reason, 'not-markdown');
});

test('ci classify: a rename between documentation and code is the full lane, with both ends', async () => {
  const out = await classifyChange((directory) => {
    git(directory, ['mv', 'docs/old.md', 'src/old.md']);
  });
  assert.equal(out.lane, 'full');
  assert.deepEqual(out.files['src/old.md'], {
    path: 'src/old.md',
    oldPath: 'docs/old.md',
    status: 'renamed',
    reason: 'outside-docs-paths',
  });
  // From code to documentation: the base is the commit that added the file
  // under src/.
  const { directory } = await createRepository();
  try {
    const base = await commitChange(directory, (path) =>
      writeFiles(path, { 'src/notes.md': '# Notes\n\nSynthetic text.\n' }),
    );
    const result = await classify(
      directory,
      base,
      await commitChange(directory, () => {
        git(directory, ['mv', 'src/notes.md', 'docs/notes.md']);
      }),
    );
    assert.equal(result.lane, 'full');
    assert.deepEqual(result.files, [
      {
        path: 'docs/notes.md',
        oldPath: 'src/notes.md',
        status: 'renamed',
        reason: 'outside-docs-paths',
      },
    ]);
    // A rename inside the documentation stays in the docs lane.
    const inside = await classify(
      directory,
      head(directory),
      await commitChange(directory, () => {
        git(directory, ['mv', 'docs/guide.md', 'docs/handbook.md']);
      }),
    );
    assert.equal(inside.lane, 'docs');
    assert.equal(inside.files[0].oldPath, 'docs/guide.md');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ci classify: a deleted document is the docs lane, deleted code the full lane', async () => {
  const docs = await classifyChange((directory) => unlink(join(directory, 'docs/old.md')));
  assert.equal(docs.lane, 'docs');
  assert.deepEqual(docs.files['docs/old.md'], {
    path: 'docs/old.md',
    status: 'deleted',
    reason: 'docs',
  });
  const code = await classifyChange((directory) => unlink(join(directory, 'src/app.js')));
  assert.equal(code.lane, 'full');
  assert.equal(code.files['src/app.js'].status, 'deleted');
});

test('ci classify: a symbolic link, an executable file or a submodule named .md is the full lane', async () => {
  const link = await classifyChange((directory) =>
    symlink('guide.md', join(directory, 'docs/link.md')),
  );
  assert.equal(link.lane, 'full');
  assert.equal(link.files['docs/link.md'].reason, 'symlink');
  const executable = await classifyChange(async (directory) => {
    await writeFile(join(directory, 'docs/run.md'), '# Run\n');
    await chmod(join(directory, 'docs/run.md'), 0o755);
  });
  assert.equal(executable.lane, 'full');
  assert.equal(executable.files['docs/run.md'].reason, 'executable');
  // An existing document made executable: mode 100644 on one side only.
  const modeChange = await classifyChange((directory) =>
    chmod(join(directory, 'docs/guide.md'), 0o755),
  );
  assert.equal(modeChange.lane, 'full');
  assert.equal(modeChange.files['docs/guide.md'].reason, 'executable');
  // A gitlink, committed from the index alone (git add -A would drop it).
  const { directory, base } = await createRepository();
  try {
    git(directory, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${base},docs/vendor.md`,
    ]);
    git(directory, ['commit', '--quiet', '-m', 'test: submodule']);
    const submodule = await classify(directory, base, head(directory));
    assert.equal(submodule.lane, 'full');
    assert.deepEqual(submodule.files, [
      { path: 'docs/vendor.md', status: 'added', reason: 'submodule' },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ci classify: instruction and security files in any directory and letter case are the full lane', async () => {
  const result = await classifyChange((directory) =>
    writeFiles(directory, {
      'docs/team/AGENTS.md': '# Agents\n',
      'docs/Claude.md': '# Claude\n',
      'docs/policy/security.md': '# Security\n',
      'docs/skills/review/SKILL.md': '# Skill\n',
      'docs/plain.md': '# Plain\n',
    }),
  );
  assert.equal(result.lane, 'full');
  assert.deepEqual(result.reasons, ['instruction-file']);
  for (const path of [
    'docs/team/AGENTS.md',
    'docs/Claude.md',
    'docs/policy/security.md',
    'docs/skills/review/SKILL.md',
  ])
    assert.equal(result.files[path].reason, 'instruction-file', path);
  assert.equal(result.files['docs/plain.md'].reason, 'docs');
});

test('ci classify: a file of the profile is the full lane (protectedPaths)', async () => {
  const result = await classifyChange((directory) =>
    writeFile(join(directory, 'ringi.config.mjs'), profileSource(CI, ' Changed.')),
  );
  assert.equal(result.lane, 'full');
  assert.equal(result.files['ringi.config.mjs'].reason, 'protected-path');
  // The comparison folds ASCII letter case, as the docs candidate rule does.
  const records = [
    { status: 'modified', path: 'docs/Profile-Notes.md', oldMode: '100644', newMode: '100644' },
  ];
  assert.equal(
    classifyRecords(records, {
      ci: CI,
      docsCandidatePolicy: DOCS_POLICY,
      protectedPaths: ['docs/profile-notes.md'],
    }).files[0]
      .reason,
    'protected-path',
  );
  assert.equal(
    classifyRecords(records, { ci: CI, docsCandidatePolicy: DOCS_POLICY }).lane,
    'docs',
  );
});

test('ci classify: a path segment that starts with a dot is the full lane', async () => {
  const result = await classifyChange((directory) =>
    writeFiles(directory, {
      'docs/.drafts/page.md': '# Draft\n',
      'docs/.page.md': '# Hidden\n',
    }),
  );
  assert.equal(result.lane, 'full');
  assert.deepEqual(result.reasons, ['dot-segment']);
  assert.equal(result.files['docs/.drafts/page.md'].reason, 'dot-segment');
  assert.equal(result.files['docs/.page.md'].reason, 'dot-segment');
  // A file of the docs paths whose name folds to ASCII (U+212A Kelvin sign)
  // and a name with a control character are refused as well.
  const folding = classifyRecords(
    [
      { status: 'added', path: 'docs/Key.md', oldMode: '000000', newMode: '100644' },
      { status: 'added', path: 'docs/a\u0007.md', oldMode: '000000', newMode: '100644' },
    ],
    { ci: CI, docsCandidatePolicy: DOCS_POLICY },
  );
  assert.deepEqual(folding.reasons, ['ascii-folding-name', 'unsafe-name']);
});

test('ci classify: names with non-ASCII characters and spaces are kept exactly', async () => {
  // Non-ASCII letters outside the Polish alphabet: the Polish literal scan
  // of scripts/ covers this file.
  const path = 'docs/naïve café notes.md';
  const result = await classifyChange((directory) =>
    writeFiles(directory, { [path]: '# Notes\n' }),
  );
  assert.equal(result.lane, 'docs');
  assert.deepEqual(result.files[path], { path, status: 'added', reason: 'docs' });
  const code = await classifyChange((directory) =>
    writeFiles(directory, { 'src/mañana module.js': 'export {};\n' }),
  );
  assert.equal(code.lane, 'full');
  assert.equal(code.files['src/mañana module.js'].reason, 'not-markdown');
});

test('ci classify: an empty diff is the full lane', async () => {
  const { directory, base } = await createRepository();
  try {
    const same = await classify(directory, base, base);
    assert.deepEqual(same, {
      schemaVersion: 1,
      lane: 'full',
      checks: ['git diff --check', 'pnpm test'],
      files: [],
      reasons: ['empty-diff'],
    });
    const empty = await classify(directory, base, await commitChange(directory, () => {}));
    assert.equal(empty.lane, 'full');
    assert.deepEqual(empty.reasons, ['empty-diff']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ci classify: without --json one lane= line on standard output and a summary on standard error', async () => {
  const { directory, base } = await createRepository();
  try {
    const headSha = await commitChange(directory, (path) =>
      writeFiles(path, { 'src/extra.js': 'export {};\n', 'docs/extra.md': '# Extra\n' }),
    );
    const child = await ringi(directory, ['ci', 'classify', '--base', base, '--head', headSha]);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'lane=full\n');
    assert.match(child.stderr, /lane full, 2 file\(s\); reasons: not-markdown\./);
    assert.match(child.stderr, /^ {2}not-markdown: "src\/extra\.js"$/m);
    assert.doesNotMatch(child.stderr, /docs\/extra\.md/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ci classify: a missing commit, an invalid SHA, no ci section or an uncommitted profile is no lane', async () => {
  const { directory, base } = await createRepository();
  try {
    const missing = 'f'.repeat(40);
    for (const args of [
      ['--base', missing, '--head', base],
      ['--base', base, '--head', missing],
    ]) {
      const child = await ringi(directory, ['ci', 'classify', ...args, '--json']);
      assert.equal(child.status, 1, child.stderr);
      assert.deepEqual(
        { ...JSON.parse(child.stdout), error: undefined },
        { schemaVersion: 1, status: 'STOPPED', code: 'DIFF_FAILED', error: undefined },
      );
      assert.doesNotMatch(child.stdout, /lane/);
      assert.match(child.stderr, /DIFF_FAILED: --(?:base|head) f{40} is not a commit/);
    }
    // A tree is not a commit.
    const tree = git(directory, ['rev-parse', 'HEAD^{tree}']).trim();
    const treeChild = await ringi(directory, ['ci', 'classify', '--base', tree, '--head', base]);
    assert.equal(treeChild.status, 1);
    assert.equal(treeChild.stdout, '');
    for (const sha of [base.slice(0, 39), base.toUpperCase(), `${base}0`, 'HEAD', '']) {
      const child = await ringi(directory, ['ci', 'classify', '--base', sha, '--head', base]);
      assert.equal(child.status, 2, sha);
      assert.equal(child.stdout, '', sha);
      assert.match(child.stderr, /--base must be a full commit SHA/, sha);
    }
    for (const args of [
      ['--base', base],
      ['--base', base, '--head', base, '--head', base],
      ['--base', base, '--head', base, '--verbose'],
      ['--base', base, '--head'],
    ]) {
      const child = await ringi(directory, ['ci', 'classify', ...args]);
      assert.equal(child.status, 2, args.join(' '));
      assert.equal(child.stdout, '');
    }
    for (const args of [[], ['lint']]) {
      const child = await ringi(directory, ['ci', ...args]);
      assert.equal(child.status, 2);
      assert.match(child.stderr, /subcommand/);
    }
    // An uncommitted profile is not loaded.
    await writeFile(join(directory, 'ringi.config.mjs'), profileSource(CI, ' Edited.'));
    const uncommitted = await ringi(directory, [
      'ci', 'classify', '--base', base, '--head', base, '--json',
    ]);
    assert.equal(uncommitted.status, 1);
    assert.equal(JSON.parse(uncommitted.stdout).code, 'PROFILE_UNCOMMITTED');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const withoutCi = await createRepository({ ci: null });
  try {
    const child = await ringi(withoutCi.directory, [
      'ci', 'classify', '--base', withoutCi.base, '--head', withoutCi.base, '--json',
    ]);
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stdout).code, 'INVALID_CONFIGURATION');
    assert.match(child.stderr, /no ci section/);
  } finally {
    await rm(withoutCi.directory, { recursive: true, force: true });
  }
});

test('ci classify: the raw diff parser refuses incomplete, unknown and undecodable records', () => {
  const sha = 'a'.repeat(40);
  const header = (oldMode, newMode, status) => `:${oldMode} ${newMode} ${sha} ${sha} ${status}`;
  assert.deepEqual(parseRawDiff(''), []);
  assert.deepEqual(
    parseRawDiff(
      `${header('100644', '100644', 'R100')}\0docs/a.md\0docs/b.md\0${header('000000', '100644', 'A')}\0README.md\0`,
    ),
    [
      { status: 'renamed', oldPath: 'docs/a.md', path: 'docs/b.md', oldMode: '100644', newMode: '100644' },
      { status: 'added', path: 'README.md', oldMode: '000000', newMode: '100644' },
    ],
  );
  for (const text of [
    // Not valid UTF-8 (decoded with a replacement character).
    `${header('100644', '100644', 'M')}\0docs/�.md\0`,
    // Incomplete: no final NUL, no path, one path of a rename.
    `${header('100644', '100644', 'M')}\0docs/a.md`,
    `${header('100644', '100644', 'M')}\0`,
    `${header('100644', '100644', 'R100')}\0docs/a.md\0`,
    `${header('100644', '100644', 'M')}\0\0`,
    // Unknown status, a score where none belongs, an unmerged entry.
    `${header('100644', '100644', 'X')}\0docs/a.md\0`,
    `${header('100644', '100644', 'U')}\0docs/a.md\0`,
    `${header('100644', '100644', 'M050')}\0docs/a.md\0`,
    `${header('100644', '100644', 'R')}\0docs/a.md\0docs/b.md\0`,
    // Modes that do not fit the status, an unknown mode, a tree.
    `${header('100644', '100644', 'A')}\0docs/a.md\0`,
    `${header('100644', '000000', 'M')}\0docs/a.md\0`,
    `${header('000000', '100644', 'D')}\0docs/a.md\0`,
    `${header('100664', '100644', 'M')}\0docs/a.md\0`,
    `${header('040000', '040000', 'M')}\0docs\0`,
    // Abbreviated object ids, a line of another format.
    `:100644 100644 aaaaaaa aaaaaaa M\0docs/a.md\0`,
    'docs/a.md\0',
  ]) {
    assert.throws(() => parseRawDiff(text), { code: 'DIFF_FAILED' }, JSON.stringify(text));
  }
});

test('ci classify: Git runs without the configuration of the environment', () => {
  const env = ciGitEnvironment({
    PATH: '/usr/bin',
    GIT_DIR: '/elsewhere',
    GIT_CONFIG_PARAMETERS: "'diff.renames'='false'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.pager',
    GIT_CONFIG_VALUE_0: 'cat',
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  });
});

test('ci classify: replace objects do not change the classified diff', async () => {
  const { directory, base } = await createRepository();
  try {
    const code = await commitChange(directory, (path) =>
      writeFile(join(path, 'src/app.js'), 'export const answer = 43;\n'),
    );
    git(directory, ['switch', '--quiet', '--detach', base]);
    const docs = await commitChange(directory, (path) =>
      writeFile(join(path, 'docs/guide.md'), '# Guide\n\nMore.\n'),
    );
    // A replace ref that makes the code commit look like the docs commit.
    git(directory, ['replace', code, docs]);
    git(directory, ['switch', '--quiet', 'main']);
    const result = await classify(directory, base, code);
    assert.equal(result.lane, 'full');
    assert.deepEqual(result.files.map(({ path }) => path), ['src/app.js']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ci classify: the exclusions of the docs candidate policy, base and of the profile, are the full lane', async () => {
  const base = await classifyChange((directory) =>
    writeFiles(directory, {
      'docs/skills/usage.md': '# Usage\n',
      'docs/development/agent-notes.md': '# Notes\n',
      'docs/plain.md': '# Plain\n',
    }),
  );
  assert.equal(base.lane, 'full');
  assert.deepEqual(base.reasons, ['excluded-by-docs-policy']);
  assert.equal(base.files['docs/skills/usage.md'].reason, 'excluded-by-docs-policy');
  assert.equal(base.files['docs/development/agent-notes.md'].reason, 'excluded-by-docs-policy');
  assert.equal(base.files['docs/plain.md'].reason, 'docs');
  // A profile's own exclusions apply as in the docs candidate rule.
  const { directory, base: start } = await createRepository({
    extra: {
      docsCandidatePolicy: {
        ...DOCS_POLICY,
        excludedNames: [...DOCS_POLICY.excludedNames, 'RUNBOOK.md'],
        excludedSegments: [...DOCS_POLICY.excludedSegments, 'prompts'],
        excludedPrefixes: [...DOCS_POLICY.excludedPrefixes, 'docs/internal/'],
      },
    },
  });
  try {
    const result = await classify(
      directory,
      start,
      await commitChange(directory, (path) =>
        writeFiles(path, {
          'docs/team/runbook.md': '# Runbook\n',
          'docs/Prompts/review.md': '# Review\n',
          'docs/internal/plan.md': '# Plan\n',
          'docs/guide-2.md': '# Guide\n',
        }),
      ),
    );
    assert.equal(result.lane, 'full');
    assert.deepEqual(
      Object.fromEntries(result.files.map(({ path, reason }) => [path, reason])),
      {
        'docs/Prompts/review.md': 'excluded-by-docs-policy',
        'docs/guide-2.md': 'docs',
        'docs/internal/plan.md': 'excluded-by-docs-policy',
        'docs/team/runbook.md': 'excluded-by-docs-policy',
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ci classify: --head must be HEAD of the checkout', async () => {
  const { directory, base } = await createRepository();
  try {
    const headSha = await commitChange(directory, (path) =>
      writeFiles(path, { 'docs/extra.md': '# Extra\n' }),
    );
    const child = await ringi(directory, [
      'ci', 'classify', '--base', headSha, '--head', base, '--json',
    ]);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(JSON.parse(child.stdout).code, 'INVALID_CONFIGURATION');
    assert.match(child.stderr, /is not HEAD of the checkout/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ci classify: a copy (C) and a file replaced by a symbolic link (T) are real records', async () => {
  const { directory } = await createRepository();
  try {
    const lines = Array.from({ length: 20 }, (_, index) => `Line ${index + 1} of the source.\n`).join('');
    const base = await commitChange(directory, (path) =>
      writeFiles(path, { 'docs/source.md': `# Source\n\n${lines}` }),
    );
    const copied = await classify(
      directory,
      base,
      await commitChange(directory, (path) =>
        writeFiles(path, {
          'docs/source.md': `# Source\n\n${lines}One more line.\n`,
          'docs/copy.md': `# Source\n\n${lines}`,
        }),
      ),
    );
    assert.equal(copied.lane, 'docs');
    assert.deepEqual(
      copied.files.find(({ status }) => status === 'copied'),
      { path: 'docs/copy.md', oldPath: 'docs/source.md', status: 'copied', reason: 'docs' },
    );
    const changed = await classify(
      directory,
      head(directory),
      await commitChange(directory, async (path) => {
        await unlink(join(path, 'docs/copy.md'));
        await symlink('source.md', join(path, 'docs/copy.md'));
      }),
    );
    assert.equal(changed.lane, 'full');
    assert.deepEqual(changed.files, [
      { path: 'docs/copy.md', status: 'type-changed', reason: 'symlink' },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ci classify: a path that is not valid UTF-8 stops with DIFF_FAILED', async (t) => {
  const { directory, base } = await createRepository();
  try {
    const blob = git(directory, ['rev-parse', 'HEAD:docs/guide.md']).trim();
    const entry = Buffer.concat([
      Buffer.from(`100644 ${blob}\tdocs/`),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('.md\n'),
    ]);
    const added = spawnSync(realGit, ['update-index', '--index-info'], {
      cwd: directory,
      env: gitEnvironment,
      input: entry,
      shell: false,
    });
    if (added.status !== 0) {
      t.skip(`git cannot add a path that is not valid UTF-8 here: ${added.stderr}`);
      return;
    }
    git(directory, ['commit', '--quiet', '-m', 'test: invalid name']);
    const child = await ringi(directory, [
      'ci', 'classify', '--base', base, '--head', head(directory), '--json',
    ]);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(JSON.parse(child.stdout).code, 'DIFF_FAILED');
    assert.match(child.stderr, /not valid UTF-8/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ci classify: an output over the limit is DIFF_TOO_LARGE, a timeout stays TIMEOUT', async () => {
  const base = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const result = (fields) => ({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    stdoutLimitExceeded: false,
    ...fields,
  });
  // Answers rev-parse with the commit asked for (HEAD is headSha) and the
  // diff with the given result; no process starts.
  const runner = (diff) => ({
    async run(program, args) {
      assert.equal(program, 'git');
      if (args[0] === 'rev-parse')
        return result({
          stdout: `${args[3] === 'HEAD^{commit}' ? headSha : args[3].slice(0, 40)}\n`,
        });
      assert.equal(args[0], 'diff-tree');
      return result(diff);
    },
  });
  const run = (diff) =>
    classifyDiff({
      runner: runner(diff),
      cwd: '/synthetic/repository',
      base,
      head: headSha,
      ci: CI,
      docsCandidatePolicy: DOCS_POLICY,
      protectedPaths: [],
    });
  await assert.rejects(run({ stdoutLimitExceeded: true }), { code: 'DIFF_TOO_LARGE' });
  await assert.rejects(run({ code: 1, signal: 'SIGINT', timedOut: true }), {
    code: 'TIMEOUT',
  });
  await assert.rejects(run({ code: 128, stderr: 'fatal: bad object' }), {
    code: 'DIFF_FAILED',
  });
  assert.equal((await run({})).lane, 'full');
});

// --- The aggregator ----------------------------------------------------------

const JOBS = { docs: ['lint'], full: ['lint', 'test'] };
const needsOf = ({ lane = 'docs', classify = 'success', lint = 'success', test = 'skipped' } = {}) => ({
  classify: { result: classify, outputs: classify === 'success' ? { lane } : {} },
  lint: { result: lint, outputs: {} },
  test: { result: test, outputs: {} },
});
const aggregate = (lane, needs) =>
  aggregateNeeds({ lane, needs, classifyJob: 'classify', jobs: JOBS });

test('ci aggregate: green only when the classification and every job of the lane succeeded', () => {
  assert.deepEqual(aggregate('docs', needsOf()), {
    status: 'success',
    lane: 'docs',
    required: ['lint'],
    reasons: [],
  });
  assert.equal(aggregate('full', needsOf({ lane: 'full', test: 'success' })).status, 'success');
});

test('ci aggregate: every other result is red with its reasons', () => {
  const red = (lane, needs, pattern) => {
    const result = aggregate(lane, needs);
    assert.equal(result.status, 'failure', JSON.stringify(needs));
    assert.ok(result.reasons.some((reason) => pattern.test(reason)), result.reasons.join('; '));
  };
  for (const outcome of ['failure', 'cancelled', 'skipped', 'neutral']) {
    red('docs', needsOf({ lint: outcome }), /"lint" did not succeed/);
    red('full', needsOf({ lane: 'full', test: outcome }), /"test" did not succeed/);
  }
  // A job outside the lane must be skipped, whatever else it did.
  red('docs', needsOf({ test: 'success' }), /"test" is outside the docs lane/);
  red('docs', needsOf({ test: 'failure' }), /"test" is outside the docs lane/);
  // A missing job, a job of no lane, an entry without a result.
  const { test: _test, ...withoutTest } = needsOf({ lane: 'full' });
  red('full', withoutTest, /"test" is not in needs/);
  red('docs', { ...needsOf(), deploy: { result: 'skipped' } }, /"deploy" of needs belongs to no lane/);
  red('docs', { ...needsOf(), lint: {} }, /"lint" did not succeed \(unknown\)/);
});

test('ci aggregate: a classification job that did not succeed, is missing or names another lane is red', () => {
  const red = (lane, needs, pattern) => {
    const result = aggregate(lane, needs);
    assert.equal(result.status, 'failure');
    assert.match(result.reasons[0], pattern);
  };
  for (const outcome of ['failure', 'cancelled', 'skipped'])
    red('full', needsOf({ classify: outcome, lint: 'success', test: 'success' }), /classification job "classify" did not succeed/);
  const { classify: _classify, ...withoutClassify } = needsOf();
  red('docs', withoutClassify, /classification job "classify" is not in needs/);
  // The lane argument must be the lane the classification put out.
  red('docs', needsOf({ lane: 'full' }), /has no output lane=docs/);
  red('docs', { ...needsOf(), classify: { result: 'success' } }, /has no output lane=docs/);
});

test('ci aggregate: the command exits 0 only for a green check, 2 for invalid arguments', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ringi-ci-needs-')));
  try {
    const needsFile = join(directory, 'needs.json');
    const run = (needs, overrides = {}) => {
      const options = {
        '--lane': 'docs',
        '--needs': needsFile,
        '--classify-job': 'classify',
        '--docs-jobs': 'lint',
        '--full-jobs': 'lint,test',
        ...overrides,
      };
      return (async () => {
        if (needs !== undefined) await writeFile(needsFile, JSON.stringify(needs));
        return ringi(directory, [
          'ci',
          'aggregate',
          ...Object.entries(options).flatMap(([name, value]) =>
            value === undefined ? [] : [name, value],
          ),
        ]);
      })();
    };
    const green = await run(needsOf());
    assert.equal(green.status, 0, green.stderr);
    assert.match(green.stdout, /^required check: success \(lane docs; required jobs: lint\)\n$/);
    const red = await run(needsOf({ lint: 'failure' }));
    assert.equal(red.status, 1);
    assert.match(red.stdout, /^required check: failure/);
    assert.match(red.stdout, /"lint" did not succeed \(failure\)/);
    for (const overrides of [
      { '--lane': 'preview' },
      { '--lane': '' },
      { '--lane': undefined },
      { '--classify-job': 'lint' },
      { '--classify-job': 'two words' },
      { '--docs-jobs': 'lint,lint' },
      { '--docs-jobs': '' },
      { '--docs-jobs': 'lint,docs' },
      { '--full-jobs': 'test' },
      { '--needs': join(directory, 'missing.json') },
      { '--needs': directory },
    ]) {
      const child = await run(needsOf(), overrides);
      assert.equal(child.status, 2, JSON.stringify(overrides));
      assert.equal(child.stdout, '');
    }
    for (const needs of [[], 'success', { classify: 'success' }, { 'bad job': {} }]) {
      const child = await run(needs);
      assert.equal(child.status, 2, JSON.stringify(needs));
    }
    await writeFile(needsFile, '{');
    const child = await run(undefined);
    assert.equal(child.status, 2);
    assert.match(child.stderr, /the needs file cannot be read/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
