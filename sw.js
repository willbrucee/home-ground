// Service worker: keeps satellite tiles the player has already seen, so they show instantly next time.
// It only touches map tiles; the game's own files always come fresh from the server.

const CACHE = "hg-tiles-v1";
const MAX_TILES = 2000; // roughly 40 MB; the oldest are dropped beyond this
const TILE_HOSTS = ["clarity.maptiles.arcgis.com", "server.arcgisonline.com"];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || !TILE_HOSTS.includes(url.hostname)) return; // not a tile: leave it alone
  event.respondWith(cacheFirst(event.request));
});

// Use the saved copy if there is one; otherwise download it, save it, and hand it over.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
    trimSometimes(cache);
  }
  return response;
}

// Every 100 new tiles, drop the oldest ones above the limit.
let added = 0;
async function trimSometimes(cache) {
  if (++added % 100) return;
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(old);
}
