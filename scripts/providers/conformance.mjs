// Conformance suite for provider modules. It calls only the module's own
// functions with synthetic input, never a CLI or a model, so it runs for any
// module in a unit test:
//
//   const result = checkProviderConformance(module, fixtures);
//   assert.deepEqual(result.failures, []);
//
// fixtures describe the CLI's output format, which only the module author
// knows (see docs/providers.md):
// - model: a model ID the module accepts (default 'conformance-model');
// - implementer.stdout(report, sessionId): stdout of a successful round;
// - implementer.withoutSession: stdouts that carry no session ID;
// - implementer.malformed: stdouts whose result the module must refuse
//   (only for modules with output());
// - reviewer.envelope(review): the parsed output of a successful review;
// - reviewer.malformed: parsed outputs the module must refuse;
// - preflight.accepted / preflight.refused: hosts ({ version, platform }
//   and, for refused hosts, the expected reason, required and one of
//   PREFLIGHT_REASONS); an implementer needs at least one refused host;
// - reviewer.preflight.accepted / reviewer.preflight.refused: the same for a
//   reviewer with a preflight.
//
// The suite checks: the contract and the role rules (the same validation as
// the core), the few declarations visible in the argv (schema, output file,
// argv by mode), argv as a plain array of strings without forbidden
// arguments for every role, mode, effort and resume, the environment, the
// output parsers on valid and malformed envelopes, the session ID reading,
// the preflight and the probedVersions. It cannot check that the CLI keeps
// its sandbox, network or approval declarations: those rest on review of the
// module. Passing it does not replace the core's own checks.
import {
  GUARANTEES,
  PREFLIGHT_REASONS,
  PROVIDER_ROLES,
  ROLE_REQUIREMENTS,
  copyProviderArgs,
  forbiddenArgument,
  isProbedVersion,
  validateProviderModule,
} from './contract.mjs';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PATHS = Object.freeze({
  repositoryRoot: '/conformance/repo',
  schemaPath: '/conformance/run/output-schema.json',
  outputPath: '/conformance/run/round-1-output.json',
});
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string' } },
});
const ENVIRONMENT = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/conformance/home',
  CI: '1',
  NO_COLOR: '1',
});
const GUARD_BIN = '/conformance/guard-bin';
const REPORT = Object.freeze({ status: 'COMPLETED', summary: 'conformance' });
const REVIEW = Object.freeze({ verdict: 'APPROVE', findings: [] });
// Failures that must never allow a reviewer fallback.
const DENIAL_TEXTS = [
  'authentication failed: overloaded_error',
  'permission denied: model is not available',
  'invalid api key: usage limit reached',
  'policy violation: capacity unavailable',
];

function isDeepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// { value } or { text } with the expected JSON, as the core reads it.
function carries(output, expected) {
  if (!output || typeof output !== 'object') return false;
  if (Object.hasOwn(output, 'value')) return isDeepEqual(output.value, expected);
  if (typeof output.text !== 'string') return false;
  try {
    return isDeepEqual(JSON.parse(output.text), expected);
  } catch {
    return false;
  }
}

