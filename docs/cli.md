# The `ringi` command

`ringi` runs Ringi Gate on the Git repository of the current directory, with
the project profile from `ringi.config.mjs` at that repository's root. It has
three commands:

- `ringi init` prepares a project: a profile and a task template;
- `ringi doctor` checks the repository and the machine before a run;
- `ringi run <task.md> [options]` runs the writer, the gates and the
  independent review.

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
| `implementer-cli` | the implementer CLI answers `--version`, and its module's preflight accepts the version and platform (for Claude Code as implementer: versions from 2.1.285 up to, not including, 2.2.0, macOS or Linux) | `environmentReport` |
| `reviewer-cli` | the reviewer CLI answers `--version` | `environmentReport` |

These are the preflight steps of a run, not all of them: a run also checks
the task file, the secret scan, the dependency fingerprints and installed
dependency state, and copies the Corepack cache and runs the pinned
`pnpm --version` in an isolated environment. `doctor` passing does not
guarantee that a run's preflight passes.

Output: a table on standard output, or with `--json` an object
`{ schemaVersion: 1, status: 'ok' | 'fail', summary: { ok, warn, fail },
checks: [{ id, status, detail, hint, code?, message? }] }`. Exit code `0`
when no check fails, `1` when one fails, `2` for an unknown option.

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
ok      implementer-cli    codex: codex-cli 0.147.0
ok      reviewer-cli       claude: 2.1.290 (Claude Code)

ringi doctor: 15 ok, 0 warn, 0 fail
```

## `ringi run`

```sh
ringi run path/to/task.md [--dry-run] [--task-mode implementation|analysis]
  [--review-profile <name>] [--codex-model <id>] [--sol-effort <effort>]
  [--verbose] [--no-animation] [--json]
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
the shared parser.

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
