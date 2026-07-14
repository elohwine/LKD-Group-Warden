const DB_NAME = 'ldk-warden-app';
const MIRROR_DB_NAME = 'ldk-warden-app-mirror';
const STORE_NAME = 'captureQueue';

function openDb(dbName) {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(dbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openQueueDb() {
  return openDb(DB_NAME);
}

function openQueueMirrorDb() {
  return openDb(MIRROR_DB_NAME);
}

async function withStoreFromDb(db, mode, callback) {
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const result = callback(store, transaction);

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function withStore(mode, callback) {
  const db = await openQueueDb();
  return withStoreFromDb(db, mode, callback);
}

async function listFromDb(db) {
  if (!db) return [];

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function mirrorWrite(item) {
  const mirrorDb = await openQueueMirrorDb();
  if (!mirrorDb) return;
  await withStoreFromDb(mirrorDb, 'readwrite', (store) => store.put(item));
}

async function mirrorDelete(id) {
  const mirrorDb = await openQueueMirrorDb();
  if (!mirrorDb) return;
  await withStoreFromDb(mirrorDb, 'readwrite', (store) => store.delete(id));
}

async function restorePrimaryFromMirrorIfNeeded() {
  const [primaryDb, mirrorDb] = await Promise.all([openQueueDb(), openQueueMirrorDb()]);
  if (!primaryDb || !mirrorDb) return [];

  const primaryItems = await listFromDb(primaryDb);
  if (primaryItems.length > 0) return primaryItems;

  const mirrorItems = await listFromDb(mirrorDb);
  if (mirrorItems.length === 0) return [];

  await withStoreFromDb(primaryDb, 'readwrite', (store) => {
    mirrorItems.forEach((item) => store.put(item));
  });

  return mirrorItems;
}

export async function listQueueItems() {
  const restored = await restorePrimaryFromMirrorIfNeeded();
  if (restored.length > 0) return restored;

  const db = await openQueueDb();
  return listFromDb(db);
}

export async function saveQueueItem(item) {
  const result = await withStore('readwrite', (store) => store.put(item));
  try {
    await mirrorWrite(item);
  } catch (error) {
    console.warn('[queue] mirror save failed', error?.message || error);
  }
  return result;
}

export async function deleteQueueItem(id) {
  const result = await withStore('readwrite', (store) => store.delete(id));
  try {
    await mirrorDelete(id);
  } catch (error) {
    console.warn('[queue] mirror delete failed', error?.message || error);
  }
  return result;
}

export async function updateQueueItem(id, patch) {
  const db = await openQueueDb();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => {
      const next = request.result;
      if (!next) {
        resolve(null);
        return;
      }
      const updated = { ...next, ...patch };
      const writeRequest = store.put(updated);
      writeRequest.onsuccess = async () => {
        try {
          await mirrorWrite(updated);
        } catch (error) {
          console.warn('[queue] mirror update failed', error?.message || error);
        }
        resolve(updated);
      };
      writeRequest.onerror = () => reject(writeRequest.error);
    };

    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

export function createQueueItem({ payload, files = [] }) {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 0,
    status: 'queued',
    lastError: null,
    payload,
    files
  };
}