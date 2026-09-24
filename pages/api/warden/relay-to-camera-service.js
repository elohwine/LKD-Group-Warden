import { adminAuth } from '../../../lib/firebase-admin.mjs';

const CAMERA_SERVICE_BASE = (
  process.env.CAMERA_SERVICE_BASE_URL ||
  process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL ||
  ''
).replace(/\/$/, '');

const RELAY_TIMEOUT_MS = 15000;

function normalizeDirection(value) {
  const direction = String(value ?? '').trim().toLowerCase();
  if (direction === 'entry' || direction === 'in' || direction === 'forward') return 'entry';
  if (direction === 'exit' || direction === 'out' || direction === 'reverse') return 'exit';
  return 'unknown';
}

function normalizeUtcIso(value, fallback = new Date().toISOString()) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  const normalized = parsed.toISOString();
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
}

export function buildCameraServiceCapturePayload({
  body = {},
  wardenId = '',
  wardenEmail = '',
  wardenName = '',
  deviceIp = null,
} = {}) {
  const vrm = String(body.vrm || body.Registration || body.registration || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const confidence = Number(
    body.confidence ?? body.plateConfidence ?? body.Confidence ?? body.PlateConfidence ?? body.ocrConfidence ?? 0
  );

  return {
    Registration: vrm,
    ReadTime: normalizeUtcIso(body.timestamp || body.ReadTime || body.readTime || new Date().toISOString()),
    Direction: normalizeDirection(body.direction || body.Direction || body.directionName),
    PlateImage: body.plateImage || body.PlateImage || body.platePicture || body.plateUrl || null,
    OverviewImage: body.vehicleImage || body.OverviewImage || body.overviewImage || body.vehiclePicture || body.vehicleUrl || null,
    siteId: body.siteId || body.site_id || null,
    site: body.site || body.siteName || body.site_name || null,
    wardenId,
    wardenEmail,
    wardenName: body.wardenName || body.warden_name || wardenName,
    deviceIp,
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };
}

/**
 * POST /api/warden/relay-to-camera-service
 * Relays a warden ANPR capture event to the camera service breach engine.
 * Fire-and-forget from the client's perspective: always returns 200 so
 * a camera-service outage never blocks PCN generation.
 *
 * Headers:
 *   Authorization: Bearer <id-token>
 *   Content-Type: application/json
 *
 * Body:
 *   {
 *     vrm: string (required),
 *     timestamp: ISO string,
 *     direction: "entry" | "exit" | "unknown",
 *     vehicleImage: string (URL),
 *     plateImage: string (URL),
 *     siteId: string,
 *     siteName: string,
 *     confidence: number
 *   }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let wardenId, wardenEmail, wardenName;
  try {
    const token = authHeader.slice('Bearer '.length).trim();
    const decoded = await adminAuth.verifyIdToken(token);
    wardenId = decoded.uid;
    wardenEmail = decoded.email || '';
    // Firebase token carries displayName as `name`.
    wardenName = decoded.name || decoded.displayName || wardenEmail.split('@')[0] || wardenId.slice(0, 12);
  } catch (authErr) {
    console.warn('[relay-to-camera-service] Token verification failed:', authErr?.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Best-effort device IP — forwarded by the warden app client through the relay.
  const deviceIp = String(
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    ''
  ).replace('::ffff:', '').trim() || null;

  // ── Validate ─────────────────────────────────────────────────────────────
  const body = req.body || {};
  const vrm = String(body.vrm || body.Registration || '')
    .trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!vrm) {
    return res.status(400).json({ error: 'vrm is required' });
  }

  if (!CAMERA_SERVICE_BASE) {
    console.warn('[relay-to-camera-service] CAMERA_SERVICE_BASE_URL not configured — skipping relay');
    return res.status(200).json({ relayed: false, skipped: true, reason: 'camera_service_not_configured', vrm });
  }

  // ── Relay ─────────────────────────────────────────────────────────────────
  const payload = buildCameraServiceCapturePayload({
    body,
    wardenId,
    wardenEmail,
    wardenName: body.wardenName || wardenName,
    deviceIp,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

  try {
    const headers = { 'Content-Type': 'application/json' };

    const response = await fetch(`${CAMERA_SERVICE_BASE}/api/warden/capture`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const json = await response.json().catch(() => ({}));
    console.log(`[relay-to-camera-service] Camera service responded ${response.status} for VRM=${vrm} direction=${payload.Direction}`);

    return res.status(200).json({
      relayed: true,
      vrm,
      cameraServiceStatus: response.status,
      cameraServiceOk: response.ok,
      ...json,
    });
  } catch (relayErr) {
    clearTimeout(timeout);
    const reason = relayErr?.name === 'AbortError' ? 'timeout' : 'network_error';
    console.warn(`[relay-to-camera-service] Camera service unreachable (${reason}):`, relayErr?.message);
    return res.status(200).json({ relayed: false, skipped: true, reason, vrm });
  }
}
