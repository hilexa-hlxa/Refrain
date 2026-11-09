/**
 * Checks the decisions that actually put a notification on screen: which
 * phrase fire() draws, and when tick() delivers, holds, or waits.
 *
 * These are the functions the whole app hangs off, and until this file they
 * had no coverage at all — every test was of a pure helper alongside them.
 * They need storage, so this harness stands a fake RFStore in front of them;
 * nothing here touches IndexedDB, notifications, or the DOM.
 *
 * Run with: node test/schedule.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { console, Date, Math, Object, String, JSON, Array, Set, Promise, parseInt };
ctx.self = ctx;
vm.createContext(ctx);
for (const f of ["bag.js", "pulse.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../lib", f), "utf8"), ctx);
}
const Pulse = ctx.RFPulse;

/** Storage, in memory. Reads and writes the same keys the real store does. */
function store(initial) {
  const data = Object.assign({}, initial);
  ctx.RFStore = {
    get: (k, fallback) => Promise.resolve(k in data && data[k] !== undefined ? data[k] : fallback),
    set: (k, v) => { data[k] = v; return Promise.resolve(); },
    getAll: (spec) => Promise.all(Object.keys(spec).map((k) => ctx.RFStore.get(k, spec[k])))
      .then((values) => {
        const out = {};
        Object.keys(spec).forEach((k, i) => { out[k] = values[i]; });
        return out;
      }),
  };
  return data;
}

