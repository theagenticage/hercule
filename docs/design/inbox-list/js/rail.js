// PROTOTYPE - the rail: saved queries with no heading, Triage, the user's pins, and Browse, each
// source's own structure from the facets its plugin declares. A click sets the list's scope.
window.Rail = (function () {
  "use strict";
  var K = Kinds, D = Draw;
  var moreOpen = new Set();
  var STAR = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.2l-3.53 1.85.7-3.93L2.3 6.35l3.95-.55z"/></svg>';

  function isOn(state, scope) {
    if (state.search.text || state.search.clauses.length) return false;
    return JSON.stringify(state.scope) === JSON.stringify(scope);
  }

  function row(attrs, inner, on) {
    return '<button type="button" class="rl-row' + (attrs.cls ? " " + attrs.cls : "") + (on ? " is-on" : "") + '" data-scope="' + D.esc(JSON.stringify(attrs.scope)) + '"' + (on ? ' aria-current="true"' : "") + (attrs.title ? ' title="' + D.esc(attrs.title) + '"' : "") + ">" + inner + "</button>";
  }
  var loading = false;
  function count(n, cls) { return '<span class="rl-n' + (cls ? " " + cls : "") + '">' + (loading ? '<span class="skel-n"></span>' : n ? D.num(n) : "") + "</span>"; }

  function browseScope(source, account, field, value) {
    var clauses = [{ key: field, value: value, source: source }];
    if (account) clauses[0].account = account;
    return { browse: { source: source, account: account || null, field: field, value: value }, clauses: clauses };
  }
  function isPinned(state, p) {
    return state.pins.some(function (x) { return x.source === p.source && (x.account || null) === (p.account || null) && x.field === p.field && x.value === p.value; });
  }

  function valueRow(state, source, account, f, v, projects) {
    var scope = browseScope(source, account, f.field, v.value);
    var pinned = isPinned(state, { source: source, account: account, field: f.field, value: v.value });
    var hl = "";
    if (f.health) { var p = projects.find(function (x) { return x.name === v.value; }); if (p) hl = D.health(p.health); }
    var pin = '<span class="rl-star' + (pinned ? " is-on" : "") + '" role="button" tabindex="-1" data-pin="' + D.esc(JSON.stringify({ source: source, account: account, field: f.field, value: v.value })) + '" title="' + (pinned ? "Unpin from the rail" : "Pin to the rail") + '" aria-label="' + (pinned ? "Unpin " : "Pin ") + D.esc(v.value) + '">' + STAR + "</span>";
    return row({ scope: scope, cls: "rl-row--val" + (v.n ? "" : " is-empty"), title: v.n ? null : "Nothing of yours here yet" }, '<span class="rl-ic">' + hl + '</span><span class="rl-name">' + D.esc(v.value) + "</span>" + pin + count(v.n), isOn(state, scope));
  }

  function facetBlock(state, source, account, f, projects) {
    var known = f.known === "projects" ? projects.map(function (p) { return p.name; }) : null;
    var values = Model.facetValues(source, f.field, account, known);
    if (!values.length) return "";
    var id = source + "/" + (account || "") + "/" + f.field;
    var limit = moreOpen.has(id) ? values.length : 6;
    var html = '<p class="rl-facet">' + D.esc(K.FIELDS[f.field].plural || K.FIELDS[f.field].label) + "</p>";
    values.slice(0, limit).forEach(function (v) { html += valueRow(state, source, account, f, v, projects); });
    if (values.length > 6) html += '<button type="button" class="rl-more" data-more="' + D.esc(id) + '">' + (moreOpen.has(id) ? "Show fewer" : (values.length - 6) + " more") + "</button>";
    return html;
  }

  function draw(host, state) {
    loading = state.loading;
    var html = "";
    var projects = World.projects(state.load);
    var core = K.SAVED.filter(function (s) { return !s.source; });
    var plugin = K.SAVED.filter(function (s) { return s.source; });
    html += '<div class="rl-group">';
    core.forEach(function (s, i) {
      var scope = { saved: s.id };
      html += row({ scope: scope, title: s.name + " (" + (i + 1) + ")" }, '<span class="rl-ic">' + D.icon(s.icon, 16) + '</span><span class="rl-name">' + D.esc(s.name) + "</span>" + count(Model.countSaved(s.id)), isOn(state, scope));
    });
    plugin.forEach(function (s, i) {
      var scope = { saved: s.id };
      html += row({ scope: scope, title: s.name + " (" + (core.length + i + 1) + ")" }, '<span class="rl-ic">' + D.mark(s.source, 16) + '</span><span class="rl-name">' + D.esc(s.name) + "</span>" + count(Model.countSaved(s.id)), isOn(state, scope));
    });
    html += "</div>";

    var tn = loading ? 0 : Model.countTriage();
    html += '<div class="rl-group">' + row({ scope: { triage: 1 }, cls: "rl-row--triage", title: "Proposals and links Hercule suggests" }, '<span class="rl-ic">' + D.icon("sparkle", 16) + '</span><span class="rl-name">Triage</span>' + (tn ? '<b class="count count--you rl-badge">' + tn + "</b>" : count(0)), isOn(state, { triage: 1 })) + "</div>";

    if (state.pins.length) {
      html += '<h3 class="rl-h">Pinned</h3><div class="rl-group">';
      state.pins.forEach(function (p) {
        var scope = browseScope(p.source, p.account, p.field, p.value);
        var n = Model.facetValues(p.source, p.field, p.account).find(function (v) { return v.value === p.value; });
        var accounts = Model.accountsOf(p.source);
        var suffix = accounts.length > 1 && p.account ? '<span class="rl-acct-in"> · ' + D.esc(p.account) + "</span>" : "";
        html += row({ scope: scope, cls: "rl-row--pin" }, '<span class="rl-ic">' + D.mark(p.source, 16) + '</span><span class="rl-name">' + D.esc(p.value) + suffix + '</span><span class="rl-star is-on" role="button" tabindex="-1" data-pin="' + D.esc(JSON.stringify(p)) + '" title="Unpin from the rail" aria-label="Unpin ' + D.esc(p.value) + '">' + STAR + "</span>" + count(n ? n.n : 0), isOn(state, scope));
      });
      html += "</div>";
    }

    html += '<h3 class="rl-h">Browse</h3>';
    Object.keys(K.BROWSE).forEach(function (source) {
      var n = Model.countSource(source);
      var accounts = Model.accountsOf(source);
      if (!n && !accounts.length) return;
      var open = !state.folded.has(source);
      var failing = state.failing === source;
      html += '<div class="rl-src' + (open ? " is-open" : "") + '">';
      html += '<button type="button" class="rl-row rl-row--src" data-fold="' + source + '" aria-expanded="' + open + '"><span class="rl-ic">' + D.mark(source, 16) + '</span><span class="rl-name">' + D.esc(K.SOURCES[source].name) + "</span>" + (failing ? '<span class="rl-warn" title="Can\'t be read since 08:40">' + D.icon("alert", 14) + "</span>" : "") + count(n) + '<span class="rl-chev">' + D.icon("chevron-right", 12) + "</span></button>";
      if (open) {
        html += '<div class="rl-src-body">';
        if (accounts.length > 1) {
          accounts.forEach(function (a) {
            html += '<p class="rl-acct"><span class="rl-ic">' + D.icon("connections", 14) + '</span><span class="rl-name">' + D.esc(a.label) + "</span>" + count(a.n) + "</p>";
            K.BROWSE[source].forEach(function (f) { html += facetBlock(state, source, a.label, f, projects); });
          });
        } else {
          K.BROWSE[source].forEach(function (f) { html += facetBlock(state, source, null, f, projects); });
        }
        html += "</div>";
      }
      html += "</div>";
    });
    host.innerHTML = html;
  }

  function start(host) {
    host.addEventListener("click", function (e) {
      var pin = e.target.closest("[data-pin]");
      var s = App.state;
      if (pin) {
        e.stopPropagation();
        var p = JSON.parse(pin.dataset.pin);
        if (!p.account) delete p.account;
        var i = s.pins.findIndex(function (x) { return x.source === p.source && (x.account || null) === (p.account || null) && x.field === p.field && x.value === p.value; });
        if (i >= 0) s.pins.splice(i, 1); else s.pins.push(p);
        Rail.draw(host, s);
        return;
      }
      var more = e.target.closest("[data-more]");
      if (more) { var id = more.dataset.more; if (moreOpen.has(id)) moreOpen.delete(id); else moreOpen.add(id); Rail.draw(host, s); return; }
      var fold = e.target.closest("[data-fold]");
      if (fold) { var src = fold.dataset.fold; if (s.folded.has(src)) s.folded.delete(src); else s.folded.add(src); Rail.draw(host, s); return; }
      var r = e.target.closest("[data-scope]");
      if (r) Moves.setScope(JSON.parse(r.dataset.scope));
    });
  }

  return { draw: draw, start: start, browseScope: browseScope };
})();
