// PROTOTYPE - the route line, Expedition's atom: a hairline from base to summit, a mark per camp,
// filled in the thread's hue up to where it stands, the bean's head at its position, partners
// roped behind it, a marigold flag on a camp that waits on Rogier, a cloud over a stuck route.
//
// The window (expedition.js) and the story page (index.html) both draw it, so it lives alone.
// It needs window.WORLD (world.js, world-plus.js, expedition-data.js) and window.Crew for hues.
//
//   ExpeditionRoute.buildModel(goal, ctx)   reads a goal into where the route stands
//   ExpeditionRoute.drawRoute(model, opts)  returns the route's markup
//   ExpeditionRoute.describeProgress(model) returns the short progress words: "4 of 9", "+2 camps"
//
// Positions are percentages of the route's inner width, so one markup draws at 160px in the
// sidebar and at 1,000px in the ledger, and a CSS transition can move a camp when a route grows.
(function () {
  "use strict";

  var W = window.WORLD;

  function minutes(time) {
    return W.helpers.minutes(time);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  /** Returns the crew hue of a thread, the one its face wears: cast by hand or hashed from its title. */
  function findHue(title) {
    return Crew.lookFor(title).hue;
  }

  /*
   * Builds the model of one route. ctx:
   *   thread     the thread the goal belongs to (its pose decides whether the head is under way)
   *   partners   the threads roped to it (a lead's partners); each becomes a dot behind the head
   *   since      a time; the route marks where it stood then (the away state's ghost tick)
   *   showGrew   true while the route's growth is news (Rogier has not looked since it grew)
   * Returns { camps, total, done, headPct, landed, settingOut, waitIdx, nextIdx, stuckMin, grew,
   *   seenPct, ghostPct, movedCamps, hue, partners }. Camp positions are in camps[i].pct; seenPct
   *   and ghostPct are null unless ctx.since is given.
   */
  function buildModel(goal, ctx) {
    ctx = ctx || {};
    var t = ctx.thread || {};
    var camps = (goal && goal.camps) || [];
    var total = camps.length;
    var out = {
      camps: [],
      total: total,
      done: 0,
      landed: false,
      settingOut: total === 0,
      waitIdx: -1,
      nextIdx: -1,
      stuckMin: 0,
      grew: 0,
      grewAt: null,
      ghostPct: null,
      seenPct: null,
      movedCamps: 0,
      hue: findHue(t.title || ""),
      partners: [],
      summit: goal ? goal.summit : "",
    };
    camps.forEach(function (c, i) {
      var m = {};
      for (var k in c) m[k] = c[k];
      m.pct = ((i + 1) / total) * 100;
      out.camps.push(m);
      if (c.state === "done") out.done++;
      if (c.state === "waiting" && out.waitIdx < 0) out.waitIdx = i;
      if (c.added && (!out.grewAt || minutes(c.added) > minutes(out.grewAt))) out.grewAt = c.added;
    });
    out.landed = total > 0 && out.done === total;
    out.nextIdx = out.landed || out.settingOut ? -1 : out.done;

    // Where the head stands: at the last camp it reached, or part way to the next one while its
    // thread works. A camp that counts (9 of 14 secrets) puts the head that far along its leg.
    if (out.landed) out.headPct = 100;
    else if (out.settingOut) out.headPct = 0;
    else {
      var from = out.done > 0 ? out.camps[out.done - 1].pct : 0;
      var to = out.camps[out.done].pct;
      var next = out.camps[out.done];
      var frac = 0;
      if (next.of) frac = next.of[0] / next.of[1];
      else if (t.pose === "working" && next.state !== "waiting") frac = 0.45;
      out.headPct = from + frac * (to - from);
    }

    // Stuck: no camp reached for a while, though the thread is not idle.
    var quiet = goal && goal.lastProgress ? minutes(W.now) - minutes(goal.lastProgress) : 0;
    if (!out.landed && t.pose && t.pose !== "idle" && t.pose !== "asleep" && quiet >= W.expedition.stuckAfter) out.stuckMin = quiet;

    if (goal && goal.grew && ctx.showGrew) out.grew = goal.grew;

    // The away reading: the part of the route climbed before Rogier left is "seen", the rest is
    // news. A route he had seen that moved since gets a notch where it stood when he left.
    if (ctx.since && !out.settingOut) {
      var then = minutes(ctx.since);
      var doneThen = 0;
      if (!t.started || minutes(t.started) <= then) {
        out.camps.forEach(function (c) {
          if (c.state === "done" && c.at && minutes(c.at) <= then) doneThen++;
        });
      }
      out.movedCamps = out.done - doneThen;
      out.seenPct = Math.min(out.headPct, doneThen > 0 ? out.camps[doneThen - 1].pct : 0);
      if (out.movedCamps > 0 && doneThen > 0) out.ghostPct = out.seenPct;
    }

    (ctx.partners || []).forEach(function (p) {
      out.partners.push({ id: p.id, hue: findHue(p.title), waiting: p.pose === "waiting", role: p.role || "partner" });
    });
    return out;
  }

  /** Returns the words for where a route stands, as the row's right column shows them. */
  function describeProgress(m) {
    if (m.settingOut) return "setting out";
    if (m.landed) return "landed";
    return m.done + " of " + m.total;
  }

  /** Returns a camp's tooltip: its label, when it was reached or what it waits on, and who sees it. */
  function describeCamp(c, i, m) {
    var when;
    if (c.state === "done") when = c.at ? "reached " + c.at : "reached";
    else if (c.state === "waiting") when = c.note ? c.note + (c.at ? " since " + c.at : "") : "waits on you" + (c.at ? " since " + c.at : "");
    else if (i === m.nextIdx) when = c.of ? c.of[0] + " of " + c.of[1] + " so far" : "on the way";
    else when = "not reached yet";
    var who = c.observed ? "a check Hercule sees itself" : "from the agent's plan";
    return c.label + " · " + when + " · " + who + (c.added ? " · added " + c.added : "") + (c.note && c.state !== "waiting" ? " · " + c.note : "");
  }

  var EGG =
    '<svg viewBox="0 0 10 12" width="10" height="12" aria-hidden="true"><path class="ex-r-egg" d="M5 .9C7.5.9 9.3 4.1 9.3 7c0 2.6-1.9 4.2-4.3 4.2S.7 9.6.7 7C.7 4.1 2.5.9 5 .9z"/>' +
    '<circle class="ex-r-eye" cx="3.7" cy="6.4" r=".85"/><circle class="ex-r-eye" cx="6.5" cy="6.4" r=".85"/></svg>';
  var FLAG = '<svg viewBox="0 0 8 11" width="8" height="11" aria-hidden="true"><path class="ex-r-pole" d="M1.2 1v10"/><path class="ex-r-pennant" d="M1.7 1.2 7.4 3.3 1.7 5.4z"/></svg>';
  var PEAK = '<svg viewBox="0 0 10 8" width="10" height="8" aria-hidden="true"><path d="M.8 7.4 5 .9l4.2 6.5z"/></svg>';
  var PEAK_FLAG =
    '<svg viewBox="0 0 12 13" width="12" height="13" aria-hidden="true"><path class="ex-r-peak" d="M1 12.4 6 4.6l5 7.8z"/><path class="ex-r-pole" d="M6 5V.8"/><path class="ex-r-sflag" d="M6.4.9 9.6 2.1 6.4 3.3z"/></svg>';
  var CLOUD =
    '<svg viewBox="0 0 14 9" width="14" height="9" aria-hidden="true"><path d="M3.9 8.3h6.6a2.5 2.5 0 0 0 .3-5A3.3 3.3 0 0 0 4.5 2.6 2.9 2.9 0 0 0 3.9 8.3z"/></svg>';

  /*
   * Returns the route's markup. opts:
   *   variant   "row" (the sidebar, 16px), "wide" (the ledger, with every camp's label), "card"
   *             (the selection card and the Board, with the next camp's label), or "mini" (a
   *             partner's line or a Board card: no head face, smaller)
   *   tips      true to give every camp a tooltip (data-tip)
   *   id        the thread id, set on the route as data-route
   */
  function drawRoute(m, opts) {
    opts = opts || {};
    var variant = opts.variant || "row";
    var cls = "ex-route ex-route--" + variant + (m.landed ? " is-landed" : "") + (m.settingOut ? " is-setting-out" : "") + (m.stuckMin ? " is-stuck" : "") + (m.seenPct != null ? " is-away" + (m.movedCamps > 0 ? " has-news" : "") : "");
    var style = "--hue:var(--hue-" + m.hue + ");--n:" + Math.max(1, m.total);
    var html = '<span class="' + cls + '" style="' + style + '"' + (opts.id ? ' data-route="' + opts.id + '"' : "") + ">";
    html += '<span class="ex-r-in">';

    if (m.settingOut) {
      // No plan yet: a short dashed start and the head, and no summit until the agent writes one.
      html += '<span class="ex-r-dash"></span><span class="ex-r-base"></span>' + '<span class="ex-r-head ex-r-head--setting" style="left:28px">' + EGG + "</span></span></span>";
      return html;
    }

    html += '<span class="ex-r-track"></span>';
    if (m.seenPct != null) {
      html += '<span class="ex-r-fill ex-r-fill--seen" style="width:' + m.seenPct + '%"></span>';
      if (m.headPct > m.seenPct) html += '<span class="ex-r-fill ex-r-fill--new" style="left:' + m.seenPct + "%;width:" + (m.headPct - m.seenPct) + '%"></span>';
    } else {
      html += '<span class="ex-r-fill" style="width:' + m.headPct + '%"></span>';
    }
    html += '<span class="ex-r-base"></span>';

    m.camps.forEach(function (c, i) {
      if (i === m.total - 1) return; // the last camp is the summit
      if (i === m.waitIdx) return; // the flag stands there
      var k = "ex-r-camp" + (c.observed ? " is-obs" : "") + (c.state === "done" ? " is-done" : "") + (i === m.nextIdx ? " is-next" : "") + (c.added ? " is-added" : "");
      html += '<span class="' + k + '" data-c="' + i + '" style="left:' + c.pct + '%"' + (opts.tips ? ' data-tip="' + esc(describeCamp(c, i, m)) + '"' : "") + "></span>";
    });

    var last = m.camps[m.total - 1];
    html += '<span class="ex-r-summit' + (m.landed ? " is-reached" : "") + '"' + (opts.tips ? ' data-tip="' + esc("Summit: " + m.summit + " · " + describeCamp(last, m.total - 1, m)) + '"' : "") + ">" + (m.landed ? PEAK_FLAG : PEAK) + "</span>";

    if (m.ghostPct != null) {
      html += '<span class="ex-r-ghost" style="left:' + m.ghostPct + '%"' + (opts.tips ? ' data-tip="Where it stood when you left at ' + esc(opts.ghostAt || "09:01") + '"' : "") + "></span>";
    }

    if (m.waitIdx >= 0) {
      var wc = m.camps[m.waitIdx];
      html += '<span class="ex-r-flag" style="left:' + wc.pct + '%"' + (opts.tips ? ' data-tip="' + esc(describeCamp(wc, m.waitIdx, m)) + '"' : "") + ">" + FLAG + "</span>";
    }

    if (!m.landed && m.partners.length && variant !== "mini") {
      html += '<span class="ex-r-rope" style="left:' + m.headPct + '%">';
      m.partners.slice(0, 3).forEach(function (p, i) {
        html += '<i class="' + (p.waiting ? "is-waiting" : "") + '" style="--hue:var(--hue-' + p.hue + ");--i:" + (i + 1) + '"></i>';
      });
      html += "</span>";
    }

    if (!m.landed) html += '<span class="ex-r-head" style="left:' + m.headPct + '%">' + EGG + "</span>";
    if (m.stuckMin) html += '<span class="ex-r-cloud" style="left:' + m.headPct + '%"' + (opts.tips ? ' data-tip="No camp reached in ' + m.stuckMin + 'm"' : "") + ">" + CLOUD + "</span>";

    if (variant === "wide" || variant === "card") html += drawLabels(m, variant, opts.numbers);
    html += "</span></span>";
    return html;
  }

  /**
   * Returns the camp labels under a route: every camp on the wide route, the next one on a card.
   * With `numbers`, each camp is labelled by its number instead, for a list beside the route.
   */
  function drawLabels(m, variant, numbers) {
    var html = '<span class="ex-r-labels' + (numbers ? " ex-r-labels--num" : "") + '">';
    m.camps.forEach(function (c, i) {
      var shown = variant === "wide" || i === m.nextIdx || (m.landed && i === m.total - 1);
      if (!shown) return;
      var k = "ex-r-label" + (c.state === "done" ? " is-done" : "") + (i === m.nextIdx ? " is-next" : "") + (c.state === "waiting" ? " is-waiting" : "") + (c.added ? " is-added" : "") + (i === m.total - 1 ? " is-last" : "") + (i === 0 ? " is-first" : "");
      // A lone label leans away from the route's ends, so it never runs past them.
      if (variant === "card") k += c.pct < 30 ? " is-start" : c.pct > 70 ? " is-end" : "";
      // A long code word ("handlePaymentResult") may break where its words join, never mid-word.
      var text = numbers ? String(i + 1) : esc(c.label).replace(/([a-z])([A-Z])/g, "$1<wbr>$2");
      html += '<span class="' + k + '" data-c="' + i + '" style="left:' + c.pct + '%">' + (c.added && !numbers ? '<b class="ex-r-plus">+</b>' : "") + text + "</span>";
    });
    return html + "</span>";
  }

  window.ExpeditionRoute = {
    buildModel: buildModel,
    drawRoute: drawRoute,
    describeProgress: describeProgress,
    describeCamp: describeCamp,
    findHue: findHue,
    icons: { egg: EGG, flag: FLAG, peak: PEAK, cloud: CLOUD },
  };
})();
