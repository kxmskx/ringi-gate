// Contract of a provider module (runner core). A provider module is code
// that describes one agent CLI: the roles it serves and their task modes,
// how it builds the argv and environment of a process, how it reads results
// and sessions, how it checks the host, and how it meets each safety
// guarantee.
// A profile can only pass module objects (providerModules); the core never
// loads a provider from a path or a command line.
//
// validateProviderModule reads a module through data descriptors only
// (getters never run), accepts plain objects and arrays only, rejects
// unknown fields, Symbol keys and proxies, and returns a frozen copy. It
// then applies the role rules (ROLE_REQUIREMENTS): a module that declares a
// role without the guarantees the core requires for it is refused. The
// runner core (agent-review-loop-lib.mjs) validates every module again when
// it loads it and keeps its own checks whatever a module declares.
import { types } from 'node:util';

export const PROVIDER_ROLES = Object.freeze(['implementer', 'reviewer']);
export const PROVIDER_TASK_MODES = Object.freeze(['implementation', 'analysis']);
export const PROVIDER_STABILITY = Object.freeze(['stable', 'experimental']);
export const GUARANTEE_STATUSES = Object.freeze(['enforced', 'not-supported']);

// The safety guarantees every role declares (the parity table of the codex
// and claude writers, plus read-only tools for the reviewer):
// - noApprovalPrompts: the CLI never waits for a person to approve an action;
// - sandboxByMode: commands and file tools run in a sandbox chosen by task
//   mode (writes confined to the working directory in implementation,
//   read-only in analysis);
// - noCommandNetwork: commands the agent runs reach no network host;
// - noUserConfiguration: user and project configuration of the CLI (rules,
//   hooks, plugins, MCP servers, settings files) is not loaded;
// - pathGuards: commands find the core's guard directory on PATH before any
//   other directory that holds a guarded command;
// - isolatedEnvironment: the process gets only the core's environment;
// - schemaOutput: the CLI constrains the result to the core's JSON schema;
// - explicitResume: a correction round resumes the session by its ID only;
// - readOnlyTools: the role has file reading tools only, in every mode.
export const GUARANTEES = Object.freeze([
  'noApprovalPrompts',
  'sandboxByMode',
  'noCommandNetwork',
  'noUserConfiguration',
  'pathGuards',
  'isolatedEnvironment',
  'schemaOutput',
  'explicitResume',
  'readOnlyTools',
]);

// Guarantees a role needs as 'enforced'; anything else refuses the module.
// The implementer also needs a preflight function (host and sandbox check);
// for the reviewer it is optional.
export const ROLE_REQUIREMENTS = Object.freeze({
  implementer: Object.freeze([
    'noApprovalPrompts',
    'sandboxByMode',
    'noCommandNetwork',
    'noUserConfiguration',
    'pathGuards',
    'isolatedEnvironment',
    'explicitResume',
  ]),
  reviewer: Object.freeze(['readOnlyTools']),
});

// Reasons a preflight may return; any other value also refuses the host.
export const PREFLIGHT_REASONS = Object.freeze([
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_PLATFORM',
]);

// Executables a provider may not name: the core's guarded tools, shells,
// interpreters, programs that run another program, and network clients (a
// provider is never a raw command line). Best effort: a list of known names,
// not a proof that a program cannot run arbitrary code; module review is the
// guarantee.
const RESERVED_PROGRAMS = new Set([
  'git',
  'pnpm',
  'corepack',
  'npm',
  'npx',
  'yarn',
  'yarnpkg',
  'bun',
  'bunx',
  'deno',
  'uv',
  'uvx',
  'pip',
  'pipx',
  'env',
  'sh',
  'dash',
  'fish',
  'csh',
  'tcsh',
  'powershell',
  'cmd',
  'osascript',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'sed',
  'busybox',
  'toybox',
  'sudo',
  'doas',
  'su',
  'runuser',
  'pkexec',
  'xargs',
  'exec',
  'command',
  'nohup',
  'timeout',
  'gtimeout',
  'nice',
  'stdbuf',
  'script',
  'caffeinate',
  'setsid',
  'chroot',
  'unshare',
  'nsenter',
  'systemd-run',
  'launchctl',
  'open',
  'time',
  'watch',
  'flock',
  'make',
  'docker',
  'podman',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ftp',
  'arch',
  'sandbox-exec',
  'tmux',
  'screen',
  'find',
  'expect',
  'unbuffer',
  'rlwrap',
  'strace',
  'ltrace',
  'dtruss',
  'gdb',
  'lldb',
  'valgrind',
  'ionice',
  'taskset',
  'chrt',
  'firejail',
  'bwrap',
  'fakeroot',
  'java',
  'jshell',
  'jrunscript',
  'vi',
  'vim',
  'nvim',
  'view',
  'ex',
  'ed',
  'emacs',
  'nano',
  'crontab',
  'at',
  'batch',
  'rscript',
  'swift',
]);
// Interpreters and shells with any version suffix, also after a hyphen or
// underscore (python3.12, perl5.34, node22, bash5, bash-5.2, zsh-5.9).
const RESERVED_PROGRAM_PATTERN =
  /^(?:python|pypy|perl|ruby|irb|php|node|nodejs|lua|luajit|tclsh|wish|bash|rbash|zsh|ksh|mksh|yash|ash|sh|dash|fish|csh|tcsh|pwsh)[-_.0-9]*$/;

