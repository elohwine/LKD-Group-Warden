import { checkVrmAuthorization, batchCheckAuthorizations } from '../../../../lib/permitValidation.mjs';

export default async function handler(req, res) {
  if (req.method === 'HEAD') {
    return res.status(204).end();
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.replace(/^Bearer\s+/i, '');
  await (await import('../../../../lib/firebase-admin.mjs')).adminAuth.verifyIdToken(token);

  if (req.method === 'GET') {
    try {
      const { vrm, breachTime, siteId } = req.query;
      if (!vrm) return res.status(400).json({ error: 'VRM is required' });
      const auth = await checkVrmAuthorization(vrm, breachTime, siteId);
      return res.status(200).json({ vrm, hasAuthorization: !!auth, authorization: auth });
    } catch (error) {
      console.error('[warden/check-authorization] error', error);
      return res.status(500).json({ error: 'Failed to check authorization' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { items } = req.body;
      if (!Array.isArray(items)) return res.status(400).json({ error: 'Items array is required' });
      const results = await batchCheckAuthorizations(items);
      const response = {};
      items.forEach((item) => {
        const vrm = String(item.vrm || '').toUpperCase().replace(/\s+/g, '');
        const siteId = item.siteId || 'any';
        const key = `${vrm}_${siteId}`;
        const auth = results.get(key);
        response[key] = { hasAuthorization: results.has(key), authorization: auth || null };
      });
      return res.status(200).json(response);
    } catch (error) {
      console.error('[warden/check-authorization] batch error', error);
      return res.status(500).json({ error: 'Failed to check authorizations' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}