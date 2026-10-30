// PROTOTYPE - round 2's sheets: the account sheet (everything about one account that the rows
// leave out) and the catalog opened for one wallet, whose switches are that wallet's accounts.
(function () {
  var W = World, R = Pv.R, mark = Pv.mark, icon = Crew.icon;
  var host;

  function close() { if (host) host.innerHTML = ""; }

  function bar(label, pct, resets) {
    var hot = pct >= 80;
    return (
      '<div class="as-use"><span>' + label + '</span><span class="as-bar' + (hot ? " is-hot" : "") + '"><i style="width:' + pct + '%"></i></span><b>' + pct + "%</b><small>resets " + resets + "</small></div>"
    );
  }

  /**
   * Opens one account: its usage windows, each machine and whether it is ready there, how it
   * signs in, the harness its models run in, and the wallets it pays for.
   */
  Pv.openAccount = function (accountId, walletId, store) {
    // Round 2 groups accounts in wallets, round 3 in profiles; `store` says which.
    store = store || R;
    var a = W.account(accountId);
    var v = W.VENDORS[a.vendor];
    var on = W.accountMachines(a);
    var usage = a.failed
      ? '<p class="fail-ink">' + a.failed.what + " at " + a.failed.at + ": " + a.failed.detail + '.</p>'
      : a.balance
      ? '<div class="as-use"><span>Credits</span><b class="as-big">' + a.balance + "</b></div>"
      : a.usage
      ? bar(a.usage.window.replace(" window", "").replace(" limit", "").replace(/^./, function (ch) { return ch.toUpperCase(); }), a.usage.pct, a.usage.resets) + (a.weekly ? bar("Weekly", a.weekly.pct, a.weekly.resets) : "")
      : '<p class="faint">A long-lived token can only run models, so Anthropic does not tell Hercule how much of the plan is used. A login per machine would show it.</p>';
    var machines = W.MACHINES.map(function (m) {
      var ok = on.indexOf(m.id) !== -1 && !a.failed;
      return (
        '<div class="as-m">' + Crew.icon(m.kind, 14) + "<span>" + m.id + (m.note === "this Mac" ? ' <small>this Mac</small>' : "") + "</span>" +
        '<span class="as-st' + (ok ? "" : a.failed ? " fail-ink" : " you-ink") + '"><i class="pip' + (ok ? "" : a.failed ? " is-fail" : " is-you") + '"></i>' + (ok ? "Ready" : a.failed ? "Key refused" : "Not signed in") + "</span>" +
        (ok || a.failed ? "<span></span>" : '<button class="btn btn--sm" data-sheet="relay">Sign in</button>') +
        "</div>"
      );
    }).join("");
    var how = {
      token: "Long-lived token, made " + a.made + ", ends " + a.ends + ". Hercule keeps it and hands it to each machine while a session runs.",
      "per-machine": "Each machine keeps its own login and renews it. Logins end now and then; that machine then needs you again.",
      "chatgpt-shared": "Signed in with ChatGPT once. Hercule renews the sign-in every hour and hands each machine a fresh pass.",
      chatgpt: "Codex's own login on each machine.",
      key: "API key " + a.who.replace("key ", "") + ". Hercule keeps it and hands it to each machine while a session runs.",
    }[a.method];
    var switchTo = a.method === "per-machine" ? '<button class="pv-link" data-sheet="add-anthropic">Switch to a long-lived token</button>' : a.method === "token" ? '<button class="pv-link" data-sheet="renew">Renew now</button>' : a.method === "key" ? '<button class="pv-link" data-sheet="replace-key">Replace the key</button>' : "";
    var harnesses = W.HARNESSES.filter(function (h) { return a.harnesses.indexOf(h.id) !== -1; });
    var runs = harnesses.length > 1
      ? '<select class="vd-select">' + harnesses.map(function (h) { return "<option>" + h.name + "</option>"; }).join("") + "</select><span class=\"faint\">by default; a thread can switch</span>"
      : "<span>" + harnesses[0].name + '</span><span class="faint">' + (a.only || "") + "</span>";
    var wallets = store.groups().map(function (w) {
      var inIt = w.accounts.indexOf(a.id) !== -1;
      var rival = store.oneVendor === false ? null : !inIt && store.accountsIn(w).filter(function (x) { return x.vendor === a.vendor; })[0];
      return (
        '<label class="as-w' + (rival ? " is-off" : "") + '" title="' + (rival ? w.name + " already pays with " + W.accountName(rival) + "; it holds one account per vendor" : "") + '">' +
        '<span class="choice-box"><input type="checkbox" data-member="' + w.id + '"' + (inIt ? " checked" : "") + (rival ? " disabled" : "") + " />" + icon("check", 10) + "</span>" +
        store.avatar(w, "sm") + "<b>" + w.name + "</b>" +
        '<small>' + (inIt ? store.picksOf(w.id, a.id).length + (store.picksOf(w.id, a.id).length === 1 ? " model" : " models") + " in its menu" : rival ? "pays with " + W.accountName(rival) : "not in it") + "</small></label>"
      );
    }).join("");
    if (!host) { host = document.createElement("div"); document.body.appendChild(host); }
    host.innerHTML =
      '<div class="ov-scrim" data-as-scrim><div class="ov pop as" role="dialog" aria-label="' + W.accountName(a) + '">' +
      '<div class="ov-h"><span class="pv-mk">' + mark(v.mark, 16) + '</span><span class="as-t"><h2>' + W.accountName(a) + "</h2><small>" + a.plan + (a.who.indexOf("@") !== -1 ? " · " + a.who : "") + '</small></span><button class="icon-btn" data-as-close title="Close">' + icon("close") + "</button></div>" +
      '<div class="ov-b">' +
      '<div class="as-sec"><h3>Usage</h3>' + usage + "</div>" +
      '<div class="as-sec"><h3>Machines</h3>' + machines + "</div>" +
      '<div class="as-sec"><h3>Sign-in</h3><p>' + how + " " + switchTo + "</p></div>" +
      (store.canRun
        ? '<div class="as-sec"><h3>Default harness</h3>' + store.canRun(a).map(function (c) {
            var h = c.harness;
            var on = c.ok && store.accountDefault(a).id === h.id;
            var note = c.ok ? store.suggestedReason(a, h) : c.why;
            return c.ok
              ? '<button class="as-h' + (on ? " is-on" : "") + '" data-acct-default="' + h.id + '"><span class="vi-radio' + (on ? " is-on" : "") + '"></span>' + Pv.mark(h.mark, 13) + "<b>" + h.name + "</b><small>" + note + "</small></button>"
              : '<div class="as-h is-off"><span class="vi-radio"></span>' + Pv.mark(h.mark, 13) + "<b>" + h.name + "</b><small>" + note + "</small></div>";
          }).join("") + '<p class="as-hint">Every profile runs this account\'s models here, unless the account\'s line in a profile picks another.</p></div>'
        : '<div class="as-sec"><h3>Runs in</h3><p class="as-runs">' + runs + "</p></div>") +
      '<div class="as-sec"><h3>' + store.noun + "</h3>" + wallets + "</div>" +
      "</div>" +
      '<div class="ov-f"><button class="btn btn--quiet btn--danger">Remove account</button><span class="spacer"></span><button class="btn" data-as-close>Done</button></div>' +
      "</div></div>";
    host.querySelectorAll("[data-as-close]").forEach(function (b) { b.addEventListener("click", close); });
    // In round 3 the default harness is a choice here, and the page follows it.
    if (store.setAccountDefault) {
      host.querySelectorAll("[data-acct-default]").forEach(function (el) {
        el.addEventListener("click", function () {
          store.setAccountDefault(a.id, el.dataset.acctDefault);
          if (Pv.rerender) Pv.rerender();
          Pv.openAccount(accountId, walletId, store);
        });
      });
    }
    // In round 3 the boxes work: an account joins or leaves a profile, and the page follows.
    if (store.toggleMember) {
      host.querySelectorAll("[data-member]").forEach(function (el) {
        el.addEventListener("change", function () {
          store.toggleMember(el.dataset.member, a.id);
          if (Pv.rerender) Pv.rerender();
          Pv.openAccount(accountId, walletId, store);
        });
      });
    }
    host.querySelector("[data-as-scrim]").addEventListener("click", function (e) { if (e.target === e.currentTarget) close(); });
    host.querySelectorAll("[data-sheet]").forEach(function (b) {
      b.addEventListener("click", function () { close(); Pv.openSheet(b.dataset.sheet); });
    });
  };
  Pv.closeAccount = close;

  /** Opens the catalog for one wallet: its accounts are the switches on each row. */
  Pv.openWalletCatalog = function (walletId, accountId, rerender) {
    var w = R.wallet(walletId);
    var sources = R.accountsIn(w).map(function (a) {
      return {
        id: a.id, short: a.label && W.accountsOf(a.vendor).length > 1 ? W.accountName(a) : (a.name || W.VENDORS[a.vendor].name),
        mark: W.VENDORS[a.vendor].mark,
        offers: function (m) { return m.from.some(function (f) { return f[0] === a.id; }); },
      };
    });
    var selected = {};
    sources.forEach(function (s) { selected[s.id] = R.picksOf(w.id, s.id).slice(); });
    Pv.openCatalog({
      sources: sources, selected: selected, vendor: accountId || null, noun: "account",
      title: "Add models to " + w.name, sub: "What " + w.name + "'s accounts offer", monogram: R.monogram(w),
      write: function (sel) { Object.keys(sel).forEach(function (id) { R.state.picks[w.id][id] = sel[id].slice(); }); R.save(); },
      onSave: rerender,
    });
  };
})();
