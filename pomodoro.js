"use strict";

const CONFIG_KEY = "pomodoro.config";
const RUN_KEY = "pomodoro.run";
const LIMITS = { sessions: [1, 12], focusMin: [1, 180], breakMin: [1, 60] };
const DEFAULT_CONFIG = { sessions: 4, focusMin: 25, breakMin: 5 };
const TICK_MS = 250;

const setupEl = document.getElementById("setup");
const runEl = document.getElementById("run");
const errorEl = document.getElementById("error");
const beginEl = document.getElementById("begin");
const phaseEl = document.getElementById("phase");
const clockEl = document.getElementById("clock");
const pipsEl = document.getElementById("pips");
const pauseEl = document.getElementById("pause");
const stopEl = document.getElementById("stop");
const steppers = document.querySelectorAll(".stepper");

let config = loadConfig();
let run = loadRun();
let tickTimer = null;
let audioCtx = null;
let wakeLock = null;
let renderedPipsKey = "";

/* ---------- storage ---------- */

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    // Happens in some private-browsing modes; the timer still works, it just can't persist.
    showError("Browser storage is unavailable. Settings and timer will not be saved.");
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    showError("Could not save: " + err.message);
  }
}

function removeStored(key) {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    showError("Could not clear saved timer: " + err.message);
  }
}

function isValidSetting(key, value) {
  const [min, max] = LIMITS[key];
  return Number.isInteger(value) && value >= min && value <= max;
}

function isValidConfig(candidate) {
  return candidate !== null && typeof candidate === "object" &&
         Object.keys(LIMITS).every((key) => isValidSetting(key, candidate[key]));
}

function isValidRun(candidate) {
  if (candidate === null || typeof candidate !== "object" || !isValidConfig(candidate.config)) {
    return false;
  }
  if (!["focus", "break", "done"].includes(candidate.phase)) {
    return false;
  }
  if (!Number.isInteger(candidate.session) || candidate.session < 1 ||
      candidate.session > candidate.config.sessions) {
    return false;
  }
  if (candidate.phase === "done") {
    return true;
  }
  if (candidate.paused === true) {
    return Number.isFinite(candidate.remainingMs) && candidate.remainingMs >= 0;
  }
  return Number.isFinite(candidate.endsAt);
}

function loadConfig() {
  const raw = readStored(CONFIG_KEY);
  if (raw === null) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isValidConfig(parsed)) {
      throw new Error("unexpected data shape");
    }
    return parsed;
  } catch (err) {
    showError("Saved settings could not be read. Defaults are used.");
    return { ...DEFAULT_CONFIG };
  }
}

function loadRun() {
  const raw = readStored(RUN_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isValidRun(parsed)) {
      throw new Error("unexpected data shape");
    }
    return parsed;
  } catch (err) {
    showError("Saved timer could not be read and was discarded.");
    removeStored(RUN_KEY);
    return null;
  }
}

function saveRun() {
  if (run === null) {
    removeStored(RUN_KEY);
  } else {
    writeStored(RUN_KEY, JSON.stringify(run));
  }
}

/* ---------- settings ---------- */

function renderConfig() {
  for (const stepper of steppers) {
    stepper.querySelector("input").value = config[stepper.dataset.field];
  }
}

function setSetting(key, value) {
  if (!isValidSetting(key, value)) {
    // a typed value that is blank, fractional or out of range snaps back to the last good one
    renderConfig();
    return;
  }
  config[key] = value;
  renderConfig();
  writeStored(CONFIG_KEY, JSON.stringify(config));
}

function clampSetting(key, value) {
  const [min, max] = LIMITS[key];
  return Math.min(max, Math.max(min, value));
}

for (const stepper of steppers) {
  const key = stepper.dataset.field;
  const input = stepper.querySelector("input");
  input.min = LIMITS[key][0];
  input.max = LIMITS[key][1];

  stepper.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-step]");
    if (button) {
      setSetting(key, clampSetting(key, config[key] + Number(button.dataset.step)));
    }
  });
  // "change", not "input": typing "25" must not be judged after the first digit
  input.addEventListener("change", () => setSetting(key, Number(input.value)));
}

/* ---------- timer logic ---------- */

function phaseMs(settings, phase) {
  const minutes = phase === "focus" ? settings.focusMin : settings.breakMin;
  return minutes * 60 * 1000;
}

// Moves to the next phase for every phase boundary already in the past. Looping (instead of one
// step) catches up correctly after the tab slept or the page was reloaded mid-session.
// Each new deadline is built from the previous one, not from "now", so no time is lost or gained.
function advance(state, now) {
  let changed = false;
  while (state.phase !== "done" && now >= state.endsAt) {
    const finishedAt = state.endsAt;
    if (state.phase === "focus") {
      if (state.session >= state.config.sessions) {
        state.phase = "done";
        state.endsAt = null;
      } else {
        state.phase = "break";
        state.endsAt = finishedAt + phaseMs(state.config, "break");
      }
    } else {
      state.phase = "focus";
      state.session += 1;
      state.endsAt = finishedAt + phaseMs(state.config, "focus");
    }
    changed = true;
  }
  return changed;
}

function remainingMs() {
  return run.paused ? run.remainingMs : Math.max(0, run.endsAt - Date.now());
}

