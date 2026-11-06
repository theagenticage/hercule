// How things relate, and nothing about any one system. Two relations exist: part of, which points upward and can have many parents,
// and linked, between peers. Every claim says who makes it. The page reads this module and never asks what a thing is called.
window.Relations = (function () {
  var K = Kinds.KINDS;
  var things = {};    // every entity by id, cards and context alike
  var claims = [];

  /** Takes in the entities and claims of a scene. */
  function load(entities, contexts, relations) {
    things = {};
    entities.concat(contexts).forEach(function (e) { things[e.id] = e; });
    claims = relations;
  }

  /** Adds an entity that arrived after the scene was loaded. */
  function note(e) { things[e.id] = e; }

  function find(id) { return things[id]; }

  /** Returns the things this one is directly part of, in the order the source reports them. */
  function readParents(e) {
    return claims.filter(function (c) { return c.rel === 'part-of' && c.from === e.id; }).map(function (c) { return things[c.to]; }).filter(Boolean);
  }

  /** Returns everything above a thing, on every path, each once, nearest first. */
  function readAncestors(e) {
    var seen = {}, out = [], queue = readParents(e);
    seen[e.id] = true;  // a bad report can make a loop, and a thing is never its own ancestor
    while (queue.length) {
      var p = queue.shift();
      if (seen[p.id]) continue;
      seen[p.id] = true;
      out.push(p);
      queue = queue.concat(readParents(p));
    }
    return out;
  }

  /** Returns the things under a place that concern the person, at any depth. */
  function readChildren(context) {
    return Object.keys(things).map(function (id) { return things[id]; }).filter(function (e) {
      return e.concern && !e.dismissed && readAncestors(e).indexOf(context) >= 0;
    });
  }

  /** Returns the places a thing is usually shown under: everything above it of a kind its table names as home. A thing can have several. */
  function readHomes(e) {
    var homes = [].concat(K[e.kind].home || []);
    return readAncestors(e).filter(function (p) { return homes.indexOf(p.kind) >= 0; });
  }

  /**
   * Returns the links of a thing, one for each other end, however many claims there are. The firmest claim speaks for the pair: a
   * source, then a person, then a reference in text. The other end is missing only when the claim says it is hidden from the person.
   */
  function readLinks(e) {
    var byOther = {}, order = [], strength = { source: 3, person: 2, text: 1 };
    claims.forEach(function (c) {
      if (c.rel !== 'linked' || c.dropped || (c.from !== e.id && c.to !== e.id)) return;
      var otherId = c.from === e.id ? c.to : c.from;
      var other = things[otherId] || null;
      if (other && other.dismissed) return;
      if (!other && !c.claim.hidden) return;
      if (!byOther[otherId]) { byOther[otherId] = { other: other, otherId: otherId, claims: [] }; order.push(otherId); }
      byOther[otherId].claims.push(c);
    });
    return order.map(function (id) {
      var l = byOther[id];
      var best = l.claims.slice().sort(function (a, b) { return strength[b.claim.type] - strength[a.claim.type]; })[0];
      l.relation = best;
      l.claim = best.claim;
      l.byPerson = l.claims.filter(function (c) { return c.claim.type === 'person'; })[0] || null;
      return l;
    });
  }

  /** Returns whether a claim is firm enough to put two things together: the source says so, or a person does. A reference in text is only a hint. */
  function isConfirmed(claim) { return claim.type === 'source' || claim.type === 'person'; }

  /** Returns the links of a thing that join it to others on the page. */
  function readConfirmed(e) { return readLinks(e).filter(function (l) { return isConfirmed(l.claim); }); }

  /** Returns the references found in text that nobody has confirmed. */
  function readHints(e) { return readLinks(e).filter(function (l) { return l.claim.type === 'text' && l.other; }); }

  /** Returns whether a hint runs from this thing, which is the one whose text holds the reference. */
  function isMentioner(hint, e) { return hint.relation.from === e.id; }

  /** Returns the places directly under a place, for the bigger picture. */
  function readChildPlaces(place) {
    return claims.filter(function (c) { return c.rel === 'part-of' && c.to === place.id && things[c.from] && !things[c.from].concern; }).map(function (c) { return things[c.from]; });
  }

  /** Returns a sentence saying who claims a link. */
  function sayClaim(claim) {
    if (claim.type === 'person') return (claim.by === 'you' ? World.PEOPLE.you.name : (World.PEOPLE[claim.by] || { short: claim.by }).short) + ' linked this';
    if (claim.type === 'text') return 'Found in ' + claim.evidence;
    return claim.by + ' reports this';
  }

  /** Returns how to name something the person cannot open. The source says what kind of thing it is, and nothing more. */
  function sayRestricted(claim) {
    var kind = K[claim.hidden];
    var word = kind.noun.toLowerCase();
    return (/^[aeiou]/i.test(kind.plugin.name) ? 'An ' : 'A ') + kind.plugin.name + ' ' + word + ' you cannot open';
  }

  /** Links two things by hand. A hint between them turns into a person's claim. Returns what undoes it. */
  function linkByHand(a, b) {
    var claim = { type: 'person', by: 'you', at: World.NOW };
    var hint = claims.filter(function (c) { return c.rel === 'linked' && !c.dropped && c.claim.type === 'text' && ((c.from === a.id && c.to === b.id) || (c.from === b.id && c.to === a.id)); })[0];
    if (hint) {
      var was = hint.claim;
      hint.claim = claim;
      return function () { hint.claim = was; };
    }
    var made = { from: a.id, rel: 'linked', to: b.id, claim: claim };
    claims.push(made);
    return function () { claims.splice(claims.indexOf(made), 1); };
  }

  /** Takes a claim back here. The source is not told. Returns what undoes it. */
  function drop(relation) {
    relation.dropped = true;
    return function () { relation.dropped = false; };
  }

  /** Records a claim that arrived after the scene was loaded. */
  function addClaim(claim) { claims.push(claim); }

  /** Returns how much of its patience a thing has used, so the most pressing part of a group can lead. */
  function readPressure(e) {
    var kind = K[e.kind];
    return (World.NOW - e.since) / 36e5 / Math.max(1, kind.patience);
  }

  /**
   * Returns the bundles of the page. Each lasting thing is a lead, always under its own places, so a peer link never pulls it out of
   * them. A small thing with a firm link rides on the lasting thing it is linked to, and only one: on any other it shows as a quiet
   * row. Two lasting things linked to each other stay two rows, each showing the other quietly. Only direct links join.
   */
  function buildBundles(list) {
    var rich = function (e) { return K[e.kind].card === 'rich'; };
    var taken = {}, leads = list.filter(rich), out = {};
    leads.slice().sort(function (a, b) { return readPressure(b) - readPressure(a); }).forEach(function (lead) {
      out[lead.id] = { lead: lead, parts: readConfirmed(lead).map(function (l) {
        if (!l.other) return { restricted: true, link: l };
        var rides = !rich(l.other) && !taken[l.other.id] && list.indexOf(l.other) >= 0;
        if (rides) taken[l.other.id] = true;
        return { e: l.other, link: l, rides: rides };
      }) };
    });
    return list.filter(function (e) { return !taken[e.id]; }).map(function (e) {
      return out[e.id] || { lead: e, parts: [], peers: readConfirmed(e).filter(function (l) { return l.other; }) };
    });
  }

  return { load: load, note: note, find: find, readParents: readParents, readAncestors: readAncestors, readChildren: readChildren, readHomes: readHomes, readLinks: readLinks, readConfirmed: readConfirmed, readHints: readHints, isMentioner: isMentioner, readChildPlaces: readChildPlaces, isConfirmed: isConfirmed, sayClaim: sayClaim, sayRestricted: sayRestricted, linkByHand: linkByHand, drop: drop, addClaim: addClaim, buildBundles: buildBundles };
})();
