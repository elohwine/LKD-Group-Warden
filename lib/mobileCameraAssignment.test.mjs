import { describe, expect, it } from 'vitest';
import { buildMobileCameraAssignmentPayload } from './mobileCameraAssignment.js';

describe('buildMobileCameraAssignmentPayload', () => {
  it('includes the site id and resolved site name for backend assignment', () => {
    const payload = buildMobileCameraAssignmentPayload({
      siteId: 'site-1',
      siteName: 'Stephenson House',
      assignedBy: 'warden@example.com',
      reason: 'warden_patrol_site_assignment',
    });

    expect(payload).toEqual({
      siteId: 'site-1',
      assignedBy: 'warden@example.com',
      reason: 'warden_patrol_site_assignment',
      siteName: 'Stephenson House',
    });
  });
});
