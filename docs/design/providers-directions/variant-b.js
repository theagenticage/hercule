// PROTOTYPE - Variant B, "The wallet": accounts first. One block per account says how it signs
// in and which machines it reaches, switches the harnesses it may run in, and lists its models
// in the menu. The composer's menu rides along in the right rail, so every change shows there.
(function () {
  var W = World, P = Pv, mark = Pv.mark, icon = Crew.icon;

  function render() {
    if (!W.ACCOUNTS.length) return '<div class="set-col pv-col">' + P.empty() + "</div>";
    return (
      '<div class="vb">' +
      '<div class="vb-main">' + W.ACCOUNTS.map(block).join("") + harnesses() + "</div>" +
      rail() +
      "</div>"
    );
  }

  function headerAction() {
    return W.ACCOUNTS.length ? '<button class="btn btn--sm" data-sheet="add-account">' + icon("plus", 14) + "Add an account</button>" : "";
  }

  /* ---------------------------------------------------------------- one account */

  function block(a) {
    var v = W.VENDORS[a.vendor];
    return (
      '<section class="vb-acct' + (a.failed ? " is-fail" : "") + '">' +
      '<div class="vb-top">' +
      '<span class="pv-mk pv-mk--lg">' + mark(v.mark, 20) + "</span>" +
      '<span class="vb-id"><b>' + W.accountName(a) + "</b><span>" + a.plan + " · " + a.who + "</span></span>" +
      '<span class="vb-use">' + usage(a) + "</span>" +
      '<button class="icon-btn" title="More">' + icon("more") + "</button>" +
      "</div>" +
      '<div class="vb-facts">' +
      '<small>Signed in with</small><div class="vb-fact">' + signIn(a) + "</div>" +
      '<small>Runs in</small><div class="vb-fact"><div class="vb-line">' + switches(a) + "</div>" + (a.only ? "<p>" + a.only + "</p>" : "") + "</div>" +
      '<small>In the menu</small><div class="vb-fact"><div class="vb-models">' + models(a) + "</div></div>" +
      "</div>" +
      "</section>"
    );
  }

  /** Returns the plan window or the credit left; a failed key shows why instead. */
  function usage(a) {
    if (a.failed) return '<span class="vb-use-top"><span class="fail-ink" style="font-weight:520">' + a.failed.what + '</span><span>' + a.failed.at + "</span></span>";
    if (a.balance) return '<span class="vb-use-top"><span><b>' + a.balance.replace(" left", "") + "</b> left</span><span>prepaid credits</span></span>";
    if (!a.usage) return a.noUsage ? '<span class="vb-use-top"><span class="faint">' + a.noUsage + "</span></span>" : "";
    return (
      '<span class="vb-use-top"><span><b>' + a.usage.pct + "%</b> of the " + a.usage.window + "</span><span>resets " + a.usage.resets + "</span></span>" +
      '<span class="meter"><i style="width:' + a.usage.pct + '%"></i></span>'
    );
  }

  /** Returns how the account signs in: one fleet credential, or one login per machine with each machine shown. */
  function signIn(a) {
    if (a.reach === "fleet") {
      var what = a.method === "token" ? "Long-lived token" : a.method === "chatgpt-shared" ? "ChatGPT sign-in" : "API key " + a.who.replace("key ", "");
      var line = '<div class="vb-line"><span class="vb-tab">' + icon(a.method === "chatgpt-shared" ? "user" : "key", 13) + what + '</span><span class="muted">every machine</span></div>';
      if (a.failed) {
        return line.replace('class="vb-tab"', 'class="vb-tab is-fail chip--fail"') + '<p class="fail-ink">' + a.failed.detail + '.</p><div class="vb-line"><button class="btn btn--sm" data-sheet="replace-key">Replace key</button><button class="btn btn--sm btn--quiet">Run GLM 5.3 from OpenCode Go instead</button></div>';
      }
      if (a.expiring) {
        return line + '<div class="vb-line"><span class="pv-note pv-note--you">Ends in ' + a.endsIn + ", on " + a.ends + '</span><button class="btn btn--sm" data-sheet="renew">Renew</button></div>';
      }
      if (a.method === "token") return line + "<p>Ends " + a.ends + ". Hercule reminds you a month before.</p>";
      if (a.method === "chatgpt-shared") return line + "<p>Hercule renews it every hour. A machine you add later needs one approval click.</p>";
      return line;
    }
    var tabs = W.MACHINES.map(function (m) {
      var on = a.signedIn.indexOf(m.id) !== -1;
      return on
        ? '<span class="vb-tab">' + icon("check", 12) + m.id + "</span>"
        : '<button class="vb-tab is-you" data-sheet="relay">' + m.id + " · Sign in</button>";
    }).join("");
    return '<div class="vb-line">' + tabs + "</div><p>Each machine keeps its own login, which renews itself.</p>";
  }

  /** Returns a switch per harness the account may run in. A harness is on while the account may be used in it. */
  function switches(a) {
    return W.HARNESSES.filter(function (h) { return a.harnesses.indexOf(h.id) !== -1; })
      .map(function (h) {
        var on = a.vendor !== "openrouter" || h.id !== "claude-code";
        return '<button class="vb-sw' + (on ? " is-on" : "") + '"><span class="vb-box">' + (on ? icon("check", 10) : "") + "</span>" + mark(h.mark, 12) + h.name + "</button>";
      }).join("");
  }

  /** Returns the account's entries in the menu, then a way to add more of its models. */
  function models(a) {
    var mine = W.MENU.filter(function (e) { return e.account === a.id; });
    var chips = mine.map(function (e) {
      var twinsHere = mine.filter(function (x) { return x.model === e.model; }).length > 1;
      var label = W.model(e.model).name + (twinsHere ? " <small>in " + W.harness(e.harness).name + "</small>" : "");
      return '<span class="vb-model' + (e.isDefault ? " is-default" : "") + '">' + label + (e.isDefault ? " <small>default</small>" : "") + "</span>";
    }).join("");
    var more = a.models - mine.length;
    return chips + '<button class="vb-model vb-model--add" data-sheet="' + (a.vendor === "openrouter" ? "catalog-openrouter" : "catalog") + '">' + icon("plus", 12) + (mine.length ? more + " more" : "Add from " + a.models + " models") + "</button>";
  }

  /* ---------------------------------------------------------------- harnesses */

  function harnesses() {
    return (
      '<div class="vb-harnesses"><h3>Harnesses</h3>' +
      W.HARNESSES.map(function (h) {
        var missing = W.ALL.filter(function (m) { return h.on.indexOf(m) === -1; });
        var end = missing.length
          ? '<span class="vb-line">' + P.note("Not on " + missing.join(", "), "you") + '<button class="btn btn--sm">Install</button></span>'
          : P.note("every machine");
        return '<div class="vb-hrow">' + mark(h.mark, 16) + "<span>" + h.name + ' <span class="ver">' + h.version + "</span></span>" + end + "</div>";
      }).join("") +
      "</div>"
    );
  }

  /* ---------------------------------------------------------------- the rail */

  function rail() {
    var picks = W.MENU.map(function (e) {
      var a = W.account(e.account), h = W.harness(e.harness), v = W.VENDORS[a.vendor];
      var p = W.entryProblem(e);
      var end = e.isDefault ? '<span class="pv-note">default</span>' : "";
      if (p) end = '<i class="dot ' + (p.kind === "fail" ? "dot--fail" : "dot--you") + '" title="' + p.text + '"></i>';
      return (
        '<div class="vb-pick">' +
        '<span class="va-grip">' + icon("grip", 12) + "</span>" +
        mark(v.mark, 14) +
        '<span class="vb-pick-t"><b>' + W.entryName(e) + "</b><small>" + (a.label || W.accountName(a)) + " · " + h.name + "</small></span>" +
        end +
        "</div>"
      );
    }).join("");
    return (
      '<aside class="vb-rail">' +
      '<div class="vb-rail-h"><b>Model menu</b><span>What the composer offers.</span></div>' +
      picks +
      '<div class="vb-rail-foot">' +
      '<button class="line" data-sheet="catalog">' + icon("plus", 14) + '<span class="grow"><b>Add models</b></span><span class="line-note">' + W.catalogCount() + "</span></button>" +
      '<div class="line">' + mark("pi", 14) + '<span class="grow">Open models run in <b>pi</b></span><span class="line-note">' + icon("chev-d", 12) + "</span></div>" +
      "</div>" +
      "</aside>"
    );
  }

  Pv.variants.b = { key: "b", name: "The wallet", about: "Accounts first, the menu in a rail", render: render, headerAction: headerAction };
})();
