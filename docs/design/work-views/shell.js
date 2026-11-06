// PROTOTYPE shell. Holds the data, the changes kept in this browser, the details drawer and the view switcher.
// A view registers itself with Shell.register and draws through the api below. See CONTRACT.md.
const STAGES = [['exploring','Exploring'],['planned','Planned'],['building','Building'],['reviewing','In review'],['landed','Landed']];
const MOVES = [['you','You'],['agent','An agent'],['others','Others'],['nobody','Nobody']];
const NEEDS = [['think','Real thinking'],['quick','A quick call'],['look','Just a look'],['nothing','Nothing']];
const PROJECTS = ['platform','storefront','ops','Insights','field-app'];
const KEY = 'PROTOTYPE-wipe-me-work-v3';
const q = new URLSearchParams(location.search);
const registered = {}, sheets = [];
let order = [], view = q.get('view') || 'home';
let saved = JSON.parse(localStorage.getItem(KEY) || '{"items":{},"scribbles":[],"views":{}}');
let selected = null, selectedInit = null, search = '', filter = '';
let wear = q.get('wear') === '1', fog = q.get('fog') === '1';

const save = () => localStorage.setItem(KEY, JSON.stringify(saved));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const days = d => d ? Math.max(0, Math.round((new Date('2026-11-04') - new Date(d))/864e5)) : null;
const pieces = () => WORK.map(w=>({...w, ...(saved.items[w.id]||{})})).filter(w=>!w.ended).sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''));
const planName = w => INITIATIVES.find(i=>i.id===w.initiative)?.name || '';
const hit = w => (!search || (w.name+' '+w.what+' '+w.where+' '+w.project+' '+planName(w)).toLowerCase().includes(search)) && (!filter || (filter==='stalled' ? w.stalled : w.need===filter));
const quietDays = w => days(w.lastActivityAt);
const quiet = w => { const d = quietDays(w); return d===null ? '' : d===0 ? 'today' : `quiet ${d}d`; };
const hue = id => { const i = INITIATIVES.findIndex(x=>x.id===id); return i<0 ? 40 : Math.round(i*360/INITIATIVES.length + 20) % 360; };
function initiatives() {
  const all = pieces();
  return INITIATIVES.map(i=>({...i, pieces:all.filter(w=>w.initiative===i.id)}));
}
function groups() {
  const all = pieces(), inits = initiatives();
  return PROJECTS.map(p=>({project:p, inits:inits.filter(i=>i.project===p && i.pieces.length), loose:all.filter(w=>!w.initiative && w.project===p)})).filter(g=>g.inits.length||g.loose.length);
}
const progress = i => i.total ? `<div class="bar"><i style="width:${Math.round(100*i.done/i.total)}%"></i></div><div class="prog">${esc(i.progress)}</div>` : (i.target ? `<div class="prog">Target: ${esc(i.target)}</div>` : '');
// A bullet graph: a dark bar for what is done, a marker for the target, and a pale band for what is in flight.
const bullet = i => {
  if (!i.total) return i.target ? `<div class="prog">Target: ${esc(i.target)}, nothing measured yet</div>` : '';
  const open = (i.pieces||[]).filter(w=>w.stage!=='landed').length, done = 100*i.done/i.total, flight = Math.min(100, 100*(i.done+open)/i.total);
  return `<div class="bullet" title="${esc(i.progress)}"><div class="band" style="width:${flight}%"></div><div class="val" style="width:${done}%"></div><div class="tgt" style="left:calc(100% - 2px)"></div></div><div class="prog">${esc(i.progress)}</div>`;
};
const cls = w => [
  hit(w) ? '' : 'dim',
  wear ? (quietDays(w)>=21 ? 'wear3' : quietDays(w)>=14 ? 'wear2' : quietDays(w)>=7 ? 'wear1' : '') : '',
  fog && w.stage==='exploring' ? 'fog' : '',
  w.need==='think'||w.need==='quick' ? w.need : '',
].filter(Boolean).join(' ');

