// The stack: the one rule behind the page. A stack shows the oldest few, and everything else waits in a pile under them. More
// volume makes the pile thicker, not the page busier, so the page looks the same at 30 cards and at 300.
(function () {
  // A strip's height, by density. An open strip shows a title and a line; a tight strip shows a title, and a line only when it has news.
  var METRICS = {
    open: { strip: 52, gap: 12 },
    tight: { strip: 34, news: 50, gap: 8 },
  };
  var LEAD_GAP = 12;  // the air under a stack's first card, which stands apart from the strips behind it
  var PILE = 70;      // a pile, with its sheets
  var TAB = 28;       // a group's heading on the shelf

  /** Returns how many strips a stack on the clock may show under its first card, at this depth. */
  function countStrips(depth, sharesColumn, leadHeight) {
    var room = Math.floor((depth - leadHeight - LEAD_GAP - PILE) / METRICS.open.strip);
    return Math.max(1, Math.min(sharesColumn ? 3 : 5, room));
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

  window.Stacks = { METRICS: METRICS, LEAD_GAP: LEAD_GAP, PILE: PILE, TAB: TAB, countStrips: countStrips, layOut: layOut, shareDepth: shareDepth };
})();
