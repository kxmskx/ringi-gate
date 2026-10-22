import {
  internal,
  isValidCodexModel,
  DEFAULT_TASK_MODE,
  REVIEW_PROFILES,
  SOL_EFFORTS,
  TASK_MODES,
  redactSensitive,
  resolveReviewProfile,
} from './agent-review-loop-lib.mjs';
import { currentLocale, t } from './messages/index.mjs';

const ANSI = {
  hideCursor: '\u001b[?25l',
  showCursor: '\u001b[?25h',
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  // Explicit RGB bypasses the terminal theme's configurable ANSI 16 palette.
  cyan: '\u001b[38;2;34;211;238m',
  green: '\u001b[38;2;74;222;128m',
  amber: '\u001b[38;2;251;191;36m',
  red: '\u001b[38;2;248;113;113m',
  violet: '\u001b[38;2;167;139;250m',
  enterScreen: '\u001b[?1049h',
  leaveScreen: '\u001b[?1049l',
  home: '\u001b[H',
  clearScreen: '\u001b[2J',
};

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const GATE_FRAMES = ['·', '•', '·', '◦'];
const CLAUDE_FRAMES = ['◇', '◆', '◇', '◈'];
const SEVERITIES = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'];
const MIN_INTERACTIVE_WIDTH = 12;
const INTERACTIVE_RIGHT_MARGIN = 1;
// Usage values of the core defaults; the CLI lists those of its profile.
export const REVIEW_PROFILE_USAGE = Object.keys(REVIEW_PROFILES).join('|');
export const SOL_EFFORT_USAGE = SOL_EFFORTS.join('|');
export const TASK_MODE_USAGE = TASK_MODES.join('|');

function formatBooleanChoice(value, locale) {
  if (value === undefined) return '—';
  return t(locale, value ? 'dashboard.yes' : 'dashboard.no');
}

// The locale of the view: the dashboard's profile, otherwise the caller's.
function stateLocale(state) {
  return state.locale ?? currentLocale();
}

export function stripAnsi(value) {
  return (
    String(value)
      // OSC, DCS, SOS, PM and APC, including their C1 representations.
      .replace(
        /(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c|$)/g,
        '',
      )
      .replace(
        /(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g,
        '',
      )
      .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b[ -/]*[@-~]/g, '')
      .replace(
        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
        '',
      )
  );
}

function cleanText(value, width = 120) {
  return truncateToWidth(
    redactSensitive(stripAnsi(value ?? '—'))
      .replace(/\s+/g, ' ')
      .trim(),
    width,
  );
}

export function formatErrorDiagnostic(
  report,
  redact = (value) => value,
  locale = currentLocale(),
) {
  const field = (value, fallback, maximumWidth) =>
    truncateToWidth(redact(stripAnsi(value ?? fallback)), maximumWidth);
  return [
    `code=${field(report?.code, 'STOPPED', 80)}`,
    `stage=${field(report?.stage, 'workflow', 80)}`,
    `error=${field(report?.error, t(locale, 'dashboard.noDetails'), 500)}`,
    `resume=${field(
      report?.resume,
      t(locale, 'dashboard.defaultResume'),
      500,
    )}`,
  ].join(' | ');
}

function isCombining(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0xfe0f ||
    codePoint === 0x200d
  );
}

