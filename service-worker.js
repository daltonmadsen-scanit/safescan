
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open('safescan-v1').then(cache => cache.addAll([
    '/', '/index.html', '/styles.css', '/script.js', '/avoid_list.json', '/manifest.json', '/icon-192.png', '/icon-512.png'
  ])));
});
self.addEventListener('fetch', (event) => {
  event.respondWith(caches.match(event.request).then(resp => resp || fetch(event.request)));
});
