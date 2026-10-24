// Provider module of the Claude Code CLI (reviewer; implementer is
// experimental). Moved from agent-review-providers.mjs without a change of
// argv, environment, output reading, preflight or fallback classification;
// the declarations below describe what that code already does.
import { defineProvider, isValidModelId } from './contract.mjs';

// Efforts the claude adapter accepts in both roles; max is not planned.
export const CLAUDE_EFFORTS = Object.freeze(['medium', 'high', 'xhigh']);

// Claude Code as implementer. The CLI flags and sandbox settings below were
// checked against the help of 2.1.285 and confirmed by probes of the real
// CLI (network denied, writes outside the working directory denied). In
// print mode the CLI ignores settings that fail validation without an error,
// so only versions from 2.1.285 up to, but not including, 2.2.0 are
// accepted; a newer version needs a deliberate bump after new probes.
const CLAUDE_IMPLEMENTER_MIN_VERSION = Object.freeze([2, 1, 285]);
const CLAUDE_IMPLEMENTER_VERSION_LIMIT = Object.freeze([2, 2, 0]);
// Platforms where the command sandbox of the CLI can start (macOS, Linux and
// WSL); on any other platform the CLI would exit at startup anyway.
const CLAUDE_SANDBOX_PLATFORMS = Object.freeze(['darwin', 'linux']);
// Passed with --settings: Bash runs only inside the sandbox (the
// dangerouslyDisableSandbox escape hatch is ignored), sandboxed commands
// reach no host, and the CLI exits at startup when the sandbox cannot start
// instead of running commands unsandboxed. Commands may write in the
// working directory (the repository root, including .git) and in the paths
// the CLI sandbox itself allows, such as temporary directories; the core
// checks the Git directory after every round (gitDirectoryWritable).
const CLAUDE_IMPLEMENTER_SETTINGS = JSON.stringify({
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    network: { allowedDomains: [], strictAllowlist: true },
  },
});
// Session IDs of Claude Code are UUIDs; only such a value is resumed.
const CLAUDE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The single result object of --output-format json, or undefined.
function claudeEnvelope(stdout) {
  try {
    const envelope = JSON.parse(stdout.trim());
    return envelope && typeof envelope === 'object' && !Array.isArray(envelope)
      ? envelope
      : undefined;
  } catch {
    return undefined;
  }
}

// -1, 0 or 1 for a major.minor.patch version against a triple; undefined
// when the text does not start with such a version followed by whitespace
// or the end (a pre-release or build suffix such as -beta.1 is refused).
function compareVersion(text, triple) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?=\s|$)/.exec(text);
  if (!match) return undefined;
  for (let index = 0; index < triple.length; index += 1) {
    const part = Number(match[index + 1]);
    if (part !== triple[index]) return part > triple[index] ? 1 : -1;
  }
  return 0;
}

function versionInRange(text, minimum, limit) {
  const low = compareVersion(text, minimum);
  return low !== undefined && low >= 0 && compareVersion(text, limit) < 0;
}

// Errors that allow the reviewer fallback, and errors that never do (checked
// first). The core passes redacted process output.
const CLAUDE_FALLBACK_REASONS = Object.freeze({
  MODEL_UNAVAILABLE: [
    /\bmodel(?: is| was)? (?:currently )?(?:unavailable|not available|not found|unsupported)\b/i,
    /\bmodel_not_found\b/i,
  ],
  CAPACITY_UNAVAILABLE: [
    /\boverloaded_error\b/i,
    /\b(?:service|server|model) (?:is )?overloaded\b/i,
    /\b(?:insufficient|no) capacity\b/i,
    /\bcapacity (?:is )?(?:temporarily )?(?:unavailable|exhausted)\b/i,
  ],
  USAGE_LIMIT_EXHAUSTED: [
    /\busage (?:limit|quota) (?:has been |is )?(?:reached|exceeded|exhausted)\b/i,
    /\b(?:usage )?credits? (?:have been |are |is )?(?:exhausted|depleted|used up)\b/i,
    /\binsufficient (?:usage )?credits?\b/i,
    /\b(?:rate_limit_error|(?:rate|usage)_limit_exceeded)\b/i,
    /\bcredit balance (?:is )?(?:too low|zero|exhausted)\b/i,
  ],
});
const CLAUDE_FALLBACK_DENIAL_PATTERNS = [
  /\b(?:authentication|authorization|unauthorized|forbidden)\b/i,
  /\b(?:api[ _-]?key|credential)\b/i,
  /\b(?:permission|policy)\b/i,
  /\b(?:configuration|invalid request|schema|parsing?)\b/i,
  /\b(?:tool (?:error|failure)|timed? ?out|cancelled|canceled)\b/i,
];

