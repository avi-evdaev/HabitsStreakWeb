import {
  db, initGate, createSaveTracker, describeFirestoreError,
  collection, doc, query, orderBy, onSnapshot, addDoc, deleteDoc,
} from "./firebase.js?v=41";
import { drawLineChart } from "./chart.js?v=41";

const MIN_KG = 20;
const MAX_KG = 500;
const CHART_LOGS = 60;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const wrapEl = document.getElementById("table-wrap");
const rowsEl = document.getElementById("rows");
const emptyEl = document.getElementById("empty");
const errorEl = document.getElementById("error");
const statusEl = document.getElementById("status");
const logButtonEl = document.getElementById("log-weight");
const latestEl = document.getElementById("latest");
const changeEl = document.getElementById("change");
const logCountEl = document.getElementById("log-count");
const chartEl = document.getElementById("chart");
const dialogEl = document.getElementById("weight-dialog");
const formEl = document.getElementById("weight-form");
const inputEl = document.getElementById("weight-input");
const dialogErrorEl = document.getElementById("weight-error");
const cancelEl = document.getElementById("weight-cancel");

// One document per log, under the signed-in person's own path: { kg, at }. "at" is the moment of
// the log in milliseconds, so the date and time shown are worked out from it, never typed.
let userId = null;
const weightsCollection = () => collection(db, "users", userId, "weights");
const weightDoc = (id) => doc(db, "users", userId, "weights", id);
const saves = createSaveTracker(statusEl, showError);

let weights = [];  // oldest first

function showError(err) {
  errorEl.textContent = typeof err === "string" ? err : describeFirestoreError(err);
  errorEl.hidden = false;
}

/* ---------- data ---------- */

function isValidWeight(data) {
  return data !== null && typeof data === "object" &&
         Number.isFinite(data.kg) && data.kg >= MIN_KG && data.kg <= MAX_KG &&
         Number.isFinite(data.at);
}

function listen() {
  const weightsQuery = query(weightsCollection(), orderBy("at"));
  return onSnapshot(weightsQuery, (snapshot) => {
    weights = [];
    for (const snap of snapshot.docs) {
      const data = snap.data();
      if (isValidWeight(data)) {
        weights.push({ id: snap.id, kg: data.kg, at: data.at });
      } else {
        console.warn("Skipping malformed weight document", snap.id);
      }
    }
    render();
    saves.show();
  }, showError);
}

/* ---------- display ---------- */

function pad(number) {
  return String(number).padStart(2, "0");
}

// Local time, not UTC, so the log shows the clock on the wall when it was made.
function dateLabel(timestamp) {
  const date = new Date(timestamp);
  return date.getDate() + " " + MONTH_NAMES[date.getMonth()];
}

function timeLabel(timestamp) {
  const date = new Date(timestamp);
  return pad(date.getHours()) + ":" + pad(date.getMinutes());
}

// One decimal is what the scale shows; this also hides float noise such as 80.30000000000001.
function formatKg(kg) {
  return kg.toFixed(1);
}

function makeRow(weight) {
  const row = document.createElement("tr");

  const dateCell = document.createElement("th");
  dateCell.scope = "row";
  dateCell.className = "date";
  dateCell.textContent = dateLabel(weight.at);

  const timeCell = document.createElement("td");
  timeCell.className = "cell";
  timeCell.textContent = timeLabel(weight.at);

  const weightCell = document.createElement("td");
  weightCell.className = "cell";
  const value = document.createElement("span");
  value.textContent = formatKg(weight.kg);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon del";
  remove.setAttribute("aria-label", "Delete the log from " + dateLabel(weight.at) + " " + timeLabel(weight.at));
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    if (confirm("Delete " + formatKg(weight.kg) + " kg from " + dateLabel(weight.at) + " " + timeLabel(weight.at) + "?")) {
      saves.track(deleteDoc(weightDoc(weight.id)));
    }
  });
  const inner = document.createElement("div");
  inner.className = "weight-inner";
  inner.append(value, remove);
  weightCell.append(inner);

  row.append(dateCell, timeCell, weightCell);
  return row;
}

function renderTable() {
  rowsEl.replaceChildren();
  for (const weight of weights) {
    rowsEl.append(makeRow(weight));
  }
  wrapEl.hidden = weights.length === 0;
  emptyEl.hidden = weights.length > 0;
  // newest log is last, so scroll the box down to it
  wrapEl.scrollTop = wrapEl.scrollHeight;
}

function renderStats() {
  if (weights.length === 0) {
    latestEl.textContent = "—";
    changeEl.textContent = "—";
    logCountEl.textContent = "—";
    return;
  }
  const latest = weights[weights.length - 1].kg;
  const change = latest - weights[0].kg;
  latestEl.textContent = formatKg(latest);
  changeEl.textContent = (change > 0 ? "+" : "") + change.toFixed(1);
  logCountEl.textContent = String(weights.length);
}

function renderChart() {
  const shown = weights.slice(-CHART_LOGS);
  const labels = shown.map((weight) => dateLabel(weight.at));
  drawLineChart(chartEl, {
    labels: labels,
    zoom: true,
    emptyMin: 60,
    emptyMax: 90,
    emptyText: "No weights yet",
    series: [
      {
        name: "weight",
        values: shown.map((weight) => weight.kg),
        tip: (index) => labels[index] + " " + timeLabel(shown[index].at) + ": " + formatKg(shown[index].kg) + " kg",
      },
    ],
  });
}

function render() {
  renderTable();
  renderStats();
  renderChart();
}

/* ---------- logging a weight ---------- */

function showDialogError(message) {
  dialogErrorEl.textContent = message;
  dialogErrorEl.hidden = false;
}

logButtonEl.addEventListener("click", () => {
  inputEl.value = "";
  dialogErrorEl.hidden = true;
  dialogEl.showModal();
  inputEl.focus();
});

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  const number = Number(text);
  // type=number reports unparsable text (e.g. "1e", "-") as an empty value with badInput set
  if (inputEl.validity.badInput || text === "" || !Number.isFinite(number)) {
    showDialogError("Enter your weight in kg, for example 80.5.");
    return;
  }
  const kg = Math.round(number * 10) / 10;  // one decimal is what a scale shows
  if (kg < MIN_KG || kg > MAX_KG) {
    showDialogError("Weight must be between " + MIN_KG + " and " + MAX_KG + " kg.");
    return;
  }
  saves.track(addDoc(weightsCollection(), { kg: kg, at: Date.now() }));
  dialogEl.close();
});

cancelEl.addEventListener("click", () => dialogEl.close());
// a tap on the dimmed area outside the box also closes it
dialogEl.addEventListener("click", (event) => {
  if (event.target === dialogEl) {
    dialogEl.close();
  }
});

initGate({
  onSignedIn(user) {
    userId = user.uid;
    render();
    const unsubscribe = listen();
    return () => {
      unsubscribe();
      if (dialogEl.open) {
        dialogEl.close();
      }
      userId = null;
      // drop the data from memory and screen when signing out
      weights = [];
      render();
    };
  },
});
