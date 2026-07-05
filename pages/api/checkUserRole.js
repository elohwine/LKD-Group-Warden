import { adminDb, adminAuth } from '../../../lib/firebase-admin.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uid } = req.body || {};
  if (!uid) {
    return res.status(400).json({ error: 'Missing UID' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const decoded = await adminAuth.verifyIdToken(token);
    if (decoded.uid !== uid) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!adminDb || !adminAuth) {
      return res.status(200).json({ role: null, email: null, source: null, forcePasswordChange: false, warning: 'ADMIN_SDK_NOT_INITIALIZED' });
    }

    const userDoc = await adminDb.collection('users').doc(uid).get();
    let role = null;
    let email = null;
    let forcePasswordChange = false;
    let source = 'firestore';

    if (userDoc.exists) {
      const userData = userDoc.data() || {};
      role = userData.role || null;
      email = userData.email || null;
      forcePasswordChange = Boolean(userData.forcePasswordChange);
    }

    if (!role) {
      try {
        const authUser = await adminAuth.getUser(uid);
        email = email || authUser.email || null;
        if (authUser.customClaims?.role) {
          role = authUser.customClaims.role;
          source = 'customClaims';
        }
      } catch (claimErr) {
        console.warn('[warden/checkUserRole] claims fallback failed', claimErr?.message || claimErr);
      }
    }

    return res.status(200).json({ role, email, source, forcePasswordChange });
  } catch (error) {
    console.error('[warden/checkUserRole] error', error);
    return res.status(200).json({ role: null, email: null, source: null, forcePasswordChange: false, warning: 'INTERNAL_SERVER_ERROR' });
  }
}