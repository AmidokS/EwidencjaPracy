// Офлайн-работа: все файлы приложения хранятся в кеше телефона.
// При каждом запуске кеш тихо обновляется из сети, если она есть.
const CACHE = 'uchet-4.9-33a447a0';
// Здесь приложение оставляет адрес сервера, код и устройство — чтобы по уведомлению узнать текст объявления
const AUTH_CACHE = 'ew-auth';
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== AUTH_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // Страница управления (admin.html/js/css) и APK всегда берутся из сети: иначе можно увидеть старую админку
  // или скачать из кеша старую версию APK вместо новой
  const path = new URL(e.request.url).pathname;
  if (/\/admin\.(html|js|css)$/.test(path) || path.endsWith('.apk') || path.endsWith('/version.json')) return;
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

/*
 * Уведомления. Сервер присылает пустой push, когда владелец публикует объявление;
 * текст спрашиваем у сервера сами (по коду и устройству, которые оставило приложение).
 */
self.addEventListener('push', (e) => { e.waitUntil(showAnnouncement()); });

async function showAnnouncement() {
  let a = null;
  try { const r = await (await caches.open(AUTH_CACHE)).match('auth'); a = r ? await r.json() : null; } catch (err) { a = null; }
  const pl = a && a.lang === 'pl';
  let title = pl ? 'Ogłoszenie' : 'Объявление';
  let body = pl ? 'Nowe ogłoszenie — otwórz aplikację' : 'Новое объявление — открой приложение';
  let tag = 'msg';
  try {
    if (a && a.api && a.code) {
      const res = await fetch(a.api + '/push/msg', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ code: a.code, device: a.device }) });
      const r = await res.json();
      if (r && r.msg && r.msg.text) { body = r.msg.text; tag = `msg-${r.msg.id}`; }
    }
  } catch (err) { /* без связи — покажем общий текст */ }
  return self.registration.showNotification(title, { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: pl ? 'pl' : 'ru' });
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const w = list.find((c) => 'focus' in c);
    return w ? w.focus() : self.clients.openWindow('./');
  }));
});
