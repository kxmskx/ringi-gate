# Good first issues

Small, self-contained tasks for a first contribution. Each one is an open
issue in [kxmskx/ringi-gate](https://github.com/kxmskx/ringi-gate/issues) and
was checked against the code when this list was written. Line numbers drift,
so search for the function or test name instead. Comment on the issue before
you start, so two people don't pick the same one. Items marked **Taken** are
already assigned. General rules are in [CONTRIBUTING.md](../CONTRIBUTING.md).

Items marked **Needs a decision before code** need a quick agreement in the
issue first.

## Count re-exports in the prompts "no imports" test

Issue: [#1](https://github.com/kxmskx/ringi-gate/issues/1). **Taken.**

The prompts module is supposed to have no imports. Its surface test, `runner surface contract: prompts named exports and no imports` in `scripts/agent-review-loop.test.mjs`, walks the syntax tree with its own `visit` function and counts `import` declarations and dynamic `import()`. It misses re-exports like `export { x } from './y.mjs'` or `export * from './y.mjs'`, which load a module too.

The providers test already catches them: `moduleImportSpecifiers` in the same file also collects export declarations that have a module specifier. Use it in the prompts test as well (the expected list is empty) instead of a second visitor. `npm test` should pass.

## Reject U+1E9E in docs candidate paths

Issue: [#2](https://github.com/kxmskx/ringi-gate/issues/2).

Docs-only changes reject paths with a non-ASCII character whose case mapping contains an ASCII letter, since a case-insensitive file system could fold it into an excluded name ([profile.md](profile.md#docscandidatepolicy)).

`hasAsciiFoldingCharacter` checks `toUpperCase()` and `toLowerCase()` of each character, and U+1E9E (capital sharp s) gets through: it lowercases to U+00DF, which has no ASCII letter, but `'ß'.toUpperCase()` is `SS`.

Fix: also check `toLowerCase().toUpperCase()` (and `toUpperCase().toLowerCase()` if it helps). Add a test where a docs candidate path with U+1E9E is rejected with `DOCS_CANDIDATE_REJECTED`, and one showing that ordinary non-ASCII names, such as Polish file names, still pass. Update the examples in `docs/profile.md` if they change.

Files: `scripts/agent-review-loop-lib.mjs`, `scripts/agent-review-loop.test.mjs`.

## Align the CLI fallback report with the documentation (decision first)

Issue: [#3](https://github.com/kxmskx/ringi-gate/issues/3).

**Needs a decision before code.**

If an error that isn't an `AgentWorkflowError` reaches the CLI, the `catch` block in `scripts/agent-review-loop.mjs` writes its own report (`status: 'STOPPED'`, `code: 'UNEXPECTED_ERROR'`) with no `publicationApproved` field and exits with code `2`. `ringi run` does the same in `runCommand` in `scripts/ringi-cli.mjs`, and its report for a stop before the run (`stopBeforeRun`) has no `publicationApproved` field either.

That doesn't match the docs. The README says run reports carry `publicationApproved: false`, and [architecture.md](architecture.md#report) gives exit code `1` for any stopped run (`UNEXPECTED_ERROR` included) and `2` for errors outside the runner. This fallback is a bit of both. Errors inside the runner are fine: the core already turns them into `UNEXPECTED_ERROR` reports with `publicationApproved: false`.

The test `schemaVersion: CLI fallback preserves JSON and exit codes` pins the current shape and exit code on purpose, so it has to change together with whichever side gets fixed.

Agree on one option in the issue first: either the fallback report gains `publicationApproved: false` (and the pinned test follows), or the docs describe this report and its exit code as they are. Files: `scripts/agent-review-loop.mjs`, `scripts/ringi-cli.mjs`, `docs/architecture.md`, `docs/cli.md`, `README.md`, `scripts/agent-review-loop.test.mjs`, `scripts/ringi-cli.test.mjs`.

## Safe error message for an invalid review profile name

Issue: [#4](https://github.com/kxmskx/ringi-gate/issues/4).

`resolveReviewProfile` puts `JSON.stringify(profile)` into its error message. For a `BigInt` or a cyclic object that call throws a `TypeError` first, so instead of `INVALID_REVIEW_PROFILE` you get `UNEXPECTED_ERROR`.

The CLI only passes strings, but the `reviewProfile` option of `runAgentReviewLoop` accepts anything, and [profile.md](profile.md#reviewer) promises `INVALID_REVIEW_PROFILE` for any non-string.

Describe non-string values safely (their type is enough) and add tests for a `BigInt` and a cyclic object that expect `INVALID_REVIEW_PROFILE` at stage `preflight`. Files: `scripts/agent-review-loop-lib.mjs`, `scripts/agent-review-loop.test.mjs`.

## Headings inside fenced code blocks in task files (decision first)

Issue: [#6](https://github.com/kxmskx/ringi-gate/issues/6).

**Needs a decision before code.**

The task parser finds sections with a regex over the whole file, so `## Scope` inside a fenced code block (backticks or tildes) starts a new section. The analysis artifact check already skips fenced code (`markdownHeadings` in the core), which is a good model.

Two options: skip fenced blocks, or reject tasks whose fences contain known section headings. Pick one in the issue first. After that: update `parseMarkdownSections` in `scripts/agent-review-loop-lib.mjs`, cover backtick and tilde fences in tests, and describe the rule in the [Task file](architecture.md#task-file) section. Both `npm test` and `node --test examples/validate-examples.test.mjs` should pass.
