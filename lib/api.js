const DEFAULT_API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_WARDEN_API_BASE_URL || '').replace(/\/$/, '');

export function buildApiUrl(path) {
  if (!path) return DEFAULT_API_BASE || '';
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (DEFAULT_API_BASE) return `${DEFAULT_API_BASE}${normalizedPath}`;
  if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
    return `${window.location.origin}${normalizedPath}`;
  }
  throw new Error('API base URL is not configured. Set NEXT_PUBLIC_API_BASE_URL for the exported mobile app.');
}

export async function fetchJson(path, options = {}) {
  const { token, body, headers, ...rest } = options;
  const requestHeaders = new Headers(headers || {});
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  if (body && !(body instanceof FormData)) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(buildApiUrl(path), {
    ...rest,
    headers: requestHeaders,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof data === 'string' ? data : data?.error || data?.message || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}