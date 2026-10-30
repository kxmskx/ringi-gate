// Validates the files in examples/ against the current runner core without
// starting any agent or process. Not part of `npm test`; run it with:
//   node --test examples/validate-examples.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertNoSecretContent,
  internal,
  validateTaskMarkdown,
} from '../scripts/agent-review-loop-lib.mjs';
import { PROFILE as CLI_PROFILE } from '../scripts/agent-review-profile.mjs';
import { assertProviderConformance } from '../scripts/providers/conformance.mjs';
import { PROFILE } from './project-profile.mjs';
import exampleProvider, {
  conformanceFixtures,
} from './providers/example-provider.mjs';

const taskMarkdown = await readFile(
  new URL('./task-add-health-endpoint.md', import.meta.url),
  'utf8',
);

test('example profile passes runner profile validation', () => {
  const resolved = internal.resolveRunnerProfile(PROFILE);
  assert.deepEqual(Object.keys(resolved.checks), Object.keys(PROFILE.checks));
  assert.deepEqual(resolved.checkSets.base, ['pnpm lint', 'git diff --check']);
  assert.equal(resolved.requiredGateRules[0].code, 'API_INTEGRATION_GATE');
});

test('example task passes the task parser with the example profile', () => {
  const task = validateTaskMarkdown(taskMarkdown, 'implementation', PROFILE);
  assert.equal(task.taskClass, 'implementation');
  assert.equal(task.quality.independentReviewRequired, true);
  assert.deepEqual(task.checks, [
    'pnpm lint',
    'git diff --check',
    'pnpm test',
    'pnpm --filter @example/api run test:integration',
  ]);
  assertNoSecretContent(taskMarkdown, 'examples/task-add-health-endpoint.md');
});

// The example task with the Polish section names (aliases of the 'en'
// default schema, canonical names of the 'pl' one).
const polishTaskMarkdown = [
  ['Task class', 'Klasa zadania'],
  ['Goal', 'Cel'],
  ['Scope', 'Zakres'],
  ['Starting files', 'Pliki startowe'],
  ['Allowed change area', 'Dozwolony obszar zmian'],
  ['Acceptance criteria', 'Kryteria akceptacji'],
  ['Required checks', 'Wymagane kontrole'],
  ['Constraints', 'Ograniczenia'],
  ['Deferred items', 'Elementy odłożone'],
].reduce(
  (markdown, [english, polish]) =>
    markdown.replace(`\n## ${english}\n`, `\n## ${polish}\n`),
  taskMarkdown,
);

