// Relay-free concise verified handoff memory gate (issue #224).
//
// Pure ESM, no Node-only imports: enforces two invariants on agent handoff
// memory bundles before persistence or handoff acceptance:
//   1. Conciseness budget: <= 12 files and <= 50,000 characters.
//   2. Transcript verification: every memory assertion must be corroborated by
//      a cryptographically verified `sigil.room-transcript` v1 document.
import { verifyTranscript } from './transcript-verify.mjs';

export const HANDOFF_MEMORY_FORMAT = 'sigil.handoff-memory';
export const HANDOFF_MEMORY_VERSION = 1;
export const MAX_HANDOFF_FILES = 12;
export const MAX_HANDOFF_CHARS = 50_000;

export const HANDOFF_PROBLEM = Object.freeze({
  MALFORMED_HANDOFF: 'MALFORMED_HANDOFF',
  DUPLICATE_FILE_PATH: 'DUPLICATE_FILE_PATH',
  BUDGET_FILES_EXCEEDED: 'BUDGET_FILES_EXCEEDED',
  BUDGET_CHARS_EXCEEDED: 'BUDGET_CHARS_EXCEEDED',
  TRANSCRIPT_INVALID: 'TRANSCRIPT_INVALID',
  MISSING_ASSERTIONS: 'MISSING_ASSERTIONS',
  UNCORROBORATED_ASSERTION: 'UNCORROBORATED_ASSERTION',
  EVIDENCE_NOT_FOUND: 'EVIDENCE_NOT_FOUND',
  EVIDENCE_MISMATCH: 'EVIDENCE_MISMATCH',
  QUOTE_NOT_FOUND: 'QUOTE_NOT_FOUND',
  UNCORROBORATED_FILE: 'UNCORROBORATED_FILE',
  UNTRUSTED_SIGNER: 'UNTRUSTED_SIGNER',
});

// Shortest quote or claim (after whitespace normalization) that can count as
// evidence. Anything shorter matches almost any message.
export const MIN_EVIDENCE_TEXT_CHARS = 4;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseSeqString(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return String(BigInt(value));
  return null;
}

// Pure POSIX relative path validation (no node:path dependency so module stays browser-safe).
function normalizeRelativePath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  if (rawPath.includes('\0') || rawPath.includes('\\')) return null;
  if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) return null;
  const segments = rawPath.split('/');
  const clean = [];
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null;
    clean.push(segment);
  }
  return clean.join('/');
}

// Collect the string values of a message body (never its keys), each
// normalized on its own, so a quote must sit inside one value and cannot
// match JSON syntax, field names, or text spanning two fields.
function collectStringLeaves(value, out, depth = 0) {
  if (depth > 32) return out;
  if (typeof value === 'string') {
    const text = normalizeText(value);
    if (text) out.push(text);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out, depth + 1);
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) collectStringLeaves(value[key], out, depth + 1);
  }
  return out;
}

function extractEntryTextFields(envelope) {
  return collectStringLeaves(envelope?.body, []);
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

// True when `needle` occurs in `haystack` without cutting a word in half at
// either end ("hello 1" must not match "hello 10").
function containsAtWordBoundary(haystack, needle) {
  const needsLeft = WORD_CHAR.test(needle[0]);
  const needsRight = WORD_CHAR.test(needle[needle.length - 1]);
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at > 0 ? haystack[at - 1] : '';
    const after = haystack[at + needle.length] ?? '';
    const leftOk = !needsLeft || !before || !WORD_CHAR.test(before);
    const rightOk = !needsRight || !after || !WORD_CHAR.test(after);
    if (leftOk && rightOk) return true;
    from = at + 1;
  }
  return false;
}

function fieldsContain(fields, needle) {
  return fields.some((field) => containsAtWordBoundary(field, needle));
}

function keyRef(endpointId, keyId) {
  return `${endpointId}\u0000${keyId}`;
}

