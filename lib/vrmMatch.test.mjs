import { describe, expect, it } from 'vitest';
import {
  PERMIT_STATUS,
  VRM_NEAR_MATCH_THRESHOLD,
  buildPermitReviewDecision,
  collectAuthorizationVrmCandidates,
  generateConfusableVariants,
  generateLengthVariants,
  lookupAuthorizationWithNearMatch,
  needsNearMatchDecision,
  permitBadgeStatus,
  resolvePermitStatus,
  vrmSimilarityPercent,
  withAuthorizationMatchConfidence,
} from './vrmMatch.mjs';

describe('vrmSimilarityPercent', () => {
  it('scores identical plates at 100 regardless of spacing and case', () => {
    expect(vrmSimilarityPercent('AB12 CDE', 'ab12cde')).toBe(100);
  });

  it('scores a single confusable swap above the near-match threshold', () => {
    expect(vrmSimilarityPercent('AB12CDO', 'AB12CD0')).toBe(95);
    expect(vrmSimilarityPercent('AB12CDE', 'A8I2CDE')).toBeGreaterThanOrEqual(VRM_NEAR_MATCH_THRESHOLD);
    expect(vrmSimilarityPercent('AB12CDE', 'AB12CDG')).toBeLessThan(vrmSimilarityPercent('AB12CDE', 'AB12CD6') + 1);
  });

  it('scores extended confusables (6/G, 4/A, 7/T, 0/D) as cheap substitutions', () => {
    expect(vrmSimilarityPercent('AB12CDG', 'AB12CD6')).toBe(95);
    expect(vrmSimilarityPercent('AB12ADE', 'AB124DE')).toBe(95);
    expect(vrmSimilarityPercent('AB12TDE', 'AB127DE')).toBe(95);
    expect(vrmSimilarityPercent('AB12DDE', 'AB120DE')).toBe(95);
  });

  it('scores one arbitrary wrong character around 86 and two below threshold', () => {
    expect(vrmSimilarityPercent('AB12CDE', 'AB12CDX')).toBe(86);
    expect(vrmSimilarityPercent('AB12CDE', 'AB12CXY')).toBeLessThan(VRM_NEAR_MATCH_THRESHOLD);
  });

  it('treats an adjacent transposition as cheaper than two substitutions', () => {
    expect(vrmSimilarityPercent('AB12CDE', 'AB21CDE')).toBeGreaterThan(vrmSimilarityPercent('AB12CDE', 'AB34CDE'));
    expect(vrmSimilarityPercent('AB12CDE', 'AB21CDE')).toBeGreaterThanOrEqual(VRM_NEAR_MATCH_THRESHOLD);
  });

  it('returns 0 for empty input', () => {
    expect(vrmSimilarityPercent('', 'AB12CDE')).toBe(0);
  });

  it('scores a single missing or extra character on a 7-character plate above threshold', () => {
    expect(vrmSimilarityPercent('AB0CDE', 'AB10CDE')).toBe(86);
    expect(vrmSimilarityPercent('AB100CDE', 'AB10CDE')).toBe(88);
  });
});

describe('generateLengthVariants', () => {
  it('restores a dropped digit, ranking current-format plates first', () => {
    const variants = generateLengthVariants('AB0CDE');
    expect(variants).toContain('AB10CDE');
    expect(variants).toContain('AB00CDE');
    expect(variants).toContain('AB09CDE');
    expect(variants).not.toContain('AB0CDE');
    expect(variants).not.toContain('AAB0CDE');
    // 19 AB?0CDE / AB0?CDE candidates come before the two prefix-format deletions (A0CDE, B0CDE).
    expect(variants.slice(0, 19).every((variant) => /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(variant))).toBe(true);
    expect(variants.length).toBe(21);
  });

  it('restores a dropped letter anywhere in the plate within the default bound', () => {
    expect(generateLengthVariants('AB12CD')).toContain('AB12CDE');
    expect(generateLengthVariants('AB12CD')).toContain('AB12ECD');
    expect(generateLengthVariants('B12CDE')).toContain('AB12CDE');
    expect(generateLengthVariants('A12CDE')).toContain('AZ12CDE');
    expect(generateLengthVariants('AB12CD').length).toBeLessThanOrEqual(80);
  });

  it('removes an extra character', () => {
    expect(generateLengthVariants('AB100CDE')).toContain('AB10CDE');
    expect(generateLengthVariants('AB10CDEE')).toContain('AB10CDE');
    expect(generateLengthVariants('ABB10CDE')).toContain('AB10CDE');
  });

  it('handles prefix and suffix formats', () => {
    expect(generateLengthVariants('A123BC')).toContain('A123BCD');
    expect(generateLengthVariants('AB123D')).toContain('ABC123D');
  });

  it('returns nothing for empty or zero bound', () => {
    expect(generateLengthVariants('', { max: 5 })).toEqual([]);
    expect(generateLengthVariants('AB0CDE', { max: 0 })).toEqual([]);
  });
});

