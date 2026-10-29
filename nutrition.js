import {
  db, initGate, createSaveTracker, describeFirestoreError,
  collection, doc, query, limit, onSnapshot, getDoc, getDocs, getDocFromCache, setDoc, writeBatch,
  increment,
} from "./firebase.js?v=33";
import { drawLineChart } from "./chart.js?v=33";

// Where this page kept its data before it moved to the database
const LEGACY_KEY = "nutrition.log";
// The first account's start day. The year only keys the stored data; the table shows just day
// and month. Accounts that already hold entries from before start dates were per account keep it.
const DEFAULT_START = { year: 2026, month: 10, day: 26 };
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FIELDS = ["calories", "protein"];
const MAX_AMOUNT = { calories: 20000, protein: 1000 };
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Typing saves after this pause, so one entry like "2150" is one write, not four.
const SAVE_DELAY_MS = 700;
const IMPORT_CHUNK = 400;
// Protein (g) is drawn x10 so its line lands next to the calorie line on the same axis.
const PROTEIN_SCALE = 10;
// Top value used to size the empty chart's axis (calories, before any data exists)
const EMPTY_CHART_MAX = 2500;

const wrapEl = document.getElementById("table-wrap");
const rowsEl = document.getElementById("rows");
const errorEl = document.getElementById("error");
const importEl = document.getElementById("import");
const statusEl = document.getElementById("status");
const avgCaloriesEl = document.getElementById("avg-calories");
const avgProteinEl = document.getElementById("avg-protein");
const daysLoggedEl = document.getElementById("days-logged");
const chartEl = document.getElementById("chart");
const logDialogEl = document.getElementById("log-dialog");
const logFormEl = document.getElementById("log-form");
const logCaloriesEl = document.getElementById("log-calories");
const logProteinEl = document.getElementById("log-protein");
const logErrorEl = document.getElementById("log-error");
const logCancelEl = document.getElementById("log-cancel");

// one document per day, named by its date key; fields: calories, protein (number or null)
let userId = null;  // set when sign-in completes; everything lives under users/<id>/
const nutritionCollection = () => collection(db, "users", userId, "nutrition");
const nutritionDoc = (key) => doc(db, "users", userId, "nutrition", key);

// Every account has its own first day. A brand-new account starts on the day it first opens
// this page; one that already has entries keeps the original start date. The choice is saved
// once, so the first day never moves and later visits read it from the local copy.
let start = DEFAULT_START;
const startRef = () => doc(db, "users", userId, "meta", "nutrition");

function isValidStart(data) {
  return data !== null && typeof data === "object" &&
         Number.isInteger(data.year) && Number.isInteger(data.month) && Number.isInteger(data.day) &&
         data.month >= 1 && data.month <= 12 && data.day >= 1 && data.day <= 31;
}

async function loadStart() {
  let stored = null;
  try {
    const cached = await getDocFromCache(startRef());
    if (cached.exists()) {
      stored = cached.data();
    }
  } catch (err) {
    // not stored locally yet
  }
  if (stored === null) {
    const fromServer = await getDoc(startRef());
    if (fromServer.exists()) {
      stored = fromServer.data();
    }
  }
  if (isValidStart(stored)) {
    return { year: stored.year, month: stored.month, day: stored.day };
  }

  const existing = await getDocs(query(nutritionCollection(), limit(1)));
  let chosen = DEFAULT_START;
  if (existing.empty) {
    const now = new Date();
    chosen = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }
  saves.track(setDoc(startRef(), chosen));
  return chosen;
}
const saves = createSaveTracker(statusEl, showError);

let log = {};              // what the database last told us (plus our own sent edits)
const drafts = new Map();  // typed but not yet sent, keyed "date|field"
let shownKeys = [];
let renderedToday = null;

function showError(err) {
  errorEl.textContent = typeof err === "string" ? err : describeFirestoreError(err);
  errorEl.hidden = false;
}

/* ---------- data ---------- */

function isValidAmount(field, value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_AMOUNT[field];
}

