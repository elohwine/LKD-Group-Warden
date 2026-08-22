const DEFAULT_API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '');
const DEFAULT_CAMERA_SERVICE_BASE = (process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL || '').replace(/\/$/, '');
const FALLBACK_CAMERA_SERVICE_BASE = 'https://ldk-group-camera-service.onrender.com';

function normalizeCameraServiceBase(baseUrl) {
  if (!baseUrl) return '';
  const trimmed = String(baseUrl).trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/$/, '');
}

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

function getCapacitorHttp() {
  if (typeof window === 'undefined') return null;
  return window.Capacitor?.Plugins?.CapacitorHttp || null;
}

function shouldUseNativeHttp(url) {
  if (!isNativeApp()) return false;
  return /^https?:\/\//i.test(String(url || ''));
}

function normalizeNativeResponseData(data) {
  if (typeof data !== 'string') return data;
  const trimmed = data.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return data;
  }
}

async function requestJsonViaNativeHttp(url, options = {}) {
  const nativeHttp = getCapacitorHttp();
  if (!nativeHttp?.request) {
    throw new Error('native_http_unavailable');
  }

  const { token, body, headers, timeoutMs = 0, ...rest } = options;
  if (body instanceof FormData) {
    throw new Error('native_http_formdata_not_supported');
  }

  const requestHeaders = { ...(headers || {}) };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined && body !== null) {
    const hasContentType = Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-type');
    if (!hasContentType) requestHeaders['Content-Type'] = 'application/json';
  }

  const requestPromise = nativeHttp.request({
    url,
    method: String(rest.method || 'GET').toUpperCase(),
    headers: requestHeaders,
    data: body,
  });

  let response;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    response = await Promise.race([
      requestPromise,
      new Promise((_, reject) => {
        setTimeout(() => {
          const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
          timeoutError.status = 408;
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } else {
    response = await requestPromise;
  }

  const status = Number(response?.status || 0);
  const data = normalizeNativeResponseData(response?.data);

  if (status < 200 || status >= 300) {
    const message = typeof data === 'string'
      ? data
      : data?.error || data?.message || `Request failed (${status || 'native'})`;
    const error = new Error(message);
    error.status = status;
    error.data = data;
    throw error;
  }

  return data;
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
  if (!path) return normalizeCameraServiceBase(DEFAULT_CAMERA_SERVICE_BASE) || FALLBACK_CAMERA_SERVICE_BASE;
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  const configuredBase = normalizeCameraServiceBase(DEFAULT_CAMERA_SERVICE_BASE);
  if (configuredBase) {
    const normalizedConfiguredBase = configuredBase.replace(/camera\.ldkgroup\.co\.uk$/i, 'ldk-group-camera-service.onrender.com');
    return `${normalizedConfiguredBase}${normalizedPath}`;
  }

  if (shouldUseLocalApi(normalizedPath)) return normalizedPath;

  return `${FALLBACK_CAMERA_SERVICE_BASE}${normalizedPath}`;
}

async function requestJson(urlBuilder, path, options = {}) {
  const { token, body, headers, timeoutMs = 0, signal, ...rest } = options;
  const url = urlBuilder(path);

  if (shouldUseNativeHttp(url) && !(body instanceof FormData)) {
    try {
      return await requestJsonViaNativeHttp(url, options);
    } catch (nativeError) {
      if (String(nativeError?.message || '') !== 'native_http_unavailable') {
        throw nativeError;
      }
    }
  }

  const requestHeaders = new Headers(headers || {});
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  const isRawBody = typeof body === 'string' || body instanceof URLSearchParams;
  if (body && !(body instanceof FormData) && !isRawBody) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId = null;

  if (controller && signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
  }

  if (controller && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(new Error('request_timeout')), timeoutMs);
  }

  let response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: requestHeaders,
      signal: controller ? controller.signal : signal,
      body: body instanceof FormData
        ? body
        : body instanceof URLSearchParams
          ? body.toString()
          : typeof body === 'string'
            ? body
            : body
              ? JSON.stringify(body)
              : undefined
    });
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    if (error?.name === 'AbortError' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutError.status = 408;
      throw timeoutError;
    }
    throw error;
  }

  if (timeoutId) clearTimeout(timeoutId);

  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();
  let data = rawText;

  if (rawText && rawText.trim()) {
    if (contentType.includes('application/json')) {
      try {
        data = JSON.parse(rawText);
      } catch (error) {
        data = rawText;
      }
    }
  } else {
    data = null;
  }

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
  const isRawBody = typeof body === 'string' || body instanceof URLSearchParams;
  if (body && !(body instanceof FormData) && !isRawBody) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...rest,
    headers: requestHeaders,
    body: body instanceof FormData
      ? body
      : body instanceof URLSearchParams
        ? body.toString()
        : typeof body === 'string'
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
  });

  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();
  let data = rawText;

  if (rawText && rawText.trim()) {
    if (contentType.includes('application/json')) {
      try {
        data = JSON.parse(rawText);
      } catch (error) {
        data = rawText;
      }
    }
  } else {
    data = null;
  }

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