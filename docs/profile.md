# Project profile

The project profile tells the runner which gate commands exist for a project,
which of them always run, which paths require a specific gate, which
section headings a task file may use, which task classes exist, which
paths a docs-only candidate may touch and which provider, model and effort
the implementer and reviewer roles use. It is the only project-specific
configuration of the runner today.

## Where it lives

A profile comes from exactly one of two places, depending on the entry
point:

- **`ringi` command** ([cli.md](cli.md)): `ringi.config.mjs` at the root of
  the Git repository of the current directory, exporting `PROFILE` or a
  default export (both only if they are the same object). No other path is
  used: not a parent directory above the repository root, not a path from
  an argument, an environment variable or the task. Because Git would take
  the repository from `GIT_DIR` or `GIT_WORK_TREE`, `ringi` refuses to run
  while either is set (`INVALID_CONFIGURATION`; `ringi doctor` fails the
  `git-repository` check). A missing file stops `ringi run` with
  `INVALID_CONFIGURATION` and the hint to run `ringi init`. See
  [Protection of `ringi.config.mjs`](#protection-of-ringiconfigmjs).
- **`node scripts/agent-review-loop.mjs`**: the module
  `scripts/agent-review-profile.mjs` next to the CLI, described below.

The CLI imports `PROFILE` from `scripts/agent-review-profile.mjs`. The file in
this repository contains a neutral default (`pnpm check`, `pnpm test`,
`git diff --check`). A project replaces that module with its own profile.
This CLI loads profiles only from this module. The core also contains a built-in
default profile with the same content, used by library functions when no
profile is passed; the CLI always passes the imported `PROFILE`. The module
does not declare `taskSchema`, `docsCandidatePolicy`, `implementer` or
`reviewer`, so the built-in defaults apply. It declares `taskClasses`: the built-in default classes plus
`policy`, which points to this repository's task quality policy document
(`docs/development/agent-task-quality-policy.md`). That is the only
difference from the built-in default: the core names no policy document, so
without a profile the report field `policy` is `null`.

Every entry point that uses the profile (task parsing, the writer's guards,
the gates, snapshots and the run itself) resolves it through the same
validation. An invalid profile stops the run in preflight with
`INVALID_CONFIGURATION` before any process is started.

A complete synthetic profile is in
[examples/project-profile.mjs](../examples/project-profile.mjs).

### Protection of `ringi.config.mjs`

The profile is code that the runner executes, and it lies in the repository
the writer edits. Today the runner's own files (`scripts/**` with
`scripts/agent-review-profile.mjs`) are protected only by being imported
once, when the CLI starts: a change the writer makes there is not used by
the running process; it is part of the diff the reviewer reads, and it is
outside the docs candidate rule (`.md` files under `README.md`/`docs/` by
default). `AGENTS.md` and `CLAUDE.md` are read once in the preflight (the
reviewer gets that copy), and the core excludes them from any docs
candidate, whatever the profile says. `ringi.config.mjs` gets at least this,
and a fingerprint check on top:

- **Committed only.** `ringi run` and `ringi doctor` run only a committed
  profile. Before the import, the runner reads `ringi.config.mjs` from disk
  (`lstat` first, only a regular file, opened without blocking), computes
  its Git blob id itself (SHA-1 or SHA-256, the object format of the
  repository, no filters or `.gitattributes` conversions) and compares it
  with the blob of `HEAD:ringi.config.mjs` and with the file's index entry.
  `git status` is not used: it trusts index flags, `core.fsmonitor` and
  `.gitattributes`. A different blob, a file missing from `HEAD` or the
  index, a `skip-worktree` or `assume-unchanged` flag, a mode other than a
  regular file (`100644`, `100755`), or Git that cannot be read stops
  `ringi run` with **`PROFILE_UNCOMMITTED`** (exit code `1`, stage
  `preflight`) and fails the doctor check `profile-committed`; the file is
  not imported. A missing `ringi.config.mjs`, or one that is not a regular
  file on disk, is left to the load, which refuses it without an import
  (`INVALID_CONFIGURATION`). The Git commands of this check only read the object
  database and the index (`git rev-parse --show-object-format`,
  `git ls-tree`, `git ls-files -s -v`, with `core.fsmonitor=false`,
  `GIT_NO_REPLACE_OBJECTS=1`, `GIT_NO_LAZY_FETCH=1`,
  `GIT_OPTIONAL_LOCKS=0` and literal pathspecs) and start no hook, filter
  or fsmonitor. The modules it imports are known only after the load, so
  they are checked right after it, before any agent process and before the
  dry-run plan, with the same code (in `doctor`: the check `profile`
  fails); their bytes must also be the ones that were loaded. Their code,
  and the code of `ringi.config.mjs`, has then already run. The blob in
  `HEAD` comes from the repository's object database: a writer that can
  write to `.git` could rewrite the history so that `HEAD` holds its
  change. The run in which it does that still stops with
  `UNEXPECTED_GIT_MUTATION` or `PROFILE_MODIFIED`, and the runner reverts
  nothing; after such a stop, check `git log` (and the profile files)
  before the next `ringi run`. `ringi init` commits nothing: commit
  `ringi.config.mjs` (and its modules) before `ringi run`.
- **Loaded once.** `ringi run` loads it before anything else runs, through
  `loadProjectProfile` in the core. The load reads each module file once,
  computes its SHA-256 and hands exactly those bytes to Node.js (module
  hooks), so the evaluated code is the fingerprinted code. Node.js opens
  the file a second time only to determine its module format, without the
  non-blocking open: a FIFO swapped in between the two would block the
  load. Every load tags
  its module URLs with its own query, so no module of another load is
  reused, and after the load the profile's modules may import Node.js
  built-ins only: a later (lazy) import of any file from a profile module
  is refused with `INVALID_CONFIGURATION`.
- **What is fingerprinted.** `ringi.config.mjs` and, recursively, every
  module it imports inside the repository: ES modules and JSON files
  (anything else, for example CommonJS, is refused), at most 64 modules and
  4 MiB together. Imports must be relative paths (`./`, `../`) or Node.js
  built-ins; package names, `#` subpath imports, absolute paths, URLs,
  queries and fragments are refused. `require` (through `createRequire`) of
  anything but a built-in is refused, during the load and later.
- **No other file of the repository is loaded as a module.** While the
  profile loads and for the rest of the process, a file inside the
  repository that is not a fingerprinted module of the profile is refused
  when anything tries to load it as a module (for example `require` from a
  `createRequire` with another base path). The only exception is the
  ringi-core installation itself, see below.
- **A failed import fails the load.** An import that is refused, does not
  resolve or that Node.js cannot load (for example an unknown file
  extension) while the profile loads stops it with `INVALID_CONFIGURATION`,
  also when the profile catches the error. An optional import of a file
  that does not exist (`try { await import('./local.mjs') } catch {}`) is
  therefore refused: the writer could create that file for the next run.
