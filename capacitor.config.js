const backendBase = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '');
const secondaryBackendBase = (process.env.NEXT_PUBLIC_API_BASE_URL_SECONDARY || '').replace(/\/$/, '');
const cameraServiceBase = (process.env.NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL || '').replace(/\/$/, '');
let allowNavigation = [];

const allowNavigationSet = new Set();

if (backendBase) {
  try {
    allowNavigationSet.add(new URL(backendBase).host);
  } catch (_) {
    // Ignore invalid URL and keep existing allowNavigation entries.
  }
}

if (secondaryBackendBase) {
  try {
    allowNavigationSet.add(new URL(secondaryBackendBase).host);
  } catch (_) {
    // Ignore invalid URL and keep existing allowNavigation entries.
  }
}

if (cameraServiceBase) {
  try {
    allowNavigationSet.add(new URL(cameraServiceBase).host);
  } catch (_) {
    // Ignore invalid URL and keep existing allowNavigation entries.
  }
}

allowNavigation = Array.from(allowNavigationSet);

const server = {
  allowNavigation
};

module.exports = {
  appId: 'com.ldk.warden.mobile',
  appName: 'LDK Warden',
  webDir: 'out',
  bundledWebRuntime: false,
  server,
  plugins: {
    CapacitorHttp: {
      // Keep global fetch/XHR unpatched so Firebase Auth uses stable WebView networking.
      // App API traffic still uses native HTTP explicitly through lib/api helpers.
      enabled: false
    },
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: '#08111d',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false
    },
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK'
    }
  }
};