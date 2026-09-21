/**
 * Checks the scheduling arithmetic — mostly the overnight quiet window,
 * which wraps past midnight and is the easiest part to get subtly wrong.
 * Run with: node test/pulse.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { console, Date, Math, Object, String, parseInt, Promise, Set, Array };
ctx.self = ctx;
vm.createContext(ctx);
for (const f of ["bag.js", "pulse.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../lib", f), "utf8"), ctx);
}
const Pulse = ctx.RFPulse;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok   " + name);
  } catch (e) {
    failures++;
    console.log("  FAIL " + name + "\n       " + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * A local-time Date on an arbitrary fixed day.
 *
 * The minute is required. Omitting it would build an Invalid Date, whose
 * getHours() is NaN — which windowAt() reads as "outside every window", so a
 * test written that way would pass while checking nothing at all. Better to
 * fail on the spot than to pass for the wrong reason.
 */
function at(hh, mm, day) {
  if (typeof mm !== "number") throw new Error("at() needs an explicit minute, e.g. at(9, 0)");
  return new Date(2026, 2, day || 10, hh, mm, 0, 0);
}

const overnight = { enabled: true, from: "22:00", to: "07:00" };
const daytime = { enabled: true, from: "13:00", to: "14:00" };

check("an overnight window covers both sides of midnight", () => {
  assert(Pulse.inQuiet(at(23, 0), overnight), "23:00 should be quiet");
  assert(Pulse.inQuiet(at(3, 0), overnight), "03:00 should be quiet");
  assert(Pulse.inQuiet(at(22, 0), overnight), "22:00 starts the window");
  assert(!Pulse.inQuiet(at(21, 59), overnight), "21:59 is before the window");
  assert(!Pulse.inQuiet(at(7, 0), overnight), "07:00 ends the window");
  assert(!Pulse.inQuiet(at(12, 0), overnight), "midday is not quiet");
});

check("a same-day window stays within the day", () => {
  assert(Pulse.inQuiet(at(13, 30), daytime), "13:30 should be quiet");
  assert(!Pulse.inQuiet(at(12, 0), daytime), "12:00 is before the window");
  assert(!Pulse.inQuiet(at(14, 0), daytime), "14:00 ends the window");
});

check("a window that is off, or has no width, never applies", () => {
  assert(!Pulse.inQuiet(at(23, 0), { enabled: false, from: "22:00", to: "07:00" }), "disabled window applied");
  assert(!Pulse.inQuiet(at(23, 0), { enabled: true, from: "22:00", to: "22:00" }), "zero-width window applied");
});

check("quiet lifts at the next occurrence of the end time", () => {
  assert(Pulse.quietEnds(at(23, 0), overnight) === at(7, 0, 11).getTime(), "23:00 should lift at 07:00 tomorrow");
  assert(Pulse.quietEnds(at(3, 0), overnight) === at(7, 0).getTime(), "03:00 should lift at 07:00 today");
});

check("a pulse landing in the quiet window is held until it lifts", () => {
  const now = at(21, 30).getTime();
  const next = Pulse.nextAfter(now, { intervalMs: 60 * 60 * 1000, quiet: overnight });
  assert(next === at(7, 0, 11).getTime(), "a 22:30 pulse should be held to 07:00, got " + new Date(next));
});

check("a pulse clear of the window lands exactly one interval out", () => {
  const now = at(9, 0).getTime();
  const next = Pulse.nextAfter(now, { intervalMs: 30 * 60 * 1000, quiet: overnight });
  assert(next === at(9, 30).getTime(), "expected 09:30, got " + new Date(next));
});

check("with no quiet window the interval is the whole rule", () => {
  const now = at(23, 0).getTime();
  const next = Pulse.nextAfter(now, { intervalMs: 60 * 60 * 1000, quiet: { enabled: false } });
  assert(next === at(0, 0, 11).getTime(), "expected midnight, got " + new Date(next));
});

// --- sending at set times ------------------------------------------------

