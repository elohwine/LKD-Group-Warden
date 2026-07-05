export const DEFAULT_CONTRAVENTIONS = [
  {
    code: 'C01',
    label: 'Not parked correctly within the markings of the bay or space',
    requiresObservation: true,
    defaultObservationMinutes: 10
  },
  {
    code: 'C02',
    label: 'No valid permit or payment found',
    requiresObservation: true,
    defaultObservationMinutes: 10
  },
  {
    code: 'C03',
    label: 'Parked in a restricted area',
    requiresObservation: false,
    defaultObservationMinutes: 0
  },
  {
    code: 'C04',
    label: 'Vehicle outside permitted site hours',
    requiresObservation: true,
    defaultObservationMinutes: 6
  },
  {
    code: 'C05',
    label: 'Unauthorised vehicle on private land',
    requiresObservation: true,
    defaultObservationMinutes: 10
  }
];

export function getContraventionOptions(site) {
  const custom = Array.isArray(site?.contraventions) ? site.contraventions : [];
  if (custom.length > 0) {
    return custom.map((item, index) => ({
      code: String(item.code || item.value || `SITE-${index + 1}`).trim(),
      label: String(item.label || item.reason || item.name || item.code || `Contravention ${index + 1}`).trim(),
      requiresObservation: Boolean(item.requiresObservation || item.observationRequired),
      defaultObservationMinutes: Number(item.defaultObservationMinutes || item.observationMinutes || 10)
    }));
  }

  return DEFAULT_CONTRAVENTIONS;
}