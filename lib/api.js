function normalizeApiBase(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) return '';
  return trimmed;
}

function normalizeCameraServiceBase(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) return '';
  return trimmed.replace(/^https:\/\/www\.camera\.ldkgroup\.co\.uk/i, 'https://camera.ldkgroup.co.uk');
}

const DEFAULT_API_BASE = normalizeApiBase(process.env.NEXT_PUBLIC_API_BASE_URL || '');
const DEFAULT_SECONDARY_API_BASE = normalizeApiBase(process.env.NEXT_PUBLIC_API_BASE_URL_SECONDARY || '');
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

function summarizeRequestBody(body) {
  if (body === undefined || body === null) {
    return { kind: 'empty', keyCount: 0, keys: [], bytes: 0 };
  }

  if (body instanceof FormData) {
    const keys = [];
    try {
      body.forEach((_, key) => keys.push(String(key)));
    } catch (_) {}
    return { kind: 'form-data', keyCount: keys.length, keys, bytes: -1 };
  }

  if (body instanceof URLSearchParams) {
    const text = body.toString();
    return { kind: 'url-search-params', keyCount: Array.from(body.keys()).length, keys: Array.from(new Set(Array.from(body.keys()).map(String))), bytes: text.length };
  }

  if (typeof body === 'string') {
    return { kind: 'string', keyCount: 0, keys: [], bytes: body.length };
  }

  if (typeof body === 'object') {
    const keys = Object.keys(body);
    let bytes = -1;
    try {
      bytes = JSON.stringify(body).length;
    } catch (_) {}
    return { kind: 'json', keyCount: keys.length, keys, bytes };
  }

  return { kind: typeof body, keyCount: 0, keys: [], bytes: -1 };
}

