import { useRef, useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { isMlKitReady, scanPlateWithMlKit } from '../lib/mlkitLpr';
import { canUseNativeCameraPreview, captureNativeCameraSample, startNativeCameraPreview, stopNativeCameraPreview } from '../lib/nativeCameraPreview';

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('preview_read_failed'));
        reader.readAsDataURL(file);
    });
}

function normalizeCapturedAt(value) {
    if (!value) return '';
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return '';
        return value.toISOString();
    }
    const asDate = new Date(value);
    if (Number.isNaN(asDate.getTime())) return '';
    return asDate.toISOString();
}

function stripSitePrefix(value) {
    return String(value || '')
        .replace(/^\s*site(?:\s*[A-Z0-9]+)?[\s:_-]*/i, '')
        .replace(/^\s*(?:mnpr|anpr|rule)[\s:_-]*/i, '')
        .trim();
}

function getContraventionSelectionLabel(item) {
    const rawCode = String(item?.code || '').trim();
    const rawLabel = String(item?.label || '').trim();
    const code = stripSitePrefix(rawCode) || rawCode;
    const label = stripSitePrefix(rawLabel) || rawLabel;

    if (label) return label;
    return code || 'Contravention';
}

function formatEvidenceLocalTimestamp(capturedAt) {
    const date = new Date(capturedAt || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const sec = String(date.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`;
}

function formatEvidenceUtcTimestamp(capturedAt) {
    const date = new Date(capturedAt || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function loadImageElement(file) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('image_load_failed'));
        };
        image.src = objectUrl;
    });
}

async function resolveCameraCaptureTimestamp(file, fallbackIso) {
    const fallback = normalizeCapturedAt(fallbackIso) || new Date().toISOString();
    if (!file || typeof window === 'undefined') return fallback;

    try {
        const exifr = await import('exifr');
        const metadata = await exifr.parse(file, {
            pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate'],
        });

        const exifIso =
            normalizeCapturedAt(metadata?.DateTimeOriginal) ||
            normalizeCapturedAt(metadata?.CreateDate) ||
            normalizeCapturedAt(metadata?.ModifyDate);

        return exifIso || fallback;
    } catch (_) {
        return fallback;
    }
}

async function stampEvidenceImage(file, { capturedAt, phase } = {}) {
    if (!file || !(file.type || '').startsWith('image/')) return file;

    try {
        const image = await loadImageElement(file);
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const ctx = canvas.getContext('2d');
        if (!ctx || !canvas.width || !canvas.height) return file;

        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        const phaseLabel = String(phase || 'ENTRY').toUpperCase();
        const localLine = `LOCAL ${formatEvidenceLocalTimestamp(capturedAt)}`;
        const utcLine = `UTC ${formatEvidenceUtcTimestamp(capturedAt).replace(' UTC', '')}`;
        const lines = [`LDK WARDEN ${phaseLabel}`, localLine, utcLine];

        const baseFont = Math.max(18, Math.floor(canvas.width / 56));
        const lineGap = Math.max(4, Math.floor(baseFont * 0.25));
        const paddingX = Math.max(12, Math.floor(baseFont * 0.55));
        const paddingY = Math.max(10, Math.floor(baseFont * 0.45));

        ctx.font = `700 ${baseFont}px Arial, sans-serif`;
        const contentWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
        const boxWidth = Math.ceil(contentWidth + paddingX * 2);
        const boxHeight = Math.ceil((baseFont * lines.length) + (lineGap * (lines.length - 1)) + (paddingY * 2));
        const margin = Math.max(10, Math.floor(canvas.width * 0.02));
        const boxX = margin;
        const boxY = Math.max(margin, canvas.height - boxHeight - margin);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.66)';
        ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'top';
        let textY = boxY + paddingY;
        for (const line of lines) {
            ctx.fillText(line, boxX + paddingX, textY);
            textY += baseFont + lineGap;
        }

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, file.type || 'image/jpeg', 0.92));
        if (!blob) return file;

        const stamped = new File([blob], file.name, {
            type: blob.type || file.type || 'image/jpeg',
            lastModified: file.lastModified || Date.now(),
        });
        stamped.capturedAt = normalizeCapturedAt(capturedAt) || new Date().toISOString();
        return stamped;
    } catch (_) {
        return file;
    }
}

function dataUrlToFile(dataUrl, filename) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    const parts = dataUrl.split(',');
    if (parts.length < 2) return null;
    const mimeMatch = parts[0].match(/data:(.*?);base64/);
    const mime = mimeMatch?.[1] || 'image/jpeg';

    try {
        const binary = atob(parts[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new File([bytes], filename, { type: mime, lastModified: Date.now() });
    } catch (_) {
        return null;
    }
}

function base64JpegToFile(base64, filename) {
    if (!base64 || typeof base64 !== 'string') return null;
    try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new File([bytes], filename, { type: 'image/jpeg', lastModified: Date.now() });
    } catch (_) {
        return null;
    }
}

function computeIou(a, b) {
    if (!a || !b) return 0;
    const left = Math.max(Number(a.x0 || 0), Number(b.x0 || 0));
    const top = Math.max(Number(a.y0 || 0), Number(b.y0 || 0));
    const right = Math.min(Number(a.x1 || 0), Number(b.x1 || 0));
    const bottom = Math.min(Number(a.y1 || 0), Number(b.y1 || 0));
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (intersection <= 0) return 0;

    const areaA = Math.max(0, Number(a.x1 || 0) - Number(a.x0 || 0)) * Math.max(0, Number(a.y1 || 0) - Number(a.y0 || 0));
    const areaB = Math.max(0, Number(b.x1 || 0) - Number(b.x0 || 0)) * Math.max(0, Number(b.y1 || 0) - Number(b.y0 || 0));
    const union = areaA + areaB - intersection;
    if (union <= 0) return 0;
    return intersection / union;
}

// Scan interval and lock thresholds — tuned for quick UX on patrol:
// 350 ms interval × 2 lock frames = 0.7 s minimum lock time.
// Hard fallback capture at ~3.5 s if OCR does not settle.
const LIVE_SCAN_INTERVAL_MS = 350;
const LIVE_REQUIRED_LOCK_FRAMES = 2;
const LIVE_MIN_CONFIDENCE = 52;
const LIVE_IOU_THRESHOLD = 0.46;
const LIVE_MAX_NO_PLATE_FRAMES = 7;
const LIVE_MAX_SCAN_MS = 3500;
const IMAGE_SCAN_TIMEOUT_MS = 12000;

function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((resolve) => {
            window.setTimeout(() => resolve(null), timeoutMs);
        }),
    ]);
}

async function waitForVideoDimensions(video, timeoutMs = 2500) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const width = Number(video?.videoWidth || 0);
        const height = Number(video?.videoHeight || 0);
        if (width > 0 && height > 0) return true;
        await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    return false;
}

// Correct common OCR character confusions ONLY inside the digit sections of
// recognised UK plate formats. Letter sections are never touched, so valid
// plate letters like G, D, O in area/sequence codes are preserved.
//
// Handled UK shapes:
//   Modern  AA##AAA  (7)  e.g. AB12CDE  — fix positions 2-3
//   Prefix  A###AAA  (5-7) e.g. A123BCD — fix the 1-3 digit middle
//   Suffix  AAA###A  (5-7) e.g. ABC123D — fix the 1-3 digit middle
//
// Substitutions applied to digit sections only:
//   O → 0   G → 0   D → 0   I → 1   L → 1
function fixUkPlateOcr(raw) {
    const v = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!v) return v;

    const fixDigits = (s) =>
        s.replace(/O/g, '0').replace(/G/g, '0').replace(/D/g, '0')
         .replace(/I/g, '1').replace(/L/g, '1');

    // UK Modern: AA##AAA
    if (/^[A-Z]{2}[0-9A-Z]{2}[A-Z]{3}$/.test(v)) {
        return v.slice(0, 2) + fixDigits(v.slice(2, 4)) + v.slice(4);
    }
    // UK Prefix: A#AAA – A###AAA
    const pre = v.match(/^([A-Z])([0-9A-Z]{1,3})([A-Z]{3})$/);
    if (pre) return pre[1] + fixDigits(pre[2]) + pre[3];

    // UK Suffix: AAA#A – AAA###A
    const suf = v.match(/^([A-Z]{3})([0-9A-Z]{1,3})([A-Z])$/);
    if (suf) return suf[1] + fixDigits(suf[2]) + suf[3];

    return v;
}

function isLikelyPlateFormat(plate) {
    const value = String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!value || value.length < 5 || value.length > 8) return false;

    const ukCurrent = /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/;
    const ukPrefix = /^[A-Z][0-9]{1,3}[A-Z]{3}$/;
    const ukSuffix = /^[A-Z]{3}[0-9]{1,3}[A-Z]$/;
    const generic = /^[A-Z0-9]{5,8}$/;
    return ukCurrent.test(value) || ukPrefix.test(value) || ukSuffix.test(value) || generic.test(value);
}

/**
 * BreachStepper — 3-step creation wizard for Draft Parking Charges.
 *
 * Step 0: Entry evidence capture
 * Step 1: VRM + Contravention (VRM prefilled from OCR when possible)
 * Step 2: Confirm Parking Charge details
 */
export default function BreachStepper({
    open,
    onClose,
    onComplete,
    onCaptureComplete,
    sites = [],
    contraventions = [],
    selectedSiteId: defaultSiteId = '',
    onPlateScan,
    mode = 'full',
    capturePhase = 'entry',
}) {
    const captureOnly = mode === 'capture-only';
    const evidencePhase = capturePhase === 'closing' ? 'closing' : 'entry';
    const evidenceLabel = evidencePhase === 'closing' ? 'Closing' : 'Entry';
    const [step, setStep] = useState(0);
    const [vrm, setVrm] = useState('');
    const [contraventionCode, setContraventionCode] = useState(contraventions[0]?.code || '');
    const [contraventionTouched, setContraventionTouched] = useState(false);
    const [files, setFiles] = useState([]);
    const [previews, setPreviews] = useState([]);
    const [scanState, setScanState] = useState({ loading: false, text: '', confidence: 0 });
    const [liveEngine, setLiveEngine] = useState('none');
    const [liveCameraActive, setLiveCameraActive] = useState(false);
    const [livePlateBox, setLivePlateBox] = useState(null);
    const [lockFrames, setLockFrames] = useState(0);
    const [note, setNote] = useState('');
    const fileInputRef = useRef(null);
    const liveVideoRef = useRef(null);
    const liveCanvasRef = useRef(null);
    const liveScanTimerRef = useRef(null);
    const liveStreamRef = useRef(null);
    const liveScanBusyRef = useRef(false);
    const liveStableRef = useRef({ plateText: '', bbox: null, frames: 0, confidence: 0, confidenceSum: 0 });
    const liveNoPlateFramesRef = useRef(0);
    const liveScanStartedAtRef = useRef(0);
    const liveLastFrameRef = useRef(null);
    const nativePreviewActiveRef = useRef(false);
    const mlkitReadyRef = useRef(false);

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
        setScanState({ loading: false, text: '', confidence: 0 });
        setLiveEngine('none');
        setLivePlateBox(null);
        setLockFrames(0);
        setNote('');
    }

    function stopLiveCamera() {
        if (liveScanTimerRef.current) {
            window.clearInterval(liveScanTimerRef.current);
            liveScanTimerRef.current = null;
        }

        const stream = liveStreamRef.current;
        if (stream) {
            stream.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch (_) {
                    // Ignore camera track stop failures.
                }
            });
        }

        liveStreamRef.current = null;
        liveScanBusyRef.current = false;
        liveStableRef.current = { plateText: '', bbox: null, frames: 0, confidence: 0, confidenceSum: 0 };
        liveNoPlateFramesRef.current = 0;
        liveScanStartedAtRef.current = 0;
        liveLastFrameRef.current = null;
        if (nativePreviewActiveRef.current) {
            stopNativeCameraPreview();
            nativePreviewActiveRef.current = false;
        }
        setLiveEngine('none');
        setLiveCameraActive(false);
        setLivePlateBox(null);
        setLockFrames(0);
    }

    useEffect(() => {
        let mounted = true;
        isMlKitReady().then((ready) => {
            if (mounted) mlkitReadyRef.current = Boolean(ready);
        });

        return () => {
            mounted = false;
            stopLiveCamera();
        };
    }, []);

    useEffect(() => {
        if (step !== 0 && liveCameraActive) {
            stopLiveCamera();
        }
    }, [step, liveCameraActive]);

    useEffect(() => {
        if (!liveCameraActive || liveEngine !== 'native-preview' || typeof document === 'undefined') return undefined;

        // Inject a stylesheet that forces every element inside #__next (the Next.js
        // root — which contains the dashboard with its own opaque dark backgrounds)
        // to be transparent. This is necessary because the CameraPreview plugin renders
        // the camera BEHIND the WebView (toBack:true) and any opaque HTML element
        // will block it. Using !important here because globals.css / component CSS can
        // set background via class selectors with normal specificity.
        // The camera overlay itself is rendered via createPortal DIRECTLY on document.body,
        // outside #__next, so these rules do not affect its controls.
        const STYLE_ID = 'native-camera-bg-override';
        let styleEl = document.getElementById(STYLE_ID);
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = STYLE_ID;
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = [
            // Clear backgrounds at the root level so the camera behind the WebView
            // (toBack:true) can show through.
            'html, body, #__next { background: transparent !important; background-color: transparent !important; }',
            // FULLY hide all content inside #__next (the Next.js root that contains
            // the dashboard page). background:transparent alone keeps text/icons visible;
            // opacity:0 makes every element invisible without removing it from the DOM.
            // pointer-events:none prevents stale tap targets from the hidden content.
            // The camera overlay is mounted via createPortal on document.body (outside
            // #__next) so these rules have no effect on the controls bar or plate bbox.
            '#__next > * { opacity: 0 !important; pointer-events: none !important; }',
        ].join('\n');

        return () => {
            const el = document.getElementById(STYLE_ID);
            if (el) el.textContent = '';
        };
    }, [liveCameraActive, liveEngine]);

    function handleClose() {
        stopLiveCamera();
        reset();
        onClose?.();
    }

    async function appendCapturedFiles(captured, initialScanResult = null, options = {}) {
        if (!captured.length) return;
        const allowWebFallback = Boolean(options.allowWebFallback);

        const fallbackCapturedAt = new Date().toISOString();
        const stampedCaptured = await Promise.all(
            captured.map(async (file) => {
                const capturedAt = await resolveCameraCaptureTimestamp(file, fallbackCapturedAt);
                const stamped = await stampEvidenceImage(file, { capturedAt, phase: evidencePhase });
                stamped.capturedAt = normalizeCapturedAt(capturedAt) || fallbackCapturedAt;
                return stamped;
            })
        );

        const resolved = await Promise.all(
            stampedCaptured.map(async (file) => {
                try {
                    return await fileToDataUrl(file);
                } catch (_) {
                    return '';
                }
            })
        );
        const newPreviews = resolved.filter(Boolean);
        const nextFiles = [...stampedCaptured];
        const nextPreviews = [...newPreviews];

        let result = initialScanResult;
        if (!result && captured[0]) {
            try {
                setScanState((prev) => ({ ...prev, loading: true }));
                if (mlkitReadyRef.current) {
                    result = await withTimeout(scanPlateWithMlKit(captured[0]), IMAGE_SCAN_TIMEOUT_MS);
                }
                if (!result && allowWebFallback && typeof onPlateScan === 'function') {
                    result = await withTimeout(onPlateScan(captured[0]), IMAGE_SCAN_TIMEOUT_MS);
                }
            } catch (_) {
                result = null;
            }
        }

        if (result?.plateText) {
            const cleanedPlate = fixUkPlateOcr(normalizeVrm(result.plateText));
            setVrm(cleanedPlate);
            if (nextFiles[0]) {
                nextFiles[0].detectedPlateText = cleanedPlate;
                nextFiles[0].detectedPlateConfidence = Number(result.confidence || 0);
            }
            setScanState({
                loading: false,
                text: cleanedPlate,
                confidence: Number(result.confidence || 0),
            });
        } else {
            setScanState({ loading: false, text: '', confidence: 0 });
        }

        if (result?.cutoffImage) {
            const cutoffFile = dataUrlToFile(result.cutoffImage, `plate_cutoff_${evidencePhase}_${Date.now()}.jpg`);
            if (cutoffFile) {
                nextFiles.push(cutoffFile);
                nextPreviews.push(result.cutoffImage);
            }
            if (nextFiles[0]) {
                nextFiles[0].detectedPlateCutoffImage = result.cutoffImage;
            }
        }

        setFiles((prev) => [...prev, ...nextFiles]);
        setPreviews((prev) => [...prev, ...nextPreviews]);

        if (step === 0) {
            setTimeout(() => setStep(1), 150);
        }
    }

    async function handleFileCapture(event) {
        const captured = Array.from(event.target.files || []);
        event.target.value = '';
        if (!captured.length) return;
        await appendCapturedFiles(captured, null, { allowWebFallback: !Capacitor.isNativePlatform() });
    }

    async function startLiveCamera() {
        if (liveCameraActive) return;

        const runScanLoop = () => {
            liveScanStartedAtRef.current = Date.now();
            liveLastFrameRef.current = null;

            const fallbackToManual = async (frameFile) => {
                const fallbackFrame = frameFile || liveLastFrameRef.current;
                if (!fallbackFrame) {
                    stopLiveCamera();
                    setScanState({ loading: false, text: 'No plate detected. Enter VRM manually.', confidence: 0 });
                    setStep(1);
                    return;
                }
                stopLiveCamera();
                await appendCapturedFiles([fallbackFrame], null, { allowWebFallback: false });
                setScanState({ loading: false, text: 'No plate detected. Enter VRM manually.', confidence: 0 });
            };

            liveScanTimerRef.current = window.setInterval(async () => {
                if (liveScanBusyRef.current) return;

                liveScanBusyRef.current = true;
                try {
                    let frameFile = null;

                    if (nativePreviewActiveRef.current) {
                        const sample = await captureNativeCameraSample(88);
                        frameFile = base64JpegToFile(sample, `native_live_scan_${Date.now()}.jpg`);
                    } else {
                        const currentVideo = liveVideoRef.current;
                        const currentCanvas = liveCanvasRef.current;
                        if (!currentVideo || !currentCanvas) return;

                        const width = Number(currentVideo.videoWidth || 0);
                        const height = Number(currentVideo.videoHeight || 0);
                        if (!width || !height) return;

                        currentCanvas.width = width;
                        currentCanvas.height = height;
                        const ctx = currentCanvas.getContext('2d');
                        if (!ctx) return;
                        ctx.drawImage(currentVideo, 0, 0, width, height);

                        const blob = await new Promise((resolve) => currentCanvas.toBlob(resolve, 'image/jpeg', 0.92));
                        if (!blob) return;

                        frameFile = new File([blob], `live_scan_${Date.now()}.jpg`, {
                            type: 'image/jpeg',
                            lastModified: Date.now(),
                        });
                    }

                    if (!frameFile) return;
                    liveLastFrameRef.current = frameFile;

                    const elapsedMs = Date.now() - Number(liveScanStartedAtRef.current || 0);
                    if (elapsedMs >= LIVE_MAX_SCAN_MS) {
                        await fallbackToManual(frameFile);
                        return;
                    }

                    let result = null;
                    if (mlkitReadyRef.current) {
                        result = await scanPlateWithMlKit(frameFile);
                    }
                    if (!result && !nativePreviewActiveRef.current && typeof onPlateScan === 'function') {
                        result = await onPlateScan(frameFile);
                    }

                    const plateText = fixUkPlateOcr(normalizeVrm(result?.plateText || ''));
                    const bbox = result?.bbox || null;
                    const confidence = Number(result?.confidence || 0);

                    if (!plateText || !bbox) {
                        liveNoPlateFramesRef.current += 1;
                        if (liveNoPlateFramesRef.current >= LIVE_MAX_NO_PLATE_FRAMES) {
                            await fallbackToManual(frameFile);
                            return;
                        }
                        const prev = liveStableRef.current;
                        const downshift = Math.max(0, Number(prev.frames || 0) - 1);
                        liveStableRef.current = {
                            plateText: '',
                            bbox: null,
                            frames: downshift,
                            confidence: 0,
                            confidenceSum: Math.max(0, Number(prev.confidenceSum || 0) - Number(prev.confidence || 0)),
                        };
                        setLivePlateBox(null);
                        setLockFrames(downshift);
                        setScanState({ loading: false, text: '', confidence: 0 });
                        return;
                    }

                    liveNoPlateFramesRef.current = 0;

                    const plausiblePlate = isLikelyPlateFormat(plateText);
                    const boostedConfidence = Math.min(100, confidence + (plausiblePlate ? 8 : 0));
                    if (!plausiblePlate || boostedConfidence < 40) {
                        liveNoPlateFramesRef.current += 1;
                        if (liveNoPlateFramesRef.current >= LIVE_MAX_NO_PLATE_FRAMES) {
                            await fallbackToManual(frameFile);
                            return;
                        }
                        const prev = liveStableRef.current;
                        const downshift = Math.max(0, Number(prev.frames || 0) - 1);
                        liveStableRef.current = {
                            plateText: '',
                            bbox: null,
                            frames: downshift,
                            confidence: boostedConfidence,
                            confidenceSum: Math.max(0, Number(prev.confidenceSum || 0) - Number(prev.confidence || 0)),
                        };
                        setLockFrames(downshift);
                        setScanState({ loading: false, text: plateText, confidence: boostedConfidence });
                        return;
                    }

                    setScanState({ loading: false, text: plateText, confidence: boostedConfidence });
                    setLivePlateBox(null);

                    const prev = liveStableRef.current;
                    const sameText = prev.plateText === plateText;
                    const overlap = computeIou(prev.bbox, bbox);
                    const confidenceDrift = Math.abs(Number(prev.confidence || 0) - boostedConfidence);
                    const confidenceConsistent = confidenceDrift <= 24;
                    const nextFrames = sameText && overlap >= LIVE_IOU_THRESHOLD && confidenceConsistent
                        ? prev.frames + 1
                        : 1;
                    const nextConfidenceSum = nextFrames > 1
                        ? Number(prev.confidenceSum || 0) + boostedConfidence
                        : boostedConfidence;
                    const averageConfidence = nextFrames > 0 ? nextConfidenceSum / nextFrames : 0;

                    liveStableRef.current = {
                        plateText,
                        bbox,
                        frames: nextFrames,
                        confidence: boostedConfidence,
                        confidenceSum: nextConfidenceSum,
                    };
                    setLockFrames(nextFrames);

                    // Fast lock: if confidence is already very high, accept immediately.
                    if (boostedConfidence >= 82) {
                        stopLiveCamera();
                        await appendCapturedFiles([frameFile], result, { allowWebFallback: false });
                        return;
                    }

                    if (nextFrames >= LIVE_REQUIRED_LOCK_FRAMES && averageConfidence >= LIVE_MIN_CONFIDENCE) {
                        stopLiveCamera();
                        await appendCapturedFiles([frameFile], result, { allowWebFallback: false });
                    }
                } catch (_) {
                    setScanState({ loading: false, text: '', confidence: 0 });
                } finally {
                    liveScanBusyRef.current = false;
                }
            }, LIVE_SCAN_INTERVAL_MS);
        };

        if (canUseNativeCameraPreview()) {
            try {
                await startNativeCameraPreview();
                nativePreviewActiveRef.current = true;
                setLiveCameraActive(true);
                setLiveEngine('native-preview');
                setScanState((prev) => ({ ...prev, loading: true }));
                runScanLoop();
                return;
            } catch (_) {
                nativePreviewActiveRef.current = false;
                setScanState({ loading: false, text: 'Native camera preview failed. Enter VRM manually.', confidence: 0 });
                return;
            }
        }

        if (!navigator?.mediaDevices?.getUserMedia) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                },
            });

            liveStreamRef.current = stream;
            const video = liveVideoRef.current;
            if (video) {
                // Force inline autoplay behavior for Android WebView and avoid native controls overlay.
                video.muted = true;
                video.autoplay = true;
                video.playsInline = true;
                video.controls = false;
                video.setAttribute('playsinline', 'true');
                video.setAttribute('webkit-playsinline', 'true');
                video.disablePictureInPicture = true;
                video.srcObject = stream;

                await new Promise((resolve) => {
                    if (video.readyState >= 1) {
                        resolve();
                        return;
                    }

                    const onLoaded = () => {
                        video.removeEventListener('loadedmetadata', onLoaded);
                        resolve();
                    };
                    video.addEventListener('loadedmetadata', onLoaded, { once: true });
                });

                const playResult = video.play();
                if (playResult && typeof playResult.then === 'function') {
                    await playResult;
                }

                const hasFrames = await waitForVideoDimensions(video, 3000);
                if (!hasFrames) {
                    throw new Error('camera_no_frames');
                }
            }

            setLiveCameraActive(true);
            setLiveEngine(mlkitReadyRef.current ? 'mlkit' : 'fallback');
            setScanState((prev) => ({ ...prev, loading: true }));
            runScanLoop();
        } catch (_) {
            stopLiveCamera();
            setScanState({ loading: false, text: '', confidence: 0 });
        }
    }

    function handleConfirm() {
        if (!vrm || !defaultSiteId || files.length === 0) return;
        onComplete?.({
            vrm: normalizeVrm(vrm),
            siteId: defaultSiteId,
            siteName: selectedSite?.displayName || selectedSite?.name || selectedSite?.location || defaultSiteId,
            contraventionCode,
            contraventionLabel: getContraventionSelectionLabel(selectedContravention),
            observationMinutes,
            files,
            note,
        });
        reset();
    }

    function handleCaptureOnlyComplete() {
        if (!files.length) return;
        onCaptureComplete?.({
            phase: evidencePhase,
            files,
            previews,
            scan: {
                plateText: normalizeVrm(scanState.text),
                confidence: Number(scanState.confidence || 0),
            },
        });
        reset();
    }

    function openCamera() {
        fileInputRef.current?.click();
    }

    // Step validations
    const canAdvanceFromCapture = Boolean(files.length > 0);
    const canAdvanceFromVrm = Boolean(normalizeVrm(vrm) && defaultSiteId && files.length > 0);
    const canConfirm = Boolean(normalizeVrm(vrm) && defaultSiteId && files.length > 0);

    if (!open) return null;

    // Full-screen camera dialog — shown whenever the live camera is active.
    // For native (toBack:true): the CameraPreview plugin renders the camera behind
    // the entire WebView. For it to be visible, every HTML element must be transparent.
    // We achieve this via injected CSS (!important) above, which clears all backgrounds
    // inside #__next (the Next.js root with the dashboard). The overlay itself is
    // rendered via React portal directly on document.body (OUTSIDE #__next) so the
    // CSS injection does NOT clobber the overlay's own semi-opaque control elements.
    // For web (getUserMedia): black bg with a full-screen <video> element.
    if (liveCameraActive) {
        const isNative = liveEngine === 'native-preview';
        const overlay = (
            <div
                style={{
                    position: 'fixed',
                    top: 'var(--safe-top-effective, env(safe-area-inset-top, 0px))',
                    right: 'var(--safe-right-effective, env(safe-area-inset-right, 0px))',
                    bottom: 'var(--safe-bottom-effective, env(safe-area-inset-bottom, 0px))',
                    left: 'var(--safe-left-effective, env(safe-area-inset-left, 0px))',
                    zIndex: 9999,
                    background: isNative ? 'transparent' : '#000',
                    display: 'flex',
                    flexDirection: 'column',
                    // Overlay is inset-aware via CSS vars bridged from native Android insets.
                    boxSizing: 'border-box',
                }}
            >
                {/* Camera viewport — transparent so camera behind WebView shows through */}
                <div style={{ flex: 1, position: 'relative', background: 'transparent', overflow: 'hidden' }}>
                    {/* Web video — fills the viewport via objectFit:cover */}
                    {!isNative ? (
                        <video
                            ref={liveVideoRef}
                            playsInline
                            muted
                            autoPlay
                            style={{
                                position: 'absolute',
                                top: 0, left: 0,
                                width: '100%', height: '100%',
                                objectFit: 'cover',
                                display: 'block',
                            }}
                        />
                    ) : null}
                    <canvas ref={liveCanvasRef} style={{ display: 'none' }} />

                    {/* Plate bounding-box overlay */}
                    {livePlateBox ? (
                        <div
                            style={{
                                position: 'absolute',
                                left: `${livePlateBox.leftPct}%`,
                                top: `${livePlateBox.topPct}%`,
                                width: `${livePlateBox.widthPct}%`,
                                height: `${livePlateBox.heightPct}%`,
                                border: lockFrames >= LIVE_REQUIRED_LOCK_FRAMES ? '3px solid #00d084' : '3px solid #ffbf47',
                                borderRadius: 8,
                                pointerEvents: 'none',
                            }}
                        />
                    ) : null}

                    {/* Scan status badge — top centre */}
                    <div
                        style={{
                            position: 'absolute',
                            top: 10, left: 0, right: 0,
                            display: 'flex',
                            justifyContent: 'center',
                            pointerEvents: 'none',
                        }}
                    >
                        <span
                            style={{
                                background: 'rgba(0,0,0,0.62)',
                                color: '#fff',
                                fontSize: 13,
                                fontWeight: 500,
                                padding: '4px 14px',
                                borderRadius: 20,
                                letterSpacing: 0.2,
                            }}
                        >
                            {scanState.text
                                ? `${scanState.text} — ${Math.min(lockFrames, LIVE_REQUIRED_LOCK_FRAMES)}/${LIVE_REQUIRED_LOCK_FRAMES} frames`
                                : 'Point camera at number plate…'}
                        </span>
                    </div>
                </div>

                {/* Bottom controls bar — semi-opaque so camera shows through sides */}
                <div
                    style={{
                        background: 'rgba(0,0,0,0.80)',
                        padding: '12px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        flexShrink: 0,
                    }}
                >
                    <div style={{ flex: 1, color: '#fff', fontSize: 12, lineHeight: 1.4 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>
                            {selectedSite?.displayName || selectedSite?.name || selectedSite?.location || defaultSiteId}
                        </div>
                        {scanState.text ? (
                            <div>Detected: {scanState.text} ({Math.round(scanState.confidence)}%)</div>
                        ) : (
                            <div style={{ color: 'rgba(255,255,255,0.55)' }}>Point camera at number plate</div>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={stopLiveCamera}
                        style={{
                            background: 'rgba(229,57,53,0.9)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 8,
                            padding: '9px 20px',
                            fontSize: 14,
                            fontWeight: 600,
                            cursor: 'pointer',
                        }}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        );

        // Render the overlay via React portal directly on document.body so it sits
        // OUTSIDE #__next. The injected CSS clears all backgrounds inside #__next;
        // using a portal means those rules won't strip the overlay's own backgrounds.
        if (isNative && typeof document !== 'undefined') {
            return createPortal(overlay, document.body);
        }
        return overlay;
    }

    return (
        <div className="stepper-overlay" onClick={handleClose}>
            <div className="stepper-panel" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="stepper-header">
                    <button type="button" className="ghost-button stepper-close" onClick={handleClose}>✕</button>
                    <h3 className="stepper-title">{captureOnly ? `${evidenceLabel} evidence capture` : 'Draft Parking Charge'}</h3>
                    <div className="stepper-dots">
                        {(captureOnly ? [0] : [0, 1, 2]).map((i) => (
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

                {/* Step 0: Entry evidence capture first */}
                {step === 0 ? (
                    <div className="stepper-step">
                        <p className="stepper-step-label">Step 1 — Capture full {evidenceLabel.toLowerCase()} evidence image</p>
                        <div className="stepper-fixed-site">
                            <span className="stepper-fixed-site-label">Patrol site</span>
                            <strong className="stepper-fixed-site-value">
                                {selectedSite?.displayName || selectedSite?.name || selectedSite?.location || defaultSiteId || 'No site selected'}
                            </strong>
                        </div>

                        {previews.length > 0 ? (
                            <div className="stepper-preview-grid">
                                {previews.map((p, i) => (
                                    <img key={i} src={p} alt={`Entry evidence ${i + 1}`} className="stepper-preview-img" />
                                ))}
                            </div>
                        ) : (
                            <div className="stepper-capture-prompt">
                                <span className="stepper-capture-icon">📸</span>
                                <p>Tap the button below to start live ANPR scanning</p>
                                <p className="text-muted">Camera opens full-screen — plate locks automatically</p>
                            </div>
                        )}

                        {scanState.loading ? <div className="text-muted">Scanning image for VRM...</div> : null}
                        {scanState.text ? (
                            <div className="text-muted">Detected VRM: {scanState.text} (confidence {Math.round(scanState.confidence)}%)</div>
                        ) : null}

                        <div className="stepper-nav">
                            <button type="button" className="ghost-button" onClick={handleClose}>Cancel</button>
                            <div className="stepper-nav-actions">
                                <button
                                    type="button"
                                    className="secondary-button"
                                    onClick={liveCameraActive ? stopLiveCamera : startLiveCamera}
                                >
                                    {liveCameraActive ? 'Stop scan image' : 'Scan image'}
                                </button>
                                {canAdvanceFromCapture ? (
                                    <button
                                        type="button"
                                        className="primary-button"
                                        onClick={captureOnly ? handleCaptureOnlyComplete : () => setStep(1)}
                                    >
                                        {captureOnly ? `Use ${evidenceLabel.toLowerCase()} evidence` : 'Next — Vehicle details →'}
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Step 1: Vehicle identification + contravention */}
                {!captureOnly && step === 1 ? (
                    <div className="stepper-step">
                        <p className="stepper-step-label">Step 2 — Vehicle details</p>
                        <div className="stepper-vrm-banner">
                            <span className="stepper-vrm-text">{normalizeVrm(vrm) || 'Pending VRM'}</span>
                            <span className="text-muted">{selectedSite?.displayName || selectedSite?.name || defaultSiteId}</span>
                        </div>

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

                        <label className="stepper-field">
                            <span className="stepper-field-label">Contravention</span>
                            <select className="stepper-select" value={contraventionCode} onChange={(e) => { setContraventionCode(e.target.value); setContraventionTouched(true); }}>
                                {contraventions.map((c, index) => (
                                    <option key={c.code || `contravention-${index + 1}`} value={c.code || ''}>{getContraventionSelectionLabel(c)}</option>
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
                            <button type="button" className="ghost-button" onClick={() => setStep(0)}>← Back to capture</button>
                            <div className="stepper-nav-actions">
                                {canAdvanceFromVrm ? (
                                    <button type="button" className="primary-button" onClick={() => setStep(2)}>
                                        Next — Confirm →
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Step 2: Confirm */}
                {!captureOnly && step === 2 ? (
                    <div className="stepper-step">
                        <p className="stepper-step-label">Step 3 — Confirm Parking Charge</p>

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
                                <span className="stepper-summary-val">{getContraventionSelectionLabel(selectedContravention)}</span>
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
                                {'Create Parking Charge'}
                            </button>
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
