// Built-in providers of the runner core and the default role values. A role
// (implementer: the writer of a round; reviewer: the independent review) is
// served by a provider module: the built-in codex and claude modules in
// scripts/providers/, or a module the profile passes in providerModules
// (see scripts/providers/contract.mjs and docs/providers.md). The profile
// selects the provider, model, effort and review profiles of each role.
//
// Provider modules build the argv and environment of the provider's CLI
// process and read provider-specific output (session ID, output envelope,
// fallback reasons). The core keeps everything else: validation and errors,
// the role rules, the isolated environment passed to the module and the
// check of what the module returns, guards, schemas, report validation and
// integrity checks.
import claudeProvider from './providers/claude.mjs';
import codexProvider, { SOL_EFFORTS } from './providers/codex.mjs';
import { isValidModelId } from './providers/contract.mjs';

export { isValidModelId };

// Defaults of the profile sections implementer and reviewer (the values used
// before the profile could declare them).
export const DEFAULT_REVIEW_PROFILE = 'critical';
export const REVIEW_PROFILES = Object.freeze({
  critical: Object.freeze([
    Object.freeze({ model: 'claude-fable-5', effort: 'high' }),
    Object.freeze({ model: 'claude-opus-5', effort: 'xhigh' }),
  ]),
  'critical-opus': Object.freeze([
    Object.freeze({ model: 'claude-opus-5', effort: 'xhigh' }),
  ]),
  standard: Object.freeze([
    Object.freeze({ model: 'claude-opus-5', effort: 'high' }),
  ]),
  economy: Object.freeze([
    Object.freeze({ model: 'claude-opus-5', effort: 'medium' }),
  ]),
});

export const DEFAULT_IMPLEMENTER = Object.freeze({
  provider: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
  allowedEfforts: SOL_EFFORTS,
});
export const DEFAULT_REVIEWER = Object.freeze({
  provider: 'claude',
  profiles: REVIEW_PROFILES,
  defaultProfile: DEFAULT_REVIEW_PROFILE,
  fallbackProfile: 'critical',
});

// PROVIDERS keeps the earlier adapter shape for compatibility:
// provider, program, versionArgs, roles, efforts, isValidModel and one object
// per role with the fields that shape had (codex had no preflight). The
// functions are those of the modules; the core uses the modules themselves.
const ADAPTER_FIELDS = Object.freeze({
  codex: Object.freeze({
    implementer: Object.freeze(['processArgs', 'processEnvironment', 'sessionId']),
  }),
  claude: Object.freeze({
    implementer: Object.freeze([
      'processArgs',
      'processEnvironment',
      'sessionId',
      'output',
      'permissionDenials',
      'resumeKeepsSessionId',
      'gitDirectoryWritable',
      'scratchDirectories',
      'preflight',
    ]),
    reviewer: Object.freeze([
      'processArgs',
      'processEnvironment',
      'reviewOutput',
      'fallbackReason',
    ]),
  }),
});

function adapterView(module) {
  const fields = ADAPTER_FIELDS[module.id];
  const adapter = {
    provider: module.id,
    program: module.program,
    versionArgs: module.versionArgs,
    roles: module.roles,
    efforts: module.efforts,
    isValidModel: module.isValidModel,
  };
  for (const role of module.roles) {
    adapter[role] = Object.freeze(
      Object.fromEntries(fields[role].map((name) => [name, module[role][name]])),
    );
  }
  return Object.freeze(adapter);
}

export const PROVIDERS = Object.freeze({
  codex: adapterView(codexProvider),
  claude: adapterView(claudeProvider),
});