describe('generateConfusableVariants', () => {
  it('produces confusable substitutions and transpositions, excluding the input', () => {
    const variants = generateConfusableVariants('AB10CDE', { max: 50 });
    expect(variants).not.toContain('AB10CDE');
    expect(variants).toContain('AB1OCDE');
    expect(variants).toContain('ABI0CDE');
    expect(variants).toContain('A810CDE');
    expect(variants).toContain('BA10CDE');
  });

  it('respects the max bound and ranks confusables first', () => {
    const variants = generateConfusableVariants('AB10CDE', { max: 3 });
    expect(variants).toHaveLength(3);
    variants.forEach((variant) => {
      expect(vrmSimilarityPercent('AB10CDE', variant)).toBe(95);
    });
  });

  it('tries variants that form a valid UK plate before less plausible ones', () => {
    // AB1OCDE (letter O) -> AB10CDE is the only single-swap variant in AB12CDE format.
    const variants = generateConfusableVariants('AB1OCDE', { max: 6 });
    expect(variants[0]).toBe('AB10CDE');
    // A letter-for-digit misread in the middle block should still be found with a small bound.
    expect(generateConfusableVariants('ABI2CDE', { max: 2 })).toContain('AB12CDE');
    expect(generateConfusableVariants('AB12CD0', { max: 3 })).toContain('AB12CDO');
  });

  it('returns nothing for empty or zero bound', () => {
    expect(generateConfusableVariants('', { max: 5 })).toEqual([]);
    expect(generateConfusableVariants('AB10CDE', { max: 0 })).toEqual([]);
  });
});

describe('collectAuthorizationVrmCandidates', () => {
  it('collects VRM-like strings from nested payloads and skips our own metadata', () => {
    const payload = {
      hasAuthorization: false,
      authorization: null,
      nearby: [{ vrm: 'ab12 cde' }, { registration: 'XY99ZZZ' }],
      permits: { vehicle: { plate: 'LM34NOP' } },
      matchConfidence: { bestVrm: 'SHOULDNOT' },
      note: 'TOOLONGTOBEAPLATE',
    };
    const candidates = collectAuthorizationVrmCandidates(payload);
    expect(candidates).toEqual(expect.arrayContaining(['AB12CDE', 'XY99ZZZ', 'LM34NOP']));
    expect(candidates).not.toContain('SHOULDNOT');
  });
});

describe('resolvePermitStatus', () => {
  it('classifies permitted, near match, and no permit', () => {
    expect(resolvePermitStatus({ hasAuthorization: true })).toBe(PERMIT_STATUS.PERMITTED);
    expect(resolvePermitStatus({ hasAuthorization: false, matchConfidence: { bestVrm: 'AB12CD0', scorePercent: 95 } })).toBe(PERMIT_STATUS.NEAR_MATCH);
    expect(resolvePermitStatus({ hasAuthorization: false, matchConfidence: { bestVrm: 'AB12CD0', scorePercent: 70 } })).toBe(PERMIT_STATUS.NO_PERMIT);
    expect(resolvePermitStatus({ hasAuthorization: false })).toBe(PERMIT_STATUS.NO_PERMIT);
    expect(resolvePermitStatus(null)).toBe('');
  });

  it('classifies a permit request awaiting approval as pending (warning only)', () => {
    const pending = { id: 'p1', status: 'pending', vrm: 'NA10RTV', siteName: 'The Sidings' };
    expect(resolvePermitStatus({ hasAuthorization: false, hasPendingPermit: true, pendingPermit: pending })).toBe(PERMIT_STATUS.PENDING);
    expect(resolvePermitStatus({ hasAuthorization: false, pendingPermit: pending })).toBe(PERMIT_STATUS.PENDING);
    expect(permitBadgeStatus({ hasAuthorization: false, pendingPermit: pending })).toBe('pending_permit');
    // A real permit always outranks a pending request.
    expect(resolvePermitStatus({ hasAuthorization: true, pendingPermit: pending })).toBe(PERMIT_STATUS.PERMITTED);
    // A pending request for the exact plate outranks a possible misread of another plate.
    expect(resolvePermitStatus({ hasAuthorization: false, pendingPermit: pending, matchConfidence: { bestVrm: 'NA10RTY', scorePercent: 95 } })).toBe(PERMIT_STATUS.PENDING);
    expect(needsNearMatchDecision({ hasAuthorization: false, pendingPermit: pending, matchConfidence: { bestVrm: 'NA10RTY', scorePercent: 95 } })).toBe(false);
  });
});

