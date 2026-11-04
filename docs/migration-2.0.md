# Migration from 1.x to 2.0

Ringi Gate 2.0 removes the provider-specific names that 1.x kept as aliases
of the neutral role names, renames the STOP codes that named a provider,
and raises `schemaVersion` (report, `--json`, stop reports, dry-run plan)
and `ledgerVersion` to 2. Nothing else in the contract changes: the gates, the sandbox, the round flow and which stops
are resumable are those of 1.x. The contract of 2.0 is in
[contract.md](contract.md).

## CLI options

| 1.x | 2.0 |
| --- | --- |
| `--codex-model` | `--implementer-model` |
| `--sol-effort` | `--implementer-effort` |

A removed option is an argument error (exit code `2`) whose message names
the new option.

## Library options of `runAgentReviewLoop` (outside the contract)

Listed for scripts that used them.

| 1.x | 2.0 |
| --- | --- |
| `codexModel` | `implementerModel` |
| `solEffort` | `implementerEffort` |

A removed option stops the run with `INVALID_CONFIGURATION` (stage
`preflight`) whose message names the new option.

## Profile

The profile had no provider-specific keys; an unknown key, including any
name of 1.x, stays `INVALID_CONFIGURATION`.

## Report (`report.json`, `--json`)

`schemaVersion` is `2` in the run report, the dry-run plan and both stop
reports of the CLI.

| 1.x | 2.0 |
| --- | --- |
| `sol` (`plannedModel`, `plannedEffort`, `effectiveModel`, `effectiveEffort`, `runs`) | `implementer` (`model`, `effort`, `effectiveModel`, `effectiveEffort`, `attemptCount`, `runs`) |
| `review` | `reviewer`: the same fields (`profile`, `attemptCount`, `effectiveModel`, `effectiveEffort`, `plannedAttempts`, `plannedAttemptCount`, `fallbackAllowed`, `fallbackUsed`, `fallbackReasons`, `runs`, and for a skipped review `status`, `reason`, `policy`, `remainingAssurance`) next to `provider`, `model`, `effort` |
| `rounds[].codex` | `rounds[].implementer.output` |
| `rounds[].solExecution` | `rounds[].implementer.execution` |
| `rounds[].claude` | `rounds[].reviewer.output` |
| `rounds[].reviewExecution` | `rounds[].reviewer.execution` (`null` with review lanes; each lane's execution stays in `rounds[].reviewLanes`) |
| `rounds[].implementer.outputField`, `executionField` (and the reviewer's) | removed; the role fields hold the values |
| `findings.rejectedByCodex` | `findings.rejectedByImplementer` |

`rounds[].implementer.output` and `execution` are `null` with
`--review-only`; `rounds[].reviewer.output` is `null` when no review ran; for a skipped
review `rounds[].reviewer.execution` is the record of the skipped review,
as `reviewExecution` was in 1.x.

## Dry-run plan (`agents`)

| 1.x | 2.0 |
| --- | --- |
| `agents.codex` | `agents.implementer.version` |
| `agents.codexModel`, `agents.codexReasoning` | `agents.implementer.model`, `agents.implementer.effort` |
| `agents.claude` | `agents.reviewer.version` |
| `agents.claudeReviewProfile`, `agents.claudeAttemptCount`, `agents.claudeFallbackAllowed`, `agents.claudeAttempts` | `agents.reviewer.profile`, `plannedAttemptCount`, `fallbackAllowed`, `plannedAttempts` |

## Presenter events (outside the contract)

| 1.x | 2.0 |
| --- | --- |
| `metadata`: `solModel`, `solEffort` | `implementer.model`, `implementer.effort` |
| `metadata`: `reviewProfile`, `reviewAttempts`, `reviewFallbackAllowed` | `reviewer.profile`, `reviewer.attempts`, `reviewer.fallbackAllowed` |
| `badge` `SOL`, `CLAUDE` | `badge` `IMPLEMENTER`, `REVIEWER` (with `actor` and `provider`) |
| `activity`: `role` `ASTRA`, `CLAUDE` | `actor` `implementer`, `reviewer` |

Hooks of `createPresenters` receive copies of the events, the report and
the dashboard state; changing them changes nothing. In 1.x a hook that
changed the report in `beforeFinish` changed the final summary and the
`--json` report; in 2.0 it changes only its copy, without an error.

## Ledger

`ledgerVersion` is `2`. `ringi verify` 2.0 refuses a ledger of
`ledgerVersion: 1` with `fail` and a message that names the version; verify
a 1.x run with ringi 1.x. The `stop` event carries the new codes.

## STOP codes

| 1.x | 2.0 | Resumable |
| --- | --- | --- |
| `CLAUDE_PROCESS_FAILED` | `REVIEWER_PROCESS_FAILED` | yes |
| `CLAUDE_FALLBACK_FAILED` | `REVIEWER_FALLBACK_FAILED` | yes |
| `CLAUDE_REVIEW_FAILED` | `REVIEW_FAILED` | no |
| `INVALID_CODEX_MODEL` | `INVALID_IMPLEMENTER_MODEL` | no |
| `INVALID_SOL_EFFORT` | `INVALID_IMPLEMENTER_EFFORT` | no |
| `INVALID_CODEX_ENVIRONMENT` | `INVALID_IMPLEMENTER_ENVIRONMENT` | no |

## Library exports (outside the contract)

Listed for scripts that used them. `CODEX_MODEL`, `DEFAULT_SOL_EFFORT`, `SOL_EFFORTS` and `CODEX_REASONING`
(lib), `CODEX_MODEL`, `DEFAULT_SOL_EFFORT`, `SOL_EFFORTS` and
`CLAUDE_EFFORTS` (`agent-review-providers.mjs`) and `SOL_EFFORT_USAGE`
(dashboard) are removed. Use `DEFAULT_IMPLEMENTER.model`, `.effort` and
`.allowedEfforts` of `agent-review-providers.mjs`, and
`IMPLEMENTER_EFFORT_USAGE`.

Module-level names of the built-in providers (`SOL_EFFORTS` in
`scripts/providers/codex.mjs`, `CLAUDE_EFFORTS` in
`scripts/providers/claude.mjs`) and the other exports of `scripts/` stay
outside the contract.

## Scripts that read the report

- Check `schemaVersion === 2` before reading.
- Read the roles from `implementer` and `reviewer`, the round outputs from
  `rounds[].implementer.output` and `rounds[].reviewer.output`.
- Match the new STOP codes, for example in a CI step that retries
  `REVIEWER_PROCESS_FAILED`.
