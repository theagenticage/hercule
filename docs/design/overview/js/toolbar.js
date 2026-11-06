// PROTOTYPE - the toolbar: Group by, Filter, and what is on. Normal controls, because every person
// knows them, and because more ways of grouping and filtering will come. The choices come from the
// data: whatever the sources report as part-of shows up here by itself.
window.Toolbar = (function () {
  "use strict";

  var openMenu = "";
  var facetId = "";
  var facetWords = "";

  function esc(s) { return Board.esc(s); }

  function drawMark(item) {
    if (item.source) return '<span class="menu-mark">' + Crew.brand(item.source, 14) + "</span>";
    if (item.hue !== undefined) return '<span class="menu-mark menu-mark--plan" style="--plan-hue:' + item.hue + '">' + Board.FLAG + "</span>";
    if (item.tint) return '<span class="menu-mark"><i class="proj proj--' + item.tint + '"></i></span>';
    if (item.icon === "flag") return '<span class="menu-mark">' + Board.FLAG + "</span>";
    if (item.icon) return '<span class="menu-mark">' + Crew.icon(item.icon, 14) + "</span>";
    return '<span class="menu-mark"></span>';
  }

  function groupName() {
    var st = Store.state;
    return Store.listGroupings().filter(function (g) { return g.id === st.groupBy; })[0].name;
  }

  /** Draws the controls and the chips of what is on. The menu is drawn only while it is open. */
  function draw() {
    var main = document.getElementById("tools-main");
    if (!main) return;
    var active = Store.readActiveFilters();
    var html = '<button class="tool" data-tool="group" aria-haspopup="menu" aria-expanded="' + (openMenu === "group") + '"><span class="tool-key">Group by</span><b>' + esc(groupName()) + "</b>" + Crew.icon("chev-d", 12) + "</button>" +
      '<button class="tool" data-tool="filter" aria-haspopup="menu" aria-expanded="' + (openMenu === "filter") + '">' + Crew.icon("filter", 14) + "<b>Filter</b></button>";
    html += active.map(function (f) {
      return '<button class="chip" data-chip-facet="' + esc(f.facet) + '" data-chip-value="' + esc(f.value) + '" title="Remove this filter">' + (f.caption ? "<small>" + esc(f.caption) + "</small>" : "") + "<b>" + esc(f.name) + "</b>" + Crew.icon("close", 11) + "</button>";
    }).join("");
    if (active.length > 1) html += '<button class="chip-clear" data-chip-clear>Clear</button>';
    if (main._html !== html) {
      main.innerHTML = html;
      main._html = html;
    }
  }

  function drawGroupMenu() {
    var all = Store.listGroupings();
    function row(g) {
      var on = g.id === Store.state.groupBy;
      return '<button class="menu-row menu-pick' + (on ? " is-on" : "") + '" role="menuitemradio" aria-checked="' + on + '" data-group="' + esc(g.id) + '">' + drawMark(g) + "<span>" + esc(g.name) + "</span>" + (on ? Crew.icon("check", 14) : "") + "</button>";
    }
    var own = all.filter(function (g) { return !g.source; });
    var outside = all.filter(function (g) { return g.source; });
    return own.map(row).join("") + (outside.length ? '<p class="menu-h">From your sources</p>' + outside.map(row).join("") : "");
  }

  function drawValueRow(facet, v) {
    var on = !!(Store.state.filters[facet] && Store.state.filters[facet][v.id]);
    return '<button class="menu-row menu-pick' + (on ? " is-on" : "") + '" role="menuitemcheckbox" aria-checked="' + on + '" data-facet="' + esc(facet) + '" data-value="' + esc(v.id) + '"><i class="menu-box">' + (on ? Crew.icon("check", 11) : "") + "</i>" + drawMark(v) + "<span>" + esc(v.name) + "</span><small>" + v.count + "</small></button>";
  }

  function drawFilterMenu() {
    var facets = Store.listFacets();
    if (facetId) {
      var facet = facets.filter(function (f) { return f.id === facetId; })[0];
      var needle = facetWords.toLowerCase();
      var values = facet.values.filter(function (v) { return v.name.toLowerCase().indexOf(needle) >= 0; });
      return '<button class="menu-row menu-back" data-facet-back>' + Crew.icon("chev-l", 12) + "<b>" + esc(facet.name) + "</b></button>" +
        (facet.values.length > 7 ? '<input class="menu-find" data-facet-find placeholder="Find" value="' + esc(facetWords) + '" aria-label="Find in ' + esc(facet.name) + '">' : "") +
        '<div class="menu-list">' + values.map(function (v) { return drawValueRow(facet.id, v); }).join("") + "</div>";
    }
    function facetRow(f) {
      var on = Store.state.filters[f.id] ? Object.keys(Store.state.filters[f.id]).length : 0;
      return '<button class="menu-row menu-pick" data-open-facet="' + esc(f.id) + '">' + drawMark(f) + "<span>" + esc(f.name) + "</span>" + (on ? "<small>" + on + "</small>" : "") + Crew.icon("chev-r", 12) + "</button>";
    }
    var states = facets[0];
    var own = facets.slice(1, 4);
    var outside = facets.slice(4);
    return states.values.map(function (v) { return drawValueRow("state", v); }).join("") + '<i class="menu-line"></i>' + own.map(facetRow).join("") + (outside.length ? '<p class="menu-h">From your sources</p>' + outside.map(facetRow).join("") : "");
  }

  function placeMenu(el, btn) {
    var top = btn.closest(".top").getBoundingClientRect();
    el.style.left = btn.getBoundingClientRect().left - top.left + "px";
  }

  function drawMenu() {
    var el = document.getElementById("tool-menu");
    el.classList.toggle("is-on", !!openMenu);
    if (!openMenu) return;
    el.innerHTML = openMenu === "group" ? drawGroupMenu() : drawFilterMenu();
    var btn = document.querySelector('[data-tool="' + openMenu + '"]');
    if (btn) placeMenu(el, btn);
  }

  function closeMenu() {
    var was = openMenu;
    openMenu = "";
    facetId = "";
    facetWords = "";
    drawMenu();
    draw();
    return !!was;
  }

  function toggleMenu(name) {
    var again = openMenu === name;
    closeMenu();
    if (again) return;
    openMenu = name;
    draw();
    drawMenu();
  }

  /** Changes the grouping. The board animates from what was on screen to the new lanes. */
  function setGroup(id) {
    Board.change(function () { Store.state.groupBy = id; }, { spring: "travel", quietExits: true, noAnchor: true });
    document.getElementById("scroll").scrollTop = 0;
  }

  function mount() {
    var tools = document.getElementById("tools");
    tools.addEventListener("click", function (e) {
      e.stopPropagation();
      var tool = e.target.closest("[data-tool]");
      if (tool) return toggleMenu(tool.dataset.tool);
      var chip = e.target.closest("[data-chip-facet]");
      if (chip) return Filters.toggle(chip.dataset.chipFacet, chip.dataset.chipValue);
      if (e.target.closest("[data-chip-clear]")) Filters.clear();
    });
    var menu = document.getElementById("tool-menu");
    menu.addEventListener("click", function (e) {
      e.stopPropagation();
      var group = e.target.closest("[data-group]");
      if (group) {
        closeMenu();
        return setGroup(group.dataset.group);
      }
      var open = e.target.closest("[data-open-facet]");
      if (open) {
        facetId = open.dataset.openFacet;
        return drawMenu();
      }
      if (e.target.closest("[data-facet-back]")) {
        facetId = "";
        facetWords = "";
        return drawMenu();
      }
      var value = e.target.closest("[data-facet]");
      if (value) {
        Filters.toggle(value.dataset.facet, value.dataset.value);
        drawMenu();
      }
    });
    menu.addEventListener("input", function (e) {
      if (!e.target.matches("[data-facet-find]")) return;
      facetWords = e.target.value;
      drawMenu();
      var box = menu.querySelector("[data-facet-find]");
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
    window.addEventListener("click", closeMenu);
    draw();
    drawDisplay();
  }

  /** Marks which comparison is on in the Display menu. */
  function drawDisplay() {
    document.querySelectorAll("#display [data-place], #display [data-lanes]").forEach(function (b) {
      var on = b.dataset.place ? b.dataset.place === Store.state.planPlace : b.dataset.lanes === Store.state.laneStyle;
      b.setAttribute("aria-selected", on);
    });
  }

  return { mount: mount, draw: draw, closeMenu: closeMenu, setGroup: setGroup, drawDisplay: drawDisplay };
})();

// PROTOTYPE - filters, as gestures on the board. What does not match leaves the page, and lanes with
// nothing left go with it. Everything still lies in its place when the filter is off.
window.Filters = (function () {
  "use strict";

  function apply(mutate) {
    Board.change(mutate, { spring: "travel", quietExits: true, noAnchor: true });
  }

  /** Brings a Task's card or bead into view. */
  function reveal(id) {
    var el = Board.locate(id);
    if (!el) return;
    var s = document.getElementById("scroll");
    var r = el.getBoundingClientRect();
    var view = s.getBoundingClientRect();
    if (r.top < view.top + 110) s.scrollTop -= view.top + 110 - r.top;
    if (r.bottom > view.bottom - 30) s.scrollTop += r.bottom - view.bottom + 30;
  }

  return {
    reveal: reveal,
    toggle: function (facet, value) {
      apply(function () { Store.toggleFilter(facet, value); });
    },
    clear: function () {
      Store.state.query = "";
      Find.close();
      apply(function () { Store.state.filters = {}; });
    },
    /** Shows only the Tasks that are part of one outside thing, wherever they came from. */
    showContext: function (kind, ref) {
      Store.state.filters = {};
      apply(function () { Store.toggleFilter(kind, ref); });
      document.getElementById("scroll").scrollTop = 0;
    },
    /** Opens Work on what failed, and brings the first failed Task into view. */
    showFailed: function () {
      if (Overview.current() !== "work") Overview.show("work");
      apply(function () { Store.state.filters = { state: { failed: true } }; });
      document.getElementById("scroll").scrollTop = 0;
    },
    /** Lifts the failed filter once nothing has failed, so the page does not stay empty. */
    settle: function () {
      var f = Store.state.filters.state;
      if (f && f.failed && !Store.countStates().failed) apply(function () { Store.toggleFilter("state", "failed"); });
    },
  };
})();
