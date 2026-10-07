import { useRef, useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { formatLocalTimestamp } from '../lib/ukTimestamp';
import { isMlKitReady, scanPlateWithMlKit } from '../lib/mlkitLpr';
import { canUseNativeCameraPreview, captureNativeCameraSample, setNativeCameraTorchEnabled, startNativeCameraPreview, stopNativeCameraPreview } from '../lib/nativeCameraPreview';
import { getServerTimestamp } from '../lib/timeSync';
import { buildPermitReviewDecision, hasPendingPermit, needsNearMatchDecision } from '../lib/vrmMatch.mjs';
import { NearMatchConfirmSheet, PermitStatusBanner } from './PermitStatus';

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

function fitHeaderFont(ctx, text, maxWidth, initialSize, minSize = 10) {
    let size = Math.max(minSize, Math.round(initialSize));
    while (size > minSize) {
        ctx.font = `600 ${size}px "Roboto Mono", "Courier New", monospace`;
        if (ctx.measureText(text).width <= maxWidth) return size;
        size -= 1;
    }
    return minSize;
}

async function stampEvidenceImage(file, { capturedAt, phase, vrmText = '' } = {}) {
    if (!file || !(file.type || '').startsWith('image/')) return file;

    try {
        const image = await loadImageElement(file);
        const imageWidth = image.naturalWidth || image.width;
        const imageHeight = image.naturalHeight || image.height;
        if (!imageWidth || !imageHeight) return file;

        const isPlateCutout = String(phase || '').toLowerCase() === 'plate';
        const normalizedVrm = normalizeVrm(vrmText || file?.detectedPlateText || '');
        const localCaptured = formatEvidenceLocalTimestamp(capturedAt);
        const headerLine = normalizedVrm
            ? `VRM ${normalizedVrm} | Captured ${localCaptured}`
            : `VRM pending OCR | Captured ${localCaptured}`;

        const headerPadX = Math.max(8, Math.floor(imageWidth * 0.01));
        const headerPadY = Math.max(8, Math.floor(imageHeight * 0.01));
        const maxTextWidth = Math.max(48, imageWidth - (headerPadX * 2));

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 8;
        tempCanvas.height = 8;
        const tempCtx = tempCanvas.getContext('2d');
        if (!tempCtx) return file;

        const headerFont = fitHeaderFont(
            tempCtx,
            headerLine,
            maxTextWidth,
            isPlateCutout ? Math.max(16, Math.min(26, Math.floor(imageWidth / 38))) : Math.max(17, Math.min(27, Math.floor(imageWidth / 35))),
            14
        );

        const measuredHeaderHeight = (headerPadY * 2) + headerFont + 2;
        const headerHeight = Math.min(72, Math.max(32, measuredHeaderHeight));

        const canvas = document.createElement('canvas');
        canvas.width = imageWidth;
        canvas.height = imageHeight + headerHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx || !canvas.width || !canvas.height) return file;

        // Header band keeps metadata outside the actual captured image frame.
        ctx.fillStyle = 'rgba(5, 10, 18, 0.92)';
        ctx.fillRect(0, 0, imageWidth, headerHeight);
        ctx.strokeStyle = 'rgba(220, 235, 255, 0.26)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, headerHeight - 0.5);
        ctx.lineTo(imageWidth, headerHeight - 0.5);
        ctx.stroke();

        ctx.textBaseline = 'top';
        ctx.fillStyle = normalizedVrm ? '#8bd0ff' : '#e5eef9';
        ctx.font = `700 ${headerFont}px "Roboto Mono", "Courier New", monospace`;
        ctx.fillText(headerLine, headerPadX, headerPadY);

        // Original photo is drawn below the header without any overlap.
        ctx.drawImage(image, 0, headerHeight, imageWidth, imageHeight);

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
const LIVE_SCAN_MAX_DIMENSION = 1280;

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
    sites = [],
    contraventions = [],
    selectedSiteId: defaultSiteId = '',
    onPlateScan,
    mode = 'full',
    capturePhase = 'entry',
    forceScanMode = false,
    autoStartScan = false,
    autoCompleteOnCapture = false,
    hideCapturedPreview = false,
    quickFlow = false,
    onPermitCheck = null,
}) {
    const captureOnly = mode === 'capture-only';
    const evidencePhase = capturePhase === 'closing' ? 'closing' : 'entry';
    const evidenceLabel = evidencePhase === 'closing' ? 'Closing' : 'Entry';
    const isQuickOcrFlow = Boolean(captureOnly && quickFlow);
    const supportsManualCaptureMode = !forceScanMode;
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
    // Permit check for the VRM being drafted: { loading, vrm, result, error }
    const [permitCheck, setPermitCheck] = useState({ loading: false, vrm: '', result: null, error: '' });
    const [permitDecision, setPermitDecision] = useState(null);
    const [nearMatchOpen, setNearMatchOpen] = useState(false);
    const permitRequestRef = useRef(0);
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
    const nativePreviewActiveRef = useRef(false);
    const mlkitReadyRef = useRef(false);

    const normalizeVrm = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const stableCapturedVrm = normalizeVrm(vrm || capturedVrm || scanState.text);
    const requiresOcrArtifacts = forceScanMode || (supportsManualCaptureMode && captureMode !== 'manual');

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
        setCaptureMode(supportsManualCaptureMode ? 'scan' : 'manual');
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
        permitRequestRef.current += 1;
        setPermitCheck({ loading: false, vrm: '', result: null, error: '' });
        setPermitDecision(null);
        setNearMatchOpen(false);
        setLiveCameraActive(false);
        if (cameraInputRef.current) cameraInputRef.current.value = '';
        if (galleryInputRef.current) galleryInputRef.current.value = '';
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
        setCaptureMode(forceScanMode ? 'scan' : (supportsManualCaptureMode ? 'scan' : 'manual'));
    }, [open, supportsManualCaptureMode, forceScanMode]);

    useEffect(() => {
        if (!open || !captureOnly || !autoStartScan || !requiresOcrArtifacts) return;
        if (liveCameraActive) return;
        startLiveCamera().catch(() => null);
    }, [open, captureOnly, autoStartScan, requiresOcrArtifacts, liveCameraActive]);

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
        const shouldBuildCapturePreviews = !(captureOnly && autoCompleteOnCapture && isQuickOcrFlow);

        if (!skipOcr && !initialScanResult) {
            setScanState((prev) => ({
                ...prev,
                loading: true,
                text: isQuickOcrFlow ? 'Preparing image for OCR...' : 'Scanning image for VRM...',
                confidence: 0,
            }));
        }

        const fallbackCapturedAt = await getServerTimestamp();
        const stampedCaptured = await Promise.all(
            captured.map(async (file) => {
                const capturedAt = await resolveCameraCaptureTimestamp(file, fallbackCapturedAt);
                const stamped = await stampEvidenceImage(file, { capturedAt, phase: evidencePhase });
                stamped.capturedAt = normalizeCapturedAt(capturedAt) || fallbackCapturedAt;
                return stamped;
            })
        );

        const resolved = shouldBuildCapturePreviews
            ? await Promise.all(
                stampedCaptured.map(async (file) => {
                    try {
                        return await fileToDataUrl(file);
                    } catch (_) {
                        return '';
                    }
                })
            )
            : [];
        const newPreviews = resolved.filter(Boolean);
        const nextFiles = [...stampedCaptured];
        const nextPreviews = [...newPreviews];

        let result = initialScanResult;
        if (!skipOcr && !result && captured[0]) {
            try {
                setScanState((prev) => ({
                    ...prev,
                    loading: true,
                    text: 'Extracting plate text...',
                }));
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
                const stampedCutoff = await stampEvidenceImage(cutoffFile, {
                    capturedAt: cutoffCapturedAt,
                    phase: 'plate',
                    vrmText: result?.plateText || '',
                });
                stampedCutoff.capturedAt = cutoffCapturedAt;
                const stampedCutoffPreview = shouldBuildCapturePreviews ? await fileToDataUrl(stampedCutoff) : '';
                nextFiles.push(stampedCutoff);
                if (shouldBuildCapturePreviews) {
                    nextPreviews.push(stampedCutoffPreview || result.cutoffImage);
                }
                result.cutoffImage = stampedCutoffPreview || result.cutoffImage;
            }
            if (nextFiles[0]) {
                nextFiles[0].detectedPlateCutoffImage = result.cutoffImage;
            }
        }

        const mergedFiles = evidencePhase === 'closing' ? [...files, ...nextFiles] : [...nextFiles];
        const mergedPreviews = evidencePhase === 'closing' ? [...previews, ...nextPreviews] : [...nextPreviews];

        setFiles((prev) => [...prev, ...nextFiles]);
        setPreviews((prev) => [...prev, ...nextPreviews]);
        if (nextFiles.length > 0) {
            setSkipCapture(false);
        }

        const hasPairArtifacts = hasRequiredCaptureArtifacts(mergedFiles);
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

        if (captureOnly && autoCompleteOnCapture) {
            onCaptureComplete?.({
                phase: evidencePhase,
                files: mergedFiles,
                previews: mergedPreviews,
                captureMode,
                scan: {
                    plateText: normalizeVrm(result?.plateText || stableCapturedVrm || ''),
                    confidence: Number(result?.confidence || scanState.confidence || 0),
                    cutoffImage: String(mergedFiles?.[0]?.detectedPlateCutoffImage || result?.cutoffImage || ''),
                    bbox: mergedFiles?.[0]?.detectedPlateBbox || result?.bbox || null,
                },
            });
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
                    setScanState({ loading: false, text: 'No plate detected. Enter VRM manually.', confidence: 0 });
                    setStep(1);
                    return;
                }
                stopLiveCamera();
                const appendedWithPair = await appendCapturedFiles([fallbackFrame], null, {
                    allowWebFallback: true,
                    skipOcr: false,
                });
                if (!appendedWithPair) {
                    setScanState({ loading: false, text: 'No plate detected. Enter VRM manually.', confidence: 0 });
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

                        const dominantEdge = Math.max(width, height);
                        const scale = dominantEdge > LIVE_SCAN_MAX_DIMENSION
                            ? (LIVE_SCAN_MAX_DIMENSION / dominantEdge)
                            : 1;
                        const scanWidth = Math.max(1, Math.round(width * scale));
                        const scanHeight = Math.max(1, Math.round(height * scale));

                        currentCanvas.width = scanWidth;
                        currentCanvas.height = scanHeight;
                        const ctx = currentCanvas.getContext('2d');
                        if (!ctx) return;
                        ctx.drawImage(currentVideo, 0, 0, scanWidth, scanHeight);

                        const blob = await new Promise((resolve) => currentCanvas.toBlob(resolve, 'image/jpeg', 0.84));
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

    const permitCheckAvailable = Boolean(!captureOnly && typeof onPermitCheck === 'function' && defaultSiteId);
    const permitResultForVrm = permitCheck.result && permitCheck.vrm === normalizeVrm(vrm) ? permitCheck.result : null;
    const permitDecisionForVrm = permitDecision && permitDecision.targetVrm === normalizeVrm(vrm) ? permitDecision : null;
    const permitNeedsReview = Boolean(permitResultForVrm && needsNearMatchDecision(permitResultForVrm, permitDecisionForVrm));

    /**
     * Run the shared permit lookup (includes misread-plate detection) for the
     * VRM being drafted. Safe to call repeatedly; stale responses are ignored.
     */
    async function runStepperPermitCheck(targetVrm, { force = false } = {}) {
        const normalized = normalizeVrm(targetVrm);
        if (!permitCheckAvailable || !normalized || normalized.length < 5) return null;
        if (!force && permitCheck.vrm === normalized && (permitCheck.loading || permitCheck.result)) {
            return permitCheck.result;
        }
        const requestId = permitRequestRef.current + 1;
        permitRequestRef.current = requestId;
        setPermitCheck({ loading: true, vrm: normalized, result: null, error: '' });
        try {
            const result = await onPermitCheck(normalized, defaultSiteId);
            if (permitRequestRef.current !== requestId) return null;
            // #region agent log
            fetch('http://127.0.0.1:7816/ingest/d49109f6-c502-46e9-b8e2-2c14a52f8d97',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f2c557'},body:JSON.stringify({sessionId:'f2c557',runId:'pre-fix',hypothesisId:'B',location:'BreachStepper.js:runStepperPermitCheck',message:'stepper permit check result',data:{vrm:normalized,hasAuthorization:Boolean(result?.hasAuthorization),nearMatch:Boolean(result?.nearMatch),bestVrm:result?.matchConfidence?.bestVrm||'',scorePercent:result?.matchConfidence?.scorePercent||0,needsReview:needsNearMatchDecision(result)},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
            setPermitCheck({ loading: false, vrm: normalized, result: result || null, error: result ? '' : 'Permit check returned no result.' });
            return result || null;
        } catch (error) {
            if (permitRequestRef.current !== requestId) return null;
            setPermitCheck({ loading: false, vrm: normalized, result: null, error: String(error?.message || 'Permit check failed. You can retry on the next step.') });
            return null;
        }
    }

    function buildAuthorizationForDraft(resultOverride = null, decisionOverride = null) {
        const result = resultOverride || permitResultForVrm;
        if (!result) return null;
        const decision = decisionOverride || permitDecisionForVrm;
        return decision ? { ...result, permitReviewDecision: decision } : result;
    }

    function completeDraft({ authorizationOverride = null } = {}) {
        const authorization = authorizationOverride || buildAuthorizationForDraft();
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
            authorization,
            permitReviewDecision: authorization?.permitReviewDecision || null,
        });
        reset();
    }

    function handleConfirm() {
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
        if (permitNeedsReview) {
            // #region agent log
            fetch('http://127.0.0.1:7816/ingest/d49109f6-c502-46e9-b8e2-2c14a52f8d97',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f2c557'},body:JSON.stringify({sessionId:'f2c557',runId:'pre-fix',hypothesisId:'E',location:'BreachStepper.js:handleConfirm',message:'create blocked until registration is reviewed',data:{vrm:normalizeVrm(vrm),bestVrm:permitResultForVrm?.matchConfidence?.bestVrm||'',scorePercent:permitResultForVrm?.matchConfidence?.scorePercent||0},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
            setNearMatchOpen(true);
            return;
        }
        completeDraft();
    }

    async function handleNearMatchUseMatched(matchedVrm) {
        const nextVrm = normalizeVrm(matchedVrm);
        if (!nextVrm) return;
        setNearMatchOpen(false);
        setPermitDecision(null);
        setVrm(nextVrm);
        setCapturedVrm(nextVrm);
        await runStepperPermitCheck(nextVrm, { force: true });
    }

    function handleNearMatchKeep() {
        if (!permitResultForVrm) {
            setNearMatchOpen(false);
            return;
        }
        const decision = buildPermitReviewDecision({ result: permitResultForVrm, decision: 'keep', targetVrm: normalizeVrm(vrm) });
        setPermitDecision(decision);
        setNearMatchOpen(false);
        completeDraft({ authorizationOverride: buildAuthorizationForDraft(permitResultForVrm, decision) });
    }

    function handleCaptureOnlyComplete() {
        const hasCaptureArtifacts = hasRequiredCaptureArtifacts(files);

        if (!files.length || !hasCaptureArtifacts) {
            setScanState({
                loading: false,
                text: evidencePhase === 'closing'
                    ? (requiresOcrArtifacts
                        ? 'Capture needs full vehicle, plate cutout, and VRM text.'
                        : 'Capture at least 1 closing evidence image.')
                    : (requiresOcrArtifacts
                        ? 'Capture needs full vehicle, plate cutout, and VRM text.'
                        : 'Capture at least 1 entry evidence image.'),
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
    const quickOcrStatusLabel = isQuickOcrFlow
        ? (liveCameraActive
            ? 'OCR scanner active'
            : (scanState.loading ? 'Extracting plate text...' : 'Preparing OCR scanner...'))
        : '';
    const quickOcrPromptText = isQuickOcrFlow
        ? (liveCameraActive
            ? 'Point camera at the number plate. Capture runs automatically when lock is stable.'
            : (scanState.loading
                ? (scanState.text || 'Extracting plate text from captured image...')
                : 'Launching OCR camera...'))
        : 'Use OCR scan mode to auto-capture the plate and evidence.';

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
                    <h3 className="stepper-title">{isQuickOcrFlow ? 'Quick OCR capture' : (captureOnly ? `${evidenceLabel} evidence capture` : 'Draft Parking Charge')}</h3>
                    {!isQuickOcrFlow ? (
                        <div className="stepper-dots">
                            {(captureOnly ? [0] : [0, 1, 2]).map((i) => (
                                <span
                                    key={i}
                                    className={`stepper-dot ${step === i ? 'stepper-dot-active' : ''} ${step > i ? 'stepper-dot-done' : ''}`}
                                />
                            ))}
                        </div>
                    ) : null}
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
                        {!isQuickOcrFlow ? (
                            <p className="stepper-step-label">Step 1 — Capture {evidenceLabel.toLowerCase()} evidence image</p>
                        ) : (
                            <p className="stepper-step-label">{quickOcrStatusLabel}</p>
                        )}
                        {supportsManualCaptureMode && !isQuickOcrFlow ? (
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

                        {previews.length > 0 && !(captureOnly && hideCapturedPreview) && !(isQuickOcrFlow && scanState.loading) ? (
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
                                {requiresOcrArtifacts ? (
                                    <>
                                        <p>{quickOcrPromptText}</p>
                                        {!isQuickOcrFlow ? <p className="text-muted">Switch to Manual capture tab if OCR is not suitable.</p> : null}
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

                        {scanState.loading ? (
                            <div
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 12,
                                    padding: '14px 16px',
                                    marginTop: 10,
                                    borderRadius: 14,
                                    border: '1px solid rgba(255,255,255,0.10)',
                                    background: 'rgba(13, 19, 30, 0.68)',
                                }}
                                role="status"
                                aria-live="polite"
                            >
                                <div>
                                    <div style={{ fontWeight: 600 }}>{scanState.text || 'Scanning image for VRM...'}</div>
                                    <div className="text-muted">Keep the vehicle steady while OCR finishes.</div>
                                    <progress max="100" style={{ width: '100%', marginTop: 8, height: 8 }} />
                                </div>
                            </div>
                        ) : null}
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
                                        {liveCameraActive ? 'Stop scan image' : (isQuickOcrFlow ? 'Retry OCR scan' : 'Scan image')}
                                    </button>
                                ) : null}
                                {isQuickOcrFlow && !liveCameraActive ? (
                                    <button
                                        type="button"
                                        className="secondary-button"
                                        onClick={openCamera}
                                    >
                                        Upload fallback image
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
                                {canAdvanceFromCapture ? (
                                    <button
                                        type="button"
                                        className="primary-button"
                                        disabled={!hasCapturePair}
                                        onClick={captureOnly ? handleCaptureOnlyComplete : () => setStep(1)}
                                        style={isQuickOcrFlow ? { display: 'none' } : undefined}
                                    >
                                        {hasCapturePair
                                            ? (captureOnly ? `Use ${evidenceLabel.toLowerCase()} evidence` : 'Next — Vehicle details →')
                                            : (evidencePhase === 'closing'
                                                ? (requiresOcrArtifacts ? 'Need plate cutout to continue' : 'Need closing evidence image')
                                                : (requiresOcrArtifacts ? 'Need plate cutout to continue' : 'Need entry evidence image'))}
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
                                onBlur={() => { runStepperPermitCheck(vrm).catch(() => null); }}
                                placeholder="AB12CDE"
                                autoFocus
                            />
                        </label>
                        {permitCheckAvailable && (permitCheck.loading || permitResultForVrm) ? (
                            <div style={{ marginBottom: 10 }}>
                                {permitCheck.loading && permitCheck.vrm === normalizeVrm(vrm) ? (
                                    <span className="pcn-status-pill pcn-status-pill--warn">Checking permit...</span>
                                ) : (
                                    <PermitStatusBanner result={permitResultForVrm} decision={permitDecisionForVrm} compact />
                                )}
                            </div>
                        ) : null}

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
                                    onClick={() => {
                                        setStep(2);
                                        runStepperPermitCheck(vrm).catch(() => null);
                                    }}
                                    disabled={!canAdvanceFromVrm}
                                >
                                    {canAdvanceFromVrm
                                        ? 'Next — Confirm →'
                                        : (hasContraventionChoice ? 'Enter VRM to continue' : 'Select site contravention to continue')}
                                </button>
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
                                <span className="stepper-summary-val" style={{ fontFamily: 'monospace', fontWeight: 800 }}>{stableCapturedVrm || normalizeVrm(vrm)}</span>
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
                            {permitCheckAvailable ? (
                                <div className="stepper-summary-row">
                                    <span className="stepper-summary-label">Permit</span>
                                    <span className="stepper-summary-val">
                                        {permitCheck.loading && permitCheck.vrm === normalizeVrm(vrm)
                                            ? 'Checking...'
                                            : (permitResultForVrm
                                                ? (permitNeedsReview ? 'Needs review' : (permitResultForVrm.hasAuthorization ? 'Permit found' : (hasPendingPermit(permitResultForVrm) ? 'Permit pending' : (permitDecisionForVrm ? 'Reviewed' : 'No permit'))))
                                                : (permitCheck.error ? 'Check failed' : 'Not checked'))}
                                    </span>
                                </div>
                            ) : null}
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

                        {permitCheckAvailable ? (
                            <div className="stepper-permit-panel" style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    <button
                                        type="button"
                                        className="ghost-button"
                                        disabled={permitCheck.loading}
                                        onClick={() => { runStepperPermitCheck(vrm, { force: true }).catch(() => null); }}
                                    >
                                        {permitCheck.loading ? 'Checking permit...' : (permitResultForVrm ? 'Check permit again' : 'Check permit')}
                                    </button>
                                    {permitNeedsReview ? (
                                        <button
                                            type="button"
                                            className="ghost-button"
                                            onClick={() => setNearMatchOpen(true)}
                                        >
                                            Review registration
                                        </button>
                                    ) : null}
                                </div>
                                {permitResultForVrm && !permitCheck.loading ? (
                                    <PermitStatusBanner result={permitResultForVrm} decision={permitDecisionForVrm} />
                                ) : null}
                                {!permitResultForVrm && !permitCheck.loading && permitCheck.error ? (
                                    <div className="notice notice-error">{permitCheck.error}</div>
                                ) : null}
                            </div>
                        ) : null}

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
                                disabled={!canConfirm || permitCheck.loading}
                                onClick={handleConfirm}
                            >
                                {permitCheck.loading
                                    ? 'Checking permit...'
                                    : (permitNeedsReview ? 'Review registration to continue' : 'Create Parking Charge')}
                            </button>
                        </div>

                        <NearMatchConfirmSheet
                            open={nearMatchOpen && Boolean(permitResultForVrm)}
                            result={permitResultForVrm}
                            plateImage={String(files?.[0]?.detectedPlateCutoffImage || previews?.[0] || '').trim()}
                            busy={permitCheck.loading}
                            onUseMatched={handleNearMatchUseMatched}
                            onKeep={handleNearMatchKeep}
                            onClose={() => setNearMatchOpen(false)}
                        />
                    </div>
                ) : null}
            </div>
        </div>
    );
}
