import { buildApiUrl } from './api';
import { clearSession, loadSession, saveSession } from './session';

export const ALLOWED_ROLES = ['warden', 'qc', 'admin', 'manager', 'epermit_officer'];
const LOGIN_ENDPOINTS = [
  process.env.NEXT_PUBLIC_WARDEN_AUTH_PATH,
  '/api/warden/auth',
  '/api/auth/login',
  '/api/login',
].filter(Boolean);

function parseResponseBody(response, text) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}

function isEndpointMismatch(status, payload) {
  if (status === 404 || status === 405) return true;
  if (status === 400 && typeof payload === 'object') {
    const error = String(payload?.error || payload?.message || '').toLowerCase();
    return error.includes('missing idtoken') || error.includes('method not allowed') || error.includes('unsupported');
  }
  return false;
}

export async function signInToWardenApp(email, password) {
  if (!email || !password) {
    throw new Error('email_and_password_required');
  }

  let lastError = null;

  for (const endpoint of LOGIN_ENDPOINTS) {
    try {
      const response = await fetch(buildApiUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const rawText = await response.text();
      const payload = parseResponseBody(response, rawText);

      if (response.ok && payload?.token) {
        const role = String(payload.role || payload.userRole || 'warden').toLowerCase();
        if (!ALLOWED_ROLES.includes(role)) {
          throw new Error('insufficient_role');
        }

        const session = {
          uid: payload.uid || payload.userId || payload.id || '',
          email: payload.email || email,
          role,
          forcePasswordChange: Boolean(payload.forcePasswordChange),
          displayName: payload.displayName || payload.name || '',
          siteIds: Array.isArray(payload.siteIds) ? payload.siteIds : [],
          token: payload.token,
        };

        saveSession(session);
        return session;
      }

      const message = typeof payload === 'string'
        ? payload
        : payload?.error || payload?.message || `Login failed (${response.status})`;

      if (isEndpointMismatch(response.status, payload)) {
        lastError = new Error(message);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(message || 'invalid_credentials');
      }

      throw new Error(message);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || '').toLowerCase();
      if (message.includes('network') || message.includes('failed to fetch')) {
        continue;
      }
      if (message.includes('missing idtoken') || message.includes('method not allowed')) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Sign in failed. Check your credentials and try again.');
}

export async function signOutFromWardenApp() {
  clearSession();
}

export function getStoredToken() {
  const session = loadSession();
  return session?.token || '';
}