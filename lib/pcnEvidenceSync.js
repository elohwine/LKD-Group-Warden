function base64StringToBlob(base64Value, mimeType = 'image/jpeg') {
  const raw = String(base64Value || '').trim();
  if (!raw) return null;

  const normalized = raw.replace(/^data:.*;base64,/i, '').replace(/\s+/g, '');
  if (!normalized) return null;

  try {
    const binary = typeof atob === 'function' ? atob(normalized) : Buffer.from(normalized, 'base64').toString('binary');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType || 'image/jpeg' });
  } catch (_) {
    return null;
  }
}

function detectSourceKind(src) {
  const candidate = String(src || '').trim();
  if (!candidate) return 'empty';
  if (/^https?:\/\//i.test(candidate)) return 'http';
  if (/^data:/i.test(candidate)) return 'data';
  if (/^blob:/i.test(candidate)) return 'blob';
  if (/^file:/i.test(candidate)) return 'file';
  if (/^content:/i.test(candidate)) return 'content';
  if (/^capacitor:/i.test(candidate)) return 'capacitor';
  return 'other';
}

function traceRecoverEvent(trace, event, payload = {}) {
  if (typeof trace !== 'function') return;
  try {
    trace(event, payload);
  } catch (_) {
    // Ignore trace callback errors to avoid breaking sync recovery.
  }
}

function nativeFileUriToBlob(src, fallbackType = 'image/jpeg') {
  const sanitizedSource = String(src || '').trim();
  if (!sanitizedSource || !/^(file:|content:|capacitor:)/i.test(sanitizedSource)) {
    return null;
  }

  const capacitorFilesystem = globalThis?.Capacitor?.Filesystem;
  if (!capacitorFilesystem?.readFile) {
    return null;
  }

  try {
    const readResult = capacitorFilesystem.readFile({ path: sanitizedSource });
    const coerceBlob = (result) => {
      const payload = result?.data ?? result;
      if (payload instanceof Blob) return payload;
      if (payload instanceof ArrayBuffer) return new Blob([payload], { type: fallbackType || 'image/jpeg' });
      if (payload instanceof Uint8Array) return new Blob([payload], { type: fallbackType || 'image/jpeg' });
      if (typeof payload === 'string') {
        const trimmed = payload.trim();
        if (/^data:/i.test(trimmed)) return dataUrlToBlob(trimmed, fallbackType || 'image/jpeg');
        const base64Blob = base64StringToBlob(trimmed, fallbackType || 'image/jpeg');
        if (base64Blob) return base64Blob;
      }
      return null;
    };

    if (readResult && typeof readResult.then === 'function') {
      return readResult.then((result) => coerceBlob(result)).catch(() => null);
    }

    return coerceBlob(readResult);
  } catch (_) {
    return null;
  }
}

export function dataUrlToFile(dataUrl, fileName = 'recovered-evidence.jpg') {
  if (!dataUrl || typeof dataUrl !== 'string' || !/^data:/i.test(dataUrl)) {
    return null;
  }

  try {
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex === -1) return null;

    const header = dataUrl.slice(0, commaIndex);
    const payload = String(dataUrl.slice(commaIndex + 1)).trim();
    const isBase64 = /;base64/i.test(header);
    const mimeTypeMatch = header.match(/^data:([^;]+)(?:;charset=[^;]+)?(?:;base64)?/i);
    const mimeType = mimeTypeMatch?.[1] || 'image/jpeg';

    let binary = '';
    if (isBase64) {
      const normalizedPayload = payload.replace(/\s+/g, '');
      const decoded = typeof atob === 'function' ? atob(normalizedPayload) : Buffer.from(normalizedPayload, 'base64').toString('binary');
      binary = decoded;
    } else {
      binary = decodeURIComponent(payload);
    }

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    const blob = new Blob([bytes], { type: mimeType });
    const fallbackName = String(fileName || 'recovered-evidence.jpg').trim() || 'recovered-evidence.jpg';
    return new File([blob], fallbackName, {
      type: mimeType,
      lastModified: Date.now(),
    });
  } catch (_) {
    return null;
  }
}

