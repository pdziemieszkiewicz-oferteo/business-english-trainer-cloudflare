const CACHE = 'ride-trainer-v7-4-shell-1';

const SHELL = [
  './',
  './index.html',
  './app.js?v=7.4',
  './styles.css?v=7.4',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './lessons/index.json',
  './lessons/lesson3.txt',
  './server-config.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);

  try {
    // Force a real network check so a normal F5 sees the newest Cloudflare deployment files.
    const response = await fetch(request, { cache: 'no-store' });

    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }

    return response;
  } catch (_) {
    const cached = await cache.match(request);
    if (cached) return cached;

    // For navigation requests, fall back to the cached app shell.
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }

    throw _;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(networkFirst(request));
});
