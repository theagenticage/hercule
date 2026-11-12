// PROTOTYPE - small drawing helpers every view shares: icons, plugin marks, status glyphs, faces,
// times and the sentences a row says. Nothing here knows a source: it reads Kinds.
window.Draw = (function () {
  "use strict";
  var K = Kinds;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  /** Returns one of the app's icons as inline SVG, on its 16-unit grid. */
  function icon(name, size) {
    size = size || 16;
    return '<svg class="ic" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
  }

  /** Returns the hue style of a source: its declared hue at the theme's mark lightness and strength, or nothing for ink. */
  function hueStyle(source) {
    var h = K.SOURCES[source].hue;
    return h == null ? "" : ' style="--src-h:' + h + '"';
  }

  /** Returns a plugin's mark. A solid mark is drawn at 90%, so it carries the same weight as a line mark. */
  function mark(source, size) {
    var m = MARKS[K.SOURCES[source].mark];
    var s = m.solid ? Math.round(size * 0.9) : size;
    var paths = m.d.map(function (d) { return '<path d="' + d + '"/>'; }).join("");
    var paint = m.stroke ? 'fill="none" stroke="currentColor" stroke-width="' + (1.5 * m.vb / 16) + '" stroke-linecap="round" stroke-linejoin="round"' : 'fill="currentColor"';
    var h = K.SOURCES[source].hue;
    return '<span class="mk' + (h == null ? "" : " mk--hue") + '" style="width:' + size + "px;height:" + size + "px" + (h == null ? "" : ";--src-h:" + h) + '"><svg viewBox="0 0 ' + m.vb + " " + m.vb + '" width="' + s + '" height="' + s + '" ' + paint + ' aria-hidden="true">' + paths + "</svg></span>";
  }

  // Status shapes on a 14-unit grid. The core owns the set; a plugin picks one per status.
  var SHAPES = {
    ring: '<circle cx="7" cy="7" r="5.25"/>',
    dashed: '<circle cx="7" cy="7" r="5.25" stroke-dasharray="2.06 2.06"/>',
    quarter: '<circle cx="7" cy="7" r="5.25"/><path d="M7 7V3.6A3.4 3.4 0 0 1 10.4 7z" fill="currentColor" stroke="none"/>',
    half: '<circle cx="7" cy="7" r="5.25"/><path d="M7 3.6a3.4 3.4 0 0 1 0 6.8z" fill="currentColor" stroke="none"/>',
    most: '<circle cx="7" cy="7" r="5.25"/><path d="M7 7V3.6A3.4 3.4 0 1 1 3.6 7z" fill="currentColor" stroke="none"/>',
    check: '<circle cx="7" cy="7" r="6" fill="currentColor" stroke="none"/><path d="M4.4 7.2l1.8 1.8 3.5-3.7" stroke="var(--glyph-knock)" stroke-width="1.6"/>',
    cross: '<circle cx="7" cy="7" r="6" fill="currentColor" stroke="none"/><path d="M5 5l4 4M9 5l-4 4" stroke="var(--glyph-knock)" stroke-width="1.6"/>',
    fork: '<circle cx="4" cy="3.4" r="1.5"/><circle cx="4" cy="10.6" r="1.5"/><circle cx="10" cy="10.6" r="1.5"/><path d="M4 4.9v4.2M10 9.1V6.2a1.8 1.8 0 0 0-1.8-1.8H6.4M7.6 3.1 6.3 4.4l1.3 1.3"/>',
    draft: '<circle cx="4" cy="3.4" r="1.5"/><circle cx="4" cy="10.6" r="1.5"/><circle cx="10" cy="10.6" r="1.5"/><path d="M4 4.9v4.2"/><path d="M10 8.4v-.9M10 5.6v-.9M10 2.8v-.6" />',
    join: '<circle cx="4" cy="3.4" r="1.5"/><circle cx="4" cy="10.6" r="1.5"/><circle cx="10.4" cy="7.4" r="1.5"/><path d="M4 4.9v4.2M4 4.9c0 1.8 1.4 2.5 4.9 2.5"/>',
    alert: '<path d="M7 1.9 12.5 11.6H1.5Z"/><path d="M7 5.6v2.4" /><circle cx="7" cy="9.85" r=".2" fill="currentColor"/>',
    "return": '<path d="M11.3 8.4A4.5 4.5 0 1 1 9.9 3.6"/><path d="M10.4 1.4v2.6H7.8"/>',
    hold: '<circle cx="7" cy="7" r="5.25"/><path d="M5.6 5v4M8.4 5v4"/>',
    dot: '<circle cx="7" cy="7" r="3" fill="currentColor" stroke="none"/>',
  };

  /** Returns a thing's status glyph in its declared tone, or an empty slot when its kind has no status. */
  function glyph(t, size) {
    var st = K.KINDS[t.kind].statuses[t.status];
    if (!st) return '<span class="gl gl--none"></span>';
    return '<span class="gl gl--' + st.tone + '"' + hueStyle(K.KINDS[t.kind].source) + ' title="' + esc(st.word) + '"><svg viewBox="0 0 14 14" width="' + (size || 14) + '" height="' + (size || 14) + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="' + esc(st.word) + '">' + SHAPES[st.shape] + "</svg></span>";
  }
  function statusWord(t) { var st = K.KINDS[t.kind].statuses[t.status]; return st ? st.word : null; }

  // Project health in Browse: the one other place colour carries meaning. Shape tells it too.
  var HEALTH = {
    "on-track": { word: "On track", svg: '<circle cx="6" cy="6" r="4.5"/><path d="M4 6.1l1.4 1.4 2.6-2.8"/>' },
    "at-risk": { word: "At risk", svg: '<circle cx="6" cy="6" r="4.5"/><path d="M6 3.7v2.6"/><circle cx="6" cy="8.3" r=".25" fill="currentColor"/>' },
    "off-track": { word: "Off track", svg: '<circle cx="6" cy="6" r="4.5"/><path d="M4.3 4.3l3.4 3.4M7.7 4.3 4.3 7.7"/>' },
  };
  function health(h) {
    var x = HEALTH[h];
    return '<span class="hl hl--' + h + '" title="' + x.word + '"><svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="' + x.word + '">' + x.svg + "</svg></span>";
  }

  /** Returns a colleague's face: a workflow, an agent, or Hercule himself. */
  function face(name, pose, size) { return Crew.face(name, { pose: pose || "idle", size: size || 18 }); }
  /** Returns the user's monogram, as the sidebar draws it. */
  function you(size) { return '<svg class="cr-you" viewBox="0 0 32 32" width="' + size + '" height="' + size + '" role="img" aria-label="You"><circle cx="16" cy="16" r="15" fill="var(--you)"></circle><circle cx="16" cy="16" r="15" fill="none" stroke="oklch(0 0 0 / .08)"></circle><text x="16" y="21.2" text-anchor="middle" font-family="var(--font-ui)" font-size="15" font-weight="700" fill="var(--face-ink)">R</text></svg>'; }

  function ago(min) {
    if (min < 1) return "now";
    if (min < 60) return Math.round(min) + "m";
    if (min < 1440) return Math.round(min / 60) + "h";
    if (min < 10080) return Math.round(min / 1440) + "d";
    if (min < 43200) return Math.round(min / 10080) + "w";
    return Math.round(min / 43200) + "mo";
  }
  function agoWords(min) {
    if (min < 60) return Math.round(min) + (Math.round(min) === 1 ? " minute" : " minutes") + " ago";
    if (min < 1440) { var h = Math.round(min / 60); return h + (h === 1 ? " hour" : " hours") + " ago"; }
    var d = Math.round(min / 1440); return d + (d === 1 ? " day" : " days") + " ago";
  }
  function num(n) { return Number(n).toLocaleString("en-GB"); }
  function compact(n) { return n < 1000 ? String(n) : n < 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : n < 1e6 ? Math.round(n / 1000) + "k" : (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"; }

  // How long each kind of ask may wait before it is due. The wait is drawn in ink and weight only.
  var PATIENCE = { review: 1440, mention: 480, checks: 480, asked: 1440, regressed: 240, signoff: 4320 };
  /** Returns the wait class of a thing: fresh, recent, due or over, measured against the patience of its oldest ask. */
  function waitTone(t) {
    var a = Model.askingSignals(t);
    if (!a.length) return "fresh";
    var worst = Math.max.apply(null, a.map(function (s) { return s.at / (PATIENCE[s.kind] || 1440); }));
    return worst >= 3 ? "over" : worst >= 1 ? "due" : worst >= 0.5 ? "recent" : "fresh";
  }

  function identifier(t) { return t.key || (t.number ? "#" + t.number : ""); }
  function place(t) { var p = K.KINDS[t.kind].place; return t.fields[p] || ""; }
  function noun(t) { return K.KINDS[t.kind].noun; }

  /** Says what a signal asks, with the person in it: "Mei asked for your review". */
  function saySignal(s, t) {
    // A signal a system raised (an ownership rule, a CI run) has no person to name.
    var by = s.system ? "" : s.by;
    var said = K.SIGNALS[s.kind].say.replace("{by}", by).replace(/^\s+/, "");
    return said.charAt(0).toUpperCase() + said.slice(1);
  }
  function sayPerson(s) { return s.by; }

  /**
   * Returns the sentence a row says on its second line: the newest ask, with how many more there are,
   * or what changed, or who has it, or its status. Returns [html, extraCount].
   */
  function reason(t) {
    var a = Model.askingSignals(t).slice().sort(function (x, y) { return x.at - y.at; });
    // A workflow that has a thing may leave an ask open: the ask is the reason, and who has the rest follows.
    if (t.held && !(t.held.workflow && a.length)) return t.held.by === "you" ? "You took it on" : esc(t.held.by) + " has it";
    var also = t.held ? ' <span class="held-by">· ' + esc(t.held.by) + " has the rest</span>" : "";
    if (a.length) {
      var s = a[0];
      var text = esc(saySignal(s, t));
      if (s.by && text.indexOf(esc(s.by)) === 0) text = '<b class="who">' + esc(s.by) + "</b>" + text.slice(esc(s.by).length);
      return text + (a.length > 1 ? ' <span class="more" title="' + (a.length - 1) + ' more ask on it">+' + (a.length - 1) + "</span>" : "") + also;
    }
    if (t.note) return esc(t.note);
    var w = statusWord(t);
    var bits = [];
    if (w) bits.push(w);
    var k = K.KINDS[t.kind];
    if (k.fact && t.fields[k.fact] != null) bits.push(K.FIELDS[k.fact].type === "number" ? compact(t.fields[k.fact]) + " " + K.FIELDS[k.fact].label.toLowerCase() : t.fields[k.fact]);
    if (k.context && t.fields[k.context]) bits.push(t.fields[k.context]);
    if (!bits.length && t.fields.from) bits.push(t.fields.from);
    return esc(bits.join(" · "));
  }

  return { esc: esc, icon: icon, mark: mark, glyph: glyph, statusWord: statusWord, health: health, HEALTH: HEALTH, face: face, you: you, ago: ago, agoWords: agoWords, num: num, compact: compact, waitTone: waitTone, identifier: identifier, place: place, noun: noun, saySignal: saySignal, reason: reason, hueStyle: hueStyle };
})();
