// Provider module of the Codex CLI (implementer). Moved from
// agent-review-providers.mjs without a change of environment or output
// reading; the argv adds -c allow_login_shell=false. The declarations below
// describe what that argv does.
import { defineProvider, isValidModelId } from './contract.mjs';

export const SOL_EFFORTS = Object.freeze(['medium', 'high', 'xhigh', 'max']);

function processArgs({
  taskMode,
  model,
  effort,
  repositoryRoot,
  schemaPath,
  outputPath,
  sessionId,
}) {
  const common = [
    '-a',
    'never',
    '-s',
    taskMode === 'analysis' ? 'read-only' : 'workspace-write',
    '-m',
    model,
    '-C',
    repositoryRoot,
    '-c',
    `model_reasoning_effort=${JSON.stringify(effort)}`,
    '-c',
    'sandbox_workspace_write.network_access=false',
    // Commands run in a non-login shell (`zsh -c`, not `zsh -lc`), so the
    // login profiles do not put other directories before the guard directory
    // on PATH.
    '-c',
    'allow_login_shell=false',
    'exec',
  ];
  return sessionId
    ? [
        ...common,
        'resume',
        '--ignore-user-config',
        '--strict-config',
        '--output-schema',
        schemaPath,
        '--json',
        '-o',
        outputPath,
        sessionId,
        '-',
      ]
    : [
        ...common,
        '--ignore-user-config',
        '--strict-config',
        '--output-schema',
        schemaPath,
        '--json',
        '-o',
        outputPath,
        '-',
      ];
}

// The core's check command in the sandbox of the round's mode, without a
// model (codex sandbox has no -s, so the mode is set with -c). The temporary
// directories stay out of the writable roots, so that a write to the core's
// temporary directory shows a sandbox that does not hold.
function sandboxCheckArgs({ taskMode, command }) {
  return [
    'sandbox',
    '-c',
    `sandbox_mode=${JSON.stringify(taskMode === 'analysis' ? 'read-only' : 'workspace-write')}`,
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    '--',
    ...command,
  ];
}

// The core's isolated offline environment with the guards first on PATH.
function processEnvironment({ environment, guardBin }) {
  const env = { ...environment };
  env.PATH = `${guardBin}:${env.PATH}`;
  return env;
}

function sessionId(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const candidate =
        event.thread_id ?? event.threadId ?? event.session_id ?? event.sessionId;
      if (typeof candidate === 'string' && candidate) return candidate;
      if (
        event.type === 'thread.started' &&
        typeof event.thread?.id === 'string'
      ) {
        return event.thread.id;
      }
    } catch {
      // Pozostałe linie CLI nie są źródłem wyniku strukturalnego.
    }
  }
  return undefined;
}

// Platforms where the Codex CLI has a command sandbox: macOS and Linux. Any
// CLI version is accepted (also one that cannot be parsed); the declarations
// were probed on 0.160.0 only (probedVersions), the version still goes to
// the environment report, and another version gets UNPROBED_VERSION.
const CODEX_SANDBOX_PLATFORMS = Object.freeze(['darwin', 'linux']);

function preflight({ platform }) {
  if (!CODEX_SANDBOX_PLATFORMS.includes(platform)) return 'UNSUPPORTED_PLATFORM';
  return undefined;
}

const enforced = (mechanism) => ({ status: 'enforced', mechanism });
const notSupported = (reason) => ({ status: 'not-supported', reason });

export default defineProvider({
  id: 'codex',
  program: 'codex',
  versionArgs: ['--version'],
  roles: ['implementer'],
  efforts: SOL_EFFORTS,
  isValidModel: isValidModelId,
  implementer: {
    modes: ['implementation', 'analysis'],
    stability: 'experimental',
    limitations: [
      "The CLI has no documented setting that makes it fail when its sandbox cannot start. Before every round the core runs a check command through codex sandbox in the round's mode, without a model and with an empty CODEX_HOME: a write to the core's temporary directory and to the Git directory and a connection to a local listener must be refused, or the run stops with IMPLEMENTER_PREFLIGHT_FAILED.",
      'The check is a lower bound, not proof for codex exec: another command path, no user configuration, and TMPDIR and /tmp out of the writable roots the round keeps. It was probed on 0.164.0 on macOS only (no Linux, no linked worktree or submodule); on a host or version where codex sandbox takes another form or other error codes, every round stops before the implementer (fail-closed). Preflight accepts any version on macOS or Linux; the declarations were probed on 0.160.0.',
      'The Git directory is not fingerprinted: the workspace-write sandbox keeps .git read-only as documented by Codex, and the sandbox check before every round confirms that a write to the Git directory is refused.',
      'Codex system (admin) configuration still applies.',
      "Commands run in a non-login shell, and the core sets ZDOTDIR to an empty private directory, so zsh skips the user's .zshenv; it still reads /etc/zshenv, where a PATH change puts the real command before the guard (shown with a .zshenv on 0.160.0), and what it exports reaches every command. Only zsh was probed, not other shells in SHELL. Two directories of the CLI come before the guard directory on PATH; on 0.160.0 they hold no guarded command.",
    ],
    security: {
      noApprovalPrompts: enforced('-a never'),
      sandboxByMode: enforced(
        '-s workspace-write (implementation) or -s read-only (analysis) on every round; before it, sandboxCheckArgs runs the core check command through codex sandbox in the same mode',
      ),
      noCommandNetwork: enforced('-c sandbox_workspace_write.network_access=false'),
      noUserConfiguration: enforced('--ignore-user-config --strict-config'),
      pathGuards: enforced(
        "processEnvironment puts the core guard directory before the runner's PATH; the CLI prepends its own directories, which hold no guarded command. -c allow_login_shell=false keeps the login profiles from reordering PATH, and the core's empty ZDOTDIR keeps the user's .zshenv out; limitation: the shell still reads /etc/zshenv, and a PATH change there comes before the guard directory",
      ),
      isolatedEnvironment: enforced(
        "processEnvironment passes the core's isolated offline environment unchanged apart from PATH",
      ),
      schemaOutput: enforced('--output-schema <schema file> and -o <output file>'),
      explicitResume: enforced('exec resume <session ID> with the ID read from the --json event stream'),
      readOnlyTools: notSupported(
        'The implementer writes in implementation mode; analysis mode uses the read-only sandbox.',
      ),
    },
    processArgs,
    processEnvironment,
    sessionId,
    preflight,
    sandboxCheckArgs,
    probedVersions: ['0.160.0'],
  },
});
