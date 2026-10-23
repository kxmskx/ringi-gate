# Contributing

Thank you for your interest in Ringi Gate. The project is at an
early stage, so small, careful contributions help the most: a sharper test,
a clearer sentence in the docs, a check that stops one more unexpected
state. If you are looking for a place to start, see
[docs/good-first-issues.md](docs/good-first-issues.md).

Ringi Gate is licensed under the Apache License 2.0 ([LICENSE](LICENSE)).
By contributing, you agree that your contributions are licensed under
Apache-2.0. Please open an issue before you start work on a larger pull
request.

## Quick start

You need Node.js 24 or newer, Git 2.45 or newer, and Corepack with pnpm 11.20.0 in its
local cache (some tests run the real pnpm offline from that cache).

```sh
git clone <repository URL>
cd ringi-core
npm install
corepack install -g --cache-only pnpm@11.20.0   # once, if pnpm 11.20.0 is not cached yet
npm test
node --test examples/validate-examples.test.mjs
```

`npm install` only installs `typescript`, which the tests use to parse the
runner source. The tests never start the Codex or Claude CLIs (agent rounds
are replaced with test doubles), run pnpm offline, and create temporary Git
repositories in the system temporary directory. They do not need the Git
history of this repository. More in [docs/testing.md](docs/testing.md).