function isWide(codePoint) {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

const graphemes = new Intl.Segmenter('pl', { granularity: 'grapheme' });

export function stringWidth(value) {
  let width = 0;
  for (const { segment } of graphemes.segment(stripAnsi(value))) {
    if (
      /\p{Regional_Indicator}|\u20e3/u.test(segment) ||
      (/\p{Extended_Pictographic}/u.test(segment) &&
        /\ufe0f|\u200d/u.test(segment))
    ) {
      width += 2;
      continue;
    }
    for (const character of segment) {
      const codePoint = character.codePointAt(0);
      if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
      if (
        isCombining(codePoint) ||
        /\p{Mark}|\p{Emoji_Modifier}|[\u{e0020}-\u{e007f}]/u.test(character)
      )
        continue;
      width += isWide(codePoint) ? 2 : 1;
    }
  }
  return width;
}

export function truncateToWidth(value, maximumWidth) {
  const clean = String(value).replace(/[\r\n\t]/g, ' ');
  if (maximumWidth <= 0) return '';
  if (stringWidth(clean) <= maximumWidth) return clean;
  let result = '';
  let width = 0;
  const tokens = clean
    .split(/(\u001b\[[0-?]*[ -/]*[@-~])/g)
    .flatMap((part) =>
      part.startsWith('\u001b')
        ? [part]
        : [...graphemes.segment(part)].map(({ segment }) => segment),
    );
  for (const token of tokens) {
    const characterWidth = stringWidth(token);
    if (characterWidth === 0) {
      result += token;
      continue;
    }
    if (width + characterWidth > maximumWidth - 1) break;
    result += token;
    width += characterWidth;
  }
  const reset = result.includes('\u001b') ? ANSI.reset : '';
  return `${result}…${reset}`;
}

function padToWidth(value, width) {
  const truncated = truncateToWidth(value, width);
  return `${truncated}${' '.repeat(Math.max(0, width - stringWidth(truncated)))}`;
}

export function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return '—';
  const safe = Math.max(0, Math.round(durationMs));
  if (safe < 10_000) return `${(safe / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.floor(safe / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function validCounts(counts) {
  return (
    counts &&
    SEVERITIES.every(
      (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
    )
  );
}

function reviewCounts(state) {
  const reviewed = state.result?.rounds
    ?.filter((round) => Array.isArray(round.claude?.findings))
    .at(-1);
  if (!state.reviewRound && !reviewed) return undefined;
  if (validCounts(state.result?.findingPolicy?.unresolved))
    return state.result.findingPolicy.unresolved;
  if (reviewed) {
    const counts = Object.fromEntries(SEVERITIES.map((key) => [key, 0]));
    for (const finding of reviewed.claude.findings) {
      if (Object.hasOwn(counts, finding.severity)) counts[finding.severity]++;
    }
    return counts;
  }
  return state.unresolved;
}

// Presentation only: unknown codes fail closed, without changing report.status.
export function terminalOutcome(report) {
  if (report?.code === 'INTERRUPTED' || report?.status === 'CANCELLED')
    return 'CANCELLED';
  if (
    [
      'HUMAN_DECISION_REQUIRED',
      'NEW_PERMISSION_REQUIRED',
      'FINDING_DISPUTE',
      'MAX_ROUNDS',
    ].includes(report?.code) ||
    ['NEEDS_HUMAN', 'NEEDS_HUMAN_DECISION', 'NEEDS_PERMISSION'].includes(
      report?.status,
    )
  )
    return 'NEEDS DECISION';
  if (report?.status === 'APPROVE' && !report.code) return 'APPROVE';
  return 'FAILED';
}

function boundedCount(value, maximum = 1000) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

export function gateProgress(state) {
  const stages = state.stages.filter(
    (stage) =>
      stage.round === state.round &&
      ['QUALITY GATES', 'GATES'].includes(stage.badge),
  );
  return {
    completed: stages.filter((stage) => ['PASS', 'FAIL'].includes(stage.status))
      .length,
    passed: stages.filter((stage) => stage.status === 'PASS').length,
    total: boundedCount(state.gateCount),
    active: stages.find((stage) => stage.status === 'ACTIVE'),
    stages,
  };
}

function phaseColor(name) {
  if (name === 'CLAUDE') return ANSI.violet;
  if (['GATES', 'QUALITY GATES', 'INTEGRITY'].includes(name)) return ANSI.amber;
  return ANSI.cyan;
}

function useColor(value, color, enabled) {
  return enabled ? `${color}${value}${ANSI.reset}` : value;
}

function statusMark(status, color) {
  if (status === 'PASS' || status === 'APPROVE') {
    return useColor('✓', ANSI.green, color);
  }
  if (
    ['FAIL', 'STOPPED', 'FAILED', 'CANCELLED', 'NEEDS DECISION'].includes(
      status,
    )
  ) {
    return useColor('✗', ANSI.red, color);
  }
  if (status === 'FALLBACK') return useColor('↪', ANSI.amber, color);
  return '·';
}

function stageLine(stage, nowMs, frame, color, width) {
  if (!stage) return undefined;
  const active = stage.status === 'ACTIVE';
  const frames = ['QUALITY GATES', 'GATES'].includes(stage.badge)
    ? GATE_FRAMES
    : stage.badge === 'CLAUDE'
      ? CLAUDE_FRAMES
      : SPINNER_FRAMES;
  const mark = active
    ? useColor(frames[frame % frames.length], phaseColor(stage.badge), color)
    : statusMark(stage.status, color);
  const duration = active ? nowMs - stage.startedAt : stage.durationMs;
  const suffix =
    stage.testCount === undefined ? '' : ` · ${stage.testCount} tests`;
  const prefix = `${mark} ${stage.badgeLabel ?? stage.badge}  `;
  const timing = ` · ${formatDuration(duration)}${suffix}`;
  const labelWidth = Math.max(0, width - stringWidth(prefix + timing));
  return truncateToWidth(
    `${prefix}${cleanText(stage.label, labelWidth)}${timing}`,
    width,
  );
}

const phaseName = (badge) =>
  badge === 'SOL' ? 'CODEX' : badge === 'QUALITY GATES' ? 'GATES' : badge;

const phaseLabel = (name, state) =>
  name === 'CODEX'
    ? cleanText(
        state.solModel ??
          state.result?.sol?.plannedModel ??
          state.stages.findLast((stage) => stage.badge === 'SOL' && stage.model)
            ?.model ??
          'CODEX',
      )
    : name;

export function dashboardPhases(state) {
  return [
    'PREFLIGHT',
    'CODEX',
    state.taskMode === 'analysis' ? 'INTEGRITY' : 'GATES',
    'SNAPSHOT',
    'CLAUDE',
  ].map((name) => {
    const stages = state.stages.filter(
      (stage) =>
        phaseName(stage.badge) === name &&
        (name === 'PREFLIGHT' || stage.round === state.round),
    );
    const last = stages.at(-1);
    let status = last?.status ?? 'WAITING';
    if (
      ['SNAPSHOT', 'CLAUDE'].includes(name) &&
      (state.quality ?? state.result?.quality)?.independentReviewRequired ===
        false
    )
      status = 'NOT_REQUIRED';
    if (
      name === 'GATES' &&
      status === 'PASS' &&
      stages.filter((stage) => stage.status === 'PASS').length !==
        state.gateCount
    )
      status = 'ACTIVE';
    if (state.result && status === 'ACTIVE') status = 'STOPPED';
    return {
      name,
      status,
      fallback: stages.some((stage) => stage.fallback),
    };
  });
}

function bordered(lines, width, color) {
  const innerWidth = Math.max(1, width - 4);
  const top = `┌${'─'.repeat(width - 2)}┐`;
  const bottom = `└${'─'.repeat(width - 2)}┘`;
  return [
    useColor(top, `${ANSI.dim}${ANSI.cyan}`, color),
    ...lines.map((line) => `│ ${padToWidth(line, innerWidth)} │`),
    useColor(bottom, `${ANSI.dim}${ANSI.cyan}`, color),
  ];
}

export function createDashboardState({
  profile,
  taskPath,
  taskMode = DEFAULT_TASK_MODE,
  maxRounds,
  nowMs = 0,
  demo = false,
}) {
  return {
    title: internal.resolveRunnerProfile(profile).title,
    locale: internal.profileLocale(profile),
    taskPath,
    taskMode,
    demo,
    maxRounds,
    runId: undefined,
    reportPath: undefined,
    branch: undefined,
    solModel: undefined,
    solEffort: undefined,
    reviewProfile: undefined,
    reviewAttempts: [],
    unresolved: undefined,
    reviewRound: undefined,
    feed: [],
    gateCount: undefined,
    reviewFallbackAllowed: undefined,
    round: 0,
    startedAt: nowMs,
    updatedAt: nowMs,
    stages: [],
    result: undefined,
  };
}

export function reduceDashboardEvent(state, event, nowMs) {
  state.updatedAt = nowMs;
  if (event.type === 'metadata') {
    Object.assign(state, {
      branch: event.branch ?? state.branch,
      runId: event.runId ?? state.runId,
      reportPath: event.reportPath ?? state.reportPath,
      solModel: event.solModel ?? state.solModel,
      solEffort: event.solEffort ?? state.solEffort,
      reviewProfile: event.reviewProfile ?? state.reviewProfile,
      reviewAttempts: event.reviewAttempts ?? state.reviewAttempts,
      reviewFallbackAllowed:
        event.reviewFallbackAllowed ?? state.reviewFallbackAllowed,
      taskMode: event.taskMode ?? state.taskMode,
      quality: event.quality ?? state.quality,
      effectiveGates: event.effectiveGates ?? state.effectiveGates,
    });
  } else if (event.type === 'round:start') {
    state.round = event.round;
    state.gateCount = event.gateCount;
    state.integrityCount = event.integrityCount;
    state.maxRounds = event.maxRounds ?? state.maxRounds;
  } else if (event.type === 'stage:start') {
    if (
      state.stages.some(
        (stage) => stage.round === state.round && stage.id === event.id,
      )
    )
      return state;
    state.stages.push({
      id: event.id,
      round: state.round,
      badge: [
        'PREFLIGHT',
        'SOL',
        'QUALITY GATES',
        'INTEGRITY',
        'SNAPSHOT',
        'CLAUDE',
      ].includes(event.badge)
        ? event.badge
        : 'UNKNOWN',
      label: cleanText(event.label),
      model: event.model,
      effort: event.effort,
      attempt: event.attempt,
      attemptLimit: event.attemptLimit,
      fallback:
        event.badge === 'CLAUDE' &&
        state.stages.some(
          (stage) =>
            stage.round === state.round &&
            stage.badge === 'CLAUDE' &&
            stage.status === 'FALLBACK',
        ),
      status: 'ACTIVE',
      startedAt: nowMs,
    });
  } else if (event.type === 'stage:end') {
    const stage = [...state.stages]
      .reverse()
      .find(({ id, round }) => id === event.id && round === state.round);
    if (stage) {
      stage.status = ['PASS', 'FAIL', 'FALLBACK'].includes(event.status)
        ? event.status
        : 'STOPPED';
      stage.durationMs = event.durationMs ?? nowMs - stage.startedAt;
      if (event.testCount !== undefined) stage.testCount = event.testCount;
      if (event.controlCount !== undefined)
        stage.controlCount = event.controlCount;
    }
  } else if (event.type === 'findings') {
    if (validCounts(event.unresolved)) {
      state.unresolved = { ...event.unresolved };
      state.reviewRound = state.round;
    }
  } else if (event.type === 'result') {
    state.result = event.report;
    state.finishedAt = nowMs;
    for (const stage of state.stages) {
      if (stage.status === 'ACTIVE') {
        stage.status = 'STOPPED';
        stage.durationMs = nowMs - stage.startedAt;
      }
    }
    state.reportPath = event.reportPath ?? state.reportPath;
  }
  const locale = stateLocale(state);
  let transition;
  if (event.type === 'round:start')
    transition = t(locale, 'dashboard.feedRoundStart', {
      round: boundedCount(state.round, 3) ?? '—',
    });
  if (['stage:start', 'stage:end'].includes(event.type)) {
    const stage = state.stages.findLast(
      (entry) => entry.id === event.id && entry.round === state.round,
    );
    const phase = phaseName(stage?.badge);
    if (
      [
        'PREFLIGHT',
        'CODEX',
        'GATES',
        'INTEGRITY',
        'SNAPSHOT',
        'CLAUDE',
      ].includes(phase)
    ) {
      const status =
        event.type === 'stage:start'
          ? 'START'
          : ['PASS', 'FAIL', 'FALLBACK'].includes(event.status)
            ? event.status
            : 'STOPPED';
      transition = `${phaseLabel(phase, state)} · ${status === 'FALLBACK' ? t(locale, 'dashboard.feedWaiting') : status}`;
    }
  }
  if (event.type === 'findings' && state.reviewRound)
    transition = t(locale, 'dashboard.feedReviewResult');
  if (event.type === 'result') transition = terminalOutcome(state.result);
  if (transition)
    state.feed = [...state.feed, cleanText(transition, 64)].slice(-3);
  return state;
}

export function renderDashboard(
  state,
  {
    width = 80,
    height = 24,
    nowMs = state.startedAt,
    frame = 0,
    color = false,
  } = {},
) {
  const safeWidth = Number.isFinite(width)
    ? Math.max(1, Math.min(160, Math.floor(width)))
    : 80;
  const safeHeight = Number.isFinite(height)
    ? Math.max(1, Math.floor(height))
    : 24;
  const now = state.finishedAt ?? nowMs;
  const total = formatDuration(
    state.result?.durationMs ?? now - state.startedAt,
  );
  const locale = stateLocale(state);
  const yesNo = (value) => formatBooleanChoice(value, locale);
  const round = t(locale, 'dashboard.round', {
    round: boundedCount(state.round, 3) || '—',
    max: boundedCount(state.maxRounds, 3) ?? '—',
  });
  const phases = dashboardPhases(state);
  const latest = state.stages
    .filter(
      (stage) => stage.round === state.round || stage.badge === 'PREFLIGHT',
    )
    .at(-1);
  const gates = gateProgress(state);
  const gateLabel = `GATES ${gates.completed}/${gates.total ?? '—'}`;
  const outcome = state.result ? terminalOutcome(state.result) : undefined;
  const counts = reviewCounts(state);
  const severity = SEVERITIES.map(
    (key) => `${key[0]}:${counts?.[key] ?? '—'}`,
  ).join(' ');
  const reviewLabel = t(
    locale,
    !counts
      ? 'dashboard.beforeReview'
      : state.reviewRound && state.reviewRound < state.round
        ? 'dashboard.lastKnownResult'
        : 'dashboard.reviewResult',
  );
  const activeName = phaseName(latest?.badge) ?? 'PREFLIGHT';
  const activeLabel = phaseLabel(activeName, state);
  const active =
    stageLine(
      latest && { ...latest, badgeLabel: activeLabel },
      now,
      frame,
      color,
      safeWidth - 4,
    ) ?? t(locale, 'dashboard.waitingForEvent');
  const finalColor = outcome === 'APPROVE' ? ANSI.green : ANSI.red;
  const headline = outcome
    ? `${statusMark(outcome, color)} ${useColor(outcome, `${ANSI.bold}${finalColor}`, color)} · ${total}`
    : `${useColor(activeLabel, phaseColor(activeName), color)} · ${round} · ${total}`;
  const title = `${state.demo ? 'DEMO · ' : ''}${state.title}`;
  const countLine = `${severity} · ${reviewLabel}`;
  const controlLine =
    state.taskMode === 'analysis'
      ? `INTEGRITY · ${phases[2].status} · integrity ${state.result?.rounds?.at(-1)?.integrity?.checks?.length ?? '—'}`
      : t(locale, 'dashboard.gatesLine', {
          gates: gateLabel,
          passed: gates.passed,
          active: cleanText(gates.active?.label),
        });
  const plan = `Plan Codex ${cleanText(state.solModel)}/${cleanText(state.solEffort)} · review ${cleanText(state.reviewProfile)}`;
  const agent =
    latest && ['SOL', 'CLAUDE'].includes(latest.badge) ? latest : undefined;
  const agentLine = agent
    ? t(locale, 'dashboard.agentLine', {
        model: cleanText(agent.model),
        effort: cleanText(agent.effort),
        attempt: boundedCount(agent.attempt, 2) ?? '—',
        limit: boundedCount(agent.attemptLimit, 2) ?? '—',
        fallback: agent.fallback ? ' · FALLBACK' : '',
      })
    : 'Agent —';
  const finalDiagnostics = [];
  if (outcome && state.result.error)
    finalDiagnostics.push(
      t(locale, 'dashboard.error', { error: cleanText(state.result.error) }),
    );
  if (outcome && state.result.status === 'STOPPED' && state.result.resume)
    finalDiagnostics.push(
      t(locale, 'dashboard.next', { resume: cleanText(state.result.resume) }),
    );

  // Tiny terminals prioritize the result, counters and current action.
  if (safeWidth < 64 || safeHeight < 16) {
    return [
      `${state.demo ? 'DEMO · ' : ''}${headline}`,
      `${round} · ${cleanText(state.taskMode)}`,
      ...finalDiagnostics,
      severity,
      reviewLabel,
      controlLine,
      active,
      agentLine,
    ]
      .slice(0, safeHeight)
      .map((line) => truncateToWidth(line, safeWidth))
      .join('\n');
  }

  const inner = safeWidth - 4;
  const tileWidth = Math.floor((inner - 4) / 5);
  const tile = (phase, content) =>
    padToWidth(
      useColor(
        content,
        ['WAITING', 'FALLBACK'].includes(phase.status)
          ? ANSI.dim
          : phase.status === 'PASS'
            ? ANSI.green
            : ['FAIL', 'STOPPED'].includes(phase.status)
              ? ANSI.red
              : phaseColor(phase.name),
        color,
      ),
      tileWidth,
    );
  const phaseRows = [
    phases.map((phase) => tile(phase, phaseLabel(phase.name, state))).join(' '),
    phases
      .map((phase) =>
        tile(
          phase,
          `${phase.status === 'ACTIVE' ? SPINNER_FRAMES[frame % 4] : phase.status === 'PASS' ? '✓' : phase.status === 'WAITING' ? '·' : '!'} ${phase.status === 'FALLBACK' ? 'WAITING' : phase.status}`,
        ),
      )
      .join(' '),
  ];
  const lines = [
    useColor(title, ANSI.bold, color),
    headline,
    t(locale, 'dashboard.modeLine', {
      mode: cleanText(state.taskMode),
      round,
      branch: cleanText(state.branch),
    }),
    ...((state.quality ?? state.result?.quality)
      ? [
          t(locale, 'dashboard.classLine', {
            taskClass: cleanText(
              (state.quality ?? state.result?.quality).taskClass,
            ),
            review: (state.quality ?? state.result?.quality)
              .independentReviewRequired
              ? 'REQUIRED'
              : 'NOT_REQUIRED',
          }),
          `Gates ${((state.quality ?? state.result?.quality).effectiveGates ?? state.effectiveGates ?? []).map((name) => cleanText(name)).join(', ')}`,
        ]
      : []),
    '',
    ...phaseRows,
    '',
    outcome
      ? state.result?.review?.status === 'NOT_REQUIRED'
        ? t(locale, 'dashboard.reviewNotRequired')
        : t(locale, 'dashboard.zeroFindings', {
            result: counts
              ? SEVERITIES.every((key) => counts[key] === 0)
                ? 'PASS'
                : 'FAIL'
              : t(locale, 'dashboard.noReview'),
          })
      : active,
    countLine,
    controlLine,
    outcome
      ? t(locale, 'dashboard.codeLine', {
          code: cleanText(state.result.code ?? '—'),
          stage: cleanText(state.result.stage ?? 'workflow'),
        })
      : agentLine,
  ];
  if (outcome) {
    const report = state.result;
    lines.push(...finalDiagnostics);
    if (report.sol)
      lines.push(
        `Codex plan ${cleanText(report.sol.plannedModel)}/${cleanText(report.sol.plannedEffort)} · effective ${cleanText(report.sol.effectiveModel)}/${cleanText(report.sol.effectiveEffort)}`,
      );
    if (report.quality)
      lines.push(
        t(locale, 'dashboard.classGates', {
          taskClass: cleanText(report.quality.taskClass),
          gates: (report.rounds?.at(-1)?.gates?.gates ?? [])
            .map((gate) => cleanText(gate.name))
            .join(', '),
        }),
      );
    if (report.review?.status === 'NOT_REQUIRED') {
      lines.push(
        t(locale, 'dashboard.reviewCalls'),
        cleanText(report.review.reason),
        cleanText(report.review.remainingAssurance),
      );
    } else if (report.review) {
      lines.push(
        `Review effective ${cleanText(report.review.effectiveModel)}/${cleanText(report.review.effectiveEffort)}`,
      );
      lines.push(
        t(locale, 'dashboard.reviewAttempts', {
          profile: cleanText(report.review.profile),
          attempts: boundedCount(report.review.attemptCount, 6) ?? '—',
        }),
      );
      lines.push(
        t(locale, 'dashboard.fallbackUsed', {
          allowed: yesNo(report.review.fallbackAllowed),
          used: yesNo(report.review.fallbackUsed),
        }),
      );
    }
    if (state.reportPath)
      lines.push(
        t(locale, 'dashboard.reportPath', { path: cleanText(state.reportPath) }),
      );
    if (report.diagnosticLog)
      lines.push(`Log ${cleanText(report.diagnosticLog)}`);
  } else {
    lines.push(
      plan,
      `Review plan ${state.reviewAttempts.map((attempt) => `${cleanText(attempt.model)}/${cleanText(attempt.effort)}`).join(' → ') || '—'}`,
      t(locale, 'dashboard.reviewPlan', {
        profile: cleanText(state.reviewProfile),
        attempts: state.reviewAttempts.length,
        allowed: yesNo(state.reviewFallbackAllowed),
      }),
      '',
      useColor(t(locale, 'dashboard.recent'), ANSI.dim, color),
      ...state.feed.map((entry) => `  › ${entry}`),
    );
  }
  return bordered(lines.slice(0, safeHeight - 2), safeWidth, color).join('\n');
}

function appendEventLines(state, event, nowMs) {
  const locale = stateLocale(state);
  if (event.type === 'metadata') {
    const attempts = state.reviewAttempts
      .map(({ model, effort }) => `${model}/${effort}`)
      .join(' → ');
    return [
      t(locale, 'dashboard.appendPreflight', {
        runId: state.runId ?? '—',
        branch: state.branch ?? '—',
      }),
      t(locale, 'dashboard.appendMode', { mode: state.taskMode }),
      ...(state.quality
        ? [
            t(locale, 'dashboard.appendClass', {
              taskClass: state.quality.taskClass,
              gates: (state.effectiveGates ?? []).join(', '),
            }),
            `REVIEW  ${state.quality.independentReviewRequired ? 'REQUIRED' : 'NOT_REQUIRED'} · ${state.quality.reason}`,
            t(locale, 'dashboard.appendAssurance', {
              assurance: state.quality.remainingAssurance,
            }),
          ]
        : []),
      `SOL  plan ${state.solModel && state.solEffort ? `${state.solModel}/${state.solEffort}` : '—'}`,
      t(locale, 'dashboard.appendReview', {
        profile: cleanText(state.reviewProfile),
        attempts: state.reviewAttempts.length,
        allowed: formatBooleanChoice(state.reviewFallbackAllowed, locale),
      }),
      `REVIEW  plan ${attempts || '—'}`,
    ];
  }
  if (event.type === 'round:start')
    return [
      t(locale, 'dashboard.appendRound', {
        round: event.round,
        max: state.maxRounds,
      }),
    ];
  if (event.type === 'stage:start')
    return [`${event.badge}  START ${event.label}`];
  if (event.type === 'stage:end') {
    const duration = formatDuration(event.durationMs ?? 0);
    const tests =
      event.testCount === undefined ? '' : ` · ${event.testCount} tests`;
    return [
      `${event.badge}  ${event.status} ${event.label} · ${duration}${tests}`,
    ];
  }
  if (event.type === 'heartbeat') {
    return [
      `${event.badge}  ACTIVE ${event.label} · ${formatDuration(event.durationMs ?? nowMs - state.startedAt)}`,
    ];
  }
  return [];
}

export function resolveDashboardMode({
  output,
  noAnimation = false,
  json = false,
  verbose = false,
  environment = process.env,
} = {}) {
  if (json) return 'json';
  if (
    !output?.isTTY ||
    noAnimation ||
    verbose ||
    (Number.isFinite(output.columns) &&
      output.columns > 0 &&
      output.columns < MIN_INTERACTIVE_WIDTH) ||
    environment.NO_COLOR !== undefined ||
    environment.TERM === 'dumb' ||
    Boolean(environment.CI)
  ) {
    return 'append';
  }
  return 'interactive';
}

// "a, b or c": the allowed values in error messages.
function formatChoices(values, locale) {
  return values.length > 1
    ? t(locale, 'dashboard.choices', {
        list: values.slice(0, -1).join(', '),
        last: values.at(-1),
      })
    : values.join('');
}

// Usage of the CLI (scripts/agent-review-loop.mjs) in the profile's locale:
// its options and allowlists come from the profile.
export function formatAgentUsage(profile) {
  const locale = internal.profileLocale(profile);
  const { implementer, reviewer } = resolveAgentRoles(profile);
  const criticalOpus = Object.hasOwn(reviewer.profiles, 'critical-opus')
    ? resolveReviewProfile('critical-opus', reviewer)
    : undefined;
  const [criticalOpusAttempt] = criticalOpus?.attempts ?? [];
  return [
    t(locale, 'cli.usage', {
      taskModes: TASK_MODE_USAGE,
      efforts: implementer.allowedEfforts.join('|'),
      profiles: Object.keys(reviewer.profiles).join('|'),
    }),
    ...(criticalOpus
      ? [
          t(locale, 'cli.criticalOpus', {
            model: criticalOpusAttempt.model,
            effort: criticalOpusAttempt.effort,
            attempts: criticalOpus.attempts.length,
            fallback: t(
              locale,
              criticalOpus.fallbackAllowed
                ? 'cli.fallbackAllowed'
                : 'cli.fallbackNone',
            ),
          }),
        ]
      : []),
  ].join('\n');
}

// The validated implementer and reviewer sections of a profile (the core
// defaults without one); the CLI derives its options and usage from them.
export function resolveAgentRoles(profile) {
  const { implementer, reviewer } = internal.resolveRunnerProfile(profile);
  return { implementer, reviewer };
}

// Defaults and allowlists come from the profile's implementer and reviewer.
export function parseAgentArguments(argumentsList, profile) {
  const { implementer, reviewer } = resolveAgentRoles(profile);
  const locale = internal.profileLocale(profile);
  const flags = new Set();
  const taskPaths = [];
  let reviewProfile = reviewer.defaultProfile;
  let reviewProfileProvided = false;
  let codexModel = implementer.model;
  let codexModelProvided = false;
  let solEffort = implementer.effort;
  let solEffortProvided = false;
  let taskMode = DEFAULT_TASK_MODE;
  let taskModeProvided = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--') continue;
    if (argument === '--task-mode' || argument.startsWith('--task-mode=')) {
      if (taskModeProvided) {
        return { error: t(locale, 'cli.taskModeOnce') };
      }
      const value =
        argument === '--task-mode'
          ? argumentsList[(index += 1)]
          : argument.slice('--task-mode='.length);
      if (typeof value !== 'string') {
        return { error: t(locale, 'cli.missingValue', { option: '--task-mode' }) };
      }
      if (!TASK_MODES.includes(value)) {
        return { error: t(locale, 'cli.taskModeValue') };
      }
      taskMode = value;
      taskModeProvided = true;
      continue;
    }
    if (
      argument === '--review-profile' ||
      argument.startsWith('--review-profile=')
    ) {
      if (reviewProfileProvided) {
        return { error: t(locale, 'cli.reviewProfileOnce') };
      }
      const value =
        argument === '--review-profile'
          ? argumentsList[(index += 1)]
          : argument.slice('--review-profile='.length);
      if (typeof value !== 'string') {
        return {
          error: t(locale, 'cli.missingValue', { option: '--review-profile' }),
        };
      }
      if (!Object.hasOwn(reviewer.profiles, value)) {
        return {
          error: t(locale, 'cli.reviewProfileValue', {
            choices: formatChoices(Object.keys(reviewer.profiles), locale),
          }),
        };
      }
      reviewProfile = value;
      reviewProfileProvided = true;
      continue;
    }
    if (argument === '--codex-model' || argument.startsWith('--codex-model=')) {
      if (codexModelProvided) {
        return { error: t(locale, 'cli.codexModelOnce') };
      }
      const value =
        argument === '--codex-model'
          ? argumentsList[(index += 1)]
          : argument.slice('--codex-model='.length);
      if (typeof value !== 'string') {
        return { error: t(locale, 'cli.missingValue', { option: '--codex-model' }) };
      }
      if (!isValidCodexModel(value)) {
        return { error: t(locale, 'cli.codexModelValue') };
      }
      codexModel = value;
      codexModelProvided = true;
      continue;
    }
    if (argument === '--sol-effort' || argument.startsWith('--sol-effort=')) {
      const value =
        argument === '--sol-effort'
          ? argumentsList[(index += 1)]
          : argument.slice('--sol-effort='.length);
      if (typeof value !== 'string') {
        return { error: t(locale, 'cli.missingValue', { option: '--sol-effort' }) };
      }
      if (!implementer.allowedEfforts.includes(value)) {
        return {
          error: t(locale, 'cli.solEffortValue', {
            choices: formatChoices(implementer.allowedEfforts, locale),
          }),
        };
      }
      if (solEffortProvided && solEffort !== value) {
        return {
          error: t(locale, 'cli.solEffortConflict', {
            first: solEffort,
            second: value,
          }),
        };
      }
      solEffort = value;
      solEffortProvided = true;
      continue;
    }
    if (
      ['--dry-run', '--verbose', '--no-animation', '--json'].includes(argument)
    ) {
      flags.add(argument);
    } else if (argument.startsWith('--')) {
      return { error: t(locale, 'cli.unknownOption', { option: argument }) };
    } else {
      taskPaths.push(argument);
    }
  }
  if (taskPaths.length !== 1) {
    return { error: t(locale, 'cli.oneTaskPath') };
  }
  return {
    taskPath: taskPaths[0],
    taskMode,
    reviewProfile,
    codexModel,
    solEffort,
    dryRun: flags.has('--dry-run'),
    verbose: flags.has('--verbose'),
    noAnimation: flags.has('--no-animation'),
    json: flags.has('--json'),
  };
}

export function createTerminalDashboard({
  profile,
  output = process.stdout,
  diagnosticOutput = process.stderr,
  taskPath,
  taskMode = DEFAULT_TASK_MODE,
  maxRounds = 3,
  demo = false,
  noAnimation = false,
  json = false,
  verbose = false,
  environment = process.env,
  monotonicNow = () => Number(process.hrtime.bigint()) / 1_000_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  heartbeatMs = 15_000,
  animationMs = 100,
} = {}) {
  const mode = resolveDashboardMode({
    output,
    noAnimation,
    json,
    verbose,
    environment,
  });
  const state = createDashboardState({
    profile,
    taskPath,
    taskMode,
    maxRounds,
    demo,
    nowMs: monotonicNow(),
  });
  let frame = 0;
  let timer;
  let lastHeartbeatAt = state.startedAt;
  let disposed = false;
  let started = false;
  let screen = false;
  let finished = false;

  function write(stream, text) {
    try {
      stream.write(text);
      return true;
    } catch {
      return false;
    }
  }
  const dimension = (value, fallback) =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  const width = () => dimension(output.columns, 80);
  const height = () => dimension(output.rows, 24);
  const view = (interactive) =>
    renderDashboard(state, {
      width: Math.max(
        1,
        width() - (output.isTTY ? INTERACTIVE_RIGHT_MARGIN : 0),
      ),
      height: interactive ? Math.max(1, height() - 1) : 24,
      nowMs: monotonicNow(),
      frame,
      color: interactive,
    });
  function render() {
    if (mode !== 'interactive' || disposed) return;
    // Alternate screen owns its viewport: resizing/reflow cannot touch scrollback.
    if (!write(output, `${ANSI.home}${ANSI.clearScreen}${view(true)}`))
      dispose();
    frame++;
  }
  function writeAppend(line) {
    if (
      line &&
      !write(
        output,
        `${cleanText(line, Math.max(1, width() - (output.isTTY ? 1 : 0)))}\n`,
      )
    )
      dispose();
  }
  function tick() {
    if (disposed || state.result) return;
    if (mode === 'interactive') return render();
    if (mode !== 'append') return;
    const now = monotonicNow();
    const active = state.stages.findLast((stage) => stage.status === 'ACTIVE');
    if (active && now - lastHeartbeatAt >= heartbeatMs) {
      writeAppend(
        `${phaseLabel(phaseName(active.badge), state)} ACTIVE ${active.label} · ${formatDuration(now - active.startedAt)}`,
      );
      lastHeartbeatAt = now;
    }
  }
  function start() {
    if (started || disposed) return;
    started = true;
    if (mode === 'json') return;
    if (mode === 'interactive') {
      screen = true;
      output.on?.('resize', render);
      if (!write(output, `${ANSI.enterScreen}${ANSI.hideCursor}`)) {
        dispose();
        return;
      }
      render();
    } else {
      writeAppend(`${demo ? 'DEMO · ' : ''}${state.title}`);
      writeAppend(
        t(state.locale, 'dashboard.task', {
          path: cleanText(taskPath),
          mode: taskMode,
        }),
      );
    }
    if (disposed) return;
    timer = setIntervalImpl(
      tick,
      mode === 'interactive' ? animationMs : heartbeatMs,
    );
    timer?.unref?.();
  }
  function event(value) {
    if (!started || disposed || finished) return;
    const now = monotonicNow();
    reduceDashboardEvent(state, value, now);
    if (mode === 'interactive') render();
    else if (mode === 'append') {
      for (const line of appendEventLines(state, value, now)) writeAppend(line);
    }
    if (value.type === 'result' && timer !== undefined) {
      clearIntervalImpl(timer);
      timer = undefined;
    }
  }
  function diagnostic(text, path) {
    if (!started || disposed || !verbose || !text) return;
    // Detailed output remains an explicit stderr mode, never part of the HUD/feed.
    const safe = redactSensitive(stripAnsi(text));
    write(
      diagnosticOutput,
      `${t(state.locale, 'dashboard.diagnostics')}${path ? ` ${cleanText(path)}` : ''}\n${safe}${safe.endsWith('\n') ? '' : '\n'}`,
    );
  }
  function finish(report, reportPath) {
    if (finished) return;
    finished = true;
    reduceDashboardEvent(
      state,
      { type: 'result', report, reportPath },
      state.finishedAt ?? monotonicNow(),
    );
    dispose();
    if (!started || mode === 'json') return;
    // One stable final summary on the original screen; never erase its history.
    write(output, `${view(mode === 'interactive')}\n`);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearIntervalImpl(timer);
    timer = undefined;
    output.off?.('resize', render);
    if (screen) {
      screen = false;
      write(
        output,
        `${ANSI.reset}${ANSI.showCursor}${ANSI.leaveScreen}${ANSI.reset}${ANSI.showCursor}`,
      );
    }
  }
  return {
    get mode() {
      return mode;
    },
    state,
    start,
    event,
    diagnostic,
    finish,
    dispose,
  };
}
