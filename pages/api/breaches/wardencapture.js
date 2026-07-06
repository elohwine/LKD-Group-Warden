/**
 * Local dev stub for pages/api/breaches/wardencapture
 *
 * Same pattern as uploadevidence stub: proxy or mock depending on env.
 */

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const backendBase = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '');

    if (backendBase) {
        // ── Proxy mode ──────────────────────────────────────────────────────────────
        const authHeader = req.headers.authorization || '';
        const upstream = await fetch(`${backendBase}/api/breaches/wardencapture`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(authHeader ? { Authorization: authHeader } : {}),
            },
            body: JSON.stringify(req.body),
        });
        const data = await upstream.json();
        return res.status(upstream.status).json(data);
    }

    // ── Mock mode ───────────────────────────────────────────────────────────────
    console.warn('[breaches/wardencapture stub] NEXT_PUBLIC_API_BASE_URL not set — returning mock response');
    const { vrm, siteId, siteName, wardenId, actorId } = req.body || {};
    const missing = ['vrm', 'siteId', 'siteName', 'wardenId', 'actorId'].filter((f) => !req.body?.[f]);
    if (missing.length > 0) {
        return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }
    const mockId = `mock-${Date.now()}`;
    console.log(`[wardencapture mock] breach queued vrm=${vrm} siteId=${siteId} warden=${wardenId}`);
    return res.status(200).json({ id: mockId, status: 'QUEUED_FOR_QC', vrm, _mock: true });
}
