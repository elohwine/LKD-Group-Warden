import { adminAuth } from '../../lib/firebase-admin.mjs';

function normalizeVrm(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

async function verifyBearer(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return false;

  try {
    await adminAuth.verifyIdToken(token);
    return true;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authorized = await verifyBearer(req);
  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const vrm = normalizeVrm(req.query?.vrm || req.query?.searchTerm || body?.vrm || body?.searchTerm || '');

    if (!vrm) {
      return res.status(400).json({ error: 'Missing vrm' });
    }

    const apiKey = process.env.UKVD_API_KEY;
    const endpoint = process.env.UKVD_ENDPOINT || 'https://uk.api.vehicledataglobal.com/r2/lookup';
    const packageName = 'VehicleDetailsWithImage';

    if (!apiKey) {
      console.warn('[carcheck] Missing UKVD_API_KEY; returning mock data');
      return res.status(200).json({
        mock: true,
        results: {
          vehicleDetails: {
            vehicleIdentification: {
              vrm,
              dvlaMake: 'Ford',
              dvlaModel: 'Focus',
              dvlaFuelType: 'Petrol',
            },
            vehicleHistory: {
              colourDetails: {
                currentColour: 'Blue',
              },
            },
          },
        },
      });
    }

    const url = new URL(endpoint);
    url.searchParams.append('apikey', apiKey);
    url.searchParams.append('packagename', packageName);
    url.searchParams.append('vrm', vrm);

    const upstream = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({
        error: 'Upstream error',
        details: text,
      });
    }

    const data = await upstream.json();
    return res.status(200).json(data);
  } catch (error) {
    console.error('[carcheck] Error:', error);
    return res.status(500).json({ error: 'Lookup failed' });
  }
}