import { describe, expect, it } from 'vitest';
import { buildCameraServiceCapturePayload } from './relay-to-camera-service.js';

describe('buildCameraServiceCapturePayload', () => {
  it('keeps the original camera-service field names and includes OCR confidence', () => {
    const payload = buildCameraServiceCapturePayload({
      body: {
        vrm: 'ab12 cde',
        timestamp: '2026-09-11T10:00:00Z',
        direction: 'entry',
        vehicleImage: 'https://example.com/vehicle.jpg',
        plateImage: 'https://example.com/plate.jpg',
        confidence: 87.5,
        siteId: 'site-42',
        siteName: 'Main Site',
      },
      wardenId: 'warden-123',
      wardenEmail: 'warden@example.com',
      wardenName: 'Test Warden',
      deviceIp: '192.168.0.10',
    });

    expect(payload).toMatchObject({
      Registration: 'AB12CDE',
      ReadTime: '2026-09-11T10:00:00.000Z',
      Direction: 'entry',
      PlateImage: 'https://example.com/plate.jpg',
      OverviewImage: 'https://example.com/vehicle.jpg',
      confidence: 87.5,
      siteId: 'site-42',
      site: 'Main Site',
      wardenId: 'warden-123',
      wardenEmail: 'warden@example.com',
      wardenName: 'Test Warden',
      deviceIp: '192.168.0.10',
    });
  });

  it('falls back to legacy keys and normalizes direction and timestamps', () => {
    const payload = buildCameraServiceCapturePayload({
      body: {
        Registration: 'XY99ZZZ',
        ReadTime: '2026-09-11T10:00:00+01:00',
        Direction: 'OUT',
        PlateImage: 'https://example.com/legacy-plate.jpg',
        OverviewImage: 'https://example.com/legacy-vehicle.jpg',
        plateConfidence: 91,
        site: 'West Yard',
      },
      wardenId: 'warden-9',
      wardenEmail: 'keeper@example.com',
      wardenName: 'Keeper',
    });

    expect(payload.Registration).toBe('XY99ZZZ');
    expect(payload.confidence).toBe(91);
    expect(payload.Direction).toBe('exit');
    expect(payload.ReadTime).toMatch(/T.*Z$/);
    expect(payload.site).toBe('West Yard');
    expect(payload.PlateImage).toBe('https://example.com/legacy-plate.jpg');
    expect(payload.OverviewImage).toBe('https://example.com/legacy-vehicle.jpg');
  });
});
