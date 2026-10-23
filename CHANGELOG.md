# Changelog

This file lists notable changes of Ringi Gate, newest first. Each version
is tagged `v<version>` and published to npm as `ringi-gate`. Version 0.1.0
is published by hand, without provenance; later versions are published by
`.github/workflows/release.yml`.

## 0.1.0 — 2026-10-23

The first release. It contains every change listed below.

### 2026-10-23

- Release 0.1.0: `package.json` has version `0.1.0` and `"private": false`.
- `.github/workflows/release.yml` checks that npm in the job is 11.5.1 or
  newer and fails otherwise, without installing another npm. It uses no
  npm token: it publishes through npm trusted publishing from the version
  after 0.1.0. Version 0.1.0 is published by hand, without provenance. The
  workflow test checks that neither workflow uses a secret or
  `NODE_AUTH_TOKEN`.
- README: installation from npm (`npm install --global ringi-gate`,
  `npx ringi-gate`, `npm install --save-dev ringi-gate`) from version 0.1.0;
  running from a checkout stays an alternative.

- An agent CLI that exits before reading its whole prompt from stdin no
  longer crashes the runner with an unhandled `EPIPE` (no JSON report on
  stdout). A failing exit is the agent's own failure, as before; an exit
  with 0 without the whole prompt read stops with `PROCESS_ERROR`. Stop
  codes and report fields of other runs are unchanged.
- The tests that expect an empty stderr from a child run with `NO_COLOR`
  remove `FORCE_COLOR` from its environment, so they pass when `node --test`
  writes to a terminal.

### 2026-10-22

- Documentation, examples, templates and code comments describe the tool
  and its rules directly, in the third person or as instructions. Facts,
  stop codes, report fields and prompts are unchanged.
- The package tests accept both manifest states: unreleased
  (`"private": true`, version `0.0.0`) and a release (`"private": false`,
  any other version). Name, license, `bin` and `files` are checked in both;
  the tarball name and `ringi --version` follow the version in
  `package.json`.
- The profile written by `ringi init` starts with the comment
  `Ringi Gate project profile`.
- `.github/workflows/release.yml` lists its requirements: a GitHub
  environment named `release` and npm 11.5.1 or newer for trusted
  publishing.

### 2026-10-21

- Package and workflows (prompts unchanged; the runner fingerprint below
  adds a stop code, a report field and a `ringi doctor` check):
  - `package.json` has a `files` field (`bin/`, `scripts/` without tests
    and `scripts/fixtures/`, `examples/` without its test, `docs/`,
    `LICENSE`, `NOTICE`, `README.md`, `CHANGELOG.md`, `SECURITY.md`) and
    `repository`, `homepage` and `bugs` pointing to
    `github.com/kxmskx/ringi-gate`. It stays `"private": true` at version
    `0.0.0`; nothing is published.
  - New tests (`scripts/ringi-package.test.mjs`, run by `npm test`): the
    file list of `npm pack` and the imports of the packaged modules; an
    offline installation of the packed tarball with npm and with pnpm in a
    synthetic repository, then `ringi --version`, `init`, `doctor --json`
    and `run --dry-run` from `node_modules`, and a run whose stand-in
    writer changes the runner in `node_modules` (`RUNNER_MODIFIED`); a
    text check of the workflows.
  - `.github/workflows/test.yml`: `npm ci` and `npm test` on
    `ubuntu-latest` and `macos-latest` with Node.js 24, read-only token,
    actions pinned to a commit SHA; pnpm 11.20.0 is put into the Corepack
    cache first. `.github/workflows/release.yml`: on a `v*` tag or by hand,
    in the `release` environment, `npm publish --provenance` with npm
    trusted publishing. Neither workflow has run yet.
  - Runner fingerprint: when the runner module loads, it records the
    SHA-256 of every module of the import graph of `bin/ringi.mjs` and
    `scripts/agent-review-loop.mjs` in its installation (regular files
    only, no symbolic links; otherwise no fingerprint and the run stops).
    The run checks them at the profile's check points (after each writer
    round, after the gates, before the reviewer's snapshot, before the
    final report and on every stop) and stops with the new code
    `RUNNER_MODIFIED`, the primary code before `PROFILE_MODIFIED`. Reports
    have a new field `runner` (`sha256`, `files`); the golden snapshots of
    runs omit it (normalization `runnerFingerprint`), their report and
    event hashes are unchanged. A change made before the run is not
    detected.
  - `ringi doctor`: new check `runner-location`, `warn` when the runner lies
    inside the repository (for example `node_modules/ringi-gate`), with the
    hint to install it outside (globally or through `npx`); `ok` outside.