/** A local-time Date on any day, for the tests that cross one. */
function on(y, mo, d, hh, mm) {
  if (typeof mm !== "number") throw new Error("on() needs an explicit minute");
  return new Date(y, mo - 1, d, hh, mm, 0, 0);
}

const noQuiet = { enabled: false };
const times = (list, extra) => Object.assign({ mode: "times", times: list, quiet: noQuiet }, extra);

check("the list of times is sorted, de-duplicated, and cleaned of junk", () => {
  assert(Pulse.slotMinutes(["21:00", "09:00", "13:00"]).join(",") === "540,780,1260", "not sorted");
  assert(Pulse.slotMinutes(["09:00", "09:00"]).join(",") === "540", "duplicate kept");
  assert(Pulse.slotMinutes([]).length === 0, "an empty list should stay empty");
  assert(Pulse.slotMinutes(null).length === 0, "a missing list must not throw");
});

check("a hand-edited file costs you the bad entry, not the schedule", () => {
  // parse() would let these through; slotMinutes is the last line of defence,
  // and dropping the whole list would silently stop the app sending at all.
  const junk = ["09:00", "nonsense", "25:00", "", "99:99", null, "13:00"];
  assert(Pulse.slotMinutes(junk).join(",") === "540,780", `got ${Pulse.slotMinutes(junk)}`);
});

check("times mode needs both the switch and a usable list", () => {
  assert(Pulse.usesTimes(times(["09:00"])), "a real list in times mode should be used");
  assert(!Pulse.usesTimes({ mode: "interval", times: ["09:00"] }), "interval mode must ignore the list");
  assert(!Pulse.usesTimes(times([])), "an empty list must fall back to the interval");
  assert(!Pulse.usesTimes(times(["oops"])), "an unusable list must fall back to the interval");
  assert(!Pulse.usesTimes({}), "settings written before times existed read as interval");
  assert(!Pulse.usesTimes(null), "no settings at all must not throw");
});

check("the next send is the next time on the list", () => {
  const list = ["09:00", "13:00", "21:00"];
  assert(Pulse.nextSlot(at(7, 30).getTime(), list, noQuiet) === at(9, 0).getTime(), "before the first");
  assert(Pulse.nextSlot(at(9, 30).getTime(), list, noQuiet) === at(13, 0).getTime(), "between two");
  assert(Pulse.nextSlot(at(20, 59).getTime(), list, noQuiet) === at(21, 0).getTime(), "just before the last");
});

check("past the last time of the day it rolls to tomorrow's first", () => {
  const next = Pulse.nextSlot(at(22, 0).getTime(), ["09:00", "21:00"], noQuiet);
  assert(next === at(9, 0, 11).getTime(), "expected 09:00 tomorrow, got " + new Date(next));
});

check("a send lands once, not again on the same minute", () => {
  // Exactly on a chosen time means that one has just gone out, so the next
  // send is the following slot. Anything else would re-fire 09:00 forever.
  assert(Pulse.nextSlot(at(9, 0).getTime(), ["09:00", "13:00"], noQuiet) === at(13, 0).getTime(),
    "standing on a slot must look past it");
});

check("a single chosen time comes round once a day", () => {
  assert(Pulse.nextSlot(at(9, 1).getTime(), ["09:00"], noQuiet) === at(9, 0, 11).getTime(),
    "one time a day should next land tomorrow");
});

check("a chosen time inside quiet hours is skipped, not shunted to 07:00", () => {
  // The alternative — pushing it to when quiet lifts — would have quiet hours
  // rewrite a time somebody picked on purpose, and drop a send at an hour
  // that was never on the list.
  const next = Pulse.nextSlot(at(20, 0).getTime(), ["23:00", "09:00"], overnight);
  assert(next === at(9, 0, 11).getTime(), "expected 09:00 tomorrow, got " + new Date(next));
});

