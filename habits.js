import {
  db, initGate, createSaveTracker, describeFirestoreError,
  collection, doc, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, increment, writeBatch,
} from "./firebase.js?v=17";

// Where this page kept its data before it moved to the database
const LEGACY_KEY = "habitsStreak.habits";

const listEl = document.getElementById("habit-list");
const emptyEl = document.getElementById("empty");
const errorEl = document.getElementById("error");
const formEl = document.getElementById("add-form");
const inputEl = document.getElementById("new-habit");
const importEl = document.getElementById("import");
const statusEl = document.getElementById("status");

const habitsRef = collection(db, "habits");
const saves = createSaveTracker(statusEl, showError);

let habits = [];

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
  const habitsQuery = query(habitsRef, orderBy("createdAt"));
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

function addHabit(name) {
  saves.track(addDoc(habitsRef, { name: name, count: 0, createdAt: Date.now() }));
}

// increment() runs on the server, so two devices tapping + at once both count
function incrementHabit(id) {
  saves.track(updateDoc(doc(db, "habits", id), { count: increment(1) }));
}

function resetHabit(id) {
  saves.track(updateDoc(doc(db, "habits", id), { count: 0 }));
}

function deleteHabit(id) {
  saves.track(deleteDoc(doc(db, "habits", id)));
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
      batch.set(doc(habitsRef), { name: habit.name, count: habit.count, createdAt: base + index });
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

function render() {
  listEl.replaceChildren();

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

initGate({
  onSignedIn() {
    offerImport();
    const unsubscribe = listen();
    return () => {
      unsubscribe();
      // drop the data from memory and screen when signing out
      habits = [];
      render();
    };
  },
});