- Name and license: the project is Ringi Gate, licensed under the Apache
  License 2.0 (`LICENSE`, `NOTICE`). `package.json` has `"name":
  "ringi-gate"` and `"license": "Apache-2.0"`; the command stays `ringi`
  and `ringi --version` prints `ringi (Ringi Gate) <version>`. The package
  is not published. Stop codes, report fields, prompts and golden snapshots
  are unchanged.

- Security (Claude Code as implementer and modules from a profile; the
  `codex` path and the default profile's results are unchanged, golden
  snapshots untouched):
  - Process watch (best effort): while the writer CLI runs, the default
    process runner reads the process table with `/bin/ps` or `/usr/bin/ps`
    every 200 ms and identifies a process by its PID and start time; when
    the CLI exits it kills the processes and process groups it saw (also
    those of Bash commands in their own session, as in the probe of
    2.1.285, and a recorded process that moved to another group), never a
    reused PID or a group with a foreign leader, and checks that none
    survived. A survivor, a recorded PID present with another start time
    (a reused PID or a clock step) or an unreadable process table stops the
    run with
    the new code `IMPLEMENTER_PROCESS_SURVIVED`. A process that escaped
    between two readings is not found (see `SECURITY.md`).
  - The Git directory fingerprint, the private index (against a new one
    built from `HEAD`) and the project profile are compared again after
    the gates and after the review (`UNEXPECTED_GIT_MUTATION`,
    `PROFILE_MODIFIED`); the profile check after the review applies to
    every writer. When a gate or the reviewer fails, the Git comparison is
    added to the stop report as an integrity violation.
  - Preflight refuses symbolic links among the `.git` entries the
    fingerprint reads as plain files and directories (`objects/`, `info/`,
    `hooks/` and below, `config`, `HEAD`, `refs` and others). Without a
    private index a core Git command stops (`INTEGRITY_CHECK_FAILED`)
    instead of using the repository index.
  - Provider grid: `codex` `-c` overrides of `notify`, `profile(s)` and the
    `sandbox_workspace_write` table (except `network_access=false`),
    `--profile`/`-p`; `claude --settings` checked on parsed JSON (escaped
    keys), a `sandbox` without `enabled: true` or with
    `allowUnsandboxedCommands` other than `false`, Unix sockets, local
    binding, proxy ports, `enabledPlugins`, `extraKnownMarketplaces`; a
    `claude` reviewer argv without `--tools`, and a lone `-` inside its
    tools; more reserved program names (`arch`, `sandbox-exec`, `tmux`,
    `screen`, `find`, `expect`, `strace`, `java`, `jshell`, editors,
    `crontab`, `at`, `batch`, `Rscript`, `swift`, shells with a hyphenated
    version). The conformance suite requires a
    known `reason` for every refused preflight host. The built-in `codex`
    session ID must meet `isValidSessionId`, like modules from a profile.
- Polish before publication: the `en` writer prompt says that historical
  identifiers are compatibility identifiers to use exactly as given; snapshot
  `baseline` fields hold neutral descriptions instead of commit hashes;
  snapshot diagnostics and test labels in English; adapter snapshots run Git
  without machine configuration; `update-golden.mjs` judges failures by the
  test process exit code. `pl` prompts, stop codes and report fields are
  unchanged.

### 2026-10-20

- Tests in English: test names, assertion messages and comments of the test
  suite are in English and describe behavior, without stage identifiers or
  commit hashes; what the tests check is unchanged (Polish test data stays).
  The `test` field of the golden snapshots follows the new `[golden]` test
  names; snapshot contents are otherwise unchanged. Exceptions: subtests
  named from data tables keep their Polish labels (test data), and the
  `test` field of `cli-profile-history.json`, which does not follow a test
  name, stays Polish. The naming convention is in `docs/testing.md` and
  `CONTRIBUTING.md`.
- English agent prompts and task section names. The profile's `locale` now
  also selects the writer and reviewer prompts and the default task schema.
  With `'en'` (the default) the prompts are in English, name no provider,
  model or project (they speak of the writer, the reviewer and the runner),
  and quote the English section names; every rule of the Polish prompts is
  kept. The default schema has the English canonical names (`goal`, `scope`,
  `acceptance criteria`, `required checks`, `constraints`,
  `deferred items`, optional `task class`, `starting files`,
  `allowed change area`, `review files`) with the Polish names as aliases,
  so existing Polish task files still parse; the parse result keys sections
  by the English names. As before, when the English names were aliases, a
  repeated section heading under the default `'en'` schema is
  `INVALID_TASK`. With `'pl'` prompts and schema are unchanged, byte
  for byte. A profile that declares `taskSchema` keeps it; a schema may now
  name the task class, required checks and review files sections in English
  or Polish. `taskSchemaVersion` stays 1. Stop codes, report and event
  fields, agent result schemas, argv and gates are unchanged. The example
  task, the `ringi init` template and the README use the English headings.