// Turns a stored document into { calories, protein }, or null if any field is invalid.
// A missing field means "not logged", so a partly filled day is fine.
function toEntry(data) {
  const entry = { calories: null, protein: null };
  for (const field of FIELDS) {
    const value = data[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (!isValidAmount(field, value)) {
      return null;
    }
    entry[field] = value;
  }
  return entry;
}

function draftId(key, field) {
  return key + "|" + field;
}

function savedAmount(key, field) {
  const entry = log[key];
  return entry ? entry[field] : null;
}

// What the person sees: an unsent edit wins over saved data.
function amountOf(key, field) {
  const draft = drafts.get(draftId(key, field));
  return draft ? draft.value : savedAmount(key, field);
}

function applySnapshot(snapshot) {
  const next = {};
  for (const snap of snapshot.docs) {
    const entry = DATE_KEY_PATTERN.test(snap.id) ? toEntry(snap.data()) : null;
    if (entry !== null) {
      next[snap.id] = entry;
    } else {
      console.warn("Skipping malformed nutrition document", snap.id);
    }
  }
  log = next;
  syncInputs();
  renderStats();
  saves.show();
}

// Updates the fields from the data without rebuilding the table, and never touches the field
// being typed in, so a change from another device can't make the cursor jump.
function syncInputs() {
  for (const input of rowsEl.querySelectorAll("input")) {
    const key = input.closest("tr").dataset.key;
    const field = input.dataset.field;
    if (input === document.activeElement || drafts.has(draftId(key, field))) {
      continue;
    }
    const amount = amountOf(key, field);
    input.value = amount === null ? "" : amount;
  }
}

function sendDraft(id) {
  const draft = drafts.get(id);
  if (draft === undefined) {
    return;
  }
  clearTimeout(draft.timer);
  drafts.delete(id);

  // Update our copy first so the stats and the field don't flash the old value while the
  // database round-trips.
  const entry = log[draft.key] || { calories: null, protein: null };
  entry[draft.field] = draft.value;
  log[draft.key] = entry;

  // Write only the changed field (merge), so editing calories can never wipe protein that
  // another device just saved.
  saves.track(setDoc(nutritionDoc(draft.key), { [draft.field]: draft.value }, { merge: true }));
}

function queueSave(key, field, value, immediately) {
  const id = draftId(key, field);
  const existing = drafts.get(id);
  if (existing !== undefined) {
    clearTimeout(existing.timer);
    drafts.delete(id);
  }
  if (value === savedAmount(key, field)) {
    return;  // back to what is already saved, nothing to send
  }

  const draft = { key: key, field: field, value: value, timer: null };
  drafts.set(id, draft);
  if (immediately) {
    sendDraft(id);
  } else {
    draft.timer = setTimeout(() => sendDraft(id), SAVE_DELAY_MS);
  }
}

function flushDrafts() {
  for (const id of [...drafts.keys()]) {
    sendDraft(id);
  }
}

/* ---------- dates ---------- */

function pad(number) {
  return String(number).padStart(2, "0");
}

// Local date parts, not toISOString(): that converts to UTC and would show the wrong day
// for anyone east of Greenwich shortly after midnight.
function dateKey(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function dateLabel(date) {
  return date.getDate() + " " + MONTH_NAMES[date.getMonth()];
}

function todayKey() {
  return dateKey(new Date());
}

// One date per day from the start day through today. Building each next day through the Date
// constructor handles month ends, year ends and daylight-saving changes.
function buildDays() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = [new Date(start.year, start.month - 1, start.day)];
  for (;;) {
    const last = days[days.length - 1];
    const next = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    if (next > today) {
      return days;
    }
    days.push(next);
  }
}

/* ---------- display ---------- */

function makeAmountCell(key, label, field) {
  const cell = document.createElement("td");
  const input = document.createElement("input");
  input.type = "number";
  input.inputMode = "numeric";
  input.min = 0;
  input.max = MAX_AMOUNT[field];
  input.step = 1;
  input.placeholder = "—";
  input.dataset.field = field;
  input.setAttribute("aria-label", field + " for " + label);
  const amount = amountOf(key, field);
  input.value = amount === null ? "" : amount;
  cell.append(input);
  return cell;
}

function renderTable() {
  const days = buildDays();
  const today = todayKey();
  shownKeys = days.map(dateKey);
  renderedToday = today;

  rowsEl.replaceChildren();
  for (const day of days) {
    const key = dateKey(day);
    const label = dateLabel(day);

    const row = document.createElement("tr");
    row.dataset.key = key;
    if (key === today) {
      row.classList.add("today");
      row.setAttribute("aria-current", "date");
    }

    const dateCell = document.createElement("th");
    dateCell.scope = "row";
    dateCell.className = "date";
    dateCell.textContent = label;

    row.append(dateCell,
               makeAmountCell(key, label, "calories"),
               makeAmountCell(key, label, "protein"));
    rowsEl.append(row);
    // the "Log food" button belongs to today's row only
    if (key === today) {
      rowsEl.append(makeLogRow());
    }
  }

  renderStats();
  // newest day is last, so scroll the box down to it
  wrapEl.scrollTop = wrapEl.scrollHeight;
}

// Averages count only cells that have a value, so a skipped day does not drag them down.
function renderStats() {
  const sums = { calories: 0, protein: 0 };
  const counts = { calories: 0, protein: 0 };
  let daysLogged = 0;

  for (const key of shownKeys) {
    let loggedSomething = false;
    for (const field of FIELDS) {
      const amount = amountOf(key, field);
      if (amount !== null) {
        sums[field] += amount;
        counts[field] += 1;
        loggedSomething = true;
      }
    }
    if (loggedSomething) {
      daysLogged += 1;
    }
  }

  avgCaloriesEl.textContent = counts.calories === 0
    ? "—" : String(Math.round(sums.calories / counts.calories));
  avgProteinEl.textContent = counts.protein === 0
    ? "—" : (sums.protein / counts.protein).toFixed(1);
  daysLoggedEl.textContent = daysLogged + " / " + shownKeys.length;

  renderChart();
}

/* ---------- chart ---------- */

function labelFromKey(key) {
  const [, month, day] = key.split("-");
  return Number(day) + " " + MONTH_NAMES[Number(month) - 1];
}

function renderChart() {
  const labels = shownKeys.map(labelFromKey);
  const calories = shownKeys.map((key) => amountOf(key, "calories"));
  const protein = shownKeys.map((key) => amountOf(key, "protein"));
  drawLineChart(chartEl, {
    labels: labels,
    emptyMax: EMPTY_CHART_MAX,
    series: [
      { name: "calories", values: calories, tip: (index) => labels[index] + ": " + calories[index] + " kcal" },
      {
        name: "protein",
        // drawn x10 so it lands next to the calorie line; the hover text still shows real grams
        values: protein.map((value) => (value === null ? null : value * PROTEIN_SCALE)),
        tip: (index) => labels[index] + ": " + protein[index] + " g protein",
      },
    ],
  });
}

/* ---------- editing ---------- */

function restoreInput(input, key, field) {
  const amount = amountOf(key, field);
  input.value = amount === null ? "" : amount;
  input.classList.remove("invalid");
}

// Called while typing (finished = false) and when the field is left (finished = true), where
// junk is replaced by the last good value.
function handleEdit(input, finished) {
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const key = input.closest("tr").dataset.key;
  const field = input.dataset.field;
  const text = input.value.trim();

  // type=number reports unparsable text (e.g. "1e", "-") as an empty value with badInput set
  if (input.validity.badInput || (text !== "" && !isValidAmount(field, Number(text)))) {
    if (finished) {
      restoreInput(input, key, field);
    } else {
      input.classList.add("invalid");
    }
    return;
  }

  input.classList.remove("invalid");
  queueSave(key, field, text === "" ? null : Number(text), finished);
  if (finished) {
    restoreInput(input, key, field);
  }
  renderStats();
}

rowsEl.addEventListener("input", (event) => handleEdit(event.target, false));
rowsEl.addEventListener("change", (event) => handleEdit(event.target, true));

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    // send anything still waiting for its typing pause before the phone locks or the tab closes
    flushDrafts();
  } else if (renderedToday !== null && todayKey() !== renderedToday) {
    // the page stayed open past midnight: add the new day's row
    renderTable();
  }
});
window.addEventListener("pagehide", flushDrafts);

