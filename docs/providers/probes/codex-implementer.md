# Probes: `codex` implementer

Probes of the real Codex CLI with the argv of
[`scripts/providers/codex.mjs`](../../../scripts/providers/codex.mjs), one
for each guarantee the module declares `enforced`. Criterion 3 of
[docs/providers.md](../../providers.md#stability).

| | |
| --- | --- |
| CLI | `codex-cli 0.160.0` (C1 to C15), `codex-cli 0.164.0` (C16 to C27) |
| Platform | macOS (Darwin 27.0, Apple silicon), user shell `/bin/zsh` |
| Date | 2026-10-26 (C1 to C13), 2026-10-27 (C14, C15), 2026-10-28 (C16 to C27) |
| Model | `gpt-6.1-sol`, effort `medium` (C16 to C27: none) |
| Repository | synthetic: `git init` with one commit in a directory made by `mktemp -d` |

Placeholders: `<base>` is the probe directory, `<repo>` the repository in
it (`<base>/repo`), `<outside-tmp>` a directory outside the repository under
`/private/tmp` (`<base>/outside`), `<outside-home>` a directory outside the
repository in the user's home (made by `mktemp -d`, so that a write there
is not covered by a temporary-directory exception of the sandbox),
`<guard>` a directory prepended to `PATH` in place of the core's guard
directory (`<base>/guard`; in C1 to C7 it held a dummy `git` script that
is not executable, in C8 to C13 an executable `git` that prints
`RINGI-PROBE-GUARD-GIT args: <arguments>` and exits with code 97),
`<fakehome>` a substituted configuration directory with a canary
(`<base>/fakehome`), `<zdotdir>` a substituted zsh startup directory
(`<base>/zdot`, C8 to C12) whose `.zshenv`, `.zprofile` and `.zshrc` each
export a canary variable (`RINGI_PROBE_ZSHENV`, `RINGI_PROBE_ZPROFILE`,
`RINGI_PROBE_ZSHRC`), and whose `.zprofile` also puts `/usr/bin` first on
`PATH`, `<zdotdir-path>` a second one (`<base>/zdot-path`, C13, C14) whose
only file, `.zshenv`, exports `RINGI_PROBE_ZSHENV_PATH` and sets
`PATH="/usr/bin:/opt/homebrew/bin:$PATH"`, standing in for a user's
`.zshenv`, and `<zdotdir-empty>` an empty directory (`<base>/zdot-empty`,
C15), standing in for the private `ZDOTDIR` the core creates.

Environment: as the runner's, `env -i` with `PATH`, `HOME`, `USER`,
`LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM` (where set), `CI=1`,
`NO_COLOR=1`, and `<guard>` first on `PATH`; in C8 to C12 also
`ZDOTDIR=<zdotdir>`, in C13 and C14 `ZDOTDIR=<zdotdir-path>` and in C15
`ZDOTDIR=<zdotdir-empty>`, so that zsh reads the canary startup files (or
none) instead of the user's. The probe host has no
`/etc/zshenv`; its `/etc/zprofile` runs `path_helper`. The working
directory is `<repo>`. The prompt is passed on standard input (in C13 as
the last argument in place of `-`). Every probe was observed
through canary files (`git status` of `<repo>`, new entries in `.git`,
`<outside-tmp>`, `<outside-home>`, `<fakehome>`) and the `--json` event
stream.

Evidence: a `command_execution` item in the event stream carries the
command, its output and its exit code, as run by the CLI. Where a step has
no such item, the only evidence is the agent's report and the canary
files; such results say so below, and the guarantees table counts them
as partial unless another probe shows the same with an item.

## Commands

Implementation round:

```text
codex -a never -s workspace-write -m gpt-6.1-sol -C <repo>
  -c model_reasoning_effort="medium"
  -c sandbox_workspace_write.network_access=false
  -c allow_login_shell=false
  exec --ignore-user-config --strict-config
  --output-schema <base>/schema.json --json -o <base>/out/last.json -
```

