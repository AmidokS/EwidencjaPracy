// Офлайн-работа: все файлы приложения хранятся в кеше телефона.
// При каждом запуске кеш тихо обновляется из сети, если она есть.
const CACHE = 'uchet-2.1';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' — берём файлы прямо с сервера, а не из кеша браузера,
  // иначе новая версия могла бы сохранить старые файлы
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // Страница управления и APK всегда берутся из сети: иначе можно увидеть старую админку
  // или скачать из кеша старую версию APK вместо новой
  const path = new URL(e.request.url).pathname;
  if (path.endsWith('/admin.html') || path.endsWith('.apk')) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then((res) => {
          if (res && res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
