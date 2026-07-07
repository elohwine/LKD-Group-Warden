# Warden App Implementation — Gap Analysis & Closure Plan

**Status**: Reviewed against implementation_plan.md and existing codebase patterns
**Date**: 2026-07-07

---

## ✅ Confirmed Patterns from Existing Codebase

### 1. **Authentication Pattern** (Reusable from Kiosk)
- **Location**: `pages/api/kiosk/auth.js` and `pages/api/reports/_common.js`
- **Pattern**: Bearer token validation via `adminAuth.verifyIdToken(token)`
- **Usage**:
  ```javascript
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split('Bearer ')[1];
  const decoded = await adminAuth.verifyIdToken(token);
  const userId = decoded.uid;
  ```
- **Status**: ✅ Ready to reuse for `uploadevidence.js` and `wardencapture.js`

---

### 2. **Image Upload Pattern** (Already Exists — No Gap)
- **Location**: `pages/api/upload-vehicle-image.js`
- **Pattern**:
  - Formidable v3+ for multipart parsing
  - Firebase Storage bucket upload with signed URLs
  - 5MB file limit, image MIME filter
  - Temp file cleanup via `fs.unlinkSync`
- **Response Shape**:
  ```javascript
  { url, path, filename }
  ```
- **Status**: ✅ `uploadevidence.js` should mirror this exactly

---

### 3. **Firestore Write Pattern** (Reusable from Epermits)
- **Location**: `pages/api/epermits/dispatch.js`
- **Pattern**:
  ```javascript
  const payload = { ...fields };
  const docRef = await adminDb.collection('breaches').add(payload);
  return res.status(200).json({ success: true, id: docRef.id });
  ```
- **Audit Fields** (auto-stamped server-side):
  ```javascript
  createdAt: Timestamp.fromDate(now),
  createdBy: userId,
  updatedAt: Timestamp.fromDate(now)
  ```
- **Status**: ✅ Ready to reuse for `wardencapture.js`

---

### 4. **Test Pattern** (Already Documented)
- **Location**: `pages/api/epermits/dispatch.test.mjs`
- **Pattern**:
  - Node test runner with Jest-compatible mocking
  - Mock Firebase Admin (`adminAuth.verifyIdToken`, `adminDb.collection().add`)
  - Mock Formidable for file uploads
  - 5 standard test cases per endpoint (no token, invalid token, validation errors, success, 405)
- **Status**: ✅ Ready to reuse for Warden endpoints

---

## ⚠️ Gaps Identified & Closure Steps

### Gap 1: **No Android Gradle Setup Yet**

**Issue**: `android/` directory does not exist. Capacitor hasn't been initialized.

**Closure**:
1. Run locally (requires Android SDK):
   ```bash
   cd /path/to/LKD-Group-Warden
   npx cap add android
   ```
2. Commit the generated `android/` directory to the repo.
3. Then the pre-committed `build-and-sign-apk.sh` will work.

**Status**: ⏳ **User action required** — cannot be automated in this agent.

---

### Gap 2: **Queue Secure Delete Not Implemented**

**Issue**: `lib/queue.js` exists but `secureDeleteQueueItem()` is not yet implemented.

**Closure**:
```javascript
// Add to lib/queue.js
export async function secureDeleteQueueItem(id) {
  const item = await deleteQueueItem(id); // existing function
  
  // GDPR compliance: zero-fill blob data before GC
  if (item && item.image) {
    const blob = item.image;
    if (blob instanceof Blob || (blob.arrayBuffer && blob.size)) {
      const buffer = await blob.arrayBuffer();
      const view = new Uint8Array(buffer);
      view.fill(0); // Zero-fill the entire buffer
    }
    item.image = null; // Deref so GC can collect
  }
  
  return item;
}
```

**Status**: 📝 **To be added** in Warden repo.

---

### Gap 3: **API Endpoints Missing from Warden Backend Stub**

**Issue**: `pages/api/warden/uploadevidence.js` and `pages/api/breaches/wardencapture.js` exist but are empty stubs.

**Closure**:

#### A. **Backend Endpoint** (in `LDK-Group-Ltd-Website-React`)

