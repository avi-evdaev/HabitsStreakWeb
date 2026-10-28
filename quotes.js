import {
  db, initGate, createSaveTracker, describeFirestoreError,
  collection, doc, query, orderBy, onSnapshot, addDoc, deleteDoc,
} from "./firebase.js?v=23";

const MAX_TEXT = 600;
const MAX_AUTHOR = 100;

const errorEl = document.getElementById("error");
const statusEl = document.getElementById("status");
const featuredEmptyEl = document.getElementById("featured-empty");
const featuredEl = document.getElementById("featured");
const featuredTextEl = document.getElementById("featured-text");
const featuredAuthorEl = document.getElementById("featured-author");
const anotherEl = document.getElementById("another");
const formEl = document.getElementById("quote-form");
const textEl = document.getElementById("quote-text");
const authorEl = document.getElementById("quote-author");
const countEl = document.getElementById("quote-count");
const listEl = document.getElementById("quote-list");

// one document per quote: { text, author, createdAt }
let userId = null;  // set when sign-in completes; everything lives under users/<id>/
const quotesCollection = () => collection(db, "users", userId, "quotes");
const quoteDoc = (id) => doc(db, "users", userId, "quotes", id);
const saves = createSaveTracker(statusEl, showError);

let quotes = [];        // oldest first, as stored
let featuredId = null;  // the quote shown at the top

function showError(err) {
  errorEl.textContent = typeof err === "string" ? err : describeFirestoreError(err);
  errorEl.hidden = false;
}

function isValidQuote(data) {
  return data !== null && typeof data === "object" &&
         typeof data.text === "string" && data.text.trim() !== "" &&
         (data.author === undefined || typeof data.author === "string");
}

/* ---------- database ---------- */

function listen() {
  const quotesQuery = query(quotesCollection(), orderBy("createdAt"));
  return onSnapshot(quotesQuery, (snapshot) => {
    quotes = [];
    for (const snap of snapshot.docs) {
      const data = snap.data();
      if (isValidQuote(data)) {
        quotes.push({ id: snap.id, text: data.text, author: data.author || "" });
      } else {
        console.warn("Skipping malformed quote document", snap.id);
      }
    }
    render();
    saves.show();
  }, showError);
}

function addQuote(text, author) {
  saves.track(addDoc(quotesCollection(), { text: text, author: author, createdAt: Date.now() }));
}

function deleteQuote(id) {
  saves.track(deleteDoc(quoteDoc(id)));
}

/* ---------- display ---------- */

// Prefers a quote other than the one on screen, so "Another" always changes something.
function pickRandom(excludeId) {
  const others = quotes.filter((quote) => quote.id !== excludeId);
  const pool = others.length > 0 ? others : quotes;
  return pool[Math.floor(Math.random() * pool.length)];
}

function renderFeatured() {
  // keep the shown quote across live updates; pick a new one only if it was deleted
  if (!quotes.some((quote) => quote.id === featuredId)) {
    featuredId = quotes.length > 0 ? pickRandom(null).id : null;
  }

  const featured = quotes.find((quote) => quote.id === featuredId);
  featuredEmptyEl.hidden = featured !== undefined;
  featuredEl.hidden = featured === undefined;
  anotherEl.hidden = quotes.length < 2;
  if (featured === undefined) {
    return;
  }

  // textContent, not innerHTML: quotes are user input and must not be parsed as HTML.
  featuredTextEl.textContent = featured.text;
  featuredAuthorEl.textContent = featured.author;
  featuredAuthorEl.hidden = featured.author === "";
}

function renderList() {
  listEl.replaceChildren();
  countEl.textContent = quotes.length > 0 ? "(" + quotes.length + ")" : "";

  // newest first, so what you just added is at the top
  for (const quote of [...quotes].reverse()) {
    const row = document.createElement("li");

    const body = document.createElement("div");
    body.className = "quote-body";
    const text = document.createElement("p");
    text.className = "quote-text small";
    text.textContent = quote.text;
    body.append(text);
    if (quote.author !== "") {
      const author = document.createElement("p");
      author.className = "quote-author";
      author.textContent = quote.author;
      body.append(author);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon del";
    remove.setAttribute("aria-label", "Delete quote");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      if (confirm("Delete this quote?")) {
        deleteQuote(quote.id);
      }
    });

    row.append(body, remove);
    listEl.append(row);
  }
}

function render() {
  renderFeatured();
  renderList();
}

anotherEl.addEventListener("click", () => {
  featuredId = pickRandom(featuredId).id;
  renderFeatured();
});

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textEl.value.trim();
  const author = authorEl.value.trim();
  if (text === "") {
    textEl.focus();
    return;
  }
  // maxlength already stops typing past the limit; this also covers pasted or scripted input
  if (text.length > MAX_TEXT || author.length > MAX_AUTHOR) {
    showError("Too long: a quote can have up to " + MAX_TEXT + " characters and an author " +
              MAX_AUTHOR + ".");
    return;
  }
  addQuote(text, author);
  textEl.value = "";
  authorEl.value = "";
});

initGate({
  onSignedIn(user) {
    userId = user.uid;
    const unsubscribe = listen();
    return () => {
      unsubscribe();
      userId = null;
      // drop the data from memory and screen when signing out
      quotes = [];
      featuredId = null;
      render();
    };
  },
});
