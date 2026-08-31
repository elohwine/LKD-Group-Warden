function normalizeApiBase(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) return '';
  return trimmed.replace(/^https:\/\/www\.ldkgroup\.co\.uk/i, 'https://ldkgroup.co.uk');
}

function normalizeCameraServiceBase(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) return '';
  return trimmed.replace(/^https:\/\/www\.camera\.ldkgroup\.co\.uk/i, 'https://camera.ldkgroup.co.uk');
}

const DEFAULT_API_BASE = normalizeApiBase(process.env.NEXT_PUBLIC_API_BASE_URL || '');
const DEFAULT_SECONDARY_API_BASE = normalizeApiBase(process.env.NEXT_PUBLIC_API_BASE_URL_SECONDARY || 'https://ldkgroup.co.uk');
const DEFAULT_CAMERA_SERVICE_BASE = normalizeCameraServiceBase(process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL || '');
const FALLBACK_CAMERA_SERVICE_BASE = 'https://ldk-group-camera-service.onrender.com';
const DEFAULT_NATIVE_REQUEST_TIMEOUT_MS = 30000;

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

function toRenderOriginUrl(url) {
  const current = String(url || '').trim();
  if (!current) return null;
  if (!/^https:\/\/(www\.)?ldkgroup\.co\.uk\b/i.test(current)) return null;
  return current.replace(/^https:\/\/(www\.)?ldkgroup\.co\.uk/i, 'https://ldk-group-ltd-website-react-p2ea.onrender.com');
}

function toSecondaryApiOriginUrl(url) {
  const current = String(url || '').trim();
  if (!current || !DEFAULT_SECONDARY_API_BASE) return null;
  if (/^https:\/\/(www\.)?camera\.ldkgroup\.co\.uk\b/i.test(current)) return null;
  if (/^https:\/\/ldk-group-camera-service\.onrender\.com\b/i.test(current)) return null;

  try {
    const currentUrl = new URL(current);
    const secondaryOrigin = new URL(DEFAULT_SECONDARY_API_BASE);
    if (currentUrl.origin === secondaryOrigin.origin) return null;
    currentUrl.protocol = secondaryOrigin.protocol;
    currentUrl.host = secondaryOrigin.host;
    return currentUrl.toString();
  } catch (_) {
    return null;
  }
}

function toRenderCameraServiceUrl(url) {
  const current = String(url || '').trim();
  if (!current) return null;
  if (!/^https:\/\/(www\.)?camera\.ldkgroup\.co\.uk\b/i.test(current)) return null;
  return current.replace(/^https:\/\/(www\.)?camera\.ldkgroup\.co\.uk/i, 'https://ldk-group-camera-service.onrender.com');
}

function isTransientNetworkAbort(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('software caused connection abort')
    || message.includes('unable to resolve host')
    || message.includes('failed to fetch')
    || message.includes('network request failed')
    || message.includes('connection reset')
    || message.includes('connection aborted');
}

function isDnsLookupFailure(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('unable to resolve host')
    || message.includes('no address associated with hostname')
    || message.includes('name or service not known')
    || message.includes('dns');
}

function normalizeNativeNetworkError(error, url) {
  const message = String(error?.message || '').trim();
  const targetUrl = String(url || '');
  if (!message) return error;

  if (isDnsLookupFailure(error)) {
    const isRenderHost = /ldk-group-ltd-website-react-p2ea\.onrender\.com/i.test(targetUrl) || /ldk-group-ltd-website-react-p2ea\.onrender\.com/i.test(message);
    const normalized = new Error(
      isRenderHost
        ? 'Primary API host DNS lookup failed (onrender). Check device DNS/network and retry.'
        : 'API host DNS lookup failed. Check device DNS/network and retry.'
    );
    normalized.status = Number(error?.status || 0) || 0;
    normalized.data = error?.data;
    normalized.cause = error;
    return normalized;
  }

  return error;
}

async function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
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

function serializeBody(body) {
  if (body instanceof FormData) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body === 'string') return body;
  if (body === undefined || body === null) return undefined;
  return JSON.stringify(body);
}

function isLikelyHtmlPayload(payload) {
  const text = String(payload || '').trim();
  if (!text) return false;
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text);
}

