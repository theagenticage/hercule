// PROTOTYPE - Variant C, "The switchboard": one table. Models and the accounts that offer them go
// down; the four harnesses go across. Each tick is one entry in the composer's menu, and a dash
// is a route that cannot exist. Accounts sit above the table as tiles that say only their state.
(function () {
  var W = World, P = Pv, mark = Pv.mark, icon = Crew.icon;
  var FAMILIES = [
    ["Claude", "A Claude plan runs only in Claude Code"],
    ["GPT", ""],
    ["Open models", "GLM, Kimi, Qwen, DeepSeek, MiniMax"],
  ];

  function render() {
    if (!W.ACCOUNTS.length) return '<div class="set-col pv-col">' + P.empty() + "</div>";
    return '<div class="vc">' + tiles() + table() + "</div>";
  }

  function headerAction() {
    return W.ACCOUNTS.length ? '<button class="btn btn--sm" data-sheet="catalog">' + icon("plus", 14) + "Add a model</button>" : "";
  }

  /* ---------------------------------------------------------------- accounts as tiles */

  function tiles() {
    return (
      "<section>" +
      '<div class="pv-head"><div><h2>Accounts</h2><p>Who pays for the models, and whether every machine can use them.</p></div><span class="spacer"></span>' +
      '<button class="btn btn--sm" data-sheet="add-account">' + icon("plus", 14) + "Add an account</button></div>" +
      '<div class="vc-tiles">' +
      W.ACCOUNTS.map(function (a) {
        var r = P.reach(a);
        var v = W.VENDORS[a.vendor];
        var cls = r.tone === "fail" ? " is-fail" : r.tone === "you" ? " is-you" : "";
        return (
          '<button class="vc-tile' + cls + '"' + (r.sheet ? ' data-sheet="' + r.sheet + '"' : "") + ' title="' + a.plan + " · " + a.who + '">' +
          mark(v.mark, 18) + "<b>" + W.accountName(a) + "</b>" +
          "<span>" + tileLine(a, r) + "</span>" +
          '<span class="vc-use vd-use">' + P.usageCell(a) + "</span>" +
          "</button>"
        );
      }).join("") +
      "</div></section>"
    );
  }

  /** Returns a tile's one line: what needs doing, else how it signs in and how far it reaches. */
  function tileLine(a, r) {
    if (r.tone === "fail") return "Key refused · Replace";
    if (r.tone === "you" && r.sheet === "renew") return "Token ends in " + a.endsIn + " · Renew";
    if (r.tone === "you") return "Not on " + W.ALL.filter(function (m) { return a.signedIn.indexOf(m) === -1; }).join(", ") + " · Sign in";
    var how = { token: "Token", "per-machine": "Per machine", chatgpt: "Codex sign-in", "chatgpt-shared": "ChatGPT", key: "Key" }[a.method];
    return how + " · " + (a.reach === "fleet" ? "every machine" : "all " + W.ALL.length + " machines");
  }

  /* ---------------------------------------------------------------- the table */

  function table() {
    var head =
      '<span class="vc-th">Model</span><span class="vc-th">From</span>' +
      W.HARNESSES.map(function (h) {
        var missing = W.ALL.filter(function (m) { return h.on.indexOf(m) === -1; });
        return (
          '<span class="vc-th"><span class="vc-h">' + mark(h.mark, 13) + h.name + "</span>" +
          (missing.length ? '<small class="you-ink" title="Not installed on ' + missing.join(", ") + '">' + h.on.length + " of " + W.ALL.length + " machines</small>" : "<small>" + h.version + "</small>") +
          "</span>"
        );
      }).join("");
    var body = FAMILIES.map(function (f) {
      var inFamily = W.MODELS.filter(function (m) { return familyOf(m) === f[0] && !m.older; });
      var shown = inFamily.filter(function (m) { return inMenu(m); });
      var rest = inFamily.filter(function (m) { return !inMenu(m); });
      var olderCount = W.MODELS.filter(function (m) { return familyOf(m) === f[0] && m.older; }).length;
      return (
        '<span class="vc-fam">' + f[0] + (f[1] ? " <small>" + f[1] + "</small>" : "") + "</span>" +
        shown.map(modelRows).join("") +
        (rest.length ? alsoRow(rest, olderCount) : "")
      );
    }).join("");
    return (
      "<section>" +
      '<div class="pv-head"><div><h2>Routes</h2><p>Tick a route to put it in the composer\'s menu. ★ is the default for new threads.</p></div></div>' +
      '<div class="vc-table">' + head + body + "</div>" +
      '<div class="vc-legend"><span><i class="vc-box is-on">' + icon("check", 10) + "</i>In the menu</span><span><i class=\"vc-box\"></i>Possible</span><span><i class=\"vc-no\"></i>Cannot run there</span><span>The menu keeps its own order; drag it in the composer.</span></div>" +
      "</section>"
    );
  }

  function familyOf(m) {
    return m.family === "Claude" ? "Claude" : m.family === "GPT" ? "GPT" : "Open models";
  }
  function inMenu(m) {
    return W.MENU.some(function (e) { return e.model === m.id; });
  }

  /** Returns one row per account that offers the model; the model's name heads the first. */
  function modelRows(m) {
    var routes = W.routesOf(m);
    return routes.map(function (r, i) {
      var a = r.account, v = W.VENDORS[a.vendor];
      var failed = !!a.failed;
      var problem = null;
      var cells = W.HARNESSES.map(function (h) {
        if (r.harnesses.indexOf(h.id) === -1) return '<span class="vc-c' + (failed ? " vc-row-fail" : "") + '" title="' + (a.only || "") + '"><i class="vc-no"></i></span>';
        var e = W.MENU.filter(function (x) { return x.model === m.id && x.account === a.id && x.harness === h.id; })[0];
        if (e && !problem) problem = W.entryProblem(e);
        var cls = e ? (failed ? " is-fail" : " is-on") : "";
        return (
          '<span class="vc-c' + (failed ? " vc-row-fail" : "") + '"><button class="vc-box' + cls + '" title="' + (e ? "In the menu as " + W.entryName(e) : "Add " + m.name + " from " + W.accountName(a) + " in " + h.name) + '">' +
          (e ? icon("check", 11) : "") + (e && e.isDefault ? '<span class="vc-star" title="Default for new threads">★</span>' : "") + "</button></span>"
        );
      }).join("");
      var note = "";
      if (failed) note = '<span class="pv-note pv-note--fail">key refused</span>';
      else if (problem && problem.kind === "you") note = '<span class="pv-note pv-note--you" title="' + problem.why + '">' + problem.text.replace("Not on ", "not on ") + "</span>";
      else note = '<span class="pv-note">' + (a.plan === "Credits" ? "per token" : "plan") + "</span>";
      return (
        '<span class="vc-m' + (i ? " is-cont" : "") + (failed ? " vc-row-fail" : "") + '">' + (i ? "" : m.name) + "</span>" +
        '<span class="vc-a' + (failed ? " vc-row-fail" : "") + '">' + mark(v.mark, 13) + "<span>" + W.accountName(a) + "</span>" + note + "</span>" +
        cells
      );
    }).join("");
  }

  /** Returns the family's other models in one line, with the count of older ones. */
  function alsoRow(rest, olderCount) {
    var names = rest.map(function (m) { return m.name; }).join(", ");
    return (
      '<span class="vc-m vc-collapsed" style="grid-column: 1 / -1; color: var(--faint); font-weight: 400; font-size: var(--t-12)">' +
      '<button class="pv-link" data-sheet="catalog">Also: ' + names + (olderCount ? ", and " + olderCount + " older" : "") + "</button></span>"
    );
  }

  Pv.variants.c = { key: "c", name: "The switchboard", about: "One table: model and account down, harness across", render: render, headerAction: headerAction };
})();
