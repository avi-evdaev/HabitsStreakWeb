import {
  db, initGate, createSaveTracker, describeFirestoreError,
  collection, doc, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, increment, writeBatch,
} from "./firebase.js?v=30";

// Where this page kept its data before it moved to the database
const LEGACY_KEY = "habitsStreak.habits";
// The built-in protein habit counts days at or above this many grams (from the Nutrition page).
const PROTEIN_TARGET = 140;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const listEl = document.getElementById("habit-list");
const emptyEl = document.getElementById("empty");
const errorEl = document.getElementById("error");
const formEl = document.getElementById("add-form");
const inputEl = document.getElementById("new-habit");
const importEl = document.getElementById("import");
const statusEl = document.getElementById("status");

// Every document lives under the signed-in user's own path (users/<id>/...), and the security
// rules only let that user read it. userId is set when sign-in completes.
let userId = null;
const habitsCollection = () => collection(db, "users", userId, "habits");
const habitDoc = (id) => doc(db, "users", userId, "habits", id);
const saves = createSaveTracker(statusEl, showError);

let habits = [];
// date key (YYYY-MM-DD) -> grams of protein, as logged on the Nutrition page
let proteinByDay = {};
let nutritionLoaded = false;  // the built-in habit stays hidden until this data has arrived

function showError(err) {
  errorEl.textContent = typeof err === "string" ? err : describeFirestoreError(err);
  errorEl.hidden = false;
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

// The Nutrition data comes from the same database, so the built-in habit is always computed from
// the current numbers instead of being stored: edit a past day there and this follows.
const nutritionCollection = () => collection(db, "users", userId, "nutrition");

function listenNutrition() {
  return onSnapshot(nutritionCollection(), (snapshot) => {
    proteinByDay = {};
    for (const snap of snapshot.docs) {
      const protein = snap.data().protein;
      if (DATE_KEY_PATTERN.test(snap.id) && Number.isInteger(protein) && protein >= 0) {
        proteinByDay[snap.id] = protein;
      }
    }
    nutritionLoaded = true;
    render();
  }, showError);
}

// Local date parts, not toISOString(): that converts to UTC and can give the wrong day.
function todayKey() {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" +
         String(now.getDate()).padStart(2, "0");
}

// Days at or above the target, counting only finished days: today is left out even if it
// already reached the target, because the day is not over. Date keys sort like dates.
function countProteinDays() {
  const today = todayKey();
  let days = 0;
  for (const [key, protein] of Object.entries(proteinByDay)) {
    if (key < today && protein >= PROTEIN_TARGET) {
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

// The built-in row: no buttons, because its number is not typed in, it comes from Nutrition.
function makeProteinRow() {
  const row = document.createElement("li");
  row.className = "auto";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = "Protein " + PROTEIN_TARGET + " g";
  const note = document.createElement("small");
  note.className = "auto-note";
  note.textContent = "Automatic, from Nutrition. Up to yesterday.";
  name.append(note);

  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(countProteinDays());

  row.append(name, count);
  return row;
}

function render() {
  listEl.replaceChildren();

  if (nutritionLoaded) {
    listEl.append(makeProteinRow());
  }

  for (const habit of habits) {
    const row = document.createElement("li");

    // textContent, not innerHTML: habit names are user input and must not be parsed as HTML.
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = habit.name;

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
    return () => {
      unsubscribe();
      unsubscribeNutrition();
      userId = null;
      // drop the data from memory and screen when signing out
      habits = [];
      proteinByDay = {};
      nutritionLoaded = false;
      render();
    };
  },
});