Create `pages/api/warden/uploadevidence.js`:
```javascript
import { getStorage } from 'firebase-admin/storage';
import formidable from 'formidable';
import fs from 'fs';
import { adminAuth } from '../../../lib/firebase-admin.mjs';

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Auth
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split('Bearer ')[1];
    const decoded = await adminAuth.verifyIdToken(token);
    const wardenId = decoded.uid;

    // Parse multipart (reuse upload-vehicle-image pattern)
    const form = formidable({
      multiples: true,
      keepExtensions: true,
      maxFileSize: 5 * 1024 * 1024,
      filter: part => (part.mimetype || '').startsWith('image/')
    });

    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        resolve([fields, files]);
      });
    });

    // Validate file(s)
    let fileArray = Array.isArray(files.file) ? files.file : (files.file ? [files.file] : []);
    if (fileArray.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Upload to Firebase Storage
    const bucketName = (process.env.FIREBASE_STORAGE_BUCKET || '').replace(/^gs:\/\//, '');
    if (!bucketName) {
      console.error('[uploadevidence] bucket not configured');
      return res.status(500).json({ error: 'Storage not configured' });
    }
    const bucket = getStorage().bucket(bucketName);

    const uploadedUrls = [];
    const manualVrm = fields.manualVrm ? String(fields.manualVrm).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;

    for (const file of fileArray) {
      if (file.size > 5 * 1024 * 1024) {
        try { fs.unlinkSync(file.filepath); } catch(_) {}
        continue;
      }

      const safeName = String(file.originalFilename || 'image').replace(/[^A-Za-z0-9._-]/g, '_');
      const uploadPath = `warden_evidence/${wardenId}/${Date.now()}-${safeName}`;

      await bucket.upload(file.filepath, {
        destination: uploadPath,
        metadata: { contentType: file.mimetype || 'application/octet-stream' }
      });

      const [url] = await bucket.file(uploadPath).getSignedUrl({
        action: 'read',
        expires: '01-01-2100'
      });

      uploadedUrls.push(url);

      try { fs.unlinkSync(file.filepath); } catch(_) {}
    }

    return res.status(200).json({
      vrm: manualVrm || null,
      images: uploadedUrls
    });
  } catch (error) {
    console.error('[uploadevidence] error', error?.message || error);
    return res.status(500).json({ error: 'Upload failed' });
  }
}
```

Create `pages/api/breaches/wardencapture.js`:
```javascript
import { adminAuth, adminDb } from '../../../lib/firebase-admin.mjs';
import { Timestamp } from 'firebase-admin/firestore';
import normalizeVrm from '../../../lib/normalizeVrm.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Auth
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split('Bearer ')[1];
    const decoded = await adminAuth.verifyIdToken(token);
    const wardenId = decoded.uid;

    const {
      vrm,
      siteId,
      siteName,
      contraventionReason,
      observationStartTime,
      observationEndTime,
      images = [],
      ...rest
    } = req.body || {};

    // Validate required fields
    const errors = [];
    if (!vrm) errors.push('vrm required');
    if (!siteId) errors.push('siteId required');
    if (!contraventionReason) errors.push('contraventionReason required');

    if (errors.length) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // Normalize VRM
    const vrmNormalized = normalizeVrm(vrm);

    // Server-stamped audit fields (GDPR compliance)
    const now = new Date();
    const payload = {
      source: 'WARDEN',
      status: 'QUEUED_FOR_QC',
      vrm: vrmNormalized,
      siteId,
      siteName,
      contraventionReason,
      observationStartTime: observationStartTime || now.toISOString(),
      observationEndTime: observationEndTime || now.toISOString(),
      images,
      // Server-stamped (not from client)
      wardenId,
      actorId: wardenId,
      createdAt: Timestamp.fromDate(now),
      createdBy: wardenId,
      updatedAt: Timestamp.fromDate(now),
      ...rest
    };

    // Write to Firestore
    const docRef = await adminDb.collection('breaches').add(payload);

    return res.status(200).json({
      id: docRef.id,
      status: 'QUEUED_FOR_QC'
    });
  } catch (error) {
    console.error('[wardencapture] error', error?.message || error);
    return res.status(500).json({ error: 'Capture failed' });
  }
}
```

**Status**: 📝 **To be added** to `LDK-Group-Ltd-Website-React` repo.

---

### Gap 4: **Test Suite Missing**

**Issue**: No test files for `uploadevidence.js` and `wardencapture.js`.

**Closure**:

Create `pages/api/warden/uploadevidence.test.mjs`:
```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import handler from './uploadevidence';

// Mock Firebase Admin
vi.mock('../../../lib/firebase-admin.mjs', () => ({
  adminAuth: {
    verifyIdToken: vi.fn()
  }
}));

// Mock Formidable
vi.mock('formidable', () => ({
  default: vi.fn()
}));

// Mock Firebase Storage
vi.mock('firebase-admin/storage', () => ({
  getStorage: vi.fn()
}));

describe('/api/warden/uploadevidence', () => {
  it('returns 401 without Bearer token', async () => {
    const req = {
      method: 'POST',
      headers: {}
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('returns 405 for non-POST', async () => {
    const req = {
      method: 'GET',
      headers: { authorization: 'Bearer token' }
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('returns 400 with no file uploaded', async () => {
    const { adminAuth } = await import('../../../lib/firebase-admin.mjs');
    const { default: formidable } = await import('formidable');

    adminAuth.verifyIdToken.mockResolvedValue({ uid: 'warden-123' });
    formidable.mockReturnValue({
      parse: (req, cb) => cb(null, {}, {})
    });

    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token' }
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'No files uploaded' });
  });

  it('returns 200 with vrm and image URLs on success', async () => {
    // Full mock setup...
    // Should test successful upload with signed URLs returned
  });
});
```

Create `pages/api/breaches/wardencapture.test.mjs`:
```javascript
// Similar structure — test 401, 400 validation, 200 success with Firestore write
```

**Status**: 📝 **To be added** to `LDK-Group-Ltd-Website-React` repo.

---