function resolveBudgetLimits({ maxFiles = MAX_HANDOFF_FILES, maxChars = MAX_HANDOFF_CHARS } = {}) {
  const problems = [];
  let effectiveMaxFiles = MAX_HANDOFF_FILES;
  let effectiveMaxChars = MAX_HANDOFF_CHARS;

  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_HANDOFF_FILES) {
    problems.push({
      code: HANDOFF_PROBLEM.MALFORMED_HANDOFF,
      message: `maxFiles must be an integer between 1 and ${MAX_HANDOFF_FILES}, got ${JSON.stringify(maxFiles)}`,
    });
  } else {
    effectiveMaxFiles = maxFiles;
  }

  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_HANDOFF_CHARS) {
    problems.push({
      code: HANDOFF_PROBLEM.MALFORMED_HANDOFF,
      message: `maxChars must be an integer between 1 and ${MAX_HANDOFF_CHARS}, got ${JSON.stringify(maxChars)}`,
    });
  } else {
    effectiveMaxChars = maxChars;
  }

  return { maxFiles: effectiveMaxFiles, maxChars: effectiveMaxChars, problems };
}

/**
 * Evaluate conciseness budget (<= 12 files / <= 50,000 chars) and file path hygiene.
 * Never throws on bad content; returns { ok, budget, normalized_paths, problems }.
 */
export function evaluateConcisenessBudget(handoff, options = {}) {
  const { maxFiles, maxChars, problems } = resolveBudgetLimits(options);
  const normalizedPaths = new Set();

  const files = isObject(handoff) && Array.isArray(handoff.files) ? handoff.files : [];
  const assertions = isObject(handoff) && Array.isArray(handoff.assertions) ? handoff.assertions : [];

  let fileChars = 0;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (!isObject(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
      problems.push({
        code: HANDOFF_PROBLEM.MALFORMED_HANDOFF,
        file: typeof file?.path === 'string' ? file.path : `files[${i}]`,
        message: `files[${i}] must be an object with string path and content`,
      });
      continue;
    }
    const cleanPath = normalizeRelativePath(file.path);
    if (!cleanPath) {
      problems.push({
        code: HANDOFF_PROBLEM.MALFORMED_HANDOFF,
        file: file.path,
        message: `unsafe or invalid relative file path ${JSON.stringify(file.path)}`,
      });
    } else if (normalizedPaths.has(cleanPath)) {
      problems.push({
        code: HANDOFF_PROBLEM.DUPLICATE_FILE_PATH,
        file: cleanPath,
        message: `duplicate handoff file path ${cleanPath}`,
      });
    } else {
      normalizedPaths.add(cleanPath);
    }
    fileChars += file.content.length;
  }

  let assertionChars = 0;
  for (const assertion of assertions) {
    if (!isObject(assertion)) continue;
    const text = typeof assertion.claim === 'string'
      ? assertion.claim
      : typeof assertion.statement === 'string'
        ? assertion.statement
        : typeof assertion.text === 'string'
          ? assertion.text
          : '';
    assertionChars += text.length;
  }

  const fileCount = files.length;
  const totalChars = fileCount > 0 ? fileChars : assertionChars;

  if (fileCount > maxFiles) {
    problems.push({
      code: HANDOFF_PROBLEM.BUDGET_FILES_EXCEEDED,
      message: `handoff contains ${fileCount} files, exceeding conciseness budget of ${maxFiles} files`,
    });
  }
  if (fileChars > maxChars) {
    problems.push({
      code: HANDOFF_PROBLEM.BUDGET_CHARS_EXCEEDED,
      message: `handoff files total ${fileChars} characters, exceeding conciseness budget of ${maxChars} characters`,
    });
  }
  if (assertionChars > maxChars) {
    problems.push({
      code: HANDOFF_PROBLEM.BUDGET_CHARS_EXCEEDED,
      message: `handoff assertions total ${assertionChars} characters, exceeding conciseness budget of ${maxChars} characters`,
    });
  }

  return {
    ok: problems.length === 0,
    budget: {
      file_count: fileCount,
      max_files: maxFiles,
      total_chars: totalChars,
      file_chars: fileChars,
      assertion_chars: assertionChars,
      max_chars: maxChars,
    },
    normalized_paths: normalizedPaths,
    problems,
  };
}

