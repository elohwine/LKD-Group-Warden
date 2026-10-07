import { describe, expect, it } from 'vitest';
import { isVehicleCameraCandidate } from './vehicleCameras.js';

describe('isVehicleCameraCandidate', () => {
  it('accepts only explicit vehicle-camera records', () => {
    expect(isVehicleCameraCandidate({ cameraType: 'Vehicle Camera' })).toBe(true);
    expect(isVehicleCameraCandidate({ cameraType: 'Mobile Vehicle Camera' })).toBe(true);
    expect(isVehicleCameraCandidate({ isVehicleCamera: true })).toBe(true);
    expect(isVehicleCameraCandidate({ isMobile: true, manufacturer: 'VREO', model: 'ANPR' })).toBe(true);
    expect(isVehicleCameraCandidate({ name: 'Vehicle Camera' })).toBe(true);

    expect(isVehicleCameraCandidate({ manufacturer: 'Milesight', model: 'ANPR' })).toBe(false);
    expect(isVehicleCameraCandidate({ manufacturer: 'VREO', model: 'ANPR' })).toBe(false);
    expect(isVehicleCameraCandidate({ name: 'Phoenix House ANPR', manufacturer: 'Milesight', model: 'ANPR' })).toBe(false);
    expect(isVehicleCameraCandidate({ cameraType: 'Warden App', manufacturer: 'Warden App', isMobile: true, name: 'Warden: Patrol' })).toBe(false);
    expect(isVehicleCameraCandidate({ name: 'Warden: Eloh', isMobile: true, cameraType: 'Vehicle Camera' })).toBe(false);
    expect(isVehicleCameraCandidate({ source: 'warden_app', isMobile: true })).toBe(false);
  });
});
