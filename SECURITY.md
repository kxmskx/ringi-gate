# Security policy (draft)

Ringi Gate is at an early stage and has no released versions. This policy is
a draft and will change before any public release.

## Reporting a vulnerability

Do not put exploit details in a public issue, pull request or discussion.

Use the private vulnerability reporting of the repository host if it is
enabled for this repository. If it is not, open an issue that only asks for a
private contact channel, without technical details.

Please include the affected commit, the steps to reproduce and the impact you
expect. There is no response time commitment yet.

## Scope

In scope: the runner in `scripts/`, in particular anything that lets an agent
or a task

- get a mutating Git, pnpm or other package manager command past the guards;
- make the runner execute a command that is not a validated profile check;
- change the working tree, Git state, dependencies or the review snapshot
  without the run stopping, beyond the limitations listed under "What the
  runner does not guarantee";
- make the runner report `APPROVE` while findings, failed gates or integrity
  violations exist;
- leak secrets into reports, logs or the review snapshot.

Out of scope: vulnerabilities in the Codex CLI, the Claude Code CLI, Git,
pnpm, Corepack or Node.js themselves, and in the projects the runner is used
on.

## What the runner enforces

- Gate commands come only from the validated project profile; task text is
  never executed as a shell command, and processes are started without a
  shell.
- During the implementer round, the `git` guard passes only an allowlist of
  read-only subcommand names (options are not filtered), `pnpm` only the
  task's declared checks, and other package managers only `--version`/`-v`.
- After the implementer round and after the gates, the runner checks branch, HEAD,
  staged changes, dependency inputs, installed dependency metadata and
  secret-like content in tracked and untracked, non-ignored files. After
  every gate it also checks that the checked files did not change: tracked
  and untracked, non-ignored files, excluding any path with a segment
  `node_modules`, `.pnpm-store`, `.next`, `dist`, `coverage`, `.turbo`,
  `.cache`, `tmp`, `playwright-report`, `test-results` or
  `.agent-review-loop`. Any unexpected change stops the run.
- The reviewer works on a read-only copy with read-only tools and an
  allowlisted set of environment variables. The `claude` reviewer ignores
  the settings files and MCP servers of the copy (`--restricted`,
  `--strict-mcp-config`) and its `CLAUDE.md` files (`--safe-mode`).
