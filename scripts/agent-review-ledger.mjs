// The evidence ledger of a run (ledger.jsonl in the run directory): one JSON
// line per event, each with the SHA-256 of the previous line (prev) and,
// when the checkpoint key exists, an HMAC (SHA-256) of the line made with
// that key (mac). The format is described in docs/ledger.md.
//
// The ledger documents a run; no decision of the runner depends on its
// content. The key is readable by code that runs as the user (the writer,
// the gates), so a mac only detects a change made without the key, and the
// run directory is in the repository, where the writer may change or delete
// it: a removed ledger is detectable as a missing one, but a ledger without
// macs rewritten together with the report is not detectable. A resumed run only refuses a
// checkpoint whose ledger does not verify; it never takes state from it.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export const LEDGER_FILE = 'ledger.jsonl';
export const LEDGER_VERSION = 1;
export const LEDGER_MAC = 'hmac-sha256';
export const LEDGER_EVENT_TYPES = Object.freeze([
  'preflight',
  'fingerprints',
  'resume',
  'writer-round',
  'gate',
  'integrity',
  'snapshot',
  'review-attempt',
  'findings',
  'checkpoint',
  'stop',
  'result',
]);
const LEDGER_EVENT_TYPE_SET = new Set(LEDGER_EVENT_TYPES);
const LINE_KEYS = ['ledgerVersion', 'seq', 'ts', 'type', 'data', 'prev', 'mac'];
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
// The run id of the runner (createRunId); a run directory name.
export const RUN_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z--[A-Za-z0-9]{1,64}$/;

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const sign = (key, text) => createHmac('sha256', key).update(text).digest();
const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype;

// The mac signs the JSON text of the line without its mac; the line is that
// object with mac as the last key, and its SHA-256 is the next line's prev.
export function formatLedgerLine({ seq, ts, type, data, prev, key = null }) {
  const entry = { ledgerVersion: LEDGER_VERSION, seq, ts, type, data, prev };
  const text = JSON.stringify({
    ...entry,
    mac: key ? sign(key, JSON.stringify(entry)).toString('hex') : null,
  });
  return { text, hash: sha256Hex(text) };
}

// Appends one line per event and syncs it to disk before returning. The
// first append creates the file (it must not exist); every append opens it
// without following a symbolic link and refuses anything but the regular
// file it created (the same device and inode) with a single link, so a
// file replaced or hard-linked during the run is not written to. After a
// failed append the writer refuses every later one: the file may end in a
// partial line, which verification reports.
export function createLedgerWriter({
  path,
  key = null,
  prev = null,
  now = () => new Date().toISOString(),
  redact = (text) => text,
}) {
  let events = 0;
  let headHash = prev;
  let failure;
  let created;
  return {
    get events() {
      return events;
    },
    get headHash() {
      return headHash;
    },
    get failed() {
      return failure !== undefined;
    },
    async append(type, data) {
      if (failure) throw failure;
      if (!LEDGER_EVENT_TYPE_SET.has(type) || !isPlainObject(data))
        throw new TypeError(`invalid ledger event ${type}`);
      const { text, hash } = formatLedgerLine({
        seq: events + 1,
        ts: now(),
        type,
        data: JSON.parse(
          JSON.stringify(data, (_, value) =>
            typeof value === 'string' ? redact(value) : value,
          ),
        ),
        prev: headHash,
        key,
      });
      let handle;
      try {
        handle = await open(
          path,
          fsConstants.O_WRONLY |
            fsConstants.O_APPEND |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK |
            (events === 0 ? fsConstants.O_CREAT | fsConstants.O_EXCL : 0),
          0o600,
        );
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          throw Object.assign(new Error('not a regular file'), {
            code: 'ENOTFILE',
          });
        }
        created ??= { dev: metadata.dev, ino: metadata.ino };
        if (
          metadata.dev !== created.dev ||
          metadata.ino !== created.ino ||
          metadata.nlink !== 1
        ) {
          throw Object.assign(
            new Error('not the file created by the run or has another link'),
            { code: 'ENOTLEDGER' },
          );
        }
        await handle.write(`${text}\n`);
        await handle.sync();
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        await handle?.close().catch(() => {});
      }
      events += 1;
      headHash = hash;
    },
  };
}

function mismatch(seq, check, message) {
  return { seq, check, message };
}

