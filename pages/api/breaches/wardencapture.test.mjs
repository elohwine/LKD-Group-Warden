import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import handler from './wardencapture';

vi.mock('../../../lib/firebase-admin.mjs', () => ({
  adminAuth: {
    verifyIdToken: vi.fn(),
  },
  adminDb: {
    collection: vi.fn(),
  },
}));

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: {
    fromDate: (date) => ({
      _seconds: Math.floor(date.getTime() / 1000),
    }),
  },
}));

vi.mock('../../../lib/normalizeVrm.mjs', () => ({
  default: (vrm) => {
    if (!vrm) return null;
    const normalized = String(vrm)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 10);
    return /^[A-Z0-9]{2,10}$/.test(normalized) ? normalized : null;
  },
}));

const mockResponse = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
});

const mockRequest = (overrides = {}) => {
  const { body: bodyOverrides = {}, headers: headerOverrides = {}, ...restOverrides } = overrides;

  return {
  method: 'POST',
  headers: {
    authorization: 'Bearer valid-token',
    'content-type': 'application/json',
    ...headerOverrides,
  },
  body: {
    vrm: 'AB12CDE',
    siteId: 'site-001',
    siteName: 'Test Site',
    contraventionReason: 'Parked in bay',
      vehicleDetails: {
        vrm: 'AB12CDE',
        make: 'Ford',
        model: 'Focus',
        color: 'Blue',
        imageUrl: 'https://example.com/vehicle.jpg',
      },
      authorization: {
        hasAuthorization: true,
        authorization: {
          type: 'permit',
        },
      },
    observationStartTime: '2026-07-08T10:00:00.000Z',
    observationEndTime: '2026-07-08T10:12:00.000Z',
    images: [
      'https://example.com/evidence-entry.jpg',
      'https://example.com/evidence-exit.jpg',
    ],
    imageUrls: [
      'https://example.com/evidence-entry.jpg',
      'https://example.com/evidence-exit.jpg',
    ],
    evidence: {
      entry: {
        imageUrl: 'https://example.com/evidence-entry.jpg',
        vehicleImage: 'https://example.com/evidence-entry.jpg',
        plateImage: 'https://example.com/evidence-entry.jpg',
        timestamp: '2026-07-08T10:00:00.000Z',
      },
      exit: {
        imageUrl: 'https://example.com/evidence-exit.jpg',
        vehicleImage: 'https://example.com/evidence-exit.jpg',
        plateImage: 'https://example.com/evidence-exit.jpg',
        timestamp: '2026-07-08T10:12:00.000Z',
      },
    },
    closingEvidence: {
      imageUrl: 'https://example.com/evidence-exit.jpg',
      vehicleImage: 'https://example.com/evidence-exit.jpg',
      plateImage: 'https://example.com/evidence-exit.jpg',
      closedAt: '2026-07-08T10:12:00.000Z',
      breachEvidenceMode: 'paired_exit',
      realExitObserved: true,
    },
    realExitObserved: true,
    breachEvidenceMode: 'paired_exit',
    ...bodyOverrides,
  },
  ...restOverrides,
};
};

