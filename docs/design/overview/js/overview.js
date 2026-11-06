// PROTOTYPE - the Overview: one place, several ways of seeing what is going on. The switcher's puck
// slides on a spring, and a change of view carries what the two views share: when Work gives way to
// the Office, the colleagues on the cards walk off them into the room.
window.Overview = (function () {
  "use strict";

  var VIEWS = [
    { id: "office", name: "Office", icon: "office" },
    { id: "work", name: "Work", icon: "tasks" },
  ];
  var LATER = [
    { id: "list", name: "List", icon: "list" },
    { id: "surface", name: "One surface", icon: "overlap" },
    { id: "tracks", name: "Tracks", icon: "calendar" },
  ];
  var current = "work";
  var puck = null;
  var puckBody = null;

  function allViews() { return document.documentElement.dataset.later ? VIEWS.concat(LATER) : VIEWS; }

  function drawSwitcher() {
    var el = document.getElementById("switcher");
    el.innerHTML = '<h1 class="pill-title">Overview</h1><div class="switch" role="tablist" aria-label="Views"><i class="puck" id="puck"></i>' +
      allViews().map(function (v, i) {
        return '<button class="ptab switch-tab' + (v.id === current ? " is-on" : "") + '" role="tab" aria-selected="' + (v.id === current) + '" tabindex="' + (v.id === current ? 0 : -1) + '" data-view="' + v.id + '" title="' + v.name + " (⌘" + (i + 1) + ')">' + Crew.icon(v.icon, 14) + v.name + "</button>";
      }).join("") + "</div>";
    puck = document.getElementById("puck");
    puckBody = null;
    placePuck(false);
  }

  function placePuck(animate) {
    var on = document.querySelector('.switch-tab[data-view="' + current + '"]');
    if (!on || !puck) return;
    var left = on.offsetLeft;
    var width = on.offsetWidth;
    if (!puckBody) {
      puck.style.left = left + "px";
      puck.style.width = width + "px";
      puckBody = Motion.value(left, function (x) { puck.style.left = x + "px"; });
      puck._w = Motion.value(width, function (w) { puck.style.width = w + "px"; });
      return;
    }
    if (animate) {
      puckBody.to(left, "hand");
      puck._w.to(width, "hand");
    } else {
      puckBody.set(left);
      puck._w.set(width);
    }
  }

  /** Lists the colleagues on visible cards that also have a desk in the Office. */
  function collectTravellers() {
    return Array.prototype.filter.call(document.querySelectorAll("#lanes .card-head"), function (h) {
      var card = h.closest(".card");
      var r = h.getBoundingClientRect();
      return card && Office.hasBean(card.dataset.id) && r.top > 40 && r.bottom < innerHeight;
    });
  }

  function makeTraveller(head, x, y, size) {
    var card = head.closest(".card");
    var t = Store.task(card.dataset.id);
    var el = document.createElement("div");
    el.className = "traveller";
    el.innerHTML = Crew.face(t.agent, { pose: t.move === "you" ? "waiting" : "working", size: 26 });
    el.style.left = x - 13 + "px";
    el.style.top = y - 13 + "px";
    document.getElementById("carry").appendChild(el);
    return el;
  }

  var kit = null;

  /** Loads the 3D kit once. It is a megabyte, and most mornings nobody opens the Office. */
  function loadKit() {
    if (kit) return kit;
    kit = new Promise(function (done) {
      var s = document.createElement("script");
      s.src = "vendor/office-kit.js";
      s.onload = done;
      s.onerror = done;
      document.body.appendChild(s);
    });
    return kit;
  }

  function showOffice() {
    loadKit().then(function () {
      if (current === "office") enterOffice();
    });
  }

  function enterOffice() {
    var host = document.getElementById("office");
    var work = document.getElementById("work");
    host.hidden = false;
    Office.ensure(host);
    Office.resume();
    var travellers = collectTravellers();
    var pairs = travellers.map(function (h) {
      var r = h.getBoundingClientRect();
      return { head: h, x: r.left + r.width / 2, y: r.top + r.height / 2, id: h.closest(".card").dataset.id };
    });
    work.classList.add("is-leaving");
    host.classList.add("is-arriving");
    requestAnimationFrame(function () { host.classList.remove("is-arriving"); });
    setTimeout(function () {
      pairs.forEach(function (p, i) {
        var at = Office.locate(p.id, host);
        if (!at) return;
        var el = makeTraveller(p.head, p.x, p.y);
        p.head.style.visibility = "hidden";
        Motion.body(el).to({ x: at.x - p.x, y: at.y - p.y, s: 1.5, o: 0 }, "travel", {
          delay: i * 50,
          done: function () { el.remove(); p.head.style.visibility = ""; },
        });
      });
    }, 40);
    setTimeout(function () {
      if (current === "office") {
        work.hidden = true;
        work.classList.remove("is-leaving");
      }
    }, 420);
  }

  function showWork() {
    var host = document.getElementById("office");
    var work = document.getElementById("work");
    work.hidden = false;
    work.classList.add("is-leaving");
    host.classList.add("is-going");
    var travellers = collectTravellers();
    travellers.forEach(function (h, i) {
      var id = h.closest(".card").dataset.id;
      var at = Office.locate(id, host);
      if (!at) return;
      var r = h.getBoundingClientRect();
      var el = makeTraveller(h, at.x, at.y);
      h.style.visibility = "hidden";
      Motion.body(el).set({ s: 1.5, o: 0 }).to({ x: r.left + r.width / 2 - at.x, y: r.top + r.height / 2 - at.y, s: 1, o: 1 }, "travel", {
        delay: 80 + i * 50,
        done: function () { el.remove(); h.style.visibility = ""; },
      });
    });
    requestAnimationFrame(function () { work.classList.remove("is-leaving"); });
    setTimeout(function () {
      if (current === "work") {
        host.hidden = true;
        host.classList.remove("is-going");
        Office.pause();
      }
    }, 420);
  }

  /** Switches the Overview to a view. */
  function show(id) {
    if (id === current) return;
    var was = current;
    current = id;
    document.querySelectorAll(".switch-tab").forEach(function (b) {
      var on = b.dataset.view === id;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", on);
      b.tabIndex = on ? 0 : -1;
    });
    placePuck(true);
    document.getElementById("app").dataset.view = id;
    var later = document.getElementById("later");
    if (id === "office") {
      later.hidden = true;
      showOffice();
    } else if (id === "work") {
      later.hidden = true;
      if (was === "office") showWork();
      else document.getElementById("work").hidden = false;
    } else {
      document.getElementById("work").hidden = true;
      document.getElementById("office").hidden = true;
      Later.draw(later, id);
      later.hidden = false;
    }
  }

  function mount() {
    drawSwitcher();
    // The Office is heavy. Hovering its tab is a good sign it is wanted, so start building it then.
    document.getElementById("switcher").addEventListener("pointerover", function (e) {
      if (e.target.closest('.switch-tab[data-view="office"]')) loadKit();
    });
    document.getElementById("switcher").addEventListener("click", function (e) {
      var tab = e.target.closest(".switch-tab");
      if (!tab) return;
      show(tab.dataset.view);
      // A click leaves the board's keys live. A keyboard user stays on the tab.
      if (e.detail > 0) tab.blur();
    });
    window.addEventListener("keydown", function (e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      var v = allViews()[Number(e.key) - 1];
      if (v) {
        e.preventDefault();
        show(v.id);
      }
    });
    document.getElementById("switcher").addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.stopPropagation();
      var list = allViews();
      var i = list.findIndex(function (v) { return v.id === current; }) + (e.key === "ArrowRight" ? 1 : -1);
      if (!list[i]) return;
      show(list[i].id);
      document.querySelector('.switch-tab[data-view="' + list[i].id + '"]').focus();
    });
    document.fonts.ready.then(function () { placePuck(false); });
  }

  return { mount: mount, show: show, redraw: drawSwitcher, current: function () { return current; } };
})();

