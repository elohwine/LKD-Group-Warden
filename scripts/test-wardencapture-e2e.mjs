import { spawnSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import admin from 'firebase-admin';

loadDotenv({ path: resolve(process.cwd(), '.env.local') });

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function numEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function buildServiceAccountFromEnv() {
  return {
    type: process.env.FIREBASE_ADMIN_TYPE,
    project_id: process.env.FIREBASE_ADMIN_PROJECT_ID,
    private_key_id: process.env.FIREBASE_ADMIN_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_ADMIN_PRIVATE_KEY
      ? process.env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, '\n')
      : undefined,
    client_email: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_ADMIN_CLIENT_ID,
    auth_uri: process.env.FIREBASE_ADMIN_AUTH_URI,
    token_uri: process.env.FIREBASE_ADMIN_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.FIREBASE_ADMIN_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_ADMIN_CLIENT_X509_CERT_URL,
  };
}

async function resolveIdToken() {
  const provided = String(process.env.WARDEN_TEST_ID_TOKEN || '').trim();
  if (provided) {
    return { idToken: provided, uid: String(process.env.WARDEN_TEST_UID || 'provided-token-user') };
  }

  const apiKey = String(process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('NEXT_PUBLIC_FIREBASE_API_KEY is missing. Provide WARDEN_TEST_ID_TOKEN or configure Firebase env vars.');
  }

  const email = String(process.env.WARDEN_TEST_EMAIL || '').trim();
  const password = String(process.env.WARDEN_TEST_PASSWORD || '').trim();
  if (email && password) {
    const signInUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`;
    const signInRes = await fetch(signInUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });

    const signInData = await signInRes.json().catch(() => ({}));
    if (!signInRes.ok || !signInData?.idToken) {
      throw new Error(`Email/password sign-in failed (${signInRes.status}): ${JSON.stringify(signInData)}`);
    }

    const uid = String(signInData.localId || process.env.WARDEN_TEST_UID || '').trim() || `email-login-${Date.now()}`;
    return { idToken: signInData.idToken, uid };
  }

  const serviceAccount = buildServiceAccountFromEnv();
  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error('FIREBASE_ADMIN_* env vars are incomplete. Provide WARDEN_TEST_ID_TOKEN or valid Firebase Admin credentials.');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
    });
  }

  const uid = String(process.env.WARDEN_TEST_UID || `curl-verify-${Date.now()}`);
  const customToken = await admin.auth().createCustomToken(uid);

  const signInUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`;
  const signInRes = await fetch(signInUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });

  const signInData = await signInRes.json().catch(() => ({}));
  if (!signInRes.ok || !signInData?.idToken) {
    throw new Error(`Token exchange failed (${signInRes.status}): ${JSON.stringify(signInData)}`);
  }

  return { idToken: signInData.idToken, uid };
}

