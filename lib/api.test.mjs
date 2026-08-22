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

  it('uses the configured camera-service host when it is explicitly set', async () => {
    const { buildCameraServiceUrl } = await import('./api.js');
    expect(buildCameraServiceUrl('/api/cameras')).toBe('https://camera.ldkgroup.co.uk/api/cameras');
  });
});
