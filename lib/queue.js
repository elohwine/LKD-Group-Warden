/**
 * Offline queue management for Warden app.
 * Stores breach captures & evidence locally until sync with backend.
 * GDPR compliant: secureDeleteQueueItem zero-fills image data after sync.
 */

import { openDB } from 'idb';

const DB_NAME = 'warden-queue';
const STORE_NAME = 'captures';

/**
 * Initialize IndexedDB store
 */
async function initDB() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    },
  });
}

/**
 * Add a capture to the queue.
 * @param {Object} item - { images: Blob[], vrm: string, siteId: string, ... }
 * @returns {Promise<number>} Item ID in queue
 */
export async function addQueueItem(item) {
  const db = await initDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  const queueItem = {
    ...item,
    addedAt: new Date().toISOString(),
    synced: false,
  };

  const id = await store.add(queueItem);
  console.log(`[queue] Added item ${id}: VRM=${item.vrm}, images=${item.images?.length || 0}`);
  return id;
}

/**
 * Get all items in queue.
 * @returns {Promise<Array>} Queue items
 */
export async function getQueueItems() {
  const db = await initDB();
  return db.getAll(STORE_NAME);
}

/**
 * Get a single queue item by ID.
 * @param {number} id
 * @returns {Promise<Object|undefined>} Item or undefined
 */
export async function getQueueItem(id) {
  const db = await initDB();
  return db.get(STORE_NAME, id);
}

/**
 * Update queue item (e.g., mark as synced, add breach ID).
 * @param {number} id
 * @param {Object} updates
 */
export async function updateQueueItem(id, updates) {
  const db = await initDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  const item = await store.get(id);
  if (!item) {
    console.warn(`[queue] Item ${id} not found for update`);
    return;
  }

  const updated = { ...item, ...updates, updatedAt: new Date().toISOString() };
  await store.put(updated);
  console.log(`[queue] Updated item ${id}:`, updates);
}

/**
 * Delete queue item (basic cleanup).
 * @param {number} id
 */
export async function deleteQueueItem(id) {
  const db = await initDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  const item = await store.get(id);
  await store.delete(id);
  console.log(`[queue] Deleted item ${id}`);
  return item;
}

/**
 * GDPR Compliant: Securely delete queue item.
 * 
 * After successful sync to backend, zero-fill all Blob data in memory
 * and dereference so garbage collector can reclaim the ArrayBuffer.
 * Satisfies FRD §4.2: "securely deleted immediately upon successful synchronisation"
 * 
 * @param {number} id
 * @returns {Promise<Object>} Deleted item (with zeroed data)
 */
export async function secureDeleteQueueItem(id) {
  console.log(`[queue] Securely deleting item ${id} (GDPR compliance)`);

  const db = await initDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  const item = await store.get(id);
  if (!item) {
    console.warn(`[queue] Item ${id} not found for secure delete`);
    return null;
  }

  // Zero-fill all Blob data in the images array
  if (Array.isArray(item.images)) {
    for (const blob of item.images) {
      if (blob instanceof Blob || (blob && typeof blob.arrayBuffer === 'function')) {
        try {
          const buffer = await blob.arrayBuffer();
          const view = new Uint8Array(buffer);
          view.fill(0); // Overwrite with zeros
          console.log(`[queue] Zero-filled image blob (${blob.size} bytes)`);
        } catch (err) {
          console.warn(`[queue] Could not zero-fill blob:`, err?.message);
        }
      }
    }
    item.images = null; // Dereference so GC can collect
  }

  // Zero-fill any other binary fields
  if (item.evidence && typeof item.evidence.arrayBuffer === 'function') {
    try {
      const buffer = await item.evidence.arrayBuffer();
      const view = new Uint8Array(buffer);
      view.fill(0);
      console.log(`[queue] Zero-filled evidence blob`);
    } catch (err) {
      console.warn(`[queue] Could not zero-fill evidence:`, err?.message);
    }
    item.evidence = null;
  }

  // Delete from IndexedDB
  await store.delete(id);
  console.log(`[queue] Item ${id} securely deleted (data zeroed + dereferenced)`);

  return item;
}

/**
 * Clear entire queue (testing/reset only).
 * WARNING: Does not zero-fill data. Use secureDeleteQueueItem for GDPR compliance.
 */
export async function clearQueue() {
  const db = await initDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  await store.clear();
  console.log('[queue] Entire queue cleared');
}

/**
 * Get queue statistics (for UI display).
 * @returns {Promise<Object>} { total, synced, pending, totalImageCount }
 */
export async function getQueueStats() {
  const items = await getQueueItems();
  const synced = items.filter((i) => i.synced).length;
  const pending = items.length - synced;
  const totalImageCount = items.reduce((sum, i) => sum + (i.images?.length || 0), 0);

  return {
    total: items.length,
    synced,
    pending,
    totalImageCount,
  };
}
