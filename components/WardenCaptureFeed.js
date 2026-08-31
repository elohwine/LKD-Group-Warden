import { useCallback, useEffect, useRef, useState } from 'react';
import { formatLocalTimestamp } from '../lib/ukTimestamp';
import { fetchCameraServiceJson, fetchJson } from '../lib/api';

function nv(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function fmt(v) { try { return formatLocalTimestamp(v); } catch (_) { return '–'; } }

function DirectionBadge({ direction }) {
  const d = String(direction || '').toLowerCase();
  if (d === 'entry' || d === 'in' || d === 'forward') return <span className="wf-dir wf-dir--entry">↑ In</span>;
  if (d === 'exit' || d === 'out' || d === 'reverse') return <span className="wf-dir wf-dir--exit">↓ Out</span>;
  return null;
}
function PermitBadge({ s }) {
  if (!s) return <span className="wf-badge wf-badge--grey">–</span>;
  if (s === 'checking') return <span className="wf-badge wf-badge--grey">…</span>;
  if (s === 'has_permit') return <span className="wf-badge wf-badge--amber">⚠ Permit</span>;
  if (s === 'no_permit') return <span className="wf-badge wf-badge--green">✓ Clear</span>;
  if (s === 'error') return <span className="wf-badge wf-badge--grey">!</span>;
  return null;
}
function CarcheckBadge({ s, d }) {
  if (!s) return null;
  if (s === 'checking') return <span className="wf-badge wf-badge--grey">…</span>;
  if (s === 'ok' && d) return <span className="wf-badge wf-badge--blue" title={[d.make, d.model, d.color].filter(Boolean).join(' ')}>{[d.make, d.color].filter(Boolean).join(' ') || 'OK'}</span>;
  if (s === 'not_found') return <span className="wf-badge wf-badge--grey">Unknown</span>;
  return null;
}

export default function WardenCaptureFeed({ getToken, selectedSiteId = '', sites = [], queueItems = [], contraventions = [], onStartDraft }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [vrmFilter, setVrmFilter] = useState('');
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
        id: alarm.id || `alarm-${idx}`,
        vrm: nv(alarm.vrm || ''),
        direction: alarm.direction || null,
        timestamp: alarm.timestamp || null,
        imgUrl: alarm.images?.vehicle || alarm.images?.plate || alarm.images?.all?.[0] || null,
        plateUrl: alarm.images?.plate || null,
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

  // Stable dep (joined IDs) prevents infinite re-check loop when rows reference changes.
  const rowIdKey = rows.map((r) => r.id).join(',');
  useEffect(() => {
    if (!rowIdKey) return;
    for (const row of rows) {
      if (!row.vrm) continue;
      const ex = checks[row.id] || {};
      if (!ex.permitStatus && !checkingRef.current.has(`p-${row.id}`) && selectedSiteId) runPermitCheck(row.id, row.vrm);
      if (!ex.carcheckStatus && !checkingRef.current.has(`c-${row.id}`)) runCarcheck(row.id, row.vrm);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIdKey, selectedSiteId]);

  async function runPermitCheck(id, vrm) {
    if (checkingRef.current.has(`p-${id}`)) return;
    checkingRef.current.add(`p-${id}`);
    setChecks((c) => ({ ...c, [id]: { ...c[id], permitStatus: 'checking' } }));
    try {
      const token = await getTokenRef.current();
      const result = await fetchJson(`/api/parking/check-authorization?vrm=${encodeURIComponent(vrm)}&siteId=${encodeURIComponent(selectedSiteId)}&breachTime=${encodeURIComponent(new Date().toISOString())}`, { token });
      const has = Boolean(result?.hasAuthorization);
      setChecks((c) => ({ ...c, [id]: { ...c[id], permitStatus: has ? 'has_permit' : 'no_permit', permitData: result } }));
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
      const make = String(result?.make || '').trim();
      const model = String(result?.model || '').trim();
      const color = String(result?.colour || result?.color || '').trim();
      setChecks((c) => ({ ...c, [id]: { ...c[id], carcheckStatus: make || model ? 'ok' : 'not_found', carcheckDetails: { make, model, color } } }));
    } catch (_) {
      setChecks((c) => ({ ...c, [id]: { ...c[id], carcheckStatus: 'error' } }));
    } finally { checkingRef.current.delete(`c-${id}`); }
  }

  const filtered = vrmFilter ? rows.filter((r) => r.vrm.includes(nv(vrmFilter))) : rows;

  return (
    <div className="wf-root">
      <div className="wf-toolbar-row">
        <span className="wf-title-sm">Synced captures</span>
        <input className="wf-search-sm" type="text" value={vrmFilter} onChange={(e) => setVrmFilter(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="Filter VRM" maxLength={10} />
        <button type="button" className="wf-refresh-sm" onClick={fetchRows} disabled={loading} title="Refresh">{loading ? '…' : '↻'}</button>
      </div>

      {error ? <div className="wf-error-inline">{error}</div> : null}

      {!selectedSiteId ? (
        <p className="wf-hint">Select a patrol site above to load synced captures.</p>
      ) : filtered.length === 0 && !loading ? (
        <p className="wf-hint">No synced warden captures yet for this site.</p>
      ) : (
        <div className="wf-table-wrap">
          <table className="wf-table">
            <thead>
              <tr>
                <th className="wf-th wf-th-img">Img</th>
                <th className="wf-th">VRM</th>
                <th className="wf-th">Dir</th>
                <th className="wf-th">Time</th>
                <th className="wf-th">Permit</th>
                <th className="wf-th">Vehicle</th>
                <th className="wf-th">PCN</th>
                <th className="wf-th">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const cc = checks[row.id] || {};
                const draftCode = draftByVrm[row.vrm] || null;
                const hasPcn = draftCode === 'CONVERTED' || draftCode === 'SUBMITTED';
                return (
                  <tr key={row.id} className={`wf-tr ${cc.permitStatus === 'has_permit' ? 'wf-tr--permitted' : cc.permitStatus === 'no_permit' ? 'wf-tr--actionable' : ''}`}>
                    <td className="wf-td wf-td-img">
                      {row.imgUrl ? <img src={row.imgUrl} alt={row.vrm} className="wf-thumb" loading="lazy" /> : <div className="wf-thumb-placeholder">–</div>}
                    </td>
                    <td className="wf-td"><span className="wf-plate">{row.vrm || '–'}</span></td>
                    <td className="wf-td"><DirectionBadge direction={row.direction} /></td>
                    <td className="wf-td wf-td-ts">{fmt(row.timestamp)}</td>
                    <td className="wf-td"><PermitBadge s={cc.permitStatus} /></td>
                    <td className="wf-td"><CarcheckBadge s={cc.carcheckStatus} d={cc.carcheckDetails} /></td>
                    <td className="wf-td">{draftCode && <span className={`wf-badge wf-badge--${hasPcn ? 'submitted' : 'draft-open'}`}>{hasPcn ? 'Issued' : 'Draft'}</span>}</td>
                    <td className="wf-td wf-td-actions">
                      <div className="wf-action-row">
                        <button type="button" className="wf-btn wf-btn--check" disabled={cc.carcheckStatus === 'checking'} onClick={() => runCarcheck(row.id, row.vrm)}>CC</button>
                        <button type="button" className="wf-btn wf-btn--check" disabled={cc.permitStatus === 'checking' || !selectedSiteId} onClick={() => runPermitCheck(row.id, row.vrm)}>eP</button>
                        {!hasPcn && (
                          <button type="button" className={`wf-btn ${cc.permitStatus === 'has_permit' ? 'wf-btn--draft-muted' : 'wf-btn--draft-active'}`}
                            onClick={() => onStartDraft?.({ vrm: row.vrm, vehicleImage: row.imgUrl, plateImage: row.plateUrl, timestamp: row.timestamp, siteId: selectedSiteId, carcheckDetails: cc.carcheckDetails, permitData: cc.permitData })}>
                            +PCN
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
