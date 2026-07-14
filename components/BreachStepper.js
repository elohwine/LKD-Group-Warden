import { useRef, useState, useMemo, useEffect } from 'react';

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('preview_read_failed'));
        reader.readAsDataURL(file);
    });
}

/**
 * BreachStepper — 3-step creation wizard for new breach sessions.
 *
 * Step 0: VRM + Contravention
 * Step 1: Entry evidence capture
 * Step 2: Confirm & start tracking
 */
export default function BreachStepper({
    open,
    onClose,
    onComplete,
    sites = [],
    contraventions = [],
    selectedSiteId: defaultSiteId = '',
}) {
    const [step, setStep] = useState(0);
    const [vrm, setVrm] = useState('');
    const [contraventionCode, setContraventionCode] = useState(contraventions[0]?.code || '');
    const [contraventionTouched, setContraventionTouched] = useState(false);
    const [files, setFiles] = useState([]);
    const [previews, setPreviews] = useState([]);
    const [note, setNote] = useState('');
    const fileInputRef = useRef(null);

    const normalizeVrm = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    const selectedContravention = useMemo(
        () => contraventions.find((c) => c.code === contraventionCode) || contraventions[0] || {},
        [contraventions, contraventionCode]
    );

    const selectedSite = useMemo(
        () => sites.find((s) => String(s.id) === String(defaultSiteId)) || null,
        [sites, defaultSiteId]
    );

    const siteConsiderationMinutes = useMemo(
        () => Number(selectedSite?.anprRules?.considerationMinutes ?? selectedSite?.considerationMinutes ?? 0),
        [selectedSite]
    );

    const defaultContraventionCode = useMemo(() => {
        if (!contraventions.length) return '';
        if (siteConsiderationMinutes > 0) {
            const timedRule = contraventions.find((item) => {
                const mins = Number(item?.defaultObservationMinutes ?? 0);
                if (mins !== siteConsiderationMinutes) return false;
                const text = `${item?.code || ''} ${item?.label || ''}`.toLowerCase();
                return /consideration|make_payment_within|register_vehicle_within|payment/i.test(text);
            });
            if (timedRule?.code) return timedRule.code;

            const minuteMatch = contraventions.find(
                (item) => Number(item?.defaultObservationMinutes ?? 0) === siteConsiderationMinutes
            );
            if (minuteMatch?.code) return minuteMatch.code;
        }
        return contraventions[0]?.code || '';
    }, [contraventions, siteConsiderationMinutes]);

    useEffect(() => {
        if (!contraventions.length) {
            setContraventionCode('');
            setContraventionTouched(false);
            return;
        }

        if (!contraventionTouched && defaultContraventionCode) {
            setContraventionCode(defaultContraventionCode);
            return;
        }

        const exists = contraventions.some((c) => c.code === contraventionCode);
        if (!exists) {
            setContraventionCode(defaultContraventionCode || contraventions[0]?.code || '');
            setContraventionTouched(false);
        }
    }, [contraventions, contraventionCode, contraventionTouched, defaultContraventionCode]);

    const observationMinutes = Number(selectedContravention?.defaultObservationMinutes ?? 0);

    function reset() {
        setStep(0);
        setVrm('');
        setContraventionCode(defaultContraventionCode || contraventions[0]?.code || '');
        setContraventionTouched(false);
        setFiles([]);
        setPreviews([]);
        setNote('');
    }

    function handleClose() {
        reset();
        onClose?.();
    }

    async function handleFileCapture(event) {
        const captured = Array.from(event.target.files || []);
        event.target.value = '';
        if (!captured.length) return;
        const resolved = await Promise.all(
            captured.map(async (file) => {
                try {
                    return await fileToDataUrl(file);
                } catch (_) {
                    return '';
                }
            })
        );
        const newPreviews = resolved.filter(Boolean);
        setFiles((prev) => [...prev, ...captured]);
        setPreviews((prev) => [...prev, ...newPreviews]);
        // Auto-advance to confirm step
        if (step === 1) {
            setTimeout(() => setStep(2), 200);
        }
    }

    function handleConfirm() {
        if (!vrm || !defaultSiteId || files.length === 0) return;
        onComplete?.({
            vrm: normalizeVrm(vrm),
            siteId: defaultSiteId,
            siteName: selectedSite?.displayName || selectedSite?.name || selectedSite?.location || defaultSiteId,
            contraventionCode,
            contraventionLabel: selectedContravention?.label || '',
            observationMinutes,
            files,
            note,
        });
        reset();
    }

    function openCamera() {
        fileInputRef.current?.click();
    }

    // Step validations
    const canAdvanceFromVrm = Boolean(normalizeVrm(vrm) && defaultSiteId);
    const canConfirm = Boolean(normalizeVrm(vrm) && defaultSiteId && files.length > 0);

    if (!open) return null;

    return (
        <div className="stepper-overlay" onClick={handleClose}>
            <div className="stepper-panel" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="stepper-header">
                    <button type="button" className="ghost-button stepper-close" onClick={handleClose}>✕</button>
                    <h3 className="stepper-title">New breach session</h3>
                    <div className="stepper-dots">
                        {[0, 1, 2].map((i) => (
                            <span
                                key={i}
                                className={`stepper-dot ${step === i ? 'stepper-dot-active' : ''} ${step > i ? 'stepper-dot-done' : ''}`}
                            />
                        ))}
                    </div>
                </div>

                {/* Hidden file input */}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    onChange={handleFileCapture}
                    className="file-input"
                />

                {/* Step 0: VRM + Contravention */}
                {step === 0 ? (
                    <div className="stepper-step">
                        <p className="stepper-step-label">Step 1 — Vehicle identification</p>
                        <label className="stepper-field">
                            <span className="stepper-field-label">VRM (registration)</span>
                            <input
                                className="stepper-vrm-input"
                                value={vrm}
                                onChange={(e) => setVrm(normalizeVrm(e.target.value))}
                                placeholder="AB12CDE"
                                autoFocus
                            />
                        </label>
                        <div className="stepper-fixed-site">
                            <span className="stepper-fixed-site-label">Patrol site</span>
                            <strong className="stepper-fixed-site-value">
                                {selectedSite?.displayName || selectedSite?.name || selectedSite?.location || defaultSiteId || 'No site selected'}
                            </strong>
                        </div>
                        <label className="stepper-field">
                            <span className="stepper-field-label">Contravention</span>
                            <select className="stepper-select" value={contraventionCode} onChange={(e) => { setContraventionCode(e.target.value); setContraventionTouched(true); }}>
                                {contraventions.map((c, index) => (
                                    <option key={c.code || `contravention-${index + 1}`} value={c.code || ''}>{c.code || `C${index + 1}`} – {c.label || 'Contravention'}</option>
                                ))}
                            </select>
                        </label>
                        <label className="stepper-field">
                            <span className="stepper-field-label">Notes (optional)</span>
                            <textarea
                                className="stepper-note-input"
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                                rows={2}
                                placeholder="Bay position, signage, etc."
                            />
                        </label>
                        <div className="stepper-nav">
                            <button type="button" className="ghost-button" onClick={handleClose}>Cancel</button>
                            <button
                                type="button"
                                className="primary-button"
                                disabled={!canAdvanceFromVrm}
                                onClick={() => setStep(1)}
                            >
                                Next — Capture evidence →
                            </button>
                        </div>
                    </div>
                ) : null}

                {/* Step 1: Entry evidence */}
                {step === 1 ? (
                    <div className="stepper-step">
                        <p className="stepper-step-label">Step 2 — Entry evidence</p>
                        <div className="stepper-vrm-banner">
                            <span className="stepper-vrm-text">{normalizeVrm(vrm)}</span>
                            <span className="text-muted">{selectedSite?.displayName || selectedSite?.name || defaultSiteId}</span>
                        </div>

                        {previews.length > 0 ? (
                            <div className="stepper-preview-grid">
                                {previews.map((p, i) => (
                                    <img key={i} src={p} alt={`Entry evidence ${i + 1}`} className="stepper-preview-img" />
                                ))}
                            </div>
                        ) : (
                            <div className="stepper-capture-prompt" onClick={openCamera}>
                                <span className="stepper-capture-icon">📸</span>
                                <p>Tap to capture entry evidence</p>
                                <p className="text-muted">Photo of the vehicle at first sighting</p>
                            </div>
                        )}

                        <div className="stepper-nav">
                            <button type="button" className="ghost-button" onClick={() => setStep(0)}>← Back</button>
                            <div className="stepper-nav-actions">
                                <button type="button" className="secondary-button" onClick={openCamera}>
                                    {files.length > 0 ? 'Add more' : 'Open camera'}
                                </button>
                                {files.length > 0 ? (
                                    <button type="button" className="primary-button" onClick={() => setStep(2)}>
                                        Next — Confirm →
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Step 2: Confirm */}
                {step === 2 ? (
                    <div className="stepper-step">
                        <p className="stepper-step-label">Step 3 — Confirm & start tracking</p>

                        <div className="stepper-summary-card">
                            <div className="stepper-summary-row">
                                <span className="stepper-summary-label">VRM</span>
                                <span className="stepper-summary-val" style={{ fontFamily: 'monospace', fontWeight: 800 }}>{normalizeVrm(vrm)}</span>
                            </div>
                            <div className="stepper-summary-row">
                                <span className="stepper-summary-label">Site</span>
                                <span className="stepper-summary-val">{selectedSite?.displayName || selectedSite?.name || defaultSiteId}</span>
                            </div>
                            <div className="stepper-summary-row">
                                <span className="stepper-summary-label">Contravention</span>
                                <span className="stepper-summary-val">{selectedContravention?.code || 'N/A'} – {selectedContravention?.label || 'Contravention'}</span>
                            </div>
                            <div className="stepper-summary-row">
                                <span className="stepper-summary-label">Observation</span>
                                <span className="stepper-summary-val">{observationMinutes > 0 ? 'Monitored observation (count up)' : 'No observation required'}</span>
                            </div>
                            <div className="stepper-summary-row">
                                <span className="stepper-summary-label">Entry evidence</span>
                                <span className="stepper-summary-val">{files.length} image{files.length !== 1 ? 's' : ''}</span>
                            </div>
                            {previews.length > 0 ? (
                                <div className="stepper-preview-grid" style={{ marginTop: 8 }}>
                                    {previews.slice(0, 3).map((p, i) => (
                                        <img key={i} src={p} alt={`Preview ${i + 1}`} className="stepper-preview-img" style={{ maxHeight: 100 }} />
                                    ))}
                                </div>
                            ) : null}
                        </div>

                        {note ? (
                            <div className="text-muted" style={{ marginTop: 6 }}>
                                <strong>Notes:</strong> {note}
                            </div>
                        ) : null}

                        <div className="stepper-nav">
                            <button type="button" className="ghost-button" onClick={() => setStep(1)}>← Back</button>
                            <button
                                type="button"
                                className="primary-button stepper-confirm-btn"
                                disabled={!canConfirm}
                                onClick={handleConfirm}
                            >
                                {observationMinutes > 0 ? 'Start tracking session' : 'Create breach'}
                            </button>
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
