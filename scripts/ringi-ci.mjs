// ringi ci: the CI adapter for GitHub Actions (see docs/ci.md). classify
// chooses the lane of a change from the real diff between two commits, with
// the ci section of the committed ringi.config.mjs; aggregate turns the
// results of the workflow's jobs into the required check. The classifier
// and the aggregator are in scripts/ringi-ci-lanes.mjs; this module reads
// the options and writes the output.
import { readFile, stat } from 'node:fs/promises';
import {
  AgentWorkflowError,
  createProcessRunner,
  internal,
  loadProjectProfile,
  redactSensitive,
} from './agent-review-loop-lib.mjs';
import { assertProfileCommitted, findRepositoryRoot } from './ringi-doctor.mjs';
import {
  CI_LANES,
  COMMIT_SHA,
  aggregateNeeds,
  classifyDiff,
  isJobId,
  isNeedsObject,
  parseJobList,
} from './ringi-ci-lanes.mjs';
import { runCiReview, scrubber, takeCredentials } from './ringi-ci-review.mjs';

export const CI_HELP = `Usage: ringi ci classify --base <sha> --head <sha> [--json] [--checks]
       ringi ci aggregate --lane docs|full --needs <file>
                          --classify-job <job> --docs-jobs <job,...>
                          --full-jobs <job,...> [--review-job <job>]
                          [--enforce-checks]
       ringi ci review --base <sha> --head <sha> --event <file>
                       --attempt <n> --out <dir> [--summary <file>]

classify chooses the lane of the change between two commits from the real
diff (git diff-tree), with the ci section of ringi.config.mjs, which must be
committed; --head must be HEAD of the checkout. Only plain documentation (a
.md file under ci.docsPaths, mode 100644 on both sides, not an instruction
or security file, not excluded by the docs candidate policy, not a file of
the profile, no segment starting with a dot) gets the docs lane; any other
change, an empty diff included, gets the full lane. It prints lane=<lane>
for $GITHUB_OUTPUT and a summary on standard error, or the classification
as JSON with --json. Read-only; no model, no network.

aggregate is the required check: it reads toJSON(needs) of GitHub Actions
from <file> and is green only when the classification job succeeded with
that lane, every job of the lane succeeded and every other job was skipped.

review (ci.review of the profile) reviews a pull request with a model: run
it with a trusted ringi-gate in a clean checkout of the base (--base, HEAD)
that has the merge commit (--head). It checks the budget, the credentials
and the trusted inputs, puts the merge commit's tree in the working tree
and runs ringi run --review-only on a task generated from the pull request
of --event, with only the git checks as gates. It prints verdict=, lane=
and run-id= for $GITHUB_OUTPUT and writes the evidence to --out.

Options:
  --base <sha>, --head <sha>  classify, review: full commit SHAs (40
                              lowercase hex)
  --json                      classify: print the classification as JSON
  --checks                    classify: also print checks=<JSON array>
  --lane docs|full            aggregate: the lane of the classification
  --needs <file>              aggregate: the needs context as JSON
  --classify-job <job>        aggregate: the id of the classification job
  --docs-jobs <job,...>       aggregate: the jobs of the docs lane
  --full-jobs <job,...>       aggregate: the jobs of the full lane (every
                              docs lane job among them)
  --review-job <job>          aggregate: the review job, required in both
                              lanes with verdict=APPROVE
  --enforce-checks            aggregate: the checks of the lane jobs must
                              be the classification's checks
  --event <file>              review: the pull_request event (JSON)
  --attempt <n>               review: the attempt of the job (re-runs
                              included), at most ci.review.maxAttempts
  --out <dir>                 review: where ci-review.json, report.json and
                              ledger.jsonl are written
  --summary <file>            review: the job summary is appended to it
  -h, --help                  Show this help

Exit code of classify: 0 when classified (either lane), 1 when the diff
cannot be classified (a STOP code), 2 for invalid arguments or outside a Git
repository. Exit code of aggregate: 0 only for a green check, 1 for a red
one, 2 for invalid arguments or a needs file that cannot be read. Exit code
of review: 0 only for APPROVE, 1 for any other result (a STOP code), 2 for
invalid arguments or outside a Git repository.
`;

// At most this many files outside plain documentation are named in the
// summary of classify.
const MAX_SUMMARY_FILES = 20;
const MAX_NEEDS_BYTES = 1024 * 1024;

const write = (stream, text) => stream.write(text.endsWith('\n') ? text : `${text}\n`);

function usageError(command, message) {
  write(process.stderr, `ringi ci${command ? ` ${command}` : ''}: ${message}\n\n${CI_HELP}`);
  return 2;
}

// --name value options and flags, each at most once; anything else is an
// error.
function parseOptions(args, valueOptions, flagOptions = []) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const known = valueOptions.includes(argument) || flagOptions.includes(argument);
    if (!known) return { error: `unknown option or argument ${JSON.stringify(argument)}.` };
    if (Object.hasOwn(values, argument))
      return { error: `${argument} is given more than once.` };
    if (flagOptions.includes(argument)) {
      values[argument] = true;
      continue;
    }
    if (index + 1 >= args.length) return { error: `${argument} needs a value.` };
    index += 1;
    values[argument] = args[index];
  }
  return { values };
}