export function resolveCameraRawImageSrc(record) {
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

export async function recoverUploadableEvidenceFilesFromCameraRaw(records, phase, options = {}) {
  const normalizedPhase = phase === 'closing' ? 'closing' : 'entry';
  const safeRecords = Array.isArray(records) ? records : [];
  const recovered = [];
  const trace = typeof options?.trace === 'function' ? options.trace : null;

  traceRecoverEvent(trace, 'camera_raw_recover_phase_start', {
    phase: normalizedPhase,
    totalRecords: safeRecords.length,
  });

  for (const record of safeRecords) {
    if ((record?.phase === 'closing' ? 'closing' : 'entry') !== normalizedPhase) continue;

    const src = String(resolveCameraRawImageSrc(record) || '').trim();
    const srcKind = detectSourceKind(src);
    const recordId = String(record?.id || '').trim() || null;
    if (!src || /^https?:\/\//i.test(src)) {
      traceRecoverEvent(trace, 'camera_raw_recover_skip_record', {
        phase: normalizedPhase,
        recordId,
        srcKind,
        reason: src ? 'remote_http_source' : 'missing_source',
      });
      continue;
    }

    const fileName = String(record?.fileName || `${normalizedPhase}_recovered.jpg`).trim() || `${normalizedPhase}_recovered.jpg`;
    let recoveredFile = null;

    traceRecoverEvent(trace, 'camera_raw_recover_attempt', {
      phase: normalizedPhase,
      recordId,
      fileName,
      srcKind,
      mimeType: String(record?.mimeType || 'image/jpeg'),
    });

    if (/^data:image\//i.test(src)) {
      recoveredFile = dataUrlToFile(src, fileName);
    } else if (/^(file:|content:|capacitor:)/i.test(src)) {
      const nativeBlob = await nativeFileUriToBlob(src, record?.mimeType || 'image/jpeg');
      if (nativeBlob instanceof Blob) {
        recoveredFile = new File([nativeBlob], fileName, {
          type: nativeBlob.type || record?.mimeType || 'image/jpeg',
          lastModified: Date.now(),
        });
      }
    } else if (typeof fetch === 'function' && /^blob:/i.test(src)) {
      try {
        const response = await fetch(src, { method: 'GET' });
        if (response?.ok) {
          const blob = await response.blob();
          if (blob) {
            recoveredFile = new File([blob], fileName, {
              type: blob.type || record?.mimeType || 'image/jpeg',
              lastModified: Date.now(),
            });
          }
        }
      } catch (_) {
        // Ignore fetch failures and continue; the UI still has the live preview.
      }
    }

    if (!recoveredFile || !(recoveredFile instanceof Blob)) {
      traceRecoverEvent(trace, 'camera_raw_recover_failed', {
        phase: normalizedPhase,
        recordId,
        fileName,
        srcKind,
      });
      continue;
    }

    traceRecoverEvent(trace, 'camera_raw_recover_success', {
      phase: normalizedPhase,
      recordId,
      fileName,
      srcKind,
      recoveredType: recoveredFile.type || String(record?.mimeType || 'image/jpeg'),
      sizeBytes: Number(recoveredFile.size || 0),
    });

    recovered.push({
      name: recoveredFile.name,
      type: recoveredFile.type,
      blob: recoveredFile,
      phase: normalizedPhase,
      capturedAt: record?.capturedAt || '',
    });
  }

  traceRecoverEvent(trace, 'camera_raw_recover_phase_done', {
    phase: normalizedPhase,
    recoveredCount: recovered.length,
  });

  return recovered;
}

export function dataUrlToBlob(dataUrl, fallbackType = 'image/jpeg') {
  if (typeof dataUrl !== 'string' || !dataUrl.trim()) return null;
  const trimmed = dataUrl.trim();
  if (!trimmed.startsWith('data:')) return null;

  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(?:;base64)?,(.*)$/i.exec(trimmed);
  if (!match) return null;

  const mimeType = match[1] || fallbackType;
  const isBase64 = /;base64/i.test(trimmed);
  const raw = match[2] || '';

  try {
    const binaryText = isBase64 ? atob(raw) : decodeURIComponent(raw);
    const bytes = new Uint8Array(binaryText.length);
    for (let index = 0; index < binaryText.length; index += 1) {
      bytes[index] = binaryText.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  } catch (_) {
    return null;
  }
}

export function rebuildUploadableEvidenceFromCameraRaw(cameraRawRecords = [], phase = 'entry') {
  const phaseName = phase === 'closing' ? 'closing' : 'entry';
  const records = Array.isArray(cameraRawRecords) ? cameraRawRecords : [];

  return records
    .filter((record) => String(record?.phase || '').toLowerCase() === phaseName)
    .map(async (record, index) => {
      const candidates = [
        record?.localPreviewUrl,
        record?.previewUrl,
        record?.imageUrl,
        record?.url,
        record?.publicUrl,
        record?.fileUrl,
      ].filter((value) => typeof value === 'string' && value.trim());

      for (const candidate of candidates) {
        const blob = candidate.startsWith('data:') ? dataUrlToBlob(candidate, record?.mimeType || 'image/jpeg') : null;
        if (blob) {
          return {
            name: String(record?.fileName || `${phaseName}_evidence_${index + 1}.jpg`),
            type: String(record?.mimeType || blob.type || 'image/jpeg'),
            blob,
            phase: phaseName,
          };
        }

        if (/^(file:|content:|capacitor:)/i.test(candidate)) {
          const nativeBlob = await nativeFileUriToBlob(candidate, record?.mimeType || 'image/jpeg');
          if (nativeBlob instanceof Blob) {
            return {
              name: String(record?.fileName || `${phaseName}_evidence_${index + 1}.jpg`),
              type: String(record?.mimeType || nativeBlob.type || 'image/jpeg'),
              blob: new File([nativeBlob], String(record?.fileName || `${phaseName}_evidence_${index + 1}.jpg`), {
                type: nativeBlob.type || record?.mimeType || 'image/jpeg',
                lastModified: Date.now(),
              }),
              phase: phaseName,
            };
          }
        }
      }

      return null;
    })
    .filter(Boolean);
}

export function decideEvidenceSource({
  entryUploadableFiles = [],
  closingUploadableFiles = [],
  payloadEntryImages = [],
  payloadClosingImages = [],
  hasDeepPayloadPair = false,
  legacyItem = false,
  previouslyFailedItem = false,
} = {}) {
  const hasRealLocalEvidencePair = entryUploadableFiles.length > 0 && closingUploadableFiles.length > 0;
  const hasAnyLocalEvidence = entryUploadableFiles.length > 0 || closingUploadableFiles.length > 0;
  const hasPayloadPairedEvidence = payloadEntryImages.length > 0 && payloadClosingImages.length > 0;

  const shouldPreferStoredPayloadEvidence = !hasRealLocalEvidencePair && !hasAnyLocalEvidence && (
    hasDeepPayloadPair || (
      hasPayloadPairedEvidence && (previouslyFailedItem || legacyItem)
    )
  );

  const shouldUploadLocalEvidence = !shouldPreferStoredPayloadEvidence && hasAnyLocalEvidence;

  return {
    hasRealLocalEvidencePair,
    hasAnyLocalEvidence,
    hasPayloadPairedEvidence,
    hasDeepPayloadPair,
    shouldPreferStoredPayloadEvidence,
    shouldUploadLocalEvidence,
  };
}
