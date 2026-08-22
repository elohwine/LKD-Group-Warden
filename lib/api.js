function normalizeApiBase(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) return '';
  return trimmed;
}

const DEFAULT_API_BASE = normalizeApiBase(process.env.NEXT_PUBLIC_API_BASE_URL || '');
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

function toAlternateLdkHostUrl(url) {
  const current = String(url || '').trim();
  if (!current) return null;
  if (!/^https:\/\/(www\.)?ldkgroup\.co\.uk\b/i.test(current)) return null;
  if (/^https:\/\/www\.ldkgroup\.co\.uk\b/i.test(current)) {
    return current.replace(/^https:\/\/www\.ldkgroup\.co\.uk/i, 'https://ldkgroup.co.uk');
  }
  return current.replace(/^https:\/\/ldkgroup\.co\.uk/i, 'https://www.ldkgroup.co.uk');
}

function toRenderOriginUrl(url) {
  const current = String(url || '').trim();
  if (!current) return null;
  if (!/^https:\/\/(www\.)?ldkgroup\.co\.uk\b/i.test(current)) return null;
  return current.replace(/^https:\/\/(www\.)?ldkgroup\.co\.uk/i, 'https://ldk-group-ltd-website-react-p2ea.onrender.com');
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
  const { token, body, headers, timeoutMs = 0, signal, allowApiHostFallback = false, ...rest } = options;
  const url = urlBuilder(path);
  const method = String(rest.method || 'GET').toUpperCase();

  if (shouldUseNativeHttp(url) && !(body instanceof FormData)) {
    try {
      return await requestJsonViaNativeHttp(url, options);
    } catch (nativeError) {
      if (String(nativeError?.message || '') !== 'native_http_unavailable') {
        if (isTransientNetworkAbort(nativeError)) {
          try {
            await sleepMs(250);
            return await requestJsonViaNativeHttp(url, options);
          } catch (retryError) {
            nativeError = retryError;
          }
        }

        if (allowApiHostFallback) {
          const alternateUrl = toAlternateLdkHostUrl(url);
          const renderUrl = toRenderOriginUrl(url);
          if (alternateUrl && alternateUrl !== url) {
            try {
              return await requestJsonViaNativeHttp(alternateUrl, options);
            } catch (altError) {
              if (isTransientNetworkAbort(altError)) {
                try {
                  await sleepMs(250);
                  return await requestJsonViaNativeHttp(alternateUrl, options);
                } catch (altRetryError) {
                  nativeError = altRetryError;
                }
              } else {
                nativeError = altError;
              }
            }
          }

          if (renderUrl && renderUrl !== url && renderUrl !== alternateUrl) {
            try {
              return await requestJsonViaNativeHttp(renderUrl, options);
            } catch (renderError) {
              if (isTransientNetworkAbort(renderError)) {
                try {
                  await sleepMs(250);
                  return await requestJsonViaNativeHttp(renderUrl, options);
                } catch (renderRetryError) {
                  nativeError = renderRetryError;
                }
              } else {
                nativeError = renderError;
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
  let resolvedUrl = url;
  const requestInit = {
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
  };
  try {
    response = await fetch(resolvedUrl, requestInit);
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    if (error?.name === 'AbortError' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutError.status = 408;
      timeoutError.url = url;
      timeoutError.method = method;
      throw timeoutError;
    }

    if (isNativeApp() && isTransientNetworkAbort(error)) {
      try {
        await sleepMs(250);
        response = await fetch(resolvedUrl, requestInit);
      } catch (retryError) {
        error = retryError;
      }
    }

    if (response) {
      // Retry succeeded; continue processing response below.
    } else if (allowApiHostFallback) {
      const alternateUrl = toAlternateLdkHostUrl(url);
      const renderUrl = toRenderOriginUrl(url);
      if (alternateUrl && alternateUrl !== url) {
        try {
          console.warn('[api] primary host request failed, retrying alternate host', {
            method,
            primaryUrl: url,
            alternateUrl,
            error: error?.message || String(error),
          });

          resolvedUrl = alternateUrl;
          response = await fetch(resolvedUrl, requestInit);
        } catch (fallbackError) {
          if (isNativeApp() && isTransientNetworkAbort(fallbackError)) {
            try {
              await sleepMs(250);
              response = await fetch(resolvedUrl, requestInit);
            } catch (altRetryError) {
              fallbackError = altRetryError;
            }
          }

          if (!response) {
            if (timeoutId) clearTimeout(timeoutId);
            console.error('[api] alternate host request also failed', {
              method,
              primaryUrl: url,
              alternateUrl,
              message: fallbackError?.message || String(fallbackError),
              name: fallbackError?.name || null,
            });
            error = fallbackError;
          }
        }

        if (!response && renderUrl && renderUrl !== url && renderUrl !== alternateUrl) {
          try {
            resolvedUrl = renderUrl;
            response = await fetch(resolvedUrl, requestInit);
          } catch (renderError) {
            if (isNativeApp() && isTransientNetworkAbort(renderError)) {
              try {
                await sleepMs(250);
                response = await fetch(resolvedUrl, requestInit);
              } catch (renderRetryError) {
                renderError = renderRetryError;
              }
            }

            if (!response) {
              if (timeoutId) clearTimeout(timeoutId);
              console.error('[api] render-host request also failed', {
                method,
                primaryUrl: url,
                alternateUrl,
                renderUrl,
                message: renderError?.message || String(renderError),
                name: renderError?.name || null,
              });
              throw renderError;
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