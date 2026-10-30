// PROTOTYPE - small renderers more than one variant uses: the route line, an account's sign-in
// and reach in words, and the empty page. Each variant still owns its own layout.
(function () {
  var W = World;
  var mark = Pv.mark;

  /** Returns "from <account> in <harness>" as two marks with their names. */
  function routeLine(e, opts) {
    opts = opts || {};
    var a = W.account(e.account), h = W.harness(e.harness), v = W.VENDORS[a.vendor];
    return (
      '<span class="pv-route">' +
      (opts.noAccount ? "" : "<span>" + mark(v.mark, 12) + W.accountName(a) + "</span>" + '<span class="pv-in">in</span>') +
      "<span>" + mark(h.mark, 12) + h.name + "</span></span>"
    );
  }

  /** Returns how an account signs in, in a few words. */
  function methodWords(a) {
    return {
      token: "Long-lived token",
      "per-machine": "Signed in per machine",
      chatgpt: "ChatGPT, per machine",
      "chatgpt-shared": "ChatGPT sign-in",
      key: "API key",
    }[a.method];
  }

  /** Returns how a model is paid for through an account: by plan, or per token. */
  function payWords(a) {
    if (a.plan === "Credits") return "per token · " + a.balance;
    return a.plan;
  }

  /**
   * Returns an account's reach as a note, and the one action it needs, if any. Healthy accounts
   * get faint facts only; an account that needs the user gets marigold and a button; a failed
   * one gets tomato and a button.
   */
  function reach(a) {
    if (a.failed) {
      return { tone: "fail", text: "Key refused at " + a.failed.at, action: "Replace key", sheet: "replace-key" };
    }
    if (a.expiring) {
      return { tone: "you", text: "Token ends in " + a.endsIn, action: "Renew", sheet: "renew" };
    }
    if (a.reach === "fleet") {
      var extra = a.method === "token" ? " · until " + a.ends.replace(/^\d+ /, "") : "";
      return { tone: "", text: "Every machine" + extra };
    }
    var missing = W.ALL.filter(function (m) { return a.signedIn.indexOf(m) === -1; });
    if (!missing.length) return { tone: "", text: "Signed in on all " + W.ALL.length };
    return { tone: "you", text: a.signedIn.length + " of " + W.ALL.length + " machines", action: "Sign in on " + missing[0], sheet: "relay" };
  }

  /** Returns a note span in the reach's tone. */
  function note(text, tone) {
    return '<span class="pv-note' + (tone ? " pv-note--" + tone : "") + '">' + text + "</span>";
  }

  /** Returns an account's usage as B draws it: the plan window with its meter, the credit left, or why there is none. */
  function usageCell(a) {
    if (a.failed) return '<span class="vd-use-top"><span class="fail-ink">key refused</span></span>';
    if (a.balance) return '<span class="vd-use-top"><span><b>' + a.balance.replace(" left", "") + "</b> left</span><span>credits</span></span>";
    if (!a.usage) return '<span class="vd-use-top"><span class="faint">No usage shown for a token</span></span>';
    return (
      '<span class="vd-use-top"><span><b>' + a.usage.pct + "%</b> of " + a.usage.window.replace(" window", "").replace(" limit", "") + "</span><span>" + a.usage.resets + "</span></span>" +
      '<span class="meter"><i style="width:' + a.usage.pct + '%"></i></span>'
    );
  }

  /** Returns the empty page: no account yet, three ways in. */
  function empty() {
    return (
      '<div class="pv-empty">' +
      '<span class="pv-mk pv-mk--lg">' + Crew.icon("cpu", 20) + "</span>" +
      "<h2>No models yet</h2>" +
      "<p>Add an account that pays for models: a Claude or ChatGPT plan, or a key from OpenRouter, Z.ai or OpenCode. Hercule installs the harnesses on your machines itself.</p>" +
      '<div class="pv-starts">' +
      start("anthropic", "A Claude plan", "Pro, Max or Team. Sign in once; every machine can use it.", "add-anthropic") +
      start("openai", "A ChatGPT plan", "Plus or Pro. Runs in Codex, pi and OpenCode.", "add-openai") +
      start("key", "An API key", "OpenRouter, Z.ai, OpenCode Go, Anthropic or OpenAI. Works everywhere.", "add-account") +
      "</div>" +
      '<p class="pv-empty-foot">' + Crew.icon("shield", 14) + "Keys and tokens stay encrypted on the controller. Machines never store them.</p>" +
      "</div>"
    );
  }
  function start(m, title, about, sheet) {
    return (
      '<button class="pv-start" data-sheet="' + sheet + '">' +
      '<span class="pv-start-top">' + mark(m, 16) + "<b>" + title + "</b></span>" +
      "<small>" + about + "</small></button>"
    );
  }

  window.Pv.routeLine = routeLine;
  window.Pv.methodWords = methodWords;
  window.Pv.payWords = payWords;
  window.Pv.reach = reach;
  window.Pv.note = note;
  window.Pv.usageCell = usageCell;
  window.Pv.empty = empty;
  window.Pv.variants = {};
})();
