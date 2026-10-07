const EXPLICIT_VEHICLE_CAMERA_TYPES = new Set(['vehicle camera', 'mobile vehicle camera']);

function isWardenPhoneCamera(camera) {
  const cameraType = String(camera.cameraType || '').trim().toLowerCase();
  const manufacturer = String(camera.manufacturer || '').trim().toLowerCase();
  const name = String(camera.name || '').trim().toLowerCase();
  const source = String(camera.source || '').trim().toLowerCase();

  if (cameraType === 'warden app' || manufacturer === 'warden app' || name === 'warden app') return true;
  if (name.startsWith('warden:')) return true;
  if (source === 'warden_app' || source === 'warden_webhook') return true;
  return false;
}

export function isVehicleCameraCandidate(camera) {
  if (!camera || typeof camera !== 'object') return false;
  if (isWardenPhoneCamera(camera)) return false;

  const cameraType = String(camera.cameraType || '').trim().toLowerCase();
  const explicitName = String(camera.name || '').trim().toLowerCase();
  const explicitManufacturer = String(camera.manufacturer || '').trim().toLowerCase();
  const explicitModel = String(camera.model || '').trim().toLowerCase();

  if (camera.isVehicleCamera === true) return true;
  if (camera.isMobile === true) return true;

  if (EXPLICIT_VEHICLE_CAMERA_TYPES.has(cameraType)) return true;
  if (explicitName === 'vehicle camera') return true;

  if (explicitManufacturer === 'vehicle camera' || explicitManufacturer === 'mobile vehicle camera') return true;
  if (explicitModel === 'anpr' || explicitModel === 'lpr') return false;

  return false;
}