check("with every chosen time buried in quiet hours, sends resume when it lifts", () => {
  // A contradiction, and the screen says so where the times are edited — but
  // an app that silently never sends again is the worse of the two answers.
  const settings = times(["23:00", "02:00"], { quiet: overnight });
  assert(Pulse.nextSlot(at(20, 0).getTime(), settings.times, overnight) === null,
    "nextSlot should report the contradiction rather than guess");
  assert(Pulse.nextAfter(at(20, 0).getTime(), settings) === at(7, 0, 11).getTime(),
    "nextAfter should fall back to the moment quiet lifts");
});

check("nextAfter reads the mode, and an unusable list keeps the interval", () => {
  const now = at(9, 30).getTime();
  assert(Pulse.nextAfter(now, times(["13:00"])) === at(13, 0).getTime(), "times mode ignored");
  assert(Pulse.nextAfter(now, { mode: "interval", times: ["13:00"], intervalMs: 30 * 60 * 1000, quiet: noQuiet })
    === at(10, 0).getTime(), "interval mode should not consult the list");
  assert(Pulse.nextAfter(now, times([], { intervalMs: 30 * 60 * 1000 })) === at(10, 0).getTime(),
    "an empty list should leave the interval running rather than go silent");
});

/** Every day of 2026 in local time, so no zone's clock change is missed. */
function everyDayOf2026(visit) {
  const d = on(2026, 1, 1, 12, 0);
  while (d.getFullYear() === 2026) {
    visit(d.getMonth() + 1, d.getDate());
    d.setDate(d.getDate() + 1);
  }
}

function pad2(n) { return n < 10 ? "0" + n : String(n); }

check("a chosen time keeps its wall-clock reading across a clock change", () => {
  // Advancing a day by adding 24 hours of milliseconds lands an hour out on
  // the days the clocks move — verified: in Europe/Berlin a 09:00 send came
  // back as 10:00 on 28 March 2026 and 08:00 on 24 October. Which days those
  // are depends on the zone the test happens to run in, so this sweeps the
  // whole year; in a zone that never shifts it simply passes throughout.
  everyDayOf2026((month, day) => {
    const before = Pulse.nextSlot(on(2026, month, day, 8, 0).getTime(), ["09:00"], noQuiet);
    const after = Pulse.nextSlot(on(2026, month, day, 10, 0).getTime(), ["09:00"], noQuiet);
    [before, after].forEach((t) => {
      const d = new Date(t);
      assert(d.getHours() === 9 && d.getMinutes() === 0,
        `2026-${pad2(month)}-${pad2(day)}: a 09:00 send landed at ${d.getHours()}:${pad2(d.getMinutes())}`);
    });
    assert(after > on(2026, month, day, 10, 0).getTime(),
      `2026-${pad2(month)}-${pad2(day)}: tomorrow's send must be in the future`);
  });
});

check("quiet hours lift at the wall-clock time across a clock change too", () => {
  everyDayOf2026((month, day) => {
    const lifts = new Date(Pulse.quietEnds(on(2026, month, day, 23, 0), overnight));
    assert(lifts.getHours() === 7 && lifts.getMinutes() === 0,
      `2026-${pad2(month)}-${pad2(day)}: quiet lifted at ${lifts.getHours()}:${pad2(lifts.getMinutes())}`);
  });
});

check("the progress rail spans the real gap between two chosen times", () => {
  const list = ["09:00", "13:00", "21:00"];
  const span = (t) => Pulse.spanFor(t, times(list));
  assert(span(at(13, 0).getTime()) === 4 * 60 * 60 * 1000, "09:00 to 13:00 is four hours");
  assert(span(at(21, 0).getTime()) === 8 * 60 * 60 * 1000, "13:00 to 21:00 is eight hours");
  // The first send of the day is measured back to the last of the day before,
  // not to midnight, or the rail would jump at 00:00 every night.
  assert(span(at(9, 0, 11).getTime()) === 12 * 60 * 60 * 1000, "21:00 to 09:00 is twelve hours");
  assert(Pulse.spanFor(at(9, 0, 11).getTime(), times(["09:00"])) === 24 * 60 * 60 * 1000,
    "one time a day spans the whole day");
  assert(Pulse.spanFor(at(9, 0).getTime(), { mode: "interval", intervalMs: 1234 }) === 1234,
    "on an interval the span is just the interval");
});

