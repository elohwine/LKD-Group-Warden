import { describe, expect, test } from 'vitest';
import { decideEvidenceSource, recoverUploadableEvidenceFilesFromCameraRaw } from '../lib/pcnEvidenceSync.js';

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
