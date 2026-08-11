# Warden Runtime Verification Guide

Date: 2026-07-08

## Scope
This document confirms what has been verified for the warden app flow after login, and how to produce a correctly signed APK.

## Verified Working

1. Login uses backend token auth only:
- No Firebase client auth initialization in the app login flow.
- Login is performed against backend auth endpoints and returns a session token.
- Allowed roles: `warden`, `qc`, `admin`, `manager`, `epermit_officer`.

2. Mobile/export compatibility fix:
- Role lookup now resolves through configured API base URL.
- This avoids local `/api/...` failures in static export APK mode.

3. Post-login dashboard flow compiles and routes:
- Session token is loaded and used for API calls.
- Evidence upload and breach capture handlers are present.

4. API handler tests pass:
- `pages/api/warden/uploadevidence.test.mjs`
- `pages/api/breaches/wardencapture.test.mjs`

5. Web build/export passes:
- `npm run build:web` completes successfully.

## Important Runtime Requirement

Because APK uses static export (`next export`), local Next.js API routes are not hosted inside the APK.

Set backend URL for the mobile app environment:
- `NEXT_PUBLIC_API_BASE_URL=https://<your-backend-host>`
- `NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL=https://camera.ldkgroup.co.uk`

Without this, API calls such as role lookup, site loading, upload, capture, and mobile camera management (list/assign/edit) can fail in APK runtime.

## Signed APK Runbook

Before signing, export these environment variables:

- `WARDEN_KEYSTORE_PATH`
- `WARDEN_KEYSTORE_ALIAS`
- `WARDEN_KEYSTORE_PASSWORD`
- `WARDEN_KEY_PASSWORD`

Then build and sign:

```bash
./build-and-sign-apk.sh
```

Expected signed output:
- `android/app/build/outputs/apk/release/ldk-warden-v1.0-release-signed.apk`

## Quick Smoke Test After Install

1. Open app and sign in with valid backend credentials.
2. Confirm dashboard loads with active sites.
3. Capture one image and run Analyse image.
4. Finalise breach.
5. Confirm queued/synced state updates.

If login succeeds but dashboard API calls fail, first confirm `NEXT_PUBLIC_API_BASE_URL` is set to a reachable backend.
