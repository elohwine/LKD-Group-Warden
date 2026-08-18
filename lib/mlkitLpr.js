import { normalizeUkVrmFromOcr, scoreUkVrmCandidate } from './ukVrmOcr.mjs';

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      const base64 = value.includes(',') ? value.split(',')[1] : value;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error || new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
}

function normalizePlate(value) {
  return normalizeUkVrmFromOcr(value);
}

function collectCandidates(result) {
  const candidates = [];
  const blocks = Array.isArray(result?.blocks) ? result.blocks : [];

  blocks.forEach((block) => {
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    lines.forEach((line) => {
      const text = normalizePlate(line?.text || '');
      if (!text) return;

      const bbox = line?.boundingBox || block?.boundingBox || null;
      candidates.push({
        text,
        bbox: bbox
          ? {
              x0: Number(bbox.left || 0),
              y0: Number(bbox.top || 0),
              x1: Number(bbox.right || 0),
              y1: Number(bbox.bottom || 0),
            }
          : null,
      });
    });
  });

  return candidates;
}

function scorePlate(plate) {
  return scoreUkVrmCandidate(plate);
}

function normalizeBbox(rawBbox, imageWidth = 0, imageHeight = 0) {
  if (!rawBbox) return null;

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
  if (looksNormalized && imageWidth > 0 && imageHeight > 0) {
    x0 *= imageWidth;
    x1 *= imageWidth;
    y0 *= imageHeight;
    y1 *= imageHeight;
  }

  return {
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    x1: Math.max(x0, x1),
    y1: Math.max(y0, y1),
  };
}

async function cropDataUrlFromBbox(file, bbox) {
  if (!file || !bbox || typeof document === 'undefined') return '';

  const image = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image_load_failed'));
    };
    img.src = url;
  });

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const normalizedBbox = normalizeBbox(bbox, width, height);
  if (!normalizedBbox) return '';

  const rawWidth = Math.max(1, Number(normalizedBbox.x1 || 0) - Number(normalizedBbox.x0 || 0));
  const rawHeight = Math.max(1, Number(normalizedBbox.y1 || 0) - Number(normalizedBbox.y0 || 0));
  const padX = Math.max(4, Math.round(rawWidth * 0.2));
  const padY = Math.max(4, Math.round(rawHeight * 0.35));

  const sx = Math.max(0, Math.floor(Number(normalizedBbox.x0 || 0) - padX));
  const sy = Math.max(0, Math.floor(Number(normalizedBbox.y0 || 0) - padY));
  const ex = Math.min(width, Math.ceil(Number(normalizedBbox.x1 || 0) + padX));
  const ey = Math.min(height, Math.ceil(Number(normalizedBbox.y1 || 0) + padY));
  const sw = Math.max(1, ex - sx);
  const sh = Math.max(1, ey - sy);

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL('image/jpeg', 0.92);
}

export async function scanPlateWithMlKit(file) {
  if (!file) return null;

  try {
    const base64Data = await fileToBase64(file);
    const { analyzeImageWithNativeAnpr } = await import('./nativeAnpr');
    const result = await analyzeImageWithNativeAnpr(base64Data);

    const plateText = normalizePlate(result?.plateText || '');
    if (!plateText) return null;

    const bbox = normalizeBbox(result?.bbox || null);

    const cutoffImage = String(result?.cutoffImage || '');

    return {
      plateText,
      confidence: Number(result?.confidence || scorePlate(plateText)),
      bbox,
      cutoffImage: cutoffImage || (bbox ? await cropDataUrlFromBbox(file, bbox) : ''),
      engine: String(result?.engine || 'native-anpr'),
    };
  } catch (_) {
    return null;
  }
}

export async function isMlKitReady() {
  try {
    const [{ Capacitor }, { isNativeAnprAvailable }] = await Promise.all([
      import('@capacitor/core'),
      import('./nativeAnpr'),
    ]);

    if (!Capacitor.isNativePlatform()) {
      return false;
    }

    return isNativeAnprAvailable();
  } catch (_) {
    return false;
  }
}