const enforced = (mechanism) => ({ status: 'enforced', mechanism });
const notSupported = (reason) => ({ status: 'not-supported', reason });

const implementer = Object.freeze({
  // Print mode without permission prompts or user configuration. analysis:
  // read-only tools; implementation: file tools confined to the working
  // directory, and every Bash command auto-allowed only inside the
  // offline sandbox (commands joined with ';' are denied, as nothing can
  // approve them). The session persists so that a correction round can
  // resume it.
  processArgs({ taskMode, model, effort, outputSchema, sessionId }) {
    const analysis = taskMode === 'analysis';
    return [
      '-p',
      '--safe-mode',
      '--restricted',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--model',
      model,
      '--effort',
      effort,
      '--permission-mode',
      analysis ? 'dontAsk' : 'acceptEdits',
      '--permission-prompts',
      'none',
      '--tools',
      analysis ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash',
      '--disallowedTools',
      'WebFetch,WebSearch',
      '--settings',
      CLAUDE_IMPLEMENTER_SETTINGS,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(outputSchema),
      ...(sessionId ? ['--resume', sessionId] : []),
    ];
  },
  // The same isolated offline environment and guards as for codex.
  processEnvironment({ environment, guardBin }) {
    const env = { ...environment };
    env.PATH = `${guardBin}:${env.PATH}`;
    return env;
  },
  sessionId(stdout) {
    const candidate = claudeEnvelope(stdout)?.session_id;
    return typeof candidate === 'string' && CLAUDE_SESSION_ID.test(candidate)
      ? candidate
      : undefined;
  },
  // Only a successful result object carries the round report: structured
  // output, or a JSON text result.
  output(stdout) {
    const envelope = claudeEnvelope(stdout);
    if (envelope?.type !== 'result' || envelope.is_error !== false)
      return undefined;
    if (
      envelope.structured_output &&
      typeof envelope.structured_output === 'object'
    )
      return { value: envelope.structured_output };
    if (typeof envelope.result === 'string')
      return { text: envelope.result.trim() };
    return undefined;
  },
  // The envelope's permission_denials; undefined when it has none.
  permissionDenials(stdout) {
    const denials = claudeEnvelope(stdout)?.permission_denials;
    if (!Array.isArray(denials)) return undefined;
    return denials.map((denial) => ({
      toolName: denial?.tool_name,
      toolInput: denial?.tool_input,
    }));
  },
  // Without --fork-session a resumed session keeps its ID.
  resumeKeepsSessionId: true,
  // The CLI sandbox lets Bash write in .git (confirmed by probes of
  // 2.1.285), and the CLI creates an empty .claude/.cc-writes when Bash
  // runs.
  gitDirectoryWritable: true,
  scratchDirectories: Object.freeze(['.claude/.cc-writes']),
  preflight({ version, platform }) {
    if (
      !versionInRange(
        version,
        CLAUDE_IMPLEMENTER_MIN_VERSION,
        CLAUDE_IMPLEMENTER_VERSION_LIMIT,
      )
    )
      return 'UNSUPPORTED_VERSION';
    if (!CLAUDE_SANDBOX_PLATFORMS.includes(platform))
      return 'UNSUPPORTED_PLATFORM';
    return undefined;
  },
});