export async function ciCommand(args) {
  const [subcommand, ...rest] = args;
  if (subcommand === 'classify') return classifyCommand(rest);
  if (subcommand === 'aggregate') return aggregateCommand(rest);
  if (subcommand === 'review') return reviewCommand(rest);
  return usageError(
    undefined,
    subcommand === undefined
      ? 'missing subcommand (classify, aggregate or review).'
      : `unknown subcommand ${JSON.stringify(subcommand)}.`,
  );
}

// A classification that did not happen: the STOP code on standard error,
// and with --json a stop report on standard output. Never a lane.
function classifyStopped(error, json) {
  const code = error instanceof AgentWorkflowError ? error.code : 'UNEXPECTED_ERROR';
  const message = redactSensitive(error instanceof Error ? error.message : String(error));
  if (json)
    write(
      process.stdout,
      JSON.stringify({ schemaVersion: 1, status: 'STOPPED', code, error: message }),
    );
  write(process.stderr, `ringi ci classify: ${code}: ${message}`);
  return 1;
}

async function classifyCommand(args) {
  const parsed = parseOptions(args, ['--base', '--head'], ['--json', '--checks']);
  if (parsed.error) return usageError('classify', parsed.error);
  const { values } = parsed;
  for (const name of ['--base', '--head']) {
    if (!Object.hasOwn(values, name)) return usageError('classify', `${name} is required.`);
    if (!COMMIT_SHA.test(values[name]))
      return usageError(
        'classify',
        `${name} must be a full commit SHA (40 lowercase hexadecimal characters).`,
      );
  }
  const json = values['--json'] === true;
  const runner = createProcessRunner({ output: { write() {} } });
  let root;
  try {
    root = await findRepositoryRoot(runner, process.cwd());
  } catch (error) {
    write(
      process.stderr,
      error instanceof AgentWorkflowError && error.code === 'INVALID_CONFIGURATION'
        ? `ringi ci classify: ${error.message}`
        : 'ringi ci classify: not inside a Git repository.',
    );
    return 2;
  }
  let result;
  try {
    // Only a committed profile is loaded, as in ringi run.
    await assertProfileCommitted({ runner, root });
    const { profile, projectProfile } = await loadProjectProfile({ repositoryRoot: root });
    await assertProfileCommitted({ runner, root, projectProfile });
    const { ci, docsCandidatePolicy } = internal.resolveRunnerProfile(profile);
    if (ci === undefined)
      throw new AgentWorkflowError(
        'ringi.config.mjs has no ci section; ringi ci needs one (see docs/ci.md).',
        { code: 'INVALID_CONFIGURATION', stage: 'preflight' },
      );
    result = await classifyDiff({
      runner,
      cwd: root,
      base: values['--base'],
      head: values['--head'],
      ci,
      docsCandidatePolicy,
      protectedPaths: projectProfile.files.map(({ path }) => path),
    });
  } catch (error) {
    return classifyStopped(error, json);
  }
  if (json) {
    write(process.stdout, JSON.stringify(result, null, 2));
    return 0;
  }
  write(process.stdout, `lane=${result.lane}`);
  // For ringi ci aggregate --enforce-checks: the lane's checks as one JSON
  // line (a check name has no control character).
  if (values['--checks'] === true)
    write(process.stdout, `checks=${JSON.stringify(result.checks)}`);
  const outside = result.files.filter(({ reason }) => reason !== 'docs');
  write(
    process.stderr,
    [
      `ringi ci classify: lane ${result.lane}, ${result.files.length} file(s)${result.reasons.length > 0 ? `; reasons: ${result.reasons.join(', ')}` : '; plain documentation only'}.`,
      `  checks: ${result.checks.join(', ')}`,
      ...outside
        .slice(0, MAX_SUMMARY_FILES)
        .map(
          ({ path, oldPath, reason }) =>
            `  ${reason}: ${oldPath === undefined ? '' : `${JSON.stringify(oldPath)} -> `}${JSON.stringify(path)}`,
        ),
      ...(outside.length > MAX_SUMMARY_FILES
        ? [`  and ${outside.length - MAX_SUMMARY_FILES} more (see --json)`]
        : []),
    ].join('\n'),
  );
  return 0;
}

