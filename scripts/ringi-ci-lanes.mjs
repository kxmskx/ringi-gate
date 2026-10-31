// The lanes of ringi ci: the classifier of a diff between two commits and
// the aggregator of the required check (see docs/ci.md). No model, no
// network, no secrets: the only processes are read-only Git commands, run
// with the core's process runner (timeout, output limit). The command
// itself (options, output, exit codes) is scripts/ringi-ci.mjs.
import { AgentWorkflowError, internal } from './agent-review-loop-lib.mjs';

export const CI_LANES = Object.freeze(['docs', 'full']);
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

const STAGE = 'preflight';
const GIT_TIMEOUT_MS = 2 * 60_000;
const MAX_GIT_SCALAR_BYTES = 64 * 1024;
// The whole raw diff, without a limit on the number of files: a diff over
// this size is not classified (DIFF_TOO_LARGE), never cut.
const MAX_RAW_DIFF_BYTES = internal.MAX_DIFF_BYTES;

// The raw diff: modes, object ids, the status (with the score of a rename or
// copy), then one path, or the source and the destination of a rename or
// copy. -r lists files, never trees.
const RAW_DIFF_ARGS = Object.freeze([
  'diff-tree',
  '-r',
  '-z',
  '--raw',
  '--no-abbrev',
  '--find-renames',
  '--find-copies',
  '--ignore-submodules=none',
  '--no-ext-diff',
  '--no-textconv',
]);
const RAW_HEADER =
  /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} ([ADMT]|[RC][0-9]{1,3})$/;
const RAW_STATUSES = Object.freeze({
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type-changed',
});
const ABSENT_MODE = '000000';
const DOCS_MODE = '100644';
const MODE_REASONS = Object.freeze({
  '100755': 'executable',
  '120000': 'symlink',
  '160000': 'submodule',
});

// Files that instruct agents or describe security, in every directory and
// whatever their letter case: never the docs lane.
const INSTRUCTION_FILE_NAMES = new Set([
  'agents.md',
  'claude.md',
  'security.md',
  'skill.md',
]);
const UNSAFE_NAME = /[\\\u0000-\u001f\u007f-\u009f]/;

// Git without the user's and the system's configuration, without replace
// objects, lazy fetches, optional locks or prompts. Every GIT_ variable of
// the environment is dropped: GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT
// would add configuration, GIT_DIR and GIT_WORK_TREE another repository.
export function ciGitEnvironment(source = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([name]) => !name.startsWith('GIT_')),
    ),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function diffFailed(message) {
  return new AgentWorkflowError(message, { code: 'DIFF_FAILED', stage: STAGE });
}

// A Git command of the classifier (and of ringi ci review). A failing
// command or one that cannot run is DIFF_FAILED, an output over the limit
// DIFF_TOO_LARGE; a timeout or an interruption keeps its own code. None of
// them is a lane.
export async function ciGit(
  runner,
  cwd,
  args,
  exactStdoutLimitBytes = MAX_GIT_SCALAR_BYTES,
  label = `git ${args[0]}`,
) {
  try {
    return await internal.requiredRun(
      runner,
      'git',
      args,
      {
        cwd,
        env: ciGitEnvironment(),
        stage: STAGE,
        timeoutMs: GIT_TIMEOUT_MS,
        exactStdoutLimitBytes,
      },
      label,
    );
  } catch (error) {
    if (error?.code === 'OUTPUT_LIMIT_EXCEEDED')
      throw new AgentWorkflowError(
        `${label}: the output is over ${exactStdoutLimitBytes} bytes; the diff is not classified.`,
        { code: 'DIFF_TOO_LARGE', stage: STAGE },
      );
    if (error?.code === 'PROCESS_FAILED' || error?.code === 'PROCESS_ERROR')
      throw diffFailed(error.message);
    throw error;
  }
}

