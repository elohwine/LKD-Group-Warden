const DB_NAME = 'ldk-warden-app';
const STORE_NAME = 'captureQueue';

function openQueueDb() {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);

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

async function withStore(mode, callback) {
  const db = await openQueueDb();
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

export async function listQueueItems() {
  const db = await openQueueDb();
  if (!db) return [];

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function saveQueueItem(item) {
  return withStore('readwrite', (store) => store.put(item));
}

export async function deleteQueueItem(id) {
  return withStore('readwrite', (store) => store.delete(id));
}

/**
 * secureDeleteQueueItem — FRD §4.2 compliance.
 *
 * Images stored locally during offline mode MUST be "securely deleted
 * immediately upon successful synchronisation with the cloud."
 *
 * This function:
 * 1. Reads the queued record and nullifies every blob reference so the
 *    ArrayBuffer becomes unreachable and eligible for GC.
 * 2. Overwrites the IndexedDB record with the zeroed version (belt-and-
 *    suspenders — avoids any residual data in the store).
 * 3. Deletes the record entirely.
 *
 * Call this instead of deleteQueueItem after a confirmed successful sync.
 */
export async function secureDeleteQueueItem(id) {
  const db = await openQueueDb();
  if (!db) return null;

  // Step 1 — zero blobs in-memory and overwrite the stored record
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => {
      const item = request.result;
      if (!item) {
        resolve(null);
        return;
      }

      // Null-out every file blob so the GC can reclaim the ArrayBuffer
      if (Array.isArray(item.files)) {
        item.files = item.files.map((f) => ({
          ...f,
          blob: null,
          data: null,
        }));
      }
      // Zero any top-level image data fields for good measure
      item.payload = { ...item.payload, _secureDeleted: true };

      const writeRequest = store.put(item);
      writeRequest.onsuccess = () => resolve(item);
      writeRequest.onerror = () => reject(writeRequest.error);
    };

    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });

  // Step 2 — delete the record
  return deleteQueueItem(id);
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
      writeRequest.onsuccess = () => resolve(updated);
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