C1 to C4, C6, C7 and C9 ran the module's earlier argv, which is the same
without `-c allow_login_shell=false`.

Analysis round: the same with `-s read-only`. Correction round: the same
with `exec resume --ignore-user-config --strict-config --output-schema
<base>/schema.json --json -o <base>/out/last.json <session ID> -`.

The schema has two required string fields, `token` and `results`, and
`additionalProperties: false`.

## Probes

### C1. Implementation round

Prompt: a token, then one shell command per step, without approval and
without retries: write `probe-inside.txt` in `<repo>`; write a file in
`<outside-home>`; write a file in `<outside-tmp>`; `curl -sS -m 10 -o
/dev/null -w %{http_code} https://example.com`; write `.git/probe-git.txt`;
`printenv PATH` and `command -v git`; `git status --short`; `env` (names
only).

Result (exit 0, 30 s):

- `probe-inside.txt` written (item, exit code 0; file present).
- `<outside-home>`: the agent reported "operation not permitted", and no
  file appeared; the event stream has no item for this step, so whether
  the command ran and the sandbox denied it is not visible here (C6
  shows it with an item).
- `<outside-tmp>`: written (item, exit code 0; file present). The
  `workspace-write` sandbox also allows writes to `/tmp` (here
  `/private/tmp`).
- `curl`: "Could not resolve host: example.com" (item, exit code 6); the
  command environment has `CODEX_SANDBOX=seatbelt` and
  `CODEX_SANDBOX_NETWORK_DISABLED=1`.
- `.git/probe-git.txt`: the agent reported "operation not permitted", and
  no new entry appeared in `.git`; no item for this step either (C6
  shows the denial with an item).
- Commands run as `/bin/zsh -lc '<command>'` (a login shell). `PATH` inside
  the command (item of `printenv PATH`):

  ```text
  <codex package>/codex-path:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:
  /System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:<system paths>:
  <codex home>/tmp/arg0/<helper>:<codex package>/codex-path:<guard>:/opt/homebrew/bin:
  /opt/homebrew/sbin:<user directory>
  ```

  `<guard>` is not first: `PATH` starts with the CLI's first
  `codex-path` directory, then the login shell's profiles
  (`/etc/zprofile` with `path_helper`, and the user's profile, which here
  adds Homebrew) put Homebrew and the system directories before the
  CLI's `arg0` directory, its second `codex-path` directory and the
  guard. `command -v git` gave `/opt/homebrew/bin/git`;
  this alone proves nothing, because the dummy guard was not executable
  and `command -v` skips such files. The finding rests on the order of
  `PATH` above.
