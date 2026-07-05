import fs from 'fs';
import formidable from 'formidable';
import { getStorage } from 'firebase-admin/storage';
import '../../../../lib/firebase-admin.mjs';

export const config = {
  api: {
    bodyParser: false
  }
};

function normalizeVrm(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function uploadToStorage(file) {
  const bucketName = (process.env.FIREBASE_STORAGE_BUCKET || '').replace(/^gs:\/\//, '');
  if (!bucketName) {
    throw new Error('Storage bucket not configured');
  }

  const bucket = getStorage().bucket(bucketName);
  const folder = process.env.FIREBASE_STORAGE_WARDEN_FOLDER || 'warden_evidence';
  const safeName = String(file.originalFilename || 'evidence').replace(/[^A-Za-z0-9._-]/g, '_');
  const uploadPath = `${folder}/${Date.now()}-${safeName}`;

  await bucket.upload(file.filepath, {
    destination: uploadPath,
    metadata: {
      contentType: file.mimetype || 'application/octet-stream'
    }
  });

  const [url] = await bucket.file(uploadPath).getSignedUrl({
    action: 'read',
    expires: '01-01-2100'
  });

  return { url, path: uploadPath, filename: safeName };
}

async function tryExternalOcr(file, fields) {
  const endpoint = (process.env.WARDEN_ANPR_OCR_URL || process.env.ANPR_OCR_URL || '').trim();
  if (!endpoint) return null;

  const formData = new FormData();
  formData.append('file', new Blob([fs.readFileSync(file.filepath)], { type: file.mimetype || 'application/octet-stream' }), file.originalFilename || 'evidence.jpg');
  Object.entries(fields).forEach(([key, value]) => {
    if (typeof value !== 'undefined' && value !== null && value !== '') {
      formData.append(key, String(value));
    }
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    body: formData
  });
  if (!response.ok) {
    throw new Error(`OCR upstream failed (${response.status})`);
  }
  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const form = formidable({
      multiples: true,
      keepExtensions: true,
      maxFileSize: 10 * 1024 * 1024,
      filter: (part) => (part.mimetype || '').startsWith('image/')
    });

    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) reject(error);
        resolve([parsedFields, parsedFiles]);
      });
    });

    const fileList = [];
    for (const value of Object.values(files)) {
      if (Array.isArray(value)) fileList.push(...value);
      else if (value) fileList.push(value);
    }

    if (fileList.length === 0) {
      return res.status(400).json({ error: 'No image file uploaded' });
    }

    const uploads = [];
    for (const file of fileList) {
      if (file.size > 10 * 1024 * 1024) {
        try { if (file.filepath) fs.unlinkSync(file.filepath); } catch (_) {}
        return res.status(400).json({ error: 'File exceeds 10MB limit' });
      }
      uploads.push(await uploadToStorage(file));
      try { if (file.filepath) fs.unlinkSync(file.filepath); } catch (_) {}
    }

    let vrm = normalizeVrm(fields.manualVrm || fields.vrm || '');
    let ocr = null;
    try {
      ocr = await tryExternalOcr(fileList[0], fields);
    } catch (ocrError) {
      console.warn('[warden/uploadevidence] OCR upstream failed', ocrError?.message || ocrError);
    }

    if (!vrm) {
      vrm = normalizeVrm(ocr?.vrm || ocr?.readVrm || ocr?.plate || '');
    }

    return res.status(200).json({
      ok: true,
      vrm,
      confidence: ocr?.confidence || null,
      images: uploads,
      ocr
    });
  } catch (error) {
    console.error('[warden/uploadevidence] error', error);
    return res.status(500).json({ error: 'Failed to upload evidence' });
  }
}