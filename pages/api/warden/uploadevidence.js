/**
 * Local dev stub for pages/api/warden/uploadevidence
 *
 * In APK mode (next export), this file is never loaded — the app calls the backend
 * directly via NEXT_PUBLIC_API_BASE_URL through buildApiUrl(). This stub only serves
 * requests when the dev server (next dev) is running locally.
 *
 * Behaviour:
 *   - If NEXT_PUBLIC_API_BASE_URL is set: transparently proxies to the backend.
 *   - If not set (pure local dev): returns a mock response so the UI is testable
 *     without a full backend.
 */

import formidable from 'formidable';

export const config = {
    api: { bodyParser: false },
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const backendBase = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '');

    if (backendBase) {
        // ── Proxy mode: forward multipart to backend ────────────────────────────────
        const authHeader = req.headers.authorization || '';
        const form = formidable({ multiples: true, keepExtensions: true });
        const [fields, files] = await new Promise((resolve, reject) =>
            form.parse(req, (err, f, fls) => (err ? reject(err) : resolve([f, fls])))
        );

        const formData = new FormData();
        const fileList = Array.isArray(files.file) ? files.file : files.file ? [files.file] : [];
        for (const f of fileList) {
            const buffer = await import('fs').then((m) => m.promises.readFile(f.filepath));
            formData.append('file', new Blob([buffer], { type: f.mimetype }), f.originalFilename);
        }
        if (fields.siteId) formData.append('siteId', Array.isArray(fields.siteId) ? fields.siteId[0] : fields.siteId);
        if (fields.manualVrm) formData.append('manualVrm', Array.isArray(fields.manualVrm) ? fields.manualVrm[0] : fields.manualVrm);

        const upstream = await fetch(`${backendBase}/api/warden/uploadevidence`, {
            method: 'POST',
            headers: authHeader ? { Authorization: authHeader } : {},
            body: formData,
        });
        const data = await upstream.json();
        return res.status(upstream.status).json(data);
    }

    // ── Mock mode: local dev without backend ────────────────────────────────────
    console.warn('[warden/uploadevidence stub] NEXT_PUBLIC_API_BASE_URL not set — returning mock response');
    const form = formidable({ multiples: true });
    const [fields] = await new Promise((resolve, reject) =>
        form.parse(req, (err, f, fls) => (err ? reject(err) : resolve([f, fls])))
    );
    const manualVrm = Array.isArray(fields.manualVrm) ? fields.manualVrm[0] : (fields.manualVrm || '');
    const vrm = manualVrm ? manualVrm.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;

    return res.status(200).json({
        vrm: vrm || null,
        images: ['https://via.placeholder.com/640x480.png?text=MOCK+EVIDENCE'],
        _mock: true,
    });
}