function isCounting() {
  return run !== null && run.phase !== "done" && !run.paused;
}

function tick() {
  if (!isCounting()) {
    return;
  }
  if (advance(run, Date.now())) {
    alertPhaseChange();
    saveRun();
  }
  if (run.phase === "done") {
    stopTicking();
    releaseScreen();
  }
  render();
}

function startTicking() {
  if (tickTimer === null) {
    tickTimer = setInterval(tick, TICK_MS);
  }
}

function stopTicking() {
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/* ---------- alerts and screen ---------- */

// iOS only lets audio start from a tap, so the context is created/resumed inside click handlers.
function prepareAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }
    if (audioCtx === null) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  } catch (err) {
    console.error("Audio unavailable:", err);
  }
}

function beep(count) {
  if (audioCtx === null) {
    return;
  }
  const start = audioCtx.currentTime;
  for (let index = 0; index < count; index += 1) {
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.type = "square";
    oscillator.frequency.value = 880;
    gain.gain.value = 0.15;
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start(start + index * 0.25);
    oscillator.stop(start + index * 0.25 + 0.15);
  }
}

function alertPhaseChange() {
  beep(run.phase === "done" ? 3 : 2);
  if (navigator.vibrate) {
    navigator.vibrate([200, 100, 200]);
  }
}

async function holdScreenAwake() {
  if (!("wakeLock" in navigator)) {
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (err) {
    // Needs https and a visible tab; failing only means the phone may dim, so just log it.
    console.error("Wake lock refused:", err);
  }
}

function releaseScreen() {
  if (wakeLock !== null) {
    wakeLock.release().catch((err) => console.error("Wake lock release failed:", err));
    wakeLock = null;
  }
}

/* ---------- display ---------- */

function formatClock(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
}

function renderPips() {
  const sessions = run.config.sessions;
  let completed;
  if (run.phase === "done") {
    completed = sessions;
  } else {
    completed = run.phase === "focus" ? run.session - 1 : run.session;
  }
  const current = run.phase === "focus" ? run.session - 1 : -1;

  const key = sessions + ":" + completed + ":" + current;
  if (key === renderedPipsKey) {
    return;
  }
  renderedPipsKey = key;

  pipsEl.replaceChildren();
  for (let index = 0; index < sessions; index += 1) {
    const pip = document.createElement("span");
    pip.className = "pip";
    if (index < completed) {
      pip.classList.add("done");
    } else if (index === current) {
      pip.classList.add("current");
    }
    pipsEl.append(pip);
  }
}

function render() {
  setupEl.hidden = run !== null;
  runEl.hidden = run === null;
  if (run === null) {
    document.title = "Pomodoro";
    return;
  }

  const done = run.phase === "done";
  const clockText = done ? "DONE" : formatClock(remainingMs());

  clockEl.textContent = clockText;
  clockEl.classList.toggle("break", run.phase === "break");
  clockEl.classList.toggle("done", done);

  if (done) {
    phaseEl.textContent = run.config.sessions + " sessions complete";
  } else {
    const label = run.phase === "focus" ? "Focus" : "Break";
    phaseEl.textContent = label + " · session " + run.session + " of " + run.config.sessions;
  }

  pauseEl.hidden = done;
  pauseEl.textContent = run.paused ? "Resume" : "Pause";
  stopEl.textContent = done ? "Reset" : "Stop";
  // the tab title doubles as a countdown when the page is in the background
  document.title = done ? "Done - Pomodoro" : clockText + " " + run.phase + " - Pomodoro";

  renderPips();
}

/* ---------- controls ---------- */

beginEl.addEventListener("click", () => {
  prepareAudio();
  run = {
    phase: "focus",
    session: 1,
    endsAt: Date.now() + phaseMs(config, "focus"),
    paused: false,
    remainingMs: null,
    // copied so the running session keeps its numbers even if settings change later
    config: { ...config },
  };
  saveRun();
  holdScreenAwake();
  startTicking();
  render();
});

pauseEl.addEventListener("click", () => {
  if (run === null || run.phase === "done") {
    return;
  }
  if (run.paused) {
    run.endsAt = Date.now() + run.remainingMs;
    run.remainingMs = null;
    run.paused = false;
    prepareAudio();
    holdScreenAwake();
    startTicking();
  } else {
    run.remainingMs = Math.max(0, run.endsAt - Date.now());
    run.endsAt = null;
    run.paused = true;
    stopTicking();
    releaseScreen();
  }
  saveRun();
  render();
});

stopEl.addEventListener("click", () => {
  if (run !== null && run.phase !== "done" && !confirm("Stop the timer?")) {
    return;
  }
  run = null;
  stopTicking();
  releaseScreen();
  saveRun();
  render();
});

// The OS drops the wake lock and may have frozen timers while the tab was hidden, so on return
// re-acquire the lock and recompute from the clock immediately.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isCounting()) {
    holdScreenAwake();
    tick();
  }
});

// A reloaded page has no audio context; the first tap anywhere creates one.
document.addEventListener("pointerdown", prepareAudio, { once: true });

renderConfig();
if (isCounting()) {
  startTicking();
  holdScreenAwake();
  tick();
}
render();
