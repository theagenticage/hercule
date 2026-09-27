/* PROTOTYPE - halo.js: the Halo glyph, the marks, and the few behaviours the pages share.
 *
 * Markup it understands (rendered on DOMContentLoaded, and again by Halo.mount(root)):
 *   <span data-halo="wait3 work8 pause1 idle11" data-notch="0" data-center="3"
 *         data-label="waiting on you" data-size="64"></span>
 *   <i data-mark="wait"></i>     a 12px state mark or entity glyph
 *   <i data-icon="search"></i>   a 16px interface icon
 *   <i data-brand="sentry"></i>  a monochrome source-system mark (Simple Icons, CC0)
 *   <span data-ticks="wait6.4 idle198.1" data-width="260"></span>  the halo unrolled into a strip
 *
 * Halo segment grammar: space-separated tokens "<state><count>[.<level>][|]".
 *   state  wait | work | fail | pause | idle | asleep | fyi | ink | empty (an unused slot)
 *          | slot (dashed: where a session about to start will sit)
 *   level  1 thin (at rest) · 2 medium · 3 full (moving) · 4 raised (your move)
 *   "|"    a wider gap after the token's last segment, to separate groups
 * data-span="0.7" lets the segments fill 70% of the ring; data-track draws the rest as a quiet
 * hairline (used by the Intake dial, whose remainder is the events handled quietly).
 * data-merge draws each run as one arc at any size, so the ring reads as shares of a whole
 * (the Connections volume ring). data-split does the opposite: one segment per item at every
 * size, so the logo keeps its twelve segments down to icon sizes.
 *
 * The glyph renders differently by size, like a hinted font:
 *   < 36px   runs of the same state merge into arcs, no notch, a thick ring, a bold numeral
 *   36-55    runs still merge; the notch appears
 *   56-109   one segment per session
 *   110+     adds a label under the numeral
 *   200+     adds an inner chapter ring of 60 ticks
 */
