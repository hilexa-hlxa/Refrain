/**
 * Refrain — the screen.
 *
 * The rules about what to send and when live in lib/pulse.js and lib/bag.js,
 * shared with the service worker. This file only reads that state, paints it,
 * and writes back what the person changes.
 */
(function () {
  "use strict";

  var Store = self.RFStore;
  var Bag = self.RFBag;
  var Pulse = self.RFPulse;
  var Transfer = self.RFTransfer;

  var MINUTE = 60 * 1000;

  // Measured on a macOS notification banner: the body renders three lines and
  // clips just past 110 characters. Under FITS_IN_NOTIFICATION a phrase is
  // certain to arrive whole; MAX_LENGTH leaves a little room above that for
  // anyone who would rather have the words than the guarantee.
  var FITS_IN_NOTIFICATION = 100;
  var MAX_LENGTH = 120;
  var INTERVALS = [
    { label: "15m", ms: 15 * MINUTE },
    { label: "30m", ms: 30 * MINUTE },
    { label: "1h", ms: 60 * MINUTE },
    { label: "2h", ms: 120 * MINUTE },
    { label: "4h", ms: 240 * MINUTE },
    { label: "8h", ms: 480 * MINUTE },
  ];

  var el = {};
  ["status", "status-text", "permit", "permit-text", "permit-btn", "last-when", "phrase",
   "timer-label", "countdown", "rail", "pulse-now", "toggle-pause", "deck", "deck-tally",
   "rhythm-label", "rhythm-summary", "rhythm-mode", "rhythm-note",
   "intervals", "times", "times-list", "times-add", "times-input",
   "quiet-on", "quiet-times", "quiet-from", "quiet-to", "library-tally",
   "mode-window", "mode-note", "advanced-on", "composer-windows",
   "list-filter", "recent", "recent-tally", "recent-list", "recent-more",
   "composer", "composer-input", "counter", "list", "empty", "delivery-note", "export", "import",
   "import-file", "toast"].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  /** Everything the screen is currently drawn from. */
  var state = null;
  var editingId = null;
  // Which window a newly written phrase gets pinned to. Resets to Anytime
  // after each one, so the picker never quietly files a phrase somewhere the
  // person had stopped thinking about.
  var composerWindow = "anytime";
  var DEFAULT_PLACEHOLDER = "Write a phrase worth hearing again";
  // Which window the phrase list is filtered to; "all" shows everything.
  var listFilter = "all";
  // How many past pulses are on screen. Sixty are kept.
  var RECENT_STEP = 8;
  var recentShown = RECENT_STEP;
  var lastRemaining = null;
  var lastDeliveredAt = null;
  var ticking = false;
  var lastTickAt = 0;

  // --- small helpers ------------------------------------------------------

  function newId() {
    if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function formatCountdown(ms) {
    if (ms < 0) ms = 0;
    var total = Math.ceil(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
  }

  function formatAgo(ts) {
    var mins = Math.round((Date.now() - ts) / MINUTE);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 minute ago";
    if (mins < 60) return mins + " minutes ago";
    var hrs = Math.round(mins / 60);
    if (hrs === 1) return "1 hour ago";
    if (hrs < 24) return hrs + " hours ago";
    var days = Math.round(hrs / 24);
    return days === 1 ? "yesterday" : days + " days ago";
  }

  function intervalLabel(ms) {
    var match = INTERVALS.filter(function (i) { return i.ms === ms; })[0];
    return match ? match.label : Math.round(ms / MINUTE) + "m";
  }

  /**
   * A stored "18:00" as this device would write it — so a reader who thinks
   * in twelve-hour time sees 6:00 PM, without the app storing anything but
   * the unambiguous form.
   */
  function clockLabel(hhmm) {
    try {
      return clockDate(hhmm).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (e) {
      return hhmm;   // a locale the browser dislikes is not worth a broken chip
    }
  }

  /** "09:00", from the minutes-of-day the scheduler works in. */
  function toClock(minutes) {
    return pad(Math.floor(minutes / 60)) + ":" + pad(minutes % 60);
  }

  /** The times currently set, normalised the way the scheduler reads them. */
  function sendTimes() {
    return Pulse.slotMinutes(state.settings.times).map(toClock);
  }

  /** How the next send reads in a toast — a gap, or a time on the clock. */
  function nextSendLabel() {
    if (!Pulse.usesTimes(state.settings)) {
      return "in " + intervalLabel(state.settings.intervalMs);
    }
    var d = new Date(Pulse.nextAfter(Date.now(), state.settings));
    return "at " + clockLabel(pad(d.getHours()) + ":" + pad(d.getMinutes()));
  }

  /** Report length against what a notification can actually show. */
  function renderCounter() {
    var length = el["composer-input"].value.trim().length;
    if (!length) {
      el.counter.textContent = "";
      el.counter.classList.remove("is-tight");
      return;
    }
    var tight = length > FITS_IN_NOTIFICATION;
    el.counter.textContent = tight
      ? length + " / " + MAX_LENGTH + " · may be cut off in the notification"
      : length + " / " + MAX_LENGTH;
    el.counter.classList.toggle("is-tight", tight);
  }

  var toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add("is-shown");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove("is-shown"); }, 3200);
  }

  function windowById(id) {
    return Pulse.WINDOWS.filter(function (w) { return w.id === id; })[0] || Pulse.WINDOWS[0];
  }

  /** The four Anytime/Morning/Afternoon/Evening chips, wherever they appear. */
  function windowChips(container, selected, onPick) {
    container.innerHTML = "";
    Pulse.WINDOWS.forEach(function (w) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip chip--window";
      chip.dataset.window = w.id;
      chip.textContent = w.label;
      chip.title = w.tone;
      chip.setAttribute("aria-pressed", String(w.id === selected));
      chip.addEventListener("click", function () { onPick(w); });
      container.appendChild(chip);
    });
  }

  function svg(paths) {
    return '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + "</svg>";
  }

  // --- reading and writing state ------------------------------------------

  function refresh() {
    return Pulse.readState().then(function (next) {
      state = next;
      render();
      return state;
    });
  }

  function saveSettings(patch) {
    var settings = Object.assign({}, state.settings, patch);
    state.settings = settings;
    return Store.set("settings", settings)
      .then(function () { return Pulse.reanchor(); })
      .then(refresh);
  }

  function savePhrases(phrases) {
    state.phrases = phrases;
    return Store.set("phrases", phrases).then(function () {
      // A first phrase should start the clock rather than wait for a tick.
      if (!state.schedule.nextAt && !state.settings.paused && phrases.length) return Pulse.reanchor();
    }).then(refresh);
  }

  // --- painting -----------------------------------------------------------

  /** What could be sent right now — in Advanced Mode, only what suits the hour. */
  function sendable() {
    return Pulse.eligible(state.phrases, new Date(), state.settings);
  }

  /** Which phrases are still to come in the cycle currently running. */
  function pendingSet() {
    var ids = sendable().map(function (p) { return p.id; });
    if (!ids.length) return new Set();
    var bag = Bag.reconcile(state.bag || Bag.emptyBag(), ids);
    var pending = bag.cursor >= bag.order.length ? bag.order : bag.order.slice(bag.cursor);
    return new Set(pending);
  }

  function renderStatus() {
    var activeCount = Pulse.active(state.phrases).length;
    var permission = typeof Notification === "undefined" ? "denied" : Notification.permission;
    var value, text;

    if (state.settings.paused) { value = "paused"; text = "Paused"; }
    else if (!activeCount) { value = "off"; text = "Idle"; }
    // Advanced Mode can leave a live library with nothing that suits the hour.
    // That is working as asked, not broken, and it should not read as "Live".
    else if (!sendable().length) { value = "waiting"; text = "Holding"; }
    else if (permission !== "granted") { value = "off"; text = "Silent"; }
    else { value = "live"; text = "Live"; }

    el.status.dataset.state = value;
    el["status-text"].textContent = text;

    el["toggle-pause"].textContent = state.settings.paused ? "Resume" : "Pause";
    el["toggle-pause"].setAttribute("aria-pressed", String(!!state.settings.paused));
    el["pulse-now"].disabled = activeCount === 0;
  }

  function renderPermit() {
    if (typeof Notification === "undefined") {
      el.permit.hidden = false;
      el["permit-text"].textContent =
        "This browser can't show notifications. Everything else works — sends appear here in the app.";
      el["permit-btn"].hidden = true;
      return;
    }
    if (Notification.permission === "granted") { el.permit.hidden = true; return; }

    el.permit.hidden = false;
    if (Notification.permission === "denied") {
      el["permit-text"].textContent =
        "Notifications are blocked for this site. Allow them in your browser's site settings, then reload.";
      el["permit-btn"].hidden = true;
    } else {
      el["permit-text"].textContent =
        "Sends arrive as notifications. Turn them on so they reach you when the app isn't in front of you.";
      el["permit-btn"].hidden = false;
    }
  }

  function renderReadout() {
    var latest = (state.history || [])[0];
    if (latest) {
      el.phrase.textContent = latest.text;
      el["last-when"].textContent = formatAgo(latest.at);
      if (lastDeliveredAt !== latest.at) {
        lastDeliveredAt = latest.at;
        el.phrase.classList.remove("is-fresh");
        void el.phrase.offsetWidth; // restart the animation
        el.phrase.classList.add("is-fresh");
      }
    } else {
      el.phrase.innerHTML = '<span class="phrase__placeholder">Nothing dealt yet.</span>';
      el["last-when"].textContent = "";
    }
  }

  /** Runs every second — the only thing on screen that moves on its own. */
  function paintClock(now) {
    var schedule = state.schedule || {};
    var paused = state.settings.paused;
    var activeCount = Pulse.active(state.phrases).length;

    if (paused || !activeCount || !schedule.nextAt) {
      el["timer-label"].textContent =
        paused ? "Paused" : !activeCount ? "Waiting for a phrase" : "Next send in";
      el.countdown.textContent = "--:--";
      el.rail.style.width = "0%";
      return;
    }

    var remainingMs = schedule.nextAt - now;
    // On set times the hour it lands on is the thing worth reading, and the
    // countdown becomes the supporting detail rather than the whole story.
    var due = new Date(schedule.nextAt);
    el["timer-label"].textContent = Pulse.usesTimes(state.settings)
      ? "Next send at " + clockLabel(pad(due.getHours()) + ":" + pad(due.getMinutes()))
      : "Next send in";
    el.countdown.textContent = formatCountdown(remainingMs);

    // On set times the rail spans the gap back to the previous one, so a
    // twelve-hour wait and a two-hour wait do not fill at the same rate.
    var span = Pulse.spanFor(schedule.nextAt, state.settings);
    var elapsed = span - remainingMs;
    var progress = Math.max(0, Math.min(1, elapsed / span));
    el.rail.style.width = (progress * 100).toFixed(2) + "%";
  }

  function renderDeck() {
    var pending = pendingSet();
    var actives = sendable();
    var remaining = pending.size;

    // The deck relights all at once when a cycle turns over, which is the
    // moment the "no repeats" promise resets. Only then is it worth animating.
    var relight = lastRemaining !== null && remaining > lastRemaining;
    lastRemaining = remaining;

    el.deck.innerHTML = "";
    actives.forEach(function (phrase, i) {
      var li = document.createElement("li");
      li.className = "tile" + (pending.has(phrase.id) ? " is-pending" : "") + (relight ? " is-relit" : "");
      li.style.setProperty("--i", i);
      el.deck.appendChild(li);
    });

    // An empty deck means two different things now: nothing written yet, or
    // nothing that suits this hour. Saying "no phrases yet" to someone who
    // has a full library and is simply between windows would be a lie.
    var live = Pulse.active(state.phrases).length;
    el.deck.dataset.empty = live ? "nothing for this window" : "no phrases yet";
    el["deck-tally"].textContent = actives.length
      ? remaining + " of " + actives.length + " left"
      : (live ? "none this window" : "empty");
  }

  function renderMode() {
    var on = !!state.settings.advanced;
    el["advanced-on"].checked = on;

    if (!on) {
      el["mode-window"].textContent = "";
      el["mode-note"].textContent =
        "Give each phrase a part of the day, and only the ones that suit the hour get sent.";
      return;
    }

    var current = Pulse.windowAt(new Date());
    var ready = sendable().length;
    var live = Pulse.active(state.phrases).length;

    el["mode-window"].textContent = (current ? windowById(current).label : "Small hours") +
      " · " + ready + " ready";

    if (!live) {
      el["mode-note"].textContent = "Write a phrase and pin it to a part of the day.";
    } else if (ready) {
      el["mode-note"].textContent = current
        ? windowById(current).tone + ". " + ready + (ready === 1 ? " phrase suits" : " phrases suit") + " this window."
        : "Between the windows — only Anytime phrases are sent until morning.";
    } else {
      // Saying nothing here would look like a bug rather than a choice.
      el["mode-note"].textContent = current
        ? "Nothing is pinned to " + windowById(current).label.toLowerCase() +
          ", so sends are holding until a window opens with something in it."
        : "Nothing is pinned to Anytime, so sends are holding until morning.";
    }
  }

  /** The picker above the composer, and the tone it asks for. */
  function renderComposer() {
    var on = !!state.settings.advanced;
    el["composer-windows"].hidden = !on;

    if (!on) {
      el["composer-input"].placeholder = DEFAULT_PLACEHOLDER;
      return;
    }
    windowChips(el["composer-windows"], composerWindow, function (w) {
      composerWindow = w.id;
      renderComposer();
      el["composer-input"].focus();
    });
    el["composer-input"].placeholder = windowById(composerWindow).placeholder;
  }

  function renderRhythm() {
    var onTimes = state.settings.mode === "times";

    el["rhythm-mode"].innerHTML = "";
    [{ id: "interval", label: "Every" }, { id: "times", label: "At set times" }].forEach(function (option) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.textContent = option.label;
      button.setAttribute("aria-pressed", String(onTimes === (option.id === "times")));
      button.addEventListener("click", function () {
        if (state.settings.mode === option.id) return;
        saveSettings({ mode: option.id }).then(function () {
          toast(option.id === "times"
            ? "Sending at the times you set — next one " + nextSendLabel() + "."
            : "Sending one every " + intervalLabel(state.settings.intervalMs) + ".");
        });
      });
      el["rhythm-mode"].appendChild(button);
    });

    el["rhythm-label"].textContent = onTimes ? "Send at" : "Send one every";
    el.intervals.hidden = onTimes;
    el.times.hidden = !onTimes;

    if (onTimes) renderTimes(); else renderIntervals();
    renderRhythmNote();

    var quiet = state.settings.quiet;
    el["quiet-on"].checked = !!quiet.enabled;
    el["quiet-times"].hidden = !quiet.enabled;
    el["quiet-from"].value = quiet.from;
    el["quiet-to"].value = quiet.to;
  }

  function renderIntervals() {
    el["rhythm-summary"].textContent = "";
    el.intervals.innerHTML = "";
    INTERVALS.forEach(function (option) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.textContent = option.label;
      button.setAttribute("aria-pressed", String(state.settings.intervalMs === option.ms));
      button.addEventListener("click", function () {
        saveSettings({ intervalMs: option.ms }).then(function () {
          toast("Sending one every " + option.label + ".");
        });
      });
      el.intervals.appendChild(button);
    });
  }

  function renderTimes() {
    var times = sendTimes();
    var quiet = state.settings.quiet;

    el["rhythm-summary"].textContent = times.length ? times.length + " a day" : "none set";

    el["times-list"].innerHTML = "";
    times.forEach(function (hhmm) {
      var buried = Pulse.inQuiet(clockDate(hhmm), quiet);

      var li = document.createElement("li");
      li.className = "time";
      if (buried) li.dataset.quiet = "true";
      li.appendChild(document.createTextNode(clockLabel(hhmm)));

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "time__remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Remove " + clockLabel(hhmm));
      // Emptying the list would drop the app back to its interval without
      // saying so, which reads as the schedule forgetting itself. Keep one.
      remove.disabled = times.length === 1;
      if (remove.disabled) remove.title = "Keep at least one send time";
      remove.addEventListener("click", function () {
        if (times.length === 1) { toast("Keep at least one send time."); return; }
        saveSettings({ times: times.filter(function (t) { return t !== hhmm; }) }).then(function () {
          toast("Removed " + clockLabel(hhmm) + ".");
        });
      });

      li.appendChild(remove);
      el["times-list"].appendChild(li);
    });
  }

  /** A Date today at a stored "HH:MM", for asking whether quiet hours cover it. */
  function clockDate(hhmm) {
    var parts = String(hhmm).split(":");
    var d = new Date();
    d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
    return d;
  }

  /**
   * What the rhythm will actually do — which is worth saying out loud only
   * where it might surprise: a time quiet hours swallows, or a list of them
   * that leaves the app with nothing it is allowed to send.
   */
  function renderRhythmNote() {
    if (!Pulse.usesTimes(state.settings)) {
      el["rhythm-note"].textContent =
        "A send lands this long after the last one, wherever that falls in the day.";
      return;
    }

    var times = sendTimes();
    var quiet = state.settings.quiet;
    var buried = times.filter(function (t) { return Pulse.inQuiet(clockDate(t), quiet); });

    if (buried.length && buried.length === times.length) {
      el["rhythm-note"].textContent =
        "Quiet hours cover every time you have set, so nothing can land at any of them. "
        + "Sends resume at " + clockLabel(quiet.to) + " until you move one or shorten the quiet window.";
      return;
    }
    if (buried.length) {
      el["rhythm-note"].textContent =
        (buried.length === 1 ? buried.map(clockLabel)[0] + " falls" : buried.length + " of these fall")
        + " inside quiet hours and " + (buried.length === 1 ? "is" : "are") + " skipped rather than "
        + "moved to " + clockLabel(quiet.to) + ".";
      return;
    }
    el["rhythm-note"].textContent =
      "Times are read off this device's clock, so they keep meaning the same hour wherever you are.";
  }

  function renderFilter() {
    var on = !!state.settings.advanced;
    el["list-filter"].hidden = !on;
    if (!on) { listFilter = "all"; return; }

    var counts = {};
    (state.phrases || []).forEach(function (p) {
      var w = Pulse.phraseWindow(p);
      counts[w] = (counts[w] || 0) + 1;
    });

    el["list-filter"].innerHTML = "";
    var options = [{ id: "all", label: "All" }].concat(Pulse.WINDOWS.map(function (w) {
      return { id: w.id, label: w.label, count: counts[w.id] || 0 };
    }));

    options.forEach(function (option) {
      // A window you have written nothing for is noise in a filter row.
      if (option.id !== "all" && !option.count && listFilter !== option.id) return;
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip chip--window";
      chip.textContent = option.id === "all"
        ? "All"
        : option.label + " " + option.count;
      chip.setAttribute("aria-pressed", String(listFilter === option.id));
      chip.addEventListener("click", function () {
        listFilter = option.id;
        render();
      });
      el["list-filter"].appendChild(chip);
    });
  }

  /** The past pulses, newest first. */
  function renderRecent() {
    var history = state.history || [];
    el.recent.hidden = !history.length;
    if (!history.length) return;

    var shown = history.slice(0, recentShown);
    el["recent-tally"].textContent = history.length === 1 ? "1 sent" : history.length + " sent";
    el["recent-list"].innerHTML = "";

    shown.forEach(function (entry) {
      var li = document.createElement("li");
      li.className = "recent__row";
      li.dataset.reason = entry.reason || "scheduled";

      var text = document.createElement("p");
      text.className = "recent__text";
      text.textContent = entry.text;

      var when = document.createElement("span");
      when.className = "recent__when";
      when.textContent = formatAgo(entry.at);

      li.append(text, when);
      el["recent-list"].appendChild(li);
    });

    el["recent-more"].hidden = history.length <= recentShown;
    el["recent-more"].textContent = "Show " + Math.min(RECENT_STEP, history.length - recentShown) + " more";
  }

  function renderLibrary() {
    // The scheduler refreshes the screen every 25 seconds. Rebuilding the
    // list under an open editor would throw away what is being typed, so
    // leave it standing until the edit is saved or cancelled.
    if (editingId !== null && el.list.querySelector(".row__edit")) return;

    var all = state.phrases || [];
    var phrases = listFilter === "all"
      ? all
      : all.filter(function (p) { return Pulse.phraseWindow(p) === listFilter; });
    var pending = pendingSet();

    el["library-tally"].textContent = listFilter === "all"
      ? String(all.length)
      : phrases.length + " of " + all.length;
    // The empty state invites a first phrase; that is only true of a genuinely
    // empty library, not of a filter that happens to match nothing.
    el.empty.hidden = all.length > 0;
    el.list.innerHTML = "";

    phrases.forEach(function (phrase) {
      var li = document.createElement("li");
      li.className = "row" +
        (phrase.muted ? " is-muted" : "") +
        (!phrase.muted && pending.has(phrase.id) ? " is-pending" : "");

      if (editingId === phrase.id) {
        li.appendChild(buildEditor(phrase));
      } else {
        var marker = document.createElement("span");
        marker.className = "row__marker";
        marker.setAttribute("aria-hidden", "true");

        var text = document.createElement("p");
        text.className = "row__text";
        text.textContent = phrase.text;

        // Only worth showing while the categories mean something.
        if (state.settings.advanced) {
          var tag = document.createElement("span");
          var pinned = Pulse.phraseWindow(phrase);
          tag.className = "row__window";
          tag.dataset.window = pinned;
          tag.textContent = windowById(pinned).label;
          text.appendChild(tag);
        }

        var actions = document.createElement("div");
        actions.className = "row__actions";
        actions.appendChild(iconButton(
          phrase.muted ? "Unmute this phrase" : "Mute this phrase",
          phrase.muted
            ? svg('<path d="M4 6a4 4 0 0 1 8 0v3l1 2H3l1-2z"/><path d="M2 2l12 12"/>')
            : svg('<path d="M4 6a4 4 0 0 1 8 0v3l1 2H3l1-2z"/><path d="M6.4 13.2a1.8 1.8 0 0 0 3.2 0"/>'),
          function () { toggleMute(phrase.id); }
        ));
        actions.appendChild(iconButton("Edit this phrase",
          svg('<path d="M11.6 2.4a1.4 1.4 0 0 1 2 2L5.4 12.6l-2.7.7.7-2.7z"/>'),
          function () { editingId = phrase.id; render(); }
        ));
        var del = iconButton("Delete this phrase",
          svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.6 4.5l.6 8.5h5.6l.6-8.5"/>'),
          function () { removePhrase(phrase.id); }
        );
        del.dataset.act = "delete";
        actions.appendChild(del);

        li.append(marker, text, actions);
      }

      el.list.appendChild(li);
    });
  }

  function iconButton(label, markup, onClick) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "iconbtn";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = markup;
    button.addEventListener("click", onClick);
    return button;
  }

  function buildEditor(phrase) {
    var wrap = document.createElement("div");
    wrap.className = "row__edit";

    var field = document.createElement("textarea");
    field.rows = 2;
    field.maxLength = MAX_LENGTH;
    field.value = phrase.text;
    field.setAttribute("aria-label", "Edit phrase");

    // The window this phrase is pinned to, changed in place while the editor
    // is open and written back only when Save is pressed.
    var picked = Pulse.phraseWindow(phrase);
    var picker = document.createElement("div");
    picker.className = "chips chips--pick";
    picker.hidden = !state.settings.advanced;
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", "When this phrase can be sent");

    function paintPicker() {
      windowChips(picker, picked, function (w) { picked = w.id; paintPicker(); });
    }
    if (state.settings.advanced) paintPicker();

    var actions = document.createElement("div");
    actions.className = "row__edit-actions";

    var save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn--solid";
    save.textContent = "Save";
    save.addEventListener("click", function () {
      var text = field.value.trim();
      if (!text) { toast("A phrase needs some words."); field.focus(); return; }
      editingId = null;
      savePhrases(state.phrases.map(function (p) {
        return p.id === phrase.id ? Object.assign({}, p, { text: text, window: picked }) : p;
      })).then(function () { toast("Phrase updated."); });
    });

    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", function () { editingId = null; render(); });

    actions.append(save, cancel);
    wrap.append(field, picker, actions);
    setTimeout(function () { field.focus(); field.selectionStart = field.value.length; }, 0);
    return wrap;
  }

  /**
   * What the app can honestly promise about delivery on this device.
   *
   * The old wording said an installed app "can deliver while it's closed too",
   * which reads as "your rhythm keeps running". It does not. Periodic
   * Background Sync is granted sparingly and throttled to something like
   * twelve hours between runs, so a closed app delivers occasionally at the
   * browser's convenience, not every 15 minutes because you asked for that.
   * On iOS the API does not exist at all. Better to say so than to let someone
   * install this expecting an alarm clock.
   */
  function renderDeliveryNote() {
    var background = "serviceWorker" in navigator && "PeriodicSyncManager" in self;
    var open = "Your phrases never leave this device. Sends arrive on your rhythm while Refrain is open, " +
      "including in a background tab, and anything missed is delivered when you come back.";
    el["delivery-note"].textContent = open + " " + (background
      ? "Installed to your home screen, this browser may also deliver the occasional one while the app is " +
        "closed — the browser decides how often, and it is far less often than the rhythm you set, so treat " +
        "it as a bonus rather than an alarm clock."
      : "While the app is closed this browser sends nothing, so keep a tab open if you want the rhythm kept.");
  }

  function render() {
    if (!state) return;
    renderStatus();
    renderPermit();
    renderReadout();
    renderDeck();
    renderMode();
    renderComposer();
    renderRhythm();
    renderFilter();
    renderLibrary();
    renderRecent();
    paintClock(Date.now());
  }

  // --- actions ------------------------------------------------------------

  function addPhrase(text) {
    var phrase = {
      id: newId(),
      text: text,
      note: "",
      muted: false,
      window: state.settings.advanced ? composerWindow : "anytime",
      createdAt: Date.now(),
    };
    return savePhrases((state.phrases || []).concat([phrase]));
  }

  function removePhrase(id) {
    if (editingId === id) editingId = null;
    var phrase = state.phrases.filter(function (p) { return p.id === id; })[0];
    savePhrases(state.phrases.filter(function (p) { return p.id !== id; })).then(function () {
      toast(phrase ? "Deleted “" + truncate(phrase.text, 32) + "”" : "Phrase deleted.");
    });
  }

  function toggleMute(id) {
    var nowMuted = null;
    var next = state.phrases.map(function (p) {
      if (p.id !== id) return p;
      nowMuted = !p.muted;
      return Object.assign({}, p, { muted: nowMuted });
    });
    savePhrases(next).then(function () {
      toast(nowMuted ? "Muted — it stays in the list but sits out." : "Back in the rotation.");
    });
  }

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
  }

  function runTick() {
    if (ticking) return Promise.resolve();
    ticking = true;
    lastTickAt = Date.now();
    return Pulse.tick().then(function () { return refresh(); })
      .catch(function () { /* a failed tick retries on the next frame */ })
      .then(function () { ticking = false; });
  }

  function requestPermission() {
    Notification.requestPermission().then(function (result) {
      renderPermit();
      renderStatus();
      if (result === "granted") {
        registerBackgroundSync();
        toast("Notifications on. Sends will arrive from here.");
      } else {
        toast("Still off — sends will only show inside the app.");
      }
    });
  }

  /**
   * Best effort only: browsers grant periodic sync sparingly, and to
   * installed apps. Everything still works without it.
   */
  function registerBackgroundSync() {
    if (!("serviceWorker" in navigator) || !("PeriodicSyncManager" in self)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      if (!reg.periodicSync) return;
      return navigator.permissions
        .query({ name: "periodic-background-sync" })
        .then(function (status) {
          if (status.state !== "granted") return;
          return reg.periodicSync.register("refrain-tick", { minInterval: 15 * MINUTE });
        });
    }).catch(function () { /* unsupported or refused — the open app still ticks */ });
  }

  function exportPhrases() {
    var payload = Transfer.exportPayload(state);
    var url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = "refrain-phrases.json";
    a.click();
    URL.revokeObjectURL(url);
    toast("Exported " + state.phrases.length + " phrases.");
  }

  /** Import adds what's missing and leaves what's already here alone. */
  function importPhrases(file) {
    file.text().then(function (raw) {
      var incoming = Transfer.parse(raw);
      var result = Transfer.merge(state.phrases, incoming, newId, Date.now());

      // An export carries the rhythm it was written under. Restoring that onto
      // a library you are already using would silently reset your interval and
      // quiet hours, which import has no business doing — so settings come
      // back only when there is nothing here to disturb.
      var restoring = incoming.settings && !(state.phrases || []).length;

      if (!result.added.length) { toast("Nothing new to add — those phrases are already here."); return; }

      return savePhrases(result.phrases)
        .then(function () { return restoring ? saveSettings(incoming.settings) : null; })
        .then(function () {
          toast("Added " + result.added.length + (result.added.length === 1 ? " phrase." : " phrases.") +
            (restoring ? " Settings restored too." : ""));
        });
    }).catch(function () {
      toast("That file isn't a Refrain export.");
    });
  }

  // --- wiring -------------------------------------------------------------

  function autoGrow(field) {
    field.style.height = "auto";
    field.style.height = field.scrollHeight + "px";
  }

  el.composer.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = el["composer-input"].value.trim();
    if (!text) return;
    addPhrase(text).then(function () {
      el["composer-input"].value = "";
      autoGrow(el["composer-input"]);
      renderCounter();
      el["composer-input"].focus();
      var where = state.settings.advanced && composerWindow !== "anytime"
        ? " Pinned to " + windowById(composerWindow).label.toLowerCase() + "."
        : "";
      composerWindow = "anytime";
      renderComposer();
      toast("Added. It's in the cycle already running." + where);
    });
  });

  el["composer-input"].addEventListener("input", function () {
    autoGrow(this);
    renderCounter();
  });
  el["composer-input"].addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      el.composer.requestSubmit();
    }
  });

  el["pulse-now"].addEventListener("click", function () {
    Pulse.fire("manual").then(function (result) {
      if (!result) { toast("Write a phrase first."); return; }
      return refresh().then(function () {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") return;
        toast("Dealt — turn on notifications to get these outside the app.");
      });
    });
  });

  el["toggle-pause"].addEventListener("click", function () {
    var paused = !state.settings.paused;
    saveSettings({ paused: paused }).then(function () {
      toast(paused ? "Paused. Nothing sends until you resume."
                   : "Running again — next one " + nextSendLabel() + ".");
    });
  });

  el["permit-btn"].addEventListener("click", requestPermission);

  el["advanced-on"].addEventListener("change", function () {
    var on = this.checked;
    composerWindow = "anytime";
    saveSettings({ advanced: on }).then(function () {
      toast(on
        ? "Advanced mode on — phrases can be pinned to a part of the day."
        : "Advanced mode off — every phrase is back in the rotation.");
    });
  });

  el["times-add"].addEventListener("submit", function (event) {
    event.preventDefault();
    var value = el["times-input"].value;
    if (!/^\d{1,2}:\d{2}$/.test(value)) { toast("Pick a time first."); return; }

    var times = sendTimes();
    var normalised = toClock(Pulse.slotMinutes([value])[0]);
    if (times.indexOf(normalised) !== -1) {
      toast(clockLabel(normalised) + " is already on the list.");
      return;
    }

    saveSettings({ times: times.concat([normalised]) }).then(function () {
      el["times-input"].value = "";
      toast("Added " + clockLabel(normalised) + " — next send " + nextSendLabel() + ".");
    });
  });

  el["quiet-on"].addEventListener("change", function () {
    var quiet = Object.assign({}, state.settings.quiet, { enabled: this.checked });
    saveSettings({ quiet: quiet }).then(function () {
      if (!quiet.enabled) { toast("Sending around the clock."); return; }
      // Quiet hours can swallow a time that was chosen on purpose. Say which
      // ones now, rather than leaving it to be worked out from the silence.
      var buried = Pulse.usesTimes(state.settings)
        ? sendTimes().filter(function (t) { return Pulse.inQuiet(clockDate(t), quiet); })
        : [];
      toast(buried.length
        ? "Overnight sends held — " + buried.map(clockLabel).join(", ") + " now skipped."
        : "Overnight sends held until " + clockLabel(quiet.to) + ".");
    });
  });

  ["quiet-from", "quiet-to"].forEach(function (id) {
    el[id].addEventListener("change", function () {
      var quiet = Object.assign({}, state.settings.quiet);
      quiet[id === "quiet-from" ? "from" : "to"] = this.value;
      saveSettings({ quiet: quiet });
    });
  });

  el["recent-more"].addEventListener("click", function () {
    recentShown += RECENT_STEP;
    renderRecent();
  });

  el.export.addEventListener("click", exportPhrases);
  el.import.addEventListener("click", function () { el["import-file"].click(); });
  el["import-file"].addEventListener("change", function () {
    if (this.files && this.files[0]) importPhrases(this.files[0]);
    this.value = "";
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      runTick();
    } else if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      // Hand the schedule to the worker on the way out.
      navigator.serviceWorker.controller.postMessage({ type: "tick" });
    }
  });

  // --- boot ---------------------------------------------------------------

  function frame() {
    if (!state) return;
    var now = Date.now();
    paintClock(now);

    var due = state.schedule.nextAt && now >= state.schedule.nextAt &&
              !state.settings.paused && Pulse.active(state.phrases).length;
    if (due || now - lastTickAt > 25000) runTick();
  }

  /**
   * Storage can simply not be there — Safari's private browsing has blocked
   * IndexedDB, and any browser can have site data switched off. The app has
   * nowhere to put phrases in that case, so say what happened rather than
   * leaving a screen that looks broken.
   */
  function reportStorageFailure() {
    el.permit.hidden = false;
    el["permit-text"].textContent =
      "Refrain can't reach this browser's storage, so it has nowhere to keep your phrases. " +
      "That usually means private browsing, or site data being blocked for this site.";
    el["permit-btn"].hidden = true;
    el["timer-label"].textContent = "Storage unavailable";
    el.countdown.textContent = "--:--";
    el["pulse-now"].disabled = true;
    el["toggle-pause"].disabled = true;
    el.export.disabled = true;
    el.import.disabled = true;

    // Writing is what fails, so close the door rather than letting someone
    // type a phrase that would silently go nowhere.
    el["composer-input"].disabled = true;
    var add = el.composer.querySelector("button[type=submit]");
    if (add) add.disabled = true;

    // These two sections only ever draw from stored state, so without it
    // they render as empty headings. Better absent than broken-looking.
    document.querySelector(".deck").hidden = true;
    document.querySelector(".rhythm").hidden = true;

    // The empty state invites you to write a first phrase; that invitation is
    // false when there is nowhere to write it to.
    el.empty.hidden = true;
  }

  refresh().then(function () {
    renderDeliveryNote();
    return runTick();
  }).catch(reportStorageFailure);

  setInterval(frame, 1000);

  if ("serviceWorker" in navigator) {
    // A new worker takes over as soon as it installs, but the page it takes
    // over is still running the old scripts it loaded from the previous
    // cache. Nothing here is unsaved, so the honest thing is to reload once
    // and be on the new version — otherwise an update only lands on the
    // visit after the one that fetched it.
    var reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").then(function () {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          registerBackgroundSync();
        }
      }).catch(function () { /* file:// or no HTTPS — the app still runs */ });
    });
  }
})();