async function aggregateCommand(args) {
  const parsed = parseOptions(
    args,
    ['--lane', '--needs', '--classify-job', '--docs-jobs', '--full-jobs', '--review-job'],
    ['--enforce-checks'],
  );
  if (parsed.error) return usageError('aggregate', parsed.error);
  const { values } = parsed;
  for (const name of ['--lane', '--needs', '--classify-job', '--docs-jobs', '--full-jobs'])
    if (!Object.hasOwn(values, name)) return usageError('aggregate', `${name} is required.`);
  const lane = values['--lane'];
  if (!CI_LANES.includes(lane))
    return usageError('aggregate', `--lane must be ${CI_LANES.join(' or ')}.`);
  const classifyJob = values['--classify-job'];
  const docs = parseJobList(values['--docs-jobs']);
  const full = parseJobList(values['--full-jobs']);
  if (!isJobId(classifyJob))
    return usageError('aggregate', '--classify-job must be a job id.');
  if (docs === undefined || full === undefined)
    return usageError('aggregate', '--docs-jobs and --full-jobs must be comma-separated job ids, without duplicates.');
  // The jobs of the docs lane are jobs of the full lane, as the checks of
  // the profile's lanes are; the classification job is in no lane.
  if (!docs.every((job) => full.includes(job)))
    return usageError('aggregate', 'every job of --docs-jobs must also be in --full-jobs.');
  if (full.includes(classifyJob))
    return usageError('aggregate', '--classify-job must not be a job of a lane.');
  const reviewJob = values['--review-job'];
  if (
    reviewJob !== undefined &&
    (!isJobId(reviewJob) || reviewJob === classifyJob || full.includes(reviewJob))
  )
    return usageError(
      'aggregate',
      '--review-job must be a job id, neither the classification job nor a job of a lane.',
    );
  let needs;
  try {
    const metadata = await stat(values['--needs']);
    if (!metadata.isFile()) throw new Error('not a regular file');
    if (metadata.size > MAX_NEEDS_BYTES)
      throw new Error(`over ${MAX_NEEDS_BYTES} bytes`);
    needs = JSON.parse(await readFile(values['--needs'], 'utf8'));
  } catch (error) {
    write(
      process.stderr,
      `ringi ci aggregate: the needs file cannot be read: ${redactSensitive(error instanceof Error ? error.message : String(error))}`,
    );
    return 2;
  }
  if (!isNeedsObject(needs)) {
    write(
      process.stderr,
      'ringi ci aggregate: the needs file is not toJSON(needs): an object of job ids, each an object.',
    );
    return 2;
  }
  const result = aggregateNeeds({
    lane,
    needs,
    classifyJob,
    jobs: { docs, full },
    reviewJob,
    enforceChecks: values['--enforce-checks'] === true,
  });
  write(
    process.stdout,
    [
      `required check: ${result.status} (lane ${lane}; required jobs: ${[...result.required, ...(reviewJob === undefined ? [] : [reviewJob])].join(', ')})`,
      ...result.reasons.map((reason) => `  ${reason}`),
    ].join('\n'),
  );
  return result.status === 'success' ? 0 : 1;
}

async function reviewCommand(args) {
  const parsed = parseOptions(args, [
    '--base',
    '--head',
    '--event',
    '--attempt',
    '--out',
    '--summary',
  ]);
  if (parsed.error) return usageError('review', parsed.error);
  const { values } = parsed;
  for (const name of ['--base', '--head', '--event', '--attempt', '--out'])
    if (!Object.hasOwn(values, name)) return usageError('review', `${name} is required.`);
  for (const name of ['--base', '--head'])
    if (!COMMIT_SHA.test(values[name]))
      return usageError(
        'review',
        `${name} must be a full commit SHA (40 lowercase hexadecimal characters).`,
      );
  if (!/^[1-9][0-9]{0,5}$/.test(values['--attempt']))
    return usageError('review', '--attempt must be a positive integer (GITHUB_RUN_ATTEMPT).');
  // Every credential-named variable leaves this process's environment
  // before its first child process (see runCiReview).
  const secrets = takeCredentials(process.env);
  const runner = createProcessRunner({ output: { write() {} } });
  let root;
  try {
    root = await findRepositoryRoot(runner, process.cwd());
  } catch (error) {
    write(
      process.stderr,
      error instanceof AgentWorkflowError && error.code === 'INVALID_CONFIGURATION'
        ? `ringi ci review: ${error.message}`
        : 'ringi ci review: not inside a Git repository.',
    );
    return 2;
  }
  let result;
  try {
    result = await runCiReview({
      runner,
      root,
      base: values['--base'],
      head: values['--head'],
      event: values['--event'],
      attempt: Number(values['--attempt']),
      outDirectory: values['--out'],
      summaryPath: values['--summary'],
      secrets,
    });
  } catch (error) {
    // The evidence could not be written: red, without a verdict.
    write(
      process.stderr,
      `ringi ci review: UNEXPECTED_ERROR: ${scrubber(secrets)(error instanceof Error ? error.message : String(error))}`,
    );
    return 1;
  }
  write(
    process.stdout,
    [
      `verdict=${result.verdict}`,
      ...(result.lane === null ? [] : [`lane=${result.lane}`]),
      ...(result.runId === null ? [] : [`run-id=${result.runId}`]),
    ].join('\n'),
  );
  write(
    process.stderr,
    result.verdict === 'APPROVE'
      ? `ringi ci review: APPROVE (lane ${result.lane}, review profile ${result.reviewProfile}).`
      : `ringi ci review: ${result.code}: ${result.error}`,
  );
  return result.verdict === 'APPROVE' ? 0 : 1;
}
