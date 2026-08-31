import { describe, expect, it } from 'vitest';
import { normalizeUkVrmFromOcr } from './ukVrmOcr.mjs';

describe('normalizeUkVrmFromOcr', () => {
  it('converts O and I to 0 and 1 in the middle two-digit block', () => {
    expect(normalizeUkVrmFromOcr('AB1OCDE')).toBe('AB10CDE');
    expect(normalizeUkVrmFromOcr('ABO2CDE')).toBe('AB02CDE');
    expect(normalizeUkVrmFromOcr('ABI2CDE')).toBe('AB12CDE');
    expect(normalizeUkVrmFromOcr('AB12ODE')).toBe('AB12ODE');
    expect(normalizeUkVrmFromOcr('AB12CDE1')).toBe('AB12CDE1');
    expect(normalizeUkVrmFromOcr('AB1O2DE')).toBe('AB102DE');
  });

  it('does not force conversion outside the middle digit block', () => {
    expect(normalizeUkVrmFromOcr('OI23ABC')).toBe('OI23ABC');
    expect(normalizeUkVrmFromOcr('I23ABC0')).toBe('I23ABC0');
    expect(normalizeUkVrmFromOcr('AB12CIE')).toBe('AB12CIE');
  });
});