- **Symbolic links and letter case.** `ringi.config.mjs` and every module
  must be a regular file with exactly that name; each is checked with
  `lstat` before it is opened, so a FIFO, a device or a socket is refused
  (`INVALID_CONFIGURATION`) without blocking, and one that replaces a
  fingerprinted file during the run counts as a change. The path an import names must be the path
  Node.js resolves, and the file must have exactly that name on disk, so an
  import through a symbolic link or with another letter case (on a file
  system that ignores case) is refused when the profile loads
  (`INVALID_CONFIGURATION`). Later, a fingerprinted file reached through a
  symbolic link counts as changed, even with the same content.
- **Imports outside the repository.** Refused, except modules of the
  ringi-core installation that runs the command (for example its provider
  contract): they are runner code, loaded once like the runner itself, and
  not fingerprinted. Keep the ringi-core checkout outside the repository
  and outside any directory the writer can write to.
- **Checked again.** The core compares every fingerprint at the end of the
  preflight (stage `preflight`), right after every writer round
  (`post-implementer`: for a failed round or an invalid report or analysis
  artifact before that failure is reported; for a valid report after it was
  validated and, in analysis mode, its artifact saved, together with the
  checks of the repository state), after the gates, also failed ones
  (`post-checks`), and before the review snapshot (`snapshot`). Any
  difference (content, a removed file, a symbolic link) stops the run with
  **`PROFILE_MODIFIED`**, in every task class and task mode, before any gate
  or review that would follow. In addition, once the profile record is
  verified, every stop of the run, whatever stage it comes from, compares
  the fingerprints first; the only exception is `CLEANUP_FAILED` after an
  approved run, which comes after the last of these checks.
  The change itself was never used: the profile in memory is the one loaded
  before the first round. `PROFILE_MODIFIED` is the primary code (only a
  change of the runner's own files, `RUNNER_MODIFIED`, comes before it):
  the failure it displaced (for example `INVALID_AGENT_OUTPUT`,
  `ANALYSIS_ARTIFACT_MISSING`, `CHECK_FAILED`, `WORKING_TREE_CHANGED` when a
  gate changed a tracked profile file, or `HUMAN_DECISION_REQUIRED` when the
  writer asked for a human decision) is listed in `integrityViolations`.
  The runner does not revert the change.
- **Docs candidate.** The fingerprinted files are excluded from the docs
  candidate of `docsOnly` classes (`DOCS_CANDIDATE_REJECTED`), in addition to
  the extension rule, which already excludes `.mjs` and `.json`.
- **Report.** The dry-run plan and every report after the profile record was
  verified and the Git state of its files was read (a report of a failed
  read at that point has no such field) carry
  `projectProfile: { path: 'ringi.config.mjs', sha256,
  files: [{ path, sha256 }], committed, uncommitted }`; `sha256` is the
  SHA-256 of the JSON text of `files`, paths are relative to the repository
  root. `uncommitted` lists the fingerprinted files that are not committed
  at the start of the run (the same byte comparison with `HEAD` and the
  index as in "Committed only"), `committed` is `true` when there is none. `ringi run`
  stops before the run for any of them (`PROFILE_UNCOMMITTED`, see
  "Committed only"), so its reports have `committed: true`; the core itself
  only reports them.

**Known limits.** Path aliases are a known gap: the protection is not
designed for files reached through an alias, for example a symbolic link
in the repository pointing to a checkout of the runner. The default
module loader (`nextLoad`) opens each profile module a second time only
to determine its format; the bytes that run are those read and hashed
first, and swapping the file between the two reads needs a writer process
still running during the load (a FIFO swapped in this way can block the
load).

**Between runs.** The fingerprint protects one run. A change a writer left
behind (for example after a `PROFILE_MODIFIED` stop) is not committed, so
the next `ringi run` stops with `PROFILE_UNCOMMITTED` and `ringi doctor`
fails: `ringi.config.mjs` before it is imported, a module it imports after
the load (its code, and that of `ringi.config.mjs`, has run then). Review
the diff (`git diff HEAD -- <files>`) and revert it, or commit what you
accept, before running again.

Not covered: files the profile reads by other means than `import` (for
example `fs.readFile`, `child_process`, `vm`), code a profile module starts
in a `Worker` thread (module hooks do not apply to other threads), a
`require` of a file outside the repository through `createRequire` with
another base path, and code that a profile module runs on purpose (it is
trusted like any profile). The record passed to the core must be the one
`loadProjectProfile` returned for the same profile object and repository;
anything else is `INVALID_CONFIGURATION`.

## Shape

```js
export const PROFILE = {
  title: 'EXAMPLE WORKFLOW',        // dashboard title
  tempPrefix: 'example-review-',    // prefix of temporary directories
  checks: { /* name -> check definition */ },
  checkSets: { base: [/* names */], docs: [/* names */] },
  requiredGateRules: [/* rules */],
  taskSchema: { /* task sections and aliases */ },
  taskClasses: { /* class name -> class definition */ },
  docsCandidatePolicy: { /* paths a docs-only candidate may touch */ },
  implementer: { /* provider, model and effort of the writer */ },
  reviewer: { /* provider and review profiles of the reviewer */ },
  locale: 'en',                     // language of messages, prompts and the default task schema
  // reviewLanes: optional list of parallel review lanes
  // providerModules: optional list of provider module objects
  // createPresenters: optional function returning presentation hooks
};
```

Top-level keys not listed above are rejected. Keys that are omitted take the
value from the built-in default profile.

### `locale`

The language of the runner's messages for a person: stop reasons (`error`,
`resume`) and warnings in the report, stage labels in events, the dry-run
plan's `sequence` and `mutations`, the texts of the built-in task classes,
the terminal dashboard and summary, and the argument parser's errors and
usage. `'en'` (the default when the field is left out) or `'pl'`. Any other
value, including a different letter case, is `INVALID_CONFIGURATION`. The
locale comes only from the profile, never from environment variables
(`LANG` and so on), command-line options or the task.

The locale also selects:

- **the writer and reviewer prompts** (`scripts/agent-review-prompts.mjs`).
  `'en'` prompts are neutral about providers and projects: they speak of
  "the writer", "the reviewer" and "the runner", name no model or product,
  and quote the English canonical section names (`"Required checks"`,
  `"Starting files"`, `"Allowed change area"`, `"Review files"`). `'pl'`
  prompts are the original Polish texts, except that they name the role
  ("wykonawca", "reviewer") instead of a provider. Both carry the same
  contract rules, the same JSON field names and the same constants passed by
  the core (analysis sentinel, size limit). Profiles still cannot change
  prompt texts. A run's prompts follow the locale of its messages, which is
  the profile's locale when the profile is passed to the run. Neutrality
  covers the prompt text only: values the core inserts (the analysis
  sentinel, which keeps a historical name, and the model identifier chosen
  for the run) appear as given;