test('example task uses the canonical section names of the en schema', () => {
  const { taskSchema } = internal.resolveRunnerProfile(PROFILE);
  const headings = [...taskMarkdown.matchAll(/^## (.+)$/gm)].map(([, title]) =>
    title.toLowerCase(),
  );
  assert.deepEqual(headings.toSorted(), [
    ...taskSchema.requiredSections,
    ...taskSchema.optionalSections.filter((name) => name !== 'review files'),
  ].toSorted());
  const task = validateTaskMarkdown(taskMarkdown, 'implementation', PROFILE);
  assert.deepEqual(Object.keys(task.sections), [
    'goal',
    'scope',
    'acceptance criteria',
    'required checks',
    'constraints',
    'deferred items',
    'task class',
    'starting files',
    'allowed change area',
  ]);
});

test('example task with Polish section headings parses the same', () => {
  assert.doesNotMatch(polishTaskMarkdown, /^## (?:Goal|Scope|Required checks)$/m);
  assert.match(polishTaskMarkdown, /^## Elementy odłożone$/m);
  // Polish names are aliases of the 'en' default schema...
  assert.deepEqual(
    validateTaskMarkdown(polishTaskMarkdown, 'implementation', PROFILE),
    validateTaskMarkdown(taskMarkdown, 'implementation', PROFILE),
  );
  // ...and the canonical names of the 'pl' one, where the English names
  // are aliases: both files parse the same, with Polish section keys.
  const polishProfile = { ...PROFILE, locale: 'pl' };
  const polish = validateTaskMarkdown(polishTaskMarkdown, 'implementation', polishProfile);
  assert.deepEqual(
    validateTaskMarkdown(taskMarkdown, 'implementation', polishProfile),
    polish,
  );
  assert.equal(polish.sections.cel, validateTaskMarkdown(taskMarkdown, 'implementation', PROFILE).sections.goal);
  assert.deepEqual(polish.checks, validateTaskMarkdown(taskMarkdown, 'implementation', PROFILE).checks);
});

test('example task is rejected by a profile without its checks', () => {
  // The profile the CLI imports has no integration check: the run stops in
  // preflight.
  assert.throws(
    () => validateTaskMarkdown(taskMarkdown, 'implementation', CLI_PROFILE),
    { code: 'UNSUPPORTED_CHECK' },
  );
});

test('profile validation is fail-closed', () => {
  const invalidProfiles = [
    { ...PROFILE, unknownKey: true },
    {
      ...PROFILE,
      checks: {
        ...PROFILE.checks,
        'pnpm install': { program: 'pnpm', args: ['install'], timeoutMs: 60_000 },
      },
    },
    {
      ...PROFILE,
      checks: {
        ...PROFILE.checks,
        'git status': { program: 'git', args: ['status'], timeoutMs: 60_000 },
      },
    },
    {
      ...PROFILE,
      requiredGateRules: [
        { ...PROFILE.requiredGateRules[0], code: 'API_INTEGRATION' },
      ],
    },
  ];
  for (const profile of invalidProfiles) {
    assert.throws(() => internal.resolveRunnerProfile(profile), {
      code: 'INVALID_CONFIGURATION',
    });
  }
});

test('task schema validation is fail-closed', () => {
  const schema = internal.resolveRunnerProfile(PROFILE).taskSchema;
  const invalidSchemas = [
    { ...schema, extra: true },
    { ...schema, aliases: { objective: 'goals' } },
    { ...schema, aliases: { aim: 'goal', AIM: 'scope' } },
    { ...schema, aliases: { goal: 'scope' } },
    // The core reads the required checks section; it must stay required.
    {
      ...schema,
      requiredSections: schema.requiredSections.filter(
        (name) => name !== 'required checks',
      ),
    },
    { ...schema, requiredSections: [] },
    { ...schema, requiredSections: [...schema.requiredSections, ''] },
  ];
  for (const taskSchema of invalidSchemas) {
    assert.throws(
      () => internal.resolveRunnerProfile({ ...PROFILE, taskSchema }),
      { code: 'INVALID_CONFIGURATION' },
    );
  }
  // The default schema, written out explicitly, is accepted unchanged.
  assert.deepEqual(
    internal.resolveRunnerProfile({ ...PROFILE, taskSchema: schema }).taskSchema,
    schema,
  );
});

test('example task classes select gates and review', () => {
  const withClass = (taskClass) =>
    validateTaskMarkdown(
      taskMarkdown.replace(
        '## Task class\n\nimplementation\n',
        `## Task class\n\n${taskClass}\n`,
      ),
      'implementation',
      PROFILE,
    );
  const typo = withClass('docs-typo');
  assert.equal(typo.quality.independentReviewRequired, false);
  assert.equal(typo.quality.policy, 'docs/task-classes.md');
  assert.deepEqual(typo.checks.slice(0, 2), ['pnpm docs:check', 'git diff --check']);
  const contract = withClass('docs-contract');
  assert.equal(contract.quality.independentReviewRequired, true);
  assert.equal(contract.quality.policy, 'docs/task-classes.md');
  assert.deepEqual(contract.checks, ['pnpm docs:check', 'git diff --check',
    'pnpm test', 'pnpm --filter @example/api run test:integration']);
  // Classes the profile does not declare are rejected.
  assert.throws(() => withClass('critical'), { code: 'INVALID_TASK_CLASS' });
});

test('example roles select provider, model, effort and review profiles', () => {
  const { implementer, reviewer } = internal.resolveRunnerProfile(PROFILE);
  assert.deepEqual(implementer, PROFILE.implementer);
  assert.deepEqual(reviewer, PROFILE.reviewer);
  assert.deepEqual(internal.resolveReviewProfile(undefined, reviewer), {
    profile: 'standard',
    attempts: PROFILE.reviewer.profiles.standard,
    fallbackAllowed: false,
  });
  // Claude may also be the implementer, with efforts from its allowlist.
  const claudeImplementer = {
    provider: 'claude',
    model: 'claude-opus-5',
    effort: 'high',
    allowedEfforts: ['medium', 'high'],
  };
  assert.deepEqual(
    internal.resolveRunnerProfile({ ...PROFILE, implementer: claudeImplementer })
      .implementer,
    claudeImplementer,
  );
  const invalidProfiles = [
    // Codex is not a reviewer in the core.
    { ...PROFILE, reviewer: { ...PROFILE.reviewer, provider: 'codex' } },
    // Effort outside the claude allowlist (max is not planned for claude).
    {
      ...PROFILE,
      implementer: { ...claudeImplementer, allowedEfforts: ['high', 'max'] },
    },
    // Effort outside the profile allowlist.
    { ...PROFILE, implementer: { ...PROFILE.implementer, effort: 'max' } },
    // Default profile that does not exist.
    { ...PROFILE, reviewer: { ...PROFILE.reviewer, defaultProfile: 'economy' } },
    // Empty review profiles.
    { ...PROFILE, reviewer: { ...PROFILE.reviewer, profiles: {} } },
  ];
  for (const profile of invalidProfiles) {
    assert.throws(() => internal.resolveRunnerProfile(profile), {
      code: 'INVALID_CONFIGURATION',
    });
  }
});

test('example provider passes conformance and registers in the example profile', () => {
  const result = assertProviderConformance(exampleProvider, conformanceFixtures);
  assert.deepEqual(result.warnings, []);
  const implementer = {
    provider: 'example-agent',
    model: 'example-large-1',
    effort: 'medium',
    allowedEfforts: ['low', 'medium', 'high'],
  };
  const resolved = internal.resolveRunnerProfile({
    ...PROFILE,
    providerModules: [exampleProvider],
    implementer,
  });
  assert.deepEqual(resolved.implementer, implementer);
  assert.equal(resolved.providerModules[0], exampleProvider);
  // Without the module the provider is unknown; a path is not a module.
  for (const profile of [
    { ...PROFILE, implementer },
    {
      ...PROFILE,
      providerModules: ['./providers/example-provider.mjs'],
      implementer,
    },
  ]) {
    assert.throws(() => internal.resolveRunnerProfile(profile), {
      code: 'INVALID_CONFIGURATION',
    });
  }
  // An implementer without an enforced sandbox is refused by the core.
  const noSandbox = {
    ...exampleProvider,
    implementer: {
      ...exampleProvider.implementer,
      security: {
        ...exampleProvider.implementer.security,
        sandboxByMode: { status: 'not-supported', reason: 'No sandbox.' },
      },
    },
  };
  assert.throws(
    () =>
      internal.resolveRunnerProfile({ ...PROFILE, providerModules: [noSandbox] }),
    { code: 'PROVIDER_ROLE_NOT_ALLOWED' },
  );
});

test('task class and docs rule validation is fail-closed', () => {
  const { taskClasses: classes, docsCandidatePolicy: docsPolicy } = PROFILE;
  const invalidProfiles = [
    // Review skipped without the docs rule.
    {
      ...PROFILE,
      taskClasses: {
        ...classes,
        quick: { ...classes.implementation, independentReviewRequired: false },
      },
    },
    // Check set that does not exist.
    {
      ...PROFILE,
      taskClasses: {
        ...classes,
        'docs-typo': { ...classes['docs-typo'], checkSet: 'full' },
      },
    },
    // No implementation class.
    { ...PROFILE, taskClasses: { 'docs-typo': classes['docs-typo'] } },
    // Base exclusions removed.
    {
      ...PROFILE,
      docsCandidatePolicy: { ...docsPolicy, excludedNames: ['SECURITY.md'] },
    },
    // Nothing allowed for docs classes.
    {
      ...PROFILE,
      docsCandidatePolicy: { ...docsPolicy, allowedPaths: [], allowedPrefixes: [] },
    },
  ];
  for (const profile of invalidProfiles) {
    assert.throws(() => internal.resolveRunnerProfile(profile), {
      code: 'INVALID_CONFIGURATION',
    });
  }
});

// Stub runner: answers `git diff` with the given paths (NUL-separated, like `git diff -z`)
// and anything else with empty output, so no process starts
const candidateRunner = (paths) => ({
  async run(program, args) {
    return {
      code: 0, signal: null,
      stdout: args[0] === 'diff' ? paths.map((path) => `${path}\0`).join('') : '',
      stderr: '', timedOut: false,
    };
  },
});

test('docs candidate rule accepts handbook/ when the profile adds it', async () => {
  const { docsCandidatePolicy: docsPolicy } = PROFILE;
  const profile = {
    ...PROFILE,
    docsCandidatePolicy: {
      ...docsPolicy,
      allowedPrefixes: [...docsPolicy.allowedPrefixes, 'handbook/'],
      excludedPrefixes: [...docsPolicy.excludedPrefixes, 'handbook/agents/'],
    },
  };
  const check = (paths) =>
    internal.assertDocsCandidate({
      runner: candidateRunner(paths),
      cwd: '/synthetic/repository',
      stage: 'post-implementer',
      profile,
    });
  // handbook/ is allowed because the profile adds it, as in docs/profile.md.
  await check(['handbook/guide.md']);
  // The exclusions and the extension list still apply
  for (const path of ['handbook/agents/notes.md', 'SECURITY.md', 'handbook/data.json']) {
    await assert.rejects(() => check([path]), { code: 'DOCS_CANDIDATE_REJECTED' });
  }
});

// A text check of the example workflow of ringi ci, not a YAML parser (no
// dependency): its events, permissions, pinned actions, concurrency, the
// draft rule, the always-running aggregator and the job lists of its lanes.
test('example ringi ci workflow keeps the rules of docs/ci.md', async () => {
  const text = await readFile(
    new URL('./github-actions/ringi-ci.yml', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(text, /\t/);
  // Events: the pull request types (edited for a change of the base branch)
  // and a push to the default branch only.
  assert.match(
    text,
    /^on:\n {2}pull_request:\n {4}types: \[opened, edited, synchronize, reopened, ready_for_review, converted_to_draft\]\n {2}push:\n {4}branches: \[main\]\n\n/m,
  );
  // No job depends on what an edit changed: a skipped job would pass.
  assert.doesNotMatch(text, /github\.event\.changes/);
  // ringi-gate comes from the project's pnpm lockfile, without install
  // scripts, and runs with pnpm exec.
  assert.doesNotMatch(text, /\bnpx\b|\bnpm (?:ci|install)\b/);
  const ringiCalls = [...text.matchAll(/^ {10}pnpm exec ringi ci (classify|aggregate) /gm)];
  assert.deepEqual(ringiCalls.map(([, command]) => command), ['classify', 'aggregate']);
  assert.equal(
    [...text.matchAll(/^ {10}corepack enable pnpm\n {10}pnpm install --frozen-lockfile --ignore-scripts\n/gm)].length,
    2,
  );
  assert.doesNotMatch(
    text,
    /pull_request_target|workflow_run|paths-ignore|paths:|skip-ci|skip ci|ci skip/,
  );
  // No secrets, no token, no write permission.
  assert.doesNotMatch(text, /secrets|TOKEN|github\.token|id-token|write/i);
  assert.match(text, /^permissions:\n {2}contents: read\n\n/m);
  assert.equal([...text.matchAll(/permissions:/g)].length, 1);
  // Actions of actions/* only, pinned to a commit SHA; every checkout
  // without persisted credentials.
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(.+)$/gm)].map(([, value]) => value);
  assert.ok(uses.length >= 4);
  for (const value of uses)
    assert.match(value, /^actions\/(?:checkout|setup-node)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, value);
  const checkouts = uses.filter((value) => value.startsWith('actions/checkout@')).length;
  assert.equal([...text.matchAll(/^ {10}persist-credentials: false$/gm)].length, checkouts);
  // Concurrency: the workflow and the pull request number; a push has a
  // group of its own (run_id) and only a pull request cancels.
  assert.match(
    text,
    /^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| format\('run-\{0\}', github\.run_id\) \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/m,
  );
  // Jobs and their conditions.
  const jobsText = text.slice(text.indexOf('\njobs:\n'));
  const jobs = [...jobsText.matchAll(/^ {2}([a-z][a-z-]*):\n/gm)].map(([, id]) => id);
  assert.deepEqual(jobs, ['classify', 'whitespace', 'test', 'required']);
  const job = (id) => {
    const start = jobsText.indexOf(`\n  ${id}:\n`);
    const next = jobs[jobs.indexOf(id) + 1];
    return jobsText.slice(start, next ? jobsText.indexOf(`\n  ${next}:\n`) : undefined);
  };
  assert.doesNotMatch(job('classify'), /^ {4}if:/m);
  assert.match(job('classify'), /ringi ci classify --base "\$base" --head "\$head" >> "\$GITHUB_OUTPUT"/);
  assert.match(job('classify'), /test "\$\(git rev-parse HEAD\^2\)" = "\$PR_HEAD"/);
  assert.match(job('whitespace'), /^ {4}if: github\.event\.pull_request\.draft != true$/m);
  assert.match(
    job('test'),
    /^ {4}if: needs\.classify\.outputs\.lane == 'full' && github\.event\.pull_request\.draft != true$/m,
  );
  // The aggregator always runs, under a fixed name, red for a draft, and
  // its job lists are the jobs it needs.
  const required = job('required');
  assert.match(required, /^ {4}name: ringi-ci required$/m);
  assert.match(required, /^ {4}if: always\(\)$/m);
  assert.equal([...text.matchAll(/always\(\)/g)].length, 2, 'the job and its comment');
  assert.doesNotMatch(text, /success\(\)|continue-on-error/);
  assert.match(
    required,
    /- name: A draft is not ready\n {8}if: github\.event\.pull_request\.draft == true\n {8}run: \|\n(?: {10}.+\n)+ {10}exit 1\n/,
  );
  const aggregate = required.match(
    /ringi ci aggregate --lane "\$LANE" --needs "\$RUNNER_TEMP\/needs\.json" --classify-job (\S+) --docs-jobs (\S+) --full-jobs (\S+)\n/,
  );
  assert.ok(aggregate);
  const [, classifyJob, docsJobs, fullJobs] = aggregate;
  assert.equal(classifyJob, 'classify');
  assert.ok(docsJobs.split(',').every((id) => fullJobs.split(',').includes(id)));
  assert.match(required, new RegExp(`^ {4}needs: \\[${[classifyJob, ...fullJobs.split(',')].join(', ')}\\]$`, 'm'));
  assert.match(required, /NEEDS: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(required, /LANE: \$\{\{ needs\.classify\.outputs\.lane \|\| 'full' \}\}/);
  // Expressions reach the scripts through the environment only.
  for (const [, script] of text.matchAll(/run: \|\n((?: {10}.*\n)+)/g))
    assert.doesNotMatch(script, /\$\{\{/, script);
  // The ci section of the header is valid with the example profile's checks.
  const resolved = internal.resolveRunnerProfile({
    ...PROFILE,
    ci: {
      docsPaths: ['README.md', 'docs/'],
      lanes: {
        docs: ['git diff --check'],
        full: ['git diff --check', 'pnpm test'],
      },
    },
  });
  assert.deepEqual(resolved.ci.lanes.full, ['git diff --check', 'pnpm test']);
  assert.match(text, /docs: \['git diff --check'\],\n#\s+full: \['git diff --check', 'pnpm test'\],/);
});

test('required gate rule without message uses the default text', async () => {
  const [{ message, ...ruleWithoutMessage }] = PROFILE.requiredGateRules;
  const profile = { ...PROFILE, requiredGateRules: [ruleWithoutMessage] };
  const [rule] = internal.resolveRunnerProfile(profile).requiredGateRules;
  assert.equal(rule.message, undefined);
  const run = (checks) =>
    internal.assertRequiredGates({
      runner: candidateRunner(['packages/api/schema.sql']),
      cwd: '/synthetic/repository',
      stage: 'post-implementer',
      task: { mode: 'implementation', checks },
      profile,
    });
  // Touching the rule's paths without requesting its check stops the run
  await assert.rejects(() => run(['pnpm lint']), {
    code: 'API_INTEGRATION_GATE',
    message: /pnpm --filter @example\/api run test:integration/,
  });
  // With the check requested, the rule does not apply.
  await run(['pnpm lint', 'pnpm --filter @example/api run test:integration']);
});
