import {
  db, initGate, createSaveTracker, describeFirestoreError,
  collection, doc, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc,
} from "./firebase.js?v=33";

const MAX_NAME = 80;
const MAX_PER = 30;
const MAX_CALORIES = 5000;
const MAX_PROTEIN = 500;
// Typing saves after this pause, so one entry is one write, not one per keystroke.
const SAVE_DELAY_MS = 700;

const searchEl = document.getElementById("search");
const addFoodEl = document.getElementById("add-food");
const tableWrapEl = document.getElementById("table-wrap");
const rowsEl = document.getElementById("foods");
const emptyEl = document.getElementById("foods-empty");
const noMatchEl = document.getElementById("no-match");
const errorEl = document.getElementById("error");
const statusEl = document.getElementById("status");
const dialogEl = document.getElementById("food-dialog");
const formEl = document.getElementById("food-form");
const nameEl = document.getElementById("food-name");
const perEl = document.getElementById("food-per");
const caloriesEl = document.getElementById("food-calories");
const proteinEl = document.getElementById("food-protein");
const dialogErrorEl = document.getElementById("food-error");
const cancelEl = document.getElementById("food-cancel");

// One document per food, under the signed-in person's own path:
// { name, per, calories, protein, createdAt }. The security rules keep every account to its own data.
let userId = null;
const foodsCollection = () => collection(db, "users", userId, "foods");
const foodDoc = (id) => doc(db, "users", userId, "foods", id);
const saves = createSaveTracker(statusEl, showError);

let foods = [];              // { id, name, per, calories (number|null), protein (number|null) }
let pendingRebuild = false;  // a change arrived while a cell was being edited
const drafts = new Map();    // "id|field" -> typed but not yet sent
// numeric:true puts "2 eggs" before "10 eggs"; the default locale sorts Hebrew and English sensibly
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function showError(err) {
  errorEl.textContent = typeof err === "string" ? err : describeFirestoreError(err);
  errorEl.hidden = false;
}

/* ---------- validation ---------- */

// Turns what was typed into { ok, value }. Calories and protein may be left empty (value null).
function parseField(field, text, badInput) {
  const trimmed = text.trim();
  if (field === "name") {
    return { ok: trimmed !== "" && trimmed.length <= MAX_NAME, value: trimmed };
  }
  if (field === "per") {
    return { ok: trimmed.length <= MAX_PER, value: trimmed };
  }
  // type=number reports unparsable text (e.g. "1e", "-") as an empty value with badInput set
  if (badInput) {
    return { ok: false, value: null };
  }
  if (trimmed === "") {
    return { ok: true, value: null };
  }
  const number = Number(trimmed);
  if (field === "calories") {
    return { ok: Number.isInteger(number) && number >= 0 && number <= MAX_CALORIES, value: number };
  }
  const rounded = Math.round(number * 10) / 10;  // one decimal is plenty for protein
  return { ok: Number.isFinite(number) && number >= 0 && rounded <= MAX_PROTEIN, value: rounded };
}

function foodFromData(id, data) {
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const per = typeof data.per === "string" ? data.per : "";
  const calories = data.calories === null || data.calories === undefined ? null : data.calories;
  const protein = data.protein === null || data.protein === undefined ? null : data.protein;
  const valid = name !== "" && name.length <= MAX_NAME && per.length <= MAX_PER &&
    parseField("calories", calories === null ? "" : String(calories), false).ok &&
    parseField("protein", protein === null ? "" : String(protein), false).ok;
  return valid ? { id: id, name: name, per: per, calories: calories, protein: protein } : null;
}

/* ---------- database ---------- */