const reviewer = Object.freeze({
  // Print mode, read-only tools, no persistence, no slash commands.
  processArgs({ model, effort, outputSchema }) {
    return [
      '-p',
      '--safe-mode',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--model',
      model,
      '--effort',
      effort,
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Glob,Grep',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(outputSchema),
    ];
  },
  processEnvironment({ environment }) {
    return { ...environment };
  },
  // The review inside the JSON envelope: structured output, a JSON text
  // result, or the review itself.
  reviewOutput(envelope) {
    if (envelope.structured_output) return { value: envelope.structured_output };
    if (typeof envelope.result === 'string')
      return { text: envelope.result.trim() };
    if (envelope.verdict) return { value: envelope };
    return undefined;
  },
  fallbackReason(text) {
    if (CLAUDE_FALLBACK_DENIAL_PATTERNS.some((pattern) => pattern.test(text)))
      return undefined;
    for (const [reason, patterns] of Object.entries(CLAUDE_FALLBACK_REASONS)) {
      if (patterns.some((pattern) => pattern.test(text))) return reason;
    }
    return undefined;
  },
});

export default defineProvider({
  id: 'claude',
  program: 'claude',
  versionArgs: ['--version'],
  roles: ['implementer', 'reviewer'],
  efforts: CLAUDE_EFFORTS,
  isValidModel: isValidModelId,
  implementer: {
    ...implementer,
    modes: ['implementation', 'analysis'],
    stability: 'experimental',
    limitations: [
      'Not for untrusted tasks: experimental implementer.',
      'Bash inside the CLI sandbox can write in .git; the core fingerprints the Git directory around every round and detects the change afterwards instead of preventing it.',
      'Background processes started by Bash run in another process group and can outlive the CLI.',
      'In print mode the CLI ignores invalid settings without an error; preflight therefore accepts only versions from 2.1.285 up to, but not including, 2.2.0.',
      'Admin-managed (policy) settings still apply.',
    ],
    security: {
      noApprovalPrompts: enforced(
        '--permission-mode dontAsk (analysis) or acceptEdits (implementation) with --permission-prompts none',
      ),
      sandboxByMode: enforced(
        'analysis: --tools Read,Glob,Grep; implementation: file tools confined by --restricted, Bash only inside the CLI sandbox (--settings sandbox.enabled, allowUnsandboxedCommands false, failIfUnavailable true)',
      ),
      noCommandNetwork: enforced(
        '--settings sandbox.network.allowedDomains [] with strictAllowlist; --disallowedTools WebFetch,WebSearch',
      ),
      noUserConfiguration: enforced(
        '--safe-mode, --restricted, --strict-mcp-config, --disable-slash-commands',
      ),
      pathGuards: enforced(
        'processEnvironment puts the core guard directory first on PATH',
      ),
      isolatedEnvironment: enforced(
        "processEnvironment passes the core's isolated offline environment unchanged apart from PATH",
      ),
      schemaOutput: enforced('--output-format json --json-schema <writer schema>'),
      explicitResume: enforced(
        '--resume <session ID> with the UUID session_id of the previous envelope; a resumed round must report the same ID',
      ),
      readOnlyTools: notSupported(
        'The implementer writes in implementation mode; analysis mode has read-only tools only.',
      ),
    },
  },
  reviewer: {
    ...reviewer,
    modes: ['implementation', 'analysis'],
    stability: 'experimental',
    limitations: [
      'Settings files are not ignored (no --restricted); admin-managed (policy) settings apply.',
    ],
    security: {
      noApprovalPrompts: enforced('--permission-mode dontAsk'),
      sandboxByMode: notSupported(
        'The reviewer has no command tool; it reads a read-only copy of the repository made by the core.',
      ),
      noCommandNetwork: notSupported(
        'The reviewer has no command or web tool (--tools Read,Glob,Grep); no network sandbox is configured.',
      ),
      noUserConfiguration: notSupported(
        '--safe-mode and --disable-slash-commands only; settings files are not ignored.',
      ),
      pathGuards: notSupported('The reviewer has no command tool; the core adds no guards.'),
      isolatedEnvironment: enforced(
        "processEnvironment passes the core's allowlisted environment unchanged",
      ),
      schemaOutput: enforced('--output-format json --json-schema <review schema>'),
      explicitResume: notSupported(
        'Every review attempt is a new session (--no-session-persistence).',
      ),
      readOnlyTools: enforced('--tools Read,Glob,Grep'),
    },
  },
});
