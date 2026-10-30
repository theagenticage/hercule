// PROTOTYPE - Variant G, "The ledger": the quietest page. Each wallet reads as two sentences:
// who pays, and what the menu offers. Accounts are small pills, models are words you can take
// out. Point at "Menu" and the composer's menu opens beside it, as it will read. Below, one
// ledger line per account, with a dotted leader to its machines and its usage.
(function () {
  var W = World, P = Pv, R = Pv.R, mark = Pv.mark, icon = Crew.icon;
  var ui = { pmenu: null };

  function render() {
    if (!W.ACCOUNTS.length) return '<div class="set-col pv-col">' + P.empty() + "</div>";
    return (
      '<div class="vg">' +
      R.state.wallets.map(wallet).join("") +
      '<button class="vg-new" data-new-wallet>' + icon("plus", 14) + "New wallet</button>" +
      ledger() +
      "</div>"
    );
  }

  function headerAction() {
    return W.ACCOUNTS.length ? '<button class="btn btn--sm" data-sheet="add-account">' + icon("plus", 14) + "Add an account</button>" : "";
  }

  function wallet(w) {
    var pr = R.projectsOf(w.id);
    var who = pr.list.map(function (p) { return '<b>' + p + "</b>"; }).concat(pr.isNew ? ["new projects"] : []);
    var accounts = R.accountsIn(w);
    var pills = accounts.map(function (a) {
      var v = W.VENDORS[a.vendor];
      var n = R.need(a);
      return '<button class="vg-pill' + (n ? " is-" + n.tone : "") + '" data-account="' + a.id + '" data-wallet="' + w.id + '">' + mark(v.mark, 12) + W.accountName(a) + R.pips(a) + "</button>";
    }).join("");
    var groups = accounts.map(function (a) {
      var v = W.VENDORS[a.vendor];
      var picks = R.picksOf(w.id, a.id).map(W.catalogModel).filter(Boolean);
      if (!picks.length) return "";
      return (
        '<span class="vg-g">' + mark(v.mark, 12) +
        picks.map(function (m) {
          var def = R.isDefault(w.id, a.id, m.id);
          return '<span class="vg-m' + (def ? " is-def" : "") + '">' + m.name + (def ? '<i title="Default for new threads">★</i>' : "") + '<button data-out="' + w.id + "|" + a.id + "|" + m.id + '" title="Take ' + m.name + ' out of the menu">' + icon("close", 10) + "</button></span>";
        }).join('<span class="vg-dot">·</span>') +
        "</span>"
      );
    }).join("");
    return (
      '<section class="vg-w">' +
      '<div class="vg-wh">' + R.monogram(w, "lg") + "<h2>" + w.name + "</h2>" +
      '<p class="vg-for">' + (who.length ? "for " + who.join(", ").replace(/, ([^,]*)$/, " and $1") : "for no project yet") + ' <button class="pv-link" data-pmenu="' + w.id + '">change</button></p></div>' +
      (ui.pmenu === w.id ? projectMenu(w) : "") +
      '<div class="vg-line"><span class="vg-k">Pays with</span><span class="vg-v">' + (pills || '<span class="faint">no account yet</span>') + '<button class="vg-add" data-sheet="add-account">' + icon("plus", 12) + "</button></span></div>" +
      '<div class="vg-line vg-line--menu"><span class="vg-k vg-peek" tabindex="0">Menu ' + icon("chev-r", 11) +
      '<span class="vg-pop md pop">' + R.menuHTML(w.id, { noTabs: true }) + "</span></span>" +
      '<span class="vg-v">' + (groups || '<span class="faint">nothing yet</span>') + '<button class="vg-add vg-add--text" data-find="' + w.id + '">' + icon("plus", 12) + "Add</button></span></div>" +
      "</section>"
    );
  }

  function projectMenu(w) {
    return (
      '<div class="vg-pmenu">' +
      W.PROJECTS.concat([{ id: "_new", rug: "none" }]).map(function (p) {
        var here = R.state.projects[p.id] === w.id;
        return '<button class="vg-pchip' + (here ? " is-on" : "") + '" data-move="' + p.id + "|" + w.id + '">' + (p.id === "_new" ? "New projects" : '<span class="proj proj--' + p.rug + '">' + p.id + "</span>") + "</button>";
      }).join("") +
      "</div>"
    );
  }

  /** Returns one line per account: name, a dotted leader, then how it signs in, its machines and its usage. */
  function ledger() {
    return (
      '<section class="vg-ledger"><h3>Accounts</h3>' +
      W.ACCOUNTS.map(function (a) {
        var v = W.VENDORS[a.vendor];
        var n = R.need(a);
        var ins = R.state.wallets.filter(function (w) { return w.accounts.indexOf(a.id) !== -1; });
        return (
          '<button class="vg-row" data-account="' + a.id + '" data-wallet="' + (ins[0] ? ins[0].id : "") + '">' +
          mark(v.mark, 14) + '<span class="vg-rn">' + W.accountName(a) + ' <small>' + a.plan + "</small></span>" +
          '<i class="vg-lead"></i>' +
          '<span class="vg-rw">' + ins.map(function (w) { return R.monogram(w, "sm"); }).join("") + "</span>" +
          '<span class="vg-rs' + (n ? " " + n.tone + "-ink" : "") + '">' + (n ? n.text : P.methodWords(a)) + "</span>" +
          R.pips(a) + R.gauge(a) +
          "</button>"
        );
      }).join("") +
      "</section>"
    );
  }

  function wire(body, rerender) {
    function on(sel, fn) {
      body.querySelectorAll(sel).forEach(function (el) {
        el.addEventListener("click", function (ev) { ev.stopPropagation(); fn(el); rerender(); });
      });
    }
    on("[data-out]", function (el) { var p = el.dataset.out.split("|"); R.toggle(p[0], p[1], p[2]); });
    on("[data-pmenu]", function (el) { ui.pmenu = ui.pmenu === el.dataset.pmenu ? null : el.dataset.pmenu; });
    on("[data-move]", function (el) { var p = el.dataset.move.split("|"); R.moveProject(p[0], p[1]); });
    body.querySelectorAll("[data-account]").forEach(function (el) {
      el.addEventListener("click", function () { Pv.openAccount(el.dataset.account, el.dataset.wallet); });
    });
    body.querySelectorAll("[data-find]").forEach(function (el) {
      el.addEventListener("click", function () { Pv.openWalletCatalog(el.dataset.find, null, rerender); });
    });
    var nw = body.querySelector("[data-new-wallet]");
    if (nw) nw.addEventListener("click", function () {
      R.state.wallets.push({ id: "w" + R.state.wallets.length, name: "Client work", accounts: [] });
      R.save();
      rerender();
    });
  }

  Pv.variants.g = { key: "g", name: "The ledger", about: "Each wallet as two sentences; accounts as ledger lines", render: render, headerAction: headerAction, wire: wire };
})();