// The records of `git diff-tree -r -z --raw`. The output is decoded as UTF-8
// by the process runner: a replacement character means a path that is not
// valid UTF-8 (or contains U+FFFD itself) and is refused, as is a record
// that is incomplete, has an unknown status or mode, or modes that do not
// fit its status.
export function parseRawDiff(text) {
  if (text.includes('�'))
    throw diffFailed('The raw diff has a path that is not valid UTF-8.');
  if (text === '') return [];
  if (!text.endsWith('\0'))
    throw diffFailed('The raw diff does not end with a complete record.');
  const fields = text.slice(0, -1).split('\0');
  const records = [];
  for (let index = 0; index < fields.length; ) {
    const header = RAW_HEADER.exec(fields[index]);
    if (!header)
      throw diffFailed(
        `Unknown record of the raw diff: ${JSON.stringify(fields[index].slice(0, 120))}.`,
      );
    const [, oldMode, newMode, status] = header;
    const letter = status[0];
    const pair = letter === 'R' || letter === 'C';
    const paths = fields.slice(index + 1, index + (pair ? 3 : 2));
    index += pair ? 3 : 2;
    if (paths.length !== (pair ? 2 : 1) || paths.includes(''))
      throw diffFailed('Incomplete record of the raw diff.');
    const known = (mode) => mode === DOCS_MODE || Object.hasOwn(MODE_REASONS, mode);
    if (
      !(letter === 'A' ? oldMode === ABSENT_MODE : known(oldMode)) ||
      !(letter === 'D' ? newMode === ABSENT_MODE : known(newMode))
    )
      throw diffFailed(
        `Record of the raw diff with modes that do not fit its status: ${JSON.stringify(fields[index - paths.length - 1])}.`,
      );
    records.push({
      status: RAW_STATUSES[letter],
      ...(pair ? { oldPath: paths[0], path: paths[1] } : { path: paths[0] }),
      oldMode,
      newMode,
    });
  }
  return records;
}

// Why a path is not plain documentation, or undefined when it is.
// excluded: the exclusions of the profile's docs candidate policy with the
// base exclusions of the core (internal.docsPolicyExcludes).
function pathReason(path, { docsPaths, protectedNames, excluded }) {
  const segments = path.split('/');
  if (UNSAFE_NAME.test(path)) return 'unsafe-name';
  if (segments.some((segment) => segment.startsWith('.'))) return 'dot-segment';
  if (internal.hasAsciiFoldingCharacter(path)) return 'ascii-folding-name';
  if (
    segments.some((segment) =>
      INSTRUCTION_FILE_NAMES.has(internal.asciiLowerCase(segment)),
    )
  )
    return 'instruction-file';
  if (excluded(path)) return 'excluded-by-docs-policy';
  if (protectedNames.has(internal.asciiLowerCase(path))) return 'protected-path';
  if (!path.endsWith('.md')) return 'not-markdown';
  if (!internal.reviewLanePathsMatch(docsPaths, path)) return 'outside-docs-paths';
  return undefined;
}

// The lane of the records: docs only when every file (both ends of a rename
// or copy) is plain documentation in mode 100644 on every side it exists;
// anything else, an empty diff included, is the full lane with its reasons.
// ci, docsCandidatePolicy: the resolved sections of the profile;
// protectedPaths: the files of the project profile (ringi.config.mjs and
// the modules it imports).
export function classifyRecords(
  records,
  { ci, docsCandidatePolicy, protectedPaths = [] },
) {
  const context = {
    docsPaths: ci.docsPaths,
    protectedNames: new Set(protectedPaths.map(internal.asciiLowerCase)),
    excluded: internal.docsPolicyExcludes(docsCandidatePolicy),
  };
  const files = records.map(({ status, path, oldPath, oldMode, newMode }) => {
    const reason =
      [oldMode, newMode]
        .filter((mode) => mode !== ABSENT_MODE && mode !== DOCS_MODE)
        .map((mode) => MODE_REASONS[mode])[0] ??
      (oldPath === undefined ? undefined : pathReason(oldPath, context)) ??
      pathReason(path, context) ??
      'docs';
    return { path, ...(oldPath === undefined ? {} : { oldPath }), status, reason };
  });
  const reasons =
    files.length === 0
      ? ['empty-diff']
      : [...new Set(files.map(({ reason }) => reason))].filter(
          (reason) => reason !== 'docs',
        );
  const lane = reasons.length === 0 ? 'docs' : 'full';
  return {
    schemaVersion: 1,
    lane,
    checks: [...ci.lanes[lane]],
    files,
    reasons,
  };
}

