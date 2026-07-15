import { Capacitor } from '@capacitor/core';
import { CameraPreview } from '@capacitor-community/camera-preview';

export function canUseNativeCameraPreview() {
  return Capacitor.isNativePlatform();
}

export async function startNativeCameraPreview() {
  // On Android/iOS the plugin renders the camera BEHIND the entire WebView when toBack:true.
  // width:0 / height:0 defaults to full screen (device screen dimensions).
  // The JS caller must ensure all HTML above the camera area is background:transparent.
  // The plugin itself calls WebView.setBackgroundColor(TRANSPARENT) on start.
  await CameraPreview.start({
    position: 'rear',
    toBack: true,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    enableZoom: true,
    disableAudio: true,
    storeToFile: false,
  });
}

export async function setNativeCameraTorchEnabled(enabled = false) {
  const torchOn = Boolean(enabled);

  try {
    if (typeof CameraPreview.setFlashMode === 'function') {
      await CameraPreview.setFlashMode({ flashMode: torchOn ? 'torch' : 'off' });
      return;
    }

    if (typeof CameraPreview.setTorchMode === 'function') {
      await CameraPreview.setTorchMode({ enabled: torchOn });
      return;
    }

    if (typeof CameraPreview.setTorch === 'function') {
      await CameraPreview.setTorch({ enabled: torchOn });
    }
  } catch (_) {
    // Ignore torch failures on devices/plugins that do not support it.
  }
}

export async function stopNativeCameraPreview() {
  try {
    await setNativeCameraTorchEnabled(false);
    await CameraPreview.stop();
  } catch (_) {
    // Ignore stop failures; camera may already be stopped.
  }
}

export async function captureNativeCameraSample(quality = 88) {
  const result = await CameraPreview.captureSample({
    quality: Math.max(20, Math.min(100, Number(quality || 88))),
  });
  return String(result?.value || '');
}
