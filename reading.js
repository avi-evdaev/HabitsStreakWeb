import {
  db, initGate, createSaveTracker, describeFirestoreError,
  collection, doc, query, orderBy, onSnapshot, addDoc, deleteDoc,
} from "./firebase.js?v=36";
import { drawLineChart } from "./chart.js?v=36";

const RUN_KEY = "reading.run";
const MAX_PAGES = 5000;
const MAX_BOOK = 120;
const CHART_DAYS = 14;
const RECENT_SESSIONS = 20;
const TICK_MS = 500;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const setupEl = document.getElementById("setup");
const runningEl = document.getElementById("running");
const bookEl = document.getElementById("book");
const booksEl = document.getElementById("books");
const startEl = document.getElementById("start");
const runningBookEl = document.getElementById("running-book");
const timerEl = document.getElementById("timer");
const pauseEl = document.getElementById("pause");
const finishEl = document.getElementById("finish");
const discardEl = document.getElementById("discard");
const totalPagesEl = document.getElementById("total-pages");
const totalTimeEl = document.getElementById("total-time");
const paceEl = document.getElementById("pace");
const chartEl = document.getElementById("chart");
const listEl = document.getElementById("session-list");
const emptyEl = document.getElementById("sessions-empty");
const errorEl = document.getElementById("error");
const statusEl = document.getElementById("status");
const dialogEl = document.getElementById("finish-dialog");
const dialogFormEl = document.getElementById("finish-form");
const dialogNoteEl = document.getElementById("finish-note");
const dialogBookEl = document.getElementById("finish-book");
const dialogPagesEl = document.getElementById("finish-pages");
const dialogErrorEl = document.getElementById("finish-error");
const dialogCancelEl = document.getElementById("finish-cancel");

// One document per finished session, under the signed-in person's own path:
// { book, pages, seconds, endedAt, day }. The security rules keep every account to its own data.
let userId = null;
const sessionsCollection = () => collection(db, "users", userId, "reading");
const sessionDoc = (id) => doc(db, "users", userId, "reading", id);
const saves = createSaveTracker(statusEl, showError);

let sessions = [];  // oldest first
let run = loadRun();
let tickTimer = null;

function showError(err) {
  errorEl.textContent = typeof err === "string" ? err : describeFirestoreError(err);
  errorEl.hidden = false;
}

/* ---------- the session being read right now: kept on this device, so a reload does not lose it ---------- */

function isValidRun(candidate) {
  return candidate !== null && typeof candidate === "object" &&
         typeof candidate.book === "string" &&
         Number.isFinite(candidate.accumulatedMs) && candidate.accumulatedMs >= 0 &&
         typeof candidate.paused === "boolean" &&
         (candidate.paused || Number.isFinite(candidate.startedAt));
}

function loadRun() {
  let raw;
  try {
    raw = localStorage.getItem(RUN_KEY);
  } catch (err) {
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isValidRun(parsed)) {
      throw new Error("unexpected data shape");
    }
    return parsed;
  } catch (err) {
    showError("A saved reading session could not be read and was discarded.");
    try {
      localStorage.removeItem(RUN_KEY);
    } catch (removeErr) {
      console.error("Could not clear the unreadable session:", removeErr);
    }
    return null;
  }
}

function saveRun() {
  try {
    if (run === null) {
      localStorage.removeItem(RUN_KEY);
    } else {
      localStorage.setItem(RUN_KEY, JSON.stringify(run));
    }
  } catch (err) {
    showError("Could not keep the running session on this device: " + err.message);
  }
}

// Time is worked out from timestamps, not by adding up ticks: a locked phone or a background tab
// pauses timers, but the clock keeps going.
function elapsedMs() {
  return run.accumulatedMs + (run.paused ? 0 : Math.max(0, Date.now() - run.startedAt));
}

function pad(number) {
  return String(number).padStart(2, "0");
}

function formatTimer(ms) {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? hours + ":" + pad(minutes) + ":" + pad(seconds) : pad(minutes) + ":" + pad(seconds);
}

// "25 min", "1 h 05 min". Anything under a minute still shows as 1 min, never "0 min".
function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) {
    return minutes + " min";
  }
  return Math.floor(minutes / 60) + " h " + pad(minutes % 60) + " min";
}

