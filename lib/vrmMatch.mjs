import { normalizeVrm } from './normalizeVrm.mjs';

export { normalizeVrm };

/**
 * Minimum similarity (0-100) at which a permitted VRM is treated as a
 * "possible permit match" for the scanned/typed VRM.
 *
 * On a 7-character plate: one confusable swap (0/O, 1/I, ...) scores 95,
 * one arbitrary wrong character scores 86, two wrong characters score 71.
 */
export const VRM_NEAR_MATCH_THRESHOLD = 85;

/** Max number of extra permit lookups run for confusable variants. */
export const VRM_VARIANT_LOOKUP_LIMIT = 6;

/**
 * Max number of extra permit lookups run for missing / extra character
 * variants. Only used when the scanned VRM is not a current-format UK plate
 * (AB12CDE) and the confusable-swap probe found nothing: a dropped or
 * doubled character always breaks the current format, and a current-format
 * plate missing its first letter (B10CDE) still looks like a valid old
 * prefix plate, so older formats are probed too.
 *
 * A missing digit on an AB12CDE plate has 19 format-valid candidates; a
 * missing letter has up to 76 (26 letters x up to 3 positions), so the bound
 * covers any single dropped character. Lookups run in batches of
 * `VRM_VARIANT_LOOKUP_BATCH` and stop at the first permitted hit.
 */
export const VRM_LENGTH_VARIANT_LOOKUP_LIMIT = 80;
export const VRM_VARIANT_LOOKUP_BATCH = 16;

const VRM_MIN_LENGTH = 5;
const VRM_MAX_LENGTH = 8;
const PLATE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export const PERMIT_STATUS = Object.freeze({
  PERMITTED: 'permitted',
  /** The exact VRM has a permit request waiting for approval (warning only). */
  PENDING: 'pending_permit',
  NEAR_MATCH: 'near_match',
  NO_PERMIT: 'no_permit',
});

/**
 * True when the authorization payload carries a permit request that is still
 * waiting for approval. Such a request never authorises parking.
 */
export function hasPendingPermit(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.hasAuthorization) return false;
  return Boolean(result.hasPendingPermit) || Boolean(result.pendingPermit);
}

/**
 * Character pairs that OCR / human reading commonly confuse on UK plates.
 * Stored as groups; both directions are confusable.
 */
const CONFUSABLE_GROUPS = [
  ['0', 'O', 'D', 'Q'],
  ['1', 'I', 'L'],
  ['2', 'Z'],
  ['4', 'A'],
  ['5', 'S'],
  ['6', 'G'],
  ['7', 'T'],
  ['8', 'B'],
];

function buildConfusablePairs(groups) {
  const pairs = new Set();
  groups.forEach((group) => {
    group.forEach((left) => {
      group.forEach((right) => {
        if (left !== right) pairs.add(`${left}${right}`);
      });
    });
  });
  return pairs;
}

export const CONFUSABLE_VRM_PAIRS = buildConfusablePairs(CONFUSABLE_GROUPS);

const CONFUSABLE_SUBSTITUTION_COST = 0.35;
const TRANSPOSITION_COST = 0.6;

export function confusableAlternatives(char) {
  const upper = String(char || '').toUpperCase();
  const group = CONFUSABLE_GROUPS.find((entry) => entry.includes(upper));
  if (!group) return [];
  return group.filter((entry) => entry !== upper);
}

export function substitutionCost(leftChar, rightChar) {
  if (leftChar === rightChar) return 0;
  if (CONFUSABLE_VRM_PAIRS.has(`${leftChar}${rightChar}`)) return CONFUSABLE_SUBSTITUTION_COST;
  return 1;
}

/**
 * Damerau-style weighted edit distance:
 * - insert / delete: 1
 * - substitute: 0.35 for confusable pairs, 1 otherwise
 * - adjacent transposition: 0.6
 */
