const DB_NAME = 'ldk-warden-quick-capture';
const STORE_NAME = 'cards';
const SNAPSHOT_ID = 'snapshot';

function openDb() {
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
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const result = callback(store, tx);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveQuickCaptureCards(cards = []) {
  const safe = Array.isArray(cards) ? cards : [];
  return withStore('readwrite', (store) => store.put({ id: SNAPSHOT_ID, cards: safe, updatedAt: new Date().toISOString() }));
}

export async function loadQuickCaptureCards() {
  const db = await openDb();
  if (!db) return [];

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(SNAPSHOT_ID);
    request.onsuccess = () => {
      const value = request.result;
      const cards = Array.isArray(value?.cards) ? value.cards : [];
      resolve(cards);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearQuickCaptureCards() {
  return withStore('readwrite', (store) => store.delete(SNAPSHOT_ID));
}
