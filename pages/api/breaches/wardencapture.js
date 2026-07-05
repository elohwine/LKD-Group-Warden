import { Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../../../../lib/firebase-admin.mjs';

function normalizeVrm(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const decoded = await adminAuth.verifyIdToken(token);
    const payload = req.body || {};
    const vrm = normalizeVrm(payload.vrm);

    if (!vrm) {
      return res.status(400).json({ error: 'VRM is required' });
    }

    if (!payload.siteId) {
      return res.status(400).json({ error: 'siteId is required' });
    }

    const doc = {
      vrm,
      normalizedVrm: vrm,
      siteId: String(payload.siteId),
      siteName: payload.siteName || null,
      source: 'WARDEN',
      wardenId: payload.wardenId || decoded.uid,
      actorId: payload.actorId || decoded.uid,
      images: Array.isArray(payload.images) ? payload.images : [],
      imageUrls: Array.isArray(payload.imageUrls) ? payload.imageUrls : Array.isArray(payload.images) ? payload.images : [],
      location: payload.location || null,
      observationStartTime: payload.observationStartTime ? Timestamp.fromDate(new Date(payload.observationStartTime)) : null,
      observationEndTime: payload.observationEndTime ? Timestamp.fromDate(new Date(payload.observationEndTime)) : null,
      contraventionReason: String(payload.contraventionReason || '').trim(),
      status: 'QUEUED_FOR_QC',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      createdBy: decoded.uid,
      updatedBy: decoded.uid,
      sourceMeta: {
        client: 'warden-app',
        offline: Boolean(payload.offline)
      }
    };

    const ref = await adminDb.collection('violations').add(doc);

    return res.status(200).json({
      ok: true,
      id: ref.id,
      breach: { id: ref.id, ...doc }
    });
  } catch (error) {
    console.error('[warden/wardencapture] error', error);
    return res.status(500).json({ error: 'Failed to finalise breach capture' });
  }
}