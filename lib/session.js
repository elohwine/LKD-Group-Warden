const SESSION_KEY = 'ldk-warden-session';
const SESSION_DB_NAME = 'ldk-warden-session-db';
const SESSION_STORE_NAME = 'sessionState';

function openSessionDb() {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(SESSION_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
        db.createObjectStore(SESSION_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function persistSessionMirror(session) {
  try {
    const db = await openSessionDb();
    if (!db) return;

    await new Promise((resolve, reject) => {
      const transaction = db.transaction(SESSION_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(SESSION_STORE_NAME);
      store.put(session, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch (error) {
    console.warn('[warden-session] failed to mirror session', error?.message || error);
  }
}

async function readSessionMirror() {
  try {
    const db = await openSessionDb();
    if (!db) return null;

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(SESSION_STORE_NAME, 'readonly');
      const request = transaction.objectStore(SESSION_STORE_NAME).get('current');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('[warden-session] failed to read session mirror', error?.message || error);
    return null;
  }
}

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
  void persistSessionMirror(session);
}

export function clearSession() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(SESSION_KEY);
  void (async () => {
    try {
      const db = await openSessionDb();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(SESSION_STORE_NAME, 'readwrite');
        transaction.objectStore(SESSION_STORE_NAME).delete('current');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } catch (error) {
      console.warn('[warden-session] failed to clear session mirror', error?.message || error);
    }
  })();
}

export async function restoreSession() {
  const session = loadSession();
  if (session) return session;

  const mirroredSession = await readSessionMirror();
  if (mirroredSession) {
    try {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(mirroredSession));
    } catch (error) {
      console.warn('[warden-session] failed to rehydrate session from mirror', error?.message || error);
    }
  }

  return mirroredSession;
}

export function getStoredSiteId() {
  const session = loadSession();
  return session?.selectedSiteId || '';
}

export function saveStoredSiteId(selectedSiteId) {
  const session = loadSession() || {};
  saveSession({ ...session, selectedSiteId });
}

export function getStoredMobileCameraId() {
  const session = loadSession();
  return session?.selectedMobileCameraId || '';
}

export function saveStoredMobileCameraId(selectedMobileCameraId) {
  const session = loadSession() || {};
  saveSession({ ...session, selectedMobileCameraId });
}