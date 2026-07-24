import { Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../../../lib/firebase-admin.mjs';
import normalizeVrm from '../../../lib/normalizeVrm.mjs';
import { getUkDateTimeParts } from '../../../lib/ukTimestamp';
import { getBillableMinutesFromMilliseconds } from '../../../lib/duration';
import { buildVehicleDetailsRecord } from '../../../lib/vehicleDetails';

function buildPcnNumber(vrm) {
  const safeVrm = normalizeVrm(vrm || '').slice(0, 6) || 'WARDEN';
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(-10);
  return `PCN-${safeVrm}-${stamp}`;
}

function parseInstant(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value?.toDate === 'function') {
    const asDate = value.toDate();
    return Number.isNaN(asDate?.getTime?.()) ? null : asDate;
  }

  if (typeof value === 'number') {
    const asDate = new Date(value);
    return Number.isNaN(asDate.getTime()) ? null : asDate;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // If timezone is missing, treat as UTC to keep behavior deterministic across hosts.
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? raw
    : `${raw}Z`;

  const asDate = new Date(normalized);
  return Number.isNaN(asDate.getTime()) ? null : asDate;
}

const DEFAULT_PCN_REASON = 'No valid permit or payment found';

function resolvePreferredReason({ requestReason = '', breachData = {} } = {}) {
  const incoming = String(requestReason || '').trim();
  const breachCandidates = [
    breachData?.contraventionReason,
    breachData?.reason,
    breachData?.contravention,
    breachData?.manualNote,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const breachPreferred = breachCandidates[0] || '';
  if (incoming && incoming !== DEFAULT_PCN_REASON) return incoming;
  if (breachPreferred) return breachPreferred;
  if (incoming) return incoming;
  return DEFAULT_PCN_REASON;
}

function resolveObservationInstants({ breachData = {}, requestStartRaw = null, requestEndRaw = null, requestTimestamp = null, fallbackNow = new Date() } = {}) {
  const safeBreach = breachData && typeof breachData === 'object' ? breachData : {};
  const cameraRawData = Array.isArray(safeBreach?.cameraRawData) ? safeBreach.cameraRawData : [];

  const firstPhaseInstant = (phase) => {
    const list = cameraRawData
      .filter((record) => String(record?.phase || '').toLowerCase() === phase)
      .map((record) => parseInstant(record?.capturedAt))
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime());
    return list[0] || null;
  };

  // Prefer persisted breach evidence timestamps (same capture chain as stamped images).
  const breachStartCandidates = [
    safeBreach?.evidence?.entry?.capturedAt,
    safeBreach?.sessionEvidence?.entry?.capturedAt,
    firstPhaseInstant('entry'),
    safeBreach?.entryCapturedAt,
    safeBreach?.observationStartTime,
    safeBreach?.entryTime,
    requestStartRaw,
  ];

  const breachEndCandidates = [
    safeBreach?.evidence?.exit?.capturedAt,
    safeBreach?.closingEvidence?.capturedAt,
    safeBreach?.sessionEvidence?.closing?.capturedAt,
    firstPhaseInstant('closing'),
    safeBreach?.closingCapturedAt,
    safeBreach?.observationEndTime,
    safeBreach?.closedAt,
    requestEndRaw,
    requestTimestamp,
  ];

  const start = breachStartCandidates.map(parseInstant).find(Boolean) || parseInstant(requestTimestamp) || fallbackNow;
  const end = breachEndCandidates.map(parseInstant).find(Boolean) || parseInstant(requestTimestamp) || fallbackNow;
  return { start, end };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const decoded = await adminAuth.verifyIdToken(token);
    const actorId = decoded.uid;
    const actorEmail = decoded.email || null;

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const {
      breachId,
      amount,
      reason,
      notes,
      vrm,
      timestamp,
      observationStartTime,
      observationEndTime,
      siteId,
      siteName,
      evidence,
      images,
      imageUrls,
      vehicleDetails,
    } = body;

    if (!breachId) {
      return res.status(400).json({ error: 'Breach ID is required' });
    }

    const breaches = adminDb.collection('breaches');
    const breachRef = breaches.doc(breachId);

    let breachData = {};
    try {
      const breachSnap = await breachRef.get();
      if (breachSnap?.exists) {
        breachData = breachSnap.data() || {};
      }
    } catch (error) {
      console.warn('[convert-to-pcn] Could not read breach before conversion:', error?.message);
    }

    const vrmValue = normalizeVrm(vrm || breachData?.vrm || '');
    if (!vrmValue) {
      return res.status(400).json({ error: 'VRM is required to convert breach to PCN' });
    }

    const requestedAmount = Number(amount);
    const breachAmount = Number(breachData?.pcnAmount || breachData?.amount || 100);
    const amountValue = Number.isFinite(requestedAmount) && requestedAmount > 0
      ? requestedAmount
      : (Number.isFinite(breachAmount) && breachAmount > 0 ? breachAmount : 100);

    const now = new Date();
    const eventTime = parseInstant(timestamp);
    const safeEventTime = eventTime || now;
    const requestStartRaw = observationStartTime || null;
    const requestEndRaw = observationEndTime || null;
    const { start: safeObservedStart, end: safeObservedEnd } = resolveObservationInstants({
      breachData,
      requestStartRaw,
      requestEndRaw,
      requestTimestamp: timestamp || null,
      fallbackNow: safeEventTime,
    });
    const safeObservedStartIso = safeObservedStart.toISOString();
    const safeObservedEndIso = safeObservedEnd.toISOString();
    const rawDurationMs = safeObservedEnd.getTime() - safeObservedStart.getTime();
    const actualDurationMs = Number.isFinite(rawDurationMs) && rawDurationMs > 0 ? rawDurationMs : 0;
    const actualMinutes = getBillableMinutesFromMilliseconds(actualDurationMs);
    const observedStartUk = getUkDateTimeParts(safeObservedStart);
    const observedEndUk = getUkDateTimeParts(safeObservedEnd);
    const finalPcnNumber = buildPcnNumber(vrmValue);
    const mergedImages = [...(Array.isArray(images) ? images : []), ...(Array.isArray(imageUrls) ? imageUrls : [])]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .filter((value, index, all) => all.indexOf(value) === index);
    const resolvedVehicleDetails = buildVehicleDetailsRecord(
      vehicleDetails || breachData?.vehicleDetails || breachData?.savedVehicleLookup || null,
      vrmValue
    );

    const finalReason = resolvePreferredReason({ requestReason: reason, breachData });

    const pcnPayload = {
      breachId,
      pcnNumber: finalPcnNumber,
      vrm: vrmValue,
      amount: amountValue,
      reason: finalReason,
      notes: notes || '',
      source: 'WARDEN',
      status: 'PENDING',
      qaStatus: 'PENDING',
      siteId: siteId || breachData?.siteId || '',
      siteName: siteName || breachData?.siteName || '',
      evidence: evidence || breachData?.evidence || null,
      vehicleDetails: resolvedVehicleDetails,
      make: resolvedVehicleDetails?.make || breachData?.make || null,
      model: resolvedVehicleDetails?.model || breachData?.model || null,
      colour: resolvedVehicleDetails?.color || breachData?.colour || breachData?.color || null,
      images: mergedImages,
      imageUrls: mergedImages,
      observationStartTime: Timestamp.fromDate(safeObservedStart),
      observationEndTime: Timestamp.fromDate(safeObservedEnd),
      observedStartAt: Timestamp.fromDate(safeObservedStart),
      observedEndAt: Timestamp.fromDate(safeObservedEnd),
      observedAt: Timestamp.fromDate(safeEventTime),
      observationDateTime: Timestamp.fromDate(safeObservedStart),
      contraventionDateTime: Timestamp.fromDate(safeObservedEnd),
      observationDate: observedStartUk.date,
      observationTime: observedStartUk.time,
      contraventionDate: observedEndUk.date,
      contraventionTime: observedEndUk.time,
      actualDurationMs,
      actualMinutes,
      entryTime: breachData?.entryTime || safeObservedStartIso,
      closedAt: breachData?.closedAt || safeObservedEndIso,
      createdAt: Timestamp.fromDate(now),
      updatedAt: Timestamp.fromDate(now),
      createdBy: actorId,
      createdByEmail: actorEmail,
      issuedBy: actorId,
      issuedByEmail: actorEmail,
      escalationRoute: 'WARDEN_BREACH_TO_PCN',
    };

    const pcnRef = await adminDb.collection('pcns').add(pcnPayload);

    await adminDb.collection('pcnqa').add({
      pcnId: pcnRef.id,
      pcnNumber: finalPcnNumber,
      breachId,
      status: 'PENDING',
      source: 'WARDEN',
      queue: 'PCN_ESCALATION',
      createdAt: Timestamp.fromDate(now),
      createdBy: actorId,
      createdByEmail: actorEmail,
      updatedAt: Timestamp.fromDate(now),
    });

    await breachRef.set({
      status: 'QUEUED_FOR_QC',
      breachLifecycle: 'CONVERTED_TO_PCN',
      convertedToPcn: true,
      convertedAt: Timestamp.fromDate(now),
      pcnId: pcnRef.id,
      pcnNumber: finalPcnNumber,
      updatedAt: Timestamp.fromDate(now),
      updatedBy: actorId,
      updatedByEmail: actorEmail,
    }, { merge: true });

    return res.status(200).json({
      success: true,
      message: 'Breach converted to PCN successfully',
      pcnId: pcnRef.id,
      pcnNumber: finalPcnNumber,
      amount: amountValue,
      sameDayWarnings: null,
    });
  } catch (error) {
    console.error('[convert-to-pcn] Failed conversion:', error);
    return res.status(500).json({
      error: error?.message || 'Internal server error',
    });
  }
}