export function weightedEditDistance(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const subCost = substitutionCost(a[i - 1], b[j - 1]);
      let best = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + subCost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && a[i - 1] !== a[i - 2]) {
        best = Math.min(best, dp[i - 2][j - 2] + TRANSPOSITION_COST);
      }
      dp[i][j] = best;
    }
  }

  return dp[rows - 1][cols - 1];
}

export function vrmSimilarityPercent(left, right) {
  const a = normalizeVrm(left);
  const b = normalizeVrm(right);
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  const distance = weightedEditDistance(a, b);
  const similarity = Math.max(0, 1 - (distance / maxLen));
  return Math.round(similarity * 100);
}

/**
 * Walk an authorization API payload and collect every VRM-like string.
 */
export function collectAuthorizationVrmCandidates(payload, options = {}) {
  const minLen = Number(options.minLen || 5);
  const maxLen = Number(options.maxLen || 8);
  const candidates = new Set();
  const seen = new Set();
  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (typeof current === 'string') {
      const normalized = normalizeVrm(current);
      if (normalized.length >= minLen && normalized.length <= maxLen) {
        candidates.add(normalized);
      }
      continue;
    }

    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }

    if (typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    Object.entries(current).forEach(([key, value]) => {
      const normalizedKey = String(key || '').toLowerCase();
      // A pending request is for the scanned plate itself, never a near-match candidate.
      if (normalizedKey === 'matchconfidence' || normalizedKey === 'permitreviewdecision' || normalizedKey === 'pendingpermit') return;
      if (typeof value === 'string' && /vrm|reg|registration|plate|vehicle/i.test(normalizedKey)) {
        const normalizedValue = normalizeVrm(value);
        if (normalizedValue.length >= minLen && normalizedValue.length <= maxLen) {
          candidates.add(normalizedValue);
        }
      }

      if (value && (typeof value === 'object' || Array.isArray(value))) {
        queue.push(value);
      }
    });
  }

  return Array.from(candidates);
}

function pickBestCandidate(targetVrm, candidates) {
  let best = { vrm: '', scorePercent: 0 };
  for (const candidate of candidates) {
    const scorePercent = vrmSimilarityPercent(targetVrm, candidate);
    if (scorePercent > best.scorePercent) {
      best = { vrm: candidate, scorePercent };
    }
  }
  return best;
}

/**
 * Decorate an authorization result with `matchConfidence`, scored against
 * VRM-like strings found inside the API payload.
 */
export function withAuthorizationMatchConfidence(result, inputVrm) {
  if (!result || typeof result !== 'object') return result;

  const targetVrm = normalizeVrm(inputVrm);
  if (!targetVrm) return result;

  const hasAuthorization = Boolean(result?.hasAuthorization);
  const candidateVrmsRaw = collectAuthorizationVrmCandidates(result);
  const candidateVrms = hasAuthorization
    ? candidateVrmsRaw
    : candidateVrmsRaw.filter((candidate) => candidate !== targetVrm);

  if (candidateVrms.length === 0) {
    return {
      ...result,
      matchConfidence: {
        targetVrm,
        bestVrm: '',
        scorePercent: 0,
        comparedCount: 0,
        source: 'backend',
      },
    };
  }

  const best = pickBestCandidate(targetVrm, candidateVrms);
  return {
    ...result,
    matchConfidence: {
      targetVrm,
      bestVrm: best.vrm,
      scorePercent: Number(best.scorePercent || 0),
      comparedCount: candidateVrms.length,
      source: 'backend',
    },
  };
}

/**
 * How plausible a string is as a UK registration (used only to order variants
 * with equal similarity so the most likely correction is looked up first).
 */
export const CURRENT_FORMAT_PLAUSIBILITY = 3;

