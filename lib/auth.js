import { fetchJson } from './api';
import { clearSession, loadSession, saveSession } from './session';
import { auth } from './firebase-client';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';

export const ALLOWED_ROLES = ['warden', 'qc', 'admin', 'manager', 'client', 'epermit_officer'];

const SIGNIN_NETWORK_RETRIES = 2;
const ROLE_LOOKUP_NETWORK_RETRIES = 2;

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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isNetworkStyleError(error) {
  const message = String(error?.message || error?.code || '').toLowerCase();
  return message.includes('auth/network-request-failed')
    || message.includes('network')
    || message.includes('failed to fetch')
    || message.includes('connection')
    || message.includes('timed out')
    || message.includes('timeout');
}

export async function signInToWardenApp(email, password) {
  if (!email || !password) {
    throw new Error('email_and_password_required');
  }

  if (!auth) {
    throw new Error('firebase_client_not_ready');
  }

  let credentials;
  let signinFailure = null;
  let signinAttempts = 0;
  for (let attempt = 0; attempt <= SIGNIN_NETWORK_RETRIES; attempt += 1) {
    try {
      credentials = await signInWithEmailAndPassword(auth, email, password);
      signinFailure = null;
      break;
    } catch (error) {
      signinAttempts = attempt + 1;
      const message = String(error?.message || error?.code || '').toLowerCase();
      if (
        message.includes('auth/invalid-credential') ||
        message.includes('auth/wrong-password') ||
        message.includes('auth/user-not-found') ||
        message.includes('auth/invalid-email')
      ) {
        throw new Error('invalid_credentials');
      }

      if (!isNetworkStyleError(error)) {
        throw new Error(`signin_failed: ${error?.message || error}`);
      }

      signinFailure = error;
      if (attempt < SIGNIN_NETWORK_RETRIES) {
        await sleep(350 * (attempt + 1));
        continue;
      }
    }
  }

  if (!credentials) {
    const detail = [
      'stage=signin',
      `attempts=${signinAttempts || SIGNIN_NETWORK_RETRIES + 1}`,
      `firebaseCode=${String(signinFailure?.code || 'unknown')}`,
    ].join(';');
    throw new Error(`network_unavailable|${detail}`);
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
  let roleLookupFailure = null;
  let roleLookupAttempts = 0;
  for (let attempt = 0; attempt <= ROLE_LOOKUP_NETWORK_RETRIES; attempt += 1) {
    try {
      rolePayload = await fetchJson('/api/checkUserRole', {
        method: 'POST',
        body: { uid: user.uid },
      });
      roleLookupFailure = null;
      break;
    } catch (fetchError) {
      roleLookupAttempts = attempt + 1;
      const message = String(fetchError?.message || '').toLowerCase();
      const isTimeout = Number(fetchError?.status || 0) === 408 || message.includes('timed out') || message.includes('timeout');
      if (isTimeout) {
        const detail = [
          'stage=role_lookup',
          `attempts=${roleLookupAttempts}`,
          `httpStatus=${Number(fetchError?.status || 0) || 'unknown'}`,
        ].join(';');
        roleLookupFailure = new Error(`role_lookup_timeout|${detail}`);
      } else if (isNetworkStyleError(fetchError) || message.includes('failed to fetch')) {
        const detail = [
          'stage=role_lookup',
          `attempts=${roleLookupAttempts}`,
          `httpStatus=${Number(fetchError?.status || 0) || 'unknown'}`,
        ].join(';');
        roleLookupFailure = new Error(`network_unavailable|${detail}`);
      } else {
        throw new Error(`role_lookup_failed: ${fetchError.message}`);
      }

      if (attempt < ROLE_LOOKUP_NETWORK_RETRIES) {
        await sleep(350 * (attempt + 1));
        continue;
      }
    }
  }

  if (!rolePayload) {
    throw roleLookupFailure || new Error('role_lookup_failed');
  }

  const role = String(rolePayload?.role || '').trim().toLowerCase();
  if (!role) {
    await signOut(auth).catch(() => undefined);
    throw new Error(`role_missing:${String(rolePayload?.warning || 'UNKNOWN')}`);
  }
  if (!ALLOWED_ROLES.includes(role)) {
    await signOut(auth).catch(() => undefined);
    throw new Error(`insufficient_role:${role}`);
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