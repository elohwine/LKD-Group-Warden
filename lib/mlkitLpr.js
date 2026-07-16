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
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
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
  if (!plate) return 0;
  let score = 0;
  if (plate.length >= 5 && plate.length <= 8) score += 35;
  if (/^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(plate)) score += 35;
  if (/^[A-Z0-9]+$/.test(plate)) score += 15;
  if (/^[A-Z]+$/.test(plate) || /^[0-9]+$/.test(plate)) score -= 10;
  return Math.max(0, Math.min(99, score));
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
  const rawWidth = Math.max(1, Number(bbox.x1 || 0) - Number(bbox.x0 || 0));
  const rawHeight = Math.max(1, Number(bbox.y1 || 0) - Number(bbox.y0 || 0));
  const padX = Math.max(4, Math.round(rawWidth * 0.2));
  const padY = Math.max(4, Math.round(rawHeight * 0.35));

  const sx = Math.max(0, Math.floor(Number(bbox.x0 || 0) - padX));
  const sy = Math.max(0, Math.floor(Number(bbox.y0 || 0) - padY));
  const ex = Math.min(width, Math.ceil(Number(bbox.x1 || 0) + padX));
  const ey = Math.min(height, Math.ceil(Number(bbox.y1 || 0) + padY));
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

    const bbox = result?.bbox
      ? {
          x0: Number(result.bbox.x0 || 0),
          y0: Number(result.bbox.y0 || 0),
          x1: Number(result.bbox.x1 || 0),
          y1: Number(result.bbox.y1 || 0),
        }
      : null;

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
