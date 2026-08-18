import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import handler from './uploadevidence';

vi.mock('../../../lib/firebase-admin.mjs', () => ({
  adminAuth: {
    verifyIdToken: vi.fn(),
  },
}));

vi.mock('firebase-admin/storage', () => ({
  getStorage: vi.fn(),
}));

vi.mock('formidable', () => ({
  default: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    unlinkSync: vi.fn(),
  },
}));

const mockResponse = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
});

const mockRequest = (overrides = {}) => ({
  method: 'POST',
  headers: {
    authorization: 'Bearer valid-token',
    ...overrides.headers,
  },
  ...overrides,
});

describe('POST /api/warden/uploadevidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const req = mockRequest({ headers: {} });
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    });

    it('returns 401 when Bearer token is invalid', async () => {
      const { adminAuth } = await import('../../../lib/firebase-admin.mjs');
      adminAuth.verifyIdToken.mockRejectedValue(new Error('Invalid token'));

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    });
  });

  describe('HTTP Methods', () => {
    it('returns 405 for non-POST requests', async () => {
      const req = mockRequest({ method: 'GET' });
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
    });
  });

  describe('File Validation', () => {
    beforeEach(async () => {
      const { adminAuth } = await import('../../../lib/firebase-admin.mjs');
      adminAuth.verifyIdToken.mockResolvedValue({
        uid: 'warden-123',
        email: 'warden@example.com',
      });
    });

    it('returns 400 when no files are uploaded', async () => {
      const { default: formidable } = await import('formidable');
      formidable.mockReturnValue({
        parse: (req, cb) => cb(null, {}, {}),
      });

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'No files uploaded' });
    });

    it('returns 400 when all files exceed size limit', async () => {
      const { default: formidable } = await import('formidable');
      formidable.mockReturnValue({
        parse: (req, cb) => {
          cb(null, {}, {
            file: [
              {
                originalFilename: 'large.jpg',
                mimetype: 'image/jpeg',
                size: 10 * 1024 * 1024, // 10MB
                filepath: '/tmp/large.jpg',
              },
            ],
          });
        },
      });

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('Storage Configuration', () => {
    beforeEach(async () => {
      const { adminAuth } = await import('../../../lib/firebase-admin.mjs');
      adminAuth.verifyIdToken.mockResolvedValue({
        uid: 'warden-123',
        email: 'warden@example.com',
      });

      const { default: formidable } = await import('formidable');
      formidable.mockReturnValue({
        parse: (req, cb) => {
          cb(null, {}, {
            file: {
              originalFilename: 'test.jpg',
              mimetype: 'image/jpeg',
              size: 100 * 1024, // 100KB
              filepath: '/tmp/test.jpg',
            },
          });
        },
      });
    });

    it('returns 500 when storage bucket is not configured', async () => {
      process.env.FIREBASE_STORAGE_BUCKET = '';

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Storage bucket not configured' });
    });
  });

  describe('Successful Upload', () => {
    beforeEach(async () => {
      const { adminAuth } = await import('../../../lib/firebase-admin.mjs');
      adminAuth.verifyIdToken.mockResolvedValue({
        uid: 'warden-123',
        email: 'warden@example.com',
      });

      const { default: formidable } = await import('formidable');
      formidable.mockReturnValue({
        parse: (req, cb) => {
          cb(null, { manualVrm: ['AB12CDE'] }, {
            file: {
              originalFilename: 'plate.jpg',
              mimetype: 'image/jpeg',
              size: 150 * 1024,
              filepath: '/tmp/plate.jpg',
            },
          });
        },
      });

      process.env.FIREBASE_STORAGE_BUCKET = 'test-bucket';
    });

    it('returns 200 with vrm and image URLs on successful upload', async () => {
      const { getStorage } = await import('firebase-admin/storage');
      const mockBucket = {
        upload: vi.fn().mockResolvedValue([]),
        file: vi.fn().mockReturnValue({
          getSignedUrl: vi.fn().mockResolvedValue([
            'https://storage.googleapis.com/test-bucket/warden_evidence/...',
          ]),
        }),
      };
      getStorage.mockReturnValue({
        bucket: vi.fn().mockReturnValue(mockBucket),
      });

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const callArgs = res.json.mock.calls[0][0];
      expect(callArgs).toHaveProperty('vrm', 'AB12CDE');
      expect(callArgs).toHaveProperty('images');
      expect(Array.isArray(callArgs.images)).toBe(true);
    });

    it('normalizes VRM correctly', async () => {
      const { getStorage } = await import('firebase-admin/storage');
      const mockBucket = {
        upload: vi.fn().mockResolvedValue([]),
        file: vi.fn().mockReturnValue({
          getSignedUrl: vi.fn().mockResolvedValue([
            'https://storage.googleapis.com/test-bucket/warden_evidence/...',
          ]),
        }),
      };
      getStorage.mockReturnValue({
        bucket: vi.fn().mockReturnValue(mockBucket),
      });

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      const callArgs = res.json.mock.calls[0][0];
      // VRM should be uppercase with no spaces
      expect(callArgs.vrm).toMatch(/^[A-Z0-9]{2,10}$/);
    });
  });
});
