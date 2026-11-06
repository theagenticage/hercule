'use strict'; // Keeps this file's functions out of global scope, where a function named render would replace the shell's.
// One surface: a single map of all the work, and two independent controls over it.
//
// Clicking a branch opens or closes it, as in a mind map. Zooming moves the camera. Neither one moves anything on the map:
// every piece owns a card slot from the start, so the room for a branch's leaves is already kept beside it. A leaf is that
// card, drawn in its slot with only its name. Opening a branch reveals its leaves, and zooming in shows every card. A card
// swaps between a few faces as it grows, so its text stays readable at every distance.
//
// What decides a slot is the work itself, and a slot changes only on purpose:
// - Strong links are structure. Pieces joined by blockedBy links form a DAG, and the whole DAG lives in one lane as another
//   level of the hierarchy, blockers nearest the trunk.
// - Everything else in a lane is ordered by stage, in compact runs, so a change of stage moves a card within its lane.
// - Arrange by decides whether a project's branches are Topics and initiatives, or Zones.
// Outward from the trunk always means later, for levels of a DAG and for stages alike.
//
// Weak links are the only lines that cross the map. They are drawn over it and never touch it.
{
  // World units. At zoom 1 one unit is one screen pixel.
  const CARD_W = 600, CARD_H = 160, ROW_GAP = 18, ROW_H = CARD_H + ROW_GAP, LANE_GAP = 44, PROJECT_GAP = 120;
  // Cards in a row sit this far apart, which leaves room for a short real branch between the levels of a DAG. Every row uses it, so the columns of a lane line up.
  const COL_GAP = 84, COL_W = CARD_W + COL_GAP;
  // How many cards wide a board is. The right side holds the most work, so it gets the wider boards.
  const ACROSS_RIGHT = 3, ACROSS_LEFT = 2;
  // Distances out from the centre: the end of a trunk's curve, its gate where the lanes fork off, where a lane's name starts, and where its cards start.
  const HUB_RX = 230, HUB_RY = 124, RUN_X = 470, GATE_X = 1080, LABEL_X = 1290, CARDS_X = 1975, FORK = 130;
  // Each project's direction in degrees, clockwise from east. Direction is memory, so it never depends on the data.
  const DIRECTIONS = {storefront:-40, platform:-140, ops:177, 'field-app':136, Insights:44};
  const MOVE_WORDS = {you:'your move', agent:"an agent's move", others:"others' move", nobody:'nobody on it'};
  // The zoom where each card face starts. Below the first, a card is a leaf: just its name.
  const CLOSE_ZOOM = .7, FACES = [['title', .285], ['card', .38], ['close', CLOSE_ZOOM]];
  const MAX_ZOOM = 1.25, BOARD_ZOOM = .46, LANE_ZOOM = .62, CARD_ZOOM = 1.1;
  const VIEW_TOP = 62, VIEW_BOTTOM = 56, VIEW_SIDE = 22, MINI_W = 164;
  // How much of the window's bottom the chain strip takes.
  const STRIP_ROOM = 152;
  // Two cards further apart than this, in world units, are joined by a long sweep instead of a short curve.
  const SWEEP_SPAN = 3 * COL_W;

  let api, root, ground, sheet, labelLayer, crumbsEl, miniEl, miniView, world, labels = [], lines = [], linesZoom = 0, open = new Set();
  let cam = null, fitted = true, zooms = {boardFrom:.15, boardTo:.2, min:.08};
  let press = null, dragged = false, clickTimer = 0, frame = 0, wheelGoal = null, place = [], shownPlace = '', returnHome = false;
  // relations and chains are read on every render. routes holds the lines on screen by key, slotEls the slot of each piece, and shownSlots where each card was last drawn, so that a card that changes place can glide there.
  // followed is the chain being followed, lit the Topic or initiative lit up. arrange is 'topic' or 'zone'.
  let relations = [], chains = [], lights = [], routes = new Map(), routeLayer, slotEls = new Map(), shownSlots = new Map(), shownShape = '';
  let showWeak = false, hovered = null, hoverTimer = 0, followed = null, lit = null, arrange = 'topic', lastSelected = null;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const contains = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const growRect = (r, by) => ({x:r.x - by, y:r.y - by, w:r.w + 2 * by, h:r.h + 2 * by});
  const round = n => Math.round(n);

  /** Returns the one muted line of a card: who asked for a review, else what is left, else what the piece is. */
  function pickMutedLine(w) {
    const asker = w.where.match(/requested by (\S+)/);
    if (asker) return `Asked by ${asker[1]}`;
    if (w.left && !/^(everything|nothing|a review)$/i.test(w.left.trim())) return w.left;
    const what = w.what.replace(/\.$/, '');
    return what === w.name ? 'Not started' : what;
  }

  /** Returns the lane a piece belongs to by itself. Under Topic that is its initiative, else its Topic. Under Zone, initiatives are not branches, so it is always its Zone. A piece taken out of its initiative may have no Topic yet. */
  function readOwnLane(w, inits) {
    const init = inits.find(i => i.id === w.initiative), project = init?.project ?? w.project;
    if (arrange === 'zone') return {key:`z:${project}:${w.zone}`, name:w.zone, project};
    if (init) return {key:`i:${init.id}`, name:init.name, project, init};
    const name = w.topic || 'No topic';
    return {key:`t:${project}:${name}`, name, project};
  }

  /** Sends every piece to its lane. A whole DAG goes to the lane of the blocker at its root, and a piece that came from elsewhere keeps its origin, to show on its card. */
  function assignLanes(all, inits) {
    for (const w of all) w.lane = readOwnLane(w, inits);
    for (const chain of chains) {
      const home = chain.ranks[0][0].lane;
      for (const w of chain.ranks.flat()) {
        if (w.lane.key !== home.key) w.origin = w.lane.project === home.project ? w.lane.name : `${w.lane.project} · ${w.lane.name}`;
        w.lane = home; w.inDag = true;
        w.isSample = relations.some(r => r.sample && r.from === w.id);
      }
    }
  }

  /** Gathers a project's lanes: initiatives first, then the rest in the order of their names, because that order cannot change when work comes and goes. */
  function buildLanes(project, all, inits) {
    const lanes = new Map();
    for (const w of all.filter(w => w.lane.project === project)) {
      if (!lanes.has(w.lane.key)) lanes.set(w.lane.key, {...w.lane, pieces:[], links:[]});
      lanes.get(w.lane.key).pieces.push(w);
    }
    const rankInit = l => l.init ? inits.findIndex(i => i.id === l.init.id) : inits.length;
    return [...lanes.values()].sort((a, b) => rankInit(a) - rankInit(b) || a.name.localeCompare(b.name));
  }

  /**
   * Places a DAG in the cells of its lane as a tree, from a first row, and returns the next free row. A piece's column is its
   * level, so blockers sit nearest the trunk. A piece with several blockers hangs under one at the level just before it, and
   * gets a second link to the others, so that it still appears once.
   */
  function placeDag(chain, lane, firstRow) {
    const pieces = chain.ranks.flat(), levels = new Map(chain.ranks.flatMap((rank, level) => rank.map(w => [w.id, level])));
    const blockersOf = w => relations.filter(r => r.kind === 'blockedBy' && r.from === w.id).map(r => pieces.find(x => x.id === r.to));
    const parents = new Map(pieces.map(w => [w.id, blockersOf(w).find(b => levels.get(b.id) === levels.get(w.id) - 1)]));
    let row = firstRow;
    const placeUnder = w => {
      w.cell = {col:levels.get(w.id), row};
      const kids = pieces.filter(x => parents.get(x.id) === w);
      kids.forEach(placeUnder);
      if (!kids.length) row++;
    };
    pieces.filter(w => !parents.get(w.id)).forEach(placeUnder);
    for (const w of pieces) for (const b of blockersOf(w)) lane.links.push({from:b, to:w, isSecond:parents.get(w.id) !== b});
    return row;
  }

  /** Fills a lane's cells: its DAGs first, then the rest in stage order, wrapped at the board's width, so a run of one stage takes only the room it needs. starts lists the rows that reach back to the branch. */
  function arrangeLane(lane, across) {
    let row = 0;
    lane.starts = [];
    for (const chain of chains.filter(c => c.ranks[0][0].lane.key === lane.key)) { lane.starts.push(row); row = placeDag(chain, lane, row); }
    const flat = lane.pieces.filter(w => !w.inDag);
    let stage = null;
    flat.forEach((w, n) => {
      w.cell = {col:n % across, row:row + Math.floor(n / across)};
      if (n % across === 0) lane.starts.push(w.cell.row);
      if (!w.gone && w.stage !== stage) { w.isRunStart = true; stage = w.stage; }
    });
    lane.rows = row + Math.ceil(flat.length / across);
    lane.cols = Math.max(...lane.pieces.map(w => w.cell.col)) + 1;
  }

  /** Builds one project's board: its lanes stacked, each a block of cards. A DAG deeper than the board is wide widens the board. Everything but the sizes is placed later. */
  function buildBoard(project, all, inits) {
    const angle = DIRECTIONS[project] * Math.PI / 180, side = Math.cos(angle) >= 0 ? 1 : -1, across = side > 0 ? ACROSS_RIGHT : ACROSS_LEFT;
    const lanes = buildLanes(project, all, inits);
    let y = 0, cols = across;
    for (const lane of lanes) {
      arrangeLane(lane, across);
      lane.y = y; lane.h = lane.rows * ROW_H - ROW_GAP;
      y += lane.h + LANE_GAP;
      cols = Math.max(cols, lane.cols);
    }
    return {key:`p:${project}`, name:project, lanes, cols, angle, side, x:0, y:0, w:cols * COL_W - COL_GAP, h:y - LANE_GAP};
  }

  /** Places the boards on each side of the centre. Boards start on their fixed direction and are pushed apart only as far as they need. */
  function placeBoards(boards) {
    for (const side of [1, -1]) {
      const list = boards.filter(b => b.side === side).sort((a, b) => Math.sin(a.angle) - Math.sin(b.angle));
      for (const b of list) b.middle = Math.tan(b.angle) * side * GATE_X;
      for (let pass = 0; pass < 40; pass++) {
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1], b = list[i], overlap = a.middle + a.h / 2 + PROJECT_GAP - (b.middle - b.h / 2);
          if (overlap > 0) { a.middle -= overlap / 2; b.middle += overlap / 2; }
        }
      }
      // The whole side sits centred on the hub, so a fit uses all the height of the window.
      const middle = (list[0].middle - list[0].h / 2 + list.at(-1).middle + list.at(-1).h / 2) / 2;
      for (const b of list) { b.y = b.middle - middle - b.h / 2; b.x = side > 0 ? CARDS_X : -CARDS_X - b.w; }
    }
  }

  /** Moves every lane into world coordinates and gives each piece its slot. Columns count outward from the trunk on both sides of the map. */
  function placeLanes(board) {
    const {side, cols} = board, labelGap = CARDS_X - LABEL_X;
    board.area = {x:side > 0 ? LABEL_X : board.x, y:board.y, w:board.w + labelGap, h:board.h};
    for (const lane of board.lanes) {
      lane.y += board.y;
      lane.area = {x:board.area.x, y:lane.y, w:board.area.w, h:lane.h};
      lane.lineY = lane.y + CARD_H / 2; lane.startX = side * LABEL_X; lane.edgeX = side * CARDS_X;
      for (const w of lane.pieces) {
        const {col, row} = w.cell;
        // out is the side of the board this card is nearest, which is the side a weak line bulges to.
        w.slot = {x:side > 0 ? CARDS_X + col * COL_W : -CARDS_X - CARD_W - col * COL_W, y:lane.y + row * ROW_H, w:CARD_W, h:CARD_H, out:col * 2 + 1 > cols ? side : -side};
      }
    }
  }

  /** Samples a cubic curve. */
  function sampleCurve(a, b, c, d, count) {
    const out = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count, u = 1 - t;
      out.push([u ** 3 * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t ** 3 * d[0], u ** 3 * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t ** 3 * d[1]]);
    }
    return out;
  }

  /** Returns the widths of a line that narrows evenly along its points. Widths are in screen pixels, so a line stays fine at every zoom. */
  const taper = (points, from, to) => points.map((_, i) => lerp(from, to, i / (points.length - 1)));

  /** Shapes a project's trunk: out of the centre in its fixed direction, curving to its name, then running under the name to the gate. */
  function shapeTrunk(board) {
    const {angle, side} = board, gateY = board.y + board.h / 2, gateX = side * GATE_X, runX = side * RUN_X;
    const start = [Math.cos(angle) * (HUB_RX - 24), Math.sin(angle) * (HUB_RY - 14)];
    const across = Math.abs(runX - start[0]), reach = Math.hypot(across, gateY - start[1]) * .34;
    // A trunk with far to go drops straight out of the hub and turns late, so that it never runs alongside its neighbour.
    const far = clamp(Math.abs(gateY) / 1700, 0, 1) ** 2;
    const curve = sampleCurve(start, [start[0] + Math.cos(angle) * reach * (1 - far), start[1] + Math.sin(angle) * reach], [runX - side * across * lerp(.7, 1, far), gateY], [runX, gateY], 30);
    const points = [...curve, [gateX, gateY]], count = board.lanes.reduce((n, l) => n + l.pieces.length, 0);
    board.gate = [gateX, gateY];
    return {points, widths:taper(points, 3.4 + .34 * Math.sqrt(count), 1.7)};
  }

  /** Shapes the curve out of a project's gate to where its lane's name starts, and on under the name to the lane's first card. */
  function shapeFan(board, lane) {
    const {gate} = board, dx = lane.startX - gate[0];
    const curve = sampleCurve(gate, [gate[0] + dx * .62, gate[1]], [lane.startX - dx * .62, lane.lineY], [lane.startX, lane.lineY], 22);
    const points = [...curve, [lane.edgeX, lane.lineY]];
    return {points, widths:taper(points, 1.6, .85)};
  }

  /** Shapes the fine line that runs on from a closed branch. It starts at x and y, and fades out over a length. */
  function shapeTail(x, y, length, from) {
    const points = Array.from({length:7}, (_, i) => [x + length * i / 6, y]);
    return {points, widths:taper(points, from, .15)};
  }

  /** Shapes the twigs of an open lane: one from the fork to each row after the first that reaches back to the branch. The other rows of a DAG hang from the DAG itself. */
  function shapeTwigs(board, lane) {
    const forkX = lane.edgeX - board.side * FORK;
    return lane.starts.slice(1).map(row => {
      const y = lane.lineY + row * ROW_H, points = sampleCurve([forkX, lane.lineY], [forkX + board.side * FORK * .7, lane.lineY], [lane.edgeX - board.side * FORK * .7, y], [lane.edgeX, y], 16);
      return {points, widths:taper(points, .85, .6)};
    });
  }

  /** Shapes the short branch of a DAG, from the outer edge of a blocker to the inner edge of the piece it holds up. A second link is finer, because the piece does not hang from it. */
  function shapeLink(board, {from, to, isSecond}) {
    const {side} = board, edgeOf = (s, dir) => s.x + s.w / 2 + dir * s.w / 2, y = s => s.y + s.h / 2;
    const start = [edgeOf(from.slot, side), y(from.slot)], end = [edgeOf(to.slot, -side), y(to.slot)], reach = (end[0] - start[0]) * .62;
    const points = sampleCurve(start, [start[0] + reach, start[1]], [end[0] - reach, end[1]], end, 18);
    return {points, widths:taper(points, isSecond ? .9 : 1.9, isSecond ? .7 : 1.4)};
  }

  /** Returns the outline of a ribbon along points, with a width at each point, so a line tapers like a brush stroke. */
  function drawRibbon(points, widths) {
    const left = [], right = [], last = points.length - 1;
    points.forEach((p, i) => {
      const a = points[Math.max(i - 1, 0)], b = points[Math.min(i + 1, last)];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, half = widths[i] / 2;
      left.push(`${(p[0] - dy / len * half).toFixed(1)} ${(p[1] + dx / len * half).toFixed(1)}`);
      right.unshift(`${(p[0] + dy / len * half).toFixed(1)} ${(p[1] - dx / len * half).toFixed(1)}`);
    });
    return `M${left.join('L')}L${right.join('L')}Z`;
  }

  /** Returns a slightly uneven oval, as if drawn by hand. */
  function drawHub() {
    const count = 48, points = [];
    for (let i = 0; i < count; i++) {
      const t = i / count * 2 * Math.PI, wave = 1 + .03 * Math.sin(2 * t + 1) + .016 * Math.sin(3 * t + 2.4);
      points.push(`${round(Math.cos(t) * HUB_RX * wave)} ${round(Math.sin(t) * HUB_RY * wave)}`);
    }
    return `M${points.join('L')}Z`;
  }

  /** Builds the whole map. It walks every piece ever seen, so a finished piece leaves a hole instead of moving its neighbours, and it reads the relationships first, because strong links decide where pieces go. Lanes read in stage order, oldest first within a stage. */
  function buildWorld() {
    const live = new Map(api.pieces().map(w => [w.id, w])), inits = api.initiatives(), stageIds = api.stages.map(s => s[0]);
    const rankStage = w => stageIds.indexOf(w.stage);
    const all = WORK.map(w => live.get(w.id) ?? {...w, gone:true}).sort((a, b) => rankStage(a) - rankStage(b) || (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
    const pieces = new Map(all.map(w => [w.id, w]));
    relations = api.relations().filter(r => live.has(r.from) && live.has(r.to));
    chains = findChains(pieces);
    assignLanes(all, inits);
    const boards = Object.keys(DIRECTIONS).map(p => buildBoard(p, all, inits));
    placeBoards(boards);
    for (const b of boards) {
      placeLanes(b);
      b.count = b.lanes.flatMap(l => l.pieces).filter(w => !w.gone).length; b.trunk = shapeTrunk(b);
      b.tail = shapeTail(b.gate[0], b.gate[1], b.side * (LABEL_X - GATE_X + 240), 1.7);
      for (const lane of b.lanes) {
        lane.empty = lane.pieces.every(w => w.gone);
        // A closed lane's tail is as long as the work it holds, up to most of its board.
        lane.tail = shapeTail(lane.edgeX, lane.lineY, b.side * (240 + b.w * .6 * Math.min(1, lane.pieces.length / 12)), .85);
        lane.fan = shapeFan(b, lane); lane.twigs = shapeTwigs(b, lane);
      }
    }
    const left = Math.min(...boards.map(b => b.x)), right = Math.max(...boards.map(b => b.x + b.w));
    const top = Math.min(...boards.map(b => b.y)), bottom = Math.max(...boards.map(b => b.y + b.h));
    const reach = Math.max(-top, bottom);
    return {boards, pieces, x:left, y:top, w:right - left, h:bottom - top, whole:{x:left, y:-reach, w:right - left, h:2 * reach}};
  }

  const viewSize = () => ({w:root.clientWidth, h:root.clientHeight});
  const toWorld = (px, py) => ({x:(px - cam.x) / cam.k, y:(py - cam.y) / cam.k});

  /** Returns the camera that shows a rectangle in the free part of the view, no closer than limit. bottom and right are how much of the window to leave free on those sides. */
  function frameRect(r, limit, bottom = VIEW_BOTTOM, right = VIEW_SIDE) {
    const {w, h} = viewSize(), fw = w - VIEW_SIDE - right, fh = h - VIEW_TOP - bottom;
    const k = Math.min(fw / r.w, fh / r.h, limit);
    return {k, x:VIEW_SIDE + fw / 2 - (r.x + r.w / 2) * k, y:VIEW_TOP + fh / 2 - (r.y + r.h / 2) * k};
  }

  /** Sets the zooms where every card fades in. By the zoom that frames the largest board, every card is fully there. */
  function setZoomLevels() {
    const fit = frameRect(world.whole, 9).k, boardTo = Math.max(fit * 1.12, Math.min(fit * 1.3, ...world.boards.map(b => frameRect(b.area, BOARD_ZOOM).k)));
    zooms = {boardFrom:lerp(fit, boardTo, .25), boardTo, min:fit * .92};
    // A lane's name fills the room left of its cards at a fit, so a small window gets a slightly smaller name instead of an extra line.
    root.style.setProperty('--label-w', `${Math.max(104, round((CARDS_X - LABEL_X - 30) * fit))}px`);
    root.style.setProperty('--label-size', `${clamp(fit * 66, 12, 13).toFixed(2)}px`);
  }

  /** Keeps part of the world in view, so nobody can pan into nothing. */
  function keepWorldInView() {
    const {w, h} = viewSize();
    cam.x = clamp(cam.x, w * .3 - (world.x + world.w) * cam.k, w * .7 - world.x * cam.k);
    cam.y = clamp(cam.y, h * .3 - (world.y + world.h) * cam.k, h * .7 - world.y * cam.k);
  }

  /** Returns where the camera is, from the whole map down to the card in the middle of the view. Each step knows how to fly back to it. While a chain is followed the place is the chain, because the middle of the view may be a dimmed card outside it. */
  function readPlace() {
    const {w, h} = viewSize(), middle = toWorld(w / 2, (h + VIEW_TOP - VIEW_BOTTOM) / 2), steps = [{name:'My work', frame:() => frameRect(world.whole, 9)}];
    if (followed) return [...steps, {name:`Chain of ${followed.ids.length}`, frame:() => frameChain(followed)}];
    if (cam.k < zooms.boardTo) return steps;
    const board = world.boards.find(b => contains(growRect(b.area, 200), middle));
    if (!board) return steps;
    const boardFrame = () => frameRect(board.area, BOARD_ZOOM);
    steps.push({name:board.name, frame:boardFrame, board});
    if (cam.k <= boardFrame().k * 1.12) return steps;
    const lane = board.lanes.find(l => middle.y >= l.y - LANE_GAP / 2 && middle.y <= l.y + l.h + LANE_GAP / 2);
    if (!lane) return steps;
    steps.push({name:lane.name, frame:() => frameRect(growRect(lane.area, 40), LANE_ZOOM)});
    if (cam.k < CLOSE_ZOOM) return steps;
    const distance = c => Math.hypot(c.slot.x + c.slot.w / 2 - middle.x, c.slot.y + c.slot.h / 2 - middle.y);
    const card = lane.pieces.filter(c => !c.gone).sort((a, b) => distance(a) - distance(b))[0];
    if (card && distance(card) < w / 2 / cam.k) steps.push({name:card.name, frame:() => frameRect(growRect(card.slot, 30), CARD_ZOOM)});
    return steps;
  }

  /** Writes the breadcrumb when the place has changed. Every step but the last can be clicked to fly back to it. */
  function showPlace() {
    place = readPlace();
    const key = place.map(s => s.name).join('|');
    if (key === shownPlace) return;
    shownPlace = key;
    root.querySelectorAll('.sf-mini [data-board]').forEach(g => g.classList.toggle('here', g.dataset.board === place[1]?.board?.name));
    root.classList.toggle('sf-deep', place.length > 2);
    crumbsEl.innerHTML = place.map((s, i) => i === place.length - 1 ? `<b>${api.esc(s.name)}</b>` : `<button data-crumb="${i}">${api.esc(s.name)}</button><i></i>`).join('');
  }

  /** Redraws every line for the current zoom, so its width stays the same on screen. Small changes of zoom are skipped, because they cannot be seen. */
  function redrawLines() {
    if (Math.abs(Math.log(cam.k / linesZoom)) < .02) return;
    linesZoom = cam.k;
    for (const l of lines) l.el.setAttribute('d', drawRibbon(l.points, l.widths.map(w => w / cam.k)));
  }

  /** Moves the map, every label and the overview to where the current camera puts them. */
  function draw() {
    const {k, x:tx, y:ty} = cam, {w:viewW, h:viewH} = viewSize();
    const boardFade = smooth(zooms.boardFrom, zooms.boardTo, k);
    const face = FACES.filter(f => k >= f[1]).pop()?.[0] ?? 'leaf';
    if (root.dataset.face !== face) root.dataset.face = face;
    ground.setAttribute('transform', `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(5)})`);
    sheet.style.transform = `translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) scale(${k.toFixed(5)})`;
    root.style.setProperty('--hair', `${(1 / k).toFixed(3)}px`);
    root.style.setProperty('--board', boardFade.toFixed(3));
    root.classList.toggle('sf-far', !boardFade);
    root.classList.toggle('sf-close-in', boardFade === 1);
    redrawLines();
    drawRoutes();

    for (const l of labels) {
      const x = l.x * k + tx, y = l.y * k + ty, off = x < -600 || x > viewW + 600 || y < -80 || y > viewH + 80;
      if (off !== l.off) { l.off = off; l.el.style.display = off ? 'none' : ''; }
      if (!off) l.el.style.transform = `translate(${round(x)}px,${round(y)}px)${l.shift}`;
    }

    const a = toWorld(0, 0), b = toWorld(viewW, viewH), s = world.miniScale, min = 7 / s;
    const miniW = Math.max(b.x - a.x, min), miniH = Math.max(b.y - a.y, min);
    miniView.setAttribute('x', ((a.x + b.x) / 2 - miniW / 2).toFixed(0)); miniView.setAttribute('y', ((a.y + b.y) / 2 - miniH / 2).toFixed(0));
    miniView.setAttribute('width', miniW.toFixed(0)); miniView.setAttribute('height', miniH.toFixed(0));
    const miniFade = smooth(zooms.boardTo, zooms.boardTo * 1.3, k);
    miniEl.style.opacity = miniFade.toFixed(3); miniEl.style.visibility = miniFade ? '' : 'hidden';
    showPlace();
  }

  /** Runs one animation at a time. The step function returns false when it has finished. */
  function animate(step) {
    cancelAnimationFrame(frame);
    const loop = now => {
      if (!root.isConnected) return;
      const more = step(now); keepWorldInView(); draw();
      if (more) frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
  }

  /**
   * Plans a flight between two views, each a centre x, a centre y and a width in world units. It returns at, a function
   * from 0..1 to a view along the way, and length, how long the flight is. It follows van Wijk's smooth zoom: a long
   * flight rises, crosses and comes down, so the map never rushes past under the eye.
   */
  function planFlight([ax, ay, aw], [bx, by, bw]) {
    const rho = 1.25, rho2 = rho * rho, dx = bx - ax, dy = by - ay, d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
    if (d < 1) { const s = Math.log(bw / aw) / rho; return {at:t => [ax + t * dx, ay + t * dy, aw * Math.exp(rho * t * s)], length:Math.abs(s)}; }
    const solve = (width, sign) => { const b = (bw * bw - aw * aw + sign * rho2 * rho2 * d2) / (2 * width * rho2 * d); return Math.log(Math.sqrt(b * b + 1) - b); };
    const r0 = solve(aw, 1), r1 = solve(bw, -1), s = (r1 - r0) / rho;
    return {length:Math.abs(s), at:t => {
      const u = aw / (rho2 * d) * (Math.cosh(r0) * Math.tanh(rho * t * s + r0) - Math.sinh(r0));
      return [ax + u * dx, ay + u * dy, aw * Math.cosh(r0) / Math.cosh(rho * t * s + r0)];
    }};
  }

  /** Flies the camera to a target camera. */
  function flyTo(goal) {
    const {w, h} = viewSize(), view = c => [(w / 2 - c.x) / c.k, (h / 2 - c.y) / c.k, w / c.k];
    const flight = planFlight(view(cam), view(goal)), start = performance.now();
    const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : clamp(flight.length * 520, 380, 1050);
    wheelGoal = null;
    animate(now => {
      const t = clamp((now - start) / ms, 0, 1), e = t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const [x, y, width] = flight.at(e);
      cam.k = w / width; cam.x = w / 2 - x * cam.k; cam.y = h / 2 - y * cam.k;
      if (t === 1) Object.assign(cam, goal);
      return t < 1;
    });
  }

  /** Eases the zoom toward wheelGoal, keeping the world point under the cursor still. */
  function runWheelZoom() {
    animate(() => {
      if (!wheelGoal) return false;
      const {k, px, py} = wheelGoal, p = toWorld(px, py);
      const next = Math.abs(Math.log(k / cam.k)) < .002 ? k : Math.exp(lerp(Math.log(cam.k), Math.log(k), .26));
      cam.k = next; cam.x = px - p.x * next; cam.y = py - p.y * next;
      if (next === k) { wheelGoal = null; return false; }
      return true;
    });
  }

  /** Returns the board nearest a world point, measured to its rectangle or to its gate, whichever is closer. */
  function findNearestBoard(p) {
    const distance = ({area:r, gate}) => Math.min(Math.hypot(p.x - clamp(p.x, r.x, r.x + r.w), p.y - clamp(p.y, r.y, r.y + r.h)), Math.hypot(p.x - gate[0], p.y - gate[1]));
    return world.boards.reduce((a, b) => distance(b) < distance(a) ? b : a);
  }

  /** Returns the places under a world point from the outside in: its board, its lane, then the card. */
  function listPlacesAt(p) {
    const board = findNearestBoard(p), out = [frameRect(board.area, BOARD_ZOOM)];
    const lane = board.lanes.find(l => p.y >= l.y - LANE_GAP / 2 && p.y <= l.y + l.h + LANE_GAP / 2);
    if (!lane) return out;
    out.push(frameRect(growRect(lane.area, 40), LANE_ZOOM));
    const card = lane.pieces.find(w => !w.gone && contains(growRect(w.slot, ROW_GAP / 2), p));
    if (card) out.push(frameRect(growRect(card.slot, 30), CARD_ZOOM));
    return out;
  }

  /** Zooms one step deeper at a point: to the board, then the lane there, then the card. Anywhere else simply zooms in. */
  function zoomInto(px, py) {
    const p = toWorld(px, py);
    if ((p.x / HUB_RX) ** 2 + (p.y / HUB_RY) ** 2 <= 1) return flyHome();
    fitted = false;
    const goal = listPlacesAt(p).find(g => g.k > cam.k * 1.12);
    if (goal) return flyTo(goal);
    wheelGoal = {k:clamp(cam.k * 1.6, zooms.min, MAX_ZOOM), px, py};
    runWheelZoom();
  }

  /** Flies to a branch: a project's whole board, or a lane with its name and all its cards. */
  function flyToBranch(key) {
    fitted = false;
    const lane = world.boards.flatMap(b => b.lanes).find(l => l.key === key);
    flyTo(lane ? frameRect(growRect(lane.area, 40), LANE_ZOOM) : frameRect(world.boards.find(b => b.key === key).area, BOARD_ZOOM));
  }

  /** Slides the map when the card just opened is under the details drawer or off the window. A map that was showing everything goes back when the drawer closes. A followed chain is framed again as a whole instead, because sliding to one of its cards could push another off the window. */
  function keepCardInView(id) {
    if (followed) { returnHome = true; return flyTo(frameChain(followed)); }
    const card = root.querySelector(`.sf-card[data-id="${id}"]`).getBoundingClientRect(), box = root.getBoundingClientRect();
    const right = innerWidth - document.getElementById('drawer').offsetWidth - 16, top = box.top + VIEW_TOP - 22, bottom = box.bottom - VIEW_BOTTOM;
    const dx = card.right > right ? right - card.right : Math.max(16 - card.left, 0), dy = card.bottom > bottom ? bottom - card.bottom : Math.max(top - card.top, 0);
    if (dx || dy) { returnHome ||= fitted; fitted = false; flyTo({...cam, x:cam.x + dx, y:cam.y + dy}); }
  }

  /** Answers a change of the details drawer, which the shell fills just after it draws this view. A newly selected piece comes into view, however it was chosen. Once the drawer that pushed the map aside has closed, the camera flies back to the whole map or to the chain being followed. */
  function settleAroundDrawer() {
    const isDrawerClosed = document.getElementById('drawer').hidden, selected = api.selected();
    root.classList.toggle('sf-drawer', !isDrawerClosed);
    if (selected && selected !== lastSelected) keepCardInView(selected);
    lastSelected = selected;
    if (!returnHome || !isDrawerClosed) return;
    returnHome = false;
    followed ? flyTo(frameChain(followed)) : flyHome();
  }

  /** Flies back to the whole map. */
  function flyHome() { fitted = true; flyTo(frameRect(world.whole, 9)); }

  /** Flies one step back out: to the step before the current place. */
  function backOut() {
    if (place.length < 2) return flyHome();
    fitted = false;
    flyTo(place[place.length - 2].frame());
  }

  /** Returns the classes that say what is open around a part of the map. A lane only counts as open while its project is. */
  function readOpenClasses(board, lane) {
    const shown = open.has(board.key);
    return `${shown ? 'sf-shown' : ''} ${shown && lane && open.has(lane.key) ? 'sf-open' : ''}`;
  }

  /** Opens or closes a branch and remembers it. Only the classes change: nothing on the map moves. */
  function setBranchOpen(key, isOpen) {
    if (open.has(key) === isOpen) return;
    isOpen ? open.add(key) : open.delete(key);
    api.store('open', [...open]);
    for (const b of world.boards) for (const lane of [null, ...b.lanes]) {
      const parts = root.querySelectorAll(lane ? `[data-lane="${lane.key}"]` : `[data-trunk="${b.key}"]`);
      for (const el of parts) { el.classList.toggle('sf-shown', open.has(b.key)); el.classList.toggle('sf-open', open.has(b.key) && !!lane && open.has(lane.key)); }
    }
  }

  /** Returns a chain's pieces in ranks, blockers first. A piece's rank comes after everything that blocks it, and pieces that wait on nothing between them share a rank. Within a rank the oldest comes first, so that a change of stage never moves a DAG to another home. */
  function rankPieces(ids, links, pieces) {
    const ranks = [], left = new Set(ids), oldestFirst = (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id);
    while (left.size) {
      const free = [...left].filter(id => !links.some(r => r.from === id && left.has(r.to)));
      // A loop of blocks has no first piece, so its pieces share one rank instead of hanging this loop.
      const rank = free.length ? free : [...left];
      rank.forEach(id => left.delete(id));
      ranks.push(rank.map(id => pieces.get(id)).sort(oldestFirst));
    }
    return ranks;
  }

  /** Finds every chain: a connected set of blockedBy links, which forms a DAG. Each comes back with its piece ids, its ranks, blockers first, and whether it holds a sample link. */
  function findChains(pieces) {
    const strong = relations.filter(r => r.kind === 'blockedBy'), seen = new Set(), found = [];
    for (const start of strong.map(r => r.from)) {
      if (seen.has(start)) continue;
      const ids = new Set([start]);
      for (const id of ids) for (const r of strong) if (r.from === id || r.to === id) ids.add(r.from).add(r.to);
      ids.forEach(id => seen.add(id));
      found.push({ids:[...ids], ranks:rankPieces([...ids], strong, pieces), isSample:strong.some(r => r.sample && ids.has(r.from))});
    }
    return found;
  }

  const findChainContaining = id => chains.find(c => c.ids.includes(id));

  /** Returns the two lines that describe a chain in the list: what ends up waiting, and what it waits on, nearest first. */
  function describeChain(chain) {
    const nameRank = rank => rank.length > 1 ? `${rank[0].name}, and ${rank.length - 1} more` : rank[0].name;
    const [waiting, ...blockers] = chain.ranks.map(nameRank).reverse();
    return {waiting, blockers:blockers.join(', itself blocked by ')};
  }

  /** Lists the weak links to draw: those of what is selected or hovered, else every one when asked for, narrowed to the chain or the Topic that is lit. */
  function listShownRelations() {
    const focus = new Set([api.selected(), hovered].filter(Boolean)), spot = new Set((followed ?? lit)?.ids ?? []);
    const touches = (set, r) => set.has(r.from) || set.has(r.to);
    return relations.filter(r => r.kind === 'linked' && (focus.size ? touches(focus, r) : showWeak && (!spot.size || touches(spot, r))));
  }

  /**
   * Shapes a weak line between two card slots and returns its four curve points in world units. The line leaves each card by the
   * edge that suits where the other card sits, because neighbours are too close for an edge-to-edge line to be seen:
   * - On the same row, it hops over the top.
   * - In the same column, it bulges out to the side.
   * - Far apart, it sweeps between the two facing sides with a slight arch, so it never runs dead straight through the centre.
   * - Otherwise, it leaves by the side and turns into the top or bottom of the other card.
   */
  function shapeRoute(a, b) {
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2, spanX = Math.abs(bx - ax), spanY = Math.abs(by - ay);
    const dirX = Math.sign(bx - ax) || 1, dirY = Math.sign(by - ay), leaveX = dirX > 0 ? .66 : .34, arriveX = 1 - leaveX;
    if (spanX < CARD_W) {
      // The reach is small enough that a bulge from the map's outer edge stays inside the window at a fit.
      const reach = clamp(spanY * .3, 110, 160);
      return [[ax + a.out * a.w / 2, ay], [ax + a.out * (a.w / 2 + reach), ay], [bx + a.out * (b.w / 2 + reach), by], [bx + a.out * b.w / 2, by]];
    }
    if (spanX > SWEEP_SPAN) {
      const start = [ax + dirX * a.w / 2, ay], end = [bx - dirX * b.w / 2, by], reach = Math.abs(end[0] - start[0]) * .42, arch = Math.abs(end[0] - start[0]) * .07;
      return [start, [start[0] + dirX * reach, start[1] - arch], [end[0] - dirX * reach, end[1] - arch], end];
    }
    if (spanY < CARD_H) {
      const start = [a.x + a.w * leaveX, a.y], end = [b.x + b.w * arriveX, b.y], height = clamp(Math.abs(end[0] - start[0]) * .34, 110, 330);
      return [start, [start[0], start[1] - height], [end[0], end[1] - height], end];
    }
    const start = [ax + dirX * a.w / 2, ay], end = [b.x + b.w * arriveX, dirY > 0 ? b.y : b.y + b.h];
    return [start, [lerp(start[0], end[0], .72), start[1]], [end[0], lerp(end[1], start[1], .72)], end];
  }

  /** Builds one weak line on the map. */
  function buildRoute(r, isFresh) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    el.setAttribute('class', `sf-route ${isFresh ? 'sf-fresh' : ''}`);
    el.dataset.route = `${r.from}>${r.to}`;
    el.innerHTML = '<path class="sf-casing"/><path class="sf-line"/>';
    routeLayer.append(el);
    const [casing, line] = el.children;
    return {el, casing, line, curve:shapeRoute(world.pieces.get(r.from).slot, world.pieces.get(r.to).slot)};
  }

  /** Moves every line to where the camera puts it. Lines are drawn in screen pixels, so they stay fine at any zoom. */
  function drawRoutes() {
    const {k, x:tx, y:ty} = cam, writePoint = p => `${(p[0] * k + tx).toFixed(1)} ${(p[1] * k + ty).toFixed(1)}`;
    for (const route of routes.values()) {
      const [a, b, c, d] = route.curve.map(writePoint), path = `M${a}C${b} ${c} ${d}`;
      route.casing.setAttribute('d', path); route.line.setAttribute('d', path);
    }
  }

  /** Brings the lines, the cards they land on and the spotlight up to date with what is in focus. keptKeys lists the lines already seen, which appear without fading in again. Nothing here moves a piece: a card on a closed branch only shows in its own slot. */
  function showRelations(keptKeys = new Set(routes.keys())) {
    const wanted = new Map(listShownRelations().map(r => [`${r.from}:${r.to}`, r]));
    for (const [key, route] of routes) {
      if (wanted.has(key)) continue;
      route.el.classList.add('sf-leaving');
      setTimeout(() => route.el.remove(), 140);
      routes.delete(key);
    }
    for (const [key, r] of wanted) if (!routes.has(key)) routes.set(key, buildRoute(r, !keptKeys.has(key)));
    drawRoutes();
    const landing = new Set([...wanted.values()].flatMap(r => [r.from, r.to])), spot = new Set((followed ?? lit)?.ids ?? []);
    const spotLanes = new Set([...spot].map(id => world.pieces.get(id).lane.key));
    const spotBoards = new Set(world.boards.filter(b => b.lanes.some(l => spotLanes.has(l.key))).map(b => b.key));
    for (const [id, slot] of slotEls) {
      slot.classList.toggle('sf-landing', landing.has(id) || spot.has(id));
      slot.classList.toggle('sf-in-spot', spot.has(id));
      slot.firstElementChild.classList.toggle('sf-focus', id === api.selected() || (id === hovered && !!followed));
      slot.firstElementChild.classList.toggle('sf-glow', !!lit && spot.has(id));
    }
    for (const label of labels) label.el.classList.toggle('sf-in-spot', spotLanes.has(label.el.dataset.lane) || spotBoards.has(label.el.dataset.trunk));
    for (const line of lines) if (line.link) line.el.classList.toggle('sf-in-spot', spot.has(line.link.from.id) && spot.has(line.link.to.id));
    root.classList.toggle('sf-spot', spot.size > 0);
  }

  /** Returns the camera that shows a whole chain above the strip and beside any open details. */
  function frameChain(chain) {
    const slots = chain.ids.map(id => world.pieces.get(id).slot), left = Math.min(...slots.map(s => s.x)), top = Math.min(...slots.map(s => s.y)), drawer = document.getElementById('drawer');
    const r = {x:left, y:top, w:Math.max(...slots.map(s => s.x + s.w)) - left, h:Math.max(...slots.map(s => s.y + s.h)) - top};
    return frameRect(growRect(r, 70), CLOSE_ZOOM, STRIP_ROOM, VIEW_SIDE + (drawer.hidden ? 0 : drawer.offsetWidth));
  }

  /** Follows a chain: closes the details, so the chain has the whole window, then dims the rest and flies to it. The camera to come back to is remembered once, even when one chain follows another. */
  function followChain(chain) {
    const back = followed?.back ?? (returnHome ? frameRect(world.whole, 9) : {...cam}), backFitted = followed ? followed.backFitted : fitted || returnHome;
    followed = {...chain, back, backFitted, isNew:true};
    lit = null; fitted = returnHome = false;
    api.open(null);
    flyTo(frameChain(followed));
  }

  /** Stops following the chain and flies back to where the camera was. */
  function leaveChain() {
    const {back, backFitted} = followed;
    followed = null; fitted = backFitted; returnHome = false;
    api.rerender();
    flyTo(back);
  }

  /** Lights up one Topic or initiative wherever its pieces live, and dims the rest. Nothing moves, and any chain being followed stops. */
  function lightUp(light) {
    lit = light; followed = null;
    api.rerender();
  }

  /** Changes what a project's branches are. Every card glides to its new lane, so that the change can be followed. */
  function setArrangement(mode) {
    if (mode === arrange) return;
    api.store('arrange', mode);
    followed = null;
    api.rerender();
    // Close in, the cards under the camera have just gone elsewhere, so the view steps back to where the change can be seen.
    if (!fitted) flyHome();
  }

  /** Shows one of the lists in the bar, or none. They live over the map and never change it, so the view does not need drawing again. */
  function showList(name) {
    for (const el of root.querySelectorAll('.sf-list')) el.hidden = el.dataset.list !== name;
    for (const el of root.querySelectorAll('[data-list-button]')) el.setAttribute('aria-expanded', el.dataset.listButton === name);
  }
  const readShownList = () => root.querySelector('.sf-list:not([hidden])')?.dataset.list ?? null;

  /** Sets the hovered piece. A piece has to hold the pointer for a moment before its lines show, so that sweeping across the map flashes nothing. */
  function setHovered(id) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (id !== hovered) { hovered = id; showRelations(); } }, id ? 90 : 0);
  }
  function onPointerOver(e) {
    if (!press?.moved) setHovered(e.target.closest('[data-id]')?.dataset.id ?? null);
  }

  function onPointerDown(e) {
    dragged = false;
    if (e.button !== 0 || e.target.closest('button,.sf-mini,.sf-strip,.sf-list')) return;
    cancelAnimationFrame(frame); wheelGoal = null;
    press = {x:e.clientX, y:e.clientY, camX:cam.x, camY:cam.y, moved:false};
  }
  function onPointerMove(e) {
    if (!press) return;
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (!press.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      press.moved = true; root.setPointerCapture(e.pointerId); root.classList.add('panning');
    }
    cam.x = press.camX + dx; cam.y = press.camY + dy; fitted = returnHome = false;
    keepWorldInView(); draw();
  }
  function onPointerUp() {
    dragged = !!press?.moved; press = null; root.classList.remove('panning');
  }
  function onWheel(e) {
    if (e.target.closest('.sf-list')) return;
    e.preventDefault();
    if (e.target.closest('.sf-strip')) return;
    const box = root.getBoundingClientRect(), delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1), k = wheelGoal?.k ?? cam.k;
    wheelGoal = {k:clamp(k * Math.exp(-delta * (e.ctrlKey ? .012 : .0021)), zooms.min, MAX_ZOOM), px:e.clientX - box.left, py:e.clientY - box.top};
    fitted = returnHome = false;
    runWheelZoom();
  }
  // Every click here is settled by this view, because a single click on a card has to wait to see whether it becomes a double-click.
  function onClick(e) {
    e.preventDefault();
    if (dragged) { dragged = false; return; }
    const listButton = e.target.closest('[data-list-button]')?.dataset.listButton;
    if (listButton) return showList(readShownList() === listButton ? null : listButton);
    const chainRow = e.target.closest('[data-chain]'), lightRow = e.target.closest('[data-light]');
    if (chainRow) return followChain(chains[chainRow.dataset.chain]);
    if (lightRow) return lightUp(lights[lightRow.dataset.light]);
    if (readShownList()) return showList(null);
    const arrangeButton = e.target.closest('[data-arrange]');
    if (arrangeButton) return setArrangement(arrangeButton.dataset.arrange);
    if (e.target.closest('.sf-unlight')) return lightUp(null);
    if (e.target.closest('.sf-weak-button')) {
      showWeak = !showWeak; api.store('weak', showWeak);
      e.target.closest('.sf-weak-button').setAttribute('aria-pressed', showWeak);
      return showRelations();
    }
    if (e.target.closest('.sf-follow')) return followChain(findChainContaining(api.selected()));
    if (e.target.closest('.sf-leave')) return leaveChain();
    const step = e.target.closest('.sf-step');
    if (step) return api.open(step.dataset.id);
    if (e.target.closest('.sf-strip')) return;
    if (e.target.closest('.sf-fit')) return flyHome();
    if (e.target.closest('.sf-out')) return backOut();
    const crumb = e.target.closest('[data-crumb]');
    if (crumb) { fitted = crumb.dataset.crumb === '0'; return flyTo(place[crumb.dataset.crumb].frame()); }
    if (e.target.closest('.sf-bar')) return;
    const box = root.getBoundingClientRect(), px = e.clientX - box.left, py = e.clientY - box.top;
    if (e.target.closest('.sf-mini')) {
      const r = miniEl.querySelector('svg').getBoundingClientRect(), s = r.width / world.miniBox.w;
      const p = {x:world.miniBox.x + (e.clientX - r.left) / s, y:world.miniBox.y + (e.clientY - r.top) / s}, {w, h} = viewSize();
      fitted = false;
      return flyTo({k:cam.k, x:w / 2 - p.x * cam.k, y:h / 2 - p.y * cam.k});
    }
    clearTimeout(clickTimer);
    const piece = e.target.closest('[data-id]')?.dataset.id, init = e.target.closest('[data-init]')?.dataset.init;
    const branch = init ? null : e.target.closest('.sf-branch,.sf-project')?.dataset, key = branch?.lane ?? branch?.trunk;
    // Close in every card already shows, so opening a branch would change nothing there: the click goes to the branch instead.
    if (key && root.classList.contains('sf-close-in')) return flyToBranch(key);
    if (key && e.detail >= 2) { setBranchOpen(key, true); return flyToBranch(key); }
    if (key) return setBranchOpen(key, !open.has(key));
    if (e.detail >= 2) return zoomInto(px, py);
    clickTimer = setTimeout(() => {
      if (piece) api.open(piece);
      else if (init) api.openInit(init);
    }, 230);
  }

  /** Returns the classes that make a branch fade with its work: dim when nothing matches the filter, worn when all of it has been left. */
  function toneBranch(pieces) {
    const live = pieces.filter(w => !w.gone);
    if (!live.some(api.hit)) return 'dim';
    const freshest = live.reduce((a, b) => api.quietDays(a) <= api.quietDays(b) ? a : b);
    return api.cls(freshest).split(' ').filter(c => /^wear/.test(c)).join(' ');
  }

  /** Returns what is drawn after a branch's name: its count, the mark for real thinking, and any extra marks. The group never wraps apart. */
  function drawBranchCount(pieces, marks = '') {
    const live = pieces.filter(w => !w.gone), hot = live.some(w => w.need === 'think' && api.hit(w));
    return `<span class="sf-count"><small>${live.length}</small>${hot ? '<i class="sf-hot" title="Needs real thinking"></i>' : ''}${marks}</span>`;
  }

  /** Returns the markup of one card in its slot: its four faces, of which the camera shows one. */
  function drawCard(w, n, board, lane, stageNames, needNames) {
    const {esc, cls, quiet} = api, name = esc(w.name), age = quiet(w), mark = `<i class="mark" style="background:var(--s-${w.stage})"></i>`;
    const port = relations.some(r => r.kind === 'linked' && (r.from === w.id || r.to === w.id)) ? '<i class="sf-port"></i>' : '';
    // A piece that moved to its DAG keeps a quiet tag saying where it came from.
    const tag = w.origin || w.isSample ? `<small class="sf-origin">${w.isSample ? '<i>Sample</i>' : ''}<span>${esc(w.origin ?? '')}</span></small>` : '';
    const run = w.isRunStart ? `<i class="sf-run">${esc(stageNames[w.stage])}</i>` : '';
    const status = [stageNames[w.stage], MOVE_WORDS[w.move], w.need === 'think' || w.need === 'quick' ? needNames[w.need].toLowerCase() : '', age, w.stalled ? 'stalled' : ''].filter(Boolean).join(' · ');
    return `<div class="sf-slot ${readOpenClasses(board, lane)}" data-lane="${esc(lane.key)}" style="left:${w.slot.x}px;top:${w.slot.y}px;--n:${n}"><article class="sf-card ${cls(w)} ${tag ? 'sf-tagged' : ''}" data-id="${w.id}" title="${name}" style="--stage:var(--s-${w.stage})">
      <i class="sf-flag"></i>${port}${run}
      <div class="sf-face sf-leaf"><b>${name}</b>${tag}</div>
      <div class="sf-face sf-title"><b>${name}</b>${tag}</div>
      <div class="sf-face sf-regular"><b>${name}</b>${tag}<footer>${mark}<p>${esc(pickMutedLine(w))}</p><span>${age}</span></footer></div>
      <div class="sf-face sf-near"><b>${name}</b>${tag}<div class="sf-body"><div>${w.ask ? `<p>${esc(w.ask)}</p>` : ''}<p class="sf-where">${esc(w.where)}</p></div></div><footer>${mark}<span>${esc(status)}</span></footer></div>
    </article></div>`;
  }

  /** Lists every line of the map, in the order they are painted. */
  function listLines() {
    const out = [];
    const tint = lane => lane.init ? ` style="--h:${api.hue(lane.init.id)}"` : '';
    for (const b of world.boards) {
      for (const l of b.lanes.filter(l => !l.empty)) {
        const tone = `${l.init ? 'sf-tint' : ''} ${toneBranch(l.pieces)} ${readOpenClasses(b, l)}`, part = `data-lane="${api.esc(l.key)}"${tint(l)}`;
        out.push({...l.tail, markup:`class="sf-tail ${tone}" ${part}`});
        for (const twig of l.twigs) out.push({...twig, markup:`class="sf-twig ${tone}" ${part}`});
        for (const link of l.links) out.push({...shapeLink(b, link), link, markup:`class="sf-link ${link.isSecond ? 'sf-second' : ''} ${tone}" ${part}`});
        out.push({...l.fan, markup:`class="sf-fan ${tone}" ${part}`});
      }
      const tone = toneBranch(b.lanes.flatMap(l => l.pieces));
      out.push({...b.tail, markup:`class="sf-stub ${tone} ${readOpenClasses(b)}" data-trunk="${api.esc(b.key)}"`});
      out.push({...b.trunk, markup:`class="sf-trunk ${tone}"`});
    }
    return out;
  }

  /** Builds every label in screen pixels, and fills labels with where each one belongs in the world. */
  function drawLabels() {
    const {esc} = api, html = [];
    labels = [];
    const add = (markup, fields) => { html.push(markup); labels.push({shift:'', off:false, ...fields}); };
    add('<div class="sf-lab sf-hubname">My work</div>', {x:0, y:0, shift:' translate(-50%,-50%)'});
    for (const b of world.boards) {
      const left = b.side < 0, align = left ? 'sf-left' : '', anchor = left ? '-100%' : '0';
      add(`<div class="sf-lab sf-project ${toneBranch(b.lanes.flatMap(l => l.pieces))} ${readOpenClasses(b)}" data-trunk="${esc(b.key)}">${esc(b.name)} <small>${b.count}</small></div>`, {x:b.side * RUN_X, y:b.gate[1], shift:` translate(${anchor},-100%)`});
      for (const l of b.lanes) {
        if (l.empty) continue;
        const tint = l.init ? `style="--h:${api.hue(l.init.id)}"` : '';
        const about = l.init ? `<i class="sf-about" data-init="${l.init.id}" title="${esc(l.init.progress || l.init.target)}. Click for the initiative.">i</i>` : '';
        add(`<div class="sf-lab sf-branch ${align} ${toneBranch(l.pieces)} ${readOpenClasses(b, l)}" data-lane="${esc(l.key)}" ${tint}>${esc(l.name)} ${drawBranchCount(l.pieces, about)}</div>`, {x:l.startX, y:l.lineY, shift:` translate(${anchor},-100%)`});
      }
    }
    labelLayer.innerHTML = html.join('');
    [...labelLayer.children].forEach((node, i) => { labels[i].el = node; });
  }

  /** Builds the overview: every branch and block of cards in miniature, with a rectangle for what the camera sees. */
  function drawOverview() {
    const pad = 200, box = {x:world.x - pad, y:world.y - pad, w:world.w + 2 * pad, h:world.h + 2 * pad};
    world.miniBox = box; world.miniScale = MINI_W / box.w;
    const drawLine = l => `<path d="M${l.points.map(p => `${round(p[0])} ${round(p[1])}`).join('L')}"/>`;
    const branches = world.boards.map(b => `<g data-board="${api.esc(b.name)}">${[b.trunk, ...b.lanes.map(l => l.fan)].map(drawLine).join('')}${b.lanes.map(l => `<rect x="${b.x}" y="${l.y}" width="${b.w}" height="${l.h}"/>`).join('')}</g>`).join('');
    const hub = `<ellipse cx="0" cy="0" rx="${HUB_RX}" ry="${HUB_RY}"/>`;
    return `<svg viewBox="${box.x} ${box.y} ${box.w} ${box.h}" width="${MINI_W}" height="${round(MINI_W * box.h / box.w)}"><g>${branches}${hub}</g><rect class="sf-view"/></svg>`;
  }

  /** Returns the markup of the list of chains. */
  function drawChainList() {
    const {esc} = api;
    return chains.map((chain, n) => {
      const {waiting, blockers} = describeChain(chain);
      return `<button data-chain="${n}"><b>${esc(waiting)}${chain.isSample ? '<i class="sf-sample">Sample</i>' : ''}</b><span>blocked by ${esc(blockers)}</span></button>`;
    }).join('');
  }

  /** Lists what can be lit up: every initiative and Topic that has open pieces. A piece can carry both, so the two lists overlap. */
  function listLights() {
    const open = [...world.pieces.values()].filter(w => !w.gone), inits = api.initiatives().filter(i => i.pieces.length);
    const topics = [...new Set(open.map(w => w.topic).filter(Boolean))].sort();
    return [...inits.map(i => ({kind:'Initiatives', name:i.name, ids:i.pieces.map(w => w.id)})), ...topics.map(name => ({kind:'Topics', name, ids:open.filter(w => w.topic === name).map(w => w.id)}))];
  }

  /** Returns the markup of the Light up list, in its two sections. */
  function drawLightList() {
    const {esc} = api, drawRow = (l, n) => `<button data-light="${n}" class="sf-light"><b>${esc(l.name)}</b><small>${l.ids.length}</small></button>`;
    const drawSection = kind => `<h3>${kind}</h3>${lights.map((l, n) => l.kind === kind ? drawRow(l, n) : '').join('')}`;
    return drawSection('Initiatives') + drawSection('Topics');
  }

  /** Returns the hint, which always says what is true of the current mode. */
  function drawHint() {
    if (followed) return 'The lane shows the structure, the strip the order. Esc leaves the chain.';
    if (lit) return 'Everything else is dimmed and nothing has moved. Esc clears it.';
    return 'Click a branch to open it, scroll to zoom, Esc to back out. Cards move only when their stage or a strong link changes.';
  }

  /** Returns the markup of the strip: the followed chain as one straight line of small cards, blocker first. Pieces in the same rank have no order between them, so an "and" joins them instead of an arrow. */
  function drawStrip(stageNames) {
    const {esc, cls} = api, arrow = '<svg class="sf-then" width="30" height="10" viewBox="0 0 30 10"><circle cx="4" cy="5" r="2.4"/><path d="M6.4 5H24"/><path class="sf-tip" d="M29 5l-8-3.5 2.2 3.5-2.2 3.5z"/></svg>';
    const drawStep = w => `<article class="sf-step ${cls(w)} ${w.id === api.selected() ? 'sf-focus' : ''}" data-id="${w.id}" title="${esc(w.name)}"><b>${esc(w.name)}</b><footer><i class="mark" style="background:var(--s-${w.stage})"></i><span>${esc(stageNames[w.stage])} · ${esc(MOVE_WORDS[w.move])}</span></footer></article>`;
    const rising = followed.isNew ? 'sf-rising' : '';
    followed.isNew = false;
    return `<div class="sf-strip ${rising}"><div class="sf-steps">${followed.ranks.map(rank => rank.map(drawStep).join('<span class="sf-and">and</span>')).join(arrow)}</div><button class="sf-leave" title="Leave the chain (Esc)">Esc</button></div>`;
  }

  /** Glides every card that changed place from where it was, and fades in the branches when they changed too. On the first draw there is nothing to compare with. */
  function glideMovedCards() {
    const isCalm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const [id, el] of slotEls) {
      const now = world.pieces.get(id).slot, was = shownSlots.get(id);
      if (was && !isCalm && (was.x !== now.x || was.y !== now.y)) el.animate({translate:[`${was.x - now.x}px ${was.y - now.y}px`, '0 0']}, {duration:560, easing:'cubic-bezier(.3,.1,.2,1)'});
      shownSlots.set(id, now);
    }
    const shape = world.boards.flatMap(b => b.lanes.map(l => `${l.key}:${l.rows}`)).join();
    if (shownShape && shape !== shownShape) root.classList.add('sf-reshaped');
    shownShape = shape;
  }

  function render(el, shell) {
    api = shell;
    arrange = api.load('arrange', 'topic');
    world = buildWorld();
    lights = listLights();
    showWeak = api.load('weak', false);
    // A chain being followed can lose a piece while it is followed. It carries on with what is left, and ends when nothing is.
    if (followed) {
      const current = chains.find(c => c.ids.some(id => followed.ids.includes(id)));
      if (current) Object.assign(followed, current);
      else followed = null;
    }
    if (lit) lit = lights.find(l => l.kind === lit.kind && l.name === lit.name) ?? null;
    const selectedChain = findChainContaining(api.selected());
    open = new Set(api.load('open', world.boards.map(b => b.key)));
    const stageNames = Object.fromEntries(api.stages), needNames = Object.fromEntries(api.needs);
    const cards = world.boards.flatMap(b => b.lanes.flatMap(l => l.pieces.filter(w => !w.gone).map((w, n) => drawCard(w, n, b, l, stageNames, needNames)))).join('');
    lines = listLines();
    el.innerHTML = `<div class="v-surface">
      <svg class="sf-ground"><g>${lines.map(l => `<path ${l.markup}/>`).join('')}<path class="sf-hub" d="${drawHub()}"/></g></svg>
      <div class="sf-sheet">${cards}</div>
      <svg class="sf-routes"></svg>
      <div class="sf-labels"></div>
      <div class="sf-bar"><nav class="sf-crumbs"></nav><div class="hint">${drawHint()}</div>
        <div class="sf-actions">
          ${selectedChain && !followed?.ids.includes(api.selected()) ? '<button class="sf-action sf-follow">Follow the chain</button>' : ''}
          ${lit ? `<button class="sf-action sf-unlight" title="Stop lighting this up (Esc)">${api.esc(lit.name)}<i></i></button>` : ''}
          <span class="sf-arrange">Arrange by <button class="sf-action" data-arrange="topic" aria-pressed="${arrange === 'topic'}">Topic</button><button class="sf-action" data-arrange="zone" aria-pressed="${arrange === 'zone'}">Zone</button></span>
          <button class="sf-action" data-list-button="lights" aria-expanded="false" title="Light up a Topic or an initiative wherever its pieces live">Light up</button>
          <button class="sf-action" data-list-button="chains" aria-expanded="false" title="Work held up by other work">Chains <small>${chains.length}</small></button>
          <button class="sf-action sf-weak-button" aria-pressed="${showWeak}" title="Draw every weak link, the only lines that cross the map">Weak links</button>
          <div class="sf-list" data-list="chains" hidden>${drawChainList()}</div>
          <div class="sf-list sf-lights" data-list="lights" hidden>${drawLightList()}</div>
        </div>
      </div>
      ${followed ? drawStrip(stageNames) : ''}
      <div class="sf-mini" title="Your place in the whole. Click to go there."></div>
      <div class="sf-tools"><button class="sf-out" title="Zoom back out one step (Esc)">Back out</button><button class="sf-fit" title="Show everything">Fit</button></div>
    </div>`;
    root = el.firstElementChild;
    root.style.top = `${document.querySelector('.top').offsetHeight}px`;
    ground = root.querySelector('.sf-ground g'); sheet = root.querySelector('.sf-sheet');
    routeLayer = root.querySelector('.sf-routes');
    slotEls = new Map([...root.querySelectorAll('.sf-slot')].map(s => [s.firstElementChild.dataset.id, s]));
    const keptKeys = new Set(routes.keys());
    routes = new Map();
    lines.forEach((l, i) => { l.el = ground.children[i]; });
    linesZoom = 0;
    labelLayer = root.querySelector('.sf-labels'); crumbsEl = root.querySelector('.sf-crumbs');
    miniEl = root.querySelector('.sf-mini'); miniEl.innerHTML = drawOverview();
    miniView = root.querySelector('.sf-view');
    drawLabels();
    setZoomLevels();
    if (!cam || fitted) cam = frameRect(world.whole, 9);
    shownPlace = '';
    draw();
    showRelations(keptKeys);
    glideMovedCards();
    root.addEventListener('pointerover', onPointerOver);
    root.addEventListener('pointerleave', () => setHovered(null));
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
    root.addEventListener('wheel', onWheel, {passive:false});
    root.addEventListener('click', onClick);
    queueMicrotask(settleAroundDrawer);
  }

  addEventListener('resize', () => {
    if (!root?.isConnected) return;
    root.style.top = `${document.querySelector('.top').offsetHeight}px`;
    setZoomLevels();
    if (fitted) cam = frameRect(world.whole, 9);
    keepWorldInView(); draw();
  });

  // Escape takes one layer off at a time: an open list, then the details as the shell does, then the chain or the light, and only then zooms back out.
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || document.body.dataset.view !== 'surface' || e.target.matches('input,textarea,select')) return;
    if (readShownList()) { e.stopPropagation(); return showList(null); }
    if (!document.getElementById('drawer').hidden) return;
    if (followed) leaveChain();
    else if (lit) lightUp(null);
    else backOut();
  }, true);

  Shell.register({id:'surface', label:'One surface', render});
}
