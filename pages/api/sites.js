import { adminAuth, adminDb } from '../../../lib/firebase-admin.mjs';

function normalizeIncomingSite(site) {
  const next = { ...site };
  if (next.name) next.name = String(next.name).trim();
  if (next.displayName) next.displayName = String(next.displayName).trim();
  if (next.address) next.address = String(next.address).trim();
  if (next.location) next.location = String(next.location).trim();
  return next;
}

function prepareSitesResponse(sites) {
  return sites.map((site) => ({
    ...site,
    id: String(site.id),
    name: site.name || site.displayName || site.location || site.id,
    displayName: site.displayName || site.name || site.location || site.id
  }));
}

export default async function handler(req, res) {
  if (req.method === 'HEAD' || (req.method === 'GET' && (req.query?.warmup === '1' || req.query?.warmup === 'true'))) {
    return res.status(204).end();
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.replace(/^Bearer\s+/i, '');
  const decoded = await adminAuth.verifyIdToken(token);
  const userDoc = await adminDb.collection('users').doc(decoded.uid).get();
  const userData = userDoc.exists ? (userDoc.data() || {}) : {};
  const role = userData.role || decoded.role || null;

  if (req.method === 'GET') {
    const snap = await adminDb.collection('sites').get();
    const sites = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const visibleSites = role === 'manager' && Array.isArray(userData.siteIds) && userData.siteIds.length > 0
      ? sites.filter((site) => userData.siteIds.includes(site.id))
      : sites;
    return res.status(200).json({ success: true, sites: prepareSitesResponse(visibleSites) });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const sitesPayload = Array.isArray(body.sites) ? body.sites : [body];
    const created = [];

    for (const site of sitesPayload) {
      if (!site?.name && !site?.siteName) {
        return res.status(400).json({ error: `Missing required field "name" for site: ${JSON.stringify(site)}` });
      }

      const next = normalizeIncomingSite(site);
      const siteRef = adminDb.collection('sites').doc();
      await siteRef.set({ ...next, createdAt: new Date().toISOString() });
      created.push({ id: siteRef.id, name: next.name || siteRef.id });
    }

    return res.status(201).json({ success: true, created });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}