// Verifies the text of one ledger: canonical lines in the format above,
// seq from 1 without gaps, the prev chain, known event types, a preflight
// first, and every mac when a key is given. The first line's prev is null,
// or for a resumed run the head of the resumed run's ledger, named by its
// resume event. mac: 'verified' (every mac checked with the key),
// 'not-verified' (the ledger has macs, no key was given) or 'absent' (the
// ledger was written without a key). failure: the first mismatch, or null.
export function verifyLedgerText(text, { key = null } = {}) {
  const result = {
    events: 0,
    headHash: null,
    firstPrev: null,
    mac: 'absent',
    entries: [],
    failure: null,
  };
  const fail = (seq, check, message) => {
    result.failure = mismatch(seq, check, message);
    return result;
  };
  if (text.length === 0) return fail(1, 'empty', 'The ledger is empty.');
  const lines = text.split('\n');
  const tail = lines.pop();
  if (tail !== '') {
    return fail(
      lines.length + 1,
      'truncated',
      'The ledger ends with an incomplete line.',
    );
  }
  let macMode;
  let previousHash = null;
  for (const [index, line] of lines.entries()) {
    const seq = index + 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return fail(seq, 'line', `Line ${seq} is not JSON.`);
    }
    if (
      !isPlainObject(entry) ||
      Object.keys(entry).join(',') !== LINE_KEYS.join(',') ||
      JSON.stringify(entry) !== line
    ) {
      return fail(seq, 'line', `Line ${seq} is not a ledger line.`);
    }
    if (entry.ledgerVersion !== LEDGER_VERSION)
      return fail(seq, 'version', `Line ${seq} has another ledgerVersion.`);
    if (entry.seq !== seq)
      return fail(seq, 'seq', `Line ${seq} has seq ${JSON.stringify(entry.seq)}.`);
    if (
      typeof entry.ts !== 'string' ||
      !LEDGER_EVENT_TYPE_SET.has(entry.type) ||
      !isPlainObject(entry.data)
    ) {
      return fail(seq, 'event', `Event ${seq} has an invalid ts, type or data.`);
    }
    if (seq === 1) {
      if (
        entry.type !== 'preflight' ||
        (entry.data.mac !== LEDGER_MAC && entry.data.mac !== null)
      ) {
        return fail(seq, 'event', 'The first event is not a preflight event.');
      }
      macMode = entry.data.mac;
      if (entry.prev !== null && !HASH_PATTERN.test(String(entry.prev)))
        return fail(seq, 'prev', 'Event 1 has an invalid prev.');
      result.firstPrev = entry.prev;
    } else if (entry.prev !== previousHash) {
      return fail(
        seq,
        'prev',
        `Event ${seq} does not follow event ${seq - 1} (prev differs).`,
      );
    }
    if (macMode === null) {
      if (entry.mac !== null)
        return fail(seq, 'mac', `Event ${seq} has a mac in a ledger without one.`);
    } else {
      if (typeof entry.mac !== 'string' || !HASH_PATTERN.test(entry.mac))
        return fail(seq, 'mac', `Event ${seq} has no valid mac.`);
      if (key) {
        const { mac, ...signed } = entry;
        if (
          !timingSafeEqual(
            Buffer.from(mac, 'hex'),
            sign(key, JSON.stringify(signed)),
          )
        ) {
          return fail(seq, 'mac', `The mac of event ${seq} does not match the key.`);
        }
      }
    }
    previousHash = sha256Hex(line);
    result.entries.push(entry);
  }
  result.events = result.entries.length;
  result.headHash = previousHash;
  result.mac =
    macMode === null ? 'absent' : key ? 'verified' : 'not-verified';
  const resumeEvents = result.entries.filter(({ type }) => type === 'resume');
  if (resumeEvents.length > 1) {
    return fail(
      resumeEvents[1].seq,
      'resume',
      'The ledger has more than one resume event.',
    );
  }
  const [resumeEvent] = resumeEvents;
  const resumedHead = resumeEvent?.data.previousLedger?.headHash ?? null;
  if (resumedHead !== result.firstPrev) {
    return fail(
      resumeEvent?.seq ?? 1,
      'resume',
      'The first prev and the resume event do not name the same ledger.',
    );
  }
  return result;
}

