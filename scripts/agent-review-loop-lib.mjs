import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import * as nodeModule from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  chmod,
  copyFile,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { inflateSync } from 'node:zlib';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  SOL_PHASE_OWNERSHIP_CONTRACT,
  buildClaudePrompt,
  buildCodexPrompt,
} from './agent-review-prompts.mjs';
import {
  CODEX_MODEL,
  DEFAULT_IMPLEMENTER,
  DEFAULT_REVIEW_PROFILE,
  DEFAULT_REVIEWER,
  DEFAULT_SOL_EFFORT,
  REVIEW_PROFILES,
  SOL_EFFORTS,
} from './agent-review-providers.mjs';
import claudeProvider from './providers/claude.mjs';
import codexProvider from './providers/codex.mjs';
import {
  ProviderContractError,
  copyProviderArgs,
  forbiddenArgument,
  isValidModelId,
  isValidSessionId,
  isValidatedProviderModule,
  roleRuleViolations,
  validateProviderModule,
} from './providers/contract.mjs';
import {
  DEFAULT_LOCALE,
  currentLocale,
  isLocale,
  msg,
  t,
  withLocale,
} from './messages/index.mjs';

// Moved to the providers module; re-exported for compatibility.
export {
  CODEX_MODEL,
  DEFAULT_REVIEW_PROFILE,
  DEFAULT_SOL_EFFORT,
  REVIEW_PROFILES,
  SOL_EFFORTS,
};

// Presentation projections are deliberately smaller than validated agent reports.
// No free-form report text, tool arguments, output or reasoning crosses this API.
export const MAX_ACTIVITY_ITEMS = 6;
export const MAX_ACTIVITY_BYTES = 1536;
export const MAX_CODEX_ACTIVITY_LINE_BYTES = 64 * 1024;
const ACTIVITY_STATUSES = ['ACTIVE', 'PASS', 'FAIL'];
const ACTIVITY_TYPES = [
  'WORK',
  'COMMAND',
  'TEST',
  'FILE',
  'SEARCH',
  'TOOL',
  'SNAPSHOT',
  'REVIEW',
  'SUMMARY',
];
const AGENT_COMPLETIONS = [
  'COMPLETED',
  'NEEDS_HUMAN_DECISION',
  'NEEDS_PERMISSION',
  'BLOCKED',
];

export function normalizeActivityPath(value) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > 180 ||
    /[\x00-\x20\x7f-\x9f]/.test(value) ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) ||
    value
      .split('/')
      .some(
        (part) =>
          part === '.' ||
          part === '..' ||
          part.length > 80 ||
          ['.git', '.agent-review-loop', 'node_modules'].includes(part) ||
          isSuspiciousSecretPath(part),
      ) ||
    !/\.(?:[cm]?[jt]sx?|md|json|ya?ml|css|scss|html|sql|prisma|txt|svg|toml)$/.test(
      value,
    ) ||
    redactSensitive(value) !== value
  )
    return null;
  return value;
}

export function normalizeActivityEntry(value, role) {
  if (!value || !['ASTRA', 'CLAUDE'].includes(role)) return null;
  const allowed =
    role === 'ASTRA'
      ? ['WORK', 'COMMAND', 'TEST', 'FILE', 'SEARCH', 'TOOL', 'SUMMARY']
      : ['SNAPSHOT', 'REVIEW', 'SUMMARY'];
  if (!ACTIVITY_TYPES.includes(value.type) || !allowed.includes(value.type))
    return null;
  if (value.type === 'SUMMARY') {
    if (role === 'ASTRA') {
      if (
        !AGENT_COMPLETIONS.includes(value.status) ||
        !Number.isSafeInteger(value.changes) ||
        value.changes < 0 ||
        value.changes > 100000
      )
        return null;
      return { type: 'SUMMARY', status: value.status, changes: value.changes };
    }
    if (
      !['APPROVE', 'REQUEST_CHANGES'].includes(value.status) ||
      !Number.isSafeInteger(value.checks) ||
      value.checks < 0 ||
      value.checks > 100000 ||
      !Array.isArray(value.findings) ||
      value.findings.length !== 4 ||
      !value.findings.every(
        (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100000,
      )
    )
      return null;
    return {
      type: 'SUMMARY',
      status: value.status,
      checks: value.checks,
      findings: [...value.findings],
    };
  }
  if (!ACTIVITY_STATUSES.includes(value.status)) return null;
  if (value.type === 'FILE') {
    const path = normalizeActivityPath(value.path);
    if (!path || !['add', 'update', 'delete'].includes(value.operation))
      return null;
    return {
      type: 'FILE',
      status: value.status,
      operation: value.operation,
      path,
    };
  }
  return { type: value.type, status: value.status };
}

export function normalizeActivityFeed(value, role) {
  if (!Array.isArray(value)) return [];
  const entries = value
    .slice(-MAX_ACTIVITY_ITEMS)
    .map((entry) => normalizeActivityEntry(entry, role))
    .filter(Boolean);
  while (Buffer.byteLength(JSON.stringify(entries)) > MAX_ACTIVITY_BYTES)
    entries.shift();
  return entries;
}

// Incremental JSONL framing keeps at most one bounded line, drops oversized lines
// through LF, and never forwards raw chunks. A broken observer is presentation only.
export function createCodexActivityParser(onActivity = () => {}) {
  const storage = Buffer.alloc(MAX_CODEX_ACTIVITY_LINE_BYTES);
  let bytes = 0;
  let dropping = false;
  let ended = false;
  const emit = (entry) => {
    try {
      const safe = normalizeActivityEntry(entry, 'ASTRA');
      if (safe) onActivity(safe);
    } catch {
      /* Presentation cannot fail the process. */
    }
  };
  function line(buffer) {
    try {
      const event = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer),
      );
      if (!event || typeof event !== 'object') return;
      if (event.type === 'turn.started')
        emit({ type: 'WORK', status: 'ACTIVE' });
      else if (event.type === 'turn.completed')
        emit({ type: 'WORK', status: 'PASS' });
      else if (event.type === 'turn.failed')
        emit({ type: 'WORK', status: 'FAIL' });
      else if (['item.started', 'item.completed'].includes(event.type)) {
        const item = event.item;
        if (!item || typeof item !== 'object') return;
        const status =
          event.type === 'item.started'
            ? item.status === 'in_progress'
              ? 'ACTIVE'
              : null
            : item.status === 'completed'
              ? 'PASS'
              : item.status === 'failed'
                ? 'FAIL'
                : null;
        if (!status) return;
        if (item.type === 'command_execution') {
          // Exact allowlist only; never parse or display arbitrary shell text.
          const isTest = ['pnpm test', 'pnpm test:integration'].includes(
            item.command,
          );
          if (
            status === 'PASS' &&
            (!Number.isSafeInteger(item.exit_code) ||
              item.exit_code < 0 ||
              item.exit_code > 255)
          )
            return;
          const commandStatus =
            status === 'PASS' && item.exit_code !== 0 ? 'FAIL' : status;
          emit({ type: isTest ? 'TEST' : 'COMMAND', status: commandStatus });
        } else if (item.type === 'file_change' && Array.isArray(item.changes)) {
          for (const change of item.changes.slice(0, MAX_ACTIVITY_ITEMS))
            if (change)
              emit({
                type: 'FILE',
                status,
                operation: change.kind,
                path: change.path,
              });
        } else if (item.type === 'web_search') emit({ type: 'SEARCH', status });
        else if (item.type === 'mcp_tool_call') emit({ type: 'TOOL', status });
      }
    } catch {
      /* Malformed, unknown and unsafe events carry no observable fact. */
    }
  }
  return {
    push(chunk) {
      if (ended) return;
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < buffer.length) {
          const newline = buffer.indexOf(10, offset);
          const end = newline === -1 ? buffer.length : newline;
          const size = end - offset;
          if (!dropping && bytes + size <= MAX_CODEX_ACTIVITY_LINE_BYTES) {
            if (size) buffer.copy(storage, bytes, offset, end);
            bytes += size;
          } else {
            dropping = true;
            bytes = 0;
          }
          if (newline === -1) break;
          if (!dropping) line(storage.subarray(0, bytes));
          bytes = 0;
          dropping = false;
          offset = newline + 1;
        }
      } catch {
        bytes = 0;
        dropping = true;
      }
    },
    end() {
      // An unterminated final line is not a complete event.
      ended = true;
      storage.fill(0);
      bytes = 0;
    },
  };
}

const MAX_TASK_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_GIT_PATH_LIST_BYTES = 4 * 1024 * 1024;
const MAX_GIT_SCALAR_BYTES = 64 * 1024;
const MAX_AGENT_STRUCTURED_BYTES = 4 * 1024 * 1024;
const MAX_ANALYSIS_ARTIFACT_BYTES = 512 * 1024;
const MAX_ANALYSIS_REVIEW_FILES = 32;
const MAX_ANALYSIS_REVIEW_FILES_BYTES = 32 * 1024 * 1024;
const MAX_COREPACK_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_COREPACK_CACHE_ENTRIES = 5_000;
const MAX_DEPENDENCY_METADATA_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DEPENDENCY_METADATA_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DEPENDENCY_INPUT_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_LOG_BYTES = 128 * 1024;
const MAX_SAVED_LOG_BYTES = 16 * 1024;
const MAX_GATE_SUMMARY_BYTES = 2 * 1024;
const MAX_ROUNDS = 3;
const MAX_FINDING_RESPONSE_CHECK_CHARACTERS = 500;
const ANALYSIS_COMPLETENESS_SENTINEL = '<!-- SOL_FULL_ANALYSIS_COMPLETE -->';
const ANALYSIS_FINDING_FILE = 'analysis-artifact.md';
const ANALYSIS_TRUNCATION_PATTERNS = [
  /…\[(?:log|podsumowanie|wynik|analiza)[^\]]*obcięt[^\]]*\]…/iu,
  /…\[log pominięt[^\]]*\]…/iu,
  // The same runner markers in the 'en' locale.
  /…\[(?:log|summary)[^\]]*(?:truncated|omitted)[^\]]*\]…/iu,
  /…\[(?:truncated|output truncated)[^\]]*\]…/iu,
  /…\s*\d+\s+tokens?\s+truncated\s*…/iu,
  /\[(?:truncated|output truncated)\]/iu,
  /\bwarning:\s*truncated output\b/iu,
  /\btruncated output\s*\(original token count\b/iu,
  /\b(?:content|output|response)\s+(?:was\s+)?truncated\b/iu,
];
const FINDING_ID_PREFIX = 'finding-';
const FINDING_RESPONSE_FIELDS = [
  'findingId',
  'status',
  'analysis',
  'evidence',
  'fix',
  'regressionTest',
  'checks',
  'question',
];
const FINDING_RESPONSE_RESERVED_RESULT_FIELDS = [
  'status',
  'changes',
  'checks',
  'deferred',
  'summary',
  'findingResponses',
  'fullAnalysis',
  ...FINDING_RESPONSE_FIELDS,
];
const FINDING_RESPONSE_CHECK_FORBIDDEN_MARKERS = [
  'SOL_FULL_ANALYSIS_COMPLETE',
  'truncated',
  'obcięt',
  'ucięt',
  'log pominięt',
  'log omitted',
];
const FINDING_RESPONSE_CHECK_SCHEMA_PATTERN =
  '^[^\\s\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]([^\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]*[^\\s\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029])?$';
const FINDING_RESPONSE_CHECK_SCHEMA_REGEX = new RegExp(
  FINDING_RESPONSE_CHECK_SCHEMA_PATTERN,
  'u',
);
const FINDING_RESPONSE_RESERVED_RESULT_FIELD_SET = new Set(
  FINDING_RESPONSE_RESERVED_RESULT_FIELDS.map((field) => field.toLowerCase()),
);
const MIN_ANALYSIS_ARTIFACT_FRAGMENT_CHARACTERS = 80;
const FINDING_SEVERITIES = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'];
const UNRESOLVED_FINDING_SEVERITIES = new Set(FINDING_SEVERITIES);
const COREPACK_INTEGRITY_HEX_LENGTHS = new Map([
  ['sha1', 40],
  ['sha224', 56],
  ['sha256', 64],
  ['sha384', 96],
  ['sha512', 128],
]);
const SEMVER_NUMBER = '(?:0|[1-9]\\d*)';
const SEMVER_PRERELEASE_IDENTIFIER =
  '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const EXACT_SEMVER_PATTERN = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?$`,
);
const STATE_DIRECTORY = '.agent-review-loop';
const REQUIRED_DEPENDENCY_METADATA_PATHS = [
  'node_modules/.modules.yaml',
  'node_modules/.pnpm/lock.yaml',
];
const OPTIONAL_DEPENDENCY_METADATA_PATHS = [
  'node_modules/.pnpm-workspace-state-v1.json',
];
const BLOCKED_PACKAGE_MANAGERS = [
  'npm',
  'npx',
  'yarn',
  'yarnpkg',
  'bun',
  'bunx',
];
const DEPENDENCY_INPUT_NAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnp.cjs',
  '.pnp.loader.mjs',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
]);
const ISOLATED_NPMRC = '';
const WORKING_BRANCHES_BLOCKED = new Set(['main', 'master']);
const SNAPSHOT_EXCLUDED_SEGMENTS = new Set([
  STATE_DIRECTORY,
  'node_modules',
  '.pnpm-store',
  '.next',
  'dist',
  'coverage',
  '.turbo',
  '.cache',
  'tmp',
  'playwright-report',
  'test-results',
]);
// Task sections come from the profile's taskSchema. The core reads three of
// them (task class, required checks, review files); a schema declares each
// under its Polish or English canonical name. When a schema declares both,
// the Polish one is the section the core reads, as before the English names.
const TASK_SCHEMA_ROLES = Object.freeze({
  taskClass: Object.freeze(['klasa zadania', 'task class']),
  requiredChecks: Object.freeze(['wymagane kontrole', 'required checks']),
  reviewFiles: Object.freeze(['pliki review', 'review files']),
});

// The names of the sections the core reads, in the given schema; undefined
// for a role the schema does not declare (an invalid schema).
function taskSchemaRoles({ requiredSections, optionalSections }) {
  const declared = new Set([...requiredSections, ...optionalSections]);
  return Object.fromEntries(
    Object.entries(TASK_SCHEMA_ROLES).map(([role, names]) => [
      role,
      names.find((name) => declared.has(name)),
    ]),
  );
}

// Default schemas, one per locale: the same sections with the canonical names
// in the language of the profile and the names of the other language (and
// "deferred") as aliases, so a task file in either language parses with both.
// Names are kept in normalized heading form (see normalizeHeading).
// Resolved forms of the default en schema. Its names were aliases before
// they became canonical, so a repeated heading stays an error there.
const STRICT_DUPLICATE_TASK_SCHEMAS = new WeakSet();

const DEFAULT_TASK_SCHEMAS = Object.freeze({
  en: Object.freeze({
    version: 1,
    requiredSections: Object.freeze([
      'goal',
      'scope',
      'acceptance criteria',
      'required checks',
      'constraints',
      'deferred items',
    ]),
    optionalSections: Object.freeze([
      'task class',
      'starting files',
      'allowed change area',
      'review files',
    ]),
    aliases: Object.freeze({
      cel: 'goal',
      zakres: 'scope',
      'kryteria akceptacji': 'acceptance criteria',
      'wymagane kontrole': 'required checks',
      ograniczenia: 'constraints',
      deferred: 'deferred items',
      'elementy odłożone': 'deferred items',
      'klasa zadania': 'task class',
      'pliki startowe': 'starting files',
      'dozwolony obszar zmian': 'allowed change area',
      'pliki review': 'review files',
    }),
  }),
  pl: Object.freeze({
    version: 1,
    requiredSections: Object.freeze([
      'cel',
      'zakres',
      'kryteria akceptacji',
      'wymagane kontrole',
      'ograniczenia',
      'elementy odłożone',
    ]),
    optionalSections: Object.freeze([
      'klasa zadania',
      'pliki startowe',
      'dozwolony obszar zmian',
      'pliki review',
    ]),
    aliases: Object.freeze({
      goal: 'cel',
      scope: 'zakres',
      'acceptance criteria': 'kryteria akceptacji',
      'required checks': 'wymagane kontrole',
      constraints: 'ograniczenia',
      deferred: 'elementy odłożone',
      'deferred items': 'elementy odłożone',
      'task class': 'klasa zadania',
      'starting files': 'pliki startowe',
      'allowed change area': 'dozwolony obszar zmian',
      'review files': 'pliki review',
    }),
  }),
});
const TASK_SCHEMA_KEYS = new Set([
  'version',
  'requiredSections',
  'optionalSections',
  'aliases',
]);
const MAX_TASK_SCHEMA_VERSION = 1_000_000;
const MAX_TASK_SECTION_NAME_LENGTH = 100;
const MAX_TASK_SCHEMA_ALIASES = 256;
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'check-attr',
  'check-ignore',
  'describe',
  'diff',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
]);

// The gate registry (checks, default sets, nested pnpm invocations, path rules)
// comes from the runner profile. The core accepts only programs it can guard.
const CHECK_PROGRAMS = new Set(['pnpm', 'git']);
// The only non-script pnpm argv the guard passes through unchanged.
const PNPM_VERSION_ARGV = new Set(['--version', '-v']);
// pnpm argv in checks and nestedInvocations has one of the shapes [script],
// ['run', script], ['--filter', package, script] or
// ['--filter', package, 'run', script]. No other options are accepted.
// Whatever shape the profile uses, runChecks and the pnpm guard execute the
// explicit form [--filter package] run script (pnpmRunArgv): `pnpm run` only
// runs a package script and never falls back to a built-in command or to
// `exec` of a binary with the same name.
// A script name is a letter or digit followed by letters, digits, ':', '.',
// '_' or '-'. As an extra profile check, the name must not be a pnpm
// built-in command (or alias, or a command pnpm forwards to npm); the list
// depends on the pnpm version, so the run form above is what is relied on.
// 'test' stays allowed: pnpm runs it as the package script.
const PNPM_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
// npm package name, optionally scoped, lowercase. No '/' outside the scope
// and no '..', so paths and pnpm selectors (globs, '...', '^', '{dir}',
// '[ref]', '!') never match.
const PNPM_PACKAGE_NAME =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PNPM_BUILTIN_COMMANDS = new Set([
  'access',
  'add',
  'adduser',
  'approve-builds',
  'audit',
  'bin',
  'bugs',
  'c',
  'cache',
  'cat-file',
  'cat-index',
  'catalog',
  'ci',
  'clean',
  'completion',
  'config',
  'create',
  'dedupe',
  'deploy',
  'deprecate',
  'dislink',
  'dist-tag',
  'dlx',
  'docs',
  'doctor',
  'edit',
  'env',
  'exec',
  'fetch',
  'find-hash',
  'get',
  'help',
  'i',
  'ignored-builds',
  'import',
  'info',
  'init',
  'install',
  'install-completion',
  'install-test',
  'it',
  'la',
  'licenses',
  'link',
  'list',
  'll',
  'ln',
  'login',
  'logout',
  'ls',
  'm',
  'multi',
  'outdated',
  'owner',
  'pack',
  'patch',
  'patch-commit',
  'patch-remove',
  'ping',
  'pkg',
  'prefix',
  'profile',
  'prune',
  'publish',
  'rb',
  'rebuild',
  'recursive',
  'remove',
  'repo',
  'restart',
  'rm',
  'root',
  'run',
  'run-script',
  'runtime',
  's',
  'sbom',
  'se',
  'search',
  'self-update',
  'server',
  'set',
  'set-script',
  'setup',
  'show',
  'star',
  'stars',
  'start',
  'store',
  't',
  'team',
  'token',
  'tst',
  'un',
  'uni',
  'uninstall',
  'unlink',
  'unpublish',
  'unstar',
  'up',
  'update',
  'upgrade',
  'v',
  'version',
  'view',
  'whoami',
  'why',
  'with',
  'x',
  'xmas',
]);
// git checks are read-only gates: only `git diff --check`, optionally on the
// index (--cached or its alias --staged) and with external diff drivers and
// textconv filters explicitly disabled. Every other option, global option
// (-c, --git-dir, --work-tree, --exec-path) or positional argument is
// rejected, including writers and program launchers such as --output,
// -O/--open-files-in-pager, --ext-diff and --textconv.
const GIT_CHECK_SUBCOMMAND = 'diff';
const GIT_CHECK_REQUIRED_OPTION = '--check';
const GIT_CHECK_OPTIONS = new Set([
  '--check',
  '--cached',
  '--staged',
  '--no-ext-diff',
  '--no-textconv',
]);
// Required gate rule codes live in their own namespace: no core stop code
// ends with _GATE, so a profile cannot reuse a core code.
const REQUIRED_GATE_RULE_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_GATE$/;
const CHECK_DEFINITION_KEYS = new Set([
  'program',
  'args',
  'timeoutMs',
  'nestedInvocations',
  'passDockerHost',
  'unsetCiOnDarwin',
]);
const REQUIRED_GATE_RULE_KEYS = new Set([
  'check',
  'prefixes',
  'paths',
  'code',
  'message',
]);
const MAX_PROFILE_CHECKS = 64;
const MAX_PROFILE_LIST_ITEMS = 64;
const MIN_CHECK_TIMEOUT_MS = 1_000;
const MAX_CHECK_TIMEOUT_MS = 4 * 60 * 60_000;
// Task classes come from the profile's taskClasses. The core keeps the
// invariants: a task without a class section uses DEFAULT_TASK_CLASS, which
// every profile must declare as the full track (review, base checks, no docs
// rule); analysis mode accepts no other class; a class may skip independent
// review only with docsOnly, i.e. when the docs candidate rule applies.
const DEFAULT_TASK_CLASS = 'implementation';
const TASK_CLASS_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TASK_CLASS_NAME_LENGTH = 64;
const MAX_TASK_CLASS_TEXT_LENGTH = 500;
const TASK_CLASS_KEYS = new Set([
  'independentReviewRequired',
  'checkSet',
  'docsOnly',
  'reason',
  'remainingAssurance',
  'policy',
]);
// Built-in default: the classes used so far, with their texts in the locale
// of the profile. It names no policy document; a profile points to its own
// (see scripts/agent-review-profile.mjs).
function defaultTaskClasses(locale) {
  const docsTaskClass = (independentReviewRequired) =>
    Object.freeze({
      independentReviewRequired,
      checkSet: 'docs',
      docsOnly: true,
      reason: t(
        locale,
        independentReviewRequired
          ? 'taskClass.reviewRequiredReason'
          : 'taskClass.docsReason',
      ),
      remainingAssurance: t(
        locale,
        independentReviewRequired
          ? 'taskClass.reviewRequiredAssurance'
          : 'taskClass.docsAssurance',
      ),
    });
  const fullTaskClass = Object.freeze({
    independentReviewRequired: true,
    checkSet: 'base',
    docsOnly: false,
    reason: t(locale, 'taskClass.reviewRequiredReason'),
    remainingAssurance: t(locale, 'taskClass.reviewRequiredAssurance'),
  });
  return Object.freeze({
    'docs-minor': docsTaskClass(false),
    'docs-descriptive': docsTaskClass(false),
    'docs-contract': docsTaskClass(true),
    [DEFAULT_TASK_CLASS]: fullTaskClass,
    critical: fullTaskClass,
  });
}
const DEFAULT_TASK_CLASSES = defaultTaskClasses(DEFAULT_LOCALE);
// Names of the built-in default classes; a profile may declare others.
export const TASK_CLASSES = Object.freeze(Object.keys(DEFAULT_TASK_CLASSES));

// Docs candidate rule. Exclusions match whole path segments: names compare
// ASCII letters case-insensitively, segments compare in lower case; excluded
// prefixes compare ASCII letters case-insensitively from the path start.
// The base exclusions below apply to every profile; a profile may add more.
const BASE_DOCS_EXCLUDED_NAMES = Object.freeze(['AGENTS.md', 'CLAUDE.md']);
const BASE_DOCS_EXCLUDED_SEGMENTS = Object.freeze([
  '.git',
  '.agents',
  '.claude',
  '.codex',
  'skills',
]);
// Extensions a docs candidate may have, whatever the profile allows. No
// .txt: build and dependency inputs (requirements.txt, CMakeLists.txt) use
// it, so a profile listing it is rejected.
const DOCS_CANDIDATE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.rst',
  '.adoc',
]);
const DOCS_CANDIDATE_POLICY_KEYS = new Set([
  'allowedPaths',
  'allowedPrefixes',
  'allowedExtensions',
  'excludedNames',
  'excludedSegments',
  'excludedPrefixes',
]);
const DEFAULT_DOCS_CANDIDATE_POLICY = Object.freeze({
  allowedPaths: Object.freeze(['README.md']),
  allowedPrefixes: Object.freeze(['docs/']),
  allowedExtensions: Object.freeze(['.md']),
  excludedNames: Object.freeze([
    ...BASE_DOCS_EXCLUDED_NAMES,
    'SECURITY.md',
    'SKILL.md',
  ]),
  excludedSegments: BASE_DOCS_EXCLUDED_SEGMENTS,
  excludedPrefixes: Object.freeze([
    'docs/development/agent-',
    'docs/development/frontend-agent-skills.md',
  ]),
});

// Lower-cases A-Z only, like a case-insensitive non-Unicode RegExp.
function asciiLowerCase(value) {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

// True if a non-ASCII character maps to an ASCII letter under Unicode case
// mapping (U+017F long s, U+212A Kelvin sign, U+0130, U+0131, ligatures
// such as U+FB01). Exclusions fold
// ASCII letters only, while case-insensitive file systems may fold these to
// an excluded ASCII name, so a docs candidate never contains them.
function hasAsciiFoldingCharacter(value) {
  for (const character of value) {
    if (character.charCodeAt(0) < 0x80) continue;
    if (/[A-Za-z]/.test(character.toUpperCase() + character.toLowerCase()))
      return true;
  }
  return false;
}

function taskQualityPolicy(profile, taskClass, taskMode) {
  const definition = profile.taskClasses[taskClass];
  const docs = taskMode === 'implementation' && definition.docsOnly === true;
  // Without the docs rule independent review is always required.
  const required = !docs || definition.independentReviewRequired !== false;
  return {
    taskClass,
    docs,
    independentReviewRequired: required,
    reason: definition.reason,
    policy: definition.policy ?? null,
    remainingAssurance: definition.remainingAssurance,
  };
}

function skippedReviewAudit(quality) {
  return {
    status: 'NOT_REQUIRED',
    reason: quality.reason,
    policy: quality.policy,
    attemptCount: 0,
    runs: [],
    remainingAssurance: quality.remainingAssurance,
  };
}

export const TASK_MODES = Object.freeze(['implementation', 'analysis']);
export const DEFAULT_TASK_MODE = 'implementation';
export const CODEX_REASONING = DEFAULT_SOL_EFFORT;
// Profile sections implementer and reviewer (see agent-review-providers.mjs).
const IMPLEMENTER_KEYS = new Set([
  'provider',
  'model',
  'effort',
  'allowedEfforts',
]);
const REVIEWER_KEYS = new Set([
  'provider',
  'profiles',
  'defaultProfile',
  'fallbackProfile',
]);
const REVIEW_ATTEMPT_KEYS = new Set(['model', 'effort']);
const REVIEW_PROFILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Reported as the review profile of a run with an unknown profile name.
const INVALID_REVIEW_PROFILE_NAME = 'invalid';
const MAX_REVIEW_PROFILE_NAME_LENGTH = 64;
// The fallback profile has the planned attempt and one fallback attempt;
// every other profile has a single attempt.
const FALLBACK_PROFILE_ATTEMPTS = 2;

// Provider modules (scripts/providers/contract.mjs). The built-in modules
// are always known; a profile adds others with providerModules. Each
// resolved role section is mapped to the module that serves it.
const BUILTIN_PROVIDERS = Object.freeze(
  Object.assign(Object.create(null), {
    codex: codexProvider,
    claude: claudeProvider,
  }),
);
const ROLE_PROVIDERS = new WeakMap();
const MAX_PROVIDER_ARGS = 256;
const REVIEW_FALLBACK_REASONS = Object.freeze([
  'MODEL_UNAVAILABLE',
  'CAPACITY_UNAVAILABLE',
  'USAGE_LIMIT_EXHAUSTED',
]);

function isBuiltinProvider(module) {
  return Object.values(BUILTIN_PROVIDERS).includes(module);
}

// A module from the profile: the contract and the role rules are checked
// again here, whatever produced the object. A shape error is
// INVALID_CONFIGURATION; a role the declaration does not allow is
// PROVIDER_ROLE_NOT_ALLOWED. Both stop the run before any process.
function loadProviderModule(value) {
  try {
    const module = validateProviderModule(value);
    const violations = roleRuleViolations(module);
    if (violations.length > 0)
      throw new ProviderContractError(violations.join('; '), 'role');
    return module;
  } catch (error) {
    const role =
      error instanceof ProviderContractError && error.kind === 'role';
    throw new AgentWorkflowError(
      msg(role ? 'provider.roleRules' : 'provider.invalidModule', {
        detail: redactSensitive(String(error?.message ?? error)).slice(0, 500),
      }),
      {
        code: role ? 'PROVIDER_ROLE_NOT_ALLOWED' : 'INVALID_CONFIGURATION',
        stage: 'preflight',
      },
    );
  }
}

// The module serving a role section: the one recorded when the profile was
// resolved, otherwise a built-in provider by name.
function roleProvider(section, role) {
  const module =
    ROLE_PROVIDERS.get(section) ??
    (typeof section?.provider === 'string' &&
    Object.hasOwn(BUILTIN_PROVIDERS, section.provider)
      ? BUILTIN_PROVIDERS[section.provider]
      : undefined);
  if (!module?.roles.includes(role)) {
    throw new AgentWorkflowError(msg('profile.invalid'), {
      code: 'INVALID_CONFIGURATION',
      stage: 'preflight',
    });
  }
  return module;
}

// State checked around the rounds of an implementer. Only the built-in
// codex module runs without the Git directory checks (as before the
// provider interface); for any module from a profile the core applies them
// whatever the module declares.
function implementerStateChecks(module) {
  const { gitDirectoryWritable = false, scratchDirectories = [] } =
    module.implementer;
  return {
    gitDirectoryWritable: gitDirectoryWritable || !isBuiltinProvider(module),
    scratchDirectories,
  };
}

function providerContractViolation(module, role, stage, reason) {
  return new AgentWorkflowError(
    msg('provider.contractViolation', { id: module.id, role, reason }),
    { code: 'PROVIDER_CONTRACT_VIOLATION', stage },
  );
}

// The model a role runs: the core's identifier rule and the module's own.
function isProviderModel(module, value) {
  try {
    return isValidModelId(value) && module.isValidModel(value) === true;
  } catch {
    return false;
  }
}

// The task modes a role serves; any other mode stops the run.
function assertProviderTaskMode(module, role, taskMode) {
  if (!module[role].modes.includes(taskMode)) {
    throw new AgentWorkflowError(
      msg('provider.taskMode', { id: module.id, taskMode, role }),
      { code: 'INVALID_TASK_MODE', stage: 'preflight' },
    );
  }
}

// The argv a module builds: a plain array of strings, copied once through
// data descriptors (copyProviderArgs), and no argument the forbidden-argument
// list matches (scripts/providers/contract.mjs); the values the core passed
// in (exempt) are not inspected. The checks and the process both use the
// frozen copy, never the module's array.
function providerArgs(module, role, input, exempt, stage) {
  const args = copyProviderArgs(
    module[role].processArgs(input),
    MAX_PROVIDER_ARGS,
  );
  if (!args)
    throw providerContractViolation(
      module,
      role,
      stage,
      msg('provider.argvNotStrings'),
    );
  const forbidden = forbiddenArgument(module.program, args, { exempt, role });
  if (forbidden)
    throw providerContractViolation(
      module,
      role,
      stage,
      msg('provider.forbiddenArgument', { index: forbidden.index }),
    );
  return args;
}

// The environment a module returns must be exactly the core's: the given
// environment, for the implementer with the guard directory first on PATH.
// A module cannot add, drop or change a variable.
function providerEnvironment(module, role, environment, guardBin, stage) {
  const expected =
    role === 'implementer'
      ? { ...environment, PATH: `${guardBin}:${environment.PATH}` }
      : { ...environment };
  const env = module[role].processEnvironment(
    role === 'implementer'
      ? { environment: Object.freeze({ ...environment }), guardBin }
      : { environment: Object.freeze({ ...environment }) },
  );
  const keys =
    env && typeof env === 'object' && !Array.isArray(env)
      ? Reflect.ownKeys(env)
      : undefined;
  if (
    !keys ||
    keys.length !== Object.keys(expected).length ||
    !keys.every((key) => {
      const descriptor =
        typeof key === 'string' && Object.getOwnPropertyDescriptor(env, key);
      return (
        descriptor &&
        Object.hasOwn(descriptor, 'value') &&
        Object.hasOwn(expected, key) &&
        descriptor.value === expected[key]
      );
    })
  )
    throw providerContractViolation(
      module,
      role,
      stage,
      msg('provider.environmentChanged'),
    );
  return expected;
}

export class AgentWorkflowError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AgentWorkflowError';
    this.code = options.code ?? 'WORKFLOW_ERROR';
    this.stage = options.stage;
    this.resume = options.resume;
    this.report = options.report;
    this.diagnostic = options.diagnostic;
  }
}

function cleanControlCharacters(value) {
  return String(value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    '',
  );
}

export function redactSensitive(value) {
  return cleanControlCharacters(value)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+(?::[^\s/@]*)?)@/gi, '$1***@')
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-(?:ant-)?[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
      '***',
    )
    .replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, '$1***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***')
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY|CREDENTIALS)[A-Z0-9_]*\s*[=:]\s*)([^\s,;]+)/gi,
      '$1***',
    )
    .replace(
      /\b(token|password|passwd|secret|api[_-]?key)=([^\s&]+)/gi,
      '$1=***',
    );
}

export function createStreamingRedactor({
  maxBytes = MAX_PROCESS_LOG_BYTES,
  onText = () => {},
  live = false,
} = {}) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  let pending = '';
  const decoder = new StringDecoder('utf8');

  return {
    append(chunk) {
      if (truncated) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        truncated = true;
        chunks.length = 0;
        pending = '';
        return;
      }
      chunks.push(buffer);
      if (live) {
        pending += decoder.write(buffer);
        const lastNewline = pending.lastIndexOf('\n');
        if (lastNewline >= 0) {
          onText(redactSensitive(pending.slice(0, lastNewline + 1)));
          pending = pending.slice(lastNewline + 1);
        }
      }
    },
    flush() {
      const value = truncated
        ? `${msg('log.omitted')}\n`
        : redactSensitive(Buffer.concat(chunks).toString('utf8'));
      if (live) {
        pending += decoder.end();
        if (!truncated && pending) onText(redactSensitive(pending));
        if (truncated) onText(value);
      } else {
        onText(value);
      }
      chunks.length = 0;
      pending = '';
      return value;
    },
    wasTruncated() {
      return truncated;
    },
  };
}

function createExactCollector(maxBytes, onLimit) {
  const chunks = [];
  let bytes = 0;
  let limitExceeded = false;
  return {
    append(chunk) {
      if (limitExceeded) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        limitExceeded = true;
        chunks.length = 0;
        onLimit();
        return;
      }
      chunks.push(buffer);
    },
    value() {
      return limitExceeded ? '' : Buffer.concat(chunks).toString('utf8');
    },
    limitExceeded() {
      return limitExceeded;
    },
  };
}

function interruptionResult(stage) {
  return {
    code: 130,
    signal: 'SIGINT',
    stdout: '',
    stderr: msg('process.interrupted', {
      stage: stage ?? msg('process.defaultStage'),
    }),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutLimitExceeded: false,
  };
}

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Proces już zakończony.
    }
  }
}

// The process table as pid -> { ppid, pgid, start }, read with ps (macOS,
// Linux procps); start is the start time (lstart), opaque text that together
// with the PID identifies a process. Zombies are left out (they run
// nothing). Rejects when no ps is found at an absolute path, when it cannot
// run, prints an unexpected line (also without a start time) or does not
// list the runner itself.
const PS_PROGRAM = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path));

function readProcessTable() {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!PS_PROGRAM) {
      rejectPromise(new Error('ps not found at /bin/ps or /usr/bin/ps'));
      return;
    }
    execFile(
      PS_PROGRAM,
      ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='],
      {
        env: { ...process.env, LC_ALL: 'C' },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error) return rejectPromise(error);
        const table = new Map();
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(.*)$/.exec(line);
          if (!match) return rejectPromise(new Error('unexpected ps output'));
          if (match[4].startsWith('Z')) continue;
          const start = match[5].trim();
          if (!start || !/^\s/.test(match[5]))
            return rejectPromise(new Error('ps lists no start time'));
          table.set(Number(match[1]), {
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            start,
          });
        }
        if (!table.has(process.pid))
          return rejectPromise(new Error('ps does not list the runner'));
        resolvePromise(table);
      },
    );
  });
}

// Interval of the process watch: a reading costs one ps run, so a shorter
// interval keeps ps running most of the round.
const PROCESS_WATCH_INTERVAL_MS = 200;

// Best effort for killProcessGroupOnExit (background process watch): processes a program
// started that left its process group. A process is identified by its PID
// and start time, so a PID the system gave to another process is never taken
// for a recorded one. While the program runs, the process table is read
// every intervalMs. Each reading first drops the recorded processes that are
// gone (PID absent) and fails the check when a recorded PID is present with
// another start time, then records the program, the
// children of recorded processes and the members of the groups kept from the
// previous reading, and keeps only the groups that have a recorded member (a
// recorded process that changed its group brings the new one). A group whose
// leader (PID equal to the group ID) is present but not recorded is a reused
// number and records nothing. The runner's own group and processes are
// never recorded. When the program exits, the recorded processes still
// present are killed (SIGKILL) whatever their group, a group only when its
// leader and all its present members are recorded, and the table is read
// again until none is left. finish() resolves to { status: 'clean' }, {
// status: 'survived', pids } when one is still there after
// survivalTimeoutMs, { status: 'changed', pids } when a recorded PID was
// present with another start time (nothing is killed then), or { status:
// 'unavailable' } when the table could not be read or processed at any
// point. Not covered: a process that left the
// tree and the recorded groups between two readings, and one whose parent
// died before the first reading; SECURITY.md describes the limits.
function watchProcessTree(
  rootPid,
  { readProcesses, kill, intervalMs, survivalTimeoutMs },
) {
  // pid -> { start, pgid } of the recorded processes.
  const recorded = new Map();
  let groups = new Set([rootPid]);
  let ownGroup;
  let failed = false;
  // Recorded PIDs found with another start time; set once, then failed.
  const changed = [];
  let reading;
  const record = (table) => {
    ownGroup ??= table.get(process.pid)?.pgid;
    for (const [pid, identity] of recorded) {
      const entry = table.get(pid);
      // A recorded PID still present with another start time cannot be told
      // apart from a shifted clock, so it fails the check.
      if (entry && entry.start !== identity.start) changed.push(pid);
      else if (!entry || entry.pgid === ownGroup) recorded.delete(pid);
      else identity.pgid = entry.pgid;
    }
    if (changed.length > 0) {
      failed = true;
      return;
    }
    const usable = (pgid) =>
      groups.has(pgid) && (!table.has(pgid) || recorded.has(pgid));
    let added = true;
    while (added) {
      added = false;
      for (const [pid, { ppid, pgid, start }] of table) {
        if (recorded.has(pid) || pid === process.pid || pgid === ownGroup)
          continue;
        if (
          (pid === rootPid && ppid === process.pid) ||
          recorded.has(ppid) ||
          usable(pgid)
        ) {
          recorded.set(pid, { start, pgid });
          added = true;
        }
      }
    }
    groups = new Set(
      [...recorded.values()]
        .map(({ pgid }) => pgid)
        .filter((pgid) => pgid > 1 && pgid !== ownGroup),
    );
  };
  const poll = () => {
    if (reading || failed) return;
    try {
      reading = readProcesses()
        .then(record)
        .catch(() => {
          failed = true;
        })
        .finally(() => {
          reading = undefined;
        });
    } catch {
      failed = true;
    }
  };
  poll();
  const timer = setInterval(poll, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
    async finish() {
      clearInterval(timer);
      await reading;
      const startedAt = Date.now();
      while (!failed) {
        let table;
        try {
          table = await readProcesses();
          record(table);
        } catch {
          break;
        }
        // Nothing is killed after a changed start time: the PID may be reused.
        if (failed) break;
        const left = [...recorded.keys()];
        if (left.length === 0) return { status: 'clean' };
        if (Date.now() - startedAt > survivalTimeoutMs)
          return { status: 'survived', pids: left };
        for (const pgid of groups) {
          const members = [...table].filter(
            ([, entry]) => entry.pgid === pgid,
          );
          if (
            (table.has(pgid) && !recorded.has(pgid)) ||
            members.some(([pid]) => !recorded.has(pid))
          )
            continue;
          try {
            kill(-pgid, 'SIGKILL');
          } catch {
            // ESRCH or EPERM: the next reading determines the outcome.
          }
        }
        for (const pid of left) {
          try {
            kill(pid, 'SIGKILL');
          } catch {
            // As above.
          }
        }
        await new Promise((resolvePause) => setTimeout(resolvePause, 50));
      }
      if (changed.length > 0) return { status: 'changed', pids: changed };
      return { status: 'unavailable' };
    },
  };
}