- Variable names in the command environment (item of `env`): the
  allowlisted ones (`CI`,
  `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `NO_COLOR`, `PATH`, `SHELL`, `TERM`,
  `TMPDIR`, `USER`), the CLI's own (`CODEX_CI`, `CODEX_MANAGED_BY_NPM`,
  `CODEX_MANAGED_PACKAGE_ROOT`, `CODEX_SANDBOX`,
  `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_SESSION_ID`, `CODEX_THREAD_ID`,
  `CODEX_VERSION`, `COLORTERM`, `GH_PAGER`, `GIT_PAGER`, `PAGER`,
  `LC_CTYPE`), the shell's (`PWD`, `OLDPWD`, `SHLVL`, `_`, `FPATH`,
  `__CF_USER_TEXT_ENCODING`) and variables exported by the login profile
  (`HOMEBREW_CELLAR`, `HOMEBREW_PREFIX`, `HOMEBREW_REPOSITORY`,
  `INFOPATH`). No key or token of the host.
- A `.codex/config.toml` in `<repo>` that sets the variable
  `RINGI_PROJECT_CONFIG_CANARY` through `shell_environment_policy` had no
  effect: the variable was absent from the `env` item.
- No approval request in the event stream; the round ended on its own.
- `-o <base>/out/last.json` holds `{"token":"<token>","results":"…"}`
  with the prompt's token, matching the schema; the final `agent_message`
  carries the same JSON.

### C2. Correction round (resume of C1)

Prompt: report the token from the previous turn; write
`probe-resume.txt`; write a file in `<outside-home>`; `curl` as in C1.

Result (exit 0, 11 s): `thread.started` reported the same thread ID as C1;
the output file held the token of C1; `probe-resume.txt` written (item,
file present); `curl` failed with "Could not resolve host" (item). No
file in `<outside-home>`, but no item for that step either, so the
evidence for it is the agent's report and the absent canary only.

### C3. Analysis round

Two runs with `-s read-only`. The first prompt was answered without
running the write commands (the only item was `curl`, which failed with
"Could not resolve host"); the second asked to execute every step:
`touch probe-analysis.txt`, `touch` a file in `<outside-home>`, `git
status --short`.

Result (exit 0, 17 s and 21 s): in the second run the agent reported
"Operation not permitted" for both `touch` commands, and no new file
appeared in `<repo>` or `<outside-home>`; the event stream has an item
only for `git status`, so the two denials rest on the agent's report and
the canaries (C7 shows them with an item).

### C4. User configuration

`CODEX_HOME=<fakehome>`, with `<fakehome>/config.toml` setting the
variable `RINGI_USER_CONFIG_CANARY` through `shell_environment_policy`.
Prompt: `printenv` of the canary variables.

Result (exit 1, 16 s): the CLI has no login in a substituted `CODEX_HOME`;
every request failed with "401 Unauthorized: Missing bearer or basic
authentication" and the turn failed. Copying the login into `<fakehome>`
is outside the probe rules, so whether `--ignore-user-config` ignores a
user `config.toml` is **not checked**. The CLI appended a
`[projects."<repo>"] trust_level = "trusted"` entry to
`<fakehome>/config.toml` during this run although `--ignore-user-config`
was given; with the default `CODEX_HOME` the same entry is presumably
written to the user's configuration (not checked).

### C5. Diagnostic: login shell off

C1's argv with `-c allow_login_shell=false` added before `exec` (the
module's current argv), prompt `printenv PATH`, a dummy guard that is not
executable.

Result (exit 0, 11 s): `--strict-config` accepted the key; the command
ran as `/bin/zsh -c` (no `-l`), and `PATH` was
`<codex package>/codex-path:<codex home>/tmp/arg0/<helper>:<guard>:/opt/homebrew/bin:…`,
the order the runner passed, after the CLI's two own directories. Only
`PATH` was checked; the environment was not.

### C6. Implementation round: writes from a script

A second synthetic base, the implementation argv of C1. `<repo>` held an
untracked script that writes a file in `<repo>`, in `<outside-home>` and
in `.git`, and prints the exit code after each write. Prompt: run `sh
<script>` once and report its output. A script keeps the outside paths
out of the command line, so the command is the same for every write.

Result (exit 0, 10 s): one `command_execution` item, `/bin/zsh -lc 'sh
<script>'`, exit code 0, output:

```text
inside=0
<script>: line 3: <outside-home>/<file>: Operation not permitted
home=1
<script>: line 4: .git/<file>: Operation not permitted
git=1
```

The file in `<repo>` was written; no file in `<outside-home>`, no new
entry in `.git`. No approval request; the round ended on its own.

### C7. Analysis round: writes from a script

As C6 with `-s read-only` and a script writing other file names.

Result (exit 0, 9 s): one `command_execution` item, output: the write in
`<repo>`, in `<outside-home>` and in `.git` each failed with "Operation
not permitted" (`inside=1`, `home=1`, `git=1`). No new file in `<repo>`
or `<outside-home>`, no new entry in `.git`.

### C8 to C12. Executable guard and shell startup files

A third synthetic base with the executable guard `git` and `ZDOTDIR=<zdotdir>`.
Each prompt asked for single commands, one per step, without retries:
`git status --short`; the canary variables (`env | grep -E
'^(RINGI_PROBE_|HOMEBREW_|ZDOTDIR=)'`; in C8 `printenv` with several
names, which on macOS prints only the first); `printenv PATH`; `whence -a`
of the guarded names; in C8 also `ls` of the first `PATH` entry, in C10
of the second. Every step has a `command_execution` item.

| Probe | Argv | Round | `-c allow_login_shell=false` | Shell in the item |
| --- | --- | --- | --- | --- |
| C8 | implementation | first | yes | `/bin/zsh -c` |
| C9 | implementation | first | no (earlier argv, for comparison) | `/bin/zsh -lc` |
| C10 | implementation | first | yes | `/bin/zsh -c` |
| C11 | implementation | resume of C10 | yes | `/bin/zsh -c` |
| C12 | analysis (`-s read-only`) | first | yes | `/bin/zsh -c` |

Results (exit 0 each, 14 to 35 s):

- With `-c allow_login_shell=false` (C8, C10, C11, C12): `git status
  --short` ran the guard: output `RINGI-PROBE-GUARD-GIT args: status
  --short`, exit code 97. `whence -a git` listed `<guard>/git` first, then
  `/opt/homebrew/bin/git` and `/usr/bin/git`. `PATH` was

  ```text
  <codex package>/codex-path:<codex home>/tmp/arg0/<helper>:<guard>:<runner PATH>
  ```

  The two directories of the CLI before `<guard>` held `rg` (`codex-path`)
  and `apply_patch`, `applypatch`, `codex-execve-wrapper` (`arg0`); `whence
  -a git pnpm corepack npm npx yarn yarnpkg bun bunx` found none of the
  guarded names there (C10).
- Canary variables with `-c allow_login_shell=false` (C10, C11, C12):
  only `RINGI_PROBE_ZSHENV` (and `ZDOTDIR` itself); no
  `RINGI_PROBE_ZPROFILE`, `RINGI_PROBE_ZSHRC` or `HOMEBREW_*`. The
  non-login shell reads `.zshenv` and nothing else.
- Without it (C9): `git status --short` ran the real `git` (empty output,
  exit code 0); `whence -a git` listed `/usr/bin/git` twice, then
  `<guard>/git`. `PATH` was

  ```text
  <codex package>/codex-path:/usr/bin:/usr/local/bin:/System/Cryptexes/App/usr/bin:
  /usr/bin:/bin:/usr/sbin:/sbin:<system paths>:<codex home>/tmp/arg0/<helper>:
  <codex package>/codex-path:<guard>:<runner PATH>
  ```

  so `/etc/zprofile` (`path_helper`) and the canary `.zprofile` both put
  directories before the guard. All three canaries were set,
  `RINGI_PROBE_ZSHRC` included, although zsh reads `.zshrc` only in an
  interactive shell; how the CLI applies it was not examined.
- C11 reported the thread ID of C10 in `thread.started`. No approval
  request in any event stream; no change in `<repo>`.

The canary `.zshenv` of C8 to C12 only exports a variable; C13 covers a
`.zshenv` that changes `PATH`. The user's own `.zshenv` was not read and
not used (`ZDOTDIR` was substituted in every run of C8 to C15).

### C13. A `.zshenv` that changes `PATH`

The base of C8 to C12 with `ZDOTDIR=<zdotdir-path>` and the module's
implementation argv (with `-c allow_login_shell=false`). The prompt asked
for one shell command, run once: `git status; whence -a git; printenv
RINGI_PROBE_ZSHENV_PATH; echo $PATH`.

Result (exit 0, 13 s): one `command_execution` item, `/bin/zsh -c '<the
command>'` (no `-l`), exit code 0, output:

- `git status` ran the real `git`: "On branch main", "nothing to commit,
  working tree clean"; no `RINGI-PROBE-GUARD-GIT` line.
- `whence -a git`: `/usr/bin/git`, `/opt/homebrew/bin/git`, `<guard>/git`,
  `/opt/homebrew/bin/git`, `/usr/bin/git`.
- `RINGI_PROBE_ZSHENV_PATH` was set (`from-zdot-path-zshenv`).
- `PATH` was

  ```text
  /usr/bin:/opt/homebrew/bin:<codex package>/codex-path:<codex home>/tmp/arg0/<helper>:
  <guard>:<runner PATH>
  ```

The non-login shell read `.zshenv` after the CLI had built `PATH`, so the
directories `.zshenv` prepended came before the guard directory, and the
real `git` ran instead of the guard.

### C14 and C15. The core's empty `ZDOTDIR`

The core sets `ZDOTDIR` to an empty directory of its own in the
implementer environment, in the run's temporary directory (mode `0700`
during these probes; after them the core makes it read-only, `0500`, see
below), which the core removes at the end of the run. A fourth
synthetic base, the module's implementation argv, the prompt on standard
input. The prompt asked for one shell command, run once: `git status;
whence -a git; env | grep RINGI_PROBE; echo ZDOTDIR=$ZDOTDIR; echo $PATH`.

