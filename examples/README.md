# Examples

Synthetic files for an imaginary pnpm monorepo. They are not used by the
runner; `npm test` uses only the template provider.

| File | What it is |
| --- | --- |
| [`project-profile.mjs`](project-profile.mjs) | A project profile with the same shape as `scripts/agent-review-profile.mjs`. The CLI imports the profile from that module only; it does not load profiles from other paths. To use this example, its contents would replace that file. |
| [`task-add-health-endpoint.md`](task-add-health-endpoint.md) | An implementation task in the format accepted by the current task parser. It uses the English canonical section names of the default task schema (`locale: 'en'`); the Polish names listed in [docs/architecture.md](../docs/architecture.md#task-file) are accepted as aliases of the same sections. Body text can be in any language. |
| [`providers/example-provider.mjs`](providers/example-provider.mjs) | A template provider module for a fictional agent CLI (`example-agent`), with its conformance fixtures. No such CLI exists; copy it as a starting point for a new provider (see [docs/providers.md](../docs/providers.md)). |
| [`validate-examples.test.mjs`](validate-examples.test.mjs) | Checks these files against the runner core without starting agents. |

Run the check from the repository root:

```sh
node --test examples/validate-examples.test.mjs
```

It verifies that:

- the profile is accepted by the runner's profile validation;
- the task is accepted by `validateTaskMarkdown` with the example profile, and
  its effective checks are the profile's `base` set followed by the checks
  requested in the task;
- the task's headings are the canonical section names of the `'en'` default
  schema, and the same task with Polish section headings gives the same
  parse result (with `locale: 'pl'` too, keyed by the Polish names);
- the same task is rejected with `UNSUPPORTED_CHECK` under the profile the
  CLI uses (`PROFILE` from `scripts/agent-review-profile.mjs`), which does not
  define the integration check;
- the profile's task classes select the check set and the review decision
  (for docs-contract, the docs set followed by the checks requested in the
  task), and a class the profile does not declare is rejected with
  `INVALID_TASK_CLASS`;
- a few invalid profile variants, including invalid task schemas, task
  classes and docs candidate rules, are rejected with `INVALID_CONFIGURATION`;
- the template provider passes the provider conformance suite, can be
  registered with `providerModules` in the example profile, and a variant
  without an enforced sandbox is refused with `PROVIDER_ROLE_NOT_ALLOWED`.
- the docs candidate rule accepts `handbook/` when the profile adds it (as in
  [docs/profile.md](../docs/profile.md#docscandidatepolicy)), and still
  rejects `handbook/agents/`, `SECURITY.md` and files that are not `.md`,
  with `DOCS_CANDIDATE_REJECTED`;
- a `requiredGateRules` entry without `message` is accepted, and touching its
  paths without requesting its check stops with the rule's `code` and the
  default text, which names the check.
