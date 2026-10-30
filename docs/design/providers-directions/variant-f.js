// PROTOTYPE - Variant F, "Cards on the table": one wallet at a time. Its accounts lie on the table
// as cards (usage in a big Deco numeral, machines as pips). Below, what those cards offer, with a
// switch per model, beside the composer's menu as it will read. Point at a card and its models
// light up on both sides, so you see which card pays for which line of the menu.
(function () {
  var W = World, P = Pv, R = Pv.R, mark = Pv.mark, icon = Crew.icon;
  var ui = { wallet: null, hot: null, older: {}, q: "", flash: null };

  function current() {
    if (!ui.wallet || !R.wallet(ui.wallet)) ui.wallet = R.state.wallets[0].id;
    return R.wallet(ui.wallet);
  }

  function render() {
    if (!W.ACCOUNTS.length) return '<div class="set-col pv-col">' + P.empty() + "</div>";
    var w = current();
    return (
      '<div class="vf">' +
      tabs(w) +
      '<div class="vf-cards">' + R.accountsIn(w).map(function (a) { return card(w, a); }).join("") +
      '<button class="vf-card vf-card--add" data-sheet="add-account">' + icon("plus", 18) + "<span>Add an account</span><small>One per vendor in a wallet</small></button></div>" +
      '<div class="vf-build">' + offers(w) + preview(w) + "</div>" +
      "</div>"
    );
  }

  function headerAction() {
    return W.ACCOUNTS.length ? '<button class="btn btn--sm" data-sheet="add-account">' + icon("plus", 14) + "Add an account</button>" : "";
  }

  function tabs(w) {
    return (
      '<div class="vf-tabs" role="tablist">' +
      R.state.wallets.map(function (x) {
        var pr = R.projectsOf(x.id);
        var who = pr.list.concat(pr.isNew ? ["new projects"] : []).join(", ");
        return '<button role="tab" class="vf-tab" data-wallet-tab="' + x.id + '" aria-selected="' + (x.id === w.id) + '">' + R.monogram(x) + '<span><b>' + x.name + "</b><small>" + (who || "no project yet") + "</small></span></button>";
      }).join("") +
      '<button class="vf-tab vf-tab--new" data-new-wallet>' + icon("plus", 14) + "<span><b>New wallet</b><small>For a client, a side project</small></span></button>" +
      "</div>"
    );
  }

  /** Returns an account as a card: its mark and machines on top, its name, then its usage as a big numeral. */
  function card(w, a) {
    var v = W.VENDORS[a.vendor];
    var n = R.need(a);
    var num, sub;
    if (a.failed) { num = "!"; sub = "Key refused · replace it"; }
    else if (a.balance) { num = a.balance.replace(" left", ""); sub = "credits left"; }
    else if (a.usage) { num = a.usage.pct + "%"; sub = "of the " + a.usage.window.replace(" window", "").replace(" limit", "") + " · " + a.usage.resets; }
    else { num = a.endsIn.split(" ")[0]; sub = a.endsIn.split(" ")[1] + " left on the token"; }
    var shared = R.sharedWith(a.id, w.id);
    return (
      '<button class="vf-card' + (n ? " is-" + n.tone : "") + (ui.hot === a.id ? " is-hot" : "") + '" data-card="' + a.id + '">' +
      '<span class="vf-card-top"><span class="vf-card-mk">' + mark(v.mark, 16) + "</span>" + R.pips(a) + "</span>" +
      '<span class="vf-card-name">' + W.accountName(a) + "</span>" +
      '<span class="vf-card-plan">' + a.plan + (shared.length ? " · shared" : "") + "</span>" +
      '<span class="vf-card-use"><b class="vf-num">' + num + "</b>" + (a.usage && !a.failed ? '<i class="vf-bar"><i style="width:' + a.usage.pct + '%"></i></i>' : "") + "<small>" + (n ? n.text : sub) + "</small></span>" +
      "</button>"
    );
  }

  /** Returns what the wallet's accounts offer, grouped by account, with a switch per model. */
  function offers(w) {
    var q = ui.q.trim().toLowerCase();
    var groups = R.accountsIn(w).map(function (a) {
      var v = W.VENDORS[a.vendor];
      var picks = R.picksOf(w.id, a.id);
      var all = R.offersOf(a.id).filter(function (m) { return !m.tail || picks.indexOf(m.id) !== -1 || q; });
      var list = all.filter(function (m) { return Pv.D.matches(m, q); });
      var showOlder = ui.older[a.id] || q;
      var shown = showOlder ? list : list.filter(function (m) { return !m.older || picks.indexOf(m.id) !== -1; });
      var hidden = list.length - shown.length;
      if (q && !list.length) return "";
      return (
        '<div class="vf-og' + (ui.hot === a.id ? " is-hot" : "") + '" data-og="' + a.id + '">' +
        '<div class="vf-og-h">' + mark(v.mark, 13) + "<b>" + W.accountName(a) + "</b><small>" + picks.length + " of " + a.models + " in the menu</small></div>" +
        shown.slice(0, q ? 40 : 99).map(function (m) {
          var on = picks.indexOf(m.id) !== -1;
          var key = w.id + "|" + a.id + "|" + m.id;
          return (
            '<div class="vf-o' + (on ? " is-on" : "") + '">' +
            "<span><b>" + m.name + "</b>" + (m.tier ? "<small>" + m.tier + "</small>" : m.older ? "<small>older</small>" : "") + "</span>" +
            '<button class="toggle" role="switch" aria-checked="' + on + '" data-tog="' + key + '" title="' + (on ? "In the menu" : "Not in the menu") + '"></button>' +
            "</div>"
          );
        }).join("") +
        (hidden > 0 ? '<button class="ve-more" data-older="' + a.id + '">' + icon("plus", 12) + hidden + " older</button>" : "") +
        (a.models > 60 ? '<button class="ve-more" data-find="' + w.id + "|" + a.id + '">' + icon("search", 12) + "Search all " + a.models + "</button>" : "") +
        "</div>"
      );
    }).join("");
    return (
      '<div class="vf-offer">' +
      '<div class="vf-offer-h"><b>What ' + w.name + "'s accounts offer</b>" +
      '<label class="field vf-q">' + icon("search", 13) + '<input data-fq placeholder="Filter" value="' + ui.q + '" /></label></div>' +
      (groups || '<p class="ve-empty">Nothing matches.</p>') +
      "</div>"
    );
  }

  function preview(w) {
    var pr = R.projectsOf(w.id).list;
    return (
      '<aside class="vf-preview">' +
      '<div class="vf-prev-h">' + icon("compose", 13) + "<b>In the composer</b><small>" + (pr.length ? "for " + pr.join(", ") : "") + "</small></div>" +
      '<div class="md pop vf-menu">' +
      '<label class="md-search">' + icon("search", 14) + '<input placeholder="Search ' + R.count(w) + ' models" disabled /></label>' +
      R.menuHTML(w.id, { hot: ui.hot, project: pr[0] }) +
      "</div>" +
      '<p class="vd-rail-foot">The tabs switch wallets in the composer: the same model from another account. <button class="pv-link" data-reset>Start over</button></p>' +
      "</aside>"
    );
  }

  function wire(body, rerender) {
    function on(sel, fn) {
      body.querySelectorAll(sel).forEach(function (el) {
        el.addEventListener("click", function (ev) { ev.stopPropagation(); fn(el); rerender(); });
      });
    }
    on("[data-wallet-tab]", function (el) { ui.wallet = el.dataset.walletTab; ui.hot = null; });
    on("[data-mw-tab]", function (el) { ui.wallet = el.dataset.mwTab; ui.hot = null; });
    on("[data-tog]", function (el) { var p = el.dataset.tog.split("|"); R.toggle(p[0], p[1], p[2]); });
    on("[data-older]", function (el) { ui.older[el.dataset.older] = true; });
    on("[data-reset]", function () { R.reset(); ui.wallet = null; });
    body.querySelectorAll("[data-card]").forEach(function (el) {
      el.addEventListener("mouseenter", function () { setHot(body, el.dataset.card); });
      el.addEventListener("mouseleave", function () { setHot(body, null); });
      el.addEventListener("click", function () { Pv.openAccount(el.dataset.card, current().id); });
    });
    body.querySelectorAll("[data-og]").forEach(function (el) {
      el.addEventListener("mouseenter", function () { setHot(body, el.dataset.og); });
      el.addEventListener("mouseleave", function () { setHot(body, null); });
    });
    body.querySelectorAll("[data-find]").forEach(function (el) {
      el.addEventListener("click", function () { var p = el.dataset.find.split("|"); Pv.openWalletCatalog(p[0], p[1], rerender); });
    });
    var nw = body.querySelector("[data-new-wallet]");
    if (nw) nw.addEventListener("click", function () {
      var id = "w" + R.state.wallets.length;
      R.state.wallets.push({ id: id, name: "Client work", accounts: [] });
      R.save();
      ui.wallet = id;
      rerender();
    });
    var q = body.querySelector("[data-fq]");
    if (q) q.addEventListener("input", function () {
      ui.q = q.value;
      var pos = q.selectionStart;
      rerender();
      var again = document.querySelector("[data-fq]");
      again.focus();
      again.setSelectionRange(pos, pos);
    });
  }

  /** Lights one account on the cards, in the offers and in the menu, without a redraw. */
  function setHot(body, id) {
    ui.hot = id;
    body.querySelectorAll("[data-card]").forEach(function (el) { el.classList.toggle("is-hot", el.dataset.card === id); });
    body.querySelectorAll("[data-og]").forEach(function (el) { el.classList.toggle("is-hot", el.dataset.og === id); });
    body.querySelectorAll("[data-mw-acct]").forEach(function (el) { el.classList.toggle("is-hot", el.dataset.mwAcct === id); });
  }

  Pv.variants.f = { key: "f", name: "Cards on the table", about: "One wallet at a time: its accounts as cards, its offers beside its menu", render: render, headerAction: headerAction, wire: wire };
})();
