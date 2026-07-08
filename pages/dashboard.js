import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { fetchJson } from '../lib/api';
import { clearSession, loadSession, saveSession, saveStoredSiteId } from '../lib/session';
import { signOutFromWardenApp, getStoredToken } from '../lib/auth';
import { getContraventionOptions } from '../lib/contraventions';
import { getCurrentLocation } from '../lib/geo';
import { buildApiUrl } from '../lib/api';
import { createQueueItem, deleteQueueItem, listQueueItems, saveQueueItem, updateQueueItem } from '../lib/queue';
import AppShell from '../components/AppShell';
import LoadingSpinner from '../components/LoadingSpinner.js';
import LicensePlate from '../components/LicensePlate.js';

function formatCountdown(targetIso) {
  const diff = new Date(targetIso).getTime() - Date.now();
  if (Number.isNaN(diff)) return '00:00';
  if (diff <= 0) return '00:00';
  const totalSeconds = Math.floor(diff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function toObjectUrlList(files) {
  return files.map((file) => URL.createObjectURL(file));
}

function normalizeVrm(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export default function DashboardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [sites, setSites] = useState([]);
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [selectedVrm, setSelectedVrm] = useState('');
  const [selectedReason, setSelectedReason] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [manualObservationMinutes, setManualObservationMinutes] = useState(10);
  const [location, setLocation] = useState(null);
  const [files, setFiles] = useState([]);
  const [filePreviews, setFilePreviews] = useState([]);
  const [authorization, setAuthorization] = useState(null);
  const [queueItems, setQueueItems] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [ticks, setTicks] = useState(0);
  const [selectedContraventionCode, setSelectedContraventionCode] = useState('');
  const [authToken, setAuthToken] = useState('');
  const fileInputRef = useRef(null);
  const authReadyRef = useRef(false);

  const selectedSite = useMemo(() => sites.find((site) => String(site.id) === String(selectedSiteId)) || null, [sites, selectedSiteId]);
  const contraventions = useMemo(() => getContraventionOptions(selectedSite), [selectedSite]);
  const activeTimers = useMemo(() => {
    return queueItems
      .filter((item) => item?.payload?.observationEndTime)
      .map((item) => ({
        id: item.id,
        vrm: item.payload.vrm,
        reason: item.payload.contraventionReason,
        endsAt: item.payload.observationEndTime,
        siteName: item.payload.siteName || selectedSite?.name || 'Site'
      }));
  }, [queueItems, selectedSite?.name]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const fromSite = url.searchParams.get('siteId');
    if (fromSite) {
      setSelectedSiteId(fromSite);
      saveStoredSiteId(fromSite);
    } else {
      const saved = loadSession();
      if (saved?.selectedSiteId) setSelectedSiteId(saved.selectedSiteId);
    }
  }, []);

  useEffect(() => {
    async function bootstrapSession() {
      try {
        const session = loadSession();
        const token = session?.token;

        if (!token || !session?.role) {
          await router.replace('/login');
          return;
        }

        setAuthToken(token);
        setProfile(session);
        setOnline(navigator.onLine);
        await Promise.all([loadSites(token), refreshQueue()]);
        authReadyRef.current = true;
      } catch (error) {
        console.error('[warden] profile bootstrap failed', error);
        clearSession();
        await signOutFromWardenApp();
        await router.replace('/login');
      }
    }

    bootstrapSession();
  }, [router]);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setTicks((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      filePreviews.forEach((preview) => URL.revokeObjectURL(preview));
    };
  }, [filePreviews]);

  useEffect(() => {
    const contravention = contraventions.find((item) => item.code === selectedContraventionCode) || contraventions[0];
    if (contravention) {
      setSelectedReason(contravention.label);
      setManualObservationMinutes(Number(contravention.defaultObservationMinutes || 10));
    }
  }, [contraventions, selectedContraventionCode]);

  useEffect(() => {
    if (selectedSiteId) {
      saveStoredSiteId(selectedSiteId);
    }
  }, [selectedSiteId]);

  async function loadSites(token) {
    const data = await fetchJson('/api/sites?forceAdmin=true', { token });
    const nextSites = Array.isArray(data?.sites) ? data.sites : [];
    const activeSites = nextSites.filter((site) => site.active !== false && site.isActive !== false);
    setSites(activeSites);
    if (!selectedSiteId && activeSites.length > 0) {
      setSelectedSiteId(activeSites[0].id);
      saveStoredSiteId(activeSites[0].id);
    }
  }

  async function refreshQueue() {
    const items = await listQueueItems();
    setQueueItems(items.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))));
  }

  async function handleLogout() {
    clearSession();
    await signOutFromWardenApp();
    await router.replace('/login');
  }

  async function handleFileSelection(event) {
    const nextFiles = Array.from(event.target.files || []);
    setFiles(nextFiles);
    setFilePreviews(toObjectUrlList(nextFiles));
    if (nextFiles.length > 0) {
      setMessage(`Captured ${nextFiles.length} file${nextFiles.length > 1 ? 's' : ''}.`);
    }
  }

  async function inferVrmFromImage() {
    if (!files.length) return;
    setBusy(true);
    setMessage('Reading VRM from image…');

    try {
      const token = authToken || getStoredToken();
      if (!token) throw new Error('auth_missing');

      const formData = new FormData();
      files.forEach((file) => formData.append('file', file));
      formData.append('siteId', selectedSiteId);
      formData.append('manualVrm', selectedVrm);

      const response = await fetch(buildApiUrl('/api/warden/uploadevidence'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to analyse evidence');
      }

      if (data?.vrm) {
        setSelectedVrm(data.vrm);
      }
      if (data?.images?.length) {
        setMessage(`Evidence uploaded. ${data.images.length} image${data.images.length > 1 ? 's' : ''} ready.`);
      }
    } catch (error) {
      console.error('[warden] evidence analysis failed', error);
      setMessage(error?.message || 'Evidence analysis failed');
    } finally {
      setBusy(false);
    }
  }

  async function checkAuthorization(nextVrm) {
    const vrm = normalizeVrm(nextVrm || selectedVrm);
    if (!vrm || !selectedSiteId) return null;
    const token = authToken || getStoredToken();
    if (!token) throw new Error('auth_missing');
    const result = await fetchJson(`/api/parking/check-authorization?vrm=${encodeURIComponent(vrm)}&siteId=${encodeURIComponent(selectedSiteId)}&breachTime=${encodeURIComponent(new Date().toISOString())}`, {
      token
    });
    setAuthorization(result);
    return result;
  }

  async function queueOrSendCapture({ immediate = false } = {}) {
    if (!selectedSiteId) {
      setMessage('Choose a patrol site before submitting.');
      return;
    }
    if (!selectedVrm) {
      setMessage('Enter or capture a VRM first.');
      return;
    }

    const observationRequired = manualObservationMinutes > 0;
    const now = new Date();
    const locationSnapshot = location || (await getCurrentLocation());
    const payload = {
      vrm: normalizeVrm(selectedVrm),
      siteId: selectedSiteId,
      siteName: selectedSite?.name || selectedSite?.displayName || selectedSiteId,
      source: 'WARDEN',
      wardenId: profile?.uid,
      actorId: profile?.uid,
      contraventionReason: selectedReason,
      status: 'QUEUED_FOR_QC',
      location: locationSnapshot || null,
      observationStartTime: observationRequired ? now.toISOString() : null,
      observationEndTime: observationRequired ? new Date(now.getTime() + manualObservationMinutes * 60000).toISOString() : null,
      manualNote,
      authorization,
      selectedContraventionCode
    };

    const item = createQueueItem({
      payload,
      files: files.map((file) => ({
        name: file.name,
        type: file.type,
        blob: file
      }))
    });

    await saveQueueItem(item);
    await refreshQueue();

    if (!online && !immediate) {
      setMessage('Captured offline. The breach is queued for sync.');
      return;
    }

    await syncQueueItem(item.id);
  }

  async function syncQueueItem(itemId) {
    const queuedItem = (await listQueueItems()).find((item) => item.id === itemId);
    if (!queuedItem) return;

    try {
      await updateQueueItem(itemId, { status: 'syncing', attempts: queuedItem.attempts + 1, updatedAt: new Date().toISOString(), lastError: null });
      await refreshQueue();

      const token = authToken || getStoredToken();
      if (!token) throw new Error('auth_missing');

      const formData = new FormData();
      queuedItem.files.forEach((file) => {
        formData.append('file', file.blob, file.name);
      });
      formData.append('siteId', queuedItem.payload.siteId);
      formData.append('manualVrm', queuedItem.payload.vrm);

      const evidenceResponse = await fetch(buildApiUrl('/api/warden/uploadevidence'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      const evidenceData = await evidenceResponse.json();
      if (!evidenceResponse.ok) {
        throw new Error(evidenceData?.error || 'Evidence upload failed');
      }

      const vrm = normalizeVrm(evidenceData.vrm || queuedItem.payload.vrm);
      const authData = await checkAuthorization(vrm);
      const breachPayload = {
        ...queuedItem.payload,
        vrm,
        images: evidenceData.images || [],
        imageUrls: evidenceData.images || [],
        authorization: authData,
        status: 'QUEUED_FOR_QC',
        source: 'WARDEN',
        wardenId: profile?.uid,
        actorId: profile?.uid
      };

      const breachResult = await fetchJson('/api/breaches/wardencapture', {
        method: 'POST',
        token,
        body: breachPayload
      });

      await deleteQueueItem(itemId);
      setMessage(`Breach queued successfully: ${breachResult?.id || vrm}`);
      setSelectedVrm('');
      setFiles([]);
      setFilePreviews([]);
      setAuthorization(null);
      setManualNote('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) {
      console.error('[warden] sync failed', error);
      await updateQueueItem(itemId, {
        status: 'failed',
        lastError: error?.message || 'Sync failed',
        updatedAt: new Date().toISOString()
      });
      setMessage(error?.message || 'Sync failed');
    } finally {
      await refreshQueue();
    }
  }

  async function syncQueue() {
    if (syncing) return;
    setSyncing(true);
    try {
      const items = await listQueueItems();
      for (const item of items.filter((entry) => entry.status !== 'synced')) {
        await syncQueueItem(item.id);
      }
    } finally {
      setSyncing(false);
    }
  }

  async function handleFinalize() {
    setBusy(true);
    try {
      setLocation((await getCurrentLocation()) || location);
      await checkAuthorization(selectedVrm);
      await queueOrSendCapture();
    } finally {
      setBusy(false);
    }
  }

  function selectContravention(code) {
    const next = contraventions.find((item) => item.code === code) || contraventions[0];
    setSelectedContraventionCode(code);
    if (next) {
      setSelectedReason(next.label);
      setManualObservationMinutes(Number(next.defaultObservationMinutes || 10));
    }
  }

  if (!profile) {
    return (
      <div className="screen-loading">
        <LoadingSpinner />
        <span>Loading secure patrol workspace…</span>
      </div>
    );
  }

  return (
    <AppShell
      profile={profile}
      siteName={selectedSite?.name || selectedSite?.displayName || ''}
      online={online}
      syncing={syncing}
      queueCount={queueItems.length}
      onLogout={handleLogout}
      onSync={syncQueue}
    >
      <section className="workspace-grid">
        <div className="card stack gap-large">
          <div className="card-header-row">
            <div>
              <p className="eyebrow">1. Site selection</p>
              <h3>Current patrol site</h3>
            </div>
            <span className="muted-chip">{sites.length} active sites</span>
          </div>
          <select className="field-select" value={selectedSiteId} onChange={(event) => setSelectedSiteId(event.target.value)}>
            <option value="">Select site</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.displayName || site.name || site.location || site.id}
              </option>
            ))}
          </select>
          <p className="card-copy">
            Site scope is enforced before submission. You can only finalise a breach against the patrol site selected here.
          </p>
        </div>

        <div className="card stack gap-large">
          <div className="card-header-row">
            <div>
              <p className="eyebrow">2. Capture evidence</p>
              <h3>Camera-first workflow</h3>
            </div>
            <button type="button" className="ghost-button" onClick={() => fileInputRef.current?.click()}>
              Capture
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={handleFileSelection}
            className="file-input"
          />

          <div className="capture-grid">
            <label>
              VRM
              <input value={selectedVrm} onChange={(event) => setSelectedVrm(normalizeVrm(event.target.value))} placeholder="AB12CDE" />
            </label>
            <label>
              Contravention
              <select value={selectedContraventionCode} onChange={(event) => selectContravention(event.target.value)}>
                {contraventions.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.code} - {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label>
            Notes
            <textarea value={manualNote} onChange={(event) => setManualNote(event.target.value)} rows={3} placeholder="Observation notes, bay position, signage issues, etc." />
          </label>

          <div className="preview-row">
            {filePreviews.length > 0 ? filePreviews.map((preview) => <img key={preview} src={preview} alt="Evidence preview" className="preview-image" />) : <div className="preview-placeholder">Evidence previews appear here.</div>}
          </div>

          <div className="action-row">
            <button type="button" className="secondary-button" onClick={inferVrmFromImage} disabled={busy || files.length === 0}>
              Analyse image
            </button>
            <button type="button" className="primary-button" onClick={handleFinalize} disabled={busy || !selectedSiteId}>
              Finalise breach
            </button>
          </div>
        </div>

        <div className="card stack gap-large">
          <div className="card-header-row">
            <div>
              <p className="eyebrow">3. Live validation</p>
              <h3>Authorization status</h3>
            </div>
            <span className={`status-pill ${authorization?.hasAuthorization ? 'status-pill-online' : 'status-pill-offline'}`}>
              {authorization?.hasAuthorization ? 'Authorised' : 'Unverified'}
            </span>
          </div>
          <div className="auth-state">
            <LicensePlate number={selectedVrm || '—'} size="large" />
            <div className="auth-state-copy">
              <strong>{authorization?.authorization?.type || 'No active permit'}</strong>
              <p>{authorization?.authorization ? `${authorization.authorization.site || 'Site matched'} • ${authorization.authorization.status || 'active'}` : 'Run analysis or enter a VRM to check the current site.'}</p>
            </div>
          </div>
          <div className="auth-meta-grid">
            <div>
              <span className="meta-label">Location</span>
              <strong>{location ? `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}` : 'Pending'}</strong>
            </div>
            <div>
              <span className="meta-label">Observation</span>
              <strong>{manualObservationMinutes > 0 ? `${manualObservationMinutes} minutes` : 'Not required'}</strong>
            </div>
            <div>
              <span className="meta-label">Notes</span>
              <strong>{manualNote || 'None'}</strong>
            </div>
          </div>
        </div>

        <div className="card stack gap-large wide-card">
          <div className="card-header-row">
            <div>
              <p className="eyebrow">4. Observation timers</p>
              <h3>Multi-vehicle monitoring</h3>
            </div>
            <span className="muted-chip">{activeTimers.length} active</span>
          </div>
          {activeTimers.length === 0 ? (
            <p className="card-copy">No active observation timers yet. Finalised captures with an observation requirement will appear here.</p>
          ) : (
            <div className="timer-list">
              {activeTimers.map((timer) => (
                <article key={timer.id} className="timer-item">
                  <div>
                    <strong>{timer.vrm}</strong>
                    <p>{timer.reason}</p>
                    <span>{timer.siteName}</span>
                  </div>
                  <div className="timer-countdown">{formatCountdown(timer.endsAt)}</div>
                </article>
              ))}
            </div>
          )}
        </div>

        <div className="card stack gap-large wide-card">
          <div className="card-header-row">
            <div>
              <p className="eyebrow">5. Queue</p>
              <h3>Offline sync status</h3>
            </div>
            <span className="muted-chip">{queueItems.length} queued</span>
          </div>

          {message ? <div className="notice notice-info">{message}</div> : null}

          {queueItems.length === 0 ? (
            <p className="card-copy">The queue is empty. Captures will be stored locally if the device drops offline.</p>
          ) : (
            <div className="queue-list">
              {queueItems.map((item) => (
                <article key={item.id} className="queue-item">
                  <div>
                    <strong>{item.payload?.vrm || 'Pending VRM'}</strong>
                    <p>{item.payload?.contraventionReason || 'No reason supplied'}</p>
                    <span>{item.payload?.siteName || 'Site not set'}</span>
                  </div>
                  <div className="queue-item-meta">
                    <span className={`status-pill ${item.status === 'failed' ? 'status-pill-offline' : 'status-pill-online'}`}>{item.status}</span>
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </AppShell>
  );
}