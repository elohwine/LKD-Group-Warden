import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('buildApiUrl', () => {
  const originalApiBase = process.env.NEXT_PUBLIC_API_BASE_URL;
  const originalSecondaryApiBase = process.env.NEXT_PUBLIC_API_BASE_URL_SECONDARY;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://ldkgroup.co.uk';
    process.env.NEXT_PUBLIC_API_BASE_URL_SECONDARY = 'https://ldk-group-ltd-website-react-p2ea.onrender.com';
    global.window = {
      location: { hostname: 'localhost' },
      Capacitor: { isNativePlatform: () => true },
    };
  });

  afterEach(() => {
    if (originalApiBase === undefined) {
      delete process.env.NEXT_PUBLIC_API_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_API_BASE_URL = originalApiBase;
    }

    if (originalSecondaryApiBase === undefined) {
      delete process.env.NEXT_PUBLIC_API_BASE_URL_SECONDARY;
    } else {
      process.env.NEXT_PUBLIC_API_BASE_URL_SECONDARY = originalSecondaryApiBase;
    }

    delete global.window;
  });

  it('uses the configured API host as-is without host rewrite', async () => {
    const { buildApiUrl } = await import('./api.js');
    expect(buildApiUrl('/api/breaches/wardencapture')).toBe('https://ldkgroup.co.uk/api/breaches/wardencapture');
  });
});

describe('buildCameraServiceUrl', () => {
  const originalEnv = process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL = 'https://camera.ldkgroup.co.uk';
    global.window = {
      location: { hostname: 'localhost' },
      Capacitor: { isNativePlatform: () => true },
    };
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
