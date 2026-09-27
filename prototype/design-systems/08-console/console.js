// Console prototype helpers. Plain script, no dependencies, works from file://.
//
// - Renders the shared chrome: the titlebar (desktop), the web bar, the sidebar with its
//   two faces, the status line, and on a phone the status bar, the folded status line
//   and the tab bar. Pages hold only an empty placeholder element with a
//   few data attributes, so every screen shows the same chrome.
// - Runs the composer's glass behaviour: it shrinks and turns see-through while you read
//   back through a transcript, and comes back when you reach the bottom or focus it.
//   `?state=scrolled` forces the scrolled look for screenshots.
// - Moves the row cursor with j / k in any [data-list], like the real thing would.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const icon = (id, cls = "mk") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
  const keys = (s) => s.split(" ").map((k) => `<kbd>${k}</kbd>`).join("");

  // `?state=10x` shows the same screen with ten times the work: more runners, more sessions.
  const X10 = document.documentElement.dataset.state === "10x";
  const WAITING = X10 ? "11" : "3";

  const THEME_NAMES = {
    phosphor: "Phosphor", dark: "Phosphor", graphite: "Graphite", ember: "Ember", void: "Void",
    "paper-tape": "Paper Tape", light: "Paper Tape", porcelain: "Porcelain",
  };

  // -------------------------------------------------------------- titlebar ---
  function renderTitlebar(el) {
    const command = el.dataset.command || "Go to, answer or start anything";
    el.innerHTML = `
      <div class="tb-lights" aria-hidden="true"><i></i><i></i><i></i></div>
      <a class="wordmark" href="#">${icon("logo", "logo")}<span>hercule</span></a>
      <button class="cmdbar" type="button">
        ${icon("c-caret", "mk prompt")}
        <span class="cmdbar-text">${command}</span>
        <span class="cmdbar-keys">${keys("⌘ K")}</span>
      </button>
      <div class="tb-right">
        <button class="tb-needs" type="button" title="${WAITING} decisions wait on you">${icon("m-decision")}<b>${WAITING}</b><span>wait on you</span></button>
        <span class="avatar" title="Rogier">R</span>
      </div>`;
  }

  // --------------------------------------------------------------- web bar ---
  function renderWebbar(el) {
    const command = el.dataset.command || "Go to, answer or start anything";
    el.innerHTML = `
      <a class="wordmark" href="#">${icon("logo", "logo")}<span>hercule</span></a>
      <button class="cmdbar" type="button">
        ${icon("c-caret", "mk prompt")}
        <span class="cmdbar-text">${command}</span>
        <span class="cmdbar-keys">${keys("⌘ K")}</span>
      </button>
      <div class="tb-right">
        <button class="tb-needs" type="button">${icon("m-decision")}<b>${WAITING}</b><span>wait on you</span></button>
        <span class="avatar" title="Rogier">R</span>
      </div>`;
  }

  // --------------------------------------------------------------- sidebar ---
  const THREADS = [
    {
      project: "webshop", hue: "webshop", count: 2,
      workspaces: [
        {
          label: "fix/3ds-eu-cards · studio-mac",
          threads: [
            { id: "fix-3ds", mark: "m-decision", tone: "attn", title: "Fix 3-D Secure checkout for EU cards", age: "39m", meta: "waits on you · git push" },
            { id: "cart", mark: "m-working", tone: "live", title: "Refactor cart totals", age: "22m", meta: "working · Sonnet 5" },
          ],
        },
      ],
    },
    {
      project: "payments-api", hue: "payments-api", count: 1,
      workspaces: [
        {
          label: "research/ideal · build-box-2",
          threads: [{ id: "ideal", mark: "m-idle", tone: "idle", title: "Add iDEAL research", age: "1h", meta: "idle · gpt-5.4" }],
        },
      ],
    },
    {
      project: "ops", hue: "ops", count: 1,
      workspaces: [
        {
          label: "ops · studio-mac",
          threads: [{ id: "dashboards", mark: "m-decision", tone: "attn", title: "Migrate ops dashboards", age: "48m", meta: "waits on you · a question" }],
        },
      ],
    },
  ];
  const ASSISTANTS = [
    { id: "ada", name: "Ada", mark: "m-working", tone: "live", where: "Web chat · Slack DM" },
    { id: "milo", name: "Milo", mark: "m-idle", tone: "idle", where: "Slack #ops" },
    { id: "juno", name: "Juno", mark: "m-asleep", tone: "idle", where: "Discord", warn: "reconnecting" },
  ];
  const NAV = [
    { id: "intake", label: "Intake", glyph: "g-proposal", count: X10 ? "60" : "6", tone: "", chord: "g i" },
    { id: "checkin", label: "Check-in", glyph: "m-decision", count: WAITING, tone: "attn", chord: "g c" },
    { id: "tasks", label: "Tasks", glyph: "g-task", count: "", chord: "g t" },
    { id: "runs", label: "Runs", glyph: "g-run", count: "", chord: "g r" },
    { id: "workflows", label: "Workflows", glyph: "g-workflow", count: "", chord: "g w" },
    { sep: true },
    { id: "fleet", label: "Fleet", glyph: "g-runner", count: "", chord: "g f" },
    { id: "connections", label: "Connections", glyph: "g-connection", count: "", chord: "g o" },
    { id: "notifications", label: "Notifications", glyph: "g-bell", count: "5", tone: "", chord: "g n" },
    { id: "settings", label: "Settings", glyph: "g-gear", count: "", chord: "⌘ ,", web: "g s" },
  ];
  // One cell per session slot on each runner, colored by what the session in it is doing.
  const METERS = X10
    ? [
        { name: "studio-mac", cells: "aawwww", note: "6/6", cap: true },
        { name: "build-box-1", cells: "wwwwwiii", note: "8/8", cap: true },
        { name: "build-box-2", cells: "awwwwi..", note: "6/8" },
        { name: "build-box-3", cells: "wwwwwwww", note: "8/8", cap: true },
        { name: "build-box-4", cells: "wwawwwi.", note: "7/8" },
        { name: "build-box-5", cells: "wwwwii..", note: "6/8" },
        { name: "build-box-6", cells: "awwwwwii", note: "8/8", cap: true },
        { name: "ci-1", cells: "wwwww...", note: "5/8" },
        { name: "ci-2", cells: "wwwwwwi.", note: "7/8" },
      ]
    : [
        { name: "studio-mac", cells: "aawwi.", note: "5/6" },
        { name: "build-box-1", cells: "wwwwwiii", note: "8/8", cap: true },
        { name: "build-box-2", cells: "awi.....", note: "3/8" },
      ];

  function renderMeters() {
    const cell = { w: "live", a: "attn", i: "idle", ".": "free" };
    return METERS.map(
      (m) => `
      <div class="meter${m.cap ? " is-cap" : ""}">
        <span class="meter-name">${m.name}</span>
        <span class="meter-cells">${[...m.cells].map((c) => `<i class="${cell[c]}"></i>`).join("")}</span>
        <span class="meter-note">${m.note}</span>
      </div>`,
    ).join("");
  }

  function renderSidebar(el) {
    const face = el.dataset.side || "hercule";
    const active = el.dataset.active || "";
    // In a browser, ⌘N and ⌘, belong to the browser, so the web app takes plain keys.
    const web = !!el.closest(".webapp");
    const theme = document.documentElement.dataset.theme || "phosphor";
    let body = "";
    if (face === "threads") {
      body += `
        <div class="side-new">
          <button class="side-row new-thread${active === "new" ? " is-active" : ""}" type="button">${icon("c-plus")}<span>New thread</span><span class="side-keys">${keys(web ? "c" : "⌘ N")}</span></button>
          <button class="side-icon" type="button" title="New project">${icon("g-folder")}</button>
        </div>`;
      for (const p of THREADS) {
        body += `<div class="side-group">
          <div class="side-project" style="--hue: var(--project-${p.hue})"><i class="sq"></i><span>${p.project}</span><span class="side-count">${p.count}</span></div>`;
        for (const w of p.workspaces) {
          body += `<div class="side-ws">${w.label}</div>`;
          for (const t of w.threads) {
            body += `<a class="side-thread${active === t.id ? " is-active" : ""}" href="#">
              <span class="st-mark tone-${t.tone}">${icon(t.mark)}</span>
              <span class="st-title">${t.title}</span><span class="st-age">${t.age}</span>
              <span class="st-meta">${t.meta}</span></a>`;
          }
        }
        body += `</div>`;
      }
      body += `<div class="side-group"><div class="side-label">Assistants</div>`;
      for (const a of ASSISTANTS) {
        body += `<a class="side-assistant${active === a.id ? " is-active" : ""}" href="#">
          <span class="st-mark tone-${a.tone}">${icon(a.mark)}</span>
          <span class="sa-name">${a.name}</span>
          <span class="sa-where">${a.where}${a.warn ? ` <em>${a.warn}</em>` : ""}</span></a>`;
      }
      body += `</div><a class="side-row all-sessions${active === "all" ? " is-active" : ""}" href="#"><span>All sessions</span><span class="side-count tone-live">23</span>${icon("c-right")}</a>`;
    } else {
      body += `<div class="side-nav">`;
      for (const n of NAV) {
        if (n.sep) { body += `<div class="side-sep"></div>`; continue; }
        body += `<a class="side-row${active === n.id ? " is-active" : ""}" href="#">
          ${n.glyph ? icon(n.glyph, "mk glyph") : `<span class="glyph-gap"></span>`}
          <span>${n.label}</span>
          ${n.count ? `<span class="side-count${n.tone ? " tone-" + n.tone : ""}">${n.count}</span>` : ""}
          <span class="side-keys">${keys(web && n.web ? n.web : n.chord)}</span></a>`;
      }
      body += `</div>`;
      body += `<div class="side-group"><div class="side-label">Assistants</div>`;
      for (const a of ASSISTANTS) {
        body += `<a class="side-assistant${active === a.id ? " is-active" : ""}" href="#">
          <span class="st-mark tone-${a.tone}">${icon(a.mark)}</span>
          <span class="sa-name">${a.name}</span>
          <span class="sa-where">${a.where}${a.warn ? ` <em>${a.warn}</em>` : ""}</span></a>`;
      }
      body += `</div>`;
    }
    el.innerHTML = `
      <div class="side-faces" role="tablist">
        <button role="tab" class="face${face === "threads" ? " is-on" : ""}" type="button">Threads</button>
        <button role="tab" class="face${face === "hercule" ? " is-on" : ""}" type="button">Hercule <span class="face-count">${icon("m-decision")}${WAITING}</span></button>
      </div>
      <div class="side-scroll">${body}</div>
      <div class="side-foot">
        <div class="side-label">Fleet <span class="side-label-note">${X10 ? "61 of 70" : "16 of 22"} slots</span></div>
        <div class="meters">${renderMeters()}</div>
        <div class="foot-row">
          <button type="button">Marks <kbd>?</kbd></button>
          <button type="button">Theme <b>${THEME_NAMES[theme] || theme}</b></button>
        </div>
      </div>`;
  }

  // ------------------------------------------------------- settings domains ---
  // The settings index, as a pane. `data-active` names the open domain.
  const DOMAINS = [
    { id: "profile", label: "Profile", glyph: "g-user", note: "Rogier" },
    { id: "appearance", label: "Appearance", glyph: "g-palette", note: "theme" },
    { id: "threads", label: "Threads", glyph: "g-session" },
    { id: "assistants", label: "Assistants", glyph: "g-assistant", note: "3" },
    { id: "connections", label: "Connections", glyph: "g-connection", note: "11", warn: true },
    { id: "providers", label: "Providers", glyph: "g-chip", note: "3" },
    { id: "machines", label: "Machines", glyph: "g-runner", note: "3", warn: true },
    { id: "identities", label: "Identities", glyph: "g-id" },
    { id: "permissions", label: "Permission profiles", glyph: "g-shield" },
    { id: "secrets", label: "Secrets", glyph: "g-key" },
    { id: "bounds", label: "Bounds", glyph: "g-gauge" },
    { id: "plugins", label: "Plugins", glyph: "g-plug" },
    { id: "system", label: "System", glyph: "g-gear" },
  ];
  function renderSettingsNav(el) {
    const active = el.dataset.active || "";
    const theme = document.documentElement.dataset.theme || "phosphor";
    el.innerHTML = `
      <label class="set-filter">${icon("c-search")}<span>Filter settings</span><kbd>/</kbd></label>
      <div class="set-list">${DOMAINS.map((d) => `
        <a class="set-row${active === d.id ? " is-active" : ""}" href="#">
          ${icon(d.glyph, "mk glyph")}<span class="set-label">${d.label}</span>
          ${d.warn ? icon("m-urgent", "mk tone-attn") : ""}
          <span class="set-note">${d.note === "theme" ? THEME_NAMES[theme] || theme : d.note || ""}</span>
        </a>`).join("")}
      </div>`;
  }

  // ----------------------------------------------------------- status line ---
  // data-mode: the mode chip. data-context: what the cursor is on. data-keys: "keys:label|..."
  function renderStatus(el) {
    const mode = el.dataset.mode || "NAV";
    const context = el.dataset.context || "";
    const hints = (el.dataset.keys || "").split("|").filter(Boolean).map((pair) => {
      const [k, label] = pair.split(":");
      return `<span class="hint">${keys(k)}<span>${label}</span></span>`;
    }).join("");
    const compact = el.hasAttribute("data-compact");
    el.innerHTML = `
      <span class="mode">${mode}</span>
      ${context ? `<span class="seg seg-context">${context}</span>` : ""}
      <span class="seg seg-swarm">
        <span class="tone-live">${icon("m-live")}${X10 ? "140" : "23"} live</span>
        <span class="tone-live">${X10 ? "51" : "8"} working</span>
        <span class="tone-attn">${WAITING} wait on you</span>
        ${compact ? "" : `<span class="tone-idle">${X10 ? "78" : "12"} idle</span>`}
      </span>
      ${compact ? "" : `<span class="seg seg-warn tone-attn">${icon("m-urgent")}<span class="warn-text">${X10 ? "4 runners at cap" : "build-box-1 at cap"} · Discord reconnecting</span></span>`}
      <span class="status-fill"></span>
      <span class="seg seg-keys">${hints}</span>
      <span class="seg seg-clock">Tue 29 Sep · 09:41</span>`;
  }

  // ---------------------------------------------------------------- mobile ---
  // The phone's own status bar: the clock, the island, signal, wifi and battery.
  // `data-time=""` leaves the clock out, as the lock screen does.
  const SIGNAL = `<svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true"><g fill="currentColor"><rect x="0" y="7.5" width="3" height="4.5" rx="0.8"/><rect x="5" y="5" width="3" height="7" rx="0.8"/><rect x="10" y="2.5" width="3" height="9.5" rx="0.8"/><rect x="15" y="0" width="3" height="12" rx="0.8"/></g></svg>`;
  const WIFI = `<svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true"><path d="M8 11.2 1 4.6a10 10 0 0 1 14 0z" fill="currentColor" opacity="0.92"/></svg>`;
  const BATTERY = `<svg width="25" height="12" viewBox="0 0 25 12" aria-hidden="true"><rect x="0.5" y="0.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" opacity="0.5"/><rect x="2" y="2" width="15" height="8" rx="1.5" fill="currentColor"/><rect x="22.5" y="4" width="1.6" height="4" rx="0.8" fill="currentColor" opacity="0.5"/></svg>`;
  function renderStatusBar(el) {
    const time = el.dataset.time ?? "9:41";
    el.innerHTML = `<span class="sb-time">${time}</span><span class="sb-island"></span><span class="sb-icons">${SIGNAL}${WIFI}${BATTERY}</span>`;
  }

  // The status line, folded for a phone: mode, what the screen is on, the swarm.
  function renderMobileStatus(el) {
    const mode = el.dataset.mode || "NAV";
    const context = el.dataset.context || "";
    el.innerHTML = `
      <span class="mode">${mode}</span>
      ${context ? `<span class="ctx">${context}</span>` : ""}
      <span class="end"><span class="tone-live">${icon("m-live")}${X10 ? "140" : "23"} live</span><span class="tone-attn">${WAITING} wait on you</span></span>`;
  }

  // The tab bar. `data-active` names the tab that is on.
  const MOBILE_TABS = [
    { id: "threads", label: "Threads", glyph: "g-session" },
    { id: "intake", label: "Intake", glyph: "g-proposal", count: X10 ? "60" : "6" },
    { id: "checkin", label: "Check-in", glyph: "m-decision", count: WAITING, tone: "attn" },
    { id: "assistants", label: "Assistants", glyph: "g-assistant" },
    { id: "settings", label: "Settings", glyph: "g-gear" },
  ];
  function renderMobileTabs(el) {
    const active = el.dataset.active || "";
    el.innerHTML = MOBILE_TABS.map((t) => `
      <a class="m-tab${active === t.id ? " is-on" : ""}" href="#">${icon(t.glyph)}<span>${t.label}</span>${
        t.count ? `<span class="m-badge${t.tone ? " " + t.tone : ""}">${t.count}</span>` : ""
      }</a>`).join("");
  }

  // ------------------------------------------------------ composer glass ---
  function wireComposer(scroller) {
    const dock = $(scroller.dataset.composer);
    if (!dock) return;
    const forced = document.documentElement.dataset.state === "scrolled";
    // The transcript leaves room under its last message for the full composer.
    scroller.style.setProperty("--dock-h", `${dock.offsetHeight}px`);
    const update = () => {
      if (forced) return;
      const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const focused = dock.contains(document.activeElement);
      dock.classList.toggle("is-scrolled", fromBottom > 24 && !focused);
    };
    if (forced) {
      dock.classList.add("is-scrolled");
      const anchor = scroller.dataset.scrolledTo && $(scroller.dataset.scrolledTo, scroller);
      scroller.scrollTop = anchor ? anchor.offsetTop - 24 : scroller.scrollHeight / 3;
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    scroller.addEventListener("scroll", update, { passive: true });
    dock.addEventListener("focusin", update);
    dock.addEventListener("focusout", () => setTimeout(update));
    update();
  }

  // ------------------------------------------------------------ row cursor ---
  function wireLists() {
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input, textarea, [contenteditable]")) return;
      if (e.key !== "j" && e.key !== "k") return;
      const list = $("[data-list]");
      if (!list) return;
      const rows = $$("[data-row]", list);
      const at = rows.findIndex((r) => r.classList.contains("is-cursor"));
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === "j" ? 1 : -1)))];
      if (!next) return;
      rows.forEach((r) => r.classList.remove("is-cursor"));
      next.classList.add("is-cursor");
      next.scrollIntoView({ block: "nearest" });
    });
  }

  function init() {
    $$("[data-titlebar]").forEach(renderTitlebar);
    $$("[data-webbar]").forEach(renderWebbar);
    $$("[data-side]").forEach(renderSidebar);
    $$("[data-settings-nav]").forEach(renderSettingsNav);
    $$("[data-status]").forEach(renderStatus);
    $$("[data-sb]").forEach(renderStatusBar);
    $$("[data-mstatus]").forEach(renderMobileStatus);
    $$("[data-mtabs]").forEach(renderMobileTabs);
    $$("[data-composer]").forEach(wireComposer);
    wireLists();
    // SMIL animations (the working mark) ignore prefers-reduced-motion; stop them by hand.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      $$("svg").forEach((s) => s.pauseAnimations && s.pauseAnimations());
    }
  }

  window.Console = { icon, keys, renderSidebar, THEME_NAMES };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
