// Provider module of the Codex CLI (implementer). Moved from
// agent-review-providers.mjs without a change of argv, environment or output
// reading; the declarations below describe what that argv already does.
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

// No host restriction, as before the provider interface: the sandbox mode
// is passed with -s on every round.
function preflight() {
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
      'Preflight does not restrict the CLI version or platform; the runner does not check whether the CLI refuses to run commands when its sandbox cannot start.',
      'The Git directory is not fingerprinted: the workspace-write sandbox keeps .git read-only as documented by Codex (not checked by this runner).',
      'Codex system (admin) configuration still applies.',
    ],
    security: {
      noApprovalPrompts: enforced('-a never'),
      sandboxByMode: enforced(
        '-s workspace-write (implementation) or -s read-only (analysis) on every round',
      ),
      noCommandNetwork: enforced('-c sandbox_workspace_write.network_access=false'),
      noUserConfiguration: enforced('--ignore-user-config --strict-config'),
      pathGuards: enforced(
        'processEnvironment puts the core guard directory first on PATH',
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
