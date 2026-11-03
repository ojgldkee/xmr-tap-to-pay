const CACHE = 'xmrtap-beta-v1';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(c => c.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(r => r || caches.match('./index.html'))));
});