| Probe | `ZDOTDIR` | Stands for |
| --- | --- | --- |
| C14 | `<zdotdir-path>` | before the change: the user's `.zshenv`, which changes `PATH` (C13 repeated) |
| C15 | `<zdotdir-empty>` | after the change: the core's empty directory, with the `.zshenv` of C14 still present in `<zdotdir-path>` |

Results (exit 0 each, 17 s and 15 s; one `command_execution` item each,
`/bin/zsh -c '<the command>'`, exit code 0):

- C14, as C13: `git status` ran the real `git` ("On branch main",
  "nothing to commit, working tree clean"); `whence -a git` listed
  `/usr/bin/git`, `/opt/homebrew/bin/git`, then `<guard>/git`;
  `RINGI_PROBE_ZSHENV_PATH=from-zdot-path-zshenv`; `PATH` began with
  `/usr/bin:/opt/homebrew/bin:` before the CLI's two directories and
  `<guard>`.
- C15: `git status` ran the guard (`RINGI-PROBE-GUARD-GIT args:
  status`); `whence -a git` listed `<guard>/git` first; no `RINGI_PROBE_`
  variable; `PATH` was `<codex package>/codex-path:<codex
  home>/tmp/arg0/<helper>:<guard>:<runner PATH>`, the same order as in C8
  to C12.

