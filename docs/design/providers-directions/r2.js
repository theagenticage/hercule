// PROTOTYPE - round 2: the Wallet, and the pieces every round-2 variant draws with.
//
// A Wallet is a named set of accounts, at most one per vendor, with its own model menu:
//   - "Work" holds Anthropic · Work and OpenAI · Work, so a work project gets both at once.
//   - The menu belongs to the wallet, so Daybreak (only OpenAI · Work offers it) and Opus 4.8
//     (kept at work for one skill) show in Work's menu and nowhere else.
//   - Each project picks one wallet. The composer opens on it and can switch to another, which
//     is how the same model is picked from a different account.
//   - One account may sit in several wallets (OpenRouter here); each wallet picks its own models.
// The state lives in sessionStorage, so the settings page and composer.html agree.
(function () {
  var W = World, mark = Pv.mark, icon = Crew.icon;
  var KEY = "pv-r2-state-1";

  function initial() {
    return {
      wallets: [
        { id: "personal", name: "Personal", accounts: ["anthropic-personal", "openai-personal", "zai", "opencode-go", "openrouter"] },
        { id: "work", name: "Work", accounts: ["anthropic-work", "openai-work", "openrouter"] },
      ],
      projects: { webshop: "personal", "payments-api": "work", ops: "work", _new: "personal" },
      picks: {
        personal: {
          "anthropic-personal": ["opus-5-5", "fable-5-1", "sonnet-5-5", "haiku-5-5"],
          "openai-personal": ["gpt-6-1-sol", "gpt-6-luna"],
          zai: ["glm-5-3"],
          "opencode-go": ["kimi-k3"],
          openrouter: ["or-gemini-3-5-pro"],
        },
        work: {
          "anthropic-work": ["opus-5-5", "sonnet-5-5", "opus-4-8"],
          "openai-work": ["gpt-6-1-sol", "daybreak"],
          openrouter: ["glm-5-3"],
        },
      },
      defaults: { personal: ["anthropic-personal", "opus-5-5"], work: ["anthropic-work", "opus-5-5"] },
    };
  }

  function load() {
    try {
      var raw = sessionStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* storage may be refused over file://; start fresh */ }
    return initial();
  }
  var state = load();
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* see load */ } }
  function reset() { state = initial(); R.state = state; save(); }

  function wallet(id) { return state.wallets.filter(function (w) { return w.id === id; })[0]; }
  /** Returns the wallet a project pays from; new projects use the `_new` pick. */
  function walletOf(project) { return wallet(state.projects[project] || state.projects._new); }
  /** Returns the projects that pay from a wallet, "new projects" last when it is their default. */
  function projectsOf(walletId) {
    var out = W.PROJECTS.filter(function (p) { return state.projects[p.id] === walletId; }).map(function (p) { return p.id; });
    return { list: out, isNew: state.projects._new === walletId };
  }
  /** Returns the accounts of a wallet that exist in this moment of the world (none when empty). */
  function accountsIn(w) { return w.accounts.map(W.account).filter(Boolean); }
  function picksOf(walletId, accountId) {
    var p = state.picks[walletId] = state.picks[walletId] || {};
    return p[accountId] = p[accountId] || [];
  }
  /** Returns every model an account offers, newest first, older last. */
  function offersOf(accountId) {
    return W.CATALOG.filter(function (m) { return m.from.some(function (f) { return f[0] === accountId; }); })
      .sort(function (a, b) { return (a.older ? 1 : 0) - (b.older ? 1 : 0); });
  }
  /** Returns the other wallets an account sits in. */
  function sharedWith(accountId, walletId) {
    return state.wallets.filter(function (w) { return w.id !== walletId && w.accounts.indexOf(accountId) !== -1; });
  }
  function toggle(walletId, accountId, modelId) {
    var l = picksOf(walletId, accountId);
    var i = l.indexOf(modelId);
    if (i === -1) l.push(modelId);
    else l.splice(i, 1);
    save();
  }
  function isDefault(walletId, accountId, modelId) {
    var d = state.defaults[walletId];
    return d && d[0] === accountId && d[1] === modelId;
  }
  function setDefault(walletId, accountId, modelId) { state.defaults[walletId] = [accountId, modelId]; save(); }
  function moveProject(project, walletId) { state.projects[project] = walletId; save(); }
  function count(w) {
    return accountsIn(w).reduce(function (n, a) { return n + picksOf(w.id, a.id).length; }, 0);
  }

  /* ------------------------------------------------------------------ pieces */

  /** Returns a wallet's monogram: its initial in the Deco face, in a brass ring. */
  function monogram(w, size) {
    return '<span class="mono' + (size ? " mono--" + size : "") + '" aria-hidden="true">' + w.name.charAt(0) + "</span>";
  }

  /**
   * Returns one pip per machine: filled where the account works, a marigold ring where it waits
   * for a sign-in, tomato where it failed. The title names them.
   */
  function pips(a) {
    var on = W.accountMachines(a);
    var title = a.failed ? a.failed.what : W.ALL.map(function (m) { return m + (on.indexOf(m) !== -1 ? ": ready" : ": not signed in"); }).join(" · ");
    return '<span class="pips" title="' + title + '">' + icon("fleet", 11) + W.ALL.map(function (m) {
      var cls = a.failed ? " is-fail" : on.indexOf(m) === -1 ? " is-you" : "";
      return '<i class="pip' + cls + '"></i>';
    }).join("") + "</span>";
  }

  /** Returns the plan window as a short meter and a number; credit as an amount; a token as a dash. */
  function gauge(a) {
    if (a.failed) return "";
    if (a.balance) return '<span class="gauge"><b>' + a.balance.replace(" left", "") + "</b></span>";
    if (!a.usage) return '<span class="gauge gauge--none" title="A long-lived token cannot read the plan\'s usage">no usage</span>';
    var hot = a.usage.pct >= 80;
    return '<span class="gauge' + (hot ? " gauge--hot" : "") + '" title="' + a.usage.pct + "% of the " + a.usage.window + ", resets " + a.usage.resets + '"><i class="gauge-bar"><i style="width:' + a.usage.pct + '%"></i></i><b>' + a.usage.pct + "%</b></span>";
  }

  /** Returns what an account needs from the user, or null. */
  function need(a) {
    var r = Pv.reach(a);
    return r.tone ? r : null;
  }

  /**
   * Returns the composer's model menu for a wallet as HTML: wallet tabs when there are several,
   * one section per account with its usage, its picked models, a check on the current one.
   */
  function menuHTML(walletId, opts) {
    opts = opts || {};
    var w = wallet(walletId);
    var q = (opts.query || "").trim().toLowerCase();
    var html = "";
    if (state.wallets.length > 1 && !opts.noTabs) {
      html += '<div class="mw-tabs" role="tablist">' + state.wallets.map(function (x) {
        var home = opts.project && walletOf(opts.project).id === x.id;
        return '<button role="tab" data-mw-tab="' + x.id + '" aria-selected="' + (x.id === walletId) + '">' + monogram(x, "sm") + x.name + (home ? '<i class="mw-home" title="This project\'s wallet"></i>' : "") + "</button>";
      }).join("") + "</div>";
    }
    var any = false;
    accountsIn(w).forEach(function (a) {
      var rows = picksOf(w.id, a.id).map(W.catalogModel).filter(Boolean).filter(function (m) { return Pv.D.matches(m, q); });
      if (!rows.length) return;
      any = true;
      var v = W.VENDORS[a.vendor];
      html +=
        '<div class="mw-sec' + (opts.hot === a.id ? " is-hot" : "") + '" data-mw-acct="' + a.id + '">' +
        '<div class="mw-sh">' + mark(v.mark, 12) + "<span>" + W.accountName(a) + "</span>" + gauge(a) + "</div>" +
        rows.map(function (m) {
          var cur = opts.current ? opts.current[0] === a.id && opts.current[1] === m.id : isDefault(w.id, a.id, m.id);
          return '<button class="mw-row' + (cur ? " is-cur" : "") + (a.failed ? " is-dim" : "") + '"><b>' + m.name + "</b>" + (m.older ? '<small>older</small>' : "") + '<span class="mw-ok">' + (cur ? icon("check", 14) : "") + "</span></button>";
        }).join("") +
        "</div>";
    });
    if (!any) html += '<p class="md-none">' + (q ? "No model in " + w.name + " matches." : "Nothing picked yet.") + "</p>";
    return html;
  }

  var R = {
    groups: function () { return state.wallets; }, noun: "Wallets", avatar: monogram,
    state: state, save: save, reset: reset,
    wallet: wallet, walletOf: walletOf, projectsOf: projectsOf, accountsIn: accountsIn,
    picksOf: picksOf, offersOf: offersOf, sharedWith: sharedWith, toggle: toggle,
    isDefault: isDefault, setDefault: setDefault, moveProject: moveProject, count: count,
    monogram: monogram, pips: pips, gauge: gauge, need: need, menuHTML: menuHTML,
  };
  window.Pv.R = R;
})();
