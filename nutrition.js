"use strict";

const STORAGE_KEY = "nutrition.log";
// First tracked day. The year only keys the stored data; the table shows just day and month.
const START = { year: 2026, month: 10, day: 28 };
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FIELDS = ["calories", "protein"];
const MAX_AMOUNT = { calories: 20000, protein: 1000 };
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const wrapEl = document.getElementById("table-wrap");
const rowsEl = document.getElementById("rows");
const errorEl = document.getElementById("error");
const avgCaloriesEl = document.getElementById("avg-calories");
const avgProteinEl = document.getElementById("avg-protein");
const daysLoggedEl = document.getElementById("days-logged");

let log = loadLog();
let shownKeys = [];
let renderedToday = null;

/* ---------- storage ---------- */

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function isValidAmount(field, value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_AMOUNT[field];
}

function isValidEntry(entry) {
  return entry !== null && typeof entry === "object" &&
         FIELDS.every((field) => entry[field] === null || isValidAmount(field, entry[field]));
}

function loadLog() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    // Happens in some private-browsing modes; the page still works, it just can't persist.
    showError("Browser storage is unavailable. Entries will not be saved.");
    return {};
  }
  if (raw === null) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const isPlainObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    if (!isPlainObject ||
        !Object.entries(parsed).every(([key, entry]) => DATE_KEY_PATTERN.test(key) && isValidEntry(entry))) {
      throw new Error("unexpected data shape");
    }
    return parsed;
  } catch (err) {
    // Keep the bad data under another key instead of overwriting it on the next save.
    try {
      localStorage.setItem(STORAGE_KEY + ".corrupt", raw);
    } catch (backupErr) {
      console.error("Could not back up corrupt data:", backupErr);
    }
    showError("Saved entries could not be read. The old data was kept under '" +
              STORAGE_KEY + ".corrupt'.");
    return {};
  }
}

function saveLog() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
  } catch (err) {
    showError("Could not save entries: " + err.message);
  }
}

function setAmount(key, field, value) {
  const entry = log[key] || { calories: null, protein: null };
  entry[field] = value;
  if (entry.calories === null && entry.protein === null) {
    delete log[key];
  } else {
    log[key] = entry;
  }
  saveLog();
}

function storedAmount(key, field) {
  const entry = log[key];
  return entry && entry[field] !== null ? entry[field] : null;
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
  const days = [new Date(START.year, START.month - 1, START.day)];
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
  const stored = storedAmount(key, field);
  input.value = stored === null ? "" : stored;
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
      const amount = storedAmount(key, field);
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
}

/* ---------- editing ---------- */

function restoreInput(input, key, field) {
  const stored = storedAmount(key, field);
  input.value = stored === null ? "" : stored;
  input.classList.remove("invalid");
}

// Saves while typing so nothing is lost if the phone locks mid-entry. "finished" is the
// change event (field left), where junk is replaced by the last saved value.
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
  setAmount(key, field, text === "" ? null : Number(text));
  if (finished) {
    restoreInput(input, key, field);
  }
  renderStats();
}

rowsEl.addEventListener("input", (event) => handleEdit(event.target, false));
rowsEl.addEventListener("change", (event) => handleEdit(event.target, true));

// If the page stays open past midnight, the new day's row appears when you come back to it.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && todayKey() !== renderedToday) {
    renderTable();
  }
});

renderTable();
