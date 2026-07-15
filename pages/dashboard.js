import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { fetchJson } from '../lib/api';
import { clearSession, getStoredSiteId, loadSession, restoreSession, saveStoredSiteId } from '../lib/session';
import { signOutFromWardenApp, getStoredToken, getValidToken } from '../lib/auth';
import { getContraventionOptions } from '../lib/contraventions';
import { getCurrentLocation } from '../lib/geo';
import { buildApiUrl } from '../lib/api';
import { createQueueItem, deleteQueueItem, listQueueItems, saveQueueItem, updateQueueItem } from '../lib/queue';
import AppShell from '../components/AppShell';
import LoadingSpinner from '../components/LoadingSpinner.js';
import LicensePlate from '../components/LicensePlate.js';
import BreachStepper from '../components/BreachStepper';

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

function normalizeObservationMinutes(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.ceil(numeric);
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

    const label = phase === 'closing' ? 'CLOSING' : 'ENTRY';
    const stampText = `${label} ${formatCaptureTimestamp(capturedAt)}`;
    const baseFont = Math.max(24, Math.floor(canvas.width / 40));
    ctx.font = `700 ${baseFont}px Arial, sans-serif`;
    const paddingX = Math.max(16, Math.floor(baseFont * 0.6));
    const paddingY = Math.max(12, Math.floor(baseFont * 0.45));
    const textMetrics = ctx.measureText(stampText);
    const boxWidth = Math.ceil(textMetrics.width + paddingX * 2);
    const boxHeight = Math.ceil(baseFont + paddingY * 2);
    const boxX = Math.max(12, Math.floor(canvas.width * 0.03));
    const boxY = Math.max(12, canvas.height - boxHeight - Math.floor(canvas.height * 0.03));

    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    ctx.fillText(stampText, boxX + paddingX, boxY + paddingY);

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
      } catch (_) {}
      return worker;
    })();
  }

  return ocrWorkerPromise;
}