function buildRequestErrorMessage(status, data, url = '') {
  const normalizedStatus = Number(status || 0);
  const requestUrl = String(url || '');
  const isCameraServiceRequest = /camera\.ldkgroup\.co\.uk|ldk-group-camera-service\.onrender\.com/i.test(requestUrl);

  if (typeof data === 'string') {
    if (isLikelyHtmlPayload(data)) {
      if (normalizedStatus === 502 && isCameraServiceRequest) {
        return 'ANPR service is temporarily unavailable (502). Please retry in a moment.';
      }
      return `Request failed (${normalizedStatus || 'network'})`;
    }
    const safe = data.trim();
    if (safe) return safe;
  }

  if (data && typeof data === 'object') {
    const structured = String(data?.error || data?.message || '').trim();
    if (structured) return structured;
  }

  if (normalizedStatus === 502 && isCameraServiceRequest) {
    return 'ANPR service is temporarily unavailable (502). Please retry in a moment.';
  }

  return `Request failed (${normalizedStatus || 'network'})`;
}

function prepareHeaders(headers = {}, token, body) {
  const requestHeaders = new Headers(headers || {});
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  const isRawBody = typeof body === 'string' || body instanceof URLSearchParams;
  if (body && !(body instanceof FormData) && !isRawBody) {
    requestHeaders.set('Content-Type', 'application/json');
  }
  return requestHeaders;
}

function getRedirectLocationFromNativeResponse(response) {
  const headers = response?.headers;
  if (!headers || typeof headers !== 'object') return '';

  const location = headers.location || headers.Location || headers.LOCATION || '';
  return String(location || '').trim();
}

function resolveRedirectUrl(baseUrl, location) {
  const rawLocation = String(location || '').trim();
  if (!rawLocation) return '';

  try {
    return new URL(rawLocation, String(baseUrl || '')).toString();
  } catch (_) {
    return '';
  }
}

