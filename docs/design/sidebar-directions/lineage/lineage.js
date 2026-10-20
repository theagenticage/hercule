// PROTOTYPE - direction 2, Lineage: every thread keeps its row, and kinship is drawn.
//
// A lead and the threads it started are a family. The partners sit under their lead, joined to
// it by one line in the lead's signature hue (color is who, and the lead is who started them).
// A partner's row says only what it adds: its face on the line, its role, its agent, its status.
// Quiet partners fold into a knot on the line. When the list is grouped any other way, families
// split, and every partner carries a kin tag instead: its lead's hue and its lead's name.
//
// States (?state=): everyday, partner, spawn, swarm, done, lens, plus
//   card    the hover card of the 3-D Secure review, held open
//   beads   messages run along the lines, one family after another
//   lit     the lens, with the 3-D Secure family lit across its groups
//   knot    the Result types family's knot, opened
(function () {
  "use strict";

  var api;
  var W;
  var CAP = 5; // families shown per project before its "more" row

  // What the person did that the list remembers while the page is open.
  var ui = {
    lens: "project", // "project" or "status"
    openKnots: {}, // lead id -> true while its knot is open
    shelfOpen: false,
    lit: null, // the lead id of the family lit by hover
    held: {}, // lead id -> partners waiting for the pointer to leave the list
    cardFor: null,
  };

  /* ------------------------------------------------------------------ small helpers */

  function esc(s) {
    return api.escapeHtml(s);
  }

  /** Returns a thread's signature hue name, the one its face wears. */
  function findHue(t) {
    return Crew.lookFor(t.title).hue;
  }

  /** Returns the inline style that gives an element a family's hue. */
  function styleHue(lead) {
    return ' style="--hue:var(--hue-' + findHue(lead) + ')"';
  }

  /** Returns whether a partner has nothing going on, so it can fold into its family's knot. */
  function isQuiet(t, openId) {
    return (t.pose === "idle" || t.pose === "asleep" || t.pose === "away") && t.id !== openId;
  }

  /** Returns the partners of a lead that are on the live list, oldest first. */
  function listLivePartners(leadId) {
    return api.listPartners(leadId).filter(function (p) { return !ui.held[leadId] || ui.held[leadId].indexOf(p.id) === -1; });
  }

  function slotHtml(t) {
    var s = api.decideSlot(t);
    return '<span class="side-end st-end--' + s.kind + '">' + s.text + "</span>";
  }

  /** Returns the agent's short name, "Codex", with its mark. */
  function agentHtml(t) {
    return '<span class="ln-agent"><span class="st-glyph">' + api.drawBrand(t, 12) + "</span>" + api.world.providers[t.provider].name + "</span>";
  }

  /** Returns a kin tag: the lead's hue as a small mark, and the lead's title. */
  function kinHtml(lead) {
    return '<span class="ln-kin" data-kin="' + lead.id + '"' + styleHue(lead) + '><i class="ln-kin-dot"></i><span class="ln-kin-name">' + esc(lead.title) + "</span></span>";
  }

  function doneButton(t, label) {
    return '<button class="ln-act" type="button" data-done="' + t.id + '" title="' + (label || "Mark done") + '">' + Crew.icon("check", 13) + "Done</button>";
  }

  /* ------------------------------------------------------------------ rows */

  /** Returns a lead's row: today's 52px row, with the Done button and the stub its family's line starts from. */
  function drawLeadRow(t, openId, family) {
    var row = api.drawThreadRow(t, { selected: t.id === openId, cls: "ln-row ln-lead" + (family ? " has-kin" : "") });
    return row.replace("</a></div>", "</a>" + doneButton(t, family ? "Mark done with its partners" : "Mark done") + "</div>");
  }

  /** Returns a partner's row: its face on the line, its role, its agent and its status. */
  function drawPartnerRow(p, openId) {
    return (
      '<div class="ln-row ln-kid' + (p.pose === "working" && p.id !== openId ? " is-receded" : "") + '" data-thread="' + p.id + '">' +
      '<a class="side-row ln-kid-row' + (p.id === openId ? " is-on" : "") + '" href="#" data-open-row="' + p.id + '">' +
      '<span class="ln-node">' + api.drawFace(p, 18) + "</span>" +
      '<span class="ln-role">' + esc(p.role) + "</span>" + agentHtml(p) +
      slotHtml(p) +
      "</a>" + doneButton(p) + "</div>"
    );
  }

  /** Returns the knot: the quiet partners of a family, folded into one short row on the line. */
  function drawKnot(lead, quiet, open) {
    if (open) {
      return (
        '<div class="ln-row ln-knot is-open" data-fold="' + lead.id + '">' +
        '<button class="side-row ln-knot-row" type="button" title="Fold the quiet partners into the line">' +
        '<span class="ln-node ln-ring"></span><span class="ln-knot-text">Fold ' + quiet.length + ' quiet</span>' +
        '<span class="side-end">' + Crew.icon("chev-ud", 12) + "</span></button></div>"
      );
    }
    var roles = quiet.map(function (q) { return q.role; });
    var newest = quiet.slice().sort(function (a, b) { return api.compareTimes(b.last, a.last); })[0];
    var label = roles.length <= 2 ? roles.join(", ") : roles.length + " partners";
    return (
      '<div class="ln-row ln-knot" data-knot="' + lead.id + '">' +
      '<button class="side-row ln-knot-row" type="button" title="Show the quiet partners">' +
      '<span class="ln-node ln-ring"></span>' +
      '<span class="ln-knot-faces">' + quiet.map(function (q) { return api.drawFace(q, 13); }).join("") + "</span>" +
      '<span class="ln-knot-text">' + esc(label) + ' <span class="ln-knot-quiet">· quiet</span></span>' +
      '<span class="side-end">' + api.formatAge(newest.last) + "</span>" +
      "</button></div>"
    );
  }

  /** Returns a family: its lead's row, the partners with something going on, then the knot. */
  function drawFamily(lead, openId) {
    var partners = listLivePartners(lead.id);
    if (!partners.length) return '<div class="ln-fam ln-fam--alone" data-fam="' + lead.id + '"' + styleHue(lead) + ">" + drawLeadRow(lead, openId, false) + "</div>";
    var current = lead.id === openId || partners.some(function (p) { return p.id === openId; });
    var open = !!ui.openKnots[lead.id];
    var quiet = partners.filter(function (p) { return isQuiet(p, openId); });
    var shownRows = open ? partners : partners.filter(function (p) { return quiet.indexOf(p) === -1; });
    return (
      '<div class="ln-fam' + (current ? " is-current" : "") + (ui.lit === lead.id ? " is-lit" : "") + '" data-fam="' + lead.id + '"' + styleHue(lead) + ">" +
      drawLeadRow(lead, openId, true) +
      shownRows.map(function (p) { return drawPartnerRow(p, openId); }).join("") +
      (quiet.length ? drawKnot(lead, quiet, open) : "") +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ the project view */

  /** Returns a project's leads in the order the list shows them, and how many it leaves for "more". */
  function pickFamilies(projectId, openId) {
    var leads = api.listLeads(projectId); // newest started first
    var rank = function (lead) {
      var crew = api.listCrew(lead.id);
      if (crew.some(function (t) { return t.pose === "waiting"; })) return 0;
      if (crew.some(function (t) { return t.pose === "working"; })) return 1;
      return 2;
    };
    var picked = leads
      .slice()
      .sort(function (a, b) { return rank(a) - rank(b) || api.compareTimes(b.last, a.last); })
      .slice(0, CAP);
    leads.forEach(function (l) {
      if (picked.indexOf(l) === -1 && api.listCrew(l.id).some(function (t) { return t.id === openId; })) picked.push(l);
    });
    return { shown: leads.filter(function (l) { return picked.indexOf(l) !== -1; }), hidden: leads.length - picked.length };
  }

  function drawProject(projectId, openId) {
    var all = api.listThreads(function (t) { return t.project === projectId; });
    if (!all.length) return "";
    var p = api.getProject(projectId);
    var need = all.filter(function (t) { return t.pose === "waiting"; }).length;
    var fam = pickFamilies(projectId, openId);
    var swarmMore = api.state === "swarm" && p ? api.world.swarm.more[p.id] : 0;
    var hiddenThreads = fam.hidden ? api.listLeads(projectId).filter(function (l) { return fam.shown.indexOf(l) === -1; }).reduce(function (n, l) { return n + api.listCrew(l.id).length; }, 0) : 0;
    var more = hiddenThreads + swarmMore;
    return (
      '<section class="side-sec ln-sec">' +
      '<h3 class="side-h side-h--proj">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj ln-noproj">No project</span>') +
      (need ? '<span class="st-need">' + need + (need === 1 ? " needs you" : " need you") + "</span>" : "") +
      '<button class="icon-btn icon-btn--sm" title="New thread">' + Crew.icon("plus", 14) + "</button></h3>" +
      fam.shown.map(function (l) { return drawFamily(l, openId); }).join("") +
      (more > 0 ? '<a class="side-row st-more" href="#">' + more + " more threads</a>" : "") +
      "</section>"
    );
  }

  /** Returns the projects in the list's order: by when their newest lead started. A partner never reorders the list. */
  function orderProjects() {
    return api.world.projects
      .map(function (p) { return p.id; })
      .filter(function (id) { return api.listLeads(id).length; })
      .sort(function (a, b) { return api.compareTimes(api.listLeads(b)[0].started, api.listLeads(a)[0].started); });
  }

  /* ------------------------------------------------------------------ Waiting on you */

  function drawWaiting(openId) {
    // A thread marked done whose Request still waits stays here, because the Request still needs you (spec 17).
    var doneWaiting = api.world.done.filter(function (d) { return d.pose === "waiting" && d.doneAt === api.world.now; });
    var waiting = api.listThreads(function (t) { return t.pose === "waiting"; }).concat(doneWaiting).sort(function (a, b) { return api.compareTimes(b.last, a.last); });
    var runs = api.world.waitingRuns;
    if (!waiting.length) return "";
    return (
      '<section class="side-sec ln-wait"><h3 class="side-h"><span>Waiting on you</span><b class="count count--you">' + (waiting.length + runs.length) + "</b></h3>" +
      waiting.slice(0, 3).map(function (t) {
        var lead = t.lead ? api.getThread(t.lead) : null;
        var name = lead ? '<span class="ln-wait-role">' + esc(t.role) + "</span>" + kinHtml(lead) : esc(t.title);
        return (
          '<a class="side-row side-row--wait' + (t.id === openId ? " is-on" : "") + '" href="#" data-open-row="' + t.id + '"' + (lead ? ' data-member="' + lead.id + '"' : "") + ">" +
          api.drawFace(t, 24, "waiting") +
          '<span class="side-text"><span class="side-name' + (lead ? " ln-wait-name" : "") + '">' + name + '</span><span class="side-ask">' + esc(t.askShort || t.ask) + "</span></span></a>"
        );
      }).join("") +
      (waiting.length > 3 ? '<a class="side-row st-more" href="#">' + (waiting.length - 3) + " more waiting on you</a>" : "") +
      '<h4 class="side-sub">From runs</h4>' +
      runs.map(function (r) {
        return '<a class="side-row side-row--wait" href="#"><span class="side-lead">' + Crew.mark("waiting") + '</span><span class="side-text"><span class="side-name">' + r.title + '</span><span class="side-ask">' + r.ask + "</span></span></a>";
      }).join("") +
      "</section>"
    );
  }

  /* ------------------------------------------------------------------ the status lens */

  var GROUPS = [
    { key: "waiting", label: "Needs you", test: function (t) { return t.pose === "waiting"; } },
    { key: "working", label: "Working", test: function (t) { return t.pose === "working"; } },
    { key: "quiet", label: "Quiet", test: function (t) { return t.pose !== "waiting" && t.pose !== "working"; } },
  ];

  /** Returns a thread's row under a lens other than projects. A partner apart from its lead carries a kin tag on its second line. */
  function drawLensRow(t, openId, withLead, groupIds) {
    if (!t.lead) {
      var family = api.listPartners(t.id).length > 0;
      var apart = api.listPartners(t.id).filter(function (p) { return !groupIds || groupIds.indexOf(p.id) === -1; });
      if (apart.length) {
        var faces = '<span class="ln-apart-kin" title="' + apart.map(function (p) { return p.role; }).join(", ") + ' in another group">' + apart.map(function (p) { return api.drawFace(p, 14); }).join("") + "</span>";
        return api
          .drawThreadRow(t, { selected: t.id === openId, cls: "ln-row ln-lead" + (withLead ? " has-kin" : "") })
          .replace('data-thread="', 'data-member="' + t.id + '"' + styleHue(t) + ' data-thread="')
          .replace("</span></span></span></a>", "</span>" + faces + "</span></span></a>");
      }
      return api.drawThreadRow(t, { selected: t.id === openId, cls: "ln-row ln-lead" + (withLead ? " has-kin" : "") }).replace('data-thread="', (family ? 'data-member="' + t.id + '"' + styleHue(t) + " " : "") + 'data-thread="');
    }
    if (withLead) return drawPartnerRow(t, openId).replace('data-thread="', 'data-member="' + t.lead + '" data-thread="');
    var lead = api.getThread(t.lead);
    return (
      '<div class="st-thread ln-row ln-apart' + (t.pose === "working" && t.id !== openId ? " is-receded" : "") + '" data-thread="' + t.id + '" data-member="' + lead.id + '"' + styleHue(lead) + ">" +
      '<a class="side-row' + (t.id === openId ? " is-on" : "") + '" href="#" data-open-row="' + t.id + '">' +
      '<span class="side-text">' +
      '<span class="st-line"><span class="side-name ln-apart-name"><span class="ln-apart-face">' + api.drawFace(t, 16) + '</span><span class="ln-role">' + esc(t.role) + "</span>" + agentHtml(t) + "</span>" + slotHtml(t) + "</span>" +
      '<span class="st-detail">' + kinHtml(lead) + "</span>" +
      "</span></a></div>"
    );
  }

  function drawLens(openId) {
    var live = api.listThreads();
    return (
      '<div class="ln-lensbar"><span>Group by</span><span class="ln-seg"><button type="button" data-lens="project" aria-pressed="false">Project</button><button type="button" data-lens="status" aria-pressed="true">Status</button></span></div>' +
      GROUPS.map(function (g) {
        var members = live.filter(g.test);
        if (!members.length) return "";
        var ids = members.map(function (t) { return t.id; });
        // Families stay together inside a group: each lead's members follow it, oldest first.
        var byLead = {};
        var order = [];
        members.forEach(function (t) {
          var key = t.lead || t.id;
          if (!byLead[key]) {
            byLead[key] = [];
            order.push(key);
          }
          byLead[key].push(t);
        });
        order.sort(function (a, b) { return api.compareTimes(api.getThread(b).started, api.getThread(a).started); });
        return (
          '<section class="side-sec ln-sec ln-group ln-group--' + g.key + '">' +
          '<h3 class="side-h ln-group-h"><span>' + g.label + '</span><b class="count' + (g.key === "waiting" ? " count--you" : "") + '">' + members.length + "</b></h3>" +
          order.map(function (key) {
            var list = byLead[key].sort(function (a, b) { return (a.lead ? 1 : 0) - (b.lead ? 1 : 0) || api.compareTimes(a.started, b.started); });
            var lead = api.getThread(key);
            var leadHere = list[0].id === key;
            if (leadHere && list.length > 1) {
              return '<div class="ln-fam' + (list.some(function (t) { return t.id === openId; }) ? " is-current" : "") + '" data-fam="' + key + '"' + styleHue(lead) + ">" + list.map(function (t) { return drawLensRow(t, openId, true, ids); }).join("") + "</div>";
            }
            return list.map(function (t) { return drawLensRow(t, openId, false, ids); }).join("");
          }).join("") +
          "</section>"
        );
      }).join("")
    );
  }

  /* ------------------------------------------------------------------ the Done shelf */

  /** Returns the shelf's families: each done lead with its done partners under it, newest first. */
  function listShelf() {
    var done = api.world.done.slice();
    var leads = done.filter(function (d) { return !d.lead; });
    return leads.map(function (l) {
      return { lead: l, partners: done.filter(function (d) { return d.lead === l.id; }) };
    });
  }

  function drawShelf(openId) {
    var fams = listShelf();
    var count = api.world.doneCount + (api.world.done.length - 7);
    var rows = "";
    if (ui.shelfOpen) {
      rows = fams.slice(0, 6).map(function (f) {
        var lead = f.lead;
        var leadRow =
          '<div class="st-thread ln-row ln-lead ln-done' + (f.partners.length ? " has-kin" : "") + '" data-thread="' + lead.id + '">' +
          '<a class="side-row' + (lead.id === openId ? " is-on" : "") + '" href="#" data-open-row="' + lead.id + '"><span class="side-text">' +
          '<span class="st-line"><span class="side-name">' + esc(lead.title) + '</span><span class="side-end">' + (lead.doneAt === api.world.now ? "now" : shortDone(lead.doneAt)) + "</span></span>" +
          '<span class="st-detail"><span class="st-glyph">' + api.drawBrand(lead, 12) + '</span><span class="st-clip">Done ' + (lead.doneAt === api.world.now ? "just now" : lead.doneAt) + (f.partners.length ? " · with " + f.partners.length + (f.partners.length === 1 ? " partner" : " partners") : "") + "</span></span>" +
          "</span></a>" +
          '<button class="ln-act ln-act--reopen" type="button" title="Reopen">' + Crew.icon("undo", 13) + "Reopen</button></div>";
        var kids = f.partners.map(function (p) {
          return (
            '<div class="ln-row ln-kid ln-done" data-thread="' + p.id + '"><a class="side-row ln-kid-row' + (p.id === openId ? " is-on" : "") + '" href="#" data-open-row="' + p.id + '">' +
            '<span class="ln-node">' + api.drawFace(p, 16, "done") + '</span><span class="ln-role">' + esc(p.role) + "</span>" + agentHtml(p) + "</a></div>"
          );
        }).join("");
        return '<div class="ln-fam ln-fam--done' + (f.partners.length ? "" : " ln-fam--alone") + (f.fresh ? " is-fresh" : "") + '" data-fam="' + lead.id + '"' + styleHue(lead) + ">" + leadRow + kids + "</div>";
      }).join("") + '<a class="side-row st-more" href="#">Show ' + (count - fams.slice(0, 6).reduce(function (n, f) { return n + 1 + f.partners.length; }, 0)) + " more</a>";
    }
    return (
      '<section class="side-sec ln-sec ln-shelf">' +
      '<h3 class="side-h ln-shelf-h"><button type="button" data-shelf aria-expanded="' + ui.shelfOpen + '">' + Crew.icon("chev-r", 12) + "<span>Done</span><b>" + count + "</b></button></h3>" +
      rows +
      "</section>"
    );
  }

  function shortDone(at) {
    if (/^yesterday/.test(at)) return "1d";
    if (/^Sun/.test(at)) return "2d";
    return api.formatAge(at);
  }

  /* ------------------------------------------------------------------ drawing and events */

  var listEl;

  function draw() {
    var openId = api.openId();
    var scroll = listEl.scrollTop;
    if (ui.lens === "status") {
      listEl.innerHTML = drawLens(openId) + drawShelf(openId);
    } else {
      listEl.innerHTML =
        drawWaiting(openId) +
        orderProjects().map(function (id) { return drawProject(id, openId); }).join("") +
        drawProject(null, openId) +
        drawShelf(openId);
    }
    listEl.scrollTop = scroll;
    Object.keys(ui.held).forEach(function (leadId) {
      var detail = listEl.querySelector('[data-thread="' + leadId + '"] .st-detail');
      if (!detail || !ui.held[leadId].length) return;
      var pip = document.createElement("span");
      pip.className = "ln-pip";
      pip.title = "A partner joined. It slides in when the pointer leaves the list.";
      pip.innerHTML = api.drawFace(api.getThread(ui.held[leadId][0]), 14) + "+" + ui.held[leadId].length;
      detail.appendChild(pip);
    });
    if (ui.fakeHover) {
      var hovered = listEl.querySelector('[data-thread="' + ui.fakeHover + '"] > .side-row');
      if (hovered) hovered.classList.add("ln-fake-hover");
    }
    api.els.side.classList.toggle("ln-lensed", ui.lens === "status");
    var lensBtn = api.els.side.querySelector(".ln-lens-btn");
    if (lensBtn) lensBtn.setAttribute("aria-pressed", String(ui.lens === "status"));
    applyLit();
  }

  function applyLit() {
    listEl.classList.toggle("has-lit", !!ui.lit);
    listEl.querySelectorAll("[data-fam],[data-member],[data-thread]").forEach(function (el) {
      var fam = el.dataset.fam || el.dataset.member || (el.dataset.thread && famOf(el.dataset.thread));
      el.classList.toggle("is-lit", !!ui.lit && fam === ui.lit);
    });
  }

  /** Returns the lead id of the family a thread belongs to, or null for a thread alone. */
  function famOf(id) {
    var t = api.getThread(id);
    if (!t) return null;
    return t.lead || (api.listPartners(t.id).length ? t.id : null);
  }

  function wire() {
    listEl.addEventListener("click", function (e) {
      var done = e.target.closest("[data-done]");
      if (done) {
        e.preventDefault();
        markDone(done.dataset.done);
        return;
      }
      var knot = e.target.closest("[data-knot]");
      if (knot) {
        ui.openKnots[knot.dataset.knot] = true;
        draw();
        return;
      }
      var fold = e.target.closest("[data-fold]");
      if (fold) {
        delete ui.openKnots[fold.dataset.fold];
        draw();
        return;
      }
      var shelf = e.target.closest("[data-shelf]");
      if (shelf) {
        ui.shelfOpen = !ui.shelfOpen;
        draw();
        return;
      }
      var lens = e.target.closest("[data-lens]");
      if (lens) {
        ui.lens = lens.dataset.lens;
        ui.lit = null;
        draw();
        return;
      }
      var row = e.target.closest("[data-open-row]");
      if (row) {
        e.preventDefault();
        api.open(row.dataset.openRow);
      }
    });

    // Hovering a family's line, its kin tag, or a lensed member lights the whole family.
    listEl.addEventListener("pointerover", function (e) {
      var kin = e.target.closest("[data-kin]");
      var fam = e.target.closest(".ln-fam:not(.ln-fam--alone):not(.ln-fam--done)");
      var member = e.target.closest("[data-member]");
      var next = kin ? kin.dataset.kin : fam ? fam.dataset.fam : member ? member.dataset.member : null;
      if (next !== ui.lit) {
        ui.lit = next;
        applyLit();
      }
      var row = e.target.closest("[data-thread]");
      scheduleCard(row ? row.dataset.thread : null, row);
    });
    listEl.addEventListener("pointerleave", function () {
      ui.lit = null;
      applyLit();
      scheduleCard(null);
      releaseHeld();
    });
    listEl.addEventListener("scroll", function () { scheduleCard(null); }, { passive: true });
  }

  /* ------------------------------------------------------------------ the hover card */

  var cardEl;
  var cardTimer;

  function scheduleCard(id, row) {
    clearTimeout(cardTimer);
    if (!id) {
      if (cardEl) cardEl.classList.remove("is-shown");
      return;
    }
    if (cardEl && cardEl.classList.contains("is-shown")) return showCard(id, row);
    cardTimer = setTimeout(function () { showCard(id, row); }, 400);
  }

  function showCard(id, row) {
    var t = api.getThread(id);
    if (!t || !row || t.doneAt || api.world.done.indexOf(t) !== -1) return;
    if (!cardEl) {
      cardEl = document.createElement("div");
      cardEl.className = "ln-card";
      api.els.app.appendChild(cardEl);
    }
    var lead = t.lead ? api.getThread(t.lead) : null;
    var partners = lead ? [] : api.listPartners(t.id);
    var brief = lead ? api.listExchanges(lead.id).filter(function (e) { return e.to === t.id && e.kind === "brief"; })[0] : null;
    var branch = api.findBranch(t);
    var p = api.getProject(t.project);
    cardEl.style.cssText = lead ? "--hue:var(--hue-" + findHue(lead) + ")" : partners.length ? "--hue:var(--hue-" + findHue(t) + ")" : "";
    cardEl.innerHTML =
      '<div class="ln-card-title">' + esc(t.title) + "</div>" +
      (lead
        ? '<div class="ln-card-kin">' + api.drawFace(lead, 16) + '<span><b>' + esc(t.role) + "</b> for " + esc(lead.title) + "</span></div>" +
          '<div class="ln-card-how">' + (t.joined === "added" ? "You added it with + at " + t.started : "Started by its lead at " + t.started) + "</div>"
        : "") +
      '<dl class="ln-card-facts">' +
      (p ? "<dt>Project</dt><dd>" + p.name + "</dd>" : "") +
      "<dt>Machine</dt><dd>" + api.findMachine(t) + "</dd>" +
      "<dt>Branch</dt><dd>" + (branch ? '<span class="mono">' + branch + "</span>" : "No checkout") + "</dd>" +
      "<dt>Model</dt><dd>" + api.drawBrand(t, 12) + " " + api.describeAgent(t) + "</dd>" +
      (partners.length ? "<dt>Partners</dt><dd>" + partners.map(function (x) { return x.role; }).join(", ") + "</dd>" : "") +
      "</dl>" +
      (brief ? '<div class="ln-card-brief"><span>Its brief, ' + brief.at + "</span>" + esc(brief.text) + "</div>" : "");
    var r = row.getBoundingClientRect();
    cardEl.style.top = Math.max(12, Math.min(window.innerHeight - 260, r.top - 4)) + "px";
    cardEl.classList.add("is-shown");
  }

  /* ------------------------------------------------------------------ the bead: a message runs along the line */

  /**
   * Returns where a member's node sits on its family's line, inside the family: { mid, half },
   * the node's centre and half its height. A lead's node is its provider mark; a quiet partner's
   * is the knot.
   */
  function findNode(famEl, id) {
    var row = famEl.querySelector('[data-thread="' + id + '"]');
    if (row && row.classList.contains("ln-lead")) return { mid: row.offsetTop + 38, half: 7 };
    if (row) return { mid: row.offsetTop + row.offsetHeight / 2, half: 9 };
    var knot = famEl.querySelector(".ln-knot");
    return knot ? { mid: knot.offsetTop + knot.offsetHeight / 2, half: 6 } : null;
  }

  /** Runs a bead along a family's line, from the thread that sent a message to the one that got it. */
  function runBead(ex) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var sender = api.getThread(ex.from);
    var lead = sender.lead ? api.getThread(sender.lead) : sender;
    var famEl = listEl.querySelector('.ln-fam[data-fam="' + lead.id + '"]');
    if (!famEl) return;
    var a = findNode(famEl, ex.from);
    var b = findNode(famEl, ex.to);
    if (!a || !b) return;
    // The bead leaves the sender's node at the edge facing the receiver, and arrives at the receiver's edge.
    var down = b.mid > a.mid ? 1 : -1;
    var y1 = a.mid + down * (a.half + 2) - 5;
    var y2 = b.mid - down * (b.half + 2) - 5 - down * 6;
    var bead = document.createElement("i");
    bead.className = "ln-bead";
    famEl.appendChild(bead);
    var dist = Math.abs(y2 - y1);
    var anim = bead.animate(
      [
        { transform: "translateY(" + y1 + "px) scaleY(.2)", opacity: 0 },
        { transform: "translateY(" + y1 + "px) scaleY(1)", opacity: 1, offset: 0.15 },
        { transform: "translateY(" + y2 + "px) scaleY(1)", opacity: 1, offset: 0.85 },
        { transform: "translateY(" + y2 + "px) scaleY(.2)", opacity: 0 },
      ],
      { duration: 900 + dist * 8, easing: "cubic-bezier(.45,0,.25,1)" },
    );
    anim.onfinish = function () {
      bead.remove();
      var target = famEl.querySelector('[data-thread="' + ex.to + '"] .ln-node, [data-thread="' + ex.to + '"] .st-glyph');
      if (target) target.animate([{ transform: "scale(1)" }, { transform: "scale(1.25)" }, { transform: "scale(1)" }], { duration: 360, easing: "cubic-bezier(.34,1.5,.64,1)" });
    };
  }

  /** Returns whether a family's line is in the list's visible part. */
  function isVisible(leadId) {
    var famEl = listEl.querySelector('.ln-fam[data-fam="' + leadId + '"]');
    if (!famEl || famEl.classList.contains("ln-fam--alone")) return false;
    var r = famEl.getBoundingClientRect();
    var l = listEl.getBoundingClientRect();
    return r.top >= l.top - 4 && r.bottom <= l.bottom + 4;
  }

  /** Returns the newest exchange of a family that is in view, so the demo bead runs where you can see it. */
  function pickVisibleExchanges() {
    return api.world.exchanges.filter(function (ex) {
      var s = api.getThread(ex.from);
      return s && isVisible(s.lead || s.id);
    });
  }

  /* ------------------------------------------------------------------ finishing a family */

  function markDone(id) {
    var t = api.getThread(id);
    var ids = [id].concat(t.lead ? [] : api.listPartners(id).map(function (p) { return p.id; }));
    var famEl = listEl.querySelector('.ln-fam[data-fam="' + (t.lead ? t.lead : id) + '"]');
    var rows = t.lead ? [listEl.querySelector('.ln-kid[data-thread="' + id + '"]')] : famEl ? [famEl] : [];
    var leave = function () {
      var moved = api.markDone(ids);
      // The shelf keeps the family together: the lead first, its partners under it.
      var shelfEntries = moved.map(function (m) {
        return Object.assign({}, m, { doneAt: api.world.now, lead: t.lead ? null : m.lead });
      });
      if (t.lead) shelfEntries[0].lead = null;
      api.world.done.unshift.apply(api.world.done, shelfEntries);
      ui.shelfOpen = true;
      draw();
      api.drawMain();
      var fresh = listEl.querySelector('.ln-fam--done[data-fam="' + id + '"]');
      var n = ids.length - 1;
      api.showToast(n ? "Marked done with " + n + (n === 1 ? " partner" : " partners") : "Marked done", "Undo", function () {
        api.world.done.splice(0, shelfEntries.length);
        api.restoreThreads(moved);
        draw();
      });
      placeToast();
      // Bring the shelf's new family into view, clear of the toast.
      if (fresh) {
        fresh.classList.add("is-fresh");
        var toast = api.els.side.querySelector(".stage-toast");
        var limit = toast ? toast.getBoundingClientRect().top - 10 : listEl.getBoundingClientRect().bottom;
        var over = fresh.getBoundingClientRect().bottom - limit;
        if (over > 0) listEl.scrollTo({ top: listEl.scrollTop + over, behavior: "smooth" });
      }
    };
    if (!rows.length || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return leave();
    // Common fate: the family leaves as one.
    rows.forEach(function (el) {
      el.style.height = el.offsetHeight + "px";
      el.style.overflow = "hidden";
      el.animate([{ height: el.offsetHeight + "px", opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
    });
    setTimeout(leave, 330);
  }

  /**
   * Sets the 3-D Secure work up for the done state: Rogier allowed the push, the review reported
   * back, and the lead opened its pull request, so nothing of the family waits any more. A done
   * thread whose Request still waits would stay in Waiting on you (spec 17).
   */
  function settleForDone() {
    var lead = api.getThread("t3ds");
    var review = api.getThread("t3dsReview");
    lead.pose = "idle";
    lead.status = null;
    lead.last = "09:40";
    review.pose = "idle";
    review.status = null;
    review.last = "09:39";
    var tx = api.world.transcripts.t3ds.filter(function (it) { return !it.waiting; });
    tx.push({ from: "t3dsReview", at: "09:39", text: "Second pass done. The processing status now waits for the webhook instead of failing. No more findings." });
    tx.push({ worked: "Worked for 58s", tools: ["ran git push -u origin fix/3ds-eu-cards", "opened a pull request"] });
    tx.push({ agent: true, at: "09:40", html: "Pushed <code>fix/3ds-eu-cards</code> and opened pull request #1290, with both findings fixed and covered by tests." });
    api.world.transcripts.t3ds = tx;
  }

  /** Sits the stage's toast at the bottom of the thread list, just above the pinned assistants. */
  function placeToast() {
    var toast = api.els.side.querySelector(".stage-toast");
    if (!toast) return;
    toast.style.bottom = "auto";
    toast.style.top = api.els.assistants.offsetTop - toast.offsetHeight - 8 + "px";
  }

  /* ------------------------------------------------------------------ a partner joins */

  /** Adds the spawn state's partner. While the pointer is in the list it waits as a pip on its lead. */
  function joinPartner(pointerInList) {
    var p = api.spawnPartner();
    if (pointerInList) {
      ui.held[p.lead] = [p.id];
      draw();
      var pip = listEl.querySelector(".ln-pip");
      if (pip) pip.animate([{ transform: "scale(.3)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 360, easing: "cubic-bezier(.34,1.5,.64,1)" });
    } else {
      slideIn(p);
    }
    api.drawMain();
    announceInTranscript(p);
  }

  function releaseHeld() {
    Object.keys(ui.held).forEach(function (leadId) {
      var ids = ui.held[leadId];
      delete ui.held[leadId];
      ids.forEach(function (id) { slideIn(api.getThread(id)); });
    });
  }

  /** Draws the list with a new partner and grows its row out of its lead's line. */
  function slideIn(p) {
    draw();
    var row = listEl.querySelector('.ln-kid[data-thread="' + p.id + '"]');
    var famEl = row && row.closest(".ln-fam");
    if (!row || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    famEl.classList.add("is-growing");
    var h = row.offsetHeight;
    row.animate([{ height: "0px", opacity: 0 }, { height: h + "px", opacity: 1 }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
    var face = row.querySelector(".ln-node");
    face.animate([{ transform: "scale(0)" }, { transform: "scale(0)", offset: 0.4 }, { transform: "scale(1)" }], { duration: 560, easing: "cubic-bezier(.34,1.5,.64,1)" });
    setTimeout(function () {
      famEl.classList.remove("is-growing");
      var ex = api.world.spawn.exchange;
      runBead(ex);
    }, 420);
  }

  /** Adds the lead's message to its new partner to the open transcript, as the stage's exchange card draws it. */
  function announceInTranscript(p) {
    var open = api.getThread(api.openId());
    if (open.id !== p.lead) return;
    var live = api.els.main.querySelector(".stage-live");
    var ex = api.world.spawn.exchange;
    var card = document.createElement("div");
    card.className = "stage-x stage-x--out ln-new-x";
    card.innerHTML =
      '<div class="stage-x-head"><span class="stage-x-dir">Sent to</span>' + api.drawFace(p, 18) + '<a href="#" class="stage-x-name">' + esc(p.title) + '</a><span class="stage-x-role">' + esc(p.role) + '</span><span class="stage-x-at">' + ex.at + "</span></div>" +
      '<p class="stage-x-text">' + esc(ex.text) + "</p>";
    if (live) live.parentNode.insertBefore(card, live);
    var tx = api.els.main.querySelector("[data-transcript]");
    if (tx) tx.scrollTop = tx.scrollHeight;
  }

  /** Moves a drawn pointer over the list, so the spawn state can show the calm rule without a real pointer. */
  function drawPointer() {
    var ptr = document.createElement("div");
    ptr.className = "ln-pointer";
    ptr.innerHTML = '<svg viewBox="0 0 16 24" width="17" height="25"><path d="M1.5 1.5v18.2l4.6-4.4 3 6.9 3-1.3-3-6.8h6.3z" fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    api.els.app.appendChild(ptr);
    return ptr;
  }

  /* ------------------------------------------------------------------ the header: the family's tabs */

  /** Returns the header for a thread: its family as tabs, the lead by its title and each partner by its role. */
  function drawHeader(t) {
    var live = api.listThreads().some(function (x) { return x.id === t.id; });
    var lead = live ? api.findLead(t) : t.lead ? api.getThread(t.lead) : t;
    var crew = live
      ? api.listCrew(lead.id)
      : [lead].concat(api.world.done.filter(function (d) { return d.lead === lead.id; }));
    var p = api.getProject(t.project);
    function mark(x) {
      return x.doneAt ? Crew.mark("done") : x.pose === "waiting" ? Crew.mark("waiting") : x.pose === "working" ? Crew.mark("working") : Crew.mark("idle");
    }
    var tabs = crew.map(function (x, i) {
      var label = i === 0 ? esc(x.title) : esc(x.role) + '<span class="ln-tab-agent">' + api.world.providers[x.provider].name + "</span>";
      var age = x.pose === "idle" ? "<small>" + api.formatAge(x.last) + "</small>" : "";
      return '<a class="ptab' + (x.id === t.id ? " is-on" : "") + (i ? " ln-tab-kid" : "") + '" href="#" data-open="' + x.id + '">' + mark(x) + label + age + "</a>";
    }).join("");
    return (
      '<header class="top">' +
      '<nav class="pill ln-tabs" aria-label="This family"' + (crew.length > 1 ? styleHue(lead) : "") + ">" +
      '<span class="pill-crumb">' + (p ? '<span class="proj proj--' + p.tint + '">' + p.name + "</span>" : '<span class="proj">No project</span>') + "</span>" +
      '<span class="ln-tabset' + (crew.length > 1 ? " has-kin" : "") + '">' + tabs + "</span>" +
      '<button class="icon-btn" title="Add a partner to ' + esc(lead.title) + '">' + Crew.icon("plus") + "</button>" +
      "</nav>" +
      '<span class="spacer"></span>' +
      '<span class="pill"><button class="icon-btn" title="Side pane">' + Crew.icon("sidebar") + "</button></span>" +
      '<span class="pill"><button class="icon-btn" title="Open in editor">' + Crew.icon("editor") + "</button></span>" +
      '<span class="pill"><button class="icon-btn" title="More">' + Crew.icon("more") + "</button></span>" +
      "</header>"
    );
  }

  /**
   * Scrolls the list so a row is in view with a section's heading at the top: the row's own
   * section when the list can scroll that far, else the last heading that still keeps the row in view.
   */
  function scrollToSection(row) {
    var base = listEl.getBoundingClientRect().top - listEl.scrollTop;
    var max = listEl.scrollHeight - listEl.clientHeight;
    var rowTop = row.getBoundingClientRect().top - base;
    var rowBottom = rowTop + row.offsetHeight;
    var best = 0;
    listEl.querySelectorAll(".side-sec").forEach(function (sec) {
      var top = sec.getBoundingClientRect().top - base;
      if (top <= max && top <= rowTop && rowBottom <= top + listEl.clientHeight) best = Math.max(best, top);
    });
    listEl.scrollTop = best;
  }

  /* ------------------------------------------------------------------ the direction */

  Stage.direction({
    rootClass: "d-lineage",
    initial: function (state) {
      if (state === "partner" || state === "card") return "t3dsReview";
      if (state === "spawn") return "tSecrets";
      if (state === "knot") return "tResult";
      if (state === "swarm") return "sApple";
      return "t3ds";
    },
    drawList: function (el, a) {
      api = a;
      W = a.world;
      listEl = el;
      if (a.state === "lens" || a.state === "lit") ui.lens = "status";
      if (a.state === "lit") ui.lit = "t3ds";
      if (a.state === "knot") ui.openKnots.tResult = true;
      if (a.state === "done") settleForDone();
      var actions = a.els.side.querySelector(".side-actions");
      var lensBtn = document.createElement("button");
      lensBtn.className = "icon-btn ln-lens-btn";
      lensBtn.title = "Group and sort";
      lensBtn.innerHTML = Crew.icon("filter");
      lensBtn.addEventListener("click", function () {
        ui.lens = ui.lens === "status" ? "project" : "status";
        ui.lit = null;
        draw();
      });
      actions.insertBefore(lensBtn, actions.querySelector(".icon-btn"));
      wire();
      draw();
    },
    drawHeader: function (t) {
      return drawHeader(t);
    },
    onOpen: function () {
      if (!listEl) return;
      draw();
    },
    boot: function (a) {
      var openRow = listEl.querySelector('[data-thread="' + a.openId() + '"]');
      var keepVisible = { partner: 1, card: 1, knot: 1 };
      if (openRow && keepVisible[a.state]) {
        scrollToSection(openRow);
      }
      if (a.state === "lit") {
        // Keep the whole lit family in view: from its lead down to its quietest partner.
        var litRow = listEl.querySelector('[data-thread="t3ds"]');
        var lastLit = listEl.querySelector('[data-thread="tStripe"]');
        var listTop = listEl.getBoundingClientRect().top;
        if (litRow && lastLit && lastLit.getBoundingClientRect().bottom - listTop > listEl.clientHeight) {
          listEl.scrollTop = litRow.getBoundingClientRect().top - listTop - 40;
        }
      }
      if (a.state === "spawn") {
        var lead = listEl.querySelector('.ln-fam[data-fam="tSecrets"]');
        if (lead) scrollToSection(lead);
        var ptr = drawPointer();
        var target = listEl.querySelector('[data-thread="tDash"] .side-row');
        var r = target ? target.getBoundingClientRect() : { left: 120, top: 400, width: 0, height: 0 };
        ptr.style.transform = "translate(" + (r.left + 150) + "px," + (r.top + 22) + "px)";
        ptr.classList.add("is-shown");
        ui.fakeHover = "tDash";
        if (target) target.classList.add("ln-fake-hover");
        setTimeout(function () { joinPartner(true); }, 1000);
        setTimeout(function () {
          ui.fakeHover = null;
          listEl.querySelectorAll(".ln-fake-hover").forEach(function (el) { el.classList.remove("ln-fake-hover"); });
          ptr.classList.add("is-moving");
          ptr.style.transform = "translate(760px, 360px)";
        }, 2600);
        setTimeout(releaseHeld, 3300);
      }
      if (a.state === "done") {
        setTimeout(function () { markDone("t3ds"); }, 1000);
      }
      if (a.state === "everyday" || a.state === "beads") {
        var queue = [];
        var step = function () {
          if (!queue.length) queue = pickVisibleExchanges().slice().reverse();
          var ex = queue.shift();
          if (ex) runBead(ex);
        };
        setTimeout(step, 900);
        if (a.state === "beads") setInterval(step, 1700);
      }
      if (a.state === "card") {
        setTimeout(function () {
          var row = listEl.querySelector('[data-thread="t3dsReview"]');
          ui.lit = "t3ds";
          applyLit();
          showCard("t3dsReview", row);
        }, 300);
      }
    },
  });
})();