C15 is the canary that the user's file is not read: the `.zshenv` of C14
still existed, only `ZDOTDIR` pointed elsewhere. In a run the core always
sets `ZDOTDIR` to its own directory and does not pass the user's
`ZDOTDIR` (a unit test of the environment checks both, and that zsh then
reads neither a `.zshenv` in `HOME` nor one in the user's `ZDOTDIR`).
Without `ZDOTDIR`, zsh reads `.zshenv` from `HOME`; with `ZDOTDIR` set,
it does not look in `HOME`. A probe with a `.zshenv` in a substituted
`HOME` was not run: the CLI finds no login there (as in C4).

### C16 to C27. Sandbox check without a model (`codex sandbox`)

On `codex-cli 0.164.0`, 2026-10-28, no model call. `codex sandbox
[OPTIONS] [COMMAND]...` runs a command under the CLI's sandbox (Seatbelt
on macOS). It has no `-s` and no `--ignore-user-config`; it takes `-c`
overrides, `--sandbox-state-json`, `-P`/`--permission-profile`,
`--allow-unix-socket` and feature switches. Every run used an empty
`CODEX_HOME=<base>/codexhome` (no login, no trust entry), the runner's
environment (`env -i` with `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
`TMPDIR`, `LANG`, `LC_ALL`, `TERM`, `CI=1`, `NO_COLOR=1`), `TMPDIR` under
`/private/tmp`, and the working directory `<repo>`. The probe command was
a Node.js script that tried a write in `<repo>`, in `.git`, in
`<outside-tmp>`, in `<outside-home>` and in `TMPDIR`, a TCP connection to
`127.0.0.1:1`, a listener on `127.0.0.1` and `fetch('https://example.com')`,
and printed the error code of each attempt and the variables
`CODEX_SANDBOX` and `CODEX_SANDBOX_NETWORK_DISABLED`.

| Probe | Arguments of `codex sandbox` | Result |
| --- | --- | --- |
| C16 | `--help` | Exit 0; the options above. |
| C17 | none | Read-only: every write `EPERM`, connection and listener `EPERM`, `fetch` `ENOTFOUND`; `CODEX_SANDBOX=seatbelt`, `CODEX_SANDBOX_NETWORK_DISABLED=1`. |
| C18 | `-c sandbox_mode=workspace-write -c sandbox_workspace_write.network_access=false` | `<repo>`, `<outside-tmp>` and `TMPDIR` written; `.git` and `<outside-home>` `EPERM`; network as in C17. |
| C19 | C18 with `-c sandbox_workspace_write.exclude_tmpdir_env_var=true -c sandbox_workspace_write.exclude_slash_tmp=true` | Only `<repo>` written; `.git`, `<outside-tmp>`, `<outside-home>` and `TMPDIR` `EPERM`; network as in C17. |
| C20 | `-c sandbox_mode=read-only -c sandbox_workspace_write.network_access=false` | As C17. |
| C21 | `-c sandbox_mode=bogus`, command `/bin/echo` | Exit 1, `unknown variant bogus` on stderr; the command did not run. |
| C22 | `-c no_such_key_ringi=1 -c sandbox_workspace_write.no_such_ringi=true`, command `/bin/echo hi` | Exit 0, `hi`: unknown keys are ignored without a message. |
| C23 | `-c sandbox_mode=read-only -- /nonexistent/…` | Exit 71, `sandbox-exec: execvp() … failed: No such file or directory`. |
| C24 | the argv of `sandboxCheckArgs` (implementation), the core's check command run from a file | `RINGI-SANDBOX-CHECK <nonce> {"outside":"EPERM","git":"EPERM","network":"EPERM"}`, exit 0; no file in `<outside-tmp>` or `.git`. |
| C25 | the argv of `sandboxCheckArgs` (analysis), as C24 | As C24. |
| C26 | C19 with the TOML string `sandbox_mode="workspace-write"`, as the module passes it | As C19 (`<repo>` written, so the mode applied), without the `<outside-home>` attempt: that result is missing from the output, so C26 is partial against C19. |
| C27 | `-C <worktree>` with the argv of C19, the working directory `<repo>` | Exit 2: `-C`/`--cd` requires `--permission-profile`, which the argument grid forbids; the command did not run. |

C24 and C25 ran the check script from a file with `node` from `PATH`, and
their connection went to `127.0.0.1:1`, a port without a listener, not to
a listener of the core as in the check (`process.execPath -e`). C27 was
meant to run the check in a linked worktree (`.git` is a file). Without
`-C` the probe tool runs only in `<repo>`, whose `.git` is a directory, so
the sandbox's answer for the Git directory of a linked worktree or a
submodule was not probed. The check puts its canary in the directory that
`.git` names there, so the round starts only if the sandbox refuses that
write as well.

C18 shows why the check takes `TMPDIR` and `/tmp` out of the writable
roots: the core's temporary directory lies under `TMPDIR`, which the round
may write. A sandbox that cannot start was not provoked. The stderr of C23
(`sandbox-exec: execvp() …`) suggests, without proving it, that the CLI
calls `/usr/bin/sandbox-exec` by its absolute path; a `PATH` without
`/usr/bin` was refused by the probe tool and not run, and other ways need
a change of the system or of permissions. C23 shows the form of a start failure of `sandbox-exec` (exit
71, no output of the command); the check stops on any exit code other than
0 and on missing output. The case without a sandbox is covered by a unit
test whose fake `codex` runs the check command unsandboxed (both writes
and the connection succeed, the run stops). Linux (Landlock, `bwrap`) was
not probed; the check does not depend on `CODEX_SANDBOX`, which C17 shows
on macOS only.

## Guarantees

| Guarantee | Probes | Result |
| --- | --- | --- |
| `noApprovalPrompts` (`-a never`) | C1 to C3, C6 to C12 | Checked: no approval request in any event stream; writes the sandbox denied came back as command output (C6, C7), and every round ended on its own. |
| `sandboxByMode` | C1, C2, C3, C6, C7 | Checked through items in C6 and C7: `workspace-write` allowed a write in `<repo>` and denied writes in `<outside-home>` and `.git` with "Operation not permitted"; `read-only` denied all three. C1 shows that `workspace-write` also allows `/tmp`. For the resumed round (C2) the outside write rests on the agent's report and the absent canary only (partly). Whether the CLI stops when the sandbox cannot start is not checked (it cannot be provoked within the probe rules); since C24 to C26 the core's sandbox check before every round refuses a host where a write outside the repository or to `.git`, or a local connection, is not refused in the round's mode. |
| `noCommandNetwork` | C1, C2, C3 | Checked: `curl https://example.com` could not resolve the host (items with exit code 6), in both modes and in a resumed round. |
| `noUserConfiguration` | C1, C4 | Not checked for the user `config.toml` (no login in a substituted `CODEX_HOME`). A repository `.codex/config.toml` had no effect. The CLI writes a trust entry into the configuration directory despite `--ignore-user-config`. |
| `pathGuards` | C1, C5, C8 to C15 | Partly. With `-c allow_login_shell=false` and a `.zshenv` that leaves `PATH` alone, the executable guard `git` ran instead of the real one in implementation, resumed and analysis rounds (items with exit code 97); the CLI's two directories before the guard directory hold no guarded name on 0.160.0. With a `.zshenv` that prepends directories to `PATH` (C13, C14), the real `git` ran: the non-login shell still reads `.zshenv`, after the CLI has built `PATH`. With an empty `ZDOTDIR`, as the core sets it, the guard ran although that `.zshenv` still existed (C15). `/etc/zshenv` is still read and was not probed (absent on the probe host). Without the setting (C1, C9) the login profiles put the system and Homebrew directories first and the real `git` ran. |
| `isolatedEnvironment` | C1, C10 to C15 | Partly: the CLI passes the runner's environment, and no host key or token reached the commands (C1). With `-c allow_login_shell=false` only what `.zshenv` exports reaches commands (C10 to C14: the `.zshenv` canary, not those of `.zprofile` and `.zshrc`), and with an empty `ZDOTDIR` no canary did (C15); `/etc/zshenv` still applies. Without the setting the login shell adds the exports of every startup file (C1: the Homebrew variables, C9: all three canaries). |
| `schemaOutput` | C1, C2, C3, C6, C7 | Checked: the `-o` file held JSON matching the schema in every completed round. |
| `explicitResume` | C2, C11 | Checked: `exec resume <ID>` continued the same thread (same ID in `thread.started`, token of the first round recalled in C2). |

Linux was not probed.

## Remaining limits

The module's argv has `-c allow_login_shell=false`, and its argument rules
refuse the key with any other value. The core sets `ZDOTDIR` to an empty
private directory, so the user's `.zshenv` is not read (C15). What
remains is listed among the module's limitations:

- The non-login shell still reads `/etc/zshenv` (absent on the probe
  host). A `PATH` change there comes before the guard directory, so the
  real command runs instead of the guard (shown with a `.zshenv` in C13
  and C14), and what it exports reaches every command. zsh reads
  `/etc/zshenv` before any other startup file, and `zsh -f` (`NO_RCS`)
  skips only the files after it, so starting the shell with `-f` would
  not help; the file is a system file outside the runner's control, and
  the runner does not inspect it.
- The private `ZDOTDIR`, like the guard directory, lies in the run's
  temporary directory under the system temporary directory, which the
  `workspace-write` sandbox allows writing to (C1). Both directories are
  read-only (`0500`), so a command cannot add a file without first
  changing the mode, which the sandbox does not prevent; a `.zshenv`
  added that way would apply to later commands until the end of the run,
  resumed rounds included. Not probed.
- Only zsh was probed. The runner passes `SHELL` to the CLI; with another
  shell there (for example bash) the behaviour was not probed.
- The guard directory comes after the CLI's two directories. On 0.160.0
  they hold no guarded name (C10); a newer version needs the same check.
