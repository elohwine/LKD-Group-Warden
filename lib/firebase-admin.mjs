import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { config } from 'dotenv';
import admin from 'firebase-admin';

// Load environment variables first
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env.local') });

if (!admin.apps.length) {
  // Create service account object with exact property names
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
    client_x509_cert_url: process.env.FIREBASE_ADMIN_CLIENT_X509_CERT_URL
  };

  // Verify required properties; in local dev allow graceful degradation
  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
    console.warn('Firebase admin credentials incomplete — running without admin DB. Set FIREBASE_ADMIN_* env vars to enable Firestore.');
  } else {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
      });
    } catch (error) {
      console.error('Firebase admin initialization error', error);
      console.warn('Continuing without admin DB due to initialization error.');
    }
  }
}

// Safely get Firestore and Auth instances — returns null if SDK wasn't initialized
// (e.g. missing FIREBASE_ADMIN_* env vars in local dev). The checkUserRole handler
// already guards for null and returns a graceful ADMIN_SDK_NOT_INITIALIZED response.
let _adminDb = null;
let _adminAuth = null;

try {
  _adminDb = admin.firestore();
  _adminAuth = admin.auth();
} catch (e) {
  console.warn('[firebase-admin] Could not get Firestore/Auth instances (SDK not initialized):', e.message);
}

export const adminDb = _adminDb;
export const adminAuth = _adminAuth;