- With `reviewLanes` (see [profile.md](docs/profile.md#reviewlanes)) every
  lane is a separate reviewer process with these same guarantees, on the
  same read-only copy with one hash. The lanes run in parallel: they are the
  only processes of the runner that may overlap (with the read-only state
  checks between their attempts), never with the writer, a gate or another
  command. The snapshot and the working tree are checked before the stage,
  around every attempt of every lane and after the stage. A lane without a
  valid result stops the run; partial results are never merged. The profile
  cannot change the fixed reviewer prompt: a lane's focus is a validated
  phrase (Latin letters A-Z, digits, spaces and plain punctuation only; no
  line breaks, quotes, brackets other than parentheses or markup; no stem of
  a word of the result contract or of format instructions anywhere in a
  word) appended after it. This validation guards against mistakes, not
  against prompt injection: the profile is trusted code (it can already
  load provider modules and presenters), so the focus is not a security
  barrier. Each lane is a full
  review, so the review cost of a round grows with the number of lanes (up
  to 4).
- A lane's `paths` (its context package) limit only where its review starts:
  its prompt names every changed file and a file of the snapshot with the
  part of the diff for its files.
  They are not isolation: every lane runs on the same complete read-only
  copy and can read the full diff and any file in it. A review of the whole
  change therefore depends on coverage, which the runner enforces: before
  any reviewer starts, every changed file (both sides of a rename, a deleted
  file too) must belong to at least one lane, otherwise the run stops with
  `INVALID_CONFIGURATION`. A lane still reviews its files with the depth it
  chooses, so narrow paths can mean a narrower review of the changes they
  leave to other lanes. No diff content enters the prompt: the lane's part
  is written next to the full diff (`.review-context/lane-<id>.diff`)
  before the copy is made read-only and hashed, so it has the same
  protection as the full diff, and a change to it stops the run with
  `SNAPSHOT_CHANGED`. The prompt carries only that path, its SHA-256 and
  the names of the changed files, each a JSON string on its own line with
  U+0085, U+2028 and U+2029 escaped too. File names are working tree
  content and stay untrusted.
- `.review-context` is reserved: the runner writes the review context (full
  diff, trusted gate report, task and instructions, correction context,
  lane diffs) into that directory of the snapshot. A working-tree path with
  a `.review-context` segment (compared without case, outside the excluded
  directories) stops the run with `PATH_ESCAPE` before any snapshot or
  reviewer. The runner creates the directory and each file in it only as
  new entries (no `recursive`, `O_CREAT | O_EXCL` with `O_NOFOLLOW`), so an
  existing entry or a symbolic link stops the run instead of being written
  through.
- Repository paths are never read or copied through a symbolic link. A
  manifest entry with a parent directory that is a symbolic link stops the
  run with `SYMLINK_ESCAPE`, also when the link points inside the
  repository. A symbolic link in the repository must point inside it both
  lexically and by its target resolved segment by segment through the links
  on its way (`realpath` of each existing link, the missing rest
  lexically); a link whose chain cannot be resolved (a loop, or a dangling
  link on the way) stops the run too. The snapshot creates directories one
  segment at a time and refuses one that is not a real directory, copies
  files with `COPYFILE_EXCL` and creates symbolic links only after every
  file, so no write follows a link out of the snapshot. Untracked paths
  come from Git, which does not list paths beyond a symbolic link.
  `AGENTS.md` and `CLAUDE.md` pass the same check before they are read
  (an in-repository link such as `CLAUDE.md -> AGENTS.md` still works).
  The checks inspect a path and then read or copy it; a process that swaps
  a path between the two steps is outside this model, which is why the
  writer has finished before every snapshot and the snapshot and working
  tree are compared after each stage.
- Every run report (`APPROVE` or `STOPPED`) has `publicationApproved: false`;
  the runner never sets it to `true` and never commits, pushes or merges.
- Checkpoints are opt-in. With `--checkpoint` or `--resume`, state carried
  between runs (round, findings) is accepted only with a valid HMAC
  (SHA-256) signature, compared in constant time. The key is 32 random
  bytes in `$XDG_STATE_HOME/ringi/checkpoint.key` or
  `~/.local/state/ringi/checkpoint.key`: created once, atomically, never
  replaced; the directory must be the current user's with mode `0700` and
  the file `0600`, neither a symbolic link, or the resume stops with
  `INTEGRITY_CHECK_FAILED`. Only the stops in an allowlist are resumable
  (see [cli.md](docs/cli.md#checkpoints-and-resume)). A resumed run always
  runs the gates and the review again, so `APPROVE` after a resume requires
  passing fresh gates and, for a task class with review, a fresh review with
  no unresolved findings.
  Without these options nothing is written in the state directory.
- Every run with a run directory writes an append-only evidence ledger
  (`ledger.jsonl`, see [ledger.md](docs/ledger.md)): a SHA-256 hash chain of
  its phases, and an HMAC of each line when the checkpoint key exists. Only
  evidence the report already contains, or hashes of it, after the same
  redaction. A run without checkpoints only reads an existing key, with the
  same permission checks, and never creates it. An event that cannot be
  written stops the run with `INTEGRITY_CHECK_FAILED`. `ringi verify <runId>`
  checks the ledger against the key and the report, read-only.

## What the runner does not guarantee

- The checkpoint signature detects a checkpoint changed without the key. It
  does not protect against code that runs as the user: the writer (the
  sandboxes restrict writes, not reads in the user's home) and the gates
  (outside any sandbox) can read the key, and a gate can remove revocation
  markers. A checkpoint forged that way can change the round or the
  findings history a resume continues with, but cannot approve a run.
  Deleting the key makes every existing checkpoint unverifiable.

- The ledger detects a line changed, removed, reordered or cut by someone
  without the key, as long as the report is not changed with it. It does not
  prove that a ledger is authentic: the writer and the gates can read the
  key and write a ledger that verifies. The ledger is in the run directory in
  the repository, which the writer can change or delete; a deleted ledger is
  detectable as a missing one, but a ledger rewritten without `mac` together
  with its report is not detectable without the key. With the key present,
  `ringi verify` reports a ledger without `mac` as `unverified` (exit code
  `1`), since it cannot tell a ledger written without the key from one whose
  macs were removed. Without the key `ringi verify` checks only the hash
  chain and says so. The runner never takes trusted state from the ledger.

- It is not a sandbox. Isolation of the implementer relies on the
  implementer's CLI: with the default profile setting, the Codex CLI
  sandbox. Claude Code as implementer is
  experimental, not for untrusted tasks. Its Bash commands run in the
  Claude Code sandbox with network blocked and may write in the working
  directory, including `.git`; the runner does not prevent changes to
  `.git`. It refuses repository layouts its checks do not cover (linked
  worktrees, submodules, alternates, a Git directory other than `.git`,
  symbolic links among the entries of `.git` the fingerprint reads as plain
  files and directories), detects the changes its fingerprint of the Git
  directory covers (as listed in the architecture document) and stops with
  `UNEXPECTED_GIT_MUTATION`, and computes what the reviewer and gates see
  from `HEAD` and the working tree with a private index; without that index
  a Git command of the core is refused, never run with the repository
  index. The fingerprint, the private index and the project profile are
  compared right after the round, again after the gates (before the
  reviewer's snapshot) and again after the review (before the final
  report or the next round). When a gate or the reviewer fails, the
  comparison is added to the stop report as an integrity violation.
  Background processes: Claude Code's Bash runs each command in its own
  session and process group, so a command such as `nohup … &` leaves a
  process that outlives the CLI (probe of 2.1.285). When the CLI exits the
  runner kills its process group and, best effort, the processes and
  process groups it saw while the CLI ran (it reads the process table with
  `/bin/ps` or `/usr/bin/ps` every 200 ms and identifies a process by its
  PID and start time, so a reused PID is not killed), then reads the table
  again: a recorded process it cannot kill within 2 seconds, also one that
  moved to another group, a recorded PID present with another start time
  (a reused PID or a clock step; nothing is killed then), or a table it
  cannot read (no `ps` at those
  paths, an error or timeout of `ps`, unexpected output, any platform
  other than macOS and Linux), stops the run with
  `IMPLEMENTER_PROCESS_SURVIVED`. Known limits: a process that left the
  CLI's process tree and the groups the runner saw between two readings
  (within the interval plus the time `ps` takes, for example a command
  that ran `nohup`, `setsid` or `&` and ended before a reading saw it) is
  not found and not killed; it
  can change `.git`, the working tree or the private index. Such a change
  is detected only by the comparisons listed above, so a change after the
  last one (after the final report) is not detected, and changes to files
  ignored by Git are not detected at all (see below). The runner does not
  look for processes by working directory or environment. The process
  watch was tested on macOS; on Linux it relies on the same `ps` options
  (procps) and was not tested on a Linux host. Its file tools are confined
  to the working
  directory by the CLI's permission checks (`--restricted`), not by an OS
  sandbox, and admin-managed Claude Code settings still apply (see
  [docs/architecture.md](docs/architecture.md#claude-code-as-implementer)).
  The runner's guards cover the commands they wrap on `PATH`, not
  every possible way to run a program. The `codex` implementer runs
  commands in a non-login shell (`-c allow_login_shell=false`), where a
  probe of Codex CLI 0.160.0 on macOS reached the guards
  ([probes](docs/providers/probes/codex-implementer.md)); in a login
  shell the profiles (`/etc/zprofile` with `path_helper`) put the system
  directories before the guard directory. The runner gives the
  implementer (`codex` and `claude`) an empty private `ZDOTDIR`, so zsh
  does not read the user's `.zshenv`; probes showed the guard reached
  with it, and the real `git` running instead of the guard when a user's
  `.zshenv` that changes `PATH` was read by `codex`. zsh still reads the
  system file `/etc/zshenv`, which the runner does not control: a `PATH`
  change there comes before the guard directory for `codex`, and what it
  exports reaches every command. The `git`
  guard checks only the subcommand name, so options of allowed
  subcommands (for example ones that write output files or start external
  programs) are passed through.
- Gates run project scripts, which may include code changed by the implementer,
  outside the implementer's sandbox (Codex or Claude Code), with the user's
  permissions and network access;
  only their environment variables are isolated (separate home, configuration
  and cache directories, Corepack network disabled).
- Changes to files ignored by Git, and to paths inside the excluded build and
  cache directories listed above (tracked or not), are not detected by the
  working tree checks. Ignored files are not scanned for secrets.
- The runner's own files are runner code, not part of the repository's
  checks. When the runner starts it records the SHA-256 of every module of
  the import graph of `bin/ringi.mjs` and `scripts/agent-review-loop.mjs`
  in its installation (regular files only; a symbolic link, another letter
  case or an unreadable file means no fingerprint, and the run stops). The
  run compares them after each writer round, after the gates, before the
  reviewer's snapshot, before the final report and on every stop, and
  stops with `RUNNER_MODIFIED` on a difference or when they cannot be
  read. This detects a change made during the run only: a change made
  before the run (for example one a writer left in a runner inside the
  repository, such as `node_modules/ringi-gate`, during an earlier run)
  is not detected, because the fingerprint starts from the files as they
  are. Install the runner outside the target repository (globally or
  through `npx` from the npm cache); `ringi doctor` reports
  `runner-location` as `warn` when it lies inside. Runner modules a
  project profile imports outside that import graph (for example
  `examples/`) are not fingerprinted.
- Secret detection is pattern-based and can miss secrets or flag false
  positives.
- An `APPROVE` means the configured gates passed and, where independent
  review is required, the reviewer reported no findings. For the task classes
  `docs-minor` and `docs-descriptive` (in the default classes), chosen in the
  task file, review is skipped (`NOT_REQUIRED`) and `APPROVE` means only that
  the profile's `docs` gates passed; such a change may only touch the paths
  of the profile's docs candidate rule (by default `README.md` and Markdown
  files under `docs/`). A profile can skip review only for classes limited to
  that rule, and cannot drop its base exclusions of agent instruction files
  (see [docs/profile.md](docs/profile.md#taskclasses)). In no case is
  `APPROVE` a proof of correctness or security;
  a human must still review the change before publishing it.
- The agents' own behaviour, models and network access outside the runner's
  settings are not controlled by Ringi.
