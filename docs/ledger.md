# Run ledger

Every run that reaches its run directory writes an evidence ledger next to
its report: `.agent-review-loop/runs/<runId>/ledger.jsonl`. A dry run and a
run that stops before the run directory exists have no ledger. The ledger
records the evidence of each phase as it happens; `ringi verify <runId>`
checks it (see [cli.md](cli.md#ringi-verify)).

The ledger documents a run. No decision of the runner depends on its
content: the gates and the review decide, and a resumed run only refuses a
checkpoint whose ledger does not verify. See [What the ledger proves](#what-the-ledger-proves).

## Format (`ledgerVersion` 1)

One JSON object per line (JSON Lines, UTF-8, each line ends with `\n`),
with exactly these keys in this order:

| Key | Value |
| --- | --- |
| `ledgerVersion` | `1` |
| `seq` | the event number, from 1, without gaps |
| `ts` | the time of the event, ISO 8601 (UTC) |
| `type` | the event type (below) |
| `data` | an object, the evidence of the event (below) |
| `prev` | the SHA-256 (hex) of the previous line, without its `\n`; `null` in the first line, or for a resumed run the last line of the ledger it continues |
| `mac` | the HMAC (SHA-256, hex) of the line without `mac`, made with the checkpoint key; `null` in a ledger written without the key |

The text a `mac` signs is `JSON.stringify` of the object with the first six
keys; the line is the same object with `mac` added as the last key. A line
must be exactly that serialization (no extra whitespace). `report.ledger.headHash`
is the SHA-256 of the last line.

The ledger is append-only: the runner opens the file for appending, without
following a symbolic link, writes one line per event and syncs it to disk
(`fsync`) before the run goes on. The first event creates the file and fails
if it exists. Every later event is written only to that same file (the same
device and inode) with a single link, so a ledger replaced or hard-linked
during the run stops it.

## Events

The data holds only evidence the report already contains, or hashes of it.
Strings are redacted like the report. The ledger never holds a prompt, the
content of the diff or of any file, an agent's output, environment variables
or paths outside the repository.

| Type | When | `data` |
| --- | --- | --- |
| `preflight` | first event, when the run directory is created | `runId`, `mac` (`"hmac-sha256"` or `null`), `macUnavailable` (only without a key: `no-key`, `key-unsafe` or `no-state-directory`), `taskMode`, `runMode` (only `review-only`), `branch`, `head`, `task` (`path`, `sha256`, `mode`) |
| `fingerprints` | after `preflight` | `runner` (`report.runner.sha256`), `projectProfile` (`report.projectProfile.sha256` or `null`) |
| `resume` | a resumed run, after `fingerprints` | `resumedFrom`, `phase` and `round` of the checkpoint, `previousLedger` (`path`, `events`, `headHash` of the ledger it continues) |
| `routing` | with [`routing`](profile.md#routing) in the implementation mode: after `fingerprints` (and `resume`), and after each writer round that escalated to a stricter rule | `round` (`null` in the preflight), then `report.routing`: `class`, `rule`, `escalatedBy`, `applied`, `overriddenBy`, `reason`, `checkpointDifferences` (resumed runs only) |
| `writer-round` | after the writer's round passed its checks | `round`, `status`, `changes` and `findingResponses` (counts) |
| `gate` | after each gate | `round`, `index`, `name`, `passed` |
| `integrity` | analysis mode, before and after the review | `round`, `checks` (`name`, `status`) |
| `snapshot` | after the reviewer's snapshot | `round` and the round's `snapshot` field of the report (counts and hashes) |
| `review-attempt` | after the review, per attempt | `round`, `lane` (with [review lanes](profile.md#reviewlanes) only), `attempt`, `model`, `effort`, `status` |
| `review-lane` | with review lanes, after each lane's attempts | the lane's entry of `report.reviewer.lanes`: `round`, `id`, `provider`, `profile`, `model`, `effort`, `status`, `findingCount`, `durationMs`, `contextBytes`, `diffFiles` (see [profile.md](profile.md#context-packages-paths)) |
| `findings` | after the review | `round`, `verdict`, `findings` (`findingId`, `severity`), `unresolved` (finding ids) |
| `checkpoint` | after each checkpoint (`--checkpoint`, `--resume`) | `path`, `phase`, `round` |
| `stop` | a stopped run | `code`, `stage`, `lane` (only when a review lane stopped the run), `resumable` (only with checkpoints), `integrityViolations` (count) |
| `result` | last event | `status`, `rounds`, `publicationApproved` (`false`) |

After `CLEANUP_FAILED` at the end of an approved run, a `stop` and a new
`result` follow the approved result.

The `review-lane` event is new while `ledgerVersion` stays the same: a
`ringi verify` older than review lanes rejects a ledger that has it. The
same holds for the `routing` event and a `ringi verify` older than routing.

## Key and `mac`

The key is the checkpoint key of [checkpoints](cli.md#checkpoints-and-resume)
in the user's state directory. A run with `--checkpoint` or `--resume` uses
it (and the first such run creates it). Any other run only reads an existing
key, with the same checks (directory `0700`, file `0600` of the current user,
32 bytes, no symbolic link); it never creates the key or writes anything
outside the repository. Without a usable key the ledger has no `mac`, and
its `preflight` event says why (`macUnavailable`).

## Report

The report (`APPROVE` and `STOPPED`) has
`ledger: { path, events, headHash }`: the ledger's path relative to the
repository root, its number of events and the SHA-256 of its last line. The
field is additive; `schemaVersion` stays 1.

An event that cannot be written stops the run with `INTEGRITY_CHECK_FAILED`
(not resumable), like a checkpoint that cannot be written. When the `stop`
or `result` of a stopped run cannot be written, the stop code stays and the
report's `warnings` say that the ledger is incomplete; `report.ledger` then
counts the events written.

## Resume

A resumed run (`--resume <runId>`) verifies the ledger of the run it
resumes before any agent starts: every line with the key, its `preflight`
names that run, and its last `checkpoint` event names the checkpoint's phase
and round. A missing ledger
or one that does not verify refuses the checkpoint with
`INTEGRITY_CHECK_FAILED`. The new ledger continues the chain: its first
`prev` is the head of that ledger, and its `resume` event names it. Nothing
else is taken from the ledger; the gates and the review run again.

## What the ledger proves

- The hash chain detects a changed, removed, reordered or cut line, as long as
  the report (`report.ledger`) is not changed with it.
- A valid `mac` on every line shows that the ledger was not changed by
  someone without the key.
- The key is readable by code that runs as the user, including the writer and
  the gates, so a `mac` does not prove that the ledger is authentic: code
  with the key can write a ledger that verifies.
- The run directory is in the repository, where the writer can change or
  delete it. A deleted ledger is detectable as a missing one. A ledger
  rewritten without `mac` together with its report is not detectable without
  the key: anyone can compute a valid hash chain, so a ledger without `mac`
  does not protect even against someone without the key. With the key
  present, `ringi verify` reports such a ledger as `unverified` (exit code
  `1`), because a ledger written without the key and one whose macs were
  removed look the same.

The ledger is therefore never a source of trusted state for the runner. See
[SECURITY.md](../SECURITY.md).
