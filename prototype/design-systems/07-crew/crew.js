// PROTOTYPE - Crew's runtime: the character generator, icons, source marks and the shells.
// Every page loads it at the end of <body>. It turns markup like
//   <i data-face="Ada" data-pose="working" data-size="28"></i>
//   <i data-i="search"></i>   <i data-brand="sentry"></i>   <i data-you></i>
// into inline SVG, and renders the shared chrome (sidebar, web bar, tab bar, status bar).
(function () {
  "use strict";

  /* ------------------------------------------------------------------ characters */

  var HUES = ["iris", "teal", "orchid", "lime", "sky", "peach", "mint", "grape"];
  var SHAPES = ["round", "bean", "dome", "square"];
  var ACCESSORIES = ["none", "antenna", "tuft", "ears", "glasses"];

  // Assistants, workflows and today's threads are cast by hand; everyone else is generated.
  var CAST = {
    Ada: ["iris", "bean", "bun"],
    Milo: ["teal", "round", "phones"],
    Juno: ["orchid", "dome", "sprout"],
    Triage: ["lime", "square", "glasses"],
    "Fix bug": ["iris", "square", "antenna"],
    Investigate: ["sky", "round", "glasses"],
    "Ship release": ["orchid", "bean", "antenna"],
    "Label new issues": ["grape", "dome", "ears"],
    "Draft reply": ["teal", "square", "tuft"],
    "Nightly backup check": ["lime", "bean", "ears"],
    "Fix 3-D Secure checkout for EU cards": ["peach", "round", "tuft"],
    "Refactor cart totals": ["sky", "bean", "ears"],
    "Add iDEAL research": ["mint", "dome", "none"],
    "Migrate ops dashboards": ["mint", "square", "antenna"],
    // the rest of this morning's floor, cast so that neighbours never look alike
    "Write checkout e2e tests": ["lime", "round", "tuft"],
    "Payout email copy": ["peach", "bean", "glasses"],
    "Rotate B2 backup keys": ["orchid", "square", "ears"],
    "Update status page copy": ["teal", "dome", "antenna"],
    "Invoice PDF layout": ["peach", "square", "none"],
    "Grafana alert tuning": ["sky", "dome", "antenna"],
    "Sign-up funnel notes": ["orchid", "round", "glasses"],
    "Discount code edge cases": ["lime", "dome", "tuft"],
    "README for payments-api": ["grape", "square", "glasses"],
    "B2 bucket audit": ["teal", "round", "ears"],
    "Refund webhook test": ["iris", "dome", "tuft"],
    "Cart total rounding on discounts": ["mint", "bean", "tuft"],
    "Flaky test hunt": ["peach", "square", "antenna"],
    "Dependency bumps": ["lime", "round", "ears"],
    Nell: ["peach", "round", "bun"],
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

  /** Returns a colleague's look - hue, body shape and accessory - cast by hand or hashed from its name. */
  function lookFor(name) {
    var cast = CAST[name];
    if (cast) return { hue: cast[0], shape: cast[1], acc: cast[2] };
    var h = hash(name);
    return { hue: HUES[h % 8], shape: SHAPES[(h >>> 4) % 4], acc: ACCESSORIES[(h >>> 8) % 5] };
  }

  var BODY = {
    round: '<circle cx="24" cy="27" r="15"/>',
    bean: '<rect x="10" y="11" width="28" height="31" rx="13"/>',
    dome: '<path d="M10 26a14 14 0 0 1 28 0v11a5 5 0 0 1-5 5H15a5 5 0 0 1-5-5z"/>',
    square: '<rect x="10" y="12.5" width="28" height="29.5" rx="10"/>',
  };
  var TOP = { round: 12, bean: 11, dome: 12, square: 12.5 };

  function accessoryBehind(acc, top) {
    if (acc === "ears") return '<g fill="var(--who-shade)"><circle cx="13.5" cy="' + (top + 3) + '" r="4.2"/><circle cx="34.5" cy="' + (top + 3) + '" r="4.2"/></g>';
    if (acc === "bun") return '<circle cx="24" cy="' + (top - 2.5) + '" r="5" fill="var(--who-shade)"/>';
    if (acc === "antenna")
      return '<path d="M24 ' + (top + 1) + 'V' + (top - 5) + '" stroke="var(--who-shade)" stroke-width="1.8" stroke-linecap="round"/><circle cx="24" cy="' + (top - 6.5) + '" r="2.6" fill="var(--who-shade)"/>';
    if (acc === "sprout")
      return (
        '<path d="M24 ' + (top + 1) + 'V' + (top - 4) + '" stroke="var(--who-shade)" stroke-width="1.8" stroke-linecap="round"/>' +
        '<ellipse cx="20.6" cy="' + (top - 5.2) + '" rx="3.6" ry="2" transform="rotate(-28 20.6 ' + (top - 5.2) + ')" fill="var(--who-shade)"/>' +
        '<ellipse cx="27.4" cy="' + (top - 5.2) + '" rx="3.6" ry="2" transform="rotate(28 27.4 ' + (top - 5.2) + ')" fill="var(--who-shade)"/>'
      );
    return "";
  }

  function accessoryFront(acc, top) {
    if (acc === "tuft")
      return '<path d="M21.5 ' + (top + 1.5) + 'c-.6-3.8 2.6-6.2 5.6-5.2-2.2.7-2.9 2.4-2.2 4.6z" fill="var(--who-shade)"/>';
    if (acc === "glasses")
      return '<g fill="none" stroke="var(--face-ink)" stroke-width="1.15" opacity=".85"><circle cx="18.6" cy="26" r="4"/><circle cx="29.4" cy="26" r="4"/><path d="M22.6 25.6h2.8"/></g>';
    if (acc === "phones")
      return (
        '<path d="M9.5 27a14.5 14.5 0 0 1 29 0" fill="none" stroke="var(--face-ink)" stroke-width="2" opacity=".78"/>' +
        '<rect x="6.8" y="23.5" width="5" height="9.5" rx="2.4" fill="var(--face-ink)" opacity=".88"/><rect x="36.2" y="23.5" width="5" height="9.5" rx="2.4" fill="var(--face-ink)" opacity=".88"/>'
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
    if (pose === "working")
      return [19, 29]
        .map(function (x) {
          return '<path d="M' + (x - 2.3 * r) + " 26.2a" + 2.3 * r + " " + 2.3 * r + " 0 0 0 " + 4.6 * r + ' 0z" ' + ink + "/>";
        })
        .join("");
    if (pose === "paused")
      return [19, 29]
        .map(function (x) {
          return '<path d="M' + (x - 2.2 * r) + " 26.4h" + 4.4 * r + '" ' + stroke + "/>";
        })
        .join("");
    if (pose === "asleep")
      return [19, 29]
        .map(function (x) {
          return '<path d="M' + (x - 2.3) + " 26.3q2.3 2 4.6 0" + '" ' + stroke + "/>";
        })
        .join("");
    if (pose === "done")
      return [19, 29]
        .map(function (x) {
          return '<path d="M' + (x - 2.3) + " 27.2q2.3-2.8 4.6 0" + '" ' + stroke + "/>";
        })
        .join("");
    if (pose === "away")
      return [19, 29]
        .map(function (x) {
          return '<circle cx="' + (x - 1) + '" cy="26.5" r="' + 1.5 * r + '" ' + ink + "/>";
        })
        .join("");
    if (pose === "waiting") return open(-0.6, 2.75);
    return open(0, 2.55);
  }

  function brows(pose, bold) {
    var s = 'fill="none" stroke="var(--face-ink)" stroke-width="' + (bold ? 1.6 : 1.25) + '" stroke-linecap="round"';
    if (pose === "waiting") return '<path d="M16.9 21.2q2.1-1.4 4.2 0M26.9 21.2q2.1-1.4 4.2 0" ' + s + "/>";
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

  function extras(pose, uid) {
    if (pose === "working")
      return (
        '<rect x="11" y="41.2" width="26" height="3.4" rx="1.7" fill="var(--face-ink)" opacity=".82"/>' +
        '<g class="cr-hands" fill="var(--who-shade)" stroke="var(--face-ink)" stroke-opacity=".25" stroke-width=".6"><ellipse class="cr-tap" cx="17.5" cy="40.6" rx="3" ry="2"/>' +
        '<ellipse class="cr-tap cr-tap--2" cx="30.5" cy="40.6" rx="3" ry="2"/></g>'
      );
    if (pose === "waiting")
      return (
        '<g class="cr-wave"><path d="M36.4 32.5C40 30 41.2 24 41.4 18" fill="none" stroke="var(--who-shade)" stroke-width="3.4" stroke-linecap="round"/>' +
        '<rect x="37.4" y="6.6" width="8" height="10.6" rx="4" fill="var(--you)" stroke="var(--who-shade)" stroke-width="1.3"/>' +
        '<ellipse cx="37.2" cy="13.2" rx="1.7" ry="2.5" transform="rotate(-32 37.2 13.2)" fill="var(--you)" stroke="var(--who-shade)" stroke-width="1.1"/></g>'
      );
    if (pose === "asleep")
      return '<g class="cr-z" fill="var(--muted)" font-family="var(--font-ui)" font-weight="760"><text x="37" y="15" font-size="10">z</text><text x="42.4" y="8.4" font-size="7">z</text></g>';
    if (pose === "failed")
      return (
        '<g transform="rotate(-32 31 16)"><rect x="25.2" y="13.2" width="12" height="5.4" rx="2.7" fill="oklch(0.95 0.03 75)" stroke="oklch(0.72 0.05 60)" stroke-width=".7"/>' +
        '<rect x="29.5" y="13.9" width="3.4" height="4" rx=".8" fill="oklch(0.86 0.05 65)"/></g>' +
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
   * opts  - { pose: working|waiting|idle|asleep|failed|paused|done|away, size: px, blink: bool }
   */
  function face(name, opts) {
    opts = opts || {};
    var look = opts.look || lookFor(name);
    var pose = opts.pose || "idle";
    var size = opts.size || 28;
    var bold = size < 30;
    var top = TOP[look.shape];
    var uid = ++uidCounter;
    var body = BODY[look.shape];
    var delay = (4 + (hash(name + uid) % 700) / 100).toFixed(2);
    var blinks = pose === "idle" || pose === "working" || pose === "waiting" || pose === "failed";
    return (
      '<svg class="cr cr--' + pose + '" viewBox="3 1 45 45" width="' + size + '" height="' + size + '" role="img" aria-label="' + name.replace(/"/g, "&quot;") + ", " + poseWord(pose) + '" style="--hue:var(--hue-' + look.hue + ')">' +
      accessoryBehind(look.acc, top) +
      '<g fill="var(--who-shade)">' + body + "</g>" +
      '<g fill="var(--who)" transform="translate(0 -2.2)">' + body + "</g>" +
      '<ellipse cx="17" cy="' + (top + 5.2) + '" rx="3.8" ry="2.2" transform="rotate(-28 17 ' + (top + 5.2) + ')" fill="#fff" opacity=".32"/>' +
      '<g transform="translate(0 -1.2)">' +
      '<ellipse cx="15.2" cy="30.6" rx="2.6" ry="1.6" fill="var(--blush)"/><ellipse cx="32.8" cy="30.6" rx="2.6" ry="1.6" fill="var(--blush)"/>' +
      '<g class="' + (blinks ? "cr-eyes" : "") + '" style="animation-delay:' + delay + 's">' + eyes(pose, bold) + "</g>" +
      brows(pose, bold) + mouth(pose, bold) + "</g>" +
      accessoryFront(look.acc, top) +
      extras(pose, uid) +
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

  // 16px stroke icons on a 16 grid, 1.5 stroke, round caps. Marks (state) share the family.
  var ICONS = {
    search: '<circle cx="7.2" cy="7.2" r="4.4"/><path d="M10.5 10.5l3 3"/>',
    plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    check: '<path d="M3.4 8.4l3 3 6.2-6.6"/>',
    "chev-r": '<path d="M6.2 3.8L10.4 8l-4.2 4.2"/>',
    "chev-l": '<path d="M9.8 3.8L5.6 8l4.2 4.2"/>',
    "chev-d": '<path d="M3.8 6.2L8 10.4l4.2-4.2"/>',
    "chev-ud": '<path d="M5 6l3-2.8L11 6M5 10l3 2.8 3-2.8"/>',
    office: '<path d="M8 2.2l5.6 3.1v5.8L8 14.2 2.4 11.1V5.3z"/><path d="M2.6 5.4L8 8.4l5.4-3M8 8.4v5.6"/>',
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
    crew: '<circle cx="5.6" cy="6" r="2.4"/><circle cx="11" cy="6.8" r="2"/><path d="M1.8 13.2c.4-2.4 1.8-3.8 3.8-3.8s3.4 1.4 3.8 3.8M9.6 10a3 3 0 0 1 4.6 3"/>',
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
    grip: '<circle cx="6" cy="4" r=".6"/><circle cx="10" cy="4" r=".6"/><circle cx="6" cy="8" r=".6"/><circle cx="10" cy="8" r=".6"/><circle cx="6" cy="12" r=".6"/><circle cx="10" cy="12" r=".6"/>',
    // state marks: one family with the icons, 16 grid.
    "m-working": '<circle cx="4" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1.3" fill="currentColor" stroke="none"/>',
    "m-queued": '<path d="M4 5h8M4 8h8M4 11h5"/>',
    "m-done": '<circle cx="8" cy="8" r="6"/><path d="M5.4 8.2l1.8 1.8 3.4-3.6"/>',
    "m-failed": '<circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/>',
    "m-cancelled": '<circle cx="8" cy="8" r="6"/><path d="M4 12l8-8"/>',
    "m-skipped": '<path d="M3 11a5 5 0 0 1 9.2-2.8M12.6 4.6v3.8H8.8"/>',
    "m-paused": '<circle cx="8" cy="8" r="6"/><path d="M6.6 5.8v4.4M9.4 5.8v4.4"/>',
    "m-decision": '<path d="M5.4 8.4V4.2a1 1 0 0 1 2 0v3.4V3.2a1 1 0 0 1 2 0v4.4V4.2a1 1 0 0 1 2 0v5.6c0 2.4-1.6 4.2-4 4.2-1.6 0-2.6-.8-3.4-2L2.6 9.4a1 1 0 0 1 1.5-1.2l1.3 1.2"/>',
  };

  /** Returns the SVG markup of an icon or state mark, drawn in currentColor. */
  function icon(name, size) {
    size = size || 16;
    var body = ICONS[name];
    if (!body) throw new Error("Crew has no icon named " + name);
    return (
      '<svg class="ic" viewBox="0 0 16 16" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body.replace(/<circle cx="([\d.]+)" cy="([\d.]+)" r="\.([56])"\/>/g, '<circle cx="$1" cy="$2" r=".$3" fill="currentColor"/>') +
      "</svg>"
    );
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

  // The colleagues on today's floor, shared by the sidebar, the roster and the office.
  var WAITING = [
    { name: "Fix 3-D Secure checkout for EU cards", short: "Fix 3-D Secure checkout", project: "webshop", ask: "Run git push?", href: "session-active.html" },
    { name: "Migrate ops dashboards", short: "Migrate ops dashboards", project: "ops", ask: "Keep the old Grafana folder?", href: "#" },
    { name: "Ship release", short: "Ship release v2.15", project: "payments-api", ask: "Publish to npm?", href: "#" },
  ];
  var ASSISTANTS = [
    { name: "Ada", pose: "working", where: "heartbeat · Web chat" },
    { name: "Milo", pose: "idle", where: "idle · Slack #ops" },
    { name: "Juno", pose: "asleep", where: "asleep · Discord" },
  ];

  /* ------------------------------------------------------------------ shells */

  function navRow(key, label, ic, active, count, countKind) {
    return (
      '<a class="nav-row' + (active === key ? " is-on" : "") + '" href="' + (NAV_HREF[key] || "#") + '"' + (active === key ? ' aria-current="page"' : "") + ">" +
      icon(ic) + "<span>" + label + "</span>" +
      (count ? '<b class="count' + (countKind ? " count--" + countKind : "") + '">' + count + "</b>" : "") +
      "</a>"
    );
  }
  var NAV_HREF = {
    office: "office.html",
    intake: "intake.html",
    threads: "session-active.html",
    assistants: "assistant.html",
    settings: "settings-appearance.html",
  };

  /** Renders the desktop sidebar: traffic lights, places, the people waiting on you, the assistants and the foot. */
  function sidebar(el) {
    var active = el.dataset.side;
    // "threads-new" lights the Threads place without selecting a waiting colleague
    var place = active.split("-")[0];
    // ?state=swarm shows the same shell at ten times today's load
    var swarm = document.documentElement.dataset.state === "swarm";
    el.classList.add("side");
    el.innerHTML =
      '<div class="side-top"><span class="tl"><i></i><i></i><i></i></span>' +
      '<button class="icon-btn" title="New thread  ⌘N">' + icon("plus") + "</button></div>" +
      '<button class="side-search">' + icon("search", 14) + "<span>Find anyone or anything</span><kbd>⌘K</kbd></button>" +
      '<nav class="nav">' +
      navRow("office", "Office", "office", place, swarm ? "140" : "23") +
      navRow("intake", "Intake", "intake", place, swarm ? "72" : "9", "you") +
      navRow("checkin", "Check-in", "checkin", place) +
      navRow("threads", "Threads", "threads", place) +
      navRow("runs", "Runs", "runs", place) +
      navRow("workflows", "Workflows", "workflows", place) +
      navRow("fleet", "Fleet", "fleet", place) +
      "</nav>" +
      '<div class="side-h"><span>Waiting on you</span><b class="count count--you">' + (swarm ? "10" : "3") + "</b></div>" +
      '<div class="side-list">' +
      WAITING.map(function (w, i) {
        var on = active === "threads" && i === 0;
        return (
          '<a class="who-row' + (on ? " is-on" : "") + '" href="' + w.href + '">' + face(w.name, { pose: "waiting", size: 30 }) +
          '<span class="who-text"><span class="who-name">' + w.short + '</span><span class="who-sub">' + w.ask + "</span></span></a>"
        );
      }).join("") +
      (swarm ? '<a class="who-row who-row--flat" href="intake.html"><span class="stack-more">+7</span><span class="who-text"><span class="who-state">more waiting on you</span></span></a>' : "") +
      "</div>" +
      '<div class="side-h"><span>Assistants</span></div>' +
      '<div class="side-list">' +
      ASSISTANTS.map(function (a) {
        var on = active === "assistants" && a.name === "Ada";
        return (
          '<a class="who-row who-row--flat' + (on ? " is-on" : "") + '" href="assistant.html">' + face(a.name, { pose: a.pose, size: 26 }) +
          '<span class="who-text"><span class="who-name">' + a.name + '</span></span><span class="who-state">' + a.where.split(" · ")[0] + "</span></a>"
        );
      }).join("") +
      "</div>" +
      '<div class="side-foot">' +
      '<a class="nav-row' + (active === "settings" ? " is-on" : "") + '" href="settings-appearance.html">' + icon("settings") + "<span>Settings</span></a>" +
      '<div class="pulse">' + you(26) + '<span class="pulse-text"><b>Rogier</b><span>3 machines · 1 at cap</span></span>' + icon("chev-ud", 14) + "</div>" +
      "</div>";
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
    var pages = web ? { providers: 1 } : { appearance: 1, assistants: 1, connections: 1 };
    el.classList.add("set-nav");
    el.innerHTML = SETTINGS.map(function (group) {
      return (
        '<div class="side-h"><span>' + group[0] + "</span></div>" +
        group[1].map(function (d) {
          var href = pages[d[0]] ? "settings-" + d[0] + ".html" : "#";
          // Discord has been reconnecting since 09:12, so Connections carries the one warning dot.
          var dot = d[0] === "connections" ? '<i class="dot dot--fail" title="Discord is reconnecting"></i>' : "";
          return '<a class="nav-row' + (active === d[0] ? " is-on" : "") + '" href="' + href + '">' + icon(d[2]) + "<span>" + d[1] + "</span>" + dot + "</a>";
        }).join("")
      );
    }).join("");
  }

  // The live threads, for the web's thread pane (the desktop keeps them in the sidebar).
  var THREADS = [
    ["Waiting on you", [
      { name: "Fix 3-D Secure checkout for EU cards", key: "fix", pose: "waiting", project: "webshop", sub: "Run git push?", href: "session-active.html" },
      { name: "Migrate ops dashboards", pose: "waiting", project: "ops", sub: "Keep the old Grafana folder?" },
    ]],
    ["Working", [
      { name: "Refactor cart totals", pose: "working", project: "webshop", sub: "working 22m" },
      { name: "Write checkout e2e tests", pose: "working", project: "webshop", sub: "working 9m" },
    ]],
    ["Idle", [
      { name: "Add iDEAL research", pose: "idle", project: "payments-api", sub: "idle 1h" },
      { name: "Invoice PDF layout", pose: "idle", project: "webshop", sub: "idle 3h" },
      { name: "Payout email copy", pose: "asleep", project: "payments-api", sub: "since yesterday" },
    ]],
  ];

  /** Renders the web's thread pane: search, a draft when data-threads is "new", and threads grouped by who needs you. */
  function threadpane(el) {
    var active = el.dataset.threads;
    el.classList.add("tpane");
    var draft =
      active === "new"
        ? '<a class="who-row is-on" href="session-empty.html"><span class="draft-face">' + icon("plus", 14) + '</span><span class="who-text"><span class="who-name">New thread</span><span class="who-sub who-sub--quiet">webshop · draft</span></span></a>'
        : "";
    el.innerHTML =
      '<div class="tpane-top"><button class="side-search">' + icon("search", 14) + '<span>Find a thread</span><kbd>/</kbd></button>' +
      '<a class="icon-btn" href="session-empty.html" title="New thread">' + icon("plus") + "</a></div>" +
      '<div class="tpane-list">' + draft +
      THREADS.map(function (group) {
        return (
          '<div class="side-h"><span>' + group[0] + "</span><span>" + group[1].length + "</span></div>" +
          group[1].map(function (t) {
            var quiet = t.pose !== "waiting" ? " who-sub--quiet" : "";
            return (
              '<a class="who-row' + (active === t.key ? " is-on" : "") + '" href="' + (t.href || "#") + '">' + face(t.name, { pose: t.pose, size: 30 }) +
              '<span class="who-text"><span class="who-name">' + t.name + '</span><span class="who-sub' + quiet + '">' + t.project + " · " + t.sub + "</span></span></a>"
            );
          }).join("")
        );
      }).join("") +
      "</div>";
  }

  // The web set has no office page, and its settings open on Providers.
  var WEB_HREF = {
    intake: "intake.html",
    threads: "session-active.html",
    assistants: "assistant.html",
    settings: "settings-providers.html",
  };

  /** Renders the web top bar: mark, places as tabs, the waiting faces and search. */
  function webbar(el) {
    var active = el.dataset.webbar;
    el.classList.add("webbar");
    var link = document.createElement("link");
    link.rel = "icon";
    link.href = favicon(WAITING.length > 0);
    document.head.appendChild(link);
    function tab(key, label, count, kind) {
      return (
        '<a class="wtab' + (active === key ? " is-on" : "") + '" href="' + (WEB_HREF[key] || "#") + '">' + label +
        (count ? ' <b class="count' + (kind ? " count--" + kind : "") + '">' + count + "</b>" : "") + "</a>"
      );
    }
    el.innerHTML =
      '<a class="wb-mark" href="intake.html">' + logo(26) + "<span>Hercule</span></a>" +
      '<nav class="wtabs">' + tab("office", "Office") + tab("intake", "Intake", "9", "you") + tab("threads", "Threads") + tab("runs", "Runs") + tab("assistants", "Assistants") + tab("fleet", "Fleet") + tab("settings", "Settings") + "</nav>" +
      '<div class="wb-right">' +
      '<button class="wb-waiting" title="3 colleagues are waiting on you"><span class="stack">' +
      WAITING.map(function (w) {
        return face(w.name, { pose: "waiting", size: 26 });
      }).join("") +
      '</span><span><b>3</b> waiting</span></button>' +
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

  /** Renders the mobile tab bar: thumb-reach places with a centre compose button. */
  function tabbar(el) {
    var active = el.dataset.tabbar;
    el.classList.add("tabbar");
    function t(key, label, ic, badge) {
      return (
        '<a class="tb' + (active === key ? " is-on" : "") + '" href="' + ({ office: "office.html", intake: "intake.html", threads: "session-active.html", settings: "settings.html" }[key] || "#") + '">' +
        '<span class="tb-ic">' + icon(ic, 22) + (badge ? '<b class="tb-badge">' + badge + "</b>" : "") + "</span><span>" + label + "</span></a>"
      );
    }
    el.innerHTML =
      t("office", "Office", "office", "3") +
      t("intake", "Intake", "intake", "9") +
      '<a class="tb-new" href="session-empty.html" aria-label="New thread">' + icon("plus", 24) + "</a>" +
      t("threads", "Threads", "threads") +
      t("settings", "You", "user");
  }

  /* ------------------------------------------------------------------ logo */

  /**
   * Returns the Hercule mark: three colleagues shoulder to shoulder forming an H - two tall
   * characters as the posts and a small one as the bar, the middle one raising a marigold hand.
   */
  function logo(size, opts) {
    size = size || 28;
    opts = opts || {};
    return (
      '<svg class="logo" viewBox="0 0 32 32" width="' + size + '" height="' + size + '" role="img" aria-label="Hercule">' +
      '<rect x="3" y="4" width="9" height="25" rx="4.5" fill="oklch(var(--char-l) var(--char-c) var(--hue-iris))"/>' +
      '<rect x="20" y="4" width="9" height="25" rx="4.5" fill="oklch(var(--char-l) var(--char-c) var(--hue-teal))"/>' +
      '<rect x="10.5" y="13" width="11" height="9" rx="4.5" fill="' + (opts.mono ? "currentColor" : "var(--you)") + '" stroke="var(--logo-ring, var(--surface))" stroke-width="1.6"/>' +
      '<g fill="var(--face-ink)"><circle cx="6.1" cy="10.4" r="1.15"/><circle cx="9" cy="10.4" r="1.15"/><circle cx="23" cy="10.4" r="1.15"/><circle cx="25.9" cy="10.4" r="1.15"/>' +
      '<circle cx="14.6" cy="17.3" r="1"/><circle cx="17.4" cy="17.3" r="1"/></g></svg>'
    );
  }

  /**
   * Returns the favicon as an SVG data URL: the mark with literal colors (a favicon cannot read
   * CSS variables) and, when someone waits on you, a marigold dot in the corner. The browser tab
   * is the web's one ambient signal, so the dot shows from any other tab.
   */
  function favicon(waiting) {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect x="3" y="4" width="9" height="25" rx="4.5" fill="oklch(0.775 0.13 282)"/>' +
      '<rect x="20" y="4" width="9" height="25" rx="4.5" fill="oklch(0.775 0.13 198)"/>' +
      '<rect x="10.5" y="13" width="11" height="9" rx="4.5" fill="oklch(0.8 0.155 78)" stroke="#fff" stroke-width="1.6"/>' +
      (waiting ? '<circle cx="25" cy="7" r="6.5" fill="oklch(0.8 0.155 78)" stroke="#fff" stroke-width="2"/>' : "") +
      "</svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  /* ------------------------------------------------------------------ hydrate */

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
    root.querySelectorAll("[data-brand]").forEach(function (el) {
      el.outerHTML = brand(el.dataset.brand, Number(el.dataset.size) || 14);
    });
    root.querySelectorAll("[data-logo]").forEach(function (el) {
      el.outerHTML = logo(Number(el.dataset.logo) || 28, { mono: el.hasAttribute("data-mono") });
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
    hydrate(document);
    glassComposer();
    segments();
    // A page framed in the design book must not take focus: focusing inside an iframe scrolls the book.
    var first = document.querySelector("[data-autofocus]");
    if (first && window.top === window) first.focus();
    document.documentElement.classList.add("is-ready");
  }

  window.Crew = { favicon: favicon, face: face, you: you, icon: icon, brand: brand, logo: logo, lookFor: lookFor, hash: hash, hydrate: hydrate, poseWord: poseWord, WAITING: WAITING };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
