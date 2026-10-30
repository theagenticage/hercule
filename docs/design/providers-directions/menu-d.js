// PROTOTYPE - variant D's state and the composer's model menu it produces. Shared by the
// settings page (its preview rail) and composer.html, so both draw the very same menu. The
// state lives in sessionStorage, so a change in Settings shows when the composer page opens.
//
// D's model:
//   - Per vendor, the models you want to see: "from Anthropic: Opus, Fable, Sonnet, Haiku".
//     Every account of that vendor shows them, unless that account has its own list.
//   - Per project, which account of a vendor pays (only where a vendor has two or more).
//   - Per vendor, the harness a model runs in by default; the composer can switch it.
(function () {
  var W = World, mark = Pv.mark, icon = Crew.icon;
  var KEY = "pv-d-state-2";

  function initial() {
    return {
      shown: {
        anthropic: ["opus-5-5", "fable-5-1", "sonnet-5-5", "haiku-5-5"],
        openai: ["gpt-6-1-sol", "gpt-6-luna"],
        zai: ["glm-5-3"],
        opencode: ["glm-5-3", "kimi-k3"],
        openrouter: ["or-gemini-3-5-pro"],
      },
      perAccount: {},
      projects: {
        webshop: { anthropic: "anthropic-personal" },
        "payments-api": { anthropic: "anthropic-work", openai: "openai-work" },
        ops: { anthropic: "anthropic-work", openai: "openai-work" },
        _new: { anthropic: "anthropic-personal", openai: "openai-personal" },
      },
      harness: { anthropic: "claude-code", openai: "codex", zai: "pi", opencode: "opencode", openrouter: "pi" },
      defaultModel: { vendor: "anthropic", model: "opus-5-5" },
    };
  }

  function load() {
    try {
      var raw = sessionStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* a file:// page may refuse storage; the prototype then starts fresh */ }
    return initial();
  }

  var state = load();

  function save() {
    try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* see load */ }
  }

  function reset() {
    state = initial();
    Pv.D.state = state;
    save();
  }

  /** Returns the account a project pays with for a vendor: its own pick, else the vendor's only account. */
  function accountFor(project, vendor) {
    var accounts = W.accountsOf(vendor);
    if (accounts.length === 1) return accounts[0].id;
    var picks = state.projects[project] || state.projects._new;
    return (picks && picks[vendor]) || accounts[0].id;
  }

  /** Returns the models an account shows: its own list when it has one, else its vendor's. */
  function shownFor(accountId) {
    var a = W.account(accountId);
    return state.perAccount[accountId] || state.shown[a.vendor] || [];
  }

  /** Returns the projects that pay with an account. */
  function projectsUsing(accountId) {
    var a = W.account(accountId);
    if (W.accountsOf(a.vendor).length < 2) return null;
    var out = W.PROJECTS.filter(function (p) { return accountFor(p.id, a.vendor) === accountId; }).map(function (p) { return p.id; });
    return out;
  }

  function matches(m, q) {
    if (!q) return true;
    var hay = (m.name + " " + m.slug + " " + m.family).toLowerCase();
    return q.split(/\s+/).every(function (t) { return hay.indexOf(t) !== -1; });
  }

  /**
   * Returns the menu for a draft thread in a project: one group per vendor, from the account the
   * project pays with, then every other account folded into one row. A query filters both, and
   * adds the matching models no account shows yet.
   */
  function buildMenu(project, query) {
    var q = (query || "").trim().toLowerCase();
    var groups = W.vendorsInUse().map(function (v) {
      var accountId = accountFor(project, v);
      var a = W.account(accountId);
      var rows = shownFor(accountId).map(W.catalogModel).filter(Boolean).filter(function (m) { return matches(m, q); });
      return { vendor: v, account: a, harness: W.harness(state.harness[v]), rows: rows };
    }).filter(function (g) { return g.rows.length || !q; });
    var chosen = groups.map(function (g) { return g.account.id; });
    var others = W.ACCOUNTS.filter(function (a) { return chosen.indexOf(a.id) === -1; }).map(function (a) {
      var rows = shownFor(a.id).map(W.catalogModel).filter(Boolean);
      return { account: a, rows: rows.filter(function (m) { return matches(m, q); }), count: rows.length };
    }).filter(function (o) { return !q || o.rows.length; });
    var extra = [];
    if (q) {
      W.vendorsInUse().forEach(function (v) {
        var shown = state.shown[v] || [];
        W.modelsOf(v).forEach(function (m) {
          if (shown.indexOf(m.id) === -1 && matches(m, q) && extra.length < 6) extra.push({ model: m, vendor: v, account: W.account(accountFor(project, v)) });
        });
      });
    }
    var def = state.defaultModel;
    return { groups: groups, others: others, extra: extra, current: { account: accountFor(project, def.vendor), model: def.model } };
  }

  /**
   * Returns the menu as HTML, in the composer's own look. `opts.open` names the other accounts
   * that are unfolded; `opts.machine` dims accounts that are not signed in there.
   */
  function renderMenu(menu, opts) {
    opts = opts || {};
    var html = "";
    menu.groups.forEach(function (g) {
      var v = W.VENDORS[g.vendor];
      html +=
        '<div class="md-gh">' + mark(v.mark, 12) + "<span>" + W.accountName(g.account) + "</span>" +
        (g.account.failed ? '<span class="md-gh-r fail-ink">key refused</span>' : '<span class="md-gh-r">' + g.harness.name + "</span>") + "</div>";
      html += g.rows.map(function (m) {
        var isCurrent = g.account.id === menu.current.account && m.id === menu.current.model;
        var dim = g.account.failed || (opts.machine && W.accountMachines(g.account).indexOf(opts.machine) === -1);
        return '<button class="md-row' + (isCurrent ? " is-hot" : "") + (dim ? " is-dim" : "") + '"><b>' + m.name + "</b>" +
          '<span class="md-ok">' + (isCurrent ? icon("check", 14) : "") + "</span></button>";
      }).join("");
    });
    if (menu.others.length) {
      html += '<div class="md-sep"></div><div class="md-gh md-gh--other"><span>Other accounts</span></div>';
      html += menu.others.map(function (o) {
        var v = W.VENDORS[o.account.vendor];
        var open = opts.open && opts.open[o.account.id];
        var rows = open || opts.query ? o.rows.map(function (m) {
          return '<button class="md-row md-row--in"><b>' + m.name + "</b><span class=\"md-ok\"></span></button>";
        }).join("") : "";
        return (
          '<button class="md-acct' + (open ? " is-open" : "") + '" data-other="' + o.account.id + '">' + mark(v.mark, 14) +
          "<b>" + W.accountName(o.account) + '</b><span class="md-n">' + o.count + " model" + (o.count === 1 ? "" : "s") + "</span>" +
          '<span class="md-chev">' + icon("chev-r", 12) + "</span></button>" + rows
        );
      }).join("");
    }
    if (menu.extra.length) {
      html += '<div class="md-sep"></div><div class="md-gh md-gh--other"><span>Not in your menu yet</span></div>';
      html += menu.extra.map(function (x) {
        return '<div class="md-row md-row--x"><b>' + x.model.name + "<small>" + W.accountName(x.account) + "</small></b>" +
          '<span class="md-use">Use once</span><button class="md-add" title="Add to the menu">' + icon("plus", 13) + "</button></div>";
      }).join("");
    }
    if (!menu.groups.length && !menu.others.length && !menu.extra.length) {
      html += '<p class="md-none">No model matches.</p>';
    }
    return html;
  }

  window.Pv.D = {
    state: state, save: save, reset: reset,
    accountFor: accountFor, shownFor: shownFor, projectsUsing: projectsUsing,
    buildMenu: buildMenu, renderMenu: renderMenu, matches: matches,
  };
})();
