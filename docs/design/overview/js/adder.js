// PROTOTYPE - Add to Work: starting work from this page. A sheet at the right lists outside things
// that have no Task yet, from one source, opening on whatever you were looking at. The board stays
// in view behind it, and what you add stays in view too. A plain New Task sits at the top.
window.Adder = (function () {
  "use strict";

  var sheet = null;
  var source = "";
  var scope = "";
  var words = "";
  var lane = null;
  var added = {};

  function esc(s) { return Board.esc(s); }

  function isOpen() { return !!sheet && sheet.classList.contains("is-on"); }

  /** Lists every outside thing the picker can offer, including what was added while it is open. */
  function readItems() {
    return Graph.listOffered(Store.state.tasks, added);
  }

  /** Lists the outside things that can narrow the list for one source. */
  function readScopes(items) {
    var seen = {};
    items.forEach(function (e) {
      Graph.readAncestors([e.ref]).forEach(function (r) { if (Graph.KINDS[Graph.entity(r).kind].group) seen[r] = true; });
    });
    return Object.keys(seen).sort(function (a, b) {
      var ka = Graph.KINDS[Graph.entity(a).kind].group;
      var kb = Graph.KINDS[Graph.entity(b).kind].group;
      return ka.localeCompare(kb) || Graph.entity(a).title.localeCompare(Graph.entity(b).title);
    });
  }

  function isInScope(e) {
    if (!scope) return true;
    if (scope.indexOf("project:") === 0) return e.project === scope.slice(8);
    return Graph.readAncestors([e.ref]).indexOf(scope) >= 0;
  }

  /** Lists the headings a thing could sit under: each parent whose kind declares itself a heading. */
  function readHeadings(e) {
    var parents = Graph.readParents(e.ref).filter(function (r) { return Graph.KINDS[Graph.entity(r).kind].listBy; });
    return parents.length ? parents : [""];
  }

  /** Draws one thing. If it sits under more than one heading, it says so: no parent is the only one. */
  function drawRow(e, heading) {
    var taken = Store.state.tasks.some(function (t) { return t.entities.indexOf(e.ref) >= 0; });
    var made = taken ? Store.state.tasks.filter(function (t) { return t.entities.indexOf(e.ref) >= 0; })[0] : null;
    var state = made ? NW.STAGES.filter(function (s) { return s.id === made.stage; })[0].name : e.state;
    var others = readHeadings(e).filter(function (h) { return h && h !== heading; }).map(function (h) { return Graph.entity(h).title; });
    var also = others.length ? '<small class="ad-also">Also in ' + esc(others.join(", ")) + "</small>" : "";
    return '<button class="ad-row' + (taken ? " is-added" : "") + '" data-add-ref="' + esc(e.ref) + '"' + (taken ? " disabled" : "") + '><small class="ad-ref">' + esc(e.label) + '</small><span class="ad-words"><span class="ad-title">' + esc(e.title) + "</span>" + also + '</span><small class="ad-state">' + esc(state) + '</small><i class="ad-go">' + Crew.icon(taken ? "check" : "plus", 14) + "</i></button>";
  }

  function drawList() {
    var needle = words.toLowerCase();
    var items = readItems().filter(function (e) {
      return Graph.sourceOf(e.ref) === source && isInScope(e) && (e.title + " " + e.label).toLowerCase().indexOf(needle) >= 0;
    });
    if (!items.length) return '<p class="ad-none">Nothing from ' + esc(Graph.SOURCES[source]) + " here without a Task.</p>";
    // Each thing is listed once, under the heading you narrowed to or its first. Its row says where else it sits.
    function pickHeading(e) {
      var all = readHeadings(e);
      return all.indexOf(scope) >= 0 ? scope : all[0];
    }
    var heads = [];
    items.forEach(function (e) { if (heads.indexOf(pickHeading(e)) < 0) heads.push(pickHeading(e)); });
    return heads.map(function (h) {
      var rows = items.filter(function (e) { return pickHeading(e) === h; });
      var title = h ? '<h4 class="ad-h"><b>' + esc(Graph.entity(h).title) + "</b><small>" + Board.drawContextFacts(Graph.entity(h)) + "</small></h4>" : "";
      return title + rows.map(function (e) { return drawRow(e, h); }).join("");
    }).join("");
  }

  function drawPicker() {
    var ofSource = readItems().filter(function (e) { return Graph.sourceOf(e.ref) === source; });
    var scopes = readScopes(ofSource);
    var projects = Store.state.projects.filter(function (p) { return scope === "project:" + p.id || ofSource.some(function (e) { return e.project === p.id; }); });
    var options = '<option value="">Everywhere</option>' + projects.map(function (p) {
      return '<option value="project:' + esc(p.id) + '"' + (scope === "project:" + p.id ? " selected" : "") + ">" + esc(p.name) + "</option>";
    }).join("") + scopes.map(function (r) {
      return '<option value="' + esc(r) + '"' + (scope === r ? " selected" : "") + ">" + esc(Graph.entity(r).title) + " (" + esc(Graph.KINDS[Graph.entity(r).kind].group) + ")</option>";
    }).join("");
    return '<div class="seg ad-sources" role="tablist">' + Object.keys(Graph.SOURCES).map(function (s) {
      return '<button role="tab" aria-selected="' + (s === source) + '" data-add-source="' + s + '">' + Crew.brand(s, 14) + esc(Graph.SOURCES[s]) + "</button>";
    }).join("") + "</div>" +
      '<div class="ad-narrow"><label class="ad-scope"><span class="ad-in">In</span><select data-add-scope aria-label="Narrow the list">' + options + '</select>' + Crew.icon("chev-d", 12) + '</label><input class="ad-find" data-add-find placeholder="Find" aria-label="Find" value="' + esc(words) + '"></div>' +
      '<div class="ad-list" id="ad-list">' + drawList() + "</div>";
  }

  /** Says where a plain New Task lands, and where it will show under the current grouping. */
  function describeLanding() {
    var project = readTargetProject();
    var name = project !== undefined ? Store.state.projects.filter(function (p) { return p.id === project; })[0].name : "";
    var kind = Graph.KINDS[Store.state.groupBy];
    return "Starts in Exploring" + (name ? ", in " + name : "") + "." + (kind ? " It shows under No " + kind.group + " until a source says otherwise." : "");
  }

  /** Decides which project a plain New Task joins: the lane you came from, then the scope, then the first. */
  function readTargetProject() {
    if (lane && lane.type === "project") return lane.id;
    if (lane && lane.type === "initiative") return Store.state.plans.filter(function (p) { return p.id === lane.id; })[0].project;
    if (scope.indexOf("project:") === 0) return scope.slice(8);
    // A lane for an outside thing has no project of its own, so it follows most of what is in it.
    var tally = {};
    (lane && lane.tasks || []).forEach(function (t) { tally[t.project] = (tally[t.project] || 0) + 1; });
    var likely = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0];
    return likely !== undefined ? likely : (Store.state.projects[0] || {}).id;
  }

  /** Returns the project an outside thing belongs to, or the first one if this board does not have it. */
  function readEntityProject(e) {
    var known = Store.state.projects.some(function (p) { return p.id === e.project; });
    return known ? e.project : (Store.state.projects[0] || {}).id;
  }

  function draw() {
    sheet.innerHTML = '<div class="ad-head"><h2>Add to Work</h2><button class="icon-btn" data-add-close aria-label="Close">' + Crew.icon("close", 14) + "</button></div>" +
      '<form class="ad-new" data-add-new><input placeholder="New Task" aria-label="New Task"><kbd>↩</kbd></form><p class="ad-landing">' + esc(describeLanding()) + '</p>' +
      '<h3 class="ad-from">From a source</h3>' + drawPicker();
  }

  /** Decides what the picker opens on: the lane you asked from, then the filter that is on. */
  function decideStart(from) {
    var filters = Store.state.filters;
    scope = "";
    if (from && from.type === "context") scope = from.entity.ref;
    else if (from && from.type === "project") scope = "project:" + from.id;
    else if (from && from.type === "initiative") scope = "project:" + readTargetProject();
    else {
      var active = Store.readActiveFilters().filter(function (f) { return Graph.KINDS[f.facet]; })[0];
      if (active) scope = active.value;
      else if (filters.project) scope = "project:" + Object.keys(filters.project)[0];
    }
    var named = filters.source ? Object.keys(filters.source).filter(function (s) { return Graph.SOURCES[s]; })[0] : "";
    // It opens on a source that has something to offer here, so the list is not empty for no reason.
    var offering = Object.keys(Graph.SOURCES).filter(function (s) {
      return readItems().some(function (e) { return Graph.sourceOf(e.ref) === s && isInScope(e); });
    })[0];
    source = (scope && Graph.entity(scope) ? Graph.sourceOf(scope) : "") || named || offering || source || Object.keys(Graph.SOURCES)[0];
  }

  /** Opens the sheet. Pass a lane's id to open on that lane. */
  function show(laneId) {
    if (Pane.currentId()) Pane.hide();
    lane = laneId ? Store.readLanes().filter(function (l) { return l.id === laneId; })[0] : null;
    decideStart(lane);
    words = "";
    added = {};
    draw();
    sheet.hidden = false;
    sheet.classList.add("is-on");
    document.getElementById("work").classList.add("has-pane");
    Motion.body(sheet).set({ x: 18, o: 0 }).to({ x: 0, o: 1 }, "hand");
    sheet.querySelector(".ad-new input").focus();
  }

  function hide() {
    if (!isOpen()) return false;
    sheet.classList.remove("is-on");
    document.getElementById("work").classList.remove("has-pane");
    Motion.body(sheet).to({ x: 18, o: 0 }, "hand", { done: function () { sheet.hidden = true; } });
    return true;
  }

  /** Says what became of a new Task: where it went, and anything that keeps it from view. */
  function reportAdded(t) {
    var stage = NW.STAGES.filter(function (s) { return s.id === t.stage; })[0].name;
    var hidden = Store.matches(t) ? "" : " Your filter hides it.";
    Toast.show("Added to " + stage + "." + hidden + (Store.state.offline ? " It will sync when you are back." : ""), true);
  }

  /** Puts a new Task on the board and keeps it in view for this visit. */
  function create(t) {
    t.fresh = true;
    t.pendingSync = !!Store.state.offline;
    // The board does not scroll: the sheet is still open, and the row and the line at the foot say where it went.
    Board.change(function () { Store.createTask(t); }, { spring: "travel", noAnchor: true });
    reportAdded(t);
  }

  /** Creates a Task from an outside thing. It starts at the stage its source state maps to. */
  function addEntity(ref) {
    var e = Graph.entity(ref);
    var kind = Graph.kindOf(ref);
    var plan = lane && lane.type === "initiative" ? Store.state.plans.filter(function (p) { return p.id === lane.id; })[0] : null;
    added[ref] = true;
    create({
      id: "add-" + ref, name: e.title, project: plan ? plan.project : readEntityProject(e), initiative: plan ? plan.id : "",
      stage: kind.stages[e.state], kind: "ticket", now: "Added just now.", where: "Added from " + Graph.SOURCES[kind.source] + ". Nothing has started yet.", left: "", ref: e.label, age: 0, entities: [ref], source: kind.source,
    });
    refresh();
  }

  function addPlain(name) {
    create({ id: "new-" + Date.now(), name: name, project: readTargetProject(), initiative: lane && lane.type === "initiative" ? lane.id : "", stage: "exploring", kind: "thread", now: "Nothing has started yet.", where: "Nothing has started yet.", left: "", ref: "", age: 0, entities: [], source: "" });
  }

  /** Redraws the list, keeping where it is scrolled. Undo on the board lands here too. */
  function refresh() {
    if (!isOpen()) return;
    var list = sheet.querySelector("#ad-list");
    if (!list) return;
    var top = list.scrollTop;
    list.innerHTML = drawList();
    list.scrollTop = top;
  }

  function redrawPicker() {
    var from = sheet.querySelector(".ad-from");
    while (from.nextSibling) from.nextSibling.remove();
    from.insertAdjacentHTML("afterend", drawPicker());
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
        scope = scope.indexOf("project:") === 0 ? scope : "";
        words = "";
        return redrawPicker();
      }
      var row = e.target.closest("[data-add-ref]");
      if (row) addEntity(row.dataset.addRef);
    });
    sheet.addEventListener("change", function (e) {
      if (!e.target.matches("[data-add-scope]")) return;
      scope = e.target.value;
      refresh();
      sheet.querySelector(".ad-landing").textContent = describeLanding();
    });
    sheet.addEventListener("input", function (e) {
      if (!e.target.matches("[data-add-find]")) return;
      words = e.target.value;
      refresh();
    });
    sheet.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = e.target.querySelector("input");
      if (input.value.trim()) addPlain(input.value.trim());
      input.value = "";
    });
  }

  return { mount: mount, show: show, hide: hide, isOpen: isOpen, refresh: refresh };
})();
