import { adminAuth, adminDb } from '../../../lib/firebase-admin.mjs';
import { Timestamp } from 'firebase-admin/firestore';
import normalizeVrm from '../../../lib/normalizeVrm.mjs';

/**
 * POST /api/breaches/wardencapture
 * Accept a breach report from a warden (parking enforcement officer).
 * Writes to Firestore with source=WARDEN and status=QUEUED_FOR_QC.
 * All audit fields are server-stamped for GDPR compliance.
 *
 * Headers:
 *   Authorization: Bearer <id-token>
 *   Content-Type: application/json
 *
 * Body:
 *   {
 *     vrm: string (required),
 *     siteId: string (required),
 *     siteName: string,
 *     contraventionReason: string (required),
 *     observationStartTime: ISO 8601 string (optional, defaults to now),
 *     observationEndTime: ISO 8601 string (optional, defaults to now),
 *     images: string[] (optional, array of image URLs),
 *     location: { lat, lng } (optional),
 *     notes: string (optional)
 *   }
 *
 * Response:
 *   200 { id: string, status: "QUEUED_FOR_QC" }
 *   400 { error: "...", details?: [...] }
 *   401 { error: "Unauthorized" }
 *   405 { error: "Method not allowed" }
 *   500 { error: "..." }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ───── AUTH ─────
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      console.warn('[wardencapture] Missing or invalid Bearer token');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let decoded;
    try {
      const token = authHeader.slice('Bearer '.length).trim();
      decoded = await adminAuth.verifyIdToken(token);
    } catch (authErr) {
      console.warn('[wardencapture] Token verification failed:', authErr?.message);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const wardenId = decoded.uid;
    const wardenEmail = decoded.email || null;
    console.log(`[wardencapture] Authenticated warden: ${wardenId} (${wardenEmail})`);

    // ───── PARSE BODY ─────
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

    const {
      vrm,
      siteId,
      siteName,
      contraventionReason,
      observationStartTime,
      observationEndTime,
      images = [],
      location,
      notes,
    } = body;

    // ───── VALIDATE REQUIRED FIELDS ─────
    const errors = [];
    if (!vrm) errors.push('vrm is required');
    if (!siteId) errors.push('siteId is required');
    if (!contraventionReason) errors.push('contraventionReason is required');

    if (errors.length > 0) {
      console.warn(`[wardencapture] Validation failed: ${errors.join(', ')}`);
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // ───── NORMALIZE VRM ─────
    let vrmNormalized;
    try {
      vrmNormalized = normalizeVrm(vrm);
      if (!vrmNormalized) {
        errors.push('vrm: Invalid format');
      }
    } catch (vrmErr) {
      console.error('[wardencapture] VRM normalization error:', vrmErr?.message);
      errors.push('vrm: Could not normalize');
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // ───── RESOLVE TIMESTAMPS ─────
    const now = new Date();
    let startTime;
    let endTime;

    try {
      startTime = observationStartTime ? new Date(observationStartTime) : now;
      if (Number.isNaN(startTime.getTime())) {
        startTime = now;
      }

      endTime = observationEndTime ? new Date(observationEndTime) : now;
      if (Number.isNaN(endTime.getTime())) {
        endTime = now;
      }
    } catch (timeErr) {
      console.warn('[wardencapture] Timestamp parsing error, using now:', timeErr?.message);
      startTime = now;
      endTime = now;
    }

    // ───── VALIDATE IMAGES ARRAY ─────
    const validImages = Array.isArray(images)
      ? images.filter((url) => typeof url === 'string' && url.startsWith('http'))
      : [];

    // ───── BUILD FIRESTORE PAYLOAD ─────
    const payload = {
      // Data from warden
      vrm: vrmNormalized,
      siteId,
      siteName: siteName || 'Unknown Site',
      contraventionReason,
      observationStartTime: Timestamp.fromDate(startTime),
      observationEndTime: Timestamp.fromDate(endTime),
      images: validImages,
      location: location || null,
      notes: notes || '',

      // Server-stamped audit fields (GDPR compliance - not from client)
      source: 'WARDEN',
      status: 'QUEUED_FOR_QC',
      wardenId,
      actorId: wardenId,
      actorEmail: wardenEmail,
      createdAt: Timestamp.fromDate(now),
      createdBy: wardenId,
      createdByEmail: wardenEmail,
      updatedAt: Timestamp.fromDate(now),

      // Lifecycle tracking
      queuedAt: Timestamp.fromDate(now),
      queuedFor: 'QC',
      history: [
        {
          event: 'created',
          timestamp: Timestamp.fromDate(now),
          by: wardenId,
          byEmail: wardenEmail,
          detail: {
            source: 'WARDEN',
            images: validImages.length,
          },
        },
      ],
    };

    // ───── WRITE TO FIRESTORE ─────
    console.log(`[wardencapture] Writing breach to Firestore: VRM=${vrmNormalized}, siteId=${siteId}`);

    let docRef;
    try {
      docRef = await adminDb.collection('breaches').add(payload);
    } catch (dbErr) {
      console.error('[wardencapture] Firestore write failed:', dbErr?.message);
      return res.status(500).json({ error: 'Failed to save breach capture' });
    }

    console.log(`[wardencapture] Breach created: ${docRef.id}`);

    // ───── RESPONSE ─────
    return res.status(200).json({
      id: docRef.id,
      status: 'QUEUED_FOR_QC',
    });
  } catch (error) {
    console.error('[wardencapture] Unhandled error:', error?.message || error);
    return res.status(500).json({ error: 'Breach capture failed' });
  }
}
