#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE } from './agent-review-profile.mjs';
import { runAgentReviewLoop } from './agent-review-loop-lib.mjs';
import {
  formatAgentUsage,
  parseAgentArguments,
} from './agent-review-dashboard.mjs';
import { runWithPresentation } from './ringi-presentation.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Options, usage and messages follow the profile (roles and locale).
const parsed = parseAgentArguments(process.argv.slice(2), PROFILE);
const usage = formatAgentUsage(PROFILE);

if (parsed.error) {
  console.error(`${parsed.error}\n${usage}`);
  process.exitCode = 2;
} else {
  // The loop, the presentation and the exit code: the flow of `ringi run`.
  // A stopped run sets process.exitCode before the hooks' flush and
  // dispose; a completed run leaves it unset, as before.
  await runWithPresentation({
    profile: PROFILE,
    repositoryRoot,
    parsed,
    runAgentReviewLoop,
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
}