function isReservedProgram(program) {
  const name = program.toLowerCase().replace(/\.exe$/, '');
  return RESERVED_PROGRAMS.has(name) || RESERVED_PROGRAM_PATTERN.test(name);
}

const MODULE_KEYS = new Set([
  'id',
  'program',
  'versionArgs',
  'roles',
  'efforts',
  'isValidModel',
  'implementer',
  'reviewer',
]);
const DECLARATION_KEYS = ['modes', 'stability', 'limitations', 'security'];
const ROLE_FUNCTIONS = Object.freeze({
  implementer: Object.freeze([
    'processArgs',
    'processEnvironment',
    'sessionId',
    'preflight',
  ]),
  reviewer: Object.freeze([
    'processArgs',
    'processEnvironment',
    'reviewOutput',
    'fallbackReason',
  ]),
});
// sandboxCheckArgs({ taskMode, command }) returns the argv that runs the
// core's check command in the CLI's sandbox of that task mode, without a
// model; the core runs it before every round (runSandboxCheck in
// agent-review-loop-lib.mjs) and checks it with forbiddenArgument (call
// 'sandboxCheck').
const OPTIONAL_IMPLEMENTER_FUNCTIONS = ['output', 'permissionDenials', 'sandboxCheckArgs'];
const OPTIONAL_IMPLEMENTER_FLAGS = ['resumeKeepsSessionId', 'gitDirectoryWritable'];
const ROLE_KEYS = Object.freeze({
  implementer: new Set([
    ...DECLARATION_KEYS,
    ...ROLE_FUNCTIONS.implementer,
    ...OPTIONAL_IMPLEMENTER_FUNCTIONS,
    ...OPTIONAL_IMPLEMENTER_FLAGS,
    'scratchDirectories',
    'probedVersions',
  ]),
  reviewer: new Set([
    ...DECLARATION_KEYS,
    ...ROLE_FUNCTIONS.reviewer,
    'preflight',
    'probedVersions',
  ]),
});
const GUARANTEE_KEYS = Object.freeze({
  enforced: new Set(['status', 'mechanism']),
  'not-supported': new Set(['status', 'reason']),
});

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_ARGUMENT = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const EFFORT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_TEXT_LENGTH = 500;
const MAX_LIST_ITEMS = 32;
// major.minor.patch without leading zeros or a pre-release or build suffix.
const CLI_VERSION = /^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}$/;
// The output of a version command: the version, optionally after one word
// ('codex-cli 0.160.0') or before a parenthesized name ('2.1.285 (Claude
// Code)'), on one line.
const CLI_VERSION_OUTPUT =
  /^(?:[A-Za-z][A-Za-z0-9._-]{0,31} )?([0-9]+\.[0-9]+\.[0-9]+)(?: \([A-Za-z0-9 ._-]{1,64}\))?$/;

// The major.minor.patch version read from the output of a CLI's version
// command, or undefined when the output has another form.
export function readCliVersion(output) {
  if (typeof output !== 'string') return undefined;
  const version = CLI_VERSION_OUTPUT.exec(output.trim())?.[1];
  return version !== undefined && CLI_VERSION.test(version) ? version : undefined;
}

