// PROTOTYPE - round 3: the Profile (round 2's wallet, renamed on Rogier's word) and the pieces
// variant H and composer.html draw with.
//
// A Profile is a named set of accounts, at most one per vendor, with its own model menu. Each
// project picks a profile; a thread can use another one.
//
// One rule for every account: its section lists exactly what is in the menu, and "Add a model"
// opens the same picker for every account, 14 models or 466. A model the vendor released lately
// is offered once, as a quiet "New" line, and never enters the menu by itself.
(function () {
  var W = World, R = Pv.R, mark = Pv.mark, icon = Crew.icon;
  // Each moment keeps its own state, so "single" never inherits four profiles from "ready".
  var KEY = "pv-r3-state-5-" + World.state + (new URLSearchParams(location.search).get("opencode") === "0" ? "-pi" : "");
  var FAMILY_ORDER = ["Claude", "GPT", "GLM", "Kimi", "Qwen", "DeepSeek", "MiniMax", "Gemini", "Grok", "Mistral", "Llama", "Others"];

  function initial() {
    // One profile holding every account: the page then has no tabs, only Accounts and the menu.
    // It also shows a profile with two Anthropic accounts, which the menu tells apart by section.
    if (World.state === "single") {
      return {
        profiles: [{ id: "personal", name: "Personal", accounts: ["anthropic-personal", "anthropic-work", "openai-personal", "openai-work", "zai", "opencode-go", "openrouter"] }],
        projects: { webshop: "personal", "payments-api": "personal", ops: "personal", _new: "personal" },
        picks: {
          personal: {
            "anthropic-personal": ["opus-5-5", "fable-5-1", "sonnet-5-5", "haiku-5-5"],
            "anthropic-work": ["opus-4-8"],
            "openai-personal": ["gpt-6-1-sol", "gpt-6-luna"],
            "openai-work": ["daybreak"],
            zai: ["glm-5-3"],
            "opencode-go": ["kimi-k3"],
            openrouter: ["or-gemini-3-5-pro"],
          },
        },
        defaults: { personal: ["anthropic-personal", "opus-5-5"] },
        dismissed: {},
        harness: {},
        accountDefaults: {},
      };
    }
    return {
      profiles: [
        { id: "personal", name: "Personal", accounts: ["anthropic-personal", "openai-personal", "zai", "opencode-go", "openrouter"] },
        { id: "work", name: "Work", accounts: ["anthropic-work", "openai-work", "openrouter"] },
        { id: "oss", name: "Open source", accounts: ["zai", "opencode-go", "openrouter"] },
        { id: "night", name: "Night runs", accounts: ["opencode-go", "zai"] },
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
          "openai-work": ["gpt-6-1-sol", "gpt-6-1-sol@pi", "daybreak"],
          openrouter: ["glm-5-3"],
        },
        oss: { zai: ["glm-5-3", "glm-5-3-flash"], "opencode-go": ["kimi-k3", "qwen-3-6-coder"], openrouter: ["deepseek-v4"] },
        night: { "opencode-go": ["kimi-k3", "minimax-m3"], zai: ["glm-5-3-flash"] },
      },
      defaults: { personal: ["anthropic-personal", "opus-5-5"], work: ["anthropic-work", "opus-5-5"], oss: ["zai", "glm-5-3"], night: ["opencode-go", "kimi-k3"] },
      dismissed: {},
      harness: { oss: { "opencode-go": "opencode" } },
      accountDefaults: {},
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
  function reset() { state = initial(); P.state = state; save(); }

  function profile(id) { return state.profiles.filter(function (p) { return p.id === id; })[0]; }
  function profileOf(project) { return profile(state.projects[project] || state.projects._new); }
  function projectsOf(id) {
    return {
      list: W.PROJECTS.filter(function (p) { return state.projects[p.id] === id; }).map(function (p) { return p.id; }),
      isNew: state.projects._new === id,
    };
  }
  function accountsIn(p) { return p.accounts.map(W.account).filter(Boolean); }
  function picksOf(pid, aid) {
    var m = state.picks[pid] = state.picks[pid] || {};
    return m[aid] = m[aid] || [];
  }
  function count(p) { return accountsIn(p).reduce(function (n, a) { return n + picksOf(p.id, a.id).length; }, 0); }
  function add(pid, aid, mid) { var l = picksOf(pid, aid); if (l.indexOf(mid) === -1) l.push(mid); save(); }
  function remove(pid, aid, mid) {
    var l = picksOf(pid, aid);
    var i = l.indexOf(mid);
    if (i !== -1) l.splice(i, 1);
    save();
  }
  function isDefault(pid, aid, mid) { var d = state.defaults[pid]; return d && d[0] === aid && d[1] === mid; }
  function setDefault(pid, aid, mid) { state.defaults[pid] = [aid, mid]; save(); }
  function moveProject(project, pid) { state.projects[project] = pid; save(); }
  /** Puts an account in a profile, or takes it out with its picks. Any account may sit in any number of profiles. */
  function toggleMember(pid, aid) {
    var p = profile(pid);
    var i = p.accounts.indexOf(aid);
    if (i === -1) p.accounts.push(aid);
    else { p.accounts.splice(i, 1); if (state.picks[pid]) delete state.picks[pid][aid]; }
    save();
  }
  function profilesUsing(aid) { return state.profiles.filter(function (p) { return p.accounts.indexOf(aid) !== -1; }); }

  /** Returns the models an account's vendor released lately that this profile has not decided on. */
  /* ---------------------------------------------------------------- harnesses */

  // A vendor's own harness, tried first when the order starts with "native".
  var NATIVE = { anthropic: "claude-code", openai: "codex" };
  var WHY = {
    "claude-code": "Claude Code runs Claude models only",
    codex: "Codex speaks only OpenAI's Responses API",
  };

  /** Splits a menu entry into its model and the harness it was moved to, if any ("gpt-6-1-sol@pi"). */
  function entry(e) { var parts = String(e).split("@"); return { id: parts[0], h: parts[1] || null }; }
  function hasModel(list, mid) { return list.some(function (e) { return entry(e).id === mid; }); }

  /** Returns every harness with whether this account can run in it, and why not. */
  function canRun(a) {
    return W.HARNESSES.map(function (h) {
      var ok = a.harnesses.indexOf(h.id) !== -1;
      var why = h.id === "claude-code" && a.vendor !== "anthropic" ? "Claude Code runs Claude models only" : a.only || WHY[h.id] || "Not supported";
      return { harness: h, ok: ok, why: ok ? "" : why };
    });
  }

  /**
   * Returns an account's default harness: the one picked in its sheet, else its vendor's own
   * (Claude Code, Codex), else pi, else the first it can run in. Every profile uses it unless the
   * account's line in that profile picks another.
   */
  function accountDefault(a) {
    var picked = state.accountDefaults && state.accountDefaults[a.id];
    if (picked && W.harness(picked) && a.harnesses.indexOf(picked) !== -1) return W.harness(picked);
    return suggested(a);
  }
  /** Returns what Hercule picks for an account when nobody has: its vendor's own harness, else pi. */
  function suggested(a) {
    var native = NATIVE[a.vendor];
    if (native && a.harnesses.indexOf(native) !== -1) return W.harness(native);
    if (a.harnesses.indexOf("pi") !== -1 && W.harness("pi")) return W.harness("pi");
    return W.HARNESSES.filter(function (h) { return a.harnesses.indexOf(h.id) !== -1; })[0];
  }
  function setAccountDefault(aid, hid) {
    state.accountDefaults = state.accountDefaults || {};
    state.accountDefaults[aid] = hid;
    save();
  }
  /** Returns why a harness is the one Hercule suggests for an account, in a few words, or "". */
  function suggestedReason(a, h) {
    if (suggested(a).id !== h.id) return "";
    return NATIVE[a.vendor] === h.id ? W.VENDORS[a.vendor].name + "'s own" : "Hercule's pick for accounts without one";
  }
  /** Returns the harness an account's models run in within a profile: its choice there, else the account's default. */
  function accountHarness(pid, aid) {
    var chosen = state.harness && state.harness[pid] && state.harness[pid][aid];
    var a = W.account(aid);
    // A pick of a harness that is gone, or that this account cannot run in, falls back to automatic.
    return chosen && W.harness(chosen) && a.harnesses.indexOf(chosen) !== -1 ? W.harness(chosen) : accountDefault(a);
  }
  function isAutoHarness(pid, aid) { return !(state.harness && state.harness[pid] && state.harness[pid][aid]); }
  function setAccountHarness(pid, aid, hid) {
    state.harness = state.harness || {};
    state.harness[pid] = state.harness[pid] || {};
    if (hid) state.harness[pid][aid] = hid;
    else delete state.harness[pid][aid];
    save();
  }
  /** Returns the harness one entry runs in: its own, else its account's in this profile. */
  function entryHarness(pid, aid, e) { var h = entry(e).h; return h && W.harness(h) ? W.harness(h) : accountHarness(pid, aid); }
  /** Moves one entry to another harness; the account's own harness puts it back in line. */
  function setEntryHarness(pid, aid, e, hid) {
    var l = picksOf(pid, aid);
    var i = l.indexOf(e);
    if (i === -1) return;
    var id = entry(e).id;
    var next = hid && hid !== accountHarness(pid, aid).id ? id + "@" + hid : id;
    if (l.indexOf(next) !== -1 && next !== e) l.splice(i, 1);
    else l[i] = next;
    save();
  }
  /** Adds a second entry of a model, run by another harness, right after the first. */
  function alsoOffer(pid, aid, e, hid) {
    var l = picksOf(pid, aid);
    var next = entry(e).id + "@" + hid;
    if (l.indexOf(next) !== -1) return;
    l.splice(l.indexOf(e) + 1, 0, next);
    save();
  }
  function moveOrder(from, to) {
    var o = state.order;
    var item = o.splice(from, 1)[0];
    o.splice(to, 0, item);
    save();
  }

  function news(pid, aid) {
    return R.offersOf(aid).filter(function (m) {
      return m.fresh && !hasModel(picksOf(pid, aid), m.id) && !state.dismissed[pid + "|" + aid + "|" + m.id];
    });
  }
  function dismiss(pid, aid, mid) { state.dismissed[pid + "|" + aid + "|" + mid] = true; save(); }

  /** Returns a profile's avatar: its initial in the UI face, on a quiet disc. */
  function avatar(p, size) {
    return '<span class="pav' + (size ? " pav--" + size : "") + '" aria-hidden="true">' + p.name.charAt(0) + "</span>";
  }

  /**
   * Returns the composer's model menu for a profile. The profile's accounts are open, each with
   * its usage; every other profile is one folded row, which `opts.open` unfolds. With
   * `opts.mode === "pick"` the other profiles are left out, because a pick of their own beside
   * the model chooses the profile.
   */
  function menuHTML(pid, opts) {
    opts = opts || {};
    var p = profile(pid);
    var q = (opts.query || "").trim().toLowerCase();
    var html = "";
    var any = false;
    accountsIn(p).forEach(function (a) {
      var rows = picksOf(p.id, a.id).map(W.catalogModel).filter(Boolean).filter(function (m) { return Pv.D.matches(m, q); });
      if (!rows.length) return;
      any = true;
      html +=
        '<div class="mw-sec" data-mw-acct="' + a.id + '">' +
        '<div class="mw-sh">' + mark(W.VENDORS[a.vendor].mark, 12) + "<span>" + W.accountName(a) + "</span>" + R.gauge(a) + "</div>" +
        rows.map(function (m) {
          var cur = opts.current ? opts.current[0] === a.id && opts.current[1] === m.id : isDefault(p.id, a.id, m.id);
          return '<button class="mw-row' + (cur ? " is-cur" : "") + (a.failed ? " is-dim" : "") + '"><b>' + m.name + "</b>" + (m.older ? "<small>older</small>" : "") + '<span class="mw-ok">' + (cur ? icon("check", 14) : "") + "</span></button>";
        }).join("") +
        "</div>";
    });
    if (!any) html += '<p class="md-none">' + (q ? "Nothing in " + p.name + " matches." : "Nothing in " + p.name + "'s menu yet.") + "</p>";
    if (opts.mode !== "pick") {
      var others = state.profiles.filter(function (x) { return x.id !== p.id; });
      if (others.length) {
        html += '<div class="md-sep"></div><div class="md-gh md-gh--other"><span>Other profiles</span></div>';
        html += others.map(function (o) {
          var open = (opts.open && opts.open[o.id]) || q;
          var rows = "";
          if (open) {
            accountsIn(o).forEach(function (a) {
              picksOf(o.id, a.id).map(W.catalogModel).filter(Boolean).filter(function (m) { return Pv.D.matches(m, q); }).forEach(function (m) {
                rows += '<button class="md-row md-row--in"><b>' + m.name + "<small>" + (a.label || W.VENDORS[a.vendor].name) + "</small></b><span class=\"md-ok\"></span></button>";
              });
            });
            if (q && !rows) return "";
          }
          return (
            '<button class="md-acct' + (open ? " is-open" : "") + '" data-other="' + o.id + '">' + avatar(o, "sm") +
            "<b>" + o.name + '</b><span class="md-n">' + count(o) + " model" + (count(o) === 1 ? "" : "s") + "</span>" +
            '<span class="md-chev">' + icon("chev-r", 12) + "</span></button>" + rows
          );
        }).join("");
      }
    }
    return html;
  }

  /** Returns a profile's own part of the menu: one section per account, its usage, its models in order. */
  function sectionsHTML(p, q, opts) {
    var html = "";
    accountsIn(p).forEach(function (a) {
      var entries = picksOf(p.id, a.id).filter(function (e) { var m = W.catalogModel(e); return m && Pv.D.matches(m, q); });
      if (!entries.length) return;
      html +=
        '<div class="mw-sec" data-mw-acct="' + a.id + '">' +
        '<div class="mw-sh">' + mark(W.VENDORS[a.vendor].mark, 12) + "<span>" + W.accountName(a) + ' <i class="mw-h">· ' + accountHarness(p.id, a.id).name + "</i></span>" + R.gauge(a) + "</div>" +
        entries.map(function (e) {
          var m = W.catalogModel(e), h = entry(e).h;
          var cur = opts.current ? opts.current[0] === p.id && opts.current[1] === a.id && opts.current[2] === e : opts.markDefault !== false && isDefault(p.id, a.id, e);
          return '<button class="mw-row' + (cur ? " is-cur" : "") + (a.failed ? " is-dim" : "") + (opts.fresh === p.id + "|" + a.id + "|" + e ? " is-fresh" : "") + '"><b>' + m.name + (h ? ' <small class="mw-in">in ' + W.harness(h).name + "</small>" : "") + "</b>" + (m.older ? "<small>older</small>" : "") + '<span class="mw-ok">' + (cur ? icon("check", 14) : "") + "</span></button>";
        }).join("") +
        "</div>";
    });
    return html;
  }

  /**
   * Returns the composer's model menu as an accordion: every profile is a head, in a fixed
   * order, and only one is open, so a model is never far from the name of the profile it
   * belongs to. Opening another profile closes the one before. With one profile there are no
   * heads. While searching, every profile with a match is open.
   */
  function accordionHTML(openId, opts) {
    opts = opts || {};
    var q = (opts.query || "").trim().toLowerCase();
    if (state.profiles.length === 1) {
      var only = sectionsHTML(state.profiles[0], q, opts);
      return only || '<p class="md-none">' + (q ? "No model matches." : "Nothing in the menu yet.") + "</p>";
    }
    var html = state.profiles.map(function (p) {
      var body = sectionsHTML(p, q, opts);
      var open = q ? !!body : p.id === openId;
      if (q && !body) return "";
      return (
        '<div class="ac' + (open ? " is-open" : "") + '">' +
        '<button class="ac-h" data-ac="' + p.id + '" aria-expanded="' + open + '">' + avatar(p, "sm") + "<b>" + p.name + '</b><span class="md-n">' + count(p) + '</span><span class="md-chev">' + icon("chev-r", 12) + "</span></button>" +
        (open ? '<div class="ac-b">' + (body || '<p class="md-none">Nothing in ' + p.name + "'s menu yet.</p>") + "</div>" : "") +
        "</div>"
      );
    }).join("");
    return html || '<p class="md-none">No model matches.</p>';
  }

  /** Makes a profile, empty or as a copy of another one's accounts and menu; returns its id. */
  function createProfile(name, fromId) {
    var id = "p" + Date.now().toString(36);
    var from = fromId && profile(fromId);
    state.profiles.push({ id: id, name: name, accounts: from ? from.accounts.slice() : [] });
    state.picks[id] = {};
    if (from) {
      Object.keys(state.picks[from.id] || {}).forEach(function (aid) { state.picks[id][aid] = state.picks[from.id][aid].slice(); });
      if (state.defaults[from.id]) state.defaults[id] = state.defaults[from.id].slice();
    }
    save();
    return id;
  }
  function renameProfile(id, name) { profile(id).name = name; save(); }
  function deleteProfile(id) {
    state.profiles = state.profiles.filter(function (p) { return p.id !== id; });
    delete state.picks[id];
    P.state = state;
    save();
  }

  /** Returns the add picker's list for one account: its models by family, newest first, the rest folded. */
  function pickerList(pid, aid, q, unfold) {
    q = (q || "").trim().toLowerCase();
    var picks = picksOf(pid, aid);
    var all = R.offersOf(aid).filter(function (m) { return Pv.D.matches(m, q); });
    if (!all.length) return '<p class="md-none">No model matches.</p>';
    var cap = 60, shown = 0;
    var html = FAMILY_ORDER.map(function (f) {
      var fam = all.filter(function (m) { return m.family === f; });
      if (!fam.length) return "";
      var fold = !q && !unfold[f];
      var visible = fold ? fam.filter(function (m) { return !m.older; }).slice(0, 4) : fam;
      visible = visible.slice(0, Math.max(0, cap - shown));
      shown += visible.length;
      var hidden = fam.length - visible.length;
      return (
        '<div class="pk-fam">' + f + " <small>" + fam.length + "</small></div>" +
        visible.map(function (m) {
          var on = hasModel(picks, m.id);
          return '<button class="pk-row' + (on ? " is-on" : "") + '" data-pick="' + m.id + '"><b>' + m.name + "</b><small>" + (m.fresh ? '<span class="pk-new">New</span>' : "") + (m.tier || (m.older ? "older" : m.meta || "")) + '</small><span class="mw-ok">' + (on ? icon("check", 14) : "") + "</span></button>";
        }).join("") +
        (hidden > 0 && fold ? '<button class="pk-more" data-unfold="' + f + '">' + icon("chev-r", 11) + hidden + " more " + f + "</button>" : "")
      );
    }).join("");
    if (q && all.length > cap) html += '<p class="md-none">' + (all.length - cap) + " more match. Type a little more.</p>";
    return html;
  }

  var P = {
    groups: function () { return state.profiles; }, noun: "Profiles", oneVendor: false,
    toggleMember: toggleMember, profilesUsing: profilesUsing,
    state: state, save: save, reset: reset,
    profile: profile, profileOf: profileOf, projectsOf: projectsOf, accountsIn: accountsIn, picksOf: picksOf,
    count: count, add: add, remove: remove, isDefault: isDefault, setDefault: setDefault, moveProject: moveProject,
    news: news, dismiss: dismiss, avatar: avatar, menuHTML: menuHTML, pickerList: pickerList,
    sectionsHTML: sectionsHTML, accordionHTML: accordionHTML,
    entry: entry, hasModel: hasModel, canRun: canRun, accountHarness: accountHarness,
    isAutoHarness: isAutoHarness, setAccountHarness: setAccountHarness, entryHarness: entryHarness,
    accountDefault: accountDefault, setAccountDefault: setAccountDefault, suggestedReason: suggestedReason,
    setEntryHarness: setEntryHarness, alsoOffer: alsoOffer, moveOrder: moveOrder,
    createProfile: createProfile, renameProfile: renameProfile, deleteProfile: deleteProfile,
  };
  window.Pv.P3 = P;
})();
