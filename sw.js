const VERSION = 'mori-gist-v1';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './db.js', './sync.js',
  './markdown.js', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(k=>k!==VERSION).map(k=>caches.delete(k)))),
    self.clients.claim()
  ]));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // GitHub API и внешние изображения никогда не кэшируем.
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then(response => {
      if (response.ok) {
        const clone = response.clone();
        event.waitUntil(caches.open(VERSION).then(cache => cache.put(req,clone)));
      }
      return response;
    }).catch(async () => (await caches.match(req)) ||
      (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
  );
});
