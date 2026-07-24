const DEFAULT_API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_WARDEN_API_BASE_URL || '').replace(/\/$/, '');
const DEFAULT_CAMERA_SERVICE_BASE = (process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL || '').replace(/\/$/, '');

function isNativeApp() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.Capacitor?.isNativePlatform?.()) return true;
  } catch (_) {}
  const protocol = window.location?.protocol;
  return protocol === 'capacitor:' || protocol === 'ionic:';
}

function shouldUseLocalApi(path) {
  if (typeof window === 'undefined') return false;
  if (!path || !path.startsWith('/api/')) return false;
  if (isNativeApp()) return false;
  const { hostname } = window.location;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

export function buildApiUrl(path) {
  if (!path) return DEFAULT_API_BASE || '';
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (shouldUseLocalApi(normalizedPath)) return normalizedPath;
  if (DEFAULT_API_BASE) return `${DEFAULT_API_BASE}${normalizedPath}`;
  throw new Error('API base URL is not configured. Set NEXT_PUBLIC_API_BASE_URL for the exported mobile app.');
}

export function buildCameraServiceUrl(path) {
  if (!path) return DEFAULT_CAMERA_SERVICE_BASE || DEFAULT_API_BASE || '';
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  // In local web dev, allow same-origin API routes for convenience.
  if (shouldUseLocalApi(normalizedPath)) return normalizedPath;

  if (DEFAULT_CAMERA_SERVICE_BASE) return `${DEFAULT_CAMERA_SERVICE_BASE}${normalizedPath}`;
  if (DEFAULT_API_BASE) return `${DEFAULT_API_BASE}${normalizedPath}`;
  throw new Error('Camera service base URL is not configured. Set NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL.');
}

async function requestJson(urlBuilder, path, options = {}) {
  const { token, body, headers, ...rest } = options;
  const requestHeaders = new Headers(headers || {});
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  if (body && !(body instanceof FormData)) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(urlBuilder(path), {
    ...rest,
    headers: requestHeaders,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const isHtml = typeof data === 'string' && /<!doctype html|<html[\s>]/i.test(data);
    const message = isHtml
      ? `Request failed (${response.status})`
      : typeof data === 'string'
        ? data
        : data?.error || data?.message || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export async function fetchJson(path, options = {}) {
  return requestJson(buildApiUrl, path, options);
}

export async function fetchCameraServiceJson(path, options = {}) {
  return requestJson(buildCameraServiceUrl, path, options);
}

export async function fetchLocalJson(path, options = {}) {
  const { token, body, headers, ...rest } = options;
  const requestHeaders = new Headers(headers || {});
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  if (body && !(body instanceof FormData)) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...rest,
    headers: requestHeaders,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const isHtml = typeof data === 'string' && /<!doctype html|<html[\s>]/i.test(data);
    const message = isHtml
      ? `Request failed (${response.status})`
      : typeof data === 'string'
        ? data
        : data?.error || data?.message || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}