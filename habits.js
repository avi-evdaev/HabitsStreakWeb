import {
  db, initGate, createSaveTracker, describeFirestoreError,
  collection, doc, query, orderBy, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc, increment,
  writeBatch,
} from "./firebase.js?v=31";

// Where this page kept its data before it moved to the database
const LEGACY_KEY = "habitsStreak.habits";
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A habit row heats up with its count: grey at 0, a little redder with each one, full red at
// HEAT_FULL_AT and beyond. The cool end is the normal row grey, so a habit at 0 looks unchanged.
const HEAT_FULL_AT = 10;
const COOL_RGB = [28, 28, 30];
const HOT_RGB = [209, 17, 27];

// Built-in habits. Their numbers are not typed in: each one counts the finished days on the
// Nutrition page whose logged value passes a test against a number the person sets for themselves.
// Everyone starts at the fallback and can change their own (kept in the account's settings).
const AUTO_HABITS = [
  {
    field: "protein",
    setting: "proteinTarget",
    fallback: 140,
    max: 1000,
    title: (value) => "Protein " + value + " g",
    note: () => "Automatic, from Nutrition, up to yesterday",
    passes: (logged, value) => logged >= value,
    changeLabel: "Change the protein target",
    dialogTitle: "Protein target",
    dialogNote: "Days at or above this many grams count, up to yesterday.",
    dialogLabel: "Grams per day",
  },
  {
    field: "calories",
    setting: "calorieLimit",
    fallback: 2000,
    max: 20000,
    title: () => "Calorie deficit",
    note: (value) => "At or under " + value + " kcal. Automatic, up to yesterday",
    // a logged 0 is treated as "nothing logged", so an empty day is never counted as a deficit
    passes: (logged, value) => logged > 0 && logged <= value,
    changeLabel: "Change the calorie limit",
    dialogTitle: "Calorie limit",
    dialogNote: "Days at or under this many calories count as a deficit, up to yesterday.",
    dialogLabel: "Calories per day",
  },
];

const listEl = document.getElementById("habit-list");
const emptyEl = document.getElementById("empty");
const errorEl = document.getElementById("error");
const formEl = document.getElementById("add-form");
const inputEl = document.getElementById("new-habit");
const importEl = document.getElementById("import");
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
// date key (YYYY-MM-DD) -> { calories, protein }, as logged on the Nutrition page
let nutritionByDay = {};
let settings = defaultSettings();
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

// The Nutrition data comes from the same database, so the built-in habits are always computed from
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
    render();
  }, showError);
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
function todayKey() {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" +
         String(now.getDate()).padStart(2, "0");
}

// Finished days that pass the test. Today is left out even if it already passes, because the day
// is not over. Days with nothing logged for the field never count. Date keys sort like dates.
function countDays(auto) {
  const today = todayKey();
  let days = 0;
  for (const [key, entry] of Object.entries(nutritionByDay)) {
    const logged = entry[auto.field];
    if (key < today && logged !== null && auto.passes(logged, settings[auto.setting])) {
      days += 1;
    }
  }
  return days;
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

// A built-in row has the same columns as a normal habit: name, number, then three button slots.
// Only the first slot holds a button (change the setting); the other two are empty spacers, so the
// numbers of all rows line up in one column. The explanation sits on its own line underneath.
function makeAutoRow(auto) {
  const value = settings[auto.setting];
  const row = document.createElement("li");
  row.className = "auto";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = auto.title(value);
  const note = document.createElement("small");
  note.className = "auto-note";
  note.textContent = auto.note(value);

  const days = countDays(auto);
  row.style.backgroundColor = heatColor(days);
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(days);

  const spacer = () => {
    const slot = document.createElement("span");
    slot.className = "slot";
    return slot;
  };
  row.append(name, count, makeButton("edit", auto.changeLabel, "✎", () => openTargetDialog(auto)),
             spacer(), spacer(), note);
  return row;
}

function render() {
  listEl.replaceChildren();

  if (nutritionLoaded) {
    for (const auto of AUTO_HABITS) {
      listEl.append(makeAutoRow(auto));
    }
  }

  for (const habit of habits) {
    const row = document.createElement("li");

    // textContent, not innerHTML: habit names are user input and must not be parsed as HTML.
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = habit.name;

    row.style.backgroundColor = heatColor(habit.count);
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(habit.count);

    row.append(
      name,
      count,
      makeButton("inc", "Increment " + habit.name, "+", () => incrementHabit(habit.id)),
      makeButton("reset", "Reset " + habit.name, "↺", () => resetHabit(habit.id)),
      // No swipe-to-delete in a browser, so deleting gets an explicit button.
      makeButton("del", "Delete " + habit.name, "×", () => {
        if (confirm("Delete \"" + habit.name + "\"?")) {
          deleteHabit(habit.id);
        }
      })
    );
    listEl.append(row);
  }

  emptyEl.hidden = habits.length > 0;
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