export function ukPlatePlausibility(vrm) {
  const value = normalizeVrm(vrm);
  if (/^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(value)) return CURRENT_FORMAT_PLAUSIBILITY; // current format AB12CDE
  if (/^[A-Z][0-9]{1,3}[A-Z]{3}$/.test(value)) return 2; // prefix A123BCD
  if (/^[A-Z]{3}[0-9]{1,3}[A-Z]$/.test(value)) return 2; // suffix ABC123D
  if (/^[A-Z]{1,3}[0-9]{1,4}$/.test(value) || /^[0-9]{1,4}[A-Z]{1,3}$/.test(value)) return 1; // dateless
  return 0;
}

/**
 * Generate likely-misread alternatives of a VRM:
 * single-position confusable substitutions and adjacent transpositions.
 * Ranked by similarity to the input, then UK-format plausibility; deduped,
 * input excluded.
 */
export function generateConfusableVariants(inputVrm, options = {}) {
  const max = Math.max(0, Number(options.max ?? VRM_VARIANT_LOOKUP_LIMIT));
  const target = normalizeVrm(inputVrm);
  if (!target || max === 0) return [];

  const variants = new Set();
  const chars = target.split('');

  for (let index = 0; index < chars.length; index += 1) {
    confusableAlternatives(chars[index]).forEach((alt) => {
      const next = [...chars];
      next[index] = alt;
      variants.add(next.join(''));
    });
  }

  for (let index = 0; index < chars.length - 1; index += 1) {
    if (chars[index] === chars[index + 1]) continue;
    const next = [...chars];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    variants.add(next.join(''));
  }

  variants.delete(target);

  return Array.from(variants)
    .map((vrm) => ({ vrm, scorePercent: vrmSimilarityPercent(target, vrm), plausibility: ukPlatePlausibility(vrm) }))
    .sort((left, right) => (
      (right.scorePercent - left.scorePercent)
      || (right.plausibility - left.plausibility)
      || left.vrm.localeCompare(right.vrm)
    ))
    .slice(0, max)
    .map((entry) => entry.vrm);
}

/**
 * Generate alternatives of a VRM that are one character longer or shorter:
 * a dropped character (AB0CDE -> AB10CDE) or an extra one (AB100CDE -> AB10CDE).
 *
 * Only variants that fit a known UK plate format are kept, otherwise the
 * candidate space (36 characters x every position) is far too large to probe.
 * Ranked by similarity, then plausibility, then shortest-first.
 */
export function generateLengthVariants(inputVrm, options = {}) {
  const max = Math.max(0, Number(options.max ?? VRM_LENGTH_VARIANT_LOOKUP_LIMIT));
  const target = normalizeVrm(inputVrm);
  if (!target || max === 0) return [];

  const variants = new Set();
  const chars = target.split('');

  if (chars.length < VRM_MAX_LENGTH) {
    for (let index = 0; index <= chars.length; index += 1) {
      PLATE_CHARS.forEach((char) => {
        const next = [...chars.slice(0, index), char, ...chars.slice(index)].join('');
        if (ukPlatePlausibility(next) > 0) variants.add(next);
      });
    }
  }

  if (chars.length > VRM_MIN_LENGTH) {
    for (let index = 0; index < chars.length; index += 1) {
      const next = [...chars.slice(0, index), ...chars.slice(index + 1)].join('');
      if (ukPlatePlausibility(next) > 0) variants.add(next);
    }
  }

  variants.delete(target);

  return Array.from(variants)
    .map((vrm) => ({ vrm, scorePercent: vrmSimilarityPercent(target, vrm), plausibility: ukPlatePlausibility(vrm) }))
    .sort((left, right) => (
      (right.scorePercent - left.scorePercent)
      || (right.plausibility - left.plausibility)
      || (left.vrm.length - right.vrm.length)
      || left.vrm.localeCompare(right.vrm)
    ))
    .slice(0, max)
    .map((entry) => entry.vrm);
}

/**
 * Classify a (decorated) authorization result.
 */