Write test names, assertion messages and comments in English. Name a test
after the behavior it checks, without stage identifiers, review finding
codes or commit hashes; Polish text belongs only in test data (Polish task
files, expected `pl` messages and markers, `pl` prompts). See
[docs/testing.md](docs/testing.md#test-names-messages-and-comments).

### Golden snapshots

The `[golden]` compatibility tests compare runner output with snapshots in
`scripts/fixtures/golden/` (a readable header and SHA-256 digests of large
subtrees). `npm test` never writes them, and a missing snapshot fails. If
your change alters runner behavior on purpose, update the snapshots by hand
with `node scripts/fixtures/update-golden.mjs [snapshot-name ...]`, check
`git diff scripts/fixtures/golden/`, and explain the change in the pull
request: a changed snapshot is a changed behavior and is reviewed as one.
See [docs/testing.md](docs/testing.md#golden-snapshots).

## Repository map

| Path | What is there |
| --- | --- |
| `scripts/agent-review-loop.mjs` | CLI entry point: arguments, profile import, exit code. |
| `scripts/agent-review-loop-lib.mjs` | Runner core: task parsing, profile validation, guards, gates, snapshots, agent calls, report. |
| `scripts/agent-review-providers.mjs` | Default role values and the built-in providers in their earlier adapter shape. Imports only `scripts/providers/`. |
| `scripts/providers/` | Provider contract, the built-in `codex` and `claude` modules, and the conformance suite. |
| `scripts/agent-review-prompts.mjs` | Prompt texts for the implementer and the reviewer. No imports. |
| `scripts/agent-review-dashboard.mjs` | Argument parser and terminal presentation. |
| `scripts/agent-review-profile.mjs` | The default project profile (the binding point the CLI imports). |
| `bin/ringi.mjs`, `scripts/ringi-*.mjs` | The `ringi` command (`init`, `doctor`, `run`); see [docs/cli.md](docs/cli.md). |
| `scripts/agent-review-loop.test.mjs` | The core test suite (`npm test`); it also imports `scripts/ringi-cli.test.mjs`, the tests of the `ringi` command, and `scripts/ringi-package.test.mjs`, the tests of the npm package and the workflows. |
| `examples/` | A synthetic profile and task, and the test that checks them against the core. |
| `docs/` | Architecture, profile reference, testing. `docs/development/` holds the task quality policy document that the default profile's task classes point to. |
| `assets/` | The mark and the terminal demo image. |
| `.github/` | Issue and pull request templates; the `test` and `release` workflows (see [Continuous integration](#continuous-integration)). |

## Principles

- **One writer.** One person or agent changes a given area at a time. Do not
  open parallel pull requests that touch the same files.
- **Small changes.** One topic per pull request, with a clear goal and scope.
  Split large changes.
- **Fail-closed.** When something is unexpected, the runner stops with a
  stable code. See the rules below.
- **Claims match code.** The README and `docs/` describe only what is
  implemented. Plans go to [ROADMAP.md](ROADMAP.md).
- **No real data.** Use synthetic names, paths and values in tests, examples
  and documentation. Never commit secrets.

### Fail-closed rules for changes

- Validate every new input (profile field, option, task section) and reject
  anything unknown or malformed instead of ignoring it. An invalid profile
  is always `INVALID_CONFIGURATION`.
- A new failure gets a stable, upper-case code and a stage, raised as an
  `AgentWorkflowError`. Core codes never end in `_GATE`; that suffix belongs
  to the profile's `requiredGateRules`.
- No silent fallbacks, automatic repairs, retries that hide a failure, or
  reverts of the implementer's changes. Stop, and leave the state for a human.
- Do not widen what agents, tasks or gates may do (allowlists, guards, path
  rules, environment variables) without an explicit reason in the pull
  request and a test that shows the new boundary.
- Presentation (dashboard, presenters) must never change the report or the
  exit code.
- Some tests pin the runner's surface: CLI options, exported names, stop
  codes and selected literals. If one of them fails, the change is visible
  on purpose; update the contract only when the change is intended, and say
  so in the pull request.

## Adding a test

Core tests live in `scripts/agent-review-loop.test.mjs` and use
`node:test` with `node:assert/strict`. The file already has helpers for
the common cases, for example:

- `taskMarkdown`: a valid synthetic task (Polish section names);
- `validateTaskMarkdown(markdown, taskMode, profile)`: the task parser,
  with the synthetic `TEST_PROFILE` by default;
- `createRepository()`: a temporary Git repository on a working branch;
- `createMockRunner()` and `fakePrepareCheckEnvironment`: run the loop
  without real agents or a real Corepack cache.

A minimal test looks like this:

```js
test('a requested check missing from the profile stops the run', () => {
  const markdown = taskMarkdown.replace('- `pnpm check`', '- `pnpm deploy:prod`');
  assert.throws(() => validateTaskMarkdown(markdown, 'implementation'), {
    code: 'UNSUPPORTED_CHECK',
  });
});
```

Guidelines:

- Assert the stop code (and the stage, where it matters), not only that
  something failed.
- A behaviour change comes with a test that fails without it.
- Keep tests deterministic and offline. Create temporary directories with
  `mkdtemp(join(tmpdir(), ...))` and remove them in `finally`.
- Do not loosen a fail-closed check to make a test pass.

Changes to `examples/` are checked by
`examples/validate-examples.test.mjs`; add a case there when you extend the
example profile or task.

## Adding a provider

Support for another agent CLI is a provider module: code with a security
declaration and tests, never a command line in the profile. See
[docs/providers.md](docs/providers.md) for the contract, the role rules and
the conformance suite, and start from the template
[examples/providers/example-provider.mjs](examples/providers/example-provider.mjs).
Declare `not-supported` for any guarantee you cannot show for the CLI.

## Commit style

- Write the subject as one line in sentence case that says what changed,
  without a type prefix.
- In the body, explain what changed and why, how compatibility was shown,
  and which checks ran locally, with their results.
- Keep one topic per commit, in English or Polish.

## Proposing an idea

1. Check [ROADMAP.md](ROADMAP.md) and the open issues: it may already be
   planned or discussed.
2. Open an issue with the **Proposal** template. Describe the problem first,
   then the change, and what the runner should do when the new input or
   state is unexpected.
3. For questions, use the **Question** template; for a behaviour that does
   not match the docs or tests, the **Bug report** template.
4. Never put vulnerability details in a public issue; see
   [SECURITY.md](SECURITY.md).

## Pull requests

1. Create a branch and make the change.
2. Add or update tests, and run `npm test` and
   `node --test examples/validate-examples.test.mjs`.
3. Open a pull request using the template and fill in its checklist.

### Continuous integration

`.github/workflows/test.yml` runs on every pull request and on pushes to
`main`, on `ubuntu-latest` and `macos-latest` with Node.js 24. It checks out
the repository, sets up Node.js, puts pnpm 11.20.0 into the Corepack cache
(`corepack enable pnpm` and `corepack install -g --cache-only
pnpm@11.20.0`, the only step that downloads pnpm), then runs `npm ci`,
`npm test` and `node --test examples/validate-examples.test.mjs`. The
workflow has a read-only token (`permissions: contents: read`), uses no
secrets and pins each action to a commit SHA. It does not run the Codex or
Claude CLIs. The workflow has not run yet: Linux is covered only once it
runs in the public repository.

`.github/workflows/release.yml` publishes the package to npm. It starts
only on a `v*` tag or by hand, runs in the `release` environment (whose
required reviewers approve each run), repeats `npm ci` and `npm test`,
checks that the tag is `v` plus the `version` in `package.json` and that
`private` is `false`, checks that npm is 11.5.1 or newer, and runs
`npm publish --provenance --access public` with npm trusted publishing
(`id-token: write`) and no npm token. It publishes the versions after
0.1.0; version 0.1.0 is published by hand, without provenance. While `package.json` has
`"private": true`, the check stops the workflow before `npm publish`.

Please also read the [code of conduct](CODE_OF_CONDUCT.md).

## Style

Match the surrounding code: plain Node.js ES modules, only `node:` built-in
modules at runtime, no new dependencies without discussion.
