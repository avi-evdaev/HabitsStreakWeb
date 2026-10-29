import {
  db, initGate, describeFirestoreError,
  collection, doc, query, limit, getDoc, getDocs, getDocFromCache, getDocsFromCache, setDoc,
  writeBatch,
} from "./firebase.js?v=37";

// Before accounts existed, data lived in these shared collections. It now lives under
// users/<id>/<name>, and this page offers a one-time copy of the old data into the account.
const LEGACY_COLLECTIONS = ["habits", "nutrition", "quotes"];
const BATCH_SIZE = 400;

const errorEl = document.getElementById("error");
const statusEl = document.getElementById("status");
const moveEl = document.getElementById("move");
const moveNoteEl = document.getElementById("move-note");
const quoteBoxEl = document.getElementById("home-quote");
const quoteTextEl = document.getElementById("home-quote-text");
const quoteAuthorEl = document.getElementById("home-quote-author");

let userId = null;

function showError(err) {
  errorEl.textContent = typeof err === "string" ? err : describeFirestoreError(err);
  errorEl.hidden = false;
}

const migrationDoc = () => doc(db, "users", userId, "meta", "migration");

// The local copy answers instantly. Only when nothing is stored yet (a first visit on this
// device) is the server asked, and the answer is then kept for next time.
async function isMarkedDone() {
  try {
    if ((await getDocFromCache(migrationDoc())).exists()) {
      return true;
    }
  } catch (err) {
    // not stored locally yet
  }
  return (await getDoc(migrationDoc())).exists();
}

async function readQuotes(id) {
  const quotesRef = collection(db, "users", id, "quotes");
  try {
    const cached = await getDocsFromCache(quotesRef);
    if (!cached.empty) {
      return cached;
    }
  } catch (err) {
    // no local copy yet
  }
  return getDocs(quotesRef);
}

function isValidQuote(data) {
  return data !== null && typeof data === "object" &&
         typeof data.text === "string" && data.text.trim() !== "" &&
         (data.author === undefined || typeof data.author === "string");
}

// Shows one of the account's quotes at random, picked again on every page load. It reads the
// local copy when there is one, so it is instant and costs no database reads.
async function showRandomQuote(id) {
  const snapshot = await readQuotes(id);
  const quotes = snapshot.docs.map((snap) => snap.data()).filter(isValidQuote);
  // nothing to show, or the person signed out while the request was running
  if (quotes.length === 0 || id !== userId) {
    return;
  }
  const pick = quotes[Math.floor(Math.random() * quotes.length)];
  // textContent, not innerHTML: quotes are user input and must not be parsed as HTML.
  quoteTextEl.textContent = pick.text;
  quoteAuthorEl.textContent = pick.author || "";
  quoteAuthorEl.hidden = !pick.author;
  quoteBoxEl.hidden = false;
}

// Looks once per account. The flag document records that the question was settled, so later
// visits cost a single read instead of scanning the old collections.
async function offerMove(id) {
  if (await isMarkedDone()) {
    return;
  }

  for (const name of LEGACY_COLLECTIONS) {
    let snapshot;
    try {
      snapshot = await getDocs(query(collection(db, name), limit(1)));
    } catch (err) {
      if (err.code === "permission-denied") {
        // not the account that owns the old data, so there is nothing to move
        await setDoc(migrationDoc(), { done: true, moved: 0, at: Date.now() });
        return;
      }
      throw err;
    }
    if (!snapshot.empty) {
      if (id === userId) {
        moveEl.hidden = false;
      }
      return;
    }
  }
  // no old data anywhere: settle the question so this check never runs again
  await setDoc(migrationDoc(), { done: true, moved: 0, at: Date.now() });
}

async function moveData() {
  let moved = 0;
  for (const name of LEGACY_COLLECTIONS) {
    const snapshot = await getDocs(collection(db, name));
    // same document ids, so running this twice only rewrites the same documents
    for (let start = 0; start < snapshot.docs.length; start += BATCH_SIZE) {
      const batch = writeBatch(db);
      for (const legacy of snapshot.docs.slice(start, start + BATCH_SIZE)) {
        batch.set(doc(db, "users", userId, name, legacy.id), legacy.data());
      }
      await batch.commit();
    }
    moved += snapshot.docs.length;
  }
  await setDoc(migrationDoc(), { done: true, moved: moved, at: Date.now() });
  return moved;
}

moveEl.addEventListener("click", async () => {
  moveEl.disabled = true;
  try {
    const moved = await moveData();
    moveEl.hidden = true;
    moveNoteEl.textContent = "Moved " + moved + " item" + (moved === 1 ? "" : "s") +
                             " into your account. The old copies were left untouched.";
    moveNoteEl.hidden = false;
  } catch (err) {
    showError(err);
  } finally {
    moveEl.disabled = false;
  }
});

initGate({
  onSignedIn(user) {
    userId = user.uid;
    statusEl.textContent = "Signed in: " + user.email;
    offerMove(user.uid).catch(showError);
    showRandomQuote(user.uid).catch(showError);
    return () => {
      userId = null;
      statusEl.textContent = "";
      moveEl.hidden = true;
      moveNoteEl.hidden = true;
      quoteBoxEl.hidden = true;
      quoteTextEl.textContent = "";
      quoteAuthorEl.textContent = "";
      errorEl.hidden = true;
    };
  },
});
