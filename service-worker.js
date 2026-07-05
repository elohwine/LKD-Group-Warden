/* eslint-disable no-undef */
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { NetworkFirst, CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';

self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST || []);
cleanupOutdatedCaches();

registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: 'pages',
    plugins: [new CacheableResponsePlugin({ statuses: [200] }), new ExpirationPlugin({ maxEntries: 50, purgeOnQuotaError: true })]
  })
);

setCatchHandler(async ({ event }) => {
  if (event.request.mode === 'navigate') {
    const cache = await caches.open('static-fallbacks');
    const fallback = await cache.match('/offline.html');
    if (fallback) return fallback;
  }
  return Response.error();
});

registerRoute(
  ({ request }) => request.destination === 'image',
  new CacheFirst({
    cacheName: 'images',
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] }), new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 })]
  })
);

registerRoute(
  ({ request }) => ['style', 'script', 'worker', 'font'].includes(request.destination),
  new StaleWhileRevalidate({ cacheName: 'assets' })
);

registerRoute(
  ({ url, request }) => request.method === 'GET' && url.pathname.startsWith('/api/'),
  new NetworkFirst({ cacheName: 'api-get', networkTimeoutSeconds: 5 })
);