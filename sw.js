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

const CACHE = "refrain-shell-v17";
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
 * Everything, the page itself included, is answered from the cache at once
 * and refreshed in the background, so the app opens without waiting on the
 * network — which on a weak connection used to mean staring at a blank
 * screen until the request for index.html came back or gave up.
 *
 * Navigations used to go to the network first, so that a redeploy showed on
 * the next visit even if CACHE had not been bumped. That is not needed for a
 * redeploy done properly: a changed sw.js installs, precaches the new shell,
 * takes over, and the page reloads itself once (see app.js), all on the
 * visit that fetched it. And when the bump is forgotten, a fresh page over
 * stale scripts is a worse place to be than a whole shell that is one visit
 * behind, which is what this gives instead.
 *
 * With no connection and nothing cached for the address asked for, a
 * navigation falls back to the cached index.html, so the app still opens.
 */
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      let stored = Promise.resolve();
      const fresh = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            stored = caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit || (request.mode === "navigate" ? caches.match("index.html") : undefined));
      // The page already has its answer when there was a hit, so nothing else
      // is holding the worker open until the background copy has landed.
      event.waitUntil(fresh.then(() => stored).catch(() => {}));
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
