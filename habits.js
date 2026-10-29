import {
  db, initGate, createSaveTracker, describeFirestoreError,
  collection, doc, query, orderBy, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc, increment,
  writeBatch,
} from "./firebase.js?v=37";
import { GOAL_DEFAULTS, GOAL_MAX } from "./goals.js?v=37";

// Where this page kept its data before it moved to the database
const LEGACY_KEY = "habitsStreak.habits";
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ORDER_ITEMS = 500;

// A habit row grows greener with its streak: grey at 0, a little greener with each day, full green at
// HEAT_FULL_AT and beyond. The grey end is the normal row grey, so a habit at 0 looks unchanged. The
// green is dark enough for white text on it to stay readable.
const HEAT_FULL_AT = 10;
const COOL_RGB = [28, 28, 30];
const HOT_RGB = [24, 134, 64];

// Built-in habits. Their numbers are not typed in: each one is the current day streak on the
// Tracker page, meaning finished days in a row whose logged value passes a test against a number
// the person sets for themselves.
// Everyone starts at the fallback and can change their own (kept in the account's settings).
const AUTO_HABITS = [
  {
    field: "protein",
    setting: "proteinTarget",
    fallback: GOAL_DEFAULTS.proteinTarget,
    max: GOAL_MAX.proteinTarget,
    title: (value) => "Protein " + value + " g",
    note: () => "Day streak, from Tracker. Resets if a day is missed",
    passes: (logged, value) => logged >= value,
    changeLabel: "Change the protein target",
    dialogTitle: "Protein target",
    dialogNote: "Each day at or above this many grams extends your streak. A day below it, or with nothing logged, resets it to 0. Today only counts once it is over.",
    dialogLabel: "Grams per day",
  },
  {
    field: "calories",
    setting: "calorieLimit",
    fallback: GOAL_DEFAULTS.calorieLimit,
    max: GOAL_MAX.calorieLimit,
    title: () => "Calorie deficit",
    note: (value) => "Day streak at or under " + value + " kcal. Resets if missed",
    // a logged 0 is treated as "nothing logged", so an empty day is never counted as a deficit
    passes: (logged, value) => logged > 0 && logged <= value,
    changeLabel: "Change the calorie limit",
    dialogTitle: "Calorie limit",
    dialogNote: "Each day at or under this many calories extends your deficit streak. A day above it, or with nothing logged, resets it to 0. Today only counts once it is over.",
    dialogLabel: "Calories per day",
  },
];

const listEl = document.getElementById("habit-list");
const emptyEl = document.getElementById("empty");
const errorEl = document.getElementById("error");
const formEl = document.getElementById("add-form");
const inputEl = document.getElementById("new-habit");
const importEl = document.getElementById("import");
const editToggleEl = document.getElementById("edit-toggle");
const statusEl = document.getElementById("status");
const targetDialogEl = document.getElementById("target-dialog");
const targetFormEl = document.getElementById("target-form");
const targetTitleEl = document.getElementById("target-title");
const targetNoteEl = document.getElementById("target-note");
const targetLabelEl = document.getElementById("target-label");
const targetInputEl = document.getElementById("target-input");
const targetErrorEl = document.getElementById("target-error");
const targetCancelEl = document.getElementById("target-cancel");

// Every document lives under the signed-in user's own path (users/<id>/...), and the security
// rules only let that user read it. userId is set when sign-in completes.
let userId = null;
const habitsCollection = () => collection(db, "users", userId, "habits");
const habitDoc = (id) => doc(db, "users", userId, "habits", id);
const saves = createSaveTracker(statusEl, showError);

let habits = [];
// date key (YYYY-MM-DD) -> { calories, protein }, as logged on the Tracker page
let nutritionByDay = {};
let settings = defaultSettings();
// The order the person chose, as a list of ids: the id of a habit, or "auto:<field>" for a built-in one.
// Kept in the account's settings so it follows them across devices.
let habitOrder = [];
// Edit mode: each row shows move buttons (and delete, or the target button for a built-in habit)
// instead of the everyday + and reset buttons, so editing can't change a count by accident.
let editing = false;
let activeAuto = null;        // the built-in habit whose setting the dialog is editing
let nutritionLoaded = false;  // the built-in habits stay hidden until this data has arrived

function defaultSettings() {
  const values = {};
  for (const auto of AUTO_HABITS) {
    values[auto.setting] = auto.fallback;
  }
  return values;
}

function showError(err) {
  errorEl.textContent = typeof err === "string" ? err : describeFirestoreError(err);
  errorEl.hidden = false;
}