// Whether a role was probed on the CLI version of this output. A role
// without probedVersions has no list to compare with and counts as probed (no
// warning); an output without a readable version counts as not probed. Only
// a warning (UNPROBED_VERSION): preflight alone accepts or refuses a host.
export function isProbedVersion(definition, output) {
  const probed = definition?.probedVersions;
  if (!probed) return true;
  const version = readCliVersion(output);
  return version !== undefined && probed.includes(version);
}

export class ProviderContractError extends Error {
  // kind: 'contract' (shape of the module) or 'role' (role rules).
  constructor(message, kind = 'contract') {
    super(message);
    this.name = 'ProviderContractError';
    this.kind = kind;
  }
}

// One model identifier: 1-128 ASCII letters, digits, '.', '_' or '-',
// starting with a letter or digit. The core applies it to every provider,
// together with the module's own isValidModel.
export function isValidModelId(value) {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^[A-Za-z0-9]/.test(value) &&
    !/[^A-Za-z0-9._-]/.test(value)
  );
}

// One session ID of a provider from a profile: 1-128 ASCII letters, digits,
// '.', '_', ':' or '-', starting with a letter or digit (never a flag). The
// core applies it to every session ID such a module reads or resumes.
export function isValidSessionId(value) {
  return (
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}

// The argv a module function returned, copied once through data descriptors
// into a new frozen array, or undefined. A proxy, an array with another
// prototype or with own fields besides its items (such as its own every or
// some), a hole, an accessor item or an item that is not a string without
// NUL refuses the argv. The core checks and runs only the copy, so a module
// cannot show one argv to the checks and another to the process.
export function copyProviderArgs(value, maxItems = 256) {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return undefined;
  const { value: length } = Object.getOwnPropertyDescriptor(value, 'length');
  if (length > maxItems || Reflect.ownKeys(value).length !== length + 1)
    return undefined;
  const copy = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.includes('\0')
    )
      return undefined;
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
}

function fail(path, message) {
  throw new ProviderContractError(`Provider module ${path}: ${message}.`);
}

function isText(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_TEXT_LENGTH &&
    !/[\x00-\x1f\x7f-\x9f]/.test(value)
  );
}