// Classifies the diff between two commits of the repository at cwd. Both
// must be full SHAs of commits, and head must be HEAD of the checkout, the
// commit the profile was loaded from (INVALID_CONFIGURATION otherwise);
// anything that prevents a classification throws with a STOP code and is
// never reported as a lane.
export async function classifyDiff({
  runner,
  cwd,
  base,
  head,
  ci,
  docsCandidatePolicy,
  protectedPaths,
}) {
  await verifyCommits(runner, cwd, { '--base': base, '--head': head });
  const checkout = await readCheckoutHead(runner, cwd);
  if (checkout !== head)
    throw new AgentWorkflowError(
      `--head ${head} is not HEAD of the checkout (${checkout}); the profile is read from HEAD, so check out --head first.`,
      { code: 'INVALID_CONFIGURATION', stage: STAGE },
    );
  return classifyRecords(await readRawDiff(runner, cwd, base, head), {
    ci,
    docsCandidatePolicy,
    protectedPaths,
  });
}

// Each value a full SHA of a commit of the repository at cwd, resolving to
// itself; the keys name them in the messages.
export async function verifyCommits(runner, cwd, commits) {
  for (const [name, sha] of Object.entries(commits)) {
    if (!COMMIT_SHA.test(sha))
      throw new AgentWorkflowError(
        `${name} must be a full commit SHA (40 lowercase hexadecimal characters).`,
        { code: 'INVALID_CONFIGURATION', stage: STAGE },
      );
    const commit = await ciGit(
      runner,
      cwd,
      ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
      MAX_GIT_SCALAR_BYTES,
      `${name} ${sha} is not a commit of the repository`,
    );
    if (commit.stdout.trim() !== sha)
      throw diffFailed(`${name} ${sha} resolves to another object.`);
  }
}

export async function readCheckoutHead(runner, cwd) {
  return (
    await ciGit(
      runner,
      cwd,
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      MAX_GIT_SCALAR_BYTES,
      'HEAD of the checkout cannot be read',
    )
  ).stdout.trim();
}

// The parsed raw diff between two verified commits.
export async function readRawDiff(runner, cwd, base, head) {
  const diff = await ciGit(
    runner,
    cwd,
    [...RAW_DIFF_ARGS, base, head, '--'],
    MAX_RAW_DIFF_BYTES,
    `git diff-tree ${base} ${head}`,
  );
  return parseRawDiff(diff.stdout);
}

// GitHub Actions job ids.
const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const JOB_RESULTS = new Set(['success', 'failure', 'cancelled', 'skipped']);

// The job list of an option: comma-separated job ids, at least one, no
// duplicate. undefined when the value is not one.
export function parseJobList(value) {
  if (typeof value !== 'string') return undefined;
  const jobs = value.split(',');
  return jobs.every((job) => JOB_ID.test(job)) && new Set(jobs).size === jobs.length
    ? jobs
    : undefined;
}

export function isJobId(value) {
  return typeof value === 'string' && JOB_ID.test(value);
}

