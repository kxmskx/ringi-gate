# Contract

This document says what Ringi Gate 2.x promises and what changes only in a
major version. It does not repeat the reference
documentation: each item names the place where the details are. The lists
marked in this file are checked by the contract tests in
`scripts/agent-review-loop.test.mjs` (tests named `contract: …` and
`runner surface contract: …`): a change of any of them changes the test and
this document together.

Version rules:

This is the contract of 2.0 (the changes from 1.x are in
[migration-2.0.md](migration-2.0.md)).

- **Major** (3.0): removing or renaming anything listed here, or changing
  its meaning; a stricter validation that refuses a profile, task or option
  that 2.x accepts. Two exceptions are described below: new core checks of
  a provider module's argv and environment
  ([Provider modules](#provider-modules)), and the guarantees of an
  `experimental` provider ([Provider stability](#provider-stability)).
  Also major: making a listed STOP code resumable or not resumable; a new
  value of the report's `status` or of the `ci review` `verdict`.
- **Minor**: adding something optional whose absence keeps the 2.0
  behaviour: a profile key, a report field, a CLI option, a STOP code for a
  new situation, a ledger event type, a `stage` value, a field of an
  event's `data`. A new STOP code is not resumable unless the minor version
  that adds it lists it as resumable ([STOP codes](#stop-codes)) for its
  new situation only.
- **Patch**: fixes that keep every listed name and meaning. A fix may stop
  a run that a bug let through (fail-closed); such a stop uses an existing
  code.

The separate `schemaVersion: 1` outputs (`ringi doctor --json`,
`ringi ci classify --json`, `ci-review.json`) follow the same rules on
their own.

## CLI

The `ringi` command and its exit codes are described in [cli.md](cli.md).

<!-- contract:cli-commands -->
- `init`: [cli.md](cli.md#ringi-init); exit code `0`, `1` outside a
  repository root, `2` for an unknown option.
- `doctor`: [cli.md](cli.md#ringi-doctor); `0` when no check fails, `1`
  when one fails, `2` for an unknown option. The JSON output has its own
  `schemaVersion: 1`.
- `run`: [cli.md](cli.md#ringi-run); `0` for `APPROVE` or `DRY_RUN_OK`, `1`
  for a stopped run, `2` for invalid arguments or an error outside the
  runner.
- `verify`: [cli.md](cli.md#ringi-verify); `0` for `ok`, `1` for `fail` or
  `unverified`, `2` for invalid arguments or outside a Git repository.
- `ci`: [ci.md](ci.md), subcommands `classify`, `aggregate` and `review`.
  `classify`: `0` when the diff is classified (either lane), `1` when it
  cannot be (a STOP code, never a lane), `2` for invalid arguments or
  outside a Git repository. `aggregate`: `0` only for a green required
  check, `1` for a red one, `2` for invalid arguments or a needs file that
  cannot be read. `review`: `0` only for `APPROVE`, `1` for any other
  verdict, `2` for invalid arguments or outside a Git repository.
<!-- /contract:cli-commands -->

Options (of every command together; `ringi run` takes the options of
`scripts/agent-review-loop.mjs`, which stays a supported entry point with
the same options and codes and the same report apart from
`projectProfile`):

<!-- contract:cli-options -->
- `--help`, `-h`: help, exit code `0`.
- `--version`: `ringi (Ringi Gate) <version>`.
- `--dry-run`: `init` writes nothing; `run` runs the preflight and prints
  the plan.
- `--json`: machine output of `doctor`, `run`, `verify` and `ci classify`.
- `--base`, `--head`: `ci classify` and `ci review`, the two commits of
  the diff (full SHAs).
- `--checks`: `ci classify`, also print the lane's checks.
- `--lane`, `--needs`, `--classify-job`, `--docs-jobs`, `--full-jobs`:
  `ci aggregate`, the lane, the `toJSON(needs)` file and the jobs of the
  classification and of each lane ([ci.md](ci.md#ringi-ci-aggregate)).
- `--review-job`, `--enforce-checks`: `ci aggregate`, the review job and
  the comparison of the lane jobs' checks.
- `--event`, `--attempt`, `--out`, `--summary`: `ci review`, the event,
  the attempt of the job, the evidence directory and the job summary
  ([ci.md](ci.md#ringi-ci-review)).
- `--task-mode`: `implementation` (default) or `analysis`.
- `--review-only`: [cli.md](cli.md#review-only).
- `--checkpoint`, `--resume`: [cli.md](cli.md#checkpoints-and-resume).
- `--implementer-model`: an identifier that follows the model rule
  ([profile.md](profile.md#implementer)).
- `--implementer-effort`, `--review-profile`: values from the profile's
  allowlists.
- `--verbose`, `--no-animation`: presentation only.
<!-- /contract:cli-options -->

The standard output of `ringi run --json` is the report (below). The
`--json` output of `ringi doctor` (`schemaVersion`, `status`, `summary`,
`checks[]` with `id`, `status`, `detail`, `hint`, `code`, `message`;
[cli.md](cli.md#ringi-doctor)) and of `ringi verify` (`status`, `runId`,
`ledger`, `events`, `headHash`, `mac`, `key`, `failure`, `warnings`;
[cli.md](cli.md#ringi-verify)) is in the contract in the same way: fields
are only added in 2.x; the check ids and the messages are outside the
contract. `ringi ci classify --json` is described under
[CI classification](#ci-classification). The terminal output without
`--json` is presentation and outside the contract.

## Profile

The profile (`ringi.config.mjs`, exporting `PROFILE`) is described in
[profile.md](profile.md). It is validated fail-closed before any process
starts: an unknown key, at the top level or inside any section, is
`INVALID_CONFIGURATION`. Top-level keys:

<!-- contract:profile-keys -->
- `title`, `tempPrefix`, `createPresenters`: [profile.md](profile.md#title-tempprefix-createpresenters).
- `checks`: [profile.md](profile.md#checks).
- `checkSets`: [profile.md](profile.md#checksets).
- `requiredGateRules`: [profile.md](profile.md#requiredgaterules).
- `taskSchema`: [profile.md](profile.md#taskschema).
- `taskClasses`: [profile.md](profile.md#taskclasses).
- `docsCandidatePolicy`: [profile.md](profile.md#docscandidatepolicy).
- `implementer`: [profile.md](profile.md#implementer).
- `reviewer`: [profile.md](profile.md#reviewer).
- `locale`: [profile.md](profile.md#locale).
- `reviewLanes`: [profile.md](profile.md#reviewlanes).
- `routing`: [profile.md](profile.md#routing).
- `prompts`: [profile.md](profile.md#prompts).
- `providerModules`: [profile.md](profile.md#providermodules).
- `ci`: [profile.md](profile.md#ci); read only by `ringi ci`.
<!-- /contract:profile-keys -->

Extension rule: a new optional key, at the top level or in a section, is a
minor change when a profile without it behaves exactly as before. Keys
reserved for later (any key of `routing` other than `rules`, any key of
`ci` other than `docsPaths`, `lanes` and `review`, any lane of `ci.lanes`
or `ci.review.profiles` other than `docs` and `full`, any key of
`ci.review` other than `profiles`, `maxAttempts`, `timeoutMinutes` and
`credentials`, a cost limit among them, any key of `prompts` other than
`implementer` and `reviewer`, any key of a role in `prompts` other than
`guidance`) stay `INVALID_CONFIGURATION` until a version defines them.

`prompts` ([profile.md](profile.md#prompts)) has the shape
`{ implementer?: { guidance }, reviewer?: { guidance } }`, at least one
role, `guidance` a string of 1 to 4000 characters of valid Unicode, not
only white space, with no control character but `\n` and no U+2028 or
U+2029, taken only from the profile.
The contract fixes where the guidance goes and what it cannot change, not
the wording around it: in the `implementation` mode each role's prompts get
its guidance in a section of its own after the fixed rules that precede the
task and right before the original task (the fixed line about the JSON
report still follows the task) (for a review lane, before its focus line and
context package), each line quoted with `> `, between a fixed opening that
names what the guidance does not change (the phase ownership contract, the
task mode, the scope of the original task, the ban on Git operations and
publication, the result schema, the zero findings policy, the reviewer's
read-only rules, the review lanes) and a fixed closing that gives every
rule above precedence. The `analysis` mode takes no guidance. No version
of 2.x lets the profile replace or remove a fixed rule of a prompt. Without
`prompts` the prompts are unchanged.

Names in `routing.rules` share one namespace with the task classes: a rule
named after a class is that class's rule, and any other name is an
escalation rule (see [profile.md](profile.md#routing)). Adding a task class whose name equals
an existing escalation rule therefore turns that rule into the class's rule
without a message: it applies to every task of the new class, and other
rules may still escalate to it. When the new class has no review, the
rule's review settings (`reviewProfile`, `reviewLanes`) make the profile
`INVALID_CONFIGURATION`; otherwise the profile stays valid. Do not give a
task class the name of an escalation rule.

`createPresenters` is a key of the contract; the events presenters receive
are presentation and outside it.

## Task file

The task format (sections, aliases, `Required checks`, task class) is
described in [architecture.md](architecture.md#task-file) and set by the
profile's `taskSchema`. Its `version` appears in the report as
`taskSchemaVersion`.

## Report

The run report (`.agent-review-loop/runs/<runId>/report.json`, and the
`--json` output) has `schemaVersion: 2`. Fields are only added in 2.x;
removing a field or changing its meaning needs a new `schemaVersion` and a
major version. The fields are described in
[architecture.md](architecture.md#report) and
[profile.md](profile.md#report-fields). Every run report has
`publicationApproved: false`; no version sets it to `true`. Top-level
fields:

<!-- contract:report-fields -->
- `schemaVersion`, `status`, `runId`, `publicationApproved`: every run
  report (not the two stop reports below); `status` is `APPROVE` or
  `STOPPED`.
- `code`, `stage`, `error`: a stopped run.
- `resume`: the next step of a stopped run, a text (with
  `ringi run <task> --resume <runId>` only when the stop is resumable).
- `nextStep`: the next step of an approved run, a text.
- `integrityViolations`: further violations of a stopped run.
- `lane`: the review lane that stopped the run.
- `warnings`: present only when not empty.
- `task`, `taskMode`, `taskSchemaVersion`.
- `analysisArtifacts`: a run in the `analysis` mode that wrote its
  analysis files.
- `branch`, `head`, `startedAt`, `finishedAt`, `durationMs`, `reportPath`.
- `runMode`: only `review-only`.
- `quality`, `rounds`, `findings`, `findingPolicy`.
- `implementer`, `reviewer`: the roles.
- `routing`: with `routing` in the profile.
- `promptGuidance`: with `prompts` in the profile.
- `checkpoint`, `resumedFrom`: with `--checkpoint` or `--resume`.
- `ledger`: every run with a run directory.
- `runner`, `projectProfile`: fingerprints; `projectProfile` only with
  `ringi` (absent with `scripts/agent-review-loop.mjs`).
- `diagnostics`, `diagnosticLog`: the redacted diagnostic logs (their
  contents are outside the contract).
<!-- /contract:report-fields -->

Each agent's output and execution of a round is in
`rounds[].implementer` and `rounds[].reviewer` (`provider`, `output`,
`execution`); each output is stored once (the executions are also in
`implementer.runs` and `reviewer.runs`). The dry-run plan is not a run
report: it has `schemaVersion` `2` and `status: 'DRY_RUN_OK'`, no
`publicationApproved`, and it carries `agents`, which a run report does not:
`agents.implementer` (`provider`, `version`, `model`, `effort`),
`agents.reviewer` (`provider`, `version`, `profile`, `plannedAttemptCount`,
`fallbackAllowed`, `plannedAttempts`) and, when no review is required,
`agents.independentReview`. Its other fields are outside the contract. The 1.x provider-specific names are gone; see
[migration-2.0.md](migration-2.0.md).

Two stop reports of the CLI are not run reports and have neither `runId`
nor `publicationApproved`:

- A stop before the run of `ringi run` (no run directory yet: the profile
  is missing, invalid or uncommitted, or `GIT_DIR` or `GIT_WORK_TREE` is
  set) has exactly `schemaVersion` (`2`), `status` (`STOPPED`), `code`,
  `stage`, `error` and `resume`; with `--json` it is printed on standard
  output.
- The last-resort error report (`UNEXPECTED_ERROR` when the runner itself
  fails without a report of its own) has `schemaVersion` (`2`), `status`
  (`STOPPED`), `code` and `error`.

The round files (`round-<n>-*.json`), the diagnostic logs and the
checkpoint file are outside the contract; the checkpoint is checked only by
the runner that wrote it (see [cli.md](cli.md#checkpoints-and-resume)).

## CI classification

`ringi ci classify` is described in [ci.md](ci.md#ringi-ci-classify).
Without `--json` its standard output is exactly one line, `lane=docs` or
`lane=full`, and with `--checks` a second one, `checks=` and the `checks`
below as a JSON array; the summary on standard error is presentation. With `--json`
the output has its own `schemaVersion: 1` and exactly these fields:

- `schemaVersion`: `1`.
- `lane`: `docs` or `full`.
- `checks`: the check names of the lane, from the profile's `ci.lanes`.
- `files`: one entry per record of the diff, each with `path`, `oldPath`
  (only for `renamed` and `copied`: the source), `status` (`added`,
  `copied`, `deleted`, `modified`, `renamed` or `type-changed`) and
  `reason`: `docs` for plain documentation; otherwise a reason of a mode
  (`executable`, `symlink`, `submodule`), or else the first of
  `unsafe-name`, `dot-segment`, `ascii-folding-name`, `instruction-file`,
  `excluded-by-docs-policy`, `protected-path`, `not-markdown`, `outside-docs-paths` that applies to
  the source, or else to the path.
- `reasons`: why the lane is `full`, the distinct reasons of its files or
  `empty-diff`; empty for the docs lane.

Lanes, statuses and reasons are only added in 2.x; a new reason may only
move a change from `docs` to `full`. A classification that does not happen
is never a lane: with `--json` it prints a stop report with exactly
`schemaVersion` (`1`), `status` (`STOPPED`), `code` and `error`. The
output of `ringi ci aggregate` is presentation; its exit code is the
contract.

`ringi ci review` ([ci.md](ci.md#ringi-ci-review)): its standard output
lines `verdict=` (`APPROVE` or `STOPPED`), `lane=` and `run-id=`, and
`ci-review.json` with its own `schemaVersion: 1` and the fields `verdict`,
`code` and `error` (not approved), `pullRequest`, `base`, `head`, `lane`,
`reviewProfile`, `runId`, `findings` and `measurement` (`durationMs`,
`runAttempt`, `maxAttempts`, `timeoutMinutes`, `reviewAttempts`,
`contextBytes`, `costUsd`). Fields are only added in 2.x. The job summary
is presentation.

## STOP codes

A stopped run has a `code`. Codes are stable identifiers, independent of
the locale. The list below is checked against every code the core and the
`ringi` command can set. **Resumable** means the code is in
`RESUMABLE_STOP_CODES` (see [cli.md](cli.md#checkpoints-and-resume)); a stop
with `integrityViolations` is never resumable. Codes of the profile's
`requiredGateRules` end in `_GATE`, which no core code does; they are not
resumable.

A new code is a minor change when it covers a situation that no existing
code covers; a code that replaces another one in the same situation is a
major change. Messages (`error`) are outside the contract.

<!-- contract:stop-codes -->
| Code | Resumable | Meaning |
| --- | --- | --- |
| `AMBIGUOUS_FINDING_IDENTITY` | no | The reviewer reported the same finding identity twice in one review. |
| `ANALYSIS_ARTIFACT_INCOMPLETE` | no | Analysis mode: the writer's analysis lacks its completeness sentinel. |
| `ANALYSIS_ARTIFACT_INTEGRITY_FAILED` | no | Analysis mode: the stored analysis artifact is missing or changed. |
| `ANALYSIS_ARTIFACT_MISSING` | no | Analysis mode: the writer returned no analysis. |
| `ANALYSIS_ARTIFACT_TOO_LARGE` | no | Analysis mode: the analysis is over the size limit. |
| `ANALYSIS_ARTIFACT_TRUNCATED` | no | Analysis mode: the analysis is marked as truncated. |
| `ANALYSIS_ARTIFACT_WRITE_FAILED` | no | Analysis mode: the artifact could not be written. |
| `ANALYSIS_PACKAGE_INVALID` | no | Analysis mode: the reviewer's package cannot be built or is inconsistent. |
| `ANALYSIS_REVIEW_FILES_UNCONFIRMED` | no | Analysis mode: the reviewer did not confirm every review file with its hash. |
| `ANALYSIS_REVIEW_UNCONFIRMED` | no | Analysis mode: the reviewer did not confirm what it read. |
| `ANALYSIS_WORKING_TREE_WRITE` | no | Analysis mode: the working tree changed. |
| `CHECK_FAILED` | yes | A gate exited with a code other than 0. |
| `CLEANUP_FAILED` | no | Cleanup at the end of the run failed. |
| `CONCURRENT_PROCESS` | no | A second process was started while one was active. |
| `COREPACK_CACHE_CHANGED` | no | The isolated Corepack cache changed. |
| `COREPACK_CACHE_ESCAPE` | no | A path of the Corepack cache leaves its directory. |
| `COREPACK_CACHE_LIMIT` | no | The Corepack cache is over its size or entry limit. |
| `COREPACK_CACHE_SYMLINK` | no | The Corepack cache contains a symbolic link. |
| `DEPENDENCIES_NOT_INSTALLED` | no | Installed dependency metadata is missing. |
| `DEPENDENCY_INPUT_CHANGED` | no | A dependency input (`package.json`, lockfile, configuration) changed. |
| `DEPENDENCY_INPUT_INVALID` | no | A dependency input cannot be read safely. |
| `DEPENDENCY_INPUT_TOO_LARGE` | no | Dependency inputs are over the size limit. |
| `DEPENDENCY_MANIFEST_MISMATCH` | no | Installed dependencies do not match the manifest. |
| `DEPENDENCY_METADATA_CHANGED` | no | Installed dependency metadata changed. |
| `DEPENDENCY_METADATA_INVALID` | no | Installed dependency metadata cannot be read safely. |
| `DEPENDENCY_METADATA_TOO_LARGE` | no | Installed dependency metadata is over the size limit. |
| `DEPENDENCY_STATE_STALE` | no | Installed dependencies are older than their inputs. |
| `DETACHED_HEAD` | no | `HEAD` is detached. |
| `DIAGNOSTIC_LOG_FAILED` | no | A diagnostic log could not be written. |
| `DIFF_FAILED` | no | Git could not produce a diff. |
| `DIFF_TOO_LARGE` | no | The diff is over the size limit. |
| `DOCS_CANDIDATE_REJECTED` | no | A documentation class changed a path outside its candidate policy. |
| `FINDING_DISPUTE` | no | The writer rejected a finding. |
| `FINDING_ID_COLLISION` | no | One finding id with two identities. |
| `FINDING_ID_MISMATCH` | no | A finding id does not match its identity. |
| `HUMAN_DECISION_REQUIRED` | no | A human decides: a writer question, a finding after review-only, a refused resume. |
| `IMPLEMENTER_PREFLIGHT_FAILED` | no | The implementer's host, layout or sandbox check failed. |
| `IMPLEMENTER_PROCESS_SURVIVED` | no | A process of the implementer CLI survived it, or the process table could not be read. |
| `IMPLEMENTER_SCRATCH_NOT_EMPTY` | no | The implementer CLI's scratch directory is not empty. |
| `INTEGRITY_CHECK_FAILED` | no | An integrity check could not be completed (key, checkpoint, ledger, private index, limits). |
| `INTERRUPTED` | yes | The run was interrupted. |
| `INVALID_AGENT_OUTPUT` | yes | An agent's output is not valid. |
| `INVALID_ANALYSIS_INTEGRITY_REPORT` | no | Analysis mode: the integrity report is not valid. |
| `INVALID_ANALYSIS_REVIEW_FILES` | no | Analysis mode: the task's `Review files` are not valid. |
| `INVALID_CONFIGURATION` | no | The profile, an option or the environment of the command is not valid. |
| `INVALID_COREPACK_CACHE` | no | The Corepack cache cannot be used. |
| `INVALID_DOCKER_HOST` | no | `DOCKER_HOST` is not a local socket. |
| `INVALID_GATE_REPORT` | no | The trusted gate report is not valid. |
| `INVALID_IMPLEMENTER_EFFORT` | no | The implementer effort is not allowed. |
| `INVALID_IMPLEMENTER_ENVIRONMENT` | no | The implementer's isolated environment cannot be prepared. |
| `INVALID_IMPLEMENTER_MODEL` | no | The implementer model is not valid. |
| `INVALID_PACKAGE_MANAGER` | no | `packageManager` is not an exact pnpm version. |
| `INVALID_PROCESS_ARGS` | no | A process would get arguments that are not plain strings. |
| `INVALID_REVIEW_PROFILE` | no | The review profile is not one of the profile's. |
| `INVALID_TASK` | no | The task file is not valid. |
| `INVALID_TASK_CLASS` | no | The task class is not valid for the run. |
| `INVALID_TASK_MODE` | no | The task mode is not valid for the run or the provider. |
| `INVALID_TASK_PATH` | no | The task path is not valid. |
| `MAX_ROUNDS` | no | The round limit was reached with open findings. |
| `MISSING_EXECUTABLE` | no | A required program is not on `PATH`. |
| `NEW_PERMISSION_REQUIRED` | no | The writer asked for a permission it does not have. |
| `OUTPUT_LIMIT_EXCEEDED` | yes | A process wrote more than its output limit. |
| `PATH_ESCAPE` | no | A path leaves the repository or uses a reserved name. |
| `PNPM_CACHE_MISSING` | no | The pinned pnpm is not in the local Corepack cache. |
| `PNPM_INTEGRITY_MISMATCH` | no | The pinned pnpm does not match its integrity. |
| `PNPM_VERSION_MISMATCH` | no | pnpm reports another version than the pinned one. |
| `PROCESS_ERROR` | yes | A process could not be run, or exited 0 without reading its whole input. |
| `PROCESS_FAILED` | yes | The implementer process failed. |
| `PROFILE_MODIFIED` | no | `ringi.config.mjs` or a module it imports changed during the run. |
| `PROFILE_UNCOMMITTED` | no | `ringi run`, `ringi doctor`, `ringi ci classify`, `ringi ci review`: the profile or a module it imports is not committed or differs from `HEAD`. |
| `PROTECTED_BRANCH` | no | The branch is `main` or `master`. |
| `PROVIDER_CONTRACT_VIOLATION` | no | A provider module's argv or environment breaks a core check. |
| `PROVIDER_ROLE_NOT_ALLOWED` | no | A provider module's declaration does not allow the role. |
| `REVIEWER_FALLBACK_FAILED` | yes | The reviewer's fallback attempt failed. |
| `REVIEWER_PREFLIGHT_FAILED` | no | The reviewer's host check failed. |
| `REVIEWER_PROCESS_FAILED` | yes | The reviewer process failed. |
| `REVIEW_FAILED` | no | The review failed for another reason (for example a review lane without a classified failure). |
| `RUNNER_MODIFIED` | no | A module of the runner changed during the run. |
| `SECRET_DETECTED` | no | New secret-like content. |
| `SNAPSHOT_CHANGED` | no | The reviewer's read-only snapshot changed. |
| `SNAPSHOT_TOO_LARGE` | no | The snapshot is over its limit. |
| `STAGED_CHANGES` | no | Something is staged. |
| `SYMLINK_ESCAPE` | no | A symbolic link leaves the repository or a path goes through one. |
| `TASK_PATH_ESCAPE` | no | The task file is outside the repository. |
| `TIMEOUT` | yes | A gate or process exceeded its timeout. |
| `UNEXPECTED_ERROR` | no | An error the runner did not classify. |
| `UNEXPECTED_GIT_MUTATION` | no | Git state (branch, `HEAD`, Git directory, private index) changed. |
| `UNSAFE_CLEANUP` | no | Cleanup refused an unknown resource. |
| `UNSUPPORTED_CHECK` | no | A required check is not in the profile. |
| `UNSUPPORTED_FILE_TYPE` | no | The repository has an entry that is not a file, directory or symbolic link. |
| `WORKFLOW_ERROR` | no | The default code of a runner error without its own code. |
| `WORKING_TREE_CHANGED` | no | The working tree changed where it must not. |
| `WRONG_REPOSITORY` | no | The command runs in another repository. |
<!-- /contract:stop-codes -->

The `stage` values are part of the contract in the same way:

<!-- contract:stages -->
- `preflight`, `implementer`, `post-implementer`: before and around a
  writer round.
- `checks`, `post-checks`, `analysis`: the gates, or the integrity checks
  of the analysis mode.
- `snapshot`, `reviewer`, `post-review`: the review.
- `approve`, `cleanup`, `diagnostics`, `workflow`: the end of the run, and
  `workflow` for a profile change found without a stage.
<!-- /contract:stages -->

## Ledger

The run ledger is described in [ledger.md](ledger.md): `ledgerVersion: 2`,
one JSON line per event with the keys `ledgerVersion`, `seq`, `ts`, `type`,
`data`, `prev` and `mac`, a SHA-256 chain and an optional HMAC. Event
types:

<!-- contract:ledger-events -->
- `preflight`
- `fingerprints`
- `resume`
- `routing`
- `writer-round`
- `gate`
- `integrity`
- `snapshot`
- `review-attempt`
- `review-lane`
- `findings`
- `checkpoint`
- `stop`
- `result`
<!-- /contract:ledger-events -->

`ringi verify` rejects an event type it does not know. A new event type is
therefore a minor change for the runner, but a `ringi verify` older than
the event rejects a ledger that has it: verify a ledger with the same or a
newer version than the one that wrote it. Fields of an event's `data` are
only added in 2.x; a change of the line format needs a new `ledgerVersion`.
`ringi verify` 2.x refuses a ledger of `ledgerVersion: 1` (ringi 1.x) with
`fail` and a message that names the version; verify such a run with ringi
1.x.

## Provider modules

The interface of `providerModules` is described in
[providers.md](providers.md#contract): the module fields `id`, `program`,
`versionArgs`, `roles`, `efforts`, `isValidModel` and one role object per
role, with `modes`, `stability`, `limitations`, `security`, optional
`probedVersions` and the role's functions. `efforts` must be listed from
the lowest to the highest effort: [routing](profile.md#routing) compares
review efforts by that order (the contract does not check the order). The
security declaration ([providers.md](providers.md#security-declaration)),
the role rules ([providers.md](providers.md#role-rules)) and the
conformance suite (`scripts/providers/conformance.mjs`) are part of the
contract. Module authors import `defineProvider` from
`scripts/providers/contract.mjs` and `checkProviderConformance` from
`scripts/providers/conformance.mjs`; both paths and functions are part of
the contract. The core may add checks of a module's argv and environment in a
minor or patch version: they only refuse more (fail-closed), as the
forbidden argument lists do today.

## Outside the contract

These may change in any version:

- the writer and reviewer prompts (`scripts/agent-review-prompts.mjs`),
  the wording of the project guidance section included; the shape of
  `prompts` and the place of the section are in the contract (see
  [Profile](#profile));
- the layout and contents of `.review-context/` in the reviewer's snapshot;
- the terminal dashboard, `--verbose` output and the events presenters
  receive;
- the text of every message (`error`, hints, help texts) and the message
  catalogs;
- the `internal` export of `scripts/agent-review-loop-lib.mjs` and every
  export not named in this document: the JavaScript API of `scripts/`
  (`runAgentReviewLoop`, its options and exports, the module-level names
  of the built-in providers) apart from the names above; the supported
  entry points are `ringi` and `scripts/agent-review-loop.mjs`;
- the dry-run plan apart from its `schemaVersion`, `status` and `agents`, the round files, the
  diagnostic logs and the checkpoint file;
- probes and their documentation.

## Provider stability

The built-in modules and their state (see
[providers.md](providers.md#stability)):

| Module | Implementer | Reviewer |
| --- | --- | --- |
| `codex` | `experimental` (default) | — |
| `claude` | `experimental` | `experimental` (default) |

No built-in role meets every stability criterion today. For a role
declared `experimental`, 2.x promises the interface (how the profile
selects it, the report fields, the STOP codes) but not its guarantees: its
argv, its security declaration and its known limits may change in a minor
version when a probe shows they must, and such a change may stop runs that
passed before (fail-closed). A role becomes `stable` only by meeting the
criteria in [providers.md](providers.md#stability); after that, its
declaration changes only in a major version.
