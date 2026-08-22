import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { fetchCameraServiceJson, fetchJson } from '../lib/api';
import {
  clearSession,
  getStoredMobileCameraId,
  getStoredSiteId,
  loadSession,
  restoreSession,
  saveStoredMobileCameraId,
  saveStoredSiteId,
} from '../lib/session';
import { signOutFromWardenApp, getStoredToken, getValidToken } from '../lib/auth';
import { getContraventionOptions } from '../lib/contraventions';
import { getCurrentLocation } from '../lib/geo';
import { buildApiUrl } from '../lib/api';
import { createQueueItem, createSerialTaskQueue, listQueueItems, saveQueueItem, updateQueueItem } from '../lib/queue';
import { formatLocalTimestamp } from '../lib/ukTimestamp';
import { isLikelyCurrentUkVrm, normalizeUkVrmFromOcr, scoreUkVrmCandidate } from '../lib/ukVrmOcr.mjs';
import { getServerTimestamp, syncWithServerTime } from '../lib/timeSync';
import { getBillableMinutes } from '../lib/duration';
import { buildVehicleDetailsRecord } from '../lib/vehicleDetails';
import { isVehicleCameraCandidate } from '../lib/vehicleCameras';
import { buildMobileCameraAssignmentPayload } from '../lib/mobileCameraAssignment';
import AppShell from '../components/AppShell';
import LoadingSpinner from '../components/LoadingSpinner.js';
import LicensePlate from '../components/LicensePlate.js';
import BreachStepper from '../components/BreachStepper';
import PcnPreviewDialog from '../components/PcnPreviewDialog';
import { buildDemoSites, isDemoModeEnabled } from '../lib/demoMode';

function formatElapsed(startIso, endIso = '') {
  const startMs = new Date(startIso || '').getTime();
  if (!Number.isFinite(startMs) || startMs <= 0) return '00:00';

  const endMs = endIso ? new Date(endIso).getTime() : Date.now();
  const diffMs = Math.max(0, endMs - startMs);
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatRemaining(secondsRemaining) {
  const totalSeconds = Math.max(0, Math.floor(Number(secondsRemaining) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function createConcurrencyLimiter(maxConcurrency = 4) {
  const concurrency = Number.isFinite(Number(maxConcurrency)) ? Math.max(1, Math.floor(Number(maxConcurrency))) : 4;
  let activeCount = 0;
  const queue = [];

  const runNext = () => {
    if (activeCount >= concurrency) return;
    const next = queue.shift();
    if (!next) return;

    activeCount += 1;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeCount = Math.max(0, activeCount - 1);
        runNext();
      });
  };

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    runNext();
  });
}

const PCN_SYNC_CONCURRENCY = 1;
const IMAGE_UPLOAD_CONCURRENCY = 1;

function normalizeObservationMinutes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.ceil(numeric);
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

function buildVehicleLookupFingerprint(lookup) {
  if (!lookup || typeof lookup !== 'object') return '';
  return [
    normalizeVrm(lookup.vrm),
    String(lookup.make || '').trim().toUpperCase(),
    String(lookup.model || '').trim().toUpperCase(),
    String(lookup.color || '').trim().toUpperCase(),
    String(lookup.yearOfManufacture || '').trim().toUpperCase(),
    String(lookup.fuelType || '').trim().toUpperCase(),
    String(lookup.imageUrl || lookup.imageUrls?.[0] || '').trim(),
  ].join('|');
}

function hasVehicleLookupEvidence(lookup) {
  if (!lookup || typeof lookup !== 'object') return false;
  const hasImage = Boolean(String(lookup.imageUrl || lookup.savedVehicleImageUrl || '').trim())
    || (Array.isArray(lookup.imageUrls) && lookup.imageUrls.length > 0);
  const hasVehicleFields = [
    lookup.make,
    lookup.model,
    lookup.color,
    lookup.yearOfManufacture,
    lookup.fuelType,
    lookup.bodyStyle,
  ].some((value) => String(value || '').trim().length > 0);
  return hasImage || hasVehicleFields;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('preview_read_failed'));
    reader.readAsDataURL(file);
  });
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

function formatCaptureTimestamp(capturedAt) {
  // Use the device's local timezone so displayed times match the warden's clock.
  // Europe/London (UK-only) is used exclusively for persisted PCN records on the backend.
  return formatLocalTimestamp(capturedAt);
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

    const isPlateCutout = String(phase || '').toLowerCase() === 'plate';
    const stampText = formatCaptureTimestamp(capturedAt);
    let baseFont = 3 * (isPlateCutout
      ? Math.max(10, Math.min(14, Math.floor(canvas.width / 90)))
      : Math.max(11, Math.min(16, Math.floor(canvas.width / 88))));
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

    return new File([blob], file.name, {
      type: blob.type || file.type || 'image/jpeg',
      lastModified: file.lastModified || Date.now(),
    });
  } catch (_) {
    return file;
  }
}

async function toPreviewSrcList(files) {
  const resolved = await Promise.all(
    files.map(async (file) => {
      try {
        return await fileToDataUrl(file);
      } catch (_) {
        return '';
      }
    })
  );
  return resolved.filter(Boolean);
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

async function resolveCameraCaptureTimestamp(file, fallbackIso) {
  const fallback = normalizeCapturedAt(fallbackIso) || new Date().toISOString();
  if (!file || typeof window === 'undefined') return fallback;

  // Use the actual capture moment as the canonical timestamp. EXIF can drift by
  // timezone/DST depending on camera metadata and device behavior.
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

async function resolveImageDimensions(src) {
  const candidate = String(src || '').trim();
  if (!candidate || typeof window === 'undefined') return null;

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      resolve({
        width: Number(image.naturalWidth || image.width || 0),
        height: Number(image.naturalHeight || image.height || 0),
      });
    };
    image.onerror = () => resolve(null);
    image.src = candidate;
  });
}

function normalizeVrm(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const CONFUSABLE_VRM_PAIRS = new Set([
  '0O', 'O0',
  '1I', 'I1',
  '1L', 'L1',
  '2Z', 'Z2',
  '5S', 'S5',
  '8B', 'B8',
]);

function substitutionCost(leftChar, rightChar) {
  if (leftChar === rightChar) return 0;
  if (CONFUSABLE_VRM_PAIRS.has(`${leftChar}${rightChar}`)) return 0.35;
  return 1;
}

function weightedEditDistance(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const subCost = substitutionCost(a[i - 1], b[j - 1]);
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + subCost,
      );
    }
  }

  return dp[rows - 1][cols - 1];
}

function vrmSimilarityPercent(left, right) {
  const a = normalizeVrm(left);
  const b = normalizeVrm(right);
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  const distance = weightedEditDistance(a, b);
  const similarity = Math.max(0, 1 - (distance / maxLen));
  return Math.round(similarity * 100);
}

function collectAuthorizationVrmCandidates(payload, options = {}) {
  const minLen = Number(options.minLen || 5);
  const maxLen = Number(options.maxLen || 8);
  const candidates = new Set();
  const seen = new Set();
  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (typeof current === 'string') {
      const normalized = normalizeVrm(current);
      if (normalized.length >= minLen && normalized.length <= maxLen) {
        candidates.add(normalized);
      }
      continue;
    }

    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }

    if (typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    Object.entries(current).forEach(([key, value]) => {
      const normalizedKey = String(key || '').toLowerCase();
      if (typeof value === 'string' && /vrm|reg|registration|plate|vehicle/i.test(normalizedKey)) {
        const normalizedValue = normalizeVrm(value);
        if (normalizedValue.length >= minLen && normalizedValue.length <= maxLen) {
          candidates.add(normalizedValue);
        }
      }

      if (value && (typeof value === 'object' || Array.isArray(value))) {
        queue.push(value);
      }
    });
  }

  return Array.from(candidates);
}

function withAuthorizationMatchConfidence(result, inputVrm) {
  if (!result || typeof result !== 'object') return result;

  const targetVrm = normalizeVrm(inputVrm);
  if (!targetVrm) return result;

  const hasAuthorization = Boolean(result?.hasAuthorization);
  const candidateVrmsRaw = collectAuthorizationVrmCandidates(result);
  const candidateVrms = hasAuthorization
    ? candidateVrmsRaw
    : candidateVrmsRaw.filter((candidate) => candidate !== targetVrm);
  if (candidateVrms.length === 0) {
    return {
      ...result,
      matchConfidence: {
        targetVrm,
        bestVrm: '',
        scorePercent: 0,
        comparedCount: 0,
      },
    };
  }

  let best = { vrm: '', scorePercent: 0 };
  for (const candidate of candidateVrms) {
    const scorePercent = vrmSimilarityPercent(targetVrm, candidate);
    if (scorePercent > best.scorePercent) {
      best = { vrm: candidate, scorePercent };
    }
  }

  return {
    ...result,
    matchConfidence: {
      targetVrm,
      bestVrm: best.vrm,
      scorePercent: Number(best.scorePercent || 0),
      comparedCount: candidateVrms.length,
    },
  };
}

let ocrWorkerPromise = null;
const TESSERACT_WORKER_PATH = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js';

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      if (typeof window === 'undefined') {
        throw new Error('ocr_worker_browser_only');
      }

      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng', 1, {
        workerPath: TESSERACT_WORKER_PATH,
      });
      try {
        await worker.setParameters({
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
          preserve_interword_spaces: '0',
        });
      } catch (_) { }
      return worker;
    })();
  }

  return ocrWorkerPromise;
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

  // Some engines emit normalized [0..1] coordinates.
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

