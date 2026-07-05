let withPWA = (config) => config;

try {
  withPWA = require('next-pwa')({
    dest: 'public',
    disable: process.env.NODE_ENV === 'development',
    register: true,
    skipWaiting: true,
    swSrc: 'service-worker.js'
  });
} catch (error) {
  console.warn('[warden-app] next-pwa not installed; building without PWA wrapper.');
}

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    externalDir: true
  }
};

module.exports = withPWA(nextConfig);