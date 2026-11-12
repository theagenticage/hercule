// PROTOTYPE - what the controller works out on read: which things a saved query holds, the counts
// on the rail, the groups linked things make, and the order of the list. Views only read from here.
window.Model = (function () {
  "use strict";
  var K = Kinds;
  var ASKING = { review: 1, mention: 1, checks: 1, asked: 1, regressed: 1, signoff: 1 };

  var world = null; // { things, links, triage }
  var byId = new Map();
  var gone = new Set(); // handled this visit: dismissed, taken on, handed off, or answered

  function load(w) {
    world = w;
    byId = new Map(w.things.map(function (t) { return [t.id, t]; }));
    // Cleared, never replaced: Model.gone is the same Set for the life of the page.
    gone.clear();
  }

  function sourceOf(t) { return K.KINDS[t.kind].source; }
  function openSignals(t) { return t.signals.filter(function (s) { return !s.done; }); }
  function askingSignals(t) { return openSignals(t).filter(function (s) { return ASKING[s.kind]; }); }
  function asks(t) { return askingSignals(t).length > 0; }
  /** Returns how long the oldest open ask on a thing has waited, in minutes, or null when nothing asks. */
  function waitOf(t) {
    var a = askingSignals(t);
    return a.length ? Math.max.apply(null, a.map(function (s) { return s.at; })) : null;
  }
  function isLive(t) { return !gone.has(t.id) && !t.dismissed; }
  function live() { return world.things.filter(isLive); }

  /** Checks whether a thing answers a saved query's declared clauses. */
  function inSaved(t, q) {
    if (q.asks === 1 && !asks(t)) return false;
    if (q.asks === 0 && asks(t)) return false;
    if (q.held === 1 && !t.held) return false;
    if (q.held === 0 && t.held) return false;
    if (q.mine && !t.mine) return false;
    if (q.kind && t.kind !== q.kind) return false;
    if (q.signal && !openSignals(t).some(function (s) { return s.kind === q.signal; })) return false;
    return true;
  }

  /** Reads a field of a thing as the search bar and Browse see it. Core fields are worked out; the rest are declared. */
  function readField(t, key) {
    if (key === "source") return K.SOURCES[sourceOf(t)].name;
    if (key === "kind") return K.KINDS[t.kind].noun;
    if (key === "account") return t.account;
    if (key === "from") {
      var a = askingSignals(t)[0];
      return t.fields.from || t.fields.author || (a && a.by) || t.fields.assignee || null;
    }
    if (key === "waiting") return waitOf(t);
    return t.fields[key] == null ? null : t.fields[key];
  }

  var UNITS = { m: 1, h: 60, d: 1440, w: 10080 };
  /** Checks one search clause against a thing: `team:Checkout`, `events:>1000`, `waiting:>2d`. */
  function matchClause(t, c) {
    if (c.source && sourceOf(t) !== c.source) return false;
    if (c.account && t.account !== c.account) return false;
    var v = readField(t, c.key);
    if (v == null) return false;
    var m = /^([<>])(\d+(?:\.\d+)?)([mhdw]?)$/.exec(c.value);
    if (m) {
      var n = Number(m[2]) * (UNITS[m[3]] || 1);
      return m[1] === ">" ? Number(v) > n : Number(v) < n;
    }
    return String(v).toLowerCase() === String(c.value).toLowerCase();
  }
  function matchText(t, text) {
    if (!text) return true;
    var hay = (t.title + " " + (t.key || "") + " " + (t.number ? "#" + t.number : "") + " " + Object.values(t.fields).join(" ")).toLowerCase();
    return text.toLowerCase().split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  /** Returns the things a scope holds: a saved query, or the clauses of a Browse value, plus the search. */
  function find(scope, search) {
    var q = scope.saved ? K.SAVED.find(function (s) { return s.id === scope.saved; }).q : null;
    return live().filter(function (t) {
      if (q && !inSaved(t, q)) return false;
      if (scope.clauses && !scope.clauses.every(function (c) { return matchClause(t, c); })) return false;
      if (search && search.clauses && !search.clauses.every(function (c) { return matchClause(t, c); })) return false;
      if (search && !matchText(t, search.text)) return false;
      return true;
    });
  }

  // ---- Groups: every set of things linked to each other, by a source or a person ----
  /** Returns the groups of live things: each a set of two or more things joined by links, directly or through others. */
  function decideGroups() {
    var parent = new Map();
    function root(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
    live().forEach(function (t) { parent.set(t.id, t.id); });
    world.links.forEach(function (l) {
      if (parent.has(l[0]) && parent.has(l[1])) parent.set(root(l[0]), root(l[1]));
    });
    var sets = new Map();
    parent.forEach(function (_, id) { var r = root(id); if (!sets.has(r)) sets.set(r, []); sets.get(r).push(byId.get(id)); });
    var groups = [];
    sets.forEach(function (members) {
      if (members.length < 2) return;
      var lead = members.slice().sort(function (a, b) { return K.KINDS[b.kind].lasting - K.KINDS[a.kind].lasting || b.opened - a.opened; })[0];
      groups.push({ id: "g:" + lead.id, lead: lead, members: members, label: lead.title });
    });
    return groups;
  }
  function groupOf(id) { return decideGroups().find(function (g) { return g.members.some(function (m) { return m.id === id; }); }) || null; }
  function linksOf(id) {
    return world.links.filter(function (l) { return l[0] === id || l[1] === id; }).map(function (l) {
      var other = byId.get(l[0] === id ? l[1] : l[0]);
      return { other: other, claim: l[2] };
    }).filter(function (x) { return x.other && isLive(x.other); });
  }

  // ---- Triage ----
  function triageLive() {
    return world.triage.filter(function (x) { return !gone.has(x.id) && x.things.every(function (id) { return byId.has(id); }); });
  }

  /** Orders things the way a saved query says: longest waiting first, or newest first. */
  function sortKey(order) {
    return order === "waiting"
      ? function (t) { var w = waitOf(t); return w == null ? -t.updated / 1e6 : w; }
      : function (t) { return -t.updated; };
  }

  /**
   * Builds the list's rows for a scope: triage at the top where the saved query asks for it, then
   * things and whole groups, ordered by the saved query. A group stands where its best member would,
   * and holds every live member, so nothing is torn from what it is linked to. Counts count things.
   */
  function buildRows(scope, search) {
    var saved = scope.saved ? K.SAVED.find(function (s) { return s.id === scope.saved; }) : null;
    var order = scope.triage ? "newest" : saved ? saved.order : "waiting";
    var key = sortKey(order);
    var rows = [];
    var searching = search && (search.text || search.clauses.length);
    if (scope.triage || (saved && saved.triage && !searching)) {
      var tl = triageLive().slice().sort(function (a, b) { return a.at - b.at; });
      // At the top of a saved query, triage keeps three rows, so it never pushes the list below the fold.
      var cap = scope.triage ? tl.length : 3;
      tl.slice(0, cap).forEach(function (x) { rows.push({ type: x.type, key: "t:" + x.id, item: x, things: x.things.map(function (id) { return byId.get(id); }) }); });
      if (tl.length > cap) rows.push({ type: "tmore", key: "tm", n: tl.length - cap });
    }
    if (scope.triage) return { rows: rows, count: rows.length, order: order };
    var found = find(scope, search);
    var inFound = new Set(found.map(function (t) { return t.id; }));
    var groups = decideGroups();
    var placed = new Set();
    var units = [];
    groups.forEach(function (g) {
      var hits = g.members.filter(function (m) { return inFound.has(m.id); });
      if (!hits.length) return;
      g.members.forEach(function (m) { placed.add(m.id); });
      var best = hits.slice().sort(function (a, b) { return key(b) - key(a); })[0];
      units.push({ type: "group", key: "g:" + g.lead.id, group: g, hits: hits, best: best, sort: key(best) });
    });
    found.forEach(function (t) {
      if (placed.has(t.id)) return;
      units.push({ type: "thing", key: "r:" + t.id, thing: t, sort: key(t) });
    });
    units.sort(function (a, b) { return b.sort - a.sort; });
    return { rows: rows.concat(units), count: found.length, order: order, triage: rows.length };
  }

  // ---- Counts, for the rail ----
  function countSaved(id) {
    var s = K.SAVED.find(function (x) { return x.id === id; });
    return live().filter(function (t) { return inSaved(t, s.q); }).length;
  }
  function countTriage() { return triageLive().length; }

  /** Lists a facet's values for one source and account, with counts: values with things first, then known ones with none. */
  function facetValues(source, field, account, known) {
    var counts = new Map();
    live().forEach(function (t) {
      if (sourceOf(t) !== source) return;
      if (account && t.account !== account) return;
      var v = t.fields[field];
      if (v == null) return;
      counts.set(v, (counts.get(v) || 0) + 1);
    });
    var out = Array.from(counts, function (e) { return { value: e[0], n: e[1] }; }).sort(function (a, b) { return b.n - a.n || String(a.value).localeCompare(String(b.value)); });
    (known || []).forEach(function (v) { if (!counts.has(v)) out.push({ value: v, n: 0 }); });
    return out;
  }
  function accountsOf(source) {
    var seen = new Map();
    live().forEach(function (t) { if (sourceOf(t) === source) seen.set(t.account, (seen.get(t.account) || 0) + 1); });
    return Array.from(seen, function (e) { return { label: e[0], n: e[1] }; });
  }
  function countSource(source) { return live().filter(function (t) { return sourceOf(t) === source; }).length; }

  /** Lists the workflows that can take a thing, with what each would end and leave open. */
  function offersFor(t) {
    if (!t) return [];
    var open = openSignals(t);
    return Object.keys(World.WORKFLOWS).map(function (id) {
      var w = World.WORKFLOWS[id];
      if (w.takes.indexOf(t.kind) < 0) return null;
      if (w.when && t.status !== w.when) return { id: id, w: w, off: "Its checks pass, so there is nothing to fix." };
      var ends = open.filter(function (s) { return w.ends.indexOf(s.kind) >= 0; }).map(function (s) { return K.SIGNALS[s.kind].ends; });
      var leaves = open.filter(function (s) { return ASKING[s.kind] && w.ends.indexOf(s.kind) < 0; }).map(function (s) { return K.SIGNALS[s.kind].ends.toLowerCase(); });
      var line = ends.length ? "Ends " + ends.join(" and ") + "." : "Ends nothing: the asks stay open.";
      if (ends.length && leaves.length) line += " Leaves the " + leaves.join(" and ") + " open.";
      return { id: id, w: w, line: line };
    }).filter(Boolean);
  }

  return {
    load: load, add: function (t) { world.things.push(t); byId.set(t.id, t); }, byId: function (id) { return byId.get(id); }, all: function () { return world.things; }, live: live,
    gone: gone, links: function () { return world.links; }, triage: function () { return world.triage; },
    sourceOf: sourceOf, openSignals: openSignals, askingSignals: askingSignals, asks: asks, waitOf: waitOf, readField: readField,
    find: find, buildRows: buildRows, decideGroups: decideGroups, groupOf: groupOf, linksOf: linksOf, triageLive: triageLive,
    countSaved: countSaved, countTriage: countTriage, facetValues: facetValues, accountsOf: accountsOf, countSource: countSource,
    offersFor: offersFor, matchClause: matchClause, isLive: isLive,
  };
})();
