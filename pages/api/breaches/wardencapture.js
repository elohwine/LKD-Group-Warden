/**
 * POST /api/breaches/wardencapture (Warden App Wrapper)
 * 
 * In PRODUCTION (APK mode):
 *   Forwards JSON body to backend at https://ldkgroup.co.uk/api/breaches/wardencapture
 * 
 * In DEV (next dev):
 *   Returns mock response with test breach ID
 * 
 * This layer allows the Warden app to work offline in dev mode while forwarding
 * to the real backend in production.
 */

function getBackendUrl() {
  // Production: use backend at ldkgroup.co.uk
  // Dev: return null to trigger mock mode
  if (process.env.NEXT_PUBLIC_API_BASE_URL) {
    return `${process.env.NEXT_PUBLIC_API_BASE_URL}/api/breaches/wardencapture`;
  }
  if (process.env.NODE_ENV === 'production' || process.env.NEXT_BUILD === 'true') {
    // APK mode: use production backend
    return 'https://ldkgroup.co.uk/api/breaches/wardencapture';
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
    console.log('[wardencapture] DEV MODE: Returning mock response');
    const mockId = `MOCK-${Date.now()}`;
    return res.status(200).json({
      id: mockId,
      status: 'QUEUED_FOR_QC',
    });
  }

  // ───── PRODUCTION MODE (FORWARD TO BACKEND) ─────
  try {
    console.log(`[wardencapture] Forwarding to backend: ${backendUrl}`);

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Forward Authorization header
        ...(req.headers.authorization && {
          authorization: req.headers.authorization,
        }),
      },
      body: JSON.stringify(req.body || {}),
    });

    const data = await response.json();

    // Mirror backend response status and data
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[wardencapture] Forwarding error:', error?.message || error);
    return res.status(502).json({ error: 'Backend unreachable' });
  }
}
