# CI: `ringi ci` in GitHub Actions

`ringi ci` gives a project that uses Ringi Gate a cheap, fail-closed choice
of checks in CI:

- a change of plain documentation only runs the light checks (the `docs`
  lane);
- every other change, and every case the classifier is not sure of, runs
  the full checks (the `full` lane);
- one required check is always present, and it is green only after the
  exact set of jobs of the lane succeeded.

Classification and aggregation run no model and need no secret. Review by
a model in CI is opt-in (`ci.review` in the profile, `ringi ci review`); it
is the only part with a secret, and the [threat model](#threat-model) below
comes first.

| Piece | Where |
| --- | --- |
| The threat model of review in CI | [below](#threat-model) |
| The `ci` section of the profile | [profile.md](profile.md#ci) |
| `ringi ci classify` | [below](#ringi-ci-classify) |
| `ringi ci aggregate` | [below](#ringi-ci-aggregate) |
| `ringi ci review` | [below](#ringi-ci-review) |
| The example workflow | [`examples/github-actions/ringi-ci.yml`](../examples/github-actions/ringi-ci.yml) |
| The budget policy | [below](#budget-policy) |

## Threat model

Review in CI sends the change to a model, and the model's CLI needs a
secret (an API key or a token). The rules below decide where that secret
may be and which code may run next to it. They come first; the command,
the profile section and the example workflow follow them.

- **The workflow of a `pull_request` run comes from the pull request.**
  GitHub runs the workflow file of the merge commit, so an author with write
  access to the repository can change the workflow in the pull request
  itself: drop the review job, print the secret, run anything. Nothing
  written in the YAML protects against that author, and Ringi Gate does not
  claim it does.
- **The boundary of the secret is the GitHub `environment`, not the
  YAML.** The secret is an environment secret of an `environment` with
  required reviewers: a human approves every run of the review job before
  the secret is handed out, and should look at the change of `.github/`
  first. A pull request from a fork gets no secrets at all (GitHub's rule
  for `pull_request`), so its review job is red, never skipped. That is all
  these docs promise; code owner review of `.github/` and of the profile
  (see [Setup](#setup)) narrows who can change the workflow, it does not
  make a changed workflow safe.
- **In the job with the secret, only the base is code.** `ringi-gate`,
  `ringi.config.mjs` and the prompts come from a checkout of the pull
  request's base commit (`base.sha`), installed from the base's lockfile
  without install scripts. The pull request's tree is data: the diff and
  the snapshot the reviewer reads. None of its scripts, installations,
  hooks, profile or copy of Ringi Gate runs in that job. Concretely:
  - `ringi` is run from a separate checkout of the base (the *trusted*
    directory); the reviewed checkout is another directory whose `HEAD` is
    the base commit and whose working tree is the merge commit's tree;
  - the profile is loaded from `HEAD` of the reviewed checkout (the base)
    and must be committed there; a pull request that changes, adds,
    deletes or renames (either end) the profile or a module it imports,
    agent instructions or settings (`AGENTS.md`, `CLAUDE.md`,
    `CLAUDE.local.md`, `.mcp.json`, a `.claude` segment, at any depth and
    in any ASCII letter case), Corepack's `.corepack.env` (at any depth), a
    dependency input (`package.json`, the lockfiles, `.npmrc`,
    `.pnpmfile.cjs` and the other names the core's preflight treats as
    dependency inputs, at any depth), a `.patch` file,
    anything under `node_modules`, or that adds a symbolic link, is refused
    before any model starts (`HUMAN_DECISION_REQUIRED`): a person reviews
    such a change;
  - the dependencies of the reviewed checkout are installed from the base's
    lockfile before the pull request's tree is put in place. The core's
    preflight runs pnpm, which reads the dependency inputs of the working
    tree, but only ever in the base's version: a pull request that changes
    one is stopped before the review (above);
  - the gates of the review run are only the profile's `git` checks
    (`git diff --check`); checks that run the project's scripts (`pnpm …`)
    run in the lane jobs, which have no secret. A required gate rule that
    asks for such a check stops the review with its own code;
  - the reviewer CLI is installed in an exact version (never a range or
    `latest`) in a step without the secret: it is code from the npm
    registry, pinned by its version, not by an integrity hash. It reads the
    snapshot with read-only tools.
- **No `pull_request_target` with a checkout of the pull request, and no
  `workflow_run` that consumes artifacts of a pull request run as
  trusted.** Both would give the base repository's secrets or token to
  input written by the author of the change.
- **The secret is only in the `env` of the review step.** Never in an
  argument, a log line, an artifact or the job summary. `ringi ci review`
  removes it from its own environment before the run and hands it only to
  the reviewer's process; the other processes of the run (Git, the gates)
  do not get it, and every text the command writes has the secret's value
  replaced by `[REDACTED]` (a configured credential shorter than 8
  characters is refused, since its value could not be redacted reliably).
  Removing it from the environment only stops inheritance: a process of the
  same user on the runner could still read `/proc/<pid>/environ` of
  `ringi ci review` or of the reviewer. That is why no input of the pull
  request reaches a program that runs in the job: its scripts, dependency
  inputs, hooks and settings are never executed or read as configuration.

What this does not cover: a person who approves the environment without
looking at the change, a reviewer CLI that leaks its own credentials, and
the admin-managed settings of the reviewer CLI (see
[providers.md](providers.md)). The review is a check of the change, not of
the workflow that runs it.

## Setup

1. Add a `ci` section to `ringi.config.mjs` and commit it:

   ```js
   ci: {
     docsPaths: ['README.md', 'docs/'],
     lanes: {
       docs: ['git diff --check'],
       full: ['git diff --check', 'pnpm test'],
     },
   },
   ```

2. Copy `examples/github-actions/ringi-ci.yml` (it is also in the npm
   package, under `node_modules/ringi-gate/examples/github-actions/`) to
   `.github/workflows/` and replace its lane jobs with the jobs that run
   the checks of your lanes. Keep `--docs-jobs` and `--full-jobs` of the
   aggregator equal to those jobs. The workflow installs `ringi-gate` with
   pnpm from the project's lockfile (`pnpm exec ringi`).
3. In the branch protection (or ruleset) of the default branch, require
   the single check `ringi-ci required`. Do not require the lane jobs: a
   job outside the lane is skipped by design, and GitHub counts a skipped
   required check as passed.
4. Ask for code owner review of `.github/`, `ringi.config.mjs` and the
   modules it imports, `package.json` and the lockfile (see
   [what the classifier does not prove](#what-the-classifier-does-not-prove)).

## Lanes

A change is in the `docs` lane only when every file of its diff, both ends
of a rename or copy included, is plain documentation:

- its path matches `ci.docsPaths` (the dialect of review lane paths: a
  directory prefix ending with `/` or an exact file path, case-sensitive)
  and ends with `.md`;
- its mode is `100644` on every side where it exists (no symbolic link, no
  executable file, no submodule); an added or deleted file has one side;
- it is not an instruction or security file: no segment of its path is
  `AGENTS.md`, `CLAUDE.md`, `SECURITY.md` or `SKILL.md` in any ASCII letter
  case, in any directory;
- it is not excluded by the docs candidate rule of the core, with the same
  code ([profile.md](profile.md#docscandidatepolicy)): the base exclusions
  (the names `AGENTS.md` and `CLAUDE.md` and the segments `.git`,
  `.agents`, `.claude`, `.codex` and `skills`) and the profile's
  `docsCandidatePolicy.excludedNames`, `excludedSegments` and
  `excludedPrefixes` (by default `SECURITY.md`, `SKILL.md` and
  `docs/development/agent-`). Its allowed paths and extensions do not
  apply: `ci.docsPaths` and `.md` take their place;
- it is not a file of the profile (`ringi.config.mjs` and the modules it
  imports, compared in any ASCII letter case);
- no segment of its path starts with a dot (`.github/`, `.claude/`,
  `docs/.drafts/`);
- its name has no backslash or control character and no non-ASCII
  character that folds to an ASCII letter (such as U+212A, the Kelvin
  sign), so that a case-insensitive file system cannot turn it into one of
  the names above.

Everything else is the `full` lane with a reason, an empty diff included:
the classifier never says "nothing to check".

The `docs` lane's checks are a **subset** of the `full` lane's (the profile
refuses anything else, and the aggregator refuses `--docs-jobs` that are not
all in `--full-jobs`). The lanes are therefore ordered: moving a change from
`docs` to `full` only adds checks and never drops one. With disjoint lanes,
a change of documentation and code would skip the documentation checks, and
every new reason for `full` would change what is checked instead of only
adding to it.

## `ringi ci classify`

```sh
ringi ci classify --base <sha> --head <sha> [--json]
```

Classifies the real diff between two commits of the repository of the
current directory, never a declaration of the pull request (title, labels,
description, commit messages):

- `--base` and `--head` are full commit SHAs: exactly 40 lowercase
  hexadecimal characters (SHA-1 repositories), each the SHA of a commit of
  the repository (`git rev-parse --verify <sha>^{commit}`);
- `--head` must be `HEAD` of the checkout: the profile, its
  `protectedPaths` and its docs candidate policy are read from `HEAD`, so a
  different `--head` is `INVALID_CONFIGURATION`;
- the diff is `git diff-tree -r -z --raw --no-abbrev --find-renames
  --find-copies --ignore-submodules=none`, with no limit on the number of
  files: every record with both ends of a rename or copy and every deletion;
- the Git commands of the classifier (`rev-parse` of the commits and of
  `HEAD`, `diff-tree`) run without the user's and the system's
  configuration, without any `GIT_` variable of the environment, without
  replace objects, lazy fetches or optional locks, with a timeout of two
  minutes per command and an output limit of 16 MiB. The steps before them
  are those of `ringi run`, with their own Git environment: finding the
  repository root (`git rev-parse --show-toplevel`, with the configuration
  of the environment) and the committed-profile check (see
  [cli.md](cli.md#git-version));
- the output is decoded as UTF-8; a path that is not valid UTF-8, an
  incomplete or unknown record, an unknown mode or a mode that does not fit
  the status stops the classification.

`ringi.config.mjs` is loaded as by `ringi run`: only when it and the modules
it imports are committed and equal to `HEAD`.

Without `--json` standard output is one line, `lane=docs` or `lane=full`,
ready for `>> "$GITHUB_OUTPUT"`; standard error has a short summary (the
lane, its checks, the reasons and up to 20 files outside plain
documentation, paths in JSON quotes). With `--json`:

```json
{
  "schemaVersion": 1,
  "lane": "full",
  "checks": ["git diff --check", "pnpm test"],
  "files": [
    { "path": "docs/guide.md", "status": "modified", "reason": "docs" },
    { "path": "src/notes.md", "oldPath": "docs/notes.md", "status": "renamed", "reason": "outside-docs-paths" }
  ],
  "reasons": ["outside-docs-paths"]
}
```

`status` is `added`, `copied`, `deleted`, `modified`, `renamed` or
`type-changed`; `oldPath` is the source of a rename or copy. The reasons:

| Reason | Meaning |
| --- | --- |
| `docs` | Plain documentation (the file does not prevent the `docs` lane). |
| `executable`, `symlink`, `submodule` | A side of the file has mode `100755`, `120000` or `160000`. |
| `unsafe-name` | A backslash or a control character in the path. |
| `dot-segment` | A segment of the path starts with a dot. |
| `ascii-folding-name` | A non-ASCII character that folds to an ASCII letter. |
| `instruction-file` | `AGENTS.md`, `CLAUDE.md`, `SECURITY.md` or `SKILL.md` in any letter case. |
| `excluded-by-docs-policy` | An exclusion of the docs candidate rule: base, or of the profile's `docsCandidatePolicy`. |
| `protected-path` | A file of the profile. |
| `not-markdown` | The path does not end with `.md`. |
| `outside-docs-paths` | The path is not under `ci.docsPaths`. |
| `empty-diff` | The diff has no file (only in `reasons`). |

When the diff cannot be classified, `classify` prints no lane and exits with
`1` and a STOP code (with `--json`, a stop report `{ schemaVersion: 1,
status: 'STOPPED', code, error }`). The aggregator then sees a failed
classification job and the required check is red; a failure is never
turned into the `full` lane, which would hide it.

| Code | When |
| --- | --- |
| `INVALID_CONFIGURATION` | The profile is missing or invalid, it has no `ci` section, or `--head` is not `HEAD` of the checkout. |
| `PROFILE_UNCOMMITTED` | The profile or a module it imports is not committed or differs from `HEAD`. |
| `DIFF_FAILED` | A SHA is not a commit of the repository (also in a clone too shallow to have it), Git fails, or a record of the diff is invalid. |
| `DIFF_TOO_LARGE` | The raw diff is over 16 MiB. |
| `TIMEOUT` | A Git command took more than two minutes. |
| `INTERRUPTED` | The process was interrupted. |
| `UNEXPECTED_ERROR` | An error without a code of its own. |

Exit codes: `0` when classified (either lane), `1` when not (one of the
codes above), `2` for invalid arguments (a missing option, a SHA that is
not 40 lowercase hexadecimal characters, an unknown option), outside a Git
repository, or while `GIT_DIR` or `GIT_WORK_TREE` is set. Exit code `2`
prints a message on standard error only: no STOP code and, with `--json`,
no stop report.

In a job that runs in a container, `actions/checkout` marks the checkout
as a `safe.directory` in the global Git configuration, because the
directory belongs to another user than the container's. The classifier's
Git commands do not read the global configuration
(`GIT_CONFIG_GLOBAL=/dev/null`), so Git refuses the repository as one of
another owner and the classification stops with `DIFF_FAILED`
(fail-closed). Run the classification job without a container, or in a
container whose user owns the checkout directory.

In a pull request the example workflow classifies the merge commit GitHub
built (`--head`) against its first parent, the tip of the base branch
(`--base`): the change the merge would make. It also checks that the second
parent is the head of the pull request. `fetch-depth: 2` is enough.

With `--checks` (for `ringi ci aggregate --enforce-checks`), the plain
output has a second line, `checks=<JSON array>`: the checks of the lane, as
in the JSON output. Without it the output is the one line above.

## `ringi ci aggregate`

```sh
ringi ci aggregate --lane docs|full --needs <file> \
  --classify-job <job> --docs-jobs <job,...> --full-jobs <job,...> \
  [--review-job <job>] [--enforce-checks]
```

The required check. `<file>` holds `toJSON(needs)` of the aggregator job:
an object of job ids, each with its `result` and `outputs`. The check is
green only when:

- the classification job (`--classify-job`) is in `needs`, its result is
  `success` and its output `lane` equals `--lane`;
- every job of the lane is in `needs` with the result `success`;
- every other job of `needs` is a job of the `full` lane with the result
  `skipped`.

Anything else is red with a list of reasons: `failure`, `cancelled`, or
`skipped` of a job of the lane, a missing job, a job that belongs to no
lane, a job outside the lane that ran, an unknown result, a classification
that did not succeed or put out another lane. Exit codes: `0` only for
green, `1` for red, `2` for invalid arguments (a lane other than `docs` or
`full`, a job id that is not one, a duplicate, a `--docs-jobs` job missing
from `--full-jobs`, the classification job in a lane) or a needs file that
cannot be read or is not an object of objects.

The mapping of lanes to jobs comes from the arguments, not from a file or
the profile. The profile names checks, and only the workflow knows which
job runs them; the arguments stand in the workflow next to the `needs:`
list they describe, so one change of one file keeps them in step and one
review sees both. A separate mapping file would be a second place to keep
in sync and to protect. Nothing is guessed: every job of `needs` must be
named, and a job added to `needs` but not to a lane makes the check red.

Two options, each opt-in; without them the check is the one above:

- `--review-job <job>`: the job of `ringi ci review`, required in both
  lanes (a change of documentation gets a cheaper review, never none). It
  is green only with the result `success`, the output `verdict` equal to
  `APPROVE` and the output `lane` equal to `--lane`: the review classifies
  the change itself, with the base's profile, so a classification job that
  put out another lane makes the check red. The review job is neither the
  classification job nor a job of a lane (exit code `2` otherwise).
- `--enforce-checks`: the jobs, not only their names. The classification
  job's output `checks` (from `classify --checks`) must be exactly the
  union of the outputs `checks` of the jobs of the lane, each a JSON array
  of the check names the job ran. A check of the lane that no job ran, a
  job without the output, a check that is not one of the lane's, or an
  output that is not a JSON array of distinct names makes the check red.
  The outputs are written by the workflow's own steps, so this catches a
  workflow that has drifted from `ci.lanes` (a check added to the profile
  and to no job), not a workflow changed on purpose (see the
  [threat model](#threat-model)).

## `ringi ci review`

```sh
ringi ci review --base <sha> --head <sha> --event <file> \
  --attempt <n> --out <dir> [--summary <file>]
```

The review of a pull request by a model, with the `ci.review` section of
the profile ([profile.md](profile.md#ci)), as the
[threat model](#threat-model) requires. Run it with a `ringi-gate`
installed from a checkout of the base, in another checkout (the reviewed
one) that is clean, has `HEAD` at `--base` on a branch other than `main`
or `master`, the base's dependencies installed, and the merge commit
`--head`. `--event` is the `pull_request` event (`$GITHUB_EVENT_PATH`),
`--attempt` the attempt of the job (`$GITHUB_RUN_ATTEMPT`).

In this order, each step fail-closed:

1. Every variable whose name ends in `_KEY` or `_TOKEN` leaves the
   command's environment before its first process; none of the later
   processes gets it, except the reviewer below.
2. The profile is loaded from `HEAD` (the base) as by `ringi run`: committed,
   valid, with `ci.review`.
3. Budget of the workflow run: an `--attempt` (`run_attempt`, re-runs of
   the job included) over `ci.review.maxAttempts` stops before any model
   (`HUMAN_DECISION_REQUIRED`). Re-running the job does not help; a new run
   needs a new event (a push or an edit of the pull request) and a new
   approval of the environment.
4. Commits: `--base` is the base of the event and `HEAD`; `--head` is a
   merge commit whose first parent is `--base` and whose second parent is
   the head of the event. A merge commit that GitHub computed against
   another base (for example right after the base branch was changed) is
   refused (`INVALID_CONFIGURATION`), not reviewed. A re-run of the job has
   the same event and commits; a new event (a push or an edit of the pull
   request) brings the current merge commit.
5. Credentials: each name of `ci.review.credentials` must be set and at
   least 8 characters long; a pull request from a fork has none
   (`INVALID_CONFIGURATION`).
6. Trusted inputs: a diff record (added, modified, deleted, type-changed,
   both ends of a rename or copy) of the profile or a module it imports;
   `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`,
   `.corepack.env` or a name of the core's dependency inputs
   (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`,
   `.pnpmfile.cjs` and the others) at any
   depth, in any ASCII letter case; a name ending in `.patch`; a path with
   a `node_modules`, `.claude` or `.agent-review-loop` segment; or a
   symbolic link on the head side (mode `120000`, added or type-changed)
   stops (`HUMAN_DECISION_REQUIRED`): such a change is reviewed by a
   person. A symbolic link is refused whatever its target, so the
   code is not `SYMLINK_ESCAPE` (a link that leaves the repository).
7. The lane, classified from the diff with the base's profile, chooses the
   review profile (`ci.review.profiles`).
8. The task is generated from the pull request in the profile's task
   schema and validated: the class is the full track (`implementation`),
   the required checks are the `git` checks of its check set, and the title
   and the description (cut to 256 and 4000 characters) are quoted as one
   JSON string each, with `<`, `>`, `&`, the backtick and the control,
   format and bidirectional characters escaped, under a sentence that says
   they are data, not instructions. No heading, check name, HTML comment or
   line break of theirs reaches the Markdown of the task.
9. `git restore --source=<head> --worktree` makes the working tree the
   merge commit's tree (`HEAD` and the index stay the base), and the task is
   written to `.agent-review-loop/ci-review/task.md` (never over an existing
   file).
10. The run is `ringi run <task> --review-only --review-profile <profile>`
    of the profile, in the same process, with two differences that only
    `ringi ci review` sets: the gates are only the task's `git` checks (a
    routing rule's added checks included), and the credentials of
    `ci.review.credentials` are added to the reviewer's environment and to
    no other process. A run longer than `ci.review.timeoutMinutes` is
    cancelled (`TIMEOUT`). Every other rule of review-only applies: a
    finding is `HUMAN_DECISION_REQUIRED`, secret-like content in the change
    is `SECRET_DETECTED`, changed dependencies stop the preflight.

Output: standard output has `verdict=APPROVE` or `verdict=STOPPED`,
`lane=<lane>` once the lane is known and `run-id=<id>` once the run has one,
ready for `>> "$GITHUB_OUTPUT"`; standard error the code and the message.
`--out` gets `ci-review.json` and, after a run, the run's `report.json` and
`ledger.jsonl` byte for byte, for the job's artifact and for
`ringi verify <run-id>` in a later step. `ci-review.json` (`schemaVersion:
1`) has `verdict`, `code` and `error` (when not approved), `pullRequest`,
`base`, `head`, `lane`, `reviewProfile`, `runId`, `findings` (the open
findings) and `measurement`, the data per commit for routing:
`durationMs`, `runAttempt`, `maxAttempts`, `timeoutMinutes`,
`reviewAttempts` (attempts of the review profile), `contextBytes` (the
prompt bytes of the review lanes, `null` without lanes) and `costUsd`,
always `null`: no provider reports a cost to the core, so the limits are the
attempts and the time. `--summary` (`$GITHUB_STEP_SUMMARY`) gets a short
table: verdict, open findings, time, attempts, cost; never the diff, the
findings' text or a secret. In every text the command writes, each value of
a credential is replaced by `[REDACTED]`; a report or ledger of the run that
holds one is not copied and the verdict is `STOPPED` with
`INTEGRITY_CHECK_FAILED`.

| Code | When |
| --- | --- |
| `INVALID_CONFIGURATION` | No `ci.review`, an invalid profile or event, a commit that does not match, a missing credential, an unclean checkout. |
| `PROFILE_UNCOMMITTED` | The profile of the base is not committed. |
| `HUMAN_DECISION_REQUIRED` | Over the budget, a change of a trusted input, or a finding of the review. |
| `DIFF_FAILED`, `DIFF_TOO_LARGE` | Git cannot read a commit, a parent or the diff. |
| `INVALID_TASK`, `INVALID_TASK_PATH` | The generated task is refused, or its file cannot be written. |
| `TIMEOUT` | Over `ci.review.timeoutMinutes`. |
| `INTEGRITY_CHECK_FAILED` | Evidence would hold a credential. |
| any code of `ringi run` | The review-only run stopped. |

Exit codes: `0` only for `APPROVE`, `1` for any other verdict (and when the
evidence cannot be written), `2` for invalid arguments or outside a Git
repository. A skipped review job is never a pass: the aggregator requires
its success with `--review-job`.

## The example workflow

[`examples/github-actions/ringi-ci.yml`](../examples/github-actions/ringi-ci.yml)
follows these rules, and `node --test examples/validate-examples.test.mjs`
checks them in its text:

- events: `pull_request` of types `opened`, `edited`, `synchronize`,
  `reopened`, `ready_for_review` and `converted_to_draft`, and `push` to
  the default branch (change `branches: [main]` to the name of yours).
  `edited` covers a change of the pull request's base branch: without it
  the green check computed against the old base would stay. The price is
  that every edit of the title or the description runs the whole workflow
  again; no job is made conditional on what the edit changed
  (`github.event.changes.base`), since a job skipped by such a condition
  counts as a passed required check. As a complement, enable "Require
  branches to be up to date before merging" in the branch protection, so
  that a pull request behind its base is checked again before the merge.
  No `pull_request_target` (it would run with the base repository's
  token and secrets next to the pull request's code), no `paths-ignore` or
  `paths` (a workflow that does not run leaves the required check missing,
  and the classifier, not a path filter, chooses the checks);
- `permissions: contents: read` for the whole workflow, no secret, every
  checkout with `persist-credentials: false`, only `actions/*` actions,
  each pinned to a full commit SHA;
- concurrency: one group per workflow and pull request number, where a new
  push cancels the older run (`cancel-in-progress` only for
  `pull_request`); a push to the default branch has a group of its own
  (`run_id`) and is never cancelled;
- a draft runs only the light preflight (the classification); the lane
  jobs are skipped and the aggregator fails on purpose, so a draft never
  has a green required check. `ready_for_review` runs the lanes;
  `converted_to_draft` makes the check red again;
- the aggregator job has a fixed name, `ringi-ci required`, and
  `if: always()`, only so that it runs after a failed, cancelled or skipped
  job: without it the job would be skipped, and a skipped required check
  counts as passed. Its result is the exit code of `ringi ci aggregate`;
- a push to the default branch always runs the `full` lane;
- values of the event reach the scripts through `env`, never inside a
  `run:` script;
- `corepack enable pnpm` and `pnpm install --frozen-lockfile
  --ignore-scripts` install the project's `ringi-gate` from its lockfile
  without running install scripts, and `pnpm exec ringi ci …` runs it.
  Corepack ships with Node.js 24 but not with Node.js 25 and later; there,
  install it first or set up pnpm another way. Without a `packageManager`
  field in `package.json`, Corepack uses its default pnpm version, so set
  the field to pin it;
- no job of a lane has `continue-on-error`: a failed job would then count
  as a success in `needs`, and the aggregator could not see the failure.

### With review

[`examples/github-actions/ringi-ci-review.yml`](../examples/github-actions/ringi-ci-review.yml)
is the same workflow with a `review` job; use one of the two. It is a
second file and not an option of the first because the first must stay a
workflow without any secret, and a complete one because the aggregator can
only `needs` jobs of its own workflow. Its test checks, in addition:

- the `review` job has `environment: ringi-review` (create it with required
  reviewers and put the secret there, not in the repository's secrets) and
  runs for every pull request that is not a draft, in both lanes;
- `secrets.` appears once, in the `env` of the step `Review`, never in a
  `run:` script;
- the base is checked out to `trusted` (`ref: base.sha`) and installed with
  `--ignore-scripts`; the merge commit is checked out to `review` as data,
  switched to a branch at the base and given the base's dependencies before
  `ringi ci review` puts the pull request's tree in place; every `ringi` of
  the job is `trusted/node_modules/.bin/ringi`, never `pnpm exec`;
- the reviewer CLI is installed in an exact version;
- `ringi verify <run-id>` runs after the review;
- the lane jobs put out `checks`, and the aggregator runs with
  `--enforce-checks --review-job review` (without the review job on a push
  to the default branch, which has no review);
- the permissions stay `contents: read`. A job that comments on the pull
  request would need `pull-requests: write`; keep it a separate job without
  the environment and the secret. The example has none.

The evidence directory is not uploaded by the example: that needs
`actions/upload-artifact` pinned to a full commit SHA, which the example
does not pin yet. Add the step with the SHA of a release you reviewed; it
uploads `ci-review.json`, `report.json` and `ledger.jsonl`, none of which
holds the secret.

`merge_group` (the merge queue) is not supported: the workflow does not run
for it, so in a merge queue the required check would be missing. Do not add
`merge_group` to this workflow without classifying the queue's commits.

GitHub itself skips `push` and `pull_request` workflows for a commit whose
message contains `[skip ci]` or a similar marker. The required check is
then missing and the pull request cannot be merged; push again without the
marker.

## Budget policy

CI minutes are a budget, and the rules below keep it without weakening the
required check:

- **One coherent pull request instead of many.** Every pull request and
  every push to it costs at least a classification and an aggregation; a
  change split into many small pull requests multiplies them. Push a
  finished set of commits, not every commit.
- **Draft while the work goes on.** A draft runs only the preflight; mark
  it ready for review once, when it is complete.
- **Re-run only failed jobs, and only after a failure of the
  infrastructure** (a lost runner, a network or service outage), with "Re-run
  failed jobs". A check that fails because of the change is fixed by a new
  commit, not re-run.
- **No retry loop when the minutes are exhausted.** A job that cannot start
  for lack of minutes or a spending limit is not retried automatically or
  by hand in a loop: wait for the quota or raise the limit, then re-run the
  failed jobs once.
- **The review has a budget per workflow run, and the approval of the
  environment is the limit of the cost across runs.** `ci.review.maxAttempts`
  bounds the attempts of the review job in one run (`$GITHUB_RUN_ATTEMPT`,
  re-runs included); over it the job is red before any model starts. Ringi
  Gate keeps no count across runs: a new run of the same commit (an edit of
  the pull request, a reopen) starts again at attempt 1, and only the
  person who approves the environment decides whether it reviews again, so
  approve it only when the commit has not been reviewed yet. The time of
  the review is bounded by `ci.review.timeoutMinutes`; set the job's
  `timeout-minutes` above it plus the checkouts, the installations and the
  preflight (the example: 30 and 50), so that `ringi ci review` stops first
  with `TIMEOUT` and its evidence, and the job's limit is only a backstop.
  There is no cost limit: no provider reports a cost to the core.
- **No way around the required check.** No merge by an administrator over
  a red or missing check, no removing the requirement, no `[skip ci]` to
  merge, no change of the workflow that skips a lane. An exception is a
  human decision, recorded in the pull request.

## What the classifier proves

For the two commits it is given: every file of their diff, both ends of a
rename or copy included, is plain documentation by the rules above, read
from Git objects (not from the pull request's declaration), without
replace objects or the user's Git configuration. Otherwise the lane is
`full`, or there is no lane at all.

## What the classifier does not prove

- **Not that the documentation is right or harmless.** The `docs` lane
  replaces checks, not review. A document can describe a contract (in this
  project: [contract.md](contract.md)) or instructions that a person or a
  later agent follows; such a change needs review of its content like
  code. Keep such documents out of `docsPaths` (list the directories of
  plain documentation, not every `docs/`), or review them in the pull
  request.
- **Not that the workflow, the profile or Ringi Gate can be trusted.** In a
  `pull_request` run, the workflow file, `ringi.config.mjs` and the
  installed `ringi-gate` come from the pull request's merge commit. A
  change of `.github/` or of the profile is in the `full` lane, but the
  same change could also alter what the `full` lane runs or the aggregator
  itself. The classifier protects against mistakes and against a wrong
  declaration, not against an author who changes CI: protect `.github/`,
  the profile and its modules, `package.json` and the lockfile with code
  owner review.
- **Not that the jobs run the profile's checks.** The profile names the
  checks of each lane and the classifier prints them; which job runs which
  check is the workflow's. With `--enforce-checks` the aggregator compares
  the checks the lane jobs say they ran with the classification's; the
  jobs' outputs are still written by the workflow.
- **Not that the base is the right one.** The classifier compares the two
  commits it is given; the workflow chooses them (in the example: the
  merge commit and its first parent, checked against the pull request's
  head).