check("the phrase always goes in the body, never the title", () => {
  const short = "Start badly. Fix it later.";
  const out = Pulse.splitForNotification({ text: short, note: "" });
  assert(out.body === short, "the body must carry the phrase");
  assert(out.title === "Refrain", "the title stays a short fixed label");
});

check("a long phrase reaches the body complete and unclipped", () => {
  const long = "The mood follows the action rather than the other way round, so the "
    + "way out is to start moving before you feel like starting at all.";
  const out = Pulse.splitForNotification({ text: long, note: "" });
  assert(out.body === long, "the body must carry the complete phrase");
  assert(!out.body.includes("\u2026"), "the app must not pre-truncate the phrase itself");
});

check("nothing is ever put in the narrow title field", () => {
  // Measured on macOS: the title is clipped near 29 characters. Anything
  // longer than the label would risk exactly the bug this replaced.
  const cases = ["short", "x".repeat(240), "Если будешь дохуя думать, можно и передумать"];
  cases.forEach((text) => {
    const out = Pulse.splitForNotification({ text, note: "" });
    assert(out.title.length <= 29, "title must stay inside the clip point: " + out.title);
    assert(out.body === text, "body must be the untouched phrase");
  });
});

check("a note on a phrase never reaches the narrow title field", () => {
  const out = Pulse.splitForNotification({ text: "the words that matter", note: "smuggled" });
  assert(out.title === "Refrain", `a note reached the title: ${out.title}`);
  assert(out.body === "the words that matter", "the phrase must still be the body");
});

check("the longest phrase the app accepts still arrives whole", () => {
  const max = "x".repeat(120);   // the composer's cap
  assert(Pulse.splitForNotification({ text: max, note: "" }).body === max,
    "a 120-character phrase must survive intact in the body");
});

check("phrases written before the cap was lowered are left alone", () => {
  // Existing phrases can be longer than today's limit; the app must never
  // silently shorten something already written.
  const legacy = "y".repeat(240);
  assert(Pulse.splitForNotification({ text: legacy, note: "" }).body === legacy,
    "an over-length phrase must still be delivered in full");
});

// --- time windows (Advanced Mode) ---------------------------------------

check("the clock helper refuses a call that would build an invalid date", () => {
  let threw = false;
  try { at(9); } catch (e) { threw = true; }
  assert(threw, "at(9) must throw — it would otherwise yield NaN hours and quietly pass");
  assert(at(9, 30).getHours() === 9 && at(9, 30).getMinutes() === 30, "at() lost the time it was given");
});

const plain = { advanced: false };
const advanced = { advanced: true };

check("each window claims its own hours, and the boundaries do not overlap", () => {
  const expected = [
    [6, 0, "morning"], [11, 59, "morning"],
    [12, 0, "afternoon"], [17, 59, "afternoon"],
    [18, 0, "evening"], [23, 59, "evening"],
  ];
  expected.forEach(([h, m, want]) => {
    const got = Pulse.windowAt(at(h, m));
    assert(got === want, `${h}:${m} landed in ${got}, expected ${want}`);
  });
});

check("the small hours belong to no window at all", () => {
  [[0, 0], [3, 30], [5, 59]].forEach(([h, m]) => {
    assert(Pulse.windowAt(at(h, m)) === null, `${h}:${m} should be outside every window`);
  });
});

check("a phrase with no category set counts as anytime", () => {
  assert(Pulse.phraseWindow({ text: "old" }) === "anytime", "a legacy phrase must default to anytime");
  assert(Pulse.phraseWindow({ text: "x", window: "" }) === "anytime", "an empty category must fall back");
  assert(Pulse.phraseWindow({ text: "x", window: "teatime" }) === "anytime", "an unknown category must fall back");
  assert(Pulse.phraseWindow({ text: "x", window: "morning" }) === "morning", "a real category must be kept");
});

