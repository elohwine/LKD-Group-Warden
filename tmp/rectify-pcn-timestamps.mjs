import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../lib/firebase-admin.mjs';

const pcnId = process.argv[2] || 'fjNH7DEJbYhPzzn0qnCo';

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value.toDate === 'function') {
    try {
      const d = value.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    } catch (_) {
      return null;
    }
  }
  if (typeof value._seconds === 'number') {
    const millis = (value._seconds * 1000) + Math.floor((Number(value._nanoseconds || 0) || 0) / 1e6);
    const d = new Date(millis);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function pickDate(...values) {
  for (const value of values) {
    const d = toDate(value);
    if (d) return d;
  }
  return null;
}

if (!adminDb) {
  console.error('ADMIN_DB_UNAVAILABLE');
  process.exit(2);
}

const pcnRef = adminDb.collection('pcns').doc(pcnId);
const pcnSnap = await pcnRef.get();
if (!pcnSnap.exists) {
  console.error(`PCN_NOT_FOUND:${pcnId}`);
  process.exit(3);
}

const pcn = pcnSnap.data() || {};
const breachId = String(pcn.breachId || '').trim();
let breach = null;
if (breachId) {
  const breachSnap = await adminDb.collection('breaches').doc(breachId).get();
  if (breachSnap.exists) breach = breachSnap.data() || {};
}

const startFromBreach = pickDate(
  breach?.entryCapturedAt,
  breach?.observationStartTime,
  breach?.entryTime,
  breach?.evidence?.entry?.timestamp
);
const endFromBreach = pickDate(
  breach?.closingCapturedAt,
  breach?.observationEndTime,
  breach?.closedAt,
  breach?.closingEvidence?.closedAt,
  breach?.evidence?.exit?.timestamp,
  breach?.evidence?.latest?.timestamp
);

const startFromPcn = pickDate(
  pcn?.observationStartTime,
  pcn?.observedStartAt,
  pcn?.entryTime
);
const endFromPcn = pickDate(
  pcn?.observationEndTime,
  pcn?.observedEndAt,
  pcn?.closedAt,
  pcn?.observedAt
);

const observedAt = pickDate(pcn?.observedAt);
let start = startFromBreach || startFromPcn || observedAt;
let end = endFromBreach || endFromPcn || observedAt || start;

if (!start && end) start = end;
if (!end && start) end = start;

if (!start || !end) {
  console.error('TIMESTAMPS_UNRESOLVABLE');
  process.exit(4);
}

if (end.getTime() < start.getTime()) {
  const tmp = start;
  start = end;
  end = tmp;
}

const now = new Date();
const updatePayload = {
  observationStartTime: Timestamp.fromDate(start),
  observationEndTime: Timestamp.fromDate(end),
  observedStartAt: Timestamp.fromDate(start),
  observedEndAt: Timestamp.fromDate(end),
  observedAt: Timestamp.fromDate(end),
  entryTime: start.toISOString(),
  closedAt: end.toISOString(),
  updatedAt: Timestamp.fromDate(now),
};

await pcnRef.set(updatePayload, { merge: true });

console.log(JSON.stringify({
  ok: true,
  pcnId,
  breachId: breachId || null,
  previous: {
    observationStartTime: toDate(pcn?.observationStartTime)?.toISOString() || null,
    observationEndTime: toDate(pcn?.observationEndTime)?.toISOString() || null,
    observedAt: toDate(pcn?.observedAt)?.toISOString() || null,
    entryTime: toDate(pcn?.entryTime)?.toISOString() || null,
    closedAt: toDate(pcn?.closedAt)?.toISOString() || null,
  },
  applied: {
    observationStartTime: start.toISOString(),
    observationEndTime: end.toISOString(),
    observedStartAt: start.toISOString(),
    observedEndAt: end.toISOString(),
    observedAt: end.toISOString(),
    entryTime: start.toISOString(),
    closedAt: end.toISOString(),
  },
}, null, 2));
