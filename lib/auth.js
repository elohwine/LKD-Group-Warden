import { auth } from './firebase-client.js';
import { clearSession, loadSession, saveSession } from './session';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';

export const ALLOWED_ROLES = ['warden', 'qc', 'admin', 'manager', 'epermit_officer'];

export async function signInToWardenApp(email, password) {
  if (!email || !password) {
    throw new Error('email_and_password_required');
  }

  if (!auth) {
    throw new Error('firebase_client_not_ready');
  }

  const result = await signInWithEmailAndPassword(auth, email, password);
  const token = await result.user.getIdToken();

  const roleResponse = await fetch('/api/checkUserRole', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: result.user.uid }),
  });

  if (!roleResponse.ok) {
    throw new Error(`role_lookup_failed_${roleResponse.status}`);
  }

  const profile = await roleResponse.json();
  const role = String(profile?.role || '').toLowerCase();

  if (!ALLOWED_ROLES.includes(role)) {
    await signOut(auth).catch(() => undefined);
    throw new Error('insufficient_role');
  }

  const session = {
    uid: result.user.uid,
    email: profile?.email || result.user.email || email,
    role,
    forcePasswordChange: Boolean(profile?.forcePasswordChange),
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