// Straight blend between the two colors. Done here, not with the CSS color-mix function, so it
// also works in older browsers.
function heatColor(count) {
  const heat = Math.min(Math.max(count, 0), HEAT_FULL_AT) / HEAT_FULL_AT;
  const channel = (index) => Math.round(COOL_RGB[index] + (HOT_RGB[index] - COOL_RGB[index]) * heat);
  return "rgb(" + channel(0) + ", " + channel(1) + ", " + channel(2) + ")";
}

function isValidHabit(item) {
  return item !== null && typeof item === "object" &&
         typeof item.name === "string" &&
         Number.isInteger(item.count) && item.count >= 0;
}

/* ---------- database ---------- */

function listen() {
  // one document per habit; createdAt keeps the list in the order habits were added
  const habitsQuery = query(habitsCollection(), orderBy("createdAt"));
  return onSnapshot(habitsQuery, (snapshot) => {
    habits = [];
    for (const snap of snapshot.docs) {
      const data = snap.data();
      if (isValidHabit(data)) {
        habits.push({ id: snap.id, name: data.name, count: data.count });
      } else {
        console.warn("Skipping malformed habit document", snap.id);
      }
    }
    render();
    saves.show();
  }, showError);
}

// The Tracker data comes from the same database, so the built-in habits are always computed from
// the current numbers instead of being stored: edit a past day there and they follow.
const nutritionCollection = () => collection(db, "users", userId, "nutrition");

function loggedAmount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function listenNutrition() {
  return onSnapshot(nutritionCollection(), (snapshot) => {
    nutritionByDay = {};
    for (const snap of snapshot.docs) {
      if (DATE_KEY_PATTERN.test(snap.id)) {
        const data = snap.data();
        nutritionByDay[snap.id] = { calories: loggedAmount(data.calories), protein: loggedAmount(data.protein) };
      }
    }
    nutritionLoaded = true;
    render();
  }, showError);
}

/* ---------- the built-in habits' numbers: one setting each, kept in the account's own settings ---------- */

const settingsRef = () => doc(db, "users", userId, "meta", "settings");

function isValidSetting(auto, value) {
  return Number.isInteger(value) && value >= 1 && value <= auto.max;
}

// Live, so a change made on another device shows up here too. A missing or invalid stored value
// means the fallback.
function listenSettings() {
  return onSnapshot(settingsRef(), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    settings = defaultSettings();
    for (const auto of AUTO_HABITS) {
      if (isValidSetting(auto, data[auto.setting])) {
        settings[auto.setting] = data[auto.setting];
      }
    }
    habitOrder = isValidOrder(data.habitOrder) ? data.habitOrder : [];
    render();
  }, showError);
}

function isValidOrder(value) {
  return Array.isArray(value) && value.length <= MAX_ORDER_ITEMS &&
         value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100);
}

function openTargetDialog(auto) {
  activeAuto = auto;
  targetTitleEl.textContent = auto.dialogTitle;
  targetNoteEl.textContent = auto.dialogNote;
  targetLabelEl.textContent = auto.dialogLabel;
  targetInputEl.max = auto.max;
  targetInputEl.value = String(settings[auto.setting]);
  targetErrorEl.hidden = true;
  targetDialogEl.showModal();
  targetInputEl.select();
}

targetFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = targetInputEl.value.trim();
  const value = Number(text);
  if (activeAuto === null) {
    return;
  }
  if (targetInputEl.validity.badInput || text === "" || !isValidSetting(activeAuto, value)) {
    targetErrorEl.textContent = "Use a whole number from 1 to " + activeAuto.max + ".";
    targetErrorEl.hidden = false;
    return;
  }
  settings[activeAuto.setting] = value;  // shown at once; the saved copy follows
  saves.track(setDoc(settingsRef(), { [activeAuto.setting]: value }, { merge: true }));
  render();
  targetDialogEl.close();
});

targetCancelEl.addEventListener("click", () => targetDialogEl.close());
targetDialogEl.addEventListener("click", (event) => {
  if (event.target === targetDialogEl) {
    targetDialogEl.close();
  }
});

// Local date parts, not toISOString(): that converts to UTC and can give the wrong day.
function dateKey(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" +
         String(date.getDate()).padStart(2, "0");
}

// A day streak: starting from yesterday and going back one day at a time, how many days in a row
// pass the test. The first day that fails, or has nothing logged, ends it, and what came before
// no longer counts, so a miss sends the number back to 0. Today is never looked at: the day is
// not over, so it can neither extend the streak nor break it.
const MAX_STREAK_LOOKBACK = 3660;  // ten years of days: a safety stop, the data ends long before

