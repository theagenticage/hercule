// PROTOTYPE - Crew Bureau's runtime: the character generator, icons, source marks and the shells.
// Every page loads it at the end of <body>. It turns markup like
//   <i data-face="Ada" data-pose="working" data-size="28"></i>
//   <i data-i="search"></i>   <i data-brand="sentry"></i>   <i data-you></i>
// into inline SVG, and renders the shared chrome (sidebar, web bar, tab bar, status bar).
(function () {
  "use strict";

  /* ------------------------------------------------------------------ characters */

  // Every colleague is an egg - Poirot's head was "exactly the shape of an egg" - in one of four
  // proportions, with at most two small accessories from a 1930s wardrobe.
  var HUES = ["iris", "teal", "orchid", "lime", "sky", "peach", "mint", "grape"];
  var SHAPES = ["egg", "tall", "round", "wide"];
  var ACCESSORIES = ["none", "homburg", "bowtie", "tache", "monocle", "watch", "glasses", "tache+bowtie"];

  // Assistants, workflows and today's sessions are cast by hand, so that neighbours in the office
  // never look alike; any other name gets a look hashed from it.
  var CAST = {
    Ada: ["iris", "egg", "cloche"],
    Milo: ["teal", "round", "headset"],
    Juno: ["orchid", "tall", "beret"],
    // the assistant every new install starts with
    Hercule: ["sky", "round", "tache+homburg"],
    Triage: ["lime", "egg", "tache+bowtie"],
    // workflows
    "Fix bug": ["iris", "wide", "glasses"],
    Investigate: ["sky", "egg", "tache+homburg"],
    "Ship release": ["orchid", "round", "bowtie"],
    "Label new issues": ["grape", "tall", "watch"],
    "Draft reply": ["teal", "egg", "monocle"],
    "Nightly backup check": ["lime", "wide", "homburg"],
    // the 14 live sessions besides Ada and Milo
    "Fix 3-D Secure checkout for EU cards": ["peach", "egg", "tache"],
    "Read the Stripe v14 changelog": ["sky", "tall", "glasses"],
    "Migrate ops dashboards": ["mint", "wide", "bowtie"],
    "Investigate backup timeouts": ["sky", "round", "tache+homburg"],
    "Refactor cart totals": ["grape", "egg", "watch"],
    "Webhook retry backoff": ["iris", "tall", "monocle"],
    "Cart total rounding on discounts": ["mint", "round", "glasses"],
    "Payout report for September": ["peach", "wide", "homburg"],
    "Rotate staging secrets": ["teal", "tall", "tache"],
    "Tidy checkout CSS": ["orchid", "egg", "bowtie"],
    "Label new issues run": ["grape", "tall", "watch"],
    "Ship release v2.15": ["orchid", "round", "bowtie"],
    "Add iDEAL research": ["lime", "tall", "monocle"],
    "Draft reply to Jonas at Kiteworks": ["teal", "wide", "tache+bowtie"],
  };

  function hash(text) {
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 13;
    h = Math.imul(h, 2246822507);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /** Returns a colleague's look - hue, body shape and accessories - cast by hand or hashed from its name. */
  function lookFor(name) {
    var cast = CAST[name];
    if (cast) return { hue: cast[0], shape: cast[1], acc: cast[2] };
    var h = hash(name);
    return { hue: HUES[h % 8], shape: SHAPES[(h >>> 4) % 4], acc: ACCESSORIES[(h >>> 8) % 8] };
  }

  // Each shape is an egg: top y, bottom y, the y of its widest point and its half-width there.
  // The widest point sits below the middle, so the character sits firmly on its base.
  var SHAPE = {
    egg: { top: 9.6, bottom: 42.4, mid: 30.5, half: 14.4 },
    tall: { top: 8.4, bottom: 42.4, mid: 31, half: 12.8 },
    round: { top: 11, bottom: 42.4, mid: 29.5, half: 15.4 },
    wide: { top: 12.6, bottom: 42.4, mid: 31, half: 16.2 },
  };

  /** Returns the SVG path of an egg centred on x 24, flattened a little at the base. */
  function eggPath(s) {
    var up = s.mid - s.top;
    var down = s.bottom - s.mid;
    function n(v) {
      return Math.round(v * 100) / 100;
    }
    var R = 24 + s.half;
    var L = 24 - s.half;
    return (
      "M24 " + n(s.top) +
      "C" + n(24 + s.half * 0.6) + " " + n(s.top) + " " + R + " " + n(s.mid - up * 0.52) + " " + R + " " + n(s.mid) +
      "C" + R + " " + n(s.mid + down * 0.62) + " " + n(24 + s.half * 0.7) + " " + n(s.bottom) + " 24 " + n(s.bottom) +
      "C" + n(24 - s.half * 0.7) + " " + n(s.bottom) + " " + L + " " + n(s.mid + down * 0.62) + " " + L + " " + n(s.mid) +
      "C" + L + " " + n(s.mid - up * 0.52) + " " + n(24 - s.half * 0.6) + " " + n(s.top) + " 24 " + n(s.top) + "Z"
    );
  }

  // Hats and headsets are drawn in --hat, a near-black that works on every hue and theme.
  var HAT = 'fill="var(--hat)"';
  var BAND = 'fill="var(--who-shade)"';

  /** Returns accessories drawn on top of the body: hats, the tache, glasses, ties and watches. */
  function accessories(list, s) {
    var t = s.top;
    // Hats are drawn relative to the top of the egg, so one hat fits every shape.
    function y(dy) {
      return Math.round((t + dy) * 100) / 100;
    }
    return list
      .map(function (acc) {
        if (acc === "homburg")
          // A dented crown, a band in the wearer's own shade and a brim curled up at both ends.
          return (
            '<path d="M17 ' + y(4.6) + "L17.5 " + y(-1.4) + "C17.7 " + y(-3.4) + " 19.6 " + y(-3.9) + " 21.2 " + y(-3.4) + "C22.5 " + y(-3) + " 23 " + y(-2.3) + " 24 " + y(-2.3) +
            "S25.5 " + y(-3) + " 26.8 " + y(-3.4) + "C28.4 " + y(-3.9) + " 30.3 " + y(-3.4) + " 30.5 " + y(-1.4) + "L31 " + y(4.6) + 'z" ' + HAT + "/>" +
            '<path d="M17.2 ' + y(1.8) + "h13.6l.2 2.4H17z" + '" ' + BAND + "/>" +
            '<path d="M10.2 ' + y(3.2) + "C11.2 " + y(5.9) + " 15.6 " + y(6.8) + " 24 " + y(6.8) + "S36.8 " + y(5.9) + " 37.8 " + y(3.2) +
            "C36.2 " + y(4.7) + " 31.2 " + y(5) + " 24 " + y(5) + "S11.8 " + y(4.7) + " 10.2 " + y(3.2) + 'z" ' + HAT + "/>"
          );
        if (acc === "cloche")
          // A 1920s bell hat pulled down to the brows, with a rosette on the band.
          return (
            '<path d="M9.2 ' + y(13.6) + "C9.6 " + y(3) + " 15.4 " + y(-2) + " 24 " + y(-2) + "S38.4 " + y(3) + " 38.8 " + y(13.6) +
            "C35 " + y(11.4) + " 30 " + y(10.6) + " 24 " + y(10.6) + "S13 " + y(11.4) + " 9.2 " + y(13.6) + 'z" ' + HAT + "/>" +
            '<path d="M10.2 ' + y(9.4) + "C15.6 " + y(7) + " 32.4 " + y(7) + " 37.8 " + y(9.4) + '" fill="none" stroke="var(--who-shade)" stroke-width="2"/>' +
            '<circle cx="32.8" cy="' + y(7.9) + '" r="2.4" ' + BAND + '/><circle cx="32.8" cy="' + y(7.9) + '" r=".9" ' + HAT + "/>"
          );
        if (acc === "beret")
          return (
            '<ellipse cx="22.6" cy="' + (t + 1.8) + '" rx="12.6" ry="4.6" transform="rotate(-9 22.6 ' + (t + 1.8) + ')" ' + HAT + "/>" +
            '<path d="M21.4 ' + (t - 2.4) + "l.6-2.6" + '" stroke="var(--hat)" stroke-width="1.8" stroke-linecap="round"/>'
          );
        if (acc === "headset")
          return (
            '<path d="M9.4 26.4C9 ' + (t - 1) + " 39 " + (t - 1) + ' 38.6 26.4" fill="none" stroke="var(--hat)" stroke-width="1.9"/>' +
            '<rect x="6.2" y="23" width="5.6" height="9.2" rx="2.6" ' + HAT + "/>" +
            '<path d="M9.4 31.6c.6 3 3.2 4.8 7.4 5.2" fill="none" stroke="var(--hat)" stroke-width="1.5" stroke-linecap="round"/>' +
            '<circle cx="17.4" cy="36.8" r="1.7" ' + HAT + "/>"
          );
        if (acc === "tache")
          // Poirot's mustache: two full wings that thin out and curl up into waxed points.
          return (
            '<path d="M24 30.9c-1.5-1.3-4.2-1.5-5.8-.1-.9.8-2 .8-2.6-.3 0 1.9 1.6 3 3.5 2.6 1.9-.4 3.4-1 4.9-1.3 1.5.3 3 .9 4.9 1.3 1.9.4 3.5-.7 3.5-2.6-.6 1.1-1.7 1.1-2.6.3-1.6-1.4-4.3-1.2-5.8.1z" fill="var(--face-ink)"/>' +
            '<path d="M15.8 30.9c-.9-.3-1.3-1.2-.9-2M32.2 30.9c.9-.3 1.3-1.2.9-2" fill="none" stroke="var(--face-ink)" stroke-width=".8" stroke-linecap="round"/>'
          );
        if (acc === "glasses")
          return '<g fill="none" stroke="var(--face-ink)" stroke-width="1.15" opacity=".85"><circle cx="19" cy="26.6" r="4"/><circle cx="29" cy="26.6" r="4"/><path d="M23 26.2h2"/></g>';
        if (acc === "monocle")
          return (
            '<circle cx="29" cy="26.6" r="4.2" fill="oklch(1 0 0 / .18)" stroke="var(--face-ink)" stroke-width="1.2"/>' +
            '<path d="M32.4 29.2c1.4 2.6 1.6 5.6.6 8.8" fill="none" stroke="var(--brass)" stroke-width=".9"/>'
          );
        if (acc === "bowtie")
          return (
            '<path d="M24 38.6l-5.2-2.8c-.7-.4-1.4 0-1.4.8v4c0 .8.7 1.2 1.4.8zM24 38.6l5.2-2.8c.7-.4 1.4 0 1.4.8v4c0 .8-.7 1.2-1.4.8z" ' + HAT + "/>" +
            '<rect x="22.4" y="37" width="3.2" height="3.2" rx="1" ' + HAT + ' stroke="var(--who)" stroke-width=".7"/>'
          );
        if (acc === "watch")
          return (
            '<path d="M24.4 37.2c2 1.4 4.8 1.6 7 .6" fill="none" stroke="var(--brass)" stroke-width="1" stroke-linecap="round"/>' +
            '<circle cx="33.4" cy="37.8" r="2.7" fill="var(--brass)"/><circle cx="33.4" cy="37.8" r="1.7" fill="oklch(0.97 0.02 90)"/>' +
            '<path d="M33.4 36.9v.9l.6.4" stroke="var(--face-ink)" stroke-width=".5" fill="none" stroke-linecap="round"/>'
          );
        return "";
      })
      .join("");
  }

  var EYE_Y = 26.6;

  function eyes(pose, bold) {
    var ink = 'fill="var(--face-ink)"';
    var stroke = 'fill="none" stroke="var(--face-ink)" stroke-width="' + (bold ? 1.9 : 1.5) + '" stroke-linecap="round"';
    var r = bold ? 1.2 : 1;
    function glint(x, y) {
      return '<circle cx="' + (x + 0.7) + '" cy="' + (y - 0.9) + '" r="' + 0.7 * r + '" fill="#fff" opacity=".9"/>';
    }
    function each(draw) {
      return [19, 29].map(draw).join("");
    }
    if (pose === "working")
      // Eyes lowered to the typewriter.
      return each(function (x) {
        return '<ellipse cx="' + x + '" cy="' + (EYE_Y + 1) + '" rx="' + 2 * r + '" ry="' + 2.2 * r + '" ' + ink + "/>" + glint(x, EYE_Y + 1);
      });
    if (pose === "paused")
      return each(function (x) {
        return '<path d="M' + (x - 2.2 * r) + " " + (EYE_Y + 0.2) + "h" + 4.4 * r + '" ' + stroke + "/>";
      });
    if (pose === "asleep")
      return each(function (x) {
        return '<path d="M' + (x - 2.3) + " " + EYE_Y + "q2.3 2 4.6 0" + '" ' + stroke + "/>";
      });
    if (pose === "done")
      return each(function (x) {
        return '<path d="M' + (x - 2.3) + " " + (EYE_Y + 1) + "q2.3-2.8 4.6 0" + '" ' + stroke + "/>";
      });
    if (pose === "away")
      return each(function (x) {
        return '<circle cx="' + (x - 1) + '" cy="' + (EYE_Y + 0.3) + '" r="' + 1.5 * r + '" ' + ink + "/>";
      });
    var dy = pose === "waiting" ? -0.5 : 0;
    var ry = pose === "waiting" ? 2.75 : 2.55;
    return each(function (x) {
      return '<ellipse cx="' + x + '" cy="' + (EYE_Y + dy) + '" rx="' + 2 * r + '" ry="' + ry * r + '" ' + ink + "/>" + glint(x, EYE_Y + dy);
    });
  }

  function brows(pose, bold) {
    var s = 'fill="none" stroke="var(--face-ink)" stroke-width="' + (bold ? 1.6 : 1.25) + '" stroke-linecap="round"';
    if (pose === "waiting") return '<path d="M16.9 21.6q2.1-1.4 4.2 0M26.9 21.6q2.1-1.4 4.2 0" ' + s + "/>";
    if (pose === "working") return '<path d="M17.2 22.3l3.6.5M30.8 22.3l-3.6.5" ' + s + "/>";
    if (pose === "failed") return '<path d="M16.8 22.8l4.2-1.5M31.2 22.8l-4.2-1.5" ' + s + "/>";
    return "";
  }

  function mouth(pose, bold, tache) {
    var s = 'fill="none" stroke="var(--face-ink)" stroke-width="' + (bold ? 1.8 : 1.45) + '" stroke-linecap="round"';
    // Under a mustache the mouth sits lower and only shows when it says something.
    var y = tache ? 34.4 : 32.6;
    if (pose === "waiting") return '<ellipse cx="24" cy="' + (y + 0.2) + '" rx="1.5" ry="1.7" fill="var(--face-ink)"/>';
    if (pose === "done") return '<path d="M21 ' + (y - 1.2) + "q3 3.2 6 0" + '" ' + s + "/>";
    if (pose === "failed") return '<path d="M21.4 ' + (y + 0.6) + "q1.3-1.3 2.6 0t2.6 0" + '" ' + s + "/>";
    if (tache) return "";
    if (pose === "working" || pose === "paused") return '<path d="M22.6 ' + y + 'h2.8" ' + s + "/>";
    if (pose === "asleep") return '<path d="M23 ' + y + 'q1 .8 2 0" ' + s + "/>";
    if (pose === "away") return '<path d="M22.2 ' + y + 'h3.6" ' + s + ' stroke-dasharray=".1 1.8"/>';
    return '<path d="M21.6 ' + (y - 1.2) + "q2.4 2.3 4.8 0" + '" ' + s + "/>";
  }

  function extras(pose) {
    if (pose === "working")
      return (
        // A small typewriter in front, keys as dots, two paws tapping on it.
        '<path d="M11.4 45.4l2.4-5h20.4l2.4 5z" fill="var(--hat)"/>' +
        '<g fill="var(--surface)" opacity=".55"><circle cx="17" cy="43.4" r=".7"/><circle cx="20.4" cy="43.4" r=".7"/><circle cx="24" cy="43.4" r=".7"/><circle cx="27.6" cy="43.4" r=".7"/><circle cx="31" cy="43.4" r=".7"/></g>' +
        '<g fill="var(--who-shade)" stroke="var(--face-ink)" stroke-opacity=".25" stroke-width=".6"><ellipse class="cr-tap" cx="18" cy="40.4" rx="2.8" ry="1.9"/>' +
        '<ellipse class="cr-tap cr-tap--2" cx="30" cy="40.4" rx="2.8" ry="1.9"/></g>'
      );
    if (pose === "waiting")
      // The raised hand: the one place a character carries marigold, because it asks for you.
      return (
        '<g class="cr-wave"><path d="M36.8 33C40.4 30.4 41.6 24.4 41.8 18.4" fill="none" stroke="var(--who-shade)" stroke-width="3.4" stroke-linecap="round"/>' +
        '<rect x="37.8" y="6.8" width="8" height="10.6" rx="4" fill="var(--you)" stroke="var(--who-shade)" stroke-width="1.3"/>' +
        '<ellipse cx="37.6" cy="13.4" rx="1.7" ry="2.5" transform="rotate(-32 37.6 13.4)" fill="var(--you)" stroke="var(--who-shade)" stroke-width="1.1"/></g>'
      );
    if (pose === "asleep")
      return '<g class="cr-z" fill="var(--muted)" font-family="var(--font-ui)" font-weight="760"><text x="37.4" y="15" font-size="10">z</text><text x="42.6" y="8.4" font-size="7">z</text></g>';
    if (pose === "failed")
      // A sticking plaster on the cheek, where no hat or mustache can hide it.
      return (
        '<g transform="rotate(-30 14.6 32.4)"><rect x="9.6" y="30.1" width="10" height="4.6" rx="2.3" fill="oklch(0.95 0.03 75)" stroke="oklch(0.7 0.05 60)" stroke-width=".7"/>' +
        '<rect x="13.1" y="30.7" width="3" height="3.4" rx=".7" fill="oklch(0.85 0.05 65)"/></g>' +
        badge("var(--fail)", '<path d="M38.3 37.3l3.4 3.4M41.7 37.3l-3.4 3.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>')
      );
    if (pose === "done") return badge("var(--ok)", '<path d="M37.6 39.2l1.6 1.6 3.2-3.4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>');
    if (pose === "paused") return badge("var(--raised)", '<path d="M38.8 37.2v3.6M41.2 37.2v3.6" stroke="var(--ink)" stroke-width="1.5" stroke-linecap="round"/>', true);
    if (pose === "away")
      return badge("var(--raised)", '<path d="M37.6 40.8l4.8-4.8M37.8 37.2a3 3 0 0 1 4.6 0" fill="none" stroke="var(--muted)" stroke-width="1.3" stroke-linecap="round"/>', true);
    return "";
  }

  function badge(fill, inner, outlined) {
    return (
      '<circle cx="40" cy="39" r="5.6" fill="' + fill + '" stroke="var(--badge-ring, var(--surface))" stroke-width="2"/>' +
      (outlined ? '<circle cx="40" cy="39" r="4.4" fill="none" stroke="var(--line)" stroke-width=".8"/>' : "") +
      inner
    );
  }

  var uidCounter = 0;

  /**
   * Returns the SVG markup of a colleague's face.
   * name  - the colleague's name; its look is cast or hashed from it.
   * opts  - { pose: working|waiting|idle|asleep|failed|paused|done|away, size: px, look }
   */
  function face(name, opts) {
    opts = opts || {};
    var look = opts.look || lookFor(name);
    var pose = opts.pose || "idle";
    var size = opts.size || 28;
    var bold = size < 30;
    var s = SHAPE[look.shape];
    var acc = look.acc === "none" ? [] : look.acc.split("+");
    var tache = acc.indexOf("tache") !== -1;
    var body = eggPath(s);
    var delay = (4 + (hash(name + ++uidCounter) % 700) / 100).toFixed(2);
    var blinks = pose === "idle" || pose === "waiting" || pose === "failed";
    return (
      '<svg class="cr cr--' + pose + '" viewBox="3 1 45 45" width="' + size + '" height="' + size + '" role="img" aria-label="' + name.replace(/"/g, "&quot;") + ", " + poseWord(pose) + '" style="--hue:var(--hue-' + look.hue + ')">' +
      '<path d="' + body + '" fill="var(--who-shade)"/>' +
      '<path d="' + body + '" fill="var(--who)" transform="translate(0 -2)"/>' +
      '<ellipse cx="17.4" cy="' + (s.top + 6.4) + '" rx="3.6" ry="2.1" transform="rotate(-30 17.4 ' + (s.top + 6.4) + ')" fill="#fff" opacity=".34"/>' +
      '<ellipse cx="15" cy="31.4" rx="2.6" ry="1.6" fill="var(--blush)"/><ellipse cx="33" cy="31.4" rx="2.6" ry="1.6" fill="var(--blush)"/>' +
      '<g class="' + (blinks ? "cr-eyes" : "") + '" style="animation-delay:' + delay + 's">' + eyes(pose, bold) + "</g>" +
      brows(pose, bold) +
      mouth(pose, bold, tache) +
      accessories(acc, s) +
      extras(pose) +
      "</svg>"
    );
  }

  function poseWord(pose) {
    return {
      working: "working",
      waiting: "waiting on you",
      idle: "idle",
      asleep: "asleep",
      failed: "failed",
      paused: "paused",
      done: "done",
      away: "can't be reached",
    }[pose] || pose;
  }

  /** Returns the SVG markup of the user's own avatar: a letter, because people are not characters. */
  function you(size) {
    size = size || 28;
    return (
      '<svg class="cr-you" viewBox="0 0 32 32" width="' + size + '" height="' + size + '" role="img" aria-label="Rogier">' +
      '<circle cx="16" cy="16" r="15" fill="var(--you)"/><circle cx="16" cy="16" r="15" fill="none" stroke="oklch(0 0 0 / .08)"/>' +
      '<text x="16" y="21.2" text-anchor="middle" font-family="var(--font-ui)" font-size="15" font-weight="700" fill="var(--face-ink)">R</text></svg>'
    );
  }

  /* ------------------------------------------------------------------ icons and marks */

  // 16px outline icons on a 16 grid, 1.5 stroke, round caps. The six state marks share the
  // family and are the only state symbols anywhere: working, waiting, done, failed, paused, idle.
  var ICONS = {
    search: '<circle cx="7.2" cy="7.2" r="4.4"/><path d="M10.5 10.5l3 3"/>',
    plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    compose: '<path d="M7.4 2.8H4.2a1.4 1.4 0 0 0-1.4 1.4v7.6a1.4 1.4 0 0 0 1.4 1.4h7.6a1.4 1.4 0 0 0 1.4-1.4V8.6"/><path d="M11.6 2.4l2 2-5.4 5.4-2.6.6.6-2.6z"/>',
    close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    check: '<path d="M3.4 8.4l3 3 6.2-6.6"/>',
    "chev-r": '<path d="M6.2 3.8L10.4 8l-4.2 4.2"/>',
    "chev-l": '<path d="M9.8 3.8L5.6 8l4.2 4.2"/>',
    "chev-d": '<path d="M3.8 6.2L8 10.4l4.2-4.2"/>',
    "chev-ud": '<path d="M5 6l3-2.8L11 6M5 10l3 2.8 3-2.8"/>',
    office: '<path d="M2.4 13.6h11.2M3.6 13.6V6.4L8 3l4.4 3.4v7.2"/><path d="M6.4 13.6v-3.4h3.2v3.4"/>',
    list: '<path d="M6 4.2h7.4M6 8h7.4M6 11.8h7.4"/><circle cx="3" cy="4.2" r=".5"/><circle cx="3" cy="8" r=".5"/><circle cx="3" cy="11.8" r=".5"/>',
    intake: '<path d="M2.4 9.2h3.2l1 1.8h2.8l1-1.8h3.2"/><path d="M2.4 9.2l1.6-5.4h8l1.6 5.4v3.6a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z"/>',
    checkin: '<path d="M5.2 3.4H4a1 1 0 0 0-1 1v8.6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.4a1 1 0 0 0-1-1h-1.2"/><rect x="5.4" y="2.2" width="5.2" height="2.4" rx=".8"/><path d="M5.6 9l1.7 1.6 3.2-3.4"/>',
    threads: '<path d="M2.6 4.4a1.6 1.6 0 0 1 1.6-1.6h7.6a1.6 1.6 0 0 1 1.6 1.6v5a1.6 1.6 0 0 1-1.6 1.6H7.4L4.4 13.4V11h-.2a1.6 1.6 0 0 1-1.6-1.6z"/>',
    runs: '<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="3.2"/><path d="M6.6 5.6v4.8L10.4 8z"/>',
    workflows: '<circle cx="4" cy="4" r="1.7"/><circle cx="12" cy="8" r="1.7"/><circle cx="4" cy="12" r="1.7"/><path d="M5.7 4.4c3 .4 3.2 3.2 4.6 3.6M5.7 11.6c3-.4 3.2-3.2 4.6-3.6"/>',
    tasks: '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="3"/><path d="M5.4 8.2l1.8 1.7 3.4-3.6"/>',
    fleet: '<rect x="2.4" y="2.6" width="11.2" height="4.4" rx="1.4"/><rect x="2.4" y="9" width="11.2" height="4.4" rx="1.4"/><path d="M5 4.8h.1M5 11.2h.1"/>',
    connections: '<path d="M6 2.6v2.6M10 2.6v2.6M4.2 5.2h7.6v2.4a3.8 3.8 0 0 1-7.6 0zM8 11.4v2.2"/>',
    bell: '<path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1 1.2H3z"/><path d="M6.6 13.6a1.5 1.5 0 0 0 2.8 0"/>',
    settings: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.6M8 12.5v1.6M1.9 8h1.6M12.5 8h1.6M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M3.7 12.3l1.1-1.1M11.2 4.8l1.1-1.1"/>',
    sidebar: '<rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2"/><path d="M6.2 2.8v10.4"/>',
    editor: '<path d="M5.4 4.6L2.4 8l3 3.4M10.6 4.6l3 3.4-3 3.4M9.2 3.2L6.8 12.8"/>',
    mic: '<rect x="5.8" y="2" width="4.4" height="7.6" rx="2.2"/><path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2"/>',
    send: '<path d="M8 13V3.4M4 7.2L8 3.2l4 4"/>',
    stop: '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.6" fill="currentColor" stroke="none"/>',
    branch: '<circle cx="4.6" cy="3.6" r="1.5"/><circle cx="4.6" cy="12.4" r="1.5"/><circle cx="11.4" cy="5.6" r="1.5"/><path d="M4.6 5.1v5.8M11.4 7.1c0 2.6-4.4 2.4-6.4 4"/>',
    worktree: '<path d="M2.4 4.2a1 1 0 0 1 1-1h3l1.4 1.6h4.8a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z"/>',
    laptop: '<rect x="3.4" y="3.4" width="9.2" height="6.6" rx="1.2"/><path d="M1.8 12.6h12.4"/>',
    server: '<rect x="2.4" y="2.6" width="11.2" height="4.4" rx="1.4"/><rect x="2.4" y="9" width="11.2" height="4.4" rx="1.4"/><path d="M5 4.8h.1M5 11.2h.1"/>',
    clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2 1.4"/>',
    sparkle: '<path d="M8 2.4c.5 2.9 2.7 5.1 5.6 5.6-2.9.5-5.1 2.7-5.6 5.6-.5-2.9-2.7-5.1-5.6-5.6 2.9-.5 5.1-2.7 5.6-5.6z"/>',
    sliders: '<path d="M3 5h5.4M11.6 5H13M3 11h1.4M7.6 11H13"/><circle cx="10" cy="5" r="1.6"/><circle cx="6" cy="11" r="1.6"/>',
    shield: '<path d="M8 2.2l4.8 1.8v3.8c0 3-2.2 5.2-4.8 6-2.6-.8-4.8-3-4.8-6V4z"/><path d="M5.8 8.2l1.6 1.5 2.8-3"/>',
    bolt: '<path d="M8.8 2L4 9h3.6L7 14l5-7H8.4z"/>',
    external: '<path d="M6.4 3.4H4a1.2 1.2 0 0 0-1.2 1.2V12A1.2 1.2 0 0 0 4 13.2h7.4a1.2 1.2 0 0 0 1.2-1.2V9.6M9 2.8h4.2V7M13 3l-5.6 5.6"/>',
    more: '<circle cx="3.6" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.4" cy="8" r=".6"/>',
    popout: '<rect x="2.4" y="4.6" width="9" height="9" rx="2"/><path d="M6.6 2.4h5.4a1.6 1.6 0 0 1 1.6 1.6v5.4"/>',
    moon: '<path d="M12.8 9.8A5.4 5.4 0 0 1 6.2 3.2a5.4 5.4 0 1 0 6.6 6.6z"/>',
    sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/>',
    key: '<circle cx="5.4" cy="10.6" r="2.8"/><path d="M7.4 8.6l5.4-5.4M11 4.8l1.6 1.6M9.6 6.2l1.2 1.2"/>',
    lock: '<rect x="3.4" y="7" width="9.2" height="6.6" rx="1.8"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
    globe: '<circle cx="8" cy="8" r="5.8"/><path d="M2.4 8h11.2M8 2.2c-2.6 3.4-2.6 8.2 0 11.6M8 2.2c2.6 3.4 2.6 8.2 0 11.6"/>',
    filter: '<path d="M2.6 3.6h10.8M4.6 8h6.8M6.6 12.4h2.8"/>',
    heart: '<path d="M2.2 8.2h2.6l1.4-3 2.2 6 1.6-3.4h3.8"/>',
    memory: '<path d="M3.4 2.8h7.4a1.8 1.8 0 0 1 1.8 1.8v8.6H5.2a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M3.4 11.4a1.8 1.8 0 0 1 1.8-1.8h7.4M6 5.4h4"/>',
    alarm: '<circle cx="8" cy="8.8" r="4.8"/><path d="M8 6.6v2.4l1.6 1M2.6 3.6l1.8-1.4M13.4 3.6l-1.8-1.4"/>',
    question: '<circle cx="8" cy="8" r="5.8"/><path d="M6.3 6.4a1.8 1.8 0 0 1 3.5.5c0 1.2-1.8 1.4-1.8 2.6"/><circle cx="8" cy="11.4" r=".4"/>',
    pause: '<path d="M6 4v8M10 4v8"/>',
    play: '<path d="M5.4 3.6v8.8L12.2 8z"/>',
    calendar: '<rect x="2.6" y="3.4" width="10.8" height="10" rx="2"/><path d="M2.6 6.8h10.8M5.6 2v2.6M10.4 2v2.6"/>',
    eye: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/>',
    terminal: '<rect x="2" y="2.8" width="12" height="10.4" rx="2"/><path d="M4.8 6.2l2 1.8-2 1.8M8.4 10h2.8"/>',
    file: '<path d="M4 2.4h5l3 3v8.2H4z"/><path d="M9 2.4v3h3"/>',
    diff: '<path d="M5 2.6v6M2 5.6h6M8.6 11.8H14"/>',
    link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6"/>',
    crew: '<circle cx="5.6" cy="6" r="2.4"/><circle cx="11" cy="6.8" r="2"/><path d="M1.8 13.2c.4-2.4 1.8-3.8 3.8-3.8s3.4 1.4 3.8 3.8M9.6 10a3 3 0 0 1 4.6 3"/>',
    mail: '<rect x="2" y="3.4" width="12" height="9.2" rx="1.8"/><path d="M2.6 4.4L8 8.6l5.4-4.2"/>',
    chat: '<path d="M2.4 8a5.6 5 0 1 1 2.4 4.1L2.4 13l.7-2.4A4.8 4.8 0 0 1 2.4 8z"/>',
    user: '<circle cx="8" cy="5.6" r="2.8"/><path d="M2.8 13.6c.6-2.8 2.6-4.4 5.2-4.4s4.6 1.6 5.2 4.4"/>',
    palette: '<path d="M8 2.2a5.8 5.8 0 0 0 0 11.6c1 0 1.4-.6 1.4-1.3 0-1.2-1-1.3-1-2.3 0-.8.6-1.3 1.4-1.3h1.6a2.6 2.6 0 0 0 2.6-2.6C14 4.6 11.4 2.2 8 2.2z"/><circle cx="5.2" cy="7.2" r=".6"/><circle cx="7.6" cy="4.8" r=".6"/><circle cx="10.6" cy="5.8" r=".6"/>',
    cpu: '<rect x="4" y="4" width="8" height="8" rx="1.6"/><path d="M6.4 1.8V4M9.6 1.8V4M6.4 12v2.2M9.6 12v2.2M1.8 6.4H4M1.8 9.6H4M12 6.4h2.2M12 9.6h2.2"/>',
    id: '<rect x="2" y="3.4" width="12" height="9.2" rx="2"/><circle cx="6" cy="7.4" r="1.4"/><path d="M4 10.8c.4-1 1.2-1.6 2-1.6s1.6.6 2 1.6M9.6 6.6h2.6M9.6 9h2"/>',
    bound: '<path d="M2.4 12.4h11.2M4 12.4V8.6M7 12.4V5.4M10 12.4V7.2M13 12.4V3.6"/>',
    puzzle: '<path d="M3 5.2h2.6a1.4 1.4 0 1 1 2.8 0H11v2.6a1.4 1.4 0 1 1 0 2.8v2.6H3z"/>',
    system: '<rect x="2.2" y="2.8" width="11.6" height="8.2" rx="1.6"/><path d="M6 13.4h4M8 11v2.4"/>',
    arrow: '<path d="M3 8h9.4M8.8 4.4L12.4 8l-3.6 3.6"/>',
    undo: '<path d="M5.4 4.4L2.8 7l2.6 2.6"/><path d="M3 7h6.4a3.4 3.4 0 0 1 0 6.8H7"/>',
    hash: '<path d="M6.2 2.6L5 13.4M11 2.6L9.8 13.4M2.8 5.8h10.6M2.4 10.2H13"/>',
    wave: '<path d="M2.4 8h1.6l1.4-3.4 2 7 2-9 1.8 7.2 1.2-1.8h1.2"/>',
    grip: '<circle cx="6" cy="4" r=".6"/><circle cx="10" cy="4" r=".6"/><circle cx="6" cy="8" r=".6"/><circle cx="10" cy="8" r=".6"/><circle cx="6" cy="12" r=".6"/><circle cx="10" cy="12" r=".6"/>',
    // The six state marks. Their color comes from the .mark--<state> class, never from the path.
    "m-working": '<circle cx="3.8" cy="8" r="1.35" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.35" fill="currentColor" stroke="none"/><circle cx="12.2" cy="8" r="1.35" fill="currentColor" stroke="none"/>',
    "m-waiting": '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none"/>',
    "m-done": '<circle cx="8" cy="8" r="5.6"/><path d="M5.5 8.2l1.7 1.7 3.3-3.5"/>',
    "m-failed": '<circle cx="8" cy="8" r="5.6"/><path d="M6.1 6.1l3.8 3.8M9.9 6.1l-3.8 3.8"/>',
    "m-paused": '<circle cx="8" cy="8" r="5.6"/><path d="M6.7 6v4M9.3 6v4"/>',
    "m-idle": '<path d="M12.4 9.9A5 5 0 0 1 6.1 3.6a5 5 0 1 0 6.3 6.3z"/>',
  };

  /** Returns the SVG markup of an icon or state mark, drawn in currentColor. Fails on an unknown name. */
  function icon(name, size) {
    size = size || 16;
    var body = ICONS[name];
    if (!body) throw new Error("Crew has no icon named " + name);
    return (
      '<svg class="ic" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body.replace(/<circle cx="([\d.]+)" cy="([\d.]+)" r="\.([456])"\/>/g, '<circle cx="$1" cy="$2" r=".$3" fill="currentColor"/>') +
      "</svg>"
    );
  }

  /** Returns a state mark in its state's color, with the state word as its accessible name. */
  function mark(state, size) {
    return '<span class="mark mark--' + state + '" role="img" aria-label="' + poseWord(state) + '">' + icon("m-" + state, size || 14) + "</span>";
  }

  /** Returns the SVG markup of a source system's mark, monochrome. "pi" and "cron" have no brand file. */
  function brand(name, size) {
    size = size || 14;
    if (name === "pi") return '<span class="pi" style="font-size:' + size + 'px">π</span>';
    if (name === "cron") return icon("clock", size);
    if (name === "web") return icon("chat", size);
    var d = (window.CREW_BRANDS || {})[name];
    if (!d) throw new Error("Crew has no source mark named " + name);
    return '<svg class="br" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="currentColor" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  /* ------------------------------------------------------------------ the world */

  // Everything that waits on Rogier right now: two Threads and one Run.
  var WAITING = [
    { name: "Fix 3-D Secure checkout for EU cards", short: "Fix 3-D Secure checkout", ask: "Run git push?", href: "session-active.html" },
    { name: "Migrate ops dashboards", short: "Migrate ops dashboards", ask: "Keep the old Grafana folder?", href: "#" },
    { name: "Ship release v2.15", short: "Ship release v2.15", ask: "Publish to npm?", href: "#" },
  ];
  var ASSISTANTS = [
    { name: "Ada", pose: "working", key: "ada" },
    { name: "Milo", pose: "idle", key: "milo" },
    { name: "Juno", pose: "asleep", key: "juno" },
  ];

  // The live Threads by project: its name, its tint class and its threads. Runs are not listed
  // here; a Run shows up only when it waits on you. "state" is a mark name; idle threads show
  // their "age" instead.
  var PROJECTS = [
    ["webshop", "webshop", [
      { key: "fix", name: "Fix 3-D Secure checkout for EU cards", meta: "fix/3ds-eu-cards · studio-mac", state: "waiting", href: "session-active.html" },
      { key: "read", name: "Read the Stripe v14 changelog", meta: "fix/3ds-eu-cards · studio-mac", age: "20m" },
      { name: "Refactor cart totals", meta: "refactor/cart-totals · build-box-1", state: "working" },
    ]],
    ["payments-api", "payments", [
      { name: "Payout report for September", meta: "Codex · gpt-5.4 · build-box-1", state: "working" },
      { name: "Add iDEAL research", meta: "Codex · gpt-5.4 · build-box-2", age: "1h" },
    ]],
    ["ops", "ops", [
      { name: "Migrate ops dashboards", meta: "ops/grafana-v11 · studio-mac", state: "waiting" },
      { name: "Rotate staging secrets", meta: "ops/rotate-staging · build-box-1", state: "working" },
    ]],
  ];
  // At ten times today's load each project holds many more threads than the sidebar lists.
  var SWARM_MORE = { webshop: 38, "payments-api": 24, ops: 17 };

  function isSwarm() {
    return document.documentElement.dataset.state === "swarm";
  }

  /**
   * Returns the Intake count the shell shows: the page's data-intake-count when it sets one, else
   * today's 9 or the swarm's 90. A design that changes how many decisions reach Intake sets its own.
   */
  function intakeCount() {
    return document.documentElement.dataset.intakeCount || (isSwarm() ? "90" : "9");
  }

  /**
   * Checks for the fresh install: one project, no threads, nothing waiting. ?state=first has a
   * project with its repository; ?state=first-no-repo has one whose repository waits for GitHub.
   */
  function isFirst() {
    var state = document.documentElement.dataset.state;
    return state === "first" || state === "first-no-repo";
  }

  // What a fresh install has: the project the first run added, and the assistant setup creates.
  var FIRST_PROJECTS = [["webshop", "webshop", []]];
  var FIRST_ASSISTANTS = [{ name: "Hercule", pose: "asleep", key: "hercule" }];

  /* ------------------------------------------------------------------ shells */

  /** Returns the "Waiting on you" section: one row per waiting item, its question on one line. */
  function waitingSection(selected) {
    var swarm = isSwarm();
    return (
      '<section class="side-sec side-sec--you">' +
      '<h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + (swarm ? "30" : "3") + "</b></h3>" +
      WAITING.map(function (w) {
        return (
          '<a class="side-row side-row--wait' + (selected === w.name ? " is-on" : "") + '" href="' + w.href + '">' +
          face(w.name, { pose: "waiting", size: 24 }) +
          '<span class="side-text"><span class="side-name">' + w.short + '</span><span class="side-ask">' + w.ask + "</span></span></a>"
        );
      }).join("") +
      (swarm ? '<a class="side-row side-row--more" href="intake.html">27 more waiting on you</a>' : "") +
      "</section>"
    );
  }

  /** Returns the Threads, grouped by project: a header with the project's name, mark and a + for a new thread there. */
  function threadSections(selected) {
    var swarm = isSwarm();
    return (isFirst() ? FIRST_PROJECTS : PROJECTS).map(function (p) {
      var draft =
        selected === "new" && p[0] === "webshop"
          ? '<a class="side-row is-on" href="session-empty.html"><span class="side-text"><span class="side-name">New thread</span><span class="side-meta">' + (document.documentElement.dataset.state === "first-no-repo" ? "no checkout" : "new worktree") + ' · studio-mac</span></span><span class="side-end">draft</span></a>'
          : "";
      return (
        '<section class="side-sec">' +
        '<h3 class="side-h side-h--proj"><span class="proj proj--' + p[1] + '">' + p[0] + "</span>" +
        '<a class="icon-btn icon-btn--sm" href="session-empty.html" title="New thread in ' + p[0] + '">' + icon("plus", 14) + "</a></h3>" +
        draft +
        p[2].map(function (t) {
          var end = t.state ? mark(t.state) : '<span class="side-age">' + t.age + "</span>";
          return (
            '<a class="side-row' + (selected === t.key ? " is-on" : "") + '" href="' + (t.href || "#") + '">' +
            '<span class="side-text"><span class="side-name">' + t.name + '</span><span class="side-meta">' + t.meta + "</span></span>" +
            '<span class="side-end">' + end + "</span></a>"
          );
        }).join("") +
        (swarm ? '<a class="side-row side-row--more" href="#">' + SWARM_MORE[p[0]] + " more threads</a>" : "") +
        "</section>"
      );
    }).join("");
  }

  /** Returns one navigation row of the Hercule tab: icon, label and a right-aligned count. */
  function navRow(key, label, ic, selected, count, extra) {
    var href = { office: "office.html", intake: "intake.html", settings: "settings-appearance.html" }[key] || "#";
    return (
      '<a class="nav-row' + (selected === key ? " is-on" : "") + '" href="' + href + '"' + (selected === key ? ' aria-current="page"' : "") + ">" +
      icon(ic) + "<span>" + label + "</span>" + (extra || "") +
      (count ? '<b class="count' + (key === "intake" ? " count--you" : "") + '">' + count + "</b>" : "") +
      "</a>"
    );
  }

  // Which tab of the sidebar each page opens on. Session and assistant pages open on Threads;
  // the places of Hercule itself open on the Hercule tab.
  var HERCULE_TAB = { office: 1, intake: 1, checkin: 1, fleet: 1, settings: 1 };

  /**
   * Renders the desktop sidebar into el. data-side names what is selected: a thread key ("fix",
   * "new"), an assistant key ("ada") or a place ("intake", "office", "settings"). The two tabs
   * are real: clicking one swaps the list without leaving the page.
   */
  function sidebar(el) {
    var selected = el.dataset.side;
    var swarm = isSwarm();
    var first = isFirst();
    var tab = HERCULE_TAB[selected] ? "hercule" : "threads";
    el.classList.add("side");
    el.dataset.tab = tab;
    var waitingName = { fix: "Fix 3-D Secure checkout for EU cards" }[selected];
    el.innerHTML =
      '<div class="side-top"><span class="tl"><i></i><i></i><i></i></span><button class="icon-btn" title="Hide the sidebar">' + icon("sidebar") + "</button></div>" +
      '<div class="seg seg--side" role="tablist">' +
      '<button role="tab" data-tab="threads" aria-selected="' + (tab === "threads") + '">Threads</button>' +
      '<button role="tab" data-tab="hercule" aria-selected="' + (tab === "hercule") + '">Hercule</button></div>' +
      '<div class="side-actions">' +
      '<a class="nav-row" href="session-empty.html">' + icon("compose") + "<span>New thread</span><kbd>⌘N</kbd></a>" +
      '<button class="nav-row">' + icon("search") + "<span>Search</span><kbd>⌘K</kbd></button></div>" +
      '<div class="side-scroll">' +
      (first ? "" : waitingSection(waitingName)) +
      '<div class="side-pane" data-pane="threads">' +
      threadSections(selected) +
      '<section class="side-sec"><h3 class="side-h"><span>Assistants</span></h3>' +
      (first ? FIRST_ASSISTANTS : ASSISTANTS).map(function (a) {
        return (
          '<a class="side-row side-row--who' + (selected === a.key ? " is-on" : "") + '" href="assistant.html">' + face(a.name, { pose: a.pose, size: 22 }) +
          '<span class="side-name">' + a.name + '</span><span class="side-end side-presence">' + poseWord(a.pose) + "</span></a>"
        );
      }).join("") +
      "</section></div>" +
      '<div class="side-pane" data-pane="hercule">' +
      '<section class="side-sec"><h3 class="side-h"><span>Work</span></h3>' +
      navRow("office", "The office", "office", selected, first ? "" : swarm ? "140" : "16") +
      navRow("intake", "Intake", "intake", selected, first ? "" : intakeCount()) +
      navRow("checkin", "Check-in", "checkin", selected) +
      navRow("tasks", "Tasks", "tasks", selected, first ? "" : swarm ? "118" : "14") +
      navRow("runs", "Runs", "runs", selected, first ? "" : swarm ? "64" : "6") +
      navRow("workflows", "Workflows", "workflows", selected, first ? "1" : swarm ? "14" : "6") +
      "</section>" +
      '<section class="side-sec"><h3 class="side-h"><span>System</span></h3>' +
      navRow("fleet", "Fleet", "fleet", selected, first ? "1" : swarm ? "9" : "3") +
      navRow("connections", "Connections", "connections", selected, "", first ? "" : '<i class="dot dot--fail" title="Discord is reconnecting"></i>') +
      navRow("notifications", "Notifications", "bell", selected) +
      navRow("settings", "Settings", "settings", selected) +
      "</section></div></div>" +
      '<div class="side-foot"><div class="side-sum">' +
      (first
        ? "Nothing running yet"
        : swarm
        ? "<b>78</b> working · <b class=\"you-ink\">30</b> waiting · <b>4</b> paused · <b>28</b> idle"
        : "<b>8</b> working · <b class=\"you-ink\">3</b> waiting · <b>1</b> paused · <b>4</b> idle") +
      '</div><div class="side-me">' + you(24) + '<span class="side-name">Rogier</span>' +
      '<a class="icon-btn icon-btn--sm" href="settings-appearance.html" title="Settings">' + icon("sliders", 14) + "</a></div></div>";
    el.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () {
        el.dataset.tab = b.dataset.tab;
        el.querySelectorAll("[data-tab]").forEach(function (x) {
          x.setAttribute("aria-selected", String(x === b));
        });
      });
    });
  }

  // The settings domains, grouped. Only the pages this prototype draws have links.
  var SETTINGS = [
    ["You", [["profile", "Profile", "user"], ["appearance", "Appearance", "palette"], ["threads", "Threads", "threads"]]],
    ["Crew", [["assistants", "Assistants", "crew"], ["connections", "Connections", "connections"], ["providers", "Providers", "cpu"], ["machines", "Machines", "fleet"]]],
    ["Safety", [["identities", "Identities", "id"], ["profiles", "Permission profiles", "shield"], ["secrets", "Secrets", "key"], ["bounds", "Bounds", "bound"]]],
    ["System", [["plugins", "Plugins", "puzzle"], ["system", "System", "system"]]],
  ];

  /** Renders the settings domain list; data-setnav names the open domain. */
  function setnav(el) {
    var active = el.dataset.setnav;
    var web = location.pathname.indexOf("/web/") !== -1;
    var pages = web ? { providers: 1 } : { appearance: 1, assistants: 1, connections: 1, profiles: 1 };
    el.classList.add("set-nav");
    el.innerHTML = SETTINGS.map(function (group) {
      return (
        '<section class="side-sec"><h3 class="side-h"><span>' + group[0] + "</span></h3>" +
        group[1].map(function (d) {
          var href = pages[d[0]] ? "settings-" + d[0] + ".html" : "#";
          // Discord has been reconnecting since 09:12, so Connections carries the one warning dot.
          var dot = d[0] === "connections" ? '<i class="dot dot--fail" title="Discord is reconnecting"></i>' : "";
          return '<a class="nav-row' + (active === d[0] ? " is-on" : "") + '" href="' + href + '">' + icon(d[2]) + "<span>" + d[1] + "</span>" + dot + "</a>";
        }).join("") +
        "</section>"
      );
    }).join("");
  }

  /** Renders the web's thread pane: new thread and search, then the same lists as the desktop's Threads tab. */
  function threadpane(el) {
    var selected = el.dataset.threads;
    el.classList.add("tpane");
    el.innerHTML =
      '<div class="side-actions">' +
      '<a class="nav-row" href="session-empty.html">' + icon("compose") + "<span>New thread</span></a>" +
      '<button class="nav-row">' + icon("search") + "<span>Find a thread</span><kbd>/</kbd></button></div>" +
      '<div class="side-scroll">' + waitingSection(selected === "fix" ? "Fix 3-D Secure checkout for EU cards" : "") + threadSections(selected) + "</div>";
  }

  // The web set draws Threads, Intake, an assistant and the Providers settings.
  var WEB_HREF = {
    threads: "session-active.html",
    intake: "intake.html",
    assistants: "assistant.html",
    settings: "settings-providers.html",
  };

  /** Renders the web top bar: the mark, the places as tabs, what waits on you, search and Rogier. */
  function webbar(el) {
    var active = el.dataset.webbar;
    el.classList.add("webbar");
    var link = document.createElement("link");
    link.rel = "icon";
    link.href = favicon(WAITING.length > 0);
    document.head.appendChild(link);
    function tab(key, label, count) {
      return (
        '<a class="wtab' + (active === key ? " is-on" : "") + '" href="' + (WEB_HREF[key] || "#") + '"' + (active === key ? ' aria-current="page"' : "") + ">" + label +
        (count ? ' <b class="count' + (key === "intake" ? " count--you" : "") + '">' + count + "</b>" : "") + "</a>"
      );
    }
    // The counts follow the sidebar's: ten times today's load in ?state=swarm.
    var swarm = isSwarm();
    var waiting = swarm ? "30" : "3";
    el.innerHTML =
      '<a class="wb-mark" href="session-active.html">' + logo(24) + '<span class="wordmark">Hercule</span></a>' +
      '<nav class="wtabs">' + tab("threads", "Threads") + tab("intake", "Intake", intakeCount()) + tab("checkin", "Check-in") + tab("runs", "Runs", swarm ? "64" : "6") + tab("assistants", "Assistants") + tab("fleet", "Fleet") + tab("settings", "Settings") + "</nav>" +
      '<div class="wb-right">' +
      '<a class="wb-waiting" href="intake.html" title="' + waiting + ' things are waiting on you">' + mark("waiting") + "<span><b>" + waiting + "</b> waiting on you</span></a>" +
      '<button class="side-search side-search--web">' + icon("search", 14) + "<span>Search</span><kbd>⌘K</kbd></button>" +
      you(28) +
      "</div>";
  }

  /** Renders the iPhone status bar (9:41, signal, wifi, battery). */
  function statusbar(el) {
    el.classList.add("status");
    var ink = el.dataset.status === "light" ? "#fff" : "currentColor";
    el.innerHTML =
      '<span class="status-time">9:41</span><span class="status-island"></span>' +
      '<span class="status-icons" style="color:' + ink + '">' +
      '<svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor"/><rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>' +
      '<svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 2.6c2.2 0 4.2.8 5.8 2.2l1.2-1.3C13.1 1.7 10.7.8 8 .8S2.9 1.7 1 3.5l1.2 1.3C3.8 3.4 5.8 2.6 8 2.6zm0 3.6c1.3 0 2.5.5 3.4 1.3l1.2-1.3C11.4 5 9.8 4.4 8 4.4S4.6 5 3.4 6.2l1.2 1.3c.9-.8 2.1-1.3 3.4-1.3zm0 3.6c-.5 0-.9.2-1.2.5L8 11.6l1.2-1.3c-.3-.3-.7-.5-1.2-.5z" fill="currentColor"/></svg>' +
      '<svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.6" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="9" rx="2.2" fill="currentColor"/><path d="M25 4.4v4.2c.8-.3 1.4-1.1 1.4-2.1s-.6-1.8-1.4-2.1z" fill="currentColor" opacity=".45"/></svg>' +
      "</span>";
  }

  /** Renders the mobile tab bar: Threads (home), Intake, a centre new-thread button, the office and You. */
  function tabbar(el) {
    var active = el.dataset.tabbar;
    el.classList.add("tabbar");
    function t(key, label, ic, badge) {
      return (
        '<a class="tb' + (active === key ? " is-on" : "") + '" href="' + ({ office: "office.html", intake: "intake.html", threads: "session-active.html", settings: "settings.html" }[key] || "#") + '">' +
        '<span class="tb-ic">' + icon(ic, 22) + (badge ? '<b class="tb-badge">' + badge + "</b>" : "") + "</span><span>" + label + "</span></a>"
      );
    }
    var swarm = isSwarm();
    el.innerHTML =
      t("threads", "Threads", "threads", swarm ? "30" : "3") +
      t("intake", "Intake", "intake", intakeCount()) +
      '<a class="tb-new" href="session-empty.html" aria-label="New thread">' + icon("plus", 22) + "</a>" +
      t("office", "Office", "office") +
      t("settings", "You", "user");
  }

  /* ------------------------------------------------------------------ logo */

  // The mark: Triage's lime egg head with two eyes and a waxed mustache. At 16px the mustache
  // is the one detail that still reads, so it is drawn heavy with curled tips.
  var LOGO_EGG = "M16 2.4c-6.3 0-10.9 7.6-10.9 14.8 0 7.1 4.8 12.4 10.9 12.4s10.9-5.3 10.9-12.4C26.9 10 22.3 2.4 16 2.4z";
  var LOGO_TACHE =
    "M16 19.2c-1.5-1.2-3.4-1.5-5.1-.7-.9.4-1.7.3-2.3-.4-.4-.5-1.2-.3-1.1.4.3 1.9 2 3 4 2.8 1.8-.2 3.3-.9 4.5-1.8 1.2.9 2.7 1.6 4.5 1.8 2 .2 3.7-.9 4-2.8.1-.7-.7-.9-1.1-.4-.6.7-1.4.8-2.3.4-1.7-.8-3.6-.5-5.1.7z";

  /** Returns the Hercule mark as SVG markup; with mono it is drawn in currentColor. */
  function logo(size, opts) {
    size = size || 28;
    opts = opts || {};
    var fill = opts.mono ? "currentColor" : "oklch(var(--char-l) var(--char-c) var(--hue-lime))";
    var ink = opts.mono ? "var(--bg)" : "var(--face-ink)";
    return (
      '<svg class="logo" viewBox="0 0 32 32" width="' + size + '" height="' + size + '" role="img" aria-label="Hercule">' +
      '<path d="' + LOGO_EGG + '" fill="' + fill + '"/>' +
      '<g fill="' + ink + '"><circle cx="12.4" cy="14.6" r="1.55"/><circle cx="19.6" cy="14.6" r="1.55"/><path d="' + LOGO_TACHE + '"/></g></svg>'
    );
  }

  /**
   * Returns the favicon as an SVG data URL: the mark with literal colors (a favicon cannot read
   * CSS variables) and, when something waits on you, a marigold dot in the corner. The browser
   * tab is the web's one ambient signal, so the dot shows from any other tab.
   */
  function favicon(waiting) {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<path d="' + LOGO_EGG + '" fill="oklch(0.78 0.125 132)"/>' +
      '<g fill="oklch(0.23 0.025 165)"><circle cx="12.4" cy="14.6" r="1.55"/><circle cx="19.6" cy="14.6" r="1.55"/><path d="' + LOGO_TACHE + '"/></g>' +
      (waiting ? '<circle cx="25.5" cy="6.5" r="5.5" fill="oklch(0.8 0.155 78)" stroke="#fff" stroke-width="2"/>' : "") +
      "</svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  /* ------------------------------------------------------------------ placeholders */

  /** Replaces every data-face, data-you, data-mark, data-i, data-brand and data-logo placeholder under root with its SVG. */
  function drawPlaceholders(root) {
    root = root || document;
    root.querySelectorAll("[data-face]").forEach(function (el) {
      el.outerHTML = face(el.dataset.face, { pose: el.dataset.pose, size: Number(el.dataset.size) || 28 });
    });
    root.querySelectorAll("[data-you]").forEach(function (el) {
      el.outerHTML = you(Number(el.dataset.you) || 28);
    });
    root.querySelectorAll("[data-mark]").forEach(function (el) {
      el.outerHTML = mark(el.dataset.mark, Number(el.dataset.size) || 14);
    });
    root.querySelectorAll("[data-i]").forEach(function (el) {
      el.outerHTML = icon(el.dataset.i, Number(el.dataset.size) || 16);
    });
    root.querySelectorAll("[data-brand]").forEach(function (el) {
      el.outerHTML = brand(el.dataset.brand, Number(el.dataset.size) || 14);
    });
    root.querySelectorAll("[data-logo]").forEach(function (el) {
      el.outerHTML = logo(Number(el.dataset.logo) || 28, { mono: el.hasAttribute("data-mono") });
    });
  }

  /**
   * Wires the glass composer: it shrinks while the transcript is scrolled away from the bottom,
   * and restores at the bottom or on focus. ?state=scrolled forces the shrunken state.
   */
  function glassComposer() {
    var transcript = document.querySelector("[data-transcript]");
    var composer = document.querySelector("[data-composer]");
    if (!transcript || !composer) return;
    var forced = document.documentElement.dataset.state === "scrolled";
    function atBottom() {
      return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 12;
    }
    if (forced) {
      transcript.scrollTop = Math.round((transcript.scrollHeight - transcript.clientHeight) * 0.42);
      composer.classList.add("is-scrolled");
    } else {
      transcript.scrollTop = transcript.scrollHeight;
    }
    transcript.addEventListener(
      "scroll",
      function () {
        if (composer.contains(document.activeElement)) return;
        composer.classList.toggle("is-scrolled", !atBottom());
      },
      { passive: true },
    );
    composer.addEventListener("focusin", function () {
      composer.classList.remove("is-scrolled");
    });
    composer.addEventListener("click", function () {
      if (composer.classList.contains("is-scrolled")) {
        composer.classList.remove("is-scrolled");
        transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
      }
    });
  }

  /** Makes every [data-seg] group behave as a segmented control that toggles data-view on <html>. */
  function segments() {
    document.querySelectorAll("[data-seg] button").forEach(function (b) {
      b.addEventListener("click", function () {
        b.parentElement.querySelectorAll("button").forEach(function (x) {
          x.setAttribute("aria-pressed", String(x === b));
        });
        if (b.dataset.view) document.documentElement.dataset.view = b.dataset.view;
      });
      // ?state=list opens the page on the List view, so a screenshot can show it.
      if (b.dataset.view && b.dataset.view === document.documentElement.dataset.state) b.click();
    });
  }

  function boot() {
    document.querySelectorAll("[data-side]").forEach(sidebar);
    document.querySelectorAll("[data-webbar]").forEach(webbar);
    document.querySelectorAll("[data-setnav]").forEach(setnav);
    document.querySelectorAll("[data-threads]").forEach(threadpane);
    document.querySelectorAll("[data-status]").forEach(statusbar);
    document.querySelectorAll("[data-tabbar]").forEach(tabbar);
    drawPlaceholders(document);
    glassComposer();
    segments();
    // A page framed in the design book must not take focus: focusing inside an iframe scrolls the book.
    var first = document.querySelector("[data-autofocus]");
    if (first && window.top === window) first.focus();
    document.documentElement.classList.add("is-ready");
  }

  window.Crew = { favicon: favicon, face: face, you: you, icon: icon, mark: mark, brand: brand, logo: logo, lookFor: lookFor, hash: hash, drawPlaceholders: drawPlaceholders, poseWord: poseWord, WAITING: WAITING };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
