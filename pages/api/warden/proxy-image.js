import { adminAuth } from '../../../lib/firebase-admin.mjs';
import { getStorage } from 'firebase-admin/storage';

const PROXY_TIMEOUT_MS = 20000;

function isAllowedImageHost(hostname = '') {
  const host = String(hostname || '').toLowerCase().trim();
  if (!host) return false;

  return host === 'camera.ldkgroup.co.uk'
    || host.endsWith('.ldkgroup.co.uk')
    || host === 'ldk-group-camera-service.onrender.com'
    || host === 'ldkgroup.co.uk'
    || host === 'www.ldkgroup.co.uk'
    || host === 'firebasestorage.googleapis.com'
    || host === 'firebasestorage.app'
    || host === 'firebasestorage.googleapis.com'
    || host === 'storage.googleapis.com'
    || host.endsWith('.firebasestorage.googleapis.com')
    || host.endsWith('.firebasestorage.app')
    || host.endsWith('.storage.googleapis.com');
}

function decodeStoragePath(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function parseGoogleStorageTarget(url) {
  const host = String(url?.hostname || '').toLowerCase();
  const path = String(url?.pathname || '').replace(/^\/+/, '');
  if (!host) return null;

  // https://<bucket>.storage.googleapis.com/<object>
  if (host.endsWith('.storage.googleapis.com')) {
    const bucket = decodeStoragePath(host.replace(/\.storage\.googleapis\.com$/i, ''));
    const objectPath = decodeStoragePath(path);
    if (bucket && objectPath) return { bucket, objectPath };
  }

  if (!path) return null;

  // https://storage.googleapis.com/<bucket>/<object>
  if (host === 'storage.googleapis.com') {
    const [bucket, ...rest] = path.split('/');
    const objectPath = decodeStoragePath(rest.join('/'));
    if (bucket && objectPath) return { bucket, objectPath };
    return null;
  }

  // https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<object>
  if (host === 'firebasestorage.googleapis.com') {
    const match = /^v0\/b\/([^/]+)\/o\/(.+)$/i.exec(path);
    if (!match) return null;
    const bucket = decodeStoragePath(match[1]);
    const objectPath = decodeStoragePath(match[2]);
    if (bucket && objectPath) return { bucket, objectPath };
    return null;
  }

  return null;
}

function expandBucketCandidates(bucket = '') {
  const safeBucket = String(bucket || '').trim();
  if (!safeBucket) return [];

  const candidates = new Set([safeBucket]);
  if (safeBucket.endsWith('.firebasestorage.app')) {
    candidates.add(safeBucket.replace(/\.firebasestorage\.app$/i, '.appspot.com'));
  }
  if (safeBucket.endsWith('.appspot.com')) {
    candidates.add(safeBucket.replace(/\.appspot\.com$/i, '.firebasestorage.app'));
  }

  return Array.from(candidates);
}

async function streamFromAdminStorage(target, res) {
  const parsed = parseGoogleStorageTarget(target);
  if (!parsed) return false;

  try {
    const storage = getStorage();
    const buckets = expandBucketCandidates(parsed.bucket);
    for (let i = 0; i < buckets.length; i += 1) {
      const bucketName = buckets[i];
      const file = storage.bucket(bucketName).file(parsed.objectPath);
      const [exists] = await file.exists().catch(() => [false]);
      if (!exists) continue;

      const [buffer] = await file.download();
      const [metadata] = await file.getMetadata().catch(() => [{}]);
      const contentType = String(metadata?.contentType || 'image/jpeg').trim() || 'image/jpeg';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader('Content-Length', String(buffer.length));
      res.status(200).send(buffer);
      return true;
    }

    return false;
  } catch (_) {
    return false;
  }
}

function parseTargetUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return null;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (!isAllowedImageHost(parsed.hostname)) return null;
  return parsed;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const token = authHeader.slice('Bearer '.length).trim();
    await adminAuth.verifyIdToken(token);
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const target = parseTargetUrl(req.query?.url);
  if (!target) {
    return res.status(400).json({ error: 'Invalid image URL' });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(target.toString(), {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) {
        const streamed = await streamFromAdminStorage(target, res);
        if (streamed) return;
      }
      return res.status(response.status).json({ error: `Image fetch failed (${response.status})` });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = String(response.headers.get('content-type') || 'image/jpeg').trim() || 'image/jpeg';
    const cacheControl = String(response.headers.get('cache-control') || 'private, max-age=60').trim();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Content-Length', String(buffer.length));
    res.status(200).send(buffer);
  } catch (error) {
    clearTimeout(timeoutId);
    const streamed = await streamFromAdminStorage(target, res);
    if (streamed) return;
    if (error?.name === 'AbortError') {
      return res.status(504).json({ error: 'Image fetch timed out' });
    }
    return res.status(502).json({ error: 'Image proxy failed' });
  }
}
