import { adminAuth } from '../../lib/firebase-admin.mjs';
import crypto from 'crypto';

function normalizeVrm(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

function resolveBackendBase() {
  const candidates = [
    process.env.NEXT_PUBLIC_API_BASE_URL,
    process.env.NEXT_PUBLIC_WARDEN_API_BASE_URL,
    process.env.BACKEND_BASE_URL,
  ].filter(Boolean);

  const selected = String(candidates[0] || 'https://www.ldkgroup.co.uk').replace(/\/$/, '');
  return selected;
}

function resolveCarcheckPath() {
  const raw = String(process.env.CARCHECK_PATH || '/api/carcheck').trim();
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function isLocalRequest(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  return host.includes('localhost') || host.includes('127.0.0.1') || host.includes('0.0.0.0');
}

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let cachedGoogleCerts = null;
let cachedGoogleCertsAt = 0;

function base64UrlToBuffer(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  const padded = normalized + (padding ? '='.repeat(4 - padding) : '');
  return Buffer.from(padded, 'base64');
}

function decodeJwtPart(part) {
  return JSON.parse(base64UrlToBuffer(part).toString('utf8'));
}

async function getGoogleCerts() {
  const now = Date.now();
  if (cachedGoogleCerts && now - cachedGoogleCertsAt < 60 * 60 * 1000) {
    return cachedGoogleCerts;
  }

  const response = await fetch(GOOGLE_CERTS_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    return null;
  }

  cachedGoogleCerts = await response.json();
  cachedGoogleCertsAt = now;
  return cachedGoogleCerts;
}

async function verifyTokenLocally(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) {
    return false;
  }

  const configuredProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_ADMIN_PROJECT_ID;

  try {
    const header = decodeJwtPart(parts[0]);
    const payload = decodeJwtPart(parts[1]);
    const tokenProjectId = String(payload?.aud || '').trim();
    const projectId = String(configuredProjectId || tokenProjectId).trim();
    if (!projectId) return false;
    if (payload.aud !== projectId) return false;
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return false;

    const certs = await getGoogleCerts();
    const cert = certs?.[header.kid];
    if (!cert) return false;

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    return verifier.verify(cert, base64UrlToBuffer(parts[2]));
  } catch {
    return false;
  }
}

async function verifyBearer(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return false;

  try {
    if (adminAuth) {
      await adminAuth.verifyIdToken(token);
      return true;
    }

    const locallyVerified = await verifyTokenLocally(token);
    if (locallyVerified) return true;

    // In local proxy mode, forward the bearer upstream and let upstream auth decide.
    if (isLocalRequest(req)) return true;
    return false;
  } catch {
    if (isLocalRequest(req)) return true;
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authorized = await verifyBearer(req);
  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    let body = {};
    if (typeof req.body === 'string') {
      const trimmed = req.body.trim();
      body = trimmed ? JSON.parse(trimmed) : {};
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }
    const vrm = normalizeVrm(req.query?.vrm || req.query?.searchTerm || body?.vrm || body?.searchTerm || '');

    if (!vrm) {
      return res.status(400).json({ error: 'Missing vrm' });
    }

    const backendBase = resolveBackendBase();
    const path = resolveCarcheckPath();
    const headers = { Accept: 'application/json' };
    if (req.headers.authorization) {
      headers.Authorization = req.headers.authorization;
    }

    const upstreamUrl = `${backendBase}${path}?vrm=${encodeURIComponent(vrm)}`;
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers,
    });

    const text = await upstream.text().catch(() => '');

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: 'Upstream error',
        details: text,
        path,
      });
    }

    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return res.status(502).json({
        error: 'Vehicle lookup returned non-JSON response',
        details: text || `Upstream lookup failed with status ${upstream.status}`,
        path,
      });
    }

    if (!text.trim()) {
      return res.status(502).json({
        error: 'Vehicle lookup returned empty response',
        details: `Upstream status ${upstream.status}`,
        path,
      });
    }

    try {
      const data = JSON.parse(text);
      return res.status(200).json(data);
    } catch {
      return res.status(502).json({
        error: 'Vehicle lookup returned invalid JSON',
        details: text,
        path,
      });
    }
  } catch (error) {
    console.error('[carcheck] Error:', error);
    return res.status(500).json({ error: 'Lookup failed' });
  }
}