export function resolvePermitStatus(result, threshold = VRM_NEAR_MATCH_THRESHOLD) {
  if (!result || typeof result !== 'object') return '';
  if (result.hasAuthorization) return PERMIT_STATUS.PERMITTED;
  // The exact plate is known to the system with a request awaiting approval:
  // this outranks a "possible misread" of a different, permitted plate.
  if (hasPendingPermit(result)) return PERMIT_STATUS.PENDING;
  const score = Number(result?.matchConfidence?.scorePercent || 0);
  const bestVrm = String(result?.matchConfidence?.bestVrm || '').trim();
  const nearMatch = Boolean(result?.nearMatch) || (score >= threshold && Boolean(bestVrm));
  return nearMatch ? PERMIT_STATUS.NEAR_MATCH : PERMIT_STATUS.NO_PERMIT;
}

/**
 * Map a permit result to the badge state used by capture cards / gallery rows.
 */
export function permitBadgeStatus(result, threshold = VRM_NEAR_MATCH_THRESHOLD) {
  const status = resolvePermitStatus(result, threshold);
  if (status === PERMIT_STATUS.PERMITTED) return 'has_permit';
  if (status === PERMIT_STATUS.PENDING) return 'pending_permit';
  if (status === PERMIT_STATUS.NEAR_MATCH) return 'near_match';
  if (status === PERMIT_STATUS.NO_PERMIT) return 'no_permit';
  return '';
}

export function isNearMatchResult(result, threshold = VRM_NEAR_MATCH_THRESHOLD) {
  return resolvePermitStatus(result, threshold) === PERMIT_STATUS.NEAR_MATCH;
}

/**
 * True when a near-match result still needs the warden's decision.
 */
export function needsNearMatchDecision(result, decision = null) {
  if (!isNearMatchResult(result)) return false;
  const resolved = decision || result?.permitReviewDecision || null;
  if (!resolved || typeof resolved !== 'object') return true;
  const decidedFor = normalizeVrm(resolved.targetVrm || '');
  const target = normalizeVrm(result?.matchConfidence?.targetVrm || '');
  if (decidedFor && target && decidedFor !== target) return true;
  return !String(resolved.decision || '').trim();
}

export function buildPermitReviewDecision({ result, decision, targetVrm = '' }) {
  return {
    targetVrm: normalizeVrm(targetVrm || result?.matchConfidence?.targetVrm || ''),
    nearMatchVrm: normalizeVrm(result?.matchConfidence?.bestVrm || ''),
    scorePercent: Number(result?.matchConfidence?.scorePercent || 0),
    decision: String(decision || '').trim(),
    decidedAt: new Date().toISOString(),
  };
}

/**
 * Look up variants in parallel batches (highest-ranked first) and return the
 * permitted one closest to the target, or null. Stops after the first batch
 * that contains a hit; failed lookups are ignored.
 */
async function probePermittedVariant(targetVrm, variants, lookup, batchSize = VRM_VARIANT_LOOKUP_BATCH) {
  const size = Math.max(1, Number(batchSize) || 1);
  let probed = 0;
  for (let start = 0; start < variants.length; start += size) {
    const batch = variants.slice(start, start + size);
    const settled = await Promise.allSettled(batch.map((variant) => lookup(variant)));
    probed += batch.length;
    let best = null;
    settled.forEach((entry, index) => {
      if (entry.status !== 'fulfilled') return;
      const value = entry.value;
      if (!value || typeof value !== 'object' || !value.hasAuthorization) return;
      const variant = batch[index];
      const scorePercent = vrmSimilarityPercent(targetVrm, variant);
      if (!best || scorePercent > best.scorePercent) {
        best = { vrm: variant, scorePercent, result: value };
      }
    });
    if (best) return { ...best, probed };
  }
  return null;
}

