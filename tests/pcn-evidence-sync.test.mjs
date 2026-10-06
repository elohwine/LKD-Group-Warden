import { describe, expect, test } from 'vitest';
import { collectPcnImageUrls, decideEvidenceSource, evidenceUploadGap, recoverUploadableEvidenceFilesFromCameraRaw } from '../lib/pcnEvidenceSync.js';

describe('collectPcnImageUrls', () => {
  test('keeps every remote photo from the request and the saved breach', () => {
    const urls = collectPcnImageUrls(
      {
        images: ['https://example.com/entry-1.jpg'],
        evidence: { exit: { imageUrl: 'https://example.com/exit-1.jpg' } },
      },
      {
        imageUrls: ['https://example.com/entry-2.jpg', 'not-a-url'],
        cameraRawData: [
          { uploadedUrl: 'https://example.com/entry-3.jpg' },
          { uploadedUrl: 'file:///local/only.jpg' },
          { plateCutoffImage: 'https://example.com/plate.jpg' },
        ],
      },
    );

    expect(urls).toEqual([
      'https://example.com/entry-1.jpg',
      'https://example.com/exit-1.jpg',
      'https://example.com/entry-2.jpg',
      'https://example.com/entry-3.jpg',
      'https://example.com/plate.jpg',
    ]);
  });
});

describe('evidenceUploadGap', () => {
  test('flags a partial upload instead of treating it as complete', () => {
    expect(evidenceUploadGap({
      uploadedImages: ['https://example.com/a.jpg'],
      failedCount: 1,
      expectedCount: 2,
    }).incomplete).toBe(true);
  });

  test('flags a stored-link fallback that covers fewer photos than were captured', () => {
    expect(evidenceUploadGap({
      uploadedImages: ['https://example.com/a.jpg'],
      failedCount: 3,
      expectedCount: 3,
      fromStoredPayload: true,
    }).incomplete).toBe(true);
  });

  test('accepts a full upload and a stored fallback that still covers every photo', () => {
    expect(evidenceUploadGap({
      uploadedImages: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      failedCount: 0,
      expectedCount: 2,
    }).incomplete).toBe(false);
    expect(evidenceUploadGap({
      uploadedImages: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      failedCount: 2,
      expectedCount: 2,
      fromStoredPayload: true,
    }).incomplete).toBe(false);
  });
});

describe('decideEvidenceSource', () => {
  test('prefers real local blobs over stale payload data when a fresh local pair exists', () => {
    const decision = decideEvidenceSource({
      entryUploadableFiles: [{ blob: new Blob(['a']) }],
      closingUploadableFiles: [{ blob: new Blob(['b']) }],
      payloadEntryImages: ['https://example.com/stale-entry.jpg'],
      payloadClosingImages: ['https://example.com/stale-exit.jpg'],
      hasDeepPayloadPair: true,
      legacyItem: true,
      previouslyFailedItem: true,
    });

    expect(decision.hasRealLocalEvidencePair).toBe(true);
    expect(decision.shouldPreferStoredPayloadEvidence).toBe(false);
    expect(decision.shouldUploadLocalEvidence).toBe(true);
  });

  test('uses stored payload only when there is no real local evidence at all', () => {
    const decision = decideEvidenceSource({
      entryUploadableFiles: [],
      closingUploadableFiles: [],
      payloadEntryImages: ['https://example.com/legacy-entry.jpg'],
      payloadClosingImages: ['https://example.com/legacy-exit.jpg'],
      hasDeepPayloadPair: true,
      legacyItem: true,
      previouslyFailedItem: false,
    });

    expect(decision.hasRealLocalEvidencePair).toBe(false);
    expect(decision.shouldPreferStoredPayloadEvidence).toBe(true);
    expect(decision.shouldUploadLocalEvidence).toBe(false);
  });

  test('does not fall back solely because the item is a failed retry when local evidence is still present', () => {
    const decision = decideEvidenceSource({
      entryUploadableFiles: [{ blob: new Blob(['entry']) }],
      closingUploadableFiles: [],
      payloadEntryImages: ['https://example.com/stale-entry.jpg'],
      payloadClosingImages: ['https://example.com/stale-exit.jpg'],
      hasDeepPayloadPair: true,
      legacyItem: false,
      previouslyFailedItem: true,
    });

    expect(decision.shouldPreferStoredPayloadEvidence).toBe(false);
    expect(decision.shouldUploadLocalEvidence).toBe(true);
  });

  test('recovers uploadable files from local preview data URLs', async () => {
    const dataUrl = 'data:image/png;base64,SGVsbG8=';

    const recovered = await recoverUploadableEvidenceFilesFromCameraRaw([
      {
        phase: 'entry',
        fileName: 'entry_data_url.png',
        mimeType: 'image/png',
        localPreviewUrl: dataUrl,
      },
    ], 'entry');

    expect(recovered).toHaveLength(1);
    expect(recovered[0].blob instanceof Blob).toBe(true);
    expect(recovered[0].phase).toBe('entry');
    expect(recovered[0].type).toBe('image/png');
  });

  test('recovers uploadable files from Capacitor native file URIs', async () => {
    const originalCapacitor = globalThis.Capacitor;
    globalThis.Capacitor = {
      isNativePlatform: () => true,
      Filesystem: {
        readFile: async ({ path }) => ({
          data: 'iVBORw0KGgo=',
          path,
        }),
      },
    };

    try {
      const recovered = await recoverUploadableEvidenceFilesFromCameraRaw([
        {
          phase: 'entry',
          fileName: 'native-entry.jpg',
          mimeType: 'image/jpeg',
          localPreviewUrl: 'file:///var/mobile/Containers/Data/Application/test/entry.jpg',
        },
      ], 'entry');

      expect(recovered).toHaveLength(1);
      expect(recovered[0].blob instanceof Blob).toBe(true);
      expect(recovered[0].phase).toBe('entry');
      expect(recovered[0].type).toBe('image/jpeg');
    } finally {
      if (originalCapacitor === undefined) {
        delete globalThis.Capacitor;
      } else {
        globalThis.Capacitor = originalCapacitor;
      }
    }
  });
});
