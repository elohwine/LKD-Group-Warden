import { DEMO_CONTRAVENTIONS, isDemoModeEnabled, isDemoSite } from './demoMode';

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

const CONTRAVENTION_LABELS = {
  consideration_time_6_minutes: 'Consideration time lapsed before payment (6 minutes)',
  failed_full_duration_payment: 'Full duration payment not made',
  failed_to_make_and_or_validate_payment: 'Failed to make and/or validate payment',
  failed_to_make_payment_within_the_10_minute_consideration_period_allowed: 'Failed to make payment within the consideration period allowed',
  failed_to_register_vehicle_within_the_10_minute_consideration_period_allowed: 'Failed to register vehicle within the consideration period allowed',
  returned_to_the_site_within_the_1_hour_no_return_period: 'Returned to the site within the 1 hour no return period',
  exceeded_the_3_hour_maximum_stay_allowed: 'Exceeded the 3 hour maximum stay allowed',
  exceeded_the_30_minute_maximum_stay_allowed: 'Exceeded the 30 minute maximum stay allowed',
  failed_to_display_a_valid_permit_mnpr: 'Failed to display a valid permit',
  failed_to_park_wholly_within_the_designated_bay_markings_mnpr: 'Failed to park wholly within the designated bay markings',
  loading_bay_exceeded_1_hour_maximum_stay: 'Loading bay exceeded 1 hour maximum stay',
  obstructive_parking: 'Obstructive parking',
  parked_in_a_no_parking_area: 'Parked in a no parking area',
  parked_on_a_crosshatch: 'Parked on a crosshatch',
  parked_on_double_yellow_lines: 'Parked on double yellow lines',
  parking_in_a_disabled_parking_bay_without_a_valid_blue_badge_mnpr: 'Parking in a disabled bay without a valid Blue Badge',
  unauthorised_parking: 'Unauthorised parking'
};

function prettifyKey(value) {
  return String(value || '')
    .replace(/_mnpr$/i, '')
    .replace(/_/g, ' ')
    .replace(/\bmnpr\b/gi, 'MNPR')
    .replace(/\bpcn\b/gi, 'PCN')
    .replace(/\blpr\b/gi, 'LPR')
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .trim();
}

function parseDurationFromText(value) {
  const text = String(value || '').trim();
  if (!text) return 0;

  const normalized = text
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  const hourMatch = normalized.match(/\b(\d+)\s+hour(?:s)?\b/i);
  if (hourMatch) {
    return Number(hourMatch[1]) * 60;
  }

  const minuteMatch = normalized.match(/\b(\d+)\s+minute(?:s)?\b/i);
  if (minuteMatch) {
    return Number(minuteMatch[1]);
  }

  return 0;
}

function normalizeRuleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return ['1', 'true', 'yes', 'on', 'enabled', 'active'].includes(normalized);
}

function isContraventionExplicitlyEnabled(value) {
  if (!value || typeof value !== 'object') return true;

  const explicitFields = [
    'explicitlyEnabled',
    'explicitly_enabled',
    'isExplicitlyEnabled',
    'enabledExplicitly',
    'enabled',
    'isEnabled',
    'active',
    'isActive',
    'status',
  ];

  for (const field of explicitFields) {
    if (!(field in value)) continue;
    return coerceBoolean(value[field]);
  }

  return true;
}

function siteHasContraventionConfig(site) {
  const containers = [
    site?.contraventions,
    site?.anprRules?.contraventions,
    site?.anprRules?.contraventionRules,
    site?.anprRules?.managedContraventionRules,
    site?.contraventionRules,
    site?.rules,
    site?.anprRules?.rules,
    site?.frontendManagedContraventions,
    site?.anprRules?.frontendManagedContraventions,
  ];

  return containers.some((container) => {
    if (Array.isArray(container)) return container.length > 0;
    if (container && typeof container === 'object') return Object.keys(container).length > 0;
    return false;
  });
}

function pickPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function extractMinutesFromRuleConfig(config) {
  if (!config) return 0;

  if (typeof config === 'number') {
    return pickPositiveNumber(config);
  }

  if (typeof config === 'string') {
    return pickPositiveNumber(config) || parseDurationFromText(config);
  }

  if (Array.isArray(config)) {
    for (const item of config) {
      const minutes = extractMinutesFromRuleConfig(item);
      if (minutes > 0) return minutes;
    }
    return 0;
  }

  if (typeof config === 'object') {
    const minuteFields = [
      'observationMinutes',
      'defaultObservationMinutes',
      'considerationMinutes',
      'durationMinutes',
      'maxStayMinutes',
      'graceMinutes',
      'timeLimitMinutes',
      'noReturnMinutes',
      'minutes',
    ];

    for (const field of minuteFields) {
      const minutes = pickPositiveNumber(config[field]);
      if (minutes > 0) return minutes;
    }

    const hourFields = ['hours', 'defaultHours', 'durationHours'];
    for (const field of hourFields) {
      const hours = pickPositiveNumber(config[field]);
      if (hours > 0) return hours * 60;
    }

    for (const value of Object.values(config)) {
      const minutes = extractMinutesFromRuleConfig(value);
      if (minutes > 0) return minutes;
    }
  }

  return 0;
}

