// The shell shared by every page: the bottom tab bar, the switcher between the pages of one
// section, the account sheet, and the icon set. A plain script (no Firebase), loaded before the
// page's own script, so the elements it adds (#status, #sign-out) already exist when that runs.
(function () {
  "use strict";

  // Three kinds of page, each with its own colour (set by the page's body class in style.css).
  const SECTIONS = {
    prod: {
      label: "Productivity", icon: "target",
      pages: [["habits.html", "Habits"], ["pomodoro.html", "Pomodoro"]],
    },
    fit: {
      label: "Fitness", icon: "dumbbell",
      pages: [["nutrition.html", "Tracker"], ["macros.html", "Menu"], ["weight.html", "Weight"]],
    },
    lit: {
      label: "Literature", icon: "book",
      pages: [["reading.html", "Reading"], ["quotes.html", "Quotes"]],
    },
  };
  const LAST_PAGE_PREFIX = "nav.last.";

  // Line icons drawn as one sprite, so there is no icon library to download.
  const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <symbol id="i-home" viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5M5.5 10v10h4.5v-6h4v6h4.5V10"/></symbol>
    <symbol id="i-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.7 2.7L16 9.5"/></symbol>
    <symbol id="i-dumbbell" viewBox="0 0 24 24"><path d="M6.5 6.5v11M3.5 9v6M17.5 6.5v11M20.5 9v6M6.5 12h11"/></symbol>
    <symbol id="i-book" viewBox="0 0 24 24"><path d="M2.5 5h6a3.5 3.5 0 0 1 3.5 3.5V20a2.5 2.5 0 0 0-2.5-2.5h-7zM21.5 5h-6A3.5 3.5 0 0 0 12 8.5V20a2.5 2.5 0 0 1 2.5-2.5h7z"/></symbol>
    <symbol id="i-flame" viewBox="0 0 24 24"><path d="M12 2.8c.6 3.4 5.4 5 5.4 10.4a5.4 5.4 0 0 1-10.8 0c0-2 .9-3.3 2.2-4.4.2 1.7 1 2.6 2 2.9-.5-3.2-.4-6 1.2-8.9z"/></symbol>
    <symbol id="i-timer" viewBox="0 0 24 24"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9.5 2.5h5"/></symbol>
    <symbol id="i-utensils" viewBox="0 0 24 24"><path d="M7 3v7.5M4 3v5a3 3 0 0 0 6 0V3M7 11.5V21M17.5 21V3c-2.5 1.5-3.5 4.5-3.5 8h3.5"/></symbol>
    <symbol id="i-scale" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M8.5 9.5a5 4 0 0 1 7 0M12 9.8l1.6-2"/></symbol>
    <symbol id="i-quote" viewBox="0 0 24 24"><path fill="currentColor" stroke-width="1.4" d="M6 17.5h3.2l2.3-4.6V6.5H5v6.4h3.2zM14.2 17.5h3.2l2.3-4.6V6.5h-6.5v6.4h3.2z"/></symbol>
    <symbol id="i-right" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
    <symbol id="i-cloud" viewBox="0 0 24 24"><path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.5 1.5A3.8 3.8 0 0 1 17.5 18.5z"/></symbol>
    <symbol id="i-out" viewBox="0 0 24 24"><path d="M9.5 4.5h-4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9.5"/></symbol>
  </defs></svg>`;

  const body = document.body;
  const sectionKey = body.dataset.section || "home";
  const currentFile = location.pathname.split("/").pop() || "index.html";
  const hasAccount = document.getElementById("gate") !== null;

  function icon(name, size) {
    return '<svg class="i" width="' + size + '" height="' + size + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  // The tab for a section opens the page you last used in it. Private browsing can refuse storage,
  // which only costs the memory: the tab then opens the section's first page.
  function rememberPage(key, file) {
    try {
      localStorage.setItem(LAST_PAGE_PREFIX + key, file);
    } catch (err) {
      console.warn("Could not remember the last page:", err);
    }
  }

  function recallPage(key) {
    const pages = SECTIONS[key].pages.map((page) => page[0]);
    try {
      const saved = localStorage.getItem(LAST_PAGE_PREFIX + key);
      return pages.includes(saved) ? saved : pages[0];
    } catch (err) {
      console.warn("Could not read the last page:", err);
      return pages[0];
    }
  }

  function addTabBar() {
    const bar = document.createElement("nav");
    bar.className = "tabbar";
    bar.setAttribute("aria-label", "Sections");
    const tabs = [{ key: "home", label: "Home", icon: "home", href: "./" }];
    for (const [key, section] of Object.entries(SECTIONS)) {
      tabs.push({ key: key, label: section.label, icon: section.icon, href: recallPage(key) });
    }
    for (const tab of tabs) {
      const link = document.createElement("a");
      link.className = "tab";
      link.dataset.sec = tab.key;
      link.href = tab.href;
      link.innerHTML = icon(tab.icon, 24) + "<span>" + tab.label + "</span>";
      if (tab.key === sectionKey) {
        link.classList.add("on");
        link.setAttribute("aria-current", "page");
      }
      bar.append(link);
    }
    body.append(bar);
  }

  // The pages of the current section, side by side under the title.
  function addPageSwitcher() {
    const section = SECTIONS[sectionKey];
    const head = document.querySelector(".page-head");
    if (!section || !head || section.pages.length < 2) {
      return;
    }
    const switcher = document.createElement("nav");
    switcher.className = "seg";
    switcher.setAttribute("aria-label", "Pages in " + section.label);
    for (const [file, label] of section.pages) {
      const link = document.createElement("a");
      link.href = file;
      link.textContent = label;
      if (file === currentFile) {
        link.classList.add("on");
        link.setAttribute("aria-current", "page");
      }
      switcher.append(link);
    }
    head.after(switcher);
  }

  // The avatar opens a sheet with the account, the save status and Sign out. Sign out and the save
  // status live there so they are on every page without taking room on it.
  function addAccountSheet() {
    const head = document.querySelector(".page-head");
    if (!head) {
      return;
    }
    const avatar = document.createElement("button");
    avatar.type = "button";
    avatar.className = "avatar";
    avatar.setAttribute("aria-label", "Account");
    head.append(avatar);

    const backdrop = document.createElement("div");
    backdrop.className = "sheet-bg";
    const sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Account");
    sheet.innerHTML =
      '<div class="who"><span class="avatar"></span><div><b id="account-name"></b><span id="account-email"></span></div></div>' +
      '<div class="saved">' + icon("cloud", 20) + '<span id="status">Loading&hellip;</span></div>' +
      '<button id="sign-out" type="button" class="block">' + icon("out", 20) + "Sign out</button>";
    body.append(backdrop, sheet);

    const setOpen = (open) => {
      sheet.classList.toggle("open", open);
      backdrop.classList.toggle("open", open);
    };
    avatar.addEventListener("click", () => setOpen(true));
    backdrop.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    });
  }

  body.insertAdjacentHTML("beforeend", SPRITE);
  if (SECTIONS[sectionKey]) {
    rememberPage(sectionKey, currentFile);
  }
  addTabBar();
  addPageSwitcher();
  if (hasAccount) {
    addAccountSheet();
  } else {
    // a page with no sign-in (Pomodoro) shows the shell right away
    body.classList.add("signed-in");
  }
})();