describe('POST /api/breaches/wardencapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
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

  describe('Authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const req = mockRequest({ headers: { authorization: '' } });
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

  describe('Validation', () => {
    beforeEach(async () => {
      const { adminAuth } = await import('../../../lib/firebase-admin.mjs');
      adminAuth.verifyIdToken.mockResolvedValue({
        uid: 'warden-123',
        email: 'warden@example.com',
      });
    });

    it('returns 400 when vrm is missing', async () => {
      const req = mockRequest({ body: { vrm: null } });
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const callArgs = res.json.mock.calls[0][0];
      expect(callArgs.error).toBe('Validation failed');
      expect(callArgs.details).toContain('vrm is required');
    });

    it('returns 400 when siteId is missing', async () => {
      const req = mockRequest({ body: { siteId: null } });
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const callArgs = res.json.mock.calls[0][0];
      expect(callArgs.details).toContain('siteId is required');
    });

    it('returns 400 when contraventionReason is missing', async () => {
      const req = mockRequest({ body: { contraventionReason: null } });
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const callArgs = res.json.mock.calls[0][0];
      expect(callArgs.details).toContain('contraventionReason is required');
    });

    it('returns 400 when vrm format is invalid', async () => {
      const req = mockRequest({ body: { vrm: '!!!' } });
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when paired entry/exit evidence is missing', async () => {
      const req = mockRequest({
        body: {
          images: ['https://example.com/single.jpg'],
          imageUrls: ['https://example.com/single.jpg'],
          evidence: {
            entry: {
              imageUrl: 'https://example.com/single.jpg',
              vehicleImage: 'https://example.com/single.jpg',
              plateImage: 'https://example.com/single.jpg',
              timestamp: '2026-07-08T10:00:00.000Z',
            },
          },
          closingEvidence: null,
        },
      });
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Paired opening and closing evidence is required before a breach can be created',
      });
    });

    it('returns 400 when carcheck details are missing', async () => {
      const req = mockRequest({
        body: {
          vehicleDetails: null,
        },
      });
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const callArgs = res.json.mock.calls[0][0];
      expect(callArgs.details).toContain('vehicleDetails is required');
    });

    it('returns 400 when permit lookup is missing', async () => {
      const req = mockRequest({
        body: {
          authorization: null,
        },
      });
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      const callArgs = res.json.mock.calls[0][0];
      expect(callArgs.details).toContain('authorization is required');
    });
  });

  describe('Successful Capture', () => {
    beforeEach(async () => {
      const { adminAuth } = await import('../../../lib/firebase-admin.mjs');
      adminAuth.verifyIdToken.mockResolvedValue({
        uid: 'warden-123',
        email: 'warden@example.com',
      });
    });

    it('returns 200 with breach id and status on success', async () => {
      const { adminDb } = await import('../../../lib/firebase-admin.mjs');
      const mockDocRef = { id: 'breach-doc-123' };
      const mockCollection = {
        add: vi.fn().mockResolvedValue(mockDocRef),
      };
      adminDb.collection.mockReturnValue(mockCollection);

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const callArgs = res.json.mock.calls[0][0];
      expect(callArgs).toEqual({
        id: 'breach-doc-123',
        status: 'QUEUED_FOR_QC',
      });
    });

    it('writes breach to Firestore with source=WARDEN', async () => {
      const { adminDb } = await import('../../../lib/firebase-admin.mjs');
      const mockDocRef = { id: 'breach-doc-456' };
      const mockCollection = {
        add: vi.fn().mockResolvedValue(mockDocRef),
      };
      adminDb.collection.mockReturnValue(mockCollection);

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      expect(mockCollection.add).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'WARDEN',
          status: 'QUEUED_FOR_QC',
          vrm: 'AB12CDE',
          siteId: 'site-001',
        })
      );
    });

    it('server-stamps audit fields', async () => {
      const { adminDb } = await import('../../../lib/firebase-admin.mjs');
      const mockDocRef = { id: 'breach-doc-789' };
      const mockCollection = {
        add: vi.fn().mockResolvedValue(mockDocRef),
      };
      adminDb.collection.mockReturnValue(mockCollection);

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      const payload = mockCollection.add.mock.calls[0][0];
      expect(payload).toHaveProperty('wardenId', 'warden-123');
      expect(payload).toHaveProperty('actorId', 'warden-123');
      expect(payload).toHaveProperty('actorEmail', 'warden@example.com');
      expect(payload).toHaveProperty('createdBy', 'warden-123');
      expect(payload).toHaveProperty('createdByEmail', 'warden@example.com');
      expect(payload).toHaveProperty('createdAt');
      expect(payload).toHaveProperty('updatedAt');
    });

    it('includes history entry on creation', async () => {
      const { adminDb } = await import('../../../lib/firebase-admin.mjs');
      const mockDocRef = { id: 'breach-doc-hist' };
      const mockCollection = {
        add: vi.fn().mockResolvedValue(mockDocRef),
      };
      adminDb.collection.mockReturnValue(mockCollection);

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      const payload = mockCollection.add.mock.calls[0][0];
      expect(payload.history).toBeDefined();
      expect(Array.isArray(payload.history)).toBe(true);
      expect(payload.history[0]).toMatchObject({
        event: 'created',
        by: 'warden-123',
        byEmail: 'warden@example.com',
      });
    });

    it('handles Firestore write failures gracefully', async () => {
      const { adminDb } = await import('../../../lib/firebase-admin.mjs');
      const mockCollection = {
        add: vi.fn().mockRejectedValue(new Error('Firestore unavailable')),
      };
      adminDb.collection.mockReturnValue(mockCollection);

      const req = mockRequest();
      const res = mockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to save breach capture' });
    });
  });
});
