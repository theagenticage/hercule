// PROTOTYPE - the sheets every variant opens: adding an account (who pays, how it signs in, the
// browser step, what goes in the menu), signing in on one more machine, renewing a token,
// replacing a refused key, and the catalog of every model the accounts offer.
// Pv.openSheet(name) draws one over the window; Escape or the scrim closes it.
(function () {
  var W = World, P = Pv, mark = Pv.mark, icon = Crew.icon;
  var host;

  function frame(opts, body, foot) {
    return (
      '<div class="ov-scrim" data-close>' +
      '<div class="ov pop' + (opts.wide ? " ov--wide" : "") + '" role="dialog" aria-label="' + opts.title + '">' +
      '<div class="ov-h">' + (opts.mark ? '<span class="pv-mk">' + mark(opts.mark, 16) + "</span>" : "") +
      "<h2>" + opts.title + "</h2>" + (opts.step ? '<span class="ov-step">' + opts.step + "</span>" : "") +
      '<button class="icon-btn" data-close title="Close">' + icon("close") + "</button></div>" +
      body +
      (foot ? '<div class="ov-f">' + foot + "</div>" : "") +
      "</div></div>"
    );
  }

  /* ---------------------------------------------------------------- add an account */

  function addAccount() {
    var groups = [
      ["Plans", ["anthropic", "openai"]],
      ["Keys and credits", ["openrouter", "zai", "opencode"]],
      ["Your own cloud or server", ["bedrock", "vertex", "local"]],
    ];
    var body = '<div class="ov-b"><p>Who pays for the models? You can add several accounts of one vendor, such as a personal and a work plan.</p>' +
      groups.map(function (g) {
        return '<div class="ov-group">' + g[0].toUpperCase() + '</div><div class="ov-vendors">' +
          g[1].map(function (id) {
            var v = W.VENDORS[id];
            var target = id === "anthropic" ? "add-anthropic" : id === "openai" ? "add-openai" : "";
            return '<button class="ov-vendor"' + (target ? ' data-sheet="' + target + '"' : "") + '><span class="pv-mk">' + mark(v.mark, 16) + "</span><span><b>" + v.name + "</b><small>" + v.offers + '</small></span><span class="chev">' + icon("chev-r", 14) + "</span></button>";
          }).join("") + "</div>";
      }).join("") + "</div>";
    var foot = '<span class="note">' + icon("shield", 13) + " Keys and tokens stay encrypted on the controller.</span><span class=\"spacer\"></span><button class=\"btn\" data-close>Cancel</button>";
    return frame({ title: "Add an account", step: "1 of 3" }, body, foot);
  }

  /** The method step: each way to sign in, with what it means for the machines under it. */
  function methods(vendorId) {
    var v = W.VENDORS[vendorId];
    var suggested = W.ACCOUNTS.some(function (a) { return a.vendor === vendorId; }) ? "Work" : "Personal";
    var body = '<div class="ov-b"><p>How should Hercule sign in to ' + v.name + "?</p>" +
      '<div class="ov-methods">' +
      v.methods.map(function (m, i) {
        var reach = m.reach === "fleet"
          ? icon("fleet", 13) + "Signs in every machine at once, and each machine you add later"
          : icon("laptop", 13) + "You sign in on each of your " + W.ALL.length + " machines";
        return (
          '<button class="ov-method' + (i === 0 ? " is-on" : "") + '"><span class="va-dot"></span>' +
          '<span class="ov-method-t"><b>' + m.name + "</b>" + (m.tag ? '<span class="chip pv-chip-default">' + m.tag + "</span>" : "") + "</span>" +
          "<p>" + m.about + "</p>" +
          '<span class="ov-reach">' + reach + "</span></button>"
        );
      }).join("") +
      "</div>" +
      '<div class="ov-field"><label>Name</label><input class="field ov-input" value="' + suggested + '" /><small>Shown after the vendor, as in ' + v.name + " · " + suggested + ". It tells your accounts apart in menus.</small></div>" +
      "</div>";
    var foot = '<button class="btn btn--quiet" data-sheet="add-account">Back</button><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn btn--accent" data-sheet="browser">Continue in the browser' + icon("external", 13) + "</button>";
    return frame({ title: "Add " + v.name, step: "2 of 3", mark: v.mark }, body, foot);
  }

  /** The browser step for a long-lived token: Anthropic's own sign-in runs on this Mac, and its code comes back here. */
  function browser() {
    var body =
      '<div class="ov-b"><div class="ov-wait">' +
      '<span class="ov-status"><i class="ov-spin"></i>Waiting for the code</span>' +
      "<p>Your browser opened Claude's sign-in. Sign in as the account you want to add, approve Claude Code, then paste the code it shows.</p>" +
      '<span class="ov-url">' + icon("globe", 13) + 'claude.ai/oauth/authorize · <button class="pv-link">Open again</button></span>' +
      "</div>" +
      '<div class="ov-field"><label>Code</label><input class="field ov-input" placeholder="Paste the code from the browser" /></div>' +
      '<div class="ov-tip">' + icon("shield", 14) + "<span><b>Nothing to install.</b> studio-mac runs Claude Code's own <code>setup-token</code> sign-in. The token it returns goes straight to the controller, encrypted, and reaches each machine only while a session runs there.</span></div>" +
      "</div>";
    var foot = '<button class="btn btn--quiet" data-sheet="add-anthropic">Back</button><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn btn--accent" data-sheet="added">Continue</button>';
    return frame({ title: "Add Anthropic", step: "3 of 3", mark: "anthropic" }, body, foot);
  }

  /** The end: the account is ready; its newest models are offered for the menu, the older ones are not. */
  function added() {
    var picks = [["Opus 5.5", "Most capable", true], ["Sonnet 5.5", "Everyday", true], ["Haiku 5.5", "Fast and cheap", false], ["Fable 5.1", "Long writing", false]];
    var body =
      '<div class="ov-b">' +
      '<div class="ov-done"><span class="pv-mk pv-mk--lg">' + mark("anthropic", 20) + "</span><span><b>Anthropic · Personal is ready</b><span>Long-lived token · every machine · until 28 Oct 2027</span></span></div>" +
      '<p style="margin:0 0 8px;color:var(--ink);font-weight:520">Put these in your model menu</p>' +
      '<div class="ov-picks">' +
      picks.map(function (p) {
        return '<label class="ov-pick"><span class="choice-box"><input type="checkbox"' + (p[2] ? " checked" : "") + " />" + icon("check", 10) + "</span><span><b>" + p[0] + "</b> <small>" + p[1] + "</small></span>" + '<span class="pv-route">' + mark("claude", 12) + "Claude Code</span></label>";
      }).join("") +
      "</div>" +
      '<p class="ov-pick-more">10 older Claude models stay out of the menu. Find them under Add models.</p>' +
      "</div>";
    var foot = '<span class="spacer"></span><button class="btn btn--accent" data-close>Add 2 models and finish</button>';
    return frame({ title: "Add Anthropic", step: "Done", mark: "anthropic" }, body, foot);
  }

  /* ---------------------------------------------------------------- one more machine */

  function relay() {
    var body =
      '<div class="ov-b">' +
      "<p>build-box-2 started Claude's sign-in for <b style=\"color:var(--ink);font-weight:520\">rogier@acme.com</b>. Open it here, approve, and paste the code back. build-box-2 keeps the login and renews it itself.</p>" +
      '<div class="ov-wait" style="padding-top:0"><button class="btn">' + icon("external", 14) + 'Open Claude\'s sign-in</button><span class="ov-status"><i class="ov-spin"></i>Waiting for the code</span></div>' +
      '<div class="ov-field"><label>Code</label><input class="field ov-input" placeholder="Paste the code from the browser" /></div>' +
      '<div class="ov-tip">' + icon("key", 14) + '<span><b>Signing in machine by machine?</b> A long-lived token signs in every machine at once, including the ones you add later, and lasts a year. <button class="pv-link" data-sheet="add-anthropic">Switch Work to a token</button></span></div>' +
      "</div>";
    var foot = '<span class="note">studio-mac and build-box-1 are already signed in.</span><span class="spacer"></span><button class="btn" data-close>Cancel</button>';
    return frame({ title: "Sign in to Anthropic · Work on build-box-2", mark: "anthropic" }, body, foot);
  }

  /** The device-code variant, for a ChatGPT sign-in on a machine: a code to type at OpenAI. */
  function relayOpenAI() {
    var code = "KQ7M-XW4T".split("");
    var body =
      '<div class="ov-b"><div class="ov-wait">' +
      "<p>build-box-2 asked OpenAI for a sign-in. Enter this code at OpenAI, as rogier@fastmail.com.</p>" +
      '<div class="ov-code">' + code.map(function (c) { return c === "-" ? "<i></i>" : "<span>" + c + "</span>"; }).join("") + "</div>" +
      '<span class="ov-url">' + icon("globe", 13) + 'auth.openai.com/codex/device · <button class="pv-link">Copy the code and open</button></span>' +
      '<span class="ov-status" style="margin-top:6px"><i class="ov-spin"></i>Waiting for you to approve · the code works for 14 more minutes</span>' +
      "</div></div>";
    var foot = '<span class="note">build-box-2 keeps the login and renews it itself.</span><span class="spacer"></span><button class="btn" data-close>Cancel</button>';
    return frame({ title: "Sign in to OpenAI · Personal on build-box-2", mark: "openai" }, body, foot);
  }

  function renew() {
    var body =
      '<div class="ov-b"><p>The long-lived token of Anthropic · Personal ends on 9 Nov. Sign in again for a new one: every machine switches to it at once, and running sessions keep going.</p>' +
      '<div class="ov-tip">' + icon("clock", 14) + "<span><b>Why it ends.</b> Anthropic makes these tokens for a year. Hercule cannot extend one; it can only ask you a month before, which is now.</span></div></div>";
    var foot = '<span class="spacer"></span><button class="btn" data-close>Later</button><button class="btn btn--accent" data-sheet="browser">Renew in the browser' + icon("external", 13) + "</button>";
    return frame({ title: "Renew Anthropic · Personal", mark: "anthropic" }, body, foot);
  }

  function replaceKey() {
    var body =
      '<div class="ov-b"><p>Z.ai refused the key ending ····7c2e at 09:14 today: <span class="fail-ink">401 Unauthorized, token expired or incorrect.</span> GLM 5.3 cannot start until a key works.</p>' +
      '<div class="ov-field" style="margin-top:4px"><label>New key</label><input class="field ov-input" type="password" placeholder="Paste a key from z.ai, under API keys" /><small>Hercule checks it with Z.ai before it saves it.</small></div>' +
      '<div class="ov-tip">' + mark("opencode", 14) + '<span><b>GLM 5.3 also comes from OpenCode Go</b>, which works. <button class="pv-link">Run GLM 5.3 from OpenCode Go</button> until this key is fixed.</span></div>' +
      "</div>";
    var foot = '<span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn btn--accent" data-close>Check and save</button>';
    return frame({ title: "Replace the Z.ai key", mark: "zai" }, body, foot);
  }

  /* ---------------------------------------------------------------- the catalog */

  function catalog(only) {
    var accounts = W.ACCOUNTS;
    var side =
      '<div class="ov-cat-side">' +
      '<button class="line' + (only ? "" : " is-on") + '" data-sheet="catalog">' + icon("list", 14) + '<span class="grow">All models</span><span class="line-note">' + W.catalogCount() + "</span></button>" +
      '<div class="ov-group" style="margin:12px 6px 4px">FROM</div>' +
      accounts.map(function (a) {
        var on = only === a.id;
        return '<button class="line' + (on ? " is-on" : "") + '"' + (a.vendor === "openrouter" ? ' data-sheet="catalog-openrouter"' : "") + ">" + mark(W.VENDORS[a.vendor].mark, 14) + '<span class="grow">' + W.accountName(a) + '</span><span class="line-note">' + a.models + "</span></button>";
      }).join("") +
      "</div>";
    var main = only ? openRouterList() : allList();
    var body = '<div class="ov-cat">' + side + '<div class="ov-cat-main">' + main + "</div></div>";
    var foot = only
      ? '<span class="note">Showing the newest models of each family. Type to search all 466.</span><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn btn--accent" data-close disabled>Add models</button>'
      : '<span class="note">2 selected. They join the end of the menu, from the first account that offers them.</span><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn btn--accent" data-close>Add 2 models</button>';
    return frame({ title: "Add models", wide: true }, body, foot);
  }

  function search(placeholder, value) {
    return (
      '<div class="ov-search"><label class="field">' + icon("search", 14) +
      '<input class="ov-input" style="background:none" placeholder="' + placeholder + '" value="' + (value || "") + '" /></label>' +
      '<div class="seg"><button aria-pressed="true">Newest</button><button>All</button><button>In the menu</button></div></div>'
    );
  }

  /** Every family, newest first; older models fold under one row per family. */
  function allList() {
    var fams = [];
    W.MODELS.forEach(function (m) { if (fams.indexOf(m.family) === -1) fams.push(m.family); });
    var chosen = { "haiku-5-5": true, "glm-5-3-flash": true };
    return (
      search("Search " + W.catalogCount() + " models") +
      fams.map(function (f) {
        var all = W.MODELS.filter(function (m) { return m.family === f; });
        var newest = all.filter(function (m) { return !m.older; });
        var older = all.length - newest.length;
        return (
          '<div class="ov-fam">' + f + " <small>" + all.length + "</small></div>" +
          newest.map(function (m) { return modelRow(m, chosen[m.id]); }).join("") +
          (older ? '<div class="ov-older">' + icon("chev-r", 12) + older + " older " + f + " model" + (older > 1 ? "s" : "") + "</div>" : "")
        );
      }).join("") +
      '<div class="ov-fam">More from OpenRouter <small>435</small></div>' +
      '<div class="ov-older">' + icon("chev-r", 12) + "Gemini, Grok, Mistral, Llama and 38 more families · search or pick OpenRouter on the left</div>"
    );
  }

  function modelRow(m, checked) {
    var entries = W.MENU.filter(function (e) { return e.model === m.id; });
    var isIn = entries.length > 0;
    var routes = W.routesOf(m);
    var from = routes.map(function (r) {
      return '<span class="ov-from" title="' + W.accountName(r.account) + '">' + mark(W.VENDORS[r.account.vendor].mark, 12) + (r.account.label || W.VENDORS[r.account.vendor].name) + "</span>";
    }).join('<span class="faint">·</span>');
    var caps = (m.caps || []).map(function (c) { return '<span class="ov-cap">' + c + "</span>"; }).join("");
    return (
      '<label class="ov-mrow' + (isIn ? " is-in" : "") + '">' +
      '<span class="choice-box"><input type="checkbox"' + (isIn || checked ? " checked" : "") + (isIn ? " disabled" : "") + " />" + icon("check", 10) + "</span>" +
      '<span class="ov-mrow-t"><b>' + m.name + (m.tier ? ' <span class="faint" style="font-weight:400;font-size:var(--t-12)">' + m.tier + "</span>" : "") + "</b>" +
      '<small class="pv-route">' + (isIn ? "In the menu" + (entries.length > 1 ? " twice" : "") : "From ") + (isIn ? "" : from) + "</small></span>" +
      '<span style="display:flex;gap:4px">' + caps + "</span>" +
      "</label>"
    );
  }

  /** OpenRouter's 466: never 466 rows. Families with a few newest models each, and a count of the rest. */
  function openRouterList() {
    var rows = W.LONG_TAIL.map(function (t) {
      return (
        '<div class="ov-fam">' + t[0] + " <small>" + t[2] + "</small></div>" +
        t[1].map(function (name) {
          return '<label class="ov-mrow"><span class="choice-box"><input type="checkbox" />' + icon("check", 10) + '</span><span class="ov-mrow-t"><b>' + name + '</b><small class="pv-route">From ' + mark("openrouter", 12) + "OpenRouter · per token</small></span><span></span></label>";
        }).join("") +
        '<div class="ov-older">' + icon("chev-r", 12) + (t[2] - t[1].length) + " more " + t[0] + " models</div>"
      );
    }).join("");
    return search("Search 466 OpenRouter models") + rows + '<p class="ov-count">Claude, GPT, GLM, Kimi and the other families above are in All models.</p>';
  }

  /* ---------------------------------------------------------------- open and close */

  var SHEETS = {
    "add-account": addAccount,
    "add-anthropic": function () { return methods("anthropic"); },
    "add-openai": function () { return methods("openai"); },
    browser: browser,
    added: added,
    relay: relay,
    "relay-openai": relayOpenAI,
    renew: renew,
    "replace-key": replaceKey,
    catalog: function () { return catalog(null); },
    "catalog-openrouter": function () { return catalog("openrouter"); },
  };

  Pv.openSheet = function (name) {
    if (name === "catalog" || name === "catalog-openrouter") {
      Pv.closeSheet();
      Pv.openCatalog({
        vendor: name === "catalog-openrouter" ? "openrouter" : null,
        onSave: Pv.currentVariant === "d" ? function () { Pv.D.save(); Pv.rerender(); } : null,
      });
      return;
    }
    if (!SHEETS[name]) return;
    if (!host) {
      host = document.createElement("div");
      document.body.appendChild(host);
    }
    host.innerHTML = SHEETS[name]();
    host.querySelectorAll("[data-close]").forEach(function (el) {
      el.addEventListener("click", function (ev) {
        if (ev.target === el || el.tagName === "BUTTON") Pv.closeSheet();
      });
    });
    host.querySelectorAll(".ov-method").forEach(function (b) {
      b.addEventListener("click", function () {
        host.querySelectorAll(".ov-method").forEach(function (x) { x.classList.toggle("is-on", x === b); });
      });
    });
    Pv.wireSheets(host);
  };
  Pv.closeSheet = function () {
    if (host) host.innerHTML = "";
  };
})();
