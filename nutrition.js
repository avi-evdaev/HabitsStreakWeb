import {
  db, initGate, createSaveTracker, describeFirestoreError,
  collection, doc, onSnapshot, setDoc, writeBatch,
} from "./firebase.js?v=24";

// Where this page kept its data before it moved to the database
const LEGACY_KEY = "nutrition.log";
// First tracked day. The year only keys the stored data; the table shows just day and month.
const START = { year: 2026, month: 10, day: 26 };
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FIELDS = ["calories", "protein"];
const MAX_AMOUNT = { calories: 20000, protein: 1000 };
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Typing saves after this pause, so one entry like "2150" is one write, not four.
const SAVE_DELAY_MS = 700;
const IMPORT_CHUNK = 400;
const SVG_NS = "http://www.w3.org/2000/svg";
// Protein (g) is drawn x10 so its line lands next to the calorie line on the same axis.
const PROTEIN_SCALE = 10;
// Top value used to size the empty chart's axis (calories, before any data exists)
const EMPTY_CHART_MAX = 2500;
// Drawing area in SVG units; the SVG scales to the screen width, so 360 is about phone size.
const CHART = { width: 360, height: 300, left: 46, right: 22, top: 14, bottom: 36 };

const wrapEl = document.getElementById("table-wrap");
const rowsEl = document.getElementById("rows");
const errorEl = document.getElementById("error");
const importEl = document.getElementById("import");
const statusEl = document.getElementById("status");
const avgCaloriesEl = document.getElementById("avg-calories");
const avgProteinEl = document.getElementById("avg-protein");
const daysLoggedEl = document.getElementById("days-logged");
const chartEl = document.getElementById("chart");

// one document per day, named by its date key; fields: calories, protein (number or null)
let userId = null;  // set when sign-in completes; everything lives under users/<id>/
const nutritionCollection = () => collection(db, "users", userId, "nutrition");
const nutritionDoc = (key) => doc(db, "users", userId, "nutrition", key);
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

function svgEl(name, attributes) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [attribute, value] of Object.entries(attributes || {})) {
    element.setAttribute(attribute, value);
  }
  return element;
}

function labelFromKey(key) {
  const [, month, day] = key.split("-");
  return Number(day) + " " + MONTH_NAMES[Number(month) - 1];
}

// Picks a round axis step (1, 2, 2.5, 5 x a power of ten) giving about four gridlines.
function niceScale(maxValue) {
  const rough = Math.max(maxValue, 100) / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude)
    .find((candidate) => candidate >= rough);
  return { step: step, top: step * Math.ceil(Math.max(maxValue, 100) / step) };
}

// Splits a series into runs of consecutive days that have a value, so a blank day leaves a
// gap in the line instead of a fake drop to zero.
function runsOf(points) {
  const runs = [];
  let current = [];
  for (const point of points) {
    if (point === null) {
      if (current.length > 0) {
        runs.push(current);
      }
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

function renderChart() {
  chartEl.replaceChildren();

  const count = shownKeys.length;
  const series = [
    { name: "calories", factor: 1, unit: " kcal" },
    { name: "protein", factor: PROTEIN_SCALE, unit: " g protein" },
  ];
  for (const item of series) {
    item.raw = shownKeys.map((key) => amountOf(key, item.name));
    item.scaled = item.raw.map((value) => (value === null ? null : value * item.factor));
  }

  const allValues = series.flatMap((item) => item.scaled).filter((value) => value !== null);
  const hasData = allValues.length > 0;

  // With no data the axes are still drawn, on a typical scale, so the graph is visible from
  // day one instead of appearing only after the first entry.
  const scale = niceScale(hasData ? Math.max(...allValues) : EMPTY_CHART_MAX);
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const xAt = (index) => CHART.left + (count === 1 ? plotWidth / 2 : (index * plotWidth) / (count - 1));
  const yAt = (value) => CHART.top + plotHeight - (value / scale.top) * plotHeight;
  const baseline = yAt(0);

  // horizontal gridlines with value labels
  for (let value = 0; value <= scale.top + 1e-9; value += scale.step) {
    const y = yAt(value);
    chartEl.append(svgEl("line", {
      class: value === 0 ? "axis" : "grid",
      x1: CHART.left, x2: CHART.width - CHART.right, y1: y, y2: y,
    }));
    const label = svgEl("text", { x: CHART.left - 6, y: y, "text-anchor": "end", dy: "0.35em" });
    label.textContent = String(value);
    chartEl.append(label);
  }
  chartEl.append(svgEl("line", {
    class: "axis", x1: CHART.left, x2: CHART.left, y1: CHART.top, y2: baseline,
  }));

  // x labels, counted back from today so the newest day is always labelled
  const labelEvery = Math.ceil(count / 6);
  for (let index = 0; index < count; index += 1) {
    if ((count - 1 - index) % labelEvery !== 0) {
      continue;
    }
    const x = xAt(index);
    chartEl.append(svgEl("line", { class: "axis", x1: x, x2: x, y1: baseline, y2: baseline + 5 }));
    const label = svgEl("text", { x: x, y: baseline + 19, "text-anchor": "middle" });
    label.textContent = labelFromKey(shownKeys[index]);
    chartEl.append(label);
  }

  if (!hasData) {
    const note = svgEl("text", {
      class: "placeholder",
      x: CHART.left + plotWidth / 2, y: CHART.top + plotHeight / 2, "text-anchor": "middle",
    });
    note.textContent = "No data yet";
    chartEl.append(note);
    return;
  }

  const dotSize = Math.max(4, Math.min(9, (plotWidth / count) * 0.5));
  for (const item of series) {
    const points = item.scaled.map((value, index) =>
      value === null ? null : { x: xAt(index), y: yAt(value), index: index });

    for (const run of runsOf(points)) {
      if (run.length < 2) {
        continue;
      }
      const path = run.map((point) => point.x + "," + point.y).join(" ");
      chartEl.append(svgEl("polyline", { class: "line " + item.name, points: path }));
    }

    for (const point of points.filter((candidate) => candidate !== null)) {
      const dot = svgEl("rect", {
        class: "dot " + item.name,
        x: point.x - dotSize / 2, y: point.y - dotSize / 2, width: dotSize, height: dotSize,
      });
      const tip = svgEl("title");
      tip.textContent = labelFromKey(shownKeys[point.index]) + ": " + item.raw[point.index] + item.unit;
      dot.append(tip);
      chartEl.append(dot);
    }
  }
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
    renderTable();
    offerImport();
    const unsubscribe = onSnapshot(nutritionCollection(), applySnapshot, showError);
    return () => {
      unsubscribe();
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
    };
  },
});
