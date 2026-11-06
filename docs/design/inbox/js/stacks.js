// The stack: the one rule behind the page. A stack shows the oldest few, and everything else waits in a pile under them. More
// volume makes the pile thicker, not the page busier, so the page looks the same at 30 cards and at 300.
(function () {
  // A strip's height, by density. An open strip shows a title and a line. A tight strip is one line, with any news at its end.
  var METRICS = {
    open: { strip: 52, gap: 12 },
    tight: { strip: 34, gap: 8 },
  };
  var LEAD_GAP = 12;  // the air under a stack's first card, which stands apart from the strips behind it
  var PILE = 56;      // a pile, with its sheets
  var TAB = 28;       // a group's heading on the shelf

  /**
   * Returns how many cards each stack of a column may show, so that together they fit the depth. A stack's depth is a hard limit,
   * and the pile is the only thing that gives: the tallest stack gives up a strip until all of them fit.
   */
  function planBudgets(stacks, depth) {
    var plans = stacks.map(function (s) { return { s: s, strips: Math.min(s.cap, Math.max(0, s.count - 1)) }; });
    var readRest = function (p) { return p.s.count - 1 - p.strips; };
    var height = function (p) {
      if (!p.s.count) return 30 + p.s.foot;
      var rest = readRest(p);
      // A pile of one is only a card in disguise, so it stands as a strip.
      return p.s.lead + LEAD_GAP + (p.strips + (rest === 1 ? 1 : 0)) * METRICS.open.strip + (rest > 1 ? PILE : 0) + p.s.foot;
    };
    var total = function () { return plans.reduce(function (a, p) { return a + height(p); }, 0); };
    while (total() > depth) {
      var tallest = null;
      plans.forEach(function (p) { if (p.strips > 0 && (!tallest || height(p) > height(tallest))) tallest = p; });
      if (!tallest) break;
      tallest.strips--;
    }
    return plans.map(function (p) { return 1 + p.strips + (readRest(p) === 1 ? 1 : 0); });
  }

  /**
   * Returns where each item of a stack lies. An item is a card, a tab or a pile, and each knows its own height.
   * With room, every card is whole. Otherwise the first card of a stack on the clock stands whole, and the rest are strips.
   */
  function layOut(items, depth, hasLead) {
    var n = items.length, out = [], y = 0, i;
    if (!n) return { items: out, used: 0 };
    var hasPile = items.some(function (m) { return m.isPile; });
    var whole = items.reduce(function (a, m) { return a + (m.tab ? m.tab : m.full + m.gap); }, 0);
    if (whole <= depth && !hasPile) {
      for (i = 0; i < n; i++) {
        var w = items[i];
        out.push({ y: y, show: w.tab || w.full, level: w.tab ? 'tab' : 'full' });
        y += w.tab ? w.tab : w.full + w.gap;
      }
      return { items: out, used: y - (items[n - 1].gap || 0) };
    }
    var firstCard = hasLead ? 0 : -1;
    for (i = 0; i < n; i++) {
      var m = items[i];
      if (m.tab) { out.push({ y: y, show: m.tab, level: 'tab' }); y += m.tab; continue; }
      if (i === firstCard) { out.push({ y: y, show: m.full, level: 'full' }); y += m.full + LEAD_GAP; continue; }
      out.push({ y: y, show: m.strip, level: m.strip > 40 ? 'two' : 'one' });
      y += m.strip;
    }
    return { items: out, used: y };
  }

  /**
   * Returns the depth each stack of a column gets: what it asks for if the column has room, and otherwise a share in proportion.
   */
  function shareDepth(needs, depth) {
    var total = needs.reduce(function (a, n) { return a + n.asks; }, 0);
    if (total <= depth) return needs.map(function (n) { return n.asks; });
    return needs.map(function (n) { return Math.floor((depth * n.asks) / total); });
  }

  window.Stacks = { METRICS: METRICS, LEAD_GAP: LEAD_GAP, PILE: PILE, TAB: TAB, planBudgets: planBudgets, layOut: layOut, shareDepth: shareDepth };
})();
