'use strict'; // Keeps this file's functions out of global scope, where they could overwrite the shell's own.
// Track arrangement: laid out like a music editor. Time always runs left to right on a real calendar, up to a today playhead.
// There is one track per initiative, then one per project for loose work, and review requests and mentions get one each.
// Open and delivered work share the timeline. Open work is always a clip, with a faint tail while it is quiet.
// Most delivered work lasts hours, so an item folds into a tick on its track's strip until zooming in makes it wide enough to be a clip.
{
  const MINUTE = 6e4, HOUR = 36e5, DAY = 864e5;
  const HEAD = 244, ROW = 22, THIN_ROW = 10, LANE_PADDING = 12, MIN_TRACK = 46, LEFT_MARGIN = 18, RIGHT_MARGIN = 34;
  const MIN_LABEL = 72, MIN_TAIL = 12, MIN_CLIP_DRAWN = 6;
  // Zoom is measured in pixels per day. The view opens on this many days, and zooming out reaches everything.
  const DEFAULT_SPAN_DAYS = 21, MAX_ZOOM = 12000, ZOOM_STEP = 2;
  // A delivered item stays a tick until its clip would be this wide, because a narrower clip does not read as a length.
  const MIN_CLIP = 48;
  // Below this zoom, delivered clips are thin bars without names, so names at that distance belong to open work alone.
  const NAME_ZOOM = 160;
  // From this zoom a working day fills the screen, so every item becomes a clip, however short it is.
  const ALL_CLIPS_ZOOM = 2000;
  // Threads marked Done within this gap of each other, this many or more, count as one tidy-up rather than as finished work.
  const BATCH_GAP = 3*MINUTE, BATCH_SIZE = 4;
  // A batch-closed thread's length is the misleading part of it, so it stays a tick until zoomed in this far.
  // Its clips then share a fixed number of rows and may overlap: dozens of them can overlap at once, far too many for a row each.
  const PALE_ZOOM = 500, PALE_ROWS = 4;
  // Every delivered clip keeps this much of its row free after it, so the shortest clips can never touch.
  const ROW_GAP = 20*MINUTE;
  // The strip groups ticks into columns this wide. A tick's height grows with the cube root of its count,
  // because a tidy-up can close dozens of threads in a few minutes and one finished item still has to show beside that.
  const COLUMN = 3, TICK = 2, STRIP = 22, TICK_SCALE = 6;
  const HOUR_STEPS = [1,2,3,6], MIN_TICK_GAP = 44, DAY_NUMBER_ZOOM = 44, WEEKDAY_ZOOM = 90, TODAY_CHIP_ROOM = 66;
  const TIP_NAMES = 5;
  const LABEL_FONT = '11.5px -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif';
  const canvas = document.createElement('canvas').getContext('2d');
  const labelWidths = new Map();
  let shellApi = null, deliveredItems = null, leftEdgeMs = null, scrollTop = 0;

  const formatDay = ms => new Date(ms).toLocaleDateString('en-GB', {day:'numeric', month:'short'});
  const formatWeekday = ms => new Date(ms).toLocaleDateString('en-GB', {weekday:'short'});
  const formatMoment = ms => `${formatDay(ms)} ${new Date(ms).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'})}`;
  // Some open pieces only know their day. Such a start means that day's first moment, and such an end its last.
  const parseStart = text => Date.parse(text.length===10 ? `${text}T00:00` : text);
  const parseEnd = text => text.length===10 ? parseStart(text)+DAY : Date.parse(text);

  // Returns a name's width in pixels. Widths are kept, because every zoom step asks for hundreds of them.
  function measureLabel(text) {
    if (!labelWidths.has(text)) { canvas.font = LABEL_FONT; labelWidths.set(text, canvas.measureText(text).width); }
    return labelWidths.get(text);
  }

  // Returns a duration in plain words, such as "37 min", "3.6 hours" or "21 days".
  function formatSpan(span) {
    const plain = (n, word) => { const shown = n<9.95 ? +n.toFixed(1) : Math.round(n); return `${shown} ${word}${shown===1?'':'s'}`; };
    if (span<MINUTE) return 'under 1 min';
    if (span<HOUR) return `${Math.round(span/MINUTE)} min`;
    return span<DAY ? plain(span/HOUR,'hour') : plain(span/DAY,'day');
  }

  // Returns the middle value of a list of durations, or null for an empty list.
  function computeMedian(spans) {
    if (!spans.length) return null;
    const sorted = [...spans].sort((a,b)=>a-b), middle = sorted.length>>1;
    return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
  }

  // Marks the threads that were marked Done in a batch. Their end is the moment of a tidy-up, so it says little about the work.
  function markBatches(threads) {
    const byEnd = [...threads].sort((a,b)=>a.endMs-b.endMs);
    let run = [];
    const closeRun = () => { if (run.length>=BATCH_SIZE) for (const w of run) w.batch = true; run = []; };
    for (const w of byEnd) {
      if (run.length && w.endMs-run.at(-1).endMs>=BATCH_GAP) closeRun();
      run.push(w);
    }
    closeRun();
  }

  // Gives each delivered item a row that holds at every zoom, so zooming never moves a clip.
  // The longest items claim the top rows. Clips unfold longest first, so the rows in use are always the top ones,
  // and a new row only ever appears at the bottom of the track.
  function assignRows(items) {
    const rows = [];
    for (const w of [...items].sort((a,b)=>b.span-a.span || a.startMs-b.startMs)) {
      const freeFrom = w.endMs+ROW_GAP;
      let row = rows.findIndex(taken=>!taken.some(t=>t.startMs<freeFrom && w.startMs<t.freeFrom));
      if (row<0) row = rows.push([])-1;
      rows[row].push({startMs:w.startMs, freeFrom});
      w.row = row;
    }
  }

  // Returns every delivered item with exact times. The `days` field is rounded, which turns the shortest items into 0.
  // The GitHub repository and the thread data spell one project in two ways, so a project takes the spelling open work uses.
  function readDelivered() {
    if (deliveredItems) return deliveredItems;
    const spelling = new Map(WORK.map(w=>[w.project.toLowerCase(), w.project]));
    deliveredItems = DELIVERED.map((d, index)=>{
      const startMs = Date.parse(d.start), endMs = Date.parse(d.end);
      return {...d, index, what:'', where:'', project:spelling.get(d.project.toLowerCase()) ?? d.project, startMs, endMs, span:endMs-startMs};
    });
    markBatches(deliveredItems.filter(w=>w.kind==='thread'));
    const byTrack = Map.groupBy(deliveredItems.filter(w=>!w.batch), w=>w.initiative||w.project);
    for (const items of byTrack.values()) assignRows(items);
    return deliveredItems;
  }

  // Returns the tracks in their fixed order. The order never depends on activity, so a track stays where it was.
  function buildTracks(api) {
    const delivered = readDelivered(), loose = api.pieces().filter(w=>!w.initiative);
    const isSignal = w => w.kind==='review'||w.kind==='mention';
    const inits = api.initiatives().map(i=>({name:i.name, init:i.id, hue:api.hue(i.id), pieces:i.pieces, delivered:delivered.filter(w=>w.initiative===i.id)}));
    const projects = PROJECTS.map(p=>({name:p, pieces:loose.filter(w=>w.project===p&&!isSignal(w)), delivered:delivered.filter(w=>!w.initiative&&w.project===p)}));
    const kinds = [['review','Review requests'],['mention','Mentions']].map(([kind,name])=>({name, pieces:loose.filter(w=>w.kind===kind), delivered:[]}));
    return {inits, loose:[...projects, ...kinds].filter(t=>t.pieces.length||t.delivered.length)};
  }

  // Returns the first and last moments of the timeline, and the midnight of every day between them.
  // The playhead sits at the last recorded event, because the data was taken then and not at the end of the day.
  function buildCalendar() {
    const items = readDelivered();
    const nowMs = Math.max(...items.map(w=>w.endMs), ...WORK.map(w=>Date.parse(w.lastActivityAt)));
    const first = new Date(Math.min(...items.map(w=>w.startMs), ...WORK.map(w=>parseStart(w.createdAt))));
    const days = [];
    for (let day = 0;; day++) {
      const midnight = new Date(first.getFullYear(), first.getMonth(), first.getDate()+day).getTime();
      if (midnight>nowMs) break;
      days.push(midnight);
    }
    return {days, firstMs:days[0], nowMs};
  }

  // Assigns each open piece the first row where it fits. Pieces arrive oldest first, which gives the fewest rows possible.
  // Rows depend on time alone, so a piece holds its row at every zoom.
  function packOpenClips(pieces, nowMs) {
    const rowEnds = [];
    const clips = pieces.map(w=>{
      const startMs = parseStart(w.createdAt), endMs = Math.min(parseEnd(w.lastActivityAt), nowMs);
      let row = rowEnds.findIndex(e=>e<=startMs);
      if (row<0) row = rowEnds.push(0)-1;
      rowEnds[row] = Math.max(endMs, startMs+6*HOUR);
      return {w, startMs, endMs, row};
    });
    return {clips, rows:rowEnds.length};
  }

  // Adds a clip's left edge and width at this zoom.
  function measureClip(c, time) {
    c.x = time.xAt(c.startMs);
    c.width = Math.max((c.endMs-c.startMs)/DAY*time.zoom-2, MIN_CLIP_DRAWN);
    return c;
  }

  // Decides where each clip's name goes: inside when it fits, else in the free space beside the clip, else nowhere.
  // A row is walked left to right, so a name placed beside one clip is never overdrawn by the name of the next.
  function placeLabels(clips, todayX) {
    for (const row of Map.groupBy(clips, c=>c.row).values()) {
      let taken = 0;
      row.forEach((c, n) => {
        const nextX = n+1<row.length ? row[n+1].x : todayX;
        const need = measureLabel(c.w.name), inside = c.width-12;
        const right = nextX-c.x-c.width-10, left = c.x-taken-8;
        if (need<=inside) c.label = {at:'in'};
        else if (need<=right) c.label = {at:'right', width:need};
        else if (need<=left) c.label = {at:'left', width:need};
        else if (inside>=Math.max(64,left,right)) c.label = {at:'in'};
        else if (Math.max(left,right)<MIN_LABEL) c.label = {at:'none'};
        else c.label = left>right ? {at:'left', width:left} : {at:'right', width:right};
        taken = c.x+c.width+(c.label.at==='right'?c.label.width+18:0);
      });
      // A tail stops short of whatever the row holds next: the next clip, or that clip's name when it sits on the left.
      row.forEach((c, n) => {
        const next = row[n+1];
        c.tailEnd = !next ? todayX-2 : next.label.at==='left' ? next.x-next.label.width-14 : next.x-2;
      });
    }
  }

  // Draws a clip's name. Its element reaches along the clip and tail, so the name stays on screen while any of those is.
  // `kind` is 'name' for the text, or 'plate' for the blank copy that keeps a tail from running through the text.
  function drawName(c, api, kind='name') {
    const {at, width} = c.label, name = api.esc(c.w.name);
    if (at==='none' || (at==='left' && kind==='plate')) return '';
    if (at==='left') return `<span class="name left" style="width:${Math.ceil(width)}px">${name}</span>`;
    const offset = at==='in' ? 6 : c.width+6, room = at==='in' ? c.width-12 : width+6;
    return `<span class="${kind} ${at}" style="margin-left:${offset.toFixed(1)}px;max-width:${Math.ceil(room)}px">${name}</span>`;
  }

  function drawOpenClip(c, api) {
    const w = c.w, landed = w.stage==='landed', tailWidth = c.tailEnd-c.x-c.width;
    const tail = !landed && tailWidth>=MIN_TAIL ? `<i class="tail" style="left:${c.width.toFixed(1)}px"></i>` : '';
    const reach = tail ? c.tailEnd-c.x : c.width+(c.label.at==='right'?c.label.width+12:0);
    return `<div class="piece ${landed?'landed':''} ${api.cls(w)}" data-id="${w.id}" style="left:${c.x.toFixed(1)}px;top:${c.y}px;width:${reach.toFixed(1)}px">${tail}${tail?drawName(c, api, 'plate'):''}<div class="clip" style="width:${c.width.toFixed(1)}px"></div>${drawName(c, api)}</div>`;
  }

  // Draws a finished item. A PR links to its URL, and a thread has nothing to open, so it only carries a tooltip.
  function drawDeliveredClip(c, api) {
    const w = c.w, tag = w.url ? `a href="${api.esc(w.url)}" target="_blank" rel="noreferrer"` : 'div';
    const reach = c.width+(c.label.at==='right'?c.label.width+12:0);
    return `<${tag} class="piece delivered ${w.batch?'pale':''} ${c.thin?'thin':''} ${api.cls(w)}" data-delivered="${w.index}" style="left:${c.x.toFixed(1)}px;top:${c.y}px;width:${reach.toFixed(1)}px"><div class="clip" style="width:${c.width.toFixed(1)}px"></div>${drawName(c, api)}</${w.url?'a':'div'}>`;
  }

  // Assigns pale clips to a fixed number of rows. A clip only claims the room of its name, so later clips may sit on top of its length,
  // and a clip that finds no free row goes without a name. Returns how many rows are in use.
  function packPaleClips(clips) {
    const rowEnds = [];
    clips.forEach((c, n) => {
      let row = rowEnds.findIndex(e=>e<=c.x);
      if (row<0 && rowEnds.length<PALE_ROWS) row = rowEnds.push(0)-1;
      const need = measureLabel(c.w.name);
      c.label = row<0 ? {at:'none'} : need<=c.width-12 ? {at:'in'} : {at:'right', width:need};
      c.row = row<0 ? n%PALE_ROWS : row;
      if (row>=0) rowEnds[row] = c.x+Math.max(c.width, c.label.at==='in' ? need : c.width+need)+16;
    });
    return rowEnds.length;
  }

  // Returns whether a delivered item is a tick at this zoom rather than a clip.
  function isFolded(w, zoom) {
    if (zoom>=ALL_CLIPS_ZOOM) return false;
    return w.span/DAY*zoom<MIN_CLIP || (w.batch && zoom<PALE_ZOOM);
  }

  const measureTick = count => Math.min(STRIP, TICK_SCALE*Math.cbrt(count));

  // Draws a track's folded items as columns of ticks at the moment each one ended, in three shapes that stack in one column.
  function drawStrip(t, trackIndex, time, api) {
    const shapes = {solid:'', pale:'', dim:''};
    for (const [column, items] of t.columns) {
      const matches = items.filter(api.hit), pale = matches.filter(w=>w.batch).length;
      let count = 0;
      for (const [shape, n] of [['solid',matches.length-pale],['pale',pale],['dim',items.length-matches.length]]) {
        if (!n) continue;
        const from = measureTick(count), to = measureTick(count += n);
        shapes[shape] += `M${column*COLUMN} ${(STRIP-from).toFixed(1)}v${(from-to).toFixed(1)}h${TICK}v${(to-from).toFixed(1)}z`;
      }
    }
    return `<div class="strip" data-track="${trackIndex}"><svg width="${Math.ceil(time.todayX)}" height="${STRIP}" aria-hidden="true">${Object.entries(shapes).map(([shape,d])=>`<path class="${shape}" d="${d}"/>`).join('')}</svg><i class="strip-mark" hidden></i></div>`;
  }

  // Draws a track's head: its name, and under it the three numbers in the columns the ruler names.
  // The median leaves out tidied-up threads, because their end is not when the work finished.
  function drawHead(t, api) {
    const steady = t.delivered.filter(w=>!w.batch), median = computeMedian(steady.map(w=>w.span));
    const left = t.delivered.length-steady.length;
    const note = left ? `Median of the ${steady.length} items finished one at a time. It leaves out ${left} threads marked Done in a tidy-up.` : '';
    return `<div class="head"><div class="head-text"><b ${t.init?`data-init="${t.init}"`:''} title="${api.esc(t.name)}">${api.esc(t.name)}</b>
      <div class="numbers" ${note?`title="${note}"`:''}><span>${t.delivered.length||'-'}</span><span>${median===null?'-':formatSpan(median)}</span><span>${t.pieces.length||'-'}</span></div></div></div>`;
  }

  function drawTrack(t, trackIndex, time, api) {
    const open = packOpenClips(t.pieces, time.nowMs), named = time.zoom>=NAME_ZOOM;
    const unfolded = t.delivered.filter(w=>!isFolded(w, time.zoom)), folded = t.delivered.filter(w=>isFolded(w, time.zoom));
    const buildClips = items => items.map(w=>measureClip({w, startMs:w.startMs, endMs:w.endMs, row:w.row, thin:!named}, time)).sort((a,b)=>a.x-b.x);
    const steady = buildClips(unfolded.filter(w=>!w.batch)), pale = buildClips(unfolded.filter(w=>w.batch));
    t.columns = Map.groupBy(folded, w=>Math.floor(time.xAt(w.endMs)/COLUMN));
    open.clips.forEach(c=>measureClip(c, time));
    placeLabels(open.clips, time.todayX);
    if (named) placeLabels(steady, time.todayX);
    else for (const c of steady) c.label = {at:'none'};
    const paleRows = packPaleClips(pale), steadyRows = steady.length ? Math.max(...steady.map(c=>c.row))+1 : 0;
    const steadyRow = named ? ROW : THIN_ROW, steadyTop = open.rows*ROW, paleTop = steadyTop+steadyRows*steadyRow;
    for (const c of open.clips) c.y = c.row*ROW;
    for (const c of steady) c.y = steadyTop+c.row*steadyRow;
    for (const c of pale) c.y = paleTop+c.row*ROW;
    const height = paleTop+paleRows*ROW+LANE_PADDING+(folded.length?STRIP:0);
    return `<div class="track ${t.init?'':'neutral'}" style="${t.init?`--h:${t.hue};`:''}height:${Math.max(height,MIN_TRACK)}px">
      ${drawHead(t, api)}
      <div class="lane">${open.clips.map(c=>drawOpenClip(c, api)).join('')}${pale.map(c=>drawDeliveredClip(c, api)).join('')}${steady.map(c=>drawDeliveredClip(c, api)).join('')}${folded.length?drawStrip(t, trackIndex, time, api):''}</div>
    </div>`;
  }

  // Returns the marks along the ruler at this zoom: hours when they have room, else days, else Mondays.
  function buildMarks(time) {
    const {zoom} = time, hourStep = HOUR_STEPS.find(h=>h/24*zoom>=MIN_TICK_GAP), marks = [];
    for (const midnight of time.days) {
      const date = new Date(midnight), monday = date.getDay()===1;
      if (hourStep) {
        marks.push({ms:midnight, label:'00:00', strong:true});
        for (let hour = hourStep; hour<24; hour += hourStep) marks.push({ms:new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour).getTime(), label:`${String(hour).padStart(2,'0')}:00`});
      } else if (zoom>=DAY_NUMBER_ZOOM || monday) {
        marks.push({ms:midnight, label:zoom>=WEEKDAY_ZOOM ? `${formatWeekday(midnight)} ${date.getDate()}` : String(date.getDate()), strong:monday});
      }
    }
    return {marks, hourStep};
  }

  // Draws the ruler's two lines. The upper one names the day or month, and each name stays in view while its stretch is on screen.
  function drawRuler(time, marks, hourStep) {
    const stretches = hourStep ? time.days : time.days.filter((d,n)=>n===0 || new Date(d).getDate()===1);
    const nameStretch = ms => hourStep ? `${formatWeekday(ms)} ${formatDay(ms)}` : new Date(ms).toLocaleDateString('en-GB', {month:'long'});
    const upper = stretches.map((ms,n)=>{
      const left = time.xAt(ms), right = n+1<stretches.length ? time.xAt(stretches[n+1]) : time.todayX;
      return `<div class="stretch" style="left:${left}px;width:${right-left}px"><span>${nameStretch(ms)}</span></div>`;
    }).join('');
    const lower = marks.filter(m=>time.xAt(m.ms)<time.todayX-TODAY_CHIP_ROOM).map(m=>`<span class="mark ${m.strong?'strong':''}" style="left:${time.xAt(m.ms)}px">${m.label}</span>`).join('');
    return `${upper}${lower}<span class="today" style="left:${time.todayX}px">Today</span>`;
  }

  // Draws the lines behind the lanes and a pale band for each weekend.
  function drawGrid(time, marks) {
    const lines = marks.filter(m=>m.ms<=time.nowMs).map(m=>`<i class="${m.strong?'strong':''}" style="left:${time.xAt(m.ms)}px"></i>`).join('');
    const weekends = time.days.map((d,n)=>{
      if (new Date(d).getDay()!==6) return '';
      const left = time.xAt(d), right = n+2<time.days.length ? time.xAt(time.days[n+2]) : time.todayX;
      return `<b style="left:${left}px;width:${right-left}px"></b>`;
    }).join('');
    return `<div class="grid">${weekends}${lines}</div>`;
  }

  function drawSheet(tracks, time, api) {
    const {marks, hourStep} = buildMarks(time), all = [...tracks.inits, ...tracks.loose];
    const section = (name, list) => `<div class="section"><div class="head">${name}</div><div class="lane"></div></div>${list.map(t=>drawTrack(t, all.indexOf(t), time, api)).join('')}`;
    return `<div class="ruler">
        <div class="head"><div class="numbers"><span>Delivered</span><span title="The median time from start to end. It leaves out threads marked Done in a tidy-up, because their end is not when the work finished.">Median</span><span>Open</span></div></div>
        <div class="ticks">${drawRuler(time, marks, hourStep)}</div>
      </div>
      ${drawGrid(time, marks)}
      ${section('Initiatives', tracks.inits)}
      ${section('Loose work', tracks.loose)}
      <div class="sheet-end"><div class="head"></div></div>
      <div class="playhead" style="left:${HEAD+time.todayX}px"></div>`;
  }

  // Returns the tooltip for a delivered clip. A thread has no details, so this is all there is to know about it.
  function describeDelivered(w, api) {
    const verbs = w.kind==='pr' ? ['Opened','merged'] : ['Created','marked Done'];
    const batch = w.batch ? '<em>Marked Done in a tidy-up, so that end is when you tidied up.</em>' : '';
    return `<b>${api.esc(w.name)}</b>${verbs[0]} ${formatMoment(w.startMs)}, ${verbs[1]} ${formatMoment(w.endMs)}. ${formatSpan(w.span)}.${batch}`;
  }

  function describeOpen(w, api) {
    return `<b>${api.esc(w.name)}</b>Started ${formatDay(parseStart(w.createdAt))}, last activity ${formatDay(parseStart(w.lastActivityAt))}, ${api.quiet(w)}.`;
  }

  // Returns the tooltip for one column of ticks: when, how many, and the first few names.
  function describeColumn(items, api) {
    const byEnd = [...items].sort((a,b)=>a.endMs-b.endMs), pale = items.filter(w=>w.batch).length, steady = items.length-pale;
    const counts = [steady?`${steady} delivered`:'', pale?`${pale} tidied up`:''].filter(Boolean).join(', ');
    const first = byEnd[0].endMs, last = byEnd.at(-1).endMs;
    const when = last-first<MINUTE ? formatMoment(first) : `${formatMoment(first)} to ${formatMoment(last)}`;
    const names = [...byEnd].sort((a,b)=>!!a.batch-!!b.batch).slice(0,TIP_NAMES).map(w=>`<span class="tip-name">${api.esc(w.name)}</span>`).join('');
    const more = items.length>TIP_NAMES ? `<span class="tip-name">and ${items.length-TIP_NAMES} more</span>` : '';
    return `<b>${counts}</b>${when}${names}${more}<em>Click to zoom in here.</em>`;
  }

  // Places the tooltip beside the pointer, and flips it when it would leave the window.
  function showTip(tip, html, e) {
    tip.innerHTML = html;
    tip.hidden = false;
    const {width, height} = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX+14, innerWidth-width-8)}px`;
    tip.style.top = `${e.clientY+18+height>innerHeight ? e.clientY-height-10 : e.clientY+18}px`;
  }

  // Returns the column of ticks nearest to the pointer, within two columns of it, because a tick is only three pixels wide.
  function findColumn(t, strip, e) {
    const column = Math.floor((e.clientX-strip.getBoundingClientRect().left)/COLUMN);
    return [column, column-1, column+1, column-2, column+2].find(n=>t.columns.has(n));
  }

  function renderTracks(el, api) {
    const tracks = buildTracks(api), allTracks = [...tracks.inits, ...tracks.loose], calendar = buildCalendar();
    el.innerHTML = `<div class="v-tracks">
      <div class="tk-bar">
        <div class="tk-legend">
          <div class="key"><span><i class="k-open"></i><i class="k-tail"></i>Open, then a faint line while quiet</span><span><i class="k-delivered"></i>Delivered</span><span><i class="k-ticks"></i>Too short to show here: zoom in</span><span><i class="k-pale"></i>Marked Done in a tidy-up, so the end is when you tidied up</span></div>
          <div class="hint">Start is when a PR opened or a thread was created. Neither is true conception yet, because nothing links a thread to the PR it became.</div>
        </div>
        <div class="tk-zoom"><span class="in-view"></span><button data-zoom="out" title="Zoom out">−</button><button data-zoom="in" title="Zoom in">+</button><button data-zoom="all" title="Show everything">All</button></div>
      </div>
      <div class="scroller" style="--head:${HEAD}px;--row:${ROW}px;--strip:${STRIP}px"><div class="sheet"></div></div>
      <div class="tk-tip" hidden></div>
    </div>`;
    const scroller = el.querySelector('.scroller'), sheet = el.querySelector('.sheet'), tip = el.querySelector('.tk-tip'), inView = el.querySelector('.in-view');
    scroller.style.height = `${innerHeight-scroller.getBoundingClientRect().top-window.scrollY-10}px`;
    const laneWidth = scroller.clientWidth-HEAD;
    const drawnWidth = laneWidth-LEFT_MARGIN-RIGHT_MARGIN, fullZoom = drawnWidth/((calendar.nowMs-calendar.firstMs)/DAY);
    const clampZoom = zoom => Math.min(MAX_ZOOM, Math.max(fullZoom, zoom));
    let zoom = clampZoom(api.load('pxPerDay', null) ?? drawnWidth/DEFAULT_SPAN_DAYS);
    const xAt = ms => LEFT_MARGIN+(ms-calendar.firstMs)/DAY*zoom;
    const timeAt = x => calendar.firstMs+(x-LEFT_MARGIN)/zoom*DAY;

    const draw = () => {
      const todayX = xAt(calendar.nowMs);
      sheet.style.width = `${HEAD+todayX+RIGHT_MARGIN}px`;
      sheet.innerHTML = drawSheet(tracks, {...calendar, zoom, xAt, todayX}, api);
      inView.textContent = `${formatSpan(laneWidth/zoom*DAY)} in view`;
    };
    draw();
    scroller.scrollTop = scrollTop;
    scroller.scrollLeft = leftEdgeMs===null ? scroller.scrollWidth : xAt(leftEdgeMs);
    scroller.onscroll = () => { scrollTop = scroller.scrollTop; leftEdgeMs = timeAt(scroller.scrollLeft); };

    // Keeps one moment at one spot on screen while the zoom changes. `spot` is measured from the left edge of the lanes.
    const zoomTo = (next, spot) => {
      const anchorMs = timeAt(scroller.scrollLeft+spot);
      zoom = clampZoom(next);
      api.store('pxPerDay', zoom);
      draw();
      scroller.scrollLeft = xAt(anchorMs)-spot;
    };
    // The buttons hold today in place while it is on screen, because recent work is what zooming in is usually for.
    const findButtonSpot = () => {
      const today = xAt(calendar.nowMs)-scroller.scrollLeft;
      return today>=0 && today<=laneWidth ? today : laneWidth/2;
    };
    el.querySelector('.tk-zoom').onclick = e => {
      const button = e.target.closest('[data-zoom]');
      if (!button) return;
      if (button.dataset.zoom==='all') zoomTo(fullZoom, 0);
      else zoomTo(zoom*(button.dataset.zoom==='in'?ZOOM_STEP:1/ZOOM_STEP), findButtonSpot());
    };

    // A pinch arrives as many small wheel events, so they are added up and drawn once per frame.
    let wheelZoom = null, wheelSpot = 0;
    scroller.onwheel = e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      wheelSpot = e.clientX-scroller.getBoundingClientRect().left-HEAD;
      if (wheelZoom===null) requestAnimationFrame(()=>{ zoomTo(wheelZoom, wheelSpot); wheelZoom = null; });
      wheelZoom = (wheelZoom ?? zoom)*Math.exp(-e.deltaY*.004);
    };

    const hideStripMarks = () => { for (const mark of sheet.querySelectorAll('.strip-mark')) mark.hidden = true; };
    scroller.onmousemove = e => {
      const target = e.target.closest('.strip,[data-delivered],[data-id]');
      hideStripMarks();
      if (!target) { tip.hidden = true; return; }
      if (target.dataset.id) return showTip(tip, describeOpen(api.pieces().find(w=>w.id===target.dataset.id), api), e);
      if (target.dataset.delivered) return showTip(tip, describeDelivered(readDelivered()[target.dataset.delivered], api), e);
      const t = allTracks[target.dataset.track], column = findColumn(t, target, e);
      if (column===undefined) { tip.hidden = true; return; }
      const mark = target.querySelector('.strip-mark');
      mark.hidden = false;
      mark.style.left = `${column*COLUMN-1}px`;
      showTip(tip, describeColumn(t.columns.get(column), api), e);
    };
    scroller.onmouseleave = () => { tip.hidden = true; hideStripMarks(); };
    scroller.onclick = e => {
      const strip = e.target.closest('.strip');
      if (!strip) return;
      tip.hidden = true;
      zoomTo(zoom*ZOOM_STEP*ZOOM_STEP, e.clientX-scroller.getBoundingClientRect().left-HEAD);
    };
  }

  addEventListener('resize', () => { if (document.body.dataset.view === 'tracks') shellApi?.rerender(); });

  Shell.register({ id:'tracks', label:'Track arrangement', render(el, api) {
    shellApi = api;
    // The view's stylesheet can arrive after the first draw, and everything here measures the laid-out page.
    const stylesheet = document.querySelector('link[href="views/tracks.css"]');
    if (!stylesheet.sheet) { stylesheet.addEventListener('load', () => api.rerender(), {once:true}); return; }
    renderTracks(el, api);
  }});
}
