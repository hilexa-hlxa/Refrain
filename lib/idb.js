/**
 * A minimal promise-based key/value store on top of IndexedDB.
 *
 * Why IndexedDB and not localStorage: the service worker needs to read the
 * same phrases and bag state the page writes, so it can deal a phrase while
 * no page is open. Service workers cannot touch localStorage. This file is a
 * classic script on purpose — sw.js pulls it in with importScripts().
 */
(function (root) {
  "use strict";

  // Left as "mindpulse" on purpose: this is the on-device IndexedDB name from
  // before the app was renamed to Refrain. Changing it would orphan every
  // phrase already saved by an installed copy — a fresh, empty database would
  // open under the new name instead. Nothing outside this file ever reads it.
  var DB_NAME = "mindpulse";
  var DB_VERSION = 1;
  var STORE = "kv";
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(mode, run) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = run(t.objectStore(STORE));
        t.onabort = t.onerror = function () { reject(t.error); };
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
      });
    });
  }

  root.RFStore = {
    get: function (key, fallback) {
      return tx("readonly", function (s) { return s.get(key); }).then(function (v) {
        return v === undefined ? fallback : v;
      });
    },
    set: function (key, value) {
      return tx("readwrite", function (s) { return s.put(value, key); });
    },
    /**
     * Read several keys at once, returning an object keyed the same way.
     *
     * One transaction for the lot rather than one per key: the scheduler
     * reads all five keys on every tick, and a single transaction is both
     * cheaper and a consistent snapshot — the bag and the schedule it comes
     * back with were true at the same moment.
     */
    getAll: function (spec) {
      var keys = Object.keys(spec);
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(STORE, "readonly");
          var store = t.objectStore(STORE);
          var reads = keys.map(function (k) { return store.get(k); });
          t.onabort = t.onerror = function () { reject(t.error); };
          t.oncomplete = function () {
            var out = {};
            keys.forEach(function (k, i) {
              out[k] = reads[i].result === undefined ? spec[k] : reads[i].result;
            });
            resolve(out);
          };
        });
      });
    },
  };
})(typeof self !== "undefined" ? self : globalThis);
