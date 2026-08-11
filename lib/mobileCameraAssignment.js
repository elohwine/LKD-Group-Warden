export function buildMobileCameraAssignmentPayload({ siteId, siteName, assignedBy, reason = 'warden_patrol_site_assignment' }) {
  const payload = {
    siteId: String(siteId || '').trim(),
    assignedBy: String(assignedBy || 'warden').trim() || 'warden',
    reason: String(reason || 'warden_patrol_site_assignment').trim() || 'warden_patrol_site_assignment',
  };

  const normalizedSiteName = String(siteName || '').trim();
  if (normalizedSiteName) {
    payload.siteName = normalizedSiteName;
  }

  return payload;
}
