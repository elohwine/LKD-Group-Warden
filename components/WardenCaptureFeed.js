import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatLocalTimestamp } from '../lib/ukTimestamp';
import { fetchCameraServiceJson, fetchJson } from '../lib/api';

function nv(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function fmt(v) { try { return formatLocalTimestamp(v); } catch (_) { return '–'; } }

function DirectionBadge({ direction }) {
  const d = String(direction || '').toLowerCase();
  if (d === 'entry' || d === 'in' || d === 'forward') return <span className="wf-dir wf-dir--entry">IN</span>;
  if (d === 'exit' || d === 'out' || d === 'reverse') return <span className="wf-dir wf-dir--exit">OUT</span>;
  return null;
}
function PermitBadge({ s }) {
  if (!s) return <span className="wf-badge wf-badge--grey">–</span>;
  if (s === 'checking') return <span className="wf-badge wf-badge--grey">…</span>;
  if (s === 'has_permit') return <span className="wf-badge wf-badge--amber">Permit matched</span>;
  if (s === 'no_permit') return <span className="wf-badge wf-badge--green">No permit</span>;
  if (s === 'error') return <span className="wf-badge wf-badge--grey">Error</span>;
  return null;
}
function CarcheckBadge({ s, d }) {
  if (!s) return null;
  if (s === 'checking') return <span className="wf-badge wf-badge--grey">…</span>;
  if (s === 'ok' && d) return <span className="wf-badge wf-badge--blue" title={[d.make, d.model, d.color].filter(Boolean).join(' ')}>{[d.make, d.color].filter(Boolean).join(' ') || 'OK'}</span>;
  if (s === 'not_found') return <span className="wf-badge wf-badge--grey">Unknown</span>;
  return null;
}

export default function WardenCaptureFeed({
  getToken,
  selectedSiteId = '',
  sites = [],
  localRows = [],
  queueItems = [],
  contraventions = [],
  onStartDraft,
  onOpenCarcheckResult,
  onOpenPermitResult,
  onOpenImage,
  showPcnActions = true,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [vrmFilter, setVrmFilter] = useState('');
  const [viewMode, setViewMode] = useState('table');
  const [checks, setChecks] = useState({});
  const checkingRef = useRef(new Set());

  // Stable ref breaks the unstable-function dep that caused infinite re-fetches.
  const getTokenRef = useRef(getToken);
  useEffect(() => { getTokenRef.current = getToken; });

  const draftByVrm = {};
  for (const item of queueItems) {
    const v = nv(item?.payload?.vrm || item?.vrm || '');
    if (!v) continue;
    if (Boolean(item?.archived) || String(item?.status || '') === 'archived') continue;
    const converted = Boolean(item?.payload?.convertedToPcn);
    const status = String(item?.status || '');
    const code = converted ? 'CONVERTED' : (status === 'submitted' || status === 'synced') ? 'SUBMITTED' : status === 'failed' ? 'FAILED' : 'DRAFT_OPEN';
    const pri = ['CONVERTED', 'SUBMITTED', 'FAILED', 'DRAFT_OPEN'];
    if (!draftByVrm[v] || pri.indexOf(code) < pri.indexOf(draftByVrm[v])) draftByVrm[v] = code;
  }

  const fetchRows = useCallback(async () => {
    if (!selectedSiteId) { setRows([]); setError(''); return; }
    setLoading(true);
    setError('');
    try {
      const token = await getTokenRef.current();
      const params = new URLSearchParams({ limit: '50', cameraType: 'Warden App', order: 'desc' });
      params.set('site', selectedSiteId);
      const data = await fetchCameraServiceJson(`/api/frontend/alarms?${params}`, { token });
      const alarms = Array.isArray(data?.alarms) ? data.alarms : [];
      setRows(alarms.map((alarm, idx) => ({
        vehicleUrl: alarm.images?.vehicle || alarm.vehicleImage || alarm.imageUrl || null,
        plateUrl: alarm.images?.plate || alarm.plateImage || null,
        id: alarm.id || `alarm-${idx}`,
        vrm: nv(alarm.vrm || ''),
        direction: alarm.direction || null,
        timestamp: alarm.timestamp || null,
        siteName: String(alarm.siteName || alarm.site || selectedSiteId || 'Site').trim() || 'Site',
        confidence: Number(alarm.confidence || alarm.plateConfidence || 0),
        cameraName: String(alarm.cameraName || 'Warden App').trim() || 'Warden App',
        imgUrl: alarm.images?.vehicle || alarm.vehicleImage || alarm.images?.plate || alarm.plateImage || alarm.images?.all?.[0] || alarm.imageUrl || null,
      })));
    } catch (err) {
      setError(String(err?.message || '').includes('timeout') ? 'Camera service offline — tap ↻ to retry' : (err?.message || 'Load failed'));
    } finally {
      setLoading(false);
    }
  }, [selectedSiteId]); // getToken excluded intentionally — accessed via ref

  // Only auto-fetch when selectedSiteId first becomes non-empty.
  const lastFetchedSiteRef = useRef('');
  useEffect(() => {
    if (selectedSiteId && selectedSiteId !== lastFetchedSiteRef.current) {
      lastFetchedSiteRef.current = selectedSiteId;
      fetchRows();
    } else if (!selectedSiteId) {
      lastFetchedSiteRef.current = '';
      setRows([]);
    }
  }, [selectedSiteId, fetchRows]);

  const mergedRows = useMemo(() => {
    const buildCaptureSignature = (row) => [
      nv(row?.vrm || row?.plateText || ''),
      String(row?.timestamp || row?.readTimestamp || row?.capturedAt || '').trim(),
      String(row?.siteName || row?.site || selectedSiteId || '').trim().toLowerCase(),
      String(row?.imgUrl || row?.imageUrl || row?.vehicleImageUrl || row?.plateImageUrl || row?.plateUrl || '').trim(),
    ].join('|');

    const locals = (Array.isArray(localRows) ? localRows : []).map((row, idx) => ({
      id: row?.id || `local-${idx}`,
      vrm: nv(row?.vrm || row?.plateText || ''),
      direction: row?.direction || null,
      timestamp: row?.timestamp || row?.readTimestamp || row?.capturedAt || null,
      siteName: String(row?.siteName || row?.site || selectedSiteId || 'Site').trim() || 'Site',
      confidence: Number(row?.confidence || row?.plateConfidence || 0),
      cameraName: String(row?.cameraName || 'Warden App').trim() || 'Warden App',
      vehicleUrl: row?.vehicleUrl || row?.vehicleImageUrl || row?.imgUrl || row?.imageUrl || row?.plateImageUrl || row?.plateUrl || null,
      plateUrl: row?.plateUrl || row?.plateImageUrl || row?.cutoffImage || null,
      imgUrl: row?.imgUrl || row?.imageUrl || row?.vehicleImageUrl || row?.plateImageUrl || row?.plateUrl || null,
      syncStatus: String(row?.syncStatus || '').trim().toLowerCase(),
      syncProgress: Number(row?.syncProgress || 0),
      syncError: String(row?.syncError || '').trim(),
      permitStatus: String(row?.permitStatus || '').trim(),
      permitData: row?.permitData || null,
      isLocalCapture: true,
    }));

    const remote = Array.isArray(rows) ? rows : [];
    const localSignatures = new Set(locals.map((row) => buildCaptureSignature(row)));
    const dedupedRemote = remote.filter((row) => !localSignatures.has(buildCaptureSignature(row)));
    return [...locals, ...dedupedRemote];
  }, [localRows, rows]);

  async function runPermitCheck(id, vrm) {
    if (checkingRef.current.has(`p-${id}`)) return;
    checkingRef.current.add(`p-${id}`);
    setChecks((c) => ({ ...c, [id]: { ...c[id], permitStatus: 'checking' } }));
    try {
      const token = await getTokenRef.current();
      const result = await fetchJson(`/api/parking/check-authorization?vrm=${encodeURIComponent(vrm)}&siteId=${encodeURIComponent(selectedSiteId)}&breachTime=${encodeURIComponent(new Date().toISOString())}`, { token });
      const has = Boolean(result?.hasAuthorization);
      setChecks((c) => ({ ...c, [id]: { ...c[id], permitStatus: has ? 'has_permit' : 'no_permit', permitData: result } }));
      if (!mergedRows.find((row) => row.id === id)?.isLocalCapture) {
        onOpenPermitResult?.({ vrm, siteId: selectedSiteId, result, hasAuthorization: has });
      }
    } catch (_) {
      setChecks((c) => ({ ...c, [id]: { ...c[id], permitStatus: 'error' } }));
    } finally { checkingRef.current.delete(`p-${id}`); }
  }

  async function runCarcheck(id, vrm) {
    if (checkingRef.current.has(`c-${id}`)) return;
    checkingRef.current.add(`c-${id}`);
    setChecks((c) => ({ ...c, [id]: { ...c[id], carcheckStatus: 'checking' } }));
    try {
      const token = await getTokenRef.current();
      const result = await fetchJson(`/api/carcheck?vrm=${encodeURIComponent(vrm)}`, { token });
      const make = String(result?.make || result?.vehicle?.make || '').trim();
      const model = String(result?.model || result?.vehicle?.model || '').trim();
      const color = String(result?.colour || result?.color || result?.vehicle?.colour || '').trim();
      setChecks((c) => ({ ...c, [id]: { ...c[id], carcheckStatus: make || model ? 'ok' : 'not_found', carcheckDetails: { make, model, color } } }));
      onOpenCarcheckResult?.({
        vrm,
        result: { ...result, make, model, color },
        status: make || model ? 'ok' : 'not_found',
      });
    } catch (_) {
      setChecks((c) => ({ ...c, [id]: { ...c[id], carcheckStatus: 'error' } }));
      onOpenCarcheckResult?.({
        vrm,
        result: null,
        status: 'error',
        error: 'Carcheck lookup failed',
      });
    } finally { checkingRef.current.delete(`c-${id}`); }
  }

  const filtered = vrmFilter ? mergedRows.filter((r) => r.vrm.includes(nv(vrmFilter))) : mergedRows;
  const confidenceLabel = (value) => (Number(value || 0) > 0 ? `${Math.round(Number(value))}%` : '–');
  const resolveVehicleImage = (row) => String(row?.vehicleUrl || row?.imgUrl || row?.imageUrl || '').trim();
  const resolvePlateImage = (row) => String(row?.plateUrl || row?.plateImageUrl || '').trim();

  function openRowImage(row, kind = 'vehicle') {
    const src = kind === 'plate' ? resolvePlateImage(row) : resolveVehicleImage(row);
    if (!src) return;
    onOpenImage?.({
      src,
      label: kind === 'plate' ? 'Plate cutout' : 'Vehicle image',
      phase: 'entry',
      capturedAt: row?.timestamp || row?.readTimestamp || '',
      allowDelete: false,
    });
  }

  return (
    <div className="wf-root">
      <div className="wf-toolbar-row">
        <span className="wf-title-sm">Camera data gallery</span>
        <input className="wf-search-sm" type="text" value={vrmFilter} onChange={(e) => setVrmFilter(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="Filter VRM" maxLength={10} />
        <button type="button" className="wf-refresh-sm" onClick={fetchRows} disabled={loading} title="Refresh">{loading ? '…' : '↻'}</button>
      </div>

      <div className="wf-view-tabs" role="tablist" aria-label="Synced capture view mode">
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'table'}
          className={`wf-view-tab ${viewMode === 'table' ? 'wf-view-tab--active' : ''}`}
          onClick={() => setViewMode('table')}
        >
          LIST
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'card'}
          className={`wf-view-tab ${viewMode === 'card' ? 'wf-view-tab--active' : ''}`}
          onClick={() => setViewMode('card')}
        >
          CARD
        </button>
      </div>

      {error ? <div className="wf-error-inline">{error}</div> : null}

      {!selectedSiteId ? (
        <p className="wf-hint">Select a site.</p>
      ) : filtered.length === 0 && !loading ? (
        <p className="wf-hint">No synced captures.</p>
      ) : viewMode === 'card' ? (
        <div className="wf-cards">
          {filtered.map((row) => {
            const cc = {
              ...(row.isLocalCapture ? {
                permitStatus: row.permitStatus || '',
                permitData: row.permitData || null,
              } : {}),
              ...(checks[row.id] || {}),
            };
            const draftCode = draftByVrm[row.vrm] || null;
            const hasPcn = draftCode === 'CONVERTED' || draftCode === 'SUBMITTED';
            return (
              <article key={row.id} className={`wf-card ${cc.permitStatus === 'has_permit' ? 'wf-card--permitted' : cc.permitStatus === 'no_permit' ? 'wf-card--actionable' : ''}`}>
                <div className="wf-card-media">
                  <div className="wf-card-media-grid">
                    {resolveVehicleImage(row) ? (
                      <button type="button" className="wf-thumb-btn" onClick={() => openRowImage(row, 'vehicle')} title="Open vehicle image">
                        <img src={resolveVehicleImage(row)} alt={`${row.vrm || 'Capture'} vehicle`} className="wf-thumb wf-thumb--card" loading="lazy" />
                      </button>
                    ) : <div className="wf-thumb wf-thumb--card wf-thumb-placeholder">–</div>}
                    {resolvePlateImage(row) ? (
                      <button type="button" className="wf-thumb-btn" onClick={() => openRowImage(row, 'plate')} title="Open plate image">
                        <img src={resolvePlateImage(row)} alt={`${row.vrm || 'Capture'} plate`} className="wf-thumb wf-thumb--card" loading="lazy" />
                      </button>
                    ) : <div className="wf-thumb wf-thumb--card wf-thumb-placeholder">No plate</div>}
                  </div>
                </div>
                <div className="wf-card-body">
                  <div className="wf-card-head">
                    <span className="wf-plate">{row.vrm || '–'}</span>
                    <DirectionBadge direction={row.direction} />
                  </div>
                  <div className="wf-card-meta">
                    <span>{fmt(row.timestamp)}</span>
                    {row.siteName ? <span> · {row.siteName}</span> : null}
                    {Number(row.confidence || 0) > 0 ? <span> · {Number(row.confidence)}%</span> : null}
                  </div>
                  <div className="wf-card-badges">
                    <PermitBadge s={cc.permitStatus} />
                    <CarcheckBadge s={cc.carcheckStatus} d={cc.carcheckDetails} />
                  </div>
                  {row.isLocalCapture ? (
                    <div className="wf-card-meta" style={{ marginTop: 6 }}>
                      <span>
                        Sync: {row.syncStatus || 'queued'}
                        {row.syncStatus === 'syncing' ? ` (${Math.max(0, Math.min(100, Math.round(Number(row.syncProgress || 0))))}%)` : ''}
                      </span>
                      {row.syncError ? <span> · {row.syncError}</span> : null}
                    </div>
                  ) : null}
                  <div className="wf-action-row">
                    <button
                      type="button"
                      className="wf-btn wf-btn--check"
                      disabled={cc.carcheckStatus === 'checking' || !row.vrm}
                      onClick={() => runCarcheck(row.id, row.vrm)}
                      title={!row.vrm ? 'VRM required' : 'Run carcheck lookup'}
                    >
                      {cc.carcheckStatus === 'checking' ? 'Checking carcheck...' : 'Carcheck'}
                    </button>
                    <button
                      type="button"
                      className="wf-btn wf-btn--check"
                      disabled={cc.permitStatus === 'checking' || !selectedSiteId || !row.vrm}
                      onClick={() => runPermitCheck(row.id, row.vrm)}
                      title={!selectedSiteId ? 'Select a site first' : (!row.vrm ? 'VRM required' : 'Run e-permit check')}
                    >
                      {cc.permitStatus === 'checking' ? 'Checking e-permit...' : 'e-Permit'}
                    </button>
                    {showPcnActions && !hasPcn && (
                      <button type="button" className={`wf-btn ${cc.permitStatus === 'has_permit' ? 'wf-btn--draft-muted' : 'wf-btn--draft-active'}`}
                        onClick={() => onStartDraft?.({
                          vrm: row.vrm,
                          vehicleImage: resolveVehicleImage(row),
                          plateImage: resolvePlateImage(row),
                          timestamp: row.timestamp,
                          siteId: selectedSiteId,
                          carcheckDetails: cc.carcheckDetails,
                          permitData: cc.permitData,
                        })}>
                        + Draft PCN
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="wf-table-wrap">
          <table className="wf-table">
            <thead>
              <tr>
                <th className="wf-th wf-th-img">Vehicle</th>
                <th className="wf-th wf-th-img">Plate</th>
                <th className="wf-th wf-th-vrm">VRM</th>
                <th className="wf-th wf-th-site">Site</th>
                <th className="wf-th wf-th-time">Time</th>
                <th className="wf-th wf-th-conf">Conf</th>
                <th className="wf-th wf-th-permit">Permit</th>
                <th className="wf-th wf-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const cc = {
                  ...(row.isLocalCapture ? {
                    permitStatus: row.permitStatus || '',
                    permitData: row.permitData || null,
                  } : {}),
                  ...(checks[row.id] || {}),
                };
                const draftCode = draftByVrm[row.vrm] || null;
                const hasPcn = draftCode === 'CONVERTED' || draftCode === 'SUBMITTED';
                return (
                  <tr key={row.id} className={`wf-tr ${cc.permitStatus === 'has_permit' ? 'wf-tr--permitted' : cc.permitStatus === 'no_permit' ? 'wf-tr--actionable' : ''}`}>
                    <td className="wf-td wf-td-img">
                      {resolveVehicleImage(row) ? (
                        <button type="button" className="wf-thumb-btn" onClick={() => openRowImage(row, 'vehicle')} title="Open vehicle image">
                          <img src={resolveVehicleImage(row)} alt={`${row.vrm} vehicle`} className="wf-thumb" loading="lazy" />
                        </button>
                      ) : <div className="wf-thumb-placeholder">–</div>}
                    </td>
                    <td className="wf-td wf-td-img">
                      {resolvePlateImage(row) ? (
                        <button type="button" className="wf-thumb-btn" onClick={() => openRowImage(row, 'plate')} title="Open plate image">
                          <img src={resolvePlateImage(row)} alt={`${row.vrm} plate`} className="wf-thumb" loading="lazy" />
                        </button>
                      ) : <div className="wf-thumb-placeholder">No plate</div>}
                    </td>
                    <td className="wf-td wf-td-vrm"><span className="wf-plate">{row.vrm || '–'}</span></td>
                    <td className="wf-td wf-td-site">{row.siteName || '—'}</td>
                    <td className="wf-td wf-td-ts">{fmt(row.timestamp)}</td>
                    <td className="wf-td wf-td-conf">{confidenceLabel(row.confidence)}</td>
                    <td className="wf-td wf-td-permit"><PermitBadge s={cc.permitStatus} /></td>
                    <td className="wf-td wf-td-actions">
                      <div className="wf-action-row wf-action-row--inline">
                        {row.isLocalCapture ? (
                          <span className="wf-badge wf-badge--grey" title={row.syncError ? row.syncError : 'Local capture sync state'}>
                            Sync: {row.syncStatus || 'queued'}
                            {row.syncStatus === 'syncing' ? ` ${Math.max(0, Math.min(100, Math.round(Number(row.syncProgress || 0))))}%` : ''}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="wf-btn wf-btn--check"
                          disabled={cc.carcheckStatus === 'checking' || !row.vrm}
                          onClick={() => runCarcheck(row.id, row.vrm)}
                          title={!row.vrm ? 'VRM required' : 'Run carcheck lookup'}
                        >
                          {cc.carcheckStatus === 'checking' ? 'Checking...' : 'Car'}
                        </button>
                        <button
                          type="button"
                          className="wf-btn wf-btn--check"
                          disabled={cc.permitStatus === 'checking' || !selectedSiteId || !row.vrm}
                          onClick={() => runPermitCheck(row.id, row.vrm)}
                          title={!selectedSiteId ? 'Select a site first' : (!row.vrm ? 'VRM required' : 'Run e-permit check')}
                        >
                          {cc.permitStatus === 'checking' ? 'Checking...' : 'Permit'}
                        </button>
                        {showPcnActions && !hasPcn && (
                          <button type="button" className={`wf-btn ${cc.permitStatus === 'has_permit' ? 'wf-btn--draft-muted' : 'wf-btn--draft-active'}`}
                            onClick={() => onStartDraft?.({
                              vrm: row.vrm,
                              vehicleImage: resolveVehicleImage(row),
                              plateImage: resolvePlateImage(row),
                              timestamp: row.timestamp,
                              siteId: selectedSiteId,
                              carcheckDetails: cc.carcheckDetails,
                              permitData: cc.permitData,
                            })}>
                            + PCN
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
