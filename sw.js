/**
 * Refrain service worker.
 *
 *  - caches the app shell so it opens with no network
 *  - delivers a pulse from a periodic background sync, when the browser
 *    grants one, using the same tick() the open page uses
 *  - focuses the app when a notification is tapped
 *
 * All paths are relative so the app works from a subdirectory (a GitHub
 * Pages project site, say) as happily as from a domain root.
 */
importScripts("lib/idb.js", "lib/bag.js", "lib/pulse.js");

const CACHE = "refrain-shell-v16";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "lib/idb.js",
  "lib/bag.js",
  "lib/pulse.js",
  "lib/transfer.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {
      // A precache miss shouldn't block install — the app still runs online.
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/**
 * Navigations go to the network first so a redeploy is picked up on the next
 * visit rather than whenever the cache version happens to change; everything
 * else is served from cache immediately and refreshed in the background. Both
 * paths fall back to the cache, so the app still opens with no connection.
 */
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match("index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      const fresh = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit);
      return hit || fresh;
    })
  );
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "refrain-tick") event.waitUntil(self.RFPulse.tick());
});

// The page hands off to the worker when it is about to be hidden, so a
// pulse that comes due a moment later still has an owner.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "tick") event.waitUntil(self.RFPulse.tick());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