// PROTOTYPE - the three later views, at sketch level only: enough to see that each one slots into
// the same switcher and reads the same Tasks. Not designs.
window.Later = (function () {
  "use strict";

  function drawList(el) {
    var open = Store.state.tasks.filter(function (t) { return t.stage !== "landed"; }).slice(0, 26);
    el.innerHTML = '<div class="later-note">List, later: a title, one muted line, one mark. Sketch only.</div><div class="later-list">' + open.map(function (t) {
      var h = Store.decideHolder(t);
      var mark = h.kind === "you" ? '<i class="card-tab" data-need="' + t.need + '"></i>' : h.kind === "agent" ? Crew.face(t.agent, { pose: "working", size: 18 }) : "";
      return '<div class="later-row"><span class="later-mark">' + mark + "</span><b>" + Board.esc(t.name) + "</b><span>" + Board.esc(t.now || "") + "</span><time>" + NW.formatAge(t.age) + "</time></div>";
    }).join("") + "</div>";
  }

  function drawSurface(el) {
    var tasks = Store.state.tasks.filter(function (t) { return t.stage !== "landed"; });
    var dots = tasks.map(function (t) {
      var h = Crew.hash(t.project + (t.initiative || t.topic || t.id));
      var h2 = Crew.hash(t.id);
      var px = (((h >>> 3) % 70) + 15 + ((h2 % 9) - 4));
      var py = (((h >>> 9) % 66) + 16 + (((h2 >>> 4) % 9) - 4));
      return { t: t, x: px, y: py };
    });
    var byId = {};
    dots.forEach(function (d) { byId[d.t.id] = d; });
    var lines = dots.map(function (d) {
      return d.t.blockedBy.map(function (id) {
        var b = byId[id];
        return b ? '<line x1="' + d.x + '%" y1="' + d.y + '%" x2="' + b.x + '%" y2="' + b.y + '%"/>' : "";
      }).join("");
    }).join("");
    el.innerHTML = '<div class="later-note">One surface, later: every Task has a place of its own, and chains of blockers are real structure. Sketch only.</div><svg class="later-surface">' + lines + "</svg>" + dots.map(function (d) {
      return '<i class="later-dot" style="left:' + d.x + "%;top:" + d.y + '%" data-mine="' + (d.t.move === "you" ? 1 : 0) + '"></i>';
    }).join("");
  }

  function drawTracks(el) {
    var tasks = Store.state.tasks.slice(0, 22);
    el.innerHTML = '<div class="later-note">Tracks, later: one calendar, to see how long work takes from conception to delivery. Sketch only.</div><div class="later-tracks">' + tasks.map(function (t) {
      var start = (Crew.hash(t.id) % 45);
      var len = 8 + (Crew.hash(t.id + "l") % 40);
      return '<div class="later-track"><span>' + Board.esc(t.name) + '</span><i style="left:' + start + "%;width:" + len + '%"></i></div>';
    }).join("") + "</div>";
  }

  return {
    draw: function (el, id) {
      if (id === "list") drawList(el);
      if (id === "surface") drawSurface(el);
      if (id === "tracks") drawTracks(el);
    },
  };
})();
