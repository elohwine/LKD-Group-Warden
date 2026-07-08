import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from './convert-to-pcn';

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
    if (!vrm) return '';
    return String(vrm).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
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
      ...headerOverrides,
    },
    body: {
      breachId: 'breach-123',
      pcnNumber: 'PCN-AB12-0001',
      amount: 100,
      reason: 'No valid permit or payment found',
      notes: 'Escalated by warden',
      vrm: 'AB12CDE',
      timestamp: '2026-07-08T10:12:00.000Z',
      siteId: 'site-1',
      siteName: 'Main Site',
      images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      evidence: {
        entry: { imageUrl: 'https://example.com/a.jpg' },
        exit: { imageUrl: 'https://example.com/b.jpg' },
      },
      ...bodyOverrides,
    },
    ...restOverrides,
  };
};

describe('POST /api/breaches/convert-to-pcn', () => {
  const mockBreachRef = {
    get: vi.fn(),
    set: vi.fn(),
  };
  const mockBreachesCollection = {
    doc: vi.fn(() => mockBreachRef),
  };
  const mockPcnsCollection = {
    add: vi.fn(),
  };
  const mockPcnQaCollection = {
    add: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { adminAuth, adminDb } = await import('../../../lib/firebase-admin.mjs');
    adminAuth.verifyIdToken.mockResolvedValue({
      uid: 'warden-1',
      email: 'warden@example.com',
    });

    mockBreachRef.get.mockResolvedValue({
      exists: true,
      data: () => ({
        vrm: 'AB12CDE',
        siteId: 'site-1',
        siteName: 'Main Site',
      }),
    });
    mockBreachRef.set.mockResolvedValue(undefined);
    mockPcnsCollection.add.mockResolvedValue({ id: 'pcn-123' });
    mockPcnQaCollection.add.mockResolvedValue({ id: 'pcnqa-123' });

    adminDb.collection.mockImplementation((name) => {
      if (name === 'breaches') return mockBreachesCollection;
      if (name === 'pcns') return mockPcnsCollection;
      if (name === 'pcnqa') return mockPcnQaCollection;
      return { add: vi.fn(), doc: vi.fn() };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 405 for non-POST methods', async () => {
    const req = mockRequest({ method: 'GET' });
    const res = mockResponse();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
  });

  it('returns 401 without bearer token', async () => {
    const req = mockRequest({ headers: { authorization: '' } });
    const res = mockResponse();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('returns 400 when breachId is missing', async () => {
    const req = mockRequest({ body: { breachId: '' } });
    const res = mockResponse();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Breach ID is required' });
  });

  it('returns 400 when amount is invalid', async () => {
    const req = mockRequest({ body: { amount: 0 } });
    const res = mockResponse();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'A valid PCN amount is required' });
  });

  it('writes to pcns and pcnqa and updates breach on success', async () => {
    const req = mockRequest();
    const res = mockResponse();

    await handler(req, res);

    expect(mockPcnsCollection.add).toHaveBeenCalledTimes(1);
    expect(mockPcnQaCollection.add).toHaveBeenCalledTimes(1);
    expect(mockBreachRef.set).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Breach converted to PCN successfully',
      pcnId: 'pcn-123',
      pcnNumber: 'PCN-AB12-0001',
      sameDayWarnings: null,
    });
  });

  it('returns 500 when conversion write fails', async () => {
    mockPcnsCollection.add.mockRejectedValueOnce(new Error('firestore failed'));

    const req = mockRequest();
    const res = mockResponse();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(payload.error).toBe('firestore failed');
  });
});
