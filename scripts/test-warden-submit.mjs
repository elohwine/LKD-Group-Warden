import { config } from 'dotenv';
import { resolve } from 'path';
import admin from 'firebase-admin';

config({ path: resolve(process.cwd(), '.env.local') });

const apiBase = String(process.env.NEXT_PUBLIC_API_BASE_URL || 'https://ldkgroup.co.uk').replace(/\/$/, '');
const apiKey = String(process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '').trim();
const projectId = String(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '').trim();
const serviceAccount = {
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

if (!admin.apps.length) {
  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    throw new Error('Missing FIREBASE_ADMIN_* env vars');
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
  });
}

const now = new Date();
const startIso = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
const endIso = new Date(now.getTime() - 8 * 60 * 1000).toISOString();
const uid = `script-${Date.now()}`;

async function main() {
  const customToken = await admin.auth().createCustomToken(uid);
  const signInRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });

  const signInJson = await signInRes.json();
  if (!signInRes.ok || !signInJson.idToken) {
    console.error('SIGNIN_FAILED', signInRes.status, signInJson);
    process.exitCode = 1;
    return;
  }

  const idToken = signInJson.idToken;
  const payload = {
    vrm: 'AB12CDE',
    siteId: 'test-site-01',
    siteName: 'Test Site',
    contraventionReason: 'No valid permit or payment found',
    reason: 'No valid permit or payment found',
    observationStartTime: startIso,
    observationEndTime: endIso,
    images: [
      'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1200&q=80',
    ],
    imageUrls: [
      'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1200&q=80',
    ],
    evidence: {
      entry: {
        imageUrl: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80',
        vehicleImage: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80',
        plateImage: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1200&q=80',
        capturedAt: startIso,
      },
      exit: {
        imageUrl: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1200&q=80',
        vehicleImage: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1200&q=80',
        plateImage: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80',
        capturedAt: endIso,
      }
    },
    closingEvidence: {
      imageUrl: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1200&q=80',
      vehicleImage: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1200&q=80',
      plateImage: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80',
      capturedAt: endIso,
    },
    realExitObserved: true,
    breachEvidenceMode: 'paired_exit',
    authorization: {
      hasAuthorization: false,
      source: 'script-test',
      valid: true,
    },
    vehicleDetails: {
      vrm: 'AB12CDE',
      make: 'Test',
      model: 'Car',
      color: 'Black',
      imageUrl: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80',
    },
    savedVehicleLookup: {
      vrm: 'AB12CDE',
      make: 'Test',
      model: 'Car',
      color: 'Black',
      imageUrl: 'https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1200&q=80',
    },
    notes: 'Scripted end-to-end breach submit test',
    location: { lat: 51.5074, lng: -0.1278 },
  };

  const url = `${apiBase}/api/breaches/wardencapture`;
  console.log('POSTING_TO', url);
  console.log('PROJECT_ID', projectId);
  console.log('UID', uid);

  const start = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const elapsed = Date.now() - start;
  const text = await res.text();
  console.log('ELAPSED_MS', elapsed);
  console.log('STATUS', res.status);
  console.log('RESPONSE', text);
}

main().catch((error) => {
  console.error('SCRIPT_ERROR', error);
  process.exitCode = 1;
});
