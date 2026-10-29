// Garde l'application disponible hors ligne.
// En ligne, on prend toujours la dernière version (et on met la copie à jour) ;
// hors ligne, on sert la copie gardée.

const CACHE = 'story-messenger';
const APP_FILES = [
    './',
    'index.html',
    'style.css',
    'script.js',
    'manifest.webmanifest',
    'vendor/lucide.min.js',
    'vendor/mammoth.browser.min.js',
    'icons/icon.svg',
    'icons/icon-192.png',
    'icons/icon-512.png',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    // Polices Google : elles ne changent pas, la copie suffit
    if (FONT_HOSTS.includes(url.hostname)) {
        event.respondWith(caches.match(request).then(hit => hit || fetchAndKeep(request)));
        return;
    }
    if (url.origin !== location.origin) return;

    // Fichiers de l'application : réseau d'abord, copie si hors ligne
    event.respondWith(
        fetchAndKeep(request).catch(async () =>
            (await caches.match(request, { ignoreSearch: true }))
            || (request.mode === 'navigate' && await caches.match('./'))
            || Response.error()
        )
    );
});

async function fetchAndKeep(request) {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy));
    }
    return response;
}