const api = {
  stages:STAGES, moves:MOVES, needs:NEEDS, esc, pieces, initiatives, groups, cls, hit, quiet, quietDays, progress, bullet, days,
  relations:()=>RELATIONS, selected:()=>selected,
  hue, color:(id,l=45,s=45)=>`hsl(${hue(id)} ${s}% ${l}%)`,
  open:id=>{ selected=id; selectedInit=null; render(); }, openInit:id=>{ selected=null; selectedInit=id; render(); },
  load:(k,d)=>(saved.views[view]||{})[k] ?? d, store:(k,v)=>{ (saved.views[view] ||= {})[k]=v; save(); }, rerender:()=>render(),
};
const Shell = {
  register(v) {
    registered[v.id] = v;
    if (v.css === false) return;
    const l = document.createElement('link'); l.rel='stylesheet'; l.href=`views/${v.id}.css`;
    sheets.push(new Promise(done => { l.onload = l.onerror = done; }));
    document.head.append(l);
  },
  // Waits for every view's stylesheet, so the first render is never drawn unstyled.
  async start(files) {
    await Promise.all(sheets);
    order = files.filter(f=>registered[f]);
    if (!registered[view]) view = order[0];
    document.getElementById('viewPick').innerHTML = order.map(f=>`<option value="${f}">${esc(registered[f].label)}</option>`).join('');
    render();
  },
};
function linksOf(w) {
  const t = (w.threads||[]).map(x=>`<span class="link">Thread: ${esc(x.title)} <em>${esc(x.id)}</em></span>`).join('');
  const l = (w.links||[]).map(k=>k.url?`<a class="link" href="${esc(k.url)}" target="_blank" rel="noreferrer">${esc(k.label)} <em>${esc(k.state||'')}</em></a>`:`<span class="link">${esc(k.label)} <em>${esc(k.state||'')}</em></span>`).join('');
  return t||l ? `<div class="lbl2">Linked</div>${t}${l}` : '';
}
function relationsOf(w) {
  const all = pieces(), name = id => all.find(x=>x.id===id);
  const list = (label, ids) => ids.length ? `<div class="lbl2">${label}</div>` + ids.map(name).filter(Boolean).map(x=>`<span class="chip ${x.need}" data-id="${x.id}">${esc(x.name)}</span>`).join('') : '';
  return list('Blocked by', RELATIONS.filter(r=>r.kind==='blockedBy'&&r.from===w.id).map(r=>r.to))
    + list('Blocks', RELATIONS.filter(r=>r.kind==='blockedBy'&&r.to===w.id).map(r=>r.from))
    + list('Linked (weak)', RELATIONS.filter(r=>r.kind==='linked'&&(r.from===w.id||r.to===w.id)).map(r=>r.from===w.id?r.to:r.from));
}
function renderDrawer() {
  const d = document.getElementById('drawer');
  const w = pieces().find(x=>x.id===selected), i = !w && selectedInit && initiatives().find(x=>x.id===selectedInit);
  d.hidden = !w && !i;
  if (i) {
    d.innerHTML = `<button class="x" data-close>Esc</button><h2>${esc(i.name)}</h2><div style="color:var(--mute)">${esc(i.project)} · my guess, regroup freely</div>
      <div class="lbl2">Intent</div>${esc(i.intent)}${i.target?`<div class="lbl2">Target</div>${esc(i.target)}`:''}${i.progress?`<div class="lbl2">Progress</div>${bullet(i)}`:''}
      ${STAGES.map(([s,l])=>{ const ws=i.pieces.filter(x=>x.stage===s); return ws.length?`<div class="lbl2">${l} ${ws.length}</div>`+ws.map(x=>`<span class="chip ${x.need}" data-id="${x.id}">${esc(x.name)}</span>`).join(''):''; }).join('')}`;
    return;
  }
  if (!w) return;
  const pick = (k,label,list) => `<span>${label}</span><select data-word="${k}">${list.map(x=>`<option value="${x[0]}" ${w[k]===x[0]?'selected':''}>${x[1]}</option>`).join('')}</select>`;
  const init = INITIATIVES.find(x=>x.id===w.initiative);
  d.innerHTML = `<button class="x" data-close>Esc</button>${init?`<span class="up" data-init="${init.id}">↑ ${esc(init.name)}</span>`:''}<h2>${esc(w.name)}</h2><div style="color:var(--mute)">${esc(w.project)} · ${quiet(w)}${w.stalled?' · stalled':''}</div>
    <div class="lbl2">What it is</div>${esc(w.what)}<div class="lbl2">Where it stands</div>${esc(w.where)}<div class="lbl2">What is left</div>${esc(w.left)}
    ${w.ask?`<div class="lbl2">Needed from you</div><b>${esc(w.ask)}</b>`:''}${w.whyStalled?`<div class="lbl2">Why it may be lying around</div>${esc(w.whyStalled)}`:''}
    ${(w.context||[]).length?`<ul style="margin:8px 0;padding-left:18px">${w.context.map(c=>`<li>${esc(c)}</li>`).join('')}</ul>`:''}
    ${relationsOf(w)}${linksOf(w)}
    <div class="lbl2">Words</div><div class="words">${pick('stage','Stage',STAGES)}${pick('move','Whose move',MOVES)}${pick('need','What it needs',NEEDS)}
      <span>Initiative</span><select data-word="initiative"><option value="">None</option>${INITIATIVES.map(x=>`<option value="${x.id}" ${w.initiative===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>
    <div class="lbl2">Is this wrong? Say what you see</div><textarea data-note placeholder="Noted here so we can look at it together">${esc(w.note||'')}</textarea>
    <div class="drow"><button data-act="done">Done</button><button data-act="drop">Drop</button></div>`;
}
function render() {
  const main = document.getElementById('main'), v = registered[view];
  document.body.dataset.view = view;
  document.getElementById('viewPick').value = view;
  document.getElementById('wear').checked = wear;
  document.getElementById('scribbleList').innerHTML = `<div>Scribbles are not work. Enter keeps one.</div>` + saved.scribbles.slice(-6).reverse().map(s=>`<div>${esc(s)}</div>`).join('');
  main.innerHTML = ''; v.render(main, api);
  renderDrawer();
  const u = new URL(location); u.searchParams.set('view',view); history.replaceState(null,'',u);
}
const change = (id, patch) => { saved.items[id] = {...(saved.items[id]||{}), ...patch}; save(); render(); };
const step = n => { view = order[(order.indexOf(view)+n+order.length)%order.length]; render(); };
document.getElementById('prev').onclick = () => step(-1);
document.getElementById('next').onclick = () => step(1);
document.getElementById('viewPick').onchange = e => { view = e.target.value; render(); e.target.blur(); };
document.getElementById('wear').onchange = e => { wear = e.target.checked; render(); };
document.getElementById('find').oninput = e => { search = e.target.value.toLowerCase(); render(); };
document.getElementById('filter').onchange = e => { filter = e.target.value; render(); };
document.getElementById('reset').onclick = () => { if (confirm('Forget every change made here?')) { saved = {items:{},scribbles:[],views:{}}; save(); render(); } };
document.addEventListener('click', e => {
  const t = e.target.closest('[data-id],[data-init],[data-act],[data-close]');
  if (!t || e.defaultPrevented) return;
  if (t.dataset.close !== undefined) { selected = selectedInit = null; return render(); }
  if (t.dataset.act) { const id = selected; selected = null; return change(id, {ended:t.dataset.act}); }
  if (t.dataset.id) { selected = t.dataset.id; selectedInit = null; return render(); }
  if (t.dataset.init) { selected = null; selectedInit = t.dataset.init; return render(); }
});
document.addEventListener('change', e => {
  if (e.target.dataset.word) change(selected, {[e.target.dataset.word]:e.target.value});
  if (e.target.dataset.note !== undefined) change(selected, {note:e.target.value});
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'scribble' && e.key === 'Enter' && e.target.value.trim()) { saved.scribbles.push(e.target.value.trim()); e.target.value=''; save(); render(); return; }
  if (e.key === 'Escape') { selected = selectedInit = null; render(); }
  if (e.target.matches('input,textarea,select')) return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
