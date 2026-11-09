/**
 * Checks the import/export contract: an import adds back what you do not
 * already have and leaves everything else exactly as it was.
 * Run with: node test/transfer.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { console, Date, Math, Object, String, JSON, Array, Set, Boolean, isNaN, parseInt };
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../lib/transfer.js"), "utf8"), ctx);
const Transfer = ctx.RFTransfer;

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

/** Predictable ids so a failure is reproducible. */
function counter() {
  let n = 0;
  return function () { return "new-" + ++n; };
}

function phrase(text, extra) {
  return Object.assign({ id: "have-" + text, text: text, note: "", muted: false, createdAt: 1000 }, extra || {});
}

const texts = (list) => list.map((p) => p.text);

// --- parsing ------------------------------------------------------------

check("reads the object form an export writes", () => {
  const got = Transfer.parse(JSON.stringify({ app: "Refrain", version: 1, phrases: [{ text: "one" }] }));
  assert(texts(got).join() === "one", `got ${JSON.stringify(got)}`);
});

check("reads a bare array of phrase objects", () => {
  const got = Transfer.parse(JSON.stringify([{ text: "one" }, { text: "two" }]));
  assert(texts(got).join() === "one,two", `got ${JSON.stringify(got)}`);
});

check("reads a bare array of plain strings", () => {
  const got = Transfer.parse(JSON.stringify(["one", "two"]));
  assert(texts(got).join() === "one,two", `got ${JSON.stringify(got)}`);
});

check("carries note and muted across, and trims the text", () => {
  const got = Transfer.parse(JSON.stringify([{ text: "  spaced  ", note: "a note", muted: true }]));
  assert(got[0].text === "spaced", `text not trimmed: ${JSON.stringify(got[0].text)}`);
  assert(got[0].note === "a note", "note dropped");
  assert(got[0].muted === true, "muted dropped");
});

check("drops entries with no usable text instead of failing the whole file", () => {
  const got = Transfer.parse(JSON.stringify([{ text: "keep" }, { text: "   " }, {}, null, 42, { note: "x" }]));
  assert(texts(got).join() === "keep", `got ${JSON.stringify(texts(got))}`);
});

check("refuses a file that is not an export at all", () => {
  const bad = ["not json at all", JSON.stringify({ app: "Refrain" }), JSON.stringify({ phrases: "nope" }), JSON.stringify(7)];
  bad.forEach((raw) => {
    let threw = false;
    try { Transfer.parse(raw); } catch (e) { threw = true; }
    assert(threw, `accepted a file it should have refused: ${raw}`);
  });
});

// --- merging ------------------------------------------------------------

check("adds a phrase that is not already here", () => {
  const r = Transfer.merge([phrase("here")], Transfer.parse(JSON.stringify(["fresh"])), counter(), 2000);
  assert(texts(r.phrases).join() === "here,fresh", `got ${JSON.stringify(texts(r.phrases))}`);
  assert(r.added.length === 1, `expected 1 added, got ${r.added.length}`);
});

check("leaves what is already here exactly as it was", () => {
  const mine = phrase("here", { muted: true, note: "mine", createdAt: 55 });
  const r = Transfer.merge([mine], Transfer.parse(JSON.stringify([{ text: "here", muted: false, note: "theirs" }])), counter(), 2000);
  assert(r.phrases.length === 1, `import duplicated an existing phrase: ${JSON.stringify(texts(r.phrases))}`);
  assert(r.phrases[0] === mine, "an existing phrase was rewritten rather than left alone");
  assert(r.added.length === 0, "reported an addition that did not happen");
});

check("matches on trimmed text, so spacing does not smuggle a duplicate in", () => {
  const r = Transfer.merge([phrase("here")], Transfer.parse(JSON.stringify(["  here  "])), counter(), 2000);
  assert(r.added.length === 0, `whitespace created a duplicate: ${JSON.stringify(texts(r.phrases))}`);
});

check("a file that repeats a phrase still only adds it once", () => {
  const r = Transfer.merge([], Transfer.parse(JSON.stringify(["twice", "twice", " twice "])), counter(), 2000);
  assert(r.added.length === 1, `expected 1 added, got ${r.added.length}: ${JSON.stringify(texts(r.phrases))}`);
});

