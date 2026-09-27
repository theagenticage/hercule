/* PROTOTYPE - shell.js: the app frame every page of one form factor shares, rendered from one
 * place so the sidebar, the web rail and the phone chrome never drift apart between pages.
 * Load it before halo.js; halo.js then renders the marks and glyphs inside what this file wrote.
 *
 *   <aside class="side" data-side="threads|hercule|settings" data-current="..."></aside>
 *   <nav class="rail" data-current="..."></nav>
 *   <div class="status" data-status></div>     the phone's status bar
 *   <nav class="tabbar" data-current="..."></nav>
 */
(function () {
  "use strict";

  // The fleet right now: 3 waiting on you, 8 working, 12 idle (one of them paused).
  // ?state=10x previews the swarm: 140 live sessions across 9 runners.
  var TEN = document.documentElement.dataset.state === "10x";
  var FLEET = TEN ? "wait14 work61 fail2 pause4 idle59" : "wait3 work8 pause1 idle11";
  var WAITING = TEN ? "14" : "3";
  var INTAKE = TEN ? "60" : "9";

  function glance(size) {
    return (
      '<a class="glance" href="office.html" title="All sessions">' +
      '<span data-halo="' + FLEET + '" data-notch="0" data-center="' + WAITING + '" data-size="' + size + '"></span>' +
      '<span><div class="big"><b>' + WAITING + '</b> waiting on you</div><div class="small">' +
      (TEN ? "61 working · 2 failed · 63 idle" : "8 working · 12 idle") + "</div></span></a>"
    );
  }

  function threadRow(id, current, mark, title, age, sub, href) {
    return (
      '<a class="thread-row" href="' + (href || "session-active.html") + '"' + (current === id ? ' aria-current="page"' : "") + ">" +
      '<i data-mark="' + mark + '"></i><span class="t">' + title + '</span><span class="age' + (mark === "wait" ? " wait" : "") + '">' + age +
      '</span><span></span><span class="sub">' + sub + "</span></a>"
    );
  }

  function threadsFace(current) {
    return (
      '<a class="side-row" href="session-empty.html"' + (current === "new" ? ' aria-current="page"' : "") + '><i data-icon="compose"></i>Create new thread<span class="n kbd">⌘N</span></a>' +
      '<div class="side-label">webshop <span class="n">2</span><button class="icon-btn" title="New thread in webshop"><i data-icon="plus"></i></button></div>' +
      '<div class="side-ws">fix/3ds-eu-cards</div>' +
      threadRow("fix-3ds", current, "wait", "Fix 3-D Secure checkout for EU cards", "39m", "Claude Code · Opus 5.5") +
      threadRow("cart", current, "work", "Refactor cart totals", "22m", "Claude Code · Sonnet 5") +
      '<div class="side-label">payments-api <span class="n">1</span><button class="icon-btn" title="New thread in payments-api"><i data-icon="plus"></i></button></div>' +
      '<div class="side-ws">payments-api · build-box-2</div>' +
      threadRow("ideal", current, "idle", "Add iDEAL research", "1h", "Codex · gpt-5.4") +
      '<div class="side-label">ops <span class="n">1</span><button class="icon-btn" title="New thread in ops"><i data-icon="plus"></i></button></div>' +
      '<div class="side-ws">ops · studio-mac</div>' +
      threadRow("grafana", current, "wait", "Migrate ops dashboards", "14m", "pi · qwen3-coder") +
      '<div class="side-label">Assistants</div>' +
      '<a class="asst-row" href="assistant.html"' + (current === "ada" ? ' aria-current="page"' : "") + '><span class="face sm working">A</span>Ada<span class="where">web chat</span></a>' +
      '<a class="asst-row"><span class="face sm idle">M</span>Milo<span class="where">Slack #ops</span></a>' +
      '<a class="asst-row"><span class="face sm asleep">J</span>Juno<span class="where">asleep</span></a>' +
      '<div class="side-gap"></div>' +
      '<a class="side-row" href="office.html"' + (current === "sessions" ? ' aria-current="page"' : "") + '><i data-icon="list"></i>All sessions<span class="n">' + (TEN ? "140" : "23") + '</span><i data-icon="right" style="width:12px;height:12px"></i></a>'
    );
  }

  function navRow(id, current, glyph, label, count, href) {
    return (
      '<a class="side-row" href="' + (href || "#") + '"' + (current === id ? ' aria-current="page"' : "") + ">" + glyph + label +
      (count || "") + "</a>"
    );
  }

  function herculeFace(current) {
    return (
      navRow("intake", current, '<i data-icon="intake"></i>', "Intake", '<span class="n wait">' + INTAKE + "</span>", "intake.html") +
      navRow("checkin", current, '<i data-icon="checkin"></i>', "Check-in", '<span class="n">3</span>', "office.html") +
      navRow("tasks", current, '<i data-mark="task" class="ic"></i>', "Tasks") +
      navRow("runs", current, '<i data-mark="run" class="ic"></i>', "Runs") +
      navRow("workflows", current, '<i data-mark="workflow" class="ic"></i>', "Workflows") +
      '<div class="side-gap"></div>' +
      navRow("fleet", current, '<i data-icon="server"></i>', "Fleet", '<span class="n">' + (TEN ? "9" : "3") + " runners</span>") +
      navRow("connections", current, '<i data-icon="plug"></i>', "Connections", '<span class="n">11</span>', "settings-connections.html") +
      navRow("notifications", current, '<i data-icon="bell"></i>', "Notifications", '<span class="n">5</span>') +
      navRow("settings", current, '<i data-icon="dial"></i>', "Settings", "", "settings-appearance.html")
    );
  }

  function settingsFace(current) {
    var items = [
      ["profile", "Profile", "user"],
      ["appearance", "Appearance", "palette", "settings-appearance.html"],
      ["threads", "Threads", "threads"],
      ["assistants", "Assistants", "user", "settings-assistants.html"],
      ["connections", "Connections", "plug", "settings-connections.html"],
      ["providers", "Providers", "cpu"],
      ["machines", "Machines", "server"],
      ["identities", "Identities", "key"],
      ["profiles", "Permission profiles", "shield"],
      ["secrets", "Secrets", "lock"],
      ["bounds", "Bounds", "gauge"],
      ["plugins", "Plugins", "puzzle"],
      ["system", "System", "sliders"],
    ];
    return (
      '<a class="side-row" href="intake.html"><i data-icon="back"></i>Settings</a><div class="side-gap"></div>' +
      items
        .map(function (it) {
          var glyph = it[0] === "assistants" ? '<i data-mark="assistant" class="ic"></i>' : '<i data-icon="' + it[2] + '"></i>';
          return navRow(it[0], current, glyph, it[1], "", it[3]);
        })
        .join("")
    );
  }

  function renderSide(el) {
    var face = el.getAttribute("data-side");
    var current = el.getAttribute("data-current");
    var body = face === "threads" ? threadsFace(current) : face === "settings" ? settingsFace(current) : herculeFace(current);
    el.innerHTML =
      '<div class="side-top"><span class="traffic"><i></i><i></i><i></i></span><span class="grow"></span>' +
      '<button class="icon-btn" title="Search  ⌘K"><i data-icon="search"></i></button>' +
      '<button class="icon-btn" title="Hide the sidebar"><i data-icon="sidebar"></i></button></div>' +
      (face === "settings"
        ? ""
        : '<div class="seg" data-seg><button aria-pressed="' + (face === "threads") + '">Threads</button>' +
          '<button aria-pressed="' + (face !== "threads") + '">Hercule' + (face === "threads" ? ' <span class="count">' + WAITING + "</span>" : "") + "</button></div>") +
      '<div class="side-body">' + body + "</div>" +
      '<div class="side-foot">' + glance(40) +
      '<div class="foot-row"><span class="me"><span class="avatar">R</span>Rogier</span>' +
      '<button class="icon-btn" title="Marks: what each mark means"><i data-icon="eye"></i></button>' +
      '<button class="icon-btn" title="Theme"><i data-icon="' + (isDark() ? "moon" : "sun") + '"></i></button></div></div>';
  }

  function isDark() {
    var t = document.documentElement.dataset.theme || "";
    return /dark|eclipse|umber|orchid/.test(t);
  }

  /* The web rail: the same destinations as the desktop sidebar, as icons, with the halo at its foot. */
  function renderRail(el) {
    var current = el.getAttribute("data-current");
    function a(id, glyph, title, dot, href) {
      return (
        '<a href="' + (href || "#") + '" title="' + title + '"' + (current === id ? ' aria-current="page"' : "") + ">" + glyph +
        (dot ? '<span class="dot">' + dot + "</span>" : "") + "</a>"
      );
    }
    el.innerHTML =
      '<a class="logo" href="intake.html" title="Hercule"><span class="app-icon" data-theme="eclipse" style="--sz: 36px"><span data-halo="wait1.4 work7.3 idle4.1" data-split data-size="25" data-still></span></span></a>' +
      a("threads", '<i data-icon="threads"></i>', "Threads", "", "session-active.html") +
      a("intake", '<i data-icon="intake"></i>', "Intake", INTAKE, "intake.html") +
      a("checkin", '<i data-icon="checkin"></i>', "Check-in", "3") +
      a("tasks", '<i data-mark="task" class="ic"></i>', "Tasks") +
      a("runs", '<i data-mark="run" class="ic"></i>', "Runs") +
      a("assistants", '<i data-mark="assistant" class="ic"></i>', "Assistants", "", "assistant.html") +
      a("connections", '<i data-icon="plug"></i>', "Connections") +
      '<span class="end">' + a("settings", '<i data-icon="dial"></i>', "Settings", "", "settings-providers.html") +
      '<a href="#" title="' + WAITING + ' waiting on you" style="width:44px;height:44px"><span data-halo="' + FLEET + '" data-notch="0" data-center="' + WAITING + '" data-size="36"></span></a>' +
      '<span class="avatar">R</span></span>';
  }

  function renderStatus(el) {
    var light = el.hasAttribute("data-light");
    el.innerHTML =
      '<span class="num">9:41</span><span class="island"></span><span class="icons">' +
      '<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>' +
      '<svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor" aria-hidden="true"><path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.2-1.3A10.4 10.4 0 0 0 8 .4 10.4 10.4 0 0 0 .8 3.3L2 4.6a8.6 8.6 0 0 1 6-2.4zm0 3.6c1.3 0 2.5.5 3.4 1.3l1.2-1.3A6.7 6.7 0 0 0 8 4c-1.8 0-3.4.7-4.6 1.8l1.2 1.3c.9-.8 2.1-1.3 3.4-1.3zm0 3.6c-.6 0-1.1.2-1.5.6L8 11.6l1.5-1.6c-.4-.4-.9-.6-1.5-.6z"/></svg>' +
      '<svg width="27" height="13" viewBox="0 0 27 13" aria-hidden="true"><rect x=".5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="9" rx="2.4" fill="currentColor"/><path d="M25 4.5v4a2.2 2.2 0 0 0 0-4z" fill="currentColor" opacity=".45"/></svg>' +
      "</span>";
    if (light) el.style.color = "#fff";
  }

  function renderTabbar(el) {
    var current = el.getAttribute("data-current");
    function a(id, glyph, label, dot, href) {
      return (
        '<a href="' + (href || "#") + '"' + (current === id ? ' aria-current="page"' : "") + ">" + glyph +
        (dot ? '<span class="dot">' + dot + "</span>" : "") + label + "</a>"
      );
    }
    el.innerHTML =
      a("intake", '<span data-halo="wait1.4 wait2.3 wait4.2 wait2.1 empty6" data-size="22" data-still></span>', "Intake", "9", "intake.html") +
      a("threads", '<i data-icon="threads"></i>', "Threads", "3", "session-active.html") +
      a("assistants", '<i data-mark="assistant" class="ic"></i>', "Ada", "", "assistant.html") +
      a("settings", '<i data-icon="dial"></i>', "Settings", "", "settings.html");
  }

  function start() {
    document.querySelectorAll("aside.side[data-side]").forEach(renderSide);
    document.querySelectorAll("nav.rail").forEach(renderRail);
    document.querySelectorAll("[data-status]").forEach(renderStatus);
    document.querySelectorAll("nav.tabbar").forEach(renderTabbar);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