export function checkProviderConformance(candidate, fixtures = {}) {
  const failures = [];
  const warnings = [];
  let checks = 0;
  const check = (name, condition, message) => {
    checks += 1;
    if (!condition) failures.push({ check: name, message });
    return condition;
  };
  const attempt = (name, run) => {
    try {
      return run();
    } catch (error) {
      check(name, false, `threw ${error?.name ?? 'an error'}: ${error?.message ?? error}`);
      return undefined;
    }
  };

  let module;
  try {
    module = validateProviderModule(candidate);
    check('contract', true);
  } catch (error) {
    check('contract', false, error?.message ?? String(error));
    return { id: candidate?.id, checks, failures, warnings };
  }
  // Preflight: undefined or a known reason, and the fixtures' hosts.
  const checkPreflight = (role, preflight, hosts = {}, path) => {
    for (const host of [
      { version: '', platform: 'conformance-os' },
      { version: 'not a version', platform: 'win32' },
    ]) {
      const reason = attempt(`${role}.preflight`, () => preflight(host));
      check(
        `${role}.preflight`,
        reason === undefined || PREFLIGHT_REASONS.includes(reason),
        `preflight returns ${JSON.stringify(reason)}`,
      );
    }
    for (const host of hosts.accepted ?? [])
      check(
        `${role}.preflight`,
        attempt(`${role}.preflight`, () => preflight(host)) === undefined,
        `preflight refuses ${JSON.stringify(host)}`,
      );
    // A refused host names its reason from PREFLIGHT_REASONS: without one a
    // preflight that refuses nothing (returns undefined) would pass.
    for (const { reason, ...host } of hosts.refused ?? []) {
      if (
        !check(
          `${role}.fixtures`,
          PREFLIGHT_REASONS.includes(reason),
          `${path}.refused ${JSON.stringify(host)} has no reason from ${PREFLIGHT_REASONS.join(', ')}`,
        )
      )
        continue;
      check(
        `${role}.preflight`,
        attempt(`${role}.preflight`, () => preflight(host)) === reason,
        `preflight does not refuse ${JSON.stringify(host)} with ${reason}`,
      );
    }
    // A preflight that refuses no host does not restrict the CLI.
    check(
      `${role}.fixtures`,
      (hosts.refused ?? []).length > 0,
      `${path}.refused is empty (a preflight must refuse a host where the declarations were not checked)`,
    );
  };
  const model = fixtures.model ?? 'conformance-model';
  check(
    'model',
    attempt('model', () => module.isValidModel(model)) === true,
    `isValidModel(${JSON.stringify(model)}) is not true`,
  );
  check(
    'model',
    attempt('model', () => module.isValidModel('--model')) !== true &&
      attempt('model', () => module.isValidModel('')) !== true,
    'isValidModel accepts a flag or an empty value',
  );

  for (const role of PROVIDER_ROLES) {
    const definition = module[role];
    if (!definition) continue;
    // Declarations: every guarantee, and the ones the role needs enforced.
    check(
      `${role}.declaration`,
      GUARANTEES.every((name) => Object.hasOwn(definition.security, name)),
      'not every guarantee is declared',
    );
    for (const name of ROLE_REQUIREMENTS[role]) {
      check(
        `${role}.declaration`,
        definition.security[name].status === 'enforced',
        `${name} is not enforced`,
      );
    }
    // probedVersions (optional): every listed version, also as the output of
    // a version command, reads as probed; an unreadable output does not.
    for (const version of definition.probedVersions ?? []) {
      check(
        `${role}.probedVersions`,
        isProbedVersion(definition, version) &&
          isProbedVersion(definition, `${module.program} ${version}\n`),
        `probed version ${JSON.stringify(version)} reads as not probed`,
      );
    }
    if (definition.probedVersions)
      check(
        `${role}.probedVersions`,
        !isProbedVersion(definition, 'not a version'),
        'an unreadable version reads as probed',
      );

    // argv: every mode, effort and (implementer) resume.
    const argvFor = (input) =>
      attempt(`${role}.argv`, () => definition.processArgs(input));
    const byMode = {};
    for (const taskMode of definition.modes) {
      for (const effort of module.efforts) {
        for (const sessionId of role === 'implementer'
          ? [undefined, SESSION_ID]
          : [SESSION_ID]) {
          const input = {
            taskMode,
            model,
            effort,
            outputSchema: OUTPUT_SCHEMA,
            sessionId,
            ...(role === 'implementer' ? PATHS : {}),
          };
          // The same copy as the core makes: a plain array of string data
          // items (no proxy, getter or own every/some).
          const args = copyProviderArgs(argvFor(input));
          const label = `${taskMode}/${effort}/${sessionId ? 'resume' : 'new'}`;
          if (
            !check(
              `${role}.argv`,
              args !== undefined,
              `${label}: argv is not a plain array of strings`,
            )
          )
            continue;
          check(
            `${role}.argv`,
            isDeepEqual(argvFor(input), args),
            `${label}: argv differs between two calls`,
          );
          // The session ID is checked like any other argument.
          const exempt = [
            model,
            JSON.stringify(OUTPUT_SCHEMA),
            ...(role === 'implementer' ? Object.values(PATHS) : []),
          ];
          const forbidden = forbiddenArgument(module.program, args, {
            exempt,
            role,
          });
          check(
            `${role}.argv.forbidden`,
            !forbidden,
            `${label}: forbidden argument ${JSON.stringify(forbidden?.argument)} (${forbidden?.rule} rule)`,
          );
          check(
            `${role}.argv`,
            args.includes(model) &&
              args.some((arg) => arg.includes(effort)),
            `${label}: argv does not pass the model and effort`,
          );
          if (role === 'reviewer') {
            check(
              'reviewer.argv',
              !args.some((arg) => arg.includes(SESSION_ID)),
              `${label}: the reviewer argv passes a session ID`,
            );
          } else if (sessionId) {
            check(
              'implementer.argv.resume',
              args.includes(SESSION_ID),
              `${label}: the resumed argv does not pass the session ID`,
            );
          } else {
            check(
              'implementer.argv.resume',
              !args.some((arg) => arg.includes(SESSION_ID)),
              `${label}: a new round passes a session ID`,
            );
          }
          if (definition.security.schemaOutput.status === 'enforced')
            check(
              `${role}.declaration`,
              args.includes(JSON.stringify(OUTPUT_SCHEMA)) ||
                (role === 'implementer' && args.includes(PATHS.schemaPath)),
              `${label}: schemaOutput is enforced but argv does not pass the schema`,
            );
          if (role === 'implementer' && !definition.output)
            check(
              'implementer.argv',
              args.includes(PATHS.outputPath),
              `${label}: no output() and argv does not pass the output file`,
            );
          if (!sessionId || role === 'reviewer')
            byMode[taskMode] = JSON.stringify(args);
        }
      }
    }
    if (role === 'implementer' && definition.modes.length > 1)
      check(
        'implementer.argv.modes',
        byMode.implementation !== byMode.analysis,
        'implementation and analysis argv are the same (no sandbox by mode)',
      );

    // Environment: exactly the core's.
    const expected =
      role === 'implementer'
        ? { ...ENVIRONMENT, PATH: `${GUARD_BIN}:${ENVIRONMENT.PATH}` }
        : { ...ENVIRONMENT };
    const env = attempt(`${role}.environment`, () =>
      definition.processEnvironment(
        role === 'implementer'
          ? { environment: ENVIRONMENT, guardBin: GUARD_BIN }
          : { environment: ENVIRONMENT },
      ),
    );
    check(
      `${role}.environment`,
      env !== undefined &&
        isDeepEqual(Object.keys(env).sort(), Object.keys(expected).sort()) &&
        Object.keys(expected).every((key) => env[key] === expected[key]),
      'the environment is not exactly the core environment (guards first on PATH for the implementer)',
    );
  }

  const implementer = module.implementer;
  if (implementer) {
    const given = fixtures.implementer ?? {};
    if (
      check(
        'implementer.fixtures',
        typeof given.stdout === 'function',
        'fixtures.implementer.stdout(report, sessionId) is missing',
      )
    ) {
      const stdout = attempt('implementer.fixtures', () =>
        given.stdout(REPORT, SESSION_ID),
      );
      check(
        'implementer.session',
        attempt('implementer.session', () => implementer.sessionId(stdout)) ===
          SESSION_ID,
        'sessionId() does not read the session ID of a successful round',
      );
      if (implementer.output)
        check(
          'implementer.output',
          carries(attempt('implementer.output', () => implementer.output(stdout)), REPORT),
          'output() does not return the report of a successful round',
        );
    }
    for (const stdout of ['', 'not json', '[]', 'null', ...(given.withoutSession ?? [])])
      check(
        'implementer.session',
        attempt('implementer.session', () => implementer.sessionId(stdout)) ===
          undefined,
        `sessionId() returns a value for ${JSON.stringify(stdout).slice(0, 80)}`,
      );
    if (implementer.output) {
      check(
        'implementer.fixtures',
        (given.malformed ?? []).length > 0,
        'fixtures.implementer.malformed is empty',
      );
      for (const stdout of ['', 'not json', '[]', 'null', ...(given.malformed ?? [])])
        check(
          'implementer.output',
          attempt('implementer.output', () => implementer.output(stdout)) ===
            undefined,
          `output() accepts ${JSON.stringify(stdout).slice(0, 80)}`,
        );
    }

    checkPreflight('implementer', implementer.preflight, fixtures.preflight, 'fixtures.preflight');
  }

  const reviewer = module.reviewer;
  if (reviewer) {
    const given = fixtures.reviewer ?? {};
    if (
      check(
        'reviewer.fixtures',
        typeof given.envelope === 'function' && (given.malformed ?? []).length > 0,
        'fixtures.reviewer.envelope(review) or fixtures.reviewer.malformed is missing',
      )
    ) {
      const envelope = attempt('reviewer.fixtures', () => given.envelope(REVIEW));
      check(
        'reviewer.output',
        carries(attempt('reviewer.output', () => reviewer.reviewOutput(envelope)), REVIEW),
        'reviewOutput() does not return the review',
      );
      for (const value of given.malformed)
        check(
          'reviewer.output',
          attempt('reviewer.output', () => reviewer.reviewOutput(value)) ===
            undefined,
          `reviewOutput() accepts ${JSON.stringify(value).slice(0, 80)}`,
        );
    }
    // No fallback for an empty or unspecific failure, nor for a denial.
    for (const text of ['', 'process failed', ...DENIAL_TEXTS]) {
      const reason = attempt('reviewer.fallback', () => reviewer.fallbackReason(text));
      check(
        'reviewer.fallback',
        reason === undefined,
        `fallbackReason(${JSON.stringify(text)}) returns ${JSON.stringify(reason)}`,
      );
    }
    // The reviewer's preflight is optional; when present it is checked as
    // the implementer's.
    if (reviewer.preflight)
      checkPreflight(
        'reviewer',
        reviewer.preflight,
        given.preflight,
        'fixtures.reviewer.preflight',
      );
  }
  return { id: module.id, checks, failures, warnings };
}

// Throws an Error listing the failures; returns the result otherwise.
export function assertProviderConformance(module, fixtures) {
  const result = checkProviderConformance(module, fixtures);
  if (result.failures.length > 0)
    throw new Error(
      `Provider ${result.id} fails conformance:\n${result.failures
        .map(({ check, message }) => `- ${check}: ${message}`)
        .join('\n')}`,
    );
  return result;
}