// Own string-keyed data properties of a plain object, as a new object.
function readRecord(value, path, allowedKeys) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(path, 'must be a plain object');
  const fields = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(path, 'has a Symbol key');
    if (allowedKeys && !allowedKeys.has(key))
      fail(path, `has an unknown field ${JSON.stringify(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value'))
      fail(`${path}.${key}`, 'must be a data property, not an accessor');
    fields[key] = descriptor.value;
  }
  return fields;
}

function readList(value, path, valid, { min = 0, max = MAX_LIST_ITEMS } = {}) {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    fail(path, 'must be an array');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    value.length < min ||
    value.length > max
  )
    fail(path, `must have ${min}-${max} items and no extra fields`);
  const items = Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      fail(`${path}[${index}]`, 'must be a data item');
    if (!valid(descriptor.value)) fail(`${path}[${index}]`, 'is not valid');
    return descriptor.value;
  });
  if (new Set(items).size !== items.length) fail(path, 'has duplicates');
  return Object.freeze(items);
}

function readFunction(value, path) {
  if (typeof value !== 'function' || types.isProxy(value))
    fail(path, 'must be a function');
  return value;
}

function readSecurity(value, path) {
  const fields = readRecord(value, path, new Set(GUARANTEES));
  const security = {};
  for (const guarantee of GUARANTEES) {
    if (!Object.hasOwn(fields, guarantee))
      fail(path, `does not declare ${guarantee}`);
    const entryPath = `${path}.${guarantee}`;
    const raw = readRecord(fields[guarantee], entryPath);
    if (!GUARANTEE_STATUSES.includes(raw.status))
      fail(entryPath, "status must be 'enforced' or 'not-supported'");
    const entry = readRecord(raw, entryPath, GUARANTEE_KEYS[raw.status]);
    const text = raw.status === 'enforced' ? 'mechanism' : 'reason';
    if (!isText(entry[text]))
      fail(entryPath, `needs a ${text} (1-${MAX_TEXT_LENGTH} characters)`);
    security[guarantee] = Object.freeze({
      status: entry.status,
      [text]: entry[text],
    });
  }
  return Object.freeze(security);
}

// A repository-relative directory path without '.', '..' or .git segments.
function isScratchDirectory(value) {
  return (
    isText(value) &&
    !value.includes('\\') &&
    value
      .split('/')
      .every(
        (segment) =>
          segment &&
          segment !== '.' &&
          segment !== '..' &&
          segment.toLowerCase() !== '.git',
      )
  );
}

function readRole(value, role, path) {
  const fields = readRecord(value, path, ROLE_KEYS[role]);
  const definition = {
    modes: readList(
      fields.modes,
      `${path}.modes`,
      (mode) => PROVIDER_TASK_MODES.includes(mode),
      { min: 1, max: PROVIDER_TASK_MODES.length },
    ),
    stability: PROVIDER_STABILITY.includes(fields.stability)
      ? fields.stability
      : fail(`${path}.stability`, "must be 'stable' or 'experimental'"),
    limitations: readList(fields.limitations, `${path}.limitations`, isText),
    security: readSecurity(fields.security, `${path}.security`),
  };
  for (const name of ROLE_FUNCTIONS[role]) {
    if (role === 'implementer' && name === 'preflight') continue;
    definition[name] = readFunction(fields[name], `${path}.${name}`);
  }
  if (role === 'implementer') {
    // Checked by the role rules below, so that a missing preflight is a
    // refused role rather than a shape error.
    if (Object.hasOwn(fields, 'preflight'))
      definition.preflight = readFunction(fields.preflight, `${path}.preflight`);
    for (const name of OPTIONAL_IMPLEMENTER_FUNCTIONS) {
      if (Object.hasOwn(fields, name))
        definition[name] = readFunction(fields[name], `${path}.${name}`);
    }
    for (const name of OPTIONAL_IMPLEMENTER_FLAGS) {
      if (!Object.hasOwn(fields, name)) continue;
      if (typeof fields[name] !== 'boolean')
        fail(`${path}.${name}`, 'must be a boolean');
      definition[name] = fields[name];
    }
    if (Object.hasOwn(fields, 'scratchDirectories'))
      definition.scratchDirectories = readList(
        fields.scratchDirectories,
        `${path}.scratchDirectories`,
        isScratchDirectory,
        { max: 4 },
      );
  }
  // Optional for the reviewer: the same host check as the implementer's,
  // called before the first review.
  if (role === 'reviewer' && Object.hasOwn(fields, 'preflight'))
    definition.preflight = readFunction(fields.preflight, `${path}.preflight`);
  // Optional for both roles: the CLI versions (major.minor.patch) the
  // declarations were probed on; any other version gets UNPROBED_VERSION.
  if (Object.hasOwn(fields, 'probedVersions'))
    definition.probedVersions = readList(
      fields.probedVersions,
      `${path}.probedVersions`,
      (version) => typeof version === 'string' && CLI_VERSION.test(version),
      { min: 1 },
    );
  return Object.freeze(definition);
}

// Role rules: a declared role whose declaration misses a required guarantee
// (absent or 'not-supported'), or an implementer without preflight, refuses
// the whole module.
export function roleRuleViolations(module) {
  const violations = [];
  for (const role of PROVIDER_ROLES) {
    const definition = module[role];
    if (!definition) continue;
    for (const guarantee of ROLE_REQUIREMENTS[role]) {
      if (definition.security?.[guarantee]?.status !== 'enforced')
        violations.push(`${role}: ${guarantee} is not enforced`);
    }
    if (role === 'implementer' && typeof definition.preflight !== 'function')
      violations.push('implementer: no preflight');
  }
  return violations;
}

const VALIDATED = new WeakSet();

export function isValidatedProviderModule(value) {
  return VALIDATED.has(value);
}

export function validateProviderModule(value) {
  if (VALIDATED.has(value)) return value;
  const fields = readRecord(value, 'provider', MODULE_KEYS);
  for (const key of ['id', 'program', 'versionArgs', 'roles', 'efforts', 'isValidModel']) {
    if (!Object.hasOwn(fields, key)) fail('provider', `has no ${key}`);
  }
  if (typeof fields.id !== 'string' || !PROVIDER_ID.test(fields.id))
    fail('provider.id', 'must match [a-z][a-z0-9-]{0,31}');
  const path = `provider ${fields.id}`;
  if (
    typeof fields.program !== 'string' ||
    !PROGRAM_NAME.test(fields.program) ||
    isReservedProgram(fields.program)
  )
    fail(`${path}.program`, 'must be a bare executable name that is not reserved');
  const versionArgs = readList(
    fields.versionArgs,
    `${path}.versionArgs`,
    (arg) => typeof arg === 'string' && VERSION_ARGUMENT.test(arg),
    { min: 1, max: 4 },
  );
  if (forbiddenArgument(fields.program, versionArgs))
    fail(`${path}.versionArgs`, 'has a forbidden argument');
  const roles = readList(
    fields.roles,
    `${path}.roles`,
    (role) => PROVIDER_ROLES.includes(role),
    { min: 1, max: PROVIDER_ROLES.length },
  );
  const module = {
    id: fields.id,
    program: fields.program,
    versionArgs,
    roles,
    efforts: readList(
      fields.efforts,
      `${path}.efforts`,
      (effort) => typeof effort === 'string' && EFFORT_NAME.test(effort),
      { min: 1, max: 8 },
    ),
    isValidModel: readFunction(fields.isValidModel, `${path}.isValidModel`),
  };
  for (const role of PROVIDER_ROLES) {
    const declared = roles.includes(role);
    if (declared !== Object.hasOwn(fields, role))
      fail(`${path}.${role}`, 'must be present exactly when roles lists it');
    if (declared) module[role] = readRole(fields[role], role, `${path}.${role}`);
  }
  const violations = roleRuleViolations(module);
  if (violations.length > 0)
    throw new ProviderContractError(
      `Provider module ${path} cannot serve its roles: ${violations.join('; ')}.`,
      'role',
    );
  const frozen = Object.freeze(module);
  VALIDATED.add(frozen);
  return frozen;
}

// For provider authors: the validated, frozen module (or a thrown
// ProviderContractError).
export function defineProvider(definition) {
  return validateProviderModule(definition);
}

// Arguments that turn off approvals, the sandbox or network blocking. The
// general rules apply to every program; the program rules add what is known
// about specific CLIs (a list of bypass flags, not a claim of support). It is
// a safety net against known mistakes, not a guarantee: an argv without a
// listed pattern can still weaken a CLI, and only review of the module shows
// that its argv keeps its declarations.
const FORBIDDEN_FLAG_WORDS = [
  /dangerous/,
  /bypass/,
  /yolo/,
  /skip-?permissions?/,
  /no-?sandbox/,
  /unsandboxed/,
  /full-?auto/,
  /auto-?approve/,
  /always-?approve/,
  /yes-?always/,
  /trust-?all/,
  /allow-?all/,
];
const FORBIDDEN_SUBSTRINGS = [
  /bypasspermissions/i,
  /danger-full-access/i,
  /dangerously/i,
  /"allowUnsandboxedCommands"\s*:\s*true/,
  /network_access\s*=\s*true/i,
];
const FORBIDDEN_VALUES = new Set(['yolo']);

// Long flags are compared case-insensitively; short flags (-c, -C) are not.
const flagName = (arg) => {
  const name = arg.split('=')[0];
  return name.startsWith('--') ? name.toLowerCase() : name;
};
// Name and value of a flag for the program rules: --name=value, -x=value
// and, for a short option with a program rule, an attached value (-aX, -cX
// and -sX are read as -a X, -c X and -s X); otherwise the next argument.
function flagParts(args, index, programFlags) {
  const arg = args[index];
  const short = arg.slice(0, 2);
  if (!arg.startsWith('--') && arg.length > 2 && Object.hasOwn(programFlags, short))
    return { name: short, value: arg.slice(arg[2] === '=' ? 3 : 2), attached: true };
  const attached = arg.includes('=');
  return {
    name: flagName(arg),
    value: attached ? arg.slice(arg.indexOf('=') + 1) : args[index + 1],
    attached,
  };
}
const valueOutside = (allowed) => (value) => !allowed.includes(value);

// A codex -c/--config override key=value, read by its key with quotes and
// whitespace removed: no sandbox, approval, environment, MCP, notify or
// profile setting, of the sandbox_workspace_write table only
// network_access=false (an inline table such as
// sandbox_workspace_write={writable_roots=[...]} is refused), and
// allow_login_shell only as false (a login shell puts its profiles' PATH
// before the guard directory). In the sandbox check call only (codex
// sandbox has no -s), sandbox_mode may name read-only or workspace-write,
// and the stricter exclude_tmpdir_env_var and exclude_slash_tmp may be true.
const CODEX_CONFIG_FORBIDDEN =
  /^(?:sandbox_mode|approval_policy|shell_environment_policy|mcp_servers|notify|profiles?)(?:\.|$)/;
const CODEX_SANDBOX_CHECK_EXCLUDES = [
  'sandbox_workspace_write.exclude_tmpdir_env_var',
  'sandbox_workspace_write.exclude_slash_tmp',
];
function codexConfig(value, { call } = {}) {
  const text = value ?? '';
  const separator = text.indexOf('=');
  const key = (separator === -1 ? text : text.slice(0, separator)).replace(
    /["'\s]/g,
    '',
  );
  const setting =
    separator === -1 ? undefined : text.slice(separator + 1).replace(/["'\s]/g, '');
  if (call === 'sandboxCheck' && key === 'sandbox_mode')
    return !['read-only', 'workspace-write'].includes(setting);
  if (call === 'sandboxCheck' && CODEX_SANDBOX_CHECK_EXCLUDES.includes(key))
    return setting !== 'true';
  if (CODEX_CONFIG_FORBIDDEN.test(key)) return true;
  if (key === 'sandbox_workspace_write.network_access' || key === 'allow_login_shell')
    return text.slice(separator + 1).trim() !== 'false';
  return key === 'sandbox_workspace_write' || key.startsWith('sandbox_workspace_write.');
}

// Claude Code settings passed with --settings must be inline JSON (a
// settings file cannot be inspected) without keys that run commands outside
// the sandbox, change the environment or permissions, enable MCP servers or
// plugins, and without a sandbox that is not enabled, lets commands run
// outside it, has excluded commands, allows a network host, Unix sockets,
// local binding or proxy ports. For the implementer role the settings must
// also have a sandbox with enabled and failIfUnavailable true (without it
// the CLI runs commands unsandboxed). The checks read the parsed JSON, so
// keys written with escapes (enabled) are read as Claude Code reads them.
const CLAUDE_FORBIDDEN_SETTINGS = [
  'hooks',
  'apiKeyHelper',
  'statusLine',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper',
  'env',
  'permissions',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'enabledPlugins',
  'extraKnownMarketplaces',
];
const CLAUDE_FORBIDDEN_SANDBOX_NETWORK = [
  'allowUnixSockets',
  'allowAllUnixSockets',
  'allowLocalBinding',
  'httpProxyPort',
  'socksProxyPort',
];
const isJsonObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function claudeSettings(value, { role } = {}) {
  let settings;
  try {
    settings = JSON.parse(value);
  } catch {
    return true;
  }
  if (!isJsonObject(settings)) return true;
  if (CLAUDE_FORBIDDEN_SETTINGS.some((key) => Object.hasOwn(settings, key)))
    return true;
  if (!Object.hasOwn(settings, 'sandbox')) return role === 'implementer';
  const { sandbox } = settings;
  if (!isJsonObject(sandbox)) return true;
  if (role === 'implementer' && sandbox.failIfUnavailable !== true) return true;
  if (Object.hasOwn(sandbox, 'network') && !isJsonObject(sandbox.network))
    return true;
  const network = sandbox.network ?? {};
  const domains = network.allowedDomains;
  return (
    sandbox.enabled !== true ||
    (Object.hasOwn(sandbox, 'allowUnsandboxedCommands') &&
      sandbox.allowUnsandboxedCommands !== false) ||
    Object.hasOwn(sandbox, 'excludedCommands') ||
    CLAUDE_FORBIDDEN_SANDBOX_NETWORK.some((key) => Object.hasOwn(network, key)) ||
    (domains !== undefined && !(Array.isArray(domains) && domains.length === 0))
  );
}

// A reviewer's --tools (a variadic option) lists file reading tools only.
// Its values end at the next option; a lone '-' is a value (and not a
// reading tool), not the end of the list.
const CLAUDE_REVIEWER_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];
function claudeReviewerTools(value, { args, index, role, attached }) {
  if (role !== 'reviewer') return false;
  const values = [];
  if (attached) values.push(value);
  else
    for (
      let next = index + 1;
      next < args.length && (args[next] === '-' || !args[next].startsWith('-'));
      next += 1
    )
      values.push(args[next]);
  const tools = values.flatMap((item) => item.split(/[\s,]+/)).filter(Boolean);
  return (
    values.length === 0 ||
    tools.some((tool) => !CLAUDE_REVIEWER_TOOLS.includes(tool))
  );
}

// Per program: flag name -> true (always forbidden) or a function of the
// flag's value (and { args, index, role, attached }) telling whether it is
// forbidden.
export const FORBIDDEN_PROGRAM_FLAGS = Object.freeze({
  codex: Object.freeze({
    '--dangerously-bypass-approvals-and-sandbox': true,
    '--full-auto': true,
    '--yolo': true,
    '--add-dir': true,
    '--search': true,
    '--profile': true,
    '-p': true,
    '-s': valueOutside(['read-only', 'workspace-write']),
    '--sandbox': valueOutside(['read-only', 'workspace-write']),
    '-a': valueOutside(['never']),
    '--ask-for-approval': valueOutside(['never']),
    '-c': codexConfig,
    '--config': codexConfig,
    // Options of codex sandbox that widen or replace the sandbox policy.
    '--sandbox-state-json': true,
    '--sandbox-state-readable-root': true,
    '--allow-unix-socket': true,
    '-P': true,
    '--permission-profile': true,
    '--include-managed-config': true,
    '--enable': true,
    '--disable': true,
  }),
  claude: Object.freeze({
    '--dangerously-skip-permissions': true,
    '--allow-dangerously-skip-permissions': true,
    '--add-dir': true,
    '--allowedtools': true,
    '--allowed-tools': true,
    '--mcp-config': true,
    '--plugin-dir': true,
    '--setting-sources': true,
    '--permission-mode': valueOutside(['dontAsk', 'acceptEdits']),
    '--settings': claudeSettings,
    '--tools': claudeReviewerTools,
  }),
  gemini: Object.freeze({
    '-y': true,
    '--yolo': true,
    '--approval-mode': valueOutside(['default']),
  }),
  aider: Object.freeze({
    '--yes-always': true,
  }),
});

// Flags an argv of a program must contain in a role: without --tools a
// claude reviewer would get the CLI's default tools, without --settings
// (and its sandbox) a claude implementer would run commands unsandboxed.
const REQUIRED_PROGRAM_FLAGS = Object.freeze({
  claude: Object.freeze({
    reviewer: Object.freeze(['--tools']),
    implementer: Object.freeze(['--settings']),
  }),
});

// The first forbidden argument of argv for program, or undefined. Elements
// equal to an exempt value (values the core itself passed: paths, model,
// schema and, for the built-in providers, the session ID) are not inspected.
// role ('implementer' or 'reviewer') selects the rules of one role, such as
// the read-only --tools of a claude reviewer. call 'sandboxCheck' marks the
// argv of a module's sandboxCheckArgs (codex: sandbox_mode as -c). A missing
// required flag is reported at index args.length with rule 'missing'.
export function forbiddenArgument(program, args, { exempt = [], role, call } = {}) {
  const name = String(program).toLowerCase();
  const programFlags = Object.hasOwn(FORBIDDEN_PROGRAM_FLAGS, name)
    ? FORBIDDEN_PROGRAM_FLAGS[name]
    : {};
  const required =
    Object.hasOwn(REQUIRED_PROGRAM_FLAGS, name) &&
    Object.hasOwn(REQUIRED_PROGRAM_FLAGS[name], role)
      ? REQUIRED_PROGRAM_FLAGS[name][role]
      : [];
  const skip = new Set(exempt.filter((value) => typeof value === 'string'));
  for (const flag of required) {
    if (!args.some((arg) => !skip.has(arg) && flagName(arg) === flag))
      return { index: args.length, argument: flag, rule: 'missing' };
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (skip.has(arg)) continue;
    const found = (rule) => ({ index, argument: arg, rule });
    if (FORBIDDEN_SUBSTRINGS.some((pattern) => pattern.test(arg)))
      return found('general');
    if (FORBIDDEN_VALUES.has(arg.toLowerCase())) return found('general');
    if (!arg.startsWith('-')) continue;
    const name = flagName(arg);
    if (FORBIDDEN_FLAG_WORDS.some((pattern) => pattern.test(name)))
      return found('general');
    if (
      arg.includes('=') &&
      FORBIDDEN_VALUES.has(arg.slice(arg.indexOf('=') + 1).toLowerCase())
    )
      return found('general');
    const parts = flagParts(args, index, programFlags);
    if (Object.hasOwn(programFlags, parts.name)) {
      const rule = programFlags[parts.name];
      if (
        rule === true ||
        rule(parts.value, { args, index, role, call, attached: parts.attached })
      )
        return found(program);
    }
  }
  return undefined;
}