(function () {
  "use strict";

  var DEFAULT_LEVEL = { wait: 4, work: 3, fail: 3, pause: 3, idle: 1, asleep: 1, fyi: 2, ink: 3, empty: 1, slot: 3 };
  var uid = 0;

  function parseSegments(text) {
    var segments = [];
    String(text || "")
      .trim()
      .split(/\s+/)
      .forEach(function (token) {
        var m = token.match(/^([a-z]+)(\d*)(?:\.(\d))?(\|)?$/);
        if (!m) return;
        var count = m[2] === "" ? 1 : Number(m[2]);
        for (var i = 0; i < count; i++) {
          segments.push({
            state: m[1],
            level: m[3] ? Number(m[3]) : DEFAULT_LEVEL[m[1]] || 3,
            gapAfter: !!m[4] && i === count - 1,
          });
        }
      });
    return segments;
  }

  function f(n) {
    return Math.round(n * 100) / 100;
  }

  /* Returns the SVG path of a ring sector between radii r0 and r1 and angles a0 and a1
   * (radians, clockwise from 12 o'clock). The gap g is kept parallel-sided, the way a
   * machined dial is cut, so it stays the same width at the inner and outer edge. */
  function sectorPath(c, r0, r1, a0, a1, g) {
    var oo = Math.asin(Math.min(1, g / 2 / r1));
    var io = r0 > 0 ? Math.asin(Math.min(1, g / 2 / r0)) : 0;
    var o0 = a0 + oo,
      o1 = a1 - oo,
      i0 = a0 + io,
      i1 = a1 - io;
    if (o1 - o0 <= 0.002 || i1 - i0 <= 0.002) return "";
    if (a1 - a0 >= Math.PI * 2 - 0.0001 && g === 0) {
      return (
        "M" + f(c) + " " + f(c - r1) + "A" + f(r1) + " " + f(r1) + " 0 1 1 " + f(c - 0.001) + " " + f(c - r1) + "Z" +
        "M" + f(c) + " " + f(c - r0) + "A" + f(r0) + " " + f(r0) + " 0 1 0 " + f(c - 0.001) + " " + f(c - r0) + "Z"
      );
    }
    function p(r, a) {
      return f(c + r * Math.sin(a)) + " " + f(c - r * Math.cos(a));
    }
    var lo = o1 - o0 > Math.PI ? 1 : 0;
    var li = i1 - i0 > Math.PI ? 1 : 0;
    return (
      "M" + p(r1, o0) + "A" + f(r1) + " " + f(r1) + " 0 " + lo + " 1 " + p(r1, o1) +
      "L" + p(r0, i1) + "A" + f(r0) + " " + f(r0) + " 0 " + li + " 0 " + p(r0, i0) + "Z"
    );
  }

  function arcPath(c, r, a0, a1) {
    function p(a) {
      return f(c + r * Math.sin(a)) + " " + f(c - r * Math.cos(a));
    }
    return "M" + p(a0) + "A" + f(r) + " " + f(r) + " 0 " + (a1 - a0 > Math.PI ? 1 : 0) + " 1 " + p(a1);
  }

  /* Merges neighbouring segments with the same state and level into one run, for small sizes
   * where 23 separate segments would blur into noise. */
  function mergeRuns(segments) {
    var runs = [];
    segments.forEach(function (s, i) {
      var last = runs[runs.length - 1];
      if (last && last.state === s.state && last.level === s.level && !last.gapAfter) {
        last.count++;
        last.gapAfter = s.gapAfter;
      } else runs.push({ state: s.state, level: s.level, gapAfter: s.gapAfter, count: 1, first: i });
    });
    return runs;
  }

  /* Builds the Halo glyph as an SVG string.
   * opts: size (px), segments (string), notch (segment index or null), center (text),
   * label (text), span (0-1), track (bool), merge (bool), split (bool), still (bool: no animation classes). */
  function buildHalo(opts) {
    var size = Number(opts.size) || 64;
    var segments = parseSegments(opts.segments);
    var tiny = size < 36;
    var c = size / 2;
    var margin = Math.max(0.5, size * 0.012);
    var t = size * (size < 24 ? 0.15 : tiny ? 0.12 : size < 110 ? 0.088 : size < 200 ? 0.072 : 0.062);
    var bump = tiny ? 0 : t * 0.52;
    var notchH = tiny ? 0 : Math.max(2.4, size * (size < 110 ? 0.07 : 0.05));
    var notchGap = tiny ? 0 : Math.max(1, size * 0.014);
    var r1 = c - margin - notchH - notchGap - bump;
    var r0 = r1 - t;
    var gap = tiny ? Math.max(1.1, size * 0.07) : Math.max(1, size * (size < 110 ? 0.022 : 0.013));
    var span = opts.span != null ? Number(opts.span) : 1;
    var total = segments.reduce(function (n, s) {
      return n + 1 + (s.gapAfter ? 0.6 : 0);
    }, 0);
    var unit = (Math.PI * 2 * span) / (total || 1);
    var id = "h" + ++uid;
    var parts = [];

    function outer(level) {
      if (level >= 4) return r1 + bump;
      if (level === 3) return r1;
      if (level === 2) return r0 + t * 0.6;
      return r0 + Math.max(1, t * 0.3);
    }

    // Angles per segment (or per merged run at tiny sizes).
    var items = (size < 56 || opts.merge) && !opts.split ? mergeRuns(segments) : segments.map(function (s, i) {
      return { state: s.state, level: s.level, gapAfter: s.gapAfter, count: 1, first: i };
    });
    var a = 0;
    var angles = [];
    items.forEach(function (it) {
      var a0 = a;
      a += unit * it.count;
      angles.push([a0, a]);
      if (it.gapAfter) a += unit * 0.6;
    });

    // The quiet track fills whatever the segments leave, as a hairline.
    if (opts.track && span < 1) {
      var tw = Math.max(1, t * 0.16);
      parts.push(
        '<path class="h-track" d="' + arcPath(c, r0 + tw / 2, a + gap / r0, Math.PI * 2 - gap / r0) +
          '" stroke-width="' + f(tw) + '" fill="none"/>'
      );
    }

    // The inner chapter ring: 60 ticks, like the minute track inside a watch bezel.
    if (size >= 200) {
      var tr = r0 - size * 0.035;
      var ticks = "";
      for (var k = 0; k < 60; k++) {
        var ta = (k / 60) * Math.PI * 2;
        var len = k % 5 === 0 ? size * 0.022 : size * 0.01;
        ticks +=
          "M" + f(c + tr * Math.sin(ta)) + " " + f(c - tr * Math.cos(ta)) +
          "L" + f(c + (tr - len) * Math.sin(ta)) + " " + f(c - (tr - len) * Math.cos(ta));
      }
      parts.push('<path class="h-tick" d="' + ticks + '" stroke-width="' + f(Math.max(1, size * 0.0035)) + '"/>');
    }

    var workIndex = 0;
    items.forEach(function (it, i) {
      var a0 = angles[i][0],
        a1 = angles[i][1];
      var cls = "h-seg h-" + it.state;
      var style = ' style="--i:' + i + (it.state === "work" ? ";--k:" + workIndex++ : "") + '"';
      var d;
      if (it.state === "pause" || it.state === "slot") {
        var sw = Math.max(1, t * 0.16);
        d = sectorPath(c, r0 + sw / 2, r1 - sw / 2, a0, a1, gap + sw);
        var dash = it.state === "slot" ? ' stroke-dasharray="' + f(Math.max(1.5, t * 0.34)) + " " + f(Math.max(1.5, t * 0.24)) + '"' : "";
        parts.push('<path class="' + cls + '"' + style + ' d="' + d + '" stroke-width="' + f(sw) + '"' + dash + "/>");
      } else if (it.state === "fail" && !tiny) {
        var mid = (a0 + a1) / 2;
        var cut = (gap * 1.2) / r1;
        d = sectorPath(c, r0, r1, a0, mid - cut / 2, gap) + sectorPath(c, r0, r1, mid + cut / 2, a1, gap);
        parts.push('<path class="' + cls + '"' + style + ' d="' + d + '"/>');
      } else if (it.state === "asleep" && !tiny) {
        var rr = r0 + Math.max(1, t * 0.3) / 2;
        var dots = "";
        var n = Math.max(2, Math.floor(((a1 - a0) * rr) / Math.max(2.2, t * 0.55)));
        for (var j = 0; j < n; j++) {
          var da = a0 + ((j + 0.5) / n) * (a1 - a0);
          var dr = Math.max(0.5, t * 0.15);
          dots +=
            "M" + f(c + rr * Math.sin(da) - dr) + " " + f(c - rr * Math.cos(da)) +
            "a" + f(dr) + " " + f(dr) + " 0 1 0 " + f(dr * 2) + " 0a" + f(dr) + " " + f(dr) + " 0 1 0 " + f(-dr * 2) + " 0";
        }
        parts.push('<path class="' + cls + '"' + style + ' d="' + dots + '"/>');
      } else {
        d = sectorPath(c, r0, outer(it.level), a0, a1, gap);
        parts.push('<path class="' + cls + (it.level >= 4 ? " h-raised" : "") + '"' + style + ' d="' + d + '"/>');
      }
    });

    // The notch: a bright pointer outside the ring, aimed at the most urgent segment.
    // The notch index counts segments; when runs are merged, find the run that holds it.
    var notchIndex = opts.notch != null && opts.notch !== "" ? Number(opts.notch) : -1;
    var notchItem = -1;
    items.forEach(function (it, i) {
      if (notchIndex >= it.first && notchIndex < it.first + it.count) notchItem = i;
    });
    if (!tiny && notchItem >= 0) {
      var na = angles[notchItem][0] + (notchIndex - items[notchItem].first + 0.5) * unit;
      var tip = r1 + bump + notchGap;
      var base = c - margin;
      var w = notchH * 0.72;
      var nd =
        "M" + f(c - w) + " " + f(c - base) + "L" + f(c + w) + " " + f(c - base) + "L" + f(c) + " " + f(c - tip) + "Z";
      parts.push(
        '<g transform="rotate(' + f((na * 180) / Math.PI) + " " + f(c) + " " + f(c) + ')"><path class="h-notch" d="' +
          nd + '" stroke-width="' + f(Math.max(0.6, notchH * 0.22)) + '" stroke-linejoin="round"/></g>'
      );
    }

    if (opts.center != null && opts.center !== "") {
      var label = size >= 110 && opts.label ? opts.label : "";
      var len = String(opts.center).length;
      var fs = (tiny ? r0 * 1.32 : r0 * (label ? 0.86 : 1.02)) * Math.min(1, 2.2 / Math.max(2.2, len));
      var weight = size >= 110 ? 300 : tiny ? 650 : 500;
      var y = label ? c - r0 * 0.1 : c;
      parts.push(
        '<text class="h-num" x="' + f(c) + '" y="' + f(y) + '" font-size="' + f(fs) + '" font-weight="' + weight +
          '" text-anchor="middle" dominant-baseline="central">' + escapeText(opts.center) + "</text>"
      );
      if (label) {
        parts.push(
          '<text class="h-label" x="' + f(c) + '" y="' + f(c + r0 * 0.5) + '" font-size="' +
            f(Math.max(9, r0 * 0.15)) + '" text-anchor="middle" dominant-baseline="central">' + escapeText(label) + "</text>"
        );
      }
    }

    return (
      '<svg class="halo-svg' + (tiny ? " is-tiny" : "") + (size >= 64 ? " is-lit" : "") + (opts.still ? " is-still" : "") + '" id="' + id +
      '" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size +
      '" role="img" aria-label="' + escapeText(opts.aria || describe(segments, opts.center, opts.label)) + '">' +
      parts.join("") + "</svg>"
    );
  }

  function describe(segments, center, label) {
    var counts = {};
    segments.forEach(function (s) {
      counts[s.state] = (counts[s.state] || 0) + 1;
    });
    var words = { wait: "waiting on you", work: "working", fail: "failed", pause: "paused", idle: "idle", asleep: "asleep", fyi: "FYI", ink: "", slot: "about to start" };
    var text = Object.keys(counts)
      .map(function (k) {
        return counts[k] + " " + (words[k] || k);
      })
      .join(", ");
    return (center ? center + " " + (label || "") + ". " : "") + text;
  }

  function escapeText(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  /* ------------------------------------------------------------------ marks (12px grid) */
  var ST = 'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
  var RING = '<circle cx="6" cy="6" r="4.6" ' + ST + ' opacity=".32"/>';
  var MARKS = {
    // States. Every state mark is a tiny halo: a ring holding a symbol.
    work: '<circle cx="6" cy="6" r="4.6" ' + ST + ' opacity=".26"/><path class="mk-sweep" d="M6 1.4a4.6 4.6 0 0 1 4.6 4.6" ' + ST + ' stroke-width="1.5"/>',
    wait:
      '<circle cx="6" cy="6" r="5.6" fill="currentColor"/><path d="M4.35 4.65a1.7 1.7 0 1 1 2.55 1.45c-.55.32-.9.66-.9 1.25" fill="none" stroke="var(--on-wait)" stroke-width="1.35" stroke-linecap="round"/><circle cx="6" cy="9.1" r=".78" fill="var(--on-wait)"/>',
    queued: '<circle cx="6" cy="6" r="4.6" ' + ST + "/>",
    pause: RING.replace('opacity=".32"', "") + '<path d="M4.9 4.3v3.4M7.1 4.3v3.4" ' + ST + "/>",
    done: RING + '<path d="M3.9 6.15l1.45 1.45 2.8-3.05" ' + ST + ' stroke-width="1.35"/>',
    fail: '<circle cx="6" cy="6" r="5.6" fill="currentColor"/><path d="M4.2 4.2l3.6 3.6M7.8 4.2l-3.6 3.6" fill="none" stroke="var(--on-fail)" stroke-width="1.35" stroke-linecap="round"/>',
    cancelled: RING + '<path d="M4 6h4" ' + ST + "/>",
    skipped: RING + '<path d="M3.9 4.4l1.6 1.6-1.6 1.6M6.5 4.4l1.6 1.6-1.6 1.6" ' + ST + "/>",
    idle: '<circle cx="6" cy="6" r="4.6" ' + ST + ' opacity=".55"/><circle cx="6" cy="6" r="1.15" fill="currentColor" opacity=".7"/>',
    asleep: '<circle cx="6" cy="6" r="4.6" ' + ST + ' stroke-dasharray=".1 2.35" stroke-width="1.5"/>',
    unreachable: '<circle cx="6" cy="6" r="4.6" ' + ST + ' stroke-dasharray="2.6 1.75" stroke-width="1.4"/>',
    // Priority: a four-segment halo, lit one segment per step.
    pri1: gauge(1),
    pri2: gauge(2),
    pri3: gauge(3),
    pri4: gauge(4),
    // Entities.
    task: '<rect x="2" y="2" width="8" height="8" rx="2.3" ' + ST + "/>",
    proposal: '<rect x="2" y="2" width="8" height="8" rx="2.3" ' + ST + ' stroke-dasharray="2.1 1.45"/>',
    run: '<path d="M3.6 2.5v7l5.9-3.5z" ' + ST + "/>",
    session:
      '<path d="M3.7 2.2h4.6a1.7 1.7 0 0 1 1.7 1.7v3a1.7 1.7 0 0 1-1.7 1.7H5.6L3.4 10.1V8.6h.3A1.7 1.7 0 0 1 2 6.9v-3a1.7 1.7 0 0 1 1.7-1.7z" ' + ST + "/>",
    workflow:
      '<circle cx="3" cy="3" r="1.35" ' + ST + '/><circle cx="3" cy="9" r="1.35" ' + ST + '/><circle cx="9.2" cy="6" r="1.35" ' + ST + '/><path d="M3 4.4v3.2M4.35 3.2C6.2 3.5 7 4.6 7.9 5.5" ' + ST + "/>",
    assistant: '<circle cx="6" cy="7.4" r="2.5" ' + ST + '/><ellipse cx="6" cy="2.55" rx="3.1" ry="1.05" ' + ST + "/>",
    offer: '<path d="M6.9 1.5L3.1 6.6h2.8l-.8 3.9 3.8-5.1H6.1z" ' + ST + "/>",
    fyi: RING + '<path d="M6 5.5v2.8" ' + ST + '/><circle cx="6" cy="3.75" r=".75" fill="currentColor"/>',
    reminder: '<circle cx="6" cy="6.3" r="4.2" ' + ST + '/><path d="M6 4.1v2.3l1.5 1" ' + ST + "/>",
    heartbeat: '<path d="M1.2 6.4h2.1l1.3-3 2.1 5.4 1.3-3.3h2.8" ' + ST + "/>",
    notice: RING.replace('opacity=".32"', "") + '<path d="M6 3.5v3" ' + ST + '/><circle cx="6" cy="8.35" r=".75" fill="currentColor"/>',
    attached: '<path d="M7.6 4.3L4.7 7.2a1.1 1.1 0 0 0 1.6 1.6l3.2-3.2a2.1 2.1 0 0 0-3-3L3.3 5.8a3.1 3.1 0 0 0 4.4 4.4l2.4-2.4" ' + ST + "/>",
    held: '<rect x="2.2" y="2.2" width="7.6" height="7.6" rx="3.8" ' + ST + '/><path d="M4.3 6h3.4" ' + ST + "/>",
    event: '<circle cx="6" cy="6" r="2" fill="currentColor"/>',
  };

  /* Returns a priority mark: a four-segment halo in miniature, lit clockwise from 12 o'clock,
   * one segment per step of priority (1 low to 4 urgent). */
  function gauge(n) {
    var out = "";
    var r = 4.3;
    for (var i = 0; i < 4; i++) {
      var a0 = (Math.PI / 2) * i + 0.3,
        a1 = (Math.PI / 2) * (i + 1) - 0.3;
      out +=
        '<path d="M' + f(6 + r * Math.sin(a0)) + " " + f(6 - r * Math.cos(a0)) + "A" + r + " " + r + " 0 0 1 " +
        f(6 + r * Math.sin(a1)) + " " + f(6 - r * Math.cos(a1)) + '" fill="none" stroke="currentColor" stroke-width="2.3"' +
        (i < n ? "" : ' opacity=".2"') + "/>";
    }
    return out;
  }

  /* ------------------------------------------------------------------ icons (16px grid) */
  var SI = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
  function ic(d, extra) {
    return '<path d="' + d + '" ' + SI + "/>" + (extra || "");
  }
  var ICONS = {
    search: ic("M11 11l3 3", '<circle cx="7" cy="7" r="4.6" ' + SI + "/>"),
    plus: ic("M8 3v10M3 8h10"),
    mic: ic("M4 7.6a4 4 0 0 0 8 0M8 11.6V14", '<rect x="5.8" y="1.8" width="4.4" height="7.6" rx="2.2" ' + SI + "/>"),
    stop: '<rect x="4" y="4" width="8" height="8" rx="1.8" fill="currentColor"/>',
    send: ic("M8 13V3.4M3.8 7.4L8 3.2l4.2 4.2"),
    down: ic("M4.5 6.3L8 9.7l3.5-3.4"),
    right: ic("M6.3 4.5L9.7 8l-3.4 3.5"),
    left: ic("M9.7 4.5L6.3 8l3.4 3.5"),
    up: ic("M4.5 9.7L8 6.3l3.5 3.4"),
    close: ic("M4 4l8 8M12 4l-8 8"),
    more: '<circle cx="3.6" cy="8" r="1.15" fill="currentColor"/><circle cx="8" cy="8" r="1.15" fill="currentColor"/><circle cx="12.4" cy="8" r="1.15" fill="currentColor"/>',
    branch: ic("M4.5 3.5v9M4.5 10c0-3 7-2 7-5", '<circle cx="4.5" cy="3.2" r="1.5" ' + SI + '/><circle cx="4.5" cy="12.8" r="1.5" ' + SI + '/><circle cx="11.5" cy="4.2" r="1.5" ' + SI + "/>"),
    worktree: ic("M2.5 4.5a1 1 0 0 1 1-1h3l1.4 1.5h4.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"),
    machine: ic("M5.5 14h5M8 11.5V14", '<rect x="1.8" y="2.5" width="12.4" height="9" rx="1.8" ' + SI + "/>"),
    server: ic("M4.5 5h.01M4.5 11h.01", '<rect x="2" y="2.5" width="12" height="5" rx="1.5" ' + SI + '/><rect x="2" y="8.5" width="12" height="5" rx="1.5" ' + SI + "/>"),
    lock: ic("M5.3 7V5.2a2.7 2.7 0 0 1 5.4 0V7", '<rect x="3.3" y="7" width="9.4" height="7" rx="1.8" ' + SI + "/>"),
    shield: ic("M8 1.8l5 2v4c0 3.2-2.2 5.4-5 6.4-2.8-1-5-3.2-5-6.4v-4z"),
    edit: ic("M9.8 3.2l3 3L6 13H3v-3z"),
    sliders: ic("M3 5h6M12 5h1M3 11h1M7 11h6", '<circle cx="10.5" cy="5" r="1.5" ' + SI + '/><circle cx="5.5" cy="11" r="1.5" ' + SI + "/>"),
    clip: ic("M10.5 5.5l-4.3 4.3a1.4 1.4 0 0 0 2 2l4.6-4.6a2.9 2.9 0 0 0-4.1-4.1L4.1 7.7a4.3 4.3 0 0 0 6.1 6.1"),
    bell: ic("M4 11V7.5a4 4 0 0 1 8 0V11l1.2 1.5H2.8zM6.6 14.2a1.6 1.6 0 0 0 2.8 0"),
    dial: ic(
      "M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M3.5 12.5l1.1-1.1M11.4 4.6l1.1-1.1",
      '<circle cx="8" cy="8" r="3" ' + SI + "/>"
    ),
    intake: ic("M8 1.9v2.2", '<circle cx="8" cy="8.6" r="5.3" ' + SI + ' stroke-dasharray="3.2 1.6"/><circle cx="8" cy="8.6" r="1.5" fill="currentColor"/>'),
    checkin: ic("M8 5v3.3l2.2 1.4", '<circle cx="8" cy="8" r="5.8" ' + SI + "/>"),
    link: ic("M6.8 9.2l2.4-2.4M7.2 4.8l1.1-1.1a2.6 2.6 0 0 1 3.7 3.7l-1.1 1.1M8.8 11.2l-1.1 1.1a2.6 2.6 0 0 1-3.7-3.7l1.1-1.1"),
    plug: ic("M6 1.8v3M10 1.8v3M4 4.8h8v2.4a4 4 0 0 1-8 0zM8 11.2v3"),
    key: ic("M9.4 6.6L14 2M12 4l1.6 1.6", '<circle cx="6" cy="10" r="3.4" ' + SI + "/>"),
    puzzle: ic("M3 5h2.5a1.5 1.5 0 1 1 3 0H11v2.5a1.5 1.5 0 1 1 0 3V13H3z"),
    user: ic("M2.8 14a5.2 5.2 0 0 1 10.4 0", '<circle cx="8" cy="5.6" r="3" ' + SI + "/>"),
    gauge: ic("M8 9.5l2.6-3.2M2.4 11.5a6 6 0 1 1 11.2 0"),
    cpu: ic("M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2", '<rect x="3.5" y="3.5" width="9" height="9" rx="2" ' + SI + "/>"),
    palette: ic("M8 14a6 6 0 1 1 6-6c0 1.7-1.3 2.4-2.5 2.4H10a1.3 1.3 0 0 0-.9 2.2c.5.6.1 1.4-1.1 1.4z", '<circle cx="5.3" cy="7.3" r=".9" fill="currentColor"/><circle cx="8" cy="5" r=".9" fill="currentColor"/><circle cx="10.8" cy="7" r=".9" fill="currentColor"/>'),
    threads: ic("M2.5 4h11M2.5 8h11M2.5 12h7"),
    office: ic("M8 2l5.5 3v6L8 14l-5.5-3V5zM8 8v6M8 8l5.5-3M8 8L2.5 5"),
    list: ic("M5.5 4h8M5.5 8h8M5.5 12h8M2.6 4h.01M2.6 8h.01M2.6 12h.01"),
    sidebar: ic("M6 2.8v10.4", '<rect x="2" y="2.8" width="12" height="10.4" rx="2" ' + SI + "/>"),
    popout: ic("M9 2.5h4.5V7M13.5 2.5L8 8M11.5 9.5V13a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V5.6a.8.8 0 0 1 .8-.8h3.5"),
    diff: ic("M9.5 1.8H4.3a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1V5zM9.5 1.8V5h3.2M8 6.4v3.2M6.4 8h3.2M6.4 11.6h3.2"),
    check: ic("M3.2 8.4l3 3 6.6-6.8"),
    arrow: ic("M3 8h10M9 4l4 4-4 4"),
    back: ic("M13 8H3M7 4L3 8l4 4"),
    copy: ic("M5.5 5.5V3.3a.8.8 0 0 1 .8-.8h6.4a.8.8 0 0 1 .8.8v6.4a.8.8 0 0 1-.8.8h-2.2", '<rect x="2.5" y="5.5" width="8" height="8" rx=".9" ' + SI + "/>"),
    sun: ic("M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9", '<circle cx="8" cy="8" r="2.8" ' + SI + "/>"),
    moon: ic("M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z"),
    globe: ic("M2 8h12M8 2c1.8 2 2.6 4 2.6 6S9.8 12 8 14M8 2C6.2 4 5.4 6 5.4 8s.8 4 2.6 6", '<circle cx="8" cy="8" r="6" ' + SI + "/>"),
    cmd: ic("M6 6V4.5A1.5 1.5 0 1 0 4.5 6H6zM10 6h1.5A1.5 1.5 0 1 0 10 4.5zM6 10H4.5A1.5 1.5 0 1 0 6 11.5zM10 10v1.5a1.5 1.5 0 1 0 1.5-1.5zM6 6h4v4H6z"),
    wifi: ic("M1.8 6.2a9 9 0 0 1 12.4 0M4 8.6a5.8 5.8 0 0 1 8 0M6.2 11a2.6 2.6 0 0 1 3.6 0"),
    compose: ic("M13.5 8.5V13a.8.8 0 0 1-.8.8H3a.8.8 0 0 1-.8-.8V3.3a.8.8 0 0 1 .8-.8h4.5M11.2 2.3l2.5 2.5L8.3 10.2H5.8V7.7z"),
    folderplus: ic("M2.5 4.5a1 1 0 0 1 1-1h3l1.4 1.5h4.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM8 7.3v3.4M6.3 9h3.4"),
    history: ic("M2.6 8a5.4 5.4 0 1 0 1.6-3.8M2.4 2.6v2.2h2.2M8 5.2V8l2 1.2"),
    zap: ic("M9 1.8L3.5 9h4.1l-1 5.2L12.4 7H8.3z"),
    filter: ic("M2.5 3.5h11L9.2 8.6v4.2l-2.4-1.2V8.6z"),
    calendar: ic("M2.5 6.5h11M5.5 1.8v2.4M10.5 1.8v2.4", '<rect x="2.5" y="3.2" width="11" height="10.3" rx="1.8" ' + SI + "/>"),
    waveform: ic("M2 8h.01M4.6 6v4M7.2 3.5v9M9.8 5.5v5M12.4 7v2M14.6 8h.01"),
    eye: ic("M1.8 8S4 3.6 8 3.6 14.2 8 14.2 8 12 12.4 8 12.4 1.8 8 1.8 8z", '<circle cx="8" cy="8" r="2" ' + SI + "/>"),
    refresh: ic("M13.4 5.2A5.8 5.8 0 0 0 2.6 6.4M2.6 10.8a5.8 5.8 0 0 0 10.8 1.2M13.4 2.4v2.8h-2.8M2.6 13.6v-2.8h2.8"),
  };

  /* Brand marks: Simple Icons path data (CC0), drawn in currentColor. */
  var BRANDS = {
    github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
    gmail: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
    sentry: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
    posthog: "M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z",
    intercom: "M21 0H3C1.343 0 0 1.343 0 3v18c0 1.658 1.343 3 3 3h18c1.658 0 3-1.342 3-3V3c0-1.657-1.342-3-3-3zm-5.801 4.399c0-.44.36-.8.802-.8.44 0 .8.36.8.8v10.688c0 .442-.36.801-.8.801-.443 0-.802-.359-.802-.801V4.399zM11.2 3.994c0-.44.357-.799.8-.799s.8.359.8.799v11.602c0 .44-.357.8-.8.8s-.8-.36-.8-.8V3.994zm-4 .405c0-.44.359-.8.799-.8.443 0 .802.36.802.8v10.688c0 .442-.36.801-.802.801-.44 0-.799-.359-.799-.801V4.399zM3.199 6c0-.442.36-.8.802-.8.44 0 .799.358.799.8v7.195c0 .441-.359.8-.799.8-.443 0-.802-.36-.802-.8V6zM20.52 18.202c-.123.105-3.086 2.593-8.52 2.593-5.433 0-8.397-2.486-8.521-2.593-.335-.288-.375-.792-.086-1.128.285-.334.79-.375 1.125-.09.047.041 2.693 2.211 7.481 2.211 4.848 0 7.456-2.186 7.479-2.207.334-.289.839-.25 1.128.086.289.336.25.84-.086 1.128zm.281-5.007c0 .441-.36.8-.801.8-.441 0-.801-.36-.801-.8V6c0-.442.361-.8.801-.8.441 0 .801.357.801.8v7.195z",
    grafana: "M23.02 10.59a8.578 8.578 0 0 0-.862-3.034 8.911 8.911 0 0 0-1.789-2.445c.337-1.342-.413-2.505-.413-2.505-1.292-.08-2.113.4-2.416.62-.052-.02-.102-.044-.154-.064-.22-.089-.446-.172-.677-.247-.231-.073-.47-.14-.711-.197a9.867 9.867 0 0 0-.875-.161C14.557.753 12.94 0 12.94 0c-1.804 1.145-2.147 2.744-2.147 2.744l-.018.093c-.098.029-.2.057-.298.088-.138.042-.275.094-.413.143-.138.055-.275.107-.41.166a8.869 8.869 0 0 0-1.557.87l-.063-.029c-2.497-.955-4.716.195-4.716.195-.203 2.658.996 4.33 1.235 4.636a11.608 11.608 0 0 0-.607 2.635C1.636 12.677.953 15.014.953 15.014c1.926 2.214 4.171 2.351 4.171 2.351.003-.002.006-.002.006-.005.285.509.615.994.986 1.446.156.19.32.371.488.548-.704 2.009.099 3.68.099 3.68 2.144.08 3.553-.937 3.849-1.173a9.784 9.784 0 0 0 3.164.501h.08l.055-.003.107-.002.103-.005.003.002c1.01 1.44 2.788 1.646 2.788 1.646 1.264-1.332 1.337-2.653 1.337-2.94v-.058c0-.02-.003-.039-.003-.06.265-.187.52-.387.758-.6a7.875 7.875 0 0 0 1.415-1.7c1.43.083 2.437-.885 2.437-.885-.236-1.49-1.085-2.216-1.264-2.354l-.018-.013-.016-.013a.217.217 0 0 1-.031-.02c.008-.092.016-.18.02-.27.011-.162.016-.323.016-.48v-.253l-.005-.098-.008-.135a1.891 1.891 0 0 0-.01-.13c-.003-.042-.008-.083-.013-.125l-.016-.124-.018-.122a6.215 6.215 0 0 0-2.032-3.73 6.015 6.015 0 0 0-3.222-1.46 6.292 6.292 0 0 0-.85-.048l-.107.002h-.063l-.044.003-.104.008a4.777 4.777 0 0 0-3.335 1.695c-.332.4-.592.84-.768 1.297a4.594 4.594 0 0 0-.312 1.817l.003.091c.005.055.007.11.013.164a3.615 3.615 0 0 0 .698 1.82 3.53 3.53 0 0 0 1.827 1.282c.33.098.66.14.971.137.039 0 .078 0 .114-.002l.063-.003c.02 0 .041-.003.062-.003.034-.002.065-.007.099-.01.007 0 .018-.003.028-.003l.031-.005.06-.008a1.18 1.18 0 0 0 .112-.02c.036-.008.072-.013.109-.024a2.634 2.634 0 0 0 .914-.415c.028-.02.056-.041.085-.065a.248.248 0 0 0 .039-.35.244.244 0 0 0-.309-.06l-.078.042c-.09.044-.184.083-.283.116a2.476 2.476 0 0 1-.475.096c-.028.003-.054.006-.083.006l-.083.002c-.026 0-.054 0-.08-.002l-.102-.006h-.012l-.024.006c-.016-.003-.031-.003-.044-.006-.031-.002-.06-.007-.091-.01a2.59 2.59 0 0 1-.724-.213 2.557 2.557 0 0 1-.667-.438 2.52 2.52 0 0 1-.805-1.475 2.306 2.306 0 0 1-.029-.444l.006-.122v-.023l.002-.031c.003-.021.003-.04.005-.06a3.163 3.163 0 0 1 1.352-2.29 3.12 3.12 0 0 1 .937-.43 2.946 2.946 0 0 1 .776-.101h.06l.07.002.045.003h.026l.07.005a4.041 4.041 0 0 1 1.635.49 3.94 3.94 0 0 1 1.602 1.662 3.77 3.77 0 0 1 .397 1.414l.005.076.003.075c.002.026.002.05.002.075 0 .024.003.052 0 .07v.065l-.002.073-.008.174a6.195 6.195 0 0 1-.08.639 5.1 5.1 0 0 1-.267.927 5.31 5.31 0 0 1-.624 1.13 5.052 5.052 0 0 1-3.237 2.014 4.82 4.82 0 0 1-.649.066l-.039.003h-.287a6.607 6.607 0 0 1-1.716-.265 6.776 6.776 0 0 1-3.4-2.274 6.75 6.75 0 0 1-.746-1.15 6.616 6.616 0 0 1-.714-2.596l-.005-.083-.002-.02v-.056l-.003-.073v-.096l-.003-.104v-.07l.003-.163c.008-.22.026-.45.054-.678a8.707 8.707 0 0 1 .28-1.355c.128-.444.286-.872.473-1.277a7.04 7.04 0 0 1 1.456-2.1 5.925 5.925 0 0 1 .953-.763c.169-.111.343-.213.524-.306.089-.05.182-.091.273-.135.047-.02.093-.042.138-.062a7.177 7.177 0 0 1 .714-.267l.145-.045c.049-.015.098-.026.148-.041.098-.029.197-.052.296-.076.049-.013.1-.02.15-.033l.15-.032.151-.028.076-.013.075-.01.153-.024c.057-.01.114-.013.171-.023l.169-.021c.036-.003.073-.008.106-.01l.073-.008.036-.003.042-.002c.057-.003.114-.008.171-.01l.086-.006h.023l.037-.003.145-.007a7.999 7.999 0 0 1 1.708.125 7.917 7.917 0 0 1 2.048.68 8.253 8.253 0 0 1 1.672 1.09l.09.077.089.078c.06.052.114.107.171.159.057.052.112.106.166.16.052.055.107.107.159.164a8.671 8.671 0 0 1 1.41 1.978c.012.026.028.052.04.078l.04.078.075.156c.023.051.05.1.07.153l.065.15a8.848 8.848 0 0 1 .45 1.34.19.19 0 0 0 .201.142.186.186 0 0 0 .172-.184c.01-.246.002-.532-.024-.856z",
    stripe: "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
    slack: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
    discord: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
    claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    anthropic: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
    openai: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    linear: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
    googlecalendar: "M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z",
  };
  var OWN_BRANDS = {
    cron:
      '<circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 6.6V12l3.8 2.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
    webchat:
      '<path d="M6.5 3.5h11a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H11l-5 3.6V17.5h.5a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4z" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"/><circle cx="8.3" cy="10.5" r="1.4" fill="currentColor"/><circle cx="12" cy="10.5" r="1.4" fill="currentColor"/><circle cx="15.7" cy="10.5" r="1.4" fill="currentColor"/>',
    pi: '<text x="12" y="13" text-anchor="middle" dominant-baseline="central" font-family="Geist Mono, monospace" font-size="21" font-weight="600" fill="currentColor">π</text>',
    codex: "",
  };

  function renderMark(el) {
    var name = el.getAttribute("data-mark");
    var body = MARKS[name];
    if (!body) return;
    el.outerHTML =
      '<svg class="mk mk-' + name + (el.className ? " " + el.className : "") + '" viewBox="0 0 12 12" aria-hidden="true"' +
      styleAttr(el) + ">" + body + "</svg>";
  }
  function renderIcon(el) {
    var name = el.getAttribute("data-icon");
    var body = ICONS[name];
    if (!body) return;
    el.outerHTML =
      '<svg class="ic ic-' + name + (el.className ? " " + el.className : "") + '" viewBox="0 0 16 16" aria-hidden="true"' +
      styleAttr(el) + ">" + body + "</svg>";
  }
  function renderBrand(el) {
    var name = el.getAttribute("data-brand");
    var body = OWN_BRANDS[name] != null ? OWN_BRANDS[name] : BRANDS[name] ? '<path fill="currentColor" d="' + BRANDS[name] + '"/>' : "";
    if (name === "codex") body = '<path fill="currentColor" d="' + BRANDS.openai + '"/>';
    if (name === "claudecode") body = '<path fill="currentColor" d="' + BRANDS.claude + '"/>';
    el.outerHTML =
      '<svg class="br br-' + name + (el.className ? " " + el.className : "") + '" viewBox="0 0 24 24" role="img" aria-label="' +
      name + '"' + styleAttr(el) + ">" + body + "</svg>";
  }
  function styleAttr(el) {
    var s = el.getAttribute("style");
    return s ? ' style="' + s + '"' : "";
  }

  function renderHalo(el) {
    var size = Number(el.getAttribute("data-size")) || el.getBoundingClientRect().width || 64;
    el.innerHTML = buildHalo({
      size: size,
      segments: el.getAttribute("data-halo"),
      notch: el.getAttribute("data-notch"),
      center: el.getAttribute("data-center"),
      label: el.getAttribute("data-label"),
      span: el.getAttribute("data-span"),
      track: el.hasAttribute("data-track"),
      merge: el.hasAttribute("data-merge"),
      split: el.hasAttribute("data-split"),
      still: el.hasAttribute("data-still"),
      aria: el.getAttribute("aria-label"),
    });
    el.classList.add("halo");
  }

  /* Returns an SVG strip of ticks: the halo unrolled into a line, one tick per item, using the
   * same segment grammar. Height follows the level, so "needs you" stands taller than "handled".
   *   <span data-ticks="wait6.4 idle198.1" data-width="260" data-height="20"></span> */
  function buildTicks(opts) {
    var items = parseSegments(opts.segments);
    var w = Number(opts.width) || 240;
    var h = Number(opts.height) || 18;
    var pitch = w / (items.length || 1);
    var tw = Math.max(0.8, Math.min(3, pitch * 0.6));
    var heights = { 1: 0.32, 2: 0.55, 3: 0.8, 4: 1 };
    var bars = items
      .map(function (it, i) {
        var bh = h * (heights[it.level] || 0.5);
        return '<rect class="h-' + it.state + '" x="' + f(i * pitch + (pitch - tw) / 2) + '" y="' + f(h - bh) + '" width="' + f(tw) +
          '" height="' + f(bh) + '" rx="' + f(Math.min(tw / 2, 1)) + '"/>';
      })
      .join("");
    return '<svg class="ticks-svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" aria-hidden="true">' + bars + "</svg>";
  }

  function renderTicks(el) {
    el.innerHTML = buildTicks({ segments: el.getAttribute("data-ticks"), width: el.getAttribute("data-width"), height: el.getAttribute("data-height") });
    el.classList.add("ticks");
  }

  function mount(root) {
    root = root || document;
    root.querySelectorAll("[data-mark]").forEach(renderMark);
    root.querySelectorAll("[data-icon]").forEach(renderIcon);
    root.querySelectorAll("[data-brand]").forEach(renderBrand);
    root.querySelectorAll("[data-halo]").forEach(renderHalo);
    root.querySelectorAll("[data-ticks]").forEach(renderTicks);
  }

  /* ------------------------------------------------------------------ the glass composer
   * While the transcript scrolls away from the bottom, the composer shrinks and turns see-through;
   * it restores at the bottom or when focused. ?state=scrolled forces the shrunken state. */
  function wireComposer() {
    var scroller = document.querySelector("[data-transcript]");
    var composer = document.querySelector("[data-composer]");
    if (!scroller || !composer) return;
    var forced = document.documentElement.dataset.state === "scrolled";
    function atBottom() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    }
    function update() {
      var focused = composer.contains(document.activeElement);
      composer.classList.toggle("is-compact", !focused && (forced || !atBottom()));
    }
    if (forced) {
      // Scroll up far enough that the transcript runs behind the shrunken composer.
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 430);
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    scroller.addEventListener("scroll", function () {
      forced = false;
      update();
    }, { passive: true });
    composer.addEventListener("focusin", update);
    composer.addEventListener("focusout", function () {
      setTimeout(update, 0);
    });
    composer.addEventListener("click", function () {
      if (composer.classList.contains("is-compact")) {
        forced = false;
        var ta = composer.querySelector("textarea");
        if (ta) ta.focus();
        update();
      }
    });
    update();
  }

  /* ------------------------------------------------------------------ the live favicon
   * The favicon is a live halo; colors are resolved from the theme because a favicon cannot
   * read CSS variables. */
  function setFavicon() {
    var root = document.documentElement;
    var spec = root.getAttribute("data-favicon");
    if (!spec) return;
    var cs = getComputedStyle(root);
    var svg = buildHalo({ size: 32, segments: spec, center: root.getAttribute("data-favicon-center"), still: true });
    var colors = { wait: "--wait", work: "--work", fail: "--fail", idle: "--idle", pause: "--muted", asleep: "--idle", fyi: "--idle", ink: "--ink" };
    svg = svg.replace(/class="h-seg h-(\w+)[^"]*"/g, function (_, st) {
      return 'fill="' + cs.getPropertyValue(colors[st] || "--ink").trim() + '"';
    });
    svg = svg.replace('class="h-num"', 'fill="' + cs.getPropertyValue("--ink").trim() + '" font-family="Outfit, sans-serif"');
    var link = document.querySelector('link[rel="icon"]') || document.head.appendChild(document.createElement("link"));
    link.rel = "icon";
    link.href = "data:image/svg+xml," + encodeURIComponent(svg);
  }

  /* Segmented controls and toggles: a click marks the pressed option, nothing more. */
  function wireControls() {
    document.addEventListener("click", function (e) {
      var opt = e.target.closest("[data-seg] > button");
      if (opt) {
        opt.parentElement.querySelectorAll("button").forEach(function (b) {
          b.setAttribute("aria-pressed", String(b === opt));
        });
      }
      var sw = e.target.closest("[role=switch]");
      if (sw) sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true"));
      var th = e.target.closest("[data-set-theme]");
      if (th) {
        document.documentElement.dataset.theme = th.getAttribute("data-set-theme");
        document.querySelectorAll("[data-set-theme]").forEach(function (b) {
          b.setAttribute("aria-pressed", String(b === th));
        });
        setFavicon();
      }
    });
  }

  /* Presses the theme option that matches the page's theme, so a ?theme= link opens with the
   * right card chosen. "light" and "dark" are aliases of the two flagships. */
  function pressCurrentTheme() {
    var aliases = { light: "daylight", dark: "eclipse" };
    var t = document.documentElement.dataset.theme || "daylight";
    t = aliases[t] || t;
    document.querySelectorAll("[data-set-theme]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-set-theme") === t));
    });
  }

  function start() {
    // Screenshots are taken by an automated browser; the intro sweep would be caught mid-flight.
    if (navigator.webdriver) document.documentElement.classList.add("no-intro");
    mount(document);
    wireComposer();
    wireControls();
    pressCurrentTheme();
    setFavicon();
  }

  window.Halo = { build: buildHalo, ticks: buildTicks, mount: mount, parse: parseSegments, marks: MARKS, icons: ICONS };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