export function createProcessRunner({
  output = process.stdout,
  spawnImpl = spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  // Process watch of killProcessGroupOnExit (watchProcessTree); replaceable
  // in tests only.
  readProcesses = readProcessTable,
  killProcess = (pid, signal) => process.kill(pid, signal),
  processWatchIntervalMs = PROCESS_WATCH_INTERVAL_MS,
  processSurvivalTimeoutMs = 2_000,
} = {}) {
  let active;
  let cancelled = false;
  const abortController = new AbortController();

  function stopActive(signal = 'SIGINT') {
    if (!active) return;
    killProcessGroup(active.child, signal);
    if (signal === 'SIGINT') {
      active.escalationTimers.push(
        setTimer(() => killProcessGroup(active?.child, 'SIGTERM'), 1_000),
        setTimer(() => killProcessGroup(active?.child, 'SIGKILL'), 3_000),
      );
    }
  }

  return {
    async run(program, args, options = {}) {
      if (cancelled) return interruptionResult(options.stage);
      if (active) {
        throw new AgentWorkflowError(
          msg('process.concurrent'),
          { code: 'CONCURRENT_PROCESS', stage: options.stage },
        );
      }
      if (
        !Array.isArray(args) ||
        args.some((item) => typeof item !== 'string')
      ) {
        throw new AgentWorkflowError(
          msg('process.invalidArgs'),
          {
            code: 'INVALID_PROCESS_ARGS',
            stage: options.stage,
          },
        );
      }

      return new Promise((resolvePromise, rejectPromise) => {
        let timedOut = false;
        let settled = false;
        const stdoutDiagnostic = createStreamingRedactor({
          onText: options.streamOutput
            ? (text) => output.write(text)
            : undefined,
          live: Boolean(options.liveOutput),
        });
        const stderrDiagnostic = createStreamingRedactor({
          onText: options.streamOutput
            ? (text) => output.write(text)
            : undefined,
          live: Boolean(options.liveOutput),
        });
        const stdoutExact = options.exactStdoutLimitBytes
          ? createExactCollector(options.exactStdoutLimitBytes, () =>
              stopActive('SIGINT'),
            )
          : undefined;
        let timeoutTimer;
        const child = spawnImpl(program, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        active = { child, escalationTimers: [] };

        child.stdout?.on('data', (chunk) => {
          options.onStdoutChunk?.(chunk.toString());
          try {
            options.onActivityChunk?.(chunk);
          } catch {
            /* Presentation only. */
          }
          if (stdoutExact) {
            stdoutExact.append(chunk);
          } else stdoutDiagnostic.append(chunk);
        });
        child.stderr?.on('data', (chunk) => stderrDiagnostic.append(chunk));
        // A program that exits before taking its whole input closes the pipe
        // (EPIPE, ERR_STREAM_DESTROYED): the first such error is kept, never
        // thrown. It is read only when the run settles (after 'close' and,
        // with killProcessGroupOnExit, after the process check): then it
        // turns an exit code 0 into PROCESS_ERROR, while a non-zero exit or
        // an interruption is reported as it is.
        let stdinError;
        child.stdin?.on('error', (error) => {
          stdinError ??= error;
        });
        // killProcessGroupOnExit (best effort): when the program exits, the
        // processes left in its group (spawned detached) are killed, also
        // before one that holds the output pipes lets the run settle.
        // Background commands of Claude Code's Bash run in their own group
        // and session (probes of 2.1.285): the process watch
        // (watchProcessTree) kills the groups it saw and checks that nothing
        // of them survived; a survivor or an unreadable process table
        // rejects the run with IMPLEMENTER_PROCESS_SURVIVED.
        let processWatch;
        let processCheck;
        if (options.killProcessGroupOnExit) {
          processWatch = child.pid
            ? watchProcessTree(child.pid, {
                readProcesses,
                kill: killProcess,
                intervalMs: processWatchIntervalMs,
                survivalTimeoutMs: processSurvivalTimeoutMs,
              })
            : undefined;
          child.once('exit', () => {
            if (process.platform !== 'win32') {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                // ESRCH: no process left in the group.
              }
            }
            processCheck = processWatch
              ? processWatch.finish()
              : Promise.resolve({ status: 'unavailable' });
          });
        }
        child.once('error', (error) => {
          processWatch?.stop();
          if (settled) return;
          settled = true;
          if (timeoutTimer) clearTimer(timeoutTimer);
          for (const timer of active?.escalationTimers ?? []) clearTimer(timer);
          active = undefined;
          rejectPromise(error);
        });
        child.once('close', (code, signal) => {
          if (settled) return;
          settled = true;
          if (timeoutTimer) clearTimer(timeoutTimer);
          for (const timer of active?.escalationTimers ?? []) clearTimer(timer);
          const stdout = stdoutExact
            ? stdoutExact.value()
            : stdoutDiagnostic.flush();
          const stderr = stderrDiagnostic.flush();
          const outcome = () =>
            cancelled
              ? interruptionResult(options.stage)
              : {
                  code: code ?? 1,
                  signal,
                  stdout,
                  stderr,
                  timedOut,
                  stdoutTruncated: stdoutDiagnostic.wasTruncated(),
                  stderrTruncated: stderrDiagnostic.wasTruncated(),
                  stdoutLimitExceeded: stdoutExact?.limitExceeded() ?? false,
                };
          // A program that exits with 0 without having taken its whole input
          // did not get the task it reports on (PROCESS_ERROR); a failing
          // exit is the program's own failure.
          const settle = () => {
            if (stdinError && code === 0 && !cancelled) {
              rejectPromise(
                new Error(
                  msg('process.inputNotRead', {
                    error: stdinError.code ?? stdinError.message,
                  }),
                ),
              );
              return;
            }
            resolvePromise(outcome());
          };
          if (!options.killProcessGroupOnExit) {
            active = undefined;
            settle();
            return;
          }
          // The process check settles the run; until then no other process
          // starts.
          (processCheck ?? Promise.resolve({ status: 'unavailable' }))
            .catch(() => ({ status: 'unavailable' }))
            .then((check) => {
              active = undefined;
              if (check.status === 'clean') {
                settle();
                return;
              }
              rejectPromise(
                new AgentWorkflowError(
                  check.status === 'survived'
                    ? msg('implementer.processSurvived', {
                        pids: check.pids.join(', '),
                      })
                    : check.status === 'changed'
                      ? msg('implementer.processIdentityChanged', {
                          pids: check.pids.join(', '),
                        })
                      : msg('implementer.processCheckUnavailable'),
                  {
                    code: 'IMPLEMENTER_PROCESS_SURVIVED',
                    stage: options.stage,
                    diagnostic: outcome(),
                  },
                ),
              );
            });
        });

        if (options.input !== undefined) child.stdin?.end(options.input);
        else child.stdin?.end();

        if (options.timeoutMs) {
          timeoutTimer = setTimer(() => {
            timedOut = true;
            stopActive('SIGINT');
          }, options.timeoutMs);
        }
      });
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      abortController.abort();
      stopActive('SIGINT');
    },
    isCancelled() {
      return cancelled;
    },
    hasActiveProcess() {
      return Boolean(active);
    },
    signal: abortController.signal,
  };
}

function conciseProcessFailure(result) {
  const value = redactSensitive(
    result.stderr ||
      result.stdout ||
      msg('process.exitCode', { code: result.code }),
  ).trim();
  return value.length > 1_000 ? `${value.slice(0, 1_000)}…` : value;
}

// reviewer: the resolved reviewer section of a profile; default: the core's.
// Without a profile name the reviewer's defaultProfile applies; a name that is
// not a string is unknown, even if it converts to a profile key.
export function resolveReviewProfile(name, reviewer = DEFAULT_REVIEWER) {
  const profile = name === undefined ? reviewer.defaultProfile : name;
  if (
    typeof profile !== 'string' ||
    !Object.hasOwn(reviewer.profiles, profile)
  ) {
    throw new AgentWorkflowError(
      msg('config.unknownReviewProfile', { profile: JSON.stringify(profile) }),
      { code: 'INVALID_REVIEW_PROFILE', stage: 'preflight' },
    );
  }
  const attempts = reviewer.profiles[profile];
  return {
    profile,
    attempts,
    fallbackAllowed:
      reviewer.fallbackProfile !== null && profile === reviewer.fallbackProfile,
  };
}

export function isValidCodexModel(value) {
  return codexProvider.isValidModel(value);
}

export function resolveCodexModel(model = CODEX_MODEL) {
  if (!isValidCodexModel(model)) {
    throw new AgentWorkflowError(
      msg('config.invalidCodexModel'),
      { code: 'INVALID_CODEX_MODEL', stage: 'preflight' },
    );
  }
  return model;
}

// allowedEfforts: the implementer allowlist of a profile; default: the core's.
export function resolveSolEffort(
  effort = DEFAULT_SOL_EFFORT,
  allowedEfforts = SOL_EFFORTS,
) {
  if (!allowedEfforts.includes(effort)) {
    throw new AgentWorkflowError(
      msg('config.unknownSolEffort', { effort: JSON.stringify(effort) }),
      { code: 'INVALID_SOL_EFFORT', stage: 'preflight' },
    );
  }
  return effort;
}

export function resolveTaskMode(mode = DEFAULT_TASK_MODE) {
  if (!TASK_MODES.includes(mode)) {
    throw new AgentWorkflowError(
      msg('config.invalidTaskMode'),
      { code: 'INVALID_TASK_MODE', stage: 'preflight' },
    );
  }
  return mode;
}

// Only a failed reviewer process without integrity violations, timeout or
// signal may fall back; the adapter classifies its redacted output.
function classifyClaudeFallbackReason(error, adapter = claudeProvider) {
  if (
    !(error instanceof AgentWorkflowError) ||
    error.code !== 'CLAUDE_PROCESS_FAILED' ||
    error.integrityViolations?.length
  ) {
    return undefined;
  }
  const diagnostic = error.diagnostic;
  if (!diagnostic || diagnostic.timedOut || diagnostic.signal) return undefined;
  const text = redactSensitive(
    `${diagnostic.stderr ?? ''}\n${diagnostic.stdout ?? ''}`,
  );
  // Only the known reasons allow a fallback, whatever a module returns.
  try {
    const reason = adapter.reviewer.fallbackReason(text);
    return REVIEW_FALLBACK_REASONS.includes(reason) ? reason : undefined;
  } catch {
    return undefined;
  }
}

async function safeRun(runner, program, args, options, label) {
  try {
    const result = await runner.run(program, args, options);
    if (result.stdoutLimitExceeded) {
      throw new AgentWorkflowError(
        msg('process.stdoutLimit', {
          label,
          limit: options.exactStdoutLimitBytes,
        }),
        {
          code: 'OUTPUT_LIMIT_EXCEEDED',
          stage: options.stage,
          diagnostic: result,
        },
      );
    }
    if (result.code === 130) {
      throw new AgentWorkflowError(msg('run.interrupted'), {
        code: 'INTERRUPTED',
        stage: options.stage,
        diagnostic: result,
      });
    }
    if (result.timedOut) {
      throw new AgentWorkflowError(msg('process.timeout', { label }), {
        code: 'TIMEOUT',
        stage: options.stage,
        diagnostic: result,
      });
    }
    return result;
  } catch (error) {
    if (error instanceof AgentWorkflowError) throw error;
    throw new AgentWorkflowError(
      `${label}: ${redactSensitive(error instanceof Error ? error.message : String(error))}`,
      { code: 'PROCESS_ERROR', stage: options.stage },
    );
  }
}

async function requiredRun(runner, program, args, options, label) {
  const result = await safeRun(runner, program, args, options, label);
  if (result.code !== 0) {
    throw new AgentWorkflowError(`${label}: ${conciseProcessFailure(result)}`, {
      code: 'PROCESS_FAILED',
      stage: options.stage,
      diagnostic: result,
    });
  }
  return result;
}

async function requiredGitRun(
  runner,
  args,
  { exactStdoutLimitBytes = MAX_GIT_SCALAR_BYTES, ...options },
  label,
) {
  return requiredRun(
    runner,
    'git',
    args,
    { ...options, exactStdoutLimitBytes },
    label,
  );
}

function assertNotCancelled(runner, stage) {
  if (runner.isCancelled?.()) {
    throw new AgentWorkflowError(msg('run.interrupted'), {
      code: 'INTERRUPTED',
      stage,
    });
  }
}

function pathIsInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== '' &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function resolveRepositoryRoot({
  runner,
  repositoryRoot,
  invocationCwd,
}) {
  const result = await requiredGitRun(
    runner,
    ['rev-parse', '--show-toplevel'],
    { cwd: invocationCwd, stage: 'preflight' },
    msg('git.repositoryUnknown'),
  );
  const [actual, expected] = await Promise.all([
    realpath(result.stdout.trim()),
    realpath(repositoryRoot),
  ]);
  if (actual !== expected) {
    throw new AgentWorkflowError(
      msg('git.wrongRepository', { path: JSON.stringify(actual) }),
      { code: 'WRONG_REPOSITORY', stage: 'preflight' },
    );
  }
  return expected;
}

async function readBranch(runner, cwd, stage = 'preflight') {
  const result = await requiredGitRun(
    runner,
    ['branch', '--show-current'],
    { cwd, stage },
    msg('git.branchUnreadable'),
  );
  const branch = result.stdout.trim();
  if (!branch) {
    throw new AgentWorkflowError(msg('git.detachedHead'), {
      code: 'DETACHED_HEAD',
      stage,
    });
  }
  return branch;
}

async function readHead(runner, cwd, stage = 'preflight') {
  return (
    await requiredGitRun(
      runner,
      ['rev-parse', 'HEAD'],
      { cwd, stage },
      msg('git.headUnreadable'),
    )
  ).stdout.trim();
}

// Always the repository's own index (explicit env), also when the core runs
// its other Git commands with a private index (withCoreGitIndex).
async function assertNoStagedChanges(runner, cwd, stage = 'preflight') {
  const result = await requiredGitRun(
    runner,
    ['diff', '--cached', '--name-only', '-z'],
    {
      cwd,
      env: process.env,
      stage,
      exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES,
    },
    msg('git.stagedUnreadable'),
  );
  if (result.stdout.split('\0').some(Boolean)) {
    throw new AgentWorkflowError(
      msg('git.stagedChanges'),
      {
        code: 'STAGED_CHANGES',
        stage,
      },
    );
  }
}

async function assertGitIdentityStable({ runner, cwd, branch, head, stage }) {
  const currentBranch = await readBranch(runner, cwd, stage);
  const currentHead = await readHead(runner, cwd, stage);
  if (currentBranch !== branch || currentHead !== head) {
    throw new AgentWorkflowError(
      msg('git.identityChanged', { stage }),
      { code: 'UNEXPECTED_GIT_MUTATION', stage },
    );
  }
  await assertNoStagedChanges(runner, cwd, stage);
}

// Fingerprint of the Git state outside the working tree that a writer whose
// sandbox lets commands write in the Git directory could change without
// moving the branch or HEAD and without staging: refs with their values,
// selected files (configuration, packed refs, HEAD, alternates), the trees
// info/ and hooks/ with modes and contents, the top-level entries of the Git
// directories, the index entries (mode, object ID, stage, path) and flags
// (skip-worktree, assume-unchanged), and the object directory by metadata
// (readGitObjectEntries). One SHA-256 per part, so a change names the parts
// that moved.
const MAX_GIT_FINGERPRINT_ENTRIES = 4_096;
const MAX_GIT_FINGERPRINT_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OBJECT_ENTRIES = 262_144;
const MAX_NEW_LOOSE_OBJECT_BYTES = 64 * 1024 * 1024;
const LOOSE_OBJECT_PATH = /^[0-9a-f]{2}\/(?:[0-9a-f]{38}|[0-9a-f]{62})$/;
const LOOSE_OBJECT_DIRECTORY = /^[0-9a-f]{2}$/;
const GIT_FINGERPRINT_COMMON_FILES = Object.freeze([
  'config',
  'packed-refs',
  'shallow',
  join('objects', 'info', 'alternates'),
]);
const GIT_FINGERPRINT_PRIVATE_FILES = Object.freeze([
  'HEAD',
  'config.worktree',
  'commondir',
]);

async function hashGitPath(hash, root, relativePath, budget, stage) {
  const absolute = relativePath ? join(root, relativePath) : root;
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    hash.update(`${relativePath}\0missing\0`);
    return;
  }
  budget.entries += 1;
  if (stats.isFile()) budget.bytes += stats.size;
  if (
    budget.entries > MAX_GIT_FINGERPRINT_ENTRIES ||
    budget.bytes > MAX_GIT_FINGERPRINT_BYTES
  ) {
    throw new AgentWorkflowError(
      msg('git.directoryTooLarge'),
      { code: 'INTEGRITY_CHECK_FAILED', stage },
    );
  }
  const mode = (stats.mode & 0o7777).toString(8);
  if (stats.isSymbolicLink()) {
    hash.update(`${relativePath}\0link\0${await readlink(absolute)}\0`);
  } else if (stats.isDirectory()) {
    hash.update(`${relativePath}\0dir\0${mode}\0`);
    for (const name of (await readdir(absolute)).sort()) {
      await hashGitPath(
        hash,
        root,
        relativePath ? join(relativePath, name) : name,
        budget,
        stage,
      );
    }
  } else if (stats.isFile()) {
    const content = await readFile(absolute);
    hash
      .update(`${relativePath}\0file\0${mode}\0${content.length}\0`)
      .update(content)
      .update('\0');
  } else {
    hash.update(`${relativePath}\0other\0`);
  }
}

// Parts read from the file system only, so that a changed configuration,
// attributes file or hook is detected before the core runs Git again.
async function readGitFileParts({ gitDirectory, commonDirectory, stage }) {
  const budget = { entries: 0, bytes: 0 };
  const directories =
    gitDirectory === commonDirectory
      ? [commonDirectory]
      : [commonDirectory, gitDirectory];
  const parts = {};
  const entries = createHash('sha256');
  for (const [position, directory] of directories.entries()) {
    const names = (await readdir(directory, { withFileTypes: true }))
      .map((entry) => {
        const type = entry.isSymbolicLink()
          ? 'link'
          : entry.isDirectory()
            ? 'dir'
            : 'file';
        return `${entry.name}\0${type}`;
      })
      .sort();
    entries.update(`${position}\0${names.join('\0')}\0`);
  }
  parts.entries = entries.digest('hex');
  const files = createHash('sha256');
  for (const name of GIT_FINGERPRINT_COMMON_FILES)
    await hashGitPath(files, commonDirectory, name, budget, stage);
  for (const name of GIT_FINGERPRINT_PRIVATE_FILES)
    await hashGitPath(files, gitDirectory, name, budget, stage);
  parts.files = files.digest('hex');
  const info = createHash('sha256');
  for (const directory of directories)
    await hashGitPath(info, join(directory, 'info'), '', budget, stage);
  parts.info = info.digest('hex');
  const hooks = createHash('sha256');
  await hashGitPath(hooks, join(commonDirectory, 'hooks'), '', budget, stage);
  parts.hooks = hooks.digest('hex');
  return parts;
}

// Every entry under objects/ by metadata, without reading contents: a file
// by type, mode, size, inode, change and modification time (rewriting or
// replacing it changes them); a directory by type, mode and inode only, as
// adding an object changes its times.
async function readGitObjectEntries(commonDirectory, stage) {
  const root = join(commonDirectory, 'objects');
  const entries = new Map();
  const visit = async (path) => {
    const absolute = path ? join(root, path) : root;
    const stats = await lstat(absolute, { bigint: true });
    if (entries.size >= MAX_GIT_OBJECT_ENTRIES) {
      throw new AgentWorkflowError(
        msg('git.objectsTooLarge'),
        { code: 'INTEGRITY_CHECK_FAILED', stage },
      );
    }
    const mode = (stats.mode & 0o7777n).toString(8);
    if (stats.isDirectory()) {
      entries.set(path, `dir\0${mode}\0${stats.ino}`);
      for (const name of (await readdir(absolute)).sort())
        await visit(path ? `${path}/${name}` : name);
      return;
    }
    const type = stats.isFile()
      ? 'file'
      : stats.isSymbolicLink()
        ? 'link'
        : 'other';
    entries.set(
      path,
      `${type}\0${mode}\0${stats.size}\0${stats.ino}\0${stats.ctimeNs}\0${stats.mtimeNs}`,
    );
  };
  await visit('');
  return entries;
}

// A loose object is valid when its inflated content hashes to its path
// (SHA-1 or SHA-256 by the length of the name).
async function looseObjectValid(root, path, budget) {
  const compressed = await readFile(join(root, path));
  budget.bytes += compressed.length;
  if (budget.bytes > MAX_NEW_LOOSE_OBJECT_BYTES) return false;
  let content;
  try {
    content = inflateSync(compressed, {
      maxOutputLength: MAX_NEW_LOOSE_OBJECT_BYTES,
    });
  } catch {
    return false;
  }
  const name = path.replace('/', '');
  return (
    createHash(name.length === 40 ? 'sha1' : 'sha256')
      .update(content)
      .digest('hex') === name
  );
}

// Entries present before the round must be unchanged. New ones are allowed
// only as loose-object directories and valid loose objects: such an object
// has the content its ID names, so it cannot change what an existing ID
// resolves to. Any other change (packs, objects/info, a rewritten or
// freshened object) stops the run.
async function assertGitObjectsUnchanged({ commonDirectory, baseline, stage }) {
  const current = await readGitObjectEntries(commonDirectory, stage);
  let changed = [...baseline].some(
    ([path, value]) => current.get(path) !== value,
  );
  const budget = { bytes: 0 };
  for (const [path, value] of current) {
    if (changed) break;
    if (baseline.has(path)) continue;
    if (value.startsWith('dir\0') && LOOSE_OBJECT_DIRECTORY.test(path))
      continue;
    changed =
      !value.startsWith('file\0') ||
      !LOOSE_OBJECT_PATH.test(path) ||
      !(await looseObjectValid(join(commonDirectory, 'objects'), path, budget));
  }
  if (changed) throw gitMutationError(['objects'], stage);
}

// Read with the repository's own index (explicit env), also when the core
// runs its other Git commands with a private index.
async function readGitCommandParts({ runner, cwd, stage }) {
  const refs = await requiredGitRun(
    runner,
    [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(symref)',
    ],
    {
      cwd,
      env: process.env,
      stage,
      exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES,
    },
    msg('git.refsUnreadable'),
  );
  const index = await requiredGitRun(
    runner,
    ['ls-files', '-v', '-z'],
    {
      cwd,
      env: process.env,
      stage,
      exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES,
    },
    msg('git.indexFlagsUnreadable'),
  );
  const indexEntries = await requiredGitRun(
    runner,
    ['ls-files', '-s', '-z'],
    {
      cwd,
      env: process.env,
      stage,
      exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES,
    },
    msg('git.indexEntriesUnreadable'),
  );
  return {
    refs: createHash('sha256').update(refs.stdout).digest('hex'),
    indexEntries: createHash('sha256')
      .update(indexEntries.stdout)
      .digest('hex'),
    // Tag H: a plain cached entry; any other tag is a flag or state.
    indexFlags: createHash('sha256')
      .update(
        parseNullSeparated(index.stdout)
          .filter((entry) => !entry.startsWith('H '))
          .sort()
          .join('\0'),
      )
      .digest('hex'),
  };
}

// Before the round: the Git directories (resolved once) and all parts.
async function readGitDirectoryFingerprint({ runner, cwd, stage }) {
  const gitScalar = async (args) =>
    (
      await requiredGitRun(
        runner,
        args,
        { cwd, stage },
        msg('git.directoryUnreadable'),
      )
    ).stdout.trim();
  const [gitDirectory, commonDirectory] = await Promise.all([
    realpath(await gitScalar(['rev-parse', '--absolute-git-dir'])),
    realpath(resolve(cwd, await gitScalar(['rev-parse', '--git-common-dir']))),
  ]);
  return {
    gitDirectory,
    commonDirectory,
    parts: {
      ...(await readGitFileParts({ gitDirectory, commonDirectory, stage })),
      ...(await readGitCommandParts({ runner, cwd, stage })),
    },
    objects: await readGitObjectEntries(commonDirectory, stage),
  };
}

// Right after the round the run stops before the gates; a change found by
// a later check (assertImplementerStateStillUnchanged) names its stage.
function gitMutationError(changed, stage) {
  return new AgentWorkflowError(
    stage === 'post-codex'
      ? msg('implementer.gitStateChanged', { changed: changed.join(', ') })
      : msg('implementer.gitStateChangedLater', {
          changed: changed.join(', '),
          stage,
        }),
    { code: 'UNEXPECTED_GIT_MUTATION', stage },
  );
}

function throwChangedGitParts(baseline, current, stage) {
  const changed = Object.keys(current).filter(
    (part) => baseline[part] !== current[part],
  );
  if (changed.length > 0) throw gitMutationError(changed, stage);
}

// After the round: the file parts and the object directory first; Git runs
// only when they are unchanged.
async function assertGitDirectoryUnchanged({ runner, cwd, baseline, stage }) {
  const { gitDirectory, commonDirectory, parts, objects } = baseline;
  throwChangedGitParts(
    parts,
    await readGitFileParts({ gitDirectory, commonDirectory, stage }),
    stage,
  );
  await assertGitObjectsUnchanged({
    commonDirectory,
    baseline: objects,
    stage,
  });
  throwChangedGitParts(
    parts,
    await readGitCommandParts({ runner, cwd, stage }),
    stage,
  );
}

// Directories the implementer CLI creates in the working directory (e.g.
// .claude/.cc-writes of Claude Code). Before a round each must be missing or
// an empty directory reached without symbolic links; after the round it must
// again be missing or empty, and an empty one created in the round is
// removed, with its parents that did not exist before the round and are
// empty (one that existed before is kept). Anything else stops the run:
// files there could be hidden
// from the other checks when Git ignores the path.
function scratchDirectoryError(directory, stage) {
  return new AgentWorkflowError(
    msg('implementer.scratchNotEmpty', { path: JSON.stringify(directory) }),
    { code: 'IMPLEMENTER_SCRATCH_NOT_EMPTY', stage },
  );
}

async function scratchDirectoryPresent(repositoryRoot, directory, stage) {
  let current = repositoryRoot;
  for (const segment of directory.split('/')) {
    current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (!stats.isDirectory()) throw scratchDirectoryError(directory, stage);
  }
  if ((await readdir(current)).length > 0)
    throw scratchDirectoryError(directory, stage);
  return true;
}

async function readScratchDirectoryBaseline({
  repositoryRoot,
  directories,
  stage,
}) {
  const baseline = [];
  for (const directory of directories) {
    const existed = await scratchDirectoryPresent(
      repositoryRoot,
      directory,
      stage,
    );
    const parents = [];
    for (
      let parent = dirname(directory);
      parent !== '.';
      parent = dirname(parent)
    ) {
      parents.push({
        path: parent,
        existed: await lstat(join(repositoryRoot, parent)).then(
          () => true,
          () => false,
        ),
      });
    }
    baseline.push({ directory, existed, parents });
  }
  return baseline;
}

async function removeScratchDirectories({ repositoryRoot, baseline, stage }) {
  for (const { directory, existed, parents } of baseline) {
    if (
      (await scratchDirectoryPresent(repositoryRoot, directory, stage)) &&
      !existed
    ) {
      try {
        await rmdir(join(repositoryRoot, directory));
      } catch {
        throw scratchDirectoryError(directory, stage);
      }
    }
    for (const { path, existed } of parents) {
      if (existed) break;
      try {
        await rmdir(join(repositoryRoot, path));
      } catch {
        // Not empty or missing: its contents go through the other checks.
        break;
      }
    }
  }
}

// State checked around each round for providers that declare it
// (gitDirectoryWritable, scratchDirectories) and for every provider module
// from a profile (implementerStateChecks); undefined for codex, so its
// rounds run as before.
async function readImplementerStateBaseline({
  runner,
  repositoryRoot,
  adapter,
  stage,
}) {
  const { gitDirectoryWritable, scratchDirectories } =
    implementerStateChecks(adapter);
  if (!gitDirectoryWritable && scratchDirectories.length === 0)
    return undefined;
  return {
    scratch: await readScratchDirectoryBaseline({
      repositoryRoot,
      directories: scratchDirectories,
      stage,
    }),
    git: gitDirectoryWritable
      ? await readGitDirectoryFingerprint({ runner, cwd: repositoryRoot, stage })
      : undefined,
  };
}

