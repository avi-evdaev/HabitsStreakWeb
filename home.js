import {
  db, initGate, describeFirestoreError,
  collection, doc, query, where, limit, onSnapshot, getDoc, getDocs, getDocFromCache, getDocsFromCache,
  setDoc, writeBatch,
} from "./firebase.js?v=41";
import { GOAL_DEFAULTS, readGoals } from "./goals.js?v=41";

// Before accounts existed, data lived in these shared collections. It now lives under
// users/<id>/<name>, and this page offers a one-time copy of the old data into the account.
const LEGACY_COLLECTIONS = ["habits", "nutrition", "quotes"];
const BATCH_SIZE = 400;
const POMODORO_CONFIG_KEY = "pomodoro.config";
const DEFAULT_POMODORO = { sessions: 4, focusMin: 25 };
// circumference of the two rings drawn in index.html (radius 54 and 37)
const RING_CALORIES = 2 * Math.PI * 54;
const RING_PROTEIN = 2 * Math.PI * 37;

const errorEl = document.getElementById("error");
const moveEl = document.getElementById("move");
const moveNoteEl = document.getElementById("move-note");
const quoteBoxEl = document.getElementById("home-quote");
const quoteTextEl = document.getElementById("home-quote-text");
const quoteAuthorEl = document.getElementById("home-quote-author");
const headingEl = document.getElementById("heading");
const todayLabelEl = document.getElementById("today-label");
const ringCaloriesEl = document.getElementById("ring-calories");
const ringProteinEl = document.getElementById("ring-protein");
const todayCaloriesEl = document.getElementById("today-calories");
const todayCaloriesGoalEl = document.getElementById("today-calories-goal");
const todayProteinEl = document.getElementById("today-protein");
const todayProteinGoalEl = document.getElementById("today-protein-goal");
const foodsCountEl = document.getElementById("foods-count");
const habitCountEl = document.getElementById("habit-count");
const habitBestEl = document.getElementById("habit-best");
const pomoFocusEl = document.getElementById("pomo-focus");
const pomoSessionsEl = document.getElementById("pomo-sessions");
const readPagesEl = document.getElementById("read-pages");
const readBookEl = document.getElementById("read-book");
const quotesCountEl = document.getElementById("quotes-count");

// the title before anyone signs in; put back on sign-out
const DEFAULT_HEADING = headingEl.innerHTML;
const NO_VALUE = "—";

let userId = null;
let goals = { ...GOAL_DEFAULTS };
let today = { calories: 0, protein: 0 };
let todayKey = null;
let stopToday = null;

function showError(err) {
  errorEl.textContent = typeof err === "string" ? err : describeFirestoreError(err);
  errorEl.hidden = false;
}

// Local date parts, not toISOString(): that converts to UTC and can give the wrong day.
function dateKey(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" +
         String(date.getDate()).padStart(2, "0");
}

/* ---------- the title ---------- */

function greeting(hour) {
  if (hour < 12) {
    return "Good morning,";
  }
  return hour < 18 ? "Good afternoon," : "Good evening,";
}

function showGreeting(user) {
  const firstName = (user.displayName || "").trim().split(/\s+/)[0];
  if (firstName === "") {
    return;
  }
  // text nodes, not innerHTML: a name is user input and must not be parsed as HTML.
  headingEl.replaceChildren(greeting(new Date().getHours()), document.createElement("br"), firstName);
}

function showDate() {
  todayLabelEl.textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

/* ---------- today's calories and protein ---------- */

function setRing(ringEl, fraction, circumference) {
  const shown = Math.min(Math.max(fraction, 0), 1);
  ringEl.setAttribute("stroke-dasharray", (circumference * shown).toFixed(1) + " " + circumference.toFixed(1));
}

function loggedAmount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function renderToday() {
  todayCaloriesEl.textContent = today.calories.toLocaleString("en-US");
  todayCaloriesGoalEl.textContent = " / " + goals.calorieLimit.toLocaleString("en-US");
  todayProteinEl.textContent = String(today.protein);
  todayProteinGoalEl.textContent = " / " + goals.proteinTarget + " g";
  setRing(ringCaloriesEl, today.calories / goals.calorieLimit, RING_CALORIES);
  setRing(ringProteinEl, today.protein / goals.proteinTarget, RING_PROTEIN);
}

// Live, so a meal logged on the Macros Tracker page (or another device) shows here at once.
function listenToday(id) {
  todayKey = dateKey(new Date());
  const stopDay = onSnapshot(doc(db, "users", id, "nutrition", todayKey), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    today = { calories: loggedAmount(data.calories), protein: loggedAmount(data.protein) };
    renderToday();
  }, showError);
  const stopGoals = onSnapshot(doc(db, "users", id, "meta", "settings"), (snap) => {
    goals = readGoals(snap.exists() ? snap.data() : {});
    renderToday();
  }, showError);
  return () => {
    stopDay();
    stopGoals();
  };
}