check("stamps each added phrase with its own id", () => {
  const r = Transfer.merge([], Transfer.parse(JSON.stringify(["a", "b", "c"])), counter(), 2000);
  const ids = r.added.map((p) => p.id);
  assert(new Set(ids).size === 3, `ids collided: ${ids}`);
  assert(r.added.every((p) => p.createdAt === 2000), "createdAt not stamped from the clock passed in");
});

check("an import that brings nothing new changes nothing", () => {
  const mine = [phrase("a"), phrase("b")];
  const r = Transfer.merge(mine, Transfer.parse(JSON.stringify(["a", "b"])), counter(), 2000);
  assert(r.added.length === 0, "reported additions");
  assert(r.phrases.length === 2 && r.phrases[0] === mine[0] && r.phrases[1] === mine[1], "the list was rebuilt for no reason");
});

check("importing into an empty list takes everything", () => {
  const r = Transfer.merge([], Transfer.parse(JSON.stringify(["a", "b"])), counter(), 2000);
  assert(texts(r.phrases).join() === "a,b", `got ${JSON.stringify(texts(r.phrases))}`);
});

check("long phrases from an older export are not silently cut", () => {
  const long = "x".repeat(300);
  const r = Transfer.merge([], Transfer.parse(JSON.stringify([long])), counter(), 2000);
  assert(r.phrases[0].text.length === 300, `import truncated a phrase to ${r.phrases[0].text.length}`);
});

check("a phrase keeps the part of the day it was pinned to", () => {
  const got = Transfer.parse(JSON.stringify([
    { text: "morning one", window: "morning" },
    { text: "evening one", window: "evening" },
    { text: "uncategorised" },
    { text: "nonsense", window: "teatime" },
  ]));
  assert(got.map((p) => p.window).join() === "morning,evening,anytime,anytime",
    `windows lost or mangled: ${JSON.stringify(got.map((p) => p.window))}`);
});

check("an imported phrase arrives in the list still pinned", () => {
  const r = Transfer.merge([], Transfer.parse(JSON.stringify([{ text: "x", window: "evening" }])), counter(), 2000);
  assert(r.phrases[0].window === "evening", `category dropped on merge: ${JSON.stringify(r.phrases[0])}`);
});

// --- settings -----------------------------------------------------------

check("the settings an export carries are read back", () => {
  const raw = JSON.stringify(Transfer.exportPayload(
    { phrases: [], settings: { intervalMs: 900000, advanced: true } }, "2026-01-01T00:00:00.000Z"));
  const got = Transfer.parse(raw);
  assert(got.settings && got.settings.intervalMs === 900000, `settings lost: ${JSON.stringify(got.settings)}`);
  assert(got.settings.advanced === true, "advanced flag lost");
});

check("a file with no settings block reads as none rather than failing", () => {
  const got = Transfer.parse(JSON.stringify(["just", "phrases"]));
  assert(got.settings === null, `expected null settings, got ${JSON.stringify(got.settings)}`);
  assert(got.length === 2, "phrases should still parse");
});

/** The settings a file with this settings block reads as. */
const read = (settings) => Transfer.parse(JSON.stringify({ phrases: ["x"], settings })).settings;

check("a full set of ordinary settings comes through unchanged", () => {
  const mine = {
    intervalMs: 2 * 60 * 60 * 1000, mode: "times", times: ["09:00", "13:00", "21:00"],
    paused: false, advanced: true, quiet: { enabled: true, from: "22:00", to: "07:00" },
  };
  assert(JSON.stringify(read(mine)) === JSON.stringify(mine), `changed in transit: ${JSON.stringify(read(mine))}`);
});

check("a setting the app could not use is dropped, and the rest still count", () => {
  // The two that did lasting damage before imports were checked: times that
  // are not a list threw in every repaint, and a 1ms gap sent on every tick.
  const got = read({ intervalMs: 1, mode: "times", times: "09:00", advanced: true });
  assert(!("intervalMs" in got), `kept a 1ms interval: ${JSON.stringify(got)}`);
  assert(!("times" in got), `kept times that are not a list: ${JSON.stringify(got)}`);
  assert(got.mode === "times" && got.advanced === true, `lost the usable settings: ${JSON.stringify(got)}`);
});

