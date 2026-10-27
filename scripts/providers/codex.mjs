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

// Codex CLI versions and platforms the declarations are checked against:
// 0.160.0 up to, but not including, 0.161.0 (a 0.x minor release may change
// flags or sandbox behaviour), on macOS or Linux, where the CLI has a command
// sandbox. A newer version needs a deliberate bump after new probes.
const CODEX_MIN_VERSION = Object.freeze([0, 160, 0]);
const CODEX_VERSION_LIMIT = Object.freeze([0, 161, 0]);
const CODEX_SANDBOX_PLATFORMS = Object.freeze(['darwin', 'linux']);

// -1, 0 or 1 for the version of `codex --version` ("codex-cli 0.160.0")
// against a triple; undefined when the text is not such a version followed
// by whitespace or the end (a pre-release or build suffix is refused).
function compareVersion(text, triple) {
  const match = /^(?:codex-cli )?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?=\s|$)/.exec(text);
  if (!match) return undefined;
  for (let index = 0; index < triple.length; index += 1) {
    const part = Number(match[index + 1]);
    if (part !== triple[index]) return part > triple[index] ? 1 : -1;
  }
  return 0;
}

function preflight({ version, platform }) {
  const low = compareVersion(version, CODEX_MIN_VERSION);
  if (low === undefined || low < 0 || compareVersion(version, CODEX_VERSION_LIMIT) >= 0)
    return 'UNSUPPORTED_VERSION';
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
      'The CLI has no documented setting that makes it fail when its sandbox cannot start, and the runner does not check it; preflight accepts only versions from 0.160.0 up to, but not including, 0.161.0, on macOS or Linux.',
      'The Git directory is not fingerprinted: the workspace-write sandbox keeps .git read-only as documented by Codex (not checked by this runner).',
      'Codex system (admin) configuration still applies.',
      "Commands run in a non-login shell, and the core sets ZDOTDIR to an empty private directory, so zsh skips the user's .zshenv; it still reads /etc/zshenv, where a PATH change puts the real command before the guard (shown with a .zshenv on 0.160.0), and what it exports reaches every command. Only zsh was probed, not other shells in SHELL. Two directories of the CLI come before the guard directory on PATH; on 0.160.0 they hold no guarded command.",
    ],
    security: {
      noApprovalPrompts: enforced('-a never'),
      sandboxByMode: enforced(
        '-s workspace-write (implementation) or -s read-only (analysis) on every round',
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
  },
});
