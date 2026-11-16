// 離線快取：第一次打開後，之後不用網路也能使用
const CACHE = 'speak-v7';
// 離線語音辨識引擎檔案很大（約 22MB），放在另一個快取，App 更新時不用重新下載
const ENGINE_CACHE = 'speak-engine-transformers-3.5.1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'worker.js', 'pinyin-pro.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // transformers-cache 是下載的語音模型，不能刪
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== ENGINE_CACHE && k !== 'transformers-cache').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 加上跨來源隔離標頭，讓離線辨識可以用多核心運算（GitHub Pages 無法自己設定這些標頭）
function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // 引擎檔案：有存過就直接用（不會變動）
  if (url.pathname.includes('/whisper/')) {
    e.respondWith(
      caches.open(ENGINE_CACHE).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }))).then(isolate)
    );
    return;
  }

  // 其他檔案：先用網路拿最新版，沒網路就用快取
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
      .then(isolate)
  );
});
