// PROTOTYPE - Variant H, "Profiles": round 3, F refined on Rogier's notes.
//   - Profiles (round 2's wallets) are plain tabs, so only the accounts are cards.
//   - No Deco face: avatars and numbers are in the UI face.
//   - One rule for every account: its section lists exactly what is in the menu, in the menu's
//     order. "Add a model" opens the same picker for every account, 14 models or 466. A model
//     released lately is offered once, as a quiet "New" line.
//   - Drag a model by its handle to reorder it within its account, or an account's head to
//     reorder the accounts; Alt+Up and Alt+Down do the same from the keyboard.
//   - The rail shows the menu as the composer opens it for this profile, the other profiles
//     folded below.
(function () {
  var W = World, P = Pv, R = Pv.R, mark = Pv.mark, icon = Crew.icon;
  var ui = { profile: null, picker: null, pq: "", unfold: {}, open: {}, pmenu: false, flash: null, drag: null };

  function S() { return Pv.P3; }
  function current() {
    if (!ui.profile || !S().profile(ui.profile)) ui.profile = S().state.profiles[0].id;
    return S().profile(ui.profile);
  }

  function render() {
    if (!W.ACCOUNTS.length) return '<div class="set-col pv-col">' + P.empty() + "</div>";
    var p = current();
    var accounts = S().accountsIn(p);
    return (
      '<div class="vh">' +
      tabs(p) +
      forLine(p) +
      (accounts.length
        ? '<div class="vh-cards">' + accounts.map(function (a) { return card(p, a); }).join("") + "</div>" +
          '<div class="vh-build"><div class="vh-menu">' +
          '<div class="vh-menu-h"><b>The menu</b><small>In this order in the composer. Drag to reorder.</small></div>' +
          accounts.map(function (a, i) { return section(p, a, i); }).join("") +
          "</div>" + rail(p) + "</div>"
        : emptyProfile(p)) +
      "</div>"
    );
  }

  function headerAction() {
    return W.ACCOUNTS.length ? '<button class="btn btn--sm" data-sheet="add-account">' + icon("plus", 14) + "Add an account</button>" : "";
  }

  /* ---------------------------------------------------------------- profiles */

  function tabs(p) {
    return (
      '<div class="vh-tabs" role="tablist">' +
      S().state.profiles.map(function (x) {
        return '<button role="tab" class="vh-tab" data-profile="' + x.id + '" aria-selected="' + (x.id === p.id) + '">' + S().avatar(x, "sm") + x.name + "<small>" + S().count(x) + "</small></button>";
      }).join("") +
      '<button class="vh-tab vh-tab--new" data-new-profile>' + icon("plus", 13) + "New profile</button>" +
      "</div>"
    );
  }

  function forLine(p) {
    var pr = S().projectsOf(p.id);
    var names = pr.list.map(function (x) { return "<b>" + x + "</b>"; });
    var text = names.length ? p.name + " is for " + names.join(", ").replace(/, ([^,]*)$/, " and $1") + "." : "No project uses " + p.name + " yet; a thread can still pick it.";
    if (pr.isNew) text += " New projects start with it.";
    return (
      '<p class="vh-for">' + text + ' <button class="pv-link" data-pmenu>' + (ui.pmenu ? "Done" : "Change") + "</button></p>" +
      (ui.pmenu
        ? '<div class="vg-pmenu vh-pmenu">' + W.PROJECTS.concat([{ id: "_new", rug: "none" }]).map(function (x) {
            var here = S().state.projects[x.id] === p.id;
            return '<button class="vg-pchip' + (here ? " is-on" : "") + '" data-move="' + x.id + '">' + (x.id === "_new" ? "New projects" : '<span class="proj proj--' + x.rug + '">' + x.id + "</span>") + "</button>";
          }).join("") + "</div>"
        : "")
    );
  }

  function emptyProfile(p) {
    var usable = W.ACCOUNTS.filter(function (a) { return !S().accountsIn(p).some(function (x) { return x.vendor === a.vendor; }); });
    return (
      '<div class="vh-empty"><b>' + p.name + " has no account yet</b><span>Use one you already have, or add a new one. A profile holds one account per vendor.</span>" +
      '<div class="vh-use">' + usable.map(function (a) {
        return '<button class="vg-pill" data-use="' + a.id + '">' + mark(W.VENDORS[a.vendor].mark, 12) + W.accountName(a) + "</button>";
      }).join("") + '<button class="vg-add vg-add--text" data-sheet="add-account">' + icon("plus", 12) + "New account</button></div></div>"
    );
  }

  /* ---------------------------------------------------------------- accounts */

  function card(p, a) {
    var v = W.VENDORS[a.vendor];
    var n = R.need(a);
    var num, sub;
    if (a.failed) { num = "Key refused"; sub = "at " + a.failed.at + " · replace it"; }
    else if (a.balance) { num = a.balance.replace(" left", ""); sub = "credits left"; }
    else if (a.usage) { num = a.usage.pct + "%"; sub = "of the " + a.usage.window.replace(" window", "").replace(" limit", "") + " · resets " + a.usage.resets; }
    else { num = a.endsIn; sub = "left on the token"; }
    var others = S().state.profiles.filter(function (x) { return x.id !== p.id && x.accounts.indexOf(a.id) !== -1; });
    return (
      '<button class="vf-card vh-card' + (n ? " is-" + n.tone : "") + '" data-card="' + a.id + '">' +
      '<span class="vf-card-top"><span class="vf-card-mk">' + mark(v.mark, 16) + "</span>" + R.pips(a) + "</span>" +
      '<span class="vf-card-name">' + W.accountName(a) + "</span>" +
      '<span class="vf-card-plan">' + a.plan + (others.length ? " · also in " + others.length + " other" + (others.length > 1 ? "s" : "") : "") + "</span>" +
      '<span class="vf-card-use"><b class="vh-num">' + num + "</b>" + (a.usage && !a.failed ? '<i class="vf-bar"><i style="width:' + a.usage.pct + '%"></i></i>' : "") + "<small>" + (n && !a.failed ? n.text : sub) + "</small></span>" +
      "</button>"
    );
  }

  /** Returns one account's part of the menu: its head, its models in order, a new release if any, and Add. */
  function section(p, a, index) {
    var v = W.VENDORS[a.vendor];
    var picks = S().picksOf(p.id, a.id).map(W.catalogModel).filter(Boolean);
    var key = p.id + "|" + a.id;
    var fresh = S().news(p.id, a.id);
    return (
      '<div class="vh-sec" data-sec="' + a.id + '" data-index="' + index + '">' +
      '<div class="vh-sh" draggable="true" data-drag-sec="' + a.id + '" title="Drag to move ' + W.accountName(a) + "'s models up or down the menu\">" +
      '<span class="vh-grip">' + icon("grip", 12) + "</span>" + mark(v.mark, 13) + "<b>" + W.accountName(a) + "</b>" + R.gauge(a) + "</div>" +
      picks.map(function (m, i) { return row(p, a, m, i, picks.length); }).join("") +
      fresh.map(function (m) {
        return '<div class="vh-new"><span class="pk-new">New</span><b>' + m.name + "</b><small>" + m.tier + " · released " + m.fresh + '</small><span class="spacer"></span><button class="btn btn--sm" data-add-new="' + key + "|" + m.id + '">Add</button><button class="btn btn--sm btn--quiet" data-dismiss="' + key + "|" + m.id + '">Not now</button></div>';
      }).join("") +
      '<div class="vh-addwrap"><button class="vh-add" data-picker="' + key + '">' + icon("plus", 12) + "Add a model" + (a.models > 60 ? '<small>from ' + a.models + "</small>" : "") + "</button>" +
      (ui.picker === key ? picker(p, a) : "") +
      "</div></div>"
    );
  }

  function row(p, a, m, i, n) {
    var key = p.id + "|" + a.id + "|" + m.id;
    var def = S().isDefault(p.id, a.id, m.id);
    return (
      '<div class="vh-row' + (ui.flash === key ? " is-fresh" : "") + '" draggable="true" tabindex="0" data-drag-row="' + key + '" data-i="' + i + '" data-n="' + n + '">' +
      '<span class="vh-grip" title="Drag to reorder">' + icon("grip", 12) + "</span>" +
      "<b>" + m.name + "</b><small>" + (m.tier || (m.older ? "older" : m.meta || "")) + "</small>" +
      '<span class="spacer"></span>' +
      (def ? '<span class="ve-def">default</span>' : '<button class="ve-mkdef" data-def="' + key + '">Make default</button>') +
      '<button class="vh-x" data-remove="' + key + '" title="Take ' + m.name + ' out of the menu">' + icon("close", 11) + "</button>" +
      "</div>"
    );
  }

  /** Returns the picker: the composer's own selector, for one account, to add from. */
  function picker(p, a) {
    return (
      '<div class="vh-picker pop">' +
      '<label class="md-search">' + icon("search", 14) + '<input data-pq placeholder="Search ' + a.models + " models from " + (a.label ? W.accountName(a) : W.VENDORS[a.vendor].name) + '" value="' + ui.pq + '" /></label>' +
      '<div class="vh-plist">' + S().pickerList(p.id, a.id, ui.pq, ui.unfold) + "</div>" +
      '<div class="vh-pfoot"><span>Click to add or take out.</span><button class="btn btn--sm" data-picker-close>Done</button></div>' +
      "</div>"
    );
  }

  /* ---------------------------------------------------------------- the rail */

  function rail(p) {
    var pr = S().projectsOf(p.id).list;
    return (
      '<aside class="vh-rail">' +
      '<div class="vf-prev-h">' + icon("compose", 13) + "<b>In the composer</b><small>" + (pr.length ? "a thread in " + pr[0] : "a thread set to " + p.name) + "</small></div>" +
      '<div class="md pop vh-prev">' +
      '<label class="md-search">' + icon("search", 14) + '<input placeholder="Search models" disabled /></label>' +
      '<div class="md-list">' + S().menuHTML(p.id, { open: ui.open }) + "</div>" +
      "</div>" +
      '<p class="vd-rail-foot">Other profiles fold into one row each, however many there are. <button class="pv-link" data-reset>Start over</button></p>' +
      "</aside>"
    );
  }

  /* ---------------------------------------------------------------- wiring */

  function move(list, from, to) {
    var item = list.splice(from, 1)[0];
    list.splice(to, 0, item);
  }

  function wire(body, rerender) {
    function on(sel, fn) {
      body.querySelectorAll(sel).forEach(function (el) {
        el.addEventListener("click", function (ev) { ev.stopPropagation(); fn(el); rerender(); });
      });
    }
    on("[data-profile]", function (el) { ui.profile = el.dataset.profile; ui.picker = null; ui.pmenu = false; });
    on("[data-pmenu]", function () { ui.pmenu = !ui.pmenu; });
    on("[data-move]", function (el) { S().moveProject(el.dataset.move, current().id); });
    on("[data-def]", function (el) { var k = el.dataset.def.split("|"); S().setDefault(k[0], k[1], k[2]); });
    on("[data-remove]", function (el) { var k = el.dataset.remove.split("|"); S().remove(k[0], k[1], k[2]); });
    on("[data-add-new]", function (el) { var k = el.dataset.addNew.split("|"); S().add(k[0], k[1], k[2]); ui.flash = el.dataset.addNew; });
    on("[data-dismiss]", function (el) { var k = el.dataset.dismiss.split("|"); S().dismiss(k[0], k[1], k[2]); });
    on("[data-picker]", function (el) { ui.picker = ui.picker === el.dataset.picker ? null : el.dataset.picker; ui.pq = ""; ui.unfold = {}; });
    on("[data-picker-close]", function () { ui.picker = null; });
    on("[data-unfold]", function (el) { ui.unfold[el.dataset.unfold] = true; });
    on("[data-other]", function (el) { ui.open[el.dataset.other] = !ui.open[el.dataset.other]; });
    on("[data-reset]", function () { S().reset(); ui.profile = null; });
    on("[data-use]", function (el) { current().accounts.push(el.dataset.use); S().save(); });
    on("[data-pick]", function (el) {
      var k = ui.picker.split("|");
      var picks = S().picksOf(k[0], k[1]);
      if (picks.indexOf(el.dataset.pick) === -1) { S().add(k[0], k[1], el.dataset.pick); ui.flash = ui.picker + "|" + el.dataset.pick; }
      else S().remove(k[0], k[1], el.dataset.pick);
    });
    body.querySelectorAll("[data-card]").forEach(function (el) {
      el.addEventListener("click", function () { Pv.openAccount(el.dataset.card, current().id, S()); });
    });
    var nw = body.querySelector("[data-new-profile]");
    if (nw) nw.addEventListener("click", function () {
      var id = "p" + S().state.profiles.length;
      S().state.profiles.push({ id: id, name: "Client work", accounts: [] });
      S().save();
      ui.profile = id;
      rerender();
    });

    // The picker's search filters as you type and keeps the caret.
    var pq = body.querySelector("[data-pq]");
    if (pq) {
      if (window.top === window) pq.focus();
      pq.setSelectionRange(pq.value.length, pq.value.length);
      pq.addEventListener("input", function () {
        ui.pq = pq.value;
        var k = ui.picker.split("|");
        body.querySelector(".vh-plist").innerHTML = S().pickerList(k[0], k[1], ui.pq, ui.unfold);
        body.querySelectorAll("[data-pick]").forEach(function (el) {
          el.addEventListener("click", function (ev) { ev.stopPropagation(); var picks = S().picksOf(k[0], k[1]); if (picks.indexOf(el.dataset.pick) === -1) S().add(k[0], k[1], el.dataset.pick); else S().remove(k[0], k[1], el.dataset.pick); ui.flash = ui.picker + "|" + el.dataset.pick; rerender(); });
        });
      });
    }

    // Reordering models within an account, by drag or by Alt+Up and Alt+Down.
    body.querySelectorAll("[data-drag-row]").forEach(function (el) {
      el.addEventListener("dragstart", function (ev) {
        ui.drag = { kind: "row", key: el.dataset.dragRow };
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", el.dataset.dragRow);
        el.classList.add("is-dragging");
      });
      el.addEventListener("dragend", function () { el.classList.remove("is-dragging"); clearMarks(body); });
      el.addEventListener("dragover", function (ev) {
        if (!ui.drag || ui.drag.kind !== "row") return;
        var a = ui.drag.key.split("|"), b = el.dataset.dragRow.split("|");
        if (a[0] !== b[0] || a[1] !== b[1]) return; // only within one account
        ev.preventDefault();
        clearMarks(body);
        var r = el.getBoundingClientRect();
        el.classList.add(ev.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
      });
      el.addEventListener("drop", function (ev) {
        ev.preventDefault();
        var a = ui.drag.key.split("|"), b = el.dataset.dragRow.split("|");
        var list = S().picksOf(a[0], a[1]);
        var from = list.indexOf(a[2]);
        var to = list.indexOf(b[2]) + (el.classList.contains("drop-after") ? 1 : 0);
        if (from < to) to--;
        move(list, from, to);
        S().save();
        ui.drag = null;
        ui.flash = a.join("|");
        rerender();
      });
      el.addEventListener("keydown", function (ev) {
        if (!ev.altKey || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
        ev.preventDefault();
        ev.stopPropagation();
        var k = el.dataset.dragRow.split("|");
        var list = S().picksOf(k[0], k[1]);
        var i = list.indexOf(k[2]);
        var j = ev.key === "ArrowUp" ? i - 1 : i + 1;
        if (j < 0 || j >= list.length) return;
        move(list, i, j);
        S().save();
        ui.flash = el.dataset.dragRow;
        rerender();
        var again = document.querySelector('[data-drag-row="' + el.dataset.dragRow + '"]');
        if (again) again.focus();
      });
    });
    // Reordering the accounts, which moves their whole part of the menu.
    body.querySelectorAll("[data-drag-sec]").forEach(function (el) {
      el.addEventListener("dragstart", function (ev) {
        ui.drag = { kind: "sec", id: el.dataset.dragSec };
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", el.dataset.dragSec);
      });
      el.addEventListener("dragend", function () { clearMarks(body); });
    });
    body.querySelectorAll("[data-sec]").forEach(function (sec) {
      sec.addEventListener("dragover", function (ev) {
        if (!ui.drag || ui.drag.kind !== "sec") return;
        ev.preventDefault();
        clearMarks(body);
        var r = sec.getBoundingClientRect();
        sec.classList.add(ev.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
      });
      sec.addEventListener("drop", function (ev) {
        if (!ui.drag || ui.drag.kind !== "sec") return;
        ev.preventDefault();
        var list = current().accounts;
        var from = list.indexOf(ui.drag.id);
        var to = list.indexOf(sec.dataset.sec) + (sec.classList.contains("drop-after") ? 1 : 0);
        if (from < to) to--;
        move(list, from, to);
        S().save();
        ui.drag = null;
        rerender();
      });
    });
  }

  function clearMarks(body) {
    body.querySelectorAll(".drop-before, .drop-after").forEach(function (x) { x.classList.remove("drop-before", "drop-after"); });
  }

  Pv.variants.h = { key: "h", name: "Profiles", about: "F refined: profiles as tabs, one rule for every account, reorder by dragging", render: render, headerAction: headerAction, wire: wire };
})();