function toNativeRequestData(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();

  // Capacitor Http docs require native request data to be a JSON-serializable object or string.
  try {
    return JSON.parse(JSON.stringify(body));
  } catch (_) {
    const error = new Error('request_body_not_json_serializable');
    error.status = 400;
    throw error;
  }
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

  const {
    token,
    body,
    headers,
    timeoutMs = 0,
    nativeRequestTimeoutMs = 0,
    nativeConnectTimeoutMs = 0,
    nativeReadTimeoutMs = 0,
    onTrace,
    ...rest
  } = options;
  const emitTrace = typeof onTrace === 'function' ? onTrace : () => {};
  if (body instanceof FormData) {
    throw new Error('native_http_formdata_not_supported');
  }

  const requestHeaders = {};
  const headerSource = headers instanceof Headers ? headers : new Headers(headers || {});
  headerSource.forEach((value, key) => {
    requestHeaders[key] = value;
  });
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (!Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'accept')) {
    requestHeaders.Accept = 'application/json';
  }
  if (body !== undefined && body !== null && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-type')) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  const method = String(rest.method || 'GET').toUpperCase();
  const effectiveNativeTimeoutMs = Number.isFinite(nativeRequestTimeoutMs) && nativeRequestTimeoutMs > 0
    ? Number(nativeRequestTimeoutMs)
    : Number(timeoutMs) || 0;
  const configuredConnectTimeoutMs = Number.isFinite(nativeConnectTimeoutMs) && nativeConnectTimeoutMs > 0
    ? Number(nativeConnectTimeoutMs)
    : Math.min(Math.max(effectiveNativeTimeoutMs, 0), 15000);
  const configuredReadTimeoutMs = Number.isFinite(nativeReadTimeoutMs) && nativeReadTimeoutMs > 0
    ? Number(nativeReadTimeoutMs)
    : Math.max(effectiveNativeTimeoutMs, 0);
  const requestBodySummary = summarizeRequestBody(body);

  emitTrace({
    stage: 'native_request_start',
    url,
    method,
    timeoutMs: effectiveNativeTimeoutMs,
    connectTimeoutMs: configuredConnectTimeoutMs > 0 ? configuredConnectTimeoutMs : null,
    readTimeoutMs: configuredReadTimeoutMs > 0 ? configuredReadTimeoutMs : null,
    bodyKind: requestBodySummary.kind,
    bodyKeyCount: requestBodySummary.keyCount,
    bodyKeys: requestBodySummary.keys,
    bodyBytes: requestBodySummary.bytes,
    redirectCount,
  });
  const nativeData = toNativeRequestData(body);

  const requestPromise = nativeHttp.request({
    url,
    method,
    headers: requestHeaders,
    data: nativeData,
    responseType: 'json',
    disableRedirects: true,
    connectTimeout: configuredConnectTimeoutMs > 0 ? configuredConnectTimeoutMs : undefined,
    readTimeout: configuredReadTimeoutMs > 0 ? configuredReadTimeoutMs : undefined,
  });

  const response = Number.isFinite(effectiveNativeTimeoutMs) && effectiveNativeTimeoutMs > 0
    ? await Promise.race([
      requestPromise,
      new Promise((_, reject) => {
        setTimeout(() => {
          emitTrace({
            stage: 'native_timeout',
            url,
            method,
            timeoutMs: effectiveNativeTimeoutMs,
            redirectCount,
          });
          const timeoutError = new Error(`Request timed out after ${effectiveNativeTimeoutMs}ms`);
          timeoutError.status = 408;
          reject(timeoutError);
        }, effectiveNativeTimeoutMs);
      }),
    ])
    : await requestPromise;

  const status = Number(response?.status || 0);
  const data = normalizeNativeResponseData(response?.data);

  emitTrace({
    stage: 'native_response',
    url,
    method,
    status,
    redirectCount,
  });

  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = getRedirectLocationFromNativeResponse(response);
    const redirectUrl = resolveRedirectUrl(url, location);

    emitTrace({
      stage: 'native_redirect',
      fromUrl: url,
      toUrl: redirectUrl,
      status,
      redirectCount,
    });

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

function getUnpatchedWebFetch() {
  if (typeof window === 'undefined') {
    return typeof fetch === 'function' ? fetch.bind(globalThis) : null;
  }

  if (typeof window.CapacitorWebFetch === 'function') {
    return window.CapacitorWebFetch.bind(window);
  }

  return typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_NATIVE_REQUEST_TIMEOUT_MS, fetchImpl = null) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId = null;
  const { signal, ...rest } = options || {};
  const requestFetch = typeof fetchImpl === 'function' ? fetchImpl : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  if (!requestFetch) {
    throw new Error('fetch_unavailable');
  }

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
    return await requestFetch(url, {
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
    allowFetchFallbackOnNativeFailure = true,
    onTrace = null,
    ...rest
  } = options;
  const emitTrace = typeof onTrace === 'function' ? onTrace : () => {};
  const url = urlBuilder(path);
  const method = String(rest.method || 'GET').toUpperCase();
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_NATIVE_REQUEST_TIMEOUT_MS;

  emitTrace({
    stage: 'request_start',
    url,
    method,
    timeoutMs: effectiveTimeoutMs,
    nativeCandidate: shouldUseNativeHttp(url),
    bodyKind: summarizeRequestBody(body).kind,
    bodyKeyCount: summarizeRequestBody(body).keyCount,
    bodyKeys: summarizeRequestBody(body).keys,
    bodyBytes: summarizeRequestBody(body).bytes,
  });

  if (shouldUseNativeHttp(url) && !(body instanceof FormData)) {
    let nativeError = null;
    try {
      const result = await requestJsonViaNativeHttp(url, { ...options, timeoutMs: effectiveTimeoutMs, onTrace: emitTrace });
      emitTrace({ stage: 'request_success', transport: 'native', url, method });
      return result;
    } catch (caughtError) {
      nativeError = caughtError;
      emitTrace({
        stage: 'native_request_error',
        url,
        method,
        message: String(caughtError?.message || ''),
        status: Number(caughtError?.status || 0) || null,
      });
      if (String(nativeError?.message || '') !== 'native_http_unavailable') {
        if (isTransientNetworkAbort(nativeError)) {
          try {
            await sleepMs(250);
            emitTrace({ stage: 'native_retry_start', url, method });
            const retried = await requestJsonViaNativeHttp(url, { ...options, timeoutMs: effectiveTimeoutMs, onTrace: emitTrace });
            emitTrace({ stage: 'request_success', transport: 'native', url, method, retried: true });
            return retried;
          } catch (retryError) {
            nativeError = retryError;
            emitTrace({
              stage: 'native_retry_error',
              url,
              method,
              message: String(retryError?.message || ''),
              status: Number(retryError?.status || 0) || null,
            });
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

        const normalizedNativeError = normalizeNativeNetworkError(nativeError, url);
        console.error('[api] native request failed', {
          method,
          url,
          status: Number(nativeError?.status || 0) || null,
          message: nativeError?.message || null,
        });

        if (!allowFetchFallbackOnNativeFailure) {
          throw normalizedNativeError;
        }

        emitTrace({
          stage: 'native_fallback_to_fetch',
          url,
          method,
          status: Number(normalizedNativeError?.status || 0) || null,
          message: String(normalizedNativeError?.message || ''),
          fallbackTransport: 'unpatched_web_fetch',
          hasCapacitorWebFetch: typeof window !== 'undefined' && typeof window.CapacitorWebFetch === 'function',
        });
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
    emitTrace({
      stage: 'request_response',
      transport: 'fetch',
      url: resolvedUrl,
      method,
      status: Number(response?.status || 0) || null,
    });
  } catch (caughtError) {
    let fetchError = caughtError;
    if (timeoutId) clearTimeout(timeoutId);
    if (fetchError?.name === 'AbortError' || String(fetchError?.message || '').toLowerCase().includes('request_timeout')) {
      const timeoutError = new Error(`Request timed out after ${timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS}ms`);
      timeoutError.status = 408;
      timeoutError.url = url;
      timeoutError.method = method;
      emitTrace({
        stage: 'request_timeout',
        transport: 'fetch',
        url,
        method,
        timeoutMs: timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS,
      });
      throw timeoutError;
    }

    if (isNativeApp() && isTransientNetworkAbort(fetchError)) {
      try {
        await sleepMs(250);
        emitTrace({
          stage: 'fetch_retry_start',
          transport: 'fetch',
          url: resolvedUrl,
          method,
        });
        response = await fetchWithTimeout(resolvedUrl, requestInit, timeoutMs || DEFAULT_NATIVE_REQUEST_TIMEOUT_MS);
      } catch (retryError) {
        fetchError = retryError;
        emitTrace({
          stage: 'fetch_retry_error',
          transport: 'fetch',
          url: resolvedUrl,
          method,
          message: String(retryError?.message || ''),
          status: Number(retryError?.status || 0) || null,
        });
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
        message: fetchError?.message || String(fetchError),
        name: fetchError?.name || null,
      });
      throw fetchError;
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
    emitTrace({
      stage: 'request_error_status',
      transport: 'fetch',
      url: resolvedUrl,
      method,
      status: response.status,
      message,
    });
    throw error;
  }

  emitTrace({
    stage: 'request_success',
    transport: response?.url && response.url !== url ? 'fetch_redirected' : 'fetch',
    url: resolvedUrl,
    method,
    status: response.status,
  });

  return data;
}

export async function fetchJson(path, options = {}) {
  return requestJson(buildApiUrl, path, {
    ...options,
    allowApiHostFallback: false,
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
