// PROTOTYPE - Variant A, "The menu": models first. The page opens on the composer's own menu, in
// its order; a click on a model opens its route (which account pays, which harness runs it).
// Accounts and harnesses follow as short lists, one line each, quiet unless something needs you.
(function () {
  var W = World, P = Pv, mark = Pv.mark, icon = Crew.icon;
  var open = { 5: true };

  function render(body) {
    if (!W.ACCOUNTS.length) return '<div class="set-col pv-col">' + P.empty() + "</div>";
    return (
      '<div class="set-col pv-col va">' +
      '<p class="pv-lead">Your threads pick a model from this menu. Each one says who pays for it and which harness runs it.</p>' +
      menuSection() + accountsSection() + harnessSection() +
      "</div>"
    );
  }

  /* ---------------------------------------------------------------- the menu */

  function menuSection() {
    return (
      "<section>" +
      '<div class="pv-head"><div><h2>Model menu</h2><p>What the composer offers, in this order. The first is the default for new threads.</p></div><span class="spacer"></span>' +
      '<button class="btn btn--sm" data-sheet="catalog">' + icon("plus", 14) + "Add models</button></div>" +
      '<div class="va-list">' + W.MENU.map(entry).join("") + "</div>" +
      '<p class="va-more">' + W.catalogCount() + " models come with your accounts. Older ones stay out of the menu until you add them.</p>" +
      "</section>"
    );
  }

  function entry(e, i) {
    var a = W.account(e.account), v = W.VENDORS[a.vendor];
    var problem = W.entryProblem(e);
    var end = "";
    if (problem && problem.kind === "fail") end = P.note(problem.text, "fail");
    else if (problem) end = '<span class="pv-note pv-note--you" title="' + problem.why + '">' + problem.text + "</span>";
    return (
      '<div class="va-entry' + (open[i] ? " is-open" : "") + (problem && problem.kind === "fail" ? " is-fail" : "") + '" data-entry="' + i + '">' +
      '<div class="va-row" role="button" tabindex="0" data-toggle="' + i + '">' +
      '<span class="va-grip">' + icon("grip", 14) + "</span>" +
      '<span class="pv-mk">' + mark(v.mark, 16) + "</span>" +
      '<span class="va-name"><b>' + W.entryName(e) + (e.isDefault ? '<span class="chip pv-chip-default">Default</span>' : "") + "</b>" + P.routeLine(e) + "</span>" +
      '<span class="va-end">' + end + '<span class="va-chev">' + icon("chev-r", 14) + "</span></span>" +
      '<button class="icon-btn" title="More">' + icon("more") + "</button>" +
      "</div>" +
      (open[i] ? routeEditor(e) : "") +
      "</div>"
    );
  }

  /** Draws every account that offers the entry's model against every harness, with this entry's route marked. */
  function routeEditor(e) {
    var m = W.model(e.model);
    var routes = W.routesOf(m);
    var heads = W.HARNESSES.map(function (h) {
      return '<span class="va-gh">' + mark(h.mark, 12) + h.name + "</span>";
    }).join("");
    var rows = routes.map(function (r) {
      var a = r.account, v = W.VENDORS[a.vendor];
      var sub = a.failed ? '<small class="fail-ink">' + a.failed.what + "</small>" : "<small>" + P.payWords(a) + "</small>";
      var cells = W.HARNESSES.map(function (h) {
        if (r.harnesses.indexOf(h.id) === -1) {
          return '<span class="va-cell" title="' + (a.only || h.name + " cannot reach " + W.accountName(a)) + '"><i class="va-no"></i></span>';
        }
        var mine = e.account === a.id && e.harness === h.id;
        var other = !mine && W.MENU.some(function (x) { return x.model === e.model && x.account === a.id && x.harness === h.id; });
        var cls = mine ? (a.failed ? " is-fail" : " is-on") : other ? " is-other" : "";
        var tip = mine ? "This entry" : other ? "Also in the menu" : "Use " + W.accountName(a) + " in " + h.name;
        var missing = h.on.length < W.ALL.length ? " · not on " + W.ALL.filter(function (x) { return h.on.indexOf(x) === -1; }).join(", ") : "";
        return '<span class="va-cell"><button class="va-dot' + cls + '" title="' + tip + missing + '"></button></span>';
      }).join("");
      return '<span class="va-src"><span class="pv-mk">' + mark(v.mark, 14) + "</span><span><b>" + W.accountName(a) + "</b>" + sub + "</span></span>" + cells;
    }).join("");
    var whys = routes.filter(function (r) { return r.account.only && r.harnesses.length < W.HARNESSES.length; })
      .map(function (r) { return r.account.only; })
      .filter(function (t, i, all) { return all.indexOf(t) === i; });
    var problem = W.entryProblem(e);
    var where = problem && problem.kind === "fail"
      ? '<span class="pv-note--fail">Cannot start: ' + problem.text + '</span><button class="btn btn--sm" data-sheet="replace-key">Replace key</button>'
      : problem
      ? '<span class="pv-note--you">' + problem.text + "</span><span>· " + problem.why + "</span>"
      : "<span>Runs on every machine</span>";
    return (
      '<div class="va-route">' +
      '<p class="va-route-q">Where should ' + W.model(e.model).name + " come from, and what should run it?</p>" +
      '<div class="va-grid"><span></span>' + heads + rows + "</div>" +
      (whys.length ? '<p class="va-route-why">' + whys.join(" ") + "</p>" : "") +
      '<div class="va-route-foot">' + where + '<span class="spacer"></span>' +
      '<span class="faint">Effort</span><span class="pv-select">High</span>' +
      '<button class="btn btn--sm btn--quiet">Remove from menu</button></div>' +
      "</div>"
    );
  }

  /* ---------------------------------------------------------------- accounts */

  function accountsSection() {
    return (
      "<section>" +
      '<div class="pv-head"><div><h2>Accounts</h2><p>Who pays for the models. Hercule keeps each sign-in and hands it to the machines.</p></div><span class="spacer"></span>' +
      '<button class="btn btn--sm" data-sheet="add-account">' + icon("plus", 14) + "Add an account</button></div>" +
      "<div>" + W.ACCOUNTS.map(accountRow).join("") + "</div>" +
      "</section>"
    );
  }

  function accountRow(a) {
    var v = W.VENDORS[a.vendor];
    var r = P.reach(a);
    return (
      '<div class="va-acct' + (a.failed ? " is-fail" : "") + '">' +
      '<span class="pv-mk">' + mark(v.mark, 16) + "</span>" +
      '<span class="va-who"><b>' + W.accountName(a) + "</b><span>" + a.plan + " · " + P.methodWords(a) + "</span></span>" +
      '<span class="vd-use">' + P.usageCell(a) + "</span>" +
      '<span class="va-reach">' + P.note(r.text, r.tone) + (r.action ? '<button class="btn btn--sm" data-sheet="' + r.sheet + '">' + r.action + "</button>" : "") + "</span>" +
      '<button class="icon-btn" title="More">' + icon("more") + "</button>" +
      "</div>"
    );
  }

  /* ---------------------------------------------------------------- harnesses */

  function harnessSection() {
    return (
      "<section>" +
      '<div class="pv-head"><div><h2>Harnesses</h2><p>The agent programs on your machines. Hercule installs and updates them.</p></div></div>' +
      "<div>" + W.HARNESSES.map(harnessRow).join("") + "</div>" +
      '<div class="va-pref"><span class="set-label"><b>Open models run in</b><span>GLM, Kimi, Qwen and other models with no harness of their own, when you add them. Each can still change.</span></span><span class="pv-select">' + mark("pi", 12) + "pi</span></div>" +
      "</section>"
    );
  }

  function harnessRow(h) {
    var missing = W.ALL.filter(function (m) { return h.on.indexOf(m) === -1; });
    var reach = missing.length
      ? P.note("Not on " + missing.join(", "), "you") + '<button class="btn btn--sm">Install</button>'
      : P.note("Every machine");
    return (
      '<div class="va-harn">' +
      '<span class="pv-mk">' + mark(h.mark, 16) + "</span>" +
      '<span class="va-who"><b>' + h.name + ' <span class="faint" style="font-weight:400">' + h.version + "</span></b><span>" + h.about + "</span></span>" +
      '<span class="va-reach">' + reach + "</span>" +
      '<button class="icon-btn" title="More">' + icon("more") + "</button>" +
      "</div>"
    );
  }

  /** Wires the rows: a click on a model's row opens or closes its route. */
  function wire(body, rerender) {
    body.querySelectorAll("[data-toggle]").forEach(function (row) {
      row.addEventListener("click", function (ev) {
        if (ev.target.closest(".icon-btn")) return;
        var i = Number(row.dataset.toggle);
        open[i] = !open[i];
        rerender();
      });
    });
  }

  Pv.variants.a = { key: "a", name: "The menu", about: "Models first: the page is the composer's menu", render: render, wire: wire };
})();