// A file of the run directory: a regular file, not a symbolic link, at
// most maxBytes. undefined when it does not exist.
async function readRunFile(path, maxBytes) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('not a regular file');
    if (metadata.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

// The path in the report (report.ledger.path), relative to the repository
// root like reportPath.
export function ledgerPath(stateDirectory, runId) {
  return join(stateDirectory, 'runs', runId, LEDGER_FILE);
}

// Verifies the ledger of a run against itself (verifyLedgerText) and against
// the run's report: report.ledger (path, events, headHash), the run id, the
// runner and project profile fingerprints, the final status, and for a
// resumed run the ledger of the run it resumed (the same checks, whose head
// must be the first prev). Returns { status, ... } with the first mismatch:
// 'fail' on a mismatch, 'unverified' when a key is given but the ledger has
// no mac (written without the key, or its macs were removed), otherwise
// 'ok'. Only reads files; the last element of each path is opened without
// following a symbolic link, but a symbolic link on runs/ or the run
// directory is followed.
export async function verifyRunLedgerFiles({
  runsDirectory,
  stateDirectoryName,
  runId,
  key = null,
}) {
  if (!RUN_ID_PATTERN.test(runId)) throw new TypeError('invalid run id');
  const relativePath = ledgerPath(stateDirectoryName, runId);
  const outcome = (fields) => ({
    status: fields.failure
      ? 'fail'
      : key && fields.mac === 'absent'
        ? 'unverified'
        : 'ok',
    runId,
    ledger: relativePath,
    events: 0,
    headHash: null,
    mac: 'absent',
    failure: null,
    ...fields,
  });
  const failed = (seq, check, message, fields = {}) =>
    outcome({ ...fields, failure: mismatch(seq, check, message) });
  let ledgerText;
  let reportText;
  try {
    ledgerText = await readRunFile(
      join(runsDirectory, runId, LEDGER_FILE),
      MAX_LEDGER_BYTES,
    );
    reportText = await readRunFile(
      join(runsDirectory, runId, 'report.json'),
      MAX_REPORT_BYTES,
    );
  } catch (error) {
    return failed(null, 'file', `The run files cannot be read (${error.message}).`);
  }
  if (ledgerText === undefined)
    return failed(null, 'missing', `Run ${runId} has no ledger.`);
  const verified = verifyLedgerText(ledgerText, { key });
  const fields = {
    events: verified.events,
    headHash: verified.headHash,
    mac: verified.mac,
  };
  if (verified.failure) return outcome({ ...fields, failure: verified.failure });
  const { entries } = verified;
  const first = (type) => entries.find((entry) => entry.type === type);
  const last = entries.at(-1);
  let report;
  try {
    if (reportText === undefined) throw new Error();
    report = JSON.parse(reportText);
    if (!isPlainObject(report)) throw new Error();
  } catch {
    return failed(null, 'report', `Run ${runId} has no readable report.json.`, fields);
  }
  const ledger = report.ledger;
  if (
    !isPlainObject(ledger) ||
    ledger.path !== relativePath ||
    ledger.events !== verified.events ||
    ledger.headHash !== verified.headHash
  ) {
    return failed(
      null,
      'report',
      'report.ledger (path, events, headHash) does not match the ledger.',
      fields,
    );
  }
  if (report.runId !== runId || entries[0].data.runId !== runId)
    return failed(1, 'report', 'The run id of the report or the ledger differs.', fields);
  const fingerprints = first('fingerprints');
  if (
    !fingerprints ||
    fingerprints.data.runner !== (report.runner?.sha256 ?? null) ||
    fingerprints.data.projectProfile !== (report.projectProfile?.sha256 ?? null)
  ) {
    return failed(
      fingerprints?.seq ?? null,
      'fingerprints',
      'The fingerprints in the ledger do not match the report (runner, projectProfile).',
      fields,
    );
  }
  if (last.type !== 'result' || last.data.status !== report.status) {
    return failed(
      last.seq,
      'result',
      'The last event is not the result of the report.',
      fields,
    );
  }
  const resume = first('resume');
  if (resume) {
    const previous = resume.data.resumedFrom;
    if (
      typeof previous !== 'string' ||
      !RUN_ID_PATTERN.test(previous) ||
      previous !== report.resumedFrom
    ) {
      return failed(
        resume.seq,
        'resume',
        'The resume event does not match the report.',
        fields,
      );
    }
    const predecessor = await verifyLedgerOfRun({
      runsDirectory,
      runId: previous,
      key,
    });
    if (predecessor.failure) {
      return failed(
        resume.seq,
        'predecessor',
        `The ledger of run ${previous} does not verify: ${predecessor.failure.message}`,
        fields,
      );
    }
    if (predecessor.headHash !== verified.firstPrev) {
      return failed(
        resume.seq,
        'predecessor',
        `The head of the ledger of run ${previous} is not the first prev of this ledger.`,
        fields,
      );
    }
  }
  return outcome(fields);
}

// The ledger of a resumed run's predecessor: its own chain and macs, and its
// preflight names that run (a verification of that run checks its report
// and its predecessor).
async function verifyLedgerOfRun({ runsDirectory, runId, key }) {
  let text;
  try {
    text = await readRunFile(join(runsDirectory, runId, LEDGER_FILE), MAX_LEDGER_BYTES);
  } catch (error) {
    return { failure: mismatch(null, 'file', error.message) };
  }
  if (text === undefined)
    return { failure: mismatch(null, 'missing', `Run ${runId} has no ledger.`) };
  const verified = verifyLedgerText(text, { key });
  if (!verified.failure && verified.entries[0].data.runId !== runId) {
    verified.failure = mismatch(1, 'run', `The ledger is not the ledger of run ${runId}.`);
  }
  return verified;
}

// The ledger of the run a resumed run continues: it verifies with the key
// (a valid mac on every line), its preflight names that run, and its last
// checkpoint event names the checkpoint's phase and round. failure: a short
// description of the first mismatch, or undefined; events and headHash of
// the ledger.
export function verifyResumableLedger(text, { key, runId, phase, round }) {
  if (text === undefined) return { failure: 'missing' };
  const verified = verifyLedgerText(text, { key });
  const { events, headHash, entries } = verified;
  const checkpoint = entries.findLast(({ type }) => type === 'checkpoint');
  const failure = verified.failure
    ? `${verified.failure.check} at event ${verified.failure.seq}`
    : verified.mac !== 'verified'
      ? 'no mac'
      : entries[0].data.runId !== runId
        ? 'another run id'
        : checkpoint?.data.phase !== phase || checkpoint?.data.round !== round
          ? 'last checkpoint event differs'
          : undefined;
  return { failure, events, headHash };
}

export async function readLedgerText(runDirectory) {
  return readRunFile(join(runDirectory, LEDGER_FILE), MAX_LEDGER_BYTES);
}