function streakDays(auto) {
  const limit = settings[auto.setting];
  const day = new Date();
  let streak = 0;
  for (let step = 0; step < MAX_STREAK_LOOKBACK; step += 1) {
    day.setDate(day.getDate() - 1);  // calendar arithmetic, so month ends and clock changes are safe
    const entry = nutritionByDay[dateKey(day)];
    const logged = entry ? entry[auto.field] : null;
    if (logged === null || !auto.passes(logged, limit)) {
      return streak;
    }
    streak += 1;
  }
  return streak;
}

function addHabit(name) {
  saves.track(addDoc(habitsCollection(), { name: name, count: 0, createdAt: Date.now() }));
}

// increment() runs on the server, so two devices tapping + at once both count
function incrementHabit(id) {
  saves.track(updateDoc(habitDoc(id), { count: increment(1) }));
}

function resetHabit(id) {
  saves.track(updateDoc(habitDoc(id), { count: 0 }));
}

function deleteHabit(id) {
  saves.track(deleteDoc(habitDoc(id)));
}

/* ---------- one-time import of data saved in this browser ---------- */

function readLegacyHabits() {
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
    const valid = Array.isArray(parsed) ? parsed.filter(isValidHabit) : [];
    return valid.length > 0 ? { raw: raw, habits: valid } : null;
  } catch (err) {
    console.error("Old local habits could not be read:", err);
    return null;
  }
}

function offerImport() {
  const legacy = readLegacyHabits();
  if (legacy === null) {
    importEl.hidden = true;
    return;
  }
  const count = legacy.habits.length;
  importEl.textContent = "Import " + count + " habit" + (count === 1 ? "" : "s") + " from this device";
  importEl.hidden = false;
}