/**
 * Run a permit lookup for `vrm`, and when it misses, probe likely misreads so
 * a plate belonging to a permitted vehicle is flagged:
 *
 * 1. confusable swaps / transpositions (AB1OCDE -> AB10CDE), bounded by
 *    `variantLimit`;
 * 2. only when the scanned VRM is not a current-format plate: a missing or
 *    extra character (AB0CDE -> AB10CDE, AB100CDE -> AB10CDE), bounded by
 *    `lengthVariantLimit`, probed in batches of `batchSize` with early exit.
 *
 * Every probed variant is a single edit away from the input by construction,
 * so a permitted variant is always reported as a near match (the percentage
 * is informational; a 5/6-character plate would otherwise fall under the
 * threshold on a one-character length fix).
 *
 * `lookup(vrm)` must return the raw API response for that VRM.
 */
export async function lookupAuthorizationWithNearMatch(inputVrm, lookup, options = {}) {
  const targetVrm = normalizeVrm(inputVrm);
  if (!targetVrm || typeof lookup !== 'function') return null;

  const threshold = Number(options.threshold ?? VRM_NEAR_MATCH_THRESHOLD);
  const variantLimit = Number(options.variantLimit ?? VRM_VARIANT_LOOKUP_LIMIT);
  const lengthVariantLimit = Number(options.lengthVariantLimit ?? VRM_LENGTH_VARIANT_LOOKUP_LIMIT);
  const batchSize = Number(options.batchSize ?? VRM_VARIANT_LOOKUP_BATCH);

  const primary = await lookup(targetVrm);
  const decorated = withAuthorizationMatchConfidence(primary, targetVrm);
  if (!decorated || typeof decorated !== 'object') return decorated;

  if (decorated.hasAuthorization) {
    return { ...decorated, nearMatch: false };
  }

  // A pending request for this exact plate means the plate is already known;
  // do not spend lookups probing misreads of it.
  if (hasPendingPermit(decorated)) {
    return { ...decorated, nearMatch: false };
  }

  const backendBest = decorated.matchConfidence || null;
  if (backendBest && backendBest.bestVrm && Number(backendBest.scorePercent || 0) >= threshold) {
    return { ...decorated, nearMatch: true };
  }

  let comparedCount = Number(backendBest?.comparedCount || 0);

  const confusableVariants = generateConfusableVariants(targetVrm, { max: variantLimit });
  let best = await probePermittedVariant(targetVrm, confusableVariants, lookup, batchSize);
  comparedCount += best ? best.probed : confusableVariants.length;

  if (!best && ukPlatePlausibility(targetVrm) < CURRENT_FORMAT_PLAUSIBILITY) {
    const lengthVariants = generateLengthVariants(targetVrm, { max: lengthVariantLimit });
    best = await probePermittedVariant(targetVrm, lengthVariants, lookup, batchSize);
    comparedCount += best ? best.probed : lengthVariants.length;
  }

  // #region agent log
  fetch('http://127.0.0.1:7816/ingest/d49109f6-c502-46e9-b8e2-2c14a52f8d97',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f2c557'},body:JSON.stringify({sessionId:'f2c557',runId:'pre-fix',hypothesisId:'A',location:'lib/vrmMatch.mjs:lookupAuthorizationWithNearMatch',message:'permit near-match lookup finished',data:{targetVrm,confusableVariants,nearMatch:Boolean(best),bestVrm:best?.vrm||'',scorePercent:best?.scorePercent||0,plausibility:ukPlatePlausibility(targetVrm)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (best) {
    return {
      ...decorated,
      nearMatch: true,
      nearMatchAuthorization: best.result?.authorization || null,
      matchConfidence: {
        targetVrm,
        bestVrm: best.vrm,
        scorePercent: best.scorePercent,
        comparedCount,
        source: 'variant',
      },
    };
  }

  return {
    ...decorated,
    nearMatch: false,
    matchConfidence: {
      ...(backendBest || { targetVrm, bestVrm: '', scorePercent: 0 }),
      comparedCount,
      source: backendBest?.bestVrm ? 'backend' : 'variant',
    },
  };
}
