const backendBase = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '');
let allowNavigation = [];

if (backendBase) {
  try {
    allowNavigation = [new URL(backendBase).host];
  } catch (_) {
    allowNavigation = [];
  }
}

module.exports = {
  appId: 'com.ldk.warden',
  appName: 'LDK Warden',
  webDir: 'out',
  bundledWebRuntime: false,
  server: {
    allowNavigation
  },
  plugins: {
    CapacitorHttp: {
      enabled: true
    },
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: '#08111d',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false
    }
  }
};