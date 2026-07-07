/**
 * POST /api/warden/uploadevidence (Warden App Wrapper)
 * 
 * In PRODUCTION (APK mode):
 *   Forwards multipart/form-data to backend at https://ldkgroup.co.uk/api/warden/uploadevidence
 * 
 * In DEV (next dev):
 *   Returns mock response with test image URLs
 * 
 * This layer allows the Warden app to work offline in dev mode while forwarding
 * to the real backend in production.
 */

export const config = {
  api: {
    bodyParser: false, // Let multipart handler deal with body
  },
};

function getBackendUrl() {
  // Production: use backend at ldkgroup.co.uk
  // Dev: return null to trigger mock mode
  if (process.env.NEXT_PUBLIC_API_BASE_URL) {
    return `${process.env.NEXT_PUBLIC_API_BASE_URL}/api/warden/uploadevidence`;
  }
  if (process.env.NODE_ENV === 'production' || process.env.NEXT_BUILD === 'true') {
    // APK mode: use production backend
    return 'https://ldkgroup.co.uk/api/warden/uploadevidence';
  }
  // Dev mode: no backend URL configured
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const backendUrl = getBackendUrl();

  // ───── DEV MODE (MOCK) ─────
  if (!backendUrl) {
    console.log('[uploadevidence] DEV MODE: Returning mock response');
    return res.status(200).json({
      vrm: req.query.manualVrm ? String(req.query.manualVrm[0] || '').toUpperCase() : null,
      images: [
        'https://via.placeholder.com/400x300?text=Mock+Evidence+1.jpg',
        'https://via.placeholder.com/400x300?text=Mock+Evidence+2.jpg',
      ],
    });
  }

  // ───── PRODUCTION MODE (FORWARD TO BACKEND) ─────
  try {
    console.log(`[uploadevidence] Forwarding to backend: ${backendUrl}`);

    // Forward the entire request (headers + multipart body)
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        // Forward Authorization header
        ...(req.headers.authorization && {
          authorization: req.headers.authorization,
        }),
        // Don't set Content-Type: let fetch/server handle multipart boundary
      },
      body: req, // Pass raw request body
    });

    const data = await response.json();

    // Mirror backend response status and data
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[uploadevidence] Forwarding error:', error?.message || error);
    return res.status(502).json({ error: 'Backend unreachable' });
  }
}
