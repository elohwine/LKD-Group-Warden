import { getStorage } from 'firebase-admin/storage';
import formidable from 'formidable';
import fs from 'fs';
import { adminAuth } from '../../../lib/firebase-admin.mjs';

export const config = {
  api: {
    bodyParser: false,
  },
};

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
  if (req.method !== 'POST') {
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

    // ───── PARSE MULTIPART ─────
    const form = formidable({
      multiples: true,
      keepExtensions: true,
      maxFileSize: 5 * 1024 * 1024, // 5MB per file
      filter: (part) => {
        const isImage = (part.mimetype || '').startsWith('image/');
        if (!isImage) {
          console.warn(
            `[uploadevidence] Rejected non-image part: ${part.originalFilename} (${part.mimetype})`
          );
        }
        return isImage;
      },
    });

    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) {
          console.error('[uploadevidence] Formidable parse error:', err?.message);
          reject(err);
        }
        resolve([fields, files]);
      });
    });

    // ───── VALIDATE FILES ─────
    let fileArray = files.file || [];
    if (!Array.isArray(fileArray)) {
      fileArray = fileArray ? [fileArray] : [];
    }

    if (fileArray.length === 0) {
      console.warn('[uploadevidence] No image files uploaded');
      return res.status(400).json({ error: 'No files uploaded' });
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
    let manualVrm = Array.isArray(fields.manualVrm) ? fields.manualVrm[0] : fields.manualVrm;
    if (manualVrm) {
      manualVrm = String(manualVrm)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 10);
      if (!/^[A-Z0-9]{2,10}$/.test(manualVrm)) {
        manualVrm = null; // Invalid format, ignore
      }
    }

    // ───── UPLOAD FILES ─────
    for (const file of fileArray) {
      if (!file || !file.filepath) {
        console.warn('[uploadevidence] Skipping file with missing filepath');
        continue;
      }

      // Final size check (formidable may have passed it during upload)
      if (file.size > 5 * 1024 * 1024) {
        console.warn(
          `[uploadevidence] File ${file.originalFilename} exceeds 5MB (${file.size} bytes)`
        );
        try {
          fs.unlinkSync(file.filepath);
        } catch (_) {}
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
            contentType: file.mimetype || 'application/octet-stream',
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
