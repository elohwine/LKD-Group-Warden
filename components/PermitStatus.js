import { PERMIT_STATUS, needsNearMatchDecision, resolvePermitStatus } from '../lib/vrmMatch.mjs';

export function MatchConfidencePill({ matchConfidence }) {
  const score = Number(matchConfidence?.scorePercent || 0);
  const bestVrm = String(matchConfidence?.bestVrm || '').trim();
  const targetVrm = String(matchConfidence?.targetVrm || '').trim();
  if (!(score > 0 && bestVrm)) return null;
  // An exact match adds nothing over the "Permit found" headline.
  if (score >= 100 && bestVrm === targetVrm) return null;

  return (
    <div className="auth-match-pill" role="status" aria-label="Closest match confidence">
      <span className="auth-match-pill-label">Closest match</span>
      <span className="auth-match-pill-vrm">{bestVrm}</span>
      <span className="auth-match-pill-score">{score}%</span>
    </div>
  );
}

/**
 * Plain-language permit status used on every surface (camera tab, session
 * details, draft stepper, gallery lookups) so web and mobile stay aligned.
 */
export function describePermitResult(result) {
  const status = resolvePermitStatus(result);
  const bestVrm = String(result?.matchConfidence?.bestVrm || '').trim();
  const score = Number(result?.matchConfidence?.scorePercent || 0);
  if (status === PERMIT_STATUS.PERMITTED) {
    const type = String(result?.authorization?.type || '').trim();
    return {
      status,
      tone: 'ok',
      icon: 'Yes',
      title: type ? `Permit found - ${type}` : 'Permit found',
      detail: '',
      shortLabel: 'Permit found',
    };
  }
  if (status === PERMIT_STATUS.PENDING) {
    const pending = result?.pendingPermit || {};
    const where = [String(pending.siteName || '').trim(), String(pending.propertyNumber || '').trim()].filter(Boolean).join(', ');
    return {
      status,
      tone: 'pending',
      icon: '!',
      title: 'Permit awaiting approval',
      detail: `This registration has a permit request waiting for approval${where ? ` (${where})` : ''}. It is not approved yet, so you can continue - the ticket may be cancelled later if the permit is approved.`,
      shortLabel: 'Permit pending',
    };
  }
  if (status === PERMIT_STATUS.NEAR_MATCH) {
    return {
      status,
      tone: 'near',
      icon: '?',
      title: `Possible permit match: ${bestVrm} (${score}%)`,
      detail: 'A very similar registration has a permit here. Check the plate photo before continuing.',
      shortLabel: 'Possible permit',
    };
  }
  if (status === PERMIT_STATUS.NO_PERMIT) {
    return {
      status,
      tone: 'none',
      icon: 'No',
      title: 'No permit found',
      detail: bestVrm && score > 0 ? `Closest registration checked: ${bestVrm} (${score}%).` : '',
      shortLabel: 'No permit',
    };
  }
  return { status: '', tone: 'none', icon: '-', title: 'Permit not checked yet', detail: '', shortLabel: 'Not checked' };
}

export function PermitStatusBanner({ result, decision = null, compact = false }) {
  if (!result || typeof result !== 'object') return null;
  const summary = describePermitResult(result);
  const site = String(
    result?.authorization?.site
    || result?.nearMatchAuthorization?.site
    || ''
  ).trim();
  const decisionLabel = (() => {
    if (summary.status !== PERMIT_STATUS.NEAR_MATCH) return '';
    const resolved = decision || result?.permitReviewDecision || null;
    if (!resolved || needsNearMatchDecision(result, resolved)) return 'Needs your review before this can be submitted.';
    return resolved.decision === 'keep'
      ? 'You confirmed the registration is correct.'
      : 'You switched to the matched registration.';
  })();

  return (
    <div className={`auth-result auth-result--${summary.tone}${compact ? ' auth-result--compact' : ''}`} role="status">
      <span className="auth-result-icon">{summary.icon}</span>
      <div className="auth-result-content">
        <div className="auth-result-text">{summary.title}</div>
        {summary.detail ? <div className="auth-result-sub">{summary.detail}</div> : null}
        {summary.status !== PERMIT_STATUS.NEAR_MATCH ? (
          <MatchConfidencePill matchConfidence={result?.matchConfidence} />
        ) : null}
        {site ? <div className="auth-result-sub">{site}</div> : null}
        {decisionLabel ? <div className="auth-result-sub auth-result-sub--decision">{decisionLabel}</div> : null}
      </div>
    </div>
  );
}

/**
 * Bottom sheet shown when the scanned/typed VRM is one misread away from a
 * permitted vehicle. Offers to switch to the matched VRM or keep the current one.
 */
export function NearMatchConfirmSheet({ open, result, plateImage = '', busy = false, onUseMatched, onKeep, onClose }) {
  if (!open || !result) return null;
  const targetVrm = String(result?.matchConfidence?.targetVrm || '').trim();
  const bestVrm = String(result?.matchConfidence?.bestVrm || '').trim();
  const score = Number(result?.matchConfidence?.scorePercent || 0);
  const site = String(result?.nearMatchAuthorization?.site || result?.authorization?.site || '').trim();

  return (
    <div
      className="carcheck-overlay near-match-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Possible permit match"
      onClick={(event) => {
        // Never let the backdrop click bubble to a parent overlay (e.g. the stepper).
        event.stopPropagation();
        if (!busy) onClose?.();
      }}
    >
      <div className="carcheck-sheet near-match-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="carcheck-sheet-header">
          <div>
            <div className="carcheck-sheet-kicker">Check the registration</div>
            <div className="carcheck-sheet-title">Possible permit match</div>
          </div>
          <button type="button" className="ghost-button stepper-close" onClick={onClose} disabled={busy}>
            ✕
          </button>
        </div>

        <div className="carcheck-sheet-body">
          <p className="card-copy near-match-copy">
            <strong>{bestVrm}</strong> has a permit here and is {score}% similar to <strong>{targetVrm}</strong>.
            Look at the plate photo and pick the correct registration.
          </p>

          <div className="near-match-compare">
            <div className="near-match-option">
              <span className="near-match-option-label">You entered</span>
              <span className="near-match-option-vrm">{targetVrm || '—'}</span>
            </div>
            <div className="near-match-option near-match-option--matched">
              <span className="near-match-option-label">Has a permit</span>
              <span className="near-match-option-vrm">{bestVrm || '—'}</span>
              {site ? <span className="near-match-option-site">{site}</span> : null}
            </div>
          </div>

          {plateImage ? (
            <div className="near-match-plate">
              <img src={plateImage} alt="Plate photo" className="near-match-plate-img" />
            </div>
          ) : null}

          <div className="detail-actions near-match-actions">
            <button
              type="button"
              className="action-btn action-btn--issue"
              disabled={busy || !bestVrm}
              onClick={() => onUseMatched?.(bestVrm)}
            >
              {busy ? 'Working...' : `Use ${bestVrm}`}
            </button>
            <button
              type="button"
              className="action-btn action-btn--secondary"
              disabled={busy}
              onClick={() => onKeep?.(targetVrm)}
            >
              Keep {targetVrm || 'mine'} and continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
