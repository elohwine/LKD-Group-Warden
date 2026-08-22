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
      // Routes all WebView fetch/XHR through Android native HTTP.
      // Required for CORS bypass on ldkgroup.co.uk API calls (submit, upload, sync).
      // Firebase Auth calls to googleapis.com also work fine through native HTTP.
      enabled: true
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