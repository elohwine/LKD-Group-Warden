const EXPLICIT_VEHICLE_CAMERA_TYPES = new Set(['vehicle camera', 'mobile vehicle camera']);

export function isVehicleCameraCandidate(camera) {
  if (!camera || typeof camera !== 'object') return false;

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
