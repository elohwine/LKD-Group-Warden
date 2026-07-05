const SESSION_KEY = 'ldk-warden-session';

export function loadSession() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn('[warden-session] failed to load session', error?.message || error);
    return null;
  }
}

export function saveSession(session) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(SESSION_KEY);
}

export function getStoredSiteId() {
  const session = loadSession();
  return session?.selectedSiteId || '';
}

export function saveStoredSiteId(selectedSiteId) {
  const session = loadSession() || {};
  saveSession({ ...session, selectedSiteId });
}