async function assertImplementerStateUnchanged({
  runner,
  repositoryRoot,
  baseline,
  stage,
}) {
  const failures = [];
  try {
    await removeScratchDirectories({
      repositoryRoot,
      baseline: baseline.scratch,
      stage,
    });
  } catch (error) {
    failures.push(error);
  }
  if (baseline.git) {
    try {
      await assertGitDirectoryUnchanged({
        runner,
        cwd: repositoryRoot,
        baseline: baseline.git,
        stage,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    let error = failures[0];
    for (const additional of failures.slice(1)) {
      error = appendIntegrityViolation(error, additional);
    }
    throw error;
  }
}

// The private index against a new one built from HEAD (HEAD is checked to
// be unchanged): the same entries (mode, object ID, stage, path) and flags.
// The core never changes its entries after the build, so a difference is a
// write by another process. The index in use is kept; the new one removed.
async function assertCoreGitIndexUnchanged({ state, runner, cwd, stage }) {
  if (!state.index) {
    throw new AgentWorkflowError(msg('git.privateIndexMissing'), {
      code: 'INTEGRITY_CHECK_FAILED',
      stage,
    });
  }
  const fresh = await createCoreGitIndex({ runner, cwd, stage });
  try {
    const read = async (env, args, label) =>
      (
        await requiredGitRun(
          runner,
          args,
          { cwd, env, stage, exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES },
          label,
        )
      ).stdout;
    const flags = (text) =>
      parseNullSeparated(text)
        .filter((entry) => !entry.startsWith('H '))
        .sort()
        .join('\0');
    for (const [args, label, normalize] of [
      [['ls-files', '-s', '-z'], msg('git.indexEntriesUnreadable'), String],
      [['ls-files', '-v', '-z'], msg('git.indexFlagsUnreadable'), flags],
    ]) {
      const current = normalize(await read(state.index.env, args, label));
      const expected = normalize(await read(fresh.env, args, label));
      if (current !== expected) throw gitMutationError(['privateIndex'], stage);
    }
  } finally {
    await rm(fresh.directory, { recursive: true, force: true }).catch(() => {});
  }
}

// Checks after the gates: the CLI has exited, but a process it left behind could still
// write. After the gates (before the reviewer's snapshot or the report of a
// run without review) and again before the final report, the Git directory
// is compared with the baseline of the round and the private index with a
// new one; a difference stops the run (UNEXPECTED_GIT_MUTATION). For
// providers checked around the round only (implementerStateChecks).
async function assertImplementerStateStillUnchanged({
  runner,
  repositoryRoot,
  baseline,
  coreGitIndex,
  stage,
}) {
  if (baseline.git)
    await assertGitDirectoryUnchanged({
      runner,
      cwd: repositoryRoot,
      baseline: baseline.git,
      stage,
    });
  if (coreGitIndex)
    await assertCoreGitIndexUnchanged({
      state: coreGitIndex,
      runner,
      cwd: repositoryRoot,
      stage,
    });
}

// Repository layouts the Git directory fingerprint does not cover, refused
// before any process of a provider that declares gitDirectoryWritable (or
// any provider module from a profile): a
// .git file (linked worktree, submodule) or a Git directory elsewhere,
// submodules (.gitmodules, repositories under modules/), linked worktrees
// (worktrees/) and object alternates, whose objects lie outside the
// fingerprinted directory.
async function assertImplementerRepositoryLayout({ runner, cwd, adapter }) {
  if (!implementerStateChecks(adapter).gitDirectoryWritable) return;
  const refuse = (reason) => {
    throw new AgentWorkflowError(
      msg('implementer.layout', { program: adapter.program, reason }),
      { code: 'IMPLEMENTER_PREFLIGHT_FAILED', stage: 'preflight' },
    );
  };
  const present = (path) =>
    lstat(path).catch((error) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
  const dotGit = join(cwd, '.git');
  if (!(await present(dotGit))?.isDirectory())
    refuse(msg('implementer.layoutDotGit'));
  if (await present(join(cwd, '.gitmodules')))
    refuse(msg('implementer.layoutGitmodules'));
  const gitScalar = async (args) =>
    (
      await requiredGitRun(
        runner,
        args,
        { cwd, stage: 'preflight' },
        msg('git.directoryUnreadable'),
      )
    ).stdout.trim();
  const expected = await realpath(dotGit);
  const gitDirectory = await realpath(
    await gitScalar(['rev-parse', '--absolute-git-dir']),
  );
  const commonDirectory = await realpath(
    resolve(cwd, await gitScalar(['rev-parse', '--git-common-dir'])),
  );
  if (gitDirectory !== expected || commonDirectory !== expected)
    refuse(msg('implementer.layoutGitDirectory'));
  for (const name of ['modules', 'worktrees']) {
    const stats = await present(join(commonDirectory, name));
    if (
      stats &&
      (!stats.isDirectory() ||
        (await readdir(join(commonDirectory, name))).length > 0)
    )
      refuse(msg('implementer.layoutEntries', { name }));
  }
  if (await present(join(commonDirectory, 'objects', 'info', 'alternates')))
    refuse(msg('implementer.layoutAlternates'));
  // The fingerprint reads these entries as plain files and directories: a
  // symbolic link would be hashed by its target path only, and changes
  // behind it would go unseen.
  for (const name of [
    ...GIT_FINGERPRINT_COMMON_FILES,
    ...GIT_FINGERPRINT_PRIVATE_FILES,
    'index',
    'refs',
    'logs',
  ]) {
    if ((await present(join(commonDirectory, name)))?.isSymbolicLink())
      refuse(msg('implementer.layoutSymlink', { path: JSON.stringify(name) }));
  }
  for (const name of ['objects', 'info', 'hooks']) {
    const link = await findSymbolicLink(join(commonDirectory, name));
    if (link !== undefined)
      refuse(
        msg('implementer.layoutSymlink', {
          path: JSON.stringify(link ? `${name}/${link}` : name),
        }),
      );
  }
}

// The first symbolic link at or below path (relative; '' for path itself),
// or undefined; a missing path has none. Reads directory entries only.
async function findSymbolicLink(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  if (stats.isSymbolicLink()) return '';
  if (!stats.isDirectory()) return undefined;
  const pending = [''];
  let entries = 0;
  while (pending.length > 0) {
    const relativePath = pending.pop();
    for (const entry of await readdir(
      relativePath ? join(path, relativePath) : path,
      { withFileTypes: true },
    )) {
      entries += 1;
      if (entries > MAX_GIT_OBJECT_ENTRIES) {
        throw new AgentWorkflowError(msg('git.objectsTooLarge'), {
          code: 'INTEGRITY_CHECK_FAILED',
          stage: 'preflight',
        });
      }
      const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) return child;
      if (entry.isDirectory()) pending.push(child);
    }
  }
  return undefined;
}

// For a provider that declares gitDirectoryWritable the core does not trust
// the repository index, which a round could rewrite: its Git commands
// (diffs and path lists for the reviewer, gates, the secret scan, manifests,
// snapshots) run with a private index built from HEAD and refreshed against
// the working tree, in a new directory outside the repository, with replace
// refs off. Built in the preflight and again after every round, once the
// fingerprint has passed; the fingerprint itself reads the repository index.
async function createCoreGitIndex({ runner, cwd, stage }) {
  const directory = await mkdtemp(join(tmpdir(), 'ringi-git-index-'));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(directory, 'index'),
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  try {
    await requiredGitRun(
      runner,
      ['read-tree', 'HEAD'],
      { cwd, env, stage },
      msg('git.privateIndexBuild'),
    );
    await requiredGitRun(
      runner,
      ['update-index', '-q', '--refresh'],
      { cwd, env, stage },
      msg('git.privateIndexRefresh'),
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { directory, env };
}

async function removeCoreGitIndex(state) {
  const previous = state.index;
  state.index = undefined;
  if (previous)
    await rm(previous.directory, { recursive: true, force: true });
}

async function refreshCoreGitIndex({ state, runner, cwd, stage }) {
  await removeCoreGitIndex(state);
  state.index = await createCoreGitIndex({ runner, cwd, stage });
}

// The runner with the private index for Git commands that pass no env of
// their own. Without a private index (removed, or its rebuild failed) such a
// command is refused, never run with the repository index.
function withCoreGitIndex(runner, state) {
  return new Proxy(runner, {
    get(target, key) {
      if (key === 'run') {
        return (program, args, options = {}) => {
          if (program !== 'git' || options.env !== undefined)
            return target.run(program, args, options);
          if (!state.index)
            return Promise.reject(
              new AgentWorkflowError(msg('git.privateIndexMissing'), {
                code: 'INTEGRITY_CHECK_FAILED',
                stage: options.stage,
              }),
            );
          return target.run(program, args, { ...options, env: state.index.env });
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function normalizeHeading(value) {
  return value.trim().toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ');
}

// Headings that match an alias of the task schema are stored under the
// canonical section name.
function parseMarkdownSections(markdown, taskSchema) {
  const headings = [];
  const pattern = /^(#{2,6})\s+(.+?)\s*$/gm;
  let match;
  while ((match = pattern.exec(markdown))) {
    const title = normalizeHeading(match[2]);
    const alias = Object.hasOwn(taskSchema.aliases, title);
    headings.push({
      title: alias ? taskSchema.aliases[title] : title,
      alias,
      level: match[1].length,
      start: pattern.lastIndex,
      headingStart: match.index,
    });
  }
  // A section written under an alias must not appear again, under its
  // canonical name or another alias; the parser never picks one silently.
  // Under the default en schema a repeated canonical section heading is
  // rejected the same way; other headings (e.g. two "### Notes") and other
  // schemas keep their earlier behaviour (the last one wins).
  const strictSections = STRICT_DUPLICATE_TASK_SCHEMAS.has(taskSchema)
    ? new Set([...taskSchema.requiredSections, ...taskSchema.optionalSections])
    : new Set();
  for (const { title } of headings.filter(
    (heading) => heading.alias || strictSections.has(heading.title),
  )) {
    if (headings.filter((heading) => heading.title === title).length > 1) {
      throw new AgentWorkflowError(
        msg('task.duplicateSection', { title }),
        { code: 'INVALID_TASK', stage: 'preflight' },
      );
    }
  }
  const sections = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const end = headings[index + 1]?.headingStart ?? markdown.length;
    sections.set(heading.title, markdown.slice(heading.start, end).trim());
  }
  return { sections, headings };
}

function extractRequestedChecks(section, definitions, defaults) {
  const requested = [];
  for (const match of section.matchAll(/`([^`\r\n]+)`/g)) {
    const command = match[1].trim().replace(/\s+/g, ' ');
    if (command) requested.push(command);
  }
  if (requested.length === 0) {
    throw new AgentWorkflowError(
      msg('task.checksBackticks'),
      { code: 'INVALID_TASK', stage: 'preflight' },
    );
  }
  for (const command of requested) {
    if (!Object.hasOwn(definitions, command)) {
      throw new AgentWorkflowError(
        msg('task.unsupportedCheck', { command: JSON.stringify(command) }),
        { code: 'UNSUPPORTED_CHECK', stage: 'preflight' },
      );
    }
  }
  return [...new Set([...defaults, ...requested])];
}

function extractReviewFilePaths(section) {
  if (!section?.trim()) {
    throw new AgentWorkflowError(
      msg('task.reviewFilesRequired'),
      { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
    );
  }
  const paths = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*[-*]\s+`([^`]+)`[.;]?\s*$/);
    if (!match) {
      throw new AgentWorkflowError(
        msg('task.reviewFilesBackticks'),
        { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
      );
    }
    const path = match[1];
    const segments = path.split('/');
    if (
      !path ||
      path.length > 500 ||
      isAbsolute(path) ||
      /^[A-Za-z]:/.test(path) ||
      path.includes('\\') ||
      path.includes('\0') ||
      /[*?\[\]{}!]/.test(path) ||
      isSuspiciousSecretPath(path) ||
      segments.some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          ['.git', '.review-context', STATE_DIRECTORY].includes(segment),
      )
    ) {
      throw new AgentWorkflowError(
        msg('task.reviewFilesNonCanonical'),
        { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
      );
    }
    paths.push(path);
  }
  if (paths.length === 0 || paths.length > MAX_ANALYSIS_REVIEW_FILES) {
    throw new AgentWorkflowError(
      msg('task.reviewFilesCount', { max: MAX_ANALYSIS_REVIEW_FILES }),
      { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
    );
  }
  if (new Set(paths).size !== paths.length) {
    throw new AgentWorkflowError(
      msg('task.reviewFilesDuplicate'),
      { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
    );
  }
  return paths;
}

async function validateAnalysisReviewFiles({ repositoryRoot, paths }) {
  const root = await realpath(repositoryRoot);
  const validated = [];
  const actualPaths = new Set();
  const inodes = new Set();
  let totalBytes = 0;
  for (const path of paths) {
    let current = root;
    for (const segment of path.split('/')) {
      current = join(current, segment);
      const metadata = await lstat(current).catch((error) => {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!metadata) {
        throw new AgentWorkflowError(
          msg('task.reviewFileMissing', { path: JSON.stringify(path) }),
          { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
        );
      }
      if (metadata.isSymbolicLink()) {
        throw new AgentWorkflowError(
          msg('task.reviewFileLink', { path: JSON.stringify(path) }),
          { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
        );
      }
    }
    let handle;
    let metadata;
    let content;
    try {
      handle = await open(
        current,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      metadata = await handle.stat();
      content = await handle.readFile();
    } catch {
      throw new AgentWorkflowError(
        msg('task.reviewFileUnsafe', { path: JSON.stringify(path) }),
        { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
      );
    } finally {
      await handle?.close().catch(() => {});
    }
    const currentMetadata = await lstat(current).catch(() => undefined);
    if (
      !metadata.isFile() ||
      !currentMetadata?.isFile() ||
      currentMetadata.isSymbolicLink() ||
      currentMetadata.dev !== metadata.dev ||
      currentMetadata.ino !== metadata.ino ||
      currentMetadata.size !== metadata.size ||
      metadata.size > MAX_FILE_BYTES ||
      content.length !== metadata.size
    ) {
      throw new AgentWorkflowError(
        msg('task.reviewFileSize', { path: JSON.stringify(path) }),
        { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
      );
    }
    const actual = await realpath(current);
    if (!pathIsInside(root, actual) || relative(root, actual) !== path) {
      throw new AgentWorkflowError(
        msg('task.reviewFileNonCanonical', { path: JSON.stringify(path) }),
        { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
      );
    }
    const inode = `${metadata.dev}:${metadata.ino}`;
    if (actualPaths.has(actual) || inodes.has(inode)) {
      throw new AgentWorkflowError(
        msg('task.reviewFilesSame'),
        { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
      );
    }
    actualPaths.add(actual);
    inodes.add(inode);
    assertNoSecretContent(content.toString('utf8'), path, 'preflight');
    totalBytes += metadata.size;
    if (totalBytes > MAX_ANALYSIS_REVIEW_FILES_BYTES) {
      throw new AgentWorkflowError(
        msg('task.reviewFilesTotal'),
        { code: 'INVALID_ANALYSIS_REVIEW_FILES', stage: 'preflight' },
      );
    }
    validated.push({
      path,
      absolutePath: actual,
      sizeBytes: metadata.size,
      dev: metadata.dev,
      ino: metadata.ino,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return validated;
}

// Its messages are in the locale of the profile, also outside of a run.
export function validateTaskMarkdown(
  markdown,
  taskMode = DEFAULT_TASK_MODE,
  profile,
) {
  return withLocale(profileLocale(profile), () =>
    validateTaskMarkdownInLocale(markdown, taskMode, profile),
  );
}

function validateTaskMarkdownInLocale(
  markdown,
  taskMode = DEFAULT_TASK_MODE,
  profile,
) {
  const selectedTaskMode = resolveTaskMode(taskMode);
  const selectedProfile = resolveRunnerProfile(profile);
  if (Buffer.byteLength(markdown) > MAX_TASK_BYTES) {
    throw new AgentWorkflowError(msg('task.tooLarge'), {
      code: 'INVALID_TASK',
      stage: 'preflight',
    });
  }
  const { taskSchema } = selectedProfile;
  const roles = taskSchemaRoles(taskSchema);
  const { sections, headings } = parseMarkdownSections(markdown, taskSchema);
  const classHeadings = headings.filter(
    (heading) => heading.title === roles.taskClass,
  );
  // Only a level-2 heading (canonical name or alias) sets the class; a
  // deeper one is rejected rather than read as the class or ignored.
  if (classHeadings.some((heading) => heading.level !== 2)) {
    throw new AgentWorkflowError(
      msg('task.classHeading'),
      { code: 'INVALID_TASK_CLASS', stage: 'preflight' },
    );
  }
  const taskClass = sections.has(roles.taskClass)
    ? sections.get(roles.taskClass).trim()
    : DEFAULT_TASK_CLASS;
  if (
    classHeadings.length > 1 ||
    !Object.hasOwn(selectedProfile.taskClasses, taskClass) ||
    (selectedTaskMode === 'analysis' &&
      classHeadings.length &&
      taskClass !== DEFAULT_TASK_CLASS)
  ) {
    throw new AgentWorkflowError(
      msg('task.classInvalid'),
      { code: 'INVALID_TASK_CLASS', stage: 'preflight' },
    );
  }
  const quality = taskQualityPolicy(
    selectedProfile,
    taskClass,
    selectedTaskMode,
  );
  for (const required of taskSchema.requiredSections) {
    if (!sections.get(required)?.trim()) {
      throw new AgentWorkflowError(
        msg('task.sectionMissing', { section: required }),
        { code: 'INVALID_TASK', stage: 'preflight' },
      );
    }
  }
  const recognizedSections = [
    ...taskSchema.requiredSections,
    ...taskSchema.optionalSections.filter((section) => sections.has(section)),
  ];
  const reviewFilePaths =
    selectedTaskMode === 'analysis'
      ? extractReviewFilePaths(sections.get(roles.reviewFiles))
      : [];
  return {
    taskClass,
    quality,
    sections: Object.fromEntries(
      recognizedSections.map((section) => [section, sections.get(section)]),
    ),
    checks:
      selectedTaskMode === 'implementation'
        ? extractRequestedChecks(
            sections.get(roles.requiredChecks),
            selectedProfile.checks,
            selectedProfile.checkSets[
              selectedProfile.taskClasses[taskClass].checkSet
            ],
          )
        : [],
    reviewFilePaths,
  };
}

export async function loadTaskFile({
  repositoryRoot,
  taskPath,
  taskMode = DEFAULT_TASK_MODE,
  profile,
}) {
  const selectedTaskMode = resolveTaskMode(taskMode);
  if (!taskPath || typeof taskPath !== 'string') {
    throw new AgentWorkflowError(msg('task.pathMissing'), {
      code: 'INVALID_TASK_PATH',
      stage: 'preflight',
    });
  }
  const root = await realpath(repositoryRoot);
  const lexical = resolve(root, taskPath);
  if (!pathIsInside(root, lexical)) {
    throw new AgentWorkflowError(
      msg('task.notInRepository'),
      {
        code: 'TASK_PATH_ESCAPE',
        stage: 'preflight',
      },
    );
  }
  const metadata = await lstat(lexical).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new AgentWorkflowError(
      msg('task.notRegular'),
      { code: 'INVALID_TASK_PATH', stage: 'preflight' },
    );
  }
  const actual = await realpath(lexical);
  if (!pathIsInside(root, actual)) {
    throw new AgentWorkflowError(msg('task.escapes'), {
      code: 'TASK_PATH_ESCAPE',
      stage: 'preflight',
    });
  }
  const markdown = await readFile(actual, 'utf8');
  const relativeTaskPath = relative(root, actual);
  if (selectedTaskMode === 'analysis' && relativeTaskPath.length > 500) {
    throw new AgentWorkflowError(
      msg('task.analysisPathLength'),
      { code: 'INVALID_TASK_PATH', stage: 'preflight' },
    );
  }
  const validation = validateTaskMarkdown(markdown, selectedTaskMode, profile);
  const reviewFiles =
    selectedTaskMode === 'analysis'
      ? await validateAnalysisReviewFiles({
          repositoryRoot: root,
          paths: validation.reviewFilePaths,
        })
      : [];
  assertNoSecretContent(markdown, relativeTaskPath);
  return {
    path: relativeTaskPath,
    absolutePath: actual,
    markdown,
    hash: createHash('sha256').update(markdown).digest('hex'),
    mode: selectedTaskMode,
    reviewFiles,
    ...validation,
  };
}

export function isSuspiciousSecretPath(path) {
  const name = basename(path).toLowerCase();
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (['.npmrc', '.pypirc', '.netrc', 'credentials.json'].includes(name)) {
    return true;
  }
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(name)) return true;
  return /\.(?:key|pem|p12|pfx|crt|cer|der|jks|keystore)$/i.test(name);
}

function contentSecretFindings(value, path) {
  const findings = [];
  const patterns = [
    [
      msg('secret.providerToken'),
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g,
    ],
    [
      msg('secret.authorizationHeader'),
      /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
    ],
    [msg('secret.urlCredentials'), /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{8,}@/gi],
    [
      msg('secret.secretVariable'),
      /\b[A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY|CREDENTIALS)[A-Z0-9_]*\s*[=:]\s*["']?([A-Za-z0-9._~+/-]{16,})/gi,
    ],
  ];
  for (const [label, pattern] of patterns) {
    for (const match of value.matchAll(pattern)) {
      findings.push({
        path,
        label,
        fingerprint: createHash('sha256')
          .update(`${label}\0${match[0]}`)
          .digest('hex'),
      });
    }
  }
  return findings;
}

export function assertNoSecretContent(
  value,
  path = msg('secret.defaultPath'),
  stage = 'preflight',
) {
  const findings = contentSecretFindings(value, path);
  if (findings.length > 0) {
    const labels = [...new Set(findings.map((finding) => finding.label))];
    throw new AgentWorkflowError(
      msg('secret.detected', {
        path: JSON.stringify(path),
        labels: labels.join(', '),
      }),
      { code: 'SECRET_DETECTED', stage },
    );
  }
}

function parseNullSeparated(value) {
  return value.split('\0').filter(Boolean);
}

function addFindingCount(counts, finding) {
  const current = counts.get(finding.fingerprint);
  counts.set(finding.fingerprint, {
    ...finding,
    count: (current?.count ?? 0) + 1,
    paths: [...new Set([...(current?.paths ?? []), finding.path])],
  });
}

function scanEntryForSecrets(entry) {
  const findings = [];
  if (isSuspiciousSecretPath(entry.path)) {
    const label = msg('secret.suspiciousPath');
    findings.push({
      path: entry.path,
      label,
      fingerprint: createHash('sha256')
        .update(`${entry.path}\0${label}`)
        .digest('hex'),
    });
  }
  if (entry.type === 'file' && !entry.content.includes(0)) {
    findings.push(
      ...contentSecretFindings(entry.content.toString('utf8'), entry.path),
    );
  }
  return findings;
}

async function readAllRepositoryPaths(runner, cwd, stage) {
  const result = await requiredGitRun(
    runner,
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd, stage, exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES },
    msg('secret.filesUnreadable'),
  );
  return parseNullSeparated(result.stdout).sort();
}

async function scanWorkingTreeSecrets({ runner, cwd, stage }) {
  const counts = new Map();
  for (const path of await readAllRepositoryPaths(runner, cwd, stage)) {
    assertNotCancelled(runner, stage);
    const entry = await inspectRepositoryPath(cwd, path);
    if (entry.type === 'missing') continue;
    for (const finding of scanEntryForSecrets(entry)) {
      addFindingCount(counts, finding);
    }
  }
  return counts;
}

async function scanHeadSecretsForCurrentFindings({
  runner,
  cwd,
  stage,
  current,
}) {
  const trackedResult = await requiredGitRun(
    runner,
    ['ls-files', '-z', '--cached'],
    { cwd, stage, exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES },
    msg('secret.trackedUnreadable'),
  );
  const tracked = new Set(parseNullSeparated(trackedResult.stdout));
  const changedResult = await requiredGitRun(
    runner,
    ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--'],
    { cwd, stage, exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES },
    msg('secret.basePathsUnreadable'),
  );
  const paths = [
    ...new Set([
      ...[...current.values()].flatMap(({ paths, path }) => paths ?? [path]),
      ...parseNullSeparated(changedResult.stdout),
    ]),
  ];
  const baseline = new Map();
  for (const path of paths) {
    if (!tracked.has(path)) continue;
    const result = await requiredGitRun(
      runner,
      ['show', `HEAD:${path}`],
      { cwd, stage, exactStdoutLimitBytes: MAX_FILE_BYTES },
      msg('secret.baseVersionUnreadable', { path: JSON.stringify(path) }),
    );
    const entry = {
      path,
      type: 'file',
      content: Buffer.from(result.stdout),
    };
    for (const finding of scanEntryForSecrets(entry)) {
      addFindingCount(baseline, finding);
    }
  }
  return baseline;
}

function newSecretFindings(current, baseline) {
  return [...current.values()].filter(
    (finding) =>
      finding.count > (baseline.get(finding.fingerprint)?.count ?? 0),
  );
}

function throwNewSecretFindings(findings, stage) {
  if (findings.length === 0) return;
  const summary = findings
    .slice(0, 10)
    .map(
      ({ path, label }) => `${JSON.stringify(redactSensitive(path))}: ${label}`,
    )
    .join(', ');
  throw new AgentWorkflowError(
    msg('secret.newFindings', { count: findings.length, summary }),
    { code: 'SECRET_DETECTED', stage },
  );
}

async function establishSecretBaseline({ runner, cwd, stage = 'preflight' }) {
  const current = await scanWorkingTreeSecrets({ runner, cwd, stage });
  const head = await scanHeadSecretsForCurrentFindings({
    runner,
    cwd,
    stage,
    current,
  });
  throwNewSecretFindings(newSecretFindings(current, head), stage);
  return current;
}

async function assertNoNewSecrets({ runner, cwd, baseline, stage }) {
  const current = await scanWorkingTreeSecrets({ runner, cwd, stage });
  throwNewSecretFindings(newSecretFindings(current, baseline), stage);
}

function safeAgentEnvironment(source = process.env) {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TERM',
    'NO_COLOR',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
  ];
  const env = { CI: '1', NO_COLOR: '1' };
  for (const key of allowed) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

async function createIsolatedCodexEnvironment({
  tempRoot,
  source = process.env,
  corepackHome,
}) {
  const root = join(tempRoot, 'codex-environment');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const npmConfig = join(root, 'npmrc');
  await writeFile(npmConfig, ISOLATED_NPMRC, { mode: 0o600 });
  const env = safeAgentEnvironment(source);
  delete env.CLAUDE_CONFIG_DIR;
  return {
    ...env,
    NPM_CONFIG_USERCONFIG: npmConfig,
    COREPACK_HOME: corepackHome,
    COREPACK_ENABLE_NETWORK: '0',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
    DO_NOT_TRACK: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    TURBO_TELEMETRY_DISABLED: '1',
  };
}

function readOptionalLocalDockerHost(source) {
  const value = source.DOCKER_HOST;
  if (value === undefined || value === '') return undefined;

  const fail = () => {
    throw new AgentWorkflowError(
      msg('docker.invalidHost'),
      { code: 'INVALID_DOCKER_HOST', stage: 'preflight' },
    );
  };

  if (
    typeof value !== 'string' ||
    /[\u0000-\u001f\u007f\\%]/.test(value) ||
    !value.startsWith('unix:///')
  ) {
    fail();
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail();
  }

  const socketPath = value.slice('unix://'.length);
  const segments = socketPath.split('/').slice(1);
  const allowedSocketPaths = new Set(['/var/run/docker.sock']);
  const sourceHome = source.HOME;
  if (
    typeof sourceHome === 'string' &&
    sourceHome !== '/' &&
    isAbsolute(sourceHome) &&
    resolve(sourceHome) === sourceHome
  ) {
    allowedSocketPaths.add(join(sourceHome, '.docker', 'run', 'docker.sock'));
  }
  if (
    parsed.protocol !== 'unix:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.host !== '' ||
    parsed.hostname !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== socketPath ||
    parsed.href !== value ||
    !isAbsolute(socketPath) ||
    socketPath.length <= 1 ||
    !allowedSocketPaths.has(socketPath) ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    fail();
  }

  return value;
}

async function createIsolatedCheckEnvironment({
  tempRoot,
  source = process.env,
  corepackHome,
}) {
  const root = join(tempRoot, 'check-environment');
  const home = join(root, 'home');
  const config = join(root, 'xdg-config');
  const cache = join(root, 'xdg-cache');
  const temporary = join(root, 'tmp');
  const ghConfig = join(root, 'gh');
  await Promise.all(
    [home, config, cache, temporary, ghConfig].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  const npmConfig = join(root, 'npmrc');
  await writeFile(npmConfig, ISOLATED_NPMRC, { mode: 0o600 });
  const env = {
    PATH: source.PATH ?? '',
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    TMPDIR: temporary,
    GH_CONFIG_DIR: ghConfig,
    NPM_CONFIG_USERCONFIG: npmConfig,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    CI: '1',
    NO_COLOR: '1',
    DO_NOT_TRACK: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    TURBO_TELEMETRY_DISABLED: '1',
    COREPACK_HOME: corepackHome,
    COREPACK_ENABLE_NETWORK: '0',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
  };
  for (const key of ['LANG', 'LC_ALL', 'TERM']) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

async function readDependencyMetadataEntry({
  repositoryRoot,
  path,
  required,
  stage,
  missingCode,
}) {
  const parts = path.split('/');
  let current = repositoryRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        if (!required) return { path, exists: false };
        throw new AgentWorkflowError(
          msg('deps.metadataMissing'),
          { code: missingCode, stage },
        );
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new AgentWorkflowError(
        msg('deps.metadataSymlink', { path: JSON.stringify(path) }),
        { code: 'DEPENDENCY_METADATA_INVALID', stage },
      );
    }
    const isLast = index === parts.length - 1;
    if (
      (!isLast && !metadata.isDirectory()) ||
      (isLast && !metadata.isFile())
    ) {
      throw new AgentWorkflowError(
        msg('deps.metadataNotRegular', { path: JSON.stringify(path) }),
        { code: 'DEPENDENCY_METADATA_INVALID', stage },
      );
    }
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(current, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (before.size > MAX_DEPENDENCY_METADATA_FILE_BYTES) {
      throw new AgentWorkflowError(
        msg('deps.metadataFileLimit', {
          path: JSON.stringify(path),
          limit: MAX_DEPENDENCY_METADATA_FILE_BYTES,
        }),
        { code: 'DEPENDENCY_METADATA_TOO_LARGE', stage },
      );
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      content.length !== after.size
    ) {
      throw new AgentWorkflowError(
        msg('deps.metadataFileChanged', { path: JSON.stringify(path) }),
        { code: 'DEPENDENCY_METADATA_CHANGED', stage },
      );
    }
    return {
      path,
      exists: true,
      inode: before.ino,
      mode: before.mode & 0o777,
      mtimeMs: before.mtimeMs,
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

async function createDependencyMetadataFingerprint({
  repositoryRoot,
  stage = 'preflight',
  missingCode = 'DEPENDENCIES_NOT_INSTALLED',
}) {
  const entries = [];
  for (const path of REQUIRED_DEPENDENCY_METADATA_PATHS) {
    entries.push(
      await readDependencyMetadataEntry({
        repositoryRoot,
        path,
        required: true,
        stage,
        missingCode,
      }),
    );
  }
  for (const path of OPTIONAL_DEPENDENCY_METADATA_PATHS) {
    entries.push(
      await readDependencyMetadataEntry({
        repositoryRoot,
        path,
        required: false,
        stage,
        missingCode,
      }),
    );
  }
  const totalBytes = entries.reduce(
    (total, entry) => total + (entry.size ?? 0),
    0,
  );
  if (totalBytes > MAX_DEPENDENCY_METADATA_TOTAL_BYTES) {
    throw new AgentWorkflowError(
      msg('deps.metadataTotalLimit', {
        limit: MAX_DEPENDENCY_METADATA_TOTAL_BYTES,
      }),
      { code: 'DEPENDENCY_METADATA_TOO_LARGE', stage },
    );
  }
  return {
    hash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    entries,
    totalBytes,
  };
}

async function assertDependencyMetadataUnchanged({
  repositoryRoot,
  baseline,
  stage,
}) {
  const current = await createDependencyMetadataFingerprint({
    repositoryRoot,
    stage,
    missingCode: 'DEPENDENCY_METADATA_CHANGED',
  });
  if (current.hash !== baseline.hash) {
    throw new AgentWorkflowError(
      msg('deps.metadataChanged'),
      { code: 'DEPENDENCY_METADATA_CHANGED', stage },
    );
  }
}

function isDependencyInputPath(path) {
  const name = basename(path);
  return DEPENDENCY_INPUT_NAMES.has(name) || name.endsWith('.patch');
}

async function createDependencyInputFingerprint({
  runner,
  repositoryRoot,
  stage = 'preflight',
}) {
  const paths = (await listRepositoryPaths(runner, repositoryRoot, stage))
    .filter(isDependencyInputPath)
    .sort();
  const entries = [];
  let totalBytes = 0;
  for (const path of paths) {
    assertNotCancelled(runner, stage);
    const entry = await inspectRepositoryPath(repositoryRoot, path);
    if (entry.type === 'symlink') {
      throw new AgentWorkflowError(
        msg('deps.inputSymlink', { path: JSON.stringify(path) }),
        { code: 'DEPENDENCY_INPUT_INVALID', stage },
      );
    }
    totalBytes += entry.size;
    if (totalBytes > MAX_DEPENDENCY_INPUT_TOTAL_BYTES) {
      throw new AgentWorkflowError(
        msg('deps.inputTotalLimit', { limit: MAX_DEPENDENCY_INPUT_TOTAL_BYTES }),
        { code: 'DEPENDENCY_INPUT_TOO_LARGE', stage },
      );
    }
    entries.push(entry);
  }
  return {
    paths,
    entries,
    totalBytes,
    hash: manifestHash(entries),
  };
}

async function assertDependencyInputsUnchanged({
  runner,
  repositoryRoot,
  baseline,
  stage,
}) {
  const current = await createDependencyInputFingerprint({
    runner,
    repositoryRoot,
    stage,
  });
  if (current.hash !== baseline.hash) {
    throw new AgentWorkflowError(
      msg('deps.inputsChanged'),
      { code: 'DEPENDENCY_INPUT_CHANGED', stage },
    );
  }
}

function dependencyStateRepairMessage(reason) {
  return msg('deps.repair', { reason });
}

async function copyPnpmValidationInputs({ dependencyInputs, targetRoot }) {
  for (const entry of dependencyInputs.entries) {
    if (
      entry.type !== 'file' ||
      !(
        basename(entry.path) === 'package.json' ||
        [
          'pnpm-lock.yaml',
          'pnpm-workspace.yaml',
          '.npmrc',
          '.pnpmfile.cjs',
          '.pnpmfile.mjs',
        ].includes(basename(entry.path)) ||
        entry.path.endsWith('.patch')
      )
    ) {
      continue;
    }
    const target = resolve(targetRoot, entry.path);
    if (!pathIsInside(targetRoot, target)) {
      throw new AgentWorkflowError(
        msg('deps.validationEscape'),
        { code: 'PATH_ESCAPE', stage: 'preflight' },
      );
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, entry.content, { mode: 0o600 });
  }
}

async function verifyInstalledDependencyState({
  runner,
  dependencyMetadata,
  dependencyInputs,
  environment,
  tempRoot,
}) {
  const repositoryLock = dependencyInputs.entries.find(
    (entry) => entry.path === 'pnpm-lock.yaml',
  );
  const installedLock = dependencyMetadata.entries.find(
    (entry) => entry.path === 'node_modules/.pnpm/lock.yaml',
  );
  if (
    repositoryLock?.type !== 'file' ||
    !installedLock?.exists ||
    repositoryLock.size !== installedLock.size ||
    repositoryLock.hash !== installedLock.sha256
  ) {
    throw new AgentWorkflowError(
      dependencyStateRepairMessage(
        msg('deps.lockMismatch'),
      ),
      { code: 'DEPENDENCY_STATE_STALE', stage: 'preflight' },
    );
  }

  const validationRoot = join(tempRoot, 'dependency-validation');
  const storeDirectory = join(validationRoot, '.pnpm-store');
  const modulesDirectory = join(validationRoot, '.modules');
  const virtualStoreDirectory = join(validationRoot, '.virtual-store');
  await mkdir(validationRoot, { recursive: true, mode: 0o700 });
  try {
    await copyPnpmValidationInputs({
      dependencyInputs,
      targetRoot: validationRoot,
    });
    const validation = await safeRun(
      runner,
      'pnpm',
      [
        'install',
        '--lockfile-only',
        '--offline',
        '--frozen-lockfile',
        '--trust-lockfile',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--store-dir',
        storeDirectory,
        '--modules-dir',
        modulesDirectory,
        '--virtual-store-dir',
        virtualStoreDirectory,
        '--reporter=append-only',
      ],
      {
        cwd: validationRoot,
        env: environment,
        stage: 'preflight',
        timeoutMs: 2 * 60_000,
      },
      msg('deps.manifestsUnverifiable'),
    );
    if (validation.code !== 0) {
      throw new AgentWorkflowError(
        dependencyStateRepairMessage(
          msg('deps.manifestsMismatch', {
            detail: conciseProcessFailure(validation),
          }),
        ),
        { code: 'DEPENDENCY_MANIFEST_MISMATCH', stage: 'preflight' },
      );
    }
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
}

function parsePinnedPnpmSpecification(specification) {
  if (typeof specification !== 'string') {
    throw new AgentWorkflowError(
      msg('pnpm.pinExact'),
      { code: 'INVALID_PACKAGE_MANAGER', stage: 'preflight' },
    );
  }
  const managerSeparator = specification.indexOf('@');
  if (
    managerSeparator <= 0 ||
    managerSeparator !== specification.lastIndexOf('@')
  ) {
    throw new AgentWorkflowError(
      msg('pnpm.pinFormat'),
      { code: 'INVALID_PACKAGE_MANAGER', stage: 'preflight' },
    );
  }
  const manager = specification.slice(0, managerSeparator);
  const reference = specification.slice(managerSeparator + 1);
  if (manager !== 'pnpm') {
    throw new AgentWorkflowError(
      msg('pnpm.onlyPnpm'),
      { code: 'INVALID_PACKAGE_MANAGER', stage: 'preflight' },
    );
  }
  const integritySeparator = reference.indexOf('+');
  const version =
    integritySeparator === -1
      ? reference
      : reference.slice(0, integritySeparator);
  const integrity =
    integritySeparator === -1
      ? undefined
      : reference.slice(integritySeparator + 1);
  if (!EXACT_SEMVER_PATTERN.test(version)) {
    throw new AgentWorkflowError(
      msg('pnpm.pinSemver'),
      { code: 'INVALID_PACKAGE_MANAGER', stage: 'preflight' },
    );
  }
  if (integrity !== undefined) {
    const match = /^(sha1|sha224|sha256|sha384|sha512)\.([0-9a-f]+)$/.exec(
      integrity,
    );
    const expectedLength = match
      ? COREPACK_INTEGRITY_HEX_LENGTHS.get(match[1])
      : undefined;
    if (!match || match[2].length !== expectedLength) {
      throw new AgentWorkflowError(
        msg('pnpm.integritySuffix'),
        { code: 'INVALID_PACKAGE_MANAGER', stage: 'preflight' },
      );
    }
  }
  return { specification, version, integrity };
}

async function readPinnedPnpmVersion(repositoryRoot) {
  const packagePath = join(repositoryRoot, 'package.json');
  const metadata = await lstat(packagePath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new AgentWorkflowError(
      msg('pnpm.packageJsonRegular'),
      { code: 'INVALID_PACKAGE_MANAGER', stage: 'preflight' },
    );
  }
  const raw = await readFile(packagePath, 'utf8');
  let packageJson;
  try {
    packageJson = JSON.parse(raw);
  } catch {
    throw new AgentWorkflowError(msg('pnpm.packageJsonInvalid'), {
      code: 'INVALID_PACKAGE_MANAGER',
      stage: 'preflight',
    });
  }
  return parsePinnedPnpmSpecification(packageJson.packageManager);
}

function resolveCorepackHome(source = process.env) {
  const fallbackHome = source.HOME || homedir();
  const cacheBase =
    source.COREPACK_HOME ??
    source.XDG_CACHE_HOME ??
    source.LOCALAPPDATA ??
    join(
      fallbackHome,
      process.platform === 'win32' ? 'AppData/Local' : '.cache',
    );
  const candidate = source.COREPACK_HOME
    ? cacheBase
    : join(cacheBase, 'node', 'corepack');
  if (!isAbsolute(candidate)) {
    throw new AgentWorkflowError(
      msg('corepack.homeAbsolute'),
      { code: 'INVALID_COREPACK_CACHE', stage: 'preflight' },
    );
  }
  return resolve(candidate);
}

async function walkCorepackTree({
  sourceRoot,
  maxEntries = MAX_COREPACK_CACHE_ENTRIES,
  maxBytes = MAX_COREPACK_CACHE_BYTES,
  onDirectory = async () => {},
  onFile = async () => {},
}) {
  const rootMetadata = await lstat(sourceRoot).catch(() => undefined);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new AgentWorkflowError(
      msg('corepack.versionMissing'),
      { code: 'PNPM_CACHE_MISSING', stage: 'preflight' },
    );
  }
  const realRoot = await realpath(sourceRoot);
  let entryCount = 0;
  let totalBytes = 0;
  const manifest = [];

  async function visit(relativePath = '') {
    const directory = relativePath
      ? join(sourceRoot, relativePath)
      : sourceRoot;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relativePath
        ? join(relativePath, entry.name)
        : entry.name;
      const child = join(sourceRoot, childRelative);
      const metadata = await lstat(child);
      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new AgentWorkflowError(
          msg('corepack.cacheEntries', { limit: maxEntries }),
          { code: 'COREPACK_CACHE_LIMIT', stage: 'preflight' },
        );
      }
      if (metadata.isSymbolicLink()) {
        throw new AgentWorkflowError(
          msg('corepack.cacheLink', { path: JSON.stringify(childRelative) }),
          { code: 'COREPACK_CACHE_SYMLINK', stage: 'preflight' },
        );
      }
      const actual = await realpath(child);
      if (!pathIsInside(realRoot, actual)) {
        throw new AgentWorkflowError(
          msg('corepack.cacheEscape'),
          { code: 'COREPACK_CACHE_ESCAPE', stage: 'preflight' },
        );
      }
      if (metadata.isDirectory()) {
        await onDirectory(childRelative);
        manifest.push({ path: childRelative, type: 'directory' });
        await visit(childRelative);
        continue;
      }
      if (!metadata.isFile()) {
        throw new AgentWorkflowError(
          msg('corepack.cacheUnsupported', {
            path: JSON.stringify(childRelative),
          }),
          { code: 'INVALID_COREPACK_CACHE', stage: 'preflight' },
        );
      }
      totalBytes += metadata.size;
      if (totalBytes > maxBytes) {
        throw new AgentWorkflowError(
          msg('corepack.cacheBytes', { limit: maxBytes }),
          { code: 'COREPACK_CACHE_LIMIT', stage: 'preflight' },
        );
      }
      const handle = await open(
        child,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      let content;
      try {
        const openedMetadata = await handle.stat();
        if (!openedMetadata.isFile() || openedMetadata.size !== metadata.size) {
          throw new AgentWorkflowError(
            msg('corepack.cacheChangedRead'),
            { code: 'COREPACK_CACHE_CHANGED', stage: 'preflight' },
          );
        }
        content = await handle.readFile();
      } finally {
        await handle.close();
      }
      const hash = createHash('sha256').update(content).digest('hex');
      manifest.push({
        path: childRelative,
        type: 'file',
        size: content.length,
        hash,
      });
      await onFile(childRelative, content, metadata.mode);
    }
  }

  await visit();
  return {
    entryCount,
    totalBytes,
    hash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  };
}

async function copyPinnedCorepackCache({
  sourceHome,
  targetHome,
  version,
  maxEntries = MAX_COREPACK_CACHE_ENTRIES,
  maxBytes = MAX_COREPACK_CACHE_BYTES,
}) {
  const sourceRoot = join(sourceHome, 'v1', 'pnpm', version);
  const targetRoot = join(targetHome, 'v1', 'pnpm', version);
  const sourceHomeMetadata = await lstat(sourceHome).catch(() => undefined);
  if (!sourceHomeMetadata) {
    throw new AgentWorkflowError(msg('corepack.homeMissing'), {
      code: 'PNPM_CACHE_MISSING',
      stage: 'preflight',
    });
  }
  if (
    !sourceHomeMetadata.isDirectory() ||
    sourceHomeMetadata.isSymbolicLink()
  ) {
    throw new AgentWorkflowError(
      msg('corepack.homeNotDirectory'),
      { code: 'INVALID_COREPACK_CACHE', stage: 'preflight' },
    );
  }
  for (const component of [
    join(sourceHome, 'v1'),
    join(sourceHome, 'v1', 'pnpm'),
    sourceRoot,
  ]) {
    const metadata = await lstat(component).catch(() => undefined);
    if (metadata?.isSymbolicLink()) {
      throw new AgentWorkflowError(
        msg('corepack.pinnedLink'),
        { code: 'COREPACK_CACHE_SYMLINK', stage: 'preflight' },
      );
    }
  }
  const realSourceHome = await realpath(sourceHome);
  const realSourceRoot = await realpath(sourceRoot).catch(() => undefined);
  if (realSourceRoot && !pathIsInside(realSourceHome, realSourceRoot)) {
    throw new AgentWorkflowError(
      msg('corepack.pinnedEscape'),
      { code: 'COREPACK_CACHE_ESCAPE', stage: 'preflight' },
    );
  }
  if (await lstat(targetRoot).catch(() => undefined)) {
    throw new AgentWorkflowError(msg('corepack.isolatedExists'), {
      code: 'INVALID_COREPACK_CACHE',
      stage: 'preflight',
    });
  }
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const copied = await walkCorepackTree({
    sourceRoot,
    maxEntries,
    maxBytes,
    onDirectory: async (relativePath) => {
      await mkdir(join(targetRoot, relativePath), {
        recursive: true,
        mode: 0o700,
      });
    },
    onFile: async (relativePath, content, mode) => {
      const target = join(targetRoot, relativePath);
      await writeFile(target, content, {
        mode: (mode & 0o111) !== 0 ? 0o500 : 0o400,
      });
    },
  });
  const sourceAfter = await walkCorepackTree({
    sourceRoot,
    maxEntries,
    maxBytes,
  });
  if (copied.hash !== sourceAfter.hash) {
    throw new AgentWorkflowError(
      msg('corepack.sourceChanged'),
      { code: 'COREPACK_CACHE_CHANGED', stage: 'preflight' },
    );
  }
  return { ...copied, sourceRoot, targetRoot };
}

async function validatePinnedCorepackIntegrity(cacheRoot, pinned) {
  if (!pinned.integrity) return;
  const metadataPath = join(cacheRoot, '.corepack');
  const metadata = await lstat(metadataPath).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new AgentWorkflowError(
      msg('corepack.integrityMissing'),
      { code: 'PNPM_INTEGRITY_MISMATCH', stage: 'preflight' },
    );
  }
  let corepackMetadata;
  try {
    corepackMetadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch {
    throw new AgentWorkflowError(
      msg('corepack.integrityInvalid'),
      { code: 'PNPM_INTEGRITY_MISMATCH', stage: 'preflight' },
    );
  }
  const expectedReference = `${pinned.version}+${pinned.integrity}`;
  if (
    corepackMetadata?.hash !== pinned.integrity ||
    corepackMetadata?.locator?.name !== 'pnpm' ||
    corepackMetadata?.locator?.reference !== expectedReference
  ) {
    throw new AgentWorkflowError(
      msg('corepack.integrityMismatch'),
      { code: 'PNPM_INTEGRITY_MISMATCH', stage: 'preflight' },
    );
  }
}

async function preparePinnedCorepackCopy({
  sourceHome,
  targetHome,
  pinned,
  maxEntries,
  maxBytes,
}) {
  const copied = await copyPinnedCorepackCache({
    sourceHome,
    targetHome,
    version: pinned.version,
    maxEntries,
    maxBytes,
  });
  await validatePinnedCorepackIntegrity(copied.targetRoot, pinned);
  return {
    entryCount: copied.entryCount,
    totalBytes: copied.totalBytes,
    manifestHash: copied.hash,
    targetRoot: copied.targetRoot,
  };
}

async function assertPreparedCorepackCacheUnchanged({
  cache,
  stage = 'checks',
}) {
  const current = await walkCorepackTree({
    sourceRoot: cache.targetRoot,
    maxEntries: MAX_COREPACK_CACHE_ENTRIES,
    maxBytes: MAX_COREPACK_CACHE_BYTES,
  });
  if (
    current.hash !== cache.manifestHash ||
    current.entryCount !== cache.entryCount ||
    current.totalBytes !== cache.totalBytes
  ) {
    throw new AgentWorkflowError(
      msg('corepack.checkCacheChanged'),
      { code: 'COREPACK_CACHE_CHANGED', stage },
    );
  }
}

async function verifyPinnedPnpm({
  runner,
  repositoryRoot,
  environment,
  version,
  label,
}) {
  const versionResult = await requiredRun(
    runner,
    'pnpm',
    ['--version'],
    {
      cwd: repositoryRoot,
      env: environment,
      stage: 'preflight',
      timeoutMs: 30_000,
      exactStdoutLimitBytes: MAX_GIT_SCALAR_BYTES,
    },
    msg('corepack.runPinned', { label }),
  );
  const actualVersion = versionResult.stdout.trim();
  if (actualVersion !== version) {
    throw new AgentWorkflowError(
      msg('corepack.versionMismatch', {
        label,
        actual: JSON.stringify(actualVersion),
        expected: JSON.stringify(version),
      }),
      { code: 'PNPM_VERSION_MISMATCH', stage: 'preflight' },
    );
  }
}

async function createCheckEnvironment({
  runner,
  repositoryRoot,
  tempRoot,
  source = process.env,
  maxEntries,
  maxBytes,
}) {
  const dockerHost = readOptionalLocalDockerHost(source);
  const pinned = await readPinnedPnpmVersion(repositoryRoot);
  const sourceHome = resolveCorepackHome(source);
  const codexCorepackHome = join(tempRoot, 'codex-environment', 'corepack');
  const checkCorepackHome = join(tempRoot, 'check-environment', 'corepack');
  let codexCache;
  let checkCache;
  try {
    codexCache = await preparePinnedCorepackCopy({
      sourceHome,
      targetHome: codexCorepackHome,
      pinned,
      maxEntries,
      maxBytes,
    });
    checkCache = await preparePinnedCorepackCopy({
      sourceHome,
      targetHome: checkCorepackHome,
      pinned,
      maxEntries,
      maxBytes,
    });
  } catch (error) {
    if (
      error instanceof AgentWorkflowError &&
      error.code === 'PNPM_CACHE_MISSING'
    ) {
      throw new AgentWorkflowError(
        msg('corepack.cacheMissing', { specification: pinned.specification }),
        { code: 'PNPM_CACHE_MISSING', stage: 'preflight' },
      );
    }
    throw error;
  }
  if (
    resolve(codexCache.targetRoot) === resolve(checkCache.targetRoot) ||
    codexCache.manifestHash !== checkCache.manifestHash
  ) {
    throw new AgentWorkflowError(
      msg('corepack.copiesUnconfirmed'),
      { code: 'COREPACK_CACHE_CHANGED', stage: 'preflight' },
    );
  }
  const environment = await createIsolatedCheckEnvironment({
    tempRoot,
    source,
    corepackHome: checkCorepackHome,
  });
  const codexEnvironment = await createIsolatedCodexEnvironment({
    tempRoot,
    source,
    corepackHome: codexCorepackHome,
  });
  await verifyPinnedPnpm({
    runner,
    repositoryRoot,
    environment: codexEnvironment,
    version: pinned.version,
    label: msg('corepack.labelWriter'),
  });
  await verifyPinnedPnpm({
    runner,
    repositoryRoot,
    environment,
    version: pinned.version,
    label: msg('corepack.labelChecks'),
  });
  return {
    environment,
    codexEnvironment,
    dockerHost,
    packageManager: pinned.specification,
    pnpmVersion: pinned.version,
    cache: checkCache,
    caches: { codex: codexCache, checks: checkCache },
  };
}

function createRunId(
  now = new Date(),
  random = randomBytes(4).toString('hex'),
) {
  return `${now.toISOString().replace(/[:.]/g, '-')}--${random}`;
}

function codexSchema(taskMode = DEFAULT_TASK_MODE) {
  const selectedTaskMode = resolveTaskMode(taskMode);
  const responseProperties = {
    findingId: {
      type: 'string',
      pattern: `^${FINDING_ID_PREFIX}[0-9a-f]{24}$`,
    },
    status: {
      type: 'string',
      enum: ['CONFIRMED', 'REJECTED', 'NEEDS_HUMAN'],
    },
    analysis: { type: 'string', maxLength: 2_000 },
    evidence: { type: 'string', maxLength: 4_000 },
    fix: { type: 'string', maxLength: 2_000 },
    regressionTest: { type: 'string', maxLength: 2_000 },
    checks: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_FINDING_RESPONSE_CHECK_CHARACTERS,
        pattern: FINDING_RESPONSE_CHECK_SCHEMA_PATTERN,
      },
    },
    question: { type: 'string', maxLength: 2_000 },
  };
  const required = [
    'status',
    'changes',
    'checks',
    'deferred',
    'summary',
    'findingResponses',
  ];
  const properties = {
    status: {
      type: 'string',
      enum: [
        'COMPLETED',
        'NEEDS_HUMAN_DECISION',
        'NEEDS_PERMISSION',
        'BLOCKED',
      ],
    },
    changes: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    checks: {
      type: 'array',
      items: {
        type: 'string',
        ...(selectedTaskMode === 'analysis' ? { maxLength: 500 } : {}),
      },
      maxItems: 20,
    },
    deferred: {
      type: 'array',
      items: {
        type: 'string',
        ...(selectedTaskMode === 'analysis' ? { maxLength: 500 } : {}),
      },
      maxItems: 20,
    },
    summary: { type: 'string', maxLength: 2_000 },
    findingResponses: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: FINDING_RESPONSE_FIELDS,
        properties: responseProperties,
      },
    },
  };
  if (selectedTaskMode === 'analysis') {
    required.push('fullAnalysis');
    properties.fullAnalysis = {
      type: 'string',
      minLength: ANALYSIS_COMPLETENESS_SENTINEL.length + 1,
      maxLength: MAX_ANALYSIS_ARTIFACT_BYTES,
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}

function readConfirmationSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'sha256', 'fullyRead'],
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 500 },
      sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      fullyRead: { type: 'boolean' },
    },
  };
}

function claudeSchema(taskMode = DEFAULT_TASK_MODE) {
  const selectedTaskMode = resolveTaskMode(taskMode);
  const required = ['verdict', 'findings', 'checks', 'confirmedNoChanges'];
  const properties = {
    verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES'] },
    findings: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'severity',
          'file',
          'anchor',
          'category',
          'location',
          'impact',
          'recommendation',
        ],
        properties: {
          severity: {
            type: 'string',
            enum: FINDING_SEVERITIES,
          },
          findingId: {
            type: 'string',
            pattern: `^${FINDING_ID_PREFIX}[0-9a-f]{24}$`,
          },
          file: { type: 'string', minLength: 1, maxLength: 500 },
          anchor: { type: 'string', minLength: 1, maxLength: 500 },
          category: {
            type: 'string',
            pattern: '^[a-z][a-z0-9._-]{0,99}$',
          },
          location: { type: 'string', minLength: 1, maxLength: 500 },
          impact: { type: 'string', minLength: 1, maxLength: 2_000 },
          recommendation: {
            type: 'string',
            minLength: 1,
            maxLength: 2_000,
          },
        },
      },
    },
    checks: {
      type: 'array',
      items: {
        type: 'string',
        ...(selectedTaskMode === 'analysis' ? { maxLength: 500 } : {}),
      },
      maxItems: 30,
    },
    confirmedNoChanges: { type: 'boolean' },
  };
  if (selectedTaskMode === 'analysis') {
    required.push('reviewConfirmation');
    properties.reviewConfirmation = {
      type: 'object',
      additionalProperties: false,
      required: ['task', 'manifest', 'artifact', 'documents'],
      properties: {
        task: readConfirmationSchema(),
        manifest: readConfirmationSchema(),
        artifact: readConfirmationSchema(),
        documents: {
          type: 'array',
          maxItems: MAX_ANALYSIS_REVIEW_FILES,
          items: readConfirmationSchema(),
        },
      },
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactObjectKeys(value, expected, label, stage = 'codex') {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new AgentWorkflowError(msg('output.wrongFields', { label }), {
      code: 'INVALID_AGENT_OUTPUT',
      stage,
    });
  }
}

function isNonEmptyString(value, maxLength) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function isReservedFindingResponseFieldLabel(value) {
  const delimiterIndex = value.search(/[:,]/u);
  const rawLabel = (
    delimiterIndex < 0 ? value : value.slice(0, delimiterIndex)
  ).trim();
  const unquotedLabel = rawLabel
    .replace(/^["'`]/u, '')
    .replace(/["'`]$/u, '')
    .trim()
    .toLowerCase();
  return FINDING_RESPONSE_RESERVED_RESULT_FIELD_SET.has(unquotedLabel);
}

function isStandaloneJsonStructuralFragment(value) {
  const compact = value.replace(/\s/gu, '');
  return (
    /^[{}\[\],:"'`]+$/u.test(compact) ||
    /^["'][^"'\\\r\n]+["']\s*:\s*[\[{]?\s*,?$/u.test(value)
  );
}

function containsForbiddenFindingResponseMarker(value) {
  const normalized = value.toLowerCase();
  return FINDING_RESPONSE_CHECK_FORBIDDEN_MARKERS.some((marker) =>
    normalized.includes(marker.toLowerCase()),
  );
}

function resemblesAnalysisArtifact(value, fullAnalysis) {
  if (/^(?:#{1,6}\s|```|~~~)/u.test(value)) return true;
  return (
    typeof fullAnalysis === 'string' &&
    [...value].length >= MIN_ANALYSIS_ARTIFACT_FRAGMENT_CHARACTERS &&
    fullAnalysis.includes(value)
  );
}

function isValidFindingResponseCheck(value, { fullAnalysis } = {}) {
  return (
    typeof value === 'string' &&
    [...value].length <= MAX_FINDING_RESPONSE_CHECK_CHARACTERS &&
    FINDING_RESPONSE_CHECK_SCHEMA_REGEX.test(value) &&
    !isReservedFindingResponseFieldLabel(value) &&
    !isStandaloneJsonStructuralFragment(value) &&
    !containsForbiddenFindingResponseMarker(value) &&
    !resemblesAnalysisArtifact(value, fullAnalysis)
  );
}

function validateFindingResponse(response, options = {}) {
  if (!isPlainObject(response)) {
    throw new AgentWorkflowError(
      msg('writer.invalidResponse'),
      {
        code: 'INVALID_AGENT_OUTPUT',
        stage: 'codex',
      },
    );
  }
  const commonValid =
    typeof response.findingId === 'string' &&
    new RegExp(`^${FINDING_ID_PREFIX}[0-9a-f]{24}$`).test(response.findingId) &&
    ['CONFIRMED', 'REJECTED', 'NEEDS_HUMAN'].includes(response.status);
  if (!commonValid) {
    throw new AgentWorkflowError(
      msg('writer.invalidResponse'),
      {
        code: 'INVALID_AGENT_OUTPUT',
        stage: 'codex',
      },
    );
  }
  assertExactObjectKeys(
    response,
    FINDING_RESPONSE_FIELDS,
    msg('label.findingResponse', { status: response.status }),
  );
  const fieldsValid =
    typeof response.analysis === 'string' &&
    response.analysis.length <= 2_000 &&
    typeof response.evidence === 'string' &&
    response.evidence.length <= 4_000 &&
    typeof response.fix === 'string' &&
    response.fix.length <= 2_000 &&
    typeof response.regressionTest === 'string' &&
    response.regressionTest.length <= 2_000 &&
    Array.isArray(response.checks) &&
    response.checks.length <= 20 &&
    response.checks.every((check) =>
      isValidFindingResponseCheck(check, options),
    ) &&
    typeof response.question === 'string' &&
    response.question.length <= 2_000;
  if (!fieldsValid) {
    throw new AgentWorkflowError(
      msg('writer.invalidResponse'),
      { code: 'INVALID_AGENT_OUTPUT', stage: 'codex' },
    );
  }
  if (response.status === 'CONFIRMED') {
    if (
      !isNonEmptyString(response.analysis, 2_000) ||
      !isNonEmptyString(response.evidence, 4_000) ||
      !isNonEmptyString(response.fix, 2_000) ||
      !isNonEmptyString(response.regressionTest, 2_000) ||
      response.checks.length === 0 ||
      response.question !== ''
    ) {
      throw new AgentWorkflowError(
        msg('writer.confirmedFields'),
        { code: 'INVALID_AGENT_OUTPUT', stage: 'codex' },
      );
    }
  } else if (response.status === 'REJECTED') {
    if (
      !isNonEmptyString(response.analysis, 2_000) ||
      !isNonEmptyString(response.evidence, 4_000) ||
      response.fix !== '' ||
      response.regressionTest !== '' ||
      response.question !== ''
    ) {
      throw new AgentWorkflowError(
        msg('writer.rejectedFields'),
        { code: 'INVALID_AGENT_OUTPUT', stage: 'codex' },
      );
    }
  } else {
    if (
      !isNonEmptyString(response.question, 2_000) ||
      response.analysis !== '' ||
      response.evidence !== '' ||
      response.fix !== '' ||
      response.regressionTest !== '' ||
      response.checks.length !== 0
    ) {
      throw new AgentWorkflowError(
        msg('writer.needsHumanFields'),
        { code: 'INVALID_AGENT_OUTPUT', stage: 'codex' },
      );
    }
  }
  return response;
}

function validateFindingResponseList(value, options = {}) {
  if (!Array.isArray(value) || value.length > 50) {
    throw new AgentWorkflowError(
      msg('writer.invalidResponses'),
      { code: 'INVALID_AGENT_OUTPUT', stage: 'codex' },
    );
  }
  for (const response of value) validateFindingResponse(response, options);
  return value;
}

function validateFullAnalysis(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentWorkflowError(
      msg('writer.analysisMissing'),
      { code: 'ANALYSIS_ARTIFACT_MISSING', stage: 'codex' },
    );
  }
  const sizeBytes = Buffer.byteLength(value);
  if (sizeBytes > MAX_ANALYSIS_ARTIFACT_BYTES) {
    throw new AgentWorkflowError(msg('analysis.tooLarge'), {
      code: 'ANALYSIS_ARTIFACT_TOO_LARGE',
      stage: 'codex',
    });
  }
  const sentinelIndex = value.indexOf(ANALYSIS_COMPLETENESS_SENTINEL);
  if (
    sentinelIndex < 0 ||
    sentinelIndex !== value.length - ANALYSIS_COMPLETENESS_SENTINEL.length ||
    value.lastIndexOf(ANALYSIS_COMPLETENESS_SENTINEL) !== sentinelIndex ||
    !value.slice(0, sentinelIndex).trim()
  ) {
    throw new AgentWorkflowError(
      msg('analysis.sentinel'),
      { code: 'ANALYSIS_ARTIFACT_INCOMPLETE', stage: 'codex' },
    );
  }
  if (ANALYSIS_TRUNCATION_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new AgentWorkflowError(msg('analysis.truncated'), {
      code: 'ANALYSIS_ARTIFACT_TRUNCATED',
      stage: 'codex',
    });
  }
  const headings = markdownHeadings(value);
  if (headings.length === 0 || new Set(headings).size !== headings.length) {
    throw new AgentWorkflowError(
      msg('analysis.heading'),
      { code: 'ANALYSIS_ARTIFACT_INCOMPLETE', stage: 'codex' },
    );
  }
  return {
    content: value,
    sizeBytes,
    sha256: createHash('sha256').update(Buffer.from(value)).digest('hex'),
    complete: true,
    headings,
  };
}

function validateCodexReport(
  value,
  expectedFindings = [],
  taskMode = DEFAULT_TASK_MODE,
) {
  const selectedTaskMode = resolveTaskMode(taskMode);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentWorkflowError(
      msg('writer.invalidResult'),
      {
        code: 'INVALID_AGENT_OUTPUT',
        stage: 'codex',
      },
    );
  }
  if (
    selectedTaskMode === 'analysis' &&
    !Object.hasOwn(value, 'fullAnalysis')
  ) {
    throw new AgentWorkflowError(
      msg('writer.analysisFieldMissing'),
      { code: 'ANALYSIS_ARTIFACT_MISSING', stage: 'codex' },
    );
  }
  assertExactObjectKeys(
    value,
    [
      'status',
      'changes',
      'checks',
      'deferred',
      'summary',
      'findingResponses',
      ...(selectedTaskMode === 'analysis' ? ['fullAnalysis'] : []),
    ],
    msg('label.writerResult'),
  );
  if (
    ![
      'COMPLETED',
      'NEEDS_HUMAN_DECISION',
      'NEEDS_PERMISSION',
      'BLOCKED',
    ].includes(value.status) ||
    !Array.isArray(value.changes) ||
    !Array.isArray(value.checks) ||
    !Array.isArray(value.deferred) ||
    typeof value.summary !== 'string' ||
    !Array.isArray(value.findingResponses) ||
    value.findingResponses.length > 50 ||
    value.changes.length > 20 ||
    value.checks.length > 20 ||
    value.deferred.length > 20 ||
    value.summary.length > 2_000 ||
    [value.changes, value.checks, value.deferred].some((items) =>
      items.some((item) => typeof item !== 'string'),
    )
  ) {
    throw new AgentWorkflowError(
      msg('writer.invalidResult'),
      {
        code: 'INVALID_AGENT_OUTPUT',
        stage: 'codex',
      },
    );
  }
  if (selectedTaskMode === 'analysis') {
    validateFullAnalysis(value.fullAnalysis);
    if (
      value.changes.length !== 0 ||
      value.summary.includes(ANALYSIS_COMPLETENESS_SENTINEL) ||
      [...value.checks, ...value.deferred].some((item) => item.length > 500)
    ) {
      throw new AgentWorkflowError(
        msg('writer.analysisMetadata'),
        { code: 'INVALID_AGENT_OUTPUT', stage: 'codex' },
      );
    }
  }
  const expectedIds = new Set(
    expectedFindings.map(({ findingId }) => findingId),
  );
  const findingResponseOptions =
    selectedTaskMode === 'analysis'
      ? { fullAnalysis: value.fullAnalysis }
      : undefined;
  const responseIds = new Set();
  for (const response of value.findingResponses) {
    validateFindingResponse(response, findingResponseOptions);
    if (!expectedIds.has(response.findingId)) {
      throw new AgentWorkflowError(
        msg('writer.unknownFindingId', {
          findingId: JSON.stringify(response.findingId),
        }),
        { code: 'INVALID_AGENT_OUTPUT', stage: 'codex' },
      );
    }
    if (responseIds.has(response.findingId)) {
      throw new AgentWorkflowError(
        msg('writer.duplicateResponse', {
          findingId: JSON.stringify(response.findingId),
        }),
        { code: 'INVALID_AGENT_OUTPUT', stage: 'codex' },
      );
    }
    responseIds.add(response.findingId);
  }
  const missing = [...expectedIds].filter(
    (findingId) => !responseIds.has(findingId),
  );
  if (missing.length > 0 || responseIds.size !== expectedIds.size) {
    throw new AgentWorkflowError(
      msg('writer.incompleteResponses', {
        missing: missing.join(', ') || msg('writer.responseCountMismatch'),
      }),
      { code: 'INVALID_AGENT_OUTPUT', stage: 'codex' },
    );
  }
  const humanResponse = value.findingResponses.find(
    ({ status }) => status === 'NEEDS_HUMAN',
  );
  if (humanResponse) {
    if (!['COMPLETED', 'NEEDS_HUMAN_DECISION'].includes(value.status)) {
      throw new AgentWorkflowError(
        msg('writer.needsHumanConflict'),
        { code: 'INVALID_AGENT_OUTPUT', stage: 'codex' },
      );
    }
    return value;
  }
  if (value.status !== 'COMPLETED') {
    throw new AgentWorkflowError(
      msg('writer.stopped', {
        status: value.status,
        summary: redactSensitive(value.summary),
      }),
      {
        code:
          value.status === 'NEEDS_PERMISSION'
            ? 'NEW_PERMISSION_REQUIRED'
            : 'HUMAN_DECISION_REQUIRED',
        stage: 'codex',
      },
    );
  }
  return value;
}

function assertReadConfirmation(actual, expected, label) {
  if (!isPlainObject(actual)) {
    throw new AgentWorkflowError(msg('reviewer.readUnconfirmed', { label }), {
      code: 'ANALYSIS_REVIEW_UNCONFIRMED',
      stage: 'claude',
    });
  }
  assertExactObjectKeys(
    actual,
    ['path', 'sha256', 'fullyRead'],
    msg('label.confirmation', { label }),
    'claude',
  );
  if (
    actual.path !== expected?.path ||
    actual.sha256 !== expected?.sha256 ||
    actual.fullyRead !== true
  ) {
    throw new AgentWorkflowError(
      msg('reviewer.readMismatch', { label }),
      { code: 'ANALYSIS_REVIEW_UNCONFIRMED', stage: 'claude' },
    );
  }
}

function validateAnalysisReviewConfirmation(actual, expected) {
  if (!isPlainObject(expected)) {
    throw new AgentWorkflowError(
      msg('reviewer.manifestMissing'),
      { code: 'ANALYSIS_PACKAGE_INVALID', stage: 'claude' },
    );
  }
  if (!isPlainObject(actual)) {
    throw new AgentWorkflowError(
      msg('reviewer.confirmationMissing'),
      { code: 'ANALYSIS_REVIEW_UNCONFIRMED', stage: 'claude' },
    );
  }
  assertExactObjectKeys(
    actual,
    ['task', 'manifest', 'artifact', 'documents'],
    msg('label.analysisConfirmation'),
    'claude',
  );
  assertReadConfirmation(actual.task, expected.task, msg('label.readTask'));
  assertReadConfirmation(
    actual.manifest,
    expected.manifest,
    msg('label.readManifest'),
  );
  assertReadConfirmation(
    actual.artifact,
    expected.artifact,
    msg('label.readArtifact'),
  );
  if (
    !Array.isArray(actual.documents) ||
    actual.documents.length !== expected.documents.length
  ) {
    throw new AgentWorkflowError(
      msg('reviewer.filesUnconfirmed'),
      { code: 'ANALYSIS_REVIEW_FILES_UNCONFIRMED', stage: 'claude' },
    );
  }
  const expectedByPath = new Map(
    expected.documents.map((document) => [document.path, document]),
  );
  const seen = new Set();
  for (const document of actual.documents) {
    const path = document?.path;
    if (seen.has(path) || !expectedByPath.has(path)) {
      throw new AgentWorkflowError(
        msg('reviewer.filesMismatch'),
        { code: 'ANALYSIS_REVIEW_FILES_UNCONFIRMED', stage: 'claude' },
      );
    }
    seen.add(path);
    assertReadConfirmation(
      document,
      expectedByPath.get(path),
      msg('label.readReviewFile', { path: JSON.stringify(path) }),
    );
  }
}

function validateClaudeReview(
  value,
  {
    taskMode = DEFAULT_TASK_MODE,
    expectedConfirmation,
    analysisHeadings = [],
  } = {},
) {
  const selectedTaskMode = resolveTaskMode(taskMode);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentWorkflowError(
      msg('reviewer.invalidResult'),
      {
        code: 'INVALID_AGENT_OUTPUT',
        stage: 'claude',
      },
    );
  }
  assertExactObjectKeys(
    value,
    [
      'verdict',
      'findings',
      'checks',
      'confirmedNoChanges',
      ...(selectedTaskMode === 'analysis' ? ['reviewConfirmation'] : []),
    ],
    msg('label.reviewerResult'),
    'claude',
  );
  if (
    !['APPROVE', 'REQUEST_CHANGES'].includes(value.verdict) ||
    !Array.isArray(value.findings) ||
    !Array.isArray(value.checks) ||
    value.confirmedNoChanges !== true ||
    value.findings.length > 50 ||
    value.checks.length > 30 ||
    value.checks.some(
      (check) =>
        typeof check !== 'string' ||
        (selectedTaskMode === 'analysis' && check.length > 500),
    )
  ) {
    throw new AgentWorkflowError(
      msg('reviewer.invalidResult'),
      {
        code: 'INVALID_AGENT_OUTPUT',
        stage: 'claude',
      },
    );
  }
  if (selectedTaskMode === 'analysis') {
    validateAnalysisReviewConfirmation(
      value.reviewConfirmation,
      expectedConfirmation,
    );
    if (
      (value.verdict === 'APPROVE' && value.findings.length !== 0) ||
      (value.verdict === 'REQUEST_CHANGES' && value.findings.length === 0)
    ) {
      throw new AgentWorkflowError(
        msg('reviewer.verdictConflict'),
        { code: 'INVALID_AGENT_OUTPUT', stage: 'claude' },
      );
    }
  }
  const analysisHeadingSet = new Set(analysisHeadings);
  for (const finding of value.findings) {
    if (isPlainObject(finding)) {
      const keys = [
        'severity',
        'file',
        'anchor',
        'category',
        'location',
        'impact',
        'recommendation',
        ...(finding.findingId === undefined ? [] : ['findingId']),
      ];
      assertExactObjectKeys(finding, keys, 'Finding Claude', 'claude');
    }
    if (
      !finding ||
      !FINDING_SEVERITIES.includes(finding.severity) ||
      [
        'file',
        'anchor',
        'category',
        'location',
        'impact',
        'recommendation',
      ].some(
        (field) => typeof finding[field] !== 'string' || !finding[field].trim(),
      ) ||
      finding.file.length > 500 ||
      finding.anchor.length > 500 ||
      finding.location.length > 500 ||
      finding.impact.length > 2_000 ||
      finding.recommendation.length > 2_000 ||
      !/^[a-z][a-z0-9._-]{0,99}$/.test(finding.category) ||
      (finding.findingId !== undefined &&
        !new RegExp(`^${FINDING_ID_PREFIX}[0-9a-f]{24}$`).test(
          finding.findingId,
        ))
    ) {
      throw new AgentWorkflowError(msg('reviewer.invalidFinding'), {
        code: 'INVALID_AGENT_OUTPUT',
        stage: 'claude',
      });
    }
    if (
      isAbsolute(finding.file) ||
      finding.file.split(/[\\/]/).includes('..')
    ) {
      throw new AgentWorkflowError(
        msg('reviewer.findingOutside'),
        {
          code: 'INVALID_AGENT_OUTPUT',
          stage: 'claude',
        },
      );
    }
    if (
      selectedTaskMode === 'analysis' &&
      (finding.file !== ANALYSIS_FINDING_FILE ||
        !analysisHeadingSet.has(finding.anchor))
    ) {
      throw new AgentWorkflowError(
        msg('reviewer.analysisFindingTarget'),
        { code: 'INVALID_AGENT_OUTPUT', stage: 'claude' },
      );
    }
  }
  return value;
}

// JSON text of a value, or '' when it has none (undefined, a function) or
// cannot be serialized.
function jsonText(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function parseJson(value, label, stage) {
  try {
    return JSON.parse(value);
  } catch {
    throw new AgentWorkflowError(msg('output.invalidJson', { label }), {
      code: 'INVALID_AGENT_OUTPUT',
      stage,
    });
  }
}

export function parseClaudeOutput(
  stdout,
  options,
  adapter = claudeProvider,
) {
  const wrapper = parseJson(stdout.trim(), 'Claude', 'claude');
  const output = adapter.reviewer.reviewOutput(wrapper);
  if (output && Object.hasOwn(output, 'value')) {
    // A module from a profile: the core validates and uses a JSON copy of
    // the review (getters and proxies are read once), never the module's
    // object.
    return validateClaudeReview(
      isBuiltinProvider(adapter)
        ? output.value
        : parseJson(jsonText(output.value), 'Claude result', 'claude'),
      options,
    );
  }
  if (output) {
    return validateClaudeReview(
      parseJson(output.text, 'Claude result', 'claude'),
      options,
    );
  }
  throw new AgentWorkflowError(msg('reviewer.noStructuredOutput'), {
    code: 'INVALID_AGENT_OUTPUT',
    stage: 'claude',
  });
}

function codexPrompt({
  task,
  round,
  findings,
  taskMode = DEFAULT_TASK_MODE,
  codexModel = CODEX_MODEL,
}) {
  // Order of validation as before the move: model first, then task mode.
  const selectedCodexModel = resolveCodexModel(codexModel);
  const selectedTaskMode = resolveTaskMode(taskMode);
  // Prompts follow the locale of the run, like its messages.
  return buildCodexPrompt({
    locale: currentLocale(),
    task,
    round,
    findings,
    taskMode: selectedTaskMode,
    codexModel: selectedCodexModel,
    maxAnalysisArtifactBytes: MAX_ANALYSIS_ARTIFACT_BYTES,
    analysisCompletenessSentinel: ANALYSIS_COMPLETENESS_SENTINEL,
  });
}

function claudePrompt({
  task,
  taskMode = DEFAULT_TASK_MODE,
  instructionsPath,
  diffPath,
  gatesPath,
  correctionContextPath,
  originalTaskPath,
  manifestPath,
  analysisArtifactPath,
  integrityPath,
  expectedConfirmation,
}) {
  return buildClaudePrompt({
    locale: currentLocale(),
    task,
    taskMode: resolveTaskMode(taskMode),
    instructionsPath,
    diffPath,
    gatesPath,
    correctionContextPath,
    originalTaskPath,
    manifestPath,
    analysisArtifactPath,
    integrityPath,
    expectedConfirmation,
    analysisFindingFile: ANALYSIS_FINDING_FILE,
  });
}

async function createGitGuard({ directory, gitPath, seal = true }) {
  const binDirectory = join(directory, 'guard-bin');
  const existing = await lstat(join(binDirectory, 'git')).catch(
    () => undefined,
  );
  if (existing?.isFile()) {
    if (seal) await chmod(binDirectory, 0o500);
    return binDirectory;
  }
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const guardPath = join(binDirectory, 'git');
  const source = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const allowed = new Set(${JSON.stringify([...READ_ONLY_GIT_SUBCOMMANDS])});
const args = process.argv.slice(2);
const subcommand = args[0];
if (!subcommand || subcommand.startsWith('-') || !allowed.has(subcommand)) {
  process.stderr.write(${JSON.stringify(`${msg('guard.gitBlocked')}\n`)});
  process.exit(126);
}
const result = spawnSync(${JSON.stringify(gitPath)}, args, { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
`;
  await writeFile(guardPath, source, { mode: 0o500 });
  if (seal) await chmod(binDirectory, 0o500);
  return binDirectory;
}

// Returns the script invocation described by an allowed pnpm argv shape, or
// undefined for any other argv.
function parsePnpmScriptArgv(args) {
  let rest = args;
  let filter;
  if (rest[0] === '--filter') {
    filter = rest[1];
    if (!PNPM_PACKAGE_NAME.test(filter ?? '') || filter.includes('..'))
      return undefined;
    rest = rest.slice(2);
  }
  if (rest[0] === 'run') rest = rest.slice(1);
  const [script] = rest;
  if (
    rest.length !== 1 ||
    !PNPM_SCRIPT_NAME.test(script) ||
    PNPM_BUILTIN_COMMANDS.has(script)
  )
    return undefined;
  return { filter, script };
}

// The explicit [--filter package] run script form executed for an allowed
// pnpm script argv, whichever of the allowed shapes it uses.
function pnpmRunArgv(args) {
  const { filter, script } = parsePnpmScriptArgv(args);
  return [...(filter ? ['--filter', filter] : []), 'run', script];
}

function isAllowedGitCheckArgv(args) {
  const [subcommand, ...options] = args;
  return (
    subcommand === GIT_CHECK_SUBCOMMAND &&
    options.includes(GIT_CHECK_REQUIRED_OPTION) &&
    new Set(options).size === options.length &&
    options.every((option) => GIT_CHECK_OPTIONS.has(option))
  );
}

const DEFAULT_RUNNER_PROFILE = Object.freeze({
  title: 'AGENT WORKFLOW',
  tempPrefix: 'agent-review-',
  checks: Object.freeze({
    'pnpm check': Object.freeze({
      program: 'pnpm',
      args: Object.freeze(['check']),
      timeoutMs: 20 * 60_000,
    }),
    'pnpm test': Object.freeze({
      program: 'pnpm',
      args: Object.freeze(['test']),
      timeoutMs: 15 * 60_000,
    }),
    'git diff --check': Object.freeze({
      program: 'git',
      args: Object.freeze(['diff', '--check']),
      timeoutMs: 2 * 60_000,
    }),
  }),
  checkSets: Object.freeze({
    base: Object.freeze(['pnpm check', 'git diff --check']),
    docs: Object.freeze(['git diff --check']),
  }),
  requiredGateRules: Object.freeze([]),
  taskSchema: DEFAULT_TASK_SCHEMAS[DEFAULT_LOCALE],
  taskClasses: DEFAULT_TASK_CLASSES,
  docsCandidatePolicy: DEFAULT_DOCS_CANDIDATE_POLICY,
  implementer: DEFAULT_IMPLEMENTER,
  reviewer: DEFAULT_REVIEWER,
  locale: DEFAULT_LOCALE,
});
const RUNNER_PROFILE_KEYS = new Set([
  ...Object.keys(DEFAULT_RUNNER_PROFILE),
  'createPresenters',
  'providerModules',
]);

// The locale of a profile for its messages, read before the profile is
// validated: the locale field when it is a valid own data property, 'en'
// otherwise (resolveRunnerProfile refuses an invalid value). Without a
// profile, the locale of the calling code.
function profileLocale(profile) {
  if (profile === undefined) return currentLocale();
  try {
    const descriptor =
      profile && typeof profile === 'object'
        ? Object.getOwnPropertyDescriptor(profile, 'locale')
        : undefined;
    return descriptor &&
      Object.hasOwn(descriptor, 'value') &&
      isLocale(descriptor.value)
      ? descriptor.value
      : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

// Profiles are static data: every level is read through data descriptors only,
// so getters never run and functions are rejected (except createPresenters
// and the functions of provider modules, which the provider contract checks).
// The result keeps the input shape, therefore resolving it again is a no-op.
// Its messages are in the locale of the profile, also outside of a run.
function resolveRunnerProfile(profile) {
  return withLocale(profileLocale(profile), () =>
    resolveRunnerProfileFields(profile),
  );
}

function resolveRunnerProfileFields(profile = DEFAULT_RUNNER_PROFILE) {
  const invalid = () => {
    throw new AgentWorkflowError(t(profileLocale(profile), 'profile.invalid'), {
      code: 'INVALID_CONFIGURATION',
      stage: 'preflight',
    });
  };
  const record = (value, allowedKeys) => {
    if (
      !value ||
      typeof value !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      invalid();
    const fields = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || (allowedKeys && !allowedKeys.has(key)))
        invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value')) invalid();
      Object.defineProperty(fields, key, {
        value: descriptor.value,
        enumerable: true,
        writable: true,
      });
    }
    return fields;
  };
  const list = (value) => {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_PROFILE_LIST_ITEMS
    )
      invalid();
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
      return descriptor.value;
    });
  };
  const text = (value, maxLength) =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/[\x00-\x1f\x7f-\x9f]/.test(value);
  const argv = (value) => {
    const args = list(value);
    if (
      args.length === 0 ||
      !args.every((arg) => text(arg, 200) && !/[\s`]/.test(arg))
    )
      invalid();
    return Object.freeze(args);
  };
  const repositoryPath = (value, prefix) => {
    if (!text(value, 500) || value.includes('\\')) return false;
    const body = prefix && value.endsWith('/') ? value.slice(0, -1) : value;
    return body
      .split('/')
      .every((segment) => segment && segment !== '.' && segment !== '..');
  };

  const resolved = { ...DEFAULT_RUNNER_PROFILE };
  const fields = record(profile, RUNNER_PROFILE_KEYS);
  Object.assign(resolved, fields);
  // locale: the language of the runner's messages and of the agent prompts,
  // 'en' without the field. The built-in task classes and task schema follow
  // it; a profile's own classes keep their texts, its own schema its names.
  if (!isLocale(resolved.locale)) invalid();
  if (!Object.hasOwn(fields, 'taskClasses'))
    resolved.taskClasses = defaultTaskClasses(resolved.locale);
  if (!Object.hasOwn(fields, 'taskSchema'))
    resolved.taskSchema = DEFAULT_TASK_SCHEMAS[resolved.locale];
  if (
    Object.hasOwn(resolved, 'createPresenters') &&
    typeof resolved.createPresenters !== 'function'
  )
    invalid();
  for (const key of ['title', 'tempPrefix']) {
    if (
      typeof resolved[key] !== 'string' ||
      !resolved[key].trim() ||
      /[\x00-\x1f\x7f]/.test(resolved[key])
    )
      invalid();
  }
  if (/[\\/]/.test(resolved.tempPrefix)) invalid();

  const checks = {};
  const checkEntries = Object.entries(record(resolved.checks));
  if (checkEntries.length === 0 || checkEntries.length > MAX_PROFILE_CHECKS)
    invalid();
  for (const [name, value] of checkEntries) {
    const fields = record(value, CHECK_DEFINITION_KEYS);
    if (!CHECK_PROGRAMS.has(fields.program)) invalid();
    const args = argv(fields.args);
    // The task names a check by its exact argv, so the name cannot mislead.
    if (name !== [fields.program, ...args].join(' ')) invalid();
    if (
      fields.program === 'git'
        ? !isAllowedGitCheckArgv(args)
        : !parsePnpmScriptArgv(args)
    )
      invalid();
    if (
      !Number.isSafeInteger(fields.timeoutMs) ||
      fields.timeoutMs < MIN_CHECK_TIMEOUT_MS ||
      fields.timeoutMs > MAX_CHECK_TIMEOUT_MS
    )
      invalid();
    const definition = {
      program: fields.program,
      args,
      timeoutMs: fields.timeoutMs,
    };
    for (const flag of ['passDockerHost', 'unsetCiOnDarwin']) {
      if (!Object.hasOwn(fields, flag)) continue;
      if (typeof fields[flag] !== 'boolean') invalid();
      definition[flag] = fields[flag];
    }
    if (Object.hasOwn(fields, 'nestedInvocations')) {
      if (fields.program !== 'pnpm') invalid();
      definition.nestedInvocations = Object.freeze(
        list(fields.nestedInvocations).map((value) => {
          const args = argv(value);
          if (!parsePnpmScriptArgv(args)) invalid();
          return args;
        }),
      );
    }
    checks[name] = Object.freeze(definition);
  }
  resolved.checks = Object.freeze(checks);

  const sets = record(resolved.checkSets, new Set(['base', 'docs']));
  for (const key of ['base', 'docs']) {
    const names = list(sets[key]);
    if (
      names.length === 0 ||
      new Set(names).size !== names.length ||
      !names.every(
        (name) => typeof name === 'string' && Object.hasOwn(checks, name),
      )
    )
      invalid();
    sets[key] = Object.freeze(names);
  }
  resolved.checkSets = Object.freeze(sets);

  resolved.requiredGateRules = Object.freeze(
    list(resolved.requiredGateRules).map((value) => {
      const fields = record(value, REQUIRED_GATE_RULE_KEYS);
      const prefixes = Object.hasOwn(fields, 'prefixes')
        ? list(fields.prefixes)
        : [];
      const paths = Object.hasOwn(fields, 'paths') ? list(fields.paths) : [];
      if (
        typeof fields.check !== 'string' ||
        !Object.hasOwn(checks, fields.check) ||
        typeof fields.code !== 'string' ||
        fields.code.length > 64 ||
        !REQUIRED_GATE_RULE_CODE.test(fields.code) ||
        prefixes.length + paths.length === 0 ||
        !prefixes.every((prefix) => repositoryPath(prefix, true)) ||
        !paths.every((path) => repositoryPath(path, false)) ||
        (Object.hasOwn(fields, 'message') && !text(fields.message, 500))
      )
        invalid();
      const rule = {
        check: fields.check,
        prefixes: Object.freeze(prefixes),
        paths: Object.freeze(paths),
        code: fields.code,
      };
      if (Object.hasOwn(fields, 'message')) rule.message = fields.message;
      return Object.freeze(rule);
    }),
  );

  // Section names and aliases are stored in normalized heading form, so two
  // spellings that differ only in case or spacing are the same name.
  const schema = record(resolved.taskSchema, TASK_SCHEMA_KEYS);
  if (
    Object.keys(schema).length !== TASK_SCHEMA_KEYS.size ||
    !Number.isSafeInteger(schema.version) ||
    schema.version < 1 ||
    schema.version > MAX_TASK_SCHEMA_VERSION
  )
    invalid();
  const sectionName = (value) => {
    if (!text(value, MAX_TASK_SECTION_NAME_LENGTH)) invalid();
    return normalizeHeading(value);
  };
  const requiredSections = list(schema.requiredSections).map(sectionName);
  const optionalSections = list(schema.optionalSections).map(sectionName);
  const sectionNames = new Set([...requiredSections, ...optionalSections]);
  const roles = taskSchemaRoles({ requiredSections, optionalSections });
  if (
    requiredSections.length === 0 ||
    sectionNames.size !== requiredSections.length + optionalSections.length ||
    !requiredSections.includes(roles.requiredChecks) ||
    !roles.taskClass ||
    !roles.reviewFiles
  )
    invalid();
  const aliasEntries = Object.entries(record(schema.aliases));
  if (aliasEntries.length > MAX_TASK_SCHEMA_ALIASES) invalid();
  const aliases = new Map();
  for (const [alias, target] of aliasEntries) {
    const name = sectionName(alias);
    const canonical = sectionName(target);
    // An alias may not shadow a section name or repeat another alias, and
    // must point to a declared section.
    if (
      sectionNames.has(name) ||
      aliases.has(name) ||
      !sectionNames.has(canonical)
    )
      invalid();
    aliases.set(name, canonical);
  }
  const strictDuplicates =
    resolved.taskSchema === DEFAULT_TASK_SCHEMAS.en ||
    STRICT_DUPLICATE_TASK_SCHEMAS.has(resolved.taskSchema);
  resolved.taskSchema = Object.freeze({
    version: schema.version,
    requiredSections: Object.freeze(requiredSections),
    optionalSections: Object.freeze(optionalSections),
    aliases: Object.freeze(Object.fromEntries(aliases)),
  });
  if (strictDuplicates) STRICT_DUPLICATE_TASK_SCHEMAS.add(resolved.taskSchema);

  // Task classes. The invariants hold whatever the profile declares: no
  // review or the docs check set only with docsOnly, and the default class
  // is the full track.
  const classEntries = Object.entries(record(resolved.taskClasses));
  if (classEntries.length === 0 || classEntries.length > MAX_PROFILE_LIST_ITEMS)
    invalid();
  const taskClasses = {};
  for (const [name, value] of classEntries) {
    const fields = record(value, TASK_CLASS_KEYS);
    if (
      name.length > MAX_TASK_CLASS_NAME_LENGTH ||
      !TASK_CLASS_NAME.test(name) ||
      typeof fields.independentReviewRequired !== 'boolean' ||
      typeof fields.docsOnly !== 'boolean' ||
      typeof fields.checkSet !== 'string' ||
      !Object.hasOwn(sets, fields.checkSet) ||
      (!fields.independentReviewRequired && !fields.docsOnly) ||
      (fields.checkSet === 'docs' && !fields.docsOnly) ||
      !text(fields.reason, MAX_TASK_CLASS_TEXT_LENGTH) ||
      !text(fields.remainingAssurance, MAX_TASK_CLASS_TEXT_LENGTH) ||
      (Object.hasOwn(fields, 'policy') && !repositoryPath(fields.policy, false))
    )
      invalid();
    const definition = {
      independentReviewRequired: fields.independentReviewRequired,
      checkSet: fields.checkSet,
      docsOnly: fields.docsOnly,
      reason: fields.reason,
      remainingAssurance: fields.remainingAssurance,
    };
    if (Object.hasOwn(fields, 'policy')) definition.policy = fields.policy;
    taskClasses[name] = Object.freeze(definition);
  }
  const fullTrack = taskClasses[DEFAULT_TASK_CLASS];
  if (
    !fullTrack ||
    !fullTrack.independentReviewRequired ||
    fullTrack.docsOnly ||
    fullTrack.checkSet !== 'base'
  )
    invalid();
  resolved.taskClasses = Object.freeze(taskClasses);

  // Docs candidate rule: plain lists, no patterns. Every list is required
  // and the base exclusions cannot be dropped.
  const docsPolicy = record(
    resolved.docsCandidatePolicy,
    DOCS_CANDIDATE_POLICY_KEYS,
  );
  if (Object.keys(docsPolicy).length !== DOCS_CANDIDATE_POLICY_KEYS.size)
    invalid();
  const uniqueList = (value, valid) => {
    const items = list(value);
    if (new Set(items).size !== items.length || !items.every(valid)) invalid();
    return Object.freeze(items);
  };
  const segmentName = (value) =>
    text(value, 255) &&
    value.trim() === value &&
    !/[\\/]/.test(value) &&
    value !== '.' &&
    value !== '..';
  const allowedExtensions = uniqueList(docsPolicy.allowedExtensions, (value) =>
    DOCS_CANDIDATE_EXTENSIONS.has(value),
  );
  const allowedPaths = uniqueList(
    docsPolicy.allowedPaths,
    (value) =>
      repositoryPath(value, false) &&
      allowedExtensions.some((extension) => value.endsWith(extension)),
  );
  const allowedPrefixes = uniqueList(
    docsPolicy.allowedPrefixes,
    (value) => repositoryPath(value, true) && value.endsWith('/'),
  );
  const excludedNames = uniqueList(docsPolicy.excludedNames, segmentName);
  const excludedSegments = uniqueList(docsPolicy.excludedSegments, segmentName);
  const excludedPrefixes = uniqueList(docsPolicy.excludedPrefixes, (value) =>
    repositoryPath(value, true),
  );
  if (
    allowedExtensions.length === 0 ||
    !BASE_DOCS_EXCLUDED_NAMES.every((base) =>
      excludedNames.some(
        (name) => asciiLowerCase(name) === asciiLowerCase(base),
      ),
    ) ||
    !BASE_DOCS_EXCLUDED_SEGMENTS.every((base) =>
      excludedSegments.some((segment) => segment.toLowerCase() === base),
    ) ||
    (Object.values(taskClasses).some((definition) => definition.docsOnly) &&
      allowedPaths.length + allowedPrefixes.length === 0)
  )
    invalid();
  resolved.docsCandidatePolicy = Object.freeze({
    allowedPaths,
    allowedPrefixes,
    allowedExtensions,
    excludedNames,
    excludedSegments,
    excludedPrefixes,
  });

  // Roles and providers. A provider is a built-in module or a module the
  // profile passes in providerModules (module objects, never paths), checked
  // against the provider contract and the role rules; an id may not repeat
  // a built-in or another module. The provider must serve the role; models
  // follow the core rule and the provider's, efforts its allowlist.
  const registry = Object.assign(Object.create(null), BUILTIN_PROVIDERS);
  if (Object.hasOwn(resolved, 'providerModules')) {
    const modules = list(resolved.providerModules).map(loadProviderModule);
    for (const module of modules) {
      if (Object.hasOwn(registry, module.id)) invalid();
      registry[module.id] = module;
    }
    resolved.providerModules = Object.freeze(modules);
  }
  const provider = (value, role) => {
    if (
      typeof value !== 'string' ||
      !Object.hasOwn(registry, value) ||
      !registry[value].roles.includes(role)
    )
      invalid();
    return registry[value];
  };
  const implementer = record(resolved.implementer, IMPLEMENTER_KEYS);
  if (Object.keys(implementer).length !== IMPLEMENTER_KEYS.size) invalid();
  const writer = provider(implementer.provider, 'implementer');
  const allowedEfforts = uniqueList(implementer.allowedEfforts, (value) =>
    writer.efforts.includes(value),
  );
  if (
    allowedEfforts.length === 0 ||
    !isProviderModel(writer, implementer.model) ||
    !allowedEfforts.includes(implementer.effort)
  )
    invalid();
  resolved.implementer = Object.freeze({
    provider: implementer.provider,
    model: implementer.model,
    effort: implementer.effort,
    allowedEfforts,
  });
  ROLE_PROVIDERS.set(resolved.implementer, writer);

  const reviewer = record(resolved.reviewer, REVIEWER_KEYS);
  if (Object.keys(reviewer).length !== REVIEWER_KEYS.size) invalid();
  const reviewAdapter = provider(reviewer.provider, 'reviewer');
  const profileEntries = Object.entries(record(reviewer.profiles));
  if (
    profileEntries.length === 0 ||
    profileEntries.length > MAX_PROFILE_LIST_ITEMS
  )
    invalid();
  const profiles = {};
  for (const [name, value] of profileEntries) {
    if (
      name.length > MAX_REVIEW_PROFILE_NAME_LENGTH ||
      !REVIEW_PROFILE_NAME.test(name) ||
      name === INVALID_REVIEW_PROFILE_NAME
    )
      invalid();
    profiles[name] = Object.freeze(
      list(value).map((attempt) => {
        const fields = record(attempt, REVIEW_ATTEMPT_KEYS);
        if (
          !isProviderModel(reviewAdapter, fields.model) ||
          !reviewAdapter.efforts.includes(fields.effort)
        )
          invalid();
        return Object.freeze({ model: fields.model, effort: fields.effort });
      }),
    );
  }
  const { defaultProfile, fallbackProfile } = reviewer;
  if (
    typeof defaultProfile !== 'string' ||
    !Object.hasOwn(profiles, defaultProfile) ||
    (fallbackProfile !== null &&
      (typeof fallbackProfile !== 'string' ||
        !Object.hasOwn(profiles, fallbackProfile))) ||
    !Object.entries(profiles).every(
      ([name, attempts]) =>
        attempts.length ===
        (name === fallbackProfile ? FALLBACK_PROFILE_ATTEMPTS : 1),
    )
  )
    invalid();
  resolved.reviewer = Object.freeze({
    provider: reviewer.provider,
    profiles: Object.freeze(profiles),
    defaultProfile,
    fallbackProfile,
  });
  ROLE_PROVIDERS.set(resolved.reviewer, reviewAdapter);
  return Object.freeze(resolved);
}

function checkDefinition(profile, name) {
  return Object.hasOwn(profile.checks, name) ? profile.checks[name] : undefined;
}

function allowedPnpmInvocations(checks, profile) {
  const selectedProfile = resolveRunnerProfile(profile);
  const invocations = new Map();
  const add = (args) => invocations.set(JSON.stringify(args), [...args]);
  for (const option of PNPM_VERSION_ARGV) add([option]);
  for (const name of checks) {
    const definition = checkDefinition(selectedProfile, name);
    if (definition?.program !== 'pnpm') continue;
    // The check argv and its explicit 'run' form (never 'run run …').
    add(definition.args);
    add(pnpmRunArgv(definition.args));
  }
  // Nested invocations are exact argv lists, added in registry order.
  for (const [name, definition] of Object.entries(selectedProfile.checks)) {
    if (!checks.includes(name)) continue;
    for (const args of definition.nestedInvocations ?? []) add(args);
  }
  return [...invocations.values()];
}

async function createPackageManagerGuards({
  directory,
  pnpmPath,
  corepackPath,
  checks,
  profile,
  otherPackageManagerPaths = {},
}) {
  const binDirectory = join(directory, 'guard-bin');
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  // Each allowed argv maps to the argv actually executed: the version queries
  // as they are, script invocations in their explicit 'run' form.
  const allowed = allowedPnpmInvocations(checks, profile).map((args) => [
    JSON.stringify(args),
    PNPM_VERSION_ARGV.has(args.join(' ')) ? args : pnpmRunArgv(args),
  ]);
  const pnpmSource = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const allowed = new Map(${JSON.stringify(allowed)});
const args = allowed.get(JSON.stringify(process.argv.slice(2)));
if (!args) {
  process.stderr.write(${JSON.stringify(`${msg('guard.pnpmBlocked')}\n`)});
  process.exit(126);
}
const result = spawnSync(${JSON.stringify(pnpmPath)}, args, { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
`;
  const corepackSource = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--version') {
  process.stderr.write(${JSON.stringify(`${msg('guard.corepackBlocked')}\n`)});
  process.exit(126);
}
const result = spawnSync(${JSON.stringify(corepackPath)}, args, { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
`;
  const blockedManagerSources = BLOCKED_PACKAGE_MANAGERS.map((name) => {
    const executable = otherPackageManagerPaths[name] ?? null;
    return [
      name,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (!(args.length === 1 && (args[0] === '--version' || args[0] === '-v'))) {
  process.stderr.write(${JSON.stringify(`${msg('guard.callBlocked', { name })}\n`)});
  process.exit(126);
}
const executable = ${JSON.stringify(executable)};
if (!executable) {
  process.stderr.write(${JSON.stringify(`${msg('guard.notInstalled', { name })}\n`)});
  process.exit(127);
}
const result = spawnSync(executable, args, { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
`,
    ];
  });
  await Promise.all([
    writeFile(join(binDirectory, 'pnpm'), pnpmSource, { mode: 0o500 }),
    writeFile(join(binDirectory, 'corepack'), corepackSource, { mode: 0o500 }),
    ...blockedManagerSources.map(([name, source]) =>
      writeFile(join(binDirectory, name), source, { mode: 0o500 }),
    ),
  ]);
  await chmod(binDirectory, 0o500);
  return binDirectory;
}

async function createAgentCommandGuards({
  directory,
  gitPath,
  pnpmPath,
  corepackPath,
  checks,
  profile,
  otherPackageManagerPaths,
}) {
  const binDirectory = join(directory, 'guard-bin');
  const existing = await Promise.all(
    ['git', 'pnpm', 'corepack', ...BLOCKED_PACKAGE_MANAGERS].map((name) =>
      lstat(join(binDirectory, name)).catch(() => undefined),
    ),
  );
  if (existing.every((metadata) => metadata?.isFile())) return binDirectory;
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  await chmod(binDirectory, 0o700);
  await createGitGuard({ directory, gitPath, seal: false });
  const resolvedOtherPackageManagerPaths =
    otherPackageManagerPaths ??
    Object.fromEntries(
      await Promise.all(
        BLOCKED_PACKAGE_MANAGERS.map(async (name) => [
          name,
          await findOptionalExecutable(name),
        ]),
      ),
    );
  return createPackageManagerGuards({
    directory,
    pnpmPath,
    corepackPath,
    checks,
    profile,
    otherPackageManagerPaths: resolvedOtherPackageManagerPaths,
  });
}

async function findExecutable(name, environment = process.env) {
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    const metadata = await lstat(candidate).catch(() => undefined);
    if (!metadata) continue;
    const actual = metadata.isSymbolicLink()
      ? await realpath(candidate)
      : candidate;
    const actualMetadata = await lstat(actual).catch(() => undefined);
    if (actualMetadata?.isFile() && (actualMetadata.mode & 0o111) !== 0) {
      return actual;
    }
  }
  throw new AgentWorkflowError(msg('program.notFound', { name }), {
    code: 'MISSING_EXECUTABLE',
    stage: 'preflight',
  });
}

async function findOptionalExecutable(name, environment = process.env) {
  try {
    return await findExecutable(name, environment);
  } catch (error) {
    if (
      error instanceof AgentWorkflowError &&
      error.code === 'MISSING_EXECUTABLE'
    ) {
      return undefined;
    }
    throw error;
  }
}

function isSnapshotExcludedPath(path) {
  return path
    .split('/')
    .some((segment) => SNAPSHOT_EXCLUDED_SEGMENTS.has(segment));
}

async function listRepositoryPaths(runner, cwd, stage) {
  const result = await requiredGitRun(
    runner,
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd, stage, exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES },
    msg('repo.filesUnreadable'),
  );
  return parseNullSeparated(result.stdout)
    .filter((path) => !isSnapshotExcludedPath(path))
    .sort();
}

async function inspectRepositoryPath(root, path) {
  if (isAbsolute(path)) {
    throw new AgentWorkflowError(msg('repo.absolutePath'), {
      code: 'PATH_ESCAPE',
      stage: 'snapshot',
    });
  }
  const absolute = resolve(root, path);
  if (!pathIsInside(root, absolute)) {
    throw new AgentWorkflowError(msg('repo.pathEscape'), {
      code: 'PATH_ESCAPE',
      stage: 'snapshot',
    });
  }
  const metadata = await lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return { path, type: 'missing', size: 0, hash: null };
  if (metadata.isSymbolicLink()) {
    const target = await readlink(absolute);
    if (isAbsolute(target)) {
      throw new AgentWorkflowError(
        msg('repo.linkAbsolute', { path: JSON.stringify(path) }),
        {
          code: 'SYMLINK_ESCAPE',
          stage: 'snapshot',
        },
      );
    }
    const targetAbsolute = resolve(dirname(absolute), target);
    if (!pathIsInside(root, targetAbsolute)) {
      throw new AgentWorkflowError(
        msg('repo.linkEscape', { path: JSON.stringify(path) }),
        { code: 'SYMLINK_ESCAPE', stage: 'snapshot' },
      );
    }
    return {
      path,
      type: 'symlink',
      size: Buffer.byteLength(target),
      hash: createHash('sha256').update(target).digest('hex'),
      target,
      executable: false,
    };
  }
  if (!metadata.isFile()) {
    throw new AgentWorkflowError(
      msg('repo.unsupportedEntry', { path: JSON.stringify(path) }),
      { code: 'UNSUPPORTED_FILE_TYPE', stage: 'snapshot' },
    );
  }
  if (metadata.size > MAX_FILE_BYTES) {
    throw new AgentWorkflowError(
      msg('repo.fileTooLarge', { path: JSON.stringify(path) }),
      { code: 'SNAPSHOT_TOO_LARGE', stage: 'snapshot' },
    );
  }
  const content = await readFile(absolute);
  return {
    path,
    type: 'file',
    size: content.length,
    hash: createHash('sha256').update(content).digest('hex'),
    executable: (metadata.mode & 0o111) !== 0,
    content,
  };
}

function manifestHash(entries) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        entries.map(({ path, type, size, hash, executable, target }) => ({
          path,
          type,
          size,
          hash,
          executable: Boolean(executable),
          target,
        })),
      ),
    )
    .digest('hex');
}

async function readRepositoryManifest({ runner, cwd, stage }) {
  const paths = await listRepositoryPaths(runner, cwd, stage);
  const entries = [];
  let totalBytes = 0;
  for (const path of paths) {
    assertNotCancelled(runner, stage);
    const entry = await inspectRepositoryPath(cwd, path);
    totalBytes += entry.size;
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      throw new AgentWorkflowError(
        msg('repo.stateTooLarge'),
        { code: 'SNAPSHOT_TOO_LARGE', stage },
      );
    }
    entries.push(entry);
  }
  return { paths, entries, totalBytes, hash: manifestHash(entries) };
}

// Inspect the entire candidate against HEAD, not only changes made this round.
// --no-renames deliberately exposes both endpoints; NUL preserves exact paths.
async function readCandidatePaths({ runner, cwd, stage }) {
  const changed = await requiredGitRun(
    runner,
    ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'],
    { cwd, stage, exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES },
    msg('repo.candidateUnreadable'),
  );
  const untracked = await requiredGitRun(
    runner,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd, stage, exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES },
    msg('repo.newFilesUnreadable'),
  );
  const paths = [
    ...new Set([
      ...parseNullSeparated(changed.stdout),
      ...parseNullSeparated(untracked.stdout),
    ]),
  ].sort();
  return paths;
}

// Profile rules: a candidate touching configured paths must request the
// rule's check explicitly; otherwise the run stops with the rule's code.
async function assertRequiredGates({ runner, cwd, stage, task, profile }) {
  if (task.mode !== 'implementation') return;
  const rules = resolveRunnerProfile(profile).requiredGateRules.filter(
    (rule) => !task.checks.includes(rule.check),
  );
  if (rules.length === 0) return;
  const paths = await readCandidatePaths({ runner, cwd, stage });
  for (const rule of rules) {
    if (
      paths.some(
        (path) =>
          rule.paths.includes(path) ||
          rule.prefixes.some((prefix) => path.startsWith(prefix)),
      )
    ) {
      throw new AgentWorkflowError(
        rule.message ??
          msg('gates.ruleRequired', { check: rule.check }),
        { code: rule.code, stage },
      );
    }
  }
}

// protectedPaths: the files of a project profile loaded from
// ringi.config.mjs (loadProjectProfile); never part of a docs candidate.
async function assertDocsCandidate({
  runner,
  cwd,
  stage,
  profile,
  protectedPaths = [],
}) {
  const policy = resolveRunnerProfile(profile).docsCandidatePolicy;
  const protectedNames = new Set(protectedPaths.map(asciiLowerCase));
  const excludedNames = new Set(
    [...BASE_DOCS_EXCLUDED_NAMES, ...policy.excludedNames].map(asciiLowerCase),
  );
  const excludedSegments = new Set(
    [...BASE_DOCS_EXCLUDED_SEGMENTS, ...policy.excludedSegments].map((part) =>
      part.toLowerCase(),
    ),
  );
  const excludedPrefixes = policy.excludedPrefixes.map(asciiLowerCase);
  const paths = await readCandidatePaths({ runner, cwd, stage });
  const reject = (path) => {
    throw new AgentWorkflowError(
      msg('docs.candidateForbidden', { path: JSON.stringify(path) }),
      { code: 'DOCS_CANDIDATE_REJECTED', stage },
    );
  };
  for (const path of paths) {
    // Known instruction/procedure namespaces are excluded by path, never by
    // keywords offered as a supposed proof of safe document semantics.
    const segments = path.split('/');
    if (
      !(
        (policy.allowedPaths.includes(path) ||
          policy.allowedPrefixes.some((prefix) => path.startsWith(prefix))) &&
        policy.allowedExtensions.some((extension) => path.endsWith(extension))
      ) ||
      segments.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          excludedNames.has(asciiLowerCase(part)),
      ) ||
      protectedNames.has(asciiLowerCase(path)) ||
      /[\\\x00-\x1f\x7f]/.test(path) ||
      hasAsciiFoldingCharacter(path) ||
      excludedPrefixes.some((prefix) =>
        asciiLowerCase(path).startsWith(prefix),
      ) ||
      segments.some((part) => excludedSegments.has(part.toLowerCase()))
    )
      reject(path);
    // HEAD types protect deletions and symlink-to-file replacements as well.
    const original = await requiredGitRun(
      runner,
      ['ls-tree', '-z', 'HEAD', '--', path],
      { cwd, stage, exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES },
      msg('repo.headTypeUnreadable'),
    );
    for (const entry of parseNullSeparated(original.stdout)) {
      if (!/^100644 blob [a-f0-9]+\t/.test(entry)) reject(path);
    }
    let absolute = cwd;
    for (let index = 0; index < segments.length; index++) {
      absolute = join(absolute, segments[index]);
      const metadata = await lstat(absolute).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!metadata) break; // deleted regular document
      if (
        metadata.isSymbolicLink() ||
        (index < segments.length - 1
          ? !metadata.isDirectory()
          : !metadata.isFile() || (metadata.mode & 0o111) !== 0)
      )
        reject(path);
    }
  }
}

async function readAnalysisMutationFingerprint({ runner, cwd, stage }) {
  const paths = await listRepositoryPaths(runner, cwd, stage);
  const entries = new Set(['.']);
  for (const path of paths) {
    entries.add(path);
    let parent = dirname(path);
    while (parent !== '.') {
      entries.add(parent);
      parent = dirname(parent);
    }
  }
  const hash = createHash('sha256');
  for (const path of [...entries].sort()) {
    const absolute = path === '.' ? cwd : resolve(cwd, path);
    const metadata = await lstat(absolute, { bigint: true }).catch((error) => {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadata) {
      hash.update(`missing\0${path}\0`);
      continue;
    }
    hash.update(
      [
        path,
        metadata.mode.toString(),
        metadata.dev.toString(),
        metadata.ino.toString(),
        metadata.size.toString(),
        metadata.mtimeNs?.toString() ?? metadata.mtimeMs.toString(),
        metadata.ctimeNs?.toString() ?? metadata.ctimeMs.toString(),
      ].join('\0'),
    );
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), paths };
}

async function fullDiff({ runner, cwd, stage }) {
  const tracked = await requiredGitRun(
    runner,
    ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'],
    { cwd, stage, exactStdoutLimitBytes: MAX_DIFF_BYTES },
    msg('diff.trackedFailed'),
  );
  let diff = tracked.stdout;
  const status = await requiredGitRun(
    runner,
    ['ls-files', '-z', '--others', '--exclude-standard'],
    { cwd, stage, exactStdoutLimitBytes: MAX_GIT_PATH_LIST_BYTES },
    msg('diff.untrackedUnreadable'),
  );
  for (const path of parseNullSeparated(status.stdout)
    .filter((path) => !isSnapshotExcludedPath(path))
    .sort()) {
    assertNotCancelled(runner, stage);
    const metadata = await lstat(resolve(cwd, path));
    if (!metadata.isFile() && !metadata.isSymbolicLink()) continue;
    const result = await safeRun(
      runner,
      'git',
      ['diff', '--no-index', '--binary', '--', '/dev/null', path],
      { cwd, stage, exactStdoutLimitBytes: MAX_DIFF_BYTES },
      msg('diff.pathFailed', { path }),
    );
    if (![0, 1].includes(result.code)) {
      throw new AgentWorkflowError(
        msg('diff.pathFailedDetail', {
          path: JSON.stringify(path),
          detail: conciseProcessFailure(result),
        }),
        { code: 'DIFF_FAILED', stage },
      );
    }
    diff += result.stdout;
    if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
      throw new AgentWorkflowError(msg('diff.tooLarge'), {
        code: 'DIFF_TOO_LARGE',
        stage,
      });
    }
  }
  return diff;
}

async function copyManifestToSnapshot({
  manifest,
  sourceRoot,
  targetRoot,
  runner,
}) {
  const copiedEntries = [];
  for (const entry of manifest.entries) {
    assertNotCancelled(runner, 'snapshot');
    if (entry.type === 'missing') {
      copiedEntries.push(entry);
      continue;
    }
    const source = resolve(sourceRoot, entry.path);
    const target = resolve(targetRoot, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (entry.type === 'symlink') {
      await symlink(entry.target, target);
    } else {
      await copyFile(source, target);
      await chmod(target, entry.executable ? 0o700 : 0o600);
    }
    const copied = await inspectRepositoryPath(targetRoot, entry.path);
    copiedEntries.push(copied);
  }
  return manifestHash(copiedEntries);
}

async function makeReadOnly(path) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await makeReadOnly(child);
    else await chmod(child, 0o400);
  }
  await chmod(path, 0o500);
}

async function snapshotContentHash(root) {
  const hash = createHash('sha256');
  const rootMetadata = await lstat(root);
  hash.update(`root\0${rootMetadata.mode & 0o777}\0`);
  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        hash.update(
          `symlink\0${path}\0${metadata.mode & 0o777}\0${await readlink(absolutePath)}\0`,
        );
      } else if (metadata.isDirectory()) {
        hash.update(`directory\0${path}\0${metadata.mode & 0o777}\0`);
        await visit(absolutePath, path);
      } else if (metadata.isFile()) {
        hash.update(
          `file\0${path}\0${metadata.mode & 0o777}\0${metadata.size}\0`,
        );
        hash.update(await readFile(absolutePath));
        hash.update('\0');
      } else {
        throw new AgentWorkflowError(
          msg('snapshot.unsupportedEntry', { path: JSON.stringify(path) }),
          { code: 'SNAPSHOT_CHANGED', stage: 'claude' },
        );
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

async function assertReviewStateUnchanged({
  runner,
  repositoryRoot,
  branch,
  head,
  snapshot,
  analysisArtifact,
}) {
  await assertGitIdentityStable({
    runner,
    cwd: repositoryRoot,
    branch,
    head,
    stage: 'claude',
  });
  const workingTree = await readRepositoryManifest({
    runner,
    cwd: repositoryRoot,
    stage: 'claude',
  });
  if (workingTree.hash !== snapshot.sourceHash) {
    throw new AgentWorkflowError(
      msg('snapshot.treeChangedReview'),
      { code: 'WORKING_TREE_CHANGED', stage: 'claude' },
    );
  }
  if (
    snapshot.snapshotHash &&
    (await snapshotContentHash(snapshot.root)) !== snapshot.snapshotHash
  ) {
    throw new AgentWorkflowError(
      msg('snapshot.changedDuringReview'),
      {
        code: 'SNAPSHOT_CHANGED',
        stage: 'claude',
      },
    );
  }
  if (analysisArtifact) {
    await assertAnalysisArtifactIntegrity(analysisArtifact, 'claude');
  }
}

async function makeWritableForCleanup(path) {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata || metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    await chmod(path, 0o700).catch(() => {});
    const entries = await readdir(path, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      await makeWritableForCleanup(join(path, entry.name));
    }
  } else {
    await chmod(path, 0o600).catch(() => {});
  }
}

async function writeAnalysisPackageFile({
  snapshotRoot,
  packagePath,
  content,
}) {
  const target = join(snapshotRoot, packagePath);
  if (!pathIsInside(snapshotRoot, target)) {
    throw new AgentWorkflowError(msg('snapshot.packagePathEscape'), {
      code: 'ANALYSIS_PACKAGE_INVALID',
      stage: 'snapshot',
    });
  }
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
  return {
    packagePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

async function createAnalysisReviewSnapshot({
  runner,
  repositoryRoot,
  tempRoot,
  task,
  repositoryInstructions,
  round,
  integrityReport,
  analysisArtifact,
  previousFindings,
  findingResponses,
}) {
  validateAnalysisIntegrityReport(integrityReport);
  await assertAnalysisArtifactIntegrity(analysisArtifact, 'snapshot');
  const before = await readRepositoryManifest({
    runner,
    cwd: repositoryRoot,
    stage: 'snapshot',
  });
  const snapshotRoot = join(tempRoot, `claude-review-${round}`);
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  const instructionsPath = '.review-context/repository-instructions.md';
  const originalTaskPath = '.review-context/original-task.md';
  const analysisArtifactPath = '.review-context/analysis-artifact.md';
  const integrityPath = '.review-context/trusted-integrity.json';
  const manifestPath = '.review-context/review-manifest.json';

  const instructionsEntry = await writeAnalysisPackageFile({
    snapshotRoot,
    packagePath: instructionsPath,
    content: repositoryInstructions,
  });
  const taskEntry = await writeAnalysisPackageFile({
    snapshotRoot,
    packagePath: originalTaskPath,
    content: task.markdown,
  });
  let artifactHandle;
  let artifactBytes;
  try {
    artifactHandle = await open(
      analysisArtifact.absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    artifactBytes = await artifactHandle.readFile();
  } catch {
    throw new AgentWorkflowError(
      msg('snapshot.artifactChanged'),
      { code: 'ANALYSIS_PACKAGE_INVALID', stage: 'snapshot' },
    );
  } finally {
    await artifactHandle?.close().catch(() => {});
  }
  const artifactEntry = await writeAnalysisPackageFile({
    snapshotRoot,
    packagePath: analysisArtifactPath,
    content: artifactBytes,
  });
  if (
    artifactEntry.sha256 !== analysisArtifact.sha256 ||
    artifactEntry.sizeBytes !== analysisArtifact.sizeBytes
  ) {
    throw new AgentWorkflowError(
      msg('snapshot.artifactCopyMismatch'),
      { code: 'ANALYSIS_PACKAGE_INVALID', stage: 'snapshot' },
    );
  }
  validateFindingResponseList(findingResponses, {
    fullAnalysis: artifactBytes.toString('utf8'),
  });
  const integrityBytes = Buffer.from(
    `${JSON.stringify(integrityReport, null, 2)}\n`,
  );
  const integrityEntry = await writeAnalysisPackageFile({
    snapshotRoot,
    packagePath: integrityPath,
    content: integrityBytes,
  });
  let correctionContextPath;
  let correctionEntry;
  if (round > 1) {
    correctionContextPath = '.review-context/correction-context.json';
    correctionEntry = await writeAnalysisPackageFile({
      snapshotRoot,
      packagePath: correctionContextPath,
      content: `${redactSensitive(
        JSON.stringify({ previousFindings, findingResponses }, null, 2),
      )}\n`,
    });
  }

  const documents = [];
  let documentBytes = 0;
  for (const reviewFile of task.reviewFiles) {
    let handle;
    let metadata;
    let content;
    try {
      handle = await open(
        reviewFile.absolutePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      metadata = await handle.stat();
      content = await handle.readFile();
    } catch {
      throw new AgentWorkflowError(
        msg('task.reviewFileUnsafe', { path: JSON.stringify(reviewFile.path) }),
        { code: 'ANALYSIS_PACKAGE_INVALID', stage: 'snapshot' },
      );
    } finally {
      await handle?.close().catch(() => {});
    }
    const current = await lstat(reviewFile.absolutePath).catch(() => undefined);
    if (
      !metadata.isFile() ||
      !current?.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino ||
      metadata.dev !== reviewFile.dev ||
      metadata.ino !== reviewFile.ino ||
      metadata.size !== reviewFile.sizeBytes ||
      content.length !== metadata.size ||
      createHash('sha256').update(content).digest('hex') !== reviewFile.sha256
    ) {
      throw new AgentWorkflowError(
        msg('snapshot.reviewFileChanged', {
          path: JSON.stringify(reviewFile.path),
        }),
        { code: 'ANALYSIS_PACKAGE_INVALID', stage: 'snapshot' },
      );
    }
    assertNoSecretContent(
      content.toString('utf8'),
      reviewFile.path,
      'snapshot',
    );
    documentBytes += content.length;
    if (documentBytes > MAX_ANALYSIS_REVIEW_FILES_BYTES) {
      throw new AgentWorkflowError(
        msg('task.reviewFilesTotal'),
        { code: 'ANALYSIS_PACKAGE_INVALID', stage: 'snapshot' },
      );
    }
    const entry = await writeAnalysisPackageFile({
      snapshotRoot,
      packagePath: reviewFile.path,
      content,
    });
    documents.push({ sourcePath: reviewFile.path, ...entry });
  }

  const manifest = {
    schemaVersion: 1,
    mode: 'analysis',
    round,
    task: { sourcePath: task.path, ...taskEntry },
    repositoryInstructions: instructionsEntry,
    artifact: {
      sourcePath: analysisArtifact.path,
      ...artifactEntry,
      complete: true,
      sentinel: ANALYSIS_COMPLETENESS_SENTINEL,
    },
    integrity: integrityEntry,
    documents,
    ...(correctionEntry ? { correctionContext: correctionEntry } : {}),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestEntry = await writeAnalysisPackageFile({
    snapshotRoot,
    packagePath: manifestPath,
    content: manifestBytes,
  });

  const after = await readRepositoryManifest({
    runner,
    cwd: repositoryRoot,
    stage: 'snapshot',
  });
  if (before.hash !== after.hash) {
    throw new AgentWorkflowError(
      msg('snapshot.treeChangedAnalysis'),
      { code: 'WORKING_TREE_CHANGED', stage: 'snapshot' },
    );
  }
  await makeReadOnly(snapshotRoot);
  const snapshotHash = await snapshotContentHash(snapshotRoot);
  const expectedConfirmation = {
    task: { path: originalTaskPath, sha256: taskEntry.sha256 },
    manifest: { path: manifestPath, sha256: manifestEntry.sha256 },
    artifact: {
      path: analysisArtifactPath,
      sha256: artifactEntry.sha256,
    },
    documents: documents.map(({ sourcePath, sha256 }) => ({
      path: sourcePath,
      sha256,
    })),
  };
  const totalBytes =
    instructionsEntry.sizeBytes +
    taskEntry.sizeBytes +
    artifactEntry.sizeBytes +
    integrityEntry.sizeBytes +
    manifestEntry.sizeBytes +
    documents.reduce((sum, entry) => sum + entry.sizeBytes, 0) +
    (correctionEntry?.sizeBytes ?? 0);
  if (totalBytes > MAX_SNAPSHOT_BYTES) {
    throw new AgentWorkflowError(
      msg('snapshot.analysisPackageTooLarge'),
      { code: 'SNAPSHOT_TOO_LARGE', stage: 'snapshot' },
    );
  }
  return {
    root: snapshotRoot,
    taskMode: 'analysis',
    sourceHash: before.hash,
    snapshotHash,
    instructionsPath,
    originalTaskPath,
    manifestPath,
    analysisArtifactPath,
    integrityPath,
    correctionContextPath,
    expectedConfirmation,
    analysisHeadings: [...analysisArtifact.headings],
    artifactSourcePath: analysisArtifact.path,
    manifestHash: manifestEntry.sha256,
    fileCount:
      5 + documents.length + (correctionContextPath === undefined ? 0 : 1),
    totalBytes,
  };
}

export async function createReviewSnapshot({
  runner,
  repositoryRoot,
  tempRoot,
  task,
  repositoryInstructions,
  round = 1,
  gateReport,
  previousFindings = [],
  findingResponses = [],
  taskMode = DEFAULT_TASK_MODE,
  integrityReport,
  analysisArtifact,
  profile,
}) {
  const selectedTaskMode = resolveTaskMode(taskMode);
  validateFindingResponseList(findingResponses);
  if (selectedTaskMode === 'analysis') {
    return createAnalysisReviewSnapshot({
      runner,
      repositoryRoot,
      tempRoot,
      task,
      repositoryInstructions,
      round,
      integrityReport,
      analysisArtifact,
      previousFindings,
      findingResponses,
    });
  }
  validateTrustedGateReport(gateReport, profile);
  const before = await readRepositoryManifest({
    runner,
    cwd: repositoryRoot,
    stage: 'snapshot',
  });
  const diffBefore = await fullDiff({
    runner,
    cwd: repositoryRoot,
    stage: 'snapshot',
  });
  const snapshotRoot = join(tempRoot, `claude-review-${round}`);
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  const copiedHash = await copyManifestToSnapshot({
    manifest: before,
    sourceRoot: repositoryRoot,
    targetRoot: snapshotRoot,
    runner,
  });
  const diffAfter = await fullDiff({
    runner,
    cwd: repositoryRoot,
    stage: 'snapshot',
  });
  const after = await readRepositoryManifest({
    runner,
    cwd: repositoryRoot,
    stage: 'snapshot',
  });
  if (
    before.hash !== copiedHash ||
    before.hash !== after.hash ||
    diffBefore !== diffAfter
  ) {
    throw new AgentWorkflowError(
      msg('snapshot.treeChangedCopy'),
      { code: 'WORKING_TREE_CHANGED', stage: 'snapshot' },
    );
  }

  const contextDirectory = join(snapshotRoot, '.review-context');
  await mkdir(contextDirectory, { recursive: true, mode: 0o700 });
  const instructionsPath = '.review-context/instructions-and-task.md';
  const diffPath = '.review-context/full.diff';
  const gatesPath = '.review-context/trusted-gates.json';
  await writeFile(
    join(snapshotRoot, instructionsPath),
    `# Instrukcje repozytorium\n\n${repositoryInstructions}\n\n# Oryginalne zadanie (${task.path})\n\n${task.markdown}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(snapshotRoot, diffPath), diffBefore, { mode: 0o600 });
  await writeFile(
    join(snapshotRoot, gatesPath),
    `${JSON.stringify(gateReport, null, 2)}\n`,
    { mode: 0o600 },
  );
  let correctionContextPath;
  if (round > 1) {
    correctionContextPath = '.review-context/correction-context.json';
    await writeFile(
      join(snapshotRoot, correctionContextPath),
      `${redactSensitive(
        JSON.stringify(
          {
            previousFindings,
            findingResponses,
          },
          null,
          2,
        ),
      )}\n`,
      { mode: 0o600 },
    );
  }
  await makeReadOnly(snapshotRoot);
  const snapshotHash = await snapshotContentHash(snapshotRoot);
  return {
    root: snapshotRoot,
    sourceHash: before.hash,
    diffHash: createHash('sha256').update(diffBefore).digest('hex'),
    snapshotHash,
    instructionsPath,
    diffPath,
    gatesPath,
    correctionContextPath,
    fileCount: before.entries.filter((entry) => entry.type !== 'missing')
      .length,
    totalBytes: before.totalBytes,
  };
}

async function cleanupOwnedTemp(tempRoot, runId, profile) {
  const { tempPrefix } = resolveRunnerProfile(profile);
  if (!tempRoot) return;
  const realTempParent = await realpath(tmpdir());
  const lexical = resolve(tempRoot);
  const actual = await realpath(lexical).catch(() => lexical);
  if (
    !pathIsInside(realTempParent, actual) ||
    !basename(actual).startsWith(`${tempPrefix}${runId}-`)
  ) {
    throw new AgentWorkflowError(msg('cleanup.unknownResource'), {
      code: 'UNSAFE_CLEANUP',
      stage: 'cleanup',
    });
  }
  await makeWritableForCleanup(actual);
  await rm(actual, { recursive: true, force: true });
}

function normalizeFindingPath(value) {
  const trimmed = value.trim();
  const normalized = trimmed
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  if (
    !normalized ||
    isAbsolute(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..') ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AgentWorkflowError(
      msg('reviewer.findingAmbiguousPath'),
      { code: 'INVALID_AGENT_OUTPUT', stage: 'claude' },
    );
  }
  return normalized.normalize('NFC');
}

function canonicalFindingIdentity(finding) {
  const identity = {
    file: normalizeFindingPath(finding.file),
    anchor: finding.anchor.trim().replace(/\s+/g, ' ').normalize('NFC'),
    category: finding.category.trim(),
  };
  if (
    !identity.anchor ||
    /[\u0000-\u001f\u007f]/.test(identity.anchor) ||
    !/^[a-z][a-z0-9._-]{0,99}$/.test(identity.category)
  ) {
    throw new AgentWorkflowError(
      msg('reviewer.findingAmbiguousFields'),
      { code: 'INVALID_AGENT_OUTPUT', stage: 'claude' },
    );
  }
  return identity;
}

function findingFingerprint(finding) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalFindingIdentity(finding)))
    .digest('hex');
}

function findingIdFor(finding) {
  return `${FINDING_ID_PREFIX}${findingFingerprint(finding).slice(0, 24)}`;
}

function assignFindingIds(findings, knownIdentities = new Map()) {
  const currentIdentities = new Map();
  return findings.map((finding) => {
    const identity = canonicalFindingIdentity(finding);
    const identityKey = JSON.stringify(identity);
    const findingId = findingIdFor(identity);
    if (finding.findingId !== undefined && finding.findingId !== findingId) {
      throw new AgentWorkflowError(
        msg('reviewer.findingIdMismatch', {
          file: JSON.stringify(identity.file),
        }),
        { code: 'FINDING_ID_MISMATCH', stage: 'claude' },
      );
    }
    const known = knownIdentities.get(findingId);
    if (known && JSON.stringify(known) !== identityKey) {
      throw new AgentWorkflowError(
        msg('finding.identityCollision', { findingId }),
        { code: 'FINDING_ID_COLLISION', stage: 'claude' },
      );
    }
    if (currentIdentities.has(findingId)) {
      throw new AgentWorkflowError(
        msg('finding.identityDuplicate', { findingId }),
        { code: 'AMBIGUOUS_FINDING_IDENTITY', stage: 'claude' },
      );
    }
    currentIdentities.set(findingId, identity);
    knownIdentities.set(findingId, identity);
    return { ...finding, ...identity, findingId };
  });
}

async function saveJson(path, value) {
  const redacted = redactSensitive(JSON.stringify(value, null, 2));
  await writeFile(path, `${redacted}\n`, { mode: 0o600 });
}

async function atomicWritePrivateFile(targetPath, content, stage) {
  const parent = dirname(targetPath);
  const temporaryPath = join(
    parent,
    `.${basename(targetPath)}.${randomBytes(8).toString('hex')}.tmp`,
  );
  if (await lstat(targetPath).catch(() => undefined)) {
    throw new AgentWorkflowError(msg('artifact.overwrite'), {
      code: 'ANALYSIS_ARTIFACT_WRITE_FAILED',
      stage,
    });
  }
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, targetPath);
    await unlink(temporaryPath);
    await chmod(targetPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    if (error instanceof AgentWorkflowError) throw error;
    throw new AgentWorkflowError(
      msg('artifact.writeFailed', {
        detail: redactSensitive(
          error instanceof Error ? error.message : String(error),
        ),
      }),
      { code: 'ANALYSIS_ARTIFACT_WRITE_FAILED', stage },
    );
  }
}

function markdownHeadings(content) {
  const headings = [];
  let fence;
  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.character &&
        fenceMatch[1].length >= fence.length &&
        !fenceMatch[2].trim()
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      fence = {
        character: fenceMatch[1][0],
        length: fenceMatch[1].length,
      };
      continue;
    }
    const heading = line.match(/^ {0,3}#{1,6}[\t ]+\S.*$/);
    if (heading) headings.push(heading[0].trim());
  }
  return headings;
}

async function assertAnalysisArtifactIntegrity(artifact, stage = 'analysis') {
  if (!artifact?.absolutePath || !artifact?.path) {
    throw new AgentWorkflowError(msg('artifact.metadataMissing'), {
      code: 'ANALYSIS_ARTIFACT_INTEGRITY_FAILED',
      stage,
    });
  }
  let handle;
  let metadata;
  let bytes;
  try {
    handle = await open(
      artifact.absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    metadata = await handle.stat();
    bytes = await handle.readFile();
  } catch {
    throw new AgentWorkflowError(
      msg('artifact.missing'),
      { code: 'ANALYSIS_ARTIFACT_INTEGRITY_FAILED', stage },
    );
  } finally {
    await handle?.close().catch(() => {});
  }
  const current = await lstat(artifact.absolutePath).catch(() => undefined);
  if (
    !metadata.isFile() ||
    !current?.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== metadata.dev ||
    current.ino !== metadata.ino ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size !== artifact.sizeBytes ||
    metadata.size > MAX_ANALYSIS_ARTIFACT_BYTES
  ) {
    throw new AgentWorkflowError(
      msg('artifact.changed'),
      { code: 'ANALYSIS_ARTIFACT_INTEGRITY_FAILED', stage },
    );
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== artifact.sha256) {
    throw new AgentWorkflowError(msg('artifact.hashMismatch'), {
      code: 'ANALYSIS_ARTIFACT_INTEGRITY_FAILED',
      stage,
    });
  }
  const validated = validateFullAnalysis(bytes.toString('utf8'));
  if (
    validated.sha256 !== artifact.sha256 ||
    validated.sizeBytes !== artifact.sizeBytes
  ) {
    throw new AgentWorkflowError(
      msg('artifact.contract'),
      { code: 'ANALYSIS_ARTIFACT_INTEGRITY_FAILED', stage },
    );
  }
  return true;
}

async function materializeAnalysisArtifact({
  repositoryRoot,
  runDirectory,
  round,
  report,
}) {
  const validated = validateFullAnalysis(report.fullAnalysis);
  const targetPath = join(runDirectory, `round-${round}-analysis.md`);
  assertNoSecretContent(
    validated.content,
    `round-${round}-analysis.md`,
    'codex',
  );
  await atomicWritePrivateFile(
    targetPath,
    Buffer.from(validated.content),
    'codex',
  );
  const relativePath = relative(repositoryRoot, targetPath)
    .split(sep)
    .join('/');
  const publicMetadata = {
    mode: 'analysis',
    path: relativePath,
    sha256: validated.sha256,
    sizeBytes: validated.sizeBytes,
    complete: true,
    sentinel: ANALYSIS_COMPLETENESS_SENTINEL,
  };
  const artifact = {
    ...publicMetadata,
    absolutePath: targetPath,
    headings: validated.headings,
  };
  await assertAnalysisArtifactIntegrity(artifact, 'codex');
  const withoutAnalysis = { ...report };
  delete withoutAnalysis.fullAnalysis;
  return {
    report: { ...withoutAnalysis, analysisArtifact: publicMetadata },
    artifact,
  };
}

function saveableLog(value) {
  const redacted = redactSensitive(value);
  return redacted.length > MAX_SAVED_LOG_BYTES
    ? `${redacted.slice(0, MAX_SAVED_LOG_BYTES)}\n${msg('log.truncated')}`
    : redacted;
}

function diagnosticLogContent({ label, stdout = '', stderr = '' }) {
  const sections = [`[${label}]`];
  if (stdout) sections.push(`[stdout]\n${saveableLog(stdout).trimEnd()}`);
  if (stderr) sections.push(`[stderr]\n${saveableLog(stderr).trimEnd()}`);
  if (sections.length === 1) sections.push(msg('log.noOutput'));
  return `${sections.join('\n')}\n`;
}

async function saveDiagnosticLog({
  runDirectory,
  relativePath,
  label,
  stdout,
  stderr,
  stage = 'diagnostics',
}) {
  try {
    const path = join(runDirectory, relativePath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, diagnosticLogContent({ label, stdout, stderr }), {
      mode: 0o600,
    });
    return join(STATE_DIRECTORY, 'runs', basename(runDirectory), relativePath);
  } catch (error) {
    throw new AgentWorkflowError(
      msg('log.saveFailed', {
        detail: redactSensitive(
          error instanceof Error ? error.message : String(error),
        ),
      }),
      { code: 'DIAGNOSTIC_LOG_FAILED', stage },
    );
  }
}

function asWorkflowError(
  error,
  fallbackCode = 'PROCESS_ERROR',
  stage = 'checks',
) {
  if (error instanceof AgentWorkflowError) return error;
  return new AgentWorkflowError(
    redactSensitive(error instanceof Error ? error.message : String(error)),
    { code: fallbackCode, stage },
  );
}

function appendIntegrityViolation(primaryError, integrityError) {
  const primary = asWorkflowError(primaryError);
  const integrity = asWorkflowError(integrityError, 'INTEGRITY_CHECK_FAILED');
  const candidates = [
    {
      code: integrity.code,
      stage: integrity.stage,
      error: redactSensitive(integrity.message),
    },
    ...(integrity.integrityViolations ?? []),
  ];
  const violations = [...(primary.integrityViolations ?? [])];
  for (const violation of candidates) {
    if (
      !violations.some(
        (item) =>
          item.code === violation.code &&
          item.stage === violation.stage &&
          item.error === violation.error,
      )
    ) {
      violations.push(violation);
    }
  }
  primary.integrityViolations = violations;
  return primary;
}

function checkResultReport(name, result, durationMs) {
  const fullOutputAvailable =
    !result.stdoutTruncated &&
    !result.stderrTruncated &&
    !result.stdoutLimitExceeded;
  const testCount = fullOutputAvailable
    ? extractUnambiguousTestCount(
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      )
    : undefined;
  return {
    name,
    code: result.code,
    signal: result.signal,
    timedOut: Boolean(result.timedOut),
    durationMs: Math.max(0, Math.round(durationMs)),
    stdout: saveableLog(result.stdout ?? ''),
    stderr: saveableLog(result.stderr ?? ''),
    ...(testCount === undefined ? {} : { testCount }),
  };
}

function boundedUtf8(value, maxBytes) {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  const marker = `\n${msg('summary.truncated')}`;
  const prefixBytes = Math.max(0, maxBytes - Buffer.byteLength(marker));
  return `${buffer
    .subarray(0, prefixBytes)
    .toString('utf8')
    .replace(/\uFFFD+$/g, '')}${marker}`;
}

function extractUnambiguousTestCount(output) {
  // The runner's own truncation markers, in both locales.
  if (/…\[(?:log|podsumowanie) [^\]]*obcięt[^\]]*\]…/iu.test(output)) {
    return undefined;
  }
  if (/…\[log pominięty:[^\]]*\]…/u.test(output)) return undefined;
  if (/…\[(?:log|summary) [^\]]*truncated[^\]]*\]…/iu.test(output)) {
    return undefined;
  }
  if (/…\[log omitted:[^\]]*\]…/u.test(output)) return undefined;
  const candidates = [];
  for (const match of output.matchAll(/^# tests (\d+)\s*$/gm)) {
    candidates.push(Number(match[1]));
  }
  for (const match of output.matchAll(/^ℹ tests (\d+)\s*$/gm)) {
    candidates.push(Number(match[1]));
  }
  for (const match of output.matchAll(
    /^\s*Tests\s+(?:\d+\s+(?:passed|failed|skipped)(?:\s*\|\s*)?)+\s*\((\d+)\)\s*$/gim,
  )) {
    candidates.push(Number(match[1]));
  }
  return candidates.length === 1 && Number.isSafeInteger(candidates[0])
    ? candidates[0]
    : undefined;
}

function trustedGateSummary(result) {
  const raw = [result.stdout, result.stderr]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .trim();
  if (!raw) return msg('gates.noOutput');
  const redacted = redactSensitive(raw).replace(
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|mssql):\/\/[^\s]+/gi,
    '***',
  );
  return boundedUtf8(redacted, MAX_GATE_SUMMARY_BYTES);
}

function createTrustedGateReport(results, requiredChecks, profile) {
  if (
    results.length !== requiredChecks.length ||
    results.some(
      (result, index) =>
        result.name !== requiredChecks[index] ||
        result.code !== 0 ||
        result.timedOut ||
        result.signal,
    )
  ) {
    throw new AgentWorkflowError(
      msg('gates.reportNotPass'),
      { code: 'INVALID_GATE_REPORT', stage: 'checks' },
    );
  }
  return validateTrustedGateReport(
    {
      schemaVersion: 1,
      source: 'agent-review-loop-runner',
      gates: results.map((result) => {
        const testCount = result.testCount;
        return {
          name: result.name,
          status: 'PASS',
          exitCode: result.code,
          durationMs: result.durationMs,
          summary: trustedGateSummary(result),
          ...(testCount === undefined ? {} : { testCount }),
        };
      }),
    },
    profile,
  );
}

function validateTrustedGateReport(report, profile) {
  const selectedProfile = resolveRunnerProfile(profile);
  if (
    !isPlainObject(report) ||
    Object.keys(report).length !== 3 ||
    !['gates', 'schemaVersion', 'source'].every((key) => key in report) ||
    report.schemaVersion !== 1 ||
    report.source !== 'agent-review-loop-runner' ||
    !Array.isArray(report.gates) ||
    report.gates.length === 0
  ) {
    throw new AgentWorkflowError(
      msg('gates.reportStructure'),
      {
        code: 'INVALID_GATE_REPORT',
        stage: 'checks',
      },
    );
  }
  const names = new Set();
  for (const gate of report.gates) {
    if (!isPlainObject(gate)) {
      throw new AgentWorkflowError(
        msg('gates.reportEntry'),
        {
          code: 'INVALID_GATE_REPORT',
          stage: 'checks',
        },
      );
    }
    const allowedKeys = new Set([
      'name',
      'status',
      'exitCode',
      'durationMs',
      'summary',
      'testCount',
    ]);
    if (
      Object.keys(gate).some((key) => !allowedKeys.has(key)) ||
      typeof gate.name !== 'string' ||
      !checkDefinition(selectedProfile, gate.name) ||
      names.has(gate.name) ||
      gate.status !== 'PASS' ||
      gate.exitCode !== 0 ||
      !Number.isSafeInteger(gate.durationMs) ||
      gate.durationMs < 0 ||
      !isNonEmptyString(gate.summary, MAX_GATE_SUMMARY_BYTES) ||
      Buffer.byteLength(gate.summary) > MAX_GATE_SUMMARY_BYTES ||
      (gate.testCount !== undefined &&
        (!Number.isSafeInteger(gate.testCount) || gate.testCount < 0))
    ) {
      throw new AgentWorkflowError(
        msg('gates.reportEntry'),
        {
          code: 'INVALID_GATE_REPORT',
          stage: 'checks',
        },
      );
    }
    names.add(gate.name);
  }
  return report;
}

const ANALYSIS_PRE_REVIEW_CHECKS = Object.freeze([
  'GIT_BRANCH_HEAD_UNCHANGED',
  'GIT_INDEX_UNCHANGED',
  'WORKING_TREE_UNCHANGED',
  'NO_NEW_SECRETS',
  'DEPENDENCY_INPUTS_UNCHANGED',
  'DEPENDENCY_METADATA_UNCHANGED',
  'COREPACK_CACHE_UNCHANGED',
  'ANALYSIS_ARTIFACT_COMPLETE',
  'ANALYSIS_ARTIFACT_INTEGRITY',
]);
const ANALYSIS_POST_REVIEW_CHECKS = Object.freeze([
  ...ANALYSIS_PRE_REVIEW_CHECKS,
  'REVIEW_PACKAGE_INTEGRITY',
  'REVIEWER_READ_ONLY',
  'REVIEW_CONFIRMATION_VERIFIED',
]);

function createAnalysisIntegrityReport({ postReview = false } = {}) {
  return {
    schemaVersion: 1,
    source: 'agent-review-loop-runner',
    mode: 'analysis',
    checks: (postReview
      ? ANALYSIS_POST_REVIEW_CHECKS
      : ANALYSIS_PRE_REVIEW_CHECKS
    ).map((name) => ({ name, status: 'PASS' })),
  };
}

function validateAnalysisIntegrityReport(report, { postReview = false } = {}) {
  const expected = postReview
    ? ANALYSIS_POST_REVIEW_CHECKS
    : ANALYSIS_PRE_REVIEW_CHECKS;
  if (
    !isPlainObject(report) ||
    Object.keys(report).length !== 4 ||
    report.schemaVersion !== 1 ||
    report.source !== 'agent-review-loop-runner' ||
    report.mode !== 'analysis' ||
    !Array.isArray(report.checks) ||
    report.checks.length !== expected.length ||
    report.checks.some(
      (check, index) =>
        !isPlainObject(check) ||
        Object.keys(check).length !== 2 ||
        check.name !== expected[index] ||
        check.status !== 'PASS',
    )
  ) {
    throw new AgentWorkflowError(
      msg('integrity.reportStructure'),
      { code: 'INVALID_ANALYSIS_INTEGRITY_REPORT', stage: 'analysis' },
    );
  }
  return report;
}

async function runChecks({
  runner,
  repositoryRoot,
  checks,
  profile,
  environment,
  dockerHost,
  verbose = false,
  onEvent = () => {},
  onResult = async () => {},
  afterEach = async () => {},
  monotonicNow = () => Number(process.hrtime.bigint()) / 1_000_000,
  platform = process.platform,
}) {
  const selectedProfile = resolveRunnerProfile(profile);
  const results = [];
  for (const name of checks) {
    assertNotCancelled(runner, 'checks');
    const definition = checkDefinition(selectedProfile, name);
    onEvent({
      type: 'stage:start',
      id: `gate:${name}`,
      badge: 'QUALITY GATES',
      label: name,
    });
    let result;
    let primaryError;
    const startedAt = monotonicNow();
    try {
      const checkEnvironment = { ...environment };
      delete checkEnvironment.DOCKER_HOST;
      if (platform === 'darwin' && definition.unsetCiOnDarwin) {
        delete checkEnvironment.CI;
      }
      if (definition.passDockerHost && dockerHost !== undefined) {
        checkEnvironment.DOCKER_HOST = dockerHost;
      }
      // The check name keeps the profile argv; pnpm always runs it as
      // [--filter package] run script.
      const args =
        definition.program === 'pnpm'
          ? pnpmRunArgv(definition.args)
          : definition.args;
      result = await runner.run(definition.program, args, {
        cwd: repositoryRoot,
        stage: 'checks',
        timeoutMs: definition.timeoutMs,
        streamOutput: verbose,
        liveOutput: verbose,
        env: checkEnvironment,
      });
    } catch (error) {
      primaryError = asWorkflowError(error);
      primaryError.report ??= [...results];
      onEvent({
        type: 'stage:end',
        id: `gate:${name}`,
        badge: 'QUALITY GATES',
        label: name,
        status: 'FAIL',
        durationMs: monotonicNow() - startedAt,
      });
    }
    if (result) {
      const checkReport = checkResultReport(
        name,
        result,
        monotonicNow() - startedAt,
      );
      results.push(checkReport);
      await onResult({ name, result, report: checkReport });
      onEvent({
        type: 'stage:end',
        id: `gate:${name}`,
        badge: 'QUALITY GATES',
        label: name,
        status:
          result.code === 0 && !result.timedOut && !result.signal
            ? 'PASS'
            : 'FAIL',
        durationMs: checkReport.durationMs,
        testCount: checkReport.testCount,
      });
      if (result.timedOut) {
        primaryError = new AgentWorkflowError(
          msg('check.timeout', { name }),
          { code: 'TIMEOUT', stage: 'checks', report: [...results] },
        );
      } else if (
        result.code === 130 ||
        ['SIGINT', 'SIGTERM'].includes(result.signal)
      ) {
        primaryError = new AgentWorkflowError(
          msg('check.signal', { name, signal: result.signal ?? 'SIGINT' }),
          { code: 'INTERRUPTED', stage: 'checks', report: [...results] },
        );
      } else if (result.code !== 0) {
        primaryError = new AgentWorkflowError(
          msg('check.failed', { name, detail: conciseProcessFailure(result) }),
          { code: 'CHECK_FAILED', stage: 'checks', report: [...results] },
        );
      }
    }

    let integrityError;
    try {
      await afterEach({ name, result, results: [...results] });
    } catch (error) {
      integrityError = error;
    }
    if (primaryError) {
      throw integrityError
        ? appendIntegrityViolation(primaryError, integrityError)
        : primaryError;
    }
    if (integrityError) throw integrityError;
  }
  return results;
}

async function assertQaStateUnchanged({
  runner,
  repositoryRoot,
  branch,
  head,
  dependencyMetadata,
  dependencyInputs,
  repositoryManifest,
  cache,
  stage = 'checks',
}) {
  const failures = [];
  const capture = async (assertion) => {
    try {
      await assertion();
    } catch (error) {
      failures.push(error);
    }
  };
  await capture(() =>
    assertDependencyMetadataUnchanged({
      repositoryRoot,
      baseline: dependencyMetadata,
      stage,
    }),
  );
  await capture(() =>
    assertDependencyInputsUnchanged({
      runner,
      repositoryRoot,
      baseline: dependencyInputs,
      stage,
    }),
  );
  await capture(() => assertPreparedCorepackCacheUnchanged({ cache, stage }));
  await capture(() =>
    assertGitIdentityStable({
      runner,
      cwd: repositoryRoot,
      branch,
      head,
      stage,
    }),
  );
  await capture(async () => {
    const currentManifest = await readRepositoryManifest({
      runner,
      cwd: repositoryRoot,
      stage,
    });
    if (currentManifest.hash !== repositoryManifest.hash) {
      throw new AgentWorkflowError(
        msg('check.treeChanged'),
        { code: 'WORKING_TREE_CHANGED', stage },
      );
    }
  });
  if (failures.length > 0) {
    let error = failures[0];
    for (const additional of failures.slice(1)) {
      error = appendIntegrityViolation(error, additional);
    }
    throw error;
  }
}

async function assertPostCodexStateUnchanged({
  runner,
  repositoryRoot,
  branch,
  head,
  dependencyMetadata,
  dependencyInputs,
  secretBaseline,
  implementerState,
  coreGitIndex,
}) {
  const failures = [];
  const capture = async (assertion) => {
    try {
      await assertion();
    } catch (error) {
      failures.push(error);
    }
  };
  // First, so that the CLI's empty scratch directories are gone before the
  // working tree is inspected. A failure stops at once: after a change in
  // the Git directory the core runs no further Git command.
  if (implementerState)
    await assertImplementerStateUnchanged({
      runner,
      repositoryRoot,
      baseline: implementerState,
      stage: 'post-codex',
    });
  if (coreGitIndex)
    await refreshCoreGitIndex({
      state: coreGitIndex,
      runner,
      cwd: repositoryRoot,
      stage: 'post-codex',
    });
  await capture(() =>
    assertGitIdentityStable({
      runner,
      cwd: repositoryRoot,
      branch,
      head,
      stage: 'post-codex',
    }),
  );
  await capture(() =>
    assertDependencyMetadataUnchanged({
      repositoryRoot,
      baseline: dependencyMetadata,
      stage: 'post-codex',
    }),
  );
  await capture(() =>
    assertDependencyInputsUnchanged({
      runner,
      repositoryRoot,
      baseline: dependencyInputs,
      stage: 'post-codex',
    }),
  );
  await capture(() =>
    assertNoNewSecrets({
      runner,
      cwd: repositoryRoot,
      baseline: secretBaseline,
      stage: 'post-codex',
    }),
  );
  if (failures.length > 0) {
    let error = failures[0];
    for (const additional of failures.slice(1)) {
      error = appendIntegrityViolation(error, additional);
    }
    throw error;
  }
}

// The raw round report from an adapter's stdout output; empty without one
// or when the module returns anything but { value } or { text: string }.
function implementerStdoutReport(output) {
  if (!output || typeof output !== 'object') return '';
  const text = Object.hasOwn(output, 'value')
    ? JSON.stringify(output.value)
    : output.text;
  return typeof text === 'string' ? text : '';
}

// Tool calls the implementer CLI denied, for the round report: redacted and
// bounded like other saved outputs; null when the CLI reported none.
const MAX_PERMISSION_DENIALS = 20;
const MAX_PERMISSION_DENIAL_INPUT_CHARACTERS = 500;

function reportPermissionDenials(denials) {
  if (!Array.isArray(denials)) return null;
  const bounded = (value, limit) => {
    const text = redactSensitive(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  return {
    count: denials.length,
    entries: denials.slice(0, MAX_PERMISSION_DENIALS).map((denial) => ({
      toolName: bounded(String(denial?.toolName ?? ''), 100),
      toolInput: bounded(
        JSON.stringify(denial?.toolInput ?? null) ?? 'null',
        MAX_PERMISSION_DENIAL_INPUT_CHARACTERS,
      ),
    })),
  };
}

async function runCodexRound({
  runner,
  repositoryRoot,
  runDirectory,
  tempRoot,
  gitPath,
  pnpmPath,
  corepackPath,
  task,
  checks,
  profile,
  round,
  findings,
  sessionId,
  taskMode = DEFAULT_TASK_MODE,
  codexModel,
  solEffort,
  timeoutMs,
  environment,
  verbose = false,
  onActivity = () => {},
}) {
  const selectedTaskMode = resolveTaskMode(taskMode);
  const { implementer, checkSets } = resolveRunnerProfile(profile);
  const adapter = roleProvider(implementer, 'implementer');
  const selectedCodexModel = resolveCodexModel(
    codexModel === undefined ? implementer.model : codexModel,
  );
  // The module's own model rule applies as well (for codex and claude it is
  // the core rule above).
  if (!isProviderModel(adapter, selectedCodexModel)) {
    throw new AgentWorkflowError(
      msg('config.modelUnsupported', {
        model: JSON.stringify(selectedCodexModel),
        provider: adapter.id,
      }),
      { code: 'INVALID_CODEX_MODEL', stage: 'preflight' },
    );
  }
  const selectedSolEffort = resolveSolEffort(
    solEffort === undefined ? implementer.effort : solEffort,
    implementer.allowedEfforts,
  );
  assertProviderTaskMode(adapter, 'implementer', selectedTaskMode);
  const schemaPath = join(runDirectory, 'codex-output-schema.json');
  const outputPath = join(runDirectory, `round-${round}-codex.json`);
  await saveJson(schemaPath, codexSchema(selectedTaskMode));
  const guardBin = await createAgentCommandGuards({
    directory: tempRoot,
    gitPath,
    pnpmPath: pnpmPath ?? (await findExecutable('pnpm')),
    corepackPath: corepackPath ?? (await findExecutable('corepack')),
    checks: checks ?? task.checks ?? checkSets.base,
    profile,
  });
  if (
    !environment?.COREPACK_HOME ||
    environment.COREPACK_ENABLE_NETWORK !== '0' ||
    !environment.NPM_CONFIG_USERCONFIG
  ) {
    throw new AgentWorkflowError(
      msg('writer.offlineConfig'),
      { code: 'INVALID_CODEX_ENVIRONMENT', stage: 'preflight' },
    );
  }
  // The module builds the environment and argv; the core checks both
  // before the process starts.
  const env = providerEnvironment(
    adapter,
    'implementer',
    environment,
    guardBin,
    'codex',
  );
  const outputSchema = codexSchema(selectedTaskMode);
  // Every provider resumes only a session ID that meets the core's rule
  // (isValidSessionId); for a module from a profile the argv check covers
  // that ID as well, the built-in providers pass it as an exempt value.
  const builtin = isBuiltinProvider(adapter);
  if (sessionId !== undefined && !isValidSessionId(sessionId)) {
    throw new AgentWorkflowError(msg('writer.sessionId'), {
      code: 'INVALID_AGENT_OUTPUT',
      stage: 'codex',
    });
  }
  const command = providerArgs(
    adapter,
    'implementer',
    {
      taskMode: selectedTaskMode,
      model: selectedCodexModel,
      effort: selectedSolEffort,
      repositoryRoot,
      schemaPath,
      outputPath,
      outputSchema,
      sessionId,
    },
    [
      selectedCodexModel,
      repositoryRoot,
      schemaPath,
      outputPath,
      JSON.stringify(outputSchema),
      ...(builtin ? [sessionId] : []),
    ],
    'codex',
  );
  const activity = createCodexActivityParser(onActivity);
  let result;
  try {
    result = await requiredRun(
      runner,
      adapter.program,
      command,
      {
        cwd: repositoryRoot,
        env,
        input: codexPrompt({
          task,
          round,
          findings,
          taskMode: selectedTaskMode,
          codexModel: selectedCodexModel,
        }),
        timeoutMs,
        stage: 'codex',
        onActivityChunk: activity.push,
        exactStdoutLimitBytes: MAX_AGENT_STRUCTURED_BYTES,
        streamOutput: verbose,
        liveOutput: verbose,
        // Best effort: processes left in the CLI's group, and those of other
        // groups the process watch saw, do not outlive it (a survivor or an
        // unreadable process table is IMPLEMENTER_PROCESS_SURVIVED); one that
        // escaped between two readings can (known limit, the checks after the gates detect its
        // later Git changes up to the final report).
        ...(implementerStateChecks(adapter).gitDirectoryWritable
          ? { killProcessGroupOnExit: true }
          : {}),
      },
      msg('writer.roundFailed'),
    );
  } catch (error) {
    await saveJson(outputPath, { status: 'PROCESS_FAILED' }).catch(() => {});
    throw error;
  } finally {
    activity.end();
  }
  // An adapter with output() returns the result on stdout; codex writes the
  // output file.
  const rawReport = adapter.implementer.output
    ? implementerStdoutReport(adapter.implementer.output(result.stdout))
    : await readFile(outputPath, 'utf8').catch(() => '');
  if (!rawReport.trim()) {
    throw new AgentWorkflowError(msg('writer.noResult'), {
      code: 'INVALID_AGENT_OUTPUT',
      stage: 'codex',
    });
  }
  await saveJson(outputPath, { status: 'RECEIVED_PENDING_VALIDATION' });
  const report = validateCodexReport(
    parseJson(rawReport.trim(), 'Codex', 'codex'),
    findings,
    selectedTaskMode,
  );
  if (selectedTaskMode === 'analysis') {
    const boundedReport = { ...report };
    delete boundedReport.fullAnalysis;
    await saveJson(outputPath, {
      ...boundedReport,
      analysisArtifact: { status: 'VALIDATED_PENDING_WRITE' },
    });
  } else {
    await saveJson(outputPath, report);
  }
  // A session ID meets isValidSessionId, for every provider. A resumed round
  // of a provider that declares resumeKeepsSessionId, and of every module
  // from a profile, must report the session it resumed.
  const resolvedSession =
    sessionId ?? adapter.implementer.sessionId(result.stdout);
  if (
    !isValidSessionId(resolvedSession) ||
    (sessionId &&
      (adapter.implementer.resumeKeepsSessionId ||
        !isBuiltinProvider(adapter)) &&
      adapter.implementer.sessionId(result.stdout) !== sessionId)
  ) {
    throw new AgentWorkflowError(msg('writer.sessionId'), {
      code: 'INVALID_AGENT_OUTPUT',
      stage: 'codex',
    });
  }
  return {
    report,
    sessionId: resolvedSession,
    stdout: saveableLog(result.stdout),
    stderr: saveableLog(result.stderr),
    ...(adapter.implementer.permissionDenials
      ? {
          permissionDenials: reportPermissionDenials(
            adapter.implementer.permissionDenials(result.stdout),
          ),
        }
      : {}),
  };
}

async function runClaudeReview({
  runner,
  task,
  snapshot,
  taskMode = DEFAULT_TASK_MODE,
  model = REVIEW_PROFILES.critical[0].model,
  effort = REVIEW_PROFILES.critical[0].effort,
  provider = DEFAULT_REVIEWER.provider,
  // A provider module from the profile (runClaudeReviewWithPolicy passes it
  // only for providers that are not built in).
  providerModule,
  timeoutMs,
  verbose = false,
}) {
  const selectedTaskMode = resolveTaskMode(taskMode);
  // Only a validated reviewer module named by provider is accepted; anything
  // else is INVALID_CONFIGURATION (roleProvider of no section).
  const adapter =
    providerModule === undefined
      ? roleProvider({ provider }, 'reviewer')
      : isValidatedProviderModule(providerModule) &&
          providerModule.id === provider &&
          providerModule.roles.includes('reviewer')
        ? providerModule
        : roleProvider(undefined, 'reviewer');
  assertProviderTaskMode(adapter, 'reviewer', selectedTaskMode);
  // The profile validated the model; checked again because the argv check
  // below does not inspect it.
  if (!isProviderModel(adapter, model)) {
    throw new AgentWorkflowError(
      msg('reviewer.invalidModel', {
        model: JSON.stringify(String(model)).slice(0, 140),
      }),
      { code: 'INVALID_CONFIGURATION', stage: 'claude' },
    );
  }
  // The module builds the argv and environment; the core checks both before
  // the process starts.
  const outputSchema = claudeSchema(selectedTaskMode);
  const args = providerArgs(
    adapter,
    'reviewer',
    { model, effort, outputSchema },
    [model, JSON.stringify(outputSchema)],
    'claude',
  );
  const result = await safeRun(
    runner,
    adapter.program,
    args,
    {
      cwd: snapshot.root,
      env: providerEnvironment(
        adapter,
        'reviewer',
        safeAgentEnvironment(),
        undefined,
        'claude',
      ),
      input: claudePrompt({
        task,
        taskMode: selectedTaskMode,
        instructionsPath: snapshot.instructionsPath,
        diffPath: snapshot.diffPath,
        gatesPath: snapshot.gatesPath,
        correctionContextPath: snapshot.correctionContextPath,
        originalTaskPath: snapshot.originalTaskPath,
        manifestPath: snapshot.manifestPath,
        analysisArtifactPath: snapshot.analysisArtifactPath,
        integrityPath: snapshot.integrityPath,
        expectedConfirmation: snapshot.expectedConfirmation,
      }),
      timeoutMs,
      stage: 'claude',
      exactStdoutLimitBytes: MAX_AGENT_STRUCTURED_BYTES,
      streamOutput: verbose,
      liveOutput: verbose,
    },
    msg('reviewer.reviewFailed'),
  );
  if (result.code !== 0) {
    throw new AgentWorkflowError(`${msg('reviewer.reviewFailed')}.`, {
      code: 'CLAUDE_PROCESS_FAILED',
      stage: 'claude',
      diagnostic: result,
    });
  }
  return {
    review: parseClaudeOutput(
      result.stdout,
      {
        taskMode: selectedTaskMode,
        expectedConfirmation: snapshot.expectedConfirmation,
        analysisHeadings: snapshot.analysisHeadings,
      },
      adapter,
    ),
    stdout: saveableLog(result.stdout),
    stderr: saveableLog(result.stderr),
  };
}

// profile: review profile name; reviewer: resolved reviewer section of the
// runner profile. Each attempt also receives the reviewer provider.
async function runClaudeReviewWithPolicy({
  profile,
  reviewer = DEFAULT_REVIEWER,
  reviewAttempt = runClaudeReview,
  beforeAttempt = async () => {},
  afterAttempt = async () => {},
  onAttemptStart = () => {},
  onAttemptEnd = () => {},
  ...options
}) {
  const policy = resolveReviewProfile(profile, reviewer);
  const adapter = roleProvider(reviewer, 'reviewer');
  // Built-in providers are found by name, as before; a module from the
  // profile goes with each attempt.
  const attemptProvider = isBuiltinProvider(adapter)
    ? {}
    : { providerModule: adapter };
  const execution = {
    profile: policy.profile,
    fallbackAllowed: policy.fallbackAllowed,
    attempts: [],
    completed: null,
    fallbackUsed: false,
    fallbackReason: null,
    attemptCount: 0,
  };

  for (let index = 0; index < policy.attempts.length; index += 1) {
    const requested = policy.attempts[index];
    const attemptNumber = index + 1;
    const attempt = {
      attempt: attemptNumber,
      requestedModel: requested.model,
      requestedEffort: requested.effort,
      status: 'STARTED',
    };
    try {
      await beforeAttempt({ ...attempt });
    } catch (error) {
      const failure = asWorkflowError(
        error,
        'INTEGRITY_CHECK_FAILED',
        'claude',
      );
      failure.reviewExecution = execution;
      throw failure;
    }
    execution.attempts.push(attempt);
    execution.attemptCount = execution.attempts.length;
    if (index > 0) execution.fallbackUsed = true;
    onAttemptStart({ ...attempt });
    let result;
    let failure;
    try {
      result = await reviewAttempt({
        ...options,
        model: requested.model,
        effort: requested.effort,
        provider: reviewer.provider,
        ...attemptProvider,
      });
    } catch (error) {
      failure = asWorkflowError(error, 'CLAUDE_REVIEW_FAILED', 'claude');
    }
    try {
      await afterAttempt({ ...attempt });
    } catch (integrityError) {
      failure = failure
        ? appendIntegrityViolation(failure, integrityError)
        : asWorkflowError(integrityError, 'INTEGRITY_CHECK_FAILED', 'claude');
    }

    if (!failure) {
      attempt.status = 'COMPLETED';
      execution.completed = {
        model: requested.model,
        effort: requested.effort,
      };
      onAttemptEnd({ ...attempt });
      return { ...result, execution };
    }

    const fallbackReason =
      policy.fallbackAllowed && index === 0 && policy.attempts.length === 2
        ? classifyClaudeFallbackReason(failure, adapter)
        : undefined;
    attempt.status = fallbackReason ? 'FALLBACK_ELIGIBLE' : 'FAILED';
    attempt.failureCode = fallbackReason ?? failure.code;
    onAttemptEnd({ ...attempt });
    if (fallbackReason) {
      execution.fallbackReason = fallbackReason;
      continue;
    }
    failure.reviewExecution = execution;
    throw failure;
  }

  const error = new AgentWorkflowError(
    msg('reviewer.fallbackFailed'),
    { code: 'CLAUDE_FALLBACK_FAILED', stage: 'claude' },
  );
  error.reviewExecution = execution;
  throw error;
}

// The fields codex*, claude* and the version keys codex and claude are aliases
// of the neutral implementer and reviewer fields.
async function environmentReport({
  runner,
  cwd,
  reviewProfile,
  codexModel,
  solEffort,
  independentReviewRequired = true,
  implementer = DEFAULT_IMPLEMENTER,
  reviewer = DEFAULT_REVIEWER,
  platform = process.platform,
}) {
  const version = async (adapter) => {
    const result = await requiredRun(
      runner,
      adapter.program,
      [...adapter.versionArgs],
      { cwd, stage: 'preflight', timeoutMs: 15_000 },
      msg('preflight.versionUnreadable', {
        command: [adapter.program, ...adapter.versionArgs].join(' '),
      }),
    );
    return result.stdout.trim() || result.stderr.trim();
  };
  const writer = roleProvider(implementer, 'implementer');
  const codex = await version(writer);
  // The module may refuse a host where it cannot keep its guarantees. Any
  // result other than undefined, or an exception, refuses the host.
  let refusal;
  try {
    refusal = writer.implementer.preflight({ version: codex, platform });
  } catch {
    refusal = 'PREFLIGHT_ERROR';
  }
  if (refusal !== undefined) {
    throw new AgentWorkflowError(
      refusal === 'UNSUPPORTED_VERSION'
        ? msg('preflight.unsupportedVersion', {
            program: writer.program,
            version: redactSensitive(codex).slice(0, 80),
          })
        : refusal === 'UNSUPPORTED_PLATFORM'
          ? msg('preflight.unsupportedPlatform', {
              platform,
              program: writer.program,
            })
          : msg('preflight.refused', { id: writer.id }),
      { code: 'IMPLEMENTER_PREFLIGHT_FAILED', stage: 'preflight' },
    );
  }
  const claude = independentReviewRequired
    ? await version(roleProvider(reviewer, 'reviewer'))
    : null;
  const policy = resolveReviewProfile(reviewProfile, reviewer);
  const plannedAttempts = (
    independentReviewRequired ? policy.attempts : []
  ).map(({ model, effort }) => ({
    model,
    effort,
  }));
  const fallbackAllowed = independentReviewRequired && policy.fallbackAllowed;
  return {
    codex,
    ...(claude !== null ? { claude } : { independentReview: 'NOT_REQUIRED' }),
    codexModel,
    codexReasoning: solEffort,
    claudeReviewProfile: independentReviewRequired ? policy.profile : null,
    claudeAttemptCount: plannedAttempts.length,
    claudeFallbackAllowed: fallbackAllowed,
    claudeAttempts: plannedAttempts,
    implementer: {
      provider: implementer.provider,
      version: codex,
      model: codexModel,
      effort: solEffort,
    },
    reviewer: {
      provider: reviewer.provider,
      version: claude,
      profile: independentReviewRequired ? policy.profile : null,
      plannedAttemptCount: plannedAttempts.length,
      fallbackAllowed,
      plannedAttempts,
    },
  };
}

// Neutral implementer field of the report; report.sol is its alias with
// plannedModel = model and plannedEffort = effort.
function buildImplementerAudit(provider, sol) {
  return {
    provider,
    model: sol.plannedModel,
    effort: sol.plannedEffort,
    effectiveModel: sol.effectiveModel,
    effectiveEffort: sol.effectiveEffort,
    attemptCount: sol.runs.length,
    runs: sol.runs,
  };
}

// Neutral reviewer field of the report: a summary of report.review. model
// and effort are the first planned attempt, attemptCount the attempts run.
function buildReviewerAudit(provider, review) {
  const [planned] = review.plannedAttempts ?? [];
  return {
    provider,
    profile: review.profile ?? null,
    model: planned?.model ?? null,
    effort: planned?.effort ?? null,
    effectiveModel: review.effectiveModel ?? null,
    effectiveEffort: review.effectiveEffort ?? null,
    attemptCount: review.attemptCount,
  };
}

function buildSolAudit(effort, runs, model = CODEX_MODEL) {
  const completed = [...runs]
    .reverse()
    .find(({ status }) => status === 'COMPLETED')?.completed;
  return {
    plannedModel: model,
    plannedEffort: effort,
    effectiveModel: completed?.model ?? null,
    effectiveEffort: completed?.effort ?? null,
    runs,
  };
}

function latestResponseByFindingId(responses) {
  const values = new Map();
  for (const response of responses) {
    values.set(response.findingId, response);
  }
  return values;
}

function buildFindingReport({ history, responses, latest, pending }) {
  const unresolvedById = new Map(
    [...pending, ...latest]
      .filter(({ severity }) => UNRESOLVED_FINDING_SEVERITIES.has(severity))
      .map((finding) => [finding.findingId, finding]),
  );
  const latestResponses = latestResponseByFindingId(responses);
  const withFinding = ([findingId, response]) => ({
    findingId,
    finding: history.get(findingId),
    response,
  });
  const wrapFinding = (finding) => ({
    findingId: finding.findingId,
    finding,
    response: latestResponses.get(finding.findingId) ?? null,
  });
  const unresolved = [...unresolvedById.values()].map(wrapFinding);
  const categorizedIds = new Set(unresolved.map(({ findingId }) => findingId));
  const closedAfterConfirmed = [];
  const rejectedByCodex = [];
  for (const entry of latestResponses) {
    const [findingId, response] = entry;
    if (categorizedIds.has(findingId)) continue;
    if (response.status === 'CONFIRMED') {
      closedAfterConfirmed.push(withFinding(entry));
      categorizedIds.add(findingId);
    } else if (response.status === 'REJECTED') {
      rejectedByCodex.push(withFinding(entry));
      categorizedIds.add(findingId);
    } else {
      const finding = history.get(findingId);
      if (finding) {
        unresolved.push(wrapFinding(finding));
        categorizedIds.add(findingId);
      }
    }
  }
  return {
    closedAfterConfirmed,
    rejectedByCodex,
    unresolved,
  };
}

function buildFindingPolicy(findings) {
  const threshold = Object.fromEntries(
    FINDING_SEVERITIES.map((severity) => [severity, 0]),
  );
  const unresolved = Object.fromEntries(
    FINDING_SEVERITIES.map((severity) => [severity, 0]),
  );
  for (const entry of findings.unresolved) {
    unresolved[entry.finding.severity] += 1;
  }
  return {
    name: 'ZERO_FINDINGS',
    threshold,
    unresolved,
    satisfied: FINDING_SEVERITIES.every(
      (severity) => unresolved[severity] === threshold[severity],
    ),
  };
}

// The report adds rejectedByImplementer, the neutral name of rejectedByCodex
// (the same entries, so the categories are not disjoint across both names).
function buildFindingState(options) {
  const findings = buildFindingReport(options);
  return {
    findings: {
      ...findings,
      rejectedByImplementer: findings.rejectedByCodex,
    },
    findingPolicy: buildFindingPolicy(findings),
  };
}

function buildReviewAudit(profile, runs, reviewer = DEFAULT_REVIEWER) {
  const policy =
    typeof profile === 'string' && Object.hasOwn(reviewer.profiles, profile)
      ? resolveReviewProfile(profile, reviewer)
      : { attempts: [], fallbackAllowed: false };
  const completed = runs.at(-1)?.completed;
  return {
    profile,
    plannedAttempts: policy.attempts.map(({ model, effort }) => ({
      model,
      effort,
    })),
    plannedAttemptCount: policy.attempts.length,
    fallbackAllowed: policy.fallbackAllowed,
    attemptCount: runs.reduce(
      (total, execution) => total + execution.attemptCount,
      0,
    ),
    fallbackUsed: runs.some((execution) => execution.fallbackUsed),
    fallbackReasons: [
      ...new Set(
        runs.map((execution) => execution.fallbackReason).filter(Boolean),
      ),
    ],
    effectiveModel: completed?.model ?? null,
    effectiveEffort: completed?.effort ?? null,
    runs,
  };
}

// Project profile of the ringi command: ringi.config.mjs at the root of the
// repository, the only place it is read from. The profile is code the
// runner executes, in a repository the writer edits, so it is loaded once,
// before the first round, and the SHA-256 of every module of its graph is
// recorded; runAgentReviewLoop compares them again (PROFILE_MODIFIED).
// Module hooks keep the graph closed and fingerprinted:
// - a profile module imports Node.js built-ins or relative paths ('./',
//   '../') only; package names, subpath imports ('#'), absolute paths, URLs,
//   queries and fragments are refused;
// - require (createRequire) of anything but a built-in is refused;
// - the path an import names must be the path Node.js resolves, and the
//   file must have that exact name on disk (native realpath), so a symbolic
//   link or another letter case is refused;
// - a module is an ES module or JSON file inside the repository, or a
//   module of the running runner installation (runner code, loaded once like
//   the runner itself, not fingerprinted); anything else is refused;
// - no other file inside the repository is loaded as a module, during the
//   load or after it, whoever imports or requires it (only the runner
//   installation is exempt);
// - Node.js evaluates exactly the bytes that were hashed (the load hook reads
//   the file once and returns those bytes);
// - a refused or failed import while the profile loads fails the load, also
//   when the profile catches the error (an optional import of a file the
//   writer could create later is refused);
// - each load tags its URLs with its own query, so no module of an earlier
//   load is reused, and after the load the profile's modules may import
//   built-ins only: a lazy import of a file the writer changed is refused.
// Not covered: files a profile reads by other means than import or require
// (fs, child_process, vm) and code it starts in a Worker thread, which does
// not run these hooks.
const PROJECT_PROFILE_FILE = 'ringi.config.mjs';
const MAX_PROJECT_PROFILE_MODULES = 64;
const MAX_PROJECT_PROFILE_BYTES = 4 * 1024 * 1024;
const PROJECT_PROFILE_FORMATS = new Set(['module', 'json']);
const PROJECT_PROFILES = new WeakMap();
// Tagged URLs of every load in this process: the hooks of one load pass
// the modules of another load of the same repository on.
const PROJECT_PROFILE_MODULE_URLS = new Set();
const RUNNER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

// The runner's own files: every module of the import graph of
// bin/ringi.mjs and scripts/agent-review-loop.mjs in the runner
// installation (an entry point that does not exist is skipped, the graph
// must reach this module). A runner installed inside the repository it works on (for
// example node_modules/ringi-gate) is a file the writer can change, so the
// SHA-256 of each module is recorded when this module loads, and
// runAgentReviewLoop compares them again at the profile's check points
// (RUNNER_MODIFIED). A file that is not a regular file, is reached through
// a symbolic link or another letter case, or cannot be read fails the
// fingerprint. Only static import and export declarations with a relative
// path or a Node.js built-in are followed; any other specifier fails it. A
// change made before the runner started is not detected (the fingerprint
// starts from the files as they are).
const RUNNER_ENTRY_POINTS = ['bin/ringi.mjs', 'scripts/agent-review-loop.mjs'];
const RUNNER_LIBRARY = 'scripts/agent-review-loop-lib.mjs';
const MAX_RUNNER_FILES = 128;
const MAX_RUNNER_BYTES = 16 * 1024 * 1024;
const RUNNER_IMPORT_PATTERN =
  /^(?:import|export)\s+(?:[^'";=(]*?\s+from\s+)?['"]([^'"\n]+)['"]/gmu;
const RUNNER_FINGERPRINTS = new WeakMap();

// lstat before open: a FIFO, device or socket is refused without opening
// it; O_NONBLOCK keeps an open of one swapped in meanwhile from blocking.
function readRunnerFileSync(absolute) {
  if (!lstatSync(absolute).isFile()) throw new Error('not a regular file');
  if (realpathSync.native(absolute) !== absolute)
    throw new Error('another name on disk');
  const descriptor = openSync(
    absolute,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('not a regular file');
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readRunnerFingerprint(runnerRoot = RUNNER_ROOT) {
  const root = realpathSync.native(runnerRoot);
  const files = new Map();
  // An entry point that does not exist is skipped (a copy of scripts/ only,
  // the earlier way to use the runner); the graph must still reach this
  // module.
  const pending = RUNNER_ENTRY_POINTS.filter(
    (path) => lstatSync(join(root, ...path.split('/')), { throwIfNoEntry: false }) !== undefined,
  );
  let totalBytes = 0;
  while (pending.length > 0) {
    const path = pending.shift();
    if (files.has(path)) continue;
    if (files.size >= MAX_RUNNER_FILES)
      throw new Error(`more than ${MAX_RUNNER_FILES} runner modules`);
    const absolute = join(root, ...path.split('/'));
    let bytes;
    try {
      bytes = readRunnerFileSync(absolute);
    } catch (error) {
      throw new Error(
        `${path} is not a readable regular file with exactly this name (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_RUNNER_BYTES)
      throw new Error(`the runner modules exceed ${MAX_RUNNER_BYTES} bytes`);
    files.set(path, { path, absolute, sha256: sha256Hex(bytes) });
    for (const [, specifier] of bytes
      .toString('utf8')
      .matchAll(RUNNER_IMPORT_PATTERN)) {
      if (nodeModule.isBuiltin(specifier)) continue;
      const target = posix.normalize(
        posix.join(posix.dirname(path), specifier),
      );
      if (
        !/^\.\.?\//.test(specifier) ||
        /[?#\\]/.test(specifier) ||
        target === '..' ||
        target.startsWith('../')
      ) {
        throw new Error(
          `${path} imports ${JSON.stringify(specifier)}, which is not a module of the runner installation`,
        );
      }
      pending.push(target);
    }
  }
  if (!files.has(RUNNER_LIBRARY))
    throw new Error(`no entry point of the runner imports ${RUNNER_LIBRARY}`);
  const sorted = [...files.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const publicFiles = sorted.map(({ path, sha256 }) =>
    Object.freeze({ path, sha256 }),
  );
  const fingerprint = Object.freeze({
    sha256: sha256Hex(JSON.stringify(publicFiles)),
    files: Object.freeze(publicFiles),
  });
  RUNNER_FINGERPRINTS.set(fingerprint, sorted);
  return fingerprint;
}

// The fingerprint of this process's runner, taken when this module loads;
// failure: why it could not be taken (the run stops with RUNNER_MODIFIED).
const RUNNER_FINGERPRINT = (() => {
  try {
    return { fingerprint: readRunnerFingerprint() };
  } catch (error) {
    return {
      failure: error instanceof Error ? error.message : String(error),
    };
  }
})();

// Every runner module must still be the same regular file with the same
// SHA-256; a fingerprint that was not taken (or not by
// readRunnerFingerprint) fails the check.
function assertRunnerUnchanged(fingerprint, stage, failure = undefined) {
  const files = RUNNER_FINGERPRINTS.get(fingerprint);
  const stop = (message) =>
    new AgentWorkflowError(redactSensitive(message).slice(0, 1_000), {
      code: 'RUNNER_MODIFIED',
      stage,
      resume: msg('runner.modifiedResume'),
    });
  if (!files) {
    throw stop(
      msg('runner.unverifiable', {
        detail: failure ?? 'no fingerprint of the runner files',
      }),
    );
  }
  const changed = [];
  for (const file of files) {
    let unchanged = false;
    try {
      unchanged = sha256Hex(readRunnerFileSync(file.absolute)) === file.sha256;
    } catch {
      unchanged = false;
    }
    if (!unchanged) changed.push(file.path);
  }
  if (changed.length > 0) {
    throw stop(
      msg('runner.modified', {
        files: changed.map((path) => JSON.stringify(path)).join(', '),
      }),
    );
  }
}

export async function loadProjectProfile({ repositoryRoot }) {
  const invalid = (message) =>
    new AgentWorkflowError(redactSensitive(message).slice(0, 1_000), {
      code: 'INVALID_CONFIGURATION',
      stage: 'preflight',
    });
  if (typeof nodeModule.registerHooks !== 'function') {
    throw invalid(
      `Loading ${PROJECT_PROFILE_FILE} requires module.registerHooks (Node.js 24 or newer).`,
    );
  }
  const root = await realpath(repositoryRoot);
  const runnerRoot = await realpath(RUNNER_ROOT);
  const entry = join(root, PROJECT_PROFILE_FILE);
  const metadata = await lstat(entry).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) {
    throw invalid(
      `${PROJECT_PROFILE_FILE} not found at the repository root. Run \`ringi init\` to create it.`,
    );
  }
  if (!metadata.isFile()) {
    throw invalid(
      `${PROJECT_PROFILE_FILE} must be a regular file, not a symbolic link or a directory.`,
    );
  }
  if ((await realpath(entry)) !== entry) {
    throw invalid(
      `The profile file must be named exactly ${PROJECT_PROFILE_FILE} (letter case).`,
    );
  }
  const loadId = randomBytes(8).toString('hex');
  const tag = (url) => `${url}?ringi-profile=${loadId}`;
  const entryUrl = tag(pathToFileURL(entry).href);
  const label = (url) =>
    relative(root, fileURLToPath(url)).split(sep).join('/');
  // graph: URLs of the profile's modules inside the repository, graphPaths:
  // their paths; modules: those already loaded, with their path and
  // SHA-256; failures: refusals and failed imports while the profile loads.
  const graph = new Set([entryUrl]);
  const graphPaths = new Set([entry]);
  PROJECT_PROFILE_MODULE_URLS.add(entryUrl);
  const modules = new Map();
  const failures = [];
  let sealed = false;
  let totalBytes = 0;
  const refuse = (message) => {
    const error = invalid(message);
    if (!sealed) failures.push(error);
    return error;
  };
  // A file inside the repository that is not a module of the runner
  // installation (a checkout of ringi-core inside the repository is runner
  // code, as before).
  const repositoryFile = (url) => {
    if (typeof url !== 'string' || !url.startsWith('file:')) return false;
    const path = fileURLToPath(url);
    return (
      (path === root || pathIsInside(root, path)) &&
      !pathIsInside(runnerRoot, path)
    );
  };
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === entryUrl) {
        const result = nextResolve(specifier, context);
        if (!result.url.startsWith('file:') || fileURLToPath(result.url) !== entry)
          throw invalid(`${PROJECT_PROFILE_FILE} resolves to another file.`);
        return { ...result, url: entryUrl };
      }
      const parent = context.parentURL;
      if (!parent || !graph.has(parent)) {
        // A require from a profile module whose URL lost its tag.
        if (
          typeof parent === 'string' &&
          parent.startsWith('file:') &&
          !PROJECT_PROFILE_MODULE_URLS.has(parent) &&
          graphPaths.has(fileURLToPath(parent)) &&
          !nodeModule.isBuiltin(specifier)
        ) {
          throw refuse(
            `${label(parent)} requires ${JSON.stringify(specifier)}; profile modules load other modules with import only.`,
          );
        }
        return nextResolve(specifier, context);
      }
      if (nodeModule.isBuiltin(specifier)) return nextResolve(specifier, context);
      const importer = label(parent);
      if (sealed) {
        throw invalid(
          `${importer} imports ${JSON.stringify(specifier)} after ${PROJECT_PROFILE_FILE} was loaded; profile modules are loaded once, before the run.`,
        );
      }
      if (context.conditions?.includes('require')) {
        throw refuse(
          `${importer} requires ${JSON.stringify(specifier)}; profile modules load other modules with import only.`,
        );
      }
      if (!/^\.\.?\//.test(specifier) || /[?#\\]/.test(specifier)) {
        throw refuse(
          `${importer} imports ${JSON.stringify(specifier)}; profile modules may import Node.js built-ins and relative paths ('./', '../') only.`,
        );
      }
      const expected = fileURLToPath(new URL(specifier, parent));
      let result;
      try {
        result = nextResolve(specifier, context);
      } catch (error) {
        refuse(
          `${importer} imports ${JSON.stringify(specifier)}, which cannot be resolved; every import of a profile module must resolve, also one the profile catches.`,
        );
        throw error;
      }
      if (
        !result.url.startsWith('file:') ||
        fileURLToPath(result.url) !== expected
      ) {
        throw refuse(
          `${importer} imports ${JSON.stringify(specifier)}, which resolves to another path (symbolic link or letter case); symbolic links are refused.`,
        );
      }
      if (pathIsInside(root, expected)) {
        const url = tag(pathToFileURL(expected).href);
        graph.add(url);
        graphPaths.add(expected);
        PROJECT_PROFILE_MODULE_URLS.add(url);
        return { ...result, url };
      }
      if (pathIsInside(runnerRoot, expected)) return result;
      throw refuse(
        `${importer} imports ${JSON.stringify(specifier)} from outside the repository; only the repository and the runner installation are allowed.`,
      );
    },
    load(url, context, nextLoad) {
      if (!graph.has(url)) {
        // Another file of the repository, loaded by any other means
        // (require with another base, an earlier load's hooks): refused.
        if (repositoryFile(url) && !PROJECT_PROFILE_MODULE_URLS.has(url)) {
          throw refuse(
            `${label(url)} is loaded as a module but is not an import of ${PROJECT_PROFILE_FILE}; files of the repository are loaded only as fingerprinted profile modules.`,
          );
        }
        return nextLoad(url, context);
      }
      if (modules.has(url)) return nextLoad(url, context);
      const path = label(url);
      if (sealed) throw invalid(`${path} was loaded after ${PROJECT_PROFILE_FILE}.`);
      if (modules.size >= MAX_PROJECT_PROFILE_MODULES) {
        throw refuse(
          `${PROJECT_PROFILE_FILE} imports more than ${MAX_PROJECT_PROFILE_MODULES} modules.`,
        );
      }
      const absolute = fileURLToPath(url);
      let bytes;
      try {
        // lstat before open: a FIFO, device or socket is refused without
        // opening it; O_NONBLOCK keeps an open of one swapped in meanwhile
        // from blocking, and fstat refuses it.
        if (!lstatSync(absolute).isFile()) throw new Error('not a regular file');
        if (realpathSync.native(absolute) !== absolute)
          throw new Error('another name on disk');
        const descriptor = openSync(
          absolute,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
        try {
          if (!fstatSync(descriptor).isFile())
            throw new Error('not a regular file');
          bytes = readFileSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      } catch {
        throw refuse(
          `${path} is not a readable regular file with exactly this name (symbolic links and another letter case are refused).`,
        );
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_PROJECT_PROFILE_BYTES) {
        throw refuse(
          `The modules of ${PROJECT_PROFILE_FILE} exceed ${MAX_PROJECT_PROFILE_BYTES} bytes.`,
        );
      }
      // nextLoad only determines the format (it opens the file again,
      // without O_NONBLOCK: a FIFO swapped in after the read above would
      // block it); the bytes that run are those read and hashed above.
      let result;
      try {
        result = nextLoad(url, context);
      } catch (error) {
        // For example an unknown file extension: fails the load, also when
        // the profile catches the error.
        refuse(`${path} cannot be loaded as a module.`);
        throw error;
      }
      if (!PROJECT_PROFILE_FORMATS.has(result.format)) {
        throw refuse(`${path} must be an ES module or a JSON file.`);
      }
      modules.set(url, { path, absolute, sha256: sha256Hex(bytes) });
      return { format: result.format, source: bytes };
    },
  });
  let namespace;
  try {
    namespace = await import(entryUrl);
  } catch (error) {
    if (failures.length > 0) throw failures[0];
    if (error instanceof AgentWorkflowError) throw error;
    throw invalid(
      `${PROJECT_PROFILE_FILE} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    sealed = true;
  }
  if (failures.length > 0) throw failures[0];
  if (!modules.has(entryUrl)) {
    throw invalid(`${PROJECT_PROFILE_FILE} could not be fingerprinted.`);
  }
  const hasProfile = Object.hasOwn(namespace, 'PROFILE');
  const hasDefault = Object.hasOwn(namespace, 'default');
  if (!hasProfile && !hasDefault) {
    throw invalid(
      `${PROJECT_PROFILE_FILE} must export PROFILE or a default export.`,
    );
  }
  if (hasProfile && hasDefault && namespace.PROFILE !== namespace.default) {
    throw invalid(
      `${PROJECT_PROFILE_FILE} exports PROFILE and a different default export.`,
    );
  }
  const profile = hasProfile ? namespace.PROFILE : namespace.default;
  // The same validation as every other profile.
  resolveRunnerProfile(profile);
  const files = [...modules.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const publicFiles = files.map(({ path, sha256 }) =>
    Object.freeze({ path, sha256 }),
  );
  const projectProfile = Object.freeze({
    path: PROJECT_PROFILE_FILE,
    sha256: sha256Hex(JSON.stringify(publicFiles)),
    files: Object.freeze(publicFiles),
  });
  PROJECT_PROFILES.set(projectProfile, { root, profile, files });
  return Object.freeze({ profile, projectProfile });
}

// Every fingerprinted module of the project profile must still be the same
// regular file, reached without symbolic links, with the same SHA-256. lstat
// before open: anything but a regular file (a FIFO, device, socket) counts
// as changed without being opened; O_NONBLOCK keeps an open of one swapped
// in meanwhile from blocking.
async function assertProjectProfileUnchanged(projectProfile, stage) {
  if (projectProfile === undefined) return;
  const changed = [];
  for (const file of PROJECT_PROFILES.get(projectProfile).files) {
    let unchanged = false;
    try {
      if (
        (await lstat(file.absolute)).isFile() &&
        (await realpath(file.absolute)) === file.absolute
      ) {
        const handle = await open(
          file.absolute,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
        try {
          unchanged =
            (await handle.stat()).isFile() &&
            sha256Hex(await handle.readFile()) === file.sha256;
        } finally {
          await handle.close();
        }
      }
    } catch {
      unchanged = false;
    }
    if (!unchanged) changed.push(file.path);
  }
  if (changed.length > 0) {
    throw new AgentWorkflowError(
      `The project profile changed during the run: ${changed.map((path) => JSON.stringify(path)).join(', ')}. It was loaded once, before the first round; the change was not used.`,
      {
        code: 'PROFILE_MODIFIED',
        stage,
        resume:
          'Inspect and revert the change to the profile, check the working tree, and run the task again.',
      },
    );
  }
}

// The files of the project profile whose bytes on disk are not the blob
// committed in HEAD: the profile runs as it is on disk, so a change there,
// also one a writer left behind, runs with the next load. git status is not
// used, because it trusts index flags, core.fsmonitor and .gitattributes
// conversions. The runner hashes the bytes itself (blob header, object
// format of the repository, no filters) and compares the id with the blob
// of HEAD:<path> (git ls-tree) and with the index entry (git ls-files -s
// -v). Changed, missing from HEAD or the index, flagged skip-worktree or
// assume-unchanged, or not a regular file (mode 100644 or 100755): listed.
// With a sha256 (a loaded module), the bytes must also be those it was
// loaded with. The git commands only read the object database and the
// index: no fsmonitor, no replace refs, no lazy fetch, no index refresh,
// literal pathspecs; they run no hook, filter or textconv. lstat before
// open: anything but a regular file is listed without being opened;
// O_NONBLOCK keeps an open of one swapped in meanwhile from blocking.
// ringi doctor and ringi run stop on them (PROFILE_UNCOMMITTED); the report
// of a run lists them.
async function readUncommittedProjectProfileFiles({
  runner,
  cwd,
  projectProfile,
  stage = 'preflight',
}) {
  const paths = projectProfile.files.map(({ path }) => path);
  const git = (args, label, exactStdoutLimitBytes) =>
    requiredGitRun(
      runner,
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_NO_LAZY_FETCH: '1',
          GIT_LITERAL_PATHSPECS: '1',
        },
        stage,
        exactStdoutLimitBytes,
      },
      `${label} of ${PROJECT_PROFILE_FILE}`,
    );
  const unexpected = (message) =>
    new AgentWorkflowError(`${message} of ${PROJECT_PROFILE_FILE}.`, {
      code: 'PROCESS_FAILED',
      stage,
    });
  const format = (
    await git(['rev-parse', '--show-object-format'], 'Cannot read the object format')
  ).stdout.trim();
  if (format !== 'sha1' && format !== 'sha256') {
    throw unexpected('Unknown object format of the repository');
  }
  const entries = (stdout, pattern) => {
    const found = new Map();
    for (const entry of stdout.split('\0').filter(Boolean)) {
      const match = pattern.exec(entry);
      if (!match) throw unexpected('Unexpected git output for the files');
      const { path, ...fields } = match.groups;
      // A path listed twice (an unmerged entry) is never accepted.
      found.set(path, found.has(path) ? null : fields);
    }
    return found;
  };
  const head = entries(
    (
      await git(
        ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', ...paths],
        'Cannot read HEAD',
        MAX_GIT_PATH_LIST_BYTES,
      )
    ).stdout,
    /^(?<mode>\d{6}) (?<type>\w+) (?<oid>[0-9a-f]+)\t(?<path>.+)$/s,
  );
  const index = entries(
    (
      await git(
        ['ls-files', '-s', '-v', '-z', '--', ...paths],
        'Cannot read the Git index',
        MAX_GIT_PATH_LIST_BYTES,
      )
    ).stdout,
    /^(?<tag>.) (?<mode>\d{6}) (?<oid>[0-9a-f]+) (?<stage>\d)\t(?<path>.+)$/s,
  );
  const regular = (mode) => mode === '100644' || mode === '100755';
  const uncommitted = [];
  for (const { path, sha256 } of projectProfile.files) {
    let committed = false;
    try {
      const absolute = join(cwd, path);
      const inHead = head.get(path);
      const inIndex = index.get(path);
      if (
        inHead?.type === 'blob' &&
        regular(inHead.mode) &&
        inIndex?.tag === 'H' &&
        inIndex.stage === '0' &&
        regular(inIndex.mode) &&
        inIndex.oid === inHead.oid &&
        (await lstat(absolute)).isFile()
      ) {
        const handle = await open(
          absolute,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
        try {
          if ((await handle.stat()).isFile()) {
            const bytes = await handle.readFile();
            const oid = createHash(format)
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest('hex');
            committed =
              oid === inHead.oid &&
              (sha256 === undefined || sha256Hex(bytes) === sha256);
          }
        } finally {
          await handle.close();
        }
      }
    } catch {
      committed = false;
    }
    if (!committed) uncommitted.push(path);
  }
  return uncommitted;
}

// Report field of a loaded project profile; committed and uncommitted: the
// Git status of its files at the start of the run.
function projectProfileAudit(projectProfile, uncommitted) {
  return {
    path: projectProfile.path,
    sha256: projectProfile.sha256,
    files: projectProfile.files.map(({ path, sha256 }) => ({ path, sha256 })),
    committed: uncommitted.length === 0,
    uncommitted: [...uncommitted],
  };
}

// Every message of the run is in the locale of its profile.
export function runAgentReviewLoop(options) {
  return withLocale(profileLocale(options?.profile), () =>
    runWorkflow(options),
  );
}

async function runWorkflow(options) {
  const {
    runner: processRunner,
    output = { write() {} },
    repositoryRoot,
    invocationCwd = repositoryRoot,
    taskPath,
    profile,
    // The record of a profile from ringi.config.mjs (loadProjectProfile);
    // without it nothing below changes.
    projectProfile,
    // The runner's own files (readRunnerFingerprint): by default this
    // process's runner, fingerprinted when the module loaded.
    runnerFingerprint = RUNNER_FINGERPRINT.fingerprint,
    taskMode = DEFAULT_TASK_MODE,
    // Without these options the profile's implementer and reviewer apply.
    reviewProfile,
    codexModel,
    solEffort,
    dryRun = false,
    maxRounds = MAX_ROUNDS,
    codexTimeoutMs = 45 * 60_000,
    claudeTimeoutMs = 30 * 60_000,
    createSnapshot = createReviewSnapshot,
    codexRound = runCodexRound,
    claudeReview = runClaudeReview,
    now = () => new Date(),
    randomId,
    sourceEnvironment = process.env,
    cleanup = cleanupOwnedTemp,
    prepareCheckEnvironment = createCheckEnvironment,
    verbose = false,
    onEvent = () => {},
    monotonicNow = () => Number(process.hrtime.bigint()) / 1_000_000,
  } = options;
  // Replaced by withCoreGitIndex for implementers that may write in .git.
  let runner = processRunner;
  const coreGitIndex = {};
  let selectedProfile;
  let runDirectory;
  let tempRoot;
  let report;
  let workflowError;
  let verifiedInputMetadata;
  let lastDiagnosticLog;
  const diagnosticLogs = [];
  const findingHistory = new Map();
  const responseHistory = [];
  const rounds = [];
  const reviewRuns = [];
  const solRuns = [];
  const analysisArtifacts = [];
  const publicAnalysisArtifacts = () =>
    analysisArtifacts.map((artifact) => {
      const publicArtifact = { ...artifact };
      delete publicArtifact.absolutePath;
      delete publicArtifact.headings;
      return publicArtifact;
    });
  let selectedCodexModel = null;
  let selectedSolEffort = null;
  let selectedTaskMode = null;
  let quality;
  // Until the profile is resolved, the core defaults describe the roles.
  const roles = () => ({
    implementer: selectedProfile?.implementer ?? DEFAULT_IMPLEMENTER,
    reviewer: selectedProfile?.reviewer ?? DEFAULT_REVIEWER,
  });
  const reviewAudit = (profile) =>
    quality?.independentReviewRequired === false
      ? skippedReviewAudit(quality)
      : buildReviewAudit(profile, reviewRuns, roles().reviewer);
  // INVALID_REVIEW_PROFILE_NAME is reserved, so it never names a profile.
  const reportReviewProfile = () => {
    const { reviewer } = roles();
    const name =
      reviewProfile === undefined ? reviewer.defaultProfile : reviewProfile;
    return typeof name === 'string' && Object.hasOwn(reviewer.profiles, name)
      ? name
      : INVALID_REVIEW_PROFILE_NAME;
  };
  // report.sol and report.review with their neutral role fields.
  const roleAudits = (review) => {
    const sol = buildSolAudit(selectedSolEffort, solRuns, selectedCodexModel);
    const { implementer, reviewer } = roles();
    // Same provider in both roles: weaker independence, reported, not
    // blocked. The review still runs in a new session.
    const sameProvider =
      implementer.provider === reviewer.provider &&
      quality?.independentReviewRequired !== false;
    return {
      sol,
      review,
      implementer: buildImplementerAudit(implementer.provider, sol),
      reviewer: {
        ...buildReviewerAudit(reviewer.provider, review),
        ...(sameProvider ? { warnings: ['SAME_PROVIDER_REVIEW'] } : {}),
      },
    };
  };
  // Neutral round fields are small pointers to the alias keys that hold the
  // data, so agent outputs are not serialized twice. reviewerOutput: the key
  // of the reviewer output in the round, or null when no review ran.
  const roundRoles = (reviewerOutput) => {
    const { implementer, reviewer } = roles();
    return {
      implementer: {
        provider: implementer.provider,
        outputField: 'codex',
        executionField: 'solExecution',
      },
      reviewer: {
        provider: reviewer.provider,
        outputField: reviewerOutput,
        executionField: 'reviewExecution',
      },
    };
  };
  // Project profile (ringi.config.mjs): its report field, once the record
  // is verified; a change of the profile is the primary stop code and any
  // other failure of the same check point is kept as an integrity violation.
  let projectProfileReport;
  const projectProfileFields = () =>
    projectProfileReport ? { projectProfile: projectProfileReport } : {};
  // The runner's own files, checked at the same points as the profile once
  // the first check passed (report field runner); their change is the
  // primary stop code, before a change of the profile.
  let runnerReport;
  const runnerFields = () => (runnerReport ? { runner: runnerReport } : {});
  const runnerViolationFirst = (error, stage) => {
    if (!runnerReport || error?.code === 'RUNNER_MODIFIED') return error;
    try {
      assertRunnerUnchanged(runnerFingerprint, stage);
      return error;
    } catch (runnerError) {
      return appendIntegrityViolation(runnerError, error);
    }
  };
  const profileViolationFirst = async (error, stage) => {
    if (projectProfile === undefined) return runnerViolationFirst(error, stage);
    try {
      await assertProjectProfileUnchanged(projectProfile, stage);
      return runnerViolationFirst(error, stage);
    } catch (profileError) {
      return runnerViolationFirst(
        appendIntegrityViolation(profileError, error),
        stage,
      );
    }
  };
  const assertFingerprintsUnchanged = async (stage) => {
    try {
      await assertProjectProfileUnchanged(projectProfile, stage);
    } catch (error) {
      throw runnerViolationFirst(error, stage);
    }
    assertRunnerUnchanged(runnerFingerprint, stage);
  };
  const assertProjectProfileAfter = async (stage, assertion) => {
    try {
      await assertion();
    } catch (error) {
      throw await profileViolationFirst(error, stage);
    }
    await assertFingerprintsUnchanged(stage);
  };
  let pendingFindings = [];
  let latestFindings = [];
  const runId = createRunId(now(), randomId);
  const startedAt = now().toISOString();
  const workflowStartedAt = monotonicNow();
  const reportPath = join(STATE_DIRECTORY, 'runs', runId, 'report.json');
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // Błąd prezentacji nie zmienia wyniku workflow.
    }
  };

  emit({
    type: 'stage:start',
    id: 'preflight',
    badge: 'PREFLIGHT',
    label: msg('stage.preflight'),
  });

  try {
    assertRunnerUnchanged(
      runnerFingerprint,
      'preflight',
      runnerFingerprint === RUNNER_FINGERPRINT.fingerprint
        ? RUNNER_FINGERPRINT.failure
        : undefined,
    );
    runnerReport = runnerFingerprint;
    selectedProfile = resolveRunnerProfile(profile);
    const { implementer, reviewer } = selectedProfile;
    if (
      projectProfile !== undefined &&
      PROJECT_PROFILES.get(projectProfile)?.profile !== profile
    ) {
      throw new AgentWorkflowError(
        `The ${PROJECT_PROFILE_FILE} record does not belong to this profile.`,
        { code: 'INVALID_CONFIGURATION', stage: 'preflight' },
      );
    }
    if (
      !Number.isInteger(maxRounds) ||
      maxRounds < 1 ||
      maxRounds > MAX_ROUNDS
    ) {
      throw new AgentWorkflowError(
        msg('config.maxRounds', { max: MAX_ROUNDS }),
        { code: 'INVALID_CONFIGURATION', stage: 'preflight' },
      );
    }
    // Options override the profile within its allowlists.
    selectedCodexModel = resolveCodexModel(
      codexModel === undefined ? implementer.model : codexModel,
    );
    selectedTaskMode = resolveTaskMode(taskMode);
    selectedSolEffort = resolveSolEffort(
      solEffort === undefined ? implementer.effort : solEffort,
      implementer.allowedEfforts,
    );
    const reviewPolicy = resolveReviewProfile(
      reviewProfile === undefined ? reviewer.defaultProfile : reviewProfile,
      reviewer,
    );
    // The provider modules of the roles: the task mode must be one they
    // serve, and the writer's model must pass the module's rule too (for
    // codex and claude it is the core rule above).
    const implementerAdapter = roleProvider(implementer, 'implementer');
    if (!isProviderModel(implementerAdapter, selectedCodexModel)) {
      throw new AgentWorkflowError(
        msg('config.modelUnsupported', {
          model: JSON.stringify(selectedCodexModel),
          provider: implementerAdapter.id,
        }),
        { code: 'INVALID_CODEX_MODEL', stage: 'preflight' },
      );
    }
    assertProviderTaskMode(implementerAdapter, 'implementer', selectedTaskMode);
    assertProviderTaskMode(
      roleProvider(reviewer, 'reviewer'),
      'reviewer',
      selectedTaskMode,
    );
    // Neutral event fields; badge SOL/CLAUDE and role ASTRA/CLAUDE are their
    // aliases.
    const implementerActor = {
      actor: 'implementer',
      provider: implementer.provider,
    };
    const reviewerActor = { actor: 'reviewer', provider: reviewer.provider };
    const cwd = await resolveRepositoryRoot({
      runner,
      repositoryRoot,
      invocationCwd,
    });
    if (projectProfile !== undefined) {
      if (PROJECT_PROFILES.get(projectProfile).root !== cwd) {
        throw new AgentWorkflowError(
          `${PROJECT_PROFILE_FILE} was loaded from another repository.`,
          { code: 'INVALID_CONFIGURATION', stage: 'preflight' },
        );
      }
      projectProfileReport = projectProfileAudit(
        projectProfile,
        await readUncommittedProjectProfileFiles({
          runner,
          cwd,
          projectProfile,
        }),
      );
    }
    const branch = await readBranch(runner, cwd);
    if (WORKING_BRANCHES_BLOCKED.has(branch)) {
      throw new AgentWorkflowError(
        msg('git.protectedBranch', { branch }),
        { code: 'PROTECTED_BRANCH', stage: 'preflight' },
      );
    }
    const head = await readHead(runner, cwd);
    await assertNoStagedChanges(runner, cwd);
    await assertImplementerRepositoryLayout({
      runner,
      cwd,
      adapter: implementerAdapter,
    });
    if (implementerStateChecks(implementerAdapter).gitDirectoryWritable) {
      coreGitIndex.index = await createCoreGitIndex({
        runner,
        cwd,
        stage: 'preflight',
      });
      runner = withCoreGitIndex(runner, coreGitIndex);
    }
    const task = await loadTaskFile({
      repositoryRoot: cwd,
      taskPath,
      taskMode: selectedTaskMode,
      profile: selectedProfile,
    });
    quality = { ...task.quality, effectiveGates: [...task.checks] };
    if (quality.docs)
      await assertDocsCandidate({
        runner,
        cwd,
        stage: 'preflight',
        profile: selectedProfile,
        protectedPaths: projectProfileReport?.files.map(({ path }) => path),
      });
    await assertRequiredGates({
      runner,
      cwd,
      stage: 'preflight',
      task,
      profile: selectedProfile,
    });
    emit({
      type: 'metadata',
      branch,
      runId,
      reportPath,
      reviewProfile: quality.independentReviewRequired
        ? reviewPolicy.profile
        : null,
      taskMode: selectedTaskMode,
      solModel: selectedCodexModel,
      solEffort: selectedSolEffort,
      quality,
      taskClass: task.taskClass,
      effectiveGates: task.checks,
      reviewAttempts: quality.independentReviewRequired
        ? reviewPolicy.attempts
        : [],
      reviewFallbackAllowed:
        quality.independentReviewRequired && reviewPolicy.fallbackAllowed,
      // Neutral role fields; solModel and solEffort are their aliases.
      implementer: {
        provider: implementer.provider,
        model: selectedCodexModel,
        effort: selectedSolEffort,
      },
      reviewer: {
        provider: reviewer.provider,
        profile: quality.independentReviewRequired
          ? reviewPolicy.profile
          : null,
        attempts: quality.independentReviewRequired
          ? reviewPolicy.attempts
          : [],
        fallbackAllowed:
          quality.independentReviewRequired && reviewPolicy.fallbackAllowed,
      },
    });
    const secretBaseline = await establishSecretBaseline({ runner, cwd });
    const dependencyMetadata = await createDependencyMetadataFingerprint({
      repositoryRoot: cwd,
    });
    const dependencyInputs = await createDependencyInputFingerprint({
      runner,
      repositoryRoot: cwd,
    });
    const environment = await environmentReport({
      runner,
      cwd,
      reviewProfile: reviewPolicy.profile,
      codexModel: selectedCodexModel,
      solEffort: selectedSolEffort,
      independentReviewRequired: quality.independentReviewRequired,
      implementer,
      reviewer,
    });
    const repositoryInstructions = `${await readFile(join(cwd, 'AGENTS.md'), 'utf8')}\n\n${await readFile(join(cwd, 'CLAUDE.md'), 'utf8')}`;
    tempRoot = await mkdtemp(
      join(tmpdir(), `${selectedProfile.tempPrefix}${runId}-`),
    );
    const checkPreparation = await prepareCheckEnvironment({
      runner,
      repositoryRoot: cwd,
      tempRoot,
      source: sourceEnvironment,
    });
    await verifyInstalledDependencyState({
      runner,
      dependencyMetadata,
      dependencyInputs,
      environment: checkPreparation.environment,
      tempRoot,
    });
    await assertFingerprintsUnchanged('preflight');

    const copyInputMetadata = () => ({
      branch,
      head,
      task: {
        path: task.path,
        sha256: task.hash,
        mode: selectedTaskMode,
        reviewFiles: task.reviewFiles.map(({ path }) => path),
      },
    });

    if (dryRun) {
      verifiedInputMetadata = copyInputMetadata();
      const audits = roleAudits({
        ...reviewAudit(reviewPolicy.profile),
      });
      report = {
        schemaVersion: 1,
        runId,
        dryRun: true,
        status: 'DRY_RUN_OK',
        taskMode: selectedTaskMode,
        taskSchemaVersion: selectedProfile.taskSchema.version,
        branch,
        head,
        task: {
          path: task.path,
          sha256: task.hash,
          mode: selectedTaskMode,
          reviewFiles: task.reviewFiles.map(({ path }) => path),
        },
        review: audits.review,
        sol: audits.sol,
        implementer: audits.implementer,
        reviewer: audits.reviewer,
        quality,
        checks: task.checks,
        ...(selectedTaskMode === 'analysis'
          ? {
              integrityChecks: [...ANALYSIS_POST_REVIEW_CHECKS],
              analysisArtifact: {
                required: true,
                maxBytes: MAX_ANALYSIS_ARTIFACT_BYTES,
                sentinel: ANALYSIS_COMPLETENESS_SENTINEL,
              },
            }
          : {}),
        agents: environment,
        packageManager: {
          required: checkPreparation.packageManager,
          verifiedPnpm: checkPreparation.pnpmVersion,
          corepackNetwork: 'disabled',
          isolatedCaches: {
            codex: true,
            checks: true,
            distinct: true,
          },
        },
        dependencyMetadata: {
          verified: true,
          fingerprint: dependencyMetadata.hash,
          installedLockfileCurrent: true,
        },
        dependencyInputs: {
          verified: true,
          fingerprint: dependencyInputs.hash,
          files: dependencyInputs.paths.length,
          manifestsMatchLockfile: true,
        },
        sequence:
          selectedTaskMode === 'analysis'
            ? [
                msg('plan.analysisWriter'),
                msg('plan.analysisIntegrity'),
                msg('plan.analysisArtifact'),
                msg('plan.analysisPackage'),
                msg('plan.analysisReview'),
                msg('plan.analysisCorrection'),
              ]
            : !quality.independentReviewRequired
              ? [
                  msg('plan.docsWriter'),
                  msg('plan.checks'),
                  'review NOT_REQUIRED',
                ]
              : [
                  msg('plan.implementationWriter'),
                  msg('plan.checks'),
                  msg('plan.isolatedCopy'),
                  msg('plan.implementationReview'),
                  msg('plan.implementationCorrection'),
                ],
        maxRounds,
        mutations: msg('plan.noMutations'),
        ...projectProfileFields(),
        ...runnerFields(),
      };
      output.write(`${JSON.stringify(report, null, 2)}\n`);
      return report;
    }

    runDirectory = join(cwd, STATE_DIRECTORY, 'runs', runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const [gitPath, pnpmPath, corepackPath] = await Promise.all([
      findExecutable('git'),
      findExecutable('pnpm'),
      findExecutable('corepack'),
    ]);
    // Keep the validated input, independently of task objects passed to agents.
    // The real-run preflight also requires executable discovery to succeed.
    verifiedInputMetadata = copyInputMetadata();
    emit({
      type: 'stage:end',
      id: 'preflight',
      runDirectory,
      badge: 'PREFLIGHT',
      label: msg('stage.preflight'),
      status: 'PASS',
      durationMs: monotonicNow() - workflowStartedAt,
    });
    const knownFindingIdentities = new Map();
    let sessionId;

    for (let round = 1; round <= maxRounds; round += 1) {
      assertNotCancelled(runner, 'codex');
      emit({
        type: 'round:start',
        round,
        maxRounds,
        gateCount: task.checks.length,
        gateNames: [...task.checks],
        integrityCount: ANALYSIS_PRE_REVIEW_CHECKS.length,
        unresolved: Object.fromEntries(
          ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'].map((severity) => [
            severity,
            pendingFindings.filter((finding) => finding.severity === severity)
              .length,
          ]),
        ),
      });
      const roundDiagnosticLogs = [];
      const analysisRoundBaseline =
        selectedTaskMode === 'analysis'
          ? await readRepositoryManifest({
              runner,
              cwd,
              stage: 'analysis',
            })
          : undefined;
      const analysisMutationBaseline =
        selectedTaskMode === 'analysis'
          ? await readAnalysisMutationFingerprint({
              runner,
              cwd,
              stage: 'analysis',
            })
          : undefined;
      // Providers whose sandbox does not keep the Git directory read-only,
      // whose CLI leaves directories in the repository, and every provider
      // module from a profile are checked around the round (before any
      // gate); codex is not.
      const implementerState = await readImplementerStateBaseline({
        runner,
        repositoryRoot: cwd,
        adapter: roleProvider(roles().implementer, 'implementer'),
        stage: 'codex',
      });
      // Checks after the gates on a failure path (a gate or the reviewer failed): the Git
      // directory and private index comparison is attached to the STOP
      // report, like post-codex.
      const withImplementerStateViolation = async (failure, stage) => {
        if (!implementerState) return failure;
        try {
          await assertImplementerStateStillUnchanged({
            runner,
            repositoryRoot: cwd,
            baseline: implementerState,
            coreGitIndex: implementerState.git ? coreGitIndex : undefined,
            stage,
          });
          return failure;
        } catch (integrityError) {
          return appendIntegrityViolation(failure, integrityError);
        }
      };
      const codexStageId = `round-${round}:codex`;
      const codexStartedAt = monotonicNow();
      const solExecution = {
        round,
        resumed: Boolean(sessionId),
        requestedModel: selectedCodexModel,
        requestedEffort: selectedSolEffort,
        status: 'STARTED',
        completed: null,
      };
      solRuns.push(solExecution);
      emit({
        type: 'stage:start',
        id: codexStageId,
        badge: 'SOL',
        ...implementerActor,
        model: selectedCodexModel,
        effort: selectedSolEffort,
        label:
          selectedTaskMode === 'analysis'
            ? round === 1
              ? msg('stage.analysis')
              : msg('stage.analysisCorrection')
            : round === 1
              ? msg('stage.implementation')
              : msg('stage.findingsCorrection'),
      });
      let codexResult;
      try {
        codexResult = await codexRound({
          runner,
          repositoryRoot: cwd,
          runDirectory,
          tempRoot,
          gitPath,
          pnpmPath,
          corepackPath,
          task,
          checks: task.checks,
          profile: selectedProfile,
          round,
          findings: pendingFindings,
          sessionId,
          taskMode: selectedTaskMode,
          codexModel: selectedCodexModel,
          solEffort: selectedSolEffort,
          timeoutMs: codexTimeoutMs,
          environment: checkPreparation.codexEnvironment,
          onActivity: (entry) =>
            emit({ type: 'activity', role: 'ASTRA', ...implementerActor, entry }),
          verbose,
        });
        solExecution.status = 'COMPLETED';
        solExecution.completed = {
          model: selectedCodexModel,
          effort: selectedSolEffort,
        };
        if (Object.hasOwn(codexResult, 'permissionDenials'))
          solExecution.permissionDenials = codexResult.permissionDenials;
      } catch (error) {
        solExecution.status = 'FAILED';
        let failure = error;
        if (implementerState) {
          try {
            await assertImplementerStateUnchanged({
              runner,
              repositoryRoot: cwd,
              baseline: implementerState,
              stage: 'post-codex',
            });
          } catch (integrityError) {
            failure = appendIntegrityViolation(error, integrityError);
          }
        }
        throw await profileViolationFirst(failure, 'post-codex');
      }
      const codexLog = await saveDiagnosticLog({
        runDirectory,
        relativePath: join('logs', `round-${round}-sol.log`),
        label: msg('log.solRound', { round }),
        stderr: codexResult.stderr,
        stage: 'codex',
      });
      diagnosticLogs.push(codexLog);
      roundDiagnosticLogs.push(codexLog);
      emit({
        type: 'stage:end',
        id: codexStageId,
        badge: 'SOL',
        ...implementerActor,
        label:
          selectedTaskMode === 'analysis'
            ? round === 1
              ? msg('stage.analysis')
              : msg('stage.analysisCorrection')
            : round === 1
              ? msg('stage.implementation')
              : msg('stage.findingsCorrection'),
        status: 'PASS',
        durationMs: monotonicNow() - codexStartedAt,
      });
      let analysisArtifact;
      // The writer's report and artifact are checked after the project
      // profile: its change stays the primary stop code.
      try {
        const validatedCodexReport = validateCodexReport(
          codexResult.report,
          pendingFindings,
          selectedTaskMode,
        );
        emit({
          type: 'activity',
          role: 'ASTRA',
          ...implementerActor,
          entry: {
            type: 'SUMMARY',
            status: validatedCodexReport.status,
            changes: validatedCodexReport.changes.length,
          },
        });
        if (selectedTaskMode === 'analysis') {
          const materialized = await materializeAnalysisArtifact({
            repositoryRoot: cwd,
            runDirectory,
            round,
            report: validatedCodexReport,
          });
          codexResult.report = materialized.report;
          analysisArtifact = materialized.artifact;
          analysisArtifacts.push(analysisArtifact);
          await saveJson(
            join(runDirectory, `round-${round}-codex.json`),
            codexResult.report,
          );
        } else {
          codexResult.report = validatedCodexReport;
        }
      } catch (error) {
        throw await profileViolationFirst(error, 'post-codex');
      }
      responseHistory.push(...codexResult.report.findingResponses);
      const needsHuman = codexResult.report.findingResponses.find(
        ({ status }) => status === 'NEEDS_HUMAN',
      );
      const humanDecisionError = needsHuman
        ? new AgentWorkflowError(
            msg('finding.needsHuman', {
              findingId: needsHuman.findingId,
              question: redactSensitive(needsHuman.question),
            }),
            { code: 'HUMAN_DECISION_REQUIRED', stage: 'codex' },
          )
        : undefined;
      sessionId = codexResult.sessionId;
      try {
        await assertProjectProfileAfter('post-codex', () =>
          assertPostCodexStateUnchanged({
            runner,
            repositoryRoot: cwd,
            branch,
            head,
            dependencyMetadata,
            dependencyInputs,
            secretBaseline,
            implementerState,
            coreGitIndex: coreGitIndex.index ? coreGitIndex : undefined,
          }),
        );
        if (quality.docs)
          await assertDocsCandidate({
            runner,
            cwd,
            stage: 'post-codex',
            profile: selectedProfile,
            protectedPaths: projectProfileReport?.files.map(({ path }) => path),
          });
        await assertRequiredGates({
          runner,
          cwd,
          stage: 'post-codex',
          task,
          profile: selectedProfile,
        });
        if (selectedTaskMode === 'analysis') {
          const mutationFingerprint = await readAnalysisMutationFingerprint({
            runner,
            cwd,
            stage: 'analysis',
          });
          if (mutationFingerprint.hash !== analysisMutationBaseline.hash) {
            throw new AgentWorkflowError(
              msg('writer.analysisWrite'),
              { code: 'ANALYSIS_WORKING_TREE_WRITE', stage: 'analysis' },
            );
          }
          await assertQaStateUnchanged({
            runner,
            repositoryRoot: cwd,
            branch,
            head,
            dependencyMetadata,
            dependencyInputs,
            repositoryManifest: analysisRoundBaseline,
            cache: checkPreparation.cache,
            stage: 'analysis',
          });
          await assertAnalysisArtifactIntegrity(analysisArtifact, 'analysis');
        }
      } catch (integrityError) {
        if (!humanDecisionError) throw integrityError;
        // A change of the project profile stays the primary stop code; the
        // human decision is kept as an integrity violation.
        throw integrityError?.code === 'PROFILE_MODIFIED'
          ? appendIntegrityViolation(integrityError, humanDecisionError)
          : appendIntegrityViolation(humanDecisionError, integrityError);
      }
      if (humanDecisionError) throw humanDecisionError;
      let gateReport;
      let integrityReport;
      if (selectedTaskMode === 'implementation') {
        const beforeChecks = await readRepositoryManifest({
          runner,
          cwd,
          stage: 'checks',
        });
        await assertPreparedCorepackCacheUnchanged({
          cache: checkPreparation.cache,
          stage: 'checks',
        });
        let checks;
        let gateIndex = 0;
        try {
          checks = await runChecks({
            runner,
            repositoryRoot: cwd,
            checks: task.checks,
            profile: selectedProfile,
            output,
            environment: checkPreparation.environment,
            dockerHost: checkPreparation.dockerHost,
            verbose,
            onEvent: emit,
            onResult: async ({ name, result }) => {
              gateIndex += 1;
              const gateLog = await saveDiagnosticLog({
                runDirectory,
                relativePath: join(
                  'logs',
                  `round-${round}-gate-${String(gateIndex).padStart(2, '0')}.log`,
                ),
                label: `QUALITY GATE ${name}`,
                stdout: result.stdout,
                stderr: result.stderr,
                stage: 'checks',
              });
              diagnosticLogs.push(gateLog);
              roundDiagnosticLogs.push(gateLog);
              if (result.code !== 0 || result.timedOut || result.signal) {
                lastDiagnosticLog = gateLog;
              }
            },
            afterEach: async () =>
              assertQaStateUnchanged({
                runner,
                repositoryRoot: cwd,
                branch,
                head,
                dependencyMetadata,
                dependencyInputs,
                repositoryManifest: beforeChecks,
                cache: checkPreparation.cache,
              }),
          });
        } catch (error) {
          let failure = error;
          try {
            await assertQaStateUnchanged({
              runner,
              repositoryRoot: cwd,
              branch,
              head,
              dependencyMetadata,
              dependencyInputs,
              repositoryManifest: beforeChecks,
              cache: checkPreparation.cache,
            });
          } catch (integrityError) {
            failure = appendIntegrityViolation(error, integrityError);
          }
          failure = await withImplementerStateViolation(failure, 'post-checks');
          throw await profileViolationFirst(failure, 'post-checks');
        }
        await assertProjectProfileAfter('post-checks', () =>
          assertQaStateUnchanged({
            runner,
            repositoryRoot: cwd,
            branch,
            head,
            dependencyMetadata,
            dependencyInputs,
            repositoryManifest: beforeChecks,
            cache: checkPreparation.cache,
          }),
        );
        await assertGitIdentityStable({
          runner,
          cwd,
          branch,
          head,
          stage: 'post-checks',
        });
        await assertNoNewSecrets({
          runner,
          cwd,
          baseline: secretBaseline,
          stage: 'post-checks',
        });
        const afterChecks = await readRepositoryManifest({
          runner,
          cwd,
          stage: 'checks',
        });
        if (beforeChecks.hash !== afterChecks.hash) {
          throw new AgentWorkflowError(
            msg('check.treeChangedStop'),
            { code: 'WORKING_TREE_CHANGED', stage: 'checks' },
          );
        }
        if (quality.docs)
          await assertDocsCandidate({
            runner,
            cwd,
            stage: 'post-checks',
            profile: selectedProfile,
            protectedPaths: projectProfileReport?.files.map(({ path }) => path),
          });
        await assertRequiredGates({
          runner,
          cwd,
          stage: 'post-checks',
          task,
          profile: selectedProfile,
        });
        gateReport = createTrustedGateReport(
          checks,
          task.checks,
          selectedProfile,
        );
      } else {
        const integrityStageId = `round-${round}:integrity`;
        const integrityStartedAt = monotonicNow();
        emit({
          type: 'stage:start',
          id: integrityStageId,
          badge: 'INTEGRITY',
          label: msg('stage.analysisChecks'),
        });
        integrityReport = createAnalysisIntegrityReport();
        validateAnalysisIntegrityReport(integrityReport);
        emit({
          type: 'stage:end',
          id: integrityStageId,
          badge: 'INTEGRITY',
          label: msg('stage.analysisChecks'),
          status: 'PASS',
          durationMs: monotonicNow() - integrityStartedAt,
          controlCount: integrityReport.checks.length,
        });
      }

      // Checks after the gates: the Git directory, the private index, the project profile
      // and the runner again after the gates, before the reviewer's snapshot
      // (or the report of a run without review).
      const assertStateStillUnchanged = (stage) =>
        implementerState
          ? assertProjectProfileAfter(stage, () =>
              assertImplementerStateStillUnchanged({
                runner,
                repositoryRoot: cwd,
                baseline: implementerState,
                // Built in the preflight for these providers; a missing one
                // stops the check (assertCoreGitIndexUnchanged).
                coreGitIndex: implementerState.git ? coreGitIndex : undefined,
                stage,
              }),
            )
          : assertFingerprintsUnchanged(stage);
      await assertStateStillUnchanged(
        selectedTaskMode === 'analysis' ? 'analysis' : 'post-checks',
      );

      if (!quality.independentReviewRequired) {
        const review = skippedReviewAudit(quality);
        const roundReport = {
          round,
          taskMode: selectedTaskMode,
          quality,
          codex: codexResult.report,
          solExecution,
          gates: gateReport,
          reviewExecution: review,
          ...roundRoles(null),
          diagnostics: roundDiagnosticLogs,
        };
        rounds.push(roundReport);
        await saveJson(join(runDirectory, `round-${round}.json`), roundReport);
        const audits = roleAudits(review);
        report = {
          schemaVersion: 1,
          runId,
          startedAt,
          finishedAt: now().toISOString(),
          status: 'APPROVE',
          taskMode: selectedTaskMode,
          taskSchemaVersion: selectedProfile.taskSchema.version,
          quality,
          durationMs: Math.max(
            0,
            Math.round(monotonicNow() - workflowStartedAt),
          ),
          ...copyInputMetadata(),
          sol: audits.sol,
          review: audits.review,
          implementer: audits.implementer,
          reviewer: audits.reviewer,
          rounds,
          publicationApproved: false,
          reportPath,
          diagnostics: { logs: diagnosticLogs },
          approvalMeaning:
            msg('report.docsApproval'),
          nextStep: quality.remainingAssurance,
          ...projectProfileFields(),
          ...runnerFields(),
        };
        await saveJson(join(runDirectory, 'report.json'), report);
        break;
      }

      await assertFingerprintsUnchanged('snapshot');
      const snapshotStageId = `round-${round}:snapshot`;
      const snapshotStartedAt = monotonicNow();
      emit({
        type: 'stage:start',
        id: snapshotStageId,
        badge: 'SNAPSHOT',
        label:
          selectedTaskMode === 'analysis'
            ? msg('stage.analysisPackage')
            : msg('stage.isolatedCopy'),
      });
      const snapshot = await createSnapshot({
        runner,
        repositoryRoot: cwd,
        tempRoot,
        task,
        profile: selectedProfile,
        taskMode: selectedTaskMode,
        repositoryInstructions,
        round,
        gateReport,
        integrityReport,
        analysisArtifact,
        previousFindings: latestFindings,
        findingResponses: codexResult.report.findingResponses,
      });
      emit({
        type: 'stage:end',
        id: snapshotStageId,
        badge: 'SNAPSHOT',
        label:
          selectedTaskMode === 'analysis'
            ? msg('stage.analysisPackage')
            : msg('stage.isolatedCopy'),
        status: 'PASS',
        durationMs: monotonicNow() - snapshotStartedAt,
      });
      const attemptStarts = new Map();
      let claudeResult;
      try {
        claudeResult = await runClaudeReviewWithPolicy({
          runner,
          task,
          taskMode: selectedTaskMode,
          snapshot,
          analysisArtifact,
          timeoutMs: claudeTimeoutMs,
          verbose,
          profile: reviewPolicy.profile,
          reviewer,
          reviewAttempt: claudeReview,
          beforeAttempt: () =>
            assertReviewStateUnchanged({
              runner,
              repositoryRoot: cwd,
              branch,
              head,
              snapshot,
              analysisArtifact,
            }),
          afterAttempt: () =>
            assertReviewStateUnchanged({
              runner,
              repositoryRoot: cwd,
              branch,
              head,
              snapshot,
              analysisArtifact,
            }),
          onAttemptStart: (attempt) => {
            const id = `round-${round}:claude:${attempt.attempt}`;
            attemptStarts.set(attempt.attempt, monotonicNow());
            emit({
              type: 'stage:start',
              id,
              badge: 'CLAUDE',
              ...reviewerActor,
              model: attempt.requestedModel,
              effort: attempt.requestedEffort,
              attempt: attempt.attempt,
              attemptLimit: reviewPolicy.attempts.length,
              label: msg('stage.reviewAttempt', {
                profile: reviewPolicy.profile,
                model: attempt.requestedModel,
                effort: attempt.requestedEffort,
                attempt: attempt.attempt,
              }),
            });
          },
          onAttemptEnd: (attempt) => {
            const id = `round-${round}:claude:${attempt.attempt}`;
            emit({
              type: 'stage:end',
              id,
              badge: 'CLAUDE',
              ...reviewerActor,
              label: msg('stage.reviewAttempt', {
                profile: reviewPolicy.profile,
                model: attempt.requestedModel,
                effort: attempt.requestedEffort,
                attempt: attempt.attempt,
              }),
              status:
                attempt.status === 'COMPLETED'
                  ? 'PASS'
                  : attempt.status === 'FALLBACK_ELIGIBLE'
                    ? 'FALLBACK'
                    : 'FAIL',
              durationMs:
                monotonicNow() -
                (attemptStarts.get(attempt.attempt) ?? monotonicNow()),
            });
          },
        });
        reviewRuns.push(claudeResult.execution);
      } catch (error) {
        if (error?.reviewExecution) reviewRuns.push(error.reviewExecution);
        throw await withImplementerStateViolation(error, 'post-review');
      }
      // The same checks again after the review, before the final report or the next
      // round's baseline.
      await assertStateStillUnchanged('post-review');
      const claudeLog = await saveDiagnosticLog({
        runDirectory,
        relativePath: join('logs', `round-${round}-claude.log`),
        label: msg('log.claudeRound', { round }),
        stderr: claudeResult.stderr,
        stage: 'claude',
      });
      diagnosticLogs.push(claudeLog);
      roundDiagnosticLogs.push(claudeLog);
      const validatedClaudeReview = validateClaudeReview(claudeResult.review, {
        taskMode: selectedTaskMode,
        expectedConfirmation: snapshot.expectedConfirmation,
        analysisHeadings: snapshot.analysisHeadings,
      });
      if (selectedTaskMode === 'analysis') {
        integrityReport = createAnalysisIntegrityReport({ postReview: true });
        validateAnalysisIntegrityReport(integrityReport, { postReview: true });
      }
      const reviewedFindings = assignFindingIds(
        validatedClaudeReview.findings,
        knownFindingIdentities,
      );
      claudeResult.review = {
        ...validatedClaudeReview,
        findings: reviewedFindings,
      };
      latestFindings = reviewedFindings;
      for (const finding of reviewedFindings) {
        findingHistory.set(finding.findingId, finding);
      }

      const roundReport = {
        round,
        taskMode: selectedTaskMode,
        quality,
        codex: codexResult.report,
        solExecution,
        ...(selectedTaskMode === 'implementation'
          ? { gates: gateReport }
          : {
              integrity: integrityReport,
              analysisArtifact: codexResult.report.analysisArtifact,
            }),
        snapshot: {
          mode: selectedTaskMode,
          fileCount: snapshot.fileCount,
          totalBytes: snapshot.totalBytes,
          sourceHash: snapshot.sourceHash,
          ...(selectedTaskMode === 'implementation'
            ? { diffHash: snapshot.diffHash, minimal: false }
            : {
                manifestHash: snapshot.manifestHash,
                artifactHash: analysisArtifact.sha256,
                packageHash: snapshot.snapshotHash,
                minimal: true,
              }),
          readOnly: true,
        },
        claude: claudeResult.review,
        reviewExecution: claudeResult.execution,
        ...roundRoles('claude'),
        diagnostics: roundDiagnosticLogs,
      };
      rounds.push(roundReport);
      await saveJson(join(runDirectory, `round-${round}.json`), roundReport);

      const unresolvedFindings = reviewedFindings.filter(({ severity }) =>
        UNRESOLVED_FINDING_SEVERITIES.has(severity),
      );
      emit({
        type: 'activity',
        role: 'CLAUDE',
        ...reviewerActor,
        entry: {
          type: 'SUMMARY',
          status: claudeResult.review.verdict,
          checks: claudeResult.review.checks.length,
          findings: ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'].map(
            (severity) =>
              reviewedFindings.filter(
                (finding) => finding.severity === severity,
              ).length,
          ),
        },
      });
      emit({
        type: 'findings',
        unresolved: Object.fromEntries(
          ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'].map((severity) => [
            severity,
            unresolvedFindings.filter(
              (finding) => finding.severity === severity,
            ).length,
          ]),
        ),
      });
      const latestResponses = latestResponseByFindingId(responseHistory);
      const dispute = unresolvedFindings.find(
        ({ findingId }) =>
          latestResponses.get(findingId)?.status === 'REJECTED',
      );
      if (dispute) {
        pendingFindings = unresolvedFindings;
        throw new AgentWorkflowError(
          msg('finding.dispute', { findingId: dispute.findingId }),
          { code: 'FINDING_DISPUTE', stage: 'claude' },
        );
      }

      if (unresolvedFindings.length === 0) {
        pendingFindings = [];
        if (selectedTaskMode === 'analysis') {
          await assertReviewStateUnchanged({
            runner,
            repositoryRoot: cwd,
            branch,
            head,
            snapshot,
            analysisArtifact,
          });
          for (const artifact of analysisArtifacts) {
            await assertAnalysisArtifactIntegrity(artifact, 'approve');
          }
        }
        // The runner once more, right before the final report.
        assertRunnerUnchanged(runnerFingerprint, 'post-review');
        report = {
          schemaVersion: 1,
          runId,
          startedAt,
          finishedAt: now().toISOString(),
          status: 'APPROVE',
          quality,
          taskMode: selectedTaskMode,
          taskSchemaVersion: selectedProfile.taskSchema.version,
          durationMs: Math.max(
            0,
            Math.round(monotonicNow() - workflowStartedAt),
          ),
          branch,
          head,
          task: {
            path: task.path,
            sha256: task.hash,
            mode: selectedTaskMode,
            reviewFiles: task.reviewFiles.map(({ path }) => path),
          },
          ...roleAudits(reviewAudit(reviewPolicy.profile)),
          rounds,
          ...buildFindingState({
            history: findingHistory,
            responses: responseHistory,
            latest: latestFindings,
            pending: pendingFindings,
          }),
          publicationApproved: false,
          reportPath,
          diagnostics: { logs: diagnosticLogs },
          ...(selectedTaskMode === 'analysis'
            ? {
                analysisArtifacts: publicAnalysisArtifacts(),
                approvalMeaning:
                  msg('report.analysisApproval'),
              }
            : {}),
          nextStep:
            msg('report.nextStep'),
          ...projectProfileFields(),
          ...runnerFields(),
        };
        await saveJson(join(runDirectory, 'report.json'), report);
        break;
      }
      pendingFindings = unresolvedFindings;
      if (round === maxRounds) {
        throw new AgentWorkflowError(
          msg('run.maxRounds', { maxRounds }),
          { code: 'MAX_ROUNDS', stage: 'claude' },
        );
      }
    }
  } catch (error) {
    let normalized =
      error instanceof AgentWorkflowError
        ? error
        : new AgentWorkflowError(
            redactSensitive(
              error instanceof Error ? error.message : String(error),
            ),
            { code: 'UNEXPECTED_ERROR' },
          );
    // Once the project profile's record is verified, every stop checks the
    // profile first: its change is the primary stop code. The runner's files
    // are checked on every stop after the first check: their change comes
    // before it.
    if (
      projectProfileReport &&
      normalized.code !== 'PROFILE_MODIFIED' &&
      normalized.code !== 'RUNNER_MODIFIED'
    ) {
      normalized = await profileViolationFirst(
        normalized,
        normalized.stage ?? 'workflow',
      );
    } else {
      normalized = runnerViolationFirst(
        normalized,
        normalized.stage ?? 'workflow',
      );
    }
    report = {
      schemaVersion: 1,
      runId,
      startedAt,
      finishedAt: now().toISOString(),
      status: 'STOPPED',
      quality,
      taskMode: selectedTaskMode ?? 'invalid',
      ...(selectedProfile
        ? { taskSchemaVersion: selectedProfile.taskSchema.version }
        : {}),
      ...verifiedInputMetadata,
      durationMs: Math.max(0, Math.round(monotonicNow() - workflowStartedAt)),
      code: normalized.code,
      stage: normalized.stage,
      error: boundedUtf8(redactSensitive(normalized.message), 1_000),
      resume:
        normalized.resume ??
        msg('run.resume'),
      ...(quality?.independentReviewRequired === false
        ? {}
        : buildFindingState({
            history: findingHistory,
            responses: responseHistory,
            latest: latestFindings,
            pending: pendingFindings,
          })),
      ...roleAudits(reviewAudit(reportReviewProfile())),
      publicationApproved: false,
      rounds,
      diagnostics: { logs: diagnosticLogs },
      ...(analysisArtifacts.length > 0
        ? { analysisArtifacts: publicAnalysisArtifacts() }
        : {}),
      ...projectProfileFields(),
      ...runnerFields(),
    };
    if (runDirectory) report.reportPath = reportPath;
    if (normalized.diagnostic && runDirectory) {
      const includeStdout = !['codex', 'claude'].includes(normalized.stage);
      lastDiagnosticLog = await saveDiagnosticLog({
        runDirectory,
        relativePath: join(
          'logs',
          `error-${String(normalized.stage ?? 'workflow').replace(/[^a-z0-9-]/gi, '-')}.log`,
        ),
        label: `${normalized.code} ${normalized.stage ?? 'workflow'}`,
        stdout: includeStdout ? normalized.diagnostic.stdout : '',
        stderr: normalized.diagnostic.stderr,
      }).catch(() => lastDiagnosticLog);
      if (lastDiagnosticLog && !diagnosticLogs.includes(lastDiagnosticLog)) {
        diagnosticLogs.push(lastDiagnosticLog);
      }
      report.diagnostics = { logs: diagnosticLogs };
    }
    if (lastDiagnosticLog) report.diagnosticLog = lastDiagnosticLog;
    if (normalized.report) report.partial = normalized.report;
    if (normalized.integrityViolations?.length) {
      report.integrityViolations = normalized.integrityViolations;
    }
    if (runDirectory) {
      await saveJson(join(runDirectory, 'report.json'), report).catch(() => {});
    }
    normalized.report = report;
    workflowError = normalized;
  } finally {
    await removeCoreGitIndex(coreGitIndex).catch(() => {});
    if (tempRoot) {
      try {
        await cleanup(tempRoot, runId, selectedProfile);
      } catch (error) {
        const hadWorkflowError = Boolean(workflowError);
        const warning = msg('cleanup.failed', {
          detail: redactSensitive(
            error instanceof Error ? error.message : String(error),
          ),
        });
        if (workflowError) {
          report.warnings = [...(report.warnings ?? []), warning];
          workflowError.report = report;
        } else {
          const completedReport = report;
          report = {
            schemaVersion: 1,
            runId,
            startedAt,
            finishedAt: now().toISOString(),
            status: 'STOPPED',
            quality,
            taskMode: selectedTaskMode ?? 'invalid',
            ...(selectedProfile
              ? { taskSchemaVersion: selectedProfile.taskSchema.version }
              : {}),
            ...verifiedInputMetadata,
            durationMs: Math.max(
              0,
              Math.round(monotonicNow() - workflowStartedAt),
            ),
            code: 'CLEANUP_FAILED',
            stage: 'cleanup',
            error: warning,
            warnings: [warning],
            partial: completedReport,
            rounds,
            ...(quality?.independentReviewRequired === false
              ? {}
              : buildFindingState({
                  history: findingHistory,
                  responses: responseHistory,
                  latest: latestFindings,
                  pending: pendingFindings,
                })),
            ...roleAudits(reviewAudit(reportReviewProfile())),
            publicationApproved: false,
            reportPath,
            diagnostics: { logs: diagnosticLogs },
            ...(analysisArtifacts.length > 0
              ? { analysisArtifacts: publicAnalysisArtifacts() }
              : {}),
            ...projectProfileFields(),
            ...runnerFields(),
          };
          workflowError = new AgentWorkflowError(warning, {
            code: 'CLEANUP_FAILED',
            stage: 'cleanup',
            report,
          });
        }
        if (runDirectory) {
          await saveJson(join(runDirectory, 'report.json'), report).catch(
            () => {},
          );
        }
        if (!hadWorkflowError) throw workflowError;
      }
    }
  }
  if (workflowError) {
    emit({ type: 'result', report, reportPath: report.reportPath });
    throw workflowError;
  }
  emit({ type: 'result', report, reportPath });
  return report;
}

export const internal = {
  profileLocale,
  assertDocsCandidate,
  assertRequiredGates,
  BLOCKED_PACKAGE_MANAGERS,
  DEPENDENCY_INPUT_NAMES,
  MAX_DIFF_BYTES,
  MAX_ANALYSIS_ARTIFACT_BYTES,
  MAX_COREPACK_CACHE_BYTES,
  MAX_COREPACK_CACHE_ENTRIES,
  MAX_DEPENDENCY_METADATA_FILE_BYTES,
  MAX_DEPENDENCY_METADATA_TOTAL_BYTES,
  MAX_DEPENDENCY_INPUT_TOTAL_BYTES,
  MAX_GIT_PATH_LIST_BYTES,
  OPTIONAL_DEPENDENCY_METADATA_PATHS,
  REQUIRED_DEPENDENCY_METADATA_PATHS,
  SOL_PHASE_OWNERSHIP_CONTRACT,
  ANALYSIS_COMPLETENESS_SENTINEL,
  ANALYSIS_FINDING_FILE,
  ANALYSIS_POST_REVIEW_CHECKS,
  STATE_DIRECTORY,
  // ringi: the project profile file and the preflight steps ringi doctor
  // shares with the runner.
  PROJECT_PROFILE_FILE,
  WORKING_BRANCHES_BLOCKED,
  assertImplementerRepositoryLayout,
  assertNoStagedChanges,
  assertProjectProfileUnchanged,
  // The runner's own files (RUNNER_MODIFIED) and their location
  // (ringi doctor: runner-location).
  RUNNER_ROOT,
  assertRunnerUnchanged,
  readRunnerFingerprint,
  environmentReport,
  readBranch,
  readUncommittedProjectProfileFiles,
  roleProvider,
  validatePinnedCorepackIntegrity,
  assertDependencyMetadataUnchanged,
  assertDependencyInputsUnchanged,
  assertNoNewSecrets,
  assertPreparedCorepackCacheUnchanged,
  assertAnalysisArtifactIntegrity,
  cleanupOwnedTemp,
  classifyClaudeFallbackReason,
  codexPrompt,
  codexSchema,
  claudePrompt,
  claudeSchema,
  copyPinnedCorepackCache,
  appendIntegrityViolation,
  buildFindingPolicy,
  buildFindingReport,
  buildFindingState,
  buildReviewAudit,
  buildSolAudit,
  createCheckEnvironment,
  createTrustedGateReport,
  createAnalysisIntegrityReport,
  createAgentCommandGuards,
  createDependencyInputFingerprint,
  createDependencyMetadataFingerprint,
  createIsolatedCodexEnvironment,
  createIsolatedCheckEnvironment,
  createGitGuard,
  createPackageManagerGuards,
  createRunId,
  establishSecretBaseline,
  findingFingerprint,
  findingIdFor,
  assignFindingIds,
  fullDiff,
  isDependencyInputPath,
  listRepositoryPaths,
  manifestHash,
  allowedPnpmInvocations,
  parsePinnedPnpmSpecification,
  readRepositoryManifest,
  readAnalysisMutationFingerprint,
  readPinnedPnpmVersion,
  readOptionalLocalDockerHost,
  resolveReviewProfile,
  resolveRunnerProfile,
  resolveSolEffort,
  resolveTaskMode,
  resolveCorepackHome,
  requiredRun,
  runClaudeReview,
  runClaudeReviewWithPolicy,
  runCodexRound,
  runChecks,
  safeAgentEnvironment,
  verifyInstalledDependencyState,
  validateClaudeReview,
  validateCodexReport,
  validateTrustedGateReport,
  validateAnalysisIntegrityReport,
  validateFullAnalysis,
  walkCorepackTree,
  withCoreGitIndex,
};