- The compatibility tests compare the runner with golden snapshots in
  `scripts/fixtures/golden/` instead of reading earlier versions of the
  runner from the Git history, so the tests no longer need that history.
  Snapshots are updated only by hand with
  `node scripts/fixtures/update-golden.mjs`; `npm test` never writes them.
  Runner behavior is unchanged.
- Golden snapshots no longer depend on the machine's Git configuration or
  inherited `GIT_*` variables, snapshot files and tests have descriptive
  names, and `update-golden.mjs` exits with a non-zero code when a failure
  left no snapshot candidate. Snapshot contents are unchanged.
- The docs list Git 2.45 or newer as a requirement (the committed-profile
  check sets `GIT_NO_LAZY_FETCH`). The task quality policy that the default
  profile's classes point to is now in English.

### 2026-10-19

- Runner messages in English, with Polish as a localization. Errors and
  diagnostics, stage labels, the dry-run plan, the texts of the built-in
  task classes, the terminal dashboard and summary, and the CLI parser and
  usage come from a message catalog (`scripts/messages/en.mjs`,
  `scripts/messages/pl.mjs`). The new profile field `locale` (`'en'` by
  default, or `'pl'`; any other value is `INVALID_CONFIGURATION`) selects
  the language; nothing else does. With `'pl'` the output is identical to
  the previous runner, also for profile and task validation outside of a
  run. Truncation and omission markers in agent output are recognized in
  both languages, whatever the locale. Stop codes, report and event fields, `stage` values,
  `schemaVersion`, prompts and the default task schema are unchanged.
  `scripts/agent-review-profile.mjs` and the profile written by
  `ringi init` set `locale: 'en'`; the built-in profile's task class texts
  are now English.
- A `ringi` command for any Git repository, run with Node.js from a
  checkout of this repository (there is no npm package yet):
  - `ringi init` writes `ringi.config.mjs`, with gates taken from the
    `check`, `lint` and `test` scripts of `package.json` plus
    `git diff --check`, and a task template with English section names. It
    never overwrites a file and never creates `AGENTS.md` or `CLAUDE.md`;
    `--dry-run` only lists what it would create. It commits nothing and
    says to commit `ringi.config.mjs` before `ringi run`.
  - `ringi doctor` checks Node.js, Git, the branch, staged changes, the
    pinned pnpm and its Corepack cache, `AGENTS.md`, `CLAUDE.md`, the
    profile, its providers and the agent CLIs, with the runner's own
    preflight functions. It is read-only and calls no model; `--json` gives
    a machine-readable result.
  - `ringi run` runs a task with the profile from `ringi.config.mjs` at the
    repository root, with the same options, report and exit codes as before.
- The profile in `ringi.config.mjs` is protected like code the runner runs:
  it is loaded once, before the first round, imports only relative paths and
  Node.js built-ins (no `require`, no symbolic links or other letter case,
  nothing outside the repository but the runner's own modules; no other
  file of the repository is loaded as a module; a refused or missing import
  fails the load even when the profile catches it, also a module Node.js
  cannot load; a FIFO, device or socket in place of a profile file is
  refused without blocking), and the SHA-256 of the file and of every module
  it imports is checked again right after every writer round, after the
  gates, before the review and at every stop of the run except a cleanup
  failure after approval. A change stops the run with the new code
  `PROFILE_MODIFIED`, which is always the primary code (the failure it
  displaced, also a request for a human decision, is listed in
  `integrityViolations`). The report shows the profile's path, fingerprint
  and whether its files were committed at the start. `ringi` refuses to run
  while `GIT_DIR` or `GIT_WORK_TREE` is set.
- Only a committed profile runs. `ringi run` checks `ringi.config.mjs`
  before it imports it, and the modules it imports right after the load,
  before any agent process and the dry-run plan; an untracked file, a
  change in the working tree or the index, or a failed check stops the run
  with the new code `PROFILE_UNCOMMITTED` (exit code `1`). The code of the
  imported modules has run by then; `ringi.config.mjs` itself is not
  imported. Changed behaviour of
  `ringi doctor`: `profile-committed` now comes before `profile` and fails
  (it was a warning after the import), and the profile is not imported then;
  an uncommitted imported module fails `profile`.
