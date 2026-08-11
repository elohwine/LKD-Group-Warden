import { getLocalDateTimeParts } from '../lib/ukTimestamp';

export default function PcnPreviewDialog({ open = false, data = {}, onConfirm, onCancel, loading = false }) {
  if (!open) return null;

  const {
    vrm = '',
    siteName = '',
    contraventionReason = '',
    observationStartTime = '',
    observationEndTime = '',
    observationStartLabel = '',
    observationEndLabel = '',
    actualMinutes = 0,
    mainEntryImagePreview = '',
    mainClosingImagePreview = '',
    location = null,
    manualNote = '',
    wardenId = '',
    permitStatus = '',
    permitWarning = '',
  } = data;

  const splitLabel = (label, fallbackValue) => {
    const text = String(label || '').trim();
    const match = text.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    if (match) {
      return { date: match[1], time: match[2] };
    }
    const parts = getLocalDateTimeParts(fallbackValue);
    return { date: parts.date || '-', time: parts.secondsTime || '' };
  };

  const entryDisplay = splitLabel(observationStartLabel, observationStartTime);
  const exitDisplay = splitLabel(observationEndLabel, observationEndTime);
  const entryTime = entryDisplay.time || '';
  const exitTime = exitDisplay.time || '';
  const entryDate = entryDisplay.date || '-';
  const exitDate = exitDisplay.date || '-';
  const locationText = location
    ? `${location.latitude?.toFixed(5)}, ${location.longitude?.toFixed(5)}${location.accuracy ? ` (±${Math.round(location.accuracy)}m)` : ''}`
    : '-';

  return (
    <div
      className="carcheck-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Review draft parking charge"
      onClick={onCancel}
    >
      <div className="carcheck-sheet pcn-preview-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="carcheck-sheet-header">
          <div>
            <div className="carcheck-sheet-kicker">PCN preview</div>
            <div className="carcheck-sheet-title">Review before final submit</div>
          </div>
          <button type="button" className="ghost-button stepper-close" onClick={onCancel} disabled={loading}>
            X
          </button>
        </div>

        <div className="carcheck-sheet-body pcn-preview-body">
          <div className="pcn-summary pcn-preview-summary">
            <div className="pcn-preview-vrm-banner">
              <span className="pcn-summary-key">VRM</span>
              <span className="pcn-preview-vrm-text">{vrm || '-'}</span>
            </div>

            <div className="pcn-summary-grid pcn-preview-grid-main">
              <div className="pcn-summary-row">
                <span className="pcn-summary-key">Site</span>
                <span className="pcn-summary-value">{siteName || '-'}</span>
              </div>
              <div className="pcn-summary-row">
                <span className="pcn-summary-key">Contravention</span>
                <span className="pcn-summary-value">{contraventionReason || '-'}</span>
              </div>
              <div className="pcn-summary-row">
                <span className="pcn-summary-key">Entry</span>
                <span className="pcn-summary-value">{entryDate}</span>
                <span className="pcn-summary-image-time">{entryTime || '-'}</span>
              </div>
              <div className="pcn-summary-row">
                <span className="pcn-summary-key">Exit</span>
                <span className="pcn-summary-value">{exitDate}</span>
                <span className="pcn-summary-image-time">{exitTime || '-'}</span>
              </div>
              <div className="pcn-summary-row">
                <span className="pcn-summary-key">Duration</span>
                <span className="pcn-summary-value">{actualMinutes} min</span>
              </div>
              <div className="pcn-summary-row">
                <span className="pcn-summary-key">Warden ID</span>
                <span className="pcn-summary-value">{wardenId || '-'}</span>
              </div>
              <div className="pcn-summary-row pcn-preview-span-2">
                <span className="pcn-summary-key">E-permit</span>
                <span className="pcn-summary-value">{permitStatus || '-'}</span>
              </div>
              <div className="pcn-summary-row pcn-preview-span-2">
                <span className="pcn-summary-key">Location</span>
                <span className="pcn-summary-value">{locationText}</span>
              </div>
              {permitWarning ? (
                <div className="pcn-summary-row pcn-preview-span-2">
                  <span className="pcn-summary-key">Submission note</span>
                  <span className="pcn-summary-value pcn-preview-notes">{permitWarning}</span>
                </div>
              ) : null}
              {manualNote ? (
                <div className="pcn-summary-row pcn-preview-span-2">
                  <span className="pcn-summary-key">Notes</span>
                  <span className="pcn-summary-value pcn-preview-notes">{manualNote}</span>
                </div>
              ) : null}
            </div>

            <div className="pcn-summary-images pcn-summary-images--timeline pcn-preview-images-row">
              <div className="pcn-summary-image-card">
                <div className="pcn-summary-image-label">Entry evidence</div>
                <div className="pcn-summary-image-frame">
                  {mainEntryImagePreview ? (
                    <img src={mainEntryImagePreview} alt="Entry evidence" className="pcn-summary-image pcn-preview-image" />
                  ) : (
                    <div className="pcn-summary-image-empty">No entry image</div>
                  )}
                </div>
              </div>
              <div className="pcn-summary-image-card">
                <div className="pcn-summary-image-label">Exit evidence</div>
                <div className="pcn-summary-image-frame">
                  {mainClosingImagePreview ? (
                    <img src={mainClosingImagePreview} alt="Exit evidence" className="pcn-summary-image pcn-preview-image" />
                  ) : (
                    <div className="pcn-summary-image-empty">No exit image</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="vehicle-result-actions pcn-dialog-actions pcn-preview-actions">
            <button type="button" className="action-btn action-btn--secondary pcn-dialog-btn" onClick={onCancel} disabled={loading}>
              Back
            </button>
            <button type="button" className="action-btn action-btn--primary pcn-dialog-btn" onClick={onConfirm} disabled={loading}>
              {loading ? 'Finalizing...' : 'Confirm and send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