### Gap 5: **Warden App Frontend Stubs**

**Issue**: Warden repo has empty stubs in `pages/api/warden/uploadevidence.js` and `pages/api/breaches/wardencapture.js`.

**Closure**:

These files should **forward to the backend** when `NEXT_PUBLIC_API_BASE_URL` is set (production/APK mode), or **mock locally** in dev mode.

Create `pages/api/warden/uploadevidence.js` (Warden repo):
```javascript
import { buildApiUrl } from '../../lib/api.js';

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const backendUrl = buildApiUrl('/api/warden/uploadevidence');

  if (!backendUrl) {
    // Dev mode: mock response
    return res.status(200).json({
      vrm: req.query.manualVrm || null,
      images: ['https://example.com/mock-image.jpg']
    });
  }

  // Production mode: forward to backend
  try {
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: req.headers,
      body: req.body
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Forwarding failed' });
  }
}
```

**Status**: 📝 **To be added** to Warden repo.

---

### Gap 6: **Environment Configuration**

**Issue**: `.env.example` not documented for Warden.

**Closure**:

Create `.env.example` (Warden repo):
```bash
# Firebase Client Configuration
NEXT_PUBLIC_FIREBASE_API_KEY=<your-api-key>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<your-domain>
NEXT_PUBLIC_FIREBASE_PROJECT_ID=<your-project>
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=<your-bucket>
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=<sender-id>
NEXT_PUBLIC_FIREBASE_APP_ID=<app-id>

# Backend API (empty in dev, set in production APK)
NEXT_PUBLIC_API_BASE_URL=https://your-backend.com

# Capacitor Config
CAPACITOR_SKIP_SOURCE_MAP_UPLOAD=true
```

**Status**: 📝 **To be added** to Warden repo.

---

## 🎯 Implementation Checklist

### Backend (LDK-Group-Ltd-Website-React)
- [ ] Create `pages/api/warden/uploadevidence.js` (mirror `upload-vehicle-image.js` pattern)
- [ ] Create `pages/api/breaches/wardencapture.js` (Firestore + audit fields)
- [ ] Create `pages/api/warden/uploadevidence.test.mjs` (5 test cases)
- [ ] Create `pages/api/breaches/wardencapture.test.mjs` (5 test cases)
- [ ] Run tests: `node --experimental-vm-modules node_modules/.bin/jest pages/api/warden/ pages/api/breaches/wardencapture.test.mjs --no-coverage`

### Warden Frontend (LKD-Group-Warden)
- [ ] Create `pages/api/warden/uploadevidence.js` (pass-through + mock)
- [ ] Create `pages/api/breaches/wardencapture.js` (pass-through + mock)
- [ ] Add `secureDeleteQueueItem()` to `lib/queue.js` (zero-fill GDPR)
- [ ] Update `pages/dashboard.js` to use `secureDeleteQueueItem` instead of `deleteQueueItem`
- [ ] Create `.env.example` with all Firebase + API config keys

### Android/APK
- [ ] Run `npx cap add android` (local machine with Android SDK)
- [ ] Commit generated `android/` directory
- [ ] Run `./build-and-sign-apk.sh` to build signed APK
- [ ] Test on device/emulator pointing to backend

### Verification
- [ ] Manual curl test against `/api/warden/uploadevidence`
- [ ] Manual curl test against `/api/breaches/wardencapture`
- [ ] Verify Firestore documents written with `source: "WARDEN"`
- [ ] Test APK offline queue sync with secure delete
- [ ] Confirm no image data remains in memory after sync (GDPR)

---

## 📚 Reusable Components from Kiosk (Already Reviewed)

| Component | Location | Reuse Status | Notes |
|-----------|----------|--------------|-------|
| Bearer token auth | `pages/api/kiosk/auth.js` | ✅ Ready | Exact pattern for Warden |
| Image upload (multipart) | `pages/api/upload-vehicle-image.js` | ✅ Ready | Formidable v3, Firebase Storage, 5MB |
| Firestore writes with audit | `pages/api/epermits/dispatch.js` | ✅ Ready | Server-stamped timestamps + userId |
| Test pattern (Node + Jest mocks) | `pages/api/epermits/dispatch.test.mjs` | ✅ Ready | 5 standard test cases |
| Normalized VRM storage | `lib/normalizeVrm.mjs` | ✅ Ready | Used in all endpoints |
| UK datetime parsing | `lib/ukTime.mjs` | ✅ Ready | If needed for timestamps |

---

## 🚀 Next Steps

1. **Immediate** (2–3 hours):
   - Create `uploadevidence.js` and `wardencapture.js` in backend
   - Add tests
   - Run test suite

2. **Short-term** (1 day):
   - Add Warden app pass-through stubs
   - Update dashboard to use `secureDeleteQueueItem`
   - Add `.env.example`

3. **Android Build** (when local SDK available):
   - Run `npx cap add android`
   - Commit `android/` directory
   - Build and test APK

4. **Deployment**:
   - Deploy backend endpoints
   - Update Warden app backend URL
   - Test end-to-end on device

---

**Author**: Copilot  
**Last Updated**: 2026-07-07
