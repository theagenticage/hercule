// PROTOTYPE - Add to Work: starting work from this page. The sheet's main action is a search that
// reaches the source itself, through its plugin, so it finds things Hercule has never seen. Words,
// an identifier or a pasted link all work, and a link works from any source. Before you type, it
// offers what already concerns you, and says that is all those are. A plain New Task sits at the top.
window.Adder = (function () {
  "use strict";

  // How long the prototype's sources take to answer. ?hold= keeps them searching, for a drawing.
  var ANSWER_AFTER = Number(new URLSearchParams(location.search).get("hold")) || 460;
  var WAIT_FOR_TYPING = 180;

  var sheet = null;
  var source = "";
  var scope = "";
  var words = "";
  var lane = null;
  var added = {};
  // What the list shows: "offers", "searching", "results" or "link".
  var view = "offers";
  var results = [];
  var linkAnswer = null;
  var run = 0;

  function esc(s) { return Board.esc(s); }

  function isOpen() { return !!sheet && sheet.classList.contains("is-on"); }

  function sourceName() { return Graph.SOURCES[source]; }

  function readTask(ref) {
    return Store.state.tasks.filter(function (t) { return t.entities.indexOf(ref) >= 0; })[0];
  }

  function isInScope(item) {
    return !scope || Graph.isUnder(item, scope);
  }

  /** Lists what concerns you and has no Task yet, from this source, including what was added just now. */
  function readOffers() {
    return Graph.listOffered(Store.state.tasks, added).map(function (e) {
      return Graph.readFromSource(e.ref);
    }).filter(function (i) { return Graph.KINDS[i.kind].source === source && isInScope(i); });
  }

  /** Lists the headings a thing could sit under: each parent whose kind declares itself a heading. */
  function readHeadings(item) {
    var parents = item.parents.filter(function (r) { return Graph.KINDS[Graph.entity(r).kind].listBy; });
    return parents.length ? parents : [""];
  }

  /** Draws one thing. If it sits under several places, it says so: no parent is the only one. */
  function drawRow(item, heading) {
    var task = readTask(item.ref);
    var isNew = !item.known && !Graph.entity(item.ref);
    var places = readHeadings(item).filter(function (h) { return h && h !== heading; }).map(function (h) { return Graph.entity(h).title; });
    var where = heading ? (places.length ? "Also in " + places.join(", ") : "") : places.join(", ");
    var note = [where, isNew ? "New to Hercule" : ""].filter(Boolean).join(" · ");
    var state = task ? NW.STAGES.filter(function (s) { return s.id === task.stage; })[0].name : item.state;
    var justAdded = task && added[item.ref];
    var go = justAdded ? Crew.icon("check", 14) : task ? Crew.icon("chev-r", 12) : Crew.icon("plus", 14);
    return '<button class="ad-row' + (justAdded ? " is-added" : task ? " is-on-work" : "") + '" data-add-ref="' + esc(item.ref) + '"' + (justAdded ? " disabled" : "") + (task && !justAdded ? ' title="Open it on Work"' : "") + '><small class="ad-ref">' + esc(item.label) + '</small><span class="ad-words"><span class="ad-title">' + esc(item.title) + "</span>" + (note ? '<small class="ad-also">' + esc(note) + "</small>" : "") + '</span><small class="ad-state">' + esc(task && !justAdded ? "On Work" : state) + '</small><i class="ad-go">' + go + "</i></button>";
  }

  /** Draws what concerns you, under its context, and says plainly that this is not all there is. */
  function drawOffers() {
    var items = readOffers().filter(function (i) { return (i.label + " " + i.title).toLowerCase().indexOf(words.toLowerCase()) >= 0; });
    var label = '<h4 class="ad-label">Suggestions<small>Things that concern you, with no Task yet.' + (Store.state.offline ? "" : " Search to reach everything else.") + "</small></h4>";
    if (!items.length) return label + '<p class="ad-none">Nothing to suggest here.</p>';
    function pickHeading(i) {
      var all = readHeadings(i);
      return all.indexOf(scope) >= 0 ? scope : all[0];
    }
    var heads = [];
    items.forEach(function (i) { if (heads.indexOf(pickHeading(i)) < 0) heads.push(pickHeading(i)); });
    return label + heads.map(function (h) {
      var title = h ? '<h4 class="ad-h"><b>' + esc(Graph.entity(h).title) + "</b><small>" + Board.drawContextFacts(Graph.entity(h)) + "</small></h4>" : "";
      return title + items.filter(function (i) { return pickHeading(i) === h; }).map(function (i) { return drawRow(i, h); }).join("");
    }).join("");
  }

  function drawSearching() {
    var bars = "";
    for (var i = 0; i < 3; i++) bars += '<div class="ad-bar"><i></i><i></i></div>';
    return '<h4 class="ad-label">Searching ' + esc(sourceName()) + "…</h4>" + bars;
  }

  function drawResults() {
    if (results.length) {
      var count = results.length + (results.length === 1 ? " result" : " results");
      return '<h4 class="ad-label">From ' + esc(sourceName()) + "<small>" + count + "</small></h4>" + results.map(function (i) { return drawRow(i, ""); }).join("");
    }
    if (!scope) return '<p class="ad-none">' + esc(sourceName()) + ' has nothing that matches "' + esc(words) + '".</p>';
    return '<p class="ad-none">Nothing in ' + esc(Graph.entity(scope).title) + ' matches "' + esc(words) + '".</p><button class="ad-widen" data-add-widen>Search all of ' + esc(sourceName()) + "</button>";
  }

  /** Draws what a pasted link led to: the thing, a thing you cannot open, or nothing. */
  function drawLinkAnswer() {
    var a = linkAnswer;
    if (a.foreign) return '<p class="ad-none">This link is not from a connected source. Hercule can read links from ' + esc(Object.keys(Graph.SOURCES).map(function (s) { return Graph.SOURCES[s]; }).join(", ")) + ".</p>";
    if (a.item && a.item.locked) {
      var kind = Graph.KINDS[a.item.locked];
      return '<h4 class="ad-label">From ' + esc(sourceName()) + '<small>Found from the link</small></h4><div class="ad-locked">' + Crew.icon("lock", 14) + "<span><b>You cannot open this " + esc(sourceName()) + " " + esc(kind.word.toLowerCase()) + ".</b><small>It exists, but your connection to " + esc(sourceName()) + " has no access to it. Ask for access, then paste the link again.</small></span></div>";
    }
    if (!a.item) return '<p class="ad-none">' + esc(sourceName()) + " found nothing at this link. It may be wrong, or the thing may be gone.</p>";
    return '<h4 class="ad-label">From ' + esc(sourceName()) + "<small>Found from the link</small></h4>" + drawRow(a.item, "");
  }

  function drawList() {
    if (view === "searching") return drawSearching();
    if (view === "results") return drawResults();
    if (view === "link") return drawLinkAnswer();
    return drawOffers();
  }

  /** Draws the quiet line under the search, which says exactly where it reaches. */
  function drawReach() {
    if (Store.state.offline) return '<p class="ad-reach is-off">You are offline, so ' + esc(sourceName()) + " cannot be searched. Typing only narrows the suggestions.</p>";
    if (view === "link" || view === "searching" && Graph.recognizeLink(words)) return '<p class="ad-reach">Reading this link from ' + esc(sourceName()) + ".</p>";
    var options = '<option value="">all of ' + esc(sourceName()) + "</option>" + Graph.listContexts(source).map(function (r) {
      var e = Graph.entity(r);
      return '<option value="' + esc(r) + '"' + (scope === r ? " selected" : "") + ">" + esc(e.title) + " (" + esc(Graph.KINDS[e.kind].word.toLowerCase()) + ")</option>";
    }).join("");
    return '<label class="ad-reach"><span>Searches</span><span class="ad-reach-pick"><select data-add-scope aria-label="Narrow the search">' + options + "</select>" + Crew.icon("chev-d", 11) + "</span>" + (scope ? "<span>in " + esc(sourceName()) + "</span>" : "") + "</label>";
  }

  function drawSearchBox() {
    var hint = "Search " + sourceName() + ", or paste a link";
    return '<form class="ad-search" data-add-search>' + Crew.icon("search", 15) + '<input data-add-find placeholder="' + esc(hint) + '" aria-label="' + esc(hint) + '" value="' + esc(words) + '" autocomplete="off"></form>';
  }

  function drawPicker() {
    return '<div class="seg ad-sources" role="tablist">' + Object.keys(Graph.SOURCES).map(function (s) {
      return '<button role="tab" aria-selected="' + (s === source) + '" data-add-source="' + s + '">' + Crew.brand(s, 14) + esc(Graph.SOURCES[s]) + "</button>";
    }).join("") + "</div>" + drawSearchBox() + '<div id="ad-reach">' + drawReach() + '</div><div class="ad-list" id="ad-list">' + drawList() + "</div>";
  }

  /** Says where a plain New Task lands, and where it will show under the current grouping. */
  function describeLanding() {
    var project = readTargetProject();
    var name = project !== undefined ? Store.state.projects.filter(function (p) { return p.id === project; })[0].name : "";
    var kind = Graph.KINDS[Store.state.groupBy];
    return "Starts in Exploring" + (name ? ", in " + name : "") + "." + (kind ? " It shows under No " + kind.group + " until a source says otherwise." : "");
  }

  /** Decides which project a plain New Task joins: the lane you came from, then most of that lane, then the first. */
  function readTargetProject() {
    if (lane && lane.type === "project") return lane.id;
    if (lane && lane.type === "initiative") return Store.state.plans.filter(function (p) { return p.id === lane.id; })[0].project;
    var tally = {};
    (lane && lane.tasks || []).forEach(function (t) { tally[t.project] = (tally[t.project] || 0) + 1; });
    var likely = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0];
    return likely !== undefined ? likely : (Store.state.projects[0] || {}).id;
  }

  /** Returns the project a thing from a source joins: its own if this board has it, else where you came from. */
  function readItemProject(item) {
    var known = Store.state.projects.some(function (p) { return p.id === item.project; });
    return known ? item.project : readTargetProject();
  }

  function draw() {
    sheet.innerHTML = '<div class="ad-head"><h2>Add to Work</h2><button class="icon-btn" data-add-close aria-label="Close">' + Crew.icon("close", 14) + "</button></div>" +
      '<form class="ad-new" data-add-new><input placeholder="New Task" aria-label="New Task"><kbd>↩</kbd></form><p class="ad-landing">' + esc(describeLanding()) + '</p>' +
      '<h3 class="ad-from">From a source</h3>' + drawPicker();
  }

  /** Picks the context of this source that most of a lane's Tasks sit under, or none. */
  function guessScope(from) {
    if (!from) return "";
    if (from.type === "context" && from.source === source) return from.entity.ref;
    var tally = {};
    from.tasks.forEach(function (t) {
      Graph.readAncestors(t.entities).forEach(function (r) {
        if (Graph.sourceOf(r) === source && Graph.KINDS[Graph.entity(r).kind].group) tally[r] = (tally[r] || 0) + 1;
      });
    });
    return Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0] || "";
  }

  /** Decides what the picker opens on: the lane you asked from, then the filter that is on. */
  function decideStart(from) {
    var filters = Store.state.filters;
    var active = Store.readActiveFilters().filter(function (f) { return Graph.KINDS[f.facet]; })[0];
    var named = filters.source ? Object.keys(filters.source).filter(function (s) { return Graph.SOURCES[s]; })[0] : "";
    source = (from && from.source) || (active && Graph.sourceOf(active.value)) || named || source || Object.keys(Graph.SOURCES)[0];
    scope = from ? guessScope(from) : active ? active.value : "";
  }

  function redrawPicker() {
    var from = sheet.querySelector(".ad-from");
    while (from.nextSibling) from.nextSibling.remove();
    from.insertAdjacentHTML("afterend", drawPicker());
  }

  /** Redraws the list and the line above it, keeping where the list is scrolled. Undo on the board lands here too. */
  function refresh() {
    if (!isOpen()) return;
    var list = sheet.querySelector("#ad-list");
    if (!list) return;
    var top = list.scrollTop;
    list.innerHTML = drawList();
    list.scrollTop = top;
    sheet.querySelector("#ad-reach").innerHTML = drawReach();
  }

  /** Starts a search or a link lookup. An answer that a newer one has replaced is thrown away. */
  function search() {
    var mine = ++run;
    var text = words.trim();
    if (!text || Store.state.offline) {
      view = "offers";
      return refresh();
    }
    var link = Graph.recognizeLink(text);
    var isLink = /^https?:\/\//i.test(text) || /\.example\//i.test(text);
    if (link && link.source !== source) {
      // A link says which source it is from, so nobody has to choose one first.
      source = link.source;
      redrawPicker();
      var box = sheet.querySelector("[data-add-find]");
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
    if (isLink && !link) {
      view = "link";
      linkAnswer = { foreign: true };
      return refresh();
    }
    view = "searching";
    refresh();
    setTimeout(function () {
      if (mine !== run || !isOpen()) return;
      if (link) {
        view = "link";
        linkAnswer = { item: Graph.readFromSource(link.ref) };
      } else {
        view = "results";
        results = Graph.searchSource(source, text).filter(isInScope);
      }
      refresh();
    }, ANSWER_AFTER);
  }

  /** Sets what is typed in the search, and searches once typing stops. */
  function setWords(text, now) {
    words = text;
    clearTimeout(setWords.timer);
    if (now) return search();
    setWords.timer = setTimeout(search, WAIT_FOR_TYPING);
  }

  /** Opens the sheet. Pass a lane's id to open on that lane. */
  function show(laneId) {
    if (Pane.currentId()) Pane.hide();
    lane = laneId ? Store.readLanes().filter(function (l) { return l.id === laneId; })[0] : null;
    decideStart(lane);
    words = "";
    view = "offers";
    added = {};
    draw();
    sheet.hidden = false;
    sheet.classList.add("is-on");
    document.getElementById("work").classList.add("has-pane");
    Motion.body(sheet).set({ x: 18, o: 0 }).to({ x: 0, o: 1 }, "hand");
    sheet.querySelector("[data-add-find]").focus();
  }

  function hide() {
    if (!isOpen()) return false;
    sheet.classList.remove("is-on");
    document.getElementById("work").classList.remove("has-pane");
    Motion.body(sheet).to({ x: 18, o: 0 }, "hand", { done: function () { sheet.hidden = true; } });
    return true;
  }

  /** Esc: clears what is typed first, then closes. */
  function stepBack() {
    if (!words) return hide();
    var box = sheet.querySelector("[data-add-find]");
    box.value = "";
    setWords("", true);
    box.focus();
  }

  /** Says what became of a new Task: where it went, and anything that keeps it from view. */
  function reportAdded(t, followed) {
    var stage = NW.STAGES.filter(function (s) { return s.id === t.stage; })[0].name;
    var hidden = Store.matches(t) ? "" : " Your filter hides it.";
    Toast.show("Added to " + stage + "." + (followed ? " Hercule now follows " + t.ref + "." : "") + hidden + (Store.state.offline ? " It will sync when you are back." : ""), true);
  }

  /** Puts a new Task on the board and keeps it in view for this visit. */
  function create(t, followed) {
    t.fresh = true;
    t.pendingSync = !!Store.state.offline;
    // The board does not scroll: the sheet is still open, and the row and the line at the foot say where it went.
    Board.change(function () { Store.createTask(t); }, { spring: "travel", noAnchor: true });
    reportAdded(t, followed);
  }

  /**
   * Creates a Task for a thing from a source. If Hercule has not seen it, its record comes first,
   * with "following" as its concern. It starts at the stage its source state maps to.
   */
  function addItem(item) {
    var kind = Graph.KINDS[item.kind];
    var plan = lane && lane.type === "initiative" ? Store.state.plans.filter(function (p) { return p.id === lane.id; })[0] : null;
    var followed = !Graph.entity(item.ref);
    Graph.follow(item);
    added[item.ref] = true;
    create({
      id: "add-" + item.ref, name: item.title, project: plan ? plan.project : readItemProject(item), initiative: plan ? plan.id : "",
      stage: kind.stages[item.state], kind: "ticket", now: "Added just now.", where: "Added from " + Graph.SOURCES[kind.source] + ". Nothing has started yet.", left: "", ref: item.label, age: 0, entities: [item.ref], source: kind.source,
    }, followed);
    refresh();
  }

  function addPlain(name) {
    create({ id: "new-" + Date.now(), name: name, project: readTargetProject(), initiative: lane && lane.type === "initiative" ? lane.id : "", stage: "exploring", kind: "thread", now: "Nothing has started yet.", where: "Nothing has started yet.", left: "", ref: "", age: 0, entities: [], source: "" });
  }

  /** Adds what a click or Return chose, or opens it if it already has a Task. */
  function pick(ref) {
    var task = readTask(ref);
    if (task) return Pane.show(task.id);
    addItem(Graph.readFromSource(ref));
    // The row just went quiet, so the keys go back to the search, ready for the next one.
    sheet.querySelector("[data-add-find]").focus();
  }

  function mount() {
    sheet = document.getElementById("adder");
    document.getElementById("add-btn").innerHTML = Crew.icon("plus", 14) + "<b>Add</b>";
    document.getElementById("add-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      if (isOpen()) hide();
      else show();
    });
    sheet.addEventListener("click", function (e) {
      e.stopPropagation();
      if (e.target.closest("[data-add-close]")) return hide();
      var src = e.target.closest("[data-add-source]");
      if (src) {
        source = src.dataset.addSource;
        scope = guessScope(lane);
        view = "offers";
        redrawPicker();
        sheet.querySelector("[data-add-find]").focus();
        return setWords(words, true);
      }
      if (e.target.closest("[data-add-widen]")) {
        scope = "";
        return setWords(words, true);
      }
      var row = e.target.closest("[data-add-ref]");
      if (row) pick(row.dataset.addRef);
    });
    sheet.addEventListener("change", function (e) {
      if (!e.target.matches("[data-add-scope]")) return;
      scope = e.target.value;
      setWords(words, true);
    });
    sheet.addEventListener("input", function (e) {
      if (e.target.matches("[data-add-find]")) setWords(e.target.value);
    });
    sheet.addEventListener("submit", function (e) {
      e.preventDefault();
      if (e.target.matches("[data-add-search]")) {
        var first = sheet.querySelector("#ad-list .ad-row:not(.is-on-work):not(.is-added)");
        if (first) pick(first.dataset.addRef);
        return;
      }
      var input = e.target.querySelector("input");
      if (input.value.trim()) addPlain(input.value.trim());
      input.value = "";
    });
  }

  /** Opens the sheet with something already typed, for the Prototype tray and the screens. */
  function demo(text) {
    if (!isOpen()) show();
    sheet.querySelector("[data-add-find]").value = text;
    setWords(text, true);
  }

  return { mount: mount, show: show, hide: hide, stepBack: stepBack, isOpen: isOpen, refresh: refresh, demo: demo };
})();
