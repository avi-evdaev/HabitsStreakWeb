"use strict";

const STORAGE_KEY = "habitsStreak.habits";

const listEl = document.getElementById("habit-list");
const emptyEl = document.getElementById("empty");
const errorEl = document.getElementById("error");
const formEl = document.getElementById("add-form");
const inputEl = document.getElementById("new-habit");

let habits = loadHabits();
render();

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function isValidHabit(item) {
  return item !== null && typeof item === "object" &&
         typeof item.id === "string" &&
         typeof item.name === "string" &&
         Number.isInteger(item.count) && item.count >= 0;
}

function loadHabits() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    // Happens in some private-browsing modes; the app still works, it just can't persist.
    showError("Browser storage is unavailable. Habits will not be saved.");
    return [];
  }
  if (raw === null) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isValidHabit)) {
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
    showError("Saved habits could not be read. The old data was kept under '" +
              STORAGE_KEY + ".corrupt'.");
    return [];
  }
}

function saveHabits() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(habits));
  } catch (err) {
    showError("Could not save habits: " + err.message);
  }
}

function newId() {
  // crypto.randomUUID needs a secure context; this works everywhere, including file://.
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function addHabit(name) {
  habits.push({ id: newId(), name: name, count: 0 });
  commit();
}

function changeCount(id, update) {
  const habit = habits.find((item) => item.id === id);
  if (!habit) {
    return;
  }
  habit.count = update(habit.count);
  commit();
}

function deleteHabit(id) {
  habits = habits.filter((item) => item.id !== id);
  commit();
}

function commit() {
  saveHabits();
  render();
}

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
      makeButton("inc", "Increment " + habit.name, "+",
                 () => changeCount(habit.id, (value) => value + 1)),
      makeButton("reset", "Reset " + habit.name, "↺",
                 () => changeCount(habit.id, () => 0)),
      // No swipe-to-delete in a browser, so deleting gets an explicit button.
      makeButton("del", "Delete " + habit.name, "×",
                 () => {
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
