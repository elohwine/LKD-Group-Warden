function sanitize(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const OCR_TO_DIGIT = {
  I: '1',
  L: '1',
  O: '0',
  Q: '0',
};

const OCR_TO_LETTER = {
  0: 'O',
  1: 'I',
};

const PLATE_PATTERNS = [
  {
    name: 'current',
    mask: 'LLDDLLL',
    baseScore: 95,
    validate(text) {
      // Current GB series excludes I, Q, Z in memory tags and excludes I, Q in suffix.
      const memoryTag = text.slice(0, 2);
      const suffix = text.slice(4);
      if (/[IQZ]/.test(memoryTag)) return false;
      if (/[IQ]/.test(suffix)) return false;
      return true;
    },
  },
  {
    name: 'prefix',
    mask: 'LDDDLLL',
    baseScore: 78,
    validate(text) {
      // Year identifier exclusions used in historic prefix/suffix systems.
      return !/[IOQUZ]/.test(text[0] || '');
    },
  },
  {
    name: 'suffix',
    mask: 'LLLDDDL',
    baseScore: 78,
    validate(text) {
      return !/[IOQUZ]/.test(text[text.length - 1] || '');
    },
  },
  {
    name: 'ni',
    mask: 'LLLDDDD',
    baseScore: 70,
    validate() {
      return true;
    },
  },
];

function buildForMask(input, mask) {
  if (!input || input.length !== mask.length) return null;

  const chars = input.split('');
  let conversions = 0;

  for (let i = 0; i < mask.length; i += 1) {
    const expected = mask[i];
    const value = chars[i];

    if (expected === 'D') {
      if (/^[0-9]$/.test(value)) continue;
      const replacement = OCR_TO_DIGIT[value];
      if (!replacement) return null;
      chars[i] = replacement;
      conversions += 1;
      continue;
    }

    if (expected === 'L') {
      if (/^[A-Z]$/.test(value)) continue;
      const replacement = OCR_TO_LETTER[value];
      if (!replacement) return null;
      chars[i] = replacement;
      conversions += 1;
      continue;
    }
  }

  return {
    text: chars.join(''),
    conversions,
  };
}

function scoreGeneric(candidate) {
  if (!candidate) return 0;
  let score = 0;
  if (candidate.length >= 5 && candidate.length <= 8) score += 22;
  if (/^[A-Z0-9]+$/.test(candidate)) score += 18;
  if (/^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(candidate)) score += 32;
  if (/^[A-Z]+$/.test(candidate) || /^[0-9]+$/.test(candidate)) score -= 10;
  return Math.max(0, Math.min(99, score));
}

function scorePatternCandidate(text, pattern, conversions) {
  if (!text || !pattern) return 0;
  if (typeof pattern.validate === 'function' && !pattern.validate(text)) return 0;
  const conversionPenalty = Math.min(24, conversions * 4);
  return Math.max(0, Math.min(99, pattern.baseScore - conversionPenalty));
}

export function scoreUkVrmCandidate(value) {
  const clean = sanitize(value);
  if (!clean) return 0;

  let best = scoreGeneric(clean);

  for (const pattern of PLATE_PATTERNS) {
    const candidate = buildForMask(clean, pattern.mask);
    if (!candidate) continue;
    best = Math.max(best, scorePatternCandidate(candidate.text, pattern, candidate.conversions));
  }

  return best;
}

export function normalizeUkVrmFromOcr(value) {
  const clean = sanitize(value);
  if (!clean) return '';

  const baseline = scoreGeneric(clean);
  let best = { text: clean, score: baseline };

  for (const pattern of PLATE_PATTERNS) {
    const candidate = buildForMask(clean, pattern.mask);
    if (!candidate) continue;

    const score = scorePatternCandidate(candidate.text, pattern, candidate.conversions);
    if (score > best.score) {
      best = { text: candidate.text, score };
    }
  }

  // Apply pattern rewrite only when it materially improves confidence.
  if (best.text !== clean && best.score >= baseline + 8) {
    return best.text;
  }

  return clean;
}

export function isLikelyCurrentUkVrm(value) {
  const normalized = normalizeUkVrmFromOcr(value);
  return /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(normalized);
}