const mixed = [
  { id: "m", text: "m", window: "morning" },
  { id: "a", text: "a", window: "afternoon" },
  { id: "e", text: "e", window: "evening" },
  { id: "any", text: "any", window: "anytime" },
  { id: "legacy", text: "legacy" },
];
const idsOf = (list) => list.map((p) => p.id).join(",");

check("with Advanced Mode off every active phrase stays eligible, whatever the hour", () => {
  [0, 7, 13, 20].forEach((h) => {
    assert(idsOf(Pulse.eligible(mixed, at(h, 0), plain)) === "m,a,e,any,legacy",
      `advanced-off filtered the pool at ${h}:00`);
  });
});

check("with Advanced Mode on only this window's phrases are eligible", () => {
  assert(idsOf(Pulse.eligible(mixed, at(8, 0), advanced)) === "m,any,legacy", "morning pool wrong");
  assert(idsOf(Pulse.eligible(mixed, at(14, 0), advanced)) === "a,any,legacy", "afternoon pool wrong");
  assert(idsOf(Pulse.eligible(mixed, at(21, 0), advanced)) === "e,any,legacy", "evening pool wrong");
});

check("nothing is sent outside the windows at all", () => {
  // Treating the small hours as an anytime window left a pool of one on a
  // thin library, and a pool of one repeats — seven identical notifications
  // in a row in simulation, which is the exact thing the bag exists to stop.
  // Nobody wants a 3am pulse either, so the small hours deliver nothing.
  [[0, 0], [3, 0], [5, 59]].forEach(([h, m]) => {
    assert(Pulse.eligible(mixed, at(h, m), advanced).length === 0,
      `${h}:${m} should send nothing, got ${idsOf(Pulse.eligible(mixed, at(h, m), advanced))}`);
  });
});

check("the small hours are quiet only in Advanced Mode", () => {
  assert(Pulse.eligible(mixed, at(3, 0), plain).length === 5,
    "with Advanced Mode off, 3am is an hour like any other");
});

check("existing phrases keep working when Advanced Mode is switched on", () => {
  // Nobody who turns this on has categorised anything yet. If that silenced
  // the app it would look broken, so an uncategorised library stays whole.
  const legacyOnly = [{ id: "1", text: "a" }, { id: "2", text: "b" }];
  [8, 14, 21].forEach((h) => {
    assert(Pulse.eligible(legacyOnly, at(h, 0), advanced).length === 2,
      `an uncategorised library went quiet at ${h}:00`);
  });
});

check("muting takes a phrase out of the pool in both modes", () => {
  const withMuted = mixed.concat([{ id: "mute", text: "m", window: "morning", muted: true }]);
  assert(!idsOf(Pulse.eligible(withMuted, at(8, 0), advanced)).includes("mute"), "muted phrase eligible in advanced mode");
  assert(!idsOf(Pulse.eligible(withMuted, at(8, 0), plain)).includes("mute"), "muted phrase eligible in plain mode");
});

check("a window with nothing in it yields an empty pool rather than falling back", () => {
  const morningOnly = [{ id: "m", text: "m", window: "morning" }];
  assert(Pulse.eligible(morningOnly, at(20, 0), advanced).length === 0,
    "evening must not borrow a morning phrase");
  assert(Pulse.eligible(morningOnly, at(8, 0), advanced).length === 1,
    "morning should still deal its own phrase");
});

check("every window offers tone guidance for the composer", () => {
  Pulse.WINDOWS.forEach((w) => {
    assert(w.label && w.tone && w.placeholder, `${w.id} is missing its guidance`);
  });
  const ids = Pulse.WINDOWS.map((w) => w.id).join(",");
  assert(ids === "anytime,morning,afternoon,evening", `unexpected window order: ${ids}`);
});

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
