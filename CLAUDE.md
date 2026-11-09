# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm start                    # python3 -m http.server 8123 — then open http://127.0.0.1:8123
npm test                     # runs all four suites
node test/bag.test.js        # one suite on its own
node test/pulse.test.js
node test/transfer.test.js
node test/schedule.test.js
```

There is no build step, no bundler, no linter, and no npm dependencies — `package.json` exists only for those two scripts. Editing a file and reloading the page is the whole loop.

Notifications and the service worker need a secure context: `localhost` or HTTPS. Opening `index.html` as `file://` renders the app but silently skips service worker registration.

## Architecture

A static local-first PWA. Phrases live in IndexedDB on the device and are never sent anywhere; there is no server component to deploy.

**The one structural constraint: `lib/` is shared between the page and the service worker.** `index.html` loads `lib/idb.js`, `lib/bag.js`, `lib/pulse.js` with `<script>` tags, and `sw.js` loads the same three with `importScripts()`. (`lib/transfer.js` is page-only — import/export has no meaning in the worker — so it is in the `SHELL` cache list but not in `importScripts`.) This is why they are classic IIFE scripts attaching globals to `self` (`RFStore`, `RFBag`, `RFPulse`, `RFTransfer`) rather than ES modules. Anything in `lib/` must therefore:

- work in both a window and a worker (no `document`/`window` at load time — the tests also load these files into a bare `vm` context)
- respect load order: `idb.js` → `bag.js` → `pulse.js` → `transfer.js` → `app.js`

The payoff is that a pulse delivered while the app is closed is drawn by exactly the same code as one delivered while it is open.

**Layers.** `lib/bag.js` and `lib/pulse.js` hold every decision about *which* phrase and *when*; `app.js` only reads that state, paints it, and writes back edits. Keep new scheduling or selection logic in `lib/`, not in `app.js`.

**Advanced Mode** (`settings.advanced`, default `false`) narrows the pool by time of day. `Pulse.WINDOWS` is the single source for the four categories — id, label, hours, and the composer's tone guidance all live there, so adding or retuning a window is one edit. A phrase's category is `phrase.window`; anything missing or unrecognised reads as `"anytime"` via `Pulse.phraseWindow`, which is what keeps pre-existing libraries working. `Pulse.eligible(phrases, when, settings)` is the only thing that should decide what may be sent — `fire`, `tick`, and every count on screen go through it. When it returns nothing, `tick` deliberately *holds* the schedule instead of advancing it, so a pulse lands as soon as a window opens. Outside the three windows (00:00–06:00) it returns nothing at all: filling the small hours with Anytime phrases leaves a pool of one on a thin library, and a pool of one repeats, which breaks the app's central promise.

**Rhythm modes** (`settings.mode`, `"interval"` or `"times"`, default `"interval"`). `nextAfter(now, settings)` is the only place the choice is read, and `Pulse.usesTimes(settings)` the only test for it — it requires both the mode *and* a usable list, so an empty or corrupt `settings.times` falls back to the interval rather than going silent. Times are stored as local wall-clock `"HH:MM"` strings and normalised by `Pulse.slotMinutes`, which drops unparseable entries; there is deliberately no timezone field anywhere, because a wall-clock time already means the right hour on whatever device reads it. **Build dates with `atClock()`, never by adding `24 * 60 * MINUTE`** — the millisecond arithmetic lands an hour out on the two days a year the clocks move, and `test/pulse.test.js` sweeps a full year to catch exactly that. A chosen time inside quiet hours is *skipped*, not pushed to when quiet lifts; only when quiet covers every chosen time does `nextAfter` fall back to `quietEnds`.

**State** is a flat key/value store in IndexedDB (db `mindpulse` — kept from before the app was renamed to Refrain, so installed copies don't lose their saved phrases; nothing outside `lib/idb.js` reads the name — store `kv`) under the keys `phrases`, `settings`, `bag`, `schedule`, `history`. `RFPulse.readState()` is the single reader: it declares defaults in `STATE_SPEC` and re-fills missing settings fields via `Object.assign`, which is how older stored state is migrated forward. Add a new setting by extending `DEFAULT_SETTINGS` — stored objects will pick it up. **Then add it to `cleanSettings` in `lib/transfer.js` as well**: an import keeps only the settings named there, each checked for type and range, so a setting missing from that list exports fine and is silently dropped on the way back in. `readState()` also repairs the two stored values that can do lasting harm if malformed (`intervalMs`, `times`); anything new that the scheduler trusts on every tick belongs there too.

**Pure modules take their dependencies as arguments.** `lib/bag.js` takes `rnd`; `lib/transfer.js` takes an id source and a clock. That is what makes them testable without a DOM, a database, or a fake timer — follow it for anything new in `lib/`.

**The shuffle bag** (`lib/bag.js`) is pure: every function takes state and returns new state, and `rnd` is injectable so tests run against a seeded sequence. `bag = { order, cursor, last }`. `reconcile()` folds list edits into an in-flight cycle; `refill()` avoids opening a cycle with the id the last one closed on.

**What drives `tick()`:** a 1-second `setInterval` in the page, a `visibilitychange` handler that hands off to the worker with `postMessage({type:"tick"})` when the page hides, and a `periodicsync` event tagged `refrain-tick` in `sw.js`. `tick()` delivers at most one pulse no matter how far behind the schedule is — it re-anchors `nextAt` to now rather than chasing missed slots. Preserve that when touching it.

**The page and the worker can tick at the same moment**, so the three exported entry points — `fire`, `tick`, `reanchor` — each run inside one Web Lock (`exclusive()` in `lib/pulse.js`). Web Locks are not re-entrant: code that already holds the lock must call the plain functions underneath (`deal`, `advance`, `restart`), never the exported wrappers, or it will wait on itself forever. Where there is no lock manager (older browsers, and the tests' bare `vm` context) the work just runs.

**Notifications:** the phrase always goes in the body, never the title (the title is one unexpandable line clipped near 29–36 characters). `test/pulse.test.js` asserts this directly; the 100/120-character constants in `app.js` are measured against what a notification body actually shows.

## Conventions that bite

- **Bump `CACHE` in `sw.js`** (currently `refrain-shell-v17`) whenever a shell file changes, and add any new file to the `SHELL` array — otherwise returning visitors keep the old copy. The page reloads itself once on `controllerchange` so an update lands on the visit that fetched it. Everything is served cache-first, `index.html` included, so the bump is the *only* thing that delivers a change promptly: without it a visitor gets the old shell on their next visit and the new one on the visit after.
- **Every path is relative** (`./`, `lib/...`, `icons/...`) so the app works served from a subdirectory. Do not introduce root-absolute paths.
- **The CSP in `index.html` is `'self'`-only** — no CDN, no external fonts, no analytics, no inline `<script>`, and no `style=""` attributes or `<style>` blocks either. Style from classes in `styles.css`, or set a property from script (`el.style.width = …`), which the policy does not count as inline. Markup built as a string with a `style` attribute in it will be silently unstyled. New code must be a same-origin file.
- **`test/schedule.test.js` is where the decision path is covered.** It stands a fake in-memory `RFStore` in front of `fire`/`tick`, so anything touching storage can be tested without IndexedDB. Put new scheduling behaviour there rather than leaving it to manual checking — that gap is how two shipped defects got through.
- **Tests are plain Node with no framework**: a hand-rolled `check`/`assert` pair, a seeded PRNG, and `vm.runInContext` over the raw `lib/` source. Follow that shape rather than adding a test runner.
- `.venv/` and `.env` are leftovers from a deleted server build and are gitignored; ignore them.
