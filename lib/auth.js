import { buildApiUrl } from './api';
import { clearSession, loadSession, saveSession } from './session';
import { auth } from './firebase-client';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';

export const ALLOWED_ROLES = ['warden', 'qc', 'admin', 'manager', 'epermit_officer'];

export async function signInToWardenApp(email, password) {
  if (!email || !password) {
    throw new Error('email_and_password_required');
  }

  if (!auth) {
    throw new Error('firebase_client_not_ready');
  }

  const { user } = await signInWithEmailAndPassword(auth, email, password);
  if (!user) {
    throw new Error('invalid_credentials');
  }

  const token = await user.getIdToken();
  
  let roleUrl;
  try {
    roleUrl = buildApiUrl('/api/checkUserRole');
  } catch (urlError) {
    throw new Error('api_base_url_not_configured');
  }

  const roleResponse = await fetch(roleUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: user.uid }),
  });

  const contentType = String(roleResponse.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new Error('role_lookup_invalid_response');
  }

  const rolePayload = await roleResponse.json().catch(() => null);
  if (!roleResponse.ok) {
    throw new Error(`role_lookup_failed_${roleResponse.status}`);
  }

  const role = String(rolePayload?.role || '').toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) {
    await signOut(auth).catch(() => undefined);
    throw new Error('insufficient_role');
  }

  const session = {
    uid: user.uid,
    email: rolePayload?.email || user.email || email,
    role,
    forcePasswordChange: Boolean(rolePayload?.forcePasswordChange),
    token,
  };

  saveSession(session);
  return session;
}

export async function signOutFromWardenApp() {
  clearSession();

  if (auth) {
    await signOut(auth).catch(() => undefined);
  }
}

export function getStoredToken() {
  const session = loadSession();
  return session?.token || '';
}