// PROTOTYPE - Variant E, "Menu cards": one column per wallet, side by side. The column is that
// wallet's composer menu itself, drawn as the composer draws it, with a box on each model:
// ticking a model is putting it in the menu. Each account heads its own section, with its
// usage and its machines, so the account row and the menu are one thing. Work and Personal
// sit next to each other, so what differs between them (Daybreak, Opus 4.8) is plain to see.
(function () {
  var W = World, P = Pv, R = Pv.R, mark = Pv.mark, icon = Crew.icon;
  var ui = { more: {}, pmenu: null, flash: null };

  function render() {
    if (!W.ACCOUNTS.length) return '<div class="set-col pv-col">' + P.empty() + "</div>";
    var ws = R.state.wallets;
    return (
      '<div class="ve">' +
      '<p class="pv-lead ve-lead">Each wallet holds the accounts that pay for one side of your work, and the menu its projects see in the composer.</p>' +
      '<div class="ve-cols" style="grid-template-columns: repeat(' + ws.length + ', minmax(330px, 1fr))">' + ws.map(column).join("") + "</div>" +
      harnesses() +
      "</div>"
    );
  }

  function headerAction() {
    return W.ACCOUNTS.length
      ? '<button class="btn btn--sm btn--quiet" data-new-wallet>' + icon("plus", 14) + 'New wallet</button><button class="btn btn--sm" data-sheet="add-account">' + icon("plus", 14) + "Add an account</button>"
      : "";
  }

  /* ---------------------------------------------------------------- a wallet */

  function column(w) {
    var pr = R.projectsOf(w.id);
    var who = pr.list.concat(pr.isNew ? ["new projects"] : []);
    var accounts = R.accountsIn(w);
    return (
      '<section class="ve-w" data-wallet="' + w.id + '">' +
      '<header class="ve-wh">' + R.monogram(w, "lg") +
      '<span class="ve-wt"><b>' + w.name + "</b>" +
      '<button class="ve-proj" data-pmenu="' + w.id + '">' + (who.length ? "For " + who.join(", ").replace(/, ([^,]*)$/, " and $1") : "No project yet") + icon("chev-d", 11) + "</button></span>" +
      '<button class="icon-btn" title="More">' + icon("more") + "</button></header>" +
      (ui.pmenu === w.id ? projectMenu(w) : "") +
      '<div class="ve-card">' +
      '<div class="ve-card-h">' + icon("compose", 13) + "<span>In the composer</span><small>" + R.count(w) + " model" + (R.count(w) === 1 ? "" : "s") + '</small><a class="ve-peek" href="composer.html?project=' + (pr.list[0] || "webshop") + '" title="Open the composer for ' + (pr.list[0] || "webshop") + '">' + icon("popout", 13) + "</a></div>" +
      (accounts.length ? accounts.map(function (a) { return section(w, a); }).join("") : '<p class="ve-empty">No account yet. A wallet pays with one account per vendor.</p>') +
      '<button class="ve-addacct" data-sheet="add-account">' + icon("plus", 13) + "Add an account to " + w.name + "</button>" +
      "</div>" +
      "</section>"
    );
  }

  /** Returns the projects as a small list to move into or out of this wallet. */
  function projectMenu(w) {
    return (
      '<div class="ve-pmenu pop">' +
      W.PROJECTS.concat([{ id: "_new", rug: "none" }]).map(function (p) {
        var inHere = R.state.projects[p.id] === w.id;
        var label = p.id === "_new" ? "New projects" : '<span class="proj proj--' + p.rug + '">' + p.id + "</span>";
        var now = R.wallet(R.state.projects[p.id]);
        return '<button class="line" data-move="' + p.id + "|" + w.id + '"><span class="choice-box"><input type="radio"' + (inHere ? " checked" : "") + ' tabindex="-1" /></span><span class="grow">' + label + "</span>" + (inHere ? "" : '<span class="line-note">in ' + now.name + "</span>") + "</button>";
      }).join("") +
      "</div>"
    );
  }

  /** Returns one account's section: its head (who pays, machines, usage), then its models. */
  function section(w, a) {
    var v = W.VENDORS[a.vendor];
    var picks = R.picksOf(w.id, a.id);
    var offers = R.offersOf(a.id);
    var key = w.id + "|" + a.id;
    var open = ui.more[key];
    var shared = R.sharedWith(a.id, w.id);
    var n = R.need(a);
    var picked = picks.map(W.catalogModel).filter(Boolean);
    var rest = offers.filter(function (m) { return picks.indexOf(m.id) === -1; });
    var restShown = a.models > 60 ? rest.filter(function (m) { return !m.tail; }).slice(0, 6) : rest;
    return (
      '<div class="ve-sec' + (a.failed ? " is-fail" : "") + '">' +
      '<button class="ve-sh" data-account="' + a.id + '" title="Open ' + W.accountName(a) + '">' +
      '<span class="pv-mk ve-mk">' + mark(v.mark, 14) + "</span>" +
      '<span class="ve-sn"><b>' + W.accountName(a) + "</b><small>" + a.plan + (shared.length ? " · also in " + shared.map(function (s) { return s.name; }).join(", ") : "") + "</small></span>" +
      R.pips(a) + R.gauge(a) + "</button>" +
      (n ? '<div class="ve-need ve-need--' + n.tone + '"><span>' + n.text + "</span>" + (n.action ? '<button class="btn btn--sm" data-sheet="' + n.sheet + '">' + n.action + "</button>" : "") + "</div>" : "") +
      picked.map(function (m) { return row(w, a, m, true); }).join("") +
      (open ? restShown.map(function (m) { return row(w, a, m, false); }).join("") : "") +
      (rest.length
        ? '<button class="ve-more" data-more="' + key + '">' + (open ? icon("minus", 12) + "Fewer" : icon("plus", 12) + rest.length + " more from " + (a.label || v.name)) + "</button>" +
          (open && a.models > 60 ? '<button class="ve-more ve-more--find" data-find="' + key + '">' + icon("search", 12) + "Search all " + a.models + "</button>" : "")
        : "") +
      "</div>"
    );
  }

  function row(w, a, m, on) {
    var def = R.isDefault(w.id, a.id, m.id);
    var fresh = ui.flash === w.id + "|" + a.id + "|" + m.id;
    return (
      '<div class="ve-row' + (on ? " is-on" : "") + (fresh ? " is-fresh" : "") + '">' +
      '<button class="ve-box" data-tog="' + w.id + "|" + a.id + "|" + m.id + '" title="' + (on ? "Take out of the menu" : "Put in the menu") + '">' + (on ? icon("check", 10) : "") + "</button>" +
      "<b>" + m.name + "</b>" +
      (m.older ? '<span class="ve-tag">older</span>' : "") +
      (m.tier === "Business only" ? '<span class="ve-tag">Business only</span>' : "") +
      '<span class="spacer"></span>' +
      (def ? '<span class="ve-def">default</span>' : on ? '<button class="ve-mkdef" data-def="' + w.id + "|" + a.id + "|" + m.id + '">Make default</button>' : "") +
      "</div>"
    );
  }

  function harnesses() {
    return (
      '<section class="ve-harn">' +
      '<span class="ve-harn-h">Harnesses</span>' +
      W.HARNESSES.map(function (h) {
        var missing = W.ALL.filter(function (m) { return h.on.indexOf(m) === -1; });
        return '<span class="ve-h' + (missing.length ? " is-you" : "") + '" title="' + h.about + '">' + mark(h.mark, 13) + h.name + ' <small>' + (missing.length ? "not on " + missing.join(", ") : h.version) + "</small>" + (missing.length ? '<button class="pv-link">Install</button>' : "") + "</span>";
      }).join("") +
      "</section>"
    );
  }

  /* ---------------------------------------------------------------- wiring */

  function wire(body, rerender) {
    function on(sel, fn) {
      body.querySelectorAll(sel).forEach(function (el) {
        el.addEventListener("click", function (ev) { ev.stopPropagation(); fn(el); rerender(); });
      });
    }
    on("[data-tog]", function (el) {
      var p = el.dataset.tog.split("|");
      var wasOn = R.picksOf(p[0], p[1]).indexOf(p[2]) !== -1;
      R.toggle(p[0], p[1], p[2]);
      ui.flash = wasOn ? null : el.dataset.tog;
    });
    on("[data-def]", function (el) { var p = el.dataset.def.split("|"); R.setDefault(p[0], p[1], p[2]); });
    on("[data-more]", function (el) { ui.more[el.dataset.more] = !ui.more[el.dataset.more]; });
    on("[data-pmenu]", function (el) { ui.pmenu = ui.pmenu === el.dataset.pmenu ? null : el.dataset.pmenu; });
    on("[data-move]", function (el) {
      var p = el.dataset.move.split("|");
      R.moveProject(p[0], p[1]);
    });
    body.querySelectorAll("[data-account]").forEach(function (el) {
      el.addEventListener("click", function () { Pv.openAccount(el.dataset.account, el.closest("[data-wallet]").dataset.wallet); });
    });
    body.querySelectorAll("[data-find]").forEach(function (el) {
      el.addEventListener("click", function () {
        var p = el.dataset.find.split("|");
        Pv.openWalletCatalog(p[0], p[1], rerender);
      });
    });
    var nw = document.querySelector("[data-new-wallet]");
    if (nw && !nw.dataset.wired) {
      nw.dataset.wired = "1";
      nw.addEventListener("click", function () {
        R.state.wallets.push({ id: "w" + R.state.wallets.length, name: "Client work", accounts: [] });
        R.save();
        rerender();
      });
    }
  }

  Pv.variants.e = { key: "e", name: "Menu cards", about: "One column per wallet; the column is its composer menu", render: render, headerAction: headerAction, wire: wire };
})();
