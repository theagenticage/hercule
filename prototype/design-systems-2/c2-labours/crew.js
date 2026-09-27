// PROTOTYPE - Crew Labours' runtime: the characters, icons, state marks, source marks and the shells.
// Every page loads it at the end of <body>. It turns markup like
//   <i data-face="Ada" data-pose="working" data-size="28"></i>
//   <i data-i="search"></i>   <i data-mark="waiting"></i>   <i data-brand="sentry"></i>   <i data-you></i>
// into inline SVG, and renders the shared chrome (sidebar, web bar, thread pane, tab bar, status bar).
(function () {
  "use strict";

  /* ------------------------------------------------------------------ characters */

  // Colleague hues. There are seven so none sits near gold, brick or olive, which mean states.
  var HUES = ["iris", "teal", "orchid", "sky", "peach", "mint", "grape"];
  var SHAPES = ["round", "bean", "dome", "square"];
  // The small props any hero may carry. The lion hood, the wreath, the helmet, the feather and the
  // shield are kept for the colleagues cast below, so each of those stays one character's sign.
  var PROPS = ["none", "headband", "sprig", "club"];

  // Assistants, workflows and today's live sessions are cast by hand; anyone else is generated.
  var CAST = {
    // Each assistant has one attribute nobody else wears.
    Ada: ["iris", "bean", "wreath"],
    Milo: ["sky", "round", "helmet"],
    Juno: ["orchid", "dome", "feather"],
    // Triage wears the lion hood: it is the one that cleans out the stables every morning.
    Triage: ["teal", "square", "lion"],
    // Workflows. A run wears its workflow's prop.
    "Fix bug": ["peach", "square", "club"],
    Investigate: ["sky", "round", "headband"],
    "Ship release": ["orchid", "bean", "shield"],
    "Label new issues": ["grape", "dome", "headband"],
    "Draft reply": ["teal", "bean", "sprig"],
    "Nightly backup check": ["mint", "round", "headband"],
    // Runs live right now.
    "Investigate backup timeouts": ["mint", "round", "headband"],
    "Webhook retry backoff": ["iris", "square", "club"],
    "Cart total rounding on discounts": ["teal", "dome", "club"],
    "Ship release v2.15": ["orchid", "bean", "shield"],
    "Draft reply to Jonas at Kiteworks": ["peach", "bean", "sprig"],
    // Threads live right now, cast so that neighbours in a list never look alike.
    "Fix 3-D Secure checkout for EU cards": ["peach", "round", "headband"],
    "Read the Stripe v14 changelog": ["sky", "dome", "sprig"],
    "Refactor cart totals": ["grape", "bean", "none"],
    "Tidy checkout CSS": ["mint", "square", "sprig"],
    "Payout report for September": ["iris", "round", "none"],
    "Add iDEAL research": ["teal", "dome", "headband"],
    "Migrate ops dashboards": ["mint", "square", "club"],
    "Rotate staging secrets": ["orchid", "round", "club"],
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

  /** Returns a colleague's look - hue, body shape and prop - cast by hand or hashed from its name. */
  function lookFor(name) {
    var cast = CAST[name];
    if (cast) return { hue: cast[0], shape: cast[1], prop: cast[2] };
    var h = hash(name);
    return { hue: HUES[h % HUES.length], shape: SHAPES[(h >>> 4) % 4], prop: PROPS[(h >>> 8) % PROPS.length] };
  }

  // Squat bodies on a 45-unit canvas (viewBox 3 1 45 45). TOP is where each body's head starts.
  var BODY = {
    round: '<circle cx="24" cy="27.5" r="15.5"/>',
    bean: '<rect x="9" y="11" width="30" height="31" rx="13"/>',
    dome: '<path d="M9 26.5a15 15 0 0 1 30 0v10.5a5 5 0 0 1-5 5H14a5 5 0 0 1-5-5z"/>',
    square: '<rect x="9" y="12.5" width="30" height="29.5" rx="10.5"/>',
  };
  var TOP = { round: 12, bean: 11, dome: 11.5, square: 12.5 };

  // Prop materials. Fixed colours that read on light and dark grounds, all kept brown or green so
  // no prop is mistaken for the gold of "waiting on you".
  var M = {
    leaf: "oklch(0.6 0.085 138)",
    leafDark: "oklch(0.47 0.075 138)",
    wood: "oklch(0.57 0.065 55)",
    woodDark: "oklch(0.45 0.055 50)",
    bronze: "oklch(0.72 0.085 68)",
    bronzeDark: "oklch(0.52 0.07 58)",
    pelt: "oklch(0.66 0.08 56)",
    peltDark: "oklch(0.5 0.07 48)",
    linen: "oklch(0.965 0.012 85)",
    crest: "oklch(0.44 0.07 32)",
    crestDark: "oklch(0.34 0.05 32)",
  };

  function leaf(x, y, angle, size) {
    size = size || 1;
    return '<ellipse cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" rx="' + (2.3 * size).toFixed(2) + '" ry="' + (1.05 * size).toFixed(2) + '" transform="rotate(' + angle.toFixed(1) + " " + x.toFixed(2) + " " + y.toFixed(2) + ')"/>';
  }

  /** Returns the SVG of the parts of a prop that sit behind the body. */
  function propBehind(prop, t) {
    if (prop === "helmet")
      // A crest runs front to back over the helmet, the one sign of a Greek hoplite.
      return (
        '<path d="M12.4 ' + (t + 2) + "C12.4 " + (t - 9.6) + " 35.6 " + (t - 9.6) + " 35.6 " + (t + 2) + "L31.6 " + (t + 2) + "C31.6 " + (t - 4.4) + " 16.4 " + (t - 4.4) + " 16.4 " + (t + 2) + 'z" fill="' + M.crest + '" stroke="' + M.crestDark + '" stroke-width=".8" stroke-linejoin="round"/>' +
        '<path d="M16.6 ' + (t - 4.6) + "l-1.6-1.6M20.4 " + (t - 6.2) + "l-.9-2M24 " + (t - 6.8) + "v-2.2M27.6 " + (t - 6.2) + "l.9-2M31.4 " + (t - 4.6) + 'l1.6-1.6" stroke="' + M.crestDark + '" stroke-width=".9" stroke-linecap="round"/>'
      );
    if (prop === "feather")
      // Juno's peacock feather, tucked behind the head.
      return (
        '<path d="M27 ' + (t + 3) + "C29.4 " + (t - 2) + " 31 " + (t - 5) + " 33.2 " + (t - 7.6) + '" fill="none" stroke="' + M.bronzeDark + '" stroke-width="1.2" stroke-linecap="round"/>' +
        '<g transform="rotate(34 34.6 ' + (t - 11) + ')"><path d="M34.6 ' + (t - 18.4) + "C38.4 " + (t - 15.4) + " 38.6 " + (t - 7.4) + " 34.6 " + (t - 4.4) + "C30.6 " + (t - 7.4) + " 30.8 " + (t - 15.4) + " 34.6 " + (t - 18.4) + 'z" fill="oklch(0.62 0.095 168)"/>' +
        '<ellipse cx="34.6" cy="' + (t - 10.6) + '" rx="2.3" ry="3" fill="' + M.bronze + '"/><ellipse cx="34.6" cy="' + (t - 10.4) + '" rx="1.2" ry="1.7" fill="oklch(0.38 0.1 268)"/></g>'
      );
    return "";
  }

  /** Returns the SVG of the parts of a prop that sit in front of the body and face. */
  function propFront(prop, t) {
    if (prop === "lion") {
      // The Nemean lion's pelt worn as a hood: a tufted mane, round ears, the lion's small face on
      // the crown, and a scalloped edge above the brows.
      var hood =
        "M9.4 " + (t + 12.4) + "C9.2 " + (t + 2) + " 15.6 " + (t - 2.6) + " 24 " + (t - 2.6) + "S38.8 " + (t + 2) + " 38.6 " + (t + 12.4) +
        "C36.8 " + (t + 9.8) + " 34 " + (t + 8.8) + " 31.4 " + (t + 9.8) + "C29.4 " + (t + 8) + " 26.6 " + (t + 7.6) + " 24 " + (t + 8.9) +
        "C21.4 " + (t + 7.6) + " 18.6 " + (t + 8) + " 16.6 " + (t + 9.8) + "C14 " + (t + 8.8) + " 11.2 " + (t + 9.8) + " 9.4 " + (t + 12.4) + "z";
      var tufts = "";
      [196, 214, 232, 250, 268, 286, 304, 322, 340].forEach(function (deg) {
        var a = (deg * Math.PI) / 180;
        tufts += '<circle cx="' + (24 + 14.6 * Math.cos(a)).toFixed(2) + '" cy="' + (t + 11.6 + 13.4 * Math.sin(a)).toFixed(2) + '" r="3"/>';
      });
      return (
        '<g fill="' + M.peltDark + '">' + tufts + "</g>" +
        '<circle cx="15.4" cy="' + (t - 0.4) + '" r="2.7" fill="' + M.pelt + '" stroke="' + M.peltDark + '" stroke-width=".7"/><circle cx="32.6" cy="' + (t - 0.4) + '" r="2.7" fill="' + M.pelt + '" stroke="' + M.peltDark + '" stroke-width=".7"/>' +
        '<path d="' + hood + '" fill="' + M.pelt + '" stroke="' + M.peltDark + '" stroke-width=".8" stroke-linejoin="round"/>' +
        '<g fill="' + M.crestDark + '"><circle cx="21" cy="' + (t + 2.2) + '" r=".85"/><circle cx="27" cy="' + (t + 2.2) + '" r=".85"/><path d="M22.8 ' + (t + 3.8) + "h2.4l-1.2 1.4z" + '"/></g>'
      );
    }
    if (prop === "helmet")
      return (
        '<path d="M9.2 ' + (t + 10.6) + "C9.2 " + (t + 1.6) + " 16 " + (t - 2.2) + " 24 " + (t - 2.2) + "S38.8 " + (t + 1.6) + " 38.8 " + (t + 10.6) + "Q24 " + (t + 6.2) + " 9.2 " + (t + 10.6) + 'z" fill="' + M.bronze + '" stroke="' + M.bronzeDark + '" stroke-width=".8" stroke-linejoin="round"/>' +
        '<path d="M10.4 ' + (t + 8.6) + "Q24 " + (t + 4.4) + " 37.6 " + (t + 8.6) + '" fill="none" stroke="' + M.bronzeDark + '" stroke-width=".9"/>' +
        '<ellipse cx="17.6" cy="' + (t + 2.2) + '" rx="3" ry="1.3" transform="rotate(-24 17.6 ' + (t + 2.2) + ')" fill="#fff" opacity=".35"/>'
      );
    if (prop === "wreath") {
      // Laurel leaves along an arc over the head, two branches meeting at the brow.
      var cx = 24;
      var cy = t + 13.4;
      var r = 13.6;
      var leaves = "";
      [-168, -150, -132, -114, -12, -30, -48, -66].forEach(function (deg, i) {
        var a = (deg * Math.PI) / 180;
        leaves += leaf(cx + r * Math.cos(a), cy + r * Math.sin(a), deg + (i < 4 ? 70 : 110));
      });
      return '<path d="M11.6 ' + (t + 9.2) + "A13.6 13.6 0 0 1 36.4 " + (t + 9.2) + '" fill="none" stroke="' + M.leafDark + '" stroke-width=".9"/><g fill="' + M.leaf + '">' + leaves + "</g>";
    }
    if (prop === "sprig")
      return (
        '<path d="M29.4 ' + (t + 3) + "C31 " + t + " 33 " + (t - 2.6) + " 36 " + (t - 4) + '" fill="none" stroke="' + M.leafDark + '" stroke-width=".9" stroke-linecap="round"/>' +
        '<g fill="' + M.leaf + '">' + leaf(31.6, t - 0.6, -70, 0.85) + leaf(33.6, t - 3.6, -40, 0.85) + leaf(34.8, t - 1.2, 10, 0.85) + leaf(36.6, t - 4.2, -25, 0.8) + "</g>"
      );
    if (prop === "headband")
      return (
        '<path d="M9.4 ' + (t + 8.2) + "Q24 " + (t + 3.6) + " 38.6 " + (t + 8.2) + '" fill="none" stroke="oklch(0 0 0 / .14)" stroke-width="3.3"/>' +
        '<path d="M9.4 ' + (t + 8.2) + "Q24 " + (t + 3.6) + " 38.6 " + (t + 8.2) + '" fill="none" stroke="' + M.linen + '" stroke-width="2.5"/>' +
        '<path d="M37.8 ' + (t + 7.8) + "l3.4 2.8M37.8 " + (t + 7.8) + 'l3.9-.4" fill="none" stroke="' + M.linen + '" stroke-width="1.7" stroke-linecap="round"/>'
      );
    if (prop === "club")
      return (
        '<path d="M12.2 40.2L8.6 29.6" stroke="' + M.woodDark + '" stroke-width="2.4" stroke-linecap="round"/>' +
        '<path d="M8.3 30.4C5.6 29.8 4.6 26.6 5.4 24.2 6.2 21.8 9 21.2 10.4 23.2 11.4 24.8 11 28.6 10.2 30z" fill="' + M.wood + '" stroke="' + M.woodDark + '" stroke-width=".7"/>' +
        '<ellipse cx="11.4" cy="37.2" rx="2.6" ry="2.1" fill="var(--who-shade)"/>'
      );
    if (prop === "shield")
      return (
        '<circle cx="10.8" cy="36.2" r="5.8" fill="' + M.bronze + '" stroke="' + M.bronzeDark + '" stroke-width=".9"/>' +
        '<circle cx="10.8" cy="36.2" r="3.7" fill="none" stroke="' + M.bronzeDark + '" stroke-width=".7"/><circle cx="10.8" cy="36.2" r="1.3" fill="' + M.bronzeDark + '"/>'
      );
    return "";
  }

  function eyes(pose, bold) {
    var ink = 'fill="var(--face-ink)"';
    var stroke = 'fill="none" stroke="var(--face-ink)" stroke-width="' + (bold ? 1.9 : 1.5) + '" stroke-linecap="round"';
    var r = bold ? 1.2 : 1;
    function glint(x, y) {
      return '<circle cx="' + (x + 0.75) + '" cy="' + (y - 0.95) + '" r="' + 0.72 * r + '" fill="#fff" opacity=".9"/>';
    }
    function open(dy, ry) {
      return [19, 29]
        .map(function (x) {
          return '<ellipse cx="' + x + '" cy="' + (26 + dy) + '" rx="' + 2 * r + '" ry="' + ry * r + '" ' + ink + "/>" + glint(x, 26 + dy);
        })
        .join("");
    }
    function each(draw) {
      return [19, 29].map(draw).join("");
    }
    if (pose === "working")
      return each(function (x) {
        return '<path d="M' + (x - 2.3 * r) + " 26.2a" + 2.3 * r + " " + 2.3 * r + " 0 0 0 " + 4.6 * r + ' 0z" ' + ink + "/>";
      });
    if (pose === "paused")
      return each(function (x) {
        return '<path d="M' + (x - 2.2 * r) + " 26.4h" + 4.4 * r + '" ' + stroke + "/>";
      });
    if (pose === "asleep")
      return each(function (x) {
        return '<path d="M' + (x - 2.3) + ' 26.3q2.3 2 4.6 0" ' + stroke + "/>";
      });
    if (pose === "done")
      return each(function (x) {
        return '<path d="M' + (x - 2.3) + ' 27.2q2.3-2.8 4.6 0" ' + stroke + "/>";
      });
    if (pose === "away")
      return each(function (x) {
        return '<circle cx="' + (x - 1) + '" cy="26.5" r="' + 1.5 * r + '" ' + ink + "/>";
      });
    if (pose === "waiting") return open(-0.6, 2.75);
    return open(0, 2.55);
  }

  function brows(pose, bold) {
    var s = 'fill="none" stroke="var(--face-ink)" stroke-width="' + (bold ? 1.6 : 1.25) + '" stroke-linecap="round"';
    if (pose === "waiting") return '<path d="M16.9 21.4q2.1-1.4 4.2 0M26.9 21.4q2.1-1.4 4.2 0" ' + s + "/>";
    if (pose === "failed") return '<path d="M16.8 22.4l4.2-1.5M31.2 22.4l-4.2-1.5" ' + s + "/>";
    return "";
  }

  function mouth(pose, bold) {
    var s = 'fill="none" stroke="var(--face-ink)" stroke-width="' + (bold ? 1.8 : 1.45) + '" stroke-linecap="round"';
    if (pose === "working") return '<path d="M22.6 32.2h2.8" ' + s + "/>";
    if (pose === "paused") return '<path d="M22.4 32.2h3.2" ' + s + "/>";
    if (pose === "waiting") return '<ellipse cx="24" cy="32.2" rx="1.55" ry="1.8" fill="var(--face-ink)"/>';
    if (pose === "asleep") return '<path d="M23 32.3q1 .8 2 0" ' + s + "/>";
    if (pose === "failed") return '<path d="M21.4 33q1.3-1.3 2.6 0t2.6 0" ' + s + "/>";
    if (pose === "done") return '<path d="M20.8 30.8q3.2 3.4 6.4 0" ' + s + "/>";
    if (pose === "away") return '<path d="M22.2 32.3h3.6" ' + s + ' stroke-dasharray=".1 1.8"/>';
    return '<path d="M21.6 31.2q2.4 2.3 4.8 0" ' + s + "/>";
  }

  // What a pose adds around the body: hands on a laptop, a raised gold palm, z's, or a small badge.
  function extras(pose) {
    if (pose === "working")
      return (
        '<rect x="11" y="41.2" width="26" height="3.4" rx="1.7" fill="var(--face-ink)" opacity=".82"/>' +
        '<g fill="var(--who-shade)" stroke="var(--face-ink)" stroke-opacity=".25" stroke-width=".6"><ellipse class="cr-tap" cx="17.5" cy="40.6" rx="3" ry="2"/>' +
        '<ellipse class="cr-tap cr-tap--2" cx="30.5" cy="40.6" rx="3" ry="2"/></g>'
      );
    if (pose === "waiting")
      return (
        '<g class="cr-wave"><path d="M37 31C40.6 28.6 42 23.2 42.2 17.6" fill="none" stroke="var(--who-shade)" stroke-width="3.4" stroke-linecap="round"/>' +
        '<rect x="38.2" y="6.8" width="8" height="10.6" rx="4" fill="var(--you)" stroke="var(--who-shade)" stroke-width="1.3"/>' +
        '<ellipse cx="38" cy="13.4" rx="1.7" ry="2.5" transform="rotate(-32 38 13.4)" fill="var(--you)" stroke="var(--who-shade)" stroke-width="1.1"/></g>'
      );
    if (pose === "asleep")
      return '<g class="cr-z" fill="var(--muted)" font-family="var(--font-ui)" font-weight="760"><text x="37" y="15" font-size="10">z</text><text x="42.4" y="8.4" font-size="7">z</text></g>';
    if (pose === "failed")
      return (
        '<g transform="rotate(-32 31 16)"><rect x="25.2" y="13.2" width="12" height="5.4" rx="2.7" fill="oklch(0.95 0.03 75)" stroke="oklch(0.72 0.05 60)" stroke-width=".7"/>' +
        '<rect x="29.5" y="13.9" width="3.4" height="4" rx=".8" fill="oklch(0.86 0.05 65)"/></g>' +
        badge("var(--fail)", '<path d="M40 36.6v2.6" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="40" cy="41.2" r=".85" fill="#fff"/>')
      );
    if (pose === "done") return badge("var(--raised)", '<path d="M37.6 39.2l1.6 1.6 3.2-3.4" fill="none" stroke="var(--ink)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>', true);
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
   * Returns the SVG markup of a colleague: a small sturdy hero whose pose is its state.
   * name  - the colleague's name; its look is cast or hashed from it.
   * opts  - { pose: working|waiting|idle|asleep|failed|paused|done|away, size: px }
   */
  function face(name, opts) {
    opts = opts || {};
    var look = opts.look || lookFor(name);
    var pose = opts.pose || "idle";
    var size = opts.size || 28;
    var bold = size < 30;
    var t = TOP[look.shape];
    var body = BODY[look.shape];
    var delay = (4 + (hash(name + ++uidCounter) % 700) / 100).toFixed(2);
    var blinks = pose === "idle" || pose === "working" || pose === "waiting" || pose === "failed";
    return (
      '<svg class="cr cr--' + pose + '" viewBox="3 1 45 45" width="' + size + '" height="' + size + '" role="img" aria-label="' + name.replace(/"/g, "&quot;") + ", " + poseWord(pose) + '" style="--hue:var(--hue-' + look.hue + ')">' +
      propBehind(look.prop, t) +
      // Two small feet under the body make the stance sturdy.
      '<g fill="var(--who-shade)"><ellipse cx="17.4" cy="43.3" rx="4.4" ry="2.6"/><ellipse cx="30.6" cy="43.3" rx="4.4" ry="2.6"/></g>' +
      '<g fill="var(--who-shade)">' + body + "</g>" +
      '<g fill="var(--who)" transform="translate(0 -2.2)">' + body + "</g>" +
      '<ellipse cx="16.6" cy="' + (t + 5.2) + '" rx="3.8" ry="2.2" transform="rotate(-28 16.6 ' + (t + 5.2) + ')" fill="#fff" opacity=".3"/>' +
      '<g transform="translate(0 -1.2)">' +
      '<ellipse cx="15.2" cy="30.6" rx="2.6" ry="1.6" fill="var(--blush)"/><ellipse cx="32.8" cy="30.6" rx="2.6" ry="1.6" fill="var(--blush)"/>' +
      '<g class="' + (blinks ? "cr-eyes" : "") + '" style="animation-delay:' + delay + 's">' + eyes(pose, bold) + "</g>" +
      brows(pose, bold) + mouth(pose, bold) + "</g>" +
      propFront(look.prop, t) +
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

  /** Returns the SVG markup of the user's own avatar: a letter on stone, because people are not characters. */
  function you(size) {
    size = size || 28;
    return (
      '<svg class="cr-you" viewBox="0 0 32 32" width="' + size + '" height="' + size + '" role="img" aria-label="Rogier">' +
      '<circle cx="16" cy="16" r="15.5" fill="var(--sunken)"/><circle cx="16" cy="16" r="15" fill="none" stroke="var(--line)"/>' +
      '<text x="16" y="21.2" text-anchor="middle" font-family="var(--font-ui)" font-size="15" font-weight="680" fill="var(--ink)">R</text></svg>'
    );
  }

  /* ------------------------------------------------------------------ icons and state marks */

  // One outline family: 16px grid, 1.5 stroke, round caps.
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
    // The office is a courtyard: a small portico.
    office: '<path d="M2.4 5.8L8 2.6l5.6 3.2z"/><path d="M4.4 7.6v4.4M8 7.6v4.4M11.6 7.6v4.4M2.4 13.6h11.2"/>',
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
    editor: '<path d="M5.6 5L2.6 8l3 3M10.4 5l3 3-3 3M9 3.4L7 12.6"/>',
    moon: '<path d="M12.8 9.8A5.4 5.4 0 0 1 6.2 3.2a5.4 5.4 0 1 0 6.6 6.6z"/>',
    sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/>',
    key: '<circle cx="5.4" cy="10.6" r="2.8"/><path d="M7.4 8.6l5.4-5.4M11 4.8l1.6 1.6M9.6 6.2l1.2 1.2"/>',
    lock: '<rect x="3.4" y="7" width="9.2" height="6.6" rx="1.8"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
    globe: '<circle cx="8" cy="8" r="5.8"/><path d="M2.4 8h11.2M8 2.2c-2.6 3.4-2.6 8.2 0 11.6M8 2.2c2.6 3.4 2.6 8.2 0 11.6"/>',
    filter: '<path d="M2.6 3.6h10.8M4.6 8h6.8M6.6 12.4h2.8"/>',
    heart: '<path d="M2.2 8.2h2.6l1.4-3 2.2 6 1.6-3.4h3.8"/>',
    memory: '<path d="M3.4 2.8h7.4a1.8 1.8 0 0 1 1.8 1.8v8.6H5.2a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M3.4 11.4a1.8 1.8 0 0 1 1.8-1.8h7.4M6 5.4h4"/>',
    alarm: '<circle cx="8" cy="8.8" r="4.8"/><path d="M8 6.6v2.4l1.6 1M2.6 3.6l1.8-1.4M13.4 3.6l-1.8-1.4"/>',
    hand: '<path d="M5.4 8.4V4.2a1 1 0 0 1 2 0v3.4V3.2a1 1 0 0 1 2 0v4.4V4.2a1 1 0 0 1 2 0v5.6c0 2.4-1.6 4.2-4 4.2-1.6 0-2.6-.8-3.4-2L2.6 9.4a1 1 0 0 1 1.5-1.2l1.3 1.2"/>',
    question: '<circle cx="8" cy="8" r="5.8"/><path d="M6.3 6.4a1.8 1.8 0 0 1 3.5.5c0 1.2-1.8 1.4-1.8 2.6"/><circle cx="8" cy="11.4" r=".4"/>',
    pause: '<path d="M6 4v8M10 4v8"/>',
    play: '<path d="M5.4 3.6v8.8L12.2 8z"/>',
    calendar: '<rect x="2.6" y="3.4" width="10.8" height="10" rx="2"/><path d="M2.6 6.8h10.8M5.6 2v2.6M10.4 2v2.6"/>',
    eye: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.9"/>',
    terminal: '<rect x="2" y="2.8" width="12" height="10.4" rx="2"/><path d="M4.8 6.2l2 1.8-2 1.8M8.4 10h2.8"/>',
    file: '<path d="M4 2.4h5l3 3v8.2H4z"/><path d="M9 2.4v3h3"/>',
    diff: '<path d="M5 2.6v6M2 5.6h6M8.6 11.8H14"/>',
    link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6"/>',
    people: '<circle cx="5.6" cy="6" r="2.4"/><circle cx="11" cy="6.8" r="2"/><path d="M1.8 13.2c.4-2.4 1.8-3.8 3.8-3.8s3.4 1.4 3.8 3.8M9.6 10a3 3 0 0 1 4.6 3"/>',
    mail: '<rect x="2" y="3.4" width="12" height="9.2" rx="1.8"/><path d="M2.6 4.4L8 8.6l5.4-4.2"/>',
    chat: '<path d="M2.4 8a5.6 5 0 1 1 2.4 4.1L2.4 13l.7-2.4A4.8 4.8 0 0 1 2.4 8z"/>',
    user: '<circle cx="8" cy="5.6" r="2.8"/><path d="M2.8 13.6c.6-2.8 2.6-4.4 5.2-4.4s4.6 1.6 5.2 4.4"/>',
    palette: '<path d="M8 2.2a5.8 5.8 0 0 0 0 11.6c1 0 1.4-.6 1.4-1.3 0-1.2-1-1.3-1-2.3 0-.8.6-1.3 1.4-1.3h1.6a2.6 2.6 0 0 0 2.6-2.6C14 4.6 11.4 2.2 8 2.2z"/><circle cx="5.2" cy="7.2" r=".6"/><circle cx="7.6" cy="4.8" r=".6"/><circle cx="10.6" cy="5.8" r=".6"/>',
    plug: '<path d="M6 2.6v2.6M10 2.6v2.6M4.2 5.2h7.6v2.4a3.8 3.8 0 0 1-7.6 0zM8 11.4v2.2"/>',
    cpu: '<rect x="4" y="4" width="8" height="8" rx="1.6"/><path d="M6.4 1.8V4M9.6 1.8V4M6.4 12v2.2M9.6 12v2.2M1.8 6.4H4M1.8 9.6H4M12 6.4h2.2M12 9.6h2.2"/>',
    id: '<rect x="2" y="3.4" width="12" height="9.2" rx="2"/><circle cx="6" cy="7.4" r="1.4"/><path d="M4 10.8c.4-1 1.2-1.6 2-1.6s1.6.6 2 1.6M9.6 6.6h2.6M9.6 9h2"/>',
    bound: '<path d="M2.4 12.4h11.2M4 12.4V8.6M7 12.4V5.4M10 12.4V7.2M13 12.4V3.6"/>',
    puzzle: '<path d="M3 5.2h2.6a1.4 1.4 0 1 1 2.8 0H11v2.6a1.4 1.4 0 1 1 0 2.8v2.6H3z"/>',
    system: '<rect x="2.2" y="2.8" width="11.6" height="8.2" rx="1.6"/><path d="M6 13.4h4M8 11v2.4"/>',
    arrow: '<path d="M3 8h9.4M8.8 4.4L12.4 8l-3.6 3.6"/>',
    undo: '<path d="M5.4 4.4L2.8 7l2.6 2.6"/><path d="M3 7h6.4a3.4 3.4 0 0 1 0 6.8H7"/>',
    hash: '<path d="M6.2 2.6L5 13.4M11 2.6L9.8 13.4M2.8 5.8h10.6M2.4 10.2H13"/>',
    wave: '<path d="M2.4 8h1.6l1.4-3.4 2 7 2-9 1.8 7.2 1.2-1.8h1.2"/>',
    // The aqueduct: two arches under a channel. It stands for the event flow.
    aqueduct: '<path d="M1.8 4.4h12.4M1.8 6.6h12.4M2.6 13.4V9.4a2.2 2.2 0 0 1 4.4 0v4M9 13.4V9.4a2.2 2.2 0 0 1 4.4 0v4"/>',
  };

  /** Returns the SVG markup of an icon, drawn in currentColor. Fails when the icon does not exist. */
  function icon(name, size) {
    size = size || 16;
    var body = ICONS[name];
    if (!body) throw new Error("There is no icon named " + name);
    return (
      '<svg class="ic" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body.replace(/<circle cx="([\d.]+)" cy="([\d.]+)" r="\.([456])"\/>/g, '<circle cx="$1" cy="$2" r=".$3" fill="currentColor"/>') +
      "</svg>"
    );
  }

  // The six state marks. Each means one thing, and the book explains each once.
  // Queued is not a state mark: it uses the clock icon.
  var MARKS = {
    working: '<circle cx="8" cy="8" r="5.5" stroke-opacity=".28"/><path class="mk-arc" d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/>',
    waiting: '<circle cx="8" cy="8" r="6.5" fill="currentColor" stroke="none"/><path d="M6.35 6.5a1.7 1.7 0 0 1 3.3.45c0 1.1-1.65 1.25-1.65 2.4" stroke="var(--face-ink)" stroke-width="1.45"/><circle cx="8" cy="11.35" r=".8" fill="var(--face-ink)" stroke="none"/>',
    done: '<circle cx="8" cy="8" r="5.75"/><path d="M5.5 8.2l1.7 1.7 3.3-3.5"/>',
    failed: '<circle cx="8" cy="8" r="6.5" fill="currentColor" stroke="none"/><path d="M8 4.9v3.6" stroke="#fff" stroke-width="1.6"/><circle cx="8" cy="11" r=".85" fill="#fff" stroke="none"/>',
    paused: '<circle cx="8" cy="8" r="5.75"/><path d="M6.6 6.1v3.8M9.4 6.1v3.8"/>',
    idle: '<circle cx="8" cy="8" r="4.6"/>',
  };

  /** Returns the SVG markup of a state mark. Fails when the state has no mark. */
  function mark(state, size) {
    size = size || 14;
    if (!MARKS[state]) throw new Error("There is no state mark for " + state);
    return (
      '<svg class="mk mk--' + state + '" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="' + poseWord(state) + '">' +
      MARKS[state] +
      "</svg>"
    );
  }

  /** Returns the SVG markup of a source system's mark, monochrome. "pi", "cron" and "web" have no brand file. */
  function brand(name, size) {
    size = size || 14;
    if (name === "pi")
      return '<svg class="br" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2.6 4.6h10.8M6 4.6v8M10.2 4.6v6.4c0 1 .5 1.6 1.5 1.6"/></svg>';
    if (name === "cron") return icon("clock", size);
    if (name === "web") return icon("chat", size);
    var d = (window.CREW_BRANDS || {})[name];
    if (!d) throw new Error("There is no source mark named " + name);
    return '<svg class="br" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="currentColor" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  /* ------------------------------------------------------------------ the world */

  // Waiting on you: the three asks, shared by the sidebar, the web and the office.
  var WAITING = [
    { name: "Fix 3-D Secure checkout for EU cards", short: "Fix 3-D Secure checkout", project: "webshop", ask: "Allow git push?", href: "session-active.html" },
    { name: "Migrate ops dashboards", short: "Migrate ops dashboards", project: "ops", ask: "Keep the old Grafana folder?", href: "#" },
    { name: "Ship release v2.15", short: "Ship release v2.15", project: "payments-api", ask: "Publish to npm?", href: "#" },
  ];

  // The live threads, grouped by project. Runs and assistants are not threads.
  var PROJECTS = [
    {
      key: "webshop",
      name: "webshop",
      threads: [
        { key: "fix", title: "Fix 3-D Secure checkout for EU cards", meta: "Opus 5.5 · studio-mac", state: "waiting", href: "session-active.html" },
        { key: "stripe", title: "Read the Stripe v14 changelog", meta: "Sonnet 5 · studio-mac", state: "idle", age: "20m" },
        { title: "Refactor cart totals", meta: "Sonnet 5 · build-box-1", state: "working", age: "22m" },
        { title: "Tidy checkout CSS", meta: "Haiku 4.5 · build-box-1", state: "idle", age: "2h" },
      ],
    },
    {
      key: "payments",
      name: "payments-api",
      threads: [
        { title: "Payout report for September", meta: "gpt-5.4 · build-box-1", state: "working", age: "9m" },
        { title: "Add iDEAL research", meta: "gpt-5.4 · build-box-2", state: "idle", age: "1h" },
      ],
    },
    {
      key: "ops",
      name: "ops",
      threads: [
        { title: "Migrate ops dashboards", meta: "qwen3-coder · studio-mac", state: "waiting" },
        { title: "Rotate staging secrets", meta: "Sonnet 5 · build-box-1", state: "working", age: "11m" },
      ],
    },
  ];

  var ASSISTANTS = [
    { name: "Ada", pose: "working", note: "working" },
    { name: "Milo", pose: "idle", note: "idle" },
    { name: "Juno", pose: "asleep", note: "asleep" },
  ];

  /* ------------------------------------------------------------------ shells */

  function isSwarm() {
    // ?state=swarm shows the same shell at ten times today's load.
    return document.documentElement.dataset.state === "swarm";
  }

  /**
   * Returns the "Waiting on you" section. Each ask shows the face of the thread or run that asks,
   * waving a gold palm, the question on one line and the thread's name under it.
   */
  function waitingSection() {
    var swarm = isSwarm();
    return (
      '<div class="side-h"><span>Waiting on you</span><b class="count count--you">' + (swarm ? "10" : "3") + "</b></div>" +
      '<div class="side-list">' +
      WAITING.map(function (w) {
        return (
          '<a class="who-row" href="' + w.href + '">' + face(w.name, { pose: "waiting", size: 28 }) +
          '<span class="who-text"><span class="who-name">' + w.ask + '</span><span class="who-sub">' + w.short + "</span></span></a>"
        );
      }).join("") +
      (swarm ? '<a class="nav-row" href="intake.html"><span>7 more waiting</span>' + icon("chev-r", 14) + "</a>" : "") +
      "</div>"
    );
  }

  /** Returns one thread row: title, a quiet meta line, and a state mark or its age on the right. */
  function threadRow(t, activeKey) {
    var end = "";
    if (t.state === "waiting") end = mark("waiting");
    else if (t.state === "working") end = t.age + mark("working");
    else end = t.age;
    return (
      '<a class="th-row' + (t.key && t.key === activeKey ? " is-on" : "") + '" href="' + (t.href || "#") + '">' +
      '<span class="th-title">' + t.title + '</span><span class="th-end">' + end + '</span><span class="th-meta">' + t.meta + "</span></a>"
    );
  }

  /** Returns the threads grouped by project; the row whose key is activeKey is selected. */
  function projectGroups(activeKey) {
    var swarm = isSwarm();
    return PROJECTS.map(function (p, i) {
      var rows = swarm ? p.threads.slice(0, 2) : p.threads;
      var more = swarm ? '<a class="nav-row" href="#"><span>' + [14, 9, 11][i] + " more threads</span>" + icon("chev-r", 14) + "</a>" : "";
      return (
        '<div class="side-h"><span class="proj proj--' + p.key + '">' + p.name + '</span><a class="icon-btn icon-btn--sm" href="session-empty.html" title="New thread in ' + p.name + '">' + icon("plus", 14) + "</a></div>" +
        '<div class="side-list">' + rows.map(function (t) {
          return threadRow(t, activeKey);
        }).join("") + more + "</div>"
      );
    }).join("");
  }

  function assistantRows(activeName) {
    return (
      '<div class="side-h"><span>Assistants</span></div><div class="side-list">' +
      ASSISTANTS.map(function (a) {
        return (
          '<a class="who-row' + (a.name === activeName ? " is-on" : "") + '" href="assistant.html">' + face(a.name, { pose: a.pose, size: 24 }) +
          '<span class="who-text"><span class="who-name">' + a.name + '</span></span><span class="who-state">' + a.note + "</span></a>"
        );
      }).join("") +
      (isSwarm() ? '<a class="nav-row" href="#"><span>1 more assistant</span>' + icon("chev-r", 14) + "</a>" : "") +
      "</div>"
    );
  }

  var NAV_HREF = {
    office: "office.html",
    intake: "intake.html",
    settings: "settings-appearance.html",
  };

  function navRow(key, label, ic, active, count, extra) {
    return (
      '<a class="nav-row' + (active === key ? " is-on" : "") + '" href="' + (NAV_HREF[key] || "#") + '"' + (active === key ? ' aria-current="page"' : "") + ">" +
      icon(ic) + "<span>" + label + "</span>" + (extra || "") + (count ? '<b class="count">' + count + "</b>" : "") + "</a>"
    );
  }

  /**
   * Renders the desktop sidebar. "Waiting on you" sits on top and stays put; under it are two tabs,
   * Threads (the threads by project, then the assistants) and Hercule (the places), and only the
   * tab under it scrolls. data-side names the open page:
   * threads, threads-new and assistants open on Threads; intake, office and settings on Hercule.
   */
  function sidebar(el) {
    var active = el.dataset.side;
    var swarm = isSwarm();
    var onThreads = active === "threads" || active === "threads-new" || active === "assistants";
    var threadKey = active === "threads" ? "fix" : "";
    el.classList.add("side");
    el.dataset.panel = onThreads ? "threads" : "hercule";
    el.innerHTML =
      '<div class="side-top"><span class="tl"><i></i><i></i><i></i></span>' +
      '<div class="seg" role="tablist"><button role="tab" data-panel="threads" aria-pressed="' + onThreads + '">Threads</button><button role="tab" data-panel="hercule" aria-pressed="' + !onThreads + '">Hercule</button></div></div>' +
      '<nav class="nav">' +
      '<a class="nav-row' + (active === "threads-new" ? " is-on" : "") + '" href="session-empty.html">' + icon("compose") + "<span>New thread</span><kbd>⌘N</kbd></a>" +
      '<button class="nav-row">' + icon("search") + "<span>Search</span><kbd>⌘K</kbd></button>" +
      "</nav>" +
      waitingSection() +
      '<div class="side-panel side-panel--threads">' + projectGroups(threadKey) + assistantRows(active === "assistants" ? "Ada" : "") + "</div>" +
      '<div class="side-panel side-panel--hercule">' +
      '<div class="side-h"><span>Work</span></div><div class="side-list">' +
      navRow("intake", "Intake", "intake", active, swarm ? "87" : "9") +
      navRow("checkin", "Check-in", "checkin", active) +
      navRow("tasks", "Tasks", "tasks", active, swarm ? "180" : "23") +
      navRow("runs", "Runs", "runs", active, swarm ? "44" : "6") +
      navRow("workflows", "Workflows", "workflows", active, swarm ? "14" : "6") +
      '</div><div class="side-h"><span>System</span></div><div class="side-list">' +
      navRow("fleet", "Fleet", "fleet", active, swarm ? "9" : "3") +
      navRow("office", "Office", "office", active, swarm ? "140" : "16") +
      // Discord has been reconnecting since 09:12, so Connections carries the one warning dot.
      navRow("connections", "Connections", "connections", active, "", '<i class="dot dot--fail" title="Discord is reconnecting"></i>') +
      navRow("notifications", "Notifications", "bell", active) +
      navRow("settings", "Settings", "settings", active) +
      "</div></div>" +
      '<div class="side-foot"><span class="side-pulse">' + (swarm ? "140 live · 70 working · 10 waiting" : "8 working · 3 waiting · 1 paused · 4 idle") + "</span>" +
      '<span class="side-me">' + you(24) + "<b>Rogier</b></span></div>";
    el.querySelectorAll(".seg button").forEach(function (b) {
      b.addEventListener("click", function () {
        el.dataset.panel = b.dataset.panel;
        el.querySelectorAll(".seg button").forEach(function (x) {
          x.setAttribute("aria-pressed", String(x === b));
        });
      });
    });
  }

  // The settings domains, grouped. Only the pages this prototype draws have links.
  var SETTINGS = [
    ["You", [["profile", "Profile", "user"], ["appearance", "Appearance", "palette"], ["threads", "Threads", "threads"]]],
    ["Workspace", [["assistants", "Assistants", "people"], ["connections", "Connections", "connections"], ["providers", "Providers", "cpu"], ["machines", "Machines", "fleet"]]],
    ["Safety", [["identities", "Identities", "id"], ["profiles", "Permission profiles", "shield"], ["secrets", "Secrets", "key"], ["bounds", "Bounds", "bound"]]],
    ["System", [["plugins", "Plugins", "puzzle"], ["system", "System", "system"]]],
  ];

  /** Renders the settings domain list; data-setnav names the open domain. */
  function setnav(el) {
    var active = el.dataset.setnav;
    var web = location.pathname.indexOf("/web/") !== -1;
    var pages = web ? { providers: 1 } : { appearance: 1, assistants: 1, connections: 1 };
    el.classList.add("set-nav");
    el.innerHTML = SETTINGS.map(function (group) {
      return (
        '<div class="side-h"><span>' + group[0] + "</span></div>" +
        group[1].map(function (d) {
          var href = pages[d[0]] ? "settings-" + d[0] + ".html" : "#";
          var dot = d[0] === "connections" ? '<i class="dot dot--fail" title="Discord is reconnecting"></i>' : "";
          return '<a class="nav-row' + (active === d[0] ? " is-on" : "") + '" href="' + href + '">' + icon(d[2]) + "<span>" + d[1] + "</span>" + dot + "</a>";
        }).join("")
      );
    }).join("");
  }

  /** Renders the web's thread pane: the same Threads panel as the desktop sidebar, beside the thread. */
  function threadpane(el) {
    var key = el.dataset.threads;
    el.classList.add("tpane");
    el.innerHTML =
      '<div class="tpane-top"><button class="side-search">' + icon("search", 14) + "<span>Find a thread</span><kbd>/</kbd></button>" +
      '<a class="icon-btn" href="session-empty.html" title="New thread">' + icon("compose") + "</a></div>" +
      '<div class="tpane-list">' + waitingSection() + projectGroups(key) + "</div>";
  }

  // The web set has no office page, and its settings open on Providers.
  var WEB_HREF = {
    intake: "intake.html",
    threads: "session-active.html",
    assistants: "assistant.html",
    settings: "settings-providers.html",
  };

  /** Renders the web top bar: the mark, places as tabs, the waiting faces and search. */
  function webbar(el) {
    var active = el.dataset.webbar;
    el.classList.add("webbar");
    var link = document.createElement("link");
    link.rel = "icon";
    link.href = favicon(WAITING.length > 0);
    document.head.appendChild(link);
    function tab(key, label, count) {
      return '<a class="wtab' + (active === key ? " is-on" : "") + '" href="' + (WEB_HREF[key] || "#") + '">' + label + (count ? ' <b class="count">' + count + "</b>" : "") + "</a>";
    }
    el.innerHTML =
      '<a class="wb-mark" href="session-active.html">' + logo(24) + "<span>Hercule</span></a>" +
      '<nav class="wtabs">' + tab("threads", "Threads") + tab("intake", "Intake", "9") + tab("runs", "Runs", "6") + tab("assistants", "Assistants") + tab("fleet", "Fleet") + tab("settings", "Settings") + "</nav>" +
      '<div class="wb-right">' +
      '<button class="wb-waiting" title="3 things are waiting on you">' + mark("waiting") + '<span class="stack">' +
      WAITING.map(function (w) {
        return face(w.name, { pose: "waiting", size: 24 });
      }).join("") +
      "</span><span>3 waiting</span></button>" +
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

  /** Renders the mobile tab bar. Threads is home; its gold badge counts what waits on you. */
  function tabbar(el) {
    var active = el.dataset.tabbar;
    el.classList.add("tabbar");
    function t(key, label, ic, badge, quiet) {
      return (
        '<a class="tb' + (active === key ? " is-on" : "") + '" href="' + ({ office: "office.html", intake: "intake.html", threads: "session-active.html", settings: "settings.html" }[key] || "#") + '">' +
        '<span class="tb-ic">' + icon(ic, 22) + (badge ? '<b class="tb-badge' + (quiet ? " tb-badge--quiet" : "") + '">' + badge + "</b>" : "") + "</span><span>" + label + "</span></a>"
      );
    }
    el.innerHTML =
      t("threads", "Threads", "threads", "3") +
      t("intake", "Intake", "intake", "9", true) +
      '<a class="tb-new" href="session-empty.html" aria-label="New thread">' + icon("compose", 22) + "</a>" +
      t("office", "Office", "office") +
      t("settings", "You", "user");
  }

  /* ------------------------------------------------------------------ the mark */

  /**
   * Returns the Hercule mark: the Hercules knot, drawn as two interlocked loops - one terracotta,
   * one ink - each passing over the other once. The knot ties two strands into one, as Hercule ties
   * events, colleagues and the user together.
   */
  function logo(size) {
    size = size || 28;
    var ink = "var(--logo-ink, var(--ink))";
    var terra = "var(--terra)";
    return (
      '<svg class="logo" viewBox="0 0 32 32" width="' + size + '" height="' + size + '" role="img" aria-label="Hercule" fill="none" stroke-width="3.6">' +
      '<rect x="12.5" y="9" width="16" height="14" rx="7" stroke="' + ink + '"/>' +
      '<rect x="3.5" y="9" width="16" height="14" rx="7" stroke="' + terra + '"/>' +
      // Where the ink loop passes over: a gap in the ground colour, then the ink again.
      '<path d="M18.3 22.9A7 7 0 0 1 14 20.3" stroke="var(--logo-ground, var(--surface))" stroke-width="6.4"/>' +
      '<path d="M18.3 22.9A7 7 0 0 1 14 20.3" stroke="' + ink + '"/>' +
      "</svg>"
    );
  }

  /**
   * Returns the favicon as an SVG data URL: the knot on a marble tile, with literal colours because
   * a favicon cannot read CSS variables. When something waits on you, a gold dot sits in the corner;
   * the browser tab is the web's one ambient signal, so the dot shows from any other tab.
   */
  function favicon(waiting) {
    var ink = "#2b2622";
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke-width="3.6">' +
      '<rect width="32" height="32" rx="8" fill="#f5f2ec" stroke="none"/>' +
      '<rect x="12.5" y="9" width="16" height="14" rx="7" stroke="' + ink + '"/>' +
      '<rect x="3.5" y="9" width="16" height="14" rx="7" stroke="#c0643c"/>' +
      '<path d="M18.3 22.9A7 7 0 0 1 14 20.3" stroke="#f5f2ec" stroke-width="6.4"/><path d="M18.3 22.9A7 7 0 0 1 14 20.3" stroke="' + ink + '"/>' +
      (waiting ? '<circle cx="26" cy="6" r="5.5" fill="#e6b53a" stroke="#f5f2ec" stroke-width="2"/>' : "") +
      "</svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  /* ------------------------------------------------------------------ hydrate */

  /** Replaces every data-face, data-you, data-i, data-mark, data-brand and data-logo placeholder under root with its SVG. */
  function hydrate(root) {
    root = root || document;
    root.querySelectorAll("[data-face]").forEach(function (el) {
      el.outerHTML = face(el.dataset.face, { pose: el.dataset.pose, size: Number(el.dataset.size) || 28 });
    });
    root.querySelectorAll("[data-you]").forEach(function (el) {
      el.outerHTML = you(Number(el.dataset.you) || 28);
    });
    root.querySelectorAll("[data-i]").forEach(function (el) {
      el.outerHTML = icon(el.dataset.i, Number(el.dataset.size) || 16);
    });
    root.querySelectorAll("[data-mark]").forEach(function (el) {
      el.outerHTML = mark(el.dataset.mark, Number(el.dataset.size) || 14);
    });
    root.querySelectorAll("[data-brand]").forEach(function (el) {
      el.outerHTML = brand(el.dataset.brand, Number(el.dataset.size) || 14);
    });
    root.querySelectorAll("[data-logo]").forEach(function (el) {
      el.outerHTML = logo(Number(el.dataset.logo) || 28);
    });
  }

  /**
   * Wires the glass composer: it shrinks and turns see-through while the transcript is scrolled
   * away from the bottom, and restores at the bottom or on focus. ?state=scrolled forces it.
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
      // Scroll up just far enough that the last messages run under the composer, which is what
      // the see-through composer is for. The transcript's big bottom padding would otherwise
      // leave empty space beneath it.
      var column = transcript.firstElementChild;
      var last = column.lastElementChild;
      var contentEnd = last.getBoundingClientRect().bottom - transcript.getBoundingClientRect().top + transcript.scrollTop;
      transcript.scrollTop = Math.max(0, Math.round(contentEnd - transcript.clientHeight + 24));
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

  /**
   * Sets --tx-fade on the transcript under the header pills: 0 at the top of the thread, 1 once
   * the first lines have scrolled up to the pills. The transcript's fade mask in system.css reads
   * it, so the first lines are not dimmed before anyone scrolls.
   */
  function wireTranscriptFade() {
    var transcript = document.querySelector(".pills + [data-transcript]");
    if (!transcript) return;
    function update() {
      transcript.style.setProperty("--tx-fade", String(Math.min(transcript.scrollTop / 16, 1)));
    }
    transcript.addEventListener("scroll", update, { passive: true });
    update();
  }

  /** Makes every [data-seg] group behave as a segmented control that sets data-view on <html>. */
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

  /**
   * Wires every [data-glass-slider] range input to the page's glass level. The slider starts at the
   * level in force (the design's default, or ?glass=), moving it previews the new level on the page
   * at once, and the <output> beside it shows the level as a percentage.
   */
  function glassSliders() {
    document.querySelectorAll("input[data-glass-slider]").forEach(function (slider) {
      var shown = slider.parentElement.querySelector("output");
      function show(level) {
        slider.value = String(Math.round(level * 100));
        if (shown) shown.value = slider.value + "%";
      }
      show(Number(getComputedStyle(document.documentElement).getPropertyValue("--glass-level")));
      slider.addEventListener("input", function () {
        window.HerculePage.setGlassLevel(slider.value / 100);
      });
      // The book moves the level from outside the frame too, so the slider follows every change.
      document.addEventListener("glasschange", function (e) {
        show(e.detail);
      });
    });
  }

  function boot() {
    document.querySelectorAll("[data-side]").forEach(sidebar);
    document.querySelectorAll("[data-webbar]").forEach(webbar);
    document.querySelectorAll("[data-setnav]").forEach(setnav);
    document.querySelectorAll("[data-threads]").forEach(threadpane);
    document.querySelectorAll("[data-status]").forEach(statusbar);
    document.querySelectorAll("[data-tabbar]").forEach(tabbar);
    hydrate(document);
    glassComposer();
    wireTranscriptFade();
    segments();
    glassSliders();
    // A page framed in the design book must not take focus: focusing inside an iframe scrolls the book.
    var first = document.querySelector("[data-autofocus]");
    if (first && window.top === window) first.focus();
    document.documentElement.classList.add("is-ready");
  }

  window.Crew = { favicon: favicon, face: face, you: you, icon: icon, mark: mark, brand: brand, logo: logo, lookFor: lookFor, hash: hash, hydrate: hydrate, poseWord: poseWord, WAITING: WAITING, PROJECTS: PROJECTS };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