function listen() {
  const foodsQuery = query(foodsCollection(), orderBy("createdAt"));
  return onSnapshot(foodsQuery, (snapshot) => {
    foods = [];
    for (const snap of snapshot.docs) {
      const food = foodFromData(snap.id, snap.data());
      if (food !== null) {
        foods.push(food);
      } else {
        console.warn("Skipping malformed food document", snap.id);
      }
    }
    // what is typed but not yet sent still wins over what the database just told us
    for (const draft of drafts.values()) {
      const food = foods.find((item) => item.id === draft.id);
      if (food) {
        food[draft.field] = draft.value;
      }
    }
    refresh();
    saves.show();
  }, showError);
}

function sendDraft(key) {
  const draft = drafts.get(key);
  if (draft === undefined) {
    return;
  }
  clearTimeout(draft.timer);
  drafts.delete(key);
  saves.track(updateDoc(foodDoc(draft.id), { [draft.field]: draft.value }));
}

function queueSave(food, field, value, immediately) {
  const key = food.id + "|" + field;
  const existing = drafts.get(key);
  if (existing !== undefined) {
    clearTimeout(existing.timer);
  }
  food[field] = value;  // our own copy moves at once
  const draft = { id: food.id, field: field, value: value, timer: null };
  drafts.set(key, draft);
  if (immediately) {
    sendDraft(key);
  } else {
    draft.timer = setTimeout(() => sendDraft(key), SAVE_DELAY_MS);
  }
}

function flushDrafts() {
  for (const key of [...drafts.keys()]) {
    sendDraft(key);
  }
}

/* ---------- display ---------- */

function visibleFoods() {
  const needle = searchEl.value.trim().toLocaleLowerCase();
  return foods
    .filter((food) => needle === "" || food.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => collator.compare(a.name, b.name));
}

function makeInput(food, field) {
  const input = document.createElement("input");
  input.dataset.field = field;
  input.setAttribute("aria-label", field + ": " + food.name);
  if (field === "name" || field === "per") {
    input.type = "text";
    input.className = "text";
    // dir=auto: Hebrew names read and align right-to-left, English ones left-to-right
    input.dir = "auto";
    input.maxLength = field === "name" ? MAX_NAME : MAX_PER;
    input.placeholder = field === "per" ? "—" : "";
    input.value = food[field];
  } else {
    input.type = "number";
    input.inputMode = field === "calories" ? "numeric" : "decimal";
    input.min = 0;
    input.max = field === "calories" ? MAX_CALORIES : MAX_PROTEIN;
    input.step = field === "calories" ? 1 : 0.1;
    input.placeholder = "—";
    input.value = food[field] === null ? "" : food[field];
  }
  return input;
}

function makeRow(food) {
  const row = document.createElement("tr");
  row.dataset.id = food.id;
  for (const field of ["name", "per", "calories", "protein"]) {
    const cell = document.createElement("td");
    cell.append(makeInput(food, field));
    row.append(cell);
  }

  const actions = document.createElement("td");
  actions.className = "act";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon del";
  remove.setAttribute("aria-label", "Delete " + food.name);
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    // confirm() text is plain text, so a food name can't inject anything into it
    if (confirm("Delete \"" + food.name + "\"?")) {
      drafts.delete(food.id + "|name");
      saves.track(deleteDoc(foodDoc(food.id)));
    }
  });
  actions.append(remove);
  row.append(actions);
  return row;
}

function render() {
  pendingRebuild = false;
  const shown = visibleFoods();
  rowsEl.replaceChildren();
  for (const food of shown) {
    rowsEl.append(makeRow(food));
  }
  tableWrapEl.hidden = shown.length === 0;
  emptyEl.hidden = foods.length > 0;
  noMatchEl.hidden = !(foods.length > 0 && shown.length === 0);
}

// Rebuilding the table would drop the cell being typed in, so while one has focus the table is only
// updated in place, and the full rebuild (new rows, new order) waits until the cursor leaves.
function refresh() {
  if (!rowsEl.contains(document.activeElement)) {
    render();
    return;
  }
  pendingRebuild = true;
  for (const input of rowsEl.querySelectorAll("input")) {
    const food = foods.find((item) => item.id === input.closest("tr").dataset.id);
    const field = input.dataset.field;
    if (food && input !== document.activeElement && !drafts.has(food.id + "|" + field)) {
      input.value = food[field] === null ? "" : food[field];
    }
  }
}

