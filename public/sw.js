// Offline support: the app files and the 180 MB model are cached after first use.
const SHELL = 'unmix-shell-v7', MODEL = 'unmix-model-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('unmix-shell') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
async function cacheFirst(r, name) {
  const c = await caches.open(name), hit = await c.match(r);
  if (hit) return hit;
  const res = await fetch(r); if (res.ok) c.put(r, res.clone()); return res;
}
async function swr(r) {
  const c = await caches.open(SHELL), hit = await c.match(r);
  const net = fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.hostname.endsWith('huggingface.co') || u.hostname === 'cdn.jsdelivr.net') e.respondWith(cacheFirst(r, MODEL));
  else if (u.origin === location.origin) e.respondWith(swr(r));
});