/* ---------- log food: add a meal to today's totals ---------- */

function makeLogRow() {
  const row = document.createElement("tr");
  row.className = "log-row";
  const cell = document.createElement("td");
  cell.colSpan = 3;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "block primary";
  button.textContent = "Log food";
  button.addEventListener("click", openLogDialog);
  cell.append(button);
  row.append(cell);
  return row;
}

function openLogDialog() {
  // the page may have been open since yesterday: make sure "today" really is today first
  if (todayKey() !== renderedToday) {
    renderTable();
  }
  logCaloriesEl.value = "";
  logProteinEl.value = "";
  logErrorEl.hidden = true;
  logDialogEl.showModal();
}

function showLogError(message) {
  logErrorEl.textContent = message;
  logErrorEl.hidden = false;
}

// increment() is applied by the server, so two devices logging at the same moment both count.
// Edits still waiting for their typing pause are sent first, so the meal lands on top of them.
function addToDay(key, added) {
  flushDrafts();
  const data = {};
  const entry = log[key] || { calories: null, protein: null };
  for (const [field, value] of Object.entries(added)) {
    data[field] = increment(value);
    // our own copy moves right away, so the cells and averages do not wait for the network
    entry[field] = (entry[field] === null ? 0 : entry[field]) + value;
  }
  log[key] = entry;
  saves.track(setDoc(nutritionDoc(key), data, { merge: true }));
  syncInputs();
  renderStats();
}

logFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const added = {};
  for (const [field, input] of [["calories", logCaloriesEl], ["protein", logProteinEl]]) {
    const text = input.value.trim();
    if (text === "") {
      continue;  // left blank: that field is not touched
    }
    const value = Number(text);
    if (input.validity.badInput || !isValidAmount(field, value)) {
      showLogError("Use a whole number from 0 to " + MAX_AMOUNT[field] + " for " + field + ".");
      return;
    }
    added[field] = value;
  }
  if (Object.keys(added).length === 0) {
    showLogError("Enter calories, protein, or both.");
    return;
  }

  const key = todayKey();
  for (const [field, value] of Object.entries(added)) {
    const current = amountOf(key, field) || 0;
    if (current + value > MAX_AMOUNT[field]) {
      showLogError("That would take today's " + field + " above " + MAX_AMOUNT[field] + ".");
      return;
    }
  }
  addToDay(key, added);
  logDialogEl.close();
});

logCancelEl.addEventListener("click", () => logDialogEl.close());
// a tap on the dimmed area outside the box also closes it
logDialogEl.addEventListener("click", (event) => {
  if (event.target === logDialogEl) {
    logDialogEl.close();
  }
});

/* ---------- one-time import of data saved in this browser ---------- */

function readLegacyEntries() {
  let raw;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch (err) {
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const isPlainObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    if (!isPlainObject) {
      return null;
    }
    const entries = [];
    for (const [key, value] of Object.entries(parsed)) {
      const entry = DATE_KEY_PATTERN.test(key) && value !== null && typeof value === "object"
        ? toEntry(value) : null;
      if (entry === null) {
        continue;
      }
      // only fields that have a value, so a blank local cell can never erase saved data
      const data = {};
      for (const field of FIELDS) {
        if (entry[field] !== null) {
          data[field] = entry[field];
        }
      }
      if (Object.keys(data).length > 0) {
        entries.push([key, data]);
      }
    }
    return entries.length > 0 ? { raw: raw, entries: entries } : null;
  } catch (err) {
    console.error("Old local entries could not be read:", err);
    return null;
  }
}

function offerImport() {
  const legacy = readLegacyEntries();
  if (legacy === null) {
    importEl.hidden = true;
    return;
  }
  const count = legacy.entries.length;
  importEl.textContent = "Import " + count + " day" + (count === 1 ? "" : "s") + " from this device";
  importEl.hidden = false;
}

importEl.addEventListener("click", async () => {
  const legacy = readLegacyEntries();
  if (legacy === null) {
    importEl.hidden = true;
    return;
  }

  importEl.disabled = true;
  try {
    for (let start = 0; start < legacy.entries.length; start += IMPORT_CHUNK) {
      const batch = writeBatch(db);
      for (const [key, data] of legacy.entries.slice(start, start + IMPORT_CHUNK)) {
        batch.set(nutritionDoc(key), data, { merge: true });
      }
      await batch.commit();
    }
  } catch (err) {
    showError(err);
    importEl.disabled = false;
    return;
  }

  importEl.hidden = true;
  importEl.disabled = false;
  // Keep a copy under another key instead of deleting, and remove the original so the same
  // data can't be imported twice.
  try {
    localStorage.setItem(LEGACY_KEY + ".imported", legacy.raw);
    localStorage.removeItem(LEGACY_KEY);
  } catch (err) {
    showError("Imported, but the old copy on this device could not be cleared: " + err.message);
  }
});

/* ---------- start ---------- */

initGate({
  onSignedIn(user) {
    userId = user.uid;
    offerImport();
    let unsubscribe = null;
    let signedOut = false;
    // the table needs this account's first day, so that is read before anything is drawn
    loadStart().then((loaded) => {
      if (signedOut) {
        return;
      }
      start = loaded;
      renderTable();
      unsubscribe = onSnapshot(nutritionCollection(), applySnapshot, showError);
    }).catch(showError);
    return () => {
      signedOut = true;
      if (unsubscribe !== null) {
        unsubscribe();
      }
      userId = null;
      // drop the data from memory and screen when signing out
      for (const draft of drafts.values()) {
        clearTimeout(draft.timer);
      }
      drafts.clear();
      log = {};
      shownKeys = [];
      renderedToday = null;
      rowsEl.replaceChildren();
      chartEl.replaceChildren();
      if (logDialogEl.open) {
        logDialogEl.close();
      }
    };
  },
});
