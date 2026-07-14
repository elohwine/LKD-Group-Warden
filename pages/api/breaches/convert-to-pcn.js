import { Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../../../lib/firebase-admin.mjs';
import normalizeVrm from '../../../lib/normalizeVrm.mjs';

function buildPcnNumber(vrm) {
  const safeVrm = normalizeVrm(vrm || '').slice(0, 6) || 'WARDEN';
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(-10);
  return `PCN-${safeVrm}-${stamp}`;
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
      siteId,
      siteName,
      evidence,
      images,
      imageUrls,
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
    const eventTime = timestamp ? new Date(timestamp) : now;
    const safeEventTime = Number.isNaN(eventTime.getTime()) ? now : eventTime;
    const finalPcnNumber = buildPcnNumber(vrmValue);
    const mergedImages = [...(Array.isArray(images) ? images : []), ...(Array.isArray(imageUrls) ? imageUrls : [])]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .filter((value, index, all) => all.indexOf(value) === index);

    const pcnPayload = {
      breachId,
      pcnNumber: finalPcnNumber,
      vrm: vrmValue,
      amount: amountValue,
      reason: reason || breachData?.contraventionReason || 'No valid permit or payment found',
      notes: notes || '',
      source: 'WARDEN',
      status: 'PENDING',
      qaStatus: 'PENDING',
      siteId: siteId || breachData?.siteId || '',
      siteName: siteName || breachData?.siteName || '',
      evidence: evidence || breachData?.evidence || null,
      images: mergedImages,
      imageUrls: mergedImages,
      observedAt: Timestamp.fromDate(safeEventTime),
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
