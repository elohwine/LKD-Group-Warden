import { useCallback, useEffect, useRef, useState } from 'react';
import { formatLocalTimestamp } from '../lib/ukTimestamp';
import { fetchCameraServiceJson, fetchJson } from '../lib/api';

function nv(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatTs(value) {
  if (!value) return '–';
  try { return formatLocalTimestamp(value); } catch (_) { return String(value).slice(0, 16); }
}

function DirectionBadge({ direction }) {
  const d = String(direction || '').toLowerCase();
  if (d === 'entry' || d === 'in' || d === 'forward') {
    return <span className="wf-dir wf-dir--entry">↑ Entry</span>;
  }
  if (d === 'exit' || d === 'out' || d === 'reverse') {
    return <span className="wf-dir wf-dir--exit">↓ Exit</span>;
  }
  return <span className="wf-dir wf-dir--unknown">– {direction || 'n/a'}</span>;
}

function PermitBadge({ status }) {
  if (!status || status === 'pending') return <span className="wf-badge wf-badge--grey">–</span>;
  if (status === 'checking') return <span className="wf-badge wf-badge--grey">Checking…</span>;
  if (status === 'error') return <span className="wf-badge wf-badge--grey">Error</span>;
  if (status === 'has_permit') return <span className="wf-badge wf-badge--amber">Permitted</span>;
  if (status === 'no_permit') return <span className="wf-badge wf-badge--green">No permit</span>;
  return <span className="wf-badge wf-badge--grey">{status}</span>;
}

function CarcheckBadge({ status, details }) {
  if (!status || status === 'pending') return <span className="wf-badge wf-badge--grey">–</span>;
  if (status === 'checking') return <span className="wf-badge wf-badge--grey">Checking…</span>;
  if (status === 'error') return <span className="wf-badge wf-badge--grey">Error</span>;
  if (status === 'ok' && details) {
    const label = [details.make, details.color].filter(Boolean).join(' ') || 'OK';
    return <span className="wf-badge wf-badge--blue" title={[details.make, details.model, details.color, details.yearOfManufacture].filter(Boolean).join(' ')}>{label}</span>;
  }
  if (status === 'not_found') return <span className="wf-badge wf-badge--grey">Not found</span>;
  return <span className="wf-badge wf-badge--grey">{status}</span>;
}

function DraftBadge({ code }) {
  if (!code) return null;
  const map = {
    DRAFT_OPEN: { label: 'Draft open', cls: 'wf-badge--draft-open' },
    READY: { label: 'Ready to submit', cls: 'wf-badge--ready' },
    SUBMITTED: { label: 'Submitted', cls: 'wf-badge--submitted' },
    CONVERTED: { label: 'PCN issued', cls: 'wf-badge--converted' },
    FAILED: { label: 'Sync failed', cls: 'wf-badge--failed' },
  };
  const entry = map[code] || { label: code, cls: '' };
  return <span className={`wf-badge ${entry.cls}`}>{entry.label}</span>;
}

/**
 * WardenCaptureFeed
 * Shows camera-service alarm records for this site, with per-row carcheck,
 * e-permit, and draft-PCN actions.
 */
export default function WardenCaptureFeed({
  getToken,
  selectedSiteId = '',
  sites = [],
  queueItems = [],
  contraventions = [],
  onStartDraft,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [vrmFilter, setVrmFilter] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  // Per-row check state: { [alarmId]: { permitStatus, permitHasAuth, carcheckStatus, carcheckDetails } }
  const [checks, setChecks] = useState({});
  const checkingRef = useRef(new Set());

  // ── Derive draft lifecycle code per VRM from queueItems ───────────────────
  const draftByVrm = {};
  for (const item of queueItems) {
    const itemVrm = nv(item?.payload?.vrm || item?.vrm || '');
    if (!itemVrm) continue;
    const status = String(item?.status || '').toLowerCase();
    const converted = Boolean(item?.payload?.convertedToPcn) || item?.payload?.breachLifecycle === 'CONVERTED_TO_PCN';
    const archived = Boolean(item?.archived) || status === 'archived';
    if (archived) continue;
    let code = 'DRAFT_OPEN';
    if (converted) code = 'CONVERTED';
    else if (status === 'submitted' || status === 'synced') code = 'SUBMITTED';
    else if (status === 'failed') code = 'FAILED';
    else if (item?.payload?.breachLifecycle === 'READY_FOR_SYNC') code = 'READY';
    // Keep the highest-priority status per VRM
    const priority = ['CONVERTED', 'SUBMITTED', 'READY', 'FAILED', 'DRAFT_OPEN'];
    const existing = draftByVrm[itemVrm];
    if (!existing || priority.indexOf(code) < priority.indexOf(existing)) {
      draftByVrm[itemVrm] = code;
    }
  }

  // ── Fetch camera service alarms ───────────────────────────────────────────
  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const token = await getToken();
      const params = new URLSearchParams({ limit: '50', cameraType: 'Warden App', order: 'desc' });
      if (selectedSiteId) params.set('site', selectedSiteId);
      const data = await fetchCameraServiceJson(`/api/frontend/alarms?${params}`, { token });
      const alarms = Array.isArray(data?.alarms) ? data.alarms : [];
      setRows(alarms.map((alarm, idx) => {
        const imgUrl = alarm.images?.vehicle || alarm.images?.plate || alarm.images?.all?.[0] || null;
        const plateUrl = alarm.images?.plate || null;
        return {
          id: alarm.id || `alarm-${idx}`,
          vrm: nv(alarm.vrm || ''),
          direction: alarm.direction || null,
          site: alarm.site || '',
          cameraName: alarm.cameraName || '',
          timestamp: alarm.timestamp || null,
          imgUrl,
          plateUrl,
        };
      }));
    } catch (err) {
      setError(err?.message || 'Failed to load camera feed');
    } finally {
      setLoading(false);
    }
  }, [getToken, selectedSiteId, refreshTick]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // ── Permit check ─────────────────────────────────────────────────────────
  async function runPermitCheck(alarmId, vrm) {
    if (!vrm || !selectedSiteId) return;
    if (checkingRef.current.has(`permit-${alarmId}`)) return;
    checkingRef.current.add(`permit-${alarmId}`);
    setChecks((c) => ({ ...c, [alarmId]: { ...c[alarmId], permitStatus: 'checking' } }));
    try {
      const token = await getToken();
      const result = await fetchJson(
        `/api/parking/check-authorization?vrm=${encodeURIComponent(vrm)}&siteId=${encodeURIComponent(selectedSiteId)}&breachTime=${encodeURIComponent(new Date().toISOString())}`,
        { token }
      );
      const has = Boolean(result?.hasAuthorization);
      setChecks((c) => ({
        ...c,
        [alarmId]: {
          ...c[alarmId],
          permitStatus: has ? 'has_permit' : 'no_permit',
          permitHasAuth: has,
          permitData: result,
        },
      }));
    } catch (_) {
      setChecks((c) => ({ ...c, [alarmId]: { ...c[alarmId], permitStatus: 'error' } }));
    } finally {
      checkingRef.current.delete(`permit-${alarmId}`);
    }
  }

  // ── Carcheck ─────────────────────────────────────────────────────────────
  async function runCarcheck(alarmId, vrm) {
    if (!vrm) return;
    if (checkingRef.current.has(`cc-${alarmId}`)) return;
    checkingRef.current.add(`cc-${alarmId}`);
    setChecks((c) => ({ ...c, [alarmId]: { ...c[alarmId], carcheckStatus: 'checking' } }));
    try {
      const token = await getToken();
      const result = await fetchJson(`/api/carcheck?vrm=${encodeURIComponent(vrm)}`, { token });
      const make = String(result?.make || result?.vehicle?.make || result?.data?.make || '').trim();
      const model = String(result?.model || result?.vehicle?.model || result?.data?.model || '').trim();
      const color = String(result?.colour || result?.color || result?.vehicle?.colour || result?.data?.colour || '').trim();
      const year = String(result?.yearOfManufacture || result?.vehicle?.yearOfManufacture || result?.data?.yearOfManufacture || '').trim();
      const found = Boolean(make || model);
      setChecks((c) => ({
        ...c,
        [alarmId]: {
          ...c[alarmId],
          carcheckStatus: found ? 'ok' : 'not_found',
          carcheckDetails: found ? { make, model, color, yearOfManufacture: year } : null,
          carcheckRaw: result,
        },
      }));
    } catch (_) {
      setChecks((c) => ({ ...c, [alarmId]: { ...c[alarmId], carcheckStatus: 'error' } }));
    } finally {
      checkingRef.current.delete(`cc-${alarmId}`);
    }
  }

  // ── Auto-run both checks on new rows (non-blocking) ──────────────────────
  useEffect(() => {
    for (const row of rows) {
      if (!row.vrm) continue;
      const existing = checks[row.id] || {};
      if (!existing.permitStatus && selectedSiteId) {
        runPermitCheck(row.id, row.vrm);
      }
      if (!existing.carcheckStatus) {
        runCarcheck(row.id, row.vrm);
      }
    }
  }, [rows, selectedSiteId]);

  // ── Draft PCN action ─────────────────────────────────────────────────────
  function handleStartDraft(row) {
    if (!onStartDraft) return;
    const rowChecks = checks[row.id] || {};
    onStartDraft({
      vrm: row.vrm,
      vehicleImage: row.imgUrl || '',
      plateImage: row.plateUrl || '',
      timestamp: row.timestamp,
      direction: row.direction,
      siteId: selectedSiteId,
      carcheckDetails: rowChecks.carcheckDetails || null,
      permitData: rowChecks.permitData || null,
    });
  }

  // ── Filter ────────────────────────────────────────────────────────────────
  const filteredRows = rows.filter((row) => {
    if (!vrmFilter) return true;
    return row.vrm.includes(nv(vrmFilter));
  });

  const selectedSiteName = (sites.find((s) => String(s.id) === selectedSiteId))?.name || selectedSiteId || '';

  return (
    <div className="wf-root">
      <div className="wf-toolbar">
        <span className="wf-title">
          Camera feed
          {selectedSiteName ? ` — ${selectedSiteName}` : ''}
        </span>
        <input
          className="wf-search"
          type="text"
          value={vrmFilter}
          onChange={(e) => setVrmFilter(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          placeholder="Filter VRM"
          maxLength={10}
        />
        <button
          type="button"
          className="action-btn action-btn--secondary wf-refresh-btn"
          onClick={() => setRefreshTick((t) => t + 1)}
          disabled={loading}
        >
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {error ? <div className="notice notice-error wf-error">{error}</div> : null}

      {filteredRows.length === 0 && !loading ? (
        <div className="empty-state wf-empty">
          <div className="empty-icon">📡</div>
          <p className="empty-title">No warden captures yet</p>
          <p className="empty-hint">
            Camera-service records from your warden app captures will appear here.
          </p>
        </div>
      ) : (
        <div className="wf-table-wrap">
          <table className="wf-table">
            <thead>
              <tr>
                <th className="wf-th wf-th-img">Image</th>
                <th className="wf-th">VRM</th>
                <th className="wf-th">Direction</th>
                <th className="wf-th">Time</th>
                <th className="wf-th">e-Permit</th>
                <th className="wf-th">Carcheck</th>
                <th className="wf-th">Draft status</th>
                <th className="wf-th wf-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => {
                const rowChecks = checks[row.id] || {};
                const draftCode = draftByVrm[row.vrm] || null;
                const hasPcn = draftCode === 'CONVERTED' || draftCode === 'SUBMITTED';
                return (
                  <tr key={row.id} className={`wf-tr ${rowChecks.permitStatus === 'has_permit' ? 'wf-tr--permitted' : rowChecks.permitStatus === 'no_permit' ? 'wf-tr--actionable' : ''}`}>
                    <td className="wf-td wf-td-img">
                      {row.imgUrl ? (
                        <img
                          src={row.imgUrl}
                          alt={`${row.vrm} capture`}
                          className="wf-thumb"
                          loading="lazy"
                        />
                      ) : (
                        <div className="wf-thumb-placeholder">NO IMG</div>
                      )}
                    </td>
                    <td className="wf-td">
                      <span className="wf-plate">{row.vrm || '–'}</span>
                    </td>
                    <td className="wf-td">
                      <DirectionBadge direction={row.direction} />
                    </td>
                    <td className="wf-td wf-td-ts">
                      {formatTs(row.timestamp)}
                    </td>
                    <td className="wf-td">
                      <PermitBadge status={rowChecks.permitStatus} />
                    </td>
                    <td className="wf-td">
                      <CarcheckBadge status={rowChecks.carcheckStatus} details={rowChecks.carcheckDetails} />
                    </td>
                    <td className="wf-td">
                      <DraftBadge code={draftCode} />
                    </td>
                    <td className="wf-td wf-td-actions">
                      <div className="wf-action-row">
                        <button
                          type="button"
                          className="wf-btn wf-btn--check"
                          onClick={() => runCarcheck(row.id, row.vrm)}
                          disabled={rowChecks.carcheckStatus === 'checking'}
                          title="Run carcheck"
                        >
                          {rowChecks.carcheckStatus === 'checking' ? '…' : 'Carcheck'}
                        </button>
                        <button
                          type="button"
                          className="wf-btn wf-btn--check"
                          onClick={() => runPermitCheck(row.id, row.vrm)}
                          disabled={rowChecks.permitStatus === 'checking' || !selectedSiteId}
                          title={selectedSiteId ? 'Run e-permit check' : 'Select a site first'}
                        >
                          {rowChecks.permitStatus === 'checking' ? '…' : 'e-Permit'}
                        </button>
                        {!hasPcn ? (
                          <button
                            type="button"
                            className={`wf-btn wf-btn--draft ${rowChecks.permitStatus === 'has_permit' ? 'wf-btn--draft-muted' : 'wf-btn--draft-active'}`}
                            onClick={() => handleStartDraft(row)}
                            title={rowChecks.permitStatus === 'has_permit' ? 'Vehicle has a permit — issue PCN only if another rule was breached' : 'Start Draft PCN for this vehicle'}
                          >
                            + Draft PCN
                          </button>
                        ) : (
                          <span className="wf-btn wf-btn--issued">PCN issued</span>
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