function isLikelyUkVrm(value) {
  return /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(value);
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

      const formatBonus = isLikelyUkVrm(raw) ? 100 : 0;
      const lengthPenalty = Math.abs(raw.length - 7) * 2;
      const score = formatBonus + avgConfidence - lengthPenalty;

      candidates.push({
        text: raw,
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

    const rawWidth = Math.max(1, bbox.x1 - bbox.x0);
    const rawHeight = Math.max(1, bbox.y1 - bbox.y0);
    const padX = Math.max(4, Math.round(rawWidth * 0.2));
    const padY = Math.max(4, Math.round(rawHeight * 0.35));

    const sx = Math.max(0, Math.floor(bbox.x0 - padX));
    const sy = Math.max(0, Math.floor(bbox.y0 - padY));
    const ex = Math.min(imageWidth, Math.ceil(bbox.x1 + padX));
    const ey = Math.min(imageHeight, Math.ceil(bbox.y1 + padY));
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

    const cutoffImage = await createPlateCutoutDataUrl(file, best.bbox);
    return {
      plateText: normalizeVrm(best.text),
      confidence: Number(best.confidence || 0),
      cutoffImage,
      bbox: best.bbox,
    };
  } catch (_) {
    return null;
  }
}

function buildEvidenceFrame(imageUrl, timestamp) {
  if (!imageUrl) return null;
  return {
    imageUrl,
    vehicleImage: imageUrl,
    plateImage: imageUrl,
    timestamp: timestamp || null,
  };
}

function buildCameraRawRecords(files, previews, { phase, capturedAt, source = 'WARDEN_CAPTURE' } = {}) {
  const safeFiles = Array.isArray(files) ? files : [];
  const safePreviews = Array.isArray(previews) ? previews : [];
  const nowIso = capturedAt || new Date().toISOString();

  return safeFiles.map((file, index) => ({
    id: `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
    phase: phase === 'closing' ? 'closing' : 'entry',
    source,
    capturedAt: normalizeCapturedAt(file?.capturedAt) || nowIso,
    fileName: file?.name || `capture_${index + 1}.jpg`,
    mimeType: file?.type || '',
    sizeBytes: Number(file?.size || 0),
    localPreviewUrl: safePreviews[index] || '',
  }));
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
  return {
    phase: normalizedPhase,
    capturedAt: normalizeCapturedAt(capturedAt) || '',
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

function diffMinutes(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const diffMs = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return Math.round(diffMs / 60000);
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
    return { code: 'SUBMITTED', label: 'Submitted', syncable: false };
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
    vehicleDetails,
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
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [selectedVrm, setSelectedVrm] = useState('');
  const [selectedReason, setSelectedReason] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [manualObservationMinutes, setManualObservationMinutes] = useState(0);
  const [location, setLocation] = useState(null);
  const [entryFiles, setEntryFiles] = useState([]);
  const [entryPreviews, setEntryPreviews] = useState([]);
  const [entryCapturedAt, setEntryCapturedAt] = useState('');
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
  const [queueItems, setQueueItems] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
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
  const [stepperOpen, setStepperOpen] = useState(false);
  const [breachStatusFilter, setBreachStatusFilter] = useState('all');
  const [convertLoading, setConvertLoading] = useState(false);
  const [convertError, setConvertError] = useState('');
  const [pcnReasonInput, setPcnReasonInput] = useState('No valid permit or payment found');
  const [monitoringSessionActive, setMonitoringSessionActive] = useState(false);
  const [monitoringSessionStartedAt, setMonitoringSessionStartedAt] = useState('');
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
  });
  const fileInputRef = useRef(null);
  const qrFileInputRef = useRef(null);
  const authReadyRef = useRef(false);
  const capturePhaseRef = useRef('entry');

  async function resolveAuthToken({ forceRefresh = false } = {}) {
    const token = await getValidToken({ forceRefresh });
    const nextToken = token || authToken || getStoredToken();
    if (!nextToken) throw new Error('auth_missing');
    if (nextToken !== authToken) setAuthToken(nextToken);
    return nextToken;
  }

  const selectedSite = useMemo(() => sites.find((site) => String(site.id) === String(selectedSiteId)) || null, [sites, selectedSiteId]);
  const contraventions = useMemo(() => getContraventionOptions(selectedSite), [selectedSite]);
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
      .map((item) => ({
        id: item.id,
        vrm: item.payload.vrm,
        reason: item.payload.contraventionReason,
        startsAt: item.payload.observationStartTime || item.payload.entryCapturedAt,
        requiredMinutes: 0,
        siteName: item.payload.siteName || selectedSite?.name || 'Site'
      }));
  }, [queueItems, selectedSite?.name]);
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
      const elapsedMinutes = observationStartTime
        ? Math.max(0, diffMinutes(observationStartTime, hasExitEvidence ? observationEndTime : new Date().toISOString()))
        : 0;
      const requiredMinutes = 0;
      const isPastRequired = false;
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
  const canIssuePcnFromCurrentState = !selectedConvertedToPcn && (
    canFinalizeBreach ||
    (selectedLifecycleCode === 'SUBMITTED' && Boolean(selectedTracked?.payload?.breachId))
  );
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
    const entryTime = payload?.entryCapturedAt || payload?.observationStartTime || '';
    const closingTime = payload?.closingCapturedAt || payload?.observationEndTime || payload?.convertedAt || '';
    const durationMinutes = Number(payload?.actualMinutes) > 0
      ? Number(payload.actualMinutes)
      : diffMinutes(entryTime, closingTime);
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
    const fallbackEntryImage = imageUrls[0] || '';
    const fallbackClosingImage = imageUrls[imageUrls.length > 1 ? 1 : 0] || '';
    const observationCapture = {
      imageUrl: resolveCameraRawImageSrc(entryRecord) || fallbackEntryImage,
      capturedAt: entryRecord?.capturedAt || entryTime || '',
      label: 'Observation capture',
    };
    const contraventionCapture = {
      imageUrl: resolveCameraRawImageSrc(closingRecord) || fallbackClosingImage,
      capturedAt: closingRecord?.capturedAt || closingTime || '',
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
      entryTime,
      closingTime,
      durationMinutes,
      imageUrls,
      observationCapture,
      contraventionCapture,
      permitStatus,
      paymentStatus,
    };
  }, [selectedTracked, selectedTrackedAuthorization]);
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
      list = list.filter((item) => String(item?.payload?.siteId) === String(selectedSiteId));
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
    if (item.lifecycle.code === 'READY') return 'Submit now';
    if (item.lifecycle.code === 'FAILED') return 'Retry submit';
    if (item.lifecycle.code === 'SUBMITTED') return 'Open conversion';
    if (item.lifecycle.code === 'CONVERTED') return 'View card';
    return 'Review';
  }

  async function handlePrimaryAction(item) {
    if (!item) return;
    if (item.lifecycle.code === 'READY' || item.lifecycle.code === 'FAILED') {
      await handleRetryTracked(item.id);
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
  }, []);

  useEffect(() => {
    async function bootstrapSession() {
      try {
        const session = loadSession() || await restoreSession();
        const token = session?.token;

        if (!token || !session?.role) {
          await router.replace('/login');
          return;
        }

        setAuthToken(token);
        setProfile(session);
        setOnline(navigator.onLine);
        await Promise.all([loadSites(token), refreshQueue()]);
        authReadyRef.current = true;
      } catch (error) {
        console.error('[warden] profile bootstrap failed', error);
        clearSession();
        await signOutFromWardenApp();
        await router.replace('/login');
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
    const contravention = contraventions.find((item) => item.code === selectedContraventionCode) || contraventions[0];
    if (contravention) {
      setSelectedReason(contravention.label);
      setManualObservationMinutes(Number(contravention.defaultObservationMinutes ?? 0));
    }
  }, [contraventions, selectedContraventionCode]);

  useEffect(() => {
    if (selectedSiteId) {
      saveStoredSiteId(selectedSiteId);
    }
  }, [selectedSiteId]);

  useEffect(() => {
    setCarcheckDialogOpen(false);
    setPcnDialogOpen(false);
  }, [selectedTrackedId]);

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
    const data = await fetchJson('/api/sites?forceAdmin=true', { token });
    const nextSites = Array.isArray(data?.sites) ? data.sites : [];
    const activeSites = nextSites.filter((site) => site.active !== false && site.isActive !== false);
    setSites(activeSites);
    if (!selectedSiteId && activeSites.length > 0) {
      setSelectedSiteId(activeSites[0].id);
      saveStoredSiteId(activeSites[0].id);
    }
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
    capturePhaseRef.current = phase;
    fileInputRef.current?.click();
  }

  function closeImageDetailDialog() {
    setImageDetailDialog((current) => ({ ...current, open: false }));
  }

  function toggleImageDetailFullscreen() {
    setImageDetailDialog((current) => ({ ...current, fullscreen: !current.fullscreen }));
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

  async function handleFileSelection(event) {
    const rawFiles = Array.from(event.target.files || []);
    const fallbackCapturedAt = new Date().toISOString();
    const phase = capturePhaseRef.current === 'closing' ? 'closing' : 'entry';
    const nextFiles = await Promise.all(
      rawFiles.map(async (file) => {
        const capturedAt = await resolveCameraCaptureTimestamp(file, fallbackCapturedAt);
        const stamped = await stampEvidenceImage(file, { capturedAt, phase });
        stamped.capturedAt = capturedAt;
        return stamped;
      })
    );
    const capturedAt = normalizeCapturedAt(nextFiles[0]?.capturedAt) || fallbackCapturedAt;
    const nextPreviews = await toPreviewSrcList(nextFiles);
    let nextCameraRawRecords = buildCameraRawRecords(nextFiles, nextPreviews, { phase, capturedAt });
    let plateScanResult = null;

    if (nextFiles.length > 0) {
      plateScanResult = await scanPlateFromImage(nextFiles[0]);
      if (plateScanResult?.cutoffImage) {
        const cutoffFile = dataUrlToFile(
          plateScanResult.cutoffImage,
          `plate_cutoff_${phase}_${Date.now()}.jpg`
        );
        if (cutoffFile) {
          cutoffFile.capturedAt = capturedAt;
          nextFiles.push(cutoffFile);
        }
      }

      const refreshedPreviews = await toPreviewSrcList(nextFiles);
      nextPreviews.splice(0, nextPreviews.length, ...refreshedPreviews);
      nextCameraRawRecords = buildCameraRawRecords(nextFiles, nextPreviews, { phase, capturedAt });
      if (plateScanResult?.plateText && nextCameraRawRecords[0]) {
        nextCameraRawRecords[0] = {
          ...nextCameraRawRecords[0],
          plateText: plateScanResult.plateText,
          plateConfidence: plateScanResult.confidence,
          plateCutoffImage: plateScanResult.cutoffImage || '',
          plateBbox: plateScanResult.bbox || null,
        };
      }
    }
    const nextPhaseFiles = nextFiles.map((file) => ({
      name: file.name,
      type: file.type,
      blob: file,
      phase,
    }));

    if (phase === 'entry') {
      const mergedEntryFiles = [...entryFiles, ...nextFiles];
      const mergedEntryPreviews = [...entryPreviews, ...nextPreviews];
      setEntryFiles(mergedEntryFiles);
      setEntryPreviews(mergedEntryPreviews);
      setMainEntryImageIndex((current) => (
        mergedEntryFiles.length > 0
          ? Math.min(current, mergedEntryFiles.length - 1)
          : 0
      ));
      setEntryCapturedAt((current) => current || capturedAt);
      setCameraRawData((current) => mergeCameraRawRecords(current, nextCameraRawRecords, 'entry'));
      if (plateScanResult?.plateText) {
        setSelectedVrm(plateScanResult.plateText);
      }

      const entryCaptureMessage = plateScanResult?.plateText
        ? `Opening evidence captured: ${nextFiles.length} image${nextFiles.length === 1 ? '' : 's'}. Plate detected: ${plateScanResult.plateText}.`
        : `Opening evidence captured: ${nextFiles.length} image${nextFiles.length === 1 ? '' : 's'}.`;
      setMessage(entryCaptureMessage);

      if (selectedTrackedId) {
        try {
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
              plateText: plateScanResult?.plateText || selectedPayload?.detectedEntryPlateText || '',
              plateCutoffImage: plateScanResult?.cutoffImage || selectedPayload?.detectedEntryPlateCutoffImage || '',
              plateConfidence: Number(plateScanResult?.confidence || selectedPayload?.detectedEntryPlateConfidence || 0),
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
              mainEntryImageIndex: Math.min(
                Math.max(0, selectedMainEntryIndex),
                Math.max(0, mergedTrackedEntryFiles.length - 1)
              ),
              detectedEntryPlateText: plateScanResult?.plateText || selectedPayload?.detectedEntryPlateText || '',
              detectedEntryPlateCutoffImage: plateScanResult?.cutoffImage || selectedPayload?.detectedEntryPlateCutoffImage || '',
              detectedEntryPlateConfidence: Number(plateScanResult?.confidence || selectedPayload?.detectedEntryPlateConfidence || 0),
              detectedEntryVehicleImage: nextCameraRawRecords[0]?.imageUrl || selectedPayload?.detectedEntryVehicleImage || '',
              startVehicleImage: nextCameraRawRecords[0]?.imageUrl || selectedPayload?.startVehicleImage || '',
              sessionEvidence: mergeSessionEvidence(selectedPayload?.sessionEvidence, entryPhaseEvidence),
              cameraRawData: mergeCameraRawRecords(selectedPayload?.cameraRawData || [], nextCameraRawRecords, 'entry'),
            },
            files: [...preservedFiles, ...mergedTrackedEntryFiles],
            updatedAt: new Date().toISOString(),
          });
          await refreshQueue();
        } catch (persistError) {
          console.error('[warden] failed to persist entry capture evidence', persistError);
        }
      }
    } else {
      const mergedClosingFiles = [...closingFiles, ...nextFiles];
      const mergedClosingPreviews = [...closingPreviews, ...nextPreviews];
      setClosingFiles(mergedClosingFiles);
      setClosingPreviews(mergedClosingPreviews);
      setMainClosingImageIndex((current) => (
        mergedClosingFiles.length > 0
          ? Math.min(current, mergedClosingFiles.length - 1)
          : 0
      ));
      setClosingCapturedAt(capturedAt);
      setCameraRawData((current) => mergeCameraRawRecords(current, nextCameraRawRecords, 'closing'));
      setMonitoringSessionActive(false);
      setMonitoringSessionStartedAt('');
      if (plateScanResult?.plateText) {
        setSelectedVrm(plateScanResult.plateText);
      }

      if (selectedTrackedId) {
        try {
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
          const computedMinutes = diffMinutes(entryTime, capturedAt);

          const closingPhaseEvidence = buildPhaseSessionEvidence({
            phase: 'closing',
            capturedAt,
            detection: {
              plateText: plateScanResult?.plateText || selectedPayload?.detectedClosingPlateText || '',
              plateCutoffImage: plateScanResult?.cutoffImage || selectedPayload?.detectedClosingPlateCutoffImage || '',
              plateConfidence: Number(plateScanResult?.confidence || selectedPayload?.detectedClosingPlateConfidence || 0),
              vehicleImage: nextCameraRawRecords[0]?.imageUrl || selectedPayload?.detectedClosingVehicleImage || '',
            },
          });

          await updateQueueItem(selectedTrackedId, {
            payload: {
              ...selectedPayload,
              observationStartTime: entryTime,
              observationEndTime: capturedAt,
              entryCapturedAt: entryTime,
              closingCapturedAt: capturedAt,
              actualMinutes: computedMinutes,
              mainClosingImageIndex: Math.min(
                Math.max(0, selectedMainClosingIndex),
                Math.max(0, mergedTrackedClosingFiles.length - 1)
              ),
              breachLifecycle: computedMinutes > 0 ? 'READY_FOR_SYNC' : selectedPayload.breachLifecycle,
              detectedClosingPlateText: plateScanResult?.plateText || selectedPayload?.detectedClosingPlateText || '',
              detectedClosingPlateCutoffImage: plateScanResult?.cutoffImage || selectedPayload?.detectedClosingPlateCutoffImage || '',
              detectedClosingPlateConfidence: Number(plateScanResult?.confidence || selectedPayload?.detectedClosingPlateConfidence || 0),
              detectedClosingVehicleImage: nextCameraRawRecords[0]?.imageUrl || selectedPayload?.detectedClosingVehicleImage || '',
              sessionEvidence: mergeSessionEvidence(selectedPayload?.sessionEvidence, closingPhaseEvidence),
              cameraRawData: mergeCameraRawRecords(selectedPayload?.cameraRawData || [], nextCameraRawRecords, 'closing'),
            },
            files: [...preservedFiles, ...mergedTrackedClosingFiles],
            updatedAt: new Date().toISOString(),
          });
          await refreshQueue();
        } catch (persistError) {
          console.error('[warden] failed to persist closing capture timing', persistError);
        }
      }

      const capturedMessage = plateScanResult?.plateText
        ? `Closing evidence captured: ${nextFiles.length} image${nextFiles.length === 1 ? '' : 's'}. Plate detected: ${plateScanResult.plateText}.`
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

    event.target.value = '';
  }

  async function uploadEvidenceFiles(evidenceFiles, manualVrm) {
    const formData = new FormData();
    evidenceFiles.forEach((file) => formData.append('file', file.blob || file, file.name));
    formData.append('siteId', selectedSiteId);
    formData.append('manualVrm', manualVrm || selectedVrm);

    let token = await resolveAuthToken();
    let response = await fetch(buildApiUrl('/api/warden/uploadevidence'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (response.status === 401) {
      token = await resolveAuthToken({ forceRefresh: true });
      response = await fetch(buildApiUrl('/api/warden/uploadevidence'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
    }

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || 'Failed to analyse evidence');
    }

    return data;
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

  async function checkAuthorization(nextVrm) {
    const vrm = normalizeVrm(nextVrm || selectedVrm);
    if (!vrm || !selectedSiteId) return null;
    const token = await resolveAuthToken();
    const result = await fetchJson(`/api/parking/check-authorization?vrm=${encodeURIComponent(vrm)}&siteId=${encodeURIComponent(selectedSiteId)}&breachTime=${encodeURIComponent(new Date().toISOString())}`, {
      token
    });
    setAuthorization(result);
    setAuthorizationByVrm((current) => ({ ...current, [vrm]: result }));
    return result;
  }

  async function handlePermitLookup() {
    setBusy(true);
    try {
      const result = await checkAuthorization(selectedVrm);
      if (result?.hasAuthorization) {
        setDetailMessage('E-permit lookup matched an active authorisation for this site.');
      } else {
        setDetailMessage('E-permit lookup completed. No active authorisation matched this site.');
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
    if (!selectedSiteId || !selectedVrm || !hasEntryEvidence) {
      setMessage('Capture entry evidence with site and VRM before starting a Draft Parking Charge.');
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
    if (!closingCapturedAt) {
      setClosingCapturedAt(new Date().toISOString());
    }
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
    if (!vrm) {
      setMessage('Enter or read a VRM before running car check.');
      return;
    }

    const cachedLookup = vehicleLookupByVrm[vrm];
    if (cachedLookup && !forceRefresh) {
      setVehicleLookup(cachedLookup);
      setCarcheckDialogMessage(`Loaded from app memory${cachedLookup?.make || cachedLookup?.model ? `: ${[cachedLookup.make, cachedLookup.model].filter(Boolean).join(' ')}` : ''}.`);
      setCarcheckDialogOpen(true);
      return;
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
      setVehicleLookup(normalized);
      setVehicleLookupByVrm((current) => ({ ...current, [vrm]: normalized }));
      setCarcheckDialogMessage(`Carcheck complete${normalized?.make || normalized?.model ? `: ${[normalized.make, normalized.model].filter(Boolean).join(' ')}` : ''}.`);
      setCarcheckDialogOpen(true);
    } catch (error) {
      console.error('[warden] vehicle lookup failed', error);
      setVehicleLookup(null);
      setCarcheckDialogMessage(error?.message || 'Carcheck unavailable');
      setCarcheckDialogOpen(true);
    } finally {
      setVehicleLookupLoading(false);
    }
  }

  async function handleVehicleLookup() {
    await runVehicleLookupForVrm(selectedVrm, { forceRefresh: true });
  }

  async function handleSaveCarcheckDetails() {
    const trackedVrm = normalizeVrm(selectedTracked?.payload?.vrm || selectedTracked?.vrm || selectedVrm);
    if (!trackedVrm) {
      setDetailMessage('Run carcheck before saving details.');
      return;
    }

    const currentLookup = selectedTrackedVehicleDetails || vehicleLookup;
    if (!currentLookup) {
      setDetailMessage('No carcheck result to save yet.');
      return;
    }

    if (!selectedTrackedId) {
      setDetailMessage('Open a Draft Parking Charge before saving carcheck details.');
      return;
    }

    const nowIso = new Date().toISOString();
    const existingLookup = selectedTracked?.payload?.savedVehicleLookup || null;
    const incomingFingerprint = buildVehicleLookupFingerprint(currentLookup);
    const existingFingerprint = buildVehicleLookupFingerprint(existingLookup);
    if (selectedTracked?.payload?.savedVehicleSavedAt && existingFingerprint && incomingFingerprint === existingFingerprint) {
      setDetailMessage('Vehicle details already saved. You can reopen this result anytime.');
      return;
    }

    await updateQueueItem(selectedTrackedId, {
      payload: {
        ...selectedTracked?.payload,
        vrm: trackedVrm,
        savedVehicleLookup: currentLookup,
        savedVehicleImageUrl: currentLookup?.imageUrl || currentLookup?.imageUrls?.[0] || selectedTrackedVehicleImageUrl || null,
        savedVehicleSavedAt: nowIso,
      },
      updatedAt: nowIso,
    });
    await refreshQueue();
    setDetailMessage('Vehicle details saved. Reopen anytime from this Draft Parking Charge.');
  }

  async function queueOrSendCapture({ immediate = false, targetItemId = '', openPcnDialogAfterSync = false } = {}) {
    if (targetItemId) {
      const existing = (await listQueueItems()).find((item) => item.id === targetItemId);
      if (existing) {
        await syncQueueItem(targetItemId, { openPcnDialogAfterSuccess: openPcnDialogAfterSync });
        return;
      }
    }

    if (!selectedSiteId) {
      setMessage('Choose a patrol site before submitting.');
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

    if (closingFiles.length === 0) {
      setMessage('Capture closing evidence before creating a breach.');
      return;
    }

    const requiredObservationMinutes = 0;
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

    if (!elapsedMinutes) {
      setMessage('Closing evidence must be captured after opening evidence.');
      return;
    }

    const payload = stripCarcheckFromPayload({
      vrm: normalizeVrm(selectedVrm),
      siteId: selectedSiteId,
      siteName: selectedSite?.name || selectedSite?.displayName || selectedSiteId,
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
      selectedContraventionCode,
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
    if (!selectedSiteId) {
      setMessage('Choose a patrol site before saving a draft.');
      return;
    }
    if (!selectedVrm) {
      setMessage('Enter or capture a VRM before saving a draft.');
      return;
    }
    if (entryFiles.length === 0) {
      setMessage('Capture opening evidence before saving a draft.');
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
    const draftPayload = stripCarcheckFromPayload({
      vrm: normalizeVrm(selectedVrm),
      siteId: selectedSiteId,
      siteName: selectedSite?.name || selectedSite?.displayName || selectedSiteId,
      source: 'WARDEN',
      wardenId: profile?.uid,
      actorId: profile?.uid,
      contraventionReason: selectedReason,
      status: 'DRAFT_OPEN',
      breachLifecycle: 'DRAFT_OPEN',
      location: location || null,
      observationStartTime: entryTime,
      observationEndTime: null,
      entryCapturedAt: entryTime,
      closingCapturedAt: null,
      manualNote,
      authorization,
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
    note
  }) {
    try {
      setBusy(true);
      setMessage(`Saving Draft Parking Charge for VRM ${vrm}…`);

      const entryTime = normalizeCapturedAt(files?.[0]?.capturedAt) || new Date().toISOString();
      const requiredObservationMinutes = 0;
      const stepperPreviews = await toPreviewSrcList(files);
      const entryFile = files?.[0] || null;
      const stepperEntryVehicleImage = stepperPreviews[0] || '';
      const stepperEntryDetection = {
        plateText: normalizeVrm(entryFile?.detectedPlateText || vrm),
        plateCutoffImage: String(entryFile?.detectedPlateCutoffImage || ''),
        plateConfidence: Number(entryFile?.detectedPlateConfidence || 0),
        vehicleImage: stepperEntryVehicleImage,
      };

      const draftPayload = {
        vrm,
        contraventionCode,
        contraventionReason: contraventionLabel,
        observationStartTime: entryTime,
        observationEndTime: null,
        expectedObservationMinutes: requiredObservationMinutes,
        siteId,
        siteName,
        note,
        detectedEntryPlateText: stepperEntryDetection.plateText,
        detectedEntryPlateCutoffImage: stepperEntryDetection.plateCutoffImage,
        detectedEntryPlateConfidence: stepperEntryDetection.plateConfidence,
        detectedEntryVehicleImage: stepperEntryVehicleImage,
        startVehicleImage: stepperEntryVehicleImage,
        sessionEvidence: {
          entry: buildPhaseSessionEvidence({ phase: 'entry', detection: stepperEntryDetection, capturedAt: entryTime }),
          closing: buildPhaseSessionEvidence({ phase: 'closing', detection: {}, capturedAt: '' }),
        },
        cameraRawData: buildCameraRawRecords(files, stepperPreviews, { phase: 'entry', capturedAt: entryTime, source: 'WARDEN_STEPPER' }),
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

  async function syncQueueItem(itemId, { openPcnDialogAfterSuccess = false, forceBreachCapture = false } = {}) {
    const queuedItem = (await listQueueItems()).find((item) => item.id === itemId);
    if (!queuedItem) {
      return { ok: false, error: 'Draft Parking Charge not found for sync' };
    }

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
        ? await uploadEvidenceFiles(entryEvidenceFiles, queuedItem.payload.vrm)
        : { vrm: queuedItem.payload.vrm, images: [payloadEntryImage] };
      const closingEvidence = hasLocalPairedEvidence
        ? await uploadEvidenceFiles(closingEvidenceFiles, queuedItem.payload.vrm)
        : { vrm: queuedItem.payload.vrm, images: [payloadClosingImage] };

      const vrm = normalizeVrm(closingEvidence.vrm || entryEvidence.vrm || queuedItem.payload.vrm);
      const authData = await checkAuthorization(vrm);
      const entryTime = queuedItem.payload.entryCapturedAt || queuedItem.payload.observationStartTime || new Date().toISOString();
      const closingTime = queuedItem.payload.closingCapturedAt || queuedItem.payload.observationEndTime || new Date().toISOString();
      const entryFrame = buildEvidenceFrame(entryEvidence.images?.[0], entryTime);
      const closingFrame = buildEvidenceFrame(closingEvidence.images?.[0], closingTime);
      const allImages = [...(entryEvidence.images || []), ...(closingEvidence.images || [])];
      const cameraRawDataForLos = enrichCameraRawRecordsWithUploadedUrls(
        queuedItem?.payload?.cameraRawData || [],
        entryEvidence.images || [],
        closingEvidence.images || []
      );
      const cameraRawDataForSubmission = sanitizeCameraRawRecordsForSubmission(cameraRawDataForLos);
      const safeQueuedPayload = stripCarcheckFromPayload(queuedItem.payload);
      const sessionEvidence = {
        entry: buildPhaseSessionEvidence({
          phase: 'entry',
          capturedAt: entryTime,
          detection: {
            plateText: safeQueuedPayload?.detectedEntryPlateText,
            plateCutoffImage: safeQueuedPayload?.detectedEntryPlateCutoffImage,
            plateConfidence: safeQueuedPayload?.detectedEntryPlateConfidence,
            vehicleImage: entryFrame?.imageUrl || safeQueuedPayload?.detectedEntryVehicleImage || safeQueuedPayload?.startVehicleImage || payloadEntryImage,
          },
        }),
        closing: buildPhaseSessionEvidence({
          phase: 'closing',
          capturedAt: closingTime,
          detection: {
            plateText: safeQueuedPayload?.detectedClosingPlateText,
            plateCutoffImage: safeQueuedPayload?.detectedClosingPlateCutoffImage,
            plateConfidence: safeQueuedPayload?.detectedClosingPlateConfidence,
            vehicleImage: closingFrame?.imageUrl || safeQueuedPayload?.detectedClosingVehicleImage || payloadClosingImage,
          },
        }),
      };
      const breachPayload = {
        ...safeQueuedPayload,
        vrm,
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
        body: breachPayload
      });

      const breachId = breachResult?.id || breachResult?.breachId || queuedItem?.payload?.breachId || '';
      await updateQueueItem(itemId, {
        status: 'submitted',
        lastError: null,
        updatedAt: new Date().toISOString(),
        payload: {
          ...safeQueuedPayload,
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
          setPcnReasonInput(submittedItem?.payload?.pcnReason || 'No valid permit or payment found');
          setConvertError('');
          setMessage('Parking Charge submitted. Use the primary action to complete final PCN submission.');
        }
      }

      setMessage(`Parking Charge submitted successfully: ${breachId || vrm}`);
      setSelectedVrm('');
      setEntryFiles([]);
      setEntryPreviews([]);
      setEntryCapturedAt('');
      setClosingFiles([]);
      setClosingPreviews([]);
      setClosingCapturedAt('');
      setAuthorization(null);
      setVehicleLookup(null);
      setManualNote('');
      setCameraRawData([]);
      setMonitoringSessionActive(false);
      setMonitoringSessionStartedAt('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return { ok: true, breachId, vrm };
    } catch (error) {
      console.error('[warden] sync failed', error);
      const failureMessage = error?.message || 'Sync failed';
      await updateQueueItem(itemId, {
        status: 'failed',
        lastError: failureMessage,
        updatedAt: new Date().toISOString()
      });
      setMessage(failureMessage);
      return { ok: false, error: failureMessage };
    } finally {
      await refreshQueue();
    }
  }

  async function handleConvertToPcn() {
    if (!selectedTracked) return;
    if (convertLoading) return;

    setConvertLoading(true);
    setConvertError('');
    try {
      setPcnDialogOpen(false);
      const trackedItemId = selectedTrackedId || selectedTracked?.id || '';
      if (!trackedItemId) {
        throw new Error('No tracked session selected for final PCN submission.');
      }

      let workingItem = selectedTracked;
      let breachId = workingItem?.payload?.breachId || '';

      if (!breachId) {
        setMessage('Submitting evidence package before final PCN submission...');
        const syncResult = await syncQueueItem(trackedItemId, {
          openPcnDialogAfterSuccess: false,
          forceBreachCapture: true,
        });

        if (syncResult?.ok === false) {
          throw new Error(syncResult.error || 'Failed to create breach record during sync');
        }

        if (!breachId && syncResult?.breachId) {
          breachId = syncResult.breachId;
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
          breachId = refreshed?.payload?.breachId || '';
        }
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
      const response = await fetchJson('/api/breaches/convert-to-pcn', {
        method: 'POST',
        token,
        body: {
          breachId,
          reason: pcnReasonInput.trim() || 'No valid permit or payment found',
          notes: `Converted from breach ${breachId}`,
          vrm: workingItem?.vrm || selectedTracked?.vrm,
          timestamp: workingItem?.observationEndTime || workingItem?.createdAt || new Date().toISOString(),
          siteId: workingItem?.payload?.siteId || '',
          siteName: workingItem?.siteName || '',
          evidence: workingItem?.payload?.evidence || {},
          images,
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
          observationEndTime: workingItem?.payload?.observationEndTime || workingItem?.payload?.closingCapturedAt || convertedAt,
          closingCapturedAt: workingItem?.payload?.closingCapturedAt || workingItem?.payload?.observationEndTime || convertedAt,
          pcnReason: pcnReasonInput.trim() || 'No valid permit or payment found',
          pcnId: response?.id || response?.pcnId || '',
          pcnNumber: response?.pcnNumber || '',
          pcnAmount: Number(response?.amount || 0) > 0 ? Number(response.amount) : Number(workingItem?.payload?.pcnAmount || 0),
        },
      });
      await refreshQueue();
      setMessage(`Breach converted to PCN ${response?.pcnNumber || ''} and routed for QA escalation.`);
      setPcnDialogOpen(false);
      setMonitoringSessionActive(false);
      setMonitoringSessionStartedAt('');
    } catch (error) {
      console.error('[warden] convert breach failed', error);
      const failureMessage = error?.message || 'Failed to convert breach to PCN';
      setConvertError(failureMessage);
      setMessage(`PCN submission failed: ${failureMessage}`);
    } finally {
      setConvertLoading(false);
    }
  }

  async function syncQueue() {
    if (syncing) return;
    setSyncing(true);
    try {
      const items = await listQueueItems();
      for (const item of items.filter((entry) => getBreachLifecycle(entry).syncable || entry.status === 'syncing')) {
        await syncQueueItem(item.id);
      }
    } finally {
      setSyncing(false);
    }
  }

  async function handleCancelTracked(id) {
    try {
      await deleteQueueItem(id);
      await refreshQueue();
      if (selectedTrackedId === id) {
        setSelectedTrackedId('');
      }
      setMessage('Tracked breach cancelled and removed from queue.');
    } catch (error) {
      console.error('[warden] cancel tracked breach failed', error);
      setMessage(error?.message || 'Failed to cancel tracked breach');
    }
  }

  async function handleRetryTracked(id) {
    setSyncing(true);
    try {
      await syncQueueItem(id);
    } finally {
      setSyncing(false);
    }
  }

  async function handleReviewTracked(item) {
    setDetailMessage('');
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
    if (item?.payload?.selectedContraventionCode) {
      setSelectedContraventionCode(item.payload.selectedContraventionCode);
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

    setPcnReasonInput(item?.payload?.pcnReason || 'No valid permit or payment found');
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

  async function handleFinalize({ openPcnDialogAfterSync = false } = {}) {
    setBusy(true);
    try {
      setLocation((await getCurrentLocation()) || location);
      await checkAuthorization(selectedVrm);
      await queueOrSendCapture({
        targetItemId: selectedTrackedId || '',
        openPcnDialogAfterSync,
      });
    } finally {
      setBusy(false);
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
    setSelectedContraventionCode(code);
    if (next) {
      setSelectedReason(next.label);
      setManualObservationMinutes(Number(next.defaultObservationMinutes ?? 0));
    }
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
              { key: 'all',   label: 'All',    count: trackedBreaches.length },
              { key: 'open',  label: 'Open',   count: trackedBreaches.filter(i => i.lifecycle.code === 'DRAFT_OPEN').length },
              { key: 'ready', label: 'Ready',  count: trackedBreaches.filter(i => i.lifecycle.code === 'READY').length },
              { key: 'failed',label: 'Failed', count: trackedBreaches.filter(i => i.lifecycle.code === 'FAILED').length },
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
              <option value="">All sites</option>
              {sites.map(site => (
                <option key={site.id} value={site.id}>
                  {site.displayName || site.name || site.id}
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
                      item.lifecycle.code === 'DRAFT_OPEN' && item.isOpen   ? 'session-card--active'   : '',
                      item.lifecycle.code === 'DRAFT_OPEN' && timedOut      ? 'session-card--overtime' : '',
                      item.lifecycle.code === 'READY'                       ? 'session-card--ready'    : '',
                      item.lifecycle.code === 'FAILED'                      ? 'session-card--failed'   : '',
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
                            <span className="sc-timer-val">{formatElapsed(item.observationStartTime)}</span>
                          </div>
                          {item.isPastRequired ? (
                            <div className="sc-cta-pill sc-cta-pill--overtime" style={{ marginTop: 6 }}>
                              Overstay
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
                  {selectedTracked.isOpen ? 'Observation active (count up)' : 'Exit captured'}
                </div>
                <div className="obs-value">Elapsed: {selectedTracked.elapsedMinutes || 0} min</div>
                {selectedTracked.isOpen ? (
                  <div className="obs-value" style={{ color: 'var(--danger, #ff6b6b)', fontWeight: 700 }}>
                    Capture closing evidence to stop timer.
                  </div>
                ) : null}
              </div>
              <div className="obs-countdown">
                {formatElapsed(selectedTracked.observationStartTime, selectedTracked.isOpen ? '' : selectedTracked.observationEndTime)}
              </div>
            </div>
          ) : null}

          {selectedTracked?.lifecycle?.code === 'CONVERTED' ? (
            <div className="notice notice-info">
              Session closed: converted to formal PCN. Observation timer is stopped.
            </div>
          ) : null}

          {/* E-permit lookup */}
          <div className="detail-section">
            <div className="detail-section-label">E-permit lookup</div>
            <button
              type="button"
              className="action-btn action-btn--secondary"
              disabled={!selectedVrm || busy}
              onClick={handlePermitLookup}
            >
              {busy ? 'Checking ePermit...' : 'Check ePermit'}
            </button>

            {selectedTrackedAuthorization ? (
              <div className={`auth-result ${selectedTrackedAuthorization.hasAuthorization ? 'auth-result--ok' : 'auth-result--none'}`}>
                <span className="auth-result-icon">{selectedTrackedAuthorization.hasAuthorization ? '✓' : '✗'}</span>
                <div>
                  <div className="auth-result-text">
                    {selectedTrackedAuthorization.hasAuthorization
                      ? `Authorised - ${selectedTrackedAuthorization.authorization?.type || 'permit found'}`
                      : 'No active permit or payment found'}
                  </div>
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
              disabled={!selectedVrm || vehicleLookupLoading || busy}
              onClick={handleVehicleLookup}
            >
              {vehicleLookupLoading ? 'Checking carcheck...' : 'Run carcheck'}
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
              <button
                type="button"
                className="action-btn action-btn--issue"
                onClick={handleConvertToPcn}
                disabled={busy || convertLoading}
              >
                {convertLoading
                  ? 'Submitting...'
                  : (selectedTracked?.payload?.breachId ? '📋 Submit PCN to backend' : '📋 Sync and submit PCN')}
              </button>
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

          {detailMessage ? (
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
                            onClick={() => handleRetryTracked(item.id)}
                          >
                            Retry
                          </button>
                        ) : null}
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
                        <span className="sc-timer-val">{formatElapsed(timer.startsAt)}</span>
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
                        <span className="camera-raw-filename">{item?.fileName || `Capture ${index + 1}`}</span>
                        <span className="camera-raw-subline">
                          {item?.vrm || 'Unknown VRM'} · {item?.siteName || 'Site'}
                        </span>
                        <span className="camera-raw-subline">
                          {item?.capturedAt ? new Date(item.capturedAt).toLocaleString() : 'Capture time pending'}
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
                        <span className="camera-raw-filename">{item?.fileName || `Capture ${index + 1}`}</span>
                        <span className="camera-raw-subline">
                          {item?.vrm || 'Unknown VRM'} · {item?.siteName || 'Site'}
                        </span>
                        <span className="camera-raw-subline">
                          {item?.capturedAt ? new Date(item.capturedAt).toLocaleString() : 'Capture time pending'}
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
                    ? `Captured ${new Date(imageDetailDialog.capturedAt).toLocaleString()}`
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
                  <option value="">Select site</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.displayName || site.name || site.id}
                    </option>
                  ))}
                </select>
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
      {currentScreen !== 'detail' ? (
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

        {carcheckDialogOpen ? (
        <div
          className="carcheck-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Carcheck result"
            onClick={() => {
              setCarcheckDialogOpen(false);
              setCarcheckDialogMessage('');
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
                  }}
                >
                ✕
              </button>
            </div>

            <div className="carcheck-sheet-body">
                {carcheckDialogMessage ? <div className="notice notice-info">{carcheckDialogMessage}</div> : null}

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
                >
                  Save details
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
                    <span className="pcn-summary-value">{pcnPreview.entryTime ? new Date(pcnPreview.entryTime).toLocaleString() : '—'}</span>
                  </div>
                  <div className="pcn-summary-row">
                    <span className="pcn-summary-key">Contravention Time</span>
                    <span className="pcn-summary-value">{pcnPreview.closingTime ? new Date(pcnPreview.closingTime).toLocaleString() : '—'}</span>
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
                            ? new Date(pcnPreview.observationCapture.capturedAt).toLocaleString()
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
                            ? new Date(pcnPreview.contraventionCapture.capturedAt).toLocaleString()
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
                  className="action-btn action-btn--issue pcn-dialog-btn"
                  onClick={handleConvertToPcn}
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

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={handleFileSelection}
        className="file-input"
      />
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