const tests = [];
function check(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** A local-time timestamp; the minute is required, as in the other suites. */
function at(hh, mm, day) {
  if (typeof mm !== "number") throw new Error("at() needs an explicit minute");
  return new Date(2026, 2, day || 10, hh, mm, 0, 0).getTime();
}

const HOUR = 60 * 60 * 1000;
const settings = (extra) => Object.assign({ intervalMs: HOUR, paused: false, advanced: false }, extra);
const phrase = (id, window) => ({ id, text: id, note: "", muted: false, window: window || "anytime", createdAt: 1 });

// --- fire(): which phrase goes out --------------------------------------

check("fire draws a phrase and records it", async () => {
  const data = store({ phrases: [phrase("a")], settings: settings() });
  const out = await Pulse.fire("manual", at(9, 0));
  assert(out && out.phrase.id === "a", `expected phrase a, got ${JSON.stringify(out && out.phrase)}`);
  assert(data.history.length === 1 && data.history[0].id === "a", "the pulse was not written to history");
  assert(data.history[0].at === at(9, 0), "history should be stamped with the moment it fired");
  assert(data.bag && data.bag.cursor === 1, "the bag did not advance");
});

check("fire sends nothing when there is nothing to send", async () => {
  store({ phrases: [], settings: settings() });
  assert(await Pulse.fire("manual", at(9, 0)) === null, "fired with an empty library");
});

check("fire skips muted phrases", async () => {
  store({ phrases: [Object.assign(phrase("m"), { muted: true }), phrase("live")], settings: settings() });
  const out = await Pulse.fire("manual", at(9, 0));
  assert(out.phrase.id === "live", `drew the muted phrase: ${out.phrase.id}`);
});

check("fire obeys the window, even from the Pulse now button", async () => {
  // Weighted so that a fire() which ignored the window would have to be
  // lucky six times running to look correct.
  const phrases = [];
  for (let i = 0; i < 6; i++) phrases.push(phrase("morning-" + i, "morning"));
  phrases.push(phrase("evening-one", "evening"));
  for (let i = 0; i < 6; i++) {
    store({ phrases, settings: settings({ advanced: true }) });
    const out = await Pulse.fire("manual", at(20, 0));
    assert(out.phrase.id === "evening-one", `sent ${out.phrase.id} at 8pm`);
  }
});

check("fire sends nothing in the small hours with Advanced Mode on", async () => {
  store({ phrases: [phrase("any")], settings: settings({ advanced: true }) });
  assert(await Pulse.fire("scheduled", at(3, 0)) === null, "delivered a 3am pulse");
});

check("history keeps only the most recent sixty", async () => {
  const old = [];
  for (let i = 0; i < 60; i++) old.push({ id: "x", text: "x", at: i, reason: "scheduled" });
  const data = store({ phrases: [phrase("a")], settings: settings(), history: old });
  await Pulse.fire("scheduled", at(9, 0));
  assert(data.history.length === 60, `history grew to ${data.history.length}`);
  assert(data.history[0].id === "a", "the newest pulse should be first");
});

// --- tick(): when a pulse goes out --------------------------------------

check("the first tick sets a schedule rather than firing straight away", async () => {
  const data = store({ phrases: [phrase("a")], settings: settings() });
  const out = await Pulse.tick(at(9, 0));
  assert(out.delivered === null, "fired on the very first tick");
  assert(data.schedule.nextAt === at(10, 0), `next pulse should be an hour out, got ${data.schedule.nextAt}`);
});

check("a tick before the due time does nothing", async () => {
  store({ phrases: [phrase("a")], settings: settings(), schedule: { nextAt: at(10, 0), lastAt: null } });
  const out = await Pulse.tick(at(9, 30));
  assert(out.delivered === null, "fired early");
});

check("a tick at the due time delivers and books the next one", async () => {
  const data = store({ phrases: [phrase("a")], settings: settings(), schedule: { nextAt: at(10, 0), lastAt: null } });
  const out = await Pulse.tick(at(10, 0));
  assert(out.delivered && out.delivered.phrase.id === "a", "nothing delivered when due");
  assert(data.schedule.nextAt === at(11, 0), "the next pulse was not booked");
  assert(data.schedule.lastAt === at(10, 0), "lastAt not recorded");
});

check("coming back after a day away delivers one pulse, not a day's worth", async () => {
  // The promise in the README: reopening after hours away should not fire
  // twenty-four backlogged notifications.
  const data = store({ phrases: [phrase("a")], settings: settings(), schedule: { nextAt: at(10, 0), lastAt: null } });
  const out = await Pulse.tick(at(10, 0, 11));   // a day and an hour later
  assert(out.delivered, "nothing delivered after a long absence");
  assert(data.history.length === 1, `delivered ${data.history.length} pulses at once`);
  assert(data.schedule.nextAt === at(11, 0, 11), "the schedule was chased forward instead of re-anchored");
});

check("a paused app never delivers", async () => {
  const data = store({
    phrases: [phrase("a")], settings: settings({ paused: true }),
    schedule: { nextAt: at(10, 0), lastAt: null },
  });
  const out = await Pulse.tick(at(11, 0));
  assert(out.delivered === null, "delivered while paused");
  assert(!data.history, "wrote history while paused");
});

check("a pulse due inside quiet hours is pushed to when they lift", async () => {
  const data = store({
    phrases: [phrase("a")],
    settings: settings({ quiet: { enabled: true, from: "22:00", to: "07:00" } }),
    schedule: { nextAt: at(23, 0), lastAt: null },
  });
  const out = await Pulse.tick(at(23, 0));
  assert(out.delivered === null, "delivered inside the quiet window");
  assert(data.schedule.nextAt === at(7, 0, 11), `should wait for 07:00, got ${new Date(data.schedule.nextAt)}`);
});

check("with nothing suiting the hour the schedule is held, not spent", async () => {
  // Holding rather than advancing is what lets a pulse land the moment a
  // window opens, instead of an interval after it.
  const data = store({
    phrases: [phrase("morning-only", "morning")],
    settings: settings({ advanced: true }),
    schedule: { nextAt: at(20, 0), lastAt: null },
  });
  const out = await Pulse.tick(at(20, 0));
  assert(out.delivered === null, "sent an evening pulse from a morning phrase");
  assert(data.schedule.nextAt === at(20, 0), "the schedule should not move while holding");
});

check("the held pulse lands as soon as the window opens", async () => {
  const data = store({
    phrases: [phrase("morning-only", "morning")],
    settings: settings({ advanced: true }),
    schedule: { nextAt: at(20, 0), lastAt: null },
  });
  await Pulse.tick(at(20, 0));                   // held
  const out = await Pulse.tick(at(6, 0, 11));    // next morning
  assert(out.delivered && out.delivered.phrase.id === "morning-only", "the held pulse never arrived");
  assert(data.schedule.nextAt === at(7, 0, 11), "the schedule did not restart from the delivery");
});

// --- tick(): sending at set times ----------------------------------------

const onTimes = (list, extra) => settings(Object.assign({ mode: "times", times: list }, extra));

check("a tick at a chosen time delivers and books the next chosen time", async () => {
  const data = store({
    phrases: [phrase("a")], settings: onTimes(["09:00", "13:00", "21:00"]),
    schedule: { nextAt: at(13, 0), lastAt: null },
  });
  const out = await Pulse.tick(at(13, 0));
  assert(out.delivered && out.delivered.phrase.id === "a", "nothing delivered at a chosen time");
  assert(data.schedule.nextAt === at(21, 0), `expected 21:00 next, got ${new Date(data.schedule.nextAt)}`);
  assert(data.schedule.lastAt === at(13, 0), "lastAt not recorded");
});

check("the last time of the day books the first of the next", async () => {
  const data = store({
    phrases: [phrase("a")], settings: onTimes(["09:00", "21:00"]),
    schedule: { nextAt: at(21, 0), lastAt: null },
  });
  await Pulse.tick(at(21, 0));
  assert(data.schedule.nextAt === at(9, 0, 11), `expected 09:00 tomorrow, got ${new Date(data.schedule.nextAt)}`);
});

check("a missed time still delivers once on return, not once per time missed", async () => {
  // The same promise the interval makes, and the reason this is a rhythm and
  // not an alarm clock: what was missed arrives when you come back, once.
  const data = store({
    phrases: [phrase("a")], settings: onTimes(["09:00", "13:00", "21:00"]),
    schedule: { nextAt: at(9, 0), lastAt: null },
  });
  const out = await Pulse.tick(at(15, 30));      // 09:00 and 13:00 both went by
  assert(out.delivered, "nothing arrived after being away");
  assert(data.history.length === 1, `delivered ${data.history.length} at once`);
  assert(data.schedule.nextAt === at(21, 0), "the schedule should re-anchor to the next time, not chase 13:00");
});

check("a chosen time inside quiet hours resumes at the next one, not when quiet lifts", async () => {
  const data = store({
    phrases: [phrase("a")],
    settings: onTimes(["23:00", "09:00"], { quiet: { enabled: true, from: "22:00", to: "07:00" } }),
    schedule: { nextAt: at(23, 0), lastAt: null },
  });
  const out = await Pulse.tick(at(23, 0));
  assert(out.delivered === null, "delivered inside the quiet window");
  assert(data.schedule.nextAt === at(9, 0, 11),
    `expected the 09:00 already on the list, got ${new Date(data.schedule.nextAt)}`);
});

check("switching to times mode with no usable list keeps the interval running", async () => {
  // Silence would look like a bug. The interval is still there; use it.
  const data = store({
    phrases: [phrase("a")], settings: onTimes([]),
    schedule: { nextAt: at(10, 0), lastAt: null },
  });
  const out = await Pulse.tick(at(10, 0));
  assert(out.delivered, "nothing delivered with an empty list of times");
  assert(data.schedule.nextAt === at(11, 0), "should have fallen back to the interval");
});

check("times mode still obeys the window and holds rather than sending the wrong phrase", async () => {
  const data = store({
    phrases: [phrase("morning-only", "morning")],
    settings: onTimes(["21:00"], { advanced: true }),
    schedule: { nextAt: at(21, 0), lastAt: null },
  });
  const out = await Pulse.tick(at(21, 0));
  assert(out.delivered === null, "sent a morning phrase at nine in the evening");
  assert(data.schedule.nextAt === at(21, 0), "the schedule should hold, not move");
});

check("an empty library holds the schedule so a first phrase pulses promptly", async () => {
  const data = store({ phrases: [], settings: settings(), schedule: { nextAt: at(10, 0), lastAt: null } });
  await Pulse.tick(at(12, 0));
  assert(data.schedule.nextAt === at(10, 0), "an empty library should not spend the schedule");
});

// --- stored settings of the wrong shape ---------------------------------

check("send times that are not a list are replaced on the way out of storage", async () => {
  // A hand-edited export once put "times": "09:00" into storage. Every
  // repaint then threw, and the app could only say storage was unavailable.
  store({ phrases: [phrase("a")], settings: settings({ mode: "times", times: "09:00" }) });
  const state = await Pulse.readState();
  assert(Array.isArray(state.settings.times) && state.settings.times.length > 0,
    `times came back as ${JSON.stringify(state.settings.times)}`);
  const out = await Pulse.tick(at(9, 30));   // would have thrown inside slotMinutes
  assert(out && out.schedule.nextAt > at(9, 30), "the schedule could not be set from repaired settings");
});

check("a gap that is not a length of time falls back to the default", async () => {
  for (const bad of ["soon", null, NaN, 0, -5, 1, Infinity]) {
    store({ phrases: [phrase("a")], settings: settings({ intervalMs: bad }) });
    const state = await Pulse.readState();
    assert(state.settings.intervalMs === Pulse.DEFAULT_SETTINGS.intervalMs,
      `intervalMs ${String(bad)} was read back as ${String(state.settings.intervalMs)}`);
  }
});

check("a stored gap of one millisecond does not send on every tick", async () => {
  // What an import carrying "intervalMs": 1 used to do: four notifications
  // in five seconds, and it never stopped.
  const data = store({ phrases: [phrase("a"), phrase("b")], settings: settings({ intervalMs: 1 }) });
  let delivered = 0;
  for (let i = 0; i < 5; i++) if ((await Pulse.tick(at(9, 0) + i * 1000)).delivered) delivered++;
  assert(delivered === 0, `delivered ${delivered} pulses in five seconds`);
  assert(data.schedule.nextAt === at(10, 0), "the first tick should have booked a send an hour out");
});

// --- two callers at once ------------------------------------------------

/** The part of the Web Locks API the scheduler uses: one holder at a time. */
function lockManager() {
  let tail = Promise.resolve();
  const names = [];
  return {
    names,
    request(name, work) {
      names.push(name);
      const run = tail.then(() => work());
      tail = run.catch(() => {});
      return run;
    },
  };
}

check("the page and the worker ticking at the same moment deliver one pulse", async () => {
  // The page hands off to the worker as it is hidden, which is just when its
  // own timer may be about to fire. Both read "due" before either has written.
  const data = store({ phrases: [phrase("a"), phrase("b")], settings: settings(), schedule: { nextAt: at(10, 0), lastAt: null } });
  ctx.navigator = { locks: lockManager() };
  try {
    const both = await Promise.all([Pulse.tick(at(10, 0)), Pulse.tick(at(10, 0))]);
    const delivered = both.filter((r) => r.delivered).length;
    assert(delivered === 1, `${delivered} of two overlapping ticks delivered`);
    assert(data.bag.cursor === 1, `the bag moved on ${data.bag.cursor} places for one send`);
    assert(ctx.navigator.locks.names.every((n) => n === "refrain-schedule"), "ticks did not share one lock");
  } finally {
    delete ctx.navigator;
  }
});

check("Send now waits its turn behind a tick already under way", async () => {
  const data = store({ phrases: [phrase("a"), phrase("b")], settings: settings(), schedule: { nextAt: at(10, 0), lastAt: null } });
  ctx.navigator = { locks: lockManager() };
  try {
    const [ticked, sent] = await Promise.all([Pulse.tick(at(10, 0)), Pulse.fire("manual", at(10, 0))]);
    assert(ticked.delivered && sent, "one of the two sends went missing");
    assert(ticked.delivered.phrase.id !== sent.phrase.id, "both sends drew the same phrase");
    assert(data.history.length === 2, `history holds ${data.history.length} entries for two sends`);
    assert(data.bag.cursor === 2, `the bag is at ${data.bag.cursor} after two sends`);
  } finally {
    delete ctx.navigator;
  }
});

// --- run ----------------------------------------------------------------

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("  ok   " + name);
    } catch (e) {
      failures++;
      console.log("  FAIL " + name + "\n       " + e.message);
    }
  }
  console.log(failures ? `\n${failures} failing` : "\nall passing");
  process.exit(failures ? 1 : 0);
})();