function buildPayload(uid) {
  const now = Date.now();
  const startIso = new Date(now - 12 * 60 * 1000).toISOString();
  const endIso = new Date(now - 8 * 60 * 1000).toISOString();

  const vrm = String(process.env.WARDEN_TEST_VRM || 'AB12CDE').trim().toUpperCase();
  const siteId = String(process.env.WARDEN_TEST_SITE_ID || 'test-site-01').trim();
  const siteName = String(process.env.WARDEN_TEST_SITE_NAME || 'Test Site').trim();
  const reason = String(process.env.WARDEN_TEST_REASON || 'No valid permit or payment found').trim();

  const imageA = String(process.env.WARDEN_TEST_IMAGE_A || 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80').trim();
  const imageB = String(process.env.WARDEN_TEST_IMAGE_B || 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1200&q=80').trim();

  return {
    vrm,
    siteId,
    siteName,
    contraventionReason: reason,
    reason,
    observationStartTime: startIso,
    observationEndTime: endIso,
    images: [imageA, imageB],
    imageUrls: [imageA, imageB],
    evidence: {
      entry: {
        imageUrl: imageA,
        vehicleImage: imageA,
        plateImage: imageB,
        capturedAt: startIso,
      },
      exit: {
        imageUrl: imageB,
        vehicleImage: imageB,
        plateImage: imageA,
        capturedAt: endIso,
      },
    },
    closingEvidence: {
      imageUrl: imageB,
      vehicleImage: imageB,
      plateImage: imageA,
      capturedAt: endIso,
    },
    realExitObserved: true,
    breachEvidenceMode: 'paired_exit',
    authorization: {
      hasAuthorization: false,
      source: 'e2e-script',
      valid: true,
    },
    vehicleDetails: {
      vrm,
      make: 'Test',
      model: 'Car',
      color: 'Black',
    },
    savedVehicleLookup: {
      vrm,
      make: 'Test',
      model: 'Car',
      color: 'Black',
    },
    location: { lat: 51.5074, lng: -0.1278 },
    notes: 'E2E wardencapture verification script',
    wardenId: uid,
    actorId: uid,
  };
}

function runCurl({ url, token, payload, timeoutSeconds, followRedirects = false, trustRedirectAuth = false }) {
  const args = [
    '-sS',
    '--max-time',
    String(timeoutSeconds),
    '-X',
    'POST',
    url,
    '-H',
    'Content-Type: application/json',
    '-H',
    `Authorization: Bearer ${token}`,
    '--data',
    JSON.stringify(payload),
    '-D',
    '-',
    '-o',
    '-',
    '-w',
    '\n__STATUS__:%{http_code}\n__EFFECTIVE_URL__:%{url_effective}\n',
  ];

  if (followRedirects) args.unshift('-L');
  if (trustRedirectAuth) args.unshift('--location-trusted');

  const result = spawnSync('curl', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Failed to execute curl: ${result.error.message}`);
  }

  const stdout = String(result.stdout || '');
  const statusMatch = stdout.match(/__STATUS__:(\d+)/);
  const effectiveUrlMatch = stdout.match(/__EFFECTIVE_URL__:(.*)$/m);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const effectiveUrl = effectiveUrlMatch ? effectiveUrlMatch[1].trim() : '';

  const cleaned = stdout
    .replace(/\n__STATUS__:\d+\n__EFFECTIVE_URL__:.*$/s, '')
    .trim();

  return {
    exitCode: result.status,
    status,
    effectiveUrl,
    stderr: String(result.stderr || '').trim(),
    output: cleaned,
  };
}

function printProbeResult(label, data) {
  console.log(`\n=== ${label} ===`);
  console.log(`curl_exit: ${data.exitCode}`);
  console.log(`http_status: ${data.status}`);
  console.log(`effective_url: ${data.effectiveUrl || 'n/a'}`);
  if (data.stderr) console.log(`curl_stderr: ${data.stderr}`);
  console.log('response_preview:');
  console.log(data.output.slice(0, 2000));
}

async function main() {
  const base = String(process.env.WARDEN_TEST_API_BASE || process.env.NEXT_PUBLIC_API_BASE_URL || 'https://ldkgroup.co.uk').replace(/\/$/, '');
  const endpoint = `${base}/api/breaches/wardencapture`;
  const timeoutSeconds = numEnv('WARDEN_TEST_TIMEOUT_SECONDS', 45);
  const authMode = String(process.env.WARDEN_TEST_ID_TOKEN || '').trim()
    ? 'id-token'
    : (String(process.env.WARDEN_TEST_EMAIL || '').trim() && String(process.env.WARDEN_TEST_PASSWORD || '').trim()
      ? 'email-password'
      : 'firebase-admin-custom-token');

  console.log('Target endpoint:', endpoint);
  console.log('Timeout (s):', timeoutSeconds);
  console.log('Auth mode:', authMode);

  const { idToken, uid } = await resolveIdToken();
  const payload = buildPayload(uid);

  const noRedirect = runCurl({
    url: endpoint,
    token: idToken,
    payload,
    timeoutSeconds,
    followRedirects: false,
    trustRedirectAuth: false,
  });
  printProbeResult('POST without redirects', noRedirect);

  const doRedirectProbes = boolEnv('WARDEN_TEST_REDIRECT_PROBES', true);
  if (doRedirectProbes) {
    const withRedirect = runCurl({
      url: endpoint,
      token: idToken,
      payload,
      timeoutSeconds,
      followRedirects: true,
      trustRedirectAuth: false,
    });
    printProbeResult('POST with redirects (-L)', withRedirect);

    const withTrustedRedirect = runCurl({
      url: endpoint,
      token: idToken,
      payload,
      timeoutSeconds,
      followRedirects: true,
      trustRedirectAuth: true,
    });
    printProbeResult('POST with redirects and trusted auth (-L --location-trusted)', withTrustedRedirect);
  }

  console.log('\nDone.');
}

main().catch((error) => {
  console.error('TEST_FAILED:', error?.message || error);
  process.exitCode = 1;
});
