import { Capacitor, registerPlugin } from '@capacitor/core';

const NativeAnpr = registerPlugin('NativeAnpr');

export async function isNativeAnprAvailable() {
  if (!Capacitor.isNativePlatform()) return false;

  try {
    const result = await NativeAnpr.isAvailable();
    return Boolean(result?.available);
  } catch (_) {
    return false;
  }
}

export async function analyzeImageWithNativeAnpr(base64Data) {
  if (!base64Data) return null;

  try {
    const result = await NativeAnpr.analyzeImage({
      data: base64Data,
      format: 'jpeg',
    });
    return result || null;
  } catch (_) {
    return null;
  }
}

export async function startNativeAnprLive(options = {}) {
  return NativeAnpr.startLiveScan({
    frameSkip: Number(options.frameSkip || 4),
    minEventIntervalMs: Number(options.minEventIntervalMs || 300),
  });
}

export async function stopNativeAnprLive() {
  try {
    await NativeAnpr.stopLiveScan();
  } catch (_) {
    // Ignore best-effort stop failures.
  }
}

export async function addNativeAnprListener(listener) {
  const handle = await NativeAnpr.addListener('anprResult', (payload) => {
    if (typeof listener === 'function') listener(payload || {});
  });

  return async () => {
    try {
      await handle.remove();
    } catch (_) {
      // Ignore listener removal failures.
    }
  };
}
