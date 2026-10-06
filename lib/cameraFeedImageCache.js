const DB_NAME = 'ldk-warden-camera-feed';
const STORE_NAME = 'imagePreviews';
const MAX_PREVIEW_ENTRIES = 600;

function openDb() {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadCameraFeedImagePreviews(urls = []) {
  const safeUrls = Array.isArray(urls)
    ? urls.map((value) => String(value || '').trim()).filter((value) => /^https?:\/\//i.test(value))
    : [];

  if (safeUrls.length === 0) return {};

  const db = await openDb();
  if (!db) return {};

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const result = {};
    let pending = safeUrls.length;

    if (pending === 0) {
      resolve(result);
      return;
    }

    safeUrls.forEach((url) => {
      const req = store.get(url);
      req.onsuccess = () => {
        const value = req.result;
        if (value?.dataUrl) {
          result[url] = String(value.dataUrl);
        }
        pending -= 1;
        if (pending === 0) resolve(result);
      };
      req.onerror = () => {
        pending -= 1;
        if (pending === 0) resolve(result);
      };
    });

    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function pruneCameraFeedImageCache(store) {
  const index = store.index('updatedAt');
  const request = index.openCursor(null, 'prev');
  let seen = 0;

  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    seen += 1;
    if (seen > MAX_PREVIEW_ENTRIES) {
      store.delete(cursor.primaryKey);
    }
    cursor.continue();
  };
}

export async function saveCameraFeedImagePreview(url, dataUrl) {
  const safeUrl = String(url || '').trim();
  const safeDataUrl = String(dataUrl || '').trim();
  if (!/^https?:\/\//i.test(safeUrl) || !/^data:image\//i.test(safeDataUrl)) return;

  const db = await openDb();
  if (!db) return;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    store.put({
      url: safeUrl,
      dataUrl: safeDataUrl,
      updatedAt: Date.now(),
    });

    pruneCameraFeedImageCache(store);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
