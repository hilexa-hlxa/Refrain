/**
 * Carrying phrases out of the app and back in.
 *
 * The rule an import follows is "add what is missing, leave the rest alone":
 * your own copy of a phrase always wins, because it carries the mute state
 * and the date you wrote it. Sameness is judged on the trimmed text — an id
 * would be useless, since a phrase typed on a second device is the same
 * phrase to you and a different row to the machine.
 *
 * Pure, like lib/bag.js: state in, new state out, with the id source and the
 * clock injectable so the behaviour can be tested without either.
 *
 * Classic script — loaded by <script> in the page. Depends on nothing.
 */
(function (root) {
  "use strict";

  function fallbackId() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * The parts of the day a phrase can be pinned to. Kept as a plain list here
   * rather than reaching for RFPulse: transfer runs in the page alone and
   * should not need the scheduler loaded to read a file.
   */
  var WINDOWS = ["anytime", "morning", "afternoon", "evening"];

  /** The identity two phrases are judged the same by. */
  function key(text) {
    return String(text == null ? "" : text).trim();
  }

  var MINUTE = 60 * 1000;

  // The gap between sends an import may ask for. The floor is the shortest
  // interval the screen offers: a file should not be able to set a rhythm
  // nobody could have chosen by hand, and "one a second" is the rhythm a
  // hostile or mangled file would choose.
  var MIN_INTERVAL = 15 * MINUTE;
  var MAX_INTERVAL = 24 * 60 * MINUTE;

  // Far more send times than anyone would list; only here so a file cannot
  // hand the scheduler ten thousand of them.
  var MAX_TIMES = 48;

  /** A wall-clock "HH:MM" the scheduler can read, and nothing else. */
  function isClock(value) {
    var m = typeof value === "string" && /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
  }

  /**
   * The settings a file carries, reduced to the ones the app can use.
   *
   * Settings are written straight into storage and read back by the
   * scheduler on every tick, so a value of the wrong shape does not fail
   * once, here — it fails every second from then on. Two were possible
   * before this existed: `times` as anything but a list threw inside every
   * repaint, which the app could only report as "storage unavailable", and
   * a tiny `intervalMs` sent a notification on every tick.
   *
   * It follows the rule parse() uses for phrases: a field that cannot be used
   * is dropped and the rest of the file still counts. A dropped field leaves
   * whatever the app already had. Fields the app does not know are dropped
   * too, so a file cannot plant keys for some later version to trip over.
   *
   * Returns null when nothing usable is left, which is also what a file with
   * no settings block reads as.
   */
  function cleanSettings(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var out = {};

    if (typeof raw.intervalMs === "number" && raw.intervalMs >= MIN_INTERVAL && raw.intervalMs <= MAX_INTERVAL) {
      out.intervalMs = raw.intervalMs;
    }
    if (raw.mode === "interval" || raw.mode === "times") out.mode = raw.mode;
    if (Array.isArray(raw.times)) {
      var times = raw.times.filter(isClock).slice(0, MAX_TIMES).map(function (t) { return t.trim(); });
      if (times.length) out.times = times;
    }
    if (typeof raw.paused === "boolean") out.paused = raw.paused;
    if (typeof raw.advanced === "boolean") out.advanced = raw.advanced;

    if (raw.quiet && typeof raw.quiet === "object" && !Array.isArray(raw.quiet)) {
      var quiet = {};
      if (typeof raw.quiet.enabled === "boolean") quiet.enabled = raw.quiet.enabled;
      if (isClock(raw.quiet.from)) quiet.from = raw.quiet.from.trim();
      if (isClock(raw.quiet.to)) quiet.to = raw.quiet.to.trim();
      if (Object.keys(quiet).length) out.quiet = quiet;
    }

    return Object.keys(out).length ? out : null;
  }

  /**
   * Turn the raw text of a file into phrases we could add.
   *
   * Accepts what Refrain writes ({ phrases: [...] }), a bare array of
   * phrase objects, and a bare array of strings — the last so a list typed
   * by hand somewhere else can be brought in without ceremony. Entries with
   * no usable text are dropped rather than failing the whole file: one bad
   * row should not cost you the other ninety-nine. Throws only when the file
   * is not an export at all, which is the case worth telling someone about.
   */
  function parse(raw) {
    var data = JSON.parse(raw);
    var incoming = Array.isArray(data) ? data : (data && data.phrases);
    if (!Array.isArray(incoming)) throw new Error("not a Refrain export");

    var out = incoming
      .map(function (p) { return typeof p === "string" ? { text: p } : p; })
      .filter(function (p) { return p && typeof p.text === "string" && key(p.text); })
      .map(function (p) {
        return {
          text: key(p.text),
          note: typeof p.note === "string" ? p.note : "",
          muted: !!p.muted,
          // Anything unrecognised lands on anytime, matching how the app
          // reads a phrase that was written before categories existed.
          window: WINDOWS.indexOf(p.window) > 0 ? p.window : "anytime",
        };
      });

    // Settings ride along on the list rather than being returned separately,
    // so a caller that only wants phrases can keep treating this as an array.
    out.settings = Array.isArray(data) ? null : cleanSettings(data.settings);
    return out;
  }

  /**
   * Fold parsed phrases into the list already here.
   *
   * Returns the whole new list and, separately, just what was added — the
   * caller needs the count to say what happened. Phrases already present are
   * passed through untouched, not rebuilt, so nothing about them can drift.
   */
  function merge(existing, incoming, newId, now) {
    newId = newId || fallbackId;
    now = now == null ? Date.now() : now;

    var have = new Set((existing || []).map(function (p) { return key(p.text); }));
    var added = [];

    (incoming || []).forEach(function (p) {
      // Guarding against `have` rather than the original list also catches a
      // file that lists the same phrase twice, which would otherwise arrive
      // as two identical rows.
      if (have.has(p.text)) return;
      have.add(p.text);
      added.push({
        id: newId(),
        text: p.text,
        note: p.note || "",
        muted: !!p.muted,
        window: p.window || "anytime",
        createdAt: now,
      });
    });

    return { phrases: (existing || []).concat(added), added: added };
  }

  /** What an export file contains. */
  function exportPayload(state, exportedAt) {
    return {
      app: "Refrain",
      version: 1,
      exportedAt: exportedAt || new Date().toISOString(),
      phrases: state.phrases || [],
      settings: state.settings || {},
    };
  }

  root.RFTransfer = {
    cleanSettings: cleanSettings,
    parse: parse,
    merge: merge,
    exportPayload: exportPayload,
  };
})(typeof self !== "undefined" ? self : globalThis);