function renderRun() {
  const active = run !== null;
  setupEl.hidden = active;
  runningEl.hidden = !active;
  if (!active) {
    document.title = "Reading Session";
    return;
  }
  const text = formatTimer(elapsedMs());
  timerEl.textContent = text;
  timerEl.classList.toggle("paused", run.paused);
  runningBookEl.textContent = run.book === "" ? "No book chosen" : run.book;
  pauseEl.textContent = run.paused ? "Resume" : "Pause";
  // the tab title doubles as a timer when the page is in the background
  document.title = text + " reading";
}

function tick() {
  if (run !== null && !run.paused) {
    renderRun();
  }
}

function startTicking() {
  if (tickTimer === null) {
    tickTimer = setInterval(tick, TICK_MS);
  }
}

function stopTicking() {
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

startEl.addEventListener("click", () => {
  run = { book: bookEl.value.trim().slice(0, MAX_BOOK), startedAt: Date.now(), accumulatedMs: 0, paused: false };
  saveRun();
  startTicking();
  renderRun();
});

pauseEl.addEventListener("click", () => {
  if (run === null) {
    return;
  }
  if (run.paused) {
    run.startedAt = Date.now();
    run.paused = false;
    startTicking();
  } else {
    run.accumulatedMs = elapsedMs();
    run.startedAt = null;
    run.paused = true;
    stopTicking();
  }
  saveRun();
  renderRun();
});

discardEl.addEventListener("click", () => {
  if (run !== null && confirm("Discard this session? The time will not be saved.")) {
    run = null;
    saveRun();
    stopTicking();
    renderRun();
  }
});

/* ---------- finishing a session: ask for the pages ---------- */

function showDialogError(message) {
  dialogErrorEl.textContent = message;
  dialogErrorEl.hidden = false;
}

// Finishing stops the clock first, so the time spent typing the pages is not counted.
finishEl.addEventListener("click", () => {
  if (run === null) {
    return;
  }
  if (!run.paused) {
    run.accumulatedMs = elapsedMs();
    run.startedAt = null;
    run.paused = true;
    stopTicking();
    saveRun();
    renderRun();
  }
  dialogNoteEl.textContent = "You read for " + formatDuration(run.accumulatedMs / 1000) + ".";
  dialogBookEl.value = run.book;
  dialogPagesEl.value = "";
  dialogErrorEl.hidden = true;
  dialogEl.showModal();
  dialogPagesEl.focus();
});

dialogFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  if (run === null) {
    return;
  }
  const text = dialogPagesEl.value.trim();
  const pages = Number(text);
  if (dialogPagesEl.validity.badInput || text === "" || !Number.isInteger(pages) || pages < 0 || pages > MAX_PAGES) {
    showDialogError("Pages read: a whole number from 0 to " + MAX_PAGES + ".");
    return;
  }
  const book = dialogBookEl.value.trim();
  if (book.length > MAX_BOOK) {
    showDialogError("The book name can have up to " + MAX_BOOK + " characters.");
    return;
  }

  saves.track(addDoc(sessionsCollection(), {
    book: book,
    pages: pages,
    seconds: Math.max(1, Math.round(run.accumulatedMs / 1000)),
    endedAt: Date.now(),
    day: dayKey(0),
  }));
  run = null;
  saveRun();
  stopTicking();
  bookEl.value = book;  // the next session starts on the same book
  dialogEl.close();
  renderRun();
});

dialogCancelEl.addEventListener("click", () => dialogEl.close());
dialogEl.addEventListener("click", (event) => {
  if (event.target === dialogEl) {
    dialogEl.close();
  }
});

/* ---------- dates ---------- */

