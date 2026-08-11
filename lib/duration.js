// Duration policy: compute exact elapsed seconds first, then derive minutes.
// This avoids scattered ad-hoc rounding and keeps frontend/backend consistent.

export const DURATION_MINUTE_POLICY = 'ceil';

export function parseInstantMs(value) {
  if (!value) return NaN;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

export function getElapsedSeconds(startIso, endIso) {
  const elapsedMs = getElapsedMilliseconds(startIso, endIso);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / 1000);
}

export function getElapsedMilliseconds(startIso, endIso) {
  const startMs = parseInstantMs(startIso);
  const endMs = parseInstantMs(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  const diffMs = endMs - startMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return diffMs;
}

export function getBillableMinutesFromSeconds(seconds, policy = DURATION_MINUTE_POLICY) {
  const safeSeconds = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
  if (safeSeconds <= 0) return 0;

  if (policy === 'floor') return Math.floor(safeSeconds / 60);
  if (policy === 'nearest') return Math.round(safeSeconds / 60);
  // Default and recommended for enforcement durations: any partial minute counts.
  return Math.ceil(safeSeconds / 60);
}

export function getBillableMinutesFromMilliseconds(milliseconds, policy = DURATION_MINUTE_POLICY) {
  const safeMs = Number.isFinite(Number(milliseconds)) ? Math.max(0, Number(milliseconds)) : 0;
  if (safeMs <= 0) return 0;

  if (policy === 'floor') return Math.floor(safeMs / 60000);
  if (policy === 'nearest') return Math.round(safeMs / 60000);
  // Default and recommended for enforcement durations: any partial minute counts.
  return Math.ceil(safeMs / 60000);
}

export function getBillableMinutes(startIso, endIso, policy = DURATION_MINUTE_POLICY) {
  return getBillableMinutesFromMilliseconds(getElapsedMilliseconds(startIso, endIso), policy);
}
