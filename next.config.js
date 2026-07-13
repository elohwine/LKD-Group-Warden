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
  },
  async rewrites() {
    // Only proxy to production backend during local Next.js dev server runs.
    // Local API routes (under pages/api/*) naturally take precedence.
    return [
      {
        source: '/api/:path*',
        destination: 'https://www.ldkgroup.co.uk/api/:path*'
      }
    ];
  }
};

module.exports = withPWA(nextConfig);