// Local date parts, not toISOString(): that converts to UTC and can give the wrong day.
function dayKey(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function labelFromKey(key) {
  const [, month, day] = key.split("-");
  return Number(day) + " " + MONTH_NAMES[Number(month) - 1];
}

/* ---------- sessions from the database ---------- */

function sessionFromData(id, data) {
  const valid = data !== null && typeof data === "object" &&
    typeof data.book === "string" && data.book.length <= MAX_BOOK &&
    Number.isInteger(data.pages) && data.pages >= 0 && data.pages <= MAX_PAGES &&
    Number.isInteger(data.seconds) && data.seconds >= 1 &&
    Number.isFinite(data.endedAt) &&
    typeof data.day === "string" && DATE_KEY_PATTERN.test(data.day);
  return valid ? { id: id, book: data.book, pages: data.pages, seconds: data.seconds, day: data.day } : null;
}

function listen() {
  const sessionsQuery = query(sessionsCollection(), orderBy("endedAt"));
  return onSnapshot(sessionsQuery, (snapshot) => {
    sessions = [];
    for (const snap of snapshot.docs) {
      const session = sessionFromData(snap.id, snap.data());
      if (session !== null) {
        sessions.push(session);
      } else {
        console.warn("Skipping malformed reading session", snap.id);
      }
    }
    renderSessions();
    saves.show();
  }, showError);
}

function renderTotals() {
  let pages = 0;
  let seconds = 0;
  for (const session of sessions) {
    pages += session.pages;
    seconds += session.seconds;
  }
  const any = sessions.length > 0;
  totalPagesEl.textContent = any ? String(pages) : "—";
  totalTimeEl.textContent = any ? formatDuration(seconds) : "—";
  // a pace over a few seconds would be noise, so it waits for a full minute of reading
  paceEl.textContent = seconds >= 60 ? (pages / (seconds / 3600)).toFixed(1) : "—";
}

function renderChart() {
  const keys = [];
  for (let back = CHART_DAYS - 1; back >= 0; back -= 1) {
    keys.push(dayKey(-back));
  }
  const labels = keys.map(labelFromKey);
  const pagesByDay = {};
  const secondsByDay = {};
  for (const session of sessions) {
    pagesByDay[session.day] = (pagesByDay[session.day] || 0) + session.pages;
    secondsByDay[session.day] = (secondsByDay[session.day] || 0) + session.seconds;
  }
  // With no sessions at all the chart shows its empty note; once there are some, a day without
  // reading is a real zero.
  const any = sessions.length > 0;
  const pages = keys.map((key) => (any ? pagesByDay[key] || 0 : null));
  const minutes = keys.map((key) => (any ? Math.round((secondsByDay[key] || 0) / 60) : null));

  drawLineChart(chartEl, {
    labels: labels,
    emptyMax: 60,
    minMax: 20,
    emptyText: "No sessions yet",
    series: [
      { name: "pages", values: pages, tip: (index) => labels[index] + ": " + pages[index] + " pages" },
      { name: "minutes", values: minutes, tip: (index) => labels[index] + ": " + minutes[index] + " min" },
    ],
  });
}

function describeSession(session) {
  const parts = [labelFromKey(session.day), formatDuration(session.seconds),
                 session.pages + (session.pages === 1 ? " page" : " pages")];
  if (session.seconds >= 60 && session.pages > 0) {
    parts.push((session.pages / (session.seconds / 3600)).toFixed(1) + " pages/h");
  }
  return parts.join(" · ");
}

function renderList() {
  listEl.replaceChildren();
  // newest first, so the session you just saved is at the top
  for (const session of [...sessions].reverse().slice(0, RECENT_SESSIONS)) {
    const row = document.createElement("li");

    const name = document.createElement("div");
    name.className = "name";
    // textContent, not innerHTML: book names are user input and must not be parsed as HTML.
    const title = document.createElement("span");
    title.className = "title";
    title.dir = "auto";  // a Hebrew title reads right-to-left
    title.textContent = session.book === "" ? "No book" : session.book;
    const sub = document.createElement("small");
    sub.className = "sub";
    sub.textContent = describeSession(session);
    name.append(title, sub);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon del";
    remove.setAttribute("aria-label", "Delete this session");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      if (confirm("Delete this session? Its pages and time are removed from your totals.")) {
        saves.track(deleteDoc(sessionDoc(session.id)));
      }
    });

    row.append(name, remove);
    listEl.append(row);
  }
  emptyEl.hidden = sessions.length > 0;
}

// Books you have read before, offered while typing a book name
function renderBookChoices() {
  booksEl.replaceChildren();
  const seen = new Set();
  for (const session of [...sessions].reverse()) {
    if (session.book !== "" && !seen.has(session.book)) {
      seen.add(session.book);
      const option = document.createElement("option");
      option.value = session.book;
      booksEl.append(option);
    }
  }
}

function renderSessions() {
  renderTotals();
  renderChart();
  renderList();
  renderBookChoices();
}

// the clock kept running while the page was hidden: show the right time the moment it is back
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    renderRun();
  }
});

if (run !== null && !run.paused) {
  startTicking();
}
renderRun();

initGate({
  onSignedIn(user) {
    userId = user.uid;
    renderSessions();
    const unsubscribe = listen();
    return () => {
      unsubscribe();
      if (dialogEl.open) {
        dialogEl.close();
      }
      userId = null;
      // drop the data from memory and screen when signing out, and end any session in progress
      sessions = [];
      run = null;
      saveRun();
      stopTicking();
      renderRun();
      renderSessions();
    };
  },
});