describe('withAuthorizationMatchConfidence', () => {
  it('ignores the target VRM itself when scoring a miss', () => {
    const decorated = withAuthorizationMatchConfidence({ hasAuthorization: false, vrm: 'AB12CDE' }, 'AB12CDE');
    expect(decorated.matchConfidence.bestVrm).toBe('');
    expect(decorated.matchConfidence.scorePercent).toBe(0);
  });
});

describe('lookupAuthorizationWithNearMatch', () => {
  it('returns permitted without variant lookups when the primary lookup matches', async () => {
    const calls = [];
    const lookup = async (vrm) => {
      calls.push(vrm);
      return { hasAuthorization: true, authorization: { type: 'permit' } };
    };
    const result = await lookupAuthorizationWithNearMatch('AB12CDE', lookup);
    expect(calls).toEqual(['AB12CDE']);
    expect(result.hasAuthorization).toBe(true);
    expect(result.nearMatch).toBe(false);
    expect(resolvePermitStatus(result)).toBe(PERMIT_STATUS.PERMITTED);
  });

  it('returns pending without variant lookups when the exact plate has a request awaiting approval', async () => {
    const calls = [];
    const lookup = async (vrm) => {
      calls.push(vrm);
      return { hasAuthorization: false, hasPendingPermit: true, pendingPermit: { id: 'p1', status: 'pending', vrm, siteName: 'The Sidings' } };
    };
    const result = await lookupAuthorizationWithNearMatch('NA10RTV', lookup);
    expect(calls).toEqual(['NA10RTV']);
    expect(result.nearMatch).toBe(false);
    expect(resolvePermitStatus(result)).toBe(PERMIT_STATUS.PENDING);
    // The pending permit's own VRM must not be scored as a near-match candidate.
    expect(result.matchConfidence.bestVrm).toBe('');
  });

  it('flags a near match when a confusable variant is permitted', async () => {
    const calls = [];
    const lookup = async (vrm) => {
      calls.push(vrm);
      return vrm === 'AB10CDE'
        ? { hasAuthorization: true, authorization: { type: 'permit', site: 'Car park A' } }
        : { hasAuthorization: false };
    };
    const result = await lookupAuthorizationWithNearMatch('AB1OCDE', lookup);
    expect(calls[0]).toBe('AB1OCDE');
    expect(calls.length).toBeLessThanOrEqual(7);
    expect(result.hasAuthorization).toBe(false);
    expect(result.nearMatch).toBe(true);
    expect(result.matchConfidence.bestVrm).toBe('AB10CDE');
    expect(result.matchConfidence.scorePercent).toBe(95);
    expect(result.matchConfidence.source).toBe('variant');
    expect(result.nearMatchAuthorization).toEqual({ type: 'permit', site: 'Car park A' });
    expect(resolvePermitStatus(result)).toBe(PERMIT_STATUS.NEAR_MATCH);
  });

  it('uses backend candidates when they already clear the threshold', async () => {
    const calls = [];
    const lookup = async (vrm) => {
      calls.push(vrm);
      return { hasAuthorization: false, nearbyPermits: [{ vrm: 'AB12CD0' }] };
    };
    const result = await lookupAuthorizationWithNearMatch('AB12CDO', lookup);
    expect(calls).toEqual(['AB12CDO']);
    expect(result.nearMatch).toBe(true);
    expect(result.matchConfidence.source).toBe('backend');
  });

  it('flags a near match when the scanned VRM is missing a character', async () => {
    const calls = [];
    const lookup = async (vrm) => {
      calls.push(vrm);
      return vrm === 'AB10CDE'
        ? { hasAuthorization: true, authorization: { type: 'permit' } }
        : { hasAuthorization: false };
    };
    const result = await lookupAuthorizationWithNearMatch('AB0CDE', lookup);
    expect(calls[0]).toBe('AB0CDE');
    // primary + confusable swaps + one batch of length variants (early exit)
    expect(calls.length).toBeLessThanOrEqual(1 + 6 + 16);
    expect(result.nearMatch).toBe(true);
    expect(result.matchConfidence.bestVrm).toBe('AB10CDE');
    expect(result.matchConfidence.scorePercent).toBe(86);
    expect(result.matchConfidence.source).toBe('variant');
    expect(result.matchConfidence.comparedCount).toBe(calls.length - 1);
    expect(resolvePermitStatus(result)).toBe(PERMIT_STATUS.NEAR_MATCH);
  });

  it('flags a near match when the scanned VRM is missing a letter, stopping at the first hit', async () => {
    const calls = [];
    const lookup = async (vrm) => {
      calls.push(vrm);
      return vrm === 'AB12CDZ'
        ? { hasAuthorization: true, authorization: { type: 'permit' } }
        : { hasAuthorization: false };
    };
    const result = await lookupAuthorizationWithNearMatch('AB12CD', lookup);
    expect(result.nearMatch).toBe(true);
    expect(result.matchConfidence.bestVrm).toBe('AB12CDZ');
    expect(calls.length).toBeLessThanOrEqual(1 + 6 + 80);
    expect(calls[calls.length - 1].length).toBe(7);
  });

  it('flags a near match when the dropped first letter leaves an old-format-looking plate', async () => {
    const lookup = async (vrm) => (vrm === 'AB10CDE'
      ? { hasAuthorization: true, authorization: { type: 'permit' } }
      : { hasAuthorization: false });
    const result = await lookupAuthorizationWithNearMatch('B10CDE', lookup);
    expect(result.nearMatch).toBe(true);
    expect(result.matchConfidence.bestVrm).toBe('AB10CDE');
  });

  it('flags a near match when the scanned VRM has an extra character', async () => {
    const lookup = async (vrm) => (vrm === 'AB10CDE'
      ? { hasAuthorization: true, authorization: { type: 'permit' } }
      : { hasAuthorization: false });
    const result = await lookupAuthorizationWithNearMatch('AB100CDE', lookup);
    expect(result.nearMatch).toBe(true);
    expect(result.matchConfidence.bestVrm).toBe('AB10CDE');
    expect(result.matchConfidence.scorePercent).toBe(88);
  });

  it('stops probing length variants after the batch that hits', async () => {
    const calls = [];
    const lookup = async (vrm) => {
      calls.push(vrm);
      return vrm === 'AB12CDA'
        ? { hasAuthorization: true, authorization: { type: 'permit' } }
        : { hasAuthorization: false };
    };
    await lookupAuthorizationWithNearMatch('AB12CD', lookup, { batchSize: 4 });
    const lengthCalls = calls.filter((vrm) => vrm.length === 7);
    expect(lengthCalls).toContain('AB12CDA');
    expect(lengthCalls.length).toBeLessThanOrEqual(generateLengthVariants('AB12CD').indexOf('AB12CDA') + 4);
  });

  it('does not probe length variants when the scanned VRM already fits a UK plate format', async () => {
    const calls = [];
    const lookup = async (vrm) => {
      calls.push(vrm);
      return { hasAuthorization: false };
    };
    const result = await lookupAuthorizationWithNearMatch('AB12CDE', lookup);
    expect(calls.length).toBeLessThanOrEqual(1 + 6);
    expect(calls.every((vrm) => vrm.length === 7)).toBe(true);
    expect(result.nearMatch).toBe(false);
  });

  it('reports no permit when no variant is permitted and tolerates failed variant lookups', async () => {
    const lookup = async (vrm) => {
      if (vrm.endsWith('E')) return { hasAuthorization: false };
      throw new Error('network');
    };
    const result = await lookupAuthorizationWithNearMatch('AB12CDE', lookup);
    expect(result.nearMatch).toBe(false);
    expect(resolvePermitStatus(result)).toBe(PERMIT_STATUS.NO_PERMIT);
    expect(result.matchConfidence.comparedCount).toBeGreaterThan(0);
  });
});

describe('needsNearMatchDecision', () => {
  const nearMatch = { hasAuthorization: false, nearMatch: true, matchConfidence: { targetVrm: 'AB1OCDE', bestVrm: 'AB10CDE', scorePercent: 95 } };

  it('requires a decision until one is recorded for the same VRM', () => {
    expect(needsNearMatchDecision(nearMatch)).toBe(true);
    const decision = buildPermitReviewDecision({ result: nearMatch, decision: 'keep' });
    expect(needsNearMatchDecision(nearMatch, decision)).toBe(false);
    expect(needsNearMatchDecision(nearMatch, { ...decision, targetVrm: 'ZZ99ZZZ' })).toBe(true);
  });

  it('never requires a decision for permitted or clear results', () => {
    expect(needsNearMatchDecision({ hasAuthorization: true })).toBe(false);
    expect(needsNearMatchDecision({ hasAuthorization: false })).toBe(false);
  });
});
