import { useRef, useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { formatLocalTimestamp } from '../lib/ukTimestamp';
import { isMlKitReady, scanPlateWithMlKit } from '../lib/mlkitLpr';
import { canUseNativeCameraPreview, captureNativeCameraSample, setNativeCameraTorchEnabled, startNativeCameraPreview, stopNativeCameraPreview } from '../lib/nativeCameraPreview';
import { getServerTimestamp } from '../lib/timeSync';

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

function normalizeVrm(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
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
    return formatLocalTimestamp(capturedAt);
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

function normalizeBboxForImage(rawBbox, imageWidth, imageHeight) {
    if (!rawBbox || !imageWidth || !imageHeight) return null;

    const x0Candidate = Number(rawBbox?.x0 ?? rawBbox?.left ?? rawBbox?.x ?? NaN);
    const y0Candidate = Number(rawBbox?.y0 ?? rawBbox?.top ?? rawBbox?.y ?? NaN);
    const x1FromEdges = Number(rawBbox?.x1 ?? rawBbox?.right ?? NaN);
    const y1FromEdges = Number(rawBbox?.y1 ?? rawBbox?.bottom ?? NaN);
    const widthCandidate = Number(rawBbox?.width ?? NaN);
    const heightCandidate = Number(rawBbox?.height ?? NaN);

    let x0 = x0Candidate;
    let y0 = y0Candidate;
    let x1 = Number.isFinite(x1FromEdges)
        ? x1FromEdges
        : (Number.isFinite(x0) && Number.isFinite(widthCandidate) ? x0 + widthCandidate : NaN);
    let y1 = Number.isFinite(y1FromEdges)
        ? y1FromEdges
        : (Number.isFinite(y0) && Number.isFinite(heightCandidate) ? y0 + heightCandidate : NaN);

    if (![x0, y0, x1, y1].every(Number.isFinite)) return null;

    const looksNormalized = [x0, y0, x1, y1].every((value) => value >= 0 && value <= 1);
    if (looksNormalized) {
        x0 *= imageWidth;
        x1 *= imageWidth;
        y0 *= imageHeight;
        y1 *= imageHeight;
    }

    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);

    const safeX0 = Math.max(0, Math.min(imageWidth - 1, left));
    const safeY0 = Math.max(0, Math.min(imageHeight - 1, top));
    const safeX1 = Math.max(1, Math.min(imageWidth, right));
    const safeY1 = Math.max(1, Math.min(imageHeight, bottom));

    if (safeX1 <= safeX0 || safeY1 <= safeY0) return null;

    return {
        x0: safeX0,
        y0: safeY0,
        x1: safeX1,
        y1: safeY1,
    };
}

async function createPlateCutoutDataUrl(file, bbox) {
    if (!file || !bbox) return '';

    try {
        const image = await loadImageElement(file);
        const imageWidth = image.naturalWidth || image.width;
        const imageHeight = image.naturalHeight || image.height;
        if (!imageWidth || !imageHeight) return '';

        const normalizedBbox = normalizeBboxForImage(bbox, imageWidth, imageHeight);
        if (!normalizedBbox) return '';

        const rawWidth = Math.max(1, normalizedBbox.x1 - normalizedBbox.x0);
        const rawHeight = Math.max(1, normalizedBbox.y1 - normalizedBbox.y0);
        const padX = Math.max(4, Math.round(rawWidth * 0.2));
        const padY = Math.max(4, Math.round(rawHeight * 0.35));

        const sx = Math.max(0, Math.floor(normalizedBbox.x0 - padX));
        const sy = Math.max(0, Math.floor(normalizedBbox.y0 - padY));
        const ex = Math.min(imageWidth, Math.ceil(normalizedBbox.x1 + padX));
        const ey = Math.min(imageHeight, Math.ceil(normalizedBbox.y1 + padY));
        const sw = Math.max(1, ex - sx);
        const sh = Math.max(1, ey - sy);

        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext('2d');
        if (!ctx) return '';

        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
        return canvas.toDataURL('image/jpeg', 0.92);
    } catch (_) {
        return '';
    }
}

async function resolveCameraCaptureTimestamp(file, fallbackIso) {
    const fallback = normalizeCapturedAt(fallbackIso) || new Date().toISOString();
    if (!file || typeof window === 'undefined') return fallback;

    // Use the actual capture moment as canonical. EXIF may be timezone-shifted
    // and can introduce one-hour drift around DST.
    if (fallback) return fallback;

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

    // Keep plate cutouts unmodified so timestamp overlays never obstruct VRM pixels.
    if (String(phase || '').toLowerCase() === 'plate') return file;

    try {
        const image = await loadImageElement(file);
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const ctx = canvas.getContext('2d');
        if (!ctx || !canvas.width || !canvas.height) return file;

        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        const stampText = formatEvidenceLocalTimestamp(capturedAt);
        let baseFont = 3 * Math.max(11, Math.min(16, Math.floor(canvas.width / 88)));
        const marginX = Math.max(6, Math.floor(canvas.width * 0.012));
        const marginY = Math.max(6, Math.floor(canvas.height * 0.014));
        const maxBoxWidth = Math.max(40, canvas.width - (marginX * 2));
        const maxBoxHeight = Math.max(20, canvas.height - (marginY * 2));

        let paddingX = 0;
        let paddingY = 0;
        let boxWidth = 0;
        let boxHeight = 0;
        while (baseFont >= 10) {
            paddingX = Math.max(8, Math.floor(baseFont * 0.45));
            paddingY = Math.max(5, Math.floor(baseFont * 0.3));
            ctx.font = `600 ${baseFont}px "Roboto Mono", "Courier New", monospace`;
            const textWidth = Math.ceil(ctx.measureText(stampText).width);
            boxWidth = textWidth + (paddingX * 2);
            boxHeight = Math.ceil(baseFont + (paddingY * 2));
            if (boxWidth <= maxBoxWidth && boxHeight <= maxBoxHeight) break;
            baseFont -= 2;
        }

        const clampedBoxWidth = Math.min(maxBoxWidth, boxWidth);
        const clampedBoxHeight = Math.min(maxBoxHeight, boxHeight);

        // ANPR-style timestamp container: compact dark chip for readability.
        ctx.fillStyle = 'rgba(5, 10, 18, 0.64)';
        ctx.fillRect(marginX, marginY, clampedBoxWidth, clampedBoxHeight);
        ctx.strokeStyle = 'rgba(220, 235, 255, 0.26)';
        ctx.lineWidth = Math.max(1, Math.floor(baseFont * 0.08));
        ctx.strokeRect(marginX, marginY, clampedBoxWidth, clampedBoxHeight);

        ctx.textBaseline = 'top';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)';
        ctx.lineWidth = Math.max(2, Math.floor(baseFont * 0.22));
        ctx.fillStyle = '#f7fbff';
        ctx.save();
        ctx.beginPath();
        ctx.rect(marginX, marginY, clampedBoxWidth, clampedBoxHeight);
        ctx.clip();
        ctx.strokeText(stampText, marginX + paddingX, marginY + paddingY);
        ctx.fillText(stampText, marginX + paddingX, marginY + paddingY);
        ctx.restore();

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

function isPlateCutoffFileArtifact(fileLike) {
    const name = String(fileLike?.name || fileLike?.fileName || '').toLowerCase();
    return name.includes('plate_cutoff_');
}

function hasCapturePairArtifacts(files, options = {}) {
    const requireExtractedVrm = options?.requireExtractedVrm !== false;
    const requirePlateCutoff = options?.requirePlateCutoff !== false;
    const minimumImages = Math.max(1, Number(options?.minimumImages || 1));
    const safeFiles = Array.isArray(files) ? files : [];
    if (safeFiles.length === 0) return false;

    const hasVehicleImage = safeFiles.some((file) => !isPlateCutoffFileArtifact(file));
    const hasPlateCutoff = safeFiles.some((file) => (
        isPlateCutoffFileArtifact(file) || Boolean(String(file?.detectedPlateCutoffImage || '').trim())
    ));
    const hasExtractedVrm = safeFiles.some((file) => Boolean(normalizeVrm(file?.detectedPlateText || '')));
    const hasMinimumImages = safeFiles.length >= minimumImages;

    return hasVehicleImage
        && hasMinimumImages
        && (requirePlateCutoff ? hasPlateCutoff : true)
        && (requireExtractedVrm ? hasExtractedVrm : true);
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

// Scan interval and lock thresholds:
// - Warm-up allows user to center the vehicle before lock/fallback counters begin.
// - Stable lock requires multiple consistent frames before auto-capture.
// - Hard fallback captures a frame without OCR if no plate is found within the window.
const LIVE_SCAN_INTERVAL_MS = 300;
const LIVE_REQUIRED_LOCK_FRAMES = 3;
const LIVE_PROTECTED_CANDIDATE_FRAMES = 2;
const LIVE_CANDIDATE_MISS_TOLERANCE = 2;
const LIVE_MIN_CONFIDENCE = 52;
const LIVE_IOU_THRESHOLD = 0.46;
const LIVE_MAX_NO_PLATE_FRAMES = 15;
const LIVE_LOCK_WARMUP_MS = 900;
const LIVE_MIN_LOCK_MS = 1200;
const LIVE_MAX_SCAN_MS = 5200;
const LIVE_REPLACEMENT_REQUIRED_FRAMES = 2;
const LIVE_REPLACEMENT_CONFIDENCE_MARGIN = 10;
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

function shouldEnableNightTorch(now = new Date()) {
    const hour = Number(now.getHours());
    return hour >= 18 || hour < 6;
}

async function setWebTrackTorch(track, enabled) {
    if (!track || typeof track.applyConstraints !== 'function') return;

    try {
        const capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
        if (!capabilities?.torch) return;
        await track.applyConstraints({ advanced: [{ torch: Boolean(enabled) }] });
    } catch (_) {
        // Ignore torch failures on browsers/devices without writable torch controls.
    }
}

function isLikelyPlateFormat(plate) {
    const value = String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!value || value.length < 3 || value.length > 12) return false;

    const ukCurrent = /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/;
    const ukPrefix = /^[A-Z][0-9]{1,3}[A-Z]{3}$/;
    const ukSuffix = /^[A-Z]{3}[0-9]{1,3}[A-Z]$/;
    const generic = /^[A-Z0-9]{3,12}$/;
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
    onPermitCheck,
    sites = [],
    contraventions = [],
    selectedSiteId: defaultSiteId = '',
    onPlateScan,
    mode = 'full',
    capturePhase = 'entry',
    allowManualCaptureMode = true,
    autoStartScan = false,
    requireOcrArtifacts = true,
}) {
    const captureOnly = mode === 'capture-only';
    const evidencePhase = capturePhase === 'closing' ? 'closing' : 'entry';
    const evidenceLabel = evidencePhase === 'closing' ? 'Closing' : 'Entry';
    const supportsManualCaptureMode = allowManualCaptureMode !== false;
    const [step, setStep] = useState(0);
    const [captureMode, setCaptureMode] = useState('scan');
    const [skipCapture, setSkipCapture] = useState(false);
    const [vrm, setVrm] = useState('');
    const [capturedVrm, setCapturedVrm] = useState('');
    const [contraventionCode, setContraventionCode] = useState(contraventions[0]?.code || '');
    const [contraventionTouched, setContraventionTouched] = useState(false);
    const [files, setFiles] = useState([]);
    const [previews, setPreviews] = useState([]);
    const [scanState, setScanState] = useState({ loading: false, text: '', confidence: 0 });
    const [liveEngine, setLiveEngine] = useState('none');
    const [liveCameraActive, setLiveCameraActive] = useState(false);
    const [livePlateBox, setLivePlateBox] = useState(null);
    const [lockFrames, setLockFrames] = useState(0);
    const [nightModeActive, setNightModeActive] = useState(false);
    const [torchEnabled, setTorchEnabled] = useState(false);
    const [autoNightTorchEnabled, setAutoNightTorchEnabled] = useState(true);
    const [note, setNote] = useState('');
    const [permitCheck, setPermitCheck] = useState({ status: 'idle', hasPermit: false, message: '', matchConfidence: null });
    const cameraInputRef = useRef(null);
    const galleryInputRef = useRef(null);
    const liveVideoRef = useRef(null);
    const liveCanvasRef = useRef(null);
    const liveScanTimerRef = useRef(null);
    const liveStreamRef = useRef(null);
    const liveVideoTrackRef = useRef(null);
    const liveScanBusyRef = useRef(false);
    const liveStableRef = useRef({ plateText: '', bbox: null, frames: 0, confidence: 0, confidenceSum: 0 });
    const liveReplacementRef = useRef({ plateText: '', bbox: null, frames: 0, confidence: 0, confidenceSum: 0 });
    const liveNoPlateFramesRef = useRef(0);
    const liveScanStartedAtRef = useRef(0);
    const liveLastFrameRef = useRef(null);
    const autoStartArmedRef = useRef(false);
    const nativePreviewActiveRef = useRef(false);
    const mlkitReadyRef = useRef(false);
    const permitCheckRequestRef = useRef(0);
    const permitCheckKeyRef = useRef('');

    const normalizeVrm = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const stableCapturedVrm = normalizeVrm(vrm || capturedVrm || scanState.text);
    const requiresOcrArtifacts = captureOnly ? requireOcrArtifacts : (supportsManualCaptureMode && captureMode !== 'manual');

    const selectedContravention = useMemo(
        () => contraventions.find((c) => c.code === contraventionCode) || contraventions[0] || {},
        [contraventions, contraventionCode]
    );

    const selectedSite = useMemo(
        () => sites.find((s) => String(s.id) === String(defaultSiteId)) || null,
        [sites, defaultSiteId]
    );

    const selectedSiteName = useMemo(() => {
        const preferred = String(
            selectedSite?.displayName
            || selectedSite?.name
            || selectedSite?.siteName
            || selectedSite?.location
            || selectedSite?.title
            || ''
        ).trim();
        return preferred || 'No site selected';
    }, [selectedSite]);

    const defaultContraventionCode = useMemo(() => {
        if (!contraventions.length) return '';
        return contraventions[0]?.code || '';
    }, [contraventions]);

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
        setCaptureMode('scan');
        setSkipCapture(false);
        setVrm('');
        setCapturedVrm('');
        setContraventionCode(defaultContraventionCode || contraventions[0]?.code || '');
        setContraventionTouched(false);
        setFiles([]);
        setPreviews([]);
        setScanState({ loading: false, text: '', confidence: 0 });
        setLiveEngine('none');
        setLivePlateBox(null);
        setLockFrames(0);
        setNightModeActive(false);
        setTorchEnabled(false);
        setAutoNightTorchEnabled(true);
        setNote('');
        setPermitCheck({ status: 'idle', hasPermit: false, message: '', matchConfidence: null });
        permitCheckKeyRef.current = '';
    }

    async function applyLiveTorchState(enabled) {
        const nextEnabled = Boolean(enabled);
        if (nativePreviewActiveRef.current) {
            await setNativeCameraTorchEnabled(nextEnabled);
            setTorchEnabled(nextEnabled);
            return;
        }

        const track = liveVideoTrackRef.current;
        if (!track) {
            setTorchEnabled(false);
            return;
        }

        await setWebTrackTorch(track, nextEnabled);
        setTorchEnabled(nextEnabled);
    }

    async function toggleFlashlight() {
        if (!nightModeActive || !liveCameraActive) return;
        await applyLiveTorchState(!torchEnabled);
    }

    async function toggleAutoNightTorch() {
        const nextAutoNightTorch = !autoNightTorchEnabled;
        setAutoNightTorchEnabled(nextAutoNightTorch);

        if (!liveCameraActive || !nightModeActive) return;

        if (!nextAutoNightTorch && torchEnabled) {
            await applyLiveTorchState(false);
            return;
        }

        if (nextAutoNightTorch && !torchEnabled) {
            await applyLiveTorchState(true);
        }
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
        liveVideoTrackRef.current = null;
        liveScanBusyRef.current = false;
        liveStableRef.current = { plateText: '', bbox: null, frames: 0, confidence: 0, confidenceSum: 0 };
        liveReplacementRef.current = { plateText: '', bbox: null, frames: 0, confidence: 0, confidenceSum: 0 };
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
        setNightModeActive(false);
        setTorchEnabled(false);
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
        if (!open) return;
        setCaptureMode('scan');
    }, [open, supportsManualCaptureMode]);

    useEffect(() => {
        if (!open) {
            autoStartArmedRef.current = true;
            return;
        }
        if (!captureOnly || !autoStartScan) return;
        if (!autoStartArmedRef.current) return;
        autoStartArmedRef.current = false;

        const timer = window.setTimeout(() => {
            startLiveCamera();
        }, 40);

        return () => window.clearTimeout(timer);
    }, [open, captureOnly, autoStartScan]);

    useEffect(() => {
        if (!open || captureOnly || (step !== 1 && step !== 2)) return;

        const targetVrm = normalizeVrm(vrm);
        const targetSiteId = String(defaultSiteId || '').trim();

        if (!targetVrm || !targetSiteId) {
            setPermitCheck({ status: 'missing', hasPermit: false, message: 'Set VRM and patrol site to run e-permit check.', matchConfidence: null });
            return;
        }

        const lookupKey = `${targetVrm}|${targetSiteId}`;
        if (permitCheckKeyRef.current === lookupKey) return;
        permitCheckKeyRef.current = lookupKey;

        const requestId = permitCheckRequestRef.current + 1;
        permitCheckRequestRef.current = requestId;
        setPermitCheck({ status: 'checking', hasPermit: false, message: 'Checking e-permit status...', matchConfidence: null });

        Promise.resolve(onPermitCheck?.(targetVrm, targetSiteId))
            .then((result) => {
                if (permitCheckRequestRef.current !== requestId) return;
                const hasPermit = Boolean(result?.hasAuthorization || result?.hasPermit || result?.permit || result?.validPermit);
                if (hasPermit) {
                    setPermitCheck({
                        status: 'matched',
                        hasPermit: true,
                        message: 'Permit/payment matched. Do not create a parking charge unless another rule is breached.',
                        matchConfidence: {
                            bestVrm: String(result?.matchConfidence?.bestVrm || '').trim(),
                            scorePercent: Number(result?.matchConfidence?.scorePercent || 0),
                            comparedCount: Number(result?.matchConfidence?.comparedCount || 0),
                        },
                    });
                    return;
                }

                setPermitCheck({
                    status: 'not_matched',
                    hasPermit: false,
                    message: 'No valid permit/payment found for this VRM at this site.',
                    matchConfidence: {
                        bestVrm: String(result?.matchConfidence?.bestVrm || '').trim(),
                        scorePercent: Number(result?.matchConfidence?.scorePercent || 0),
                        comparedCount: Number(result?.matchConfidence?.comparedCount || 0),
                    },
                });
            })
            .catch(() => {
                if (permitCheckRequestRef.current !== requestId) return;
                setPermitCheck({
                    status: 'error',
                    hasPermit: false,
                    message: 'E-permit check failed. Edit VRM or go back and continue again to retry.',
                    matchConfidence: null,
                });
            });
    }, [open, captureOnly, step, vrm, defaultSiteId]);

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

    function setCaptureModeSafely(nextMode) {
        const normalizedMode = nextMode === 'manual' ? 'manual' : 'scan';
        if (!supportsManualCaptureMode || normalizedMode === captureMode) return;
        if (liveCameraActive) {
            stopLiveCamera();
        }
        setCaptureMode(normalizedMode);
        setScanState({ loading: false, text: '', confidence: 0 });
    }

    function handleSkipCapture() {
        if (liveCameraActive) {
            stopLiveCamera();
        }
        setSkipCapture(true);
        setScanState({ loading: false, text: '', confidence: 0 });
        setStep(1);
    }

    function hasRequiredCaptureArtifacts(candidateFiles) {
        return hasCapturePairArtifacts(candidateFiles, {
            requireExtractedVrm: requiresOcrArtifacts,
            requirePlateCutoff: requiresOcrArtifacts,
            minimumImages: 1,
        });
    }

    async function appendCapturedFiles(captured, initialScanResult = null, options = {}) {
        if (!captured.length) return;
        const allowWebFallback = Boolean(options.allowWebFallback);
        const skipOcr = Boolean(options.skipOcr);

        const fallbackCapturedAt = await getServerTimestamp();
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
        if (!skipOcr && !result && captured[0]) {
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

        if (!skipOcr && result?.plateText && result?.bbox && !result?.cutoffImage && captured[0]) {
            const bboxCutoff = await createPlateCutoutDataUrl(captured[0], result.bbox);
            if (bboxCutoff) {
                result = {
                    ...result,
                    cutoffImage: bboxCutoff,
                };
            }
        }

        if (!skipOcr && result?.plateText && !result?.cutoffImage && captured[0] && typeof onPlateScan === 'function') {
            try {
                const fallback = await withTimeout(onPlateScan(captured[0]), IMAGE_SCAN_TIMEOUT_MS);
                if (fallback?.cutoffImage) {
                    result = {
                        ...result,
                        cutoffImage: fallback.cutoffImage,
                        bbox: result?.bbox || fallback?.bbox || null,
                    };
                }
            } catch (_) {
                // Keep primary OCR result if fallback crop extraction fails.
            }
        }

        if (result?.plateText) {
            const cleanedPlate = normalizeVrm(result.plateText);
            setVrm((current) => current || cleanedPlate);
            setCapturedVrm(cleanedPlate);
            if (nextFiles[0]) {
                nextFiles[0].detectedPlateText = cleanedPlate;
                nextFiles[0].detectedPlateConfidence = Number(result.confidence || 0);
                nextFiles[0].detectedPlateBbox = result.bbox || null;
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
                const cutoffCapturedAt = normalizeCapturedAt(stampedCaptured?.[0]?.capturedAt) || new Date().toISOString();
                const stampedCutoff = await stampEvidenceImage(cutoffFile, { capturedAt: cutoffCapturedAt, phase: 'plate' });
                stampedCutoff.capturedAt = cutoffCapturedAt;
                const stampedCutoffPreview = await fileToDataUrl(stampedCutoff);
                nextFiles.push(stampedCutoff);
                nextPreviews.push(stampedCutoffPreview || result.cutoffImage);
                result.cutoffImage = stampedCutoffPreview || result.cutoffImage;
            }
            if (nextFiles[0]) {
                nextFiles[0].detectedPlateCutoffImage = result.cutoffImage;
            }
        }

        const mergedFiles = [...files, ...nextFiles];
        const mergedPreviews = [...previews, ...nextPreviews];
        setFiles((prev) => [...prev, ...nextFiles]);
        setPreviews((prev) => [...prev, ...nextPreviews]);
        if (nextFiles.length > 0) {
            setSkipCapture(false);
        }

        const hasPairArtifacts = hasRequiredCaptureArtifacts(evidencePhase === 'closing'
            ? [...files, ...nextFiles]
            : nextFiles);
        if (!hasPairArtifacts) {
            setScanState({
                loading: false,
                text: evidencePhase === 'closing'
                    ? (requiresOcrArtifacts
                        ? 'Full vehicle image captured. Plate cutout is missing - recapture plate and try again.'
                        : 'Closing evidence captured.')
                    : (requiresOcrArtifacts
                        ? 'Full vehicle image captured. Plate cutout is missing - recapture plate and try again.'
                        : 'Capture at least 1 entry evidence image.'),
                confidence: 0,
            });
            return false;
        }

        // Camera-tab quick OCR flow should jump directly to the parent VRM/permit
        // confirmation dialog without the extra "Use entry evidence" action screen.
        if (captureOnly && autoStartScan) {
            onCaptureComplete?.({
                phase: evidencePhase,
                files: mergedFiles,
                previews: mergedPreviews,
                captureMode,
                scan: {
                    plateText: normalizeVrm(result?.plateText || stableCapturedVrm),
                    confidence: Number(result?.confidence || scanState.confidence || 0),
                    cutoffImage: String(result?.cutoffImage || mergedFiles?.[0]?.detectedPlateCutoffImage || ''),
                    bbox: result?.bbox || mergedFiles?.[0]?.detectedPlateBbox || null,
                },
            });
            onClose?.();
            reset();
            return true;
        }

        if (step === 0 && !captureOnly) {
            setTimeout(() => setStep(1), 150);
        }

        return true;
    }

    async function handleFileCapture(event) {
        const captured = Array.from(event.target.files || []);
        event.target.value = '';
        if (!captured.length) return;
        await appendCapturedFiles(captured, null, {
            allowWebFallback: !Capacitor.isNativePlatform(),
            skipOcr: !requiresOcrArtifacts,
        });
    }

    async function startLiveCamera() {
        if (liveCameraActive) return;
        const autoNightTorch = shouldEnableNightTorch();
        const initialTorchEnabled = autoNightTorch && autoNightTorchEnabled;
        setNightModeActive(autoNightTorch);
        setTorchEnabled(initialTorchEnabled);

        const runScanLoop = () => {
            liveScanStartedAtRef.current = Date.now();
            liveLastFrameRef.current = null;

            const fallbackToManual = async (frameFile) => {
                const fallbackFrame = frameFile || liveLastFrameRef.current;
                if (!fallbackFrame) {
                    stopLiveCamera();
                    if (!captureOnly) setStep(1);
                    setScanState({ loading: false, text: captureOnly ? '' : 'No plate detected. Enter VRM manually.', confidence: 0 });
                    return;
                }
                stopLiveCamera();
                const appendedWithPair = await appendCapturedFiles([fallbackFrame], null, {
                    allowWebFallback: true,
                    skipOcr: false,
                });
                if (!appendedWithPair) {
                    setScanState({ loading: false, text: captureOnly ? '' : 'No plate detected. Enter VRM manually.', confidence: 0 });
                }
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

                    const plateText = normalizeVrm(result?.plateText || '');
                    const bbox = result?.bbox || null;
                    const confidence = Number(result?.confidence || 0);
                    const warmupActive = elapsedMs < LIVE_LOCK_WARMUP_MS;

                    if (!plateText || !bbox) {
                        if (!warmupActive) {
                            liveNoPlateFramesRef.current += 1;
                            if (liveNoPlateFramesRef.current >= LIVE_MAX_NO_PLATE_FRAMES) {
                                await fallbackToManual(frameFile);
                                return;
                            }
                        }
                        const prev = liveStableRef.current;
                        const downshift = Math.max(0, Number(prev.frames || 0) - 1);
                        const preserveCandidate = Boolean(prev.plateText) && downshift >= LIVE_CANDIDATE_MISS_TOLERANCE;
                        liveStableRef.current = {
                            plateText: preserveCandidate ? prev.plateText : '',
                            bbox: preserveCandidate ? prev.bbox : null,
                            frames: downshift,
                            confidence: 0,
                            confidenceSum: Math.max(0, Number(prev.confidenceSum || 0) - Number(prev.confidence || 0)),
                        };
                        liveReplacementRef.current = { plateText: '', bbox: null, frames: 0, confidence: 0, confidenceSum: 0 };
                        setLivePlateBox(preserveCandidate ? livePlateBox : null);
                        setLockFrames(downshift);
                        setScanState({ loading: false, text: preserveCandidate ? prev.plateText : '', confidence: preserveCandidate ? Number(prev.confidence || 0) : 0 });
                        return;
                    }

                    liveNoPlateFramesRef.current = 0;

                    const effectiveConfidence = Math.min(100, confidence);
                    setVrm((current) => current || plateText);
                    setCapturedVrm((current) => current || plateText);
                    if (!plateText) {
                        if (!warmupActive) {
                            liveNoPlateFramesRef.current += 1;
                            if (liveNoPlateFramesRef.current >= LIVE_MAX_NO_PLATE_FRAMES) {
                                await fallbackToManual(frameFile);
                                return;
                            }
                        }
                        const prev = liveStableRef.current;
                        const downshift = Math.max(0, Number(prev.frames || 0) - 1);
                        const preserveCandidate = Boolean(prev.plateText) && downshift >= LIVE_CANDIDATE_MISS_TOLERANCE;
                        liveStableRef.current = {
                            plateText: preserveCandidate ? prev.plateText : '',
                            bbox: preserveCandidate ? prev.bbox : null,
                            frames: downshift,
                            confidence: effectiveConfidence,
                            confidenceSum: Math.max(0, Number(prev.confidenceSum || 0) - Number(prev.confidence || 0)),
                        };
                        liveReplacementRef.current = { plateText: '', bbox: null, frames: 0, confidence: 0, confidenceSum: 0 };
                        setLockFrames(downshift);
                        setScanState({
                            loading: false,
                            text: preserveCandidate ? prev.plateText : '',
                            confidence: preserveCandidate ? Number(prev.confidence || 0) : effectiveConfidence,
                        });
                        return;
                    }

                    const prev = liveStableRef.current;
                    const overlap = computeIou(prev.bbox, bbox);
                    const confidenceDrift = Math.abs(Number(prev.confidence || 0) - effectiveConfidence);
                    const confidenceConsistent = confidenceDrift <= 24;
                    const hasProtectedCandidate = Boolean(prev.plateText) && Number(prev.frames || 0) >= LIVE_PROTECTED_CANDIDATE_FRAMES;

                    if (hasProtectedCandidate && prev.plateText !== plateText && overlap >= LIVE_IOU_THRESHOLD) {
                        const challengerPrev = liveReplacementRef.current;
                        const challengerOverlap = computeIou(challengerPrev.bbox, bbox);
                        const challengerSameText = challengerPrev.plateText === plateText;
                        const challengerDrift = Math.abs(Number(challengerPrev.confidence || 0) - effectiveConfidence);
                        const challengerConsistent = challengerDrift <= 24;
                        const challengerFrames = challengerSameText && challengerOverlap >= LIVE_IOU_THRESHOLD && challengerConsistent
                            ? Number(challengerPrev.frames || 0) + 1
                            : 1;
                        const challengerConfidenceSum = challengerFrames > 1
                            ? Number(challengerPrev.confidenceSum || 0) + effectiveConfidence
                            : effectiveConfidence;
                        const challengerAverageConfidence = challengerFrames > 0 ? challengerConfidenceSum / challengerFrames : 0;
                        const stableAverageConfidence = Number(prev.frames || 0) > 0
                            ? Number(prev.confidenceSum || 0) / Number(prev.frames || 1)
                            : Number(prev.confidence || 0);

                        liveReplacementRef.current = {
                            plateText,
                            bbox,
                            frames: challengerFrames,
                            confidence: effectiveConfidence,
                            confidenceSum: challengerConfidenceSum,
                        };

                        const challengerIsStronger = challengerAverageConfidence >= stableAverageConfidence + LIVE_REPLACEMENT_CONFIDENCE_MARGIN;
                        if (!challengerIsStronger || challengerFrames < LIVE_REPLACEMENT_REQUIRED_FRAMES) {
                            setScanState({ loading: false, text: prev.plateText, confidence: stableAverageConfidence });
                            setLockFrames(Number(prev.frames || 0));
                            setLivePlateBox(null);
                            return;
                        }

                        liveStableRef.current = {
                            plateText,
                            bbox,
                            frames: challengerFrames,
                            confidence: effectiveConfidence,
                            confidenceSum: challengerConfidenceSum,
                        };
                        liveReplacementRef.current = { plateText: '', bbox: null, frames: 0, confidence: 0, confidenceSum: 0 };
                        setScanState({ loading: false, text: plateText, confidence: challengerAverageConfidence });
                        setLockFrames(challengerFrames);
                        setLivePlateBox(null);
                    } else {
                        const sameText = prev.plateText === plateText;
                        const nextFrames = sameText && overlap >= LIVE_IOU_THRESHOLD && confidenceConsistent
                            ? prev.frames + 1
                            : 1;
                        const nextConfidenceSum = nextFrames > 1
                            ? Number(prev.confidenceSum || 0) + effectiveConfidence
                            : effectiveConfidence;
                        const averageConfidence = nextFrames > 0 ? nextConfidenceSum / nextFrames : 0;

                        liveStableRef.current = {
                            plateText,
                            bbox,
                            frames: nextFrames,
                            confidence: effectiveConfidence,
                            confidenceSum: nextConfidenceSum,
                        };
                        liveReplacementRef.current = { plateText: '', bbox: null, frames: 0, confidence: 0, confidenceSum: 0 };
                        setScanState({ loading: false, text: plateText, confidence: averageConfidence });
                        setLockFrames(nextFrames);
                        setLivePlateBox(null);

                        const warmupSatisfied = elapsedMs >= LIVE_LOCK_WARMUP_MS;
                        const minLockSatisfied = elapsedMs >= LIVE_MIN_LOCK_MS;

                        if (warmupSatisfied && minLockSatisfied && nextFrames >= LIVE_REQUIRED_LOCK_FRAMES && averageConfidence >= LIVE_MIN_CONFIDENCE) {
                            stopLiveCamera();
                            await appendCapturedFiles([frameFile], result, { allowWebFallback: false });
                        }
                        return;
                    }

                    const warmupSatisfied = elapsedMs >= LIVE_LOCK_WARMUP_MS;
                    const minLockSatisfied = elapsedMs >= LIVE_MIN_LOCK_MS;

                    if (warmupSatisfied && minLockSatisfied && Number(liveStableRef.current.frames || 0) >= LIVE_REQUIRED_LOCK_FRAMES) {
                        const stableAverageConfidence = Number(liveStableRef.current.frames || 0) > 0
                            ? Number(liveStableRef.current.confidenceSum || 0) / Number(liveStableRef.current.frames || 1)
                            : Number(liveStableRef.current.confidence || 0);
                        if (stableAverageConfidence < LIVE_MIN_CONFIDENCE) return;
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
                await setNativeCameraTorchEnabled(initialTorchEnabled);
                nativePreviewActiveRef.current = true;
                setLiveCameraActive(true);
                setLiveEngine('native-preview');
                setScanState((prev) => ({ ...prev, loading: true }));
                runScanLoop();
                return;
            } catch (_) {
                nativePreviewActiveRef.current = false;
                setScanState({ loading: false, text: captureOnly ? '' : (supportsManualCaptureMode ? 'Native camera preview failed. Enter VRM manually.' : 'Native camera preview failed. Try scan again.'), confidence: 0 });
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

            const [videoTrack] = stream.getVideoTracks();
            if (videoTrack) {
                liveVideoTrackRef.current = videoTrack;
                await setWebTrackTorch(videoTrack, initialTorchEnabled);
            }

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
        if (!permitChecked) {
            setScanState({
                loading: false,
                text: permitChecking
                    ? 'E-permit check in progress. Please wait before creating a draft.'
                    : 'Complete e-permit check first before creating a draft.',
                confidence: 0,
            });
            return;
        }

        if (!vrm || (!skipCapture && (files.length === 0 || !hasRequiredCaptureArtifacts(files)))) {
            setScanState({
                loading: false,
                text: requiresOcrArtifacts
                    ? 'Capture needs full vehicle, plate cutout, and VRM text.'
                    : 'Capture at least 1 entry image, then enter VRM manually.',
                confidence: 0,
            });
            return;
        }
        onComplete?.({
            vrm: normalizeVrm(vrm),
            siteId: defaultSiteId,
            siteName: selectedSiteName,
            contraventionCode,
            contraventionLabel: getContraventionSelectionLabel(selectedContravention),
            observationMinutes,
            files,
            scan: {
                plateText: stableCapturedVrm,
                confidence: Number(scanState.confidence || 0),
                cutoffImage: String(files?.[0]?.detectedPlateCutoffImage || ''),
                bbox: files?.[0]?.detectedPlateBbox || null,
            },
            captureMode,
            skippedCapture: skipCapture,
            note,
        });
        reset();
    }

    function handleCaptureOnlyComplete() {
        if (!files.length) {
            setScanState({ loading: false, text: 'Capture at least 1 image to continue.', confidence: 0 });
            return;
        }
        if (requiresOcrArtifacts && !hasRequiredCaptureArtifacts(files)) {
            setScanState({
                loading: false,
                text: evidencePhase === 'closing' ? 'Capture needs full vehicle, plate cutout, and VRM text.' : 'Capture needs full vehicle, plate cutout, and VRM text.',
                confidence: 0,
            });
            return;
        }
        onCaptureComplete?.({
            phase: evidencePhase,
            files,
            previews,
            captureMode,
            scan: {
                plateText: stableCapturedVrm,
                confidence: Number(scanState.confidence || 0),
                cutoffImage: String(files?.[0]?.detectedPlateCutoffImage || ''),
                bbox: files?.[0]?.detectedPlateBbox || null,
            },
        });
        reset();
    }

    function openCamera() {
        cameraInputRef.current?.click();
    }

    function openGallery() {
        galleryInputRef.current?.click();
    }

    function handleDeleteCapturedImage(index) {
        const targetIndex = Math.max(0, Number(index) || 0);
        if (!files.length || targetIndex >= files.length) return;

        const nextFiles = files.filter((_, fileIndex) => fileIndex !== targetIndex);
        const nextPreviews = previews.filter((_, previewIndex) => previewIndex !== targetIndex);
        setFiles(nextFiles);
        setPreviews(nextPreviews);

        if (!nextFiles.length) {
            setCapturedVrm('');
            setScanState({ loading: false, text: '', confidence: 0 });
            return;
        }

        const nextDetected = nextFiles.find((file) => Boolean(normalizeVrm(file?.detectedPlateText || ''))) || null;
        const nextDetectedVrm = normalizeVrm(nextDetected?.detectedPlateText || '');
        if (nextDetectedVrm) {
            setCapturedVrm(nextDetectedVrm);
            setScanState({
                loading: false,
                text: nextDetectedVrm,
                confidence: Number(nextDetected?.detectedPlateConfidence || 0),
            });
            return;
        }

        setCapturedVrm('');
        setScanState({ loading: false, text: '', confidence: 0 });
    }

    // Step validations
    const hasCapturePair = skipCapture ? true : hasRequiredCaptureArtifacts(files);
    const hasContraventionChoice = Boolean(String(contraventionCode || '').trim());
    const canAdvanceFromCapture = Boolean(files.length > 0);
    const canAdvanceFromVrm = Boolean(normalizeVrm(vrm) && hasContraventionChoice && (skipCapture || (files.length > 0 && hasCapturePair)));
    const canConfirm = Boolean(normalizeVrm(vrm) && hasContraventionChoice && (skipCapture || (files.length > 0 && hasCapturePair)));
    const permitBlocksCreation = permitCheck.status === 'matched' && permitCheck.hasPermit;
    const permitChecked = permitCheck.status === 'matched' || permitCheck.status === 'not_matched';
    const permitChecking = permitCheck.status === 'checking';
    const canProceedToConfirm = canAdvanceFromVrm && permitChecked;
    const canCreatePcn = canConfirm && permitChecked && !permitChecking;
    const permitIndicatorClass = [
        'stepper-permit-indicator',
        permitCheck.status === 'matched'
            ? 'stepper-permit-indicator--ok'
            : (permitCheck.status === 'not_matched'
                ? 'stepper-permit-indicator--none'
                : (permitCheck.status === 'checking'
                    ? 'stepper-permit-indicator--checking'
                    : ((permitCheck.status === 'error' || permitCheck.status === 'missing')
                        ? 'stepper-permit-indicator--error'
                        : ''))),
    ].filter(Boolean).join(' ');
    const permitIndicatorTitle = permitCheck.status === 'matched'
        ? 'Permit matched: review contravention'
        : (permitCheck.status === 'not_matched'
            ? 'No permit matched'
            : (permitCheck.status === 'checking' ? 'Checking permit' : 'Permit check status'));
    const permitIndicatorMessage = permitCheck.message || 'Permit check runs automatically once VRM and site are available.';
    const permitMatchScore = Number(permitCheck?.matchConfidence?.scorePercent || 0);
    const permitMatchVrm = String(permitCheck?.matchConfidence?.bestVrm || '').trim();
    const normalizedVrmValue = normalizeVrm(vrm);
    const canUseDetectedVrm = Boolean(stableCapturedVrm && stableCapturedVrm !== normalizedVrmValue);

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
                <div className="stepper-live-controls">
                    <div className="stepper-live-info">
                        <div className="stepper-live-site">
                            {selectedSiteName}
                        </div>
                        {scanState.text ? (
                            <div className="stepper-live-detected">Detected: {scanState.text} ({Math.round(scanState.confidence)}%)</div>
                        ) : (
                            <div className="stepper-live-hint">Point camera at number plate</div>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={stopLiveCamera}
                        className="stepper-live-btn stepper-live-btn--cancel"
                    >
                        Cancel
                    </button>
                    {nightModeActive ? (
                        <button
                            type="button"
                            onClick={toggleAutoNightTorch}
                            className={`stepper-live-btn stepper-live-btn--auto ${autoNightTorchEnabled ? 'is-active' : ''}`}
                        >
                            Auto night flash: {autoNightTorchEnabled ? 'On' : 'Off'}
                        </button>
                    ) : null}
                    {nightModeActive ? (
                        <button
                            type="button"
                            onClick={toggleFlashlight}
                            className={`stepper-live-btn stepper-live-btn--flash ${torchEnabled ? 'is-active' : ''}`}
                        >
                            {torchEnabled ? 'Flash on' : 'Flash off'}
                        </button>
                    ) : null}
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
                    ref={cameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    onChange={handleFileCapture}
                    className="file-input"
                />

                <input
                    ref={galleryInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFileCapture}
                    className="file-input"
                />

                {/* Step 0: Entry evidence capture first */}
                {step === 0 ? (
                    <div className="stepper-step">
                        <p className="stepper-step-label">Step 1 — Capture {evidenceLabel.toLowerCase()} evidence image</p>
                        {supportsManualCaptureMode ? (
                            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                                <button
                                    type="button"
                                    className={captureMode === 'scan' ? 'primary-button' : 'secondary-button'}
                                    onClick={() => setCaptureModeSafely('scan')}
                                >
                                    OCR scan
                                </button>
                                <button
                                    type="button"
                                    className={captureMode === 'manual' ? 'primary-button' : 'secondary-button'}
                                    onClick={() => setCaptureModeSafely('manual')}
                                >
                                    Manual capture
                                </button>
                            </div>
                        ) : null}
                        <div className="stepper-fixed-site">
                            <span className="stepper-fixed-site-label">Patrol site</span>
                            <strong className="stepper-fixed-site-value">
                                {selectedSiteName}
                            </strong>
                        </div>

                        {/* Hide image preview grid in quick-capture mode — VRM confirmation shows preview instead */}
                        {!captureOnly && previews.length > 0 ? (
                            <div className="stepper-preview-grid">
                                {previews.map((p, i) => (
                                    <div key={i} className="stepper-preview-tile">
                                        <img src={p} alt={`Entry evidence ${i + 1}`} className="stepper-preview-img" />
                                        <button
                                            type="button"
                                            className="stepper-preview-remove"
                                            onClick={() => handleDeleteCapturedImage(i)}
                                            title="Delete image"
                                        >
                                            Remove image
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="stepper-capture-prompt">
                                <span className="stepper-capture-icon">📸</span>
                                {requiresOcrArtifacts ? (
                                    <>
                                        <p>Use OCR scan mode to auto-capture the plate and evidence.</p>
                                        <p className="text-muted">Switch to Manual capture tab if OCR is not suitable.</p>
                                    </>
                                ) : (
                                    <>
                                        <p>Tap the button below to upload images from gallery.</p>
                                        <p className="text-muted">Use circumstantial images when no clear plate is available.</p>
                                        <button
                                            type="button"
                                            className="ghost-button"
                                            onClick={openGallery}
                                            style={{ marginTop: 6 }}
                                        >
                                            Upload from gallery
                                        </button>
                                    </>
                                )}
                            </div>
                        )}

                        {scanState.loading && !(captureOnly && autoStartScan) ? <div className="text-muted">Scanning image for VRM...</div> : null}
                        {!scanState.loading && files.length > 0 && !hasCapturePair && evidencePhase !== 'closing' && requiresOcrArtifacts ? (
                            <div className="text-muted" style={{ color: '#ffbf47' }}>
                                Full vehicle captured. Plate cutout missing - recapture plate to continue.
                            </div>
                        ) : null}

                        <div className="stepper-nav">
                            <button type="button" className="ghost-button" onClick={handleClose}>Cancel</button>
                            <div className="stepper-nav-actions">
                                {requiresOcrArtifacts ? (
                                    <button
                                        type="button"
                                        className="secondary-button"
                                        onClick={liveCameraActive ? stopLiveCamera : startLiveCamera}
                                    >
                                        {liveCameraActive ? 'Stop scan image' : 'Scan image'}
                                    </button>
                                ) : null}
                                {!requiresOcrArtifacts ? (
                                    <button
                                        type="button"
                                        className="secondary-button"
                                        onClick={openCamera}
                                    >
                                        Capture image
                                    </button>
                                ) : null}
                                {!captureOnly && evidencePhase === 'entry' ? (
                                    <button
                                        type="button"
                                        className="ghost-button"
                                        onClick={handleSkipCapture}
                                    >
                                        Skip image capture
                                    </button>
                                ) : null}
                                {canAdvanceFromCapture && (!captureOnly || !autoStartScan) ? (
                                    <button
                                        type="button"
                                        className="primary-button"
                                        disabled={requiresOcrArtifacts ? !hasCapturePair : files.length === 0}
                                        onClick={captureOnly ? handleCaptureOnlyComplete : () => setStep(1)}
                                    >
                                        {(requiresOcrArtifacts ? hasCapturePair : files.length > 0)
                                            ? (captureOnly ? `Use ${evidenceLabel.toLowerCase()} evidence` : 'Next — Vehicle details →')
                                            : (evidencePhase === 'closing'
                                                ? (requiresOcrArtifacts ? 'Need plate cutout to continue' : 'Capture at least 1 image')
                                                : (requiresOcrArtifacts ? 'Need plate cutout to continue' : 'Capture at least 1 image'))}
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
                        <label className="stepper-field">
                            <span className="stepper-field-label">VRM (registration)</span>
                            <input
                                className="stepper-vrm-input"
                                value={vrm}
                                onChange={(e) => setVrm(normalizeVrm(e.target.value))}
                                placeholder="AB12CDE"
                                inputMode="text"
                                autoCapitalize="characters"
                                spellCheck={false}
                                maxLength={8}
                                autoFocus
                            />
                            <div className="stepper-vrm-actions">
                                <button
                                    type="button"
                                    className="ghost-button stepper-vrm-action"
                                    onClick={() => setVrm('')}
                                    disabled={!normalizedVrmValue}
                                >
                                    Clear
                                </button>
                                <button
                                    type="button"
                                    className="ghost-button stepper-vrm-action"
                                    onClick={() => setVrm(stableCapturedVrm)}
                                    disabled={!canUseDetectedVrm}
                                >
                                    Use OCR: {stableCapturedVrm || 'N/A'}
                                </button>
                            </div>
                        </label>

                        <div className={permitIndicatorClass}>
                            <div className="stepper-permit-indicator-title">{permitIndicatorTitle}</div>
                            <div className="stepper-permit-indicator-message">{permitIndicatorMessage}</div>
                            {permitMatchScore > 0 && permitMatchVrm ? (
                                <div className="auth-match-pill" role="status" aria-label="Closest exemption match confidence">
                                    <span className="auth-match-pill-label">Closest exemption match</span>
                                    <span className="auth-match-pill-vrm">{permitMatchVrm}</span>
                                    <span className="auth-match-pill-score">{permitMatchScore}%</span>
                                </div>
                            ) : null}
                        </div>

                        <label className="stepper-field">
                            <span className="stepper-field-label">Contravention</span>
                            <select className="stepper-select" value={contraventionCode} onChange={(e) => { setContraventionCode(e.target.value); setContraventionTouched(true); }}>
                                {!contraventions.length ? (
                                    <option value="">No enabled contraventions for this site</option>
                                ) : null}
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
                                <button
                                    type="button"
                                    className="primary-button"
                                    onClick={() => setStep(2)}
                                    disabled={!canProceedToConfirm}
                                >
                                    {permitChecking
                                        ? 'Checking e-permit...'
                                        : permitBlocksCreation
                                            ? 'Permit matched - proceed only if contravention applies'
                                            : canProceedToConfirm
                                                ? 'Next — Confirm →'
                                                : (!hasContraventionChoice
                                                    ? 'Select site contravention to continue'
                                                    : (permitCheck.status === 'error'
                                                        ? 'E-permit check failed - edit VRM to retry'
                                                        : 'Waiting for e-permit check...'))}
                                </button>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Step 2: Confirm */}
                {!captureOnly && step === 2 ? (
                    <div className="stepper-step">
                        <p className="stepper-step-label">Step 3 — Confirm Parking Charge</p>

                        <div className="stepper-summary-card stepper-summary-card--final">
                            <div className="stepper-summary-intro">Review these details before creating the draft parking charge.</div>
                            <div className="stepper-summary-row stepper-summary-row--vrm">
                                <span className="stepper-summary-label">VRM</span>
                                <div className="stepper-summary-vrm-edit">
                                    <input
                                        className="stepper-vrm-input stepper-vrm-input--summary"
                                        value={vrm}
                                        onChange={(e) => setVrm(normalizeVrm(e.target.value))}
                                        placeholder="AB12CDE"
                                        inputMode="text"
                                        autoCapitalize="characters"
                                        spellCheck={false}
                                        maxLength={8}
                                    />
                                    <button
                                        type="button"
                                        className="ghost-button stepper-vrm-action"
                                        onClick={() => setVrm(stableCapturedVrm)}
                                        disabled={!canUseDetectedVrm}
                                    >
                                        Reset OCR
                                    </button>
                                </div>
                            </div>
                            <div className="stepper-summary-row">
                                <span className="stepper-summary-label">Site</span>
                                <span className="stepper-summary-val">{selectedSiteName}</span>
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
                            <div className={permitIndicatorClass}>
                                <div className="stepper-permit-indicator-title">{permitIndicatorTitle}</div>
                                <div className="stepper-permit-indicator-message">{permitIndicatorMessage}</div>
                                {permitMatchScore > 0 && permitMatchVrm ? (
                                    <div className="auth-match-pill" role="status" aria-label="Closest exemption match confidence">
                                        <span className="auth-match-pill-label">Closest exemption match</span>
                                        <span className="auth-match-pill-vrm">{permitMatchVrm}</span>
                                        <span className="auth-match-pill-score">{permitMatchScore}%</span>
                                    </div>
                                ) : null}
                                {permitBlocksCreation ? (
                                    <div className="stepper-permit-indicator-actions">
                                        <button
                                            type="button"
                                            className="ghost-button stepper-cancel-draft-btn"
                                            onClick={handleClose}
                                        >
                                            Cancel draft
                                        </button>
                                    </div>
                                ) : null}
                            </div>
                            {previews.length > 0 ? (
                                <div className="stepper-preview-grid stepper-preview-grid--compact">
                                    {previews.slice(0, 3).map((p, i) => (
                                        <div key={i} className="stepper-preview-tile">
                                            <img src={p} alt={`Preview ${i + 1}`} className="stepper-preview-img stepper-preview-img--compact" />
                                            <button
                                                type="button"
                                                className="stepper-preview-remove"
                                                onClick={() => handleDeleteCapturedImage(i)}
                                                title="Delete image"
                                            >
                                                Remove image
                                            </button>
                                        </div>
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
                                disabled={!canCreatePcn}
                                onClick={handleConfirm}
                            >
                                {permitChecking
                                    ? 'Checking permit...'
                                    : (permitBlocksCreation ? 'Create Parking Charge (Permit matched)' : 'Create Parking Charge')}
                            </button>
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
