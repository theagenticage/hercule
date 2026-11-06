// The stack: the one rule behind the page. A stack has a fixed depth, and its cards share that depth.
(function () {
  // The heights a card can show, by density. `two` shows the title and one line under it, `one` shows the title.
  var METRICS = {
    open: { two: 50, one: 36, gap: 12, most: 58 },
    tight: { two: 46, one: 32, gap: 8, most: 50 },
  };
  var LEAD_GAP = 12; // the air under a stack's first card, which stands apart from the strips behind it

  /**
   * Returns where each item of a stack lies. An item is a card, or a tab that heads a group. Items keep their order.
   * With room, every card is whole. With less room, the first stays whole and the others show two lines, then one line,
   * oldest first. With too little room for that, the newest fold into a pile at the foot.
   */
  function layOut(items, depth, noLead) {
    var n = items.length, out = [], y = 0, i;
    if (!n) return { items: out, folded: 0, used: 0 };
    var whole = items.reduce(function (a, m) { return a + (m.tab ? m.tab : m.full + m.gap); }, 0);
    var hasPile = items.some(function (m) { return m.isPile; });
    if (whole <= depth && !hasPile) {
      for (i = 0; i < n; i++) {
        var w = items[i];
        out.push({ y: y, show: w.tab || w.full, level: w.tab ? 'tab' : 'full' });
        y += w.tab ? w.tab : w.full + w.gap;
      }
      return { items: out, folded: 0, used: y - (items[n - 1].gap || 0) };
    }
    // A stack on the clock leads with what has waited longest. The shelf has no clock, so nothing there leads.
    var firstCard = noLead ? -1 : items[0].tab ? 1 : 0;
    var fixed = 0, least = 0;
    items.forEach(function (m, j) { if (m.tab) fixed += m.tab; else if (j === firstCard) fixed += m.full + LEAD_GAP; else least += m.one; });
    var spare = depth - fixed - least, shown = n, folded = 0;
    while (spare < 0 && shown > Math.max(1, firstCard + 1)) { shown--; folded++; spare += items[shown].tab ? items[shown].tab : items[shown].one; }
    // First decide who gets two lines, oldest first. Then what depth is left is shared out, so the stack ends at its foot.
    // A card with news goes first: its second line is the reason it matters.
    var levels = [], twos = 0;
    var giveTwo = function (j) {
      var c = items[j], grow = c.two - c.one;
      if (spare < grow) return;
      spare -= grow;
      twos++;
      levels[j] = 'two';
    };
    for (i = 0; i < shown; i++) levels[i] = items[i].tab || i === firstCard ? null : 'one';
    for (i = 0; i < shown; i++) if (levels[i] === 'one' && items[i].speaks) giveTwo(i);
    for (i = 0; i < shown; i++) if (levels[i] === 'one' && !items[i].speaks) giveTwo(i);
    var extra = twos ? spare / twos : 0;
    y = 0;
    for (i = 0; i < shown; i++) {
      var m = items[i];
      if (m.tab) { out.push({ y: y, show: m.tab, level: 'tab' }); y += m.tab; continue; }
      if (i === firstCard) { out.push({ y: y, show: m.full, level: 'full' }); y += m.full + LEAD_GAP; continue; }
      var show = levels[i] === 'two' ? Math.min(m.most || m.two, m.two + extra) : m.one;
      out.push({ y: y, show: Math.round(show), level: levels[i] });
      y += Math.round(show);
    }
    return { items: out, folded: folded, used: y };
  }

  /**
   * Returns how many cards of a stack may stay out at this depth. A stack keeps showing two lines as long as it can, and
   * takes one-line strips only for a small overflow: past that, a wall of titles is worse than a pile.
   */
  function countKept(count, depth, m, firstHeight) {
    var byTwo = 1 + Math.floor((depth - firstHeight - LEAD_GAP) / m.two);
    var byOne = 1 + Math.floor((depth - firstHeight - LEAD_GAP) / m.one);
    return count <= Math.min(byOne, Math.ceil(byTwo * 1.3)) ? count : byTwo;
  }

  /**
   * Returns the depth each stack of a column gets. Each stack gets what it needs to show its cards whole if it can; otherwise
   * two lines each; otherwise the depth is shared in proportion, and no stack gets less than its least.
   */
  function shareDepth(needs, depth) {
    var sum = function (field) { return needs.reduce(function (a, n) { return a + n[field]; }, 0); };
    var whole = sum('whole'), comfy = sum('comfy'), least = sum('least');
    if (whole <= depth) return needs.map(function (n) { return n.whole; });
    if (least >= depth) return needs.map(function (n) { return Math.floor((depth * n.least) / least); });
    // Two lines for everyone comes first. What is left over goes to those who could use it.
    if (comfy <= depth) return needs.map(function (n) { return Math.ceil(n.comfy + ((depth - comfy) * (n.whole - n.comfy)) / (whole - comfy || 1)); });
    return needs.map(function (n) { return Math.floor(n.least + ((depth - least) * (n.comfy - n.least)) / (comfy - least || 1)); });
  }

  window.Stacks = { METRICS: METRICS, layOut: layOut, shareDepth: shareDepth, countKept: countKept };
})();