/* ---------- the other tiles ---------- */

// The local copy answers instantly. Only when nothing is stored yet (a first visit on this
// device) is the server asked, and the answer is then kept for next time.
async function readCollection(id, name) {
  const ref = collection(db, "users", id, name);
  try {
    const cached = await getDocsFromCache(ref);
    if (!cached.empty) {
      return cached;
    }
  } catch (err) {
    // no local copy yet
  }
  return getDocs(ref);
}

function plural(count, one, many) {
  return count + " " + (count === 1 ? one : many);
}

async function showFoods(id) {
  const snapshot = await readCollection(id, "foods");
  if (id === userId) {
    foodsCountEl.textContent = snapshot.size === 0 ? "No foods saved yet" : plural(snapshot.size, "food", "foods") + " saved";
  }
}

async function showHabits(id) {
  const snapshot = await readCollection(id, "habits");
  const counts = snapshot.docs.map((snap) => snap.data().count).filter((count) => Number.isInteger(count) && count >= 0);
  if (id !== userId) {
    return;
  }
  habitCountEl.textContent = String(counts.length);
  habitBestEl.textContent = counts.length === 0 ? "No habits yet" : "Best streak " + plural(Math.max(...counts), "day", "days");
}

// The Pomodoro settings are kept on this device, not in the account.
function showPomodoro() {
  let config = DEFAULT_POMODORO;
  try {
    const raw = localStorage.getItem(POMODORO_CONFIG_KEY);
    const parsed = raw === null ? null : JSON.parse(raw);
    if (parsed !== null && Number.isInteger(parsed.focusMin) && Number.isInteger(parsed.sessions)) {
      config = parsed;
    }
  } catch (err) {
    console.warn("Pomodoro settings could not be read:", err);
  }
  pomoFocusEl.textContent = String(config.focusMin);
  pomoSessionsEl.textContent = plural(config.sessions, "session", "sessions");
}

async function showReading(id) {
  const key = dateKey(new Date());
  const snapshot = await getDocs(query(collection(db, "users", id, "reading"), where("day", "==", key)));
  if (id !== userId) {
    return;
  }
  let pages = 0;
  let latest = null;
  for (const snap of snapshot.docs) {
    const data = snap.data();
    if (Number.isInteger(data.pages) && data.pages >= 0) {
      pages += data.pages;
    }
    if (typeof data.book === "string" && data.book !== "" && (latest === null || data.endedAt > latest.endedAt)) {
      latest = data;
    }
  }
  readPagesEl.textContent = String(pages);
  readBookEl.textContent = latest !== null ? latest.book : (snapshot.empty ? "No session yet today" : "");
}

function isValidQuote(data) {
  return data !== null && typeof data === "object" &&
         typeof data.text === "string" && data.text.trim() !== "" &&
         (data.author === undefined || typeof data.author === "string");
}

// Shows one of the account's quotes at random, picked again on every page load, and how many there are.
async function showQuotes(id) {
  const snapshot = await readCollection(id, "quotes");
  const quotes = snapshot.docs.map((snap) => snap.data()).filter(isValidQuote);
  // the person may have signed out while the request was running
  if (id !== userId) {
    return;
  }
  quotesCountEl.textContent = String(quotes.length);
  if (quotes.length === 0) {
    return;
  }
  const pick = quotes[Math.floor(Math.random() * quotes.length)];
  // textContent, not innerHTML: quotes are user input and must not be parsed as HTML.
  quoteTextEl.textContent = pick.text;
  quoteAuthorEl.textContent = pick.author || "";
  quoteAuthorEl.hidden = !pick.author;
  quoteBoxEl.hidden = false;
}

