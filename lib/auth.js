import { fetchJson } from './api';
import { clearSession, loadSession, saveSession } from './session';
import { auth } from './firebase-client';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';

export const ALLOWED_ROLES = ['warden', 'qc', 'admin', 'manager', 'epermit_officer'];

function computeTokenExpiresAt(expiresInSeconds) {
  const expiresInMs = Math.max(0, Number(expiresInSeconds || 0) * 1000);
  if (!expiresInMs) return 0;
  return Date.now() + expiresInMs;
}

function isSessionTokenFresh(session) {
  const expiresAt = Number(session?.tokenExpiresAt || 0);
  if (!expiresAt) return Boolean(session?.token);
  return expiresAt - Date.now() > 60 * 1000;
}

export async function signInToWardenApp(email, password) {
  if (!email || !password) {
    throw new Error('email_and_password_required');
  }

  if (!auth) {
    throw new Error('firebase_client_not_ready');
  }

  let credentials;
  try {
    credentials = await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    const message = String(error?.message || error?.code || '').toLowerCase();
    if (
      message.includes('auth/invalid-credential') ||
      message.includes('auth/wrong-password') ||
      message.includes('auth/user-not-found') ||
      message.includes('auth/invalid-email')
    ) {
      throw new Error('invalid_credentials');
    }
    if (message.includes('auth/network-request-failed') || message.includes('network') || message.includes('failed to fetch')) {
      throw new Error('network_unavailable');
    }
    throw new Error(`signin_failed: ${error?.message || error}`);
  }

  const { user } = credentials;
  if (!user) {
    throw new Error('invalid_credentials');
  }

  let token;
  try {
    token = await user.getIdToken();
  } catch (error) {
    throw new Error(`token_resolve_failed: ${error?.message || error}`);
  }

  // In dev: relative URL hits local Next.js server (no CORS).
  // In production APK: NEXT_PUBLIC_API_BASE_URL prepends the backend origin.
  let rolePayload;
  try {
    rolePayload = await fetchJson('/api/checkUserRole', {
      method: 'POST',
      body: { uid: user.uid },
    });
  } catch (fetchError) {
    const message = String(fetchError?.message || '').toLowerCase();
    if (message.includes('failed to fetch') || message.includes('network')) {
      throw new Error('network_unavailable');
    }
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
    tokenExpiresAt: computeTokenExpiresAt(60 * 60),
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

export async function getValidToken({ forceRefresh = false } = {}) {
  const session = loadSession() || {};
  const fallbackToken = session?.token || '';

  if (!forceRefresh && isSessionTokenFresh(session)) {
    return fallbackToken;
  }

  try {
    if (!auth?.currentUser && typeof auth?.authStateReady === 'function') {
      try {
        await auth.authStateReady();
      } catch (_) {
        // Ignore and continue with best-effort token resolution.
      }
    }

    const currentUser = auth?.currentUser || null;
    if (!currentUser) {
      return fallbackToken;
    }

    const freshToken = await currentUser.getIdToken(Boolean(forceRefresh));
    if (!freshToken) {
      return fallbackToken;
    }

    if (freshToken !== fallbackToken) {
      saveSession({ ...session, token: freshToken, tokenExpiresAt: computeTokenExpiresAt(60 * 60) });
    }

    return freshToken;
  } catch (error) {
    console.warn('[warden-auth] failed to resolve valid token', error?.message || error);
    return fallbackToken;
  }
}