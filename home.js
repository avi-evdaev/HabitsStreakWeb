import {
  db, initGate, describeFirestoreError,
  collection, doc, query, limit, getDoc, getDocs, setDoc, writeBatch,
} from "./firebase.js?v=18";

// Before accounts existed, data lived in these shared collections. It now lives under
// users/<id>/<name>, and this page offers a one-time copy of the old data into the account.
const LEGACY_COLLECTIONS = ["habits", "nutrition", "quotes"];
const BATCH_SIZE = 400;

const errorEl = document.getElementById("error");
const statusEl = document.getElementById("status");
const moveEl = document.getElementById("move");
const moveNoteEl = document.getElementById("move-note");

let userId = null;

function showError(err) {
  errorEl.textContent = typeof err === "string" ? err : describeFirestoreError(err);
  errorEl.hidden = false;
}

const migrationDoc = () => doc(db, "users", userId, "meta", "migration");

// Looks once per account. The flag document records that the question was settled, so later
// visits cost a single read instead of scanning the old collections.
async function offerMove(id) {
  const flag = await getDoc(migrationDoc());
  if (flag.exists()) {
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
    return () => {
      userId = null;
      statusEl.textContent = "";
      moveEl.hidden = true;
      moveNoteEl.hidden = true;
      errorEl.hidden = true;
    };
  },
});
