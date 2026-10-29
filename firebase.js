// Firebase Web SDK loaded from Google's CDN as ES modules, pinned to one version, because the
// site is plain static files with no build step. To upgrade, change the version in every URL
// below (import specifiers must be literal strings, so it can't live in a variable).
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getFirestore,
  terminate, clearIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

export {
  collection, doc, query, orderBy, limit, onSnapshot, getDoc, getDocs, getDocFromCache, getDocsFromCache, addDoc, setDoc, updateDoc,
  deleteDoc, increment, writeBatch,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

// These values are not secrets: they only say which project to talk to. Who may read or write
// is enforced by the Firestore Security Rules on Google's servers.
const firebaseConfig = {
  apiKey: "AIzaSyDvmvLKXsBplo20LDwkWyrJENYHxlmwyTM",
  authDomain: "productive-752f2.firebaseapp.com",
  projectId: "productive-752f2",
  storageBucket: "productive-752f2.firebasestorage.app",
  messagingSenderId: "939985773989",
  appId: "1:939985773989:web:5601de79f6964efe7b744c",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Keeps a copy of your data in this browser (IndexedDB). Pages draw from that copy at once and
// update from the server a moment later, instead of waiting for the network every time.
// Several tabs can share it. Where the browser refuses (some private modes), fall back to the
// plain in-memory database.
function openDatabase() {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (err) {
    console.warn("Offline copy unavailable, using memory only:", err);
    return getFirestore(app);
  }
}
export const db = openDatabase();

export function describeFirestoreError(err) {
  if (err && err.code === "permission-denied") {
    return "Access denied by the database rules. The latest rules may not be published yet " +
           "(Firebase console > Firestore > Rules).";
  }
  if (err && err.code === "unavailable") {
    return "Cannot reach the database. Check your connection.";
  }
  return err && err.message ? err.message : String(err);
}

function describeAuthError(err) {
  switch (err && err.code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was cancelled.";
    case "auth/popup-blocked":
      return "The sign-in popup was blocked. Allow popups for this site and tap again.";
    case "auth/unauthorized-domain":
      return "This site's domain is not authorized in Firebase " +
             "(Authentication > Settings > Authorized domains).";
    default:
      return err && err.message ? err.message : String(err);
  }
}

// Shows either the sign-in screen or the page content, and runs onSignedIn(user) whenever a
// user is signed in. onSignedIn may return a cleanup function; it runs on sign-out so the page
// stops listening to the database and drops the data it was holding.
export function initGate({ onSignedIn }) {
  const gateEl = document.getElementById("gate");
  const contentEl = document.getElementById("content");
  const signInEl = document.getElementById("sign-in");
  const signOutEl = document.getElementById("sign-out");
  const messageEl = document.getElementById("gate-message");
  const checkingEl = document.getElementById("checking");
  let cleanup = null;

  function showMessage(text) {
    messageEl.textContent = text;
    messageEl.hidden = text === "";
  }

  // signInWithPopup (not redirect): the auth domain differs from this site's domain, and Safari
  // blocks the cross-site storage that the redirect flow relies on. It must run inside the tap.
  signInEl.addEventListener("click", async () => {
    showMessage("");
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      showMessage(describeAuthError(err));
    }
  });

  signOutEl.addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (err) {
      showMessage(describeAuthError(err));
      return;
    }
    // The offline copy of your data lives in this browser. Wipe it on sign-out so a shared
    // computer keeps nothing. If another tab still has the database open the wipe is
    // refused; the page reloads either way and shows the sign-in screen.
    try {
      await terminate(db);
      await clearIndexedDbPersistence(db);
    } catch (err) {
      console.warn("Could not clear the offline copy:", err);
    }
    location.reload();
  });

  onAuthStateChanged(auth, (user) => {
    if (cleanup !== null) {
      cleanup();
      cleanup = null;
    }
    checkingEl.hidden = true;
    gateEl.hidden = user !== null;
    contentEl.hidden = user === null;
    if (user !== null) {
      cleanup = onSignedIn(user) || null;
    }
  });
}

// Shows "Saving..." while writes are in flight and "Saved" once the server has confirmed them.
// Offline, the SDK keeps the writes queued, so the label says so instead of claiming success.
export function createSaveTracker(statusEl, onError) {
  let pending = 0;

  function show() {
    if (!navigator.onLine) {
      statusEl.textContent = "Offline: changes sync when you reconnect";
    } else {
      statusEl.textContent = pending > 0 ? "Saving…" : "Saved";
    }
  }

  window.addEventListener("online", show);
  window.addEventListener("offline", show);

  return {
    show,
    track(promise) {
      pending += 1;
      show();
      promise.then(
        () => { pending -= 1; show(); },
        (err) => { pending -= 1; show(); onError(err); },
      );
    },
  };
}
