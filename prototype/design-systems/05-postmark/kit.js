// PROTOTYPE - Postmark's page kit. Loaded with `defer` by every page after brands.js.
//
// It does four things, so the pages stay short and every page draws the same parts the same way:
// 1. injects one SVG sprite (state marks, entity glyphs, interface icons, brand marks, the logo);
// 2. expands shorthand: <i data-m="done"></i>, <span class="post" data-src="sentry" data-n="412">,
//    <span data-postmark data-top="TRIAGE" data-mid="09:00" data-bot="29 SEP">;
// 3. renders the shared chrome: [data-kit="sidebar|status|home|tabbar"];
// 4. runs the glass composer: while the transcript scrolls, the composer shrinks and turns
//    see-through; at the bottom, or on focus, it restores. ?state=scrolled forces the shrunk state.
(function () {
  "use strict";

  // ---------- 1. The sprite ----------
  // State marks are small rubber stamps on a 16px grid: a 6.6 ring with a glyph inside.
  // Filled roundels are settled or waiting on you (done, failed, decision); outlined ones are
  // in progress or pending. The glyph is knocked out of filled roundels with a mask, so it shows
  // whatever paper sits behind it.
  const ring = '<circle cx="8" cy="8" r="6.35" fill="none" stroke="currentColor" stroke-width="1.3"/>';
  const knock = (id, glyph) =>
    `<mask id="k-${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16"><rect width="16" height="16" fill="#fff"/>${glyph}</mask>` +
    `<circle cx="8" cy="8" r="7" fill="currentColor" mask="url(#k-${id})"/>`;
  const icon = (d, extra = "") =>
    `<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d
      .split("|")
      .map((p) => `<path d="${p}"/>`)
      .join("")}${extra}</g>`;

  const symbols = {
    // state marks
    working:
      ring +
      '<g fill="currentColor" class="eq"><rect class="eq1" x="4.6" y="6.4" width="1.5" height="3.2" rx=".75"/><rect class="eq2" x="7.25" y="4.7" width="1.5" height="6.6" rx=".75"/><rect class="eq3" x="9.9" y="5.9" width="1.5" height="4.2" rx=".75"/></g>',
    decision: knock(
      "q",
      '<path d="M6.15 6.35a1.95 1.95 0 1 1 2.75 1.8c-.55.28-.9.68-.9 1.3v.25" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.55" r=".95" fill="#000"/>',
    ),
    queued: '<circle cx="8" cy="8" r="6.35" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.2 1.95"/>',
    paused: ring + '<path d="M6.4 5.4v5.2M9.6 5.4v5.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    done: knock("d", '<path d="m4.9 8.2 2.1 2.1 4.1-4.5" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
    failed: knock("x", '<path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round"/>'),
    cancelled: ring + '<path d="M5.4 8h5.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    skipped: ring + '<path d="m5.2 5.7 2.3 2.3-2.3 2.3M8.5 5.7l2.3 2.3-2.3 2.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    idle: '<circle cx="8" cy="8" r="2.4" fill="currentColor"/>',
    burning: knock("b", '<path d="M8 4.2v4.6" stroke="#000" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.3" r="1" fill="#000"/>'),

    // entity glyphs
    task: icon("M4.2 2.6h5.2l3 3v7.3a.5.5 0 0 1-.5.5H4.2a.5.5 0 0 1-.5-.5V3.1a.5.5 0 0 1 .5-.5z|M9.2 2.7v3.1h3.1|M5.9 9h4.2|M5.9 11h2.6"),
    run: icon("M4.6 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1l-7.6-4.8a.6.6 0 0 0-.9.5z"),
    session: icon("M4 3h8a1.6 1.6 0 0 1 1.6 1.6v4.6A1.6 1.6 0 0 1 12 10.8H7.4l-3 2.5v-2.5H4a1.6 1.6 0 0 1-1.6-1.6V4.6A1.6 1.6 0 0 1 4 3z"),
    workflow: icon("M4.9 8h3.3l2.4-3.2M8.2 8l2.4 3.2", '<circle cx="3.4" cy="8" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12.3" cy="3.9" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12.3" cy="12.1" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
    proposal: icon("M2.4 4.4h11.2v7.8a.6.6 0 0 1-.6.6H3a.6.6 0 0 1-.6-.6z|m2.6 4.6 5.4 4.1 5.4-4.1"),
    offer: icon("M3 5.2h10v7.6a.6.6 0 0 1-.6.6H3.6a.6.6 0 0 1-.6-.6z|M2.4 3h11.2v2.2H2.4z|M8 3v10.4|M8 3C6.8 1.2 4.6 1.6 5.4 3|M8 3c1.2-1.8 3.4-1.4 2.6 0"),
    tag: '<path fill="currentColor" fill-rule="evenodd" d="M1.6 8 5.2 4.1a1.2 1.2 0 0 1 .9-.4h7.3c.66 0 1.2.54 1.2 1.2v6.2c0 .66-.54 1.2-1.2 1.2H6.1a1.2 1.2 0 0 1-.9-.4zm5.3 0a1.05 1.05 0 1 0 0-.01z"/>',

    // interface icons
    plus: icon("M8 3.2v9.6M3.2 8h9.6"),
    "chev-down": icon("m4.6 6.4 3.4 3.4 3.4-3.4"),
    "chev-right": icon("m6.4 4.6 3.4 3.4-3.4 3.4"),
    "chev-left": icon("M9.6 4.6 6.2 8l3.4 3.4"),
    "chev-up": icon("m4.6 9.6 3.4-3.4 3.4 3.4"),
    "arrow-right": icon("M3 8h10M9.2 4.2 13 8l-3.8 3.8"),
    "arrow-up": icon("M8 13V3.4M4.2 7.2 8 3.4l3.8 3.8"),
    search: icon("M7.1 11.6a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z|m10.4 10.4 3 3"),
    mic: icon("M8 2.4a2 2 0 0 1 2 2v3.4a2 2 0 0 1-4 0V4.4a2 2 0 0 1 2-2z|M4.2 7.6a3.8 3.8 0 0 0 7.6 0|M8 11.4v2.2"),
    stop: '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.3" fill="currentColor"/>',
    sidebar: icon("M3 3h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z|M6.2 3v10"),
    gear: icon("M8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2z|M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.15 1.15M11.25 11.25l1.15 1.15M3.6 12.4l1.15-1.15M11.25 4.75l1.15-1.15"),
    bell: icon("M4.2 11.2V7.4a3.8 3.8 0 0 1 7.6 0v3.8l1 1.2H3.2z|M6.6 13.6a1.5 1.5 0 0 0 2.8 0"),
    branch: icon("M5 2.8v10.4|M11 6.2c0 3-6 2.4-6 6", '<circle cx="11" cy="4.4" r="1.7" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
    machine: icon("M2.6 3.4h10.8v7H2.6z|M5.6 13h4.8|M8 10.4V13"),
    worktree: icon("M2.4 4.2a1 1 0 0 1 1-1h3l1.3 1.4h4.9a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z|M8 7.2v3.2M6.4 8.8h3.2"),
    clock: icon("M8 13.6a5.6 5.6 0 1 0 0-11.2 5.6 5.6 0 0 0 0 11.2z|M8 4.8V8l2.2 1.4"),
    lock: icon("M4 7.2h8v6H4z|M5.6 7.2V5.4a2.4 2.4 0 0 1 4.8 0v1.8"),
    more: '<g fill="currentColor"><circle cx="3.6" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/><circle cx="12.4" cy="8" r="1.15"/></g>',
    check: icon("m3.4 8.4 3 3 6.2-6.8"),
    x: icon("m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"),
    filter: icon("M2.6 3.6h10.8L9.2 8.6v4.2l-2.4-1.2v-3z"),
    external: icon("M9.2 2.8h4v4|M13.2 2.8 7.6 8.4|M11.6 9.6v2.8a.8.8 0 0 1-.8.8H3.6a.8.8 0 0 1-.8-.8V5.2a.8.8 0 0 1 .8-.8h2.8"),
    bolt: icon("M8.8 1.8 3.6 9h4l-.8 5.2L12.4 7h-4z"),
    moon: icon("M12.8 9.6A5.2 5.2 0 0 1 6.4 3.2a5.2 5.2 0 1 0 6.4 6.4z"),
    pulse: icon("M1.8 8.4h2.6l1.6-3.6 2.4 7 1.8-4.6 1 1.2h2.4"),
    reply: icon("M6.4 4.2 2.8 7.6l3.6 3.4|M3 7.6h6.2a4 4 0 0 1 4 4v.8"),
    calendar: icon("M2.8 3.8h10.4v9.4H2.8z|M2.8 6.6h10.4|M5.4 2.4v2.6M10.6 2.4v2.6"),
    key: icon("M5.6 10.6a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z|M8.2 7.8h5.4v2|M11.4 7.8v1.6"),
    shield: icon("M8 2.2 13 4v3.8c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z"),
    plug: icon("M5.6 2.4v3M10.4 2.4v3|M3.8 5.4h8.4v2.2a4.2 4.2 0 0 1-8.4 0z|M8 11.8v2"),
    user: icon("M8 7.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z|M2.8 13.6c.6-2.6 2.6-4 5.2-4s4.6 1.4 5.2 4"),
    palette: icon("M8 2.4a5.6 5.6 0 0 0 0 11.2c.9 0 1.3-.6 1.3-1.2 0-.9-.8-1.1-.8-1.9 0-.6.5-1.1 1.2-1.1h1.6a2.4 2.4 0 0 0 2.4-2.4c0-2.6-2.5-4.6-5.7-4.6z", '<g fill="currentColor"><circle cx="5.1" cy="7.3" r=".9"/><circle cx="7.2" cy="5" r=".9"/><circle cx="10.2" cy="5.3" r=".9"/></g>'),
    threads: icon("M3.2 3.4h9.6a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1H8.4l-3 2.4v-2.4H3.2a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1z|M5 6h6M5 8h3.8"),
    fleet: icon("M2.6 3h10.8v4H2.6z|M2.6 9h10.8v4H2.6z", '<g fill="currentColor"><circle cx="4.8" cy="5" r=".8"/><circle cx="4.8" cy="11" r=".8"/></g>'),
    connection: icon("M6.4 9.6 9.6 6.4|M7.2 4.4l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7l-1.2 1.2|M8.8 11.6l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2"),
    intake: icon("M2.4 9.4 4.2 3.6h7.6l1.8 5.8v3.4a.6.6 0 0 1-.6.6H3a.6.6 0 0 1-.6-.6z|M2.4 9.4h3.4l.8 1.6h2.8l.8-1.6h3.4"),
    checkin: icon("M8 13.6a5.6 5.6 0 1 0 0-11.2 5.6 5.6 0 0 0 0 11.2z|m5.4 8.2 1.8 1.8 3.4-3.8"),
    compose: icon("M11 2.6 13.4 5l-6.8 6.8-3 .6.6-3z|M9.6 4 12 6.4"),
    "folder-plus": icon("M2.4 4.2a1 1 0 0 1 1-1h3l1.3 1.4h4.9a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z|M8 7v3.6M6.2 8.8h3.6"),
    heart: icon("M8 13.2S2.4 10 2.4 6.2A2.8 2.8 0 0 1 8 4.6a2.8 2.8 0 0 1 5.6 1.6C13.6 10 8 13.2 8 13.2z"),
    memory: icon("M3.4 2.8h9.2v10.4H3.4z|M5.6 5.6h4.8M5.6 8h4.8M5.6 10.4h2.8"),
    "rotate": icon("M12.8 7.2A4.8 4.8 0 0 0 4 5.2|M3.2 2.8v2.6h2.6|M3.2 8.8A4.8 4.8 0 0 0 12 10.8|M12.8 13.2v-2.6h-2.6"),
    phone: icon("M5 1.8h6a1 1 0 0 1 1 1v10.4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z|M7 12h2"),
    globe: icon("M8 13.6a5.6 5.6 0 1 0 0-11.2 5.6 5.6 0 0 0 0 11.2z|M2.4 8h11.2|M8 2.4c1.6 1.6 2.3 3.5 2.3 5.6S9.6 12 8 13.6C6.4 12 5.7 10.1 5.7 8S6.4 4 8 2.4z"),
    minus: icon("M3.2 8h9.6"),
    haptic: icon("M5.4 3.4v9.2|M10.6 3.4v9.2|M2.8 5.8v4.4|M13.2 5.8v4.4"),
    swipe: icon("M3 8h9|M9.4 5.2 12.2 8l-2.8 2.8"),
    cron: icon("M8 13.6a5.6 5.6 0 1 0 0-11.2 5.6 5.6 0 0 0 0 11.2z|M8 4.6V8h2.8"),
    webchat: icon("M3 3.2h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8.6l-3.2 2.4v-2.4H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z", '<g fill="currentColor"><circle cx="5.4" cy="7.2" r=".85"/><circle cx="8" cy="7.2" r=".85"/><circle cx="10.6" cy="7.2" r=".85"/></g>'),
    pi: '<path d="M2.6 5.2h10.8M5.6 5.2v7.4M10.2 5.2v6a1.4 1.4 0 0 0 2.4 1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  };

  // Brand marks live on a 24px grid; they are wrapped so every symbol shares one viewBox.
  const brands = window.POSTMARK_BRANDS || {};
  for (const [name, d] of Object.entries(brands)) {
    symbols["b-" + name] = `<g transform="scale(.6667)"><path fill="currentColor" d="${d}"/></g>`;
  }
  symbols["b-cron"] = symbols.cron;
  symbols["b-webchat"] = symbols.webchat;
  symbols["b-pi"] = symbols.pi;

  // The logo: a postmark roundel. Two rings, the name set around the top arc, the place and
  // date line around the bottom, and a heavy H at the centre - the mark Hercule stamps on things.
  const logo = `
    <symbol id="logo" viewBox="0 0 64 64">
      <defs>
        <path id="logo-top" d="M12.2 32a19.8 19.8 0 0 1 39.6 0"/>
        <path id="logo-bot" d="M9.6 32a22.4 22.4 0 0 0 44.8 0"/>
      </defs>
      <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" stroke-width="2.6"/>
      <circle cx="32" cy="32" r="15.2" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text font-family="Archivo Narrow, Archivo, sans-serif" font-weight="700" font-size="9" letter-spacing="1.9" fill="currentColor" text-anchor="middle"><textPath href="#logo-top" startOffset="50%">HERCULE</textPath></text>
      <g fill="currentColor"><circle cx="9" cy="32" r="1.3"/><circle cx="55" cy="32" r="1.3"/></g>
      <path fill="currentColor" d="M24.6 23.4h4.3v6.6h6.2v-6.6h4.3v17.2h-4.3v-6.9h-6.2v6.9h-4.3z"/>
      <path d="M17 45.2c3 1.8 6 1.8 9 0s6-1.8 9 0 6 1.8 9 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </symbol>
    <symbol id="waves" viewBox="0 0 64 28">
      <g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <path d="M2 4c5 3.2 10 3.2 15 0s10-3.2 15 0 10 3.2 15 0 10-3.2 15 0"/>
        <path d="M2 14c5 3.2 10 3.2 15 0s10-3.2 15 0 10 3.2 15 0 10-3.2 15 0"/>
        <path d="M2 24c5 3.2 10 3.2 15 0s10-3.2 15 0 10 3.2 15 0 10-3.2 15 0"/>
      </g>
    </symbol>
    ${buildAppIcon()}
    ${buildMenuBarMark()}`;

  // Punches perforation holes along the four edges of a stamp: circles centred on the edge,
  // one per pitch, drawn black so a mask cuts them out of the paper.
  function punchHoles(x, y, w, h, r, pitch) {
    let holes = "";
    for (let i = pitch / 2; i < w; i += pitch)
      holes += `<circle cx="${x + i}" cy="${y}" r="${r}"/><circle cx="${x + i}" cy="${y + h}" r="${r}"/>`;
    for (let i = pitch / 2; i < h; i += pitch)
      holes += `<circle cx="${x}" cy="${y + i}" r="${r}"/><circle cx="${x + w}" cy="${y + i}" r="${r}"/>`;
    return holes;
  }

  // The app icon: the corner of a manila envelope. A violet stamp with the H, cancelled by a
  // postmark whose waves run across it. Fixed colours: an icon does not change with the theme.
  function buildAppIcon() {
    return `
    <symbol id="appicon" viewBox="0 0 100 100">
      <defs>
        <linearGradient id="ai-paper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="oklch(95% 0.035 80)"/><stop offset="1" stop-color="oklch(86% 0.06 72)"/>
        </linearGradient>
        <linearGradient id="ai-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="oklch(58% 0.2 298)"/><stop offset="1" stop-color="oklch(47% 0.2 292)"/>
        </linearGradient>
        <mask id="ai-perf" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect x="33" y="16" width="46" height="56" fill="#fff"/>
          <g fill="#000">${punchHoles(33, 16, 46, 56, 2.3, 5.75)}</g>
        </mask>
        <filter id="ai-shadow" x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy="1.2" stdDeviation="1.1" flood-color="oklch(35% 0.06 60)" flood-opacity=".35"/>
        </filter>
      </defs>
      <rect width="100" height="100" rx="22.5" fill="url(#ai-paper)"/>
      <rect x=".5" y=".5" width="99" height="99" rx="22" fill="none" stroke="oklch(100% 0 0 / .5)"/>
      <g transform="rotate(-6 56 44)" filter="url(#ai-shadow)">
        <rect x="33" y="16" width="46" height="56" fill="oklch(98.5% 0.01 85)" mask="url(#ai-perf)"/>
        <rect x="38" y="21" width="36" height="46" rx="1" fill="url(#ai-face)"/>
        <path fill="oklch(98.5% 0.01 85)" d="M46.4 30.6h5.4v8.3h8.4v-8.3h5.4V57h-5.4V44.4h-8.4V57h-5.4z"/>
      </g>
      <g fill="none" stroke="oklch(27% 0.06 292)" stroke-opacity=".9" stroke-linecap="round">
        <circle cx="33" cy="66" r="18" stroke-width="2.8"/>
        <circle cx="33" cy="66" r="11.5" stroke-width="1.4"/>
        <path stroke-width="2.4" d="M53 60c4 2.6 8 2.6 12 0s8-2.6 12 0 8 2.6 12 0M53 68.5c4 2.6 8 2.6 12 0s8-2.6 12 0 8 2.6 12 0M53 77c4 2.6 8 2.6 12 0s8-2.6 12 0 8 2.6 12 0"/>
      </g>
      <path id="ai-arc" d="M18.4 66a14.6 14.6 0 0 1 29.2 0" fill="none"/>
      <g fill="oklch(27% 0.06 292)" fill-opacity=".9" font-family="Archivo Narrow, Archivo, sans-serif" font-weight="700" text-anchor="middle">
        <text font-size="5.6" letter-spacing=".9"><textPath href="#ai-arc" startOffset="50%">HERCULE</textPath></text>
        <text x="33" y="70.2" font-size="10.5" letter-spacing="-.2">09:41</text>
      </g>
    </symbol>`;
  }

  // The menu bar mark: a template image, one colour, drawn on the 16px grid. A perforated stamp
  // with the H cut out of it.
  function buildMenuBarMark() {
    return `
    <symbol id="menubar-mark" viewBox="0 0 16 16">
      <defs>
        <mask id="mb-perf" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <rect x="2.2" y="1.4" width="11.6" height="13.2" fill="#fff"/>
          <g fill="#000">${punchHoles(2.2, 1.4, 11.6, 13.2, 0.72, 2.32)}</g>
          <path fill="#000" d="M5.5 4.4h1.6v2.8h1.8V4.4h1.6v7.2H8.9V8.7H7.1v2.9H5.5z"/>
        </mask>
      </defs>
      <rect x="2.2" y="1.4" width="11.6" height="13.2" rx=".6" fill="currentColor" mask="url(#mb-perf)"/>
    </symbol>`;
  }

  const sprite =
    '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">' +
    Object.entries(symbols)
      .map(([id, body]) => `<symbol id="${id}" viewBox="0 0 16 16">${body}</symbol>`)
      .join("") +
    logo +
    "</svg>";
  document.body.insertAdjacentHTML("afterbegin", sprite);

  const use = (id, cls = "mk") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
  window.postmarkIcon = use;

  // ---------- 3. Shared chrome ----------
  // Chrome is rendered before shorthand expansion, so its own [data-m] shorthand expands too.
  const projects = {
    webshop: "webshop",
    payments: "payments-api",
    ops: "ops",
  };

  function renderSidebar(el) {
    const face = el.dataset.face || "hercule";
    const active = el.dataset.active || "";
    const web = el.dataset.web !== undefined;
    const on = (id) => (id === active ? " is-on" : "");
    const top = web
      ? `<div class="side-brand"><svg class="logo"><use href="#logo"/></svg><span class="wordmark">Hercule</span><kbd class="side-kbd">⌘K</kbd></div>`
      : `<div class="side-top"><span class="traffic"><i></i><i></i><i></i></span><button class="icon-btn" aria-label="Hide sidebar">${use("sidebar")}</button></div>`;
    const faces = `
      <div class="faces" role="tablist">
        <button role="tab" class="${face === "threads" ? "is-on" : ""}">Threads</button>
        <button role="tab" class="${face === "hercule" ? "is-on" : ""}">Hercule${face === "threads" ? '<b class="leak">3</b>' : ""}</button>
      </div>`;
    const threads = `
      <div class="side-new">
        <button class="side-row new-thread${on("new")}">${use("compose")}<span>New thread</span><kbd>⌘N</kbd></button>
        <button class="icon-btn" aria-label="New project">${use("folder-plus")}</button>
      </div>
      <div class="side-scroll">
        <div class="proj-head"><i class="tag" data-p="webshop"></i><span>webshop</span><em>2</em><button class="icon-btn sm" aria-label="New thread in webshop">${use("plus")}</button></div>
        <div class="ws-label">fix-3ds-eu-cards · studio-mac</div>
        <a class="thread${on("t-3ds")}"><i data-m="decision" class="s-attn"></i><span class="t">Fix 3-D Secure checkout for EU cards</span><time>39m</time><small>fix/3ds-eu-cards · Opus 5.5</small></a>
        <a class="thread${on("t-cart")}"><i data-m="working" class="s-live"></i><span class="t">Refactor cart totals</span><time>22m</time><small>fix/3ds-eu-cards · Sonnet 5</small></a>
        <div class="proj-head"><i class="tag" data-p="payments"></i><span>payments-api</span><em>1</em><button class="icon-btn sm" aria-label="New thread in payments-api">${use("plus")}</button></div>
        <div class="ws-label">hercule/run-7c2 · build-box-2</div>
        <a class="thread${on("t-ideal")}"><i data-m="idle" class="s-faint"></i><span class="t">Add iDEAL research</span><time>1h</time><small>research/ideal · gpt-5.4</small></a>
        <div class="proj-head"><i class="tag" data-p="ops"></i><span>ops</span><em>1</em><button class="icon-btn sm" aria-label="New thread in ops">${use("plus")}</button></div>
        <div class="ws-label">ops · studio-mac</div>
        <a class="thread${on("t-dash")}"><i data-m="decision" class="s-attn"></i><span class="t">Migrate ops dashboards</span><time>8m</time><small>main · qwen3-coder</small></a>
        <div class="side-label">Assistants</div>
        <a class="asst-row${on("a-ada")}"><span class="seal is-working">A</span><span class="t">Ada</span><small>working · web chat</small></a>
        <a class="asst-row${on("a-milo")}"><span class="seal">M</span><span class="t">Milo</span><small>idle · Slack #ops</small></a>
        <a class="asst-row${on("a-juno")}"><span class="seal is-asleep">J</span><span class="t">Juno</span><small>asleep · Discord</small></a>
        <a class="side-row all-sessions${on("sessions")}">All sessions<span class="n">23 live</span>${use("arrow-right")}</a>
      </div>`;
    const hercule = `
      <nav class="side-scroll side-nav">
        <a class="side-row${on("intake")}">${use("intake")}<span>Intake</span><b class="count">6</b></a>
        <a class="side-row${on("checkin")}">${use("checkin")}<span>Check-in</span><b class="count attn">3</b></a>
        <a class="side-row${on("tasks")}">${use("task")}<span>Tasks</span><b class="count quiet">14</b></a>
        <a class="side-row${on("runs")}">${use("run")}<span>Runs</span><b class="count quiet">4</b></a>
        <a class="side-row${on("workflows")}">${use("workflow")}<span>Workflows</span><b class="count quiet">6</b></a>
        <div class="perf-rule"></div>
        <a class="side-row${on("fleet")}">${use("fleet")}<span>Fleet</span><b class="count quiet">3</b></a>
        <a class="side-row${on("connections")}">${use("connection")}<span>Connections</span><i data-m="paused" class="s-attn sm" title="Discord reconnecting"></i></a>
        <a class="side-row${on("notifications")}">${use("bell")}<span>Notifications</span><b class="count">5</b></a>
        <a class="side-row${on("settings")}">${use("gear")}<span>Settings</span></a>
        <div class="side-label">Assistants</div>
        <a class="asst-row${on("a-ada")}"><span class="seal is-working">A</span><span class="t">Ada</span><small>working · web chat</small></a>
        <a class="asst-row${on("a-milo")}"><span class="seal">M</span><span class="t">Milo</span><small>idle · Slack #ops</small></a>
        <a class="asst-row${on("a-juno")}"><span class="seal is-asleep">J</span><span class="t">Juno</span><small>asleep · Discord</small></a>
      </nav>`;
    const foot = `
      <div class="side-foot">
        <button class="pulse"><span class="live-dot"></span><span>3 runners · 1 at cap · Ada working</span>${use("chev-right")}</button>
        <div class="foot-row"><button class="ghost-row">Marks <span class="key">?</span></button><button class="ghost-row">Theme <span class="val" data-theme-name></span></button></div>
      </div>`;
    el.innerHTML = top + faces + (face === "threads" ? threads : hercule) + foot;
  }

  const themeNames = {
    light: "Manila",
    manila: "Manila",
    newsprint: "Newsprint",
    dark: "Carbon",
    carbon: "Carbon",
    oxide: "Oxide",
    bottle: "Bottle",
  };

  function renderStatus(el) {
    const light = el.dataset.tone === "light";
    el.classList.add("status-bar");
    if (light) el.classList.add("on-dark");
    el.innerHTML = `
      <span class="sb-time">9:41</span>
      <span class="sb-island"></span>
      <span class="sb-right">
        <svg viewBox="0 0 18 12" class="sb-sig"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>
        <svg viewBox="0 0 16 12" class="sb-wifi"><path d="M8 11.2 5.9 9.1a3 3 0 0 1 4.2 0zM3.8 7a6 6 0 0 1 8.4 0l-1.4 1.4a4 4 0 0 0-5.6 0zM1.6 4.8a9.1 9.1 0 0 1 12.8 0L13 6.2a7.1 7.1 0 0 0-10 0z"/></svg>
        <svg viewBox="0 0 27 13" class="sb-batt"><rect x=".5" y=".5" width="23" height="12" rx="3.6" fill="none" stroke="currentColor" opacity=".4"/><rect x="2.2" y="2.2" width="16.5" height="8.6" rx="2.2"/><path d="M25.2 4.4v4.2c.8-.3 1.3-1.1 1.3-2.1s-.5-1.8-1.3-2.1z" opacity=".45"/></svg>
      </span>`;
  }

  function renderTabbar(el) {
    const active = el.dataset.active || "intake";
    const tab = (id, ic, label, badge = "") =>
      `<a class="tab${id === active ? " is-on" : ""}">${use(ic)}${badge}<span>${label}</span></a>`;
    el.classList.add("tabbar");
    el.innerHTML =
      tab("intake", "intake", "Intake", '<b class="tb-badge">6</b>') +
      tab("checkin", "checkin", "Check-in", '<b class="tb-badge attn">3</b>') +
      `<a class="tab tab-new" aria-label="New thread">${use("mic", "mk mic")}</a>` +
      tab("threads", "threads", "Threads") +
      tab("more", "user", "You");
  }

  // The settings domains, grouped the way a person looks for them.
  function renderSettingsNav(el) {
    const active = el.dataset.active || "";
    const row = (id, ic, label, extra = "") =>
      `<a class="${id === active ? "is-on" : ""}">${use(ic)}<span>${label}</span>${extra}</a>`;
    el.classList.add("set-nav");
    el.innerHTML =
      '<div class="label set-group">You</div>' +
      row("profile", "user", "Profile") +
      row("appearance", "palette", "Appearance") +
      '<div class="label set-group">Work</div>' +
      row("threads", "threads", "Threads") +
      row("assistants", "heart", "Assistants") +
      row("connections", "connection", "Connections", '<i data-m="paused" class="s-attn sm" title="Discord reconnecting"></i>') +
      row("providers", "plug", "Providers") +
      row("machines", "fleet", "Machines") +
      '<div class="label set-group">Access</div>' +
      row("identities", "key", "Identities") +
      row("profiles", "shield", "Permission profiles") +
      row("secrets", "lock", "Secrets") +
      row("bounds", "pulse", "Bounds") +
      '<div class="label set-group">System</div>' +
      row("plugins", "bolt", "Plugins") +
      row("system", "gear", "System");
  }

  document.querySelectorAll('[data-kit="sidebar"]').forEach(renderSidebar);
  document.querySelectorAll('[data-kit="setnav"]').forEach(renderSettingsNav);
  document.querySelectorAll('[data-kit="status"]').forEach(renderStatus);
  document.querySelectorAll('[data-kit="tabbar"]').forEach(renderTabbar);
  document.querySelectorAll('[data-kit="home"]').forEach((el) => el.classList.add("home-ind"));

  const setThemeName = () => {
    const t = document.documentElement.dataset.theme || "light";
    document.querySelectorAll("[data-theme-name]").forEach((el) => (el.textContent = themeNames[t] || t));
  };
  setThemeName();
  new MutationObserver(setThemeName).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---------- 2. Shorthand ----------
  document.querySelectorAll("[data-m]").forEach((el) => {
    if (!el.querySelector("svg")) el.insertAdjacentHTML("afterbegin", use(el.dataset.m));
  });
  document.querySelectorAll("i.tag[data-p]").forEach((el) => {
    el.innerHTML = use("tag");
    el.title = projects[el.dataset.p] || el.dataset.p;
  });
  // A postage stamp: the system's mark on the Connection's colour, the denomination (a count)
  // under it when there is room.
  document.querySelectorAll(".post[data-src]").forEach((el) => {
    if (el.children.length) return;
    const n = el.dataset.n ? `<b>${el.dataset.n}</b>` : "";
    el.innerHTML = `<span class="post-face">${use("b-" + el.dataset.src)}${n}</span>`;
  });
  // A postmark: a dated roundel with text on its rings, optionally trailing cancel waves.
  let pmCount = 0;
  document.querySelectorAll("[data-postmark]").forEach((el) => {
    const id = "pm" + ++pmCount;
    const top = el.dataset.top || "";
    const mid = el.dataset.mid || "";
    const bot = el.dataset.bot || "";
    const waves = el.dataset.waves !== undefined;
    el.classList.add("postmark");
    el.innerHTML = `
      <svg viewBox="0 0 ${waves ? 132 : 64} 64" class="pm-svg" aria-label="${[top, mid, bot].join(" ")}">
        <defs>
          <path id="${id}t" d="M11.6 32a20.4 20.4 0 0 1 40.8 0"/>
          <path id="${id}b" d="M8.4 32a23.6 23.6 0 0 0 47.2 0"/>
        </defs>
        <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" stroke-width="2.4"/>
        <circle cx="32" cy="32" r="18" fill="none" stroke="currentColor" stroke-width="1.2"/>
        <text class="pm-ring" text-anchor="middle"><textPath href="#${id}t" startOffset="50%">${top}</textPath></text>
        <text class="pm-ring" text-anchor="middle"><textPath href="#${id}b" startOffset="50%">${bot}</textPath></text>
        <text class="pm-mid" x="32" y="36.6" text-anchor="middle">${mid}</text>
        ${waves ? '<use href="#waves" x="66" y="18" width="64" height="28"/>' : ""}
      </svg>`;
  });

  // ---------- 4. The glass composer ----------
  // The transcript scroller carries [data-transcript]; its composer carries [data-composer].
  // Shrinks while the reader is away from the bottom, restores at the bottom or on focus.
  document.querySelectorAll("[data-transcript]").forEach((scroller) => {
    const composer = document.querySelector("[data-composer]");
    if (!composer) return;
    const forced = document.documentElement.dataset.state === "scrolled";
    let focused = false;
    const update = () => {
      const away = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 24;
      composer.classList.toggle("is-compact", forced || (away && !focused));
    };
    if (forced) {
      // Show the reader mid-transcript, the way the state happens in real use.
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 420);
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    scroller.addEventListener("scroll", update, { passive: true });
    composer.addEventListener("focusin", () => ((focused = true), update()));
    composer.addEventListener("focusout", () => ((focused = false), update()));
    update();
  });

  // Answer rows thunk when pressed: the stamp lands, then the row settles.
  document.addEventListener("click", (e) => {
    const row = e.target.closest(".ans");
    if (!row) return;
    row.classList.remove("is-stamped");
    void row.offsetWidth;
    row.classList.add("is-stamped");
  });
})();