// The required check from toJSON(needs) of GitHub Actions. Green only when
// the classification job succeeded with the same lane as output, every job
// of the lane succeeded and every other job of needs is a job of the full
// lane that was skipped. A missing job, a job that belongs to no lane and
// any other result is red; the reasons say why. jobs: { docs, full }, the
// docs jobs a subset of the full ones (as the lanes of the profile).
//
// Optional, for ringi ci review (each absent: nothing changes):
// reviewJob, the id of the review job, required in both lanes: its result
// is success, its output verdict APPROVE and its output lane the lane (the
// lane the review classified from the base's profile). enforceChecks: the
// output checks of the classification job (a JSON array of check names) is
// exactly the union of the output checks of the jobs of the lane, each a
// JSON array of the check names the job ran.
export function aggregateNeeds({
  lane,
  needs,
  classifyJob,
  jobs,
  reviewJob,
  enforceChecks = false,
}) {
  const reasons = [];
  const entry = (job) => (Object.hasOwn(needs, job) ? needs[job] : undefined);
  const result = (job) => {
    const value = entry(job)?.result;
    return JOB_RESULTS.has(value) ? value : 'unknown';
  };
  if (reviewJob !== undefined) {
    const review = entry(reviewJob);
    if (review === undefined)
      reasons.push(`the review job ${JSON.stringify(reviewJob)} is not in needs`);
    else if (result(reviewJob) !== 'success')
      reasons.push(
        `the review job ${JSON.stringify(reviewJob)} did not succeed (${result(reviewJob)})`,
      );
    else if (review.outputs?.verdict !== 'APPROVE')
      reasons.push(
        `the review job ${JSON.stringify(reviewJob)} has no output verdict=APPROVE`,
      );
    else if (review.outputs?.lane !== lane)
      reasons.push(
        `the review job ${JSON.stringify(reviewJob)} has no output lane=${lane}`,
      );
  }
  if (enforceChecks) {
    const expected = checkList(entry(classifyJob)?.outputs?.checks);
    const ran = new Set();
    for (const job of jobs[lane]) {
      const checks = checkList(entry(job)?.outputs?.checks);
      if (checks === undefined)
        reasons.push(
          `the ${lane} lane job ${JSON.stringify(job)} has no output checks (a JSON array of check names)`,
        );
      else for (const check of checks) ran.add(check);
    }
    if (expected === undefined)
      reasons.push(
        `the classification job ${JSON.stringify(classifyJob)} has no output checks (a JSON array of check names)`,
      );
    else {
      for (const check of expected)
        if (!ran.has(check))
          reasons.push(`the check ${JSON.stringify(check)} of the ${lane} lane ran in no job of the lane`);
      for (const check of [...ran].sort())
        if (!expected.includes(check))
          reasons.push(`the check ${JSON.stringify(check)} is not a check of the ${lane} lane`);
    }
  }
  const classification = entry(classifyJob);
  if (classification === undefined) {
    reasons.push(`the classification job ${JSON.stringify(classifyJob)} is not in needs`);
  } else if (result(classifyJob) !== 'success') {
    reasons.push(
      `the classification job ${JSON.stringify(classifyJob)} did not succeed (${result(classifyJob)})`,
    );
  } else if (classification.outputs?.lane !== lane) {
    reasons.push(
      `the classification job ${JSON.stringify(classifyJob)} has no output lane=${lane}`,
    );
  }
  const required = jobs[lane];
  for (const job of required) {
    if (entry(job) === undefined)
      reasons.push(`the ${lane} lane job ${JSON.stringify(job)} is not in needs`);
    else if (result(job) !== 'success')
      reasons.push(
        `the ${lane} lane job ${JSON.stringify(job)} did not succeed (${result(job)})`,
      );
  }
  for (const job of Object.keys(needs).sort()) {
    if (job === classifyJob || job === reviewJob || required.includes(job))
      continue;
    if (!jobs.full.includes(job))
      reasons.push(`the job ${JSON.stringify(job)} of needs belongs to no lane`);
    else if (result(job) !== 'skipped')
      reasons.push(
        `the job ${JSON.stringify(job)} is outside the ${lane} lane and was not skipped (${result(job)})`,
      );
  }
  return {
    status: reasons.length === 0 ? 'success' : 'failure',
    lane,
    required: [...required],
    reasons,
  };
}

// The output checks of a job: a JSON array of 1 to 100 distinct, non-empty
// check names of at most 200 characters; undefined for anything else.
function checkList(value) {
  if (typeof value !== 'string' || value.length > 64 * 1024) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.length <= 100 &&
    parsed.every(
      (check) => typeof check === 'string' && check.length > 0 && check.length <= 200,
    ) &&
    new Set(parsed).size === parsed.length
    ? parsed
    : undefined;
}

// toJSON(needs): an object of job ids, each an object with its result.
export function isNeedsObject(value) {
  const record = (item) =>
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item);
  return (
    record(value) &&
    Object.entries(value).every(([job, item]) => isJobId(job) && record(item))
  );
}
