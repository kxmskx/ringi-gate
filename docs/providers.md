# Provider modules

A provider module describes one agent CLI to the runner: the roles it can
serve, how it builds the argv and environment of a process, how it reads
results and sessions, how it checks the host, and how it meets each safety
guarantee. The runner ships two built-in modules, `codex`
([scripts/providers/codex.mjs](../scripts/providers/codex.mjs)) and `claude`
([scripts/providers/claude.mjs](../scripts/providers/claude.mjs)). Other CLIs
can be added as modules that a project profile passes in
[`providerModules`](profile.md#providermodules).

The roles, the implementer and the reviewer, are defined by requirements
(see [Implementer requirements](#implementer-requirements) and
[Role rules](#role-rules)), not by a CLI. The profile chooses the provider of
each role; any module that meets the requirements of a role can serve it.
The default profile setting is `codex` as the implementer and `claude` as
the reviewer, a default the user changes in the profile. Roles and status,
as declared in the modules (`roles`, `stability`; see
[Stability](#stability) for what the status means):

| Provider | Implementer | Reviewer |
| --- | --- | --- |
| `codex` (built-in) | experimental (default) | — |
| `claude` (built-in) | experimental | experimental (default) |
| `example-agent` (template in `examples/`, not shipped) | experimental | experimental |

Only the two built-in modules are part of the runner. No module for any other
CLI is shipped or tested here;
[examples/providers/example-provider.mjs](../examples/providers/example-provider.mjs)
is a template for a fictional CLI (`example-agent`) that the tests drive with
a stub instead of a process.

A provider is always a code module with tests, never a raw command line in
the profile. The runner loads no provider from a path, a URL, a CLI option
or the task file; the profile imports the module and passes the object.

## Contract

The contract is [scripts/providers/contract.mjs](../scripts/providers/contract.mjs)
(part of the runner core). A module is the object returned by
`defineProvider({...})`, which validates it and returns a frozen copy, or a
plain object of the same shape (the core validates it when it loads the
profile either way).

| Field | Rules |
| --- | --- |
| `id` | `[a-z][a-z0-9-]{0,31}`; the name the profile uses in `implementer.provider` or `reviewer.provider`. Must not be `codex`, `claude` or the `id` of another module. |
| `program` | Bare executable name (no path), found on `PATH`. Not a reserved name: shells and interpreters (also with a version suffix, after a hyphen or underscore too, such as `python3.12`, `perl5.34` or `bash-5.2`), `java` and `jshell`, programs that run another program (`env`, `nohup`, `timeout`, `busybox`, `sudo`, `arch`, `sandbox-exec`, `tmux`, `screen`, `find`, `expect`, `strace` and similar), job schedulers (`crontab`, `at`, `batch`), `Rscript` and `swift`, editors (`vi`, `vim`, `emacs`, `nano` and similar), network clients (`ssh`, `curl` and similar) and the guarded tools (`git`, `pnpm`, `npm` and similar). The list is best effort, not proof that a program cannot run arbitrary code. |
| `versionArgs` | 1–4 arguments of the preflight version check, without forbidden arguments (below). |
| `roles` | `['implementer']`, `['reviewer']` or both; a role object must be present exactly for each listed role. |
| `efforts` | 1–8 effort names the module accepts; the profile's efforts must come from this list. |
| `isValidModel(model)` | Returns `true` for model IDs the CLI accepts. The core also applies its own model rule (1–128 ASCII letters, digits, `.`, `_`, `-`, starting with a letter or digit). |
| `implementer` | Role object (below). |
| `reviewer` | Role object (below). |

Every role object has a declaration:

| Field | Rules |
| --- | --- |
| `modes` | Task modes the role serves: `implementation`, `analysis` or both. A run in another mode stops with `INVALID_TASK_MODE`. |
| `stability` | `stable` or `experimental`. |
| `limitations` | Known limits (0–32 texts). |
| `security` | One entry per guarantee (below). |

and functions:

| Role | Function | Meaning |
| --- | --- | --- |
| implementer | `processArgs({ taskMode, model, effort, repositoryRoot, schemaPath, outputPath, outputSchema, sessionId })` | argv of a round; `sessionId` is set for a correction round, which must resume that session. |
| implementer | `processEnvironment({ environment, guardBin })` | The process environment: exactly `environment` with `guardBin` first on `PATH`. |
| implementer | `sessionId(stdout)` | The session ID of the round, or `undefined`. For a module from `providerModules` it must be 1–128 ASCII letters, digits, `.`, `_`, `:` or `-`, starting with a letter or digit (`isValidSessionId` in the contract). |
| implementer | `preflight({ version, platform })` | `undefined` when the host can run the role, otherwise `UNSUPPORTED_VERSION` or `UNSUPPORTED_PLATFORM`. |
| implementer, optional | `output(stdout)` | The round report as `{ value }` or `{ text }`, or `undefined`. Without it, the CLI must write the report to `outputPath`. |
| implementer, optional | `permissionDenials(stdout)` | Tool calls the CLI denied (`{ toolName, toolInput }[]`), stored redacted in the round report. |
| implementer, optional | `resumeKeepsSessionId`, `gitDirectoryWritable`, `scratchDirectories` | See [Core checks](#core-checks). |
| reviewer | `processArgs({ model, effort, outputSchema })` | argv of a review attempt; the reviewer never resumes a session. |
| reviewer | `processEnvironment({ environment })` | Exactly `environment`. |
| reviewer | `reviewOutput(envelope)` | The review inside the parsed JSON output as `{ value }` or `{ text }`, or `undefined`. |
| reviewer | `fallbackReason(text)` | `MODEL_UNAVAILABLE`, `CAPACITY_UNAVAILABLE`, `USAGE_LIMIT_EXHAUSTED` or `undefined` for a failed attempt's redacted output; never a reason for authentication, permission or configuration errors. |
| reviewer, optional | `preflight({ version, platform })` | The same as the implementer's, called before the first review when a review is required. |

Fields are read as data properties only: unknown fields, missing functions,
getters, `Symbol` keys, objects whose prototype is not `Object` (or `null`),
arrays with extra fields and proxies are rejected. Any rejection is
`INVALID_CONFIGURATION` in the run.

Values the functions return are read the same way where the core acts
on them: the argv must be a plain array of strings (no proxy, getter, hole
or own field such as its own `every`), which the core copies once
(`copyProviderArgs`) and then checks and runs only that frozen copy; the
environment must equal the core's, which the core then uses; the review of
a module from `providerModules` is validated as a JSON copy.

## Security declaration

Each role declares every guarantee as `{ status: 'enforced', mechanism }` (a
short description of the CLI mechanism) or `{ status: 'not-supported',
reason }`:

| Guarantee | Meaning |
| --- | --- |
| `noApprovalPrompts` | The CLI never waits for a person to approve an action; what would need approval is denied. |
| `sandboxByMode` | Commands and file tools run in a sandbox chosen by task mode: writes only in the working directory in `implementation`, read-only in `analysis`. |
| `noCommandNetwork` | Commands the agent runs reach no network host. |
| `noUserConfiguration` | User and project configuration of the CLI (rules, hooks, plugins, MCP servers, settings files) is not loaded. |
| `pathGuards` | Commands find the guarded commands in the core's guard directory: it comes before the runner's `PATH`, and no directory before it holds a guarded command. |
| `isolatedEnvironment` | The process gets only the core's environment. This isolates variables (no API keys or tokens), not the file system: the implementer environment keeps the user's `HOME` and, when set, `CODEX_HOME`, and the reviewer environment also keeps `CLAUDE_CONFIG_DIR`, so a CLI can still read credential files of other CLIs there. |
| `schemaOutput` | The CLI constrains the result to the core's JSON schema. |
| `explicitResume` | A correction round resumes the session by its ID only. |
| `readOnlyTools` | The role has file reading tools only, in every mode. |

A declaration is the module's own description of the CLI (self-report). The
core does not verify it: it cannot see whether the CLI really keeps its
sandbox, blocks the network, never asks for approval or ignores the user's
configuration. The conformance suite checks only what the argv shows (a
schema or output file in the argv, a different argv per task mode) and the
forbidden-argument list (a safety net, below). **Review of the module
against the real CLI is the guarantee**; the declaration makes that review
explicit, and the core's own checks below hold whatever it says.

## Role rules

The core refuses a module, before any process, when a role it declares
lacks what the role needs (`PROVIDER_ROLE_NOT_ALLOWED`, stage `preflight`).
The rules read the declaration's `status` fields, so they refuse a module
that admits a missing guarantee; they cannot detect a module that claims one
falsely:

| Role | Needs `enforced` | Also needs |
| --- | --- | --- |
| `implementer` | `noApprovalPrompts`, `sandboxByMode`, `noCommandNetwork`, `noUserConfiguration`, `pathGuards`, `isolatedEnvironment`, `explicitResume` | a `preflight` function |
| `reviewer` | `readOnlyTools` | – |

The rules are in the core (`ROLE_REQUIREMENTS` and `roleRuleViolations` in
the contract, applied again by `agent-review-loop-lib.mjs` when it loads a
module); a module cannot change them. The built-in modules pass them.

## Core checks

Whatever a module declares, the core enforces these checks for every
provider. They do not depend on the declaration; sandbox, network blocking,
approval prompts and user configuration of the CLI do, and rest on review
of the module.

- **argv.** The argv a module returns must be a plain array of strings; the
  core copies it once and uses only the copy (see [Contract](#contract)).
  Before the process starts, the core scans the copy against the
  [forbidden-argument list](#forbidden-arguments) (`PROVIDER_CONTRACT_VIOLATION`,
  stage `implementer` for the implementer, `reviewer` for the reviewer). The scan is a
  safety net against known mistakes, not a guarantee: an argument outside
  the list can still weaken a CLI. Values the core passed in (paths, model,
  output schema and, for the built-in providers, the session ID) are not
  inspected.
- **Environment.** The environment a module returns must equal the core's:
  the isolated implementer environment (with an empty private `ZDOTDIR`)
  with the guard directory first on `PATH`, or the reviewer's allowlisted
  environment. Adding, dropping or changing
  a variable is `PROVIDER_CONTRACT_VIOLATION`.
- **Model, efforts and modes.** The core model rule and the module's
  `isValidModel`; efforts from the module's list and the profile's
  allowlist; task modes from the role's `modes`.
- **Preflight.** After the version check of each role, any result of that
  role's `preflight` other than `undefined`, or an exception, stops the run
  with `IMPLEMENTER_PREFLIGHT_FAILED` or, for the reviewer,
  `REVIEWER_PREFLIGHT_FAILED` (stage `preflight`). The reviewer's version is read and
  its preflight called only when a review is required.
- **Output and sessions.** Results go through the same schema validation as
  for the built-in providers; anything else is `INVALID_AGENT_OUTPUT`. A
  session ID must meet `isValidSessionId` (read and resumed IDs alike),
  for every provider including the built-in `codex`; for a module from
  `providerModules` it is also scanned in the argv like any other argument
  (the built-in providers pass it as an exempt value). A resumed
  round must report the session it resumed for `claude`
  (`resumeKeepsSessionId`) and for every module from `providerModules`.
- **Reviewer fallback.** Only the three known reasons allow a fallback,
  whatever `fallbackReason` returns.
- **Git and working tree.** For every module from `providerModules` the core
  applies the checks of the Claude Code implementer, whatever the module
  declares: repository layout in preflight, process group and the process
  groups seen by the process watch killed when the CLI exits (best effort;
  `IMPLEMENTER_PROCESS_SURVIVED` when one survives or the process table is
  unreadable), Git directory fingerprint around every round and again after
  the gates and after the review, and the private index for the core's Git
  commands (see
  [architecture.md](architecture.md#claude-code-as-implementer)).
  `scratchDirectories` (repository paths of empty directories the CLI
  creates) are removed when empty and stop the run otherwise. Only the
  built-in `codex` module runs without these checks, as before.
- **Everything else** is unchanged and independent of the provider: the
  guards, the staged-changes checks, the secret scan, the gates, the
  snapshot, the analysis sentinel and artifact checks, the round limit and
  the report.

A module is code that runs inside the runner process with the user's
permissions; the core cannot sandbox the module itself. Review a module like
the core.

### Forbidden arguments

`forbiddenArgument(program, args, { role })` in the contract is a list of
known patterns, not a parser of any CLI. It applies:

- to every program: flags whose name contains `dangerous`, `bypass`, `yolo`,
  `skip-permission(s)`, `no-sandbox`, `unsandboxed`, `full-auto`,
  `auto-approve`, `always-approve`, `yes-always`, `trust-all` or
  `allow-all`; any argument containing `bypassPermissions`,
  `danger-full-access`, `dangerously`, `"allowUnsandboxedCommands": true` or
  `network_access=true`; the value `yolo` (also as `--flag=yolo`);
- to `codex`: `--dangerously-bypass-approvals-and-sandbox`, `--full-auto`,
  `--yolo`, `--add-dir`, `--search`, `--profile`/`-p`; `-s`/`--sandbox`
  other than `read-only` or `workspace-write`; `-a`/`--ask-for-approval`
  other than `never`; `-c`/`--config` overrides, read by their key with
  quotes and whitespace removed, of `sandbox_mode`, `approval_policy`,
  `shell_environment_policy`, `mcp_servers`, `notify`, `profile` and
  `profiles` (also their sub-keys), and of the `sandbox_workspace_write`
  table except `sandbox_workspace_write.network_access=false` (so an inline
  table such as `sandbox_workspace_write={writable_roots=[…]}` is refused),
  and of `allow_login_shell` other than `false`.
  Short options with a rule are also read with an attached value (`-aX`,
  `-sX`, `-cX`, `-pX`, `-a=X`);
- to `claude`: `--dangerously-skip-permissions`,
  `--allow-dangerously-skip-permissions`, `--add-dir`, `--allowedTools`,
  `--allowed-tools`, `--mcp-config`, `--plugin-dir`, `--setting-sources`;
  `--permission-mode` other than `dontAsk` or `acceptEdits`; `--settings`
  that is not inline JSON (a settings file cannot be inspected), or whose
  parsed JSON (so keys written with `\u` escapes are read as the CLI reads
  them) has `hooks`, `apiKeyHelper`, `statusLine`, `awsAuthRefresh`,
  `awsCredentialExport`, `otelHeadersHelper`, `env`, `permissions`,
  `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `enabledPlugins`
  or `extraKnownMarketplaces`, or a `sandbox` that is not an object, has
  `enabled` other than `true`, `allowUnsandboxedCommands` other than
  `false`, `excludedCommands`, a `network` that is not an object, a
  non-empty `network.allowedDomains`, or any of `network.allowUnixSockets`,
  `allowAllUnixSockets`, `allowLocalBinding`, `httpProxyPort`,
  `socksProxyPort`; for the reviewer role, an argv without `--tools`
  (rule `missing`: the CLI would give its default tools), and `--tools`
  with any tool other than `Read`, `Glob`, `Grep` or `LS` (all values of
  the option; a lone `-` is a value, not the end of the list); for the
  implementer role, an argv without `--settings` (rule `missing`) and a
  `--settings` whose parsed JSON has no `sandbox`, or a `sandbox` without
  `enabled: true` and `failIfUnavailable: true` (every `--settings` is
  checked; without them the CLI runs commands unsandboxed);
- to programs named `gemini` and `aider`: their known flags for skipping
  approvals (`-y`, `--yolo`, `--approval-mode` other than `default`;
  `--yes-always`). These entries only block flags; they are not support for
  those CLIs.

Known gaps, among others: the list cannot tell what a settings or profile
file named in the argv contains (except that `claude --settings` must be
inline JSON and `codex` profiles are refused); for a `claude` implementer
the list requires a sandbox in `--settings` (`enabled: true`,
`failIfUnavailable: true`) but cannot tell whether the CLI version honours
it or what the sandbox lets a command write (the core checks the Git
directory after every round). A CLI not on the list is checked by the
general rules only.
These are left to review of the module.

## Implementer requirements

One list applies to every provider that serves the implementer role,
built-in or from `providerModules`:

1. **Role rules (declaration).** `noApprovalPrompts`, `sandboxByMode`,
   `noCommandNetwork`, `noUserConfiguration`, `pathGuards`,
   `isolatedEnvironment` and `explicitResume` declared `enforced`, and a
   `preflight` function (see [Role rules](#role-rules)). The core reads
   the declaration only; whether the CLI keeps it rests on review of the
   module against the real CLI.
2. **Core checks for every module.** The argv copy and the
   forbidden-argument scan, the exact environment with the guards first on
   `PATH`, the model, effort and mode checks, the preflight result, schema
   validation of the output, `isValidSessionId` for read and resumed
   session IDs, and every check listed under "Everything else" in
   [Core checks](#core-checks).
3. **Conformance.** The suite passes without failures, with fixtures from
   the real CLI, including at least one host the preflight refuses.

The built-in modules differ from this list in the following points, which
are visible in the code:

| Point | `codex` | `claude` | Module from `providerModules` |
| --- | --- | --- | --- |
| Git directory fingerprint, process group kill, private index, scratch directories | not applied (`gitDirectoryWritable` not declared; built-in modules are exempt from the forced checks) | applied (`gitDirectoryWritable: true`) | always applied |
| Preflight | any Codex CLI version on macOS or Linux | any Claude Code version on macOS or Linux, in both roles | must refuse at least one fixture host |
| A resumed round must report the same session ID | not checked | checked (`resumeKeepsSessionId`) | always checked |
| Session ID in the argv | exempt from the forbidden-argument scan | exempt from the forbidden-argument scan | scanned like any other argument |

## Built-in and example declarations

| Guarantee | `codex` implementer | `claude` implementer (experimental) | `claude` reviewer | `example-agent` (template) |
| --- | --- | --- | --- | --- |
| `noApprovalPrompts` | enforced: `-a never` | enforced: `--permission-mode dontAsk`/`acceptEdits`, `--permission-prompts none` | enforced: `--permission-mode dontAsk` | enforced: `--non-interactive` (both roles) |
| `sandboxByMode` | enforced: `-s workspace-write` / `-s read-only` | enforced: read-only tools in analysis; `--restricted` file tools and Bash only in the CLI sandbox | not-supported (no command tool; read-only copy) | implementer enforced: `--sandbox workspace`/`read-only`; reviewer not-supported |
| `noCommandNetwork` | enforced: `sandbox_workspace_write.network_access=false` | enforced: sandbox network allowlist empty, `--disallowedTools WebFetch,WebSearch` | not-supported (no command or web tool) | implementer enforced: `--network none`; reviewer not-supported |
| `noUserConfiguration` | enforced: `--ignore-user-config --strict-config` | enforced: `--safe-mode`, `--restricted`, `--strict-mcp-config`, `--disable-slash-commands` | enforced: `--safe-mode`, `--restricted`, `--strict-mcp-config`, `--disable-slash-commands` | enforced: `--no-user-config` |
| `pathGuards` | enforced: guard directory before the runner's `PATH`, after the CLI's own directories (no guarded command there), commands in a non-login shell (`-c allow_login_shell=false`), the core's empty private `ZDOTDIR` instead of the user's `.zshenv`; limitation: a `PATH` change in `/etc/zshenv` comes first | enforced: guard directory first on `PATH`; the same empty `ZDOTDIR` | not-supported (no command tool) | implementer enforced; reviewer not-supported |
| `isolatedEnvironment` | enforced: core's isolated environment | enforced: same | enforced: core's allowlisted environment | enforced |
| `schemaOutput` | enforced: `--output-schema`, `-o` | enforced: `--json-schema` | enforced: `--json-schema` | enforced: `--output-schema` / `--output-schema-json` |
| `explicitResume` | enforced: `exec resume <id>` | enforced: `--resume <id>`, same ID reported | not-supported (`--no-session-persistence`) | implementer enforced: `--resume <id>`; reviewer not-supported |
| `readOnlyTools` | not-supported (writes) | not-supported (writes) | enforced: `--tools Read,Glob,Grep` | implementer not-supported; reviewer enforced: `--read-only` |

The exact texts, `stability` and `limitations` are in the modules. The
`example-agent` column describes a fictional CLI.

## Conformance suite

[scripts/providers/conformance.mjs](../scripts/providers/conformance.mjs)
checks any module without starting a CLI or calling a model:

```js
import { checkProviderConformance } from '../scripts/providers/conformance.mjs';
import provider, { conformanceFixtures } from './providers/my-provider.mjs';

const result = checkProviderConformance(provider, conformanceFixtures);
assert.deepEqual(result.failures, []);
```

`assertProviderConformance` throws instead. The fixtures describe the
CLI's output format, which only the module author knows (see the example):
`model`; `implementer.stdout(report, sessionId)`,
`implementer.withoutSession`, `implementer.malformed`;
`reviewer.envelope(review)`, `reviewer.malformed`; `preflight.accepted` and
`preflight.refused` hosts of the implementer, and `reviewer.preflight` with
the same fields for a reviewer that has a preflight.

The suite checks:

- the contract and the role rules (the same validation as the core);
- the declaration, as far as the argv shows it: every guarantee present,
  the role's requirements enforced, `schemaOutput` matched by a schema in
  the argv, and an output file in the argv when there is no `output()`.
  `sandboxByMode`, `noCommandNetwork`, `noApprovalPrompts`,
  `noUserConfiguration` and `readOnlyTools` cannot be checked without the
  real CLI; only the forbidden-argument list and the different argv per
  mode touch them;
- the argv for every role, mode, effort and (implementer) resume: a plain
  array of strings (the same copy as the core makes), the same on every
  call, no forbidden argument (the session ID included), model and effort
  passed, the session ID passed only when resuming and never to the
  reviewer, different argv for `implementation` and `analysis`;
- the environment: exactly the core's;
- the parsers: the report and the session ID of a valid round, no session
  ID from empty, non-JSON or session-less output, no result from malformed
  output; the review from a valid envelope, no review from malformed ones;
  no fallback for empty or unspecific output, nor for authentication,
  permission, API key or policy errors;
- the preflight: only `undefined` or a known reason, and the fixture hosts.
  `preflight.refused` must list at least one host, and every refused host
  needs a `reason` from `PREFLIGHT_REASONS` (`UNSUPPORTED_VERSION`,
  `UNSUPPORTED_PLATFORM`); an empty list or a host without such a reason
  is a failure (`implementer.fixtures`), so a preflight that accepts every
  host (`preflight: () => undefined`) does not pass. A reviewer's preflight,
  when the module has one, is checked the same way against
  `reviewer.preflight` (`reviewer.fixtures`, `reviewer.preflight`).

The runner's tests run the suite for `codex`, `claude` and the example
provider, and check that it catches bad modules (forbidden flags such as
`--dangerously-skip-permissions`, an argv with a getter or as a proxy, a
parser that accepts a malformed envelope, a resume without the session ID,
an environment without the guards, and others). Passing the suite does not
show that the CLI keeps the declared sandbox, network or approval
behaviour.

## Stability

`stability` is declared per role. The same criteria apply to every module,
built-in or not. A role is `stable` when it meets all of them:

1. **Role rules.** The role rules of the role are met.
2. **Conformance.** The suite reports no failure for the module.
3. **Declarations checked.** Every guarantee declared `enforced` was checked
   by a probe of the real CLI, and the probe is described (CLI version,
   what was tried, what the CLI did).
4. **No breaking limitation.** No known limitation breaks a guarantee the
   role depends on.
5. **Preflight.** The preflight refuses CLI versions and platforms where
   the declarations were not checked.

Otherwise the role is `experimental`.

Built-in modules against these criteria (✓ met, ✗ not met, partly: met
with the gaps named in the cell, open: not checked yet):

| Criterion | `codex` implementer | `claude` implementer | `claude` reviewer |
| --- | --- | --- | --- |
| 1. Role rules | ✓ | ✓ | ✓ |
| 2. Conformance | ✓ | ✓ | ✓ |
| 3. Declarations checked | ✗ [probes of 0.160.0](providers/probes/codex-implementer.md) on macOS: five of eight checked (`noApprovalPrompts`, `sandboxByMode`, `noCommandNetwork`, `schemaOutput`, `explicitResume`); `pathGuards` partly (an executable guard was reached in every kind of round with a substituted `ZDOTDIR` whose `.zshenv` leaves `PATH` alone; with a `.zshenv` that prepends directories to `PATH` the real `git` ran, with the core's empty `ZDOTDIR` the guard; `/etc/zshenv` not probed); `isolatedEnvironment` partly (what `/etc/zshenv` exports still reaches commands); `noUserConfiguration` not checked (no login in a substituted `CODEX_HOME`); Linux not probed | partly: [probes of 2.1.285](providers/probes/claude-implementer.md) on macOS: four of eight checked (`noApprovalPrompts`, `pathGuards`, `schemaOutput`, `explicitResume`); the other four partly, mostly because the result envelope carries no tool output and the evidence is the model's report (`sandboxByMode` for analysis, `noCommandNetwork`, `isolatedEnvironment`), and for `noUserConfiguration` because the user configuration directory, project settings files, hooks and MCP servers are not checked; Linux not probed | partly: [probes of 2.1.285 and 2.1.311](providers/probes/claude-reviewer.md) on macOS: `noApprovalPrompts` and `schemaOutput` checked; `readOnlyTools` partly (the model's report and absent canaries); `noUserConfiguration` partly (settings files, hooks and MCP servers of the reviewed copy checked with canaries, its `CLAUDE.md` by the model's report, the user configuration directory not checked); `isolatedEnvironment` partly (the copy's settings files are not read, the session's environment is not observable); Linux not probed |
| 4. No breaking limitation | ✗ the Codex CLI help documents no setting that makes the CLI fail when its sandbox cannot start, and the runner does not check it (`sandboxByMode`); the non-login shell of commands still reads `/etc/zshenv` (the core's empty `ZDOTDIR` keeps the user's `.zshenv` out), so a `PATH` change there comes before the guard directory and the real command runs (`pathGuards`, shown with a `.zshenv`) and its exports reach commands (`isolatedEnvironment`); two directories of the CLI come before the guard directory (on 0.160.0 they hold no guarded command) | ✗ Bash can write in `.git` (detected after the round, not prevented); background processes can outlive the CLI | ✓ no limitation shown to break `readOnlyTools`; settings files and MCP servers of the reviewed copy are ignored (`--restricted`, `--strict-mcp-config`, probes of 2.1.311); the user's settings files are ignored too, so an `apiKeyHelper` or an `env` block there (`ANTHROPIC_BASE_URL`, proxy, Bedrock, Vertex) does not reach the reviewer; admin-managed (policy) settings apply by design |
| 5. Preflight | ✗ by choice: any CLI version is accepted, so versions other than the probed 0.160.0 run unchecked; the platform is limited to macOS or Linux, probed on macOS only, so Linux is accepted unchecked | ✗ by choice: any CLI version is accepted, so versions other than the probed 2.1.285 run unchecked, and in print mode the CLI ignores sandbox settings it does not accept without an error; the platform is limited to macOS or Linux, probed on macOS only | ✗ by choice: any CLI version is accepted, so versions other than the probed 2.1.285 and 2.1.311 run unchecked; the platform is limited to macOS or Linux, probed on macOS only |

The built-in preflights accept any CLI version on macOS and Linux, so
criterion 5 is not met for any built-in role, by choice. Probes of the real CLI for
criterion 3 run on macOS; until a probe on Linux is described, Linux counts
as not checked for criteria 3 and 5.

No built-in role meets every criterion, so all three are declared
`experimental`; the open items are listed in [ROADMAP.md](../ROADMAP.md).
`example-agent` is a template for a fictional CLI and stays `experimental`.

## Adding a provider

1. Copy [examples/providers/example-provider.mjs](../examples/providers/example-provider.mjs)
   and replace every flag with the real CLI's.
2. Check each declaration against the CLI's documentation and probes; use
   `not-supported` where the CLI cannot provide a guarantee. If the role
   rules then refuse the role, the CLI cannot serve it.
3. Write the conformance fixtures from real output of the CLI and run the
   suite in your tests.
4. Pass the module in the profile's `providerModules` and select it in
   `implementer` or `reviewer`.
5. Keep `stability: 'experimental'` until the role meets every
   [stability criterion](#stability).

A new built-in provider (one the core imports) is a change of the core and
needs the same review as any core change.