- The committed-profile check no longer uses `git status`, which trusts
  index flags, `core.fsmonitor` and `.gitattributes` conversions: the
  runner hashes the bytes on disk as a Git blob and compares the id with
  `HEAD:<path>` and the index entry. A change hidden by `skip-worktree`,
  `assume-unchanged`, a conversion such as `ident` or a fsmonitor, or a
  mode other than a regular file, now stops with `PROFILE_UNCOMMITTED`; the
  check starts no hook, filter or fsmonitor. The message of
  `PROFILE_UNCOMMITTED` names the flags. `HEAD` comes from the repository's
  object database: after a `PROFILE_MODIFIED` or `UNEXPECTED_GIT_MUTATION`
  stop, check `git log`.
- `node scripts/agent-review-loop.mjs` with `scripts/agent-review-profile.mjs`
  behaves exactly as before.

### 2026-10-18

- Open provider interface. Support for another agent CLI is a provider
  module: code that declares its roles, how it builds commands, reads results
  and resumes sessions, and how it meets each safety guarantee. A profile can
  register extra modules through `providerModules`. Role rules live in the
  core: a module that does not declare every implementer guarantee (sandbox,
  no network, no prompts, explicit resume and the rest) cannot be the
  `implementer`, and the `reviewer` needs read-only tools. The declaration is
  the module's own description, so review against the real CLI is still the
  guarantee; the core's integrity checks apply whatever it says. Violations
  stop the run with `PROVIDER_ROLE_NOT_ALLOWED` or
  `PROVIDER_CONTRACT_VIOLATION`.
- The built-in `codex` and `claude` providers moved to `scripts/providers/`
  with unchanged behaviour. A shared conformance suite checks any module
  without calling a model; see [docs/providers.md](docs/providers.md) and the
  template in `examples/providers/`.
- Claude Code can now act as the `implementer`, not only the `reviewer`.
  This is **experimental and not meant for untrusted tasks**. The adapter runs
  Claude Code without permission prompts and never with
  `--dangerously-skip-permissions`. Commands run in a sandbox with no network,
  and writes stay inside the repository. Results come back through
  `--json-schema`, and sessions are resumed explicitly. Supported CLI versions:
  `>=2.1.285 <2.2.0`.
- New fail-closed checks around the implementer:
  - a fingerprint of `.git` stops the run with `UNEXPECTED_GIT_MUTATION`;
  - preflight rejects repositories that use worktrees, submodules or
    alternates;
  - the reviewer's diff is built from a private index created from `HEAD`;
  - staged changes are checked against the repository's real index;
  - permission denials are recorded in the report.
- Known limitation: a background process started through Bash can outlive the
  CLI. See [SECURITY.md](SECURITY.md).
- The default profile (Codex implements, Claude reviews) behaves exactly as
  before.

### 2026-10-17

- Clearer good first issues and a roadmap entry for an open provider
  interface.

### 2026-10-16

- Roles are separate from providers. The profile picks the provider, model,
  effort and review profiles for `implementer` and `reviewer`, and invalid
  combinations fail before the run starts. Reports gained neutral
  `implementer` and `reviewer` fields; the older fields stay as aliases.
- A friendlier repository: README with a terminal demo recorded from a real
  dry run, a contributor guide, good first issues, a code of conduct, and
  issue and pull request templates.

### 2026-10-15

- Task classes and the docs-only candidate policy live in the profile. Core
  rules still apply: only a docs candidate may skip review, and paths with
  agent instructions are always excluded.
- The task schema lives in the profile (Polish section names with English
  aliases by default), and the report records `taskSchemaVersion`. Agent
  prompts moved out of the core into `scripts/agent-review-prompts.mjs`.
- Gate commands are restricted by shape. `pnpm` runs only
  `pnpm [--filter <pkg>] run <script>`, so it cannot start binaries or
  built-in commands. `git` runs only `diff --check`. STOP codes from profile
  rules end in `_GATE`.
- English README and docs, example profile and tasks in `examples/` checked by
  the core parser, and the Ringi mark.

### 2026-10-14

- Gates are profile configuration: checks, check sets, allowed nested calls
  and path-based required gate rules, all validated fail-closed. The default
  profile runs `pnpm check`, `pnpm test` and `git diff --check`.
- The core runs on its own: default profile, `package.json` (Node 24 or
  newer, no runtime dependencies) and tests on synthetic data.
- Initial import of the runner core.
