import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('buildCameraServiceUrl', () => {
  const originalEnv = process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL = 'https://camera.ldkgroup.co.uk';
    global.window = { location: { hostname: 'localhost' } };
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL = originalEnv;
    }
    delete global.window;
  });

  it('falls back to the live Render camera-service URL when the legacy host is configured', async () => {
    const { buildCameraServiceUrl } = await import('./api.js');
    expect(buildCameraServiceUrl('/api/cameras')).toBe('https://ldk-group-camera-service.onrender.com/api/cameras');
  });
});