async function requestJsonViaNativeHttp(url, options = {}, redirectCount = 0) {
  const nativeHttp = getCapacitorHttp();
  if (!nativeHttp?.request) {
    throw new Error('native_http_unavailable');
  }

  const { token, body, headers, timeoutMs = 0, ...rest } = options;
  if (body instanceof FormData) {
    throw new Error('native_http_formdata_not_supported');
  }

  const requestHeaders = {};
  const headerSource = headers instanceof Headers ? headers : new Headers(headers || {});
  headerSource.forEach((value, key) => {
    requestHeaders[key] = value;
  });
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined && body !== null && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-type')) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  const requestPromise = nativeHttp.request({
    url,
    method: String(rest.method || 'GET').toUpperCase(),
    headers: requestHeaders,
    data: serializeBody(body),
  });

  const response = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? await Promise.race([
      requestPromise,
      new Promise((_, reject) => {
        setTimeout(() => {
          const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
          timeoutError.status = 408;
          reject(timeoutError);
        }, timeoutMs);
      }),
    ])
    : await requestPromise;

  const status = Number(response?.status || 0);
  const data = normalizeNativeResponseData(response?.data);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = getRedirectLocationFromNativeResponse(response);
    const redirectUrl = resolveRedirectUrl(url, location);

    if (redirectUrl && redirectCount < 3) {
      const redirectOptions = { ...options };
      if (status === 303) {
        redirectOptions.method = 'GET';
        redirectOptions.body = undefined;
      }
      return requestJsonViaNativeHttp(redirectUrl, redirectOptions, redirectCount + 1);
    }
  }

  if (status < 200 || status >= 300) {
    const message = buildRequestErrorMessage(status || 'native', data, url);
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
    return `${configuredBase}${normalizedPath}`;
  }

  if (shouldUseLocalApi(normalizedPath)) return normalizedPath;

  return `${FALLBACK_CAMERA_SERVICE_BASE}${normalizedPath}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_NATIVE_REQUEST_TIMEOUT_MS) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId = null;
  const { signal, ...rest } = options || {};

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

  try {
    return await fetch(url, {
      ...rest,
      signal: controller ? controller.signal : signal,
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requestJson(urlBuilder, path, options = {}) {
  const {
    token,
    body,
    headers,
    timeoutMs = 0,
    signal,
    allowApiHostFallback = false,
    allowCameraHostFallback = false,
    ...rest
  } = options;
  const url = urlBuilder(path);
  const method = String(rest.method || 'GET').toUpperCase();
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_NATIVE_REQUEST_TIMEOUT_MS;

  if (shouldUseNativeHttp(url) && !(body instanceof FormData)) {
    let nativeError = null;
    try {
      return await requestJsonViaNativeHttp(url, { ...options, timeoutMs: effectiveTimeoutMs });
    } catch (caughtError) {
      nativeError = caughtError;
      if (String(nativeError?.message || '') !== 'native_http_unavailable') {
        if (isTransientNetworkAbort(nativeError)) {
          try {
            await sleepMs(250);
            return await requestJsonViaNativeHttp(url, { ...options, timeoutMs: effectiveTimeoutMs });
          } catch (retryError) {
            nativeError = retryError;
          }
        }

        if (allowApiHostFallback || allowCameraHostFallback) {
          const renderUrl = toRenderOriginUrl(url);
          const secondaryApiUrl = allowApiHostFallback ? toSecondaryApiOriginUrl(url) : null;
          const renderCameraUrl = toRenderCameraServiceUrl(url);

          if (renderUrl && renderUrl !== url) {
            try {
              return await requestJsonViaNativeHttp(renderUrl, { ...options, timeoutMs: effectiveTimeoutMs });
            } catch (renderError) {
              if (isTransientNetworkAbort(renderError)) {
                try {
                  await sleepMs(250);
                  return await requestJsonViaNativeHttp(renderUrl, { ...options, timeoutMs: effectiveTimeoutMs });
                } catch (renderRetryError) {
                  nativeError = renderRetryError;
                }
              } else {
                nativeError = renderError;
              }
            }
          }

          if (secondaryApiUrl && secondaryApiUrl !== url && secondaryApiUrl !== renderUrl) {
            try {
              return await requestJsonViaNativeHttp(secondaryApiUrl, { ...options, timeoutMs: effectiveTimeoutMs });
            } catch (secondaryApiError) {
              if (isTransientNetworkAbort(secondaryApiError)) {
                try {
                  await sleepMs(250);
                  return await requestJsonViaNativeHttp(secondaryApiUrl, { ...options, timeoutMs: effectiveTimeoutMs });
                } catch (secondaryApiRetryError) {
                  nativeError = secondaryApiRetryError;
                }
              } else {
                nativeError = secondaryApiError;
              }
            }
          }

          if (renderCameraUrl && renderCameraUrl !== url) {
            try {
              return await requestJsonViaNativeHttp(renderCameraUrl, { ...options, timeoutMs: effectiveTimeoutMs });
            } catch (renderCameraError) {
              if (isTransientNetworkAbort(renderCameraError)) {
                try {
                  await sleepMs(250);
                  return await requestJsonViaNativeHttp(renderCameraUrl, { ...options, timeoutMs: effectiveTimeoutMs });
                } catch (renderCameraRetryError) {
                  nativeError = renderCameraRetryError;
                }
              } else {
                nativeError = renderCameraError;
              }
            }
          }
        }

        console.error('[api] native request failed', {
          method,
          url,
          status: Number(nativeError?.status || 0) || null,
          message: nativeError?.message || null,
        });
        throw normalizeNativeNetworkError(nativeError, url);
      }
    }
  }

  const requestHeaders = prepareHeaders(headers, token, body);
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
  let resolvedUrl = url;
  const requestInit = {
    ...rest,
    headers: requestHeaders,
    signal: controller ? controller.signal : signal,
    body: serializeBody(body),
  };

  try {
    response = await fetchWithTimeout(resolvedUrl, requestInit, timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    if (error?.name === 'AbortError' || String(error?.message || '').toLowerCase().includes('request_timeout')) {
      const timeoutError = new Error(`Request timed out after ${timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS}ms`);
      timeoutError.status = 408;
      timeoutError.url = url;
      timeoutError.method = method;
      throw timeoutError;
    }

    if (isNativeApp() && isTransientNetworkAbort(error)) {
      try {
        await sleepMs(250);
        response = await fetchWithTimeout(resolvedUrl, requestInit, timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS);
      } catch (retryError) {
        error = retryError;
      }
    }

    if (!response && (allowApiHostFallback || allowCameraHostFallback)) {
      const renderUrl = toRenderOriginUrl(url);
      const secondaryApiUrl = allowApiHostFallback ? toSecondaryApiOriginUrl(url) : null;
      const renderCameraUrl = toRenderCameraServiceUrl(url);

      if (!response && renderUrl && renderUrl !== url) {
        try {
          resolvedUrl = renderUrl;
          response = await fetchWithTimeout(resolvedUrl, requestInit, timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS);
        } catch (renderError) {
          if (isNativeApp() && isTransientNetworkAbort(renderError)) {
            try {
              await sleepMs(250);
              response = await fetchWithTimeout(resolvedUrl, requestInit, timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS);
            } catch (renderRetryError) {
              renderError = renderRetryError;
            }
          }

          if (!response) {
            if (timeoutId) clearTimeout(timeoutId);
            console.error('[api] render-host request also failed', {
              method,
              primaryUrl: url,
              renderUrl,
              message: renderError?.message || String(renderError),
              name: renderError?.name || null,
            });
            throw renderError;
          }
        }
      }

      if (!response && secondaryApiUrl && secondaryApiUrl !== url && secondaryApiUrl !== renderUrl) {
        try {
          resolvedUrl = secondaryApiUrl;
          response = await fetchWithTimeout(resolvedUrl, requestInit, timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS);
        } catch (secondaryApiError) {
          if (isNativeApp() && isTransientNetworkAbort(secondaryApiError)) {
            try {
              await sleepMs(250);
              response = await fetchWithTimeout(resolvedUrl, requestInit, timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS);
            } catch (secondaryApiRetryError) {
              secondaryApiError = secondaryApiRetryError;
            }
          }

          if (!response) {
            if (timeoutId) clearTimeout(timeoutId);
            console.error('[api] secondary api host request also failed', {
              method,
              primaryUrl: url,
              renderUrl,
              secondaryApiUrl,
              message: secondaryApiError?.message || String(secondaryApiError),
              name: secondaryApiError?.name || null,
            });
            throw secondaryApiError;
          }
        }
      }

      if (!response && renderCameraUrl && renderCameraUrl !== url) {
        try {
          resolvedUrl = renderCameraUrl;
          response = await fetchWithTimeout(resolvedUrl, requestInit, timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS);
        } catch (renderCameraError) {
          if (isNativeApp() && isTransientNetworkAbort(renderCameraError)) {
            try {
              await sleepMs(250);
              response = await fetchWithTimeout(resolvedUrl, requestInit, timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS);
            } catch (renderCameraRetryError) {
              renderCameraError = renderCameraRetryError;
            }
          }

          if (!response) {
            if (timeoutId) clearTimeout(timeoutId);
            console.error('[api] render camera host request also failed', {
              method,
              primaryUrl: url,
              renderCameraUrl,
              message: renderCameraError?.message || String(renderCameraError),
              name: renderCameraError?.name || null,
            });
            throw renderCameraError;
          }
        }
      }
    } else {
      console.error('[api] fetch request failed before response', {
        method,
        url,
        message: error?.message || String(error),
        name: error?.name || null,
      });
      throw error;
    }
  }

  if (!response) {
    throw new Error('request_failed_no_response');
  }

  if (timeoutId) clearTimeout(timeoutId);

  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();
  let data = rawText;

  if (rawText && rawText.trim()) {
    if (contentType.includes('application/json')) {
      try {
        data = JSON.parse(rawText);
      } catch (_) {
        data = rawText;
      }
    }
  } else {
    data = null;
  }

  if (!response.ok) {
    const message = buildRequestErrorMessage(response.status, data, resolvedUrl);
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    error.url = resolvedUrl;
    error.method = method;
    console.error('[api] request returned non-ok status', {
      method,
      url: resolvedUrl,
      status: response.status,
      message,
    });
    throw error;
  }

  return data;
}

export async function fetchJson(path, options = {}) {
  return requestJson(buildApiUrl, path, {
    ...options,
    allowApiHostFallback: true,
  });
}

export async function fetchCameraServiceJson(path, options = {}) {
  return requestJson(buildCameraServiceUrl, path, {
    ...options,
    allowCameraHostFallback: true,
  });
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
    body: serializeBody(body),
  });

  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();
  let data = rawText;

  if (rawText && rawText.trim()) {
    if (contentType.includes('application/json')) {
      try {
        data = JSON.parse(rawText);
      } catch (_) {
        data = rawText;
      }
    }
  } else {
    data = null;
  }

  if (!response.ok) {
    const message = buildRequestErrorMessage(response.status, data, path);
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}
