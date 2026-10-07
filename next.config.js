let withPWA = (config) => config;

const rewriteApiBase = (
  process.env.LOCAL_API_PROXY_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  'https://ldkgroup.co.uk'
)
  .replace(/\/$/, '');

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
    // #region agent log
    fetch('http://127.0.0.1:7816/ingest/d49109f6-c502-46e9-b8e2-2c14a52f8d97',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'f2c557'},body:JSON.stringify({sessionId:'f2c557',runId:'post-fix-local-proxy',hypothesisId:'G',location:'next.config.js:rewrites',message:'local API proxy target selected',data:{rewriteApiBase},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return [
      {
        source: '/api/:path*',
        destination: `${rewriteApiBase}/api/:path*`
      }
    ];
  }
};

module.exports = withPWA(nextConfig);