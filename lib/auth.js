import { fetchJson } from './api';
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

  // In dev: relative URL hits local Next.js server (no CORS).
  // In production APK: NEXT_PUBLIC_API_BASE_URL prepends the backend origin.
  let rolePayload;
  try {
    rolePayload = await fetchJson('/api/checkUserRole', {
      method: 'POST',
      token,
      body: { uid: user.uid },
    });
  } catch (fetchError) {
    throw new Error(`role_lookup_failed: ${fetchError.message}`);
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