rowsEl.addEventListener("focusout", () => {
  setTimeout(() => {
    if (pendingRebuild && !rowsEl.contains(document.activeElement)) {
      render();
    }
  }, 0);
});

/* ---------- editing a cell ---------- */

function restoreInput(input, food, field) {
  input.value = food[field] === null ? "" : food[field];
  input.classList.remove("invalid");
}

// Called while typing (finished = false) and when the cell is left (finished = true), where a
// value that does not fit is replaced by the last good one.
function handleEdit(input, finished) {
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const id = input.closest("tr").dataset.id;
  const field = input.dataset.field;
  const food = foods.find((item) => item.id === id);
  if (food === undefined) {
    return;
  }

  const result = parseField(field, input.value, input.validity.badInput);
  if (!result.ok) {
    if (finished) {
      restoreInput(input, food, field);
    } else {
      input.classList.add("invalid");
    }
    return;
  }

  input.classList.remove("invalid");
  queueSave(food, field, result.value, finished);
  if (finished) {
    restoreInput(input, food, field);
  }
}

rowsEl.addEventListener("input", (event) => handleEdit(event.target, false));
rowsEl.addEventListener("change", (event) => handleEdit(event.target, true));

searchEl.addEventListener("input", render);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushDrafts();  // send anything still waiting before the phone locks or the tab closes
  }
});
window.addEventListener("pagehide", flushDrafts);

/* ---------- adding a food ---------- */

function showDialogError(message) {
  dialogErrorEl.textContent = message;
  dialogErrorEl.hidden = false;
}

addFoodEl.addEventListener("click", () => {
  nameEl.value = "";
  perEl.value = "100 g";
  caloriesEl.value = "";
  proteinEl.value = "";
  dialogErrorEl.hidden = true;
  dialogEl.showModal();
  nameEl.focus();
});

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = parseField("name", nameEl.value, false);
  const per = parseField("per", perEl.value, false);
  const calories = parseField("calories", caloriesEl.value, caloriesEl.validity.badInput);
  const protein = parseField("protein", proteinEl.value, proteinEl.validity.badInput);

  if (!name.ok) {
    showDialogError(name.value === "" ? "Give the food a name." : "The name can have up to " + MAX_NAME + " characters.");
    return;
  }
  if (!per.ok) {
    showDialogError("\"Per\" can have up to " + MAX_PER + " characters.");
    return;
  }
  if (!calories.ok) {
    showDialogError("Calories: a whole number from 0 to " + MAX_CALORIES + ", or leave it empty.");
    return;
  }
  if (!protein.ok) {
    showDialogError("Protein: a number from 0 to " + MAX_PROTEIN + ", or leave it empty.");
    return;
  }

  saves.track(addDoc(foodsCollection(), {
    name: name.value, per: per.value, calories: calories.value, protein: protein.value,
    createdAt: Date.now(),
  }));
  // a search left in the box could hide the new food and look like the add failed
  searchEl.value = "";
  dialogEl.close();
});

cancelEl.addEventListener("click", () => dialogEl.close());
dialogEl.addEventListener("click", (event) => {
  if (event.target === dialogEl) {
    dialogEl.close();
  }
});

initGate({
  onSignedIn(user) {
    userId = user.uid;
    const unsubscribe = listen();
    return () => {
      unsubscribe();
      for (const draft of drafts.values()) {
        clearTimeout(draft.timer);
      }
      drafts.clear();
      if (dialogEl.open) {
        dialogEl.close();
      }
      userId = null;
      // drop the data from memory and screen when signing out
      foods = [];
      searchEl.value = "";
      render();
    };
  },
});
