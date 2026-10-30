// PROTOTYPE - Variant D, "By vendor": the pick after the first round, rebuilt on Rogier's notes.
//   - One block per vendor. Tick the models you want to see from it: that is the whole job.
//     All accounts of the vendor show them; an account can have its own list if you ask.
//   - Each account shows its usage, as B did, and how far its sign-in reaches.
//   - Each project picks which account pays, where a vendor has more than one.
//   - The rail is the composer's menu itself, for the project you pick, live.
// Everything here is interactive and kept in sessionStorage (see menu-d.js).
(function () {
  var W = World, P = Pv, mark = Pv.mark, icon = Crew.icon;
  var ui = { preview: "webshop", open: {}, perAccount: {}, query: "" };
  var SUB = {
    anthropic: "Claude models",
    openai: "GPT models",
    zai: "GLM models, by plan",
    opencode: "Open models, by plan",
    openrouter: "466 models, paid per token",
  };

  function S() { return Pv.D.state; }

  function render() {
    if (!W.ACCOUNTS.length) return '<div class="set-col pv-col">' + P.empty() + "</div>";
    return (
      '<div class="vd">' +
      '<div class="vd-main">' +
      '<p class="pv-lead">Tick the models you want from each vendor. Each project picks which account pays; the composer starts there.</p>' +
      W.vendorsInUse().map(vendorBlock).join("") +
      projectsSection() +
      harnessesSection() +
      "</div>" +
      rail() +
      "</div>"
    );
  }

  function headerAction() {
    return W.ACCOUNTS.length ? '<button class="btn btn--sm" data-sheet="add-account">' + icon("plus", 14) + "Add an account</button>" : "";
  }

  /* ---------------------------------------------------------------- a vendor */

  function vendorBlock(v) {
    var vendor = W.VENDORS[v];
    var accounts = W.accountsOf(v);
    return (
      '<section class="vd-v" data-vendor="' + v + '">' +
      '<div class="vd-vh"><span class="pv-mk pv-mk--lg">' + mark(vendor.mark, 20) + '</span><span class="vd-vt"><b>' + vendor.name + "</b><span>" + SUB[v] + "</span></span>" +
      '<button class="icon-btn" title="More">' + icon("more") + "</button></div>" +
      '<div class="vd-accts">' + accounts.map(accountRow).join("") + "</div>" +
      modelsPart(v, accounts) +
      harnessLine(v) +
      "</section>"
    );
  }

  function accountRow(a) {
    var r = P.reach(a);
    var name = a.label || a.plan;
    var how = { token: "Long-lived token", "per-machine": "Signed in per machine", chatgpt: "Codex sign-in per machine", "chatgpt-shared": "ChatGPT sign-in", key: "API key " + a.who.replace("key ", "") }[a.method];
    var reach = a.reach === "fleet" ? "every machine" : a.signedIn.length === W.ALL.length ? "all " + W.ALL.length + " machines" : "";
    var used = Pv.D.projectsUsing(a.id);
    var usedText = used ? (used.length ? "for " + used.join(", ").replace(/, ([^,]*)$/, " and $1") : "no project yet") : "";
    var act = r.tone
      ? '<span class="vd-act"><span class="pv-note pv-note--' + r.tone + '">' + r.text + "</span>" + (r.action ? '<button class="btn btn--sm" data-sheet="' + r.sheet + '">' + r.action + "</button>" : "") + "</span>"
      : "";
    return (
      '<div class="vd-acct' + (a.failed ? " is-fail" : "") + '">' +
      '<span class="vd-an"><b>' + name + (usedText ? ' <span class="vd-used">' + usedText + "</span>" : "") + "</b>" +
      "<span>" + how + (reach ? " · " + reach : "") + "</span>" + act +
      "</span>" +
      '<span class="vd-use">' + usage(a) + "</span>" +
      '<button class="icon-btn" title="More">' + icon("more") + "</button>" +
      "</div>"
    );
  }

  /** Returns the plan window as B drew it, or the credit left, or why there is none. */
  function usage(a) {
    if (a.failed) return '<span class="vd-use-top"><span class="fail-ink">no usage, key refused</span></span>';
    if (a.balance) return '<span class="vd-use-top"><span><b>' + a.balance.replace(" left", "") + "</b> left</span><span>credits</span></span>";
    if (!a.usage) return '<span class="vd-use-top"><span class="faint">No usage shown for a token</span></span>';
    return (
      '<span class="vd-use-top"><span><b>' + a.usage.pct + "%</b> of " + a.usage.window.replace(" window", "").replace(" limit", "") + "</span><span>" + a.usage.resets + "</span></span>" +
      '<span class="meter"><i style="width:' + a.usage.pct + '%"></i></span>'
    );
  }

  /** Returns the vendor's models as switches: its newest ones, or for a big catalog only those picked. */
  function modelsPart(v, accounts) {
    var shown = S().shown[v] || [];
    var all = W.modelsOf(v);
    var newest = all.filter(function (m) { return !m.older && !m.tail; });
    var big = all.length > 40;
    var list = big ? shown.map(W.catalogModel).filter(Boolean) : newest.concat(shown.map(W.catalogModel).filter(function (m) { return m && newest.indexOf(m) === -1; }));
    var more = big ? "Add from " + all.length : (all.length - newest.length) + " older";
    var def = S().defaultModel;
    var chips = list.map(function (m) {
      var on = shown.indexOf(m.id) !== -1;
      var isDef = def.vendor === v && def.model === m.id;
      return '<button class="vd-sw' + (on ? " is-on" : "") + '" data-toggle-model="' + v + "|" + m.id + '"><span class="vb-box">' + (on ? icon("check", 10) : "") + "</span>" + m.name + (isDef ? ' <small>default</small>' : "") + "</button>";
    }).join("");
    if (big || all.length > newest.length) chips += '<button class="vd-more" data-catalog="' + v + '">' + icon("plus", 12) + more + "</button>";
    var hint = "";
    var per = "";
    if (accounts.length > 1) {
      var custom = accounts.filter(function (a) { return S().perAccount[a.id]; });
      if (ui.perAccount[v] || custom.length) {
        per = '<div class="vd-per">' + accounts.map(function (a) {
          var own = S().perAccount[a.id];
          var list2 = own || shown;
          return (
            '<span class="vd-per-n">' + a.label + "</span>" +
            '<span class="vd-chips">' + newest.map(function (m) {
              var on = list2.indexOf(m.id) !== -1;
              return '<button class="vd-sw vd-sw--sm' + (on ? " is-on" : "") + '" data-toggle-acct="' + a.id + "|" + m.id + '"><span class="vb-box">' + (on ? icon("check", 9) : "") + "</span>" + m.name + "</button>";
            }).join("") +
            (own ? '<button class="pv-link vd-reset" data-reset-acct="' + a.id + '">Same as ' + W.VENDORS[v].name + "</button>" : "") +
            "</span>"
          );
        }).join("") + "</div>";
        hint = '<p class="vd-hint">Each account below shows its own list. <button class="pv-link" data-per="' + v + '">Use one list</button></p>';
      } else {
        hint = '<p class="vd-hint">' + accounts.map(function (a) { return a.label; }).join(" and ") + ' both show these. <button class="pv-link" data-per="' + v + '">Choose per account</button></p>';
      }
    }
    // With a list per account, the vendor's own list would be a second, unused list: only the per-account rows show.
    if (per) chips = chips.replace(/<button class="vd-sw[\s\S]*?<\/button>/g, "");
    return '<div class="vd-models"><span class="vd-chips">' + chips + "</span>" + hint + per + "</div>";
  }

  /** Returns where the vendor's models run: fixed for Anthropic, a choice for the rest. */
  function harnessLine(v) {
    var possible = W.HARNESSES.filter(function (h) {
      return W.accountsOf(v).some(function (a) { return a.harnesses.indexOf(h.id) !== -1; });
    });
    var current = W.harness(S().harness[v]);
    if (possible.length < 2) {
      return '<p class="vd-run">' + mark(current.mark, 12) + "Runs in " + current.name + ". A Claude plan may only run there.</p>";
    }
    var others = possible.filter(function (h) { return h.id !== current.id; }).map(function (h) { return h.name; });
    return (
      '<p class="vd-run">' + mark(current.mark, 12) + "Runs in " +
      '<select class="vd-select" data-harness="' + v + '">' + possible.map(function (h) {
        return '<option value="' + h.id + '"' + (h.id === current.id ? " selected" : "") + ">" + h.name + "</option>";
      }).join("") + "</select>" +
      '<span class="faint" title="A thread can switch to ' + others.join(", ").replace(/, ([^,]*)$/, " or $1") + '">by default</span></p>'
    );
  }

  /* ---------------------------------------------------------------- projects */

  function projectsSection() {
    var multi = W.vendorsInUse().filter(function (v) { return W.accountsOf(v).length > 1; });
    if (!multi.length) return "";
    var head = '<span class="vd-ph">Project</span>' + multi.map(function (v) { return '<span class="vd-ph">' + W.VENDORS[v].name + "</span>"; }).join("");
    var rows = W.PROJECTS.concat([{ id: "_new" }]).map(function (p) {
      var label = p.id === "_new" ? '<span class="vd-pn faint">New projects</span>' : '<span class="vd-pn"><span class="proj proj--' + p.rug + '">' + p.id + "</span></span>";
      return label + multi.map(function (v) {
        var cur = Pv.D.accountFor(p.id, v);
        return '<span class="vd-pc"><select class="vd-select vd-select--box" data-project="' + p.id + "|" + v + '">' + W.accountsOf(v).map(function (a) {
          return '<option value="' + a.id + '"' + (a.id === cur ? " selected" : "") + ">" + W.accountName(a) + "</option>";
        }).join("") + "</select></span>";
      }).join("");
    }).join("");
    return (
      '<section class="vd-sec">' +
      '<div class="pv-head"><div><h2>Accounts per project</h2><p>Where a vendor has more than one account, each project picks one. The composer starts with it; a thread can still switch.</p></div></div>' +
      '<div class="vd-ptable" style="grid-template-columns: minmax(0,1fr) repeat(' + multi.length + ', 240px)">' + head + rows + "</div>" +
      "</section>"
    );
  }

  function harnessesSection() {
    return (
      '<section class="vd-sec vb-harnesses" style="margin-top:0">' +
      '<h3>Harnesses</h3>' +
      W.HARNESSES.map(function (h) {
        var missing = W.ALL.filter(function (m) { return h.on.indexOf(m) === -1; });
        var end = missing.length
          ? '<span class="vb-line">' + P.note("Not on " + missing.join(", "), "you") + '<button class="btn btn--sm">Install</button></span>'
          : P.note("every machine");
        return '<div class="vb-hrow">' + mark(h.mark, 16) + "<span>" + h.name + ' <span class="ver">' + h.version + "</span></span>" + end + "</div>";
      }).join("") +
      "</section>"
    );
  }

  /* ---------------------------------------------------------------- the rail */

  function rail() {
    var options = W.PROJECTS.map(function (p) {
      return '<option value="' + p.id + '"' + (p.id === ui.preview ? " selected" : "") + ">" + p.id + "</option>";
    }).join("");
    var menu = Pv.D.buildMenu(ui.preview, ui.query);
    return (
      '<aside class="vd-rail">' +
      '<div class="vd-rail-h"><b>The composer\'s menu</b><span>A new thread in <select class="vd-select" data-preview>' + options + "</select></span></div>" +
      '<div class="md pop">' +
      '<label class="md-search">' + icon("search", 14) + '<input data-q placeholder="Search ' + W.catalogCount() + ' models" value="' + ui.query + '" /></label>' +
      '<div class="md-list">' + Pv.D.renderMenu(menu, { open: ui.open, query: ui.query }) + "</div>" +
      "</div>" +
      '<p class="vd-rail-foot">Changes here show in the composer at once. <button class="pv-link" data-reset>Start over</button></p>' +
      "</aside>"
    );
  }

  /* ---------------------------------------------------------------- wiring */

  function toggle(list, id) {
    var i = list.indexOf(id);
    if (i === -1) list.push(id);
    else list.splice(i, 1);
  }

  function wire(body, rerender) {
    function change(fn) {
      return function (ev) {
        ev.preventDefault();
        fn(ev.currentTarget, ev);
        Pv.D.save();
        rerender();
      };
    }
    body.querySelectorAll("[data-toggle-model]").forEach(function (b) {
      b.addEventListener("click", change(function (el) {
        var parts = el.dataset.toggleModel.split("|");
        toggle(S().shown[parts[0]] = S().shown[parts[0]] || [], parts[1]);
      }));
    });
    body.querySelectorAll("[data-toggle-acct]").forEach(function (b) {
      b.addEventListener("click", change(function (el) {
        var parts = el.dataset.toggleAcct.split("|");
        var a = W.account(parts[0]);
        if (!S().perAccount[a.id]) S().perAccount[a.id] = (S().shown[a.vendor] || []).slice();
        toggle(S().perAccount[a.id], parts[1]);
      }));
    });
    body.querySelectorAll("[data-reset-acct]").forEach(function (b) {
      b.addEventListener("click", change(function (el) { delete S().perAccount[el.dataset.resetAcct]; }));
    });
    body.querySelectorAll("[data-per]").forEach(function (b) {
      b.addEventListener("click", change(function (el) {
        var v = el.dataset.per;
        if (ui.perAccount[v] || W.accountsOf(v).some(function (a) { return S().perAccount[a.id]; })) {
          ui.perAccount[v] = false;
          W.accountsOf(v).forEach(function (a) { delete S().perAccount[a.id]; });
        } else ui.perAccount[v] = true;
      }));
    });
    body.querySelectorAll("[data-harness]").forEach(function (s) {
      s.addEventListener("change", change(function (el) { S().harness[el.dataset.harness] = el.value; }));
    });
    body.querySelectorAll("[data-project]").forEach(function (s) {
      s.addEventListener("change", change(function (el) {
        var parts = el.dataset.project.split("|");
        S().projects[parts[0]] = S().projects[parts[0]] || {};
        S().projects[parts[0]][parts[1]] = el.value;
        if (parts[0] !== "_new") ui.preview = parts[0];
      }));
    });
    var preview = body.querySelector("[data-preview]");
    if (preview) preview.addEventListener("change", change(function (el) { ui.preview = el.value; }));
    body.querySelectorAll("[data-other]").forEach(function (b) {
      b.addEventListener("click", change(function (el) { ui.open[el.dataset.other] = !ui.open[el.dataset.other]; }));
    });
    var reset = body.querySelector("[data-reset]");
    if (reset) reset.addEventListener("click", change(function () { Pv.D.reset(); ui.open = {}; ui.perAccount = {}; ui.query = ""; }));
    body.querySelectorAll("[data-catalog]").forEach(function (b) {
      b.addEventListener("click", function () {
        Pv.openCatalog({ vendor: b.dataset.catalog, onSave: function () { Pv.D.save(); rerender(); } });
      });
    });
    // The rail's search filters as you type, and keeps the caret where it was.
    var q = body.querySelector("[data-q]");
    if (q) {
      q.addEventListener("input", function () {
        ui.query = q.value;
        var list = body.querySelector(".md-list");
        list.innerHTML = Pv.D.renderMenu(Pv.D.buildMenu(ui.preview, ui.query), { open: ui.open, query: ui.query });
      });
    }
  }

  Pv.variants.d = { key: "d", name: "By vendor", about: "The pick: models per vendor, accounts per project, the menu beside", render: render, headerAction: headerAction, wire: wire };
})();
