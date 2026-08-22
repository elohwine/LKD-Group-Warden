import { getStorage } from 'firebase-admin/storage';
import formidable from 'formidable';
import fs from 'fs';
import { adminAuth } from '../../../lib/firebase-admin.mjs';

export const config = {
  api: {
    bodyParser: false,
  },
};

const MAX_UPLOAD_FILE_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 150 * 1024 * 1024;
const ALLOWED_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp', 'tif', 'tiff']);

function sanitizeUploadName(name, fallback = 'upload') {
  return String(name || fallback).replace(/[^A-Za-z0-9._-]/g, '_');
}

function getFileExtension(filename) {
  const base = String(filename || '').trim();
  const idx = base.lastIndexOf('.');
  if (idx < 0 || idx === base.length - 1) return '';
  return base.slice(idx + 1).toLowerCase();
}

function resolveContentType(file) {
  const mime = String(file?.mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return mime;
  const ext = getFileExtension(file?.originalFilename || file?.newFilename);
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    gif: 'image/gif',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
  };
  return map[ext] || 'application/octet-stream';
}

function normalizeVrm(vrmValue) {
  if (!vrmValue) return null;
  const normalized = String(vrmValue)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
  if (!/^[A-Z0-9]{2,10}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export async function createSignedUploadUrl({
  folderName = 'warden_evidence',
  fileName = 'upload',
  contentType = 'application/octet-stream',
} = {}) {
  const bucketName = (process.env.FIREBASE_STORAGE_BUCKET || '').replace(/^gs:\/\//, '');
  if (!bucketName) {
    throw new Error('Storage bucket not configured');
  }

  const bucket = getStorage().bucket(bucketName);
  const safeName = sanitizeUploadName(fileName, 'upload').slice(0, 100);
  const destination = `${String(folderName || 'warden_evidence').replace(/^\/+|\/+$/g, '')}/${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${safeName}`;

  const [url] = await bucket.file(destination).getSignedUrl({
    action: 'write',
    expires: '01-01-2100',
    contentType,
  });

  return {
    url,
    path: destination,
    filename: safeName,
    mode: 'signed-upload',
  };
}

/**
 * POST /api/warden/uploadevidence
 * Upload one or more images from a warden with optional manual VRM.
 * Returns array of signed URLs and normalized VRM.
 *
 * Headers:
 *   Authorization: Bearer <id-token>
 *   Content-Type: multipart/form-data
 *
 * Form fields:
 *   file: Image file(s) (multipart)
 *   siteId: Optional site identifier
 *   manualVrm: Optional manually-entered VRM for ANPR override
 *
 * Response:
 *   200 { vrm: string|null, images: [url, ...] }
 *   400 { error: "...", details?: [...] }
 *   401 { error: "Unauthorized" }
 *   405 { error: "Method not allowed" }
 *   500 { error: "..." }
 */
export default async function handler(req, res) {
  const signedUploadRequest =
    req.method === 'GET' && String(req.query?.mode || '').toLowerCase() === 'signed-upload'
    || req.method === 'POST' && typeof req.body === 'object' && String(req.body?.mode || '').toLowerCase() === 'signed-upload';

  if (req.method !== 'POST' && !signedUploadRequest) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ───── AUTH ─────
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      console.warn('[uploadevidence] Missing or invalid Bearer token');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let decoded;
    try {
      const token = authHeader.slice('Bearer '.length).trim();
      decoded = await adminAuth.verifyIdToken(token);
    } catch (authErr) {
      console.warn('[uploadevidence] Token verification failed:', authErr?.message);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const wardenId = decoded.uid;
    console.log(`[uploadevidence] Authenticated warden: ${wardenId}`);

    if (signedUploadRequest) {
      const folderSegment = String(req.query?.folder || req.body?.folder || 'warden_evidence').replace(/^\/+|\/+$/g, '');
      const fileName = String(req.query?.filename || req.body?.filename || 'upload');
      const contentType = String(req.query?.contentType || req.body?.contentType || 'image/jpeg');

      try {
        const result = await createSignedUploadUrl({
          folderName: folderSegment,
          fileName,
          contentType,
        });
        return res.status(200).json(result);
      } catch (error) {
        console.error('[uploadevidence] signed upload URL generation failed:', error?.message || error);
        return res.status(500).json({ error: error?.message || 'Failed to generate signed upload URL' });
      }
    }

    // ───── PARSE MULTIPART ─────
    const form = formidable({
      multiples: true,
      keepExtensions: true,
      maxFileSize: MAX_UPLOAD_FILE_BYTES,
      maxTotalFileSize: MAX_UPLOAD_TOTAL_BYTES,
      filter: (part) => {
        // Some devices send weak/blank MIME metadata.
        // Accept named file parts here; validate extension/type after parse.
        const hasFilename = Boolean(part?.originalFilename);
        if (!hasFilename) {
          console.warn('[uploadevidence] Rejected unnamed multipart part');
          return false;
        }
        return true;
      },
    });

    let fields;
    let files;
    try {
      [fields, files] = await new Promise((resolve, reject) => {
        form.parse(req, (err, parsedFields, parsedFiles) => {
          if (err) {
            console.error('[uploadevidence] Formidable parse error:', err?.message);
            reject(err);
            return;
          }
          resolve([parsedFields, parsedFiles]);
        });
      });
    } catch (parseErr) {
      const parseMessage = String(parseErr?.message || '').toLowerCase();
      const isTooLarge =
        Number(parseErr?.httpCode) === 413 ||
        Number(parseErr?.code) === 1009 ||
        parseMessage.includes('maxtotalfilesize') ||
        parseMessage.includes('maxfilesize') ||
        parseMessage.includes('too large');

      if (isTooLarge) {
        return res.status(400).json({
          error: `Evidence upload too large. Each image must be <= ${Math.floor(MAX_UPLOAD_FILE_BYTES / (1024 * 1024))}MB.`,
        });
      }
      throw parseErr;
    }

    // ───── VALIDATE FILES ─────
    let fileArray = files.file || [];
    if (!Array.isArray(fileArray)) {
      fileArray = fileArray ? [fileArray] : [];
    }

    if (fileArray.length === 0) {
      console.warn('[uploadevidence] No image files uploaded');
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const validFileArray = fileArray.filter((file) => {
      if (!file?.filepath) return false;

      const extension = getFileExtension(file.originalFilename || file.newFilename || '');
      const mimeIsImage = String(file.mimetype || '').toLowerCase().startsWith('image/');
      if (!mimeIsImage && !ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
        return false;
      }

      if (!file.size || Number(file.size) <= 0) {
        return false;
      }

      return file.size <= MAX_UPLOAD_FILE_BYTES;
    });

    if (validFileArray.length === 0) {
      fileArray.forEach((file) => {
        try {
          if (file?.filepath) fs.unlinkSync(file.filepath);
        } catch (_) {}
      });
      console.warn('[uploadevidence] No files within size limits');
      return res.status(400).json({
        error: 'No valid image files uploaded (allowed: jpg, jpeg, png, webp, heic, heif, gif, bmp, tif, tiff; max 15MB each)',
      });
    }

    // ───── PREPARE STORAGE ─────
    let bucketName = (process.env.FIREBASE_STORAGE_BUCKET || '').replace(/^gs:\/\//, '');
    if (!bucketName) {
      console.error('[uploadevidence] FIREBASE_STORAGE_BUCKET not configured');
      return res.status(500).json({ error: 'Storage bucket not configured' });
    }

    const bucket = getStorage().bucket(bucketName);
    const uploadedUrls = [];
    const siteId = Array.isArray(fields.siteId)
      ? fields.siteId[0]
      : fields.siteId || 'unknown';

    // ───── NORMALIZE VRM ─────
    const manualVrm = normalizeVrm(Array.isArray(fields.manualVrm) ? fields.manualVrm[0] : fields.manualVrm);

    // ───── UPLOAD FILES ─────
    for (const file of validFileArray) {
      if (!file || !file.filepath) {
        console.warn('[uploadevidence] Skipping file with missing filepath');
        continue;
      }

      try {
        const safeName = String(file.originalFilename || 'image')
          .replace(/[^A-Za-z0-9._-]/g, '_')
          .slice(0, 100);
        const uploadPath = `warden_evidence/${wardenId}/${siteId}/${Date.now()}-${Math.random().toString(36).substring(2, 8)}-${safeName}`;

        console.log(`[uploadevidence] Uploading: ${uploadPath}`);

        await bucket.upload(file.filepath, {
          destination: uploadPath,
          metadata: {
            contentType: resolveContentType(file),
            metadata: {
              wardenId,
              siteId,
              uploadedAt: new Date().toISOString(),
            },
          },
        });

        // Get signed URL (7 days expiration for processing)
        const [url] = await bucket.file(uploadPath).getSignedUrl({
          action: 'read',
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        });

        uploadedUrls.push(url);
        console.log(`[uploadevidence] Upload successful: ${uploadPath}`);
      } catch (uploadErr) {
        console.error(
          `[uploadevidence] Upload failed for ${file.originalFilename}:`,
          uploadErr?.message
        );
        // Non-fatal: continue with other files
      } finally {
        // Clean up temp file
        try {
          if (file.filepath) fs.unlinkSync(file.filepath);
        } catch (_) {}
      }
    }

    // ───── RESPONSE ─────
    if (uploadedUrls.length === 0) {
      console.warn('[uploadevidence] No files successfully uploaded');
      return res.status(400).json({ error: 'No files uploaded successfully' });
    }

    console.log(
      `[uploadevidence] Success: ${uploadedUrls.length} file(s) uploaded, VRM=${manualVrm || 'none'}`
    );

    return res.status(200).json({
      vrm: manualVrm,
      images: uploadedUrls,
    });
  } catch (error) {
    console.error('[uploadevidence] Unhandled error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to upload evidence' });
  }
}