check("only a real gap between sends is accepted", () => {
  const bad = [1, 0, -900000, 60 * 1000, 25 * 60 * 60 * 1000, 1e15, "900000", null, true, [900000], {}];
  bad.forEach((v) => {
    const got = read({ intervalMs: v, advanced: true });
    assert(!("intervalMs" in got), `accepted intervalMs ${JSON.stringify(v)}`);
  });
  [15 * 60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000].forEach((v) => {
    assert(read({ intervalMs: v }).intervalMs === v, `refused an ordinary interval of ${v}`);
  });
});

check("send times keep only the entries that are times on a clock", () => {
  const got = read({ times: ["09:00", " 7:30 ", "24:00", "12:60", "noon", 900, null, ["10:00"], "21:15"] });
  assert(got.times.join() === "09:00,7:30,21:15", `got ${JSON.stringify(got.times)}`);
  assert(read({ times: ["nope", 5] }) === null, "a list with no usable time should not be kept as an empty one");
  const many = [];
  for (let i = 0; i < 500; i++) many.push("0" + (i % 10) + ":00");
  assert(read({ times: many }).times.length <= 48, "took an unbounded list of times");
});

check("quiet hours are taken field by field", () => {
  const got = read({ quiet: { enabled: true, from: "25:00", to: "07:00", extra: 1 } });
  assert(JSON.stringify(got.quiet) === JSON.stringify({ enabled: true, to: "07:00" }), `got ${JSON.stringify(got.quiet)}`);
  assert(read({ quiet: "22:00" }) === null && read({ quiet: { enabled: "yes" } }) === null, "kept quiet hours it could not read");
});

check("switches must be true or false, and a mode must be one the app has", () => {
  const got = read({ paused: "no", advanced: 1, mode: "hourly", intervalMs: 3600000 });
  assert(JSON.stringify(got) === JSON.stringify({ intervalMs: 3600000 }), `got ${JSON.stringify(got)}`);
});

check("settings the app does not know are left behind", () => {
  const got = read({ advanced: true, theme: "dark", __proto__: { polluted: true }, constructor: "x" });
  assert(JSON.stringify(got) === JSON.stringify({ advanced: true }), `got ${JSON.stringify(got)}`);
  assert(got.polluted === undefined, "took a key from the file's prototype");
});

check("a settings block that is not a set of settings reads as none", () => {
  ["fast", 7, true, ["09:00"], {}, { theme: "dark" }].forEach((v) => {
    assert(read(v) === null, `read ${JSON.stringify(v)} as settings`);
  });
});

check("a note that is not text is not carried in", () => {
  const got = Transfer.parse(JSON.stringify([{ text: "a", note: { html: "<b>" } }, { text: "b", note: 5 }, { text: "c", note: "kept" }]));
  assert(got.map((p) => p.note).join("|") === "||kept", `got ${JSON.stringify(got.map((p) => p.note))}`);
});

// --- round trip ---------------------------------------------------------

check("export then import into an empty list restores the same phrases", () => {
  const mine = [phrase("one", { window: "morning" }), phrase("two", { muted: true, window: "evening" })];
  const raw = JSON.stringify(Transfer.exportPayload({ phrases: mine, settings: { intervalMs: 900000 } }, "2026-01-01T00:00:00.000Z"));
  const r = Transfer.merge([], Transfer.parse(raw), counter(), 2000);
  assert(texts(r.phrases).join() === "one,two", `got ${JSON.stringify(texts(r.phrases))}`);
  assert(r.phrases[1].muted === true, "muted state lost on the round trip");
  assert(r.phrases[0].window === "morning" && r.phrases[1].window === "evening",
    `categories lost on the round trip: ${JSON.stringify(r.phrases.map((p) => p.window))}`);
});

check("export then import into the same list adds nothing", () => {
  const mine = [phrase("one"), phrase("two")];
  const raw = JSON.stringify(Transfer.exportPayload({ phrases: mine, settings: {} }, "2026-01-01T00:00:00.000Z"));
  const r = Transfer.merge(mine, Transfer.parse(raw), counter(), 2000);
  assert(r.added.length === 0, `re-importing your own export added ${r.added.length} phrases`);
});

check("the export names itself so an import can recognise it", () => {
  const payload = Transfer.exportPayload({ phrases: [], settings: {} }, "2026-01-01T00:00:00.000Z");
  assert(payload.app === "Refrain", "export is not labelled");
  assert(payload.exportedAt === "2026-01-01T00:00:00.000Z", "export timestamp not taken from the clock passed in");
});

console.log(failures ? "\n" + failures + " failing" : "\nall passing");
process.exit(failures ? 1 : 0);