function getConfiguredRuleMinutes(site, code, label = '') {
  const codeKey = normalizeRuleKey(code);
  const labelKey = normalizeRuleKey(label);
  if (!codeKey && !labelKey) return 0;

  const candidateKeys = new Set([codeKey, labelKey].filter(Boolean));
  const candidateContainers = [
    site?.contraventions,
    site?.anprRules?.contraventionRules,
    site?.anprRules?.rules,
    site?.anprRules?.managedContraventionRules,
    site?.contraventionRules,
    site?.rules,
    site?.anprRules,
  ].filter(Boolean);

  for (const container of candidateContainers) {
    if (Array.isArray(container)) {
      for (const entry of container) {
        const key = normalizeRuleKey(
          entry?.code || entry?.key || entry?.rule || entry?.name || entry?.id || ''
        );
        if (!candidateKeys.has(key)) continue;
        const minutes = extractMinutesFromRuleConfig(entry);
        if (minutes > 0) return minutes;
      }
      continue;
    }

    if (typeof container !== 'object') continue;

    for (const [rawKey, value] of Object.entries(container)) {
      const key = normalizeRuleKey(rawKey);
      if (!candidateKeys.has(key)) continue;
      const minutes = extractMinutesFromRuleConfig(value);
      if (minutes > 0) return minutes;
    }
  }

  return 0;
}

function parseObservationMinutesFromCode(code, label = '', fallbackMinutes = 0, configuredMinutes = 0) {
  const text = String(code || '');
  const explicitDuration = parseDurationFromText(text) || parseDurationFromText(label);
  if (explicitDuration > 0) return explicitDuration;

  if (configuredMinutes > 0) {
    return configuredMinutes;
  }

  if (/failed_full_duration_payment|failed_to_make_and_or_validate_payment|consideration|register_vehicle_within/i.test(text)) {
    return Number(fallbackMinutes || 0);
  }

  return 0;
}

