/**
 * Warden Dashboard - Offline Queue & Sync UI
 * 
 * Features:
 * - Display queued breaches (pending/synced)
 * - Sync to backend with progress tracking
 * - GDPR-compliant secure delete after sync
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getQueueItems,
  getQueueStats,
  secureDeleteQueueItem,
  updateQueueItem,
} from '../lib/queue';

const Dashboard = () => {
  const [queue, setQueue] = useState([]);
  const [stats, setStats] = useState({ total: 0, synced: 0, pending: 0 });
  const [syncing, setSyncing] = useState(false);
  const [token, setToken] = useState(null);

  // Load queue on mount
  useEffect(() => {
    loadQueue();
  }, []);

  const loadQueue = async () => {
    try {
      const items = await getQueueItems();
      const stats = await getQueueStats();
      setQueue(items);
      setStats(stats);
    } catch (err) {
      console.error('Error loading queue:', err);
    }
  };

  const syncQueueItem = useCallback(
    async (id) => {
      const item = queue.find((i) => i.id === id);
      if (!item) return;

      setSyncing(true);
      try {
        // Get token from auth service (e.g., Firebase)
        if (!token) {
          console.error('No auth token available');
          return;
        }

        console.log(`[dashboard] Syncing queue item ${id}...`);

        // Step 1: Upload evidence images
        let uploadedUrls = [];
        if (item.images && item.images.length > 0) {
          const formData = new FormData();
          for (const image of item.images) {
            formData.append('file', image);
          }
          formData.append('siteId', item.siteId);
          if (item.vrm) {
            formData.append('manualVrm', item.vrm);
          }

          const uploadRes = await fetch('/api/warden/uploadevidence', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: formData,
          });

          if (!uploadRes.ok) {
            throw new Error(`Upload failed: ${uploadRes.status}`);
          }

          const uploadData = await uploadRes.json();
          uploadedUrls = uploadData.images || [];
          console.log(`[dashboard] Uploaded ${uploadedUrls.length} image(s)`);
        }

        // Step 2: Capture breach to backend
        const captureRes = await fetch('/api/breaches/wardencapture', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            vrm: item.vrm,
            siteId: item.siteId,
            siteName: item.siteName,
            contraventionReason: item.contraventionReason,
            observationStartTime: item.observationStartTime,
            observationEndTime: item.observationEndTime,
            images: uploadedUrls,
            location: item.location,
            notes: item.notes,
          }),
        });

        if (!captureRes.ok) {
          throw new Error(`Capture failed: ${captureRes.status}`);
        }

        const captureData = await captureRes.json();
        console.log(`[dashboard] Breach created: ${captureData.id}`);

        // Step 3: Update queue item (mark synced)
        await updateQueueItem(id, {
          synced: true,
          breachId: captureData.id,
          syncedAt: new Date().toISOString(),
        });

        // Step 4: GDPR Secure Delete - zero-fill image data & dereference
        console.log(`[dashboard] Executing secure delete (GDPR §4.2)...`);
        await secureDeleteQueueItem(id);

        console.log(`[dashboard] Item ${id} securely deleted after sync`);

        // Refresh queue UI
        await loadQueue();
      } catch (err) {
        console.error(`[dashboard] Sync error for item ${id}:`, err);
        // Mark item with error status (non-fatal)
        await updateQueueItem(id, { syncError: err.message });
        await loadQueue();
      } finally {
        setSyncing(false);
      }
    },
    [queue, token]
  );

  const handleSyncAll = async () => {
    const pendingItems = queue.filter((i) => !i.synced);
    for (const item of pendingItems) {
      await syncQueueItem(item.id);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>🚗 Warden Dashboard</h1>

      {/* Queue Stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '10px',
          marginBottom: '20px',
        }}
      >
        <div style={{ background: '#f0f0f0', padding: '10px', borderRadius: '4px' }}>
          <p style={{ margin: 0, fontSize: '12px', color: '#666' }}>TOTAL ITEMS</p>
          <p style={{ margin: '5px 0 0 0', fontSize: '24px', fontWeight: 'bold' }}>
            {stats.total}
          </p>
        </div>
        <div style={{ background: '#e8f5e9', padding: '10px', borderRadius: '4px' }}>
          <p style={{ margin: 0, fontSize: '12px', color: '#666' }}>SYNCED</p>
          <p style={{ margin: '5px 0 0 0', fontSize: '24px', fontWeight: 'bold', color: '#4caf50' }}>
            {stats.synced}
          </p>
        </div>
        <div style={{ background: '#fff3e0', padding: '10px', borderRadius: '4px' }}>
          <p style={{ margin: 0, fontSize: '12px', color: '#666' }}>PENDING</p>
          <p style={{ margin: '5px 0 0 0', fontSize: '24px', fontWeight: 'bold', color: '#ff9800' }}>
            {stats.pending}
          </p>
        </div>
      </div>

      {/* Sync Button */}
      <button
        onClick={handleSyncAll}
        disabled={syncing || stats.pending === 0}
        style={{
          padding: '10px 20px',
          background: syncing || stats.pending === 0 ? '#ccc' : '#2196f3',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: syncing || stats.pending === 0 ? 'not-allowed' : 'pointer',
          fontSize: '14px',
          fontWeight: 'bold',
        }}
      >
        {syncing ? '⏳ Syncing...' : `📤 Sync All (${stats.pending} pending)`}
      </button>

      {/* Queue Items Table */}
      <div style={{ marginTop: '20px', overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '12px',
          }}
        >
          <thead>
            <tr style={{ background: '#f5f5f5', borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: '8px', textAlign: 'left' }}>ID</th>
              <th style={{ padding: '8px', textAlign: 'left' }}>VRM</th>
              <th style={{ padding: '8px', textAlign: 'left' }}>Site</th>
              <th style={{ padding: '8px', textAlign: 'left' }}>Reason</th>
              <th style={{ padding: '8px', textAlign: 'left' }}>Images</th>
              <th style={{ padding: '8px', textAlign: 'center' }}>Status</th>
              <th style={{ padding: '8px', textAlign: 'center' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((item) => (
              <tr key={item.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '8px' }}>{item.id}</td>
                <td style={{ padding: '8px', fontWeight: 'bold' }}>{item.vrm || '—'}</td>
                <td style={{ padding: '8px' }}>{item.siteId}</td>
                <td style={{ padding: '8px' }}>{item.contraventionReason}</td>
                <td style={{ padding: '8px', textAlign: 'center' }}>
                  {item.images?.length || 0}
                </td>
                <td
                  style={{
                    padding: '8px',
                    textAlign: 'center',
                    color: item.synced ? '#4caf50' : '#ff9800',
                    fontWeight: 'bold',
                  }}
                >
                  {item.synced ? '✓ SYNCED' : '⏳ PENDING'}
                </td>
                <td style={{ padding: '8px', textAlign: 'center' }}>
                  {!item.synced && (
                    <button
                      onClick={() => syncQueueItem(item.id)}
                      disabled={syncing}
                      style={{
                        padding: '4px 8px',
                        background: syncing ? '#ccc' : '#2196f3',
                        color: 'white',
                        border: 'none',
                        borderRadius: '3px',
                        cursor: syncing ? 'not-allowed' : 'pointer',
                        fontSize: '11px',
                      }}
                    >
                      Sync
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {queue.length === 0 && (
          <p style={{ textAlign: 'center', color: '#999', marginTop: '20px' }}>
            No items in queue
          </p>
        )}
      </div>

      {/* GDPR Compliance Info */}
      <div
        style={{
          marginTop: '20px',
          padding: '10px',
          background: '#e3f2fd',
          borderRadius: '4px',
          fontSize: '12px',
          color: '#1565c0',
        }}
      >
        🔒 <strong>GDPR Compliant:</strong> After successful sync, image data is zero-filled and
        dereferenced from memory to prevent unauthorized recovery (FRD §4.2).
      </div>
    </div>
  );
};

export default Dashboard;
