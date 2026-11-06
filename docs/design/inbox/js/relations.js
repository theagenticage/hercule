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

  /** Adds or forgets an entity that arrived or left after the scene was loaded. */
  function note(e) { things[e.id] = e; }

  function find(id) { return things[id]; }

  /** Returns the things this one is directly part of, in the order the source reports them. */
  function readParents(e) {
    return claims.filter(function (c) { return c.rel === 'part-of' && c.from === e.id; }).map(function (c) { return things[c.to]; }).filter(Boolean);
  }

  /** Returns everything above a thing, on every path, each once, nearest first. */
  function readAncestors(e) {
    var seen = {}, out = [], queue = readParents(e);
    while (queue.length) {
      var p = queue.shift();
      if (seen[p.id]) continue;
      seen[p.id] = true;
      out.push(p);
      queue = queue.concat(readParents(p));
    }
    return out;
  }

  /** Returns the things directly under a context that concern the person. */
  function readChildren(context) {
    return Object.keys(things).map(function (id) { return things[id]; }).filter(function (e) {
      return e.concern && readAncestors(e).indexOf(context) >= 0;
    });
  }

  /** Returns the places a thing is usually shown under: its parents of the kind its own table names as home. A thing can have several. */
  function readHomes(e) {
    var home = K[e.kind].home;
    return readParents(e).filter(function (p) { return p.kind === home; });
  }

  /** Returns the link a claim makes from one end, with the other end. The other end may be something the person cannot see. */
  function readLinks(e) {
    return claims.filter(function (c) { return c.rel === 'linked' && (c.from === e.id || c.to === e.id) && !c.dropped; }).map(function (c) {
      var other = c.from === e.id ? c.to : c.from;
      return { claim: c.claim, relation: c, other: things[other] || null, otherId: other };
    });
  }

  /** Returns whether a claim is firm enough to put two things together: the source says so, or a person does. A reference in text is only a hint. */
  function isConfirmed(claim) { return claim.type === 'source' || claim.type === 'person'; }

  /** Returns the links of a thing that join it to others on the page. */
  function readConfirmed(e) { return readLinks(e).filter(function (l) { return isConfirmed(l.claim); }); }

  /** Returns the references found in text that nobody has confirmed. */
  function readHints(e) { return readLinks(e).filter(function (l) { return l.claim.type === 'text' && l.other; }); }

  /** Returns a sentence saying who claims a link. */
  function sayClaim(claim) {
    if (claim.type === 'person') return (claim.by === 'you' ? 'You' : World.PEOPLE[claim.by].short) + ' linked these';
    if (claim.type === 'text') return 'Found in ' + claim.evidence;
    return 'Reported by ' + claim.by;
  }

  /** Links two things by hand. A hint between them turns into a person's claim. */
  function linkByHand(a, b) {
    var hint = claims.filter(function (c) { return c.rel === 'linked' && c.claim.type === 'text' && ((c.from === a.id && c.to === b.id) || (c.from === b.id && c.to === a.id)); })[0];
    var claim = { type: 'person', by: 'you', at: World.NOW };
    if (hint) { hint.was = hint.claim; hint.claim = claim; return hint; }
    var made = { from: a.id, rel: 'linked', to: b.id, claim: claim, byHand: true };
    claims.push(made);
    return made;
  }

  /** Takes a link back. Dropping a claim hides it here, and the source is not told. */
  function drop(relation) { relation.dropped = true; }

  /** Puts a claim back as it stood before a person changed it. */
  function restore(relation) {
    relation.dropped = false;
    if (relation.was) { relation.claim = relation.was; relation.was = null; }
    else if (relation.byHand) claims.splice(claims.indexOf(relation), 1);
  }

  /** Returns how much of its patience a thing has used, so the most pressing part of a group can lead. */
  function readPressure(e) {
    var kind = K[e.kind];
    return (World.NOW - e.since) / 36e5 / Math.max(1, kind.patience);
  }

  /**
   * Returns the bundles of the page: each is a lead and the parts directly linked to it by a firm claim. What deserves the most room
   * leads, so a transient thing rides on the lasting thing it belongs to, and among equals the most pressing leads. Only direct links
   * join, so a chain of links never pulls in the whole neighbourhood.
   */
  function buildBundles(list) {
    var placed = {}, out = [];
    var rank = function (e) { return (K[e.kind].card === 'rich' ? 1000 : 0) + (K[e.kind].pace === 'slow' ? 1000 : 0) + readPressure(e); };
    list.slice().sort(function (a, b) { return rank(b) - rank(a); }).forEach(function (e) {
      if (placed[e.id]) return;
      placed[e.id] = true;
      var parts = [];
      readConfirmed(e).forEach(function (l) {
        if (!l.other) { parts.push({ restricted: true, link: l }); return; }
        if (placed[l.other.id] || l.other.settled) return;
        placed[l.other.id] = true;
        parts.push({ e: l.other, link: l });
      });
      out.push({ lead: e, parts: parts });
    });
    return out;
  }

  return { load: load, note: note, find: find, readParents: readParents, readAncestors: readAncestors, readChildren: readChildren, readHomes: readHomes, readLinks: readLinks, readConfirmed: readConfirmed, readHints: readHints, isConfirmed: isConfirmed, sayClaim: sayClaim, linkByHand: linkByHand, drop: drop, restore: restore, buildBundles: buildBundles };
})();