function buildPlateCandidatesFromWords(words) {
  const safeWords = Array.isArray(words) ? words : [];
  const candidates = [];

  for (let i = 0; i < safeWords.length; i += 1) {
    const first = safeWords[i];
    const second = safeWords[i + 1];
    const third = safeWords[i + 2];

    const variants = [
      [first],
      second ? [first, second] : null,
      third ? [first, second, third] : null,
    ].filter(Boolean);

    variants.forEach((parts) => {
      const raw = parts
        .map((part) => String(part?.text || ''))
        .join('')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');

      if (!raw || raw.length < 5 || raw.length > 8) return;
      const normalized = normalizeUkVrmFromOcr(raw);
      if (!normalized) return;

      const confidences = parts
        .map((part) => Number(part?.confidence || 0))
        .filter((value) => Number.isFinite(value));
      const avgConfidence = confidences.length > 0
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : 0;

      const boxes = parts
        .map((part) => part?.bbox)
        .filter((bbox) => bbox && Number.isFinite(bbox.x0) && Number.isFinite(bbox.y0) && Number.isFinite(bbox.x1) && Number.isFinite(bbox.y1));

      if (boxes.length === 0) return;

      const bbox = {
        x0: Math.min(...boxes.map((box) => box.x0)),
        y0: Math.min(...boxes.map((box) => box.y0)),
        x1: Math.max(...boxes.map((box) => box.x1)),
        y1: Math.max(...boxes.map((box) => box.y1)),
      };

      const ukFormatBonus = isLikelyCurrentUkVrm(normalized) ? 60 : 0;
      const modelScore = scoreUkVrmCandidate(normalized);
      const lengthPenalty = Math.abs(normalized.length - 7) * 2;
      const score = modelScore + ukFormatBonus + avgConfidence - lengthPenalty;

      candidates.push({
        text: normalized,
        confidence: avgConfidence,
        score,
        bbox,
      });
    });
  }

  return candidates.sort((left, right) => right.score - left.score);
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

async function scanPlateFromImage(file) {
  if (!file || !(file.type || '').startsWith('image/')) return null;

  try {
    const worker = await getOcrWorker();
    const result = await worker.recognize(file);
    const words = Array.isArray(result?.data?.words) ? result.data.words : [];
    const candidates = buildPlateCandidatesFromWords(words);
    if (candidates.length === 0) return null;

    const best = candidates[0];
    if (!best?.text) return null;

    let cutoffImage = await createPlateCutoutDataUrl(file, best.bbox);
    if (!cutoffImage) {
      const alternateCandidates = candidates
        .filter((candidate) => candidate?.bbox)
        .slice(1, 6);

      for (const candidate of alternateCandidates) {
        cutoffImage = await createPlateCutoutDataUrl(file, candidate.bbox);
        if (cutoffImage) {
          break;
        }
      }
    }

    if (cutoffImage) {
      const cutoffFile = dataUrlToFile(cutoffImage, `plate_cutoff_${Date.now()}.jpg`);
      if (cutoffFile) {
        const capturedAt = normalizeCapturedAt(file?.capturedAt) || new Date().toISOString();
        const stampedCutoff = await stampEvidenceImage(cutoffFile, { capturedAt, phase: 'plate' });
        const stampedPreview = await fileToDataUrl(stampedCutoff);
        cutoffImage = stampedPreview || cutoffImage;
      }
    }
    return {
      plateText: normalizeUkVrmFromOcr(best.text),
      confidence: Number(best.confidence || 0),
      cutoffImage,
      bbox: best.bbox,
    };
  } catch (_) {
    return null;
  }
}

function buildEvidenceFrame(imageUrl, timestamp, plateImageUrl = '') {
  if (!imageUrl) return null;
  const capturedAt = normalizeCapturedAt(timestamp) || null;
  return {
    imageUrl,
    vehicleImage: imageUrl,
    plateImage: plateImageUrl || imageUrl,
    timestamp: capturedAt,
    capturedAt,
    capturedAtUk: capturedAt ? formatCaptureTimestamp(capturedAt) : '',
  };
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

function buildCameraRawRecords(files, previews, { phase, capturedAt, source = 'WARDEN_CAPTURE' } = {}) {
  const safeFiles = Array.isArray(files) ? files : [];
  const safePreviews = Array.isArray(previews) ? previews : [];
  const nowIso = capturedAt || new Date().toISOString();

  return safeFiles.map((file, index) => {
    const normalizedCapturedAt = normalizeCapturedAt(file?.capturedAt) || nowIso;
    return {
      id: `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
      phase: phase === 'closing' ? 'closing' : 'entry',
      imageRole: isPlateCutoffFileArtifact(file) ? 'plate_cutoff' : 'vehicle_full',
      source,
      capturedAt: normalizedCapturedAt,
      capturedAtUk: formatCaptureTimestamp(normalizedCapturedAt),
      fileName: file?.name || `capture_${index + 1}.jpg`,
      mimeType: file?.type || '',
      sizeBytes: Number(file?.size || 0),
      localPreviewUrl: safePreviews[index] || '',
    };
  });
}

function resolveCameraRawImageSrc(record) {
  const candidates = [
    record?.localPreviewUrl,
    record?.uploadedUrl,
    record?.previewUrl,
    record?.imageUrl,
    record?.url,
    record?.fileUrl,
    record?.publicUrl,
  ];

  for (const value of candidates) {
    const candidate = String(value || '').trim();
    if (candidate) return candidate;
  }

  return '';
}

function mergeCameraRawRecords(existing, incoming, phase) {
  const safeExisting = Array.isArray(existing) ? existing : [];
  const safeIncoming = Array.isArray(incoming) ? incoming : [];
  const normalizedPhase = phase === 'closing' ? 'closing' : 'entry';
  const normalizedIncoming = safeIncoming.map((item) => ({
    ...item,
    phase: item?.phase === 'closing' ? 'closing' : normalizedPhase,
  }));
  return [...safeExisting, ...normalizedIncoming];
}

function getPhasePrimaryCameraRawRecord(records, phase) {
  const normalizedPhase = phase === 'closing' ? 'closing' : 'entry';
  const safeRecords = Array.isArray(records) ? records : [];
  return safeRecords.find((record) => (record?.phase === 'closing' ? 'closing' : 'entry') === normalizedPhase) || null;
}

function getPhaseDetectionFromCameraRaw(records, phase, fallbackVrm = '') {
  const record = getPhasePrimaryCameraRawRecord(records, phase);
  const fallbackPlate = phase === 'entry' ? normalizeVrm(fallbackVrm) : '';

  return {
    plateText: normalizeVrm(record?.plateText || fallbackPlate || ''),
    plateCutoffImage: String(record?.plateCutoffImage || '').trim(),
    plateConfidence: Number(record?.plateConfidence || 0),
    vehicleImage: resolveCameraRawImageSrc(record) || '',
  };
}

function buildPhaseSessionEvidence({ phase, detection, capturedAt = '' } = {}) {
  const normalizedPhase = phase === 'closing' ? 'closing' : 'entry';
  const normalizedCapturedAt = normalizeCapturedAt(capturedAt) || '';
  return {
    phase: normalizedPhase,
    capturedAt: normalizedCapturedAt,
    capturedAtUk: normalizedCapturedAt ? formatCaptureTimestamp(normalizedCapturedAt) : '',
    plateText: normalizeVrm(detection?.plateText || ''),
    plateCutoffImage: String(detection?.plateCutoffImage || '').trim(),
    plateConfidence: Number(detection?.plateConfidence || 0),
    vehicleImage: String(detection?.vehicleImage || '').trim(),
  };
}

function mergeSessionEvidence(existingEvidence, phaseEvidence) {
  const existing = existingEvidence && typeof existingEvidence === 'object'
    ? existingEvidence
    : {};
  const phase = phaseEvidence?.phase === 'closing' ? 'closing' : 'entry';
  return {
    ...existing,
    [phase]: {
      ...(existing[phase] || {}),
      ...phaseEvidence,
    },
  };
}

function reorderEvidenceByMainIndex(files, mainIndex) {
  const safeFiles = Array.isArray(files) ? files : [];
  if (safeFiles.length <= 1) return safeFiles;

  const index = Number.isFinite(Number(mainIndex)) ? Number(mainIndex) : 0;
  if (index <= 0 || index >= safeFiles.length) return safeFiles;

  const reordered = [...safeFiles];
  const [selected] = reordered.splice(index, 1);
  if (!selected) return safeFiles;
  return [selected, ...reordered];
}

async function backfillCameraRawPreviewUrls(records, files) {
  const safeRecords = Array.isArray(records) ? records : [];
  if (safeRecords.length === 0) {
    return { records: safeRecords, changed: false };
  }

  const safeFiles = Array.isArray(files) ? files : [];
  const entryBlobs = safeFiles
    .filter((file) => file?.phase === 'entry' && file?.blob)
    .map((file) => file.blob);
  const closingBlobs = safeFiles
    .filter((file) => file?.phase === 'closing' && file?.blob)
    .map((file) => file.blob);

  const [entryPreviews, closingPreviews] = await Promise.all([
    toPreviewSrcList(entryBlobs),
    toPreviewSrcList(closingBlobs),
  ]);

  let entryIndex = 0;
  let closingIndex = 0;
  let changed = false;

  const nextRecords = safeRecords.map((record) => {
    const phase = record?.phase === 'closing' ? 'closing' : 'entry';
    const hasDirectImage = Boolean(resolveCameraRawImageSrc(record));
    const preview = phase === 'closing'
      ? (closingPreviews[closingIndex++] || '')
      : (entryPreviews[entryIndex++] || '');

    if (hasDirectImage || !preview) {
      return record;
    }

    changed = true;
    return { ...record, localPreviewUrl: preview };
  });

  return { records: nextRecords, changed };
}

function enrichCameraRawRecordsWithUploadedUrls(records, entryUrls, closingUrls) {
  const safeRecords = Array.isArray(records) ? records : [];
  const safeEntryUrls = Array.isArray(entryUrls) ? entryUrls : [];
  const safeClosingUrls = Array.isArray(closingUrls) ? closingUrls : [];
  let entryIndex = 0;
  let closingIndex = 0;

  return safeRecords.map((record) => {
    if (record?.phase === 'entry') {
      const uploadedUrl = safeEntryUrls[entryIndex] || '';
      entryIndex += 1;
      return uploadedUrl ? { ...record, uploadedUrl, targetSystem: 'LOS' } : record;
    }

    const uploadedUrl = safeClosingUrls[closingIndex] || '';
    closingIndex += 1;
    return uploadedUrl ? { ...record, uploadedUrl, targetSystem: 'LOS' } : record;
  });
}

function sanitizeCameraRawRecordsForSubmission(records) {
  const safeRecords = Array.isArray(records) ? records : [];

  return safeRecords.map((record) => {
    if (!record || typeof record !== 'object') return record;

    const {
      localPreviewUrl,
      previewUrl,
      imageUrl,
      ...rest
    } = record;

    return rest;
  });
}

function isHttpUrl(value) {
  const candidate = String(value || '').trim();
  return /^https?:\/\//i.test(candidate);
}

function sanitizeSessionEvidenceForSubmission(sessionEvidence) {
  const safe = sessionEvidence && typeof sessionEvidence === 'object' ? sessionEvidence : {};

  const sanitizePhase = (phaseValue) => {
    const phase = phaseValue && typeof phaseValue === 'object' ? phaseValue : {};
    return {
      ...phase,
      plateCutoffImage: isHttpUrl(phase.plateCutoffImage) ? phase.plateCutoffImage : '',
      vehicleImage: isHttpUrl(phase.vehicleImage) ? phase.vehicleImage : '',
    };
  };

  return {
    entry: sanitizePhase(safe.entry),
    closing: sanitizePhase(safe.closing),
  };
}

function sanitizePayloadForSubmission(payload) {
  const safe = payload && typeof payload === 'object' ? payload : {};

  return {
    ...safe,
    detectedEntryPlateCutoffImage: isHttpUrl(safe.detectedEntryPlateCutoffImage) ? safe.detectedEntryPlateCutoffImage : '',
    detectedClosingPlateCutoffImage: isHttpUrl(safe.detectedClosingPlateCutoffImage) ? safe.detectedClosingPlateCutoffImage : '',
    detectedEntryVehicleImage: isHttpUrl(safe.detectedEntryVehicleImage) ? safe.detectedEntryVehicleImage : '',
    startVehicleImage: isHttpUrl(safe.startVehicleImage) ? safe.startVehicleImage : '',
    detectedClosingVehicleImage: isHttpUrl(safe.detectedClosingVehicleImage) ? safe.detectedClosingVehicleImage : '',
    sessionEvidence: sanitizeSessionEvidenceForSubmission(safe.sessionEvidence),
  };
}

function collectImageUrlsFromValue(root) {
  const found = [];
  const visited = new Set();
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (typeof current === 'string') {
      const candidate = current.trim();
      if (/^https?:\/\//i.test(candidate)) {
        found.push(candidate);
      }
      continue;
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    if (typeof current === 'object') {
      if (visited.has(current)) continue;
      visited.add(current);

      for (const [key, value] of Object.entries(current)) {
        if (typeof value === 'string') {
          const candidate = value.trim();
          if (/^https?:\/\//i.test(candidate) && /(image|photo|thumb|url|img|link|uri|href)/i.test(key)) {
            found.push(candidate);
          }
          continue;
        }
        queue.push(value);
      }
    }
  }

  return found
    .filter((url) => !/\/missing/i.test(url))
    .filter((url, index, all) => all.indexOf(url) === index);
}

function pickUploadedPlateImageUrl(uploadedUrls, evidenceFiles, fallbackUrl = '') {
  const safeUrls = Array.isArray(uploadedUrls) ? uploadedUrls : [];
  const safeFiles = Array.isArray(evidenceFiles) ? evidenceFiles : [];

  for (let i = 0; i < Math.min(safeUrls.length, safeFiles.length); i += 1) {
    const fileName = String(safeFiles[i]?.name || '').toLowerCase();
    if (!fileName.includes('plate_cutoff_')) continue;

    const candidate = String(safeUrls[i] || '').trim();
    if (/^https?:\/\//i.test(candidate)) return candidate;
  }

  const fallback = String(fallbackUrl || '').trim();
  return /^https?:\/\//i.test(fallback) ? fallback : '';
}

function diffMinutes(startIso, endIso) {
  return getBillableMinutes(startIso, endIso);
}

function resolveObservationWindow(payload = {}) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const records = Array.isArray(safePayload.cameraRawData) ? safePayload.cameraRawData : [];

  const pickPhaseTime = (phase) => {
    const matches = records
      .filter((record) => String(record?.phase || '').toLowerCase() === phase)
      .map((record) => normalizeCapturedAt(record?.capturedAt))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return matches[0] || '';
  };

  const entryFromEvidence = pickPhaseTime('entry');
  const closingFromEvidence = pickPhaseTime('closing');

  const entryTime =
    entryFromEvidence ||
    normalizeCapturedAt(safePayload.entryCapturedAt) ||
    normalizeCapturedAt(safePayload.observationStartTime) ||
    '';
  const closingTime =
    closingFromEvidence ||
    normalizeCapturedAt(safePayload.closingCapturedAt) ||
    normalizeCapturedAt(safePayload.observationEndTime) ||
    '';

  return { entryTime, closingTime };
}

function getEvidencePhaseCounts(files) {
  const safeFiles = Array.isArray(files) ? files : [];
  const entryCount = safeFiles.filter((file) => file?.phase === 'entry').length;
  const closingCount = safeFiles.filter((file) => file?.phase === 'closing').length;
  return { entryCount, closingCount };
}

function getBreachLifecycle(item) {
  const status = String(item?.status || '').toLowerCase();
  const converted = Boolean(item?.payload?.convertedToPcn) || item?.payload?.breachLifecycle === 'CONVERTED_TO_PCN';
  const { entryCount, closingCount } = getEvidencePhaseCounts(item?.files);

  if (converted) {
    return { code: 'CONVERTED', label: 'Converted to PCN', syncable: false };
  }

  if (status === 'syncing') {
    return { code: 'SYNCING', label: 'Syncing', syncable: false };
  }
  if (status === 'failed') {
    return { code: 'FAILED', label: 'Failed sync', syncable: true };
  }
  if (status === 'synced' || status === 'submitted') {
    return { code: 'SUBMITTED', label: 'Submitted (Pending PCN)', syncable: false };
  }
  if (entryCount > 0 && closingCount === 0) {
    return { code: 'DRAFT_OPEN', label: 'Draft Parking Charge', syncable: false };
  }
  if (entryCount > 0 && closingCount > 0) {
    return { code: 'READY', label: 'Ready to submit', syncable: true };
  }
  return { code: 'INCOMPLETE', label: 'Incomplete draft', syncable: false };
}

function normalizeVehicleLookup(result, fallbackVrm) {
  if (!result) return null;

  const normalize = (value) => {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (!str || str.toLowerCase() === 'unknown') return null;
    return str;
  };

  const pickValid = (...candidates) => {
    for (const value of candidates) {
      const normalized = normalize(value);
      if (normalized) return normalized;
    }
    return null;
  };

  const raw = result?.raw || result || {};
  const root = result?.response || result?.data || result || {};
  const results = raw?.results || raw?.Results || {};
  const rootResults = root?.results || root?.Results || {};
  const vehicleDetails = results?.vehicleDetails || results?.VehicleDetails || result?.vehicleDetails || result?.vehicle || result?.data || {};
  const ident = vehicleDetails?.vehicleIdentification || vehicleDetails?.VehicleIdentification || vehicleDetails?.identification || {};
  const history = vehicleDetails?.vehicleHistory || vehicleDetails?.VehicleHistory || vehicleDetails?.history || {};
  const status = vehicleDetails?.vehicleStatus || vehicleDetails?.VehicleStatus || vehicleDetails?.status || {};
  const registration = vehicleDetails?.vehicleRegistration || vehicleDetails?.VehicleRegistration || vehicleDetails?.registration || {};
  const description = vehicleDetails?.vehicleDescription || vehicleDetails?.VehicleDescription || vehicleDetails?.description || {};
  const colourDetails = history?.colourDetails || history?.ColourDetails || {};
  const modelDetails = results?.modelDetails || results?.ModelDetails || {};
  const modelIdent = modelDetails?.modelIdentification || modelDetails?.ModelIdentification || {};
  const modelDescription = modelDetails?.modelDescription || modelDetails?.ModelDescription || {};
  const imageDetails = results?.vehicleImageDetails || results?.VehicleImageDetails || {};
  const imageList = imageDetails?.vehicleImageList || imageDetails?.VehicleImageList || [];
  const firstImage = imageList[0] || {};
  const technical = vehicleDetails?.dvlaTechnicalDetails || vehicleDetails?.DvlaTechnicalDetails || vehicleDetails?.technicalDetails || {};
  const mot = vehicleDetails?.mot || result?.mot || {};
  const tax = vehicleDetails?.tax || result?.tax || {};
  const extractedImageUrls = collectImageUrlsFromValue([
    result?.imageUrl,
    result?.vehicleImage,
    result?.vehicleImageUrl,
    result?.imageUrls,
    result?.images,
    result?.vehicleImages,
    result?.photos,
    root?.imageUrl,
    root?.imageUrls,
    root?.images,
    root?.vehicleImages,
    root?.photos,
    raw?.imageUrl,
    raw?.imageUrls,
    raw?.images,
    raw?.vehicleImages,
    raw?.photos,
    results,
    rootResults,
    imageDetails,
    imageList,
    firstImage,
  ]);

  const imageUrlCandidate = pickValid(
    result?.imageUrl,
    result?.vehicleImage,
    result?.vehicleImageUrl,
    root?.imageUrl,
    raw?.imageUrl,
    firstImage?.imageUrl,
    firstImage?.ImageUrl,
    extractedImageUrls[0]
  );
  const imageUrl = imageUrlCandidate && imageUrlCandidate.includes('/missing') ? null : imageUrlCandidate;
  const imageUrls = [imageUrl, ...extractedImageUrls]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .filter((value, index, all) => all.indexOf(value) === index);

  return {
    vrm: normalizeVrm(pickValid(ident?.vrm, ident?.Vrm, result?.vrm, fallbackVrm)),
    make: pickValid(ident?.dvlaMake, ident?.DvlaMake, modelIdent?.make, modelIdent?.Make, registration?.make, registration?.Make, description?.make, description?.Make, result?.make),
    model: pickValid(ident?.dvlaModel, ident?.DvlaModel, modelIdent?.model, modelIdent?.Model, registration?.model, registration?.Model, description?.model, description?.Model, result?.model),
    color: pickValid(colourDetails?.currentColour, colourDetails?.CurrentColour, colourDetails?.originalColour, description?.colour, description?.Colour, description?.color, description?.Color, result?.color, result?.colour),
    bodyType: pickValid(ident?.dvlaBodyType, ident?.DvlaBodyType, modelDescription?.bodyStyle, modelDescription?.BodyStyle, technical?.bodyType, technical?.BodyType, vehicleDetails?.bodyType, description?.bodyType),
    fuelType: pickValid(ident?.dvlaFuelType, ident?.DvlaFuelType, technical?.fuelType, technical?.FuelType, registration?.fuelType, registration?.FuelType, vehicleDetails?.fuelType),
    yearOfManufacture: pickValid(ident?.yearOfManufacture, ident?.YearOfManufacture, registration?.yearOfManufacture, registration?.YearOfManufacture, vehicleDetails?.yearOfManufacture),
    dateFirstRegistered: pickValid(ident?.dateFirstRegistered, ident?.DateFirstRegistered, registration?.dateFirstRegistered, registration?.DateFirstRegistered, vehicleDetails?.dateFirstRegistered),
    motStatus: pickValid(mot?.status, mot?.Status, status?.motStatus, status?.MotStatus, vehicleDetails?.motStatus),
    motExpiry: pickValid(mot?.expiryDate, mot?.ExpiryDate, mot?.dueDate, mot?.DueDate, status?.motExpiryDate, status?.MotExpiryDate, vehicleDetails?.motExpiry),
    taxStatus: pickValid(tax?.status, tax?.Status, status?.taxStatus, status?.TaxStatus, vehicleDetails?.taxStatus),
    taxDueDate: pickValid(tax?.dueDate, tax?.DueDate, tax?.expiryDate, tax?.ExpiryDate, status?.taxDueDate, status?.TaxDueDate, vehicleDetails?.taxDueDate),
    keeperChanges: Array.isArray(history?.keeperChangeList || history?.KeeperChangeList)
      ? (history?.keeperChangeList || history?.KeeperChangeList).length
      : null,
    engineCapacityCc: pickValid(technical?.engineCapacityCc, technical?.EngineCapacityCc, technical?.cubicCapacity, technical?.CubicCapacity, vehicleDetails?.engineCapacityCc),
    transmission: pickValid(technical?.transmission, technical?.Transmission, description?.transmission, description?.Transmission),
    euroStatus: pickValid(technical?.euroStatus, technical?.EuroStatus, technical?.euroVersion, technical?.EuroVersion),
    co2Emissions: pickValid(technical?.co2Emissions, technical?.Co2Emissions, technical?.co2, technical?.Co2),
    wheelplan: pickValid(technical?.wheelplan, technical?.Wheelplan),
    grossWeightKg: pickValid(technical?.grossWeightKg, technical?.GrossWeightKg, technical?.revenueWeight, technical?.RevenueWeight),
    seats: pickValid(technical?.numberOfSeats, technical?.NumberOfSeats),
    doors: pickValid(technical?.numberOfDoors, technical?.NumberOfDoors),
    imageUrl,
    imageUrls,
    raw,
  };
}

function stripCarcheckFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const {
    vehicleLookup,
    carcheck,
    carCheck,
    carcheckResult,
    carCheckResult,
    ...safePayload
  } = payload;
  return safePayload;
}

export default function DashboardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState(null);
  const [sites, setSites] = useState([]);
  const [mobileCameras, setMobileCameras] = useState([]);
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [selectedMobileCameraId, setSelectedMobileCameraId] = useState('');
  const [selectedVrm, setSelectedVrm] = useState('');
  const [selectedReason, setSelectedReason] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [manualObservationMinutes, setManualObservationMinutes] = useState(0);
  const [location, setLocation] = useState(null);
  const [entryFiles, setEntryFiles] = useState([]);
  const [entryPreviews, setEntryPreviews] = useState([]);
  const [entryCapturedAt, setEntryCapturedAt] = useState('');
  const [entryCaptureMode, setEntryCaptureMode] = useState('scan');
  const [closingFiles, setClosingFiles] = useState([]);
  const [closingPreviews, setClosingPreviews] = useState([]);
  const [closingCapturedAt, setClosingCapturedAt] = useState('');
  const [mainEntryImageIndex, setMainEntryImageIndex] = useState(0);
  const [mainClosingImageIndex, setMainClosingImageIndex] = useState(0);
  const [cameraRawData, setCameraRawData] = useState([]);
  const [authorization, setAuthorization] = useState(null);
  const [authorizationByVrm, setAuthorizationByVrm] = useState({});
  const [vehicleLookup, setVehicleLookup] = useState(null);
  const [vehicleLookupLoading, setVehicleLookupLoading] = useState(false);
  const [vehicleLookupByVrm, setVehicleLookupByVrm] = useState({});
  const [carcheckDialogMessage, setCarcheckDialogMessage] = useState('');
  const [carcheckSaveLoading, setCarcheckSaveLoading] = useState(false);
  const [carcheckSaveNotice, setCarcheckSaveNotice] = useState('');
  const [carcheckSaveStatus, setCarcheckSaveStatus] = useState('idle');
  const [queueItems, setQueueItems] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mobileCameraAssigning, setMobileCameraAssigning] = useState(false);
  const [mobileCameraSavingId, setMobileCameraSavingId] = useState('');
  const [mobileCameraDrafts, setMobileCameraDrafts] = useState({});
  const [mobileCameraAssignmentSites, setMobileCameraAssignmentSites] = useState({});
  const [message, setMessage] = useState('');
  const [detailMessage, setDetailMessage] = useState('');
  const [ticks, setTicks] = useState(0);
  const [selectedContraventionCode, setSelectedContraventionCode] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [activeTab, setActiveTab] = useState('tracked');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedTrackedId, setSelectedTrackedId] = useState('');
  const [darkMode, setDarkMode] = useState(true);
  const [autoSubmitOnClosingCapture, setAutoSubmitOnClosingCapture] = useState(false);
  const [carcheckDialogOpen, setCarcheckDialogOpen] = useState(false);
  const [pcnDialogOpen, setPcnDialogOpen] = useState(false);
  const [pcnPreviewOpen, setPcnPreviewOpen] = useState(false);
  const [pendingFinalize, setPendingFinalize] = useState(null);
  const [stepperOpen, setStepperOpen] = useState(false);
  const [captureStepperOpen, setCaptureStepperOpen] = useState(false);
  const [captureStepperPhase, setCaptureStepperPhase] = useState('entry');
  const [breachStatusFilter, setBreachStatusFilter] = useState('all');
  const [convertLoading, setConvertLoading] = useState(false);
  const [convertError, setConvertError] = useState('');
  const [pcnReasonInput, setPcnReasonInput] = useState('No valid permit or payment found');
  const [monitoringSessionActive, setMonitoringSessionActive] = useState(false);
  const [monitoringSessionStartedAt, setMonitoringSessionStartedAt] = useState('');
  const [demoAlarmAcknowledged, setDemoAlarmAcknowledged] = useState(false);
  const [cameraRawViewMode, setCameraRawViewMode] = useState('grid');
  const [cameraRawVrmQuery, setCameraRawVrmQuery] = useState('');
  const [cameraRawSiteFilter, setCameraRawSiteFilter] = useState('all');
  const [imageDetailDialog, setImageDetailDialog] = useState({
    open: false,
    fullscreen: true,
    loading: false,
    src: '',
    label: '',
    phase: '',
    isMain: false,
    fileName: '',
    mimeType: '',
    sizeBytes: 0,
    capturedAt: '',
    embeddedCapturedAt: '',
    dimensions: null,
    error: '',
    imageIndex: -1,
    allowDelete: false,
  });
  const qrFileInputRef = useRef(null);
  const authReadyRef = useRef(false);
  const pcnAutoCheckSignatureRef = useRef('');
  const syncPipelineRef = useRef(createSerialTaskQueue());
  const convertPipelineRef = useRef(createSerialTaskQueue());
  const syncInFlightCountRef = useRef(0);
  const syncAbortControllersRef = useRef(new Map());

  function isRetriableSyncError(errorMessage) {
    const message = String(errorMessage || '').toLowerCase();
    if (!message) return false;

    return (
      message.includes('network request failed') ||
      message.includes('failed to fetch') ||
      message.includes('unable to resolve host') ||
      message.includes('no address associated with hostname') ||
      message.includes('connection abort') ||
      message.includes('software caused connection abort') ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('503') ||
      message.includes('504') ||
      message.includes('429')
    );
  }

  function isSyncCancelledError(errorMessage) {
    const message = String(errorMessage || '').toLowerCase();
    return (
      !message ? false : (
        message.includes('sync cancelled by user') ||
        message.includes('cancelled by user') ||
        message.includes('aborted') ||
        message.includes('aborterror')
      )
    );
  }

  function getSyncRetryDelayMs(attemptNumber) {
    const base = Math.min(30000, 2000 * (2 ** Math.max(0, attemptNumber - 1)));
    const jitter = Math.floor(base * 0.2 * Math.random());
    return base + jitter;
  }

  async function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  async function enqueueSyncTask(task, key = '__sync__') {
    const run = syncPipelineRef.current.enqueue(async () => {
      syncInFlightCountRef.current += 1;
      setSyncing(true);
      try {
        return await task();
      } finally {
        syncInFlightCountRef.current = Math.max(0, syncInFlightCountRef.current - 1);
        if (syncInFlightCountRef.current === 0) {
          setSyncing(false);
        }
      }
    }, key);

    return run;
  }

  async function resolveAuthToken({ forceRefresh = false } = {}) {
    const token = await getValidToken({ forceRefresh });
    const nextToken = token || authToken || getStoredToken();
    if (!nextToken) throw new Error('auth_missing');
    if (nextToken !== authToken) setAuthToken(nextToken);
    return nextToken;
  }

  function isAuthBootstrapError(error) {
    const status = Number(error?.status);
    if (status === 401 || status === 403) return true;

    const message = String(error?.message || '').toLowerCase();
    if (!message) return false;

    return (
      message.includes('auth_missing') ||
      message.includes('id-token') ||
      message.includes('not authorized') ||
      message.includes('unauthorized') ||
      message.includes('permission denied') ||
      message.includes('forbidden')
    );
  }

  const selectedSite = useMemo(() => sites.find((site) => String(site.id) === String(selectedSiteId)) || null, [sites, selectedSiteId]);
  const DEFAULT_PCN_REASON = 'No valid permit or payment found';
  const getPreferredReason = (payload = null, fallback = DEFAULT_PCN_REASON) => {
    const candidates = [
      payload?.pcnReason,
      payload?.contraventionReason,
      payload?.reason,
      selectedReason,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return fallback;
  };
  const selectedMobileCamera = useMemo(
    () => mobileCameras.find((camera) => String(camera.id) === String(selectedMobileCameraId)) || null,
    [mobileCameras, selectedMobileCameraId]
  );
  const selectedMobileCameraSite = useMemo(
    () => sites.find((site) => String(site.id) === String(selectedMobileCamera?.siteId || '')) || null,
    [sites, selectedMobileCamera]
  );
  const mobileCamerasByAvailability = useMemo(() => {
    const nowMs = Date.now();
    const fifteenMinutesMs = 15 * 60 * 1000;

    const withFlags = mobileCameras.map((camera) => {
      const lastSeenMs = new Date(camera?.lastSeen || '').getTime();
      const recentlySeen = Number.isFinite(lastSeenMs) && (nowMs - lastSeenMs) <= fifteenMinutesMs;
      const status = String(camera?.status || '').toLowerCase();
      const available = status === 'active' || recentlySeen;
      return { ...camera, available };
    });

    return withFlags.sort((left, right) => {
      if (left.available !== right.available) return left.available ? -1 : 1;
      return String(left.name || '').localeCompare(String(right.name || ''));
    });
  }, [mobileCameras]);
  const contraventions = useMemo(() => getContraventionOptions(selectedSite), [selectedSite]);
  const selectedContravention = useMemo(
    () => contraventions.find((item) => String(item?.code || '') === String(selectedContraventionCode || '')) || null,
    [contraventions, selectedContraventionCode]
  );
  const selectedObservationMinutes = useMemo(
    () => normalizeObservationMinutes(selectedContravention?.defaultObservationMinutes ?? manualObservationMinutes ?? 0),
    [manualObservationMinutes, selectedContravention]
  );
  const activeTimers = useMemo(() => {
    return queueItems
      .filter((item) => {
        const status = String(item?.status || '').toLowerCase();
        const { closingCount } = getEvidencePhaseCounts(item?.files);
        const exitCaptured = closingCount > 0 || Boolean(item?.payload?.closingCapturedAt);
        const converted = Boolean(item?.payload?.convertedToPcn) || item?.payload?.breachLifecycle === 'CONVERTED_TO_PCN';
        if (converted) return false;
        if (status === 'submitted' || status === 'synced') return false;
        return Boolean(item?.payload?.observationStartTime || item?.payload?.entryCapturedAt) && !exitCaptured;
      })
      .map((item) => {
        const startsAt = item.payload.observationStartTime || item.payload.entryCapturedAt || '';
        const requiredMinutes = normalizeObservationMinutes(
          item.payload.expectedObservationMinutes || item.payload.requiredObservationMinutes || item.payload.observationMinutes
        );
        const startMs = new Date(startsAt).getTime();
        const remainingSeconds = requiredMinutes > 0 && Number.isFinite(startMs) && startMs > 0
          ? Math.max(0, Math.ceil((requiredMinutes * 60) - ((Date.now() - startMs) / 1000)))
          : 0;

        return {
          id: item.id,
          vrm: item.payload.vrm,
          reason: item.payload.contraventionReason,
          startsAt,
          requiredMinutes,
          remainingSeconds,
          siteName: item.payload.siteName || selectedSite?.name || 'Site'
        };
      });
  }, [queueItems, selectedSite?.name, ticks]);
  const hasEntryEvidence = entryFiles.length > 0;
  const hasClosingEvidence = closingFiles.length > 0;
  const canRunImageAnalysis = hasEntryEvidence || hasClosingEvidence;
  const canRunLookups = Boolean(selectedSiteId && selectedVrm);
  const canFinalizeBreach = Boolean(selectedSiteId && hasEntryEvidence && hasClosingEvidence && !busy);
  const trackedBreaches = useMemo(() => {
    return queueItems.map((item) => {
      const lifecycle = getBreachLifecycle(item);
      const { entryCount, closingCount } = getEvidencePhaseCounts(item.files);
      const observationStartTime = item?.payload?.observationStartTime || item?.payload?.entryCapturedAt || '';
      const observationEndTime =
        item?.payload?.observationEndTime ||
        item?.payload?.closingCapturedAt ||
        item?.payload?.convertedAt ||
        '';
      const hasExitEvidence =
        closingCount > 0 ||
        Boolean(item?.payload?.closingCapturedAt) ||
        lifecycle.code === 'CONVERTED';
      const isOpen = lifecycle.code === 'DRAFT_OPEN' && !hasExitEvidence;
      const requiredMinutes = normalizeObservationMinutes(
        item?.payload?.expectedObservationMinutes ||
        item?.payload?.requiredObservationMinutes ||
        item?.payload?.observationMinutes ||
        0
      );
      const startMs = new Date(observationStartTime).getTime();
      const elapsedMinutes = observationStartTime
        ? Math.max(0, diffMinutes(observationStartTime, hasExitEvidence ? observationEndTime : new Date().toISOString()))
        : 0;
      const remainingSeconds = observationStartTime && requiredMinutes > 0 && isOpen && Number.isFinite(startMs) && startMs > 0
        ? Math.max(0, Math.ceil((requiredMinutes * 60) - ((Date.now() - startMs) / 1000)))
        : 0;
      const isPastRequired = requiredMinutes > 0 ? remainingSeconds <= 0 : false;
      return {
        id: item.id,
        createdAt: item.createdAt,
        status: item.status,
        lifecycle,
        attempts: item.attempts || 0,
        lastError: item.lastError || '',
        vrm: item.payload?.vrm || 'Pending VRM',
        siteName: item.payload?.siteName || 'Site not set',
        reason: item.payload?.contraventionReason || 'No reason supplied',
        observationStartTime,
        observationEndTime,
        isOpen,
        elapsedMinutes,
        requiredMinutes,
        remainingSeconds,
        isPastRequired,
        payload: item.payload || {},
        files: Array.isArray(item.files) ? item.files : [],
        entryCount,
        closingCount,
      };
    });
  }, [queueItems, ticks]);

  const syncCandidates = useMemo(
    () => trackedBreaches.filter((item) => item.lifecycle.syncable || item.status === 'syncing'),
    [trackedBreaches]
  );

  const selectedTracked = useMemo(
    () => trackedBreaches.find((entry) => entry.id === selectedTrackedId) || null,
    [trackedBreaches, selectedTrackedId]
  );
  const selectedLifecycleCode = selectedTracked?.lifecycle?.code || '';
  const selectedConvertedToPcn = selectedLifecycleCode === 'CONVERTED';
  const demoObservationExpired = isDemoModeEnabled() && trackedBreaches.some((item) => item.isOpen && item.requiredMinutes > 0 && item.remainingSeconds <= 0);
  const canProceedWithPcnActions = !demoObservationExpired || demoAlarmAcknowledged;
  const canIssuePcnFromCurrentState = !selectedConvertedToPcn && (
    canFinalizeBreach ||
    (selectedLifecycleCode === 'SUBMITTED' && Boolean(selectedTracked?.payload?.breachId))
  );

  useEffect(() => {
    if (!demoObservationExpired) {
      setDemoAlarmAcknowledged(false);
    }
  }, [demoObservationExpired]);
  const selectedTrackedVehicleLookup = useMemo(() => {
    const trackedVrm = normalizeVrm(selectedTracked?.payload?.vrm || selectedTracked?.vrm);
    if (!trackedVrm) return null;
    return vehicleLookupByVrm[trackedVrm] || null;
  }, [selectedTracked, vehicleLookupByVrm]);
  const selectedTrackedAuthorization = useMemo(() => {
    const trackedVrm = normalizeVrm(selectedTracked?.payload?.vrm || selectedTracked?.vrm);
    if (trackedVrm && authorizationByVrm[trackedVrm]) {
      return authorizationByVrm[trackedVrm];
    }
    if (selectedTracked?.payload?.authorization) {
      return selectedTracked.payload.authorization;
    }
    return authorization;
  }, [selectedTracked, authorizationByVrm, authorization]);
  const selectedTrackedVehicleDetails = useMemo(() => {
    if (selectedTrackedVehicleLookup) return selectedTrackedVehicleLookup;

    const payloadVehicleLookup =
      selectedTracked?.payload?.vehicleLookup ||
      selectedTracked?.payload?.vehicleDetails ||
      selectedTracked?.payload?.savedVehicleLookup ||
      selectedTracked?.payload?.carcheck ||
      selectedTracked?.payload?.carCheck ||
      selectedTracked?.payload?.carcheckResult ||
      selectedTracked?.payload?.carCheckResult ||
      null;

    if (!payloadVehicleLookup) return null;

    return normalizeVehicleLookup(
      payloadVehicleLookup,
      selectedTracked?.payload?.vrm || selectedTracked?.vrm || ''
    );
  }, [selectedTracked, selectedTrackedVehicleLookup]);
  const selectedTrackedVehicleImageUrl = useMemo(() => {
    if (selectedTrackedVehicleDetails?.imageUrl) return selectedTrackedVehicleDetails.imageUrl;
    if (Array.isArray(selectedTrackedVehicleDetails?.imageUrls) && selectedTrackedVehicleDetails.imageUrls.length > 0) {
      return selectedTrackedVehicleDetails.imageUrls[0];
    }

    const payloadImageUrls = collectImageUrlsFromValue([
      selectedTracked?.payload?.images,
      selectedTracked?.payload?.imageUrls,
      selectedTracked?.payload?.savedVehicleImageUrl,
      selectedTracked?.payload?.evidence,
      selectedTracked?.payload?.vehicle,
      selectedTracked?.files,
    ]);
    return payloadImageUrls[0] || null;
  }, [selectedTracked, selectedTrackedVehicleDetails]);
  const activeCarcheckLookup = selectedTrackedVehicleDetails || vehicleLookup || null;
  const canSaveCarcheckDetails = Boolean(selectedTrackedId && activeCarcheckLookup);
  const isCurrentCarcheckAlreadySaved = useMemo(() => {
    if (!selectedTracked?.payload?.savedVehicleLookup || !activeCarcheckLookup) return false;

    const incomingFingerprint = buildVehicleLookupFingerprint(activeCarcheckLookup);
    const existingFingerprint = buildVehicleLookupFingerprint(selectedTracked.payload.savedVehicleLookup);
    return Boolean(existingFingerprint && incomingFingerprint && incomingFingerprint === existingFingerprint);
  }, [selectedTracked, activeCarcheckLookup]);
  const pcnSubmissionGate = useMemo(() => {
    const trackedVrm = normalizeVrm(selectedTracked?.payload?.vrm || selectedTracked?.vrm || selectedVrm);
    const siteId = String(selectedTracked?.payload?.siteId || selectedSiteId || '').trim();
    const hasExactLookupMatch = Boolean(
      trackedVrm && activeCarcheckLookup && normalizeVrm(activeCarcheckLookup?.vrm || '') === trackedVrm
    );
    const hasLookupEvidence = Boolean(
      hasVehicleLookupEvidence(activeCarcheckLookup) ||
      hasVehicleLookupEvidence(selectedTracked?.payload?.savedVehicleLookup)
    );
    const carcheckReady = Boolean(
      trackedVrm && (hasExactLookupMatch || hasLookupEvidence)
    );
    const permitChecked = Boolean(trackedVrm && selectedTrackedAuthorization && typeof selectedTrackedAuthorization === 'object');

    let message = 'Carcheck and ePermit must both be validated before submission.';
    if (!trackedVrm) {
      message = 'Recheck the VRM on the image before submitting.';
    } else if (!siteId) {
      message = 'Assign a patrol site before submitting.';
    } else if (!carcheckReady) {
      message = 'Carcheck returned no result. Cross-check the plate image VRM, edit VRM, then retry checks.';
    } else if (!permitChecked) {
      message = 'E-permit check has not been run yet. Use Retry e-permit check in Draft PCN details.';
    } else {
      message = selectedTrackedAuthorization?.hasAuthorization
        ? 'Permit matched for this site. Continue only if another parking rule was breached.'
        : 'Carcheck and ePermit checks completed (no active permit/payment found).';
    }

    return {
      trackedVrm,
      siteId,
      carcheckReady,
      permitChecked,
      ready: Boolean(trackedVrm && siteId && carcheckReady && permitChecked),
      message,
    };
  }, [activeCarcheckLookup, selectedSiteId, selectedTracked, selectedTrackedAuthorization, selectedVrm]);
  const pcnPreview = useMemo(() => {
    if (!selectedTracked) {
      return {
        entryTime: '',
        closingTime: '',
        durationMinutes: 0,
        imageUrls: [],
        observationCapture: null,
        contraventionCapture: null,
        permitStatus: 'Not checked',
        paymentStatus: 'Not checked',
      };
    }

    const payload = selectedTracked?.payload || {};
    const { entryTime, closingTime } = resolveObservationWindow(payload);
    const imageUrls = collectImageUrlsFromValue([
      payload?.images,
      payload?.imageUrls,
      payload?.evidence,
      payload?.closingEvidence,
      payload?.cameraRawData,
    ]).slice(0, 8);
    const cameraRecords = Array.isArray(payload?.cameraRawData) ? payload.cameraRawData : [];
    const entryRecord = cameraRecords.find((record) => String(record?.phase || '').toLowerCase() !== 'closing') || null;
    const closingRecord = cameraRecords.find((record) => String(record?.phase || '').toLowerCase() === 'closing') || null;
    const trackedFiles = Array.isArray(selectedTracked?.files) ? selectedTracked.files : [];
    const trackedEntryFiles = trackedFiles.filter((file) => file?.phase === 'entry');
    const trackedClosingFiles = trackedFiles.filter((file) => file?.phase === 'closing');
    const selectedMainEntryIndex = Number.isFinite(Number(payload?.mainEntryImageIndex))
      ? Math.max(0, Number(payload.mainEntryImageIndex))
      : 0;
    const selectedMainClosingIndex = Number.isFinite(Number(payload?.mainClosingImageIndex))
      ? Math.max(0, Number(payload.mainClosingImageIndex))
      : 0;

    const entryMainStampedAt =
      normalizeCapturedAt(entryFiles?.[selectedMainEntryIndex]?.capturedAt) ||
      normalizeCapturedAt(trackedEntryFiles?.[selectedMainEntryIndex]?.blob?.capturedAt) ||
      normalizeCapturedAt(trackedEntryFiles?.[selectedMainEntryIndex]?.capturedAt) ||
      '';
    const closingMainStampedAt =
      normalizeCapturedAt(closingFiles?.[selectedMainClosingIndex]?.capturedAt) ||
      normalizeCapturedAt(trackedClosingFiles?.[selectedMainClosingIndex]?.blob?.capturedAt) ||
      normalizeCapturedAt(trackedClosingFiles?.[selectedMainClosingIndex]?.capturedAt) ||
      '';

    const resolvedEntryTime = entryMainStampedAt || normalizeCapturedAt(entryRecord?.capturedAt) || entryTime || '';
    const resolvedClosingTime = closingMainStampedAt || normalizeCapturedAt(closingRecord?.capturedAt) || closingTime || '';
    const durationMinutes = Number(payload?.actualMinutes) > 0
      ? Number(payload.actualMinutes)
      : diffMinutes(resolvedEntryTime, resolvedClosingTime);
    const fallbackEntryImage = imageUrls[0] || '';
    const fallbackClosingImage = imageUrls[imageUrls.length > 1 ? 1 : 0] || '';
    const observationCapture = {
      imageUrl: resolveCameraRawImageSrc(entryRecord) || fallbackEntryImage,
      capturedAt: resolvedEntryTime,
      capturedAtUk:
        entryRecord?.capturedAtUk ||
        payload?.sessionEvidence?.entry?.capturedAtUk ||
        (resolvedEntryTime ? formatCaptureTimestamp(resolvedEntryTime) : ''),
      label: 'Observation capture',
    };
    const contraventionCapture = {
      imageUrl: resolveCameraRawImageSrc(closingRecord) || fallbackClosingImage,
      capturedAt: resolvedClosingTime,
      capturedAtUk:
        closingRecord?.capturedAtUk ||
        payload?.sessionEvidence?.closing?.capturedAtUk ||
        (resolvedClosingTime ? formatCaptureTimestamp(resolvedClosingTime) : ''),
      label: 'Contravention capture',
    };

    const auth = selectedTrackedAuthorization || payload?.authorization || null;
    const hasAuth = Boolean(auth?.hasAuthorization);
    const authType = String(auth?.authorization?.type || '').toLowerCase();

    const permitStatus = hasAuth
      ? (authType.includes('permit') ? 'Matched' : 'No active permit')
      : 'No active permit';
    const paymentStatus = hasAuth
      ? ((authType.includes('payment') || authType.includes('session') || authType.includes('pay')) ? 'Matched' : 'No active payment')
      : 'No active payment';

    return {
      entryTime: resolvedEntryTime,
      closingTime: resolvedClosingTime,
      durationMinutes,
      imageUrls,
      observationCapture,
      contraventionCapture,
      permitStatus,
      paymentStatus,
    };
  }, [selectedTracked, selectedTrackedAuthorization, entryFiles, closingFiles]);
  const detailMessageLooksLikeCheckStatus = useMemo(() => {
    const text = String(detailMessage || '').toLowerCase();
    if (!text) return false;
    return text.includes('carcheck')
      || text.includes('e-permit')
      || text.includes('permit check')
      || text.includes('checks refreshed');
  }, [detailMessage]);
  const hideDetailMessageForClosedSession = useMemo(() => {
    const lifecycleCode = String(selectedTracked?.lifecycle?.code || '').toUpperCase();
    const isClosedLifecycle = lifecycleCode === 'SUBMITTED' || lifecycleCode === 'CONVERTED';
    return Boolean(isClosedLifecycle && detailMessageLooksLikeCheckStatus);
  }, [selectedTracked, detailMessageLooksLikeCheckStatus]);
  const cameraRawFeed = useMemo(() => {
    const feed = [];

    queueItems.forEach((item) => {
      const records = Array.isArray(item?.payload?.cameraRawData) ? item.payload.cameraRawData : [];
      records.forEach((record, index) => {
        feed.push({
          ...record,
          vrm: item?.payload?.vrm || item?.vrm || 'Unknown',
          siteName: item?.payload?.siteName || 'Site',
          queueItemId: item?.id,
          recordKey: `${item?.id || 'queue'}-${record?.id || `${record?.phase || 'entry'}-${index}`}`,
        });
      });
    });

    return feed.sort((left, right) => String(right?.capturedAt || '').localeCompare(String(left?.capturedAt || '')));
  }, [queueItems]);
  const selectedTrackedCameraRawData = useMemo(() => {
    const fromPayload = Array.isArray(selectedTracked?.payload?.cameraRawData)
      ? selectedTracked.payload.cameraRawData
      : [];

    if (fromPayload.length > 0) {
      return fromPayload;
    }

    return Array.isArray(cameraRawData) ? cameraRawData : [];
  }, [selectedTracked, cameraRawData]);
  const cameraRawSiteOptions = useMemo(() => {
    const unique = Array.from(new Set(
      cameraRawFeed
        .map((item) => String(item?.siteName || '').trim())
        .filter(Boolean)
    ));
    return unique.sort((a, b) => a.localeCompare(b));
  }, [cameraRawFeed]);
  const filteredCameraRawFeed = useMemo(() => {
    const normalizedVrmQuery = normalizeVrm(cameraRawVrmQuery);
    const normalizedSiteFilter = String(cameraRawSiteFilter || 'all').trim().toLowerCase();

    return cameraRawFeed.filter((item) => {
      const itemVrm = normalizeVrm(item?.vrm || '');
      const itemSite = String(item?.siteName || '').trim().toLowerCase();
      const vrmMatch = !normalizedVrmQuery || itemVrm.includes(normalizedVrmQuery);
      const siteMatch = normalizedSiteFilter === 'all' || itemSite === normalizedSiteFilter;
      return vrmMatch && siteMatch;
    });
  }, [cameraRawFeed, cameraRawVrmQuery, cameraRawSiteFilter]);

  const primaryCaptureAction = useMemo(() => {
    if (!hasEntryEvidence) {
      return { key: 'capture-entry', label: 'Capture entry evidence' };
    }
    if (!monitoringSessionActive && !hasClosingEvidence) {
      return { key: 'start-monitoring', label: 'Start Draft Parking Charge' };
    }
    if (monitoringSessionActive && !hasClosingEvidence) {
      return { key: 'capture-closing', label: 'Capture closing evidence' };
    }
    return { key: 'finalize', label: selectedTracked ? 'Finalize Draft Parking Charge' : 'Finalize Parking Charge' };
  }, [hasEntryEvidence, hasClosingEvidence, monitoringSessionActive, selectedTracked]);

  const filteredBreaches = useMemo(() => {
    let list = trackedBreaches;
    if (selectedSiteId) {
      list = list.filter((item) => {
        const itemSiteId = String(item?.payload?.siteId || '').trim();
        if (!itemSiteId) return true;
        return itemSiteId === String(selectedSiteId);
      });
    }
    if (breachStatusFilter === 'all') return list;
    return list.filter((item) => {
      if (breachStatusFilter === 'open') return item.lifecycle.code === 'DRAFT_OPEN';
      if (breachStatusFilter === 'ready') return item.lifecycle.code === 'READY';
      if (breachStatusFilter === 'submitted') return item.lifecycle.code === 'SUBMITTED';
      if (breachStatusFilter === 'failed') return item.lifecycle.code === 'FAILED';
      if (breachStatusFilter === 'converted') return item.lifecycle.code === 'CONVERTED';
      return true;
    });
  }, [trackedBreaches, breachStatusFilter, selectedSiteId]);

  useEffect(() => {
    if (activeTab !== 'tracked') return;
    if (!selectedTrackedId) return;
    const stillSelected = filteredBreaches.some((item) => item.id === selectedTrackedId);
    if (!stillSelected) {
      setSelectedTrackedId('');
    }
  }, [activeTab, filteredBreaches, selectedTrackedId]);

  function getPrimaryActionLabel(item) {
    if (!item) return 'Review';
    if (item.lifecycle.code === 'DRAFT_OPEN') return 'Continue Draft Parking Charge';
    if (item.lifecycle.code === 'READY') return 'Review and submit';
    if (item.lifecycle.code === 'FAILED') return 'Review and retry';
    if (item.lifecycle.code === 'SUBMITTED') return 'Finalize PCN';
    if (item.lifecycle.code === 'CONVERTED') return 'View card';
    return 'Review';
  }

  function resolveVehicleDetailsForSubmission(inputVrm, sourcePayload = null) {
    const normalizedVrm = normalizeVrm(inputVrm || sourcePayload?.vrm || selectedVrm || '');
    if (!normalizedVrm) return null;

    const payloadLookup = sourcePayload?.savedVehicleLookup || sourcePayload?.vehicleDetails || null;
    const trackedLookup = normalizeVrm(selectedTrackedVehicleDetails?.vrm || selectedTracked?.payload?.vrm || '') === normalizedVrm
      ? selectedTrackedVehicleDetails
      : null;
    const cachedLookup = vehicleLookupByVrm[normalizedVrm] || null;
    const activeLookup = normalizeVrm(vehicleLookup?.vrm || '') === normalizedVrm ? vehicleLookup : null;

    return buildVehicleDetailsRecord(
      payloadLookup || trackedLookup || cachedLookup || activeLookup || null,
      normalizedVrm
    );
  }

  async function openSubmitPreviewForTracked(itemId) {
    if (!itemId) return;
    const items = await listQueueItems();
    const item = items.find((entry) => entry.id === itemId);
    if (!item) {
      setMessage('Could not find the selected draft for submission.');
      return;
    }

    await handleReviewTracked(item);
    const checks = await ensurePcnSubmissionChecks({
      vrm: item?.payload?.vrm || item?.vrm || selectedVrm,
      siteId: item?.payload?.siteId || selectedSiteId,
      forceCarcheck: false,
      openDialog: false,
      allowNetwork: false,
    });
    if (!checks.ok) return;

    setPendingFinalize({
      action: 'convert',
      openPcnDialogAfterSync: false,
    });
    setPcnPreviewOpen(true);
  }

  async function handlePrimaryAction(item) {
    if (!item) return;
    if (item.lifecycle.code === 'READY' || item.lifecycle.code === 'FAILED') {
      await openSubmitPreviewForTracked(item.id);
      return;
    }
    if (item.lifecycle.code === 'SUBMITTED') {
      await openSubmitPreviewForTracked(item.id);
      return;
    }
    setSelectedTrackedId(item.id);
    if (item.lifecycle.code === 'DRAFT_OPEN') {
      handleReviewTracked(item);
      return;
    }
  }

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

    const storedMobileCameraId = getStoredMobileCameraId();
    if (storedMobileCameraId) {
      setSelectedMobileCameraId(storedMobileCameraId);
    }
  }, []);

  useEffect(() => {
    async function bootstrapSession() {
      try {
        const session = loadSession() || await restoreSession();
        let token = session?.token;

        if (!token || !session?.role) {
          await router.replace('/login');
          return;
        }

        setAuthToken(token);
        setProfile(session);
        setOnline(navigator.onLine);
        let bootstrapResults = await Promise.allSettled([
          loadSites(token),
          loadMobileCameras(token),
          refreshQueue(),
        ]);

        const siteFailure = bootstrapResults[0];
        if (siteFailure?.status === 'rejected' && isAuthBootstrapError(siteFailure.reason)) {
          token = await resolveAuthToken({ forceRefresh: true });
          setAuthToken(token);
          bootstrapResults = await Promise.allSettled([
            loadSites(token),
            loadMobileCameras(token),
            refreshQueue(),
          ]);
        }

        const hardFailure = bootstrapResults.find((result, index) => (
          result.status === 'rejected' && index === 2
        ));

        const siteLoadFailed = bootstrapResults[0]?.status === 'rejected';
        if (siteLoadFailed) {
          setDetailMessage('Patrol sites are still loading. You can capture evidence now and assign site before submission.');
        }

        if (hardFailure) {
          throw hardFailure.reason;
        }
        authReadyRef.current = true;
      } catch (error) {
        console.error('[warden] profile bootstrap failed', error);

        if (isAuthBootstrapError(error)) {
          clearSession();
          await signOutFromWardenApp();
          await router.replace('/login');
          return;
        }

        setMessage('Unable to load patrol sites right now. Check network/API and retry.');
        setOnline(navigator.onLine);
        authReadyRef.current = true;
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
    const refreshTick = () => setTicks((value) => value + 1);
    const handleVisibility = () => {
      if (!document.hidden) {
        refreshTick();
      }
    };

    window.addEventListener('focus', refreshTick);
    window.addEventListener('pageshow', refreshTick);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('focus', refreshTick);
      window.removeEventListener('pageshow', refreshTick);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (!contraventions.length) {
      setSelectedContraventionCode('');
      setSelectedReason('');
      setManualObservationMinutes(0);
      return;
    }

    if (selectedContravention) {
      setSelectedReason(String(selectedContravention.label || '').trim());
      setManualObservationMinutes(Number(selectedContravention.defaultObservationMinutes ?? 0));
      return;
    }

    const fallback = contraventions[0] || null;
    const fallbackCode = String(fallback?.code || '').trim();
    setSelectedContraventionCode(fallbackCode);
    setSelectedReason(String(fallback?.label || '').trim());
    setManualObservationMinutes(Number(fallback?.defaultObservationMinutes ?? 0));
  }, [contraventions, selectedContravention]);

  useEffect(() => {
    const nextReason = String(selectedReason || '').trim();
    if (!nextReason) return;
    setPcnReasonInput((current) => {
      const cur = String(current || '').trim();
      if (!cur || cur === DEFAULT_PCN_REASON) return nextReason;
      return current;
    });
  }, [selectedReason]);

  useEffect(() => {
    if (selectedSiteId) {
      saveStoredSiteId(selectedSiteId);
    }
  }, [selectedSiteId]);

  useEffect(() => {
    if (!isDemoModeEnabled()) return;
    if (!Array.isArray(sites) || sites.length === 0) return;

    const hasSelectedDemoSite = Boolean(selectedSite && sites.some((site) => String(site.id) === String(selectedSite?.id || '')));
    if (hasSelectedDemoSite) return;

    const firstDemoSite = sites[0];
    if (!firstDemoSite?.id) return;

    setSelectedSiteId(firstDemoSite.id);
    saveStoredSiteId(firstDemoSite.id);
  }, [selectedSiteId, sites]);

  useEffect(() => {
    if (selectedMobileCameraId) {
      saveStoredMobileCameraId(selectedMobileCameraId);
    }
  }, [selectedMobileCameraId]);

  useEffect(() => {
    if (!Array.isArray(mobileCameras) || mobileCameras.length === 0) {
      setMobileCameraDrafts({});
      setMobileCameraAssignmentSites({});
      return;
    }

    setMobileCameraDrafts((current) => {
      const next = {};
      for (const camera of mobileCameras) {
        next[camera.id] = {
          name: current?.[camera.id]?.name ?? (camera?.name || ''),
          ipAddress: current?.[camera.id]?.ipAddress ?? (camera?.ipAddress || ''),
          macAddress: current?.[camera.id]?.macAddress ?? (camera?.macAddress || '')
        };
      }
      return next;
    });

    setMobileCameraAssignmentSites((current) => {
      const next = {};
      for (const camera of mobileCameras) {
        next[camera.id] = current?.[camera.id] || camera?.siteId || '';
      }
      return next;
    });
  }, [mobileCameras]);

  useEffect(() => {
    if (activeTab !== 'mobile') return;

    let canceled = false;
    (async () => {
      try {
        const token = await resolveAuthToken();
        if (canceled) return;
        await loadMobileCameras(token);
      } catch (error) {
        console.error('[warden] failed to refresh mobile cameras tab', error);
      }
    })();

    return () => {
      canceled = true;
    };
  }, [activeTab]);

  useEffect(() => {
    setCarcheckDialogOpen(false);
    setCarcheckSaveLoading(false);
    setCarcheckSaveNotice('');
    setCarcheckSaveStatus('idle');
    setPcnDialogOpen(false);
  }, [selectedTrackedId]);

  useEffect(() => {
    if (activeTab !== 'tracked') return;
    if (!selectedTrackedId) return;

    const lifecycleCode = String(selectedTracked?.lifecycle?.code || '').toUpperCase();
    const isClosedLifecycle = lifecycleCode === 'SUBMITTED' || lifecycleCode === 'CONVERTED';
    if (!isClosedLifecycle) return;

    setDetailMessage((current) => {
      const text = String(current || '').toLowerCase();
      const isCheckStatus = text.includes('carcheck')
        || text.includes('e-permit')
        || text.includes('permit check')
        || text.includes('checks refreshed');
      return isCheckStatus ? '' : current;
    });
  }, [activeTab, selectedTrackedId, selectedTracked]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const storedTheme = window.localStorage.getItem('warden-theme');
    const preferDark = storedTheme !== 'light';
    setDarkMode(preferDark);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('warden-auto-submit-on-closing-capture');
    setAutoSubmitOnClosingCapture(stored === 'true');
  }, []);

  useEffect(() => {
    if (!carcheckDialogOpen) return;
    if (carcheckSaveStatus !== 'success') return;
    if (!carcheckSaveNotice) return;

    const timeoutId = window.setTimeout(() => {
      setCarcheckSaveNotice('');
      setCarcheckSaveStatus('idle');
    }, 4000);

    return () => window.clearTimeout(timeoutId);
  }, [carcheckDialogOpen, carcheckSaveStatus, carcheckSaveNotice]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.documentElement.classList.toggle('theme-light', !darkMode);
    window.localStorage.setItem('warden-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      'warden-auto-submit-on-closing-capture',
      autoSubmitOnClosingCapture ? 'true' : 'false'
    );
  }, [autoSubmitOnClosingCapture]);

  useEffect(() => {
    const vrm = normalizeVrm(selectedVrm);
    if (!vrm) {
      setVehicleLookup(null);
      return;
    }
    setVehicleLookup(vehicleLookupByVrm[vrm] || null);
  }, [selectedVrm, vehicleLookupByVrm]);

  async function loadSites(token) {
    if (isDemoModeEnabled()) {
      // const data = await fetchJson('/api/sites?forceAdmin=true', { token });
      const nextSites = buildDemoSites();
      const activeSites = nextSites.filter((site) => site.active !== false && site.isActive !== false);
      setSites(activeSites);
      return;
    }

    const data = await fetchJson('/api/sites?forceAdmin=true', { token });
    const nextSites = Array.isArray(data?.sites) ? data.sites : [];
    const activeSites = nextSites.filter((site) => site.active !== false && site.isActive !== false);
    setSites(activeSites);
  }

  async function loadMobileCameras(token) {
    try {
      const data = await fetchCameraServiceJson('/api/cameras', { token });
      const allCameras = Array.isArray(data?.cameras) ? data.cameras : [];
      const nextMobileCameras = allCameras.filter((camera) => isVehicleCameraCandidate(camera));

      setMobileCameras(nextMobileCameras);

      const storedMobileCameraId = getStoredMobileCameraId();
      const hasStoredSelection = nextMobileCameras.some((camera) => String(camera.id) === String(storedMobileCameraId || ''));
      if (hasStoredSelection) {
        setSelectedMobileCameraId(storedMobileCameraId);
        return nextMobileCameras;
      }

      if (!selectedMobileCameraId && nextMobileCameras.length === 1) {
        setSelectedMobileCameraId(nextMobileCameras[0].id);
        saveStoredMobileCameraId(nextMobileCameras[0].id);
      }

      return nextMobileCameras;
    } catch (error) {
      // Mobile camera management is optional; do not fail dashboard bootstrap.
      console.warn('[warden] mobile camera list unavailable', error?.message || error);
      setMobileCameras([]);
      return [];
    }
  }

  function updateMobileCameraDraft(cameraId, field, value) {
    setMobileCameraDrafts((current) => ({
      ...current,
      [cameraId]: {
        ...(current[cameraId] || {}),
        [field]: value
      }
    }));
  }

  function updateMobileCameraAssignmentSite(cameraId, siteId) {
    setMobileCameraAssignmentSites((current) => ({
      ...current,
      [cameraId]: siteId
    }));
  }

  async function assignMobileCameraToSite(cameraId, siteId, options = {}) {
    const {
      silentSuccess = false,
      statusMessage = '',
    } = options || {};
    const nextCameraId = String(cameraId || '').trim();
    const nextSiteId = String(siteId || '').trim();

    if (!nextSiteId) {
      setDetailMessage('Select a camera assignment site before activating this vehicle camera.');
      return;
    }

    if (!nextCameraId) {
      setDetailMessage('Warden-only mode active. No vehicle camera linked for this patrol.');
      return;
    }

    setMobileCameraAssigning(true);
    try {
      const token = await resolveAuthToken();
      const resolvedSite = sites.find((site) => String(site.id) === String(nextSiteId)) || null;
      const assignmentPayload = buildMobileCameraAssignmentPayload({
        siteId: nextSiteId,
        siteName: resolvedSite?.name || resolvedSite?.displayName || '',
        assignedBy: profile?.email || profile?.uid || 'warden',
        reason: 'warden_patrol_site_assignment',
      });

      await fetchCameraServiceJson(`/api/cameras/${encodeURIComponent(nextCameraId)}/site-assignment`, {
        method: 'POST',
        token,
        body: assignmentPayload
      });

      const refreshedCameras = await loadMobileCameras(token);
      const refreshedCamera = refreshedCameras.find((camera) => String(camera.id) === String(nextCameraId)) || selectedMobileCamera;
      if (!silentSuccess) {
        setDetailMessage(statusMessage || `${refreshedCamera?.name || 'Vehicle camera'} linked to ${resolvedSite?.name || resolvedSite?.displayName || nextSiteId}. The backend assignment and alarm metadata will now use this site.`);
      }
    } catch (error) {
      console.error('[warden] mobile camera assignment failed', error);
      setDetailMessage(error?.message || 'Vehicle camera assignment failed.');
    } finally {
      setMobileCameraAssigning(false);
    }
  }

  async function saveMobileCameraDetails(cameraId) {
    const id = String(cameraId || '').trim();
    if (!id) return;

    const draft = mobileCameraDrafts[id] || {};
    const payload = {
      isMobile: true,
      cameraType: 'Vehicle Camera',
      manufacturer: 'Vehicle Camera',
      name: String(draft.name || '').trim(),
      ipAddress: String(draft.ipAddress || '').trim() || null,
      macAddress: String(draft.macAddress || '').trim() || null
    };

    if (!payload.name) {
      setDetailMessage('Camera name cannot be empty.');
      return;
    }

    setMobileCameraSavingId(id);
    try {
      const token = await resolveAuthToken();
      await fetchCameraServiceJson(`/api/cameras/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        token,
        body: payload
      });
      await loadMobileCameras(token);
      setDetailMessage(`${payload.name} details updated.`);
    } catch (error) {
      console.error('[warden] failed to save mobile camera details', error);
      setDetailMessage(error?.message || 'Failed to save mobile camera details.');
    } finally {
      setMobileCameraSavingId('');
    }
  }

  async function handleLinkSelectedMobileCamera(nextCameraId) {
    setSelectedMobileCameraId(nextCameraId);
    saveStoredMobileCameraId(nextCameraId);

    if (!nextCameraId) {
      setDetailMessage('Warden-only mode active. No vehicle camera linked for this patrol.');
      return;
    }

    setDetailMessage('Linked camera selection updated. Camera site assignment only changes when you press Activate for that camera.');
  }

  async function refreshQueue() {
    const items = await listQueueItems();
    const nextItems = [];

    for (const item of items) {
      const records = Array.isArray(item?.payload?.cameraRawData) ? item.payload.cameraRawData : [];
      if (records.length === 0) {
        nextItems.push(item);
        continue;
      }

      const { records: repairedRecords, changed } = await backfillCameraRawPreviewUrls(records, item?.files);
      if (changed) {
        const repairedItem = {
          ...item,
          payload: {
            ...(item?.payload || {}),
            cameraRawData: repairedRecords,
          },
          updatedAt: new Date().toISOString(),
        };
        await saveQueueItem(repairedItem);
        nextItems.push(repairedItem);
      } else {
        nextItems.push(item);
      }
    }

    setQueueItems(nextItems.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))));
  }

  async function handleLogout() {
    clearSession();
    await signOutFromWardenApp();
    await router.replace('/login');
  }

  function openCaptureDialog(phase) {
    const normalizedPhase = phase === 'closing' ? 'closing' : 'entry';
    setCaptureStepperPhase(normalizedPhase);
    setCaptureStepperOpen(true);
  }

  function closeImageDetailDialog() {
    setImageDetailDialog((current) => ({ ...current, open: false }));
  }

  function toggleImageDetailFullscreen() {
    setImageDetailDialog((current) => ({ ...current, fullscreen: !current.fullscreen }));
  }

  async function handleDeleteFromImageDetail() {
    const phase = imageDetailDialog?.phase === 'closing' ? 'closing' : 'entry';
    const imageIndex = Number(imageDetailDialog?.imageIndex);
    const allowDelete = Boolean(imageDetailDialog?.allowDelete);
    if (!allowDelete || !Number.isInteger(imageIndex) || imageIndex < 0) return;

    closeImageDetailDialog();
    await handleDeleteEvidenceImage(phase, imageIndex);
  }

  async function openImageDetailDialog({
    src,
    label,
    phase,
    isMain = false,
    file = null,
    capturedAt = '',
    fileName = '',
    mimeType = '',
    sizeBytes = 0,
    record = null,
    imageIndex = -1,
    allowDelete = false,
  } = {}) {
    const imageSrc = String(src || '').trim();
    if (!imageSrc) return;

    setImageDetailDialog({
      open: true,
      fullscreen: true,
      loading: true,
      src: imageSrc,
      label: label || 'Evidence image',
      phase: phase || '',
      isMain: Boolean(isMain),
      fileName: fileName || file?.name || '',
      mimeType: mimeType || file?.type || '',
      sizeBytes: Number(sizeBytes || file?.size || 0),
      capturedAt: normalizeCapturedAt(capturedAt || file?.capturedAt) || '',
      embeddedCapturedAt: '',
      dimensions: null,
      error: '',
      imageIndex: Number.isInteger(Number(imageIndex)) ? Number(imageIndex) : -1,
      allowDelete: Boolean(allowDelete),
    });

    try {
      const dimensions = await resolveImageDimensions(imageSrc);

      setImageDetailDialog((current) => {
        if (!current.open || current.src !== imageSrc) return current;
        return {
          ...current,
          loading: false,
          dimensions: dimensions || null,
        };
      });
    } catch (_) {
      setImageDetailDialog((current) => {
        if (!current.open || current.src !== imageSrc) return current;
        return {
          ...current,
          loading: false,
          error: 'Unable to load image details.',
        };
      });
    }
  }

  async function handleStepperCaptureComplete({ files = [], phase = 'entry', scan = null, captureMode = 'scan' } = {}) {
    const normalizedPhase = phase === 'closing' ? 'closing' : 'entry';
    const isClosingCapture = normalizedPhase === 'closing';
    const normalizedCaptureMode = String(captureMode || 'scan').toLowerCase() === 'manual' ? 'manual' : 'scan';
    const requiresOcrArtifacts = !isClosingCapture && normalizedCaptureMode !== 'manual';
    const rawFiles = Array.isArray(files) ? files : [];
    if (rawFiles.length === 0) {
      setCaptureStepperOpen(false);
      return;
    }

    const fallbackCapturedAt = await getServerTimestamp();
    const nextFiles = rawFiles.map((file) => {
      const capturedAt = normalizeCapturedAt(file?.capturedAt) || fallbackCapturedAt;
      file.capturedAt = capturedAt;
      return file;
    });
    const capturedAt = normalizeCapturedAt(nextFiles[0]?.capturedAt) || fallbackCapturedAt;
    const nextPreviews = await toPreviewSrcList(nextFiles);
    let nextCameraRawRecords = buildCameraRawRecords(nextFiles, nextPreviews, { phase: normalizedPhase, capturedAt });

    let plateScanResult = null;
    if (requiresOcrArtifacts) {
      const scanPlateText = normalizeVrm(scan?.plateText || '');
      if (scanPlateText) {
        plateScanResult = {
          plateText: scanPlateText,
          confidence: Number(scan?.confidence || 0),
          cutoffImage: String(scan?.cutoffImage || ''),
          bbox: scan?.bbox || null,
        };
      }
      if (!plateScanResult && (nextFiles[0]?.detectedPlateText || nextFiles[0]?.detectedPlateCutoffImage)) {
        plateScanResult = {
          plateText: normalizeVrm(nextFiles[0]?.detectedPlateText || ''),
          confidence: Number(nextFiles[0]?.detectedPlateConfidence || 0),
          cutoffImage: nextFiles[0]?.detectedPlateCutoffImage || '',
        };
      } else if (!plateScanResult && nextFiles.length > 0) {
        plateScanResult = await scanPlateFromImage(nextFiles[0]);
      }

      if (plateScanResult?.plateText && plateScanResult?.bbox && !plateScanResult?.cutoffImage && nextFiles.length > 0) {
        const bboxCutoff = await createPlateCutoutDataUrl(nextFiles[0], plateScanResult.bbox);
        if (bboxCutoff) {
          plateScanResult = {
            ...plateScanResult,
            cutoffImage: bboxCutoff,
          };
        }
      }

      // Regression guard: some native scan paths return plate text without a
      // cutoff image. Force a secondary OCR crop pass before finalizing files.
      if (plateScanResult?.plateText && !plateScanResult?.cutoffImage && nextFiles.length > 0) {
        try {
          const fallbackScan = await scanPlateFromImage(nextFiles[0]);
          if (fallbackScan?.cutoffImage) {
            plateScanResult = {
              ...plateScanResult,
              cutoffImage: fallbackScan.cutoffImage,
              bbox: plateScanResult?.bbox || fallbackScan?.bbox || null,
            };
          }
        } catch (_) {
          // Keep capture flow running even if fallback crop extraction fails.
        }
      }

      if (plateScanResult?.plateText && !plateScanResult?.cutoffImage) {
        setMessage('Plate text detected but plate image could not be extracted. Reframe plate and capture again.');
        return;
      }

      const hasCutoffFile = nextFiles.some((file) => String(file?.name || '').toLowerCase().includes('plate_cutoff_'));
      if (!hasCutoffFile && plateScanResult?.cutoffImage) {
        const cutoffFile = dataUrlToFile(
          plateScanResult.cutoffImage,
          `plate_cutoff_${normalizedPhase}_${Date.now()}.jpg`
        );
        if (cutoffFile) {
          cutoffFile.capturedAt = capturedAt;
          nextFiles.push(cutoffFile);
          nextPreviews.push(plateScanResult.cutoffImage);
        }
      }

      if (!hasCapturePairArtifacts(nextFiles)) {
        setMessage('Capture requires 2 images: full vehicle and plate cutout. Reframe plate and capture again.');
        return;
      }

      if (nextFiles[0]) {
        nextFiles[0].detectedPlateText = normalizeVrm(plateScanResult?.plateText || nextFiles[0]?.detectedPlateText || '');
        nextFiles[0].detectedPlateCutoffImage = plateScanResult?.cutoffImage || nextFiles[0]?.detectedPlateCutoffImage || '';
        nextFiles[0].detectedPlateConfidence = Number(plateScanResult?.confidence || nextFiles[0]?.detectedPlateConfidence || 0);
        nextFiles[0].detectedVehicleImage = nextPreviews[0] || '';
      }

      nextCameraRawRecords = buildCameraRawRecords(nextFiles, nextPreviews, { phase: normalizedPhase, capturedAt });
      if ((plateScanResult?.plateText || nextFiles[0]?.detectedPlateText) && nextCameraRawRecords[0]) {
        nextCameraRawRecords[0] = {
          ...nextCameraRawRecords[0],
          plateText: normalizeVrm(plateScanResult?.plateText || nextFiles[0]?.detectedPlateText || ''),
          plateConfidence: Number(plateScanResult?.confidence || nextFiles[0]?.detectedPlateConfidence || 0),
          plateCutoffImage: plateScanResult?.cutoffImage || nextFiles[0]?.detectedPlateCutoffImage || '',
        };
      }
    } else if (!isClosingCapture) {
      if (!hasCapturePairArtifacts(nextFiles, {
        requireExtractedVrm: false,
        requirePlateCutoff: false,
        minimumImages: 1,
      })) {
        setMessage('Capture at least 1 opening evidence image before continuing.');
        return;
      }

      if (nextFiles[0]) {
        nextFiles[0].detectedVehicleImage = nextPreviews[0] || '';
      }

      nextCameraRawRecords = buildCameraRawRecords(nextFiles, nextPreviews, { phase: normalizedPhase, capturedAt });
    } else {
      const mergedClosingFiles = [...closingFiles, ...nextFiles];
      const hasClosingPair = hasCapturePairArtifacts(mergedClosingFiles, {
        requireExtractedVrm: false,
        requirePlateCutoff: false,
        minimumImages: 1,
      });
      if (!hasClosingPair) {
        setMessage('Closing evidence requires at least 1 image before continuing.');
        return;
      }
    }

    const nextPhaseFiles = nextFiles.map((file) => ({
      name: file.name,
      type: file.type,
      blob: file,
      phase: normalizedPhase,
    }));

    if (normalizedPhase === 'entry') {
      const mergedEntryFiles = [...entryFiles, ...nextFiles];
      const mergedEntryPreviews = [...entryPreviews, ...nextPreviews];
      setEntryFiles(mergedEntryFiles);
      setEntryPreviews(mergedEntryPreviews);
      if (entryFiles.length === 0) {
        setMainEntryImageIndex(0);
      } else {
        setMainEntryImageIndex((current) => (
          mergedEntryFiles.length > 0
            ? Math.min(current, mergedEntryFiles.length - 1)
            : 0
        ));
      }
      setEntryCapturedAt((current) => current || capturedAt);
      setEntryCaptureMode(normalizedCaptureMode);
      setCameraRawData((current) => mergeCameraRawRecords(current, nextCameraRawRecords, 'entry'));
      if (plateScanResult?.plateText || nextFiles[0]?.detectedPlateText) {
        setSelectedVrm(normalizeVrm(plateScanResult?.plateText || nextFiles[0]?.detectedPlateText || ''));
      }

      if (selectedTrackedId) {
        const queuedItem = (await listQueueItems()).find((item) => item.id === selectedTrackedId) || null;
        const selectedPayload = queuedItem?.payload || selectedTracked?.payload || {};
        const existingFiles = Array.isArray(queuedItem?.files) ? queuedItem.files : [];
        const preservedFiles = existingFiles.filter((file) => file?.phase !== 'entry');
        const existingEntryFiles = existingFiles.filter((file) => file?.phase === 'entry');
        const mergedTrackedEntryFiles = [...existingEntryFiles, ...nextPhaseFiles];
        const selectedMainEntryIndex = Number.isFinite(Number(selectedPayload?.mainEntryImageIndex))
          ? Number(selectedPayload.mainEntryImageIndex)
          : mainEntryImageIndex;

        const entryPhaseEvidence = buildPhaseSessionEvidence({
          phase: 'entry',
          capturedAt,
          detection: {
            plateText: normalizeVrm(plateScanResult?.plateText || nextFiles[0]?.detectedPlateText || selectedPayload?.detectedEntryPlateText || ''),
            plateCutoffImage: plateScanResult?.cutoffImage || nextFiles[0]?.detectedPlateCutoffImage || selectedPayload?.detectedEntryPlateCutoffImage || '',
            plateConfidence: Number(plateScanResult?.confidence || nextFiles[0]?.detectedPlateConfidence || selectedPayload?.detectedEntryPlateConfidence || 0),
            vehicleImage: nextCameraRawRecords[0]?.imageUrl || selectedPayload?.detectedEntryVehicleImage || selectedPayload?.startVehicleImage || '',
          },
        });

        await updateQueueItem(selectedTrackedId, {
          payload: {
            ...selectedPayload,
            observationStartTime: capturedAt,
            observationEndTime: null,
            entryCapturedAt: capturedAt,
            closingCapturedAt: null,
            breachLifecycle: 'DRAFT_OPEN',
            entryCaptureMode: normalizedCaptureMode,
            mainEntryImageIndex: Math.min(
              Math.max(0, selectedMainEntryIndex),
              Math.max(0, mergedTrackedEntryFiles.length - 1)
            ),
            detectedEntryPlateText: normalizeVrm(plateScanResult?.plateText || nextFiles[0]?.detectedPlateText || selectedPayload?.detectedEntryPlateText || ''),
            detectedEntryPlateCutoffImage: plateScanResult?.cutoffImage || nextFiles[0]?.detectedPlateCutoffImage || selectedPayload?.detectedEntryPlateCutoffImage || '',
            detectedEntryPlateConfidence: Number(plateScanResult?.confidence || nextFiles[0]?.detectedPlateConfidence || selectedPayload?.detectedEntryPlateConfidence || 0),
            detectedEntryVehicleImage: nextCameraRawRecords[0]?.imageUrl || selectedPayload?.detectedEntryVehicleImage || '',
            startVehicleImage: nextCameraRawRecords[0]?.imageUrl || selectedPayload?.startVehicleImage || '',
            sessionEvidence: mergeSessionEvidence(selectedPayload?.sessionEvidence, entryPhaseEvidence),
            cameraRawData: mergeCameraRawRecords(selectedPayload?.cameraRawData || [], nextCameraRawRecords, 'entry'),
          },
          files: [...preservedFiles, ...mergedTrackedEntryFiles],
          updatedAt: new Date().toISOString(),
        });
        await refreshQueue();
      }

      setMessage(requiresOcrArtifacts
        ? `Opening evidence captured: ${nextFiles.length} image${nextFiles.length === 1 ? '' : 's'}.`
        : `Opening evidence captured: ${nextFiles.length} image${nextFiles.length === 1 ? '' : 's'}. Enter VRM manually when ready.`);
    } else {
      const mergedClosingFiles = [...closingFiles, ...nextFiles];
      const mergedClosingPreviews = [...closingPreviews, ...nextPreviews];
      const closingTime = capturedAt;
      setClosingFiles(mergedClosingFiles);
      setClosingPreviews(mergedClosingPreviews);
      if (closingFiles.length === 0) {
        setMainClosingImageIndex(0);
      } else {
        setMainClosingImageIndex((current) => (
          mergedClosingFiles.length > 0
            ? Math.min(current, mergedClosingFiles.length - 1)
            : 0
        ));
      }
      setClosingCapturedAt(capturedAt);
      setCameraRawData((current) => mergeCameraRawRecords(current, nextCameraRawRecords, 'closing'));
      setMonitoringSessionActive(false);
      setMonitoringSessionStartedAt('');

      if (selectedTrackedId) {
        const queuedItem = (await listQueueItems()).find((item) => item.id === selectedTrackedId) || null;
        const selectedPayload = queuedItem?.payload || selectedTracked?.payload || {};
        const existingFiles = Array.isArray(queuedItem?.files) ? queuedItem.files : [];
        const preservedFiles = existingFiles.filter((file) => file?.phase !== 'closing');
        const existingClosingFiles = existingFiles.filter((file) => file?.phase === 'closing');
        const mergedTrackedClosingFiles = [...existingClosingFiles, ...nextPhaseFiles];
        const selectedMainClosingIndex = Number.isFinite(Number(selectedPayload?.mainClosingImageIndex))
          ? Number(selectedPayload.mainClosingImageIndex)
          : mainClosingImageIndex;
        const entryTime =
          entryCapturedAt ||
          selectedPayload.entryCapturedAt ||
          selectedPayload.observationStartTime ||
          monitoringSessionStartedAt ||
          capturedAt;
        const computedMinutes = diffMinutes(entryTime, closingTime);

        const closingPhaseEvidence = buildPhaseSessionEvidence({
          phase: 'closing',
          capturedAt,
          detection: {
            plateText: normalizeVrm(plateScanResult?.plateText || nextFiles[0]?.detectedPlateText || selectedPayload?.detectedClosingPlateText || ''),
            plateCutoffImage: plateScanResult?.cutoffImage || nextFiles[0]?.detectedPlateCutoffImage || selectedPayload?.detectedClosingPlateCutoffImage || '',
            plateConfidence: Number(plateScanResult?.confidence || nextFiles[0]?.detectedPlateConfidence || selectedPayload?.detectedClosingPlateConfidence || 0),
            vehicleImage: nextCameraRawRecords[0]?.imageUrl || selectedPayload?.detectedClosingVehicleImage || '',
          },
        });

        await updateQueueItem(selectedTrackedId, {
          payload: {
            ...selectedPayload,
            observationStartTime: entryTime,
            observationEndTime: closingTime,
            entryCapturedAt: entryTime,
            closingCapturedAt: closingTime,
            actualMinutes: computedMinutes,
            mainClosingImageIndex: Math.min(
              Math.max(0, selectedMainClosingIndex),
              Math.max(0, mergedTrackedClosingFiles.length - 1)
            ),
            breachLifecycle: computedMinutes > 0 ? 'READY_FOR_SYNC' : selectedPayload.breachLifecycle,
            detectedClosingPlateText: normalizeVrm(plateScanResult?.plateText || nextFiles[0]?.detectedPlateText || selectedPayload?.detectedClosingPlateText || ''),
            detectedClosingPlateCutoffImage: plateScanResult?.cutoffImage || nextFiles[0]?.detectedPlateCutoffImage || selectedPayload?.detectedClosingPlateCutoffImage || '',
            detectedClosingPlateConfidence: Number(plateScanResult?.confidence || nextFiles[0]?.detectedPlateConfidence || selectedPayload?.detectedClosingPlateConfidence || 0),
            detectedClosingVehicleImage: nextCameraRawRecords[0]?.imageUrl || selectedPayload?.detectedClosingVehicleImage || '',
            sessionEvidence: mergeSessionEvidence(selectedPayload?.sessionEvidence, closingPhaseEvidence),
            cameraRawData: mergeCameraRawRecords(selectedPayload?.cameraRawData || [], nextCameraRawRecords, 'closing'),
          },
          files: [...preservedFiles, ...mergedTrackedClosingFiles],
          updatedAt: new Date().toISOString(),
        });
        await refreshQueue();
      }

      const capturedMessage = plateScanResult?.plateText || nextFiles[0]?.detectedPlateText
        ? `Closing evidence captured: ${nextFiles.length} image${nextFiles.length === 1 ? '' : 's'}. Plate detected: ${normalizeVrm(plateScanResult?.plateText || nextFiles[0]?.detectedPlateText || '')}.`
        : `Closing evidence captured: ${nextFiles.length} image${nextFiles.length === 1 ? '' : 's'}.`;
      const shouldAutoSubmit = autoSubmitOnClosingCapture && Boolean(selectedTrackedId);

      if (shouldAutoSubmit && !online) {
        setMessage(`${capturedMessage} Auto-submit is enabled but you are offline; review and submit manually when online.`);
      } else if (shouldAutoSubmit) {
        setMessage(`${capturedMessage} Auto-submitting evidence package...`);
        await queueOrSendCapture({
          targetItemId: selectedTrackedId,
          openPcnDialogAfterSync: false,
        });
      } else {
        setMessage(`${capturedMessage} Review and submit manually when ready.`);
      }
    }

    setCaptureStepperOpen(false);
  }

  async function uploadEvidenceFiles(evidenceFiles, manualVrm, siteIdOverride = '') {
    const uploadCandidates = (Array.isArray(evidenceFiles) ? evidenceFiles : []).filter(Boolean);
    const siteId = String(siteIdOverride || selectedSiteId || '').trim();
    const fallbackVrm = normalizeVrm(manualVrm || selectedVrm || '');
    const limitUpload = createConcurrencyLimiter(IMAGE_UPLOAD_CONCURRENCY);
    const totalUploads = uploadCandidates.length;

    const uploadViaServerFallback = async ({ blob, fileName, siteIdValue, vrmValue }) => {
      const formData = new FormData();
      formData.append('file', blob, fileName);
      formData.append('siteId', siteIdValue || '');
      formData.append('manualVrm', vrmValue || '');

      let token = await resolveAuthToken();
      let response = await fetch(buildApiUrl('/api/warden/uploadevidence'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      if (response.status === 401) {
        token = await resolveAuthToken({ forceRefresh: true });
        response = await fetch(buildApiUrl('/api/warden/uploadevidence'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        });
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || `Fallback upload failed (${response.status})`);
      }

      return {
        vrm: normalizeVrm(data?.vrm || vrmValue || ''),
        images: Array.isArray(data?.images) ? data.images : [],
      };
    };

    const uploadTasks = uploadCandidates.map((file, index) => limitUpload(async () => {
      const blob = file?.blob || file;
      if (!blob) {
        return { index, images: [], vrm: '' };
      }

      const uploadLabel = `${index + 1}/${totalUploads}`;
      console.log(`[warden] evidence upload queue start ${uploadLabel}`, {
        fileName: file?.name || blob?.name || null,
        size: Number(blob?.size || 0),
        contentType: blob?.type || 'image/jpeg',
      });

      const fileName = file?.name || blob?.name || `evidence_${Date.now()}_${index}.jpg`;
      const contentType = blob?.type || 'image/jpeg';
      const signedFolder = siteId
        ? `warden_evidence/${encodeURIComponent(siteId)}`
        : 'warden_evidence';

      const signedEndpoint = buildApiUrl(
        `/api/warden/uploadevidence?mode=signed-upload&folder=${signedFolder}&filename=${encodeURIComponent(fileName)}&contentType=${encodeURIComponent(contentType)}`
      );

      try {
        let token = await resolveAuthToken();
        let response = await fetch(signedEndpoint, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });

        if (response.status === 401) {
          token = await resolveAuthToken({ forceRefresh: true });
          response = await fetch(signedEndpoint, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
            },
          });
        }

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const prefix = uploadCandidates.length > 1 ? `Image upload failed (${file?.name || 'evidence'}): ` : '';
          throw new Error(`${prefix}${data?.error || 'Failed to request signed upload URL'}`);
        }

        const putResponse = await fetch(data?.url, {
          method: 'PUT',
          headers: {
            'Content-Type': contentType,
          },
          body: blob,
        });

        if (!putResponse.ok) {
          const prefix = uploadCandidates.length > 1 ? `Image upload failed (${file?.name || 'evidence'}): ` : '';
          throw new Error(`${prefix}Direct upload failed (${putResponse.status})`);
        }

        console.log(`[warden] evidence upload queue complete ${uploadLabel}`, {
          fileName,
          path: data?.path || null,
          status: putResponse.status,
          mode: 'signed-upload',
        });

        return {
          index,
          vrm: fallbackVrm || '',
          images: data?.url ? [String(data.url).split('?')[0]] : [],
        };
      } catch (signedUploadError) {
        console.warn(`[warden] signed evidence upload failed, using server fallback ${uploadLabel}`, {
          fileName,
          error: signedUploadError?.message || String(signedUploadError),
        });

        try {
          const fallbackResult = await uploadViaServerFallback({
            blob,
            fileName,
            siteIdValue: siteId,
            vrmValue: fallbackVrm,
          });

          console.log(`[warden] evidence upload queue complete ${uploadLabel}`, {
            fileName,
            mode: 'server-fallback',
            uploaded: fallbackResult.images.length,
          });

          return {
            index,
            vrm: fallbackResult.vrm || fallbackVrm || '',
            images: fallbackResult.images,
          };
        } catch (fallbackError) {
          throw new Error(
            `Signed upload failed (${signedUploadError?.message || 'unknown'}) and fallback failed (${fallbackError?.message || 'unknown'})`
          );
        }
      }
    }));

    const uploadResults = await Promise.allSettled(uploadTasks);
    const rejected = uploadResults.find((result) => result.status === 'rejected');
    if (rejected && rejected.reason) {
      throw rejected.reason;
    }

    const fulfilled = uploadResults
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value)
      .sort((a, b) => a.index - b.index);

    const resolvedVrm = fulfilled
      .map((result) => normalizeVrm(result?.vrm || ''))
      .find((value) => Boolean(value)) || fallbackVrm;

    const uploadedImages = fulfilled.flatMap((result) => (Array.isArray(result?.images) ? result.images : []));

    return {
      vrm: resolvedVrm || fallbackVrm || null,
      images: uploadedImages.filter((url, idx, all) => typeof url === 'string' && url && all.indexOf(url) === idx),
    };
  }

  async function inferVrmFromImage() {
    const sourceFiles = closingFiles.length > 0 ? closingFiles : entryFiles;
    if (!sourceFiles.length) return;
    setBusy(true);
    setMessage('Reading VRM from image…');

    try {
      const data = await uploadEvidenceFiles(sourceFiles, selectedVrm);

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

  async function checkAuthorization(nextVrm, siteIdOverride = '') {
    const vrm = normalizeVrm(nextVrm || selectedVrm);
    const effectiveSiteId = String(siteIdOverride || selectedSiteId || '').trim();
    if (!vrm || !effectiveSiteId) return null;
    const token = await resolveAuthToken();
    const result = await fetchJson(`/api/parking/check-authorization?vrm=${encodeURIComponent(vrm)}&siteId=${encodeURIComponent(effectiveSiteId)}&breachTime=${encodeURIComponent(new Date().toISOString())}`, {
      token
    });
    const decoratedResult = withAuthorizationMatchConfidence(result, vrm);
    setAuthorization(decoratedResult);
    setAuthorizationByVrm((current) => ({ ...current, [vrm]: decoratedResult }));
    return decoratedResult;
  }

  async function persistSelectedTrackedVrm() {
    if (!selectedTrackedId) return;

    const normalized = normalizeVrm(selectedVrm);
    if (!normalized) {
      setDetailMessage('Enter a valid VRM before saving changes.');
      return;
    }

    const existing = normalizeVrm(selectedTracked?.payload?.vrm || selectedTracked?.vrm || '');
    if (existing === normalized) return;

    await updateQueueItem(selectedTrackedId, {
      payload: {
        ...(selectedTracked?.payload || {}),
        vrm: normalized,
      },
      updatedAt: new Date().toISOString(),
    });

    setSelectedVrm(normalized);
    await refreshQueue();
    setDetailMessage(`VRM updated to ${normalized}.`);
  }

  async function persistTrackedPcnDetails({ silent = false } = {}) {
    if (!selectedTrackedId) return false;

    const nextSiteId = String(selectedSiteId || selectedTracked?.payload?.siteId || '').trim();
    if (!nextSiteId) {
      if (!silent) setDetailMessage('Select a patrol site before saving PCN details.');
      return false;
    }

    const nextSite = sites.find((site) => String(site.id) === nextSiteId) || null;
    const nextSiteName = String(nextSite?.name || nextSite?.displayName || selectedTracked?.payload?.siteName || '').trim() || 'Site not set';

    const nextContravention = contraventions.find((item) => String(item?.code || '') === String(selectedContraventionCode || '')) || null;
    const nextContraventionCode = String(nextContravention?.code || '').trim();
    const nextReason = String(nextContravention?.label || '').trim();
    const nextObservationMinutes = normalizeObservationMinutes(nextContravention?.defaultObservationMinutes ?? 0);

    if (!nextContraventionCode || !nextReason) {
      if (!silent) setDetailMessage('Select a contravention before saving PCN details.');
      return false;
    }

    await updateQueueItem(selectedTrackedId, {
      payload: {
        ...(selectedTracked?.payload || {}),
        siteId: nextSiteId,
        siteName: nextSiteName,
        selectedContraventionCode: nextContraventionCode,
        contraventionCode: nextContraventionCode,
        contraventionReason: nextReason,
        contravention: nextReason,
        reason: nextReason,
        expectedObservationMinutes: nextObservationMinutes,
      },
      updatedAt: new Date().toISOString(),
    });

    setSelectedReason(nextReason);
    await refreshQueue();
    if (!silent) {
      setDetailMessage('PCN details saved. Site and contravention updated for this draft.');
    }
    return true;
  }

  async function handlePermitLookup() {
    setBusy(true);
    try {
      const result = await checkAuthorization(selectedVrm);
      if (result?.hasAuthorization) {
        const score = Number(result?.matchConfidence?.scorePercent || 0);
        const bestVrm = String(result?.matchConfidence?.bestVrm || '').trim();
        if (score > 0 && bestVrm) {
          setDetailMessage(`E-permit lookup matched an active authorisation for this site (${score}% VRM match with ${bestVrm}).`);
        } else {
          setDetailMessage('E-permit lookup matched an active authorisation for this site.');
        }
      } else {
        const score = Number(result?.matchConfidence?.scorePercent || 0);
        const bestVrm = String(result?.matchConfidence?.bestVrm || '').trim();
        if (score > 0 && bestVrm) {
          setDetailMessage(`E-permit lookup completed. No active authorisation matched this site. Closest exemption match: ${bestVrm} (${score}%).`);
        } else {
          setDetailMessage('E-permit lookup completed. No active authorisation matched this site.');
        }
      }
    } catch (error) {
      console.error('[warden] permit lookup failed', error);
      setDetailMessage(error?.message || 'Permit lookup failed');
    } finally {
      setBusy(false);
    }
  }

  function startMonitoringSession() {
    const startedAt = entryCapturedAt || new Date().toISOString();
    if (!selectedVrm || !hasEntryEvidence) {
      setMessage('Capture entry evidence and set VRM before starting a Draft Parking Charge.');
      return;
    }
    if (!entryCapturedAt) {
      setEntryCapturedAt(startedAt);
    }
    setMonitoringSessionStartedAt(startedAt);
    setMonitoringSessionActive(true);
    setMessage(`Draft Parking Charge started for ${selectedVrm}.`);
  }

  function stopMonitoringSession() {
    setMonitoringSessionActive(false);
    setMessage('Draft Parking Charge ended. Capture closing evidence and finalize when ready.');
  }

  function openPermitQrDialog() {
    qrFileInputRef.current?.click();
  }

  async function handlePermitQrSelection(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (typeof window === 'undefined' || typeof window.BarcodeDetector === 'undefined') {
      setMessage('QR scan is not supported on this device browser. Use permit lookup manually.');
      return;
    }

    try {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const bitmap = await createImageBitmap(file);
      const codes = await detector.detect(bitmap);
      const raw = String(codes?.[0]?.rawValue || '').trim();
      if (!raw) {
        setMessage('No QR code detected. Try a clearer permit QR image.');
        return;
      }

      const parsedVrmMatch = raw.match(/(?:vrm|plate|registration)[:=\s]+([A-Za-z0-9]{2,10})/i);
      const parsedVrm = parsedVrmMatch ? normalizeVrm(parsedVrmMatch[1]) : '';
      if (parsedVrm) {
        setSelectedVrm(parsedVrm);
      }
      setManualNote((prev) => [prev, `Permit QR: ${raw}`].filter(Boolean).join('\n'));

      if ((parsedVrm || selectedVrm) && selectedSiteId) {
        await checkAuthorization(parsedVrm || selectedVrm);
        setDetailMessage(`Permit QR scanned${parsedVrm ? ` for ${parsedVrm}` : ''}. Authorization refreshed.`);
      } else {
        setDetailMessage('Permit QR scanned. Select site/VRM to run authorization check.');
      }
    } catch (error) {
      console.error('[warden] permit QR scan failed', error);
      setDetailMessage(error?.message || 'Permit QR scan failed');
    }
  }

  async function runVehicleLookupForVrm(inputVrm, options = {}) {
    const vrm = normalizeVrm(inputVrm);
    const forceRefresh = Boolean(options.forceRefresh);
    const openDialog = options.openDialog !== false;
    if (!vrm) {
      setMessage('Enter or read a VRM before running car check.');
      return null;
    }

    const cachedLookup = vehicleLookupByVrm[vrm];
    if (cachedLookup && !forceRefresh) {
      setCarcheckSaveNotice('');
      setCarcheckSaveStatus('idle');
      setVehicleLookup(cachedLookup);
      if (openDialog) {
        setCarcheckDialogMessage(`Loaded from app memory${cachedLookup?.make || cachedLookup?.model ? `: ${[cachedLookup.make, cachedLookup.model].filter(Boolean).join(' ')}` : ''}.`);
        setCarcheckDialogOpen(true);
      }
      return cachedLookup;
    }

    setVehicleLookupLoading(true);
    try {
      const token = await resolveAuthToken();
      const result = await fetchJson(`/api/vehicle/lookup?vrm=${encodeURIComponent(vrm)}`, { token });

      const responseInfo = result?.ResponseInformation || result?.responseInformation || null;
      if (responseInfo && responseInfo.IsSuccessStatusCode === false) {
        const apiMessage = responseInfo.StatusMessage || responseInfo.statusMessage || 'Lookup returned no result';
        throw new Error(`Carcheck: ${apiMessage}`);
      }

      const normalized = normalizeVehicleLookup(result, vrm);
      setCarcheckSaveNotice('');
      setCarcheckSaveStatus('idle');
      setVehicleLookup(normalized);
      setVehicleLookupByVrm((current) => ({ ...current, [vrm]: normalized }));
      if (openDialog) {
        setCarcheckDialogMessage(`Carcheck complete${normalized?.make || normalized?.model ? `: ${[normalized.make, normalized.model].filter(Boolean).join(' ')}` : ''}.`);
        setCarcheckDialogOpen(true);
      }
      return normalized;
    } catch (error) {
      console.error('[warden] vehicle lookup failed', error);
      setVehicleLookup(null);
      if (openDialog) {
        setCarcheckDialogMessage(error?.message || 'Carcheck unavailable');
        setCarcheckDialogOpen(true);
      }
      return null;
    } finally {
      setVehicleLookupLoading(false);
    }
  }

  function publishCheckFailure(messageText) {
    const text = String(messageText || '').trim();
    if (!text) return;
    setDetailMessage(text);
    // Keep list/home notices scoped: detail check failures should stay in detail view.
    if (!selectedTrackedId) {
      setMessage(text);
    }
  }

  async function retryDraftChecks() {
    const detailsSaved = await persistTrackedPcnDetails({ silent: true });
    if (detailsSaved === false) return;

    await persistSelectedTrackedVrm();

    const targetVrm = normalizeVrm(selectedTracked?.payload?.vrm || selectedTracked?.vrm || selectedVrm);
    const targetSiteId = String(selectedTracked?.payload?.siteId || selectedSiteId || '').trim();
    if (!targetVrm || !targetSiteId) {
      publishCheckFailure('Set a valid VRM and patrol site before retrying checks.');
      return;
    }

    setBusy(true);
    try {
      const checks = await ensurePcnSubmissionChecks({
        vrm: targetVrm,
        siteId: targetSiteId,
        forceCarcheck: true,
        openDialog: false,
        allowNetwork: true,
      });

      if (checks.ok) {
        setDetailMessage('Carcheck and e-permit checks refreshed for this draft.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function ensurePcnSubmissionChecks({
    vrm: inputVrm = selectedVrm,
    siteId: inputSiteId = selectedSiteId,
    forceCarcheck = false,
    openDialog = false,
    allowNetwork = true,
  } = {}) {
    const vrm = normalizeVrm(inputVrm);
    const siteId = String(inputSiteId || '').trim();

    if (!vrm || !siteId) {
      return {
        ok: false,
        error: 'Enter a VRM and assign a patrol site before submitting.',
      };
    }

    let vehicleDetails = vehicleLookupByVrm[vrm] || null;
    if (!vehicleDetails && normalizeVrm(vehicleLookup?.vrm || '') === vrm) {
      vehicleDetails = vehicleLookup;
    }
    if (!vehicleDetails && normalizeVrm(selectedTrackedVehicleDetails?.vrm || '') === vrm) {
      vehicleDetails = selectedTrackedVehicleDetails;
    }
    if (!vehicleDetails && hasVehicleLookupEvidence(selectedTracked?.payload?.savedVehicleLookup)) {
      vehicleDetails = buildVehicleDetailsRecord(selectedTracked.payload.savedVehicleLookup, vrm);
    }
    if (!vehicleDetails && hasVehicleLookupEvidence(selectedTrackedVehicleDetails)) {
      vehicleDetails = buildVehicleDetailsRecord(selectedTrackedVehicleDetails, vrm);
    }

    if ((!vehicleDetails || forceCarcheck) && allowNetwork) {
      vehicleDetails = await runVehicleLookupForVrm(vrm, {
        forceRefresh: true,
        openDialog,
      });
    }

    if (!vehicleDetails) {
      const error = allowNetwork
        ? 'Carcheck returned no result. Cross-check the plate image VRM, edit VRM, then retry checks.'
        : 'Carcheck is required before submission. Use Retry carcheck in Draft PCN details.';
      publishCheckFailure(error);
      return { ok: false, error };
    }

    let permitResult = authorizationByVrm[vrm] || null;
    if (!permitResult && normalizeVrm(selectedTracked?.payload?.vrm || '') === vrm) {
      permitResult = selectedTrackedAuthorization;
    }

    if ((!permitResult || forceCarcheck) && allowNetwork) {
      try {
        permitResult = await checkAuthorization(vrm, siteId);
      } catch (error) {
        const message = allowNetwork
          ? (error?.message || 'E-permit check failed. Retry after confirming the VRM and site.')
          : 'E-permit check is required before submission. Use Retry e-permit check in Draft PCN details.';
        publishCheckFailure(message);
        return { ok: false, error: message };
      }
    }

    if (!permitResult) {
      const error = allowNetwork
        ? 'E-permit check returned no result. Retry the lookup before submitting.'
        : 'E-permit check is required before submission. Use Retry e-permit check in Draft PCN details.';
      publishCheckFailure(error);
      return { ok: false, error };
    }

    return {
      ok: true,
      vrm,
      siteId,
      vehicleDetails,
      permitResult,
    };
  }

  async function handleVehicleLookup() {
    await runVehicleLookupForVrm(selectedVrm, { forceRefresh: true });
  }

  useEffect(() => {
    const vrm = normalizeVrm(selectedVrm);
    const siteId = String(selectedSiteId || selectedTracked?.payload?.siteId || '').trim();
    const hasEntryEvidence = entryFiles.length > 0;

    if (!vrm || !siteId || !hasEntryEvidence || vrm.length < 5) return;

    const signature = `${vrm}|${siteId}|entry`;
    if (pcnAutoCheckSignatureRef.current === signature) return;

    let cancelled = false;
    (async () => {
      const result = await ensurePcnSubmissionChecks({
        vrm,
        siteId,
        forceCarcheck: true,
        openDialog: false,
        allowNetwork: true,
      });

      if (cancelled) return;
      if (result.ok) {
        pcnAutoCheckSignatureRef.current = signature;
      } else {
        setDetailMessage('Auto-check failed after entry capture. Use Retry carcheck and Retry e-permit check in Draft PCN details.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedVrm, selectedSiteId, selectedTracked?.payload?.siteId, entryFiles.length]);

  async function handleSaveCarcheckDetails() {
    const trackedVrm = normalizeVrm(selectedTracked?.payload?.vrm || selectedTracked?.vrm || selectedVrm);
    setCarcheckSaveNotice('');
    setCarcheckSaveStatus('idle');
    if (!trackedVrm) {
      setCarcheckSaveStatus('error');
      setCarcheckSaveNotice('Run carcheck before saving details.');
      setDetailMessage('Run carcheck before saving details.');
      return;
    }

    const currentLookup = activeCarcheckLookup;
    if (!currentLookup) {
      setCarcheckSaveStatus('error');
      setCarcheckSaveNotice('No carcheck result to save yet.');
      setDetailMessage('No carcheck result to save yet.');
      return;
    }

    if (!selectedTrackedId) {
      setCarcheckSaveStatus('error');
      setCarcheckSaveNotice('Open a Draft Parking Charge before saving carcheck details.');
      setDetailMessage('Open a Draft Parking Charge before saving carcheck details.');
      return;
    }

    setCarcheckSaveLoading(true);
    try {
      const nowIso = new Date().toISOString();
      const normalizedLookup = buildVehicleDetailsRecord(currentLookup, trackedVrm);
      const existingLookup = selectedTracked?.payload?.savedVehicleLookup || null;
      const incomingFingerprint = buildVehicleLookupFingerprint(normalizedLookup || currentLookup);
      const existingFingerprint = buildVehicleLookupFingerprint(existingLookup);
      if (selectedTracked?.payload?.savedVehicleSavedAt && existingFingerprint && incomingFingerprint === existingFingerprint) {
        setCarcheckSaveStatus('success');
        setCarcheckSaveNotice('Already saved for this session.');
        setDetailMessage('Vehicle details already saved. You can reopen this result anytime.');
        return;
      }

      await updateQueueItem(selectedTrackedId, {
        payload: {
          ...selectedTracked?.payload,
          vrm: trackedVrm,
          savedVehicleLookup: normalizedLookup || currentLookup,
          vehicleDetails: normalizedLookup || currentLookup,
          savedVehicleImageUrl:
            normalizedLookup?.imageUrl ||
            normalizedLookup?.imageUrls?.[0] ||
            currentLookup?.imageUrl ||
            currentLookup?.imageUrls?.[0] ||
            selectedTrackedVehicleImageUrl ||
            null,
          savedVehicleSavedAt: nowIso,
        },
        updatedAt: nowIso,
      });
      if (normalizedLookup) {
        setVehicleLookup(normalizedLookup);
        setVehicleLookupByVrm((current) => ({ ...current, [trackedVrm]: normalizedLookup }));
      }
      await refreshQueue();
      setCarcheckSaveStatus('success');
      setCarcheckSaveNotice(`Saved to this Draft Parking Charge at ${formatCaptureTimestamp(nowIso)}.`);
      setDetailMessage('Vehicle details saved. Reopen anytime from this Draft Parking Charge.');
      setCarcheckDialogMessage('Carcheck details saved and attached to this Draft Parking Charge.');
    } catch (error) {
      console.error('[warden] failed to save carcheck details', error);
      setCarcheckSaveStatus('error');
      setCarcheckSaveNotice(error?.message || 'Save failed. Please retry.');
      setDetailMessage(error?.message || 'Saving carcheck details failed.');
    } finally {
      setCarcheckSaveLoading(false);
    }
  }

  async function queueOrSendCapture({ immediate = false, targetItemId = '', openPcnDialogAfterSync = false } = {}) {
    const resolveObservationMinutesFromCode = (code, fallbackMinutes = 0) => {
      const resolvedCode = String(code || '').trim();
      if (!resolvedCode) return normalizeObservationMinutes(fallbackMinutes);
      const matched = contraventions.find((item) => String(item?.code || '').trim() === resolvedCode) || null;
      if (!matched) return normalizeObservationMinutes(fallbackMinutes);
      return normalizeObservationMinutes(matched.defaultObservationMinutes ?? fallbackMinutes ?? 0);
    };

    if (targetItemId) {
      const existing = (await listQueueItems()).find((item) => item.id === targetItemId);
      if (existing) {
        await syncQueueItem(targetItemId, { openPcnDialogAfterSuccess: openPcnDialogAfterSync });
        return;
      }
    }

    const trackedSiteId = String(selectedTracked?.payload?.siteId || '').trim();
    const effectiveSiteId = String(selectedSiteId || trackedSiteId || '').trim();
    const effectiveSite = sites.find((site) => String(site.id) === effectiveSiteId) || null;
    const effectiveSiteName =
      String(effectiveSite?.name || effectiveSite?.displayName || selectedTracked?.payload?.siteName || effectiveSiteId || '').trim();

    if (!effectiveSiteId) {
      setMessage('Assign a patrol site before submitting.');
      return;
    }
    if (!selectedVrm) {
      setMessage('Enter or capture a VRM first.');
      return;
    }

    if (entryFiles.length === 0) {
      setMessage('Capture opening evidence before creating a breach.');
      return;
    }
    const requiresEntryOcrArtifacts = entryCaptureMode !== 'manual';
    if (!hasCapturePairArtifacts(entryFiles, {
      requireExtractedVrm: requiresEntryOcrArtifacts,
      requirePlateCutoff: requiresEntryOcrArtifacts,
      minimumImages: 1,
    })) {
      setMessage(requiresEntryOcrArtifacts
        ? 'Opening evidence must include full vehicle image, plate cutout, and extracted VRM text. Recapture entry evidence.'
        : 'Opening evidence must include at least 1 image.');
      return;
    }

    if (closingFiles.length === 0) {
      setMessage('Capture closing evidence before creating a breach.');
      return;
    }
    if (!hasCapturePairArtifacts(closingFiles, {
      requireExtractedVrm: false,
      requirePlateCutoff: false,
      minimumImages: 1,
    })) {
      setMessage('Closing evidence must include at least 1 image before submission.');
      return;
    }

    const resolvedContraventionCode = String(
      selectedContraventionCode ||
      selectedTracked?.payload?.selectedContraventionCode ||
      selectedTracked?.payload?.contraventionCode ||
      ''
    ).trim();
    const requiredObservationMinutes = resolveObservationMinutesFromCode(resolvedContraventionCode, selectedObservationMinutes);
    const now = new Date();
    const locationSnapshot = location || (await getCurrentLocation());
    const entryTime = entryCapturedAt || now.toISOString();
    const closingTime = closingCapturedAt || now.toISOString();
    const entryDetection = getPhaseDetectionFromCameraRaw(cameraRawData, 'entry', selectedVrm);
    const closingDetection = getPhaseDetectionFromCameraRaw(cameraRawData, 'closing');
    const sessionEvidence = {
      entry: buildPhaseSessionEvidence({ phase: 'entry', detection: entryDetection, capturedAt: entryTime }),
      closing: buildPhaseSessionEvidence({ phase: 'closing', detection: closingDetection, capturedAt: closingTime }),
    };
    const elapsedMinutes = diffMinutes(entryTime, closingTime);
    const entryMs = new Date(entryTime).getTime();
    const closingMs = new Date(closingTime).getTime();

    if (!Number.isFinite(entryMs) || !Number.isFinite(closingMs) || closingMs <= entryMs) {
      setMessage('Closing evidence must be captured after opening evidence.');
      return;
    }

    const normalizedVrm = normalizeVrm(selectedVrm);
    const savedVehicleLookup = resolveVehicleDetailsForSubmission(normalizedVrm, selectedTracked?.payload || null);

    const payload = stripCarcheckFromPayload({
      vrm: normalizedVrm,
      siteId: effectiveSiteId,
      siteName: effectiveSiteName || 'Site not set',
      source: 'WARDEN',
      wardenId: profile?.uid,
      actorId: profile?.uid,
      contraventionReason: selectedReason,
      status: 'QUEUED_FOR_QC',
      location: locationSnapshot || null,
      observationStartTime: entryTime,
      observationEndTime: closingTime,
      expectedObservationMinutes: requiredObservationMinutes,
      entryCapturedAt: entryTime,
      closingCapturedAt: closingTime,
      realExitObserved: true,
      breachEvidenceMode: 'paired_exit',
      actualMinutes: elapsedMinutes,
      manualNote,
      authorization,
      savedVehicleLookup,
      vehicleDetails: savedVehicleLookup,
      selectedContraventionCode: resolvedContraventionCode,
      contraventionCode: resolvedContraventionCode,
      mainEntryImageIndex,
      mainClosingImageIndex,
      detectedEntryPlateText: entryDetection.plateText,
      detectedEntryPlateCutoffImage: entryDetection.plateCutoffImage,
      detectedEntryPlateConfidence: entryDetection.plateConfidence,
      detectedEntryVehicleImage: entryDetection.vehicleImage,
      startVehicleImage: entryDetection.vehicleImage,
      detectedClosingPlateText: closingDetection.plateText,
      detectedClosingPlateCutoffImage: closingDetection.plateCutoffImage,
      detectedClosingPlateConfidence: closingDetection.plateConfidence,
      detectedClosingVehicleImage: closingDetection.vehicleImage,
      sessionEvidence,
      cameraRawData,
    });

    const files = [
      ...entryFiles.map((file) => ({
        name: file.name,
        type: file.type,
        blob: file,
        phase: 'entry',
      })),
      ...closingFiles.map((file) => ({
        name: file.name,
        type: file.type,
        blob: file,
        phase: 'closing',
      })),
    ];

    let itemId = targetItemId;
    if (targetItemId) {
      const existing = (await listQueueItems()).find((item) => item.id === targetItemId);
      if (existing) {
        await saveQueueItem({
          ...existing,
          payload: {
            ...existing.payload,
            ...payload,
            breachLifecycle: 'READY_FOR_SYNC',
          },
          files,
          status: 'queued',
          updatedAt: new Date().toISOString(),
          lastError: null,
        });
      } else {
        itemId = '';
      }
    }

    if (!itemId) {
      const item = createQueueItem({ payload, files });
      item.payload = { ...item.payload, breachLifecycle: 'READY_FOR_SYNC' };
      itemId = item.id;
      await saveQueueItem(item);
    }

    await refreshQueue();

    if (!online && !immediate) {
      setMessage('Captured offline. The Parking Charge is ready and queued for sync.');
      return;
    }

    await syncQueueItem(itemId, { openPcnDialogAfterSuccess: openPcnDialogAfterSync });
  }

  async function handleSaveDraft() {
    if (!selectedVrm) {
      setMessage('Enter or capture a VRM before saving a draft.');
      return;
    }
    if (entryFiles.length === 0) {
      setMessage('Capture opening evidence before saving a draft.');
      return;
    }
    const requiresEntryOcrArtifacts = entryCaptureMode !== 'manual';
    if (!hasCapturePairArtifacts(entryFiles, {
      requireExtractedVrm: requiresEntryOcrArtifacts,
      requirePlateCutoff: requiresEntryOcrArtifacts,
      minimumImages: 1,
    })) {
      setMessage(requiresEntryOcrArtifacts
        ? 'Opening evidence must include full vehicle image, plate cutout, and extracted VRM text before saving draft.'
        : 'Opening evidence must include at least 1 image before saving draft.');
      return;
    }

    const nowIso = new Date().toISOString();
    const entryTime = entryCapturedAt || nowIso;
    const entryDetection = getPhaseDetectionFromCameraRaw(cameraRawData, 'entry', selectedVrm);
    const entrySessionEvidence = buildPhaseSessionEvidence({
      phase: 'entry',
      detection: entryDetection,
      capturedAt: entryTime,
    });
    const normalizedVrm = normalizeVrm(selectedVrm);
    const savedVehicleLookup = resolveVehicleDetailsForSubmission(normalizedVrm, selectedTracked?.payload || null);

    const draftSiteId = String(selectedSiteId || selectedTracked?.payload?.siteId || '').trim();
    const draftSite = sites.find((site) => String(site.id) === draftSiteId) || null;
    const draftSiteName = String(draftSite?.name || draftSite?.displayName || selectedTracked?.payload?.siteName || '').trim();

    const draftPayload = stripCarcheckFromPayload({
      vrm: normalizedVrm,
      siteId: draftSiteId,
      siteName: draftSiteName || 'Site not set',
      source: 'WARDEN',
      wardenId: profile?.uid,
      actorId: profile?.uid,
      entryCaptureMode,
      contraventionReason: selectedReason,
      status: 'DRAFT_OPEN',
      breachLifecycle: 'DRAFT_OPEN',
      location: location || null,
      observationStartTime: entryTime,
      observationEndTime: null,
      expectedObservationMinutes: selectedObservationMinutes,
      entryCapturedAt: entryTime,
      closingCapturedAt: null,
      manualNote,
      authorization,
      savedVehicleLookup,
      vehicleDetails: savedVehicleLookup,
      selectedContraventionCode,
      mainEntryImageIndex,
      mainClosingImageIndex,
      detectedEntryPlateText: entryDetection.plateText,
      detectedEntryPlateCutoffImage: entryDetection.plateCutoffImage,
      detectedEntryPlateConfidence: entryDetection.plateConfidence,
      detectedEntryVehicleImage: entryDetection.vehicleImage,
      startVehicleImage: entryDetection.vehicleImage,
      sessionEvidence: mergeSessionEvidence(selectedTracked?.payload?.sessionEvidence, entrySessionEvidence),
      cameraRawData,
    });

    const draftFiles = [
      ...entryFiles.map((file) => ({
        name: file.name,
        type: file.type,
        blob: file,
        phase: 'entry',
      })),
    ];

    let draftId = selectedTrackedId;
    if (draftId) {
      const existing = (await listQueueItems()).find((item) => item.id === draftId);
      if (existing) {
        await saveQueueItem({
          ...existing,
          payload: { ...existing.payload, ...draftPayload },
          files: draftFiles,
          status: 'draft',
          updatedAt: nowIso,
          lastError: null,
        });
      } else {
        draftId = '';
      }
    }

    if (!draftId) {
      const item = createQueueItem({ payload: draftPayload, files: draftFiles });
      item.status = 'draft';
      draftId = item.id;
      await saveQueueItem(item);
    }

    await refreshQueue();
    setSelectedTrackedId(draftId);
    setClosingFiles([]);
    setClosingPreviews([]);
    setClosingCapturedAt('');
    setMonitoringSessionStartedAt(entryTime);
    setMonitoringSessionActive(true);
    setMessage('Draft Parking Charge saved. Capture closing evidence later to finalise.');
  }

  async function handleStepperComplete({
    vrm,
    siteId,
    siteName,
    contraventionCode,
    contraventionLabel,
    observationMinutes,
    files,
    note,
    scan = null,
    captureMode = 'scan',
    skippedCapture = false
  }) {
    try {
      setBusy(true);
      const normalizedCaptureMode = String(captureMode || 'scan').toLowerCase() === 'manual' ? 'manual' : 'scan';
      const requiresOcrArtifacts = normalizedCaptureMode !== 'manual';
      const skipCapture = Boolean(skippedCapture);
      if (!skipCapture && !hasCapturePairArtifacts(files, {
        requireExtractedVrm: requiresOcrArtifacts,
        requirePlateCutoff: requiresOcrArtifacts,
        minimumImages: 1,
      })) {
        setMessage(requiresOcrArtifacts
          ? 'Capture requires full vehicle image, plate cutout, and extracted VRM text. Reframe plate and scan again.'
          : 'Capture at least one opening evidence image, then enter VRM manually.');
        return;
      }
      setMessage(`Saving Draft Parking Charge for VRM ${vrm}…`);

      const entryTime = skipCapture ? '' : (normalizeCapturedAt(files?.[0]?.capturedAt) || new Date().toISOString());
      const requiredObservationMinutes = normalizeObservationMinutes(observationMinutes);
      const stepperPreviews = await toPreviewSrcList(files);
      const entryFile = files?.[0] || null;
      const stepperEntryVehicleImage = stepperPreviews[0] || '';
      const stepperScanPlateText = normalizeVrm(scan?.plateText || '');
      const stepperEntryDetection = {
        plateText: stepperScanPlateText || normalizeVrm(entryFile?.detectedPlateText || vrm),
        plateCutoffImage: String(entryFile?.detectedPlateCutoffImage || ''),
        plateConfidence: Number(scan?.confidence || entryFile?.detectedPlateConfidence || 0),
        vehicleImage: stepperEntryVehicleImage,
      };

      const resolvedSiteId = String(siteId || '').trim();
      const resolvedSite = sites.find((site) => String(site.id) === resolvedSiteId) || null;

      const draftPayload = {
        vrm,
        contraventionCode,
        // Store under selectedContraventionCode as well so handleReviewTracked
        // can restore the selection without a key mismatch.
        selectedContraventionCode: contraventionCode,
        contraventionReason: contraventionLabel,
        observationStartTime: entryTime || null,
        observationEndTime: null,
        expectedObservationMinutes: requiredObservationMinutes,
        siteId: resolvedSiteId,
        siteName: siteName || resolvedSite?.name || resolvedSite?.displayName || 'Site not set',
        note,
        entryCaptureMode: normalizedCaptureMode,
        detectedEntryPlateText: skipCapture ? '' : stepperEntryDetection.plateText,
        detectedEntryPlateCutoffImage: skipCapture ? '' : stepperEntryDetection.plateCutoffImage,
        detectedEntryPlateConfidence: skipCapture ? 0 : stepperEntryDetection.plateConfidence,
        detectedEntryVehicleImage: skipCapture ? '' : stepperEntryVehicleImage,
        startVehicleImage: skipCapture ? '' : stepperEntryVehicleImage,
        sessionEvidence: {
          entry: buildPhaseSessionEvidence({ phase: 'entry', detection: skipCapture ? {} : stepperEntryDetection, capturedAt: entryTime || '' }),
          closing: buildPhaseSessionEvidence({ phase: 'closing', detection: {}, capturedAt: '' }),
        },
        cameraRawData: skipCapture
          ? []
          : buildCameraRawRecords(files, stepperPreviews, { phase: 'entry', capturedAt: entryTime, source: 'WARDEN_STEPPER' }),
      };

      const draftFiles = files.map((file, i) => ({
        name: `entry_${i}_${Date.now()}.jpg`,
        type: file.type,
        blob: file,
        phase: 'entry',
      }));

      const item = createQueueItem({ payload: draftPayload, files: draftFiles });
      item.status = 'draft';

      await saveQueueItem(item);
      await refreshQueue();

      setStepperOpen(false);
      setSelectedTrackedId(item.id);
      setActiveTab('tracked');
      setEntryCaptureMode(normalizedCaptureMode);

      // Pre-load the new item into active workflow state using handleReviewTracked
      handleReviewTracked(item);
      setMessage(`Draft Parking Charge started for vehicle ${vrm}.`);
    } catch (e) {
      console.error('[warden] failed to create stepper draft', e);
      setMessage(e.message || 'Error occurred starting Draft Parking Charge.');
    } finally {
      setBusy(false);
    }
  }

  async function syncQueueItemInternal(itemId, { openPcnDialogAfterSuccess = false, forceBreachCapture = false } = {}) {
    const queuedItem = (await listQueueItems()).find((item) => item.id === itemId);
    if (!queuedItem) {
      return { ok: false, error: 'Draft Parking Charge not found for sync' };
    }

    const syncAbortController = new AbortController();
    syncAbortControllersRef.current.set(itemId, syncAbortController);

    const lifecycle = getBreachLifecycle(queuedItem);
    const missingBreachId = !queuedItem?.payload?.breachId;
    const canForceBreachCapture = forceBreachCapture && missingBreachId;

    if (!lifecycle.syncable && queuedItem.status !== 'syncing' && !canForceBreachCapture) {
      setMessage('This Parking Charge is still a draft and needs both opening and closing evidence before submission.');
      return {
        ok: false,
        error: 'This Parking Charge is still a draft and needs both opening and closing evidence before submission.',
      };
    }

    try {
      await updateQueueItem(itemId, { status: 'syncing', attempts: queuedItem.attempts + 1, updatedAt: new Date().toISOString(), lastError: null });
      await refreshQueue();

      const token = await resolveAuthToken();
      const queuedSiteId = String(queuedItem?.payload?.siteId || selectedSiteId || '').trim();
      if (!queuedSiteId) {
        throw new Error('Assign a patrol site before syncing this Parking Charge.');
      }
      const queuedSite = sites.find((site) => String(site.id) === queuedSiteId) || null;
      const queuedSiteName = String(
        queuedItem?.payload?.siteName || queuedSite?.name || queuedSite?.displayName || queuedSiteId || ''
      ).trim();

      const storedFiles = Array.isArray(queuedItem.files) ? queuedItem.files : [];
      let entryEvidenceFiles = storedFiles.filter((file) => file.phase === 'entry');
      let closingEvidenceFiles = storedFiles.filter((file) => file.phase === 'closing');
      const mainEntryIndex = Number.isFinite(Number(queuedItem?.payload?.mainEntryImageIndex))
        ? Number(queuedItem.payload.mainEntryImageIndex)
        : 0;
      const mainClosingIndex = Number.isFinite(Number(queuedItem?.payload?.mainClosingImageIndex))
        ? Number(queuedItem.payload.mainClosingImageIndex)
        : 0;

      if (entryEvidenceFiles.length === 0 && closingEvidenceFiles.length === 0 && storedFiles.length >= 2) {
        entryEvidenceFiles = [storedFiles[0]];
        closingEvidenceFiles = storedFiles.slice(1);
      }

      entryEvidenceFiles = reorderEvidenceByMainIndex(entryEvidenceFiles, mainEntryIndex);
      closingEvidenceFiles = reorderEvidenceByMainIndex(closingEvidenceFiles, mainClosingIndex);

      // If queue persistence is stale, use current in-memory captures for the selected session.
      if ((entryEvidenceFiles.length === 0 || closingEvidenceFiles.length === 0) && itemId === selectedTrackedId) {
        if (entryEvidenceFiles.length === 0 && Array.isArray(entryFiles) && entryFiles.length > 0) {
          entryEvidenceFiles = entryFiles.map((file) => ({
            name: file?.name,
            type: file?.type,
            blob: file,
            phase: 'entry',
          }));
        }

        if (closingEvidenceFiles.length === 0 && Array.isArray(closingFiles) && closingFiles.length > 0) {
          closingEvidenceFiles = closingFiles.map((file) => ({
            name: file?.name,
            type: file?.type,
            blob: file,
            phase: 'closing',
          }));
        }

        if (entryEvidenceFiles.length > 0 && closingEvidenceFiles.length > 0) {
          const existingFiles = Array.isArray(queuedItem.files) ? queuedItem.files : [];
          const preservedFiles = existingFiles.filter((file) => file?.phase !== 'entry' && file?.phase !== 'closing');
          entryEvidenceFiles = reorderEvidenceByMainIndex(entryEvidenceFiles, mainEntryIndex);
          closingEvidenceFiles = reorderEvidenceByMainIndex(closingEvidenceFiles, mainClosingIndex);
          await updateQueueItem(itemId, {
            files: [...preservedFiles, ...entryEvidenceFiles, ...closingEvidenceFiles],
            updatedAt: new Date().toISOString(),
          });
        }
      }

      const hasLocalPairedEvidence = entryEvidenceFiles.length > 0 && closingEvidenceFiles.length > 0;
      const existingPayloadImages = [
        ...(Array.isArray(queuedItem?.payload?.images) ? queuedItem.payload.images : []),
        ...(Array.isArray(queuedItem?.payload?.imageUrls) ? queuedItem.payload.imageUrls : []),
      ]
        .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
        .filter((url, index, all) => all.indexOf(url) === index);

      const cameraRawRecords = Array.isArray(queuedItem?.payload?.cameraRawData)
        ? queuedItem.payload.cameraRawData
        : [];

      const pickFirstHttpUrl = (...candidates) => {
        for (const value of candidates) {
          const candidate = String(value || '').trim();
          if (/^https?:\/\//i.test(candidate)) return candidate;
        }
        return '';
      };

      const payloadEntryCameraRawImage = cameraRawRecords
        .filter((record) => record?.phase === 'entry')
        .map((record) => pickFirstHttpUrl(record?.uploadedUrl, record?.imageUrl, record?.url, record?.publicUrl))
        .find(Boolean) || '';

      const payloadClosingCameraRawImage = cameraRawRecords
        .filter((record) => record?.phase === 'closing')
        .map((record) => pickFirstHttpUrl(record?.uploadedUrl, record?.imageUrl, record?.url, record?.publicUrl))
        .find(Boolean) || '';

      const payloadEntryImage =
        queuedItem?.payload?.evidence?.entry?.imageUrl ||
        queuedItem?.payload?.evidence?.entry?.vehicleImage ||
        payloadEntryCameraRawImage ||
        existingPayloadImages[0] ||
        '';
      const payloadClosingImage =
        queuedItem?.payload?.evidence?.exit?.imageUrl ||
        queuedItem?.payload?.closingEvidence?.imageUrl ||
        queuedItem?.payload?.evidence?.latest?.imageUrl ||
        payloadClosingCameraRawImage ||
        existingPayloadImages[1] ||
        '';

      const hasPayloadPairedEvidence = Boolean(payloadEntryImage && payloadClosingImage);

      if (!hasLocalPairedEvidence && !hasPayloadPairedEvidence) {
        throw new Error('Paired opening and closing evidence is required before sync');
      }

      const entryEvidence = hasLocalPairedEvidence
        ? await uploadEvidenceFiles(entryEvidenceFiles, queuedItem.payload.vrm, queuedSiteId)
        : { vrm: queuedItem.payload.vrm, images: [payloadEntryImage] };
      const closingEvidence = hasLocalPairedEvidence
        ? await uploadEvidenceFiles(closingEvidenceFiles, queuedItem.payload.vrm, queuedSiteId)
        : { vrm: queuedItem.payload.vrm, images: [payloadClosingImage] };

      const vrm = normalizeVrm(closingEvidence.vrm || entryEvidence.vrm || queuedItem.payload.vrm);
      const submissionChecks = await ensurePcnSubmissionChecks({
        vrm,
        siteId: queuedSiteId,
        forceCarcheck: false,
        openDialog: false,
        allowNetwork: false,
      });
      if (!submissionChecks.ok) {
        throw new Error(submissionChecks.error || 'Carcheck or e-permit validation failed');
      }

      const authData = submissionChecks.permitResult || queuedItem?.payload?.authorization || null;
      if (!authData) {
        throw new Error('E-permit check is required before submission. Use Retry e-permit check in Draft PCN details.');
      }
      const { entryTime, closingTime } = resolveObservationWindow(queuedItem.payload || {});
      const allImages = [...(entryEvidence.images || []), ...(closingEvidence.images || [])];
      const cameraRawDataForLos = enrichCameraRawRecordsWithUploadedUrls(
        queuedItem?.payload?.cameraRawData || [],
        entryEvidence.images || [],
        closingEvidence.images || []
      );
      const cameraRawDataForSubmission = sanitizeCameraRawRecordsForSubmission(cameraRawDataForLos);
      const resolvedQueuedVehicleDetails = resolveVehicleDetailsForSubmission(queuedItem?.payload?.vrm, queuedItem?.payload || null);
      const safeQueuedPayload = stripCarcheckFromPayload({
        ...(queuedItem.payload || {}),
        savedVehicleLookup:
          queuedItem?.payload?.savedVehicleLookup ||
          queuedItem?.payload?.vehicleDetails ||
          resolvedQueuedVehicleDetails,
        vehicleDetails:
          queuedItem?.payload?.vehicleDetails ||
          queuedItem?.payload?.savedVehicleLookup ||
          resolvedQueuedVehicleDetails,
      });
      const submissionSafePayload = sanitizePayloadForSubmission(safeQueuedPayload);
      const entryPlateImageUrl = pickUploadedPlateImageUrl(
        entryEvidence.images || [],
        entryEvidenceFiles,
        submissionSafePayload?.detectedEntryPlateCutoffImage || submissionSafePayload?.sessionEvidence?.entry?.plateCutoffImage || ''
      );
      const closingPlateImageUrl = pickUploadedPlateImageUrl(
        closingEvidence.images || [],
        closingEvidenceFiles,
        submissionSafePayload?.detectedClosingPlateCutoffImage || submissionSafePayload?.sessionEvidence?.closing?.plateCutoffImage || ''
      );
      const entryFrame = buildEvidenceFrame(entryEvidence.images?.[0], entryTime, entryPlateImageUrl);
      const closingFrame = buildEvidenceFrame(closingEvidence.images?.[0], closingTime, closingPlateImageUrl);
      const vehicleDetails = buildVehicleDetailsRecord(
        submissionChecks.vehicleDetails ||
          submissionSafePayload?.savedVehicleLookup ||
          submissionSafePayload?.vehicleDetails ||
          queuedItem?.payload?.savedVehicleLookup ||
          queuedItem?.payload?.vehicleDetails ||
          null,
        vrm
      );
      const sessionEvidence = {
        entry: buildPhaseSessionEvidence({
          phase: 'entry',
          capturedAt: entryTime,
          detection: {
            plateText: submissionSafePayload?.detectedEntryPlateText,
            plateCutoffImage: entryPlateImageUrl || submissionSafePayload?.detectedEntryPlateCutoffImage,
            plateConfidence: submissionSafePayload?.detectedEntryPlateConfidence,
            vehicleImage: entryFrame?.imageUrl || submissionSafePayload?.detectedEntryVehicleImage || submissionSafePayload?.startVehicleImage || payloadEntryImage,
          },
        }),
        closing: buildPhaseSessionEvidence({
          phase: 'closing',
          capturedAt: closingTime,
          detection: {
            plateText: submissionSafePayload?.detectedClosingPlateText,
            plateCutoffImage: closingPlateImageUrl || submissionSafePayload?.detectedClosingPlateCutoffImage,
            plateConfidence: submissionSafePayload?.detectedClosingPlateConfidence,
            vehicleImage: closingFrame?.imageUrl || submissionSafePayload?.detectedClosingVehicleImage || payloadClosingImage,
          },
        }),
      };
      const breachPayload = {
        ...submissionSafePayload,
        vrm,
        siteId: queuedSiteId,
        siteName: queuedSiteName || 'Site not set',
        vehicleDetails,
        make: vehicleDetails?.make || submissionSafePayload?.make || null,
        model: vehicleDetails?.model || submissionSafePayload?.model || null,
        colour: vehicleDetails?.color || submissionSafePayload?.colour || submissionSafePayload?.color || null,
        detectedEntryPlateCutoffImage: entryPlateImageUrl || submissionSafePayload?.detectedEntryPlateCutoffImage || '',
        detectedClosingPlateCutoffImage: closingPlateImageUrl || submissionSafePayload?.detectedClosingPlateCutoffImage || '',
        images: allImages,
        imageUrls: allImages,
        evidence: {
          entry: entryFrame,
          latest: closingFrame,
          exit: {
            ...closingFrame,
            realExitObserved: true,
            closedAt: closingTime,
            breachEvidenceMode: 'paired_exit',
          },
        },
        closingEvidence: {
          ...closingFrame,
          realExitObserved: true,
          closedAt: closingTime,
          breachEvidenceMode: 'paired_exit',
        },
        authorization: authData,
        status: 'QUEUED_FOR_QC',
        breachLifecycle: 'SUBMITTED',
        source: 'WARDEN',
        wardenId: profile?.uid,
        actorId: profile?.uid,
        realExitObserved: true,
        breachEvidenceMode: 'paired_exit',
        savedVehicleLookup: vehicleDetails,
        entryTime,
        closedAt: closingTime,
        lastSeen: closingTime,
        actualMinutes: diffMinutes(entryTime, closingTime),
        sessionEvidence,
        cameraRawData: cameraRawDataForSubmission,
      };

      const breachResult = await fetchJson('/api/breaches/wardencapture', {
        method: 'POST',
        token,
        body: breachPayload,
        signal: syncAbortController.signal,
      });

      const breachId = breachResult?.id || breachResult?.breachId || queuedItem?.payload?.breachId || '';
      await updateQueueItem(itemId, {
        status: 'submitted',
        lastError: null,
        updatedAt: new Date().toISOString(),
        payload: {
          ...submissionSafePayload,
          ...breachPayload,
          breachId,
          breachLifecycle: 'SUBMITTED',
          convertedToPcn: false,
        },
      });

      if (openPcnDialogAfterSuccess) {
        const refreshedItems = await listQueueItems();
        const submittedItem = refreshedItems.find((item) => item.id === itemId);
        if (submittedItem) {
          setSelectedTrackedId(submittedItem.id);
          setActiveTab('tracked');
          setPcnReasonInput(getPreferredReason(submittedItem?.payload));
          setConvertError('');
          setMessage('Parking Charge submitted. Use the primary action to complete final PCN submission.');
        }
      }

      setMessage(`Breach submitted successfully (${breachId || vrm}). Final PCN conversion is still required.`);
      setSelectedVrm('');
      setEntryFiles([]);
      setEntryPreviews([]);
      setEntryCapturedAt('');
      setEntryCaptureMode('scan');
      setClosingFiles([]);
      setClosingPreviews([]);
      setClosingCapturedAt('');
      setAuthorization(null);
      setVehicleLookup(null);
      setManualNote('');
      setCameraRawData([]);
      setMonitoringSessionActive(false);
      setMonitoringSessionStartedAt('');
      return { ok: true, breachId, vrm };
    } catch (error) {
      const errorName = String(error?.name || '').toLowerCase();
      const errorMessage = String(error?.message || 'Sync failed');
      const cancelled = errorName === 'aborterror' || isSyncCancelledError(errorMessage);

      if (cancelled) {
        syncAbortControllersRef.current.delete(itemId);
        await updateQueueItem(itemId, {
          status: 'queued',
          lastError: 'Sync cancelled by user',
          updatedAt: new Date().toISOString(),
        });
        setMessage('Sync cancelled. Draft PCN retained in queue.');
        return { ok: false, error: 'Sync cancelled by user' };
      }

      console.error('[warden] sync failed', error);
      await updateQueueItem(itemId, {
        status: 'failed',
        lastError: errorMessage,
        updatedAt: new Date().toISOString()
      });
      setMessage(errorMessage);
      return { ok: false, error: errorMessage };
    } finally {
      syncAbortControllersRef.current.delete(itemId);
      await refreshQueue();
    }
  }

  async function syncQueueItem(itemId, options = {}) {
    return enqueueSyncTask(async () => {
      const maxAttempts = 3;
      let lastResult = { ok: false, error: 'Sync failed' };

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const result = await syncQueueItemInternal(itemId, options);
        if (result?.ok) return result;

        lastResult = result || lastResult;
        const shouldRetry = attempt < maxAttempts && isRetriableSyncError(lastResult?.error);
        if (!shouldRetry) {
          return lastResult;
        }

        const delayMs = getSyncRetryDelayMs(attempt);
        await updateQueueItem(itemId, {
          status: 'queued',
          lastError: `${lastResult?.error || 'Sync failed'} (retry ${attempt + 1}/${maxAttempts})`,
          updatedAt: new Date().toISOString(),
        });
        await refreshQueue();
        setMessage(`Network unstable. Retrying sync (${attempt + 1}/${maxAttempts})...`);
        await sleepMs(delayMs);
      }

      return lastResult;
    }, itemId);
  }

  async function handleConvertToPcn() {
    if (!selectedTracked) return;
    if (convertLoading) return;
    if (!canProceedWithPcnActions) return;

    const trackedItemId = selectedTrackedId || selectedTracked?.id || '';
    if (!trackedItemId) {
      throw new Error('No tracked session selected for final PCN submission.');
    }

    return convertPipelineRef.current.enqueue(async () => {
      setConvertLoading(true);
      setConvertError('');
      try {
        setPcnDialogOpen(false);
        let workingItem = selectedTracked;
        let breachId = workingItem?.payload?.breachId || '';

        const submissionChecks = await ensurePcnSubmissionChecks({
          vrm: workingItem?.vrm || workingItem?.payload?.vrm || selectedVrm,
          siteId: workingItem?.payload?.siteId || selectedSiteId,
          forceCarcheck: false,
          openDialog: false,
          allowNetwork: false,
        });
        if (!submissionChecks.ok) {
          throw new Error(submissionChecks.error || 'Carcheck or e-permit validation failed before PCN submission');
        }

        if (!breachId) {
          setMessage('Submitting evidence package before final PCN submission...');
          const syncResult = await syncQueueItem(trackedItemId, {
            openPcnDialogAfterSuccess: false,
            forceBreachCapture: true,
          });

          if (syncResult?.ok === false) {
            throw new Error(syncResult.error || 'Failed to create breach record during sync');
          }

          const refreshedItems = await listQueueItems();
          const refreshed = refreshedItems.find((item) => item.id === trackedItemId) || null;
          if (refreshed) {
            workingItem = {
              ...selectedTracked,
              payload: refreshed.payload,
              vrm: refreshed?.payload?.vrm || selectedTracked?.vrm,
              siteName: refreshed?.payload?.siteName || selectedTracked?.siteName,
            };
          }
          breachId = workingItem?.payload?.breachId || refreshed?.payload?.breachId || '';
        }

        if (!breachId) {
          throw new Error('Could not create breach record before final PCN submission. Please retry.');
        }

        const token = await resolveAuthToken();
        setMessage('Submitting PCN to backend...');

        const images = [
          ...(Array.isArray(workingItem?.payload?.images) ? workingItem.payload.images : []),
          ...(Array.isArray(workingItem?.payload?.imageUrls) ? workingItem.payload.imageUrls : []),
        ]
          .filter((value) => typeof value === 'string' && value.length > 0)
          .filter((value, index, all) => all.indexOf(value) === index);
        const vehicleDetails = buildVehicleDetailsRecord(
          submissionChecks.vehicleDetails ||
          workingItem?.payload?.vehicleDetails ||
          workingItem?.payload?.savedVehicleLookup ||
          selectedTrackedVehicleDetails ||
          null,
          workingItem?.vrm || selectedTracked?.vrm || selectedVrm
        );
        const resolvedWindow = resolveObservationWindow(workingItem?.payload || {});
        const manualReason = String(pcnReasonInput || '').trim();
        const payloadReason = getPreferredReason(workingItem?.payload || {}, '');
        const finalReason =
          (manualReason && manualReason !== DEFAULT_PCN_REASON && manualReason)
          || String(selectedReason || '').trim()
          || payloadReason
          || manualReason
          || DEFAULT_PCN_REASON;
        const response = await fetchJson('/api/breaches/convert-to-pcn', {
          method: 'POST',
          token,
          signal: syncAbortController.signal,
          body: {
            breachId,
            reason: finalReason,
            notes: `Converted from breach ${breachId}`,
            vrm: workingItem?.vrm || selectedTracked?.vrm,
            observationStartTime: resolvedWindow.entryTime || null,
            observationEndTime: resolvedWindow.closingTime || null,
            timestamp: (
              resolvedWindow.closingTime ||
              workingItem?.observationEndTime ||
              workingItem?.createdAt ||
              new Date().toISOString()
            ),
            siteId: workingItem?.payload?.siteId || '',
            siteName: workingItem?.siteName || '',
            evidence: workingItem?.payload?.evidence || {},
            images,
            vehicleDetails,
          },
        });

        const convertedAt = new Date().toISOString();
        await updateQueueItem(selectedTrackedId || selectedTracked.id, {
          status: 'submitted',
          updatedAt: convertedAt,
          payload: {
            ...(workingItem?.payload || selectedTracked.payload),
            breachLifecycle: 'CONVERTED_TO_PCN',
            convertedToPcn: true,
            convertedAt,
            observationEndTime: resolvedWindow.closingTime || convertedAt,
            closingCapturedAt: resolvedWindow.closingTime || convertedAt,
            pcnReason: finalReason,
            pcnId: response?.id || response?.pcnId || '',
            pcnNumber: response?.pcnNumber || '',
            pcnAmount: Number(response?.amount || 0) > 0 ? Number(response.amount) : Number(workingItem?.payload?.pcnAmount || 0),
          },
        });
        await refreshQueue();
        setDetailMessage('');
        setMessage(`Breach converted to PCN ${response?.pcnNumber || ''} and routed for QA escalation.`);
        setPcnDialogOpen(false);
        setMonitoringSessionActive(false);
        setMonitoringSessionStartedAt('');
        setDemoAlarmAcknowledged(false);
        return response;
      } catch (error) {
        console.error('[warden] convert breach failed', error);
        const failureMessage = error?.message || 'Failed to convert breach to PCN';
        setConvertError(failureMessage);
        setMessage(`PCN submission failed: ${failureMessage}`);
        throw error;
      } finally {
        setConvertLoading(false);
      }
    }, trackedItemId);
  }

  async function syncQueue() {
    const items = await listQueueItems();
    const syncableItems = items.filter((entry) => getBreachLifecycle(entry).syncable || entry.status === 'syncing');

    if (!syncableItems.length) return;

    console.log('[warden] queue sync start', {
      totalPcns: syncableItems.length,
      syncConcurrency: PCN_SYNC_CONCURRENCY,
      uploadConcurrency: IMAGE_UPLOAD_CONCURRENCY,
    });

    const limitSync = createConcurrencyLimiter(PCN_SYNC_CONCURRENCY);
    const results = await Promise.allSettled(
      syncableItems.map((item, index) => limitSync(async () => {
        const syncLabel = `${index + 1}/${syncableItems.length}`;
        console.log(`[warden] pcn sync queue start ${syncLabel}`, {
          itemId: item?.id || null,
          status: item?.status || null,
        });

        const result = await syncQueueItem(item.id);

        console.log(`[warden] pcn sync queue complete ${syncLabel}`, {
          itemId: item?.id || null,
          ok: Boolean(result?.ok),
          error: result?.error || null,
        });

        return result;
      }))
    );

    const failedCount = results.filter((result) => result.status === 'rejected' || !result.value?.ok).length;
    console.log('[warden] queue sync complete', {
      totalPcns: syncableItems.length,
      failedCount,
    });
    if (failedCount > 0) {
      setMessage(`Queue sync completed with ${failedCount} failed item${failedCount === 1 ? '' : 's'}.`);
    }
  }

  async function handleCancelTracked(id) {
    try {
      const controller = syncAbortControllersRef.current.get(id);
      if (controller) {
        controller.abort(new DOMException('Sync cancelled by user', 'AbortError'));
      }
      syncAbortControllersRef.current.delete(id);
      await updateQueueItem(id, {
        status: 'queued',
        lastError: 'Sync cancelled by user',
        updatedAt: new Date().toISOString(),
      });
      await refreshQueue();
      setMessage('Tracked breach sync cancelled. Draft PCN retained in queue.');
    } catch (error) {
      console.error('[warden] cancel tracked breach failed', error);
      setMessage(error?.message || 'Failed to cancel tracked breach');
    }
  }

  async function handleCancelQueuedSync(id) {
    try {
      const controller = syncAbortControllersRef.current.get(id);
      if (controller) {
        controller.abort(new DOMException('Sync cancelled by user', 'AbortError'));
      }
      syncAbortControllersRef.current.delete(id);
      await updateQueueItem(id, {
        status: 'queued',
        lastError: 'Sync cancelled by user',
        updatedAt: new Date().toISOString(),
      });
      await refreshQueue();
      setMessage('Queued sync cancelled. Draft PCN retained in queue.');
    } catch (error) {
      console.error('[warden] cancel queued sync failed', error);
      setMessage(error?.message || 'Failed to cancel queued sync');
    }
  }

  async function handleRetryTracked(id) {
    await syncQueueItem(id);
  }

  async function handleReviewTracked(item) {
    setDetailMessage('');
    setMessage('');
    setSelectedTrackedId(item.id);
    if (item?.payload?.siteId) {
      setSelectedSiteId(item.payload.siteId);
    }
    if (item?.payload?.vrm) {
      setSelectedVrm(item.payload.vrm);
    }
    if (item?.payload?.manualNote) {
      setManualNote(item.payload.manualNote);
    }
    if (item?.payload?.selectedContraventionCode || item?.payload?.contraventionCode) {
      setSelectedContraventionCode(item.payload.selectedContraventionCode || item.payload.contraventionCode);
    }
    if (item?.payload?.contraventionReason) {
      setSelectedReason(item.payload.contraventionReason);
    }
    const trackedVrm = normalizeVrm(item?.payload?.vrm || item?.vrm);
    const payloadAuthorization = item?.payload?.authorization || null;
    if (payloadAuthorization && trackedVrm) {
      setAuthorizationByVrm((current) => ({ ...current, [trackedVrm]: payloadAuthorization }));
    }
    setAuthorization(payloadAuthorization || (trackedVrm ? authorizationByVrm[trackedVrm] || null : null));

    setVehicleLookup(trackedVrm ? (vehicleLookupByVrm[trackedVrm] || null) : null);

    const entryEvidence = (Array.isArray(item.files) ? item.files : [])
      .filter((file) => file?.phase === 'entry' && file?.blob)
      .map((file) => file.blob);
    const closingEvidence = (Array.isArray(item.files) ? item.files : [])
      .filter((file) => file?.phase === 'closing' && file?.blob)
      .map((file) => file.blob);

    setEntryFiles(entryEvidence);
    setEntryCaptureMode(String(item?.payload?.entryCaptureMode || 'scan').toLowerCase() === 'manual' ? 'manual' : 'scan');
    setClosingFiles(closingEvidence);
    const [nextEntryPreviews, nextClosingPreviews] = await Promise.all([
      toPreviewSrcList(entryEvidence),
      toPreviewSrcList(closingEvidence),
    ]);
    setEntryPreviews(nextEntryPreviews);
    setClosingPreviews(nextClosingPreviews);
    setCameraRawData(Array.isArray(item?.payload?.cameraRawData) ? item.payload.cameraRawData : []);
    setMainEntryImageIndex(Number.isFinite(Number(item?.payload?.mainEntryImageIndex)) ? Number(item.payload.mainEntryImageIndex) : 0);
    setMainClosingImageIndex(Number.isFinite(Number(item?.payload?.mainClosingImageIndex)) ? Number(item.payload.mainClosingImageIndex) : 0);
    setEntryCapturedAt(item?.payload?.entryCapturedAt || item?.payload?.observationStartTime || '');
    setClosingCapturedAt(item?.payload?.closingCapturedAt || item?.payload?.observationEndTime || '');

    const sessionStart = item?.payload?.entryCapturedAt || item?.payload?.observationStartTime || '';
    setMonitoringSessionStartedAt(sessionStart);
    setMonitoringSessionActive(Boolean(sessionStart) && !item?.payload?.closingCapturedAt && !item?.payload?.observationEndTime && closingEvidence.length === 0);

    setPcnReasonInput(getPreferredReason(item?.payload));
    setConvertError('');

    const lifecycleLabel = (item?.lifecycle?.label || getBreachLifecycle(item).label || 'session').toLowerCase();
    const itemVrm = item?.vrm || item?.payload?.vrm || selectedVrm || 'vehicle';
    setMessage(`Loaded ${lifecycleLabel} ${itemVrm} for review.`);
  }

  async function handleSetMainEvidenceImage(phase, index) {
    const normalizedPhase = phase === 'closing' ? 'closing' : 'entry';
    const targetIndex = Math.max(0, Number(index) || 0);

    if (normalizedPhase === 'entry') {
      setMainEntryImageIndex(targetIndex);
    } else {
      setMainClosingImageIndex(targetIndex);
    }

    if (!selectedTrackedId) return;

    const payloadKey = normalizedPhase === 'entry' ? 'mainEntryImageIndex' : 'mainClosingImageIndex';
    const selectedPayload = selectedTracked?.payload || {};
    await updateQueueItem(selectedTrackedId, {
      payload: {
        ...selectedPayload,
        [payloadKey]: targetIndex,
      },
      updatedAt: new Date().toISOString(),
    });
    await refreshQueue();
  }

  async function handleDeleteEvidenceImage(phase, index) {
    const normalizedPhase = phase === 'closing' ? 'closing' : 'entry';
    const targetIndex = Math.max(0, Number(index) || 0);
    const sourceFiles = normalizedPhase === 'closing' ? closingFiles : entryFiles;
    const sourcePreviews = normalizedPhase === 'closing' ? closingPreviews : entryPreviews;
    if (!sourceFiles.length || targetIndex >= sourceFiles.length) return;

    const nextFiles = sourceFiles.filter((_, fileIndex) => fileIndex !== targetIndex);
    const nextPreviews = sourcePreviews.filter((_, previewIndex) => previewIndex !== targetIndex);
    const currentMainIndex = normalizedPhase === 'closing' ? mainClosingImageIndex : mainEntryImageIndex;
    const nextMainIndex = nextFiles.length === 0
      ? 0
      : (currentMainIndex > targetIndex
        ? currentMainIndex - 1
        : Math.min(currentMainIndex, nextFiles.length - 1));

    if (normalizedPhase === 'closing') {
      setClosingFiles(nextFiles);
      setClosingPreviews(nextPreviews);
      setMainClosingImageIndex(nextMainIndex);
      if (nextFiles.length === 0) {
        setClosingCapturedAt('');
      }
    } else {
      setEntryFiles(nextFiles);
      setEntryPreviews(nextPreviews);
      setMainEntryImageIndex(nextMainIndex);
      if (nextFiles.length === 0) {
        setEntryCapturedAt('');
      }
    }

    if (!selectedTrackedId) {
      setMessage(`${normalizedPhase === 'closing' ? 'Closing' : 'Entry'} photo deleted.`);
      return;
    }

    try {
      const queuedItem = (await listQueueItems()).find((item) => item.id === selectedTrackedId) || null;
      const selectedPayload = queuedItem?.payload || selectedTracked?.payload || {};
      const existingFiles = Array.isArray(queuedItem?.files) ? queuedItem.files : [];
      const phaseFiles = existingFiles.filter((file) => file?.phase === normalizedPhase);
      const preservedFiles = existingFiles.filter((file) => file?.phase !== normalizedPhase);
      const nextPhaseFiles = phaseFiles.filter((_, fileIndex) => fileIndex !== targetIndex);

      const payloadKey = normalizedPhase === 'closing' ? 'mainClosingImageIndex' : 'mainEntryImageIndex';
      const capturedAtKey = normalizedPhase === 'closing' ? 'closingCapturedAt' : 'entryCapturedAt';

      await updateQueueItem(selectedTrackedId, {
        payload: {
          ...selectedPayload,
          [payloadKey]: nextMainIndex,
          [capturedAtKey]: nextPhaseFiles.length > 0 ? selectedPayload[capturedAtKey] : null,
          observationEndTime: normalizedPhase === 'closing' && nextPhaseFiles.length === 0
            ? null
            : selectedPayload?.observationEndTime,
          breachLifecycle: normalizedPhase === 'closing' && nextPhaseFiles.length === 0
            ? 'DRAFT_OPEN'
            : selectedPayload?.breachLifecycle,
        },
        files: [...preservedFiles, ...nextPhaseFiles],
        updatedAt: new Date().toISOString(),
      });
      await refreshQueue();
      setMessage(`${normalizedPhase === 'closing' ? 'Closing' : 'Entry'} photo deleted.`);
    } catch (error) {
      console.error('[warden] failed to delete evidence image', error);
      setMessage(error?.message || 'Failed to delete evidence image');
    }
  }

  async function handleFinalize({ openPcnDialogAfterSync = false } = {}) {
    if (!canProceedWithPcnActions) return;
    await persistTrackedPcnDetails({ silent: true });
    const checks = await ensurePcnSubmissionChecks({ forceCarcheck: false, openDialog: false, allowNetwork: false });
    if (!checks.ok) return;

    setPendingFinalize({
      action: 'sync',
      openPcnDialogAfterSync,
    });
    setPcnPreviewOpen(true);
  }

  async function handleOpenPcnSubmitPreview() {
    if (!canProceedWithPcnActions) return;
    await persistTrackedPcnDetails({ silent: true });
    const checks = await ensurePcnSubmissionChecks({ forceCarcheck: false, openDialog: false, allowNetwork: false });
    if (!checks.ok) return;

    setPendingFinalize({
      action: 'convert',
      openPcnDialogAfterSync: false,
    });
    setPcnPreviewOpen(true);
  }

  async function confirmFinalize() {
    if (!pendingFinalize) return;
    if (!canProceedWithPcnActions) return;

    await persistTrackedPcnDetails({ silent: true });

    const checks = await ensurePcnSubmissionChecks({ forceCarcheck: false, openDialog: false, allowNetwork: false });
    if (!checks.ok) return;

    setPcnPreviewOpen(false);
    if (pendingFinalize.action === 'convert') {
      try {
        await handleConvertToPcn();
      } finally {
        setPendingFinalize(null);
      }
      return;
    }

    setBusy(true);
    try {
      setLocation((await getCurrentLocation()) || location);
      await queueOrSendCapture({
        targetItemId: selectedTrackedId || '',
        openPcnDialogAfterSync: pendingFinalize.openPcnDialogAfterSync,
      });
    } finally {
      setBusy(false);
      setPendingFinalize(null);
    }
  }

  async function handleRestartSession() {
    if (!selectedTracked) return;

    const nowIso = new Date().toISOString();
    const basePayload = stripCarcheckFromPayload(selectedTracked?.payload || {});
    const restartPayload = {
      ...basePayload,
      vrm: normalizeVrm(selectedTracked?.payload?.vrm || selectedTracked?.vrm || selectedVrm),
      siteId: selectedTracked?.payload?.siteId || selectedSiteId,
      siteName: selectedTracked?.payload?.siteName || selectedTracked?.siteName || selectedSite?.name || selectedSite?.displayName || selectedSiteId,
      status: 'DRAFT_OPEN',
      breachLifecycle: 'DRAFT_OPEN',
      observationStartTime: nowIso,
      observationEndTime: null,
      entryCapturedAt: null,
      closingCapturedAt: null,
      actualMinutes: 0,
      convertedToPcn: false,
      convertedAt: null,
      pcnId: '',
      pcnNumber: '',
      pcnAmount: null,
      pcnReason: '',
      breachId: '',
      cameraRawData: [],
      manualNote: [basePayload?.manualNote, 'Session restarted after closure'].filter(Boolean).join('\n'),
    };

    const restartItem = createQueueItem({ payload: restartPayload, files: [] });
    restartItem.status = 'draft';

    await saveQueueItem(restartItem);
    await refreshQueue();

    setSelectedTrackedId(restartItem.id);
    setActiveTab('tracked');
    setSelectedVrm(restartPayload.vrm || '');
    setSelectedSiteId(restartPayload.siteId || selectedSiteId);
    setEntryFiles([]);
    setEntryPreviews([]);
    setEntryCapturedAt('');
    setEntryCaptureMode('scan');
    setMainEntryImageIndex(0);
    setClosingFiles([]);
    setClosingPreviews([]);
    setClosingCapturedAt('');
    setMainClosingImageIndex(0);
    setCameraRawData([]);
    setMonitoringSessionActive(false);
    setMonitoringSessionStartedAt('');
    setPcnDialogOpen(false);
    setConvertError('');
    setMessage(`Restarted Draft Parking Charge for ${restartPayload.vrm || selectedTracked.vrm}. Capture opening evidence to begin a new observation.`);
  }

  async function handlePrimaryCaptureAction() {
    if (primaryCaptureAction.key === 'capture-entry') {
      openCaptureDialog('entry');
      return;
    }
    if (primaryCaptureAction.key === 'start-monitoring') {
      startMonitoringSession();
      return;
    }
    if (primaryCaptureAction.key === 'capture-closing') {
      openCaptureDialog('closing');
      return;
    }
    await handleFinalize();
  }

  function selectContravention(code) {
    const next = contraventions.find((item) => item.code === code) || contraventions[0];
    setSelectedContraventionCode(String(next?.code || '').trim());
    if (next) {
      setSelectedReason(next.label);
      setManualObservationMinutes(Number(next.defaultObservationMinutes ?? 0));
      setPcnReasonInput(next.label || '');
      return;
    }
    setSelectedReason('');
    setManualObservationMinutes(0);
  }

  if (!profile) {
    return (
      <div className="screen-loading">
        <LoadingSpinner />
        <span>Loading secure patrol workspace…</span>
      </div>
    );
  }

  // Derived: which screen is active
  const currentScreen =
    activeTab === 'tracked' && selectedTrackedId ? 'detail' : activeTab;

  return (
    <div className="warden-app">

      {/* ─── APP HEADER ─────────────────────────────────────────────── */}
      <header className="app-header">
        {currentScreen === 'detail' ? (
          <button
            type="button"
            className="app-header-back"
            onClick={() => {
              setSelectedTrackedId('');
              setDetailMessage('');
              setMessage('');
            }}
          >
            ‹ Back
          </button>
        ) : (
          <span className="app-header-brand">LDK Warden</span>
        )}

        <div className="app-header-center">
          {currentScreen === 'detail' && selectedTracked ? (
            <span className="app-header-vrm">{selectedTracked.vrm}</span>
          ) : currentScreen === 'queue' ? (
            <span>Sync Queue</span>
          ) : currentScreen === 'mobile' ? (
            <span>Mobile Cameras</span>
          ) : currentScreen === 'camera' ? (
            <span>Camera Raw Data</span>
          ) : (
            <span>Active Sessions</span>
          )}
        </div>

        <div className="app-header-right">
          <span
            className={`conn-dot ${online ? 'conn-dot--online' : 'conn-dot--offline'}`}
            title={online ? 'Online' : 'Offline'}
          />
          <button
            type="button"
            className="header-settings-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            title="Settings"
          >
            ⚙
          </button>
          <button type="button" className="header-logout-btn" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      {/* ─── SESSIONS SCREEN ────────────────────────────────────────── */}
      {currentScreen === 'tracked' ? (
        <main className="screen-body">
          {/* Summary bar */}
          {(() => {
            const openCount = trackedBreaches.filter(i => i.lifecycle.code === 'DRAFT_OPEN').length;
            const readyCount = trackedBreaches.filter(i => i.lifecycle.code === 'READY').length;
            if (openCount === 0 && readyCount === 0) return null;
            return (
              <div className="sessions-summary-bar">
                {openCount > 0 ? (
                  <span><strong>{openCount}</strong> active</span>
                ) : null}
                {readyCount > 0 ? (
                  <span className="sessions-summary-ready">
                    <strong>{readyCount}</strong> ready to issue
                  </span>
                ) : null}
              </div>
            );
          })()}

          {/* Filter pills */}
          <div className="filter-pills">
            {[
              { key: 'all', label: 'All', count: trackedBreaches.length },
              { key: 'open', label: 'Open', count: trackedBreaches.filter(i => i.lifecycle.code === 'DRAFT_OPEN').length },
              { key: 'ready', label: 'Ready', count: trackedBreaches.filter(i => i.lifecycle.code === 'READY').length },
              { key: 'failed', label: 'Failed', count: trackedBreaches.filter(i => i.lifecycle.code === 'FAILED').length },
            ].map(f => (
              <button
                key={f.key}
                type="button"
                className={`filter-pill ${breachStatusFilter === f.key ? 'filter-pill--active' : ''}`}
                onClick={() => setBreachStatusFilter(f.key)}
              >
                {f.label}
                {f.count > 0 ? (
                  <span className="filter-pill-count">{f.count}</span>
                ) : null}
              </button>
            ))}
          </div>

          {/* Site selector */}
          {sites.length > 1 ? (
            <select
              className="site-filter-select site-filter-select--home"
              value={selectedSiteId}
              onChange={e => { setSelectedSiteId(e.target.value); saveStoredSiteId(e.target.value); }}
            >
              <option value="">No site</option>
              {sites.map(site => (
                <option key={site.id} value={site.id}>
                  {site.displayName || site.name || site.id}
                </option>
              ))}
            </select>
          ) : null}

          {mobileCameras.length > 0 ? (
            <select
              className="site-filter-select site-filter-select--home"
              value={selectedMobileCameraId}
              onChange={async (event) => {
                await handleLinkSelectedMobileCamera(event.target.value);
              }}
              style={{ marginTop: 8 }}
            >
              <option value="">No vehicle camera linked (warden-only)</option>
              {mobileCamerasByAvailability.map((camera) => (
                <option key={camera.id} value={camera.id}>
                  {(camera.available ? 'Available' : 'Offline')} - {camera.name || camera.id}
                </option>
              ))}
            </select>
          ) : null}

          {/* Session cards */}
          {filteredBreaches.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🚗</div>
              <p className="empty-title">No parking charges yet</p>
              <p className="empty-hint">Tap <strong>+</strong> to create a Draft Parking Charge</p>
            </div>
          ) : (
            <div className="sessions-list">
              {filteredBreaches.map(item => {
                const timedOut = item.lifecycle.code === 'DRAFT_OPEN' && item.isPastRequired;
                const lcKey = item.lifecycle.code.toLowerCase().replace(/_/g, '-');
                return (
                  <article
                    key={item.id}
                    className={[
                      'session-card',
                      item.lifecycle.code === 'DRAFT_OPEN' && item.isOpen ? 'session-card--active' : '',
                      item.lifecycle.code === 'DRAFT_OPEN' && timedOut ? 'session-card--overtime' : '',
                      item.lifecycle.code === 'READY' ? 'session-card--ready' : '',
                      item.lifecycle.code === 'FAILED' ? 'session-card--failed' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => handleReviewTracked(item)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => e.key === 'Enter' && handleReviewTracked(item)}
                  >
                    <div className="sc-left">
                      <div className="sc-plate">{item.vrm}</div>
                      <div className="sc-site">{item.siteName}</div>
                      <div className="sc-reason">{item.reason}</div>
                      <div className="sc-meta">
                        <span className={`lc-badge lc-${lcKey}`}>{item.lifecycle.label}</span>
                        <span className="sc-evidence">
                          {item.entryCount}↑&nbsp;{item.closingCount}↓
                        </span>
                      </div>
                    </div>
                    <div className="sc-right">
                      {item.isOpen ? (
                        <>
                          <div className="sc-timer">
                            <span className="sc-timer-icon">⏱</span>
                            <span className="sc-timer-val">{item.requiredMinutes > 0 ? formatRemaining(item.remainingSeconds) : formatElapsed(item.observationStartTime)}</span>
                          </div>
                          {item.isPastRequired ? (
                            <div className="sc-cta-pill sc-cta-pill--overtime" style={{ marginTop: 6 }}>
                              Alarm
                            </div>
                          ) : null}
                        </>
                      ) : item.lifecycle.code === 'READY' ? (
                        <div className="sc-cta-pill sc-cta-pill--ready">Issue PCN →</div>
                      ) : timedOut ? (
                        <div className="sc-cta-pill sc-cta-pill--overtime">Capture closing →</div>
                      ) : item.lifecycle.code === 'CONVERTED' ? (
                        <div className="sc-cta-pill sc-cta-pill--closed">Closed</div>
                      ) : null}
                      <span className="sc-chevron" aria-hidden>›</span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {message ? (
            <div className="notice notice-info" style={{ marginTop: 16 }}>{message}</div>
          ) : null}
        </main>
      ) : null}

      {/* ─── DETAIL SCREEN ──────────────────────────────────────────── */}
      {currentScreen === 'detail' && selectedTracked ? (
        <main className="screen-body detail-screen">

          {/* Vehicle hero */}
          <div className="detail-hero">
            <div className="detail-plate-hero">{selectedTracked.vrm}</div>
            <div className="detail-hero-meta">
              <span className="detail-site">{selectedTracked.siteName}</span>
              <span className={`lc-badge lc-${selectedTracked.lifecycle.code.toLowerCase().replace(/_/g, '-')}`}>
                {selectedTracked.lifecycle.label}
              </span>
            </div>
            <div className="detail-contravention">{selectedTracked.reason}</div>
          </div>

          {/* Observation timer */}
          {selectedTracked.observationStartTime ? (
            <div className={`obs-card ${selectedTracked.isOpen ? 'obs-card--active' : 'obs-card--done'}`}>
              <span className="obs-dot" />
              <div className="obs-text">
                <div className="obs-label">
                  {selectedTracked.isOpen ? 'Consideration active (countdown)' : 'Exit captured'}
                </div>
                <div className="obs-value">Remaining: {selectedTracked.requiredMinutes > 0 ? formatRemaining(selectedTracked.remainingSeconds) : `${selectedTracked.elapsedMinutes || 0} min`}</div>
                {selectedTracked.isOpen ? (
                  <div className="obs-value" style={{ color: 'var(--danger, #ff6b6b)', fontWeight: 700 }}>
                    Capture closing evidence before the countdown reaches zero.
                  </div>
                ) : null}
              </div>
              <div className="obs-countdown">
                {selectedTracked.isOpen && selectedTracked.requiredMinutes > 0
                  ? formatRemaining(selectedTracked.remainingSeconds)
                  : formatElapsed(selectedTracked.observationStartTime, selectedTracked.observationEndTime)}
              </div>
            </div>
          ) : null}

          {demoObservationExpired ? (
            <div className="notice notice-error" style={{ marginTop: 12 }}>
              Demo consideration time has expired. Acknowledge the alarm before closing the PCN.
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="action-btn action-btn--issue"
                  onClick={() => setDemoAlarmAcknowledged(true)}
                >
                  Acknowledge alarm
                </button>
              </div>
            </div>
          ) : null}

          {selectedTracked?.lifecycle?.code === 'CONVERTED' ? (
            <div className="notice notice-info">
              Session closed: converted to formal PCN. Observation timer is stopped.
            </div>
          ) : null}

          {/* Draft PCN details */}
          <div className="detail-section">
            <div className="detail-section-label">Draft PCN details</div>
            <label className="stepper-field" style={{ marginBottom: 8 }}>
              <span className="stepper-field-label">Patrol site</span>
              <select
                className="stepper-select"
                value={selectedSiteId}
                onChange={(event) => setSelectedSiteId(event.target.value)}
              >
                <option value="">Select site</option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.displayName || site.name || site.id}
                  </option>
                ))}
              </select>
            </label>

            <label className="stepper-field" style={{ marginBottom: 8 }}>
              <span className="stepper-field-label">Contravention reason</span>
              <select
                className="stepper-select"
                value={selectedContraventionCode}
                onChange={(event) => selectContravention(event.target.value)}
              >
                {!contraventions.length ? (
                  <option value="">No enabled contraventions for this site</option>
                ) : null}
                {contraventions.map((c, index) => (
                  <option key={c.code || `detail-contravention-${index + 1}`} value={c.code || ''}>
                    {getContraventionSelectionLabel(c)}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="action-btn action-btn--secondary"
              onClick={() => persistTrackedPcnDetails({ silent: false })}
              disabled={busy}
            >
              Save PCN details
            </button>
          </div>

          {/* E-permit lookup */}
          <div className="detail-section">
            <div className="detail-section-label">E-permit lookup</div>
            <label className="stepper-field" style={{ marginBottom: 8 }}>
              <span className="stepper-field-label">VRM (editable)</span>
              <input
                className="stepper-vrm-input"
                value={selectedVrm}
                onChange={(event) => setSelectedVrm(normalizeVrm(event.target.value))}
                onBlur={persistSelectedTrackedVrm}
                placeholder="AB12CDE"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="action-btn action-btn--secondary"
              disabled={!selectedVrm || busy}
              onClick={persistSelectedTrackedVrm}
            >
              Save VRM
            </button>
            <button
              type="button"
              className="action-btn action-btn--secondary"
              disabled={!selectedVrm || busy}
              onClick={async () => {
                await persistSelectedTrackedVrm();
                await handlePermitLookup();
              }}
              style={{ marginTop: 8 }}
            >
              Retry e-permit check
            </button>
            <button
              type="button"
              className="action-btn action-btn--secondary"
              disabled={!selectedVrm || busy || vehicleLookupLoading}
              onClick={retryDraftChecks}
              style={{ marginTop: 8 }}
            >
              Retry carcheck + e-permit
            </button>

            {selectedTrackedAuthorization ? (
              <div className={`auth-result ${selectedTrackedAuthorization.hasAuthorization ? 'auth-result--ok' : 'auth-result--none'}`}>
                <span className="auth-result-icon">{selectedTrackedAuthorization.hasAuthorization ? '✓' : '✗'}</span>
                <div className="auth-result-content">
                  <div className="auth-result-text">
                    {selectedTrackedAuthorization.hasAuthorization
                      ? `Authorised - ${selectedTrackedAuthorization.authorization?.type || 'permit found'}`
                      : 'No active permit or payment found'}
                  </div>
                  {Number(selectedTrackedAuthorization?.matchConfidence?.scorePercent || 0) > 0
                  && String(selectedTrackedAuthorization?.matchConfidence?.bestVrm || '').trim() ? (
                    <div className="auth-match-pill" role="status" aria-label="Closest exemption match confidence">
                      <span className="auth-match-pill-label">Closest exemption match</span>
                      <span className="auth-match-pill-vrm">{selectedTrackedAuthorization.matchConfidence.bestVrm}</span>
                      <span className="auth-match-pill-score">{selectedTrackedAuthorization.matchConfidence.scorePercent}%</span>
                    </div>
                    ) : null}
                  {selectedTrackedAuthorization.authorization?.site ? (
                    <div className="auth-result-sub">{selectedTrackedAuthorization.authorization.site}</div>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
                No check run yet
              </p>
            )}

          </div>

          {/* Carcheck */}
          <div className="detail-section">
            <div className="detail-section-label">Carcheck</div>
            <button
              type="button"
              className="action-btn action-btn--secondary"
              onClick={async () => {
                await persistSelectedTrackedVrm();
                await handleVehicleLookup();
              }}
              disabled={!selectedVrm || busy || vehicleLookupLoading}
              style={{ marginBottom: 10 }}
            >
              {vehicleLookupLoading ? 'Running carcheck...' : 'Retry carcheck'}
            </button>
            {selectedTrackedVehicleDetails ? (
              <button
                type="button"
                className="carcheck-open-btn"
                onClick={() => {
                  const trackedVrm = selectedTracked?.payload?.vrm || selectedTracked?.vrm;
                  if (!trackedVrm) return;
                  setSelectedVrm(trackedVrm);
                  setCarcheckDialogMessage(
                    `Reopened saved carcheck${selectedTrackedVehicleDetails.make || selectedTrackedVehicleDetails.model ? `: ${[selectedTrackedVehicleDetails.make, selectedTrackedVehicleDetails.model].filter(Boolean).join(' ')}` : ''}.`
                  );
                  setCarcheckSaveNotice('');
                  setCarcheckSaveStatus('idle');
                  setCarcheckDialogOpen(true);
                }}
              >
                <span className="carcheck-open-btn-title">
                  {selectedTracked?.payload?.savedVehicleSavedAt ? 'Saved carcheck result' : 'Carcheck result ready'}
                </span>
                <span className="carcheck-open-btn-sub">
                  {[
                    selectedTrackedVehicleDetails.make,
                    selectedTrackedVehicleDetails.model,
                    selectedTrackedVehicleDetails.color,
                  ].filter(Boolean).join(' · ') || 'Open vehicle details'}
                </span>
                <span className="carcheck-open-btn-arrow">Open</span>
              </button>
            ) : (
              <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
                No carcheck run yet
              </p>
            )}
          </div>

          {/* Evidence */}
          <div className="detail-section">
            <div className="detail-section-label">Evidence</div>
            <div className="evidence-pair">
              {/* Entry */}
              <div className="evidence-frame">
                <div className="evidence-frame-label">Entry</div>
                {entryPreviews.length > 0 ? (
                  <>
                    <div className="evidence-thumbs">
                      {entryPreviews.map((p, i) => (
                        <div
                          key={i}
                          className="evidence-thumb-stack"
                          style={{ border: mainEntryImageIndex === i ? '2px solid #00d084' : '1px solid transparent' }}
                        >
                          <button
                            type="button"
                            className="evidence-thumb-button"
                            onClick={() => openImageDetailDialog({
                              src: p,
                              label: `Entry ${i + 1}`,
                              phase: 'entry',
                              imageIndex: i,
                              allowDelete: true,
                              isMain: mainEntryImageIndex === i,
                              file: entryFiles[i] || null,
                              capturedAt: entryFiles[i]?.capturedAt || entryCapturedAt,
                              fileName: entryFiles[i]?.name || `entry_${i + 1}.jpg`,
                              mimeType: entryFiles[i]?.type || '',
                              sizeBytes: Number(entryFiles[i]?.size || 0),
                            })}
                            title="Open image details"
                          >
                            <img src={p} alt={`Entry ${i + 1}`} className="evidence-thumb" />
                            <span className="evidence-thumb-badge">
                              {mainEntryImageIndex === i ? 'MAIN' : 'VIEW'}
                            </span>
                          </button>
                          <button
                            type="button"
                            className={`evidence-main-btn ${mainEntryImageIndex === i ? 'evidence-main-btn--active' : ''}`}
                            onClick={() => handleSetMainEvidenceImage('entry', i)}
                            title={mainEntryImageIndex === i ? 'Main entry image' : 'Set as main entry image'}
                          >
                            {mainEntryImageIndex === i ? 'Main image' : 'Set main'}
                          </button>
                          <button
                            type="button"
                            className="evidence-delete-btn"
                            onClick={() => handleDeleteEvidenceImage('entry', i)}
                            title="Delete entry image"
                          >
                            Delete
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="evidence-count">{entryFiles.length} photo{entryFiles.length !== 1 ? 's' : ''}</div>
                    <button type="button" className="evidence-add-btn" onClick={() => openCaptureDialog('entry')}>+ Add</button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="evidence-capture-btn"
                    onClick={() => openCaptureDialog('entry')}
                  >
                    <span className="evidence-capture-icon">📷</span>
                    <span>Capture entry</span>
                  </button>
                )}
              </div>

              {/* Closing */}
              <div className="evidence-frame">
                <div className="evidence-frame-label">Closing</div>
                {closingPreviews.length > 0 ? (
                  <>
                    <div className="evidence-thumbs">
                      {closingPreviews.map((p, i) => (
                        <div
                          key={i}
                          className="evidence-thumb-stack"
                          style={{ border: mainClosingImageIndex === i ? '2px solid #00d084' : '1px solid transparent' }}
                        >
                          <button
                            type="button"
                            className="evidence-thumb-button"
                            onClick={() => openImageDetailDialog({
                              src: p,
                              label: `Closing ${i + 1}`,
                              phase: 'closing',
                              imageIndex: i,
                              allowDelete: true,
                              isMain: mainClosingImageIndex === i,
                              file: closingFiles[i] || null,
                              capturedAt: closingFiles[i]?.capturedAt || closingCapturedAt,
                              fileName: closingFiles[i]?.name || `closing_${i + 1}.jpg`,
                              mimeType: closingFiles[i]?.type || '',
                              sizeBytes: Number(closingFiles[i]?.size || 0),
                            })}
                            title="Open image details"
                          >
                            <img src={p} alt={`Closing ${i + 1}`} className="evidence-thumb" />
                            <span className="evidence-thumb-badge">
                              {mainClosingImageIndex === i ? 'MAIN' : 'VIEW'}
                            </span>
                          </button>
                          <button
                            type="button"
                            className={`evidence-main-btn ${mainClosingImageIndex === i ? 'evidence-main-btn--active' : ''}`}
                            onClick={() => handleSetMainEvidenceImage('closing', i)}
                            title={mainClosingImageIndex === i ? 'Main closing image' : 'Set as main closing image'}
                          >
                            {mainClosingImageIndex === i ? 'Main image' : 'Set main'}
                          </button>
                          <button
                            type="button"
                            className="evidence-delete-btn"
                            onClick={() => handleDeleteEvidenceImage('closing', i)}
                            title="Delete closing image"
                          >
                            Delete
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="evidence-count">{closingFiles.length} photo{closingFiles.length !== 1 ? 's' : ''}</div>
                    <button type="button" className="evidence-add-btn" onClick={() => openCaptureDialog('closing')}>+ Add</button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="evidence-capture-btn"
                    onClick={() => openCaptureDialog('closing')}
                  >
                    <span className="evidence-capture-icon">📷</span>
                    <span>Capture closing</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ─── Primary actions ─── */}
          <div className="detail-actions">

            {/* Capture closing evidence */}
            {entryFiles.length > 0 && closingFiles.length === 0 ? (
              <button type="button" className="action-btn action-btn--primary" onClick={() => openCaptureDialog('closing')}>
                📷 Capture closing evidence
              </button>
            ) : null}

            {/* Single submit flow: sync evidence (if needed) and submit PCN once */}
            {canIssuePcnFromCurrentState ? (
                <div className="pcn-gate-card">
                  <div className="pcn-gate-row">
                    <span className={`pcn-status-pill ${pcnSubmissionGate.ready ? 'pcn-status-pill--ok' : 'pcn-status-pill--warn'}`}>
                      {pcnSubmissionGate.ready ? 'Checks passed' : 'Checks required'}
                    </span>
                    <span className="pcn-gate-message">{pcnSubmissionGate.message}</span>
                  </div>
                  <div className="pcn-gate-actions">
                    <button
                      type="button"
                      className="action-btn action-btn--issue pcn-submit-cta"
                      onClick={async () => {
                        if (!canProceedWithPcnActions) return;
                        await persistTrackedPcnDetails({ silent: true });
                        if (!pcnSubmissionGate.ready) {
                          setDetailMessage('Checks required. Use Retry carcheck and Retry e-permit check in Draft PCN details.');
                          return;
                        }
                        await handleOpenPcnSubmitPreview();
                      }}
                      disabled={busy || convertLoading || !canProceedWithPcnActions}
                    >
                      {convertLoading
                        ? 'Submitting...'
                        : (pcnSubmissionGate.ready
                          ? (selectedTracked?.payload?.breachId ? '📋 Submit PCN to backend' : '📋 Sync and submit PCN')
                          : 'Checks required before submit')}
                    </button>
                  </div>
                </div>
              ) : null}

            {convertError ? <div className="notice notice-error">{convertError}</div> : null}

            {['SUBMITTED', 'CONVERTED'].includes(selectedTracked?.lifecycle?.code) ? (
              <button
                type="button"
                className="action-btn action-btn--secondary"
                onClick={handleRestartSession}
              >
                Restart session
              </button>
            ) : null}

          </div>

          {detailMessage && !hideDetailMessageForClosedSession ? (
            <div className="notice notice-info" style={{ marginTop: 12 }}>{detailMessage}</div>
          ) : null}

          {/* Danger zone */}
          <div className="detail-danger">
            <button
              type="button"
              className="action-btn action-btn--danger"
              onClick={() => handleCancelTracked(selectedTracked.id)}
            >
              🗑 Delete session
            </button>
          </div>

        </main>
      ) : null}

      {/* ─── QUEUE SCREEN ───────────────────────────────────────────── */}
      {currentScreen === 'queue' ? (
        <main className="screen-body">

          <div className="detail-section">
            <div className="detail-section-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Pending sync</span>
              {syncCandidates.length > 0 ? (
                <button
                  type="button"
                  className="action-btn action-btn--secondary"
                  style={{ fontSize: 12, padding: '5px 12px' }}
                  onClick={syncQueue}
                  disabled={syncing}
                >
                  {syncing ? 'Syncing…' : `Sync all (${syncCandidates.length})`}
                </button>
              ) : null}
            </div>

            {syncCandidates.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">✓</div>
                <p className="empty-title">All synced</p>
                <p className="empty-hint">No pending items</p>
              </div>
            ) : (
              <div className="sessions-list">
                {syncCandidates.map(item => {
                  const lcKey = (item.lifecycle?.code || 'unknown').toLowerCase().replace(/_/g, '-');
                  return (
                    <article key={item.id} className="session-card">
                      <div className="sc-left">
                        <div className="sc-plate">{item.vrm}</div>
                        <div className="sc-site">{item.siteName}</div>
                        {item.lastError ? (
                          <div className="sc-error">{item.lastError}</div>
                        ) : null}
                      </div>
                      <div className="sc-right">
                        <span className={`lc-badge lc-${lcKey}`}>{item.status}</span>
                        {item.status === 'failed' ? (
                          <button
                            type="button"
                            className="action-btn action-btn--secondary"
                            style={{ fontSize: 12, padding: '4px 10px', marginTop: 4 }}
                            onClick={() => openSubmitPreviewForTracked(item.id)}
                          >
                            Review & retry
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="action-btn action-btn--secondary"
                          style={{ fontSize: 12, padding: '4px 10px', marginTop: 4 }}
                          onClick={() => handleCancelQueuedSync(item.id)}
                        >
                          Cancel sync
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          {activeTimers.length > 0 ? (
            <div className="detail-section">
              <div className="detail-section-label">Active timers</div>
              <div className="sessions-list">
                {activeTimers.map(timer => (
                  <article key={timer.id} className="session-card session-card--active">
                    <div className="sc-left">
                      <div className="sc-plate">{timer.vrm}</div>
                      <div className="sc-site">{timer.siteName}</div>
                    </div>
                    <div className="sc-right">
                      <div className="sc-timer">
                        <span className="sc-timer-icon">⏱</span>
                        <span className="sc-timer-val">{timer.requiredMinutes > 0 ? formatRemaining(timer.remainingSeconds) : formatElapsed(timer.startsAt)}</span>
                      </div>
                      {timer.requiredMinutes > 0 ? <div className="text-muted" style={{ fontSize: 11 }}>Baseline {timer.requiredMinutes}m</div> : null}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

        </main>
      ) : null}

      {/* ─── MOBILE CAMERAS SCREEN ─────────────────────────────────── */}
      {currentScreen === 'mobile' ? (
        <main className="screen-body">
          <div className="detail-section">
            <div className="detail-section-label">Mobile cameras</div>

            <div className="settings-row settings-row--stacked" style={{ marginBottom: 14 }}>
              <span className="settings-row-label">Linked vehicle camera for this shift</span>
              <select
                className="site-filter-select"
                value={selectedMobileCameraId}
                onChange={async (event) => {
                  await handleLinkSelectedMobileCamera(event.target.value);
                }}
              >
                <option value="">No vehicle camera linked</option>
                {mobileCamerasByAvailability.map((camera) => (
                  <option key={camera.id} value={camera.id}>
                    {(camera.available ? 'Available' : 'Offline')} - {camera.name || camera.id}
                  </option>
                ))}
              </select>
            </div>

            {mobileCamerasByAvailability.length === 0 ? (
              <div className="empty-state" style={{ padding: '20px 12px' }}>
                <div className="empty-icon">🚐</div>
                <p className="empty-title">No mobile cameras found</p>
                <p className="empty-hint">Flag a camera as mobile in camera management first.</p>
              </div>
            ) : (
              <div className="sessions-list">
                {mobileCamerasByAvailability.map((camera) => {
                  const draft = mobileCameraDrafts[camera.id] || {
                    name: camera?.name || '',
                    ipAddress: camera?.ipAddress || '',
                    macAddress: camera?.macAddress || ''
                  };
                  const assignmentSiteId = mobileCameraAssignmentSites[camera.id] || camera?.siteId || '';
                  const assignmentSite = sites.find((site) => String(site.id) === String(assignmentSiteId || '')) || null;

                  return (
                    <article key={camera.id} className="session-card">
                      <div style={{ width: '100%' }}>
                        <div className="sc-left" style={{ display: 'block' }}>
                          <div className="sc-plate">{camera.name || camera.id}</div>
                          <div className="sc-site">
                            {camera.available ? 'Available now' : 'Not recently active'}
                            {camera.lastSeen ? ` • Last seen ${new Date(camera.lastSeen).toLocaleString()}` : ''}
                          </div>
                          <div className="sc-reason">Assigned site: {sites.find((site) => String(site.id) === String(camera.siteId || ''))?.name || 'Unassigned'}</div>
                        </div>

                        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                          <input
                            type="text"
                            value={draft.name}
                            onChange={(event) => updateMobileCameraDraft(camera.id, 'name', event.target.value)}
                            placeholder="Camera name"
                          />
                          <input
                            type="text"
                            value={draft.ipAddress}
                            onChange={(event) => updateMobileCameraDraft(camera.id, 'ipAddress', event.target.value)}
                            placeholder="Camera IP"
                          />
                          <input
                            type="text"
                            value={draft.macAddress}
                            onChange={(event) => updateMobileCameraDraft(camera.id, 'macAddress', event.target.value)}
                            placeholder="Camera MAC"
                          />
                          <select
                            value={assignmentSiteId}
                            onChange={(event) => updateMobileCameraAssignmentSite(camera.id, event.target.value)}
                          >
                            <option value="">Select camera assignment site</option>
                            {sites.map((site) => (
                              <option key={site.id} value={site.id}>
                                {site.displayName || site.name || site.id}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="action-btn action-btn--secondary"
                            onClick={() => saveMobileCameraDetails(camera.id)}
                            disabled={mobileCameraSavingId === camera.id}
                            style={{ fontSize: 12, padding: '6px 10px' }}
                          >
                            {mobileCameraSavingId === camera.id ? 'Saving details...' : 'Save name/IP/MAC'}
                          </button>
                          <button
                            type="button"
                            className="action-btn action-btn--secondary"
                            onClick={async () => {
                              await assignMobileCameraToSite(camera.id, assignmentSiteId);
                            }}
                            disabled={mobileCameraAssigning || !assignmentSiteId}
                            style={{ fontSize: 12, padding: '6px 10px' }}
                          >
                            {mobileCameraAssigning && selectedMobileCameraId === camera.id
                              ? 'Assigning...'
                              : `Activate at ${assignmentSite?.name || 'selected site'}`}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {detailMessage ? (
              <div className="notice notice-info" style={{ marginTop: 12 }}>{detailMessage}</div>
            ) : null}
          </div>
        </main>
      ) : null}

      {/* ─── CAMERA RAW SCREEN ─────────────────────────────────────── */}
      {currentScreen === 'camera' ? (
        <main className="screen-body">
          <div className="detail-section">
            <div className="camera-raw-toolbar">
              <div className="detail-section-label">Camera raw data feed</div>
              {cameraRawFeed.length > 0 ? (
                <div className="camera-raw-view-toggle" role="group" aria-label="Camera raw view mode">
                  <button
                    type="button"
                    className={`camera-raw-view-btn ${cameraRawViewMode === 'grid' ? 'camera-raw-view-btn--active' : ''}`}
                    onClick={() => setCameraRawViewMode('grid')}
                  >
                    Grid
                  </button>
                  <button
                    type="button"
                    className={`camera-raw-view-btn ${cameraRawViewMode === 'list' ? 'camera-raw-view-btn--active' : ''}`}
                    onClick={() => setCameraRawViewMode('list')}
                  >
                    List
                  </button>
                </div>
              ) : null}
            </div>
            {cameraRawFeed.length > 0 ? (
              <div className="camera-raw-filters" role="region" aria-label="Camera raw filters">
                <input
                  type="text"
                  className="camera-raw-search"
                  placeholder="Search by VRM"
                  value={cameraRawVrmQuery}
                  onChange={(event) => setCameraRawVrmQuery(event.target.value.toUpperCase())}
                />
                <select
                  className="camera-raw-site-filter"
                  value={cameraRawSiteFilter}
                  onChange={(event) => setCameraRawSiteFilter(event.target.value)}
                >
                  <option value="all">All sites</option>
                  {cameraRawSiteOptions.map((siteName) => (
                    <option key={siteName} value={siteName}>
                      {siteName}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {filteredCameraRawFeed.length > 0 ? (
              cameraRawViewMode === 'list' ? (
                <div className="camera-raw-list">
                  {filteredCameraRawFeed.map((item, index) => (
                    <article className="camera-raw-list-item" key={item.recordKey || `camera-raw-${index}`}>
                      {resolveCameraRawImageSrc(item) ? (
                        <button
                          type="button"
                          className="camera-raw-image-btn"
                          onClick={() => openImageDetailDialog({
                            src: resolveCameraRawImageSrc(item),
                            label: `${item?.phase === 'closing' ? 'Closing' : 'Entry'} raw capture ${index + 1}`,
                            phase: item?.phase === 'closing' ? 'closing' : 'entry',
                            isMain: false,
                            capturedAt: item?.capturedAt || '',
                            fileName: item?.fileName || `capture_${index + 1}.jpg`,
                            mimeType: item?.mimeType || '',
                            sizeBytes: Number(item?.sizeBytes || 0),
                            record: item,
                          })}
                        >
                          <img
                            src={resolveCameraRawImageSrc(item)}
                            alt={`${item?.phase === 'closing' ? 'Closing' : 'Entry'} raw capture ${index + 1}`}
                            className="camera-raw-list-image"
                          />
                        </button>
                      ) : (
                        <div className="camera-raw-list-placeholder">No image</div>
                      )}
                      <div className="camera-raw-meta camera-raw-meta--list">
                        <span className={`camera-raw-phase ${item?.phase === 'closing' ? 'camera-raw-phase--closing' : 'camera-raw-phase--entry'}`}>
                          {item?.phase === 'closing' ? 'Closing' : 'Entry'}
                        </span>
                        <span className="camera-raw-filename">
                          {item?.fileName || `Capture ${index + 1}`}
                          {item?.imageRole === 'plate_cutoff' ? ' · Plate cutout' : ' · Full vehicle'}
                        </span>
                        <span className="camera-raw-subline">
                          {item?.vrm || 'Unknown VRM'} · {item?.siteName || 'Site'}
                        </span>
                        <span className="camera-raw-subline">
                          {item?.capturedAt ? formatCaptureTimestamp(item.capturedAt) : 'Capture time pending'}
                        </span>
                        <span className="camera-raw-subline">
                          {item?.uploadedUrl ? 'Synced for LOS forwarding' : 'Queued for LOS forwarding'}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="camera-raw-grid">
                  {filteredCameraRawFeed.map((item, index) => (
                    <article className="camera-raw-card" key={item.recordKey || `camera-raw-${index}`}>
                      {resolveCameraRawImageSrc(item) ? (
                        <button
                          type="button"
                          className="camera-raw-image-btn"
                          onClick={() => openImageDetailDialog({
                            src: resolveCameraRawImageSrc(item),
                            label: `${item?.phase === 'closing' ? 'Closing' : 'Entry'} raw capture ${index + 1}`,
                            phase: item?.phase === 'closing' ? 'closing' : 'entry',
                            isMain: false,
                            capturedAt: item?.capturedAt || '',
                            fileName: item?.fileName || `capture_${index + 1}.jpg`,
                            mimeType: item?.mimeType || '',
                            sizeBytes: Number(item?.sizeBytes || 0),
                            record: item,
                          })}
                        >
                          <img
                            src={resolveCameraRawImageSrc(item)}
                            alt={`${item?.phase === 'closing' ? 'Closing' : 'Entry'} raw capture ${index + 1}`}
                            className="camera-raw-image"
                          />
                        </button>
                      ) : null}
                      <div className="camera-raw-meta">
                        <span className={`camera-raw-phase ${item?.phase === 'closing' ? 'camera-raw-phase--closing' : 'camera-raw-phase--entry'}`}>
                          {item?.phase === 'closing' ? 'Closing' : 'Entry'}
                        </span>
                        <span className="camera-raw-filename">
                          {item?.fileName || `Capture ${index + 1}`}
                          {item?.imageRole === 'plate_cutoff' ? ' · Plate cutout' : ' · Full vehicle'}
                        </span>
                        <span className="camera-raw-subline">
                          {item?.vrm || 'Unknown VRM'} · {item?.siteName || 'Site'}
                        </span>
                        <span className="camera-raw-subline">
                          {item?.capturedAt ? formatCaptureTimestamp(item.capturedAt) : 'Capture time pending'}
                        </span>
                        <span className="camera-raw-subline">
                          {item?.uploadedUrl ? 'Synced for LOS forwarding' : 'Queued for LOS forwarding'}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              )
            ) : (
              <div className="empty-state" style={{ padding: '24px 12px' }}>
                <div className="empty-icon">📷</div>
                <p className="empty-title">No camera raw captures found</p>
                <p className="empty-hint">
                  {cameraRawFeed.length > 0
                    ? 'Try a different VRM or site filter.'
                    : 'Vehicle evidence captures will auto-populate here.'}
                </p>
              </div>
            )}
          </div>
        </main>
      ) : null}

      {/* ─── BOTTOM NAV ─────────────────────────────────────────────── */}
      <nav className="bottom-nav" aria-label="Main navigation">
        <button
          type="button"
          className={`bottom-nav-btn ${activeTab === 'tracked' ? 'bottom-nav-btn--active' : ''}`}
          onClick={() => {
            setActiveTab('tracked');
            setSelectedTrackedId('');
            setDetailMessage('');
            setMessage('');
          }}
        >
          <span className="bottom-nav-icon" aria-hidden="true">🚗</span>
          <span className="bottom-nav-label">Sessions</span>
          {trackedBreaches.filter(i => ['DRAFT_OPEN', 'READY'].includes(i.lifecycle.code)).length > 0 ? (
            <span className="bottom-nav-badge">
              {trackedBreaches.filter(i => ['DRAFT_OPEN', 'READY'].includes(i.lifecycle.code)).length}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={`bottom-nav-btn ${activeTab === 'queue' ? 'bottom-nav-btn--active' : ''}`}
          onClick={() => setActiveTab('queue')}
        >
          <span className="bottom-nav-icon" aria-hidden="true">⬆</span>
          <span className="bottom-nav-label">Queue</span>
          {syncCandidates.length > 0 ? (
            <span className="bottom-nav-badge">{syncCandidates.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={`bottom-nav-btn ${activeTab === 'camera' ? 'bottom-nav-btn--active' : ''}`}
          onClick={() => setActiveTab('camera')}
        >
          <span className="bottom-nav-icon" aria-hidden="true">📷</span>
          <span className="bottom-nav-label">Camera</span>
        </button>
        <button
          type="button"
          className={`bottom-nav-btn ${activeTab === 'mobile' ? 'bottom-nav-btn--active' : ''}`}
          onClick={() => setActiveTab('mobile')}
        >
          <span className="bottom-nav-icon" aria-hidden="true">🚐</span>
          <span className="bottom-nav-label">Mobile</span>
        </button>
      </nav>

      {imageDetailDialog.open ? (
        <div
          className="carcheck-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Image viewer"
          onClick={closeImageDetailDialog}
        >
          <div
            className={`carcheck-sheet image-detail-sheet ${imageDetailDialog.fullscreen ? 'image-detail-sheet--fullscreen' : ''}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="carcheck-sheet-header">
              <div>
                <div className="carcheck-sheet-kicker">Evidence image</div>
                <div className="carcheck-sheet-title">{imageDetailDialog.label || 'Image details'}</div>
                <div className="image-detail-subtitle">
                  {imageDetailDialog.phase ? `${imageDetailDialog.phase === 'closing' ? 'Closing' : 'Entry'} evidence` : 'Capture'}
                  {imageDetailDialog.isMain ? ' · Main image' : ''}
                </div>
              </div>
              <div className="image-detail-actions">
                {imageDetailDialog.allowDelete ? (
                  <button type="button" className="evidence-delete-btn image-detail-delete-btn" onClick={handleDeleteFromImageDetail}>
                    Delete
                  </button>
                ) : null}
                <button type="button" className="ghost-button" onClick={toggleImageDetailFullscreen}>
                  {imageDetailDialog.fullscreen ? 'Window' : 'Full'}
                </button>
                <button type="button" className="ghost-button stepper-close" onClick={closeImageDetailDialog}>
                  ✕
                </button>
              </div>
            </div>

            <div className="carcheck-sheet-body">
              <img
                src={imageDetailDialog.src}
                alt={imageDetailDialog.label || 'Evidence image'}
                className="image-detail-preview"
              />

              {imageDetailDialog.loading ? (
                <div className="notice notice-info">Preparing image…</div>
              ) : null}
              {imageDetailDialog.error ? (
                <div className="notice notice-error">{imageDetailDialog.error}</div>
              ) : null}

              <div className="image-detail-meta-strip">
                <span>
                  {imageDetailDialog.capturedAt
                    ? `Captured ${formatCaptureTimestamp(imageDetailDialog.capturedAt)}`
                    : 'Capture time unavailable'}
                </span>
                <span>
                  {imageDetailDialog.dimensions?.width && imageDetailDialog.dimensions?.height
                    ? `${imageDetailDialog.dimensions.width} × ${imageDetailDialog.dimensions.height}`
                    : ''}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div
          className="carcheck-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onClick={() => setSettingsOpen(false)}
        >
          <div className="carcheck-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="carcheck-sheet-header">
              <div>
                <div className="carcheck-sheet-kicker">Preferences</div>
                <div className="carcheck-sheet-title">Settings</div>
              </div>
              <button type="button" className="ghost-button stepper-close" onClick={() => setSettingsOpen(false)}>
                ✕
              </button>
            </div>

            <div className="carcheck-sheet-body settings-panel">
              <div className="detail-section-label">Appearance</div>
              <div className="settings-row">
                <span className="settings-row-label">Theme</span>
                <button
                  type="button"
                  className={`theme-toggle-btn ${darkMode ? 'theme-toggle-btn--dark' : 'theme-toggle-btn--light'}`}
                  aria-pressed={darkMode}
                  aria-label={`Switch to ${darkMode ? 'light' : 'dark'} mode`}
                  onClick={() => setDarkMode((current) => !current)}
                >
                  <span className="theme-toggle-btn-track">
                    <span className="theme-toggle-btn-thumb" />
                  </span>
                  <span className="theme-toggle-btn-label">{darkMode ? 'Dark' : 'Light'}</span>
                </button>
              </div>

              <div className="detail-section-label" style={{ marginTop: 8 }}>Operations</div>
              <div className="settings-row">
                <span className="settings-row-label">Auto-submit after closing capture</span>
                <button
                  type="button"
                  className={`theme-toggle-btn ${autoSubmitOnClosingCapture ? 'theme-toggle-btn--dark' : 'theme-toggle-btn--light'}`}
                  aria-pressed={autoSubmitOnClosingCapture}
                  aria-label="Toggle auto-submit after closing capture"
                  onClick={() => setAutoSubmitOnClosingCapture((current) => !current)}
                >
                  <span className="theme-toggle-btn-track">
                    <span className="theme-toggle-btn-thumb" />
                  </span>
                  <span className="theme-toggle-btn-label">{autoSubmitOnClosingCapture ? 'On' : 'Off'}</span>
                </button>
              </div>
              <div className="settings-row settings-row--stacked">
                <span className="settings-row-label">Active site</span>
                <select
                  className="site-filter-select"
                  value={selectedSiteId}
                  onChange={(event) => {
                    setSelectedSiteId(event.target.value);
                    saveStoredSiteId(event.target.value);
                  }}
                >
                  <option value="">No site</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.displayName || site.name || site.id}
                    </option>
                  ))}
                </select>
              </div>

              <div className="detail-section-label" style={{ marginTop: 8 }}>Vehicle Camera</div>
              <div className="settings-row settings-row--stacked">
                <span className="settings-row-label">Linked mobile ANPR camera</span>
                <select
                  className="site-filter-select"
                  value={selectedMobileCameraId}
                  onChange={async (event) => {
                    await handleLinkSelectedMobileCamera(event.target.value);
                  }}
                >
                  <option value="">No vehicle camera linked</option>
                  {mobileCamerasByAvailability.map((camera) => (
                    <option key={camera.id} value={camera.id}>
                      {(camera.available ? 'Available' : 'Offline')} - {camera.name || camera.id}
                    </option>
                  ))}
                </select>
                {selectedMobileCamera ? (
                  <small className="muted-text" style={{ marginTop: 6 }}>
                    Current backend site: {selectedMobileCameraSite?.displayName || selectedMobileCameraSite?.name || 'Unassigned'}.
                    Selecting this dropdown only changes which camera is linked for capture. It does not change camera site assignment.
                  </small>
                ) : null}
                {!selectedMobileCamera ? (
                  <small className="muted-text" style={{ marginTop: 6 }}>
                    Leave this blank to work in warden-only mode with no vehicle camera attached.
                  </small>
                ) : null}
                {mobileCameras.length === 0 ? (
                  <small className="muted-text" style={{ marginTop: 6 }}>
                    No mobile cameras are flagged yet in the backend camera registry.
                  </small>
                ) : null}
                {mobileCameraAssigning ? (
                  <small className="muted-text" style={{ marginTop: 6 }}>
                    Updating selected vehicle camera site assignment...
                  </small>
                ) : null}
              </div>

              <button
                type="button"
                className="action-btn action-btn--secondary"
                onClick={syncQueue}
                disabled={syncing}
              >
                {syncing ? 'Syncing...' : 'Sync now'}
              </button>

              <button
                type="button"
                className="action-btn action-btn--secondary"
                onClick={() => {
                  setActiveTab('tracked');
                  setSelectedTrackedId('');
                  setDetailMessage('');
                  setSettingsOpen(false);
                }}
              >
                Open parking charges
              </button>

              <button
                type="button"
                className="action-btn action-btn--danger"
                onClick={handleLogout}
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ─── FAB ────────────────────────────────────────────────────── */}
      {currentScreen !== 'detail' && currentScreen !== 'mobile' ? (
        <button
          type="button"
          className="fab-new-breach"
          onClick={() => setStepperOpen(true)}
          aria-label="Start Draft Parking Charge"
          title="Start Draft Parking Charge"
        >
          +
        </button>
      ) : null}

      {/* ─── Stepper ────────────────────────────────────────────────── */}
      <BreachStepper
        open={stepperOpen}
        onClose={() => setStepperOpen(false)}
        onComplete={handleStepperComplete}
        sites={sites}
        contraventions={contraventions}
        selectedSiteId={selectedSiteId}
        onPlateScan={scanPlateFromImage}
      />

      <BreachStepper
        open={captureStepperOpen}
        onClose={() => setCaptureStepperOpen(false)}
        onCaptureComplete={handleStepperCaptureComplete}
        sites={sites}
        contraventions={contraventions}
        selectedSiteId={selectedSiteId}
        onPlateScan={scanPlateFromImage}
        mode="capture-only"
        capturePhase={captureStepperPhase}
      />

      {carcheckDialogOpen ? (
        <div
          className="carcheck-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Carcheck result"
          onClick={() => {
            setCarcheckDialogOpen(false);
            setCarcheckDialogMessage('');
            setCarcheckSaveNotice('');
            setCarcheckSaveStatus('idle');
            setCarcheckSaveLoading(false);
          }}
        >
          <div className="carcheck-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="carcheck-sheet-header">
              <div>
                <div className="carcheck-sheet-kicker">Carcheck result</div>
                <div className="carcheck-sheet-title">
                  {selectedTrackedVehicleDetails?.make || vehicleLookup?.make || selectedTracked?.vrm || selectedVrm || 'Vehicle'} {selectedTrackedVehicleDetails?.model || vehicleLookup?.model || ''}
                </div>
              </div>
              <button
                type="button"
                className="ghost-button stepper-close"
                onClick={() => {
                  setCarcheckDialogOpen(false);
                  setCarcheckDialogMessage('');
                  setCarcheckSaveNotice('');
                  setCarcheckSaveStatus('idle');
                  setCarcheckSaveLoading(false);
                }}
              >
                ✕
              </button>
            </div>

            <div className="carcheck-sheet-body">
              {carcheckDialogMessage ? <div className="notice notice-info">{carcheckDialogMessage}</div> : null}
              {carcheckSaveNotice ? (
                <div
                  className={`notice ${carcheckSaveStatus === 'success' ? 'notice-success' : carcheckSaveStatus === 'error' ? 'notice-error' : 'notice-info'}`}
                  role="status"
                  aria-live="polite"
                >
                  {carcheckSaveNotice}
                </div>
              ) : null}

              {selectedTrackedVehicleDetails || vehicleLookup ? (
                <>
                  {selectedTrackedVehicleImageUrl || vehicleLookup?.imageUrl || vehicleLookup?.imageUrls?.[0] ? (
                    <img
                      src={selectedTrackedVehicleImageUrl || vehicleLookup?.imageUrl || vehicleLookup?.imageUrls?.[0]}
                      alt={`Vehicle ${selectedTrackedVehicleDetails?.vrm || vehicleLookup?.vrm || selectedTracked?.vrm || selectedVrm || 'lookup'}`}
                      className="carcheck-sheet-image"
                    />
                  ) : null}

                  <div className="carcheck-sheet-grid">
                    <div className="carcheck-field">
                      <span className="carcheck-field-label">VRM</span>
                      <span className="carcheck-field-value">{selectedTrackedVehicleDetails?.vrm || vehicleLookup?.vrm || selectedTracked?.vrm || selectedVrm || '—'}</span>
                    </div>
                    <div className="carcheck-field">
                      <span className="carcheck-field-label">Colour</span>
                      <span className="carcheck-field-value">{selectedTrackedVehicleDetails?.color || vehicleLookup?.color || 'Unknown'}</span>
                    </div>
                    <div className="carcheck-field">
                      <span className="carcheck-field-label">Year</span>
                      <span className="carcheck-field-value">{selectedTrackedVehicleDetails?.yearOfManufacture || vehicleLookup?.yearOfManufacture || 'Unknown'}</span>
                    </div>
                    <div className="carcheck-field">
                      <span className="carcheck-field-label">Fuel</span>
                      <span className="carcheck-field-value">{selectedTrackedVehicleDetails?.fuelType || vehicleLookup?.fuelType || 'Unknown'}</span>
                    </div>
                  </div>
                </>
              ) : (
                <p className="card-copy">No vehicle data returned for this lookup.</p>
              )}

              <div className="vehicle-result-actions">
                <button
                  type="button"
                  className="action-btn action-btn--secondary"
                  style={{ padding: '10px 14px', fontSize: 13 }}
                  onClick={handleSaveCarcheckDetails}
                  disabled={carcheckSaveLoading || !canSaveCarcheckDetails}
                >
                  {carcheckSaveLoading
                    ? 'Saving details...'
                    : isCurrentCarcheckAlreadySaved
                      ? 'Details saved'
                      : 'Save details'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {false ? (
        <div
          className="carcheck-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Convert to formal PCN"
          onClick={() => setPcnDialogOpen(false)}
        >
          <div className="carcheck-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="carcheck-sheet-header">
              <div>
                <div className="carcheck-sheet-kicker">PCN submission</div>
                <div className="carcheck-sheet-title">Confirm and submit PCN</div>
                <div className="pcn-sheet-subtitle">Review the case summary before final backend submission.</div>
              </div>
              <button type="button" className="ghost-button stepper-close" onClick={() => setPcnDialogOpen(false)}>
                ✕
              </button>
            </div>

            <div className="carcheck-sheet-body">
              <div className="pcn-summary">
                <div className="pcn-summary-title">Submission preview</div>
                <div className="pcn-summary-grid">
                  <div className="pcn-summary-row">
                    <span className="pcn-summary-key">VRM</span>
                    <span className="pcn-summary-value">{selectedTracked?.vrm || selectedTracked?.payload?.vrm || '—'}</span>
                  </div>
                  <div className="pcn-summary-row">
                    <span className="pcn-summary-key">Contravention</span>
                    <span className="pcn-summary-value">{selectedTracked?.reason || selectedTracked?.payload?.contraventionReason || '—'}</span>
                  </div>
                  <div className="pcn-summary-row">
                    <span className="pcn-summary-key">Observation Time</span>
                    <span className="pcn-summary-value">{pcnPreview.entryTime ? formatCaptureTimestamp(pcnPreview.entryTime) : '—'}</span>
                  </div>
                  <div className="pcn-summary-row">
                    <span className="pcn-summary-key">Contravention Time</span>
                    <span className="pcn-summary-value">{pcnPreview.closingTime ? formatCaptureTimestamp(pcnPreview.closingTime) : '—'}</span>
                  </div>
                  <div className="pcn-summary-row">
                    <span className="pcn-summary-key">Observed Duration</span>
                    <span className="pcn-summary-value">{pcnPreview.durationMinutes || 0} min</span>
                  </div>
                  <div className="pcn-summary-row">
                    <span className="pcn-summary-key">E-permit</span>
                    <span className={`pcn-summary-value pcn-status-pill ${pcnPreview.permitStatus === 'Matched' ? 'pcn-status-pill--ok' : 'pcn-status-pill--warn'}`}>
                      {pcnPreview.permitStatus}
                    </span>
                  </div>
                  <div className="pcn-summary-row">
                    <span className="pcn-summary-key">Payment</span>
                    <span className={`pcn-summary-value pcn-status-pill ${pcnPreview.paymentStatus === 'Matched' ? 'pcn-status-pill--ok' : 'pcn-status-pill--warn'}`}>
                      {pcnPreview.paymentStatus}
                    </span>
                  </div>
                </div>

                {pcnPreview.observationCapture?.imageUrl || pcnPreview.contraventionCapture?.imageUrl ? (
                  <div className="pcn-summary-images pcn-summary-images--timeline">
                    <div className="pcn-summary-image-card">
                      <div className="pcn-summary-image-label">Observation</div>
                      <div className="pcn-summary-image-frame">
                        {pcnPreview.observationCapture?.imageUrl ? (
                          <img
                            src={pcnPreview.observationCapture.imageUrl}
                            alt="Observation capture"
                            className="pcn-summary-image"
                          />
                        ) : (
                          <div className="pcn-summary-image-empty">No observation image</div>
                        )}
                        <div className="pcn-summary-image-time pcn-summary-image-time--overlay">
                          {pcnPreview.observationCapture?.capturedAt
                            ? formatCaptureTimestamp(pcnPreview.observationCapture.capturedAt)
                            : 'Capture time unavailable'}
                        </div>
                      </div>
                    </div>
                    <div className="pcn-summary-image-card">
                      <div className="pcn-summary-image-label">Contravention</div>
                      <div className="pcn-summary-image-frame">
                        {pcnPreview.contraventionCapture?.imageUrl ? (
                          <img
                            src={pcnPreview.contraventionCapture.imageUrl}
                            alt="Contravention capture"
                            className="pcn-summary-image"
                          />
                        ) : (
                          <div className="pcn-summary-image-empty">No contravention image</div>
                        )}
                        <div className="pcn-summary-image-time pcn-summary-image-time--overlay">
                          {pcnPreview.contraventionCapture?.capturedAt
                            ? formatCaptureTimestamp(pcnPreview.contraventionCapture.capturedAt)
                            : 'Capture time unavailable'}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
                    No preview images available yet.
                  </p>
                )}
              </div>

              <div className="pcn-convert-form">
                <label className="pcn-form-label">Reason
                  <textarea
                    className="pcn-form-control pcn-form-control--textarea"
                    value={pcnReasonInput}
                    onChange={(event) => setPcnReasonInput(event.target.value)}
                    rows={3}
                  />
                </label>
                {convertError ? <div className="notice notice-error">{convertError}</div> : null}
              </div>

              <div className="vehicle-result-actions pcn-dialog-actions">
                <button
                  type="button"
                  className="action-btn action-btn--secondary pcn-dialog-btn"
                  onClick={() => setPcnDialogOpen(false)}
                >
                  Close
                </button>
                <button
                  type="button"
                  className="action-btn action-btn--primary pcn-dialog-btn"
                  onClick={handleOpenPcnSubmitPreview}
                  disabled={convertLoading}
                >
                  {convertLoading
                    ? 'Submitting…'
                    : (selectedTracked?.payload?.breachId ? '📋 Submit PCN to backend' : '📋 Sync and submit PCN')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* PCN Preview Dialog */}
      <PcnPreviewDialog
        open={pcnPreviewOpen}
        loading={busy}
        data={{
          vrm: selectedVrm || selectedTracked?.vrm || selectedTracked?.payload?.vrm || '',
          siteName: selectedSite?.name || selectedSite?.displayName || selectedTracked?.siteName || selectedSiteId,
          contraventionReason: selectedReason || selectedTracked?.reason || selectedTracked?.payload?.contraventionReason || '',
          observationStartTime: pcnPreview.entryTime || '',
          observationEndTime: pcnPreview.closingTime || '',
          observationStartLabel: pcnPreview.observationCapture?.capturedAtUk || '',
          observationEndLabel: pcnPreview.contraventionCapture?.capturedAtUk || '',
          actualMinutes: diffMinutes(
            pcnPreview.entryTime || '',
            pcnPreview.closingTime || ''
          ),
          mainEntryImagePreview: entryPreviews[mainEntryImageIndex] || '',
          mainClosingImagePreview: closingPreviews[mainClosingImageIndex] || '',
          location,
          manualNote,
          wardenId: profile?.uid || '',
          permitStatus: pcnPreview.permitStatus || 'Not checked',
          permitWarning: selectedTrackedAuthorization?.hasAuthorization
            ? 'Active permit/payment found for this site. Continue only if another parking rule was breached, such as disabled bay misuse or another contravention.'
            : '',
        }}
        onConfirm={confirmFinalize}
        onCancel={() => {
          setPcnPreviewOpen(false);
          setPendingFinalize(null);
        }}
      />

      {/* Hidden file inputs */}
      <input
        ref={qrFileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handlePermitQrSelection}
        className="file-input"
      />

    </div>
  );
}
