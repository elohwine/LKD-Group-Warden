# PCN Sync + Camera Raw Issues Log

Date: 2026-09-02
Scope: Mobile warden app sync reliability and camera-tab UX.

## 1) Queue sync error says DNS lookup failed
- Symptom:
  - Queue item fails with: `Primary API host DNS lookup failed (onrender). Check device DNS/network and retry.`
- Root cause:
  - Native HTTP error normalization maps host-resolution failures to this message.
  - This indicates device DNS/network path failure to the configured API origin, not a PCN business-rule validation failure.
- Evidence:
  - [lib/api.js](lib/api.js#L105)
- Action:
  - Keep message (useful), but include endpoint/host in future message detail if needed.

## 2) Synced PCN had partial images
- Symptom:
  - Sync completed but backend/PCN showed only part of image set.
- Root cause:
  - Uploader previously accepted partial success (`Promise.allSettled`) and continued as long as at least one image uploaded.
- Evidence:
  - [pages/dashboard.js](pages/dashboard.js#L3868)
  - [pages/dashboard.js](pages/dashboard.js#L3879)
- Fix applied:
  - Added strict mode for sync uploads (`requireAllSuccess`) and enabled it for both entry and closing batches.
  - Blocked fallback to stored payload images when fallback count is less than expected uploadable file count.
- Updated code:
  - [pages/dashboard.js](pages/dashboard.js#L3610)
  - [pages/dashboard.js](pages/dashboard.js#L3890)
  - [pages/dashboard.js](pages/dashboard.js#L5129)
  - [pages/dashboard.js](pages/dashboard.js#L5199)
  - [pages/dashboard.js](pages/dashboard.js#L5137)
  - [pages/dashboard.js](pages/dashboard.js#L5207)

## 3) Camera-tab quick captures disappeared after app close
- Symptom:
  - Captures visible in camera tab vanish after app restart/close.
- Root cause:
  - Quick-capture cards were held only in component state and never persisted reliably.
- Fix applied:
  - Added persistent quick-capture store in localStorage.
  - Added file serialization (data URLs) and restoration into File objects on startup.
  - Added sanitation and cap limit to avoid unbounded growth.
- Updated code:
  - [pages/dashboard.js](pages/dashboard.js#L251)
  - [pages/dashboard.js](pages/dashboard.js#L1096)
  - [pages/dashboard.js](pages/dashboard.js#L2886)
  - [pages/dashboard.js](pages/dashboard.js#L2901)

## 4) No explicit upload progress/failure feedback on camera quick captures
- Symptom:
  - User had no per-capture upload state; failures looked like silent loss.
- Root cause:
  - Camera quick cards did not have independent sync lifecycle or upload action.
- Fix applied:
  - Added `syncQuickCaptureCard` flow using existing uploader.
  - Added per-card state: `queued | syncing | synced | failed`, progress percentage, and failure reason.
  - Added per-card upload/retry button.
- Updated code:
  - [pages/dashboard.js](pages/dashboard.js#L3169)
  - [pages/dashboard.js](pages/dashboard.js#L7421)

## 5) Camera card CTAs looked unstyled / low contrast
- Symptom:
  - Carcheck/e-permit buttons looked plain and inconsistent.
- Fix applied:
  - Added compact styled button system for camera cards and sync-state visuals.
- Updated code:
  - [styles/globals.css](styles/globals.css#L4278)

## Remaining UX gap: camera raw gallery table parity with sister project
- Status:
  - Not fully addressed in this patch.
- Requirement:
  - Match compact camera-gallery table attributes from sister project in PROJECTS.
- Next implementation slice:
  - Pull exact table columns/filters/sort from sister project camera gallery.
  - Apply same compact row density and thumbnail metadata layout in `WardenCaptureFeed`.
  - Include persistent row-level badges for permit/carcheck and upload lifecycle.

## Verification done
- `get_errors` clean for modified files:
  - [pages/dashboard.js](pages/dashboard.js)
  - [styles/globals.css](styles/globals.css)