- **the default `taskSchema`** (see [`taskSchema`](#taskschema)): English
  canonical section names with the Polish names as aliases for `'en'`, the
  reverse for `'pl'`. A profile that declares `taskSchema` keeps it whatever
  the locale.

Not affected by the locale: stop codes, report and event field names,
`stage` values, `schemaVersion`, `taskSchemaVersion` (1 for both default
schemas), the JSON schemas of agent results, the texts of task classes a
profile declares itself, and the messages of the `ringi` command (always
English). The report has no `locale` field.

Outside of a run, profile validation, task validation
(`validateTaskMarkdown`) and the argument parser (`parseAgentArguments`)
write their messages in the locale of the profile they receive. Other
library functions called outside of a run, such as `loadTaskFile` and
`createReviewSnapshot`, write their own messages in English whatever the
profile says; only the profile and task validation they call follows its
locale. With `locale: 'pl'` the runner's output is identical to the runner
before the message catalog (2026-10-19), which a test checks against the
code of that version, apart from texts that name the role instead of a
provider. One exception: truncation and omission markers in
agent output (such as `[summary truncated]` and `log omitted`) are
recognized in both languages, whatever the locale.

### `checks`

A record of 1–64 checks. The key is the check name and must equal the program
and its arguments joined with single spaces, so a task cannot name one command
and run another.

| Field | Type | Rules |
| --- | --- | --- |
| `program` | string | `pnpm` or `git` only. |
| `args` | string[] | 1–64 items; each non-empty, at most 200 characters, without whitespace, backticks or control characters; shape rules below. |
| `timeoutMs` | integer | 1 000 to 14 400 000 (4 hours). |
| `nestedInvocations` | string[][] | Optional, `pnpm` checks only. Exact pnpm argv lists that the writer's `pnpm` guard also allows while this check is part of the task. Each must follow the pnpm shape. |
| `passDockerHost` | boolean | Optional. The check receives the validated `DOCKER_HOST`; otherwise it is removed from the check environment. |
| `unsetCiOnDarwin` | boolean | Optional. On macOS the check runs without the `CI` variable. |

Other fields are rejected.

**pnpm argv shape.** `args` must be one of:

- `[script]`
- `['run', script]`
- `['--filter', package, script]`
- `['--filter', package, 'run', script]`

`script` starts with a letter or digit and continues with letters, digits,
`:`, `.`, `_` or `-`, and must not be a pnpm built-in command or alias (for
example `install`, `add`, `exec`, `dlx`, `publish`). `package` is a lowercase
npm package name, optionally scoped, without `..`, globs or other pnpm
selectors. Whatever shape the profile uses, the runner and the writer's guard
always execute `pnpm [--filter <package>] run <script>`, so pnpm never falls
back to a built-in command or a binary of the same name. The check name keeps
the argv from the profile.

**git argv shape.** `args` must start with `diff` and contain `--check`;
the only other options allowed, in any order and without repetition, are
`--cached`, `--staged`, `--no-ext-diff` and `--no-textconv`. Any other
subcommand, option or positional argument is rejected.

### `checkSets`

Exactly two keys, both required:

- `base`: checks added to implementation tasks whose class uses
  `checkSet: 'base'` (every class except `docs-*` in the default classes);
- `docs`: checks added instead of `base` for classes with
  `checkSet: 'docs'` (the `docs-*` default classes).

Each is a non-empty list of unique names that exist in `checks`. A task's
effective checks are its check set followed by the checks it requests in the
`Required checks` section (`Wymagane kontrole`).

### `requiredGateRules`

A list of at most 64 rules:

| Field | Rules |
| --- | --- |
| `check` | Name of an existing check. |
| `prefixes` | Optional list of repository-relative directory prefixes (a trailing `/` is allowed). |
| `paths` | Optional list of exact repository-relative paths. |
| `code` | Upper-case code ending in `_GATE`, at most 64 characters, e.g. `API_INTEGRATION_GATE`. |
| `message` | Optional text, at most 500 characters. |

At least one prefix or path is required. Prefixes and paths are at most 500
characters and must be relative: no leading `/`, no empty, `.` or `..`
segments, no backslashes or control characters.

In implementation mode the runner checks the rules in preflight, after the
writer round and after the gates. If the candidate (all changes against HEAD
plus untracked files) touches a listed path or a path under a listed prefix,
and the rule's `check` is not among the task's effective checks, the run stops
with the rule's `code` (and `message`, if set). Core stop codes never end in
`_GATE`, so a rule cannot impersonate one.

### `taskSchema`

The section headings accepted in task files. Optional: a profile without
`taskSchema` uses the built-in default of its `locale` (below). If present,
it must contain exactly these four keys:

| Field | Type | Rules |
| --- | --- | --- |
| `version` | integer | 1 to 1 000 000. Copied to the run report as `taskSchemaVersion`; the core does not interpret it otherwise. |
| `requiredSections` | string[] | 1–64 canonical section names. Each must be present and non-empty in every task (`INVALID_TASK`). |
| `optionalSections` | string[] | 0–64 canonical section names that are recognised when present. |
| `aliases` | object | At most 256 entries `alias: canonical name`. A heading equal to an alias is read as that canonical section. |

Names and aliases are non-empty strings of at most 100 characters without
control characters. They are compared in normalised heading form (trimmed,
lower case, runs of whitespace collapsed to one space), and the resolved
profile stores them in that form. The profile is rejected if:

- a section name appears twice, in one list or across both lists;
- the schema does not declare the three sections the core reads: the
  requested checks (`required checks` or `wymagane kontrole`, which must be
  a required section), the task class (`task class` or `klasa zadania`) and
  the analysis review files (`review files` or `pliki review`). Each may use
  its English or its Polish name; when a schema declares both names as
  separate sections, the core reads the Polish one (the rule before the
  English default schema);
- an alias equals a section name or another alias;
- an alias points to a name that is not in `requiredSections` or
  `optionalSections` (an alias cannot point to another alias).

The parse result keys sections by canonical name: required sections first,
in schema order, then the optional sections present in the task. In a task,
a section written under an alias may appear only once in total: a second
heading for the same section, canonical or alias, stops the run with
`INVALID_TASK`. Headings that are neither names nor aliases are ignored, as
before. Profiles cannot change prompts; the prompt texts are fixed in
`scripts/agent-review-prompts.mjs` and quote the canonical names of the
default schema of the locale.

The built-in default for `locale: 'en'` (also used by
`scripts/agent-review-profile.mjs`, which does not declare `taskSchema`):

```js
taskSchema: {
  version: 1,
  requiredSections: [
    'goal',
    'scope',
    'acceptance criteria',
    'required checks',
    'constraints',
    'deferred items',
  ],
  optionalSections: [
    'task class',
    'starting files',
    'allowed change area',
    'review files',
  ],
  aliases: {
    cel: 'goal',
    zakres: 'scope',
    'kryteria akceptacji': 'acceptance criteria',
    'wymagane kontrole': 'required checks',
    ograniczenia: 'constraints',
    deferred: 'deferred items',
    'elementy odłożone': 'deferred items',
    'klasa zadania': 'task class',
    'pliki startowe': 'starting files',
    'dozwolony obszar zmian': 'allowed change area',
    'pliki review': 'review files',
  },
},
```

The built-in default for `locale: 'pl'`, unchanged from the versions before
the English default:

```js
taskSchema: {
  version: 1,
  requiredSections: [
    'cel',
    'zakres',
    'kryteria akceptacji',
    'wymagane kontrole',
    'ograniczenia',
    'elementy odłożone',
  ],
  optionalSections: [
    'klasa zadania',
    'pliki startowe',
    'dozwolony obszar zmian',
    'pliki review',
  ],
  aliases: {
    goal: 'cel',
    scope: 'zakres',
    'acceptance criteria': 'kryteria akceptacji',
    'required checks': 'wymagane kontrole',
    constraints: 'ograniczenia',
    deferred: 'elementy odłożone',
    'deferred items': 'elementy odłożone',
    'task class': 'klasa zadania',
    'starting files': 'pliki startowe',
    'allowed change area': 'dozwolony obszar zmian',
    'review files': 'pliki review',
  },
},
```

Both defaults accept the same headings and map them to the same sections,
so a task file in either language parses with either locale; only the keys
of the parse result (`sections`) and the name in the missing-section message
differ. One difference: a section repeated under an alias is always
`INVALID_TASK`, and so is a repeated canonical heading under the default
`'en'` schema (its names were aliases before they became canonical), so two
`## Goal` or two `## Required checks` stop with `'en'`. Under the default
`'pl'` schema and under a schema the profile declares, a heading repeated
under the canonical name keeps the last content, so a task that repeats
`## Cel` parses with `'pl'` but stops with `'en'`. Both defaults have
`version: 1`: the version is the profile's own number for its schema, and
the report records it as `taskSchemaVersion` without the locale. So
`taskSchemaVersion` does not tell the default `'en'` and `'pl'` schemas
apart (both `1`), and the report does not record the locale either: which
default schema a run used follows only from the profile it ran with.

A project that wants an extra required section copies the default and adds
it, for example `requiredSections: [...default, 'risks']` with
`aliases: { ...default, ryzyka: 'risks' }`.

### `taskClasses`

The task classes a task may name in its `Task class` section (Polish:
`Klasa zadania`). Optional:
a profile without `taskClasses` uses the built-in default below. If present,
it is a record of 1–64 classes. The key is the class name: lower-case letters
and digits in groups joined by single hyphens (for example `docs-minor`), at
most 64 characters. Each class has these fields:

| Field | Type | Rules |
| --- | --- | --- |
| `independentReviewRequired` | boolean | Required. `false` skips the independent review (reported as `NOT_REQUIRED`). |
| `checkSet` | string | Required. `base` or `docs`, a key of `checkSets`. |
| `docsOnly` | boolean | Required. `true`: in implementation mode the candidate must pass `docsCandidatePolicy` in preflight, after the writer and after the gates (`DOCS_CANDIDATE_REJECTED`). |
| `reason` | string | Required, at most 500 characters. Copied to the report (`quality.reason`, and `review.reason` when the review is skipped). |
| `remainingAssurance` | string | Required, at most 500 characters. Copied to the report in the same places. |
| `policy` | string | Optional. Repository-relative path of the document that approves the class (same path rules as `requiredGateRules` paths). Copied to the report as `policy`; `null` when absent. |

Other fields are rejected; there are no patterns or functions. The core
enforces these invariants for every profile, so a profile cannot weaken the
fail-closed behaviour (each violation is `INVALID_CONFIGURATION`):

- a class with `independentReviewRequired: false` must have `docsOnly: true`;
  a class without `docsOnly` always requires review;
- a class with `checkSet: 'docs'` must have `docsOnly: true`;
- the class `implementation` must exist and be the full track:
  `independentReviewRequired: true`, `docsOnly: false`, `checkSet: 'base'`.
  A task without a `Task class` (`Klasa zadania`) section uses it;
- if any class has `docsOnly: true`, `docsCandidatePolicy` must allow at
  least one path or prefix.

Independently of the profile, the core keeps two task rules: in analysis
mode only `implementation` may be named (any other class is
`INVALID_TASK_CLASS`), and analysis always requires the review, without the
docs rule or command gates. A class name that the profile does not declare,
an empty or repeated class section, or a class heading below level 2 (for
example `### Klasa zadania`) stops the run with `INVALID_TASK_CLASS`. When
one of the two class headings is an alias (for example `## Klasa zadania`
with `### Task class`, or `## Task class` with `## Klasa zadania`), the
parser stops first with `INVALID_TASK`, as for any section repeated under an
alias (see [architecture.md](architecture.md#task-file)). For the same
reason a repeated `## Task class` stops with `INVALID_TASK` under the default
`'en'` schema, while a repeated `## Klasa zadania` under the default `'pl'`
schema stops with `INVALID_TASK_CLASS`.

The built-in default (the classes used before profiles could declare them;
`scripts/agent-review-profile.mjs` declares the same classes with `policy`):

| Class | `independentReviewRequired` | `checkSet` | `docsOnly` |
| --- | --- | --- | --- |
| `docs-minor` | `false` | `docs` | `true` |
| `docs-descriptive` | `false` | `docs` | `true` |
| `docs-contract` | `true` | `docs` | `true` |
| `implementation` | `true` | `base` | `false` |
| `critical` | `true` | `base` | `false` |

The library export `TASK_CLASSES` lists these default names; a profile may
declare other names. For a correction review, a `docsOnly` class with
required review (`docs-contract` by default) gets the findings-first
reviewer prompt; other classes keep the diff-first prompt.

### `docsCandidatePolicy`

The paths that the whole candidate of a `docsOnly` class may touch: all
changes against HEAD, untracked files, deletions and both ends of a rename.
Optional: a profile without it uses the built-in default below. If present,
it must contain exactly these six lists (each at most 64 unique strings):

| Field | Rules |
| --- | --- |
| `allowedPaths` | Exact repository-relative paths. Each must end with one of `allowedExtensions`. |
| `allowedPrefixes` | Repository-relative directory prefixes ending in `/`. |
| `allowedExtensions` | At least one of `.md`, `.markdown`, `.rst`, `.adoc` (the core allowlist). Any other value, including `.txt`, is `INVALID_CONFIGURATION`: build and dependency inputs such as `requirements.txt` or `CMakeLists.txt` use `.txt`, so a class without review can never accept them. |
| `excludedNames` | File or directory names (one path segment: at most 255 characters, no `/` or `\`, no surrounding spaces, not `.` or `..`), rejected at any depth. |
| `excludedSegments` | Directory or file names with the same rules, rejected at any depth. |
| `excludedPrefixes` | Repository-relative path prefixes, rejected from the start of the path. |

A path passes when it is in `allowedPaths` or starts with a prefix from
`allowedPrefixes`, ends with an extension from `allowedExtensions`
(case-sensitive), and matches no exclusion. `excludedNames` and
`excludedPrefixes` compare ASCII letters case-insensitively;
`excludedSegments` compare in lower case. The core always adds the base
exclusions `AGENTS.md` and `CLAUDE.md` (names) and `.git`, `.agents`,
`.claude`, `.codex` and `skills` (segments). A profile must list them too
(in any letter case), so removing one is `INVALID_CONFIGURATION`; it may add
more. Whatever the lists say, the core also rejects empty, `.` and `..`
segments, backslashes and control characters, paths that are not a regular
non-executable file in HEAD and on disk, and paths reached through a
symlink.

Case folding in the exclusions covers ASCII letters only (`excludedSegments`
use JavaScript `toLowerCase`, which also maps a few non-ASCII letters). A
case-insensitive file system may fold more: for example U+017F (long s) to
`S` or U+212A (Kelvin sign) to `k`, so a name written with them could reach
an excluded name. To stay fail-closed, the core rejects every docs candidate
path that contains a non-ASCII character whose Unicode upper- or lower-case
form contains an ASCII letter (such as U+017F, U+212A, U+0130, U+0131 or the
ligature U+FB01). Other non-ASCII names, for example Polish file names, are
not affected.

The built-in default, the rule used before profiles could declare it:

```js
docsCandidatePolicy: {
  allowedPaths: ['README.md'],
  allowedPrefixes: ['docs/'],
  allowedExtensions: ['.md'],
  excludedNames: ['AGENTS.md', 'CLAUDE.md', 'SECURITY.md', 'SKILL.md'],
  excludedSegments: ['.git', '.agents', '.claude', '.codex', 'skills'],
  excludedPrefixes: [
    'docs/development/agent-',
    'docs/development/frontend-agent-skills.md',
  ],
},
```

Example: a project whose documentation lives in `handbook/` adds a light
class for typo fixes and keeps the default classes:

```js
taskClasses: {
  ...defaultClasses, // copy of the table above, with reason and remainingAssurance
  'handbook-typo': {
    independentReviewRequired: false,
    checkSet: 'docs',
    docsOnly: true,
    reason: 'Approved policy for typo fixes in the handbook.',
    remainingAssurance: 'No independent review; checkpoint before publication.',
    policy: 'handbook/task-classes.md',
  },
},
docsCandidatePolicy: {
  allowedPaths: ['README.md'],
  allowedPrefixes: ['docs/', 'handbook/'],
  allowedExtensions: ['.md'],
  excludedNames: ['AGENTS.md', 'CLAUDE.md', 'SECURITY.md', 'SKILL.md'],
  excludedSegments: ['.git', '.agents', '.claude', '.codex', 'skills'],
  excludedPrefixes: ['handbook/agents/'],
},
```

### `implementer`

The profile chooses the provider of each role, `implementer` and
`reviewer`. A role is defined by its requirements
([implementer requirements](providers.md#implementer-requirements),
[role rules](providers.md#role-rules)); any provider module that meets them
can serve it. The default profile setting is `codex` as the implementer and
`claude` as the reviewer, a default the user changes here, not an
assumption of the runner. Built-in modules, as examples, by role and
declared stability: all three roles (`codex` implementer, `claude`
implementer, `claude` reviewer) are experimental; see
[docs/providers.md](providers.md#stability) for the stability criteria.

The role that writes each round (the implementer; older text and option
names call it the writer). Optional: a profile without
`implementer` uses the built-in default below. If present, it must contain
exactly these four keys:

| Field | Type | Rules |
| --- | --- | --- |
| `provider` | string | A provider that serves this role: a built-in one, `codex` (Codex CLI, the default) or `claude` (Claude Code CLI), or the `id` of a module in [`providerModules`](#providermodules). Any other value is `INVALID_CONFIGURATION`. |
| `model` | string | One model identifier: 1–128 ASCII letters, digits, `.`, `_` or `-`, starting with a letter or digit; a module from `providerModules` may restrict it further (its `isValidModel`). |
| `effort` | string | Default effort; must be in `allowedEfforts`. |
| `allowedEfforts` | string[] | Non-empty list of unique efforts the run may use; each must be in the provider's allowlist (`codex`: `medium`, `high`, `xhigh`, `max`; `claude`: `medium`, `high`, `xhigh`). |

The built-in default (the values used before profiles could declare them):

```js
implementer: {
  provider: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
  allowedEfforts: ['medium', 'high', 'xhigh', 'max'],
},
```

`--implementer-model` overrides `model` with any identifier that follows
the model rule; `--implementer-effort` overrides `effort` with a value from
`allowedEfforts`. Both apply to the implementer of any provider.
`--codex-model` and `--sol-effort` are deprecated aliases with the same
validation; giving an alias together with its new option is an argument
error, as for a repeated option. The CLI rejects any other value as an
argument error: it prints the error and the usage message and exits with
code 2, before a run starts. The library options `implementerModel` and
`implementerEffort` of `runAgentReviewLoop` follow the same rules (the
deprecated `codexModel` and `solEffort` are still read when the new options
are absent); there an invalid value stops the run with
`INVALID_CODEX_MODEL` or `INVALID_SOL_EFFORT` (stage `preflight`).

Before the first round the runner reads the version of each role's CLI and
calls its module's preflight. With `provider: 'codex'` any Codex CLI
version is accepted (the declarations were probed on 0.160.0 only), and
a platform other than macOS or Linux stops the run with
`IMPLEMENTER_PREFLIGHT_FAILED` (stage `preflight`); a version command
that fails still stops the run. When a review is
required, the `claude` reviewer accepts any Claude Code version on the
same platforms as the `claude` implementer (below; probed on 2.1.285 and
2.1.311); a refused host stops the run with `REVIEWER_PREFLIGHT_FAILED`
(stage `preflight`).

With `provider: 'claude'` the implementer is Claude Code in print mode. The
profile chooses only the model and the efforts; permissions, tools, sandbox
and session handling are fixed by the core (see
[architecture.md](architecture.md#claude-code-as-implementer)):

```js
implementer: {
  provider: 'claude',
  model: 'claude-opus-5',
  effort: 'high',
  allowedEfforts: ['medium', 'high', 'xhigh'],
},
```

Before the first round the runner checks `claude --version` and the
platform: any Claude Code version is accepted, and a platform without the
Claude Code command sandbox (anything other than macOS or Linux) stops the
run with `IMPLEMENTER_PREFLIGHT_FAILED` (stage `preflight`); a version
command that fails still stops the run. The sandbox settings were probed
on 2.1.285 only, and the CLI ignores unknown sandbox settings without an
error, so another version runs unchecked (a limitation of the module). When the
reviewer uses the same provider as the implementer, the report's `reviewer`
field gets `warnings: ['SAME_PROVIDER_REVIEW']` (weaker independence; the
run is not blocked and the review still runs in a new session).

`implementer.provider: "claude"` is experimental, not for untrusted tasks.
With Claude Code as writer the preflight also refuses, before any `claude`
process, a repository whose `.git` is not a directory (linked worktree,
submodule) or that has `.gitmodules`, entries in the Git directory's
`modules/` or `worktrees/`, `objects/info/alternates`, or symbolic links
among the `.git` entries the fingerprint reads as plain files and
directories (`IMPLEMENTER_PREFLIGHT_FAILED`). Around every round of the
Claude Code writer the core kills the CLI's process group and the
processes and process groups its process watch saw when the CLI exits
(best effort; a process is identified by its PID and start time;
`IMPLEMENTER_PROCESS_SURVIVED` when one survives or the process table is
unreadable), compares a fingerprint of the Git directory
(`UNEXPECTED_GIT_MUTATION`) after the round, after the gates and after the
review, runs its own Git commands with a private index built from `HEAD`
(compared again at the same points), removes the empty
`.claude/.cc-writes` directory the CLI creates (one that existed before the
round is kept; `IMPLEMENTER_SCRATCH_NOT_EMPTY` when it is not empty), and
stores the
tool calls the CLI denied in `rounds[].solExecution.permissionDenials`; see
[architecture.md](architecture.md#claude-code-as-implementer). Known
limits: a background process started by Claude Code's Bash that left the
CLI's process tree between two readings of the process watch is not
killed and outlives the CLI (the escape itself was confirmed by a probe of
2.1.285); it can change `.git`, the working tree or the private index, and
only changes before the last comparison (after the review) are detected.

The writer runs in the same isolated environment as `codex`, which does not
pass `CLAUDE_CONFIG_DIR`: Claude Code uses its default configuration
directory and login (as the user's own `claude` would without the
variable). With a custom `CLAUDE_CONFIG_DIR`, which the reviewer keeps, the
writer may stop with `PROCESS_FAILED` for lack of a login, or run under
another account.

### `reviewer`

The role that runs the independent review. Optional: a profile without
`reviewer` uses the built-in default below. If present, it must contain
exactly these four keys:

| Field | Type | Rules |
| --- | --- | --- |
| `provider` | string | A provider that serves this role: the built-in `claude` (Claude Code CLI) or the `id` of a module in [`providerModules`](#providermodules) that declares the reviewer role. `codex` and any other value are `INVALID_CONFIGURATION`. |
| `profiles` | object | 1–64 review profiles. The key is the profile name (lower-case letters and digits in groups joined by single hyphens, at most 64 characters); the value is a list of attempts `{ model, effort }`, with no other fields. `model` follows the model rule above; `effort` must be in the provider's allowlist (`claude`: `medium`, `high`, `xhigh`). |
| `defaultProfile` | string | Name of a profile in `profiles`; used when no review profile is selected. |
| `fallbackProfile` | string or `null` | Name of the profile that may fall back, or `null` for none. |

The fallback profile has exactly two attempts: the second runs only when the
first fails with model unavailability, capacity or usage limit errors. Every
other profile has exactly one attempt. A profile that breaks this rule is
`INVALID_CONFIGURATION`, so every planned attempt can run.

The built-in default (the review profiles used before profiles could declare
them):

```js
reviewer: {
  provider: 'claude',
  profiles: {
    critical: [
      { model: 'claude-fable-5', effort: 'high' },
      { model: 'claude-opus-5', effort: 'xhigh' },
    ],
    'critical-opus': [{ model: 'claude-opus-5', effort: 'xhigh' }],
    standard: [{ model: 'claude-opus-5', effort: 'high' }],
    economy: [{ model: 'claude-opus-5', effort: 'medium' }],
  },
  defaultProfile: 'critical',
  fallbackProfile: 'critical',
},
```

`--review-profile` selects a profile from `profiles`. The CLI rejects any
other name as an argument error (error and usage message, exit code 2). The
library option `reviewProfile` of `runAgentReviewLoop` stops the run with
`INVALID_REVIEW_PROFILE` (stage `preflight`) for a name that is not a profile
in `profiles`, including any value that is not a string. The usage message
lists the profile's efforts and review profiles.

The name `invalid` is reserved: the report of a run stopped for an unknown
review profile names it `invalid`, so a profile with this name is
`INVALID_CONFIGURATION`. Only the profile named in `fallbackProfile` allows a
fallback; with `fallbackProfile: null` no profile does.

The library still exports `CODEX_MODEL`, `SOL_EFFORTS`, `DEFAULT_SOL_EFFORT`,
`REVIEW_PROFILES` and `DEFAULT_REVIEW_PROFILE`, which keep the built-in
default values; they come from `scripts/agent-review-providers.mjs`.

### `reviewLanes`

Optional. Without it a single reviewer reviews each round, exactly as
before. With it, each review round runs one reviewer per lane, all in
parallel on the same read-only snapshot, and merges their findings (see
[architecture.md](architecture.md#review-lanes)). A list of 1 to 4 lanes,
each with exactly these keys:

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | `[a-z][a-z0-9-]{0,31}`, unique within the list. |
| `focus` | string | 1 to 200 characters: Latin letters `A-Z` `a-z`, digits, spaces and `, . ; : ( ) / -` (no letters of other scripts, so no look-alike letters); it starts with a letter or digit and ends with a letter, digit, `.` or `)`; no two spaces in a row, so no line break, tab, quote, bracket other than parentheses, Markdown or code. A focus that contains `json`, `schema`, `verdict`, `approv`, `severit`, `finding`, `check`, `confirmednochanges`, `format`, `prompt`, `instruct`, `ignor` or `overrid` anywhere, in any letter case, is refused, so `approved`, `findings`, `checks` and `information` are refused too. This guards against mistakes, not against prompt injection: the profile is trusted code, and the focus is not a security barrier. |
| `profile` | string | Optional. A review profile in `reviewer.profiles`; without it the lane uses the run's review profile (`--review-profile` or `defaultProfile`). |

Every lane uses `reviewer.provider`; a lane has no provider of its own. Any
other value, key or a getter is `INVALID_CONFIGURATION`.

The reviewer prompt stays the fixed prompt of
`scripts/agent-review-prompts.mjs`: a lane only appends one line after it,
naming the lane and its focus and stating that the focus directs attention
only, that every rule, the result schema and the zero findings policy apply
unchanged and that findings outside the focus are still reported. The
profile cannot change or remove any part of the fixed prompt.

```js
reviewLanes: [
  { id: 'correctness', focus: 'logic errors, regressions and contracts' },
  { id: 'security', focus: 'auth, secrets, injection and unsafe input' },
  { id: 'tests', focus: 'missing, weak or misleading tests', profile: 'standard' },
],
```

Each lane is a full review with its own process, so a round costs about as
many reviews as there are lanes.

### `providerModules`

Optional list of provider modules: code objects that describe an agent CLI
the built-in providers do not cover. How to write one is in
[providers.md](providers.md). The profile imports the module and passes the
object itself; the runner never loads a provider from a path, a URL, a CLI
option or the task file, and a provider is never a raw command line:

```js
// A module kept in the project, outside the runner's scripts/providers/.
import exampleProvider from '../agent-providers/example-provider.mjs';

export const PROFILE = {
  // ...
  providerModules: [exampleProvider],
  implementer: {
    provider: 'example-agent',
    model: 'example-large-1',
    effort: 'medium',
    allowedEfforts: ['low', 'medium', 'high'],
  },
};
```

`examples/providers/example-provider.mjs` is a template for a fictional CLI;
it does not describe a real tool. Each module is validated before any
process starts:

- a module that does not match the provider contract (unknown or missing
  fields, a missing function, a getter, a `Symbol` key, a prototype other
  than `Object`, a proxy, a reserved program name), a string or URL instead
  of a module, an `id` equal to a built-in provider (`codex`, `claude`) or
  to another module: `INVALID_CONFIGURATION`;
- a module whose security declaration does not allow a role it declares
  (see [providers.md](providers.md#role-rules)):
  `PROVIDER_ROLE_NOT_ALLOWED`.

Both stop the run in preflight. The role rules read the module's own
declaration; the core does not verify that the CLI keeps the declared
sandbox, network blocking, prompt-free operation or ignored user
configuration, so review the module before you register it (see
[providers.md](providers.md#security-declaration)). For a module from
`providerModules` the core always applies the checks it applies to the
Claude Code writer (repository layout, process group, Git directory
fingerprint, private index), whatever the module declares.

### `title`, `tempPrefix`, `createPresenters`

- `title` and `tempPrefix` are non-empty strings without control characters;
  `tempPrefix` must not contain `/` or `\`.
- `createPresenters` is the only function allowed in a profile outside
  provider modules. The CLI calls it to obtain optional presentation hooks;
  errors in it never change the report or the exit code.

## Validation details

- Every level must be a plain object or array. Only data properties are read,
  so getters never run; functions other than `createPresenters` and the
  functions of provider modules (checked by the provider contract) are
  rejected.
- The resolved profile is frozen; resolving it again gives the same result.
- Failures of the profile itself do not explain which field is wrong: the
  error is `INVALID_CONFIGURATION` with stage `preflight`. Failures of a
  provider module name the field in the message, and a refused role is
  `PROVIDER_ROLE_NOT_ALLOWED`.

## Example

```js
checks: {
  'pnpm --filter @example/api run test:integration': {
    program: 'pnpm',
    args: ['--filter', '@example/api', 'run', 'test:integration'],
    timeoutMs: 30 * 60_000,
    passDockerHost: true,
  },
  'git diff --check': {
    program: 'git',
    args: ['diff', '--check'],
    timeoutMs: 2 * 60_000,
  },
},
requiredGateRules: [
  {
    check: 'pnpm --filter @example/api run test:integration',
    prefixes: ['packages/api/src/db/'],
    code: 'API_INTEGRATION_GATE',
  },
],
```

Rejected, each with `INVALID_CONFIGURATION`:

```js
{ 'pnpm install': { program: 'pnpm', args: ['install'], timeoutMs: 60_000 } } // built-in command
{ 'git status': { program: 'git', args: ['status'], timeoutMs: 60_000 } }     // not diff --check
{ 'npm test': { program: 'npm', args: ['test'], timeoutMs: 60_000 } }         // program not allowed
{ 'pnpm lint': { program: 'pnpm', args: ['test'], timeoutMs: 60_000 } }       // name differs from argv
{ check: 'pnpm test', paths: ['src/a.ts'], code: 'API_CHECK' }               // code without _GATE
// below, schema is a valid task schema such as the default
taskSchema: { ...schema, extra: true }                                        // unknown field
taskSchema: { ...schema, aliases: { objective: 'goals' } }                    // alias to a missing section
taskSchema: { ...schema, aliases: { aim: 'goal', AIM: 'scope' } }             // aliases collide
taskSchema: { ...schema, aliases: { goal: 'scope' } }                         // alias equals a section name
taskSchema: { ...schema, requiredSections: [] }                               // no required section
taskSchema: { ...schema, requiredSections: [...schema.requiredSections, ''] } // empty section name
// below, classes and docsPolicy are valid values such as the defaults
taskClasses: { ...classes, quick: { ...classes.critical, independentReviewRequired: false } } // no review without docsOnly
taskClasses: { ...classes, light: { ...classes.critical, checkSet: 'docs' } }  // docs check set without docsOnly
taskClasses: { ...classes, critical: { ...classes.critical, checkSet: 'full' } } // unknown check set
taskClasses: { critical: classes.critical }                                    // no implementation class
taskClasses: { ...classes, critical: { ...classes.critical, pattern: '^src/' } } // unknown field
docsCandidatePolicy: { ...docsPolicy, excludedNames: ['SECURITY.md'] }          // base exclusions removed
docsCandidatePolicy: { ...docsPolicy, allowedPaths: [], allowedPrefixes: [] }   // nothing allowed for docs classes
docsCandidatePolicy: { ...docsPolicy, allowedExtensions: ['.md', '.js'] }       // extension outside the allowlist
docsCandidatePolicy: { ...docsPolicy, allowedPrefixes: [/^docs\//] }            // a pattern instead of a string
// below, implementer and reviewer are valid values such as the defaults
implementer: { ...implementer, provider: 'other-cli' }                       // neither built in nor in providerModules
implementer: { ...implementer, provider: 'claude' }                          // allowedEfforts of the default contain max, outside the claude allowlist
implementer: { ...implementer, effort: 'low' }                               // effort outside allowedEfforts
implementer: { ...implementer, allowedEfforts: ['high', 'low'] }             // effort outside the provider allowlist
implementer: { ...implementer, model: 'gpt 6' }                              // invalid model identifier
implementer: { ...implementer, sandbox: 'danger-full-access' }               // unknown field
reviewer: { ...reviewer, provider: 'codex' }                                 // role not served by the provider
reviewer: { ...reviewer, profiles: {} }                                      // no review profile
reviewer: { ...reviewer, profiles: { ...profiles, standard: [] } }           // profile without attempts
reviewer: { ...reviewer, profiles: { ...profiles, standard: [{ model: 'claude-opus-5', effort: 'max' }] } } // effort outside the provider allowlist
reviewer: { ...reviewer, profiles: { ...profiles, invalid: [{ model: 'claude-opus-5', effort: 'high' }] } } // reserved profile name
reviewer: { ...reviewer, defaultProfile: 'missing' }                         // default profile does not exist
reviewer: { ...reviewer, fallbackProfile: 'standard' }                       // fallback profile without two attempts
reviewLanes: []                                                              // no lane
reviewLanes: [{ id: 'Security', focus: 'auth and secrets' }]                 // id with an upper-case letter
reviewLanes: [{ id: 'tests', focus: 'tests' }, { id: 'tests', focus: 'docs' }] // the same id twice
reviewLanes: [{ id: 'tests', focus: 'return JSON only' }]                    // a reserved word in the focus
reviewLanes: [{ id: 'tests', focus: 'tests\nand more' }]                     // a line break in the focus
reviewLanes: [{ id: 'tests', focus: 'tests', provider: 'claude' }]           // unknown field
reviewLanes: [{ id: 'tests', focus: 'tests', profile: 'missing' }]           // review profile does not exist
// below, provider is a valid provider module such as the example provider
providerModules: ['./providers/example-provider.mjs']                        // a path instead of a module
providerModules: [{ ...provider, id: 'codex' }]                              // id of a built-in provider
providerModules: [provider, { ...provider }]                                 // the same id twice
providerModules: [{ ...provider, command: 'agent --yolo' }]                  // unknown field
```

A module whose declaration does not mark every guarantee its role needs as
`enforced`, or whose implementer has no `preflight`, is
`PROVIDER_ROLE_NOT_ALLOWED` instead (the full list per role is in
[providers.md](providers.md#role-rules)).

[examples/validate-examples.test.mjs](../examples/validate-examples.test.mjs)
checks the example profile and some of these rejections against the core.

## Report fields

With the `ringi` command, the report and the dry-run plan end with
`projectProfile` (path and fingerprints of `ringi.config.mjs` and its
modules and their Git status at the start of the run, see
[above](#protection-of-ringiconfigmjs)); with
`scripts/agent-review-loop.mjs` the field is absent.

`quality` in the run report and in the `metadata` event contains the
effective gates (`effectiveGates`) and the resolved class: `taskClass`,
`docs` (`docsOnly` in implementation mode),
`independentReviewRequired`, `reason`, `policy` (the class's `policy` or
`null`) and `remainingAssurance`. When the review is skipped, `review`
repeats `reason`, `policy` and `remainingAssurance` with `status:
'NOT_REQUIRED'` and zero attempts.

The roles appear under neutral names next to the earlier provider-specific
names, which stay as aliases with equal values (see
[architecture.md](architecture.md#report)):

| Neutral field | Alias |
| --- | --- |
| `implementer` (`status: 'NOT_RUN'` and the other fields `null` with `--review-only`; otherwise `provider`, `model`, `effort`, `effectiveModel`, `effectiveEffort`, `attemptCount`, `runs`; `warnings: ['UNPROBED_VERSION']` only when the implementer CLI's version is outside the module's `probedVersions` or cannot be read) | `sol` (`plannedModel`, `plannedEffort`, `effectiveModel`, `effectiveEffort`, `runs`) |
| `reviewer` (`provider`, `profile`, `model` and `effort` of the first planned attempt, `effectiveModel`, `effectiveEffort`, `attemptCount`; `warnings` only when not empty: `SAME_PROVIDER_REVIEW` when both roles use the same provider and a review is required, then `UNPROBED_VERSION` as for `implementer`) | summary of `review` |
| `agents.implementer` (`provider`, `version`, `model`, `effort`; `warnings` as in `implementer`, version warning only) | `agents.codex`, `agents.codexModel`, `agents.codexReasoning` |
| `agents.reviewer` (`provider`, `version`, `profile`, `plannedAttemptCount`, `fallbackAllowed`, `plannedAttempts`; `warnings: ['UNPROBED_VERSION']` as for `implementer`) | `agents.claude`, `agents.claudeReviewProfile`, `agents.claudeAttemptCount`, `agents.claudeFallbackAllowed`, `agents.claudeAttempts` |
| `rounds[].implementer` (`provider`, `outputField: 'codex'` or `null` with `--review-only`, `executionField: 'solExecution'`), `rounds[].reviewer` (`provider`, `outputField: 'claude'` or `null` when no review ran, `executionField: 'reviewExecution'`) | names of the keys `rounds[].codex`, `rounds[].solExecution`, `rounds[].claude`, `rounds[].reviewExecution` |
| `findings.rejectedByImplementer` | `findings.rejectedByCodex` |
| `metadata` event: `implementer` (`provider`, `model`, `effort`), `reviewer` (`provider`, `profile`, `attempts`, `fallbackAllowed`) | `solModel`, `solEffort`, `reviewProfile`, `reviewAttempts`, `reviewFallbackAllowed` |
| `actor` (`implementer` or `reviewer`) and `provider` in writer and reviewer `stage:*` and `activity` events | `badge` `SOL`/`CLAUDE`, `role` `ASTRA`/`CLAUDE` |

The aliases describe the role, not the provider. With `implementer.provider:
'claude'`, `sol`, `agents.codex` (the version printed by `claude --version`),
`agents.codexModel`, `agents.codexReasoning`, `rounds[].codex`,
`rounds[].solExecution`, `findings.rejectedByCodex`, `solModel`,
`solEffort`, the badge `SOL` and the role `ASTRA` all refer to the Claude
Code implementer; `claude*` aliases always refer to the reviewer. Stage
values name the role for any provider: `implementer` (writer round),
`post-implementer` (checks after a writer round) and `reviewer` (review).

The neutral round fields do not copy the agent outputs: they name the alias
keys of the same round that hold them, so each agent output is serialized
once in `report.json`, `round-N.json` and the `--json` output.

Because `findings.rejectedByImplementer` and `findings.rejectedByCodex` hold
the same entries, the finding categories are disjoint only within one of the
two names. `schemaVersion` is unchanged.

`warnings` of a role is optional and absent when empty. `UNPROBED_VERSION`
(see [providers.md](providers.md#contract)) is set once the preflight has
read the CLI versions, so a run stopped before that has none; it is a
warning only and changes no status, stop code or exit code. The field adds
to the format without changing an existing field, so `schemaVersion`
stays 1.

A run with `--review-only` (see [cli.md](cli.md#review-only)) adds
`runMode: 'review-only'` to the report (`APPROVE` and `STOPPED`), the
dry-run plan and the `metadata` event; any other run has no `runMode`
field. In such a run the writer does not run: `implementer` has
`status: 'NOT_RUN'`, `attemptCount: 0` and `runs: []` (its `model` and
`effort` are the profile's, unused), `sol.runs` is empty,
`agents.codex` and `agents.implementer.version` are `null`, the single
round has no `codex` and `solExecution` keys, and its `implementer` has
`outputField: null` and `executionField: null`, as `reviewer.outputField`
is `null` when no review ran. The dry-run plan has `maxRounds: 1`. These
fields add to the format or take values the format already allows, and a
run without the option is unchanged, so `schemaVersion` stays 1.

A run with `--checkpoint` or `--resume` (see
[cli.md](cli.md#checkpoints-and-resume)) adds `checkpoint` to the report
(`APPROVE` and `STOPPED`): `path` (the checkpoint relative to the
repository, or `null` when no phase completed), `signature`
(`'hmac-sha256'`), `phase` (`implementer`, `checks` or `review`, or `null`)
and `round` of the last saved checkpoint, and in a stopped run `resumable`
(`false`, with `path` `null` and an entry in `warnings`, when the stop could
not be recorded and the checkpoint was removed). A resumed run adds
`resumedFrom` (the run id it continues); its rounds keep the numbers of the
lineage, and a round resumed after the writer's phase has no `solExecution`
key (no writer ran in it). Its gate results always come from gates run in
that run. A run without these options has none of these fields, so
`schemaVersion` stays 1.

Every run with a run directory adds `ledger` to the report (`APPROVE` and
`STOPPED`, not the dry-run plan): `path` (the run's `ledger.jsonl` relative
to the repository), `events` (the number of its events) and `headHash` (the
SHA-256 of its last line); see [ledger.md](ledger.md). The field is
additive and no other field changes, so `schemaVersion` stays 1.

A run with [`reviewLanes`](#reviewlanes) adds, once a review stage ran:
`reviewer.lanes` (one entry per lane and review round: `round`, `id`,
`provider`, `profile`, `model` and `effort` of the completed attempt, or of
the last attempt when none completed, `status` (`COMPLETED`, `FAILED` when
the lane's reviewer did not complete, `INVALID` when its result was not
valid), `findingCount` (the lane's own findings, `null` without a valid
result) and `durationMs`); in each review round, `claude` is the merged
result, `reviewLanes` lists each lane's entry with its `execution` (the
lane's `reviewExecution`), `reviewer.executionField` is `'reviewLanes'` and
the round has no `reviewExecution` key; every finding has `lanes` (the ids
of the lanes that reported it, in profile order); `review.runs` has one
execution per lane and round, each with its `lane`. A run stopped by a lane
has `lane` (the lane's id) next to `code`. A run without `reviewLanes` has
none of these fields and is unchanged, so `schemaVersion` stays 1.
