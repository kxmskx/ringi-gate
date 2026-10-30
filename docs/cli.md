# The `ringi` command

`ringi` runs Ringi Gate on the Git repository of the current directory, with
the project profile from `ringi.config.mjs` at that repository's root. It has
four commands:

- `ringi init` prepares a project: a profile and a task template;
- `ringi doctor` checks the repository and the machine before a run;
- `ringi run <task.md> [options]` runs the writer, the gates and the
  independent review;
- `ringi verify <runId>` verifies the evidence ledger of a run.

From version 0.1.0 the npm package `ringi-gate` installs the command
(see [Installation from npm](../README.md#installation-from-npm)). The
alternative is to run the entry point with Node.js from a checkout of
ringi-core, for example:

```sh
node /path/to/ringi-core/bin/ringi.mjs doctor
```

`package.json` declares `"bin": { "ringi": "bin/ringi.mjs" }`, so a package
manager that installs ringi-core from a checkout would link it as `ringi`;
nothing in this repository does that for you. The examples below write
`ringi` for whichever form you use.

Keep the ringi-core checkout outside the repository you run it on and
outside any directory the writer can write to (for example a temporary
directory its sandbox allows): its modules are runner code, loaded without a
fingerprint, so a writer that could change them would change the runner of
the next run.

`ringi` finds the repository from the current directory only. While
`GIT_DIR` or `GIT_WORK_TREE` is set, every command refuses to run
(`INVALID_CONFIGURATION`); unset them first.

## Git version

Use Git 2.45 or newer. The committed-profile check of `ringi run` and
`ringi doctor` runs its Git commands with `GIT_NO_LAZY_FETCH=1`, so that in
a partial clone Git does not fetch a missing object from the remote (see
[profile.md](profile.md#protection-of-ringiconfigmjs)). `ringi doctor` does
not check the Git version.

The earlier entry point, `node scripts/agent-review-loop.mjs`, still works
unchanged: it runs on the repository that contains its `scripts/` directory
with the profile `scripts/agent-review-profile.mjs` (see
[profile.md](profile.md#where-it-lives)).

## Global options and exit codes

| Invocation | Result |
| --- | --- |
| `ringi --help`, `ringi -h` | Help, exit code `0`. |
| `ringi <command> --help` | Help of the command, exit code `0`. |
| `ringi --version` | `ringi (Ringi Gate) <version>` with the `version` of ringi-core's `package.json`, exit code `0`. |
| no command, an unknown command or an unknown option | A one-line error and the help on standard error, exit code `2`. |

Messages of the `ringi` command are in English. The messages of the runner
itself (stop reasons in reports, the dry-run plan's `sequence`, the argument
parser's errors, the terminal dashboard) follow the profile's `locale`:
English by default, Polish with `locale: 'pl'` (see
[profile.md](profile.md#locale)). The usage line of `ringi run` stays
English.

## `ringi init`

```sh
ringi init [--dry-run]
```

Run it in the root of a Git repository (the directory that contains `.git`);
anywhere else it stops with exit code `1` and writes nothing. It creates:

- `ringi.config.mjs`: a profile whose gates are `pnpm run check`,
  `pnpm run lint` and `pnpm run test` for those of the scripts `check`,
  `lint` and `test` that the project's `package.json` defines, plus
  `git diff --check`. All of them form the `base` check set; the `docs` set
  is `git diff --check`. Comments in the file explain the fields and point
  to [profile.md](profile.md). The other profile fields take the core
  defaults. The generated profile passes the core validation (tested).
- `tasks/example-task.md`: a task template with the canonical section names
  of the default task schema for `locale: 'en'` (`Goal`, `Scope`,
  `Acceptance criteria`, `Required checks`, `Constraints`,
  `Deferred items`); its only required check is
  `git diff --check`. It passes the core task parser with the generated
  profile (tested).

Rules:

- An existing file is never overwritten. It is reported as `skip` and left as
  it is; files are created with an exclusive create, so a file or symbolic
  link that appears in the meantime is not replaced either. There is no
  `--force`. The exclusive create protects the file itself, not the
  directories above it: `tasks` is checked again after it is created and
  must be a real directory, not a symbolic link (otherwise the task is
  skipped), but a change of `tasks` by another process between that check
  and the write is not detected.
- `AGENTS.md` and `CLAUDE.md` are never created. When one is missing, `init`
  prints a note: the runner requires both at the repository root.
- No Git command that changes state, no installation, no agent. The only
  process `init` starts is `git rev-parse --show-toplevel`. `init` commits
  nothing; `ringi doctor` and `ringi run` refuse an uncommitted profile
  (`PROFILE_UNCOMMITTED`), so commit `ringi.config.mjs` before `ringi run`.
- `--dry-run` prints what would be created and writes nothing.

Example on an empty repository (from the tests):

```text
$ ringi init --dry-run
ringi init --dry-run: nothing is written.
create   ringi.config.mjs (gates: git diff --check)
create   tasks/example-task.md
note     package.json is missing: only `git diff --check` was added as a gate.
note     AGENTS.md is missing at the repository root; the runner requires it (ringi init does not create it).
note     CLAUDE.md is missing at the repository root; the runner requires it (ringi init does not create it).
next     commit ringi.config.mjs before ringi run (ringi init commits nothing; doctor and run refuse an uncommitted profile)
next     ringi doctor
```

`init` does not edit `package.json`: pinning `packageManager` and installing
dependencies stay with you, and `ringi doctor` checks them.

## `ringi doctor`

```sh
ringi doctor [--json]
```

Read-only checks of the repository of the current directory and of this
machine. `doctor` calls no model and uses no network; the only processes it
starts are read-only Git commands and the agent CLIs' version commands
(`codex --version`, `claude --version`), the same ones the run's preflight
starts. It does load `ringi.config.mjs`, which runs the profile's own code,
as a run does, but only after `profile-committed` found it committed and
equal to `HEAD`; otherwise it is not imported.

Each check has the status `ok`, `warn` or `fail`. A check that failed has a
short hint (`fix:` in the table, `hint` in JSON) and, when the failure came
from the runner, the runner's stop `code` and `message` (JSON). A check that
depends on a failed one is `warn` with `not checked: … failed`.

| Check | What it verifies | Shared runner function |
| --- | --- | --- |
| `node` | Node.js 24 or newer | — (`engines` of ringi-core) |
| `git-repository` | the current directory is inside a Git working tree, and neither `GIT_DIR` nor `GIT_WORK_TREE` is set | `git rev-parse --show-toplevel` through the runner's `requiredRun` |
| `runner-location` | the runner installation (the directory of `bin/` and `scripts/`) lies outside the repository; inside it (for example `node_modules/ringi-gate`) the check is `warn`, with the hint to install the runner outside (globally or through `npx` from the npm cache): a writer can change those files, and a change made before a run is not detected | `RUNNER_ROOT` |
| `branch` | a branch is checked out and it is not `main` or `master` | `readBranch`, `WORKING_BRANCHES_BLOCKED` |
| `staged-changes` | nothing is staged in the repository's index | `assertNoStagedChanges` |
| `package-manager` | `package.json` has `packageManager: pnpm@<exact version>` | `readPinnedPnpmVersion` |
| `corepack-cache` | that pnpm version is in the local Corepack cache (no symbolic links, within the size limits, integrity suffix matching when present) | `resolveCorepackHome`, `walkCorepackTree`, `validatePinnedCorepackIntegrity` |
| `agents-md`, `claude-md` | `AGENTS.md` and `CLAUDE.md` can be read at the repository root | the same `readFile` as the run |
| `profile-committed` | before the import: the bytes of `ringi.config.mjs` on disk hash to the blob of `HEAD:ringi.config.mjs` and of its index entry, a regular file without `skip-worktree` or `assume-unchanged` (no `git status`, no fsmonitor, no filters; see [profile.md](profile.md#protection-of-ringiconfigmjs)); otherwise, also when Git cannot be read, `fail` with `PROFILE_UNCOMMITTED`, the profile is not imported and the checks that need it are `not checked` | `readUncommittedProjectProfileFiles` |
| `profile` | `ringi.config.mjs` exists, loads under the rules of [profile.md](profile.md#protection-of-ringiconfigmjs), passes the profile validation and the run's fingerprint check right after the load, and every module it imports is committed and equal to `HEAD` (otherwise `PROFILE_UNCOMMITTED`; their code has run by then) | `loadProjectProfile` (which uses `resolveRunnerProfile`), `assertProjectProfileUnchanged`, `readUncommittedProjectProfileFiles` |
| `providers` | the profile's implementer and reviewer map to provider modules that serve those roles; a module that breaks the role rules fails here with `PROVIDER_ROLE_NOT_ALLOWED` | `resolveRunnerProfile`, `roleProvider` |
| `repository-layout` | for an implementer whose Git directory is checked (Claude Code, modules from `providerModules`): no linked worktree, submodule or object alternates | `assertImplementerRepositoryLayout` |
| `implementer-cli` | the implementer CLI answers `--version`, and its module's preflight accepts the version and platform (Codex CLI and Claude Code: any version, on macOS or Linux); `warn` with `UNPROBED_VERSION` and the probed versions when the module lists `probedVersions` for the role and the version is not one of them or cannot be read (see [providers.md](providers.md#contract)) | `environmentReport` |
| `reviewer-cli` | the reviewer CLI answers `--version`, and its module's preflight, when it has one, accepts the version and platform (Claude Code: any version, on macOS or Linux); `warn` with `UNPROBED_VERSION` as for `implementer-cli` | `environmentReport` |

These are the preflight steps of a run, not all of them: a run also checks
the task file, the secret scan, the dependency fingerprints and installed
dependency state, and copies the Corepack cache and runs the pinned
`pnpm --version` in an isolated environment. `doctor` passing does not
guarantee that a run's preflight passes.

Output: a table on standard output, or with `--json` an object
`{ schemaVersion: 1, status: 'ok' | 'fail', summary: { ok, warn, fail },
checks: [{ id, status, detail, hint, code?, message? }] }`. Exit code `0`
when no check fails, `1` when one fails, `2` for an unknown option; a
`warn` (such as `UNPROBED_VERSION`) keeps status `ok` and exit code `0`.

Example on a synthetic repository with stand-in agent CLIs (from the tests):

```text
$ ringi doctor
STATUS  CHECK              DETAIL
ok      node               Node.js 24.19.0
ok      git-repository     inside a Git working tree
ok      runner-location    runner installed outside the repository
ok      branch             on feat/ringi-test
ok      staged-changes     nothing staged
ok      package-manager    packageManager pnpm@11.20.0
ok      corepack-cache     pnpm 11.20.0 in the local Corepack cache
ok      agents-md          AGENTS.md present
ok      claude-md          CLAUDE.md present
ok      profile-committed  ringi.config.mjs is committed and matches HEAD (checked before the import)
ok      profile            ringi.config.mjs valid; 1 module(s), sha256 e3a2ab45081e
ok      providers          implementer codex, reviewer claude
ok      repository-layout  layout accepted for implementer codex
ok      implementer-cli    codex: codex-cli 0.160.0
ok      reviewer-cli       claude: 2.1.285 (Claude Code)

ringi doctor: 15 ok, 0 warn, 0 fail
```

## `ringi run`

```sh
ringi run path/to/task.md [--dry-run] [--task-mode implementation|analysis]
  [--review-only] [--checkpoint] [--resume <runId>]
  [--review-profile <name>] [--implementer-model <id>]
  [--implementer-effort <effort>] [--verbose] [--no-animation] [--json]
```

The same run as `node scripts/agent-review-loop.mjs` (see
[architecture.md](architecture.md)), with two differences:

- the repository is the Git repository of the current directory (any
  subdirectory works); the task path is relative to its root;
- the profile is that repository's `ringi.config.mjs`, loaded and
  fingerprinted once before anything else runs (see
  [profile.md](profile.md#where-it-lives)). The report and the dry-run
  plan carry an extra field `projectProfile` with its path and fingerprint,
  and with `committed` and `uncommitted`: the profile files that differ
  from `HEAD` or are not committed at the start of the run (always
  `committed: true` with `ringi run`, see below).

Only a committed profile runs. Before the import, the runner hashes the
bytes of `ringi.config.mjs` on disk as a Git blob and compares the id with
the blob of `HEAD:ringi.config.mjs` and with its index entry (not
`git status`, which trusts index flags, `core.fsmonitor` and
`.gitattributes`); when it differs, is missing from `HEAD` or the index, is
flagged `skip-worktree` or `assume-unchanged`, is not a regular file, or
Git cannot be read, the run stops with `PROFILE_UNCOMMITTED` and the file
is not imported. After the load, before any agent process and before the
dry-run plan, every module it imports is checked the same way, with the
same code; the code of those modules (and of the committed
`ringi.config.mjs`) has run by then. The blob in `HEAD` comes from the
repository's object database, which a writer with write access to `.git`
could rewrite; that run still stops (`UNEXPECTED_GIT_MUTATION` or
`PROFILE_MODIFIED`) and nothing is reverted, so check `git log` after such
a stop. `ringi init` commits nothing: commit the profile first.

The options are the options of `scripts/agent-review-loop.mjs`, passed to
the same parser; their allowed values come from the profile. The usage line
printed with an argument error is in English; the error itself comes from
the shared parser. `--codex-model` and `--sol-effort` are deprecated aliases
of `--implementer-model` and `--implementer-effort` with the same
validation; giving an alias together with its new option is an argument
error.

### Review only

```sh
ringi run tasks/my-task.md --review-only --dry-run
ringi run tasks/my-task.md --review-only
ringi run tasks/my-task.md --review-only --review-profile critical-opus --json
```

`--review-only` sends a change that is already in the working tree through
the gates and the independent review without starting the writer: for a
change written by hand, or for a second opinion on a change made elsewhere.
The candidate is exactly what a writer round leaves behind: the uncommitted
changes relative to `HEAD` (modified, deleted and new, non-ignored files),
nothing staged.

- The preflight is the same, apart from the writer: its CLI is neither
  required nor probed (in the dry-run plan `agents.codex` and
  `agents.implementer.version` are `null`), there is no sandbox check and no
  writer layout check. `ringi
  doctor` is unchanged and still checks the implementer's CLI.
- The fingerprints (dependencies, the repository manifest, `HEAD`, the
  branch, the profile and the runner) are taken from the working tree at the
  start; secret-like content in the changes that is not in `HEAD` stops the
  run with `SECRET_DETECTED`, as in every preflight. So a change written by
  hand may change `package.json`, lockfiles or `.npmrc`, which after a
  writer round would stop the run with `DEPENDENCY_INPUT_CHANGED`; review
  such a change yourself, since the gates run with the dependencies
  installed before it.
- One round: the gates of the task, the read-only snapshot and the review.
  Any change of the working tree after the preflight, during the gates or
  during the review stops the run (`WORKING_TREE_CHANGED` and the other
  integrity codes).
- No finding: `APPROVE` (`publicationApproved: false`). Any finding stops the
  run with `HUMAN_DECISION_REQUIRED` (stage `reviewer`); there is no
  correction round, and the findings with their `findingId` and severity
  are in `findings` and `findingPolicy` of the report.

Stops before the gates: no uncommitted change other than the task file is
`INVALID_TASK`; a task class that skips the independent review (for example
`docs-minor`) is `INVALID_TASK_CLASS`; a staged change is `STAGED_CHANGES`.
`--task-mode analysis`, `--implementer-model` and `--implementer-effort`
(and their aliases) together with `--review-only` are argument errors (exit
code `2`); the analysis candidate is the writer's artifact. The report and
the dry-run plan carry `runMode: 'review-only'`; see
[profile.md](profile.md#report-fields).

### Review lanes

A profile with [`reviewLanes`](profile.md#reviewlanes) needs no option:
`ringi run` (also with `--review-only`, `--checkpoint` and `--resume`) runs
every lane in parallel in each review round and merges their findings (see
[architecture.md](architecture.md#review-lanes)). `--review-profile` sets
the review profile of every lane that names none. A lane without a valid
result stops the run with that lane's stop code; the report's `lane` field
names it, and `reviewer.lanes` lists every lane with its status. A
resumable stop (for example `CLAUDE_PROCESS_FAILED` or `TIMEOUT`) resumes
like any other: the resumed run runs every lane again. With
`--review-only`, any finding of any lane is `HUMAN_DECISION_REQUIRED`, with
the merged findings and their `lanes` in the report. With
[context packages](profile.md#context-packages-paths), a changed file that
belongs to no lane stops the run with `INVALID_CONFIGURATION` before any
reviewer starts, in every mode. Without an interactive terminal, the line
that ends a lane's attempt shows the size of the lane's prompt and its
number of diff files (`prompt 4178 B · diff files 1`). The lanes run in
parallel, so with `--verbose` the output of their processes is interleaved,
and the dashboard's reviewer phase shows a fallback when any lane of the
round used one; the report's `reviewer.lanes` and `review.runs` give each
lane's own result.

### Routing

A profile with [`routing.rules`](profile.md#routing) needs no option
either: in the `implementation` mode the rule named after the task's class
sets the implementer effort, the review profile, the lanes and the added
checks, and a candidate path named in the rule's `escalate` switches the
gates and the review to the strictest matching rule (of another class or an
escalation rule), only ever upwards; `routing.rule` in the report names it. The options win over the
rule, which wins over the profile's defaults: `--implementer-effort` and
`--review-profile` (and their aliases) set the value even when it is lower
than the rule's, also after an escalation; `--review-profile` does not
change a lane with its own `profile`. The
report's `routing.overriddenBy` lists them. Routing never picks a value the
profile does not allow, so the options still only accept the profile's
efforts and review profiles. With `--review-only` the rule and an
escalation by the working tree apply in the preflight; `--dry-run` shows
the routing in the plan. A resumed run computes the routing again (an
option may differ from the stopped run's) and lists the fields that differ
from the checkpoint in `routing.checkpointDifferences`; the difference does
not stop the run, while a changed profile still does. The `analysis` mode
ignores routing. See [profile.md](profile.md#report-fields) for the report
field.

### Checkpoints and resume

```sh
ringi run tasks/my-task.md --checkpoint
ringi run tasks/my-task.md --resume 2026-08-08T12-00-00-000Z--1234abcd
```

Checkpoints are opt-in: only a run with `--checkpoint` (or `--resume`)
saves them. `--checkpoint` saves a signed checkpoint after every completed
phase: the writer's round (after its integrity checks), the gates (the state
after the gates and before the review) and the review. It is
`.agent-review-loop/runs/<runId>/checkpoint.json`, next to the report, and
holds the run id and its lineage, the task's path and SHA-256, the
fingerprints of the profile and the runner, the branch, `HEAD`, the hashes
of the repository manifest and of the diff against `HEAD`, the dependency
fingerprints and the Corepack cache, the round, the findings with their
`findingId` and the writer's validated report. It holds no gate results.
Its strings are redacted like the reports. After a stop the checkpoint also
records the stop code and whether it is resumable.

`--resume <runId>` continues that run after its last completed phase. The
preflight runs in full (fresh fingerprints, the secret scan against `HEAD`,
the agents' CLIs); then the run continues only when the signature is valid
and the task, the profile, the runner, the branch, `HEAD`, the round limit
and the working tree (manifest and diff) match the checkpoint. A resumed run
gets a new run id, saves its own checkpoints and its report carries
`resumedFrom`. The round limit counts the rounds of every run of the
lineage: a resume continues with the checkpoint's round number. The writer's
session is not resumed; a correction round starts a new session with the
open findings.

A resume skips only the writer of the interrupted round. The gates, the
review snapshot and the review always run again: after the writer's phase or
after the gates the run continues with the gates of the same round, after a
review with the writer of the next round. `APPROVE` therefore always comes
from gates and a review of the resumed run itself.

Refusals (all in the preflight, before any agent):

| Condition | Code |
| --- | --- |
| `--checkpoint` or `--resume` with `--dry-run`, `--review-only` or `--task-mode analysis` | argument error (exit code `2`); in the API `INVALID_CONFIGURATION` or `INVALID_TASK_MODE` |
| No checkpoint for the run id, an invalid run id, no `XDG_STATE_HOME` or `HOME` | `INVALID_CONFIGURATION` |
| Missing key, a key or key directory with looser permissions, another owner or a symbolic link, a malformed checkpoint, a signature that does not verify, a [ledger](ledger.md) of the run that is missing, does not verify with the key or whose last `checkpoint` event is not this checkpoint | `INTEGRITY_CHECK_FAILED` |
| A stop that is not resumable, another task, profile, runner, branch, `HEAD`, round limit or working tree, a run with nothing left, a round limit already used | `HUMAN_DECISION_REQUIRED` |

Resumable stops are an allowlist (`RESUMABLE_STOP_CODES` in the runner):
`CHECK_FAILED`, `TIMEOUT`, `INTERRUPTED`, `PROCESS_ERROR`, `PROCESS_FAILED`,
`CLAUDE_PROCESS_FAILED`, `CLAUDE_FALLBACK_FAILED`, `OUTPUT_LIMIT_EXCEEDED`
and `INVALID_AGENT_OUTPUT`. Every other stop code is never resumed, and
neither is a stop that carries `integrityViolations`. Such a stop also
revokes every run of the lineage with a marker in the state directory, so
an older signed checkpoint of the same run restored from a copy is refused
too. When the stop cannot be recorded in the checkpoint, or the revocation
fails, the run fails closed: every run of the lineage is revoked and its
checkpoint removed, and the report's `warnings` say so (and name a
checkpoint that could not be removed). After a resumable stop the report's
`resume` names the command. A stop in the middle of a writer round leaves
the working tree different from the last checkpoint: such a run is not
resumed until the tree matches it again.

The signing key is `$XDG_STATE_HOME/ringi/checkpoint.key`, or
`~/.local/state/ringi/checkpoint.key` (directory `0700`, file `0600`, 32
random bytes), created on the first run with `--checkpoint` and never
replaced; see [SECURITY.md](../SECURITY.md). The signature detects a
checkpoint changed without the key. It does not protect against code that
runs as the user, such as the writer or the gates, which can read the key: a
checkpoint forged that way can change the round or the findings history a
resume continues with, but it cannot make a run approve without fresh gates
and, for a task class with review, a fresh review with no unresolved
findings. Without `--checkpoint` or `--resume` a run writes nothing there
and its report has no `checkpoint` or `resumedFrom`; it only reads an
existing key to sign its [ledger](ledger.md).

A resumed run continues the ledger of the run it resumes: its first line's
`prev` is that ledger's last line, and its `resume` event names it. The
ledger only documents the lineage; the gates and the review still run again.

Exit codes are those of the earlier CLI: `0` for a completed run (`APPROVE`
or `DRY_RUN_OK`), `1` for a stopped run, `2` for invalid arguments or an
error outside the runner. When `ringi.config.mjs` is missing, cannot be
loaded or is invalid, the run stops before any agent process with
`INVALID_CONFIGURATION` (exit code `1`), and when it or a module it imports
is not committed, with `PROFILE_UNCOMMITTED` (exit code `1`): the diagnostic line
`code=… | stage=preflight | error=… | resume=…` on standard error, and with
`--json` the stopped report on standard output. The same holds when
`GIT_DIR` or `GIT_WORK_TREE` is set. Outside a Git repository the exit code
is `2`.

A change of the runner's own files during the run (the modules of the
import graph of `bin/ringi.mjs` and `scripts/agent-review-loop.mjs`,
fingerprinted when the runner starts; report field `runner`) stops it with
`RUNNER_MODIFIED`, also when they can no longer be read, whatever else the
round ended with, before `PROFILE_MODIFIED`. It is checked after each
writer round, after the gates, before the reviewer's snapshot, before the
final report and on every stop. A change made before the run is not
detected, so install the runner outside the target repository and check
`runner-location` with `ringi doctor`; reinstall the runner after such a
stop.

A change of `ringi.config.mjs` or of a module it imports during the run
stops it with `PROFILE_MODIFIED`, whatever else the round ended with; see
[profile.md](profile.md#protection-of-ringiconfigmjs). The runner does not
revert the change: review the diff of the profile files
(`git diff HEAD -- <files>`) and revert it. Until then `ringi run` stops
with `PROFILE_UNCOMMITTED` and `ringi doctor` fails, without importing a
changed `ringi.config.mjs`.

Every run that reaches its run directory writes the evidence ledger
`.agent-review-loop/runs/<runId>/ledger.jsonl` (see [ledger.md](ledger.md))
and its report has `ledger: { path, events, headHash }`. An event that cannot
be written stops the run with `INTEGRITY_CHECK_FAILED`, which is not
resumable; when the stop or the result cannot be written, the report's
`warnings` say that the ledger is incomplete.

## `ringi verify`

```sh
ringi verify <runId> [--json]
```

Verifies the ledger of a run of the Git repository of the current directory,
read-only:

- every line is a ledger line of `ledgerVersion` 1, `seq` runs from 1
  without gaps, each `prev` is the SHA-256 of the line before, the first event
  is `preflight`, and with the key every `mac` matches;
- the report of the run: `report.ledger` names this file, its number of events
  and its last line's hash, the run id, the `runner` and `projectProfile`
  fingerprints match the `fingerprints` event, and the last event is the
  `result` with the report's `status`;
- for a resumed run, the ledger of the run it resumed names that run, verifies
  and ends at the first line's `prev`.

The key is the checkpoint key (`$XDG_STATE_HOME/ringi/checkpoint.key` or
`~/.local/state/ringi/checkpoint.key`), only read with the same permission
checks as a resume; `ringi verify` never creates it. Without the key only the
hash chain is verified and a warning says that this does not prove the ledger
is authentic. When the key exists but the ledger has no `mac`, the result is
`unverified`: the ledger was written without the key, or its macs were
removed, and the two cannot be told apart.

The output is `ok`, `unverified` or `fail` with the first mismatch (event
number, check and message); `--json` prints `status` (`ok`, `unverified` or
`fail`), `runId`, `ledger`, `events`, `headHash`, `mac` (`verified`,
`not-verified` or `absent`), `key` (`present`, `no-key`, `key-unsafe` or
`no-state-directory`), `failure` and `warnings`.

Exit codes: `0` when the ledger verifies (`ok`), `1` at the first mismatch
(also a missing ledger or report) or for `unverified`, `2` for invalid
arguments (not exactly one run id, an unknown option) or outside a Git
repository.
