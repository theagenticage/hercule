// The stack: the one rule behind the page. A stack has a fixed depth, and its cards share that depth.
(function () {
  // The heights a card can show, by density. `two` shows the title and one line under it, `one` shows the title.
  var METRICS = {
    open: { two: 49, one: 34, gap: 14 },
    tight: { two: 44, one: 32, gap: 8 },
  };

  /**
   * Returns where each item of a stack lies. An item is a card, or a tab that heads a group. Items keep their order.
   * With room, every card is whole. With less room, the first stays whole and the others show two lines, then one line,
   * oldest first. With too little room for that, the newest fold into a pile at the foot.
   */
  function layOut(items, depth) {
    var n = items.length, out = [], y = 0, i;
    if (!n) return { items: out, folded: 0, used: 0 };
    var whole = items.reduce(function (a, m) { return a + (m.tab ? m.tab : m.full + m.gap); }, 0);
    if (whole <= depth) {
      for (i = 0; i < n; i++) {
        var w = items[i];
        out.push({ y: y, show: w.tab || w.full, level: w.tab ? 'tab' : 'full' });
        y += w.tab ? w.tab : w.full + w.gap;
      }
      return { items: out, folded: 0, used: y };
    }
    var firstCard = items[0].tab ? 1 : 0;
    var fixed = 0, least = 0;
    items.forEach(function (m, j) { if (m.tab) fixed += m.tab; else if (j === firstCard) fixed += m.full + 2; else least += m.one; });
    var spare = depth - fixed - least, shown = n, folded = 0;
    while (spare < 0 && shown > firstCard + 1) { shown--; folded++; spare += items[shown].tab ? items[shown].tab : items[shown].one; }
    y = 0;
    for (i = 0; i < shown; i++) {
      var m = items[i];
      if (m.tab) { out.push({ y: y, show: m.tab, level: 'tab' }); y += m.tab; continue; }
      if (i === firstCard) { out.push({ y: y, show: m.full, level: 'full' }); y += m.full + 2; continue; }
      var grow = m.two - m.one, level = spare >= grow ? 'two' : 'one';
      if (level === 'two') spare -= grow;
      var show = level === 'two' ? m.two : m.one;
      out.push({ y: y, show: show, level: level });
      y += show;
    }
    return { items: out, folded: folded, used: y };
  }

  /**
   * Returns how many cards of a stack may stay out at this depth. A stack keeps showing two lines as long as it can, and
   * takes one-line strips only for a small overflow: past that, a wall of titles is worse than a pile.
   */
  function countKept(count, depth, m, firstHeight) {
    var byTwo = 1 + Math.floor((depth - firstHeight) / m.two);
    var byOne = 1 + Math.floor((depth - firstHeight) / m.one);
    return count <= Math.min(byOne, Math.ceil(byTwo * 1.3)) ? count : byTwo;
  }

  /**
   * Returns the depth each stack of a column gets. Each stack first gets what it needs to show its cards whole. When the
   * column is too short for that, the depth is shared in proportion to need, and no stack gets less than its least.
   */
  function shareDepth(needs, depth) {
    var total = needs.reduce(function (a, n) { return a + n.whole; }, 0);
    if (total <= depth) return needs.map(function (n) { return n.whole; });
    var least = needs.reduce(function (a, n) { return a + n.least; }, 0);
    if (least >= depth) return needs.map(function (n) { return Math.floor((depth * n.least) / least); });
    var spare = depth - least, wants = total - least;
    return needs.map(function (n) { return Math.floor(n.least + (spare * (n.whole - n.least)) / wants); });
  }

  window.Stacks = { METRICS: METRICS, layOut: layOut, shareDepth: shareDepth, countKept: countKept };
})();