/**
 * Verify a handoff memory bundle against both the conciseness budget
 * (<= 12 files / <= 50,000 chars) and a cryptographically verified Sigil room
 * transcript. Never throws on untrusted input; fails closed with structured problems.
 *
 * requireFileAssertions (default true): every file in handoff.files must be
 *   named by at least one assertion whose evidence all checks out, so no file
 *   is stored on the strength of claims made about other files.
 * requirePinnedSigners (default false): every cited transcript entry must be
 *   signed by a key in pinnedKeys. Without it, a transcript is checked only
 *   against the keys it carries itself, which anyone can generate.
 */
export async function verifyHandoffMemory(
  handoff,
  {
    transcript = undefined,
    pinnedKeys = [],
    maxFiles = MAX_HANDOFF_FILES,
    maxChars = MAX_HANDOFF_CHARS,
    requireAssertions = true,
    requireFileAssertions = true,
    requirePinnedSigners = false,
  } = {}
) {
  const problems = [];
  const baseBudget = {
    file_count: 0,
    max_files: Number.isSafeInteger(maxFiles) && maxFiles >= 1 && maxFiles <= MAX_HANDOFF_FILES ? maxFiles : MAX_HANDOFF_FILES,
    total_chars: 0,
    file_chars: 0,
    assertion_chars: 0,
    max_chars: Number.isSafeInteger(maxChars) && maxChars >= 1 && maxChars <= MAX_HANDOFF_CHARS ? maxChars : MAX_HANDOFF_CHARS,
  };
  const makeResult = (extra = {}) => ({
    ok: problems.length === 0,
    room_id: null,
    checked_entries: 0,
    checked_assertions: 0,
    budget: baseBudget,
    transcript: null,
    problems,
    ...extra,
  });

  if (!isObject(handoff)) {
    problems.push({ code: HANDOFF_PROBLEM.MALFORMED_HANDOFF, message: 'handoff must be a JSON object' });
    return makeResult();
  }
  if ('format' in handoff && handoff.format !== HANDOFF_MEMORY_FORMAT) {
    problems.push({
      code: HANDOFF_PROBLEM.MALFORMED_HANDOFF,
      message: `not a ${HANDOFF_MEMORY_FORMAT} document`,
    });
    return makeResult();
  }
  if ('version' in handoff && handoff.version !== HANDOFF_MEMORY_VERSION) {
    problems.push({
      code: HANDOFF_PROBLEM.MALFORMED_HANDOFF,
      message: `unsupported handoff memory version ${JSON.stringify(handoff.version)}`,
    });
    return makeResult();
  }
  if ('files' in handoff && !Array.isArray(handoff.files)) {
    problems.push({ code: HANDOFF_PROBLEM.MALFORMED_HANDOFF, message: 'handoff.files must be an array' });
    return makeResult();
  }
  if ('assertions' in handoff && !Array.isArray(handoff.assertions)) {
    problems.push({ code: HANDOFF_PROBLEM.MALFORMED_HANDOFF, message: 'handoff.assertions must be an array' });
    return makeResult();
  }

  const files = handoff.files ?? [];
  const assertions = handoff.assertions ?? [];

  // 1. Conciseness budget & path hygiene.
  const budgetEval = evaluateConcisenessBudget({ files, assertions }, { maxFiles, maxChars });
  problems.push(...budgetEval.problems);

  if (requireAssertions && assertions.length === 0) {
    problems.push({
      code: HANDOFF_PROBLEM.MISSING_ASSERTIONS,
      message: 'handoff must declare at least one transcript-corroborated memory assertion',
    });
  }

  // 2. Cryptographic & sequence verification of the backing room transcript.
  const backingTranscript = transcript !== undefined ? transcript : handoff.transcript;
  if (!backingTranscript) {
    problems.push({
      code: HANDOFF_PROBLEM.TRANSCRIPT_INVALID,
      message: 'missing backing sigil.room-transcript for memory verification',
    });
    return makeResult({ budget: budgetEval.budget });
  }

  const transcriptResult = await verifyTranscript(backingTranscript, { pinnedKeys });
  if (!transcriptResult.ok) {
    for (const tp of transcriptResult.problems) {
      problems.push({
        code: HANDOFF_PROBLEM.TRANSCRIPT_INVALID,
        message: `backing transcript failed verification (${tp.code}): ${tp.message}`,
        message_id: tp.message_id ?? null,
        room_seq: tp.room_seq ?? null,
        transcript_problem: tp,
      });
    }
    return makeResult({
      room_id: transcriptResult.room_id,
      checked_entries: transcriptResult.checked,
      budget: budgetEval.budget,
      transcript: transcriptResult,
    });
  }

  if (handoff.room_id != null && transcriptResult.room_id != null && handoff.room_id !== transcriptResult.room_id) {
    problems.push({
      code: HANDOFF_PROBLEM.TRANSCRIPT_INVALID,
      message: `handoff room_id ${JSON.stringify(handoff.room_id)} does not match transcript room_id ${JSON.stringify(transcriptResult.room_id)}`,
    });
  }

  // 3. Index verified entries and corroborate every memory assertion.
  const byMessageId = new Map();
  const bySeq = new Map();
  const fieldsByEntry = new Map();
  const pinnedRefs = new Set();
  for (const pin of Array.isArray(pinnedKeys) ? pinnedKeys : []) {
    if (isObject(pin) && typeof pin.endpoint_id === 'string' && typeof pin.key_id === 'string') {
      pinnedRefs.add(keyRef(pin.endpoint_id, pin.key_id));
    }
  }

  for (const entry of backingTranscript.entries) {
    fieldsByEntry.set(entry, extractEntryTextFields(entry.envelope));
    if (typeof entry.message_id === 'string') {
      byMessageId.set(entry.message_id, entry);
    }
    const seq = parseSeqString(entry.room_seq);
    if (seq !== null) bySeq.set(seq, entry);
  }

  let checkedAssertions = 0;
  const corroboratedFiles = new Set();
  for (let i = 0; i < assertions.length; i += 1) {
    const assertion = assertions[i];
    const index = i + 1;
    const assertionId = isObject(assertion) && typeof assertion.id === 'string' && assertion.id ? assertion.id : null;
    const problemsBefore = problems.length;
    let assertionFile = null;
    const addAssertionProblem = (code, message, extra = {}) => problems.push({
      code,
      message,
      assertion_index: index,
      assertion_id: assertionId,
      ...extra,
    });

    if (!isObject(assertion)) {
      addAssertionProblem(HANDOFF_PROBLEM.MALFORMED_HANDOFF, 'assertion must be an object');
      continue;
    }

    const rawClaim = typeof assertion.claim === 'string'
      ? assertion.claim
      : typeof assertion.statement === 'string'
        ? assertion.statement
        : typeof assertion.text === 'string'
          ? assertion.text
          : null;
    const claim = rawClaim ? normalizeText(rawClaim) : '';
    if (!claim) {
      addAssertionProblem(HANDOFF_PROBLEM.MALFORMED_HANDOFF, 'assertion requires a non-empty claim string');
      continue;
    }

    if (assertion.file !== undefined && assertion.file !== null) {
      const cleanFile = normalizeRelativePath(assertion.file);
      if (cleanFile && budgetEval.normalized_paths.has(cleanFile)) assertionFile = cleanFile;
      if (!cleanFile || !budgetEval.normalized_paths.has(cleanFile)) {
        addAssertionProblem(
          HANDOFF_PROBLEM.EVIDENCE_MISMATCH,
          `assertion references file ${JSON.stringify(assertion.file)} which is not present in handoff.files`,
          { file: typeof assertion.file === 'string' ? assertion.file : null }
        );
      }
    }

    if (!Array.isArray(assertion.evidence) || assertion.evidence.length === 0) {
      addAssertionProblem(HANDOFF_PROBLEM.UNCORROBORATED_ASSERTION, 'assertion has no transcript evidence references');
      continue;
    }

    checkedAssertions += 1;

    for (const ref of assertion.evidence) {
      if (!isObject(ref)) {
        addAssertionProblem(HANDOFF_PROBLEM.UNCORROBORATED_ASSERTION, 'evidence reference must be an object');
        continue;
      }

      const hasMessageId = typeof ref.message_id === 'string' && ref.message_id.length > 0;
      const seqStr = ref.room_seq !== undefined && ref.room_seq !== null ? parseSeqString(ref.room_seq) : null;
      const hasRawSeq = ref.room_seq !== undefined && ref.room_seq !== null;

      if (hasRawSeq && seqStr === null) {
        addAssertionProblem(HANDOFF_PROBLEM.EVIDENCE_MISMATCH, `invalid room_seq ${JSON.stringify(ref.room_seq)} in evidence reference`, {
          message_id: hasMessageId ? ref.message_id : null,
        });
        continue;
      }
      if (!hasMessageId && seqStr === null) {
        addAssertionProblem(HANDOFF_PROBLEM.UNCORROBORATED_ASSERTION, 'evidence reference must specify message_id or room_seq');
        continue;
      }

      const entryByMsg = hasMessageId ? byMessageId.get(ref.message_id) : undefined;
      const entryBySeq = seqStr !== null ? bySeq.get(seqStr) : undefined;

      if (hasMessageId && !entryByMsg) {
        addAssertionProblem(HANDOFF_PROBLEM.EVIDENCE_NOT_FOUND, `message_id ${ref.message_id} not found in verified transcript`, {
          message_id: ref.message_id,
          room_seq: seqStr,
        });
        continue;
      }
      if (seqStr !== null && !entryBySeq) {
        addAssertionProblem(HANDOFF_PROBLEM.EVIDENCE_NOT_FOUND, `room_seq ${seqStr} not found in verified transcript`, {
          message_id: hasMessageId ? ref.message_id : null,
          room_seq: seqStr,
        });
        continue;
      }
      if (entryByMsg && entryBySeq && entryByMsg !== entryBySeq) {
        addAssertionProblem(
          HANDOFF_PROBLEM.EVIDENCE_MISMATCH,
          `evidence message_id ${ref.message_id} does not match room_seq ${seqStr}`,
          { message_id: ref.message_id, room_seq: seqStr }
        );
        continue;
      }

      const entry = entryByMsg ?? entryBySeq;
      const entryMessageId = entry.message_id ?? null;
      const entrySeq = parseSeqString(entry.room_seq);

      const expectedSender = ref.sender_endpoint_id ?? ref.sender;
      if (expectedSender !== undefined && expectedSender !== null) {
        const actualSender = entry.envelope?.sender?.endpoint_id;
        if (typeof expectedSender !== 'string' || actualSender !== expectedSender) {
          addAssertionProblem(
            HANDOFF_PROBLEM.EVIDENCE_MISMATCH,
            `evidence sender ${JSON.stringify(expectedSender)} does not match verified entry sender ${JSON.stringify(actualSender)}`,
            { message_id: entryMessageId, room_seq: entrySeq }
          );
          continue;
        }
      }

      if (requirePinnedSigners) {
        const signerRef = keyRef(entry.envelope?.sender?.endpoint_id, entry.envelope?.signature?.key_id);
        if (!pinnedRefs.has(signerRef)) {
          addAssertionProblem(
            HANDOFF_PROBLEM.UNTRUSTED_SIGNER,
            `evidence entry ${entryMessageId ?? `room_seq ${entrySeq}`} is not signed by a pinned key`,
            { message_id: entryMessageId, room_seq: entrySeq }
          );
          continue;
        }
      }

      const fields = fieldsByEntry.get(entry) ?? extractEntryTextFields(entry.envelope);
      const hasQuote = 'quote' in ref || 'excerpt' in ref;
      if (hasQuote) {
        const rawQuote = 'quote' in ref ? ref.quote : ref.excerpt;
        const normalizedQuote = typeof rawQuote === 'string' ? normalizeText(rawQuote) : '';
        if (normalizedQuote.length < MIN_EVIDENCE_TEXT_CHARS) {
          addAssertionProblem(
            HANDOFF_PROBLEM.UNCORROBORATED_ASSERTION,
            `evidence quote must be at least ${MIN_EVIDENCE_TEXT_CHARS} characters`,
            { message_id: entryMessageId, room_seq: entrySeq }
          );
          continue;
        }
        if (!fieldsContain(fields, normalizedQuote)) {
          addAssertionProblem(
            HANDOFF_PROBLEM.QUOTE_NOT_FOUND,
            `quoted text not found in verified transcript entry ${entryMessageId ?? `room_seq ${entrySeq}`}`,
            { message_id: entryMessageId, room_seq: entrySeq }
          );
          continue;
        }
      } else if (claim.length < MIN_EVIDENCE_TEXT_CHARS || !fieldsContain(fields, claim)) {
        addAssertionProblem(
          HANDOFF_PROBLEM.UNCORROBORATED_ASSERTION,
          `evidence omits quote and claim text does not appear in verified transcript entry ${entryMessageId ?? `room_seq ${entrySeq}`}`,
          { message_id: entryMessageId, room_seq: entrySeq }
        );
      }
    }

    if (assertionFile && problems.length === problemsBefore) corroboratedFiles.add(assertionFile);
  }

  if (requireFileAssertions) {
    for (const filePath of budgetEval.normalized_paths) {
      if (!corroboratedFiles.has(filePath)) {
        problems.push({
          code: HANDOFF_PROBLEM.UNCORROBORATED_FILE,
          file: filePath,
          message: `file ${filePath} is not named by any fully corroborated assertion`,
        });
      }
    }
  }

  return makeResult({
    room_id: transcriptResult.room_id,
    checked_entries: transcriptResult.checked,
    checked_assertions: checkedAssertions,
    budget: budgetEval.budget,
    transcript: transcriptResult,
  });
}

/**
 * Throws a structured Error if handoff verification or conciseness budget fails.
 */
export async function assertVerifiedHandoffMemory(handoff, options = {}) {
  const result = await verifyHandoffMemory(handoff, options);
  if (!result.ok) {
    const first = result.problems[0];
    const error = new Error(first ? formatHandoffProblem(first) : 'handoff memory verification failed');
    error.code = first?.code ?? 'HANDOFF_MEMORY_REJECTED';
    error.problems = result.problems;
    error.budget = result.budget;
    error.result = result;
    throw error;
  }
  return result;
}

/** One line per problem, suitable for CLI output and logs. */
export function formatHandoffProblem(problem) {
  let where = 'handoff';
  if (problem.assertion_index != null) {
    const meta = [problem.assertion_id, problem.message_id].filter(Boolean).join(', ');
    where = meta ? `assertion ${problem.assertion_index} (${meta})` : `assertion ${problem.assertion_index}`;
  } else if (problem.file) {
    where = `file ${problem.file}`;
  }
  return `${where}: ${problem.code}: ${problem.message}`;
}
