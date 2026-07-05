import { auth } from './firebase-client.js';
import { clearSession, saveSession } from './session';
import { fetchJson } from './api';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';

export const ALLOWED_ROLES = ['warden', 'qc', 'admin', 'manager', 'epermit_officer'];

export async function signInToWardenApp(email, password) {
  if (!auth) {
    throw new Error('firebase_client_not_ready');
  }
  const result = await signInWithEmailAndPassword(auth, email, password);
  const token = await result.user.getIdToken();
  const profile = await fetchJson('/api/checkUserRole', {
    method: 'POST',
    token,
    body: { uid: result.user.uid }
  });

  if (!ALLOWED_ROLES.includes(profile?.role)) {
    await signOut(auth).catch(() => undefined);
    throw new Error('insufficient_role');
  }

  const session = {
    uid: result.user.uid,
    email: profile.email || result.user.email || email,
    role: profile.role,
    forcePasswordChange: Boolean(profile.forcePasswordChange)
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