function extractEnabledContraventionKeys(site) {
  const anprRules = site?.anprRules || {};
  const enabledContainers = [
    // Explicit enabled-only arrays.
    { entries: site?.enabledContraventions, strictEnabledFlag: false },
    { entries: site?.enabledContraventionRules, strictEnabledFlag: false },
    { entries: site?.enabledManagedContraventions, strictEnabledFlag: false },
    { entries: site?.frontendEnabledContraventions, strictEnabledFlag: false },
    { entries: site?.enabledFrontendManagedContraventions, strictEnabledFlag: false },
    { entries: anprRules?.enabledContraventions, strictEnabledFlag: false },
    { entries: anprRules?.enabledContraventionRules, strictEnabledFlag: false },
    { entries: anprRules?.enabledManagedContraventions, strictEnabledFlag: false },
    { entries: anprRules?.frontendEnabledContraventions, strictEnabledFlag: false },
    { entries: anprRules?.enabledFrontendManagedContraventions, strictEnabledFlag: false },
    // In some site docs this field is already the enabled UI subset.
    { entries: site?.frontendManagedContraventions, strictEnabledFlag: false },
    { entries: anprRules?.frontendManagedContraventions, strictEnabledFlag: false },
    // Full contraventions arrays: ONLY accept rows explicitly marked enabled=true.
    { entries: site?.contraventions, strictEnabledFlag: true },
    { entries: anprRules?.contraventions, strictEnabledFlag: true },
    { entries: anprRules?.contraventionRules, strictEnabledFlag: true },
  ];

  const rows = [];
  const seen = new Set();

  for (const container of enabledContainers) {
    const entries = container?.entries;
    const strictEnabledFlag = Boolean(container?.strictEnabledFlag);
    if (!Array.isArray(entries)) continue;

    for (let index = 0; index < entries.length; index += 1) {
      const item = entries[index];
      if (!item) continue;

      if (typeof item === 'string') {
        if (strictEnabledFlag) continue;
        const code = String(item).trim();
        const key = normalizeRuleKey(code);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        rows.push({ code, label: CONTRAVENTION_LABELS[code] || prettifyKey(code) || code });
        continue;
      }

      if (typeof item === 'object') {
        if (strictEnabledFlag && item?.enabled !== true && item?.isEnabled !== true && item?.active !== true && item?.isActive !== true) {
          continue;
        }
        if (!isContraventionExplicitlyEnabled(item)) continue;
        const code = String(item.code || item.value || item.key || item.rule || item.name || `SITE-${index + 1}`).trim();
        const key = normalizeRuleKey(code || item.label || item.reason || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        rows.push({
          ...item,
          code,
          label: String(item.label || item.reason || item.name || CONTRAVENTION_LABELS[code] || prettifyKey(code) || code).trim(),
        });
      }
    }
  }

  return rows;
}

function buildRuleDerivedContraventions(site) {
  const anprRules = site?.anprRules || {};
  const managed = Array.isArray(site?.frontendManagedContraventions)
    ? site.frontendManagedContraventions
    : Array.isArray(anprRules.frontendManagedContraventions)
      ? anprRules.frontendManagedContraventions
      : [];

  if (managed.length === 0) return [];

  const considerationMinutes = Number(
    anprRules.considerationMinutes || site?.considerationMinutes || 0
  );

  return managed.map((rawKey, index) => {
    const key = String(rawKey || '').trim();
    const label = CONTRAVENTION_LABELS[key] || prettifyKey(key) || `Contravention ${index + 1}`;
    const configuredMinutes = getConfiguredRuleMinutes(site, key, label);
    const observationMinutes = parseObservationMinutesFromCode(
      key,
      label,
      considerationMinutes,
      configuredMinutes
    );
    return {
      code: key || `RULE-${index + 1}`,
      label,
      requiresObservation: observationMinutes > 0,
      defaultObservationMinutes: observationMinutes
    };
  });
}

function normalizeCustomContraventions(custom, site) {
  const considerationMinutes = Number(
    site?.anprRules?.considerationMinutes || site?.considerationMinutes || 0
  );

  return custom.map((item, index) => {
    const code = String(item.code || item.value || `SITE-${index + 1}`).trim();
    const label = String(item.label || item.reason || item.name || item.code || `Contravention ${index + 1}`).trim();
    const explicitMinutes = Number(
      item.defaultObservationMinutes ||
      item.observationMinutes ||
      (String(item.type || '').toLowerCase() === 'rule' ? item.value : 0) ||
      0
    );
    const configuredMinutes = getConfiguredRuleMinutes(site, code, label);
    const parsedMinutes = parseObservationMinutesFromCode(code, label, considerationMinutes, configuredMinutes);
    const requiresObservation = Boolean(item.requiresObservation || item.observationRequired || explicitMinutes > 0 || parsedMinutes > 0);
    const defaultObservationMinutes = explicitMinutes > 0
      ? explicitMinutes
      : parsedMinutes > 0
        ? parsedMinutes
        : 0;
    return {
      code,
      label,
      requiresObservation,
      defaultObservationMinutes
    };
  });
}

function extractCustomContraventions(site) {
  const containers = [
    site?.contraventions,
    site?.anprRules?.contraventions,
    site?.anprRules?.contraventionRules,
    site?.anprRules?.managedContraventionRules,
    site?.contraventionRules,
    site?.rules,
    site?.anprRules?.rules,
  ].filter(Boolean);

  const seen = new Set();
  const rows = [];

  for (const container of containers) {
    if (Array.isArray(container)) {
      container.forEach((item, index) => {
        if (!item) return;
        if (typeof item === 'string') {
          const code = String(item).trim() || `SITE-${index + 1}`;
          const key = normalizeRuleKey(code);
          if (seen.has(key)) return;
          seen.add(key);
          rows.push({ code, label: CONTRAVENTION_LABELS[code] || prettifyKey(code) || code });
          return;
        }

        const code = String(item.code || item.value || item.key || item.rule || item.name || `SITE-${index + 1}`).trim();
        const key = normalizeRuleKey(code || item.label || item.reason || '');
        if (!key || seen.has(key)) return;
        if (!isContraventionExplicitlyEnabled(item)) return;
        seen.add(key);
        rows.push(item);
      });
      continue;
    }

    if (typeof container === 'object') {
      Object.entries(container).forEach(([rawKey, value], index) => {
        const code = String(rawKey || '').trim() || `SITE-${index + 1}`;
        const key = normalizeRuleKey(code);
        if (!key || seen.has(key)) return;
        if (value && typeof value === 'object' && !Array.isArray(value) && !isContraventionExplicitlyEnabled(value)) return;
        seen.add(key);

        if (value && typeof value === 'object' && !Array.isArray(value)) {
          rows.push({
            ...value,
            code: String(value.code || value.value || code).trim(),
            label: String(value.label || value.reason || value.name || CONTRAVENTION_LABELS[rawKey] || prettifyKey(rawKey)).trim(),
          });
          return;
        }

        rows.push({ code, label: CONTRAVENTION_LABELS[rawKey] || prettifyKey(rawKey) || code });
      });
    }
  }

  return rows;
}

export function getContraventionOptions(site) {
  if (isDemoModeEnabled() && isDemoSite(site)) {
    return DEMO_CONTRAVENTIONS;
  }

  const hasSiteConfig = siteHasContraventionConfig(site);
  const enabled = extractEnabledContraventionKeys(site);
  if (hasSiteConfig) {
    // Site-configured documents must use enabled-only contraventions.
    return enabled.length > 0 ? normalizeCustomContraventions(enabled, site) : [];
  }

  const custom = extractCustomContraventions(site);
  if (custom.length > 0) {
    return normalizeCustomContraventions(custom, site);
  }

  const ruleDerived = buildRuleDerivedContraventions(site);
  if (ruleDerived.length > 0) {
    return ruleDerived;
  }

  if (hasSiteConfig) {
    return [];
  }

  return DEFAULT_CONTRAVENTIONS;
}