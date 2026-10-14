/* Day Board service worker: keeps the app shell available offline.
 * Only same-origin files are cached; Google sign-in and Calendar API calls
 * always go to the network. Bump VERSION when shipping changes. */
const VERSION = 'dayboard-v5';
const SHELL = [
  './',
  'index.html',
  'config.js',
  'css/app.css',
  'js/util.js',
  'js/systems.js',
  'js/flap.js',
  'js/store.js',
  'js/google.js',
  'js/sample.js',
  'js/app.js',
  'manifest.webmanifest',
  'fonts/inter-latin-wght-normal.woff2',
  'fonts/cabin-latin-wght-normal.woff2',
  'fonts/vt323-latin-400-normal.woff2',
  'fonts/doto-latin-wght-normal.woff2',
  'fonts/barlow-condensed-latin-600-normal.woff2',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates land immediately), falling back to the cache offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});
