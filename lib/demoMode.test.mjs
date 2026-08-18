import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('demo mode helpers', () => {
  const originalDemoFlag = process.env.NEXT_PUBLIC_DEMO_MODE;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
  });

  afterEach(() => {
    vi.resetModules();
    if (originalDemoFlag === undefined) {
      delete process.env.NEXT_PUBLIC_DEMO_MODE;
    } else {
      process.env.NEXT_PUBLIC_DEMO_MODE = originalDemoFlag;
    }
  });

  it('builds the fixed demo site allowlist', async () => {
    const { buildDemoSites } = await import('./demoMode.js');

    expect(buildDemoSites().map((site) => site.name)).toEqual([
      'Mechline',
      'France Street',
      'Legends Barber',
      'Gainford House',
    ]);
  });

  it('returns the hardcoded demo contraventions for demo sites', async () => {
    const { getContraventionOptions } = await import('./contraventions.js');

    expect(getContraventionOptions({ name: 'Mechline' })).toEqual([
      {
        code: 'unauthorised_parking',
        label: 'Unauthorised parking',
        requiresObservation: true,
        defaultObservationMinutes: 5,
      },
      {
        code: 'parked_on_double_yellow_lines',
        label: 'Parked on double yellow lines',
        requiresObservation: true,
        defaultObservationMinutes: 3,
      },
      {
        code: 'parked_in_a_no_parking_area',
        label: 'Parked in a no parking area',
        requiresObservation: true,
        defaultObservationMinutes: 3,
      },
    ]);
  });
});
