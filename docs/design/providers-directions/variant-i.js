// PROTOTYPE - Variant I, "Shared accounts": accounts as one pool that profiles pick from.
//   - Accounts sit on top, outside the profiles: every account once, with the profiles that use
//     it. Select a profile below and its accounts light up; the rest wait, one click from use.
//   - A profile is a model menu put together from accounts. An account may sit in any number of
//     profiles, and a profile may hold two accounts of one vendor: the menu tells them apart.
//   - Inside a profile, "Add an account" lists the accounts it does not use yet. The account
//     added opens its model picker at once.
//   - A new profile is named first. An empty profile teaches: pick accounts on the left, and the
//     composer's menu, drawn empty on the right, fills as you go.
//   - Rename, duplicate and delete are rare, so they live in a small menu on the selected tab.
//   - With one profile there are no tabs: the page reads Accounts, then The menu.
//   - Adding a model: a popover for a small catalog, the model browser for a big one (more than
//     40 models); every popover links to the browser.
//   - The preview is an accordion: one profile open at a time, the others closed heads.
//   - Models and accounts reorder by drag, or Alt+Up and Alt+Down.
//   - Harnesses: which harnesses an account can run in is a fact (shown in the account sheet).
//     Each account has a default harness, set in its sheet (its vendor's own, else pi, unless
//     changed). An account's line in a profile can pick another, and one model can move, or be
//     offered in a second harness too. Installing harnesses is the Fleet page's job.
(function () {
  var W = World, P = Pv, R = Pv.R, mark = Pv.mark, icon = Crew.icon;
  var BIG = 40;
  var ui = { profile: null, picker: null, pq: "", unfold: {}, acc: null, addAcct: false, tabMenu: false, rename: false, del: false, hpop: null, rowMenu: null, flash: null, drag: null };
  var host; // the new-profile dialog

  function S() { return Pv.P3; }
  function current() {
    if (!ui.profile || !S().profile(ui.profile)) ui.profile = S().state.profiles[0].id;
    return S().profile(ui.profile);
  }
  function single() { return S().state.profiles.length === 1; }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  function render() {
    if (!W.ACCOUNTS.length) return '<div class="set-col pv-col">' + P.empty() + "</div>";
    var p = current();
    return '<div class="vi">' + pool(p) + profiles(p) + "</div>";
  }

  function headerAction() {
    return W.ACCOUNTS.length ? '<button class="btn btn--sm" data-sheet="add-account">' + icon("plus", 14) + "Add an account</button>" : "";
  }

  /* ---------------------------------------------------------------- the pool */

  function pool(p) {
    return (
      '<section class="vi-pool">' +
      '<div class="vi-h"><h2>Accounts</h2><p>' + (single() ? "Who pays for the models in your menu." : "Who pays. Each profile picks from these; an account can serve several.") + "</p></div>" +
      '<div class="vi-cards">' + W.ACCOUNTS.map(function (a) { return card(p, a); }).join("") + "</div>" +
      "</section>"
    );
  }

  function usageBits(a) {
    if (a.failed) return { num: "Key refused", sub: "at " + a.failed.at };
    if (a.balance) return { num: a.balance.replace(" left", ""), sub: "credits left" };
    if (a.usage) return { num: a.usage.pct + "%", sub: a.usage.window.replace(" window", "").replace(" limit", "") + " · " + a.usage.resets };
    return { num: a.endsIn, sub: "left on the token" };
  }

  function card(p, a) {
    var v = W.VENDORS[a.vendor];
    var n = R.need(a);
    var member = p.accounts.indexOf(a.id) !== -1;
    var using = S().profilesUsing(a.id);
    var u = usageBits(a);
    var foot = single()
      ? (member ? "" : '<span class="vi-out">Not in the menu</span>')
      : '<span class="vi-used">' + (using.length ? using.map(function (x) { return S().avatar(x, "xs"); }).join("") : '<span class="vi-out">No profile yet</span>') + "</span>";
    return (
      '<div class="vi-card' + (member ? " is-member" : " is-out") + (n ? " is-" + n.tone : "") + '" data-card="' + a.id + '">' +
      '<button class="vi-card-b" data-open-acct="' + a.id + '" title="Open ' + W.accountName(a) + '">' +
      '<span class="vi-card-top">' + mark(v.mark, 15) + "<b>" + W.accountName(a) + "</b>" + R.pips(a) + "</span>" +
      '<span class="vi-card-plan">' + a.plan + "</span>" +
      '<span class="vi-card-use"><b>' + u.num + "</b>" + (a.usage && !a.failed ? '<i class="vf-bar"><i style="width:' + a.usage.pct + '%"></i></i>' : "<i></i>") + "</span>" +
      '<span class="vi-card-sub">' + (n && !a.failed ? n.text : u.sub) + "</span>" +
      "</button>" +
      // With one profile, an account in the menu needs no footer: only the one left out says so.
      (single() && member
        ? ""
        : '<span class="vi-card-foot">' + foot +
          (member
            ? '<span class="vi-in">' + icon("check", 11) + "In " + p.name + "</span>"
            : '<button class="vi-use" data-member="' + a.id + '">' + icon("plus", 11) + (single() ? "Use" : "Use in " + p.name) + "</button>") +
          "</span>") +
      "</div>"
    );
  }

  /* ---------------------------------------------------------------- profiles */

  function profiles(p) {
    var accounts = S().accountsIn(p);
    var head = single()
      ? '<div class="vi-h vi-h--menu"><h2>Models</h2><p>The models you can use in Hercule, in the order the composer shows them. You can also <button class="pv-link" data-new-profile>create several profiles</button>, each with its own set.</p></div>'
      : '<div class="vi-h vi-h--menu"><h2>Models</h2><p>The models you can use in Hercule. Each profile is its own set; you can create as many as you like.</p></div>' + tabs(p);
    var body = accounts.length
      ? '<div class="vh-build vi-build' + (single() ? " vi-build--single" : "") + '"><div class="vh-menu">' +
        accounts.map(function (a, i) { return section(p, a, i); }).join("") +
        addAccount(p) +
        "</div>" + rail(p) + "</div>"
      : teach(p);
    return '<section class="vi-profiles">' + head + body + "</section>";
  }

  /**
   * Returns the profile tabs. The selected tab carries a small menu (rename, duplicate, delete),
   * because those are rare and get no room of their own. Renaming happens in the tab itself.
   */
  function tabs(p) {
    return (
      '<div class="vh-tabs vi-tabs" role="tablist">' +
      S().state.profiles.map(function (x) {
        var on = x.id === p.id;
        if (on && ui.rename) {
          return '<span class="vh-tab vi-tab-edit" aria-selected="true">' + S().avatar(x, "sm") + '<input class="vi-rename" data-rename-input value="' + x.name + '" size="' + Math.max(8, x.name.length + 2) + '" /></span>';
        }
        return (
          '<span class="vi-tabwrap">' +
          '<button role="tab" class="vh-tab" data-profile="' + x.id + '" aria-selected="' + on + '">' + S().avatar(x, "sm") + x.name + "<small>" + S().count(x) + "</small></button>" +
          (on ? '<button class="vi-tabmore' + (ui.tabMenu ? " is-on" : "") + '" data-tab-menu title="' + x.name + ' options">' + icon("chev-d", 11) + "</button>" : "") +
          (on && ui.tabMenu ? tabMenu(x) : "") +
          "</span>"
        );
      }).join("") +
      '<button class="vh-tab vh-tab--new" data-new-profile>' + icon("plus", 13) + "New profile</button>" +
      "</div>"
    );
  }

  function tabMenu(p) {
    if (ui.del) {
      return (
        '<div class="vi-tabpop pop vi-tabpop--del"><p>Delete <b>' + p.name + "</b>? Its menu goes. Your accounts and the other profiles stay.</p>" +
        '<div class="vi-tabpop-acts"><button class="btn btn--sm btn--quiet" data-del-no>Keep it</button><button class="btn btn--sm btn--danger" data-del-yes>Delete</button></div></div>'
      );
    }
    return (
      '<div class="vi-tabpop pop">' +
      '<button class="line" data-rename>' + icon("editor", 14) + '<span class="grow">Rename</span></button>' +
      '<button class="line" data-duplicate>' + icon("list", 14) + '<span class="grow">Duplicate</span></button>' +
      '<button class="line vi-danger" data-del>' + icon("close", 14) + '<span class="grow">Delete…</span></button>' +
      "</div>"
    );
  }

  /* ---------------------------------------------------------------- an empty profile teaches */

  function teach(p) {
    var tiles = W.ACCOUNTS.map(function (a) {
      var u = usageBits(a);
      return (
        '<button class="vi-tile" data-first="' + a.id + '">' +
        '<span class="vi-tile-top">' + mark(W.VENDORS[a.vendor].mark, 15) + "<b>" + W.accountName(a) + '</b><span class="vi-tile-plus">' + icon("plus", 12) + "</span></span>" +
        "<small>" + a.plan + " · " + u.num + "</small></button>"
      );
    }).join("");
    return (
      '<div class="vi-teach">' +
      '<div class="vi-teach-l">' +
      "<h3>Build " + p.name + "'s model menu</h3>" +
      "<p>A profile is a model selector you put together yourself: the accounts it pays with, and the models you want from each. When a thread uses " + p.name + ", the composer shows exactly that list.</p>" +
      '<ol class="vi-steps">' +
      '<li class="is-now"><i>1</i><span><b>Pick an account</b><small>Any of yours. It stays in its other profiles too.</small></span></li>' +
      "<li><i>2</i><span><b>Pick its models</b><small>The newest come first; older ones are a search away.</small></span></li>" +
      "<li><i>3</i><span><b>Use it</b><small>Open " + p.name + " in the composer's menu.</small></span></li>" +
      "</ol>" +
      '<div class="vi-tiles">' + tiles + "</div>" +
      '<button class="vi-newacct" data-sheet="add-account">' + icon("plus", 12) + "Or add a new account</button>" +
      "</div>" +
      ghost(p) +
      "</div>"
    );
  }

  /** Returns the composer's menu for an empty profile: its head, then quiet bars waiting to fill. */
  function ghost(p) {
    return (
      '<aside class="vi-ghost">' +
      '<div class="vf-prev-h">' + icon("compose", 13) + "<b>In the composer</b></div>" +
      '<div class="md pop vi-ghost-menu">' +
      '<label class="md-search">' + icon("search", 14) + '<input placeholder="Search models" disabled /></label>' +
      '<div class="ac is-open"><div class="ac-h">' + S().avatar(p, "sm") + "<b>" + p.name + '</b><span class="md-n">0</span></div>' +
      '<div class="ac-b"><i class="vi-dash vi-dash--h"></i><i class="vi-dash" style="width:52%"></i><i class="vi-dash" style="width:64%"></i><i class="vi-dash" style="width:44%"></i>' +
      '<i class="vi-dash vi-dash--h"></i><i class="vi-dash" style="width:58%"></i><i class="vi-dash" style="width:40%"></i></div></div>' +
      "</div>" +
      '<p class="vd-rail-foot">Your models will appear here, under ' + p.name + ".</p>" +
      "</aside>"
    );
  }

  /* ---------------------------------------------------------------- one account's part */

  /** Returns one account's part of the menu: its head with where it runs, its entries in order, a new release if any, and Add. */
  function section(p, a, index) {
    var v = W.VENDORS[a.vendor];
    var entries = S().picksOf(p.id, a.id).filter(function (e) { return W.catalogModel(e); });
    var key = p.id + "|" + a.id;
    var fresh = S().news(p.id, a.id);
    var big = a.models > BIG;
    return (
      '<div class="vh-sec' + (ui.flash === key ? " is-fresh-sec" : "") + '" data-sec="' + a.id + '" data-index="' + index + '">' +
      '<div class="vh-sh" draggable="true" data-drag-sec="' + a.id + '" title="Drag to move ' + W.accountName(a) + "'s models up or down the menu\">" +
      '<span class="vh-grip">' + icon("grip", 12) + "</span>" + mark(v.mark, 13) + "<b>" + W.accountName(a) + "</b>" + harnessPill(p, a) + R.gauge(a) +
      '<button class="vi-leave" data-member="' + a.id + '" title="Stop using ' + W.accountName(a) + " in " + p.name + '">' + icon("close", 11) + "</button></div>" +
      (ui.hpop === key ? harnessPop(p, a) : "") +
      entries.map(function (e) { return row(p, a, e); }).join("") +
      (entries.length ? "" : '<p class="vi-none vi-none--sec">No model from ' + W.accountName(a) + " in the menu yet.</p>") +
      fresh.map(function (m) {
        return '<div class="vh-new"><span class="pk-new">New</span><b>' + m.name + "</b><small>" + m.tier + " · released " + m.fresh + '</small><span class="spacer"></span><button class="btn btn--sm" data-add-new="' + key + "|" + m.id + '">Add</button><button class="btn btn--sm btn--quiet" data-dismiss="' + key + "|" + m.id + '">Not now</button></div>';
      }).join("") +
      '<div class="vh-addwrap">' +
      (big
        ? '<button class="vh-add" data-browse="' + a.id + '">' + icon("search", 12) + "Browse " + a.models + " models</button>"
        : '<button class="vh-add" data-picker="' + key + '">' + icon("plus", 12) + "Add a model</button>") +
      (ui.picker === key ? picker(p, a) : "") +
      "</div></div>"
    );
  }

  /** Returns where an account's models run in this profile: plain text when only one harness can, a pick when several can. */
  function harnessPill(p, a) {
    var h = S().accountHarness(p.id, a.id);
    var choices = S().canRun(a).filter(function (c) { return c.ok; });
    if (choices.length < 2) return '<span class="vi-hpill is-fixed" title="' + (a.only || "") + '">' + mark(h.mark, 11) + h.name + "</span>";
    return '<button class="vi-hpill' + (S().isAutoHarness(p.id, a.id) ? "" : " is-set") + '" data-hpop="' + p.id + "|" + a.id + '" title="Where ' + W.accountName(a) + "'s models run in " + p.name + '">' + mark(h.mark, 11) + h.name + icon("chev-d", 10) + "</button>";
  }

  /** Returns the choice of harness for one account in this profile: the account's default, or one it can run in; the rest say why not. */
  function harnessPop(p, a) {
    var auto = S().accountDefault(a);
    var isAuto = S().isAutoHarness(p.id, a.id);
    var cur = S().accountHarness(p.id, a.id);
    return (
      '<div class="vi-hpop pop">' +
      '<div class="md-gh md-gh--other"><span>' + W.accountName(a) + "'s models in " + p.name + " run in</span></div>" +
      '<button class="vi-hrow" data-set-h=""><span class="vi-radio' + (isAuto ? " is-on" : "") + '"></span><span><b>Same as the account · ' + auto.name + '</b><small>The account\'s default harness. <span class="pv-link" data-open-acct="' + a.id + '">Change it</span></small></span></button>' +
      S().canRun(a).map(function (c) {
        var h = c.harness;
        var missing = W.ALL.filter(function (m) { return h.on.indexOf(m) === -1; });
        if (!c.ok) return '<div class="vi-hrow is-off"><span class="vi-radio"></span><span><b>' + h.name + "</b><small>" + c.why + "</small></span></div>";
        return (
          '<button class="vi-hrow" data-set-h="' + h.id + '"><span class="vi-radio' + (!isAuto && cur.id === h.id ? " is-on" : "") + '"></span><span><b>' + mark(h.mark, 11) + h.name + "</b><small>" +
          (missing.length ? '<span class="you-ink">Not on ' + missing.join(", ") + "</span>" : h.about) + "</small></span></button>"
        );
      }).join("") +
      "</div>"
    );
  }

  function row(p, a, e) {
    var m = W.catalogModel(e);
    var own = S().entry(e).h;
    var key = p.id + "|" + a.id + "|" + e;
    var def = S().isDefault(p.id, a.id, e);
    var open = ui.rowMenu === key;
    return (
      '<div class="vh-row' + (ui.flash === key ? " is-fresh" : "") + (open ? " is-menu" : "") + '" draggable="true" tabindex="0" data-drag-row="' + key + '">' +
      '<span class="vh-grip" title="Drag to reorder">' + icon("grip", 12) + "</span>" +
      "<b>" + m.name + "</b>" + (own ? '<span class="vi-inh">' + mark(W.harness(own).mark, 10) + "in " + W.harness(own).name + "</span>" : "") +
      "<small>" + (m.tier || (m.older ? "older" : m.meta || "")) + "</small>" +
      '<span class="spacer"></span>' +
      (def ? '<span class="ve-def">default</span>' : "") +
      '<button class="vh-x vi-rowmore" data-row-menu="' + key + '" title="More for ' + m.name + '">' + icon("more", 13) + "</button>" +
      '<button class="vh-x" data-remove="' + key + '" title="Take ' + m.name + ' out of the menu">' + icon("close", 11) + "</button>" +
      (open ? rowMenu(p, a, e) : "") +
      "</div>"
    );
  }

  /** Returns one entry's menu: make it the default, move it to another harness, offer it in a second one, or take it out. */
  function rowMenu(p, a, e) {
    var key = p.id + "|" + a.id + "|" + e;
    var here = S().entryHarness(p.id, a.id, e);
    var acctH = S().accountHarness(p.id, a.id);
    var list = S().picksOf(p.id, a.id);
    var id = S().entry(e).id;
    var ok = S().canRun(a).filter(function (c) { return c.ok; }).map(function (c) { return c.harness; });
    var moves = ok.map(function (h) {
      return '<button class="line" data-move-h="' + key + "|" + h.id + '"><span class="vi-radio' + (h.id === here.id ? " is-on" : "") + '"></span><span class="grow">' + h.name + (h.id === acctH.id ? ' <small class="faint">like the account</small>' : "") + "</span></button>";
    }).join("");
    var also = ok.filter(function (h) {
      if (h.id === here.id) return false;
      var already = h.id === acctH.id ? list.indexOf(id) !== -1 : list.indexOf(id + "@" + h.id) !== -1;
      return !already;
    }).map(function (h) {
      return '<button class="line" data-also-h="' + key + "|" + h.id + '">' + icon("plus", 13) + '<span class="grow">Also offer in ' + h.name + "</span></button>";
    }).join("");
    return (
      '<div class="vi-rowpop pop">' +
      (S().isDefault(p.id, a.id, e) ? "" : '<button class="line" data-def="' + key + '">' + icon("check", 13) + '<span class="grow">Make it ' + p.name + "'s default</span></button>") +
      (ok.length > 1 ? '<div class="md-gh md-gh--other"><span>Runs in</span></div>' + moves + also : "") +
      '<div class="vi-rowpop-sep"></div><button class="line vi-danger" data-remove="' + key + '">' + icon("close", 13) + '<span class="grow">Take out of the menu</span></button>' +
      "</div>"
    );
  }

  function picker(p, a) {
    return (
      '<div class="vh-picker pop">' +
      '<label class="md-search">' + icon("search", 14) + '<input data-pq placeholder="Search ' + a.models + " models from " + W.accountName(a) + '" value="' + ui.pq + '" /></label>' +
      '<div class="vh-plist">' + S().pickerList(p.id, a.id, ui.pq, ui.unfold) + "</div>" +
      '<div class="vh-pfoot"><button class="pv-link" data-browse="' + a.id + '">Browse all ' + a.models + "</button><button class=\"btn btn--sm\" data-picker-close>Done</button></div>" +
      "</div>"
    );
  }

  /** Returns the row that adds an account to this profile, and its list when open. */
  function addAccount(p) {
    var out = W.ACCOUNTS.filter(function (a) { return p.accounts.indexOf(a.id) === -1; });
    return (
      '<div class="vi-addacct-wrap">' +
      '<button class="vi-addacct" data-add-acct>' + icon("plus", 13) + "Add an account to " + p.name + "</button>" +
      (ui.addAcct
        ? '<div class="vi-acctpop pop">' +
          (out.length
            ? '<div class="md-gh md-gh--other"><span>Your accounts not in ' + p.name + "</span></div>" + out.map(function (a) {
                return '<button class="vi-arow" data-first="' + a.id + '">' + mark(W.VENDORS[a.vendor].mark, 14) + '<span class="vi-arow-t"><b>' + W.accountName(a) + "</b><small>" + a.plan + "</small></span>" + R.gauge(a) + "</button>";
              }).join("")
            : '<p class="md-none">' + p.name + " already uses every account you have.</p>") +
          '<div class="mm-foot"><button class="line" data-sheet="add-account">' + icon("plus", 14) + '<span class="grow" style="color:var(--ink)">New account…</span></button></div>' +
          "</div>"
        : "") +
      "</div>"
    );
  }

  /* ---------------------------------------------------------------- the rail */

  function rail(p) {
    var open = ui.acc === null ? p.id : ui.acc;
    return (
      '<aside class="vh-rail">' +
      '<div class="vf-prev-h">' + icon("compose", 13) + "<b>In the composer</b><small>" + (single() ? "every thread" : "a thread using " + p.name) + "</small></div>" +
      '<div class="md pop vh-prev">' +
      '<label class="md-search">' + icon("search", 14) + '<input placeholder="Search models" disabled /></label>' +
      '<div class="md-list">' + S().accordionHTML(open, { fresh: ui.flash }) + "</div>" +
      "</div>" +
      '<p class="vd-rail-foot">' + (single() ? "" : "One profile open at a time. ") + '<button class="pv-link" data-reset>Start over</button></p>' +
      "</aside>"
    );
  }

  /* ---------------------------------------------------------------- a new profile */

  function newProfile(rerender) {
    if (!host) { host = document.createElement("div"); document.body.appendChild(host); }
    var others = S().state.profiles;
    host.innerHTML =
      '<div class="ov-scrim" data-np-scrim><div class="ov pop np" role="dialog" aria-label="New profile">' +
      '<div class="ov-h"><h2>New profile</h2><button class="icon-btn" data-np-close title="Close">' + icon("close") + "</button></div>" +
      '<div class="ov-b"><p>A profile is your own model menu, put together from your accounts. Name it for what it is for.</p>' +
      '<div class="ov-field" style="margin-top:0"><label>Name</label><input class="field ov-input" data-np-name placeholder="Client work, Experiments, Cheap and fast…" />' +
      '<div class="np-sugg">' + ["Client work", "Experiments", "Cheap and fast", "Long tasks"].map(function (n) { return '<button class="vg-pchip" data-np-sugg="' + n + '">' + n + "</button>"; }).join("") + "</div></div>" +
      '<div class="ov-field"><label>Start from</label><div class="ov-methods">' +
      '<button class="ov-method is-on" data-np-from=""><span class="va-dot"></span><span class="ov-method-t"><b>Nothing</b></span><p>Pick its accounts and models yourself. The page shows how.</p></button>' +
      '<button class="ov-method" data-np-from="copy"><span class="va-dot"></span><span class="ov-method-t"><b>A copy of</b><select class="vd-select" data-np-copy>' +
      others.map(function (o) { return '<option value="' + o.id + '">' + o.name + " · " + plural(S().count(o), "model") + "</option>"; }).join("") +
      "</select></span><p>Its accounts and menu, to change from there. The original stays as it is.</p></button>" +
      "</div></div></div>" +
      '<div class="ov-f"><span class="spacer"></span><button class="btn" data-np-close>Cancel</button><button class="btn btn--accent" data-np-create disabled>Create profile</button></div>' +
      "</div></div>";
    var name = host.querySelector("[data-np-name]");
    var create = host.querySelector("[data-np-create]");
    var from = "";
    function sync() { create.disabled = !name.value.trim(); create.textContent = name.value.trim() ? "Create " + name.value.trim() : "Create profile"; }
    name.addEventListener("input", sync);
    name.addEventListener("keydown", function (e) { if (e.key === "Enter" && name.value.trim()) create.click(); });
    host.querySelectorAll("[data-np-sugg]").forEach(function (b) { b.addEventListener("click", function () { name.value = b.dataset.npSugg; sync(); name.focus(); }); });
    var copy = host.querySelector("[data-np-copy]");
    host.querySelectorAll("[data-np-from]").forEach(function (b) {
      b.addEventListener("click", function () {
        from = b.dataset.npFrom === "copy" ? copy.value : "";
        host.querySelectorAll("[data-np-from]").forEach(function (x) { x.classList.toggle("is-on", x === b); });
      });
    });
    copy.addEventListener("click", function (e) { e.stopPropagation(); });
    copy.addEventListener("change", function () {
      from = copy.value;
      host.querySelectorAll("[data-np-from]").forEach(function (x) { x.classList.toggle("is-on", x.dataset.npFrom === "copy"); });
    });
    function close() { host.innerHTML = ""; }
    host.querySelectorAll("[data-np-close]").forEach(function (b) { b.addEventListener("click", close); });
    host.querySelector("[data-np-scrim]").addEventListener("click", function (e) { if (e.target === e.currentTarget) close(); });
    create.addEventListener("click", function () {
      ui.profile = S().createProfile(name.value.trim(), from);
      ui.acc = null; ui.picker = null; ui.rename = false;
      closeMenus();
      close();
      rerender();
    });
    if (window.top === window) name.focus();
  }
  Pv.closeNewProfile = function () { if (host) host.innerHTML = ""; };

  /* ---------------------------------------------------------------- wiring */

  function move(list, from, to) { var item = list.splice(from, 1)[0]; list.splice(to, 0, item); }

  /** Takes a model out of an account's part of the menu, in every harness it was offered in. */
  function removeModel(pid, aid, mid) {
    S().picksOf(pid, aid).filter(function (e) { return S().entry(e).id === mid; }).forEach(function (e) { S().remove(pid, aid, e); });
  }
  /** Adds the picker's model to the menu, or takes it out when it is there already. */
  function togglePick(mid) {
    var k = ui.picker.split("|");
    if (S().hasModel(S().picksOf(k[0], k[1]), mid)) removeModel(k[0], k[1], mid);
    else { S().add(k[0], k[1], mid); ui.flash = ui.picker + "|" + mid; }
  }

  /** Puts an account in the current profile and opens its model picker, the next step. */
  function useAccount(aid) {
    var p = current();
    if (p.accounts.indexOf(aid) === -1) S().toggleMember(p.id, aid);
    ui.addAcct = false;
    ui.flash = p.id + "|" + aid;
    ui.pq = "";
    ui.unfold = {};
    ui.picker = W.account(aid).models > BIG ? null : p.id + "|" + aid;
  }

  function closeMenus() { ui.tabMenu = false; ui.del = false; ui.hpop = null; ui.rowMenu = null; ui.addAcct = false; }

  function wire(body, rerender) {
    function on(sel, fn) {
      body.querySelectorAll(sel).forEach(function (el) {
        el.addEventListener("click", function (ev) { ev.stopPropagation(); fn(el); rerender(); });
      });
    }
    on("[data-profile]", function (el) { ui.profile = el.dataset.profile; ui.picker = null; ui.acc = null; ui.rename = false; closeMenus(); });
    on("[data-tab-menu]", function () { var was = ui.tabMenu; closeMenus(); ui.tabMenu = !was; });
    on("[data-rename]", function () { ui.rename = true; closeMenus(); });
    on("[data-duplicate]", function () {
      var p = current();
      ui.profile = S().createProfile(p.name + " copy", p.id);
      ui.acc = null;
      closeMenus();
      ui.rename = true;
    });
    on("[data-del]", function () { ui.del = true; });
    on("[data-del-no]", function () { closeMenus(); });
    on("[data-del-yes]", function () { S().deleteProfile(current().id); ui.profile = null; ui.acc = null; closeMenus(); });
    on("[data-def]", function (el) { var k = el.dataset.def.split("|"); S().setDefault(k[0], k[1], k[2]); ui.rowMenu = null; });
    on("[data-remove]", function (el) { var k = el.dataset.remove.split("|"); S().remove(k[0], k[1], k[2]); ui.rowMenu = null; });
    on("[data-add-new]", function (el) { var k = el.dataset.addNew.split("|"); S().add(k[0], k[1], k[2]); ui.flash = el.dataset.addNew; });
    on("[data-dismiss]", function (el) { var k = el.dataset.dismiss.split("|"); S().dismiss(k[0], k[1], k[2]); });
    on("[data-picker]", function (el) { var was = ui.picker === el.dataset.picker; closeMenus(); ui.picker = was ? null : el.dataset.picker; ui.pq = ""; ui.unfold = {}; });
    on("[data-picker-close]", function () { ui.picker = null; });
    on("[data-unfold]", function (el) { ui.unfold[el.dataset.unfold] = true; });
    on("[data-ac]", function (el) {
      var open = ui.acc === null ? current().id : ui.acc;
      ui.acc = open === el.dataset.ac ? "" : el.dataset.ac;
    });
    on("[data-reset]", function () { S().reset(); ui.profile = null; ui.acc = null; closeMenus(); });
    on("[data-member]", function (el) {
      var p = current();
      if (p.accounts.indexOf(el.dataset.member) === -1) useAccount(el.dataset.member);
      else S().toggleMember(p.id, el.dataset.member);
    });
    on("[data-first]", function (el) { useAccount(el.dataset.first); });
    on("[data-add-acct]", function () { var was = ui.addAcct; closeMenus(); ui.addAcct = !was; ui.picker = null; });
    on("[data-hpop]", function (el) { var was = ui.hpop === el.dataset.hpop; closeMenus(); ui.hpop = was ? null : el.dataset.hpop; });
    on("[data-set-h]", function (el) {
      var k = ui.hpop.split("|");
      S().setAccountHarness(k[0], k[1], el.dataset.setH || null);
      ui.hpop = null;
      ui.flash = k[0] + "|" + k[1];
    });
    on("[data-row-menu]", function (el) { var was = ui.rowMenu === el.dataset.rowMenu; closeMenus(); ui.rowMenu = was ? null : el.dataset.rowMenu; });
    on("[data-move-h]", function (el) {
      var k = el.dataset.moveH.split("|");
      S().setEntryHarness(k[0], k[1], k[2], k[3]);
      ui.rowMenu = null;
    });
    on("[data-also-h]", function (el) {
      var k = el.dataset.alsoH.split("|");
      S().alsoOffer(k[0], k[1], k[2], k[3]);
      ui.rowMenu = null;
      ui.flash = k[0] + "|" + k[1] + "|" + S().entry(k[2]).id + "@" + k[3];
    });
    on("[data-pick]", function (el) { togglePick(el.dataset.pick); });
    body.querySelectorAll("[data-new-profile]").forEach(function (el) {
      el.addEventListener("click", function (ev) { ev.stopPropagation(); newProfile(rerender); });
    });

    // Renaming happens in the tab: Enter or leaving the field keeps the name, Escape drops it.
    var ri = body.querySelector("[data-rename-input]");
    if (ri) {
      ri.focus();
      ri.select();
      var done = false;
      var keep = function () {
        if (done) return;
        done = true;
        var v = ri.value.trim();
        if (v) S().renameProfile(current().id, v);
        ui.rename = false;
        rerender();
      };
      ri.addEventListener("keydown", function (e) {
        if (e.key === "Enter") keep();
        if (e.key === "Escape") { e.stopPropagation(); done = true; ui.rename = false; rerender(); }
      });
      ri.addEventListener("blur", keep);
    }

    body.querySelectorAll("[data-browse]").forEach(function (el) {
      el.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var p = current(), aid = el.dataset.browse;
        ui.picker = null;
        rerender();
        Pv.openBrowser({
          accountId: aid, profile: p, inMenu: S().picksOf(p.id, aid).map(function (e) { return S().entry(e).id; }), q: ui.pq,
          onSave: function (added, removed) {
            added.forEach(function (id) { S().add(p.id, aid, id); });
            removed.forEach(function (id) { removeModel(p.id, aid, id); });
            if (added.length) ui.flash = p.id + "|" + aid + "|" + added[added.length - 1];
            rerender();
          },
        });
      });
    });
    body.querySelectorAll("[data-open-acct]").forEach(function (el) {
      el.addEventListener("click", function () { Pv.openAccount(el.dataset.openAcct, current().id, S()); });
    });
    // Pointing at an account's part of the menu lights the same part in the composer's preview.
    // The account cards stay out of it: lighting two places from one card was too busy.
    function hot(id) {
      body.querySelectorAll("[data-sec]").forEach(function (x) { x.classList.toggle("is-hot", x.dataset.sec === id); });
      body.querySelectorAll(".ac.is-open [data-mw-acct]").forEach(function (x) { x.classList.toggle("is-hot", x.dataset.mwAcct === id); });
    }
    body.querySelectorAll("[data-sec]").forEach(function (el) {
      el.addEventListener("mouseenter", function () { hot(el.dataset.sec); });
      el.addEventListener("mouseleave", function () { hot(null); });
    });

    var pq = body.querySelector("[data-pq]");
    if (pq) {
      if (window.top === window) pq.focus();
      pq.setSelectionRange(pq.value.length, pq.value.length);
      pq.addEventListener("input", function () {
        ui.pq = pq.value;
        var k = ui.picker.split("|");
        body.querySelector(".vh-plist").innerHTML = S().pickerList(k[0], k[1], ui.pq, ui.unfold);
        body.querySelectorAll(".vh-plist [data-pick]").forEach(function (el) {
          el.addEventListener("click", function (ev) { ev.stopPropagation(); togglePick(el.dataset.pick); rerender(); });
        });
      });
    }

    body.querySelectorAll("[data-drag-row]").forEach(function (el) {
      el.addEventListener("dragstart", function (ev) {
        ui.drag = { kind: "row", key: el.dataset.dragRow };
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", el.dataset.dragRow);
        el.classList.add("is-dragging");
      });
      el.addEventListener("dragend", function () { el.classList.remove("is-dragging"); clearMarks(body); });
      el.addEventListener("dragover", function (ev) {
        if (!ui.drag || ui.drag.kind !== "row") return;
        var a = ui.drag.key.split("|"), b = el.dataset.dragRow.split("|");
        if (a[0] !== b[0] || a[1] !== b[1]) return;
        ev.preventDefault();
        clearMarks(body);
        var r = el.getBoundingClientRect();
        el.classList.add(ev.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
      });
      el.addEventListener("drop", function (ev) {
        ev.preventDefault();
        var a = ui.drag.key.split("|"), b = el.dataset.dragRow.split("|");
        var list = S().picksOf(a[0], a[1]);
        var from = list.indexOf(a[2]);
        var to = list.indexOf(b[2]) + (el.classList.contains("drop-after") ? 1 : 0);
        if (from < to) to--;
        move(list, from, to);
        S().save();
        ui.drag = null;
        ui.flash = a.join("|");
        rerender();
      });
      el.addEventListener("keydown", function (ev) {
        if (!ev.altKey || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
        ev.preventDefault();
        ev.stopPropagation();
        var k = el.dataset.dragRow.split("|");
        var list = S().picksOf(k[0], k[1]);
        var i = list.indexOf(k[2]);
        var j = ev.key === "ArrowUp" ? i - 1 : i + 1;
        if (j < 0 || j >= list.length) return;
        move(list, i, j);
        S().save();
        ui.flash = el.dataset.dragRow;
        rerender();
        var again = document.querySelector('[data-drag-row="' + el.dataset.dragRow + '"]');
        if (again) again.focus();
      });
    });
    body.querySelectorAll("[data-drag-sec]").forEach(function (el) {
      el.addEventListener("dragstart", function (ev) {
        ui.drag = { kind: "sec", id: el.dataset.dragSec };
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", el.dataset.dragSec);
      });
      el.addEventListener("dragend", function () { clearMarks(body); });
    });
    body.querySelectorAll("[data-sec]").forEach(function (sec) {
      sec.addEventListener("dragover", function (ev) {
        if (!ui.drag || ui.drag.kind !== "sec") return;
        ev.preventDefault();
        clearMarks(body);
        var r = sec.getBoundingClientRect();
        sec.classList.add(ev.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
      });
      sec.addEventListener("drop", function (ev) {
        if (!ui.drag || ui.drag.kind !== "sec") return;
        ev.preventDefault();
        var list = current().accounts;
        var from = list.indexOf(ui.drag.id);
        var to = list.indexOf(sec.dataset.sec) + (sec.classList.contains("drop-after") ? 1 : 0);
        if (from < to) to--;
        move(list, from, to);
        S().save();
        ui.drag = null;
        rerender();
      });
    });
  }

  function clearMarks(body) {
    body.querySelectorAll(".drop-before, .drop-after").forEach(function (x) { x.classList.remove("drop-before", "drop-after"); });
  }

  Pv.variants.i = { key: "i", name: "Shared accounts", about: "Accounts as one pool that profiles pick from; a browser for big catalogs", render: render, headerAction: headerAction, wire: wire };
})();