importEl.addEventListener("click", async () => {
  const legacy = readLegacyHabits();
  if (legacy === null) {
    importEl.hidden = true;
    return;
  }

  importEl.disabled = true;
  try {
    const batch = writeBatch(db);
    const base = Date.now();
    legacy.habits.forEach((habit, index) => {
      batch.set(doc(habitsCollection()), { name: habit.name, count: habit.count, createdAt: base + index });
    });
    await batch.commit();
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

/* ---------- display ---------- */

function makeButton(className, label, text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon " + className;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

// Every row has the same columns: name, number, then the button slots, flush against the right edge:
// two in everyday use (+ and reset), three in edit mode. A row that has no buttons keeps empty
// spacers of the same size, so the numbers of all rows stay in one column.
function makeSpacer() {
  const slot = document.createElement("span");
  slot.className = "slot";
  return slot;
}

// The first two slots in edit mode: move up, move down.
function makeMoveButtons(item, index, total) {
  const up = makeButton("move", "Move up", "\u2191", () => moveItem(item.id, -1));
  const down = makeButton("move", "Move down", "\u2193", () => moveItem(item.id, 1));
  up.dataset.move = item.id + ":up";
  down.dataset.move = item.id + ":down";
  up.disabled = index === 0;
  down.disabled = index === total - 1;
  return [up, down];
}

// A built-in row. Normally it only shows its number; in edit mode it can be moved, and its third
// button changes the setting it counts against. The explanation sits on its own line underneath.
function makeAutoRow(item, index, total) {
  const auto = item.auto;
  const value = settings[auto.setting];
  const row = document.createElement("li");
  row.className = "auto";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = auto.title(value);
  const note = document.createElement("small");
  note.className = "auto-note";
  note.textContent = auto.note(value);

  const days = streakDays(auto);
  row.style.backgroundColor = heatColor(days);
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(days);

  const slots = editing
    ? [...makeMoveButtons(item, index, total), makeButton("edit", auto.changeLabel, "\u270e", () => openTargetDialog(auto))]
    : [makeSpacer(), makeSpacer()];
  row.append(name, count, ...slots, note);
  return row;
}

function makeHabitRow(item, index, total) {
  const habit = item.habit;
  const row = document.createElement("li");

  // textContent, not innerHTML: habit names are user input and must not be parsed as HTML.
  const name = document.createElement("span");
  name.className = "name";
  name.dir = "auto";  // a Hebrew habit name reads right-to-left
  name.textContent = habit.name;

  row.style.backgroundColor = heatColor(habit.count);
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(habit.count);

  // Deleting is only offered in edit mode, away from the buttons that get tapped every day.
  const slots = editing
    ? [
      ...makeMoveButtons(item, index, total),
      makeButton("del", "Delete " + habit.name, "\u00d7", () => {
        if (confirm("Delete \"" + habit.name + "\"?")) {
          deleteHabit(habit.id);
        }
      }),
    ]
    : [
      makeButton("inc", "Increment " + habit.name, "+", () => incrementHabit(habit.id)),
      makeButton("reset", "Reset " + habit.name, "\u21ba", () => resetHabit(habit.id)),
    ];
  row.append(name, count, ...slots);
  return row;
}

// Everything on the list in the order it is shown: built-in habits and the person's own. Ids that
// are in the saved order come first, in that order; anything not in it (a habit added since) goes
// after them in its natural place, and ids of habits that no longer exist are simply ignored.
function orderedItems() {
  const items = [];
  if (nutritionLoaded) {
    for (const auto of AUTO_HABITS) {
      items.push({ id: "auto:" + auto.field, auto: auto });
    }
  }
  for (const habit of habits) {
    items.push({ id: habit.id, habit: habit });
  }
  const position = new Map(habitOrder.map((id, index) => [id, index]));
  return items
    .map((item, natural) => ({ item: item, natural: natural }))
    .sort((a, b) => {
      const pa = position.has(a.item.id) ? position.get(a.item.id) : Infinity;
      const pb = position.has(b.item.id) ? position.get(b.item.id) : Infinity;
      if (pa !== pb) {
        return pa < pb ? -1 : 1;
      }
      return a.natural - b.natural;
    })
    .map((entry) => entry.item);
}

// Swaps a row with its neighbour and saves the whole new order. Saving the full list (not just the
// two swapped ids) also settles the position of anything that was not in the saved order yet.
function moveItem(id, delta) {
  const items = orderedItems();
  const index = items.findIndex((item) => item.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) {
    return;
  }
  [items[index], items[target]] = [items[target], items[index]];
  habitOrder = items.map((item) => item.id);
  saves.track(setDoc(settingsRef(), { habitOrder: habitOrder }, { merge: true }));
  render();

  // keep the keyboard focus on the row that moved, so it can be nudged again
  const same = listEl.querySelector('[data-move="' + id + (delta < 0 ? ":up" : ":down") + '"]');
  const other = listEl.querySelector('[data-move="' + id + (delta < 0 ? ":down" : ":up") + '"]');
  const focusTarget = same && !same.disabled ? same : other;
  if (focusTarget) {
    focusTarget.focus();
    focusTarget.scrollIntoView({ block: "nearest" });
  }
}

editToggleEl.addEventListener("click", () => {
  editing = !editing;
  render();
});

function render() {
  // The list is rebuilt on every change, including the echo of our own save. Remember which move
  // button had the keyboard focus, so it keeps it.
  const focusedMove = document.activeElement && listEl.contains(document.activeElement)
    ? document.activeElement.dataset.move : undefined;
  listEl.replaceChildren();

  const items = orderedItems();
  // with nothing on the list there is nothing to edit
  if (items.length === 0) {
    editing = false;
  }
  editToggleEl.hidden = items.length === 0;
  editToggleEl.textContent = editing ? "Done" : "Edit";

  items.forEach((item, index) => {
    listEl.append(item.auto ? makeAutoRow(item, index, items.length) : makeHabitRow(item, index, items.length));
  });

  emptyEl.hidden = habits.length > 0;

  if (focusedMove !== undefined) {
    const again = listEl.querySelector('[data-move="' + focusedMove + '"]');
    if (again && !again.disabled) {
      again.focus();
    }
  }
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = inputEl.value.trim();
  if (name === "") {
    return;
  }
  addHabit(name);
  inputEl.value = "";
});

// a day can end while the page is open: recount when the person comes back to it
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && nutritionLoaded) {
    render();
  }
});

initGate({
  onSignedIn(user) {
    userId = user.uid;
    offerImport();
    const unsubscribe = listen();
    const unsubscribeNutrition = listenNutrition();
    const unsubscribeSettings = listenSettings();
    return () => {
      unsubscribe();
      unsubscribeNutrition();
      unsubscribeSettings();
      if (targetDialogEl.open) {
        targetDialogEl.close();
      }
      activeAuto = null;
      habitOrder = [];
      editing = false;
      settings = defaultSettings();
      userId = null;
      // drop the data from memory and screen when signing out
      habits = [];
      nutritionByDay = {};
      nutritionLoaded = false;
      render();
    };
  },
});