function resetTiles() {
  today = { calories: 0, protein: 0 };
  goals = { ...GOAL_DEFAULTS };
  renderToday();
  todayCaloriesEl.textContent = NO_VALUE;
  todayProteinEl.textContent = NO_VALUE;
  foodsCountEl.textContent = "";
  habitCountEl.textContent = NO_VALUE;
  habitBestEl.textContent = "";
  readPagesEl.textContent = NO_VALUE;
  readBookEl.textContent = "";
  quotesCountEl.textContent = NO_VALUE;
  quoteBoxEl.hidden = true;
  quoteTextEl.textContent = "";
  quoteAuthorEl.textContent = "";
}

/* ---------- one-time move of data from before accounts existed ---------- */

const migrationDoc = () => doc(db, "users", userId, "meta", "migration");

async function isMarkedDone() {
  try {
    if ((await getDocFromCache(migrationDoc())).exists()) {
      return true;
    }
  } catch (err) {
    // not stored locally yet
  }
  return (await getDoc(migrationDoc())).exists();
}

// Looks once per account. The flag document records that the question was settled, so later
// visits cost a single read instead of scanning the old collections.
async function offerMove(id) {
  if (await isMarkedDone()) {
    return;
  }

  for (const name of LEGACY_COLLECTIONS) {
    let snapshot;
    try {
      snapshot = await getDocs(query(collection(db, name), limit(1)));
    } catch (err) {
      if (err.code === "permission-denied") {
        // not the account that owns the old data, so there is nothing to move
        await setDoc(migrationDoc(), { done: true, moved: 0, at: Date.now() });
        return;
      }
      throw err;
    }
    if (!snapshot.empty) {
      if (id === userId) {
        moveEl.hidden = false;
      }
      return;
    }
  }
  // no old data anywhere: settle the question so this check never runs again
  await setDoc(migrationDoc(), { done: true, moved: 0, at: Date.now() });
}

async function moveData() {
  let moved = 0;
  for (const name of LEGACY_COLLECTIONS) {
    const snapshot = await getDocs(collection(db, name));
    // same document ids, so running this twice only rewrites the same documents
    for (let start = 0; start < snapshot.docs.length; start += BATCH_SIZE) {
      const batch = writeBatch(db);
      for (const legacy of snapshot.docs.slice(start, start + BATCH_SIZE)) {
        batch.set(doc(db, "users", userId, name, legacy.id), legacy.data());
      }
      await batch.commit();
    }
    moved += snapshot.docs.length;
  }
  await setDoc(migrationDoc(), { done: true, moved: moved, at: Date.now() });
  return moved;
}

moveEl.addEventListener("click", async () => {
  moveEl.disabled = true;
  try {
    const moved = await moveData();
    moveEl.hidden = true;
    moveNoteEl.textContent = "Moved " + moved + " item" + (moved === 1 ? "" : "s") +
                             " into your account. The old copies were left untouched.";
    moveNoteEl.hidden = false;
  } catch (err) {
    showError(err);
  } finally {
    moveEl.disabled = false;
  }
});

// a day can end while the page is open: follow the new day's numbers when the person comes back
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && userId !== null && dateKey(new Date()) !== todayKey) {
    if (stopToday !== null) {
      stopToday();
    }
    stopToday = listenToday(userId);
    showReading(userId).catch(showError);
  }
});

showDate();

initGate({
  onSignedIn(user) {
    userId = user.uid;
    showGreeting(user);
    stopToday = listenToday(user.uid);
    showPomodoro();
    offerMove(user.uid).catch(showError);
    showQuotes(user.uid).catch(showError);
    showFoods(user.uid).catch(showError);
    showHabits(user.uid).catch(showError);
    showReading(user.uid).catch(showError);
    return () => {
      userId = null;
      if (stopToday !== null) {
        stopToday();
        stopToday = null;
      }
      todayKey = null;
      headingEl.innerHTML = DEFAULT_HEADING;
      moveEl.hidden = true;
      moveNoteEl.hidden = true;
      resetTiles();
      errorEl.hidden = true;
    };
  },
});
