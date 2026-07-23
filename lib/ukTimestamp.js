export function getUkDateTimeParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { date: '', time: '', secondsTime: '' };

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    time: `${byType.hour}:${byType.minute}`,
    secondsTime: `${byType.hour}:${byType.minute}:${byType.second}`,
  };
}

export function formatUkTimestamp(value) {
  const parts = getUkDateTimeParts(value);
  if (!parts.date || !parts.secondsTime) return '';
  return `${parts.date} ${parts.secondsTime}`;
}

/**
 * Format a timestamp using the device's local timezone.
 * Use this for all warden-facing display so times match the device clock,
 * regardless of where the warden is located.
 * The `Europe/London` functions above are reserved for formal PCN records only.
 */
export function getLocalDateTimeParts(value) {
  if (!value && value !== 0) return { date: '', time: '', secondsTime: '' };
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { date: '', time: '', secondsTime: '' };

  const parts = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    time: `${byType.hour}:${byType.minute}`,
    secondsTime: `${byType.hour}:${byType.minute}:${byType.second}`,
  };
}

export function formatLocalTimestamp(value) {
  const parts = getLocalDateTimeParts(value);
  if (!parts.date || !parts.secondsTime) return '';
  return `${parts.date} ${parts.secondsTime}`;
}