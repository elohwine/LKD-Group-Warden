const DEMO_SITE_NAMES = ['Mechline', 'France Street', 'Legends Barber', 'Gainford House'];

const DEMO_CONTRAVENTIONS = [
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
];

function isDemoModeEnabled() {
  return String(process.env.NEXT_PUBLIC_DEMO_MODE || '').trim().toLowerCase() === 'true';
}

function normalizeDemoSiteName(site) {
  return String(site?.displayName || site?.name || site?.siteName || site?.id || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isDemoSite(site) {
  const normalized = normalizeDemoSiteName(site);
  if (!normalized) return false;
  return DEMO_SITE_NAMES.some((name) => normalized === String(name).trim().toLowerCase());
}

function buildDemoSites() {
  return DEMO_SITE_NAMES.map((name, index) => ({
    id: `demo-${index + 1}`,
    name,
    displayName: name,
    active: true,
    isActive: true,
    demoMode: true,
  }));
}

export {
  DEMO_CONTRAVENTIONS,
  DEMO_SITE_NAMES,
  buildDemoSites,
  isDemoModeEnabled,
  isDemoSite,
};
