/**
 * Time sync utility - fetch server time at capture moment for accurate timestamps.
 * This avoids relying on device clock which may be drifted.
 */

/**
 * Fetch current server time and return as ISO string.
 * Falls back to device time if fetch fails.
 */
export async function getServerTimestamp() {
  try {
    const response = await fetch('/api/sync-time', { 
      method: 'GET',
      cache: 'no-cache',
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.timestamp) {
        console.log('[TimeSync] Using server timestamp:', data.timestamp);
        return data.timestamp;
      }
    }
  } catch (error) {
    console.warn('[TimeSync] Failed to fetch server time:', error.message);
  }
  
  // Fallback to device time
  console.warn('[TimeSync] Falling back to device time');
  return new Date().toISOString();
}

/**
 * Sync with server time on app startup for diagnostics.
 * Note: This is mainly for logging/debugging. Real timestamps come from getServerTimestamp() at capture time.
 */
export async function syncWithServerTime() {
  try {
    const serverTime = await getServerTimestamp();
    console.log('[TimeSync] App startup - server time:', serverTime);
    return true;
  } catch (error) {
    console.warn('[TimeSync] Startup sync failed:', error.message);
    return false;
  }
}

/**
 * Get current time as ISO string (for backwards compatibility).
 */
export function getCorrectedIsoString() {
  return new Date().toISOString();
}
