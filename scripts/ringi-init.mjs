// ringi init: creates ringi.config.mjs and tasks/example-task.md in the root
// of the Git repository it runs in. It never overwrites a file (exclusive
// create), never creates AGENTS.md or CLAUDE.md, runs no Git command that
// changes state, installs nothing and starts no agent.
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { internal } from './agent-review-loop-lib.mjs';

export const EXAMPLE_TASK_PATH = 'tasks/example-task.md';
// Package scripts that become gates when the project's package.json has
// them, always in the explicit run form the core executes.
const GATE_SCRIPTS = ['check', 'lint', 'test'];
const SCRIPT_TIMEOUT = '20 * 60_000';

// The gate names inferred from a parsed package.json (or undefined).
export function inferGates(packageJson) {
  const scripts =
    packageJson && typeof packageJson === 'object' ? packageJson.scripts : {};
  const names = GATE_SCRIPTS.filter(
    (name) =>
      scripts &&
      typeof scripts === 'object' &&
      Object.hasOwn(scripts, name) &&
      typeof scripts[name] === 'string',
  ).map((name) => `pnpm run ${name}`);
  return [...names, 'git diff --check'];
}

export function profileSource(gates) {
  const check = (name) => {
    if (name === 'git diff --check') {
      return [
        `    'git diff --check': {`,
        `      program: 'git',`,
        `      args: ['diff', '--check'],`,
        `      timeoutMs: 2 * 60_000,`,
        `    },`,
      ];
    }
    const script = name.slice('pnpm run '.length);
    return [
      `    '${name}': {`,
      `      program: 'pnpm',`,
      `      args: ['run', '${script}'],`,
      `      timeoutMs: ${SCRIPT_TIMEOUT},`,
      `    },`,
    ];
  };
  const list = (names) => names.map((name) => `'${name}'`).join(', ');
  return [
    '// Ringi Gate project profile, created by `ringi init`.',
    '//',
    '// The runner loads this file once, from the repository root, before the',
    '// first round, and records the SHA-256 of this file and of every module it',
    '// imports. If the writer (or a gate) changes any of them during a run, the',
    '// run stops with PROFILE_MODIFIED. Imports must be relative paths or',
    '// Node.js built-ins.',
    '//',
    '// Every field is described in docs/profile.md of Ringi Gate',
    '// (ringi-gate). Fields left out (taskSchema, taskClasses,',
    '// docsCandidatePolicy, implementer, reviewer) take the core defaults.',
    '//',
    '// checks: the only commands the runner may run as gates. A pnpm check',
    '// names a script of package.json and always runs as',
    '// `pnpm [--filter <package>] run <script>`; a git check is limited to',
    '// `git diff --check`. The check name must equal the program and its',
    '// arguments joined with spaces.',
    'export const PROFILE = {',
    "  title: 'RINGI',",
    "  tempPrefix: 'ringi-review-',",
    '  checks: {',
    ...gates.flatMap(check),
    '  },',
    '  // base: gates of every implementation task; docs: gates of',
    '  // documentation-only task classes.',
    '  checkSets: {',
    `    base: [${list(gates)}],`,
    "    docs: ['git diff --check'],",
    '  },',
    '  // Paths that require a check named in the task, for example',
    "  // { check: 'pnpm run test', prefixes: ['src/db/'], paths: [],",
    "  //   code: 'DATABASE_GATE' }.",
    '  requiredGateRules: [],',
    "  // Language of the runner's messages, of the agent prompts and of the",
    "  // default task schema: 'en' or 'pl'.",
    "  locale: 'en',",
    '};',
    '',
  ].join('\n');
}

export const EXAMPLE_TASK = `# Example task

A task template created by \`ringi init\`. Copy it, describe one change, and
run it with \`ringi run tasks/<name>.md --dry-run\` first. The section names
below are the canonical names of the default task schema for locale 'en'
(docs/profile.md).

## Goal

Describe what should change and why, in one or two sentences.

## Scope

- List the files or areas the writer may change.

## Acceptance criteria

- List observable results that show the task is done.

## Required checks

- \`git diff --check\`

## Constraints

- Do not add or update dependencies.

## Deferred items

- List related work that is out of scope for this task.
`;

async function present(path) {
  return lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function readPackageJson(root) {
  const metadata = await present(join(root, 'package.json'));
  if (!metadata?.isFile()) return { packageJson: undefined, note: 'missing' };
  try {
    return {
      packageJson: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
    };
  } catch {
    return { packageJson: undefined, note: 'invalid' };
  }
}

// Plans and (unless dryRun) creates the files. Returns the lines to print.
export async function runInit({ root, dryRun }) {
  const lines = [];
  const { packageJson, note } = await readPackageJson(root);
  const gates = inferGates(packageJson);
  const files = [
    {
      path: internal.PROJECT_PROFILE_FILE,
      content: profileSource(gates),
      detail: `gates: ${gates.join(', ')}`,
    },
    { path: EXAMPLE_TASK_PATH, content: EXAMPLE_TASK },
  ];
  if (dryRun) lines.push('ringi init --dry-run: nothing is written.');
  for (const file of files) {
    const absolute = join(root, file.path);
    const suffix = file.detail ? ` (${file.detail})` : '';
    if (await present(absolute)) {
      lines.push(`skip     ${file.path}: already exists, not overwritten`);
      continue;
    }
    if (file.path === EXAMPLE_TASK_PATH) {
      const directory = await present(join(root, 'tasks'));
      if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) {
        lines.push(`skip     ${file.path}: tasks is not a directory`);
        continue;
      }
    }
    if (dryRun) {
      lines.push(`create   ${file.path}${suffix}`);
      continue;
    }
    if (file.path === EXAMPLE_TASK_PATH) {
      await mkdir(join(root, 'tasks'), { recursive: true });
      // Checked again after mkdir: tasks must still be a real directory.
      const directory = await present(join(root, 'tasks'));
      if (!directory?.isDirectory() || directory.isSymbolicLink()) {
        lines.push(`skip     ${file.path}: tasks is not a directory`);
        continue;
      }
    }
    try {
      // wx: exclusive create, never replaces a file or follows a link.
      await writeFile(absolute, file.content, { flag: 'wx' });
      lines.push(`created  ${file.path}${suffix}`);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      lines.push(`skip     ${file.path}: already exists, not overwritten`);
    }
  }
  if (note === 'missing')
    lines.push(
      'note     package.json is missing: only `git diff --check` was added as a gate.',
    );
  if (note === 'invalid')
    lines.push(
      'note     package.json is not valid JSON: only `git diff --check` was added as a gate.',
    );
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    if (!(await present(join(root, name))))
      lines.push(
        `note     ${name} is missing at the repository root; the runner requires it (ringi init does not create it).`,
      );
  }
  lines.push(
    'next     commit ringi.config.mjs before ringi run (ringi init commits nothing; doctor and run refuse an uncommitted profile)',
    'next     ringi doctor',
  );
  return lines;
}
