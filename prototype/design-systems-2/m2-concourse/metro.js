// Metro Concourse - the page kit.
// PROTOTYPE. Loaded with `defer` by every page. It:
//   - replaces <i data-i="name">, <i data-mk="state"> and <i data-brand="id"> with inline SVG,
//   - fills the shared chrome: [data-sidebar], [data-statusbar], [data-tabbar],
//     and the identity: [data-logo] (the logomark) and [data-appicon] (the app icon),
//   - draws the departures board into every [data-flow],
//   - runs the glass composer: it shrinks while the transcript is scrolled up.
// Inline SVG (not <use>) keeps every mark styleable and animatable by system.css.
(function () {
  "use strict";

  // ---------------------------------------------------------------- icons: one outline family, 16px grid, 1.4 stroke
  var I = {
    plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    attach: '<path d="M11.8 7.3 7.4 11.7a2.5 2.5 0 0 1-3.6-3.6l4.8-4.8a1.7 1.7 0 0 1 2.4 2.4L6.5 10.2a.8.8 0 0 1-1.2-1.2l4.1-4.1"/>',
    mic: '<rect x="5.8" y="2.2" width="4.4" height="7.6" rx="2.2"/><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5v1.8"/>',
    send: '<path d="M8 12.8V3.6M4 7.4l4-4 4 4" stroke-width="1.8"/>',
    chev: '<path d="m4.5 6.2 3.5 3.6 3.5-3.6"/>',
    "chev-r": '<path d="m6.2 4.5 3.6 3.5-3.6 3.5"/>',
    "chev-l": '<path d="M9.8 4.5 6.2 8l3.6 3.5"/>',
    search: '<circle cx="7.2" cy="7.2" r="4.3"/><path d="m10.4 10.4 3.1 3.1"/>',
    sliders: '<path d="M2.8 5h5.4M12 5h1.2M2.8 11h1.4M8 11h5.2"/><circle cx="10.1" cy="5" r="1.7"/><circle cx="6.1" cy="11" r="1.7"/>',
    gear: '<path d="M6.6 3.3 6.6 1.8H9.4L9.4 3.3 10.3 3.7 11.4 2.6 13.4 4.6 12.3 5.7 12.7 6.6 14.2 6.6V9.4L12.7 9.4 12.3 10.3 13.4 11.4 11.4 13.4 10.3 12.3 9.4 12.7 9.4 14.2H6.6L6.6 12.7 5.7 12.3 4.6 13.4 2.6 11.4 3.7 10.3 3.3 9.4 1.8 9.4V6.6L3.3 6.6 3.7 5.7 2.6 4.6 4.6 2.6 5.7 3.7Z"/><circle cx="8" cy="8" r="2"/>',
    bell: '<path d="M4.2 10.8V7.4a3.8 3.8 0 0 1 7.6 0v3.4l1 1.5H3.2zM6.6 14.1h2.8"/>',
    tray: '<path d="M14 8.6h-3.3l-1.1 1.8H6.4L5.3 8.6H2"/><path d="M4.4 3.4 2 8.6v3.3c0 .7.6 1.3 1.3 1.3h9.4c.7 0 1.3-.6 1.3-1.3V8.6l-2.4-5.2a1.3 1.3 0 0 0-1.2-.8H5.6a1.3 1.3 0 0 0-1.2.8z"/>',
    history: '<path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8L2.6 5.8"/><path d="M2.6 3v2.8h2.8M8 5.2V8l2 1.3"/>',
    tasks: '<rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.4"/><path d="m5.4 8.1 1.8 1.8 3.4-3.7"/>',
    runs: '<circle cx="8" cy="8" r="5.8"/><path d="M6.9 5.8v4.4L10.3 8z"/>',
    map: '<path d="M2.5 4.3 6 3l4 1.5 3.5-1.3v8.5L10 13l-4-1.5-3.5 1.3zM6 3v8.5M10 4.5V13"/>',
    list: '<path d="M5.8 4.5h7.4M5.8 8h7.4M5.8 11.5h7.4"/><circle cx="3" cy="4.5" r=".6" fill="currentColor"/><circle cx="3" cy="8" r=".6" fill="currentColor"/><circle cx="3" cy="11.5" r=".6" fill="currentColor"/>',
    office: '<path d="M8 2.4 13.6 5.5v5.1L8 13.6l-5.6-3V5.5zM2.4 5.5 8 8.6l5.6-3.1M8 8.6v5"/>',
    more: '<circle cx="3.6" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8" r="1" fill="currentColor" stroke="none"/>',
    close: '<path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    check: '<path d="m3.4 8.4 3 3 6.2-6.8"/>',
    clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.1 1.3"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.6"/><path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7"/>',
    shield: '<path d="M8 2.2 13 4v3.9c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/><path d="m5.9 8 1.5 1.5 2.8-3"/>',
    gauge: '<path d="M2.8 11.2a5.2 5.2 0 1 1 10.4 0"/><path d="m8 11.2 2.6-3.2"/>',
    machine: '<rect x="2" y="3" width="12" height="8" rx="1.6"/><path d="M5.6 13.6h4.8M8 11v2.6"/>',
    server: '<rect x="2.5" y="2.6" width="11" height="4.6" rx="1.3"/><rect x="2.5" y="8.8" width="11" height="4.6" rx="1.3"/><path d="M5 4.9h.01M5 11.1h.01" stroke-width="2"/>',
    branch: '<circle cx="4.6" cy="3.6" r="1.5"/><circle cx="4.6" cy="12.4" r="1.5"/><circle cx="11.4" cy="5.2" r="1.5"/><path d="M4.6 5.1v5.8M11.4 6.7c0 3.1-6.8 1.8-6.8 4.2"/>',
    folder: '<path d="M2.4 4.6a1.2 1.2 0 0 1 1.2-1.2h2.8l1.5 1.5h4.5a1.2 1.2 0 0 1 1.2 1.2v5.8a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2z"/>',
    "folder-plus": '<path d="M2.4 4.6a1.2 1.2 0 0 1 1.2-1.2h2.8l1.5 1.5h4.5a1.2 1.2 0 0 1 1.2 1.2v5.8a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M8 7.2v3.6M6.2 9h3.6"/>',
    terminal: '<rect x="2" y="3" width="12" height="10" rx="1.8"/><path d="m5 6.6 2 1.6-2 1.6M8.6 10h2.6"/>',
    external: '<path d="M9.2 2.8h4v4M13.2 2.8 7.6 8.4M11.4 9.6v2.6a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2V5.8a1.2 1.2 0 0 1 1.2-1.2h2.6"/>',
    editor: '<path d="m5.6 5.2-2.8 2.8 2.8 2.8M10.4 5.2l2.8 2.8-2.8 2.8M8.9 3.6 7.1 12.4"/>',
    sidebar: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6.2 3v10"/>',
    compose: '<path d="M13 8.6V12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12V5a1.5 1.5 0 0 1 1.5-1.5h3.4"/><path d="m11.6 2.6 1.8 1.8-4.6 4.6H7V7.2z"/>',
    user: '<circle cx="8" cy="5.6" r="2.6"/><path d="M3 13.6c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8"/>',
    key: '<circle cx="5.4" cy="10.6" r="2.6"/><path d="m7.3 8.7 5.2-5.2M10.8 5.2l1.7 1.7M9.2 6.8l1.2 1.2"/>',
    plug: '<path d="M5.6 2.6v3M10.4 2.6v3M3.8 5.6h8.4v2a4.2 4.2 0 0 1-8.4 0zM8 11.8v1.8"/>',
    id: '<rect x="2" y="3.2" width="12" height="9.6" rx="1.8"/><circle cx="6" cy="7.4" r="1.5"/><path d="M3.9 10.6c.4-1 1.1-1.5 2.1-1.5s1.7.5 2.1 1.5M9.8 6.6h2.4M9.8 9h2.4"/>',
    cpu: '<rect x="4" y="4" width="8" height="8" rx="1.4"/><path d="M6.4 1.8V4M9.6 1.8V4M6.4 12v2.2M9.6 12v2.2M1.8 6.4H4M1.8 9.6H4M12 6.4h2.2M12 9.6h2.2"/>',
    palette: '<path d="M8 2.2a5.8 5.8 0 0 0 0 11.6c1 0 1.4-.7 1.1-1.5-.4-.9.2-1.8 1.2-1.8h1.4a2.1 2.1 0 0 0 2.1-2.1A5.9 5.9 0 0 0 8 2.2z"/><circle cx="5" cy="7.4" r=".7" fill="currentColor"/><circle cx="7.6" cy="5" r=".7" fill="currentColor"/><circle cx="10.6" cy="6" r=".7" fill="currentColor"/>',
    bot: '<rect x="3" y="5" width="10" height="8" rx="2.4"/><path d="M8 5V2.8"/><circle cx="8" cy="2.4" r=".6" fill="currentColor"/><path d="M6 8.6v.8M10 8.6v.8"/>',
    thread: '<path d="M3.4 2.6h9.2a1.6 1.6 0 0 1 1.6 1.6v5.4a1.6 1.6 0 0 1-1.6 1.6H7.2l-3 2.6v-2.6h-.8a1.6 1.6 0 0 1-1.6-1.6V4.2a1.6 1.6 0 0 1 1.6-1.6z"/>',
    box: '<path d="M8 2.2 13.4 5v6L8 13.8 2.6 11V5zM2.6 5 8 7.8 13.4 5M8 7.8v6"/>',
    bound: '<path d="M2.6 12.6h10.8M4 12.6V7.4M8 12.6V4M12 12.6V9"/><path d="M2.6 5.6h10.8" stroke-dasharray="1.6 1.6"/>',
    puzzle: '<path d="M6.2 2.6a1.4 1.4 0 0 1 2.8 0v1h3a.8.8 0 0 1 .8.8v2.8h-1a1.4 1.4 0 0 0 0 2.8h1v2.8a.8.8 0 0 1-.8.8H3.2a.8.8 0 0 1-.8-.8V4.4a.8.8 0 0 1 .8-.8h3z"/>',
    workflow: '<rect x="1.8" y="6" width="4" height="4" rx="1"/><rect x="10.2" y="2.2" width="4" height="4" rx="1"/><rect x="10.2" y="9.8" width="4" height="4" rx="1"/><path d="M5.8 8h2.2m0 0V4.2h2.2M8 8v3.8h2.2"/>',
    pr: '<circle cx="4.4" cy="3.6" r="1.5"/><circle cx="4.4" cy="12.4" r="1.5"/><circle cx="11.6" cy="12.4" r="1.5"/><path d="M4.4 5.1v5.8M11.6 10.9V6.4a1.8 1.8 0 0 0-1.8-1.8H7.4M8.8 3.2 7.4 4.6 8.8 6"/>',
    heartbeat: '<path d="M1.6 8.4h2.8l1.6-3.4 2.6 6.2 1.8-4.2 1 1.4h3"/>',
    memory: '<path d="M2.6 3.4h3.6A1.8 1.8 0 0 1 8 5.2a1.8 1.8 0 0 1 1.8-1.8h3.6v8.8H9.8A1.8 1.8 0 0 0 8 14a1.8 1.8 0 0 0-1.8-1.8H2.6zM8 5.2V14"/>',
    rotate: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13.2 2.8v2.6h-2.6"/>',
    alarm: '<circle cx="8" cy="8.6" r="4.8"/><path d="M8 6.2v2.6l1.6 1M2.6 3.8l2-1.6M13.4 3.8l-2-1.6"/>',
    steer: '<path d="M4 13.4V8.6a3 3 0 0 1 3-3h6.2M10.4 2.8l2.8 2.8-2.8 2.8"/>',
    stack: '<path d="M8 2.4 13.6 5 8 7.6 2.4 5zM2.4 8 8 10.6 13.6 8M2.4 11 8 13.6 13.6 11"/>',
    reply: '<path d="M6.2 4 2.6 7.6l3.6 3.6M2.8 7.6h6.6a4 4 0 0 1 4 4v.8"/>',
    wave: '<path d="M2.6 6.6v2.8M5.3 4.4v7.2M8 2.8v10.4M10.7 5v6M13.4 6.8v2.4"/>',
    diff: '<path d="M5.2 2.8v5.2M2.6 5.4h5.2M8.6 12h5"/><path d="M3 13.2 13 2.8" opacity=".5"/>',
    eye: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="2"/>',
    type: '<path d="M2.2 12.6 5.4 4h.6l3.2 8.6M3.3 9.8h4.8M10.6 7.6c.4-.6 1-.9 1.8-.9 1.1 0 1.8.7 1.8 1.8v4.1M14.2 10c-2.4-.2-3.8.3-3.8 1.4 0 .8.6 1.3 1.4 1.3 1.1 0 2.4-.8 2.4-2.1"/>',
    density: '<path d="M2.8 3.6h10.4M2.8 6.5h10.4M2.8 9.5h10.4M2.8 12.4h10.4"/>',
    motion: '<path d="M1.8 8h3M3 5h4M3 11h4"/><circle cx="11" cy="8" r="3"/>',
    glass: '<rect x="2.4" y="2.4" width="11.2" height="11.2" rx="3"/><path d="M5 9.6 9.6 5M7.4 11 11 7.4" opacity=".7"/>',
    tag: '<path d="M2.6 2.6h4.9l6 6-4.9 4.9-6-6z"/><circle cx="5.4" cy="5.4" r=".9" fill="currentColor" stroke="none"/>',
    pin: '<path d="M6.2 2.4h3.6l-.6 3.4 2.4 2.2v1.4H4.4V8l2.4-2.2zM8 9.4v4.2"/>',
    zap: '<path d="M8.8 1.8 3.8 9h3.8l-.6 5.2L12.2 7H8.4z"/>',
    moon: '<path d="M12.8 9.6A5.4 5.4 0 0 1 6.4 3.2a5.4 5.4 0 1 0 6.4 6.4z"/>',
    sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/>',
    globe: '<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.6 1.6 2.4 3.5 2.4 5.8S9.6 12.2 8 13.8C6.4 12.2 5.6 10.3 5.6 8S6.4 3.8 8 2.2z"/>',
    command: '<path d="M5.8 5.8h4.4v4.4H5.8zM5.8 5.8V4.4a1.6 1.6 0 1 0-1.6 1.4zM10.2 5.8V4.4a1.6 1.6 0 1 1 1.6 1.4zM5.8 10.2v1.4a1.6 1.6 0 1 1-1.6-1.4zM10.2 10.2v1.4a1.6 1.6 0 1 0 1.6-1.4z"/>',
    share: '<path d="M8 10V2.6M5 5.4l3-3 3 3M3.6 8.6v3.6a1.2 1.2 0 0 0 1.2 1.2h6.4a1.2 1.2 0 0 0 1.2-1.2V8.6"/>',
    link: '<path d="M7 9a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8"/><path d="M9 7a2.6 2.6 0 0 0-3.7 0L3.1 9.2a2.6 2.6 0 0 0 3.7 3.7l.8-.8"/>',
    copy: '<rect x="5.2" y="5.2" width="8.2" height="8.2" rx="1.6"/><path d="M10.8 5.2V4a1.4 1.4 0 0 0-1.4-1.4H4A1.4 1.4 0 0 0 2.6 4v5.4A1.4 1.4 0 0 0 4 10.8h1.2"/>',
    filter: '<path d="M2.6 3.6h10.8M4.6 8h6.8M6.6 12.4h2.8"/>',
    play: '<path d="M5 3.2v9.6L12.6 8z"/>',
    pause: '<path d="M5.6 3.4v9.2M10.4 3.4v9.2"/>',
    home: '<path d="M2.6 7.2 8 2.8l5.4 4.4v5.6a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1z"/>',
    back: '<path d="M10 3 5 8l5 5" stroke-width="1.8"/>',
    info: '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.6M8 5.1v.1"/>',
    fullscreen: '<path d="M2.8 6V2.8H6M10 2.8h3.2V6M13.2 10v3.2H10M6 13.2H2.8V10"/>',
    file: '<path d="M4 2.4h5l3 3v8.2H4z"/><path d="M9 2.4v3h3"/>',
  };

  // ---------------------------------------------------------------- the six state marks: 12px grid
  // One shape per state, so a mark reads without its color:
  //   work    a turning arc            (working; static under reduced motion)
  //   wait    a filled disc            (waiting on you: a Request, a question, a Proposal)
  //   done    a disc with a check
  //   fail    a disc with a cross
  //   paused  a ring with two bars     (paused, held, breaker tripped)
  //   idle    an empty ring            (idle, asleep, queued: the word says which)
  // The check and the cross are cut out in --mark-cut, the ground the mark sits on.
  var MK = {
    work: '<circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".28"/><path class="arc" d="M6 1.8a4.2 4.2 0 0 1 4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    wait: '<circle cx="6" cy="6" r="4.4" fill="currentColor"/>',
    done: '<circle cx="6" cy="6" r="5" fill="currentColor"/><path d="m3.7 6.1 1.6 1.6 3-3.3" fill="none" style="stroke:var(--mark-cut, var(--bg))" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    fail: '<circle cx="6" cy="6" r="5" fill="currentColor"/><path d="m4.2 4.2 3.6 3.6M7.8 4.2 4.2 7.8" fill="none" style="stroke:var(--mark-cut, var(--bg))" stroke-width="1.5" stroke-linecap="round"/>',
    paused: '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.9 4.3v3.4M7.1 4.3v3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    idle: '<circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  };

  // ---------------------------------------------------------------- brand marks (Simple Icons, CC0)
  var BR = {
    sentry: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
    gmail: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
    posthog: "M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z",
    github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
    stripe: "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
    intercom: "M21 0H3C1.343 0 0 1.343 0 3v18c0 1.658 1.343 3 3 3h18c1.658 0 3-1.342 3-3V3c0-1.657-1.342-3-3-3zm-5.801 4.399c0-.44.36-.8.802-.8.44 0 .8.36.8.8v10.688c0 .442-.36.801-.8.801-.443 0-.802-.359-.802-.801V4.399zM11.2 3.994c0-.44.357-.799.8-.799s.8.359.8.799v11.602c0 .44-.357.8-.8.8s-.8-.36-.8-.8V3.994zm-4 .405c0-.44.359-.8.799-.8.443 0 .802.36.802.8v10.688c0 .442-.36.801-.802.801-.44 0-.799-.359-.799-.801V4.399zM3.199 6c0-.442.36-.8.802-.8.44 0 .799.358.799.8v7.195c0 .441-.359.8-.799.8-.443 0-.802-.36-.802-.8V6zM20.52 18.202c-.123.105-3.086 2.593-8.52 2.593-5.433 0-8.397-2.486-8.521-2.593-.335-.288-.375-.792-.086-1.128.285-.334.79-.375 1.125-.09.047.041 2.693 2.211 7.481 2.211 4.848 0 7.456-2.186 7.479-2.207.334-.289.839-.25 1.128.086.289.336.25.84-.086 1.128zm.281-5.007c0 .441-.36.8-.801.8-.441 0-.801-.36-.801-.8V6c0-.442.361-.8.801-.8.441 0 .801.357.801.8v7.195z",
    slack: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
    discord: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
    claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    openai: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    grafana: "M23.02 10.59a8.578 8.578 0 0 0-.862-3.034 8.911 8.911 0 0 0-1.789-2.445c.337-1.342-.413-2.505-.413-2.505-1.292-.08-2.113.4-2.416.62-.052-.02-.102-.044-.154-.064-.22-.089-.446-.172-.677-.247-.231-.073-.47-.14-.711-.197a9.867 9.867 0 0 0-.875-.161C14.557.753 12.94 0 12.94 0c-1.804 1.145-2.147 2.744-2.147 2.744l-.018.093c-.098.029-.2.057-.298.088-.138.042-.275.094-.413.143-.138.055-.275.107-.41.166a8.869 8.869 0 0 0-1.557.87l-.063-.029c-2.497-.955-4.716.195-4.716.195-.203 2.658.996 4.33 1.235 4.636a11.608 11.608 0 0 0-.607 2.635C1.636 12.677.953 15.014.953 15.014c1.926 2.214 4.171 2.351 4.171 2.351.003-.002.006-.002.006-.005.285.509.615.994.986 1.446.156.19.32.371.488.548-.704 2.009.099 3.68.099 3.68 2.144.08 3.553-.937 3.849-1.173a9.784 9.784 0 0 0 3.164.501h.08l.055-.003.107-.002.103-.005.003.002c1.01 1.44 2.788 1.646 2.788 1.646 1.264-1.332 1.337-2.653 1.337-2.94v-.058c0-.02-.003-.039-.003-.06.265-.187.52-.387.758-.6a7.875 7.875 0 0 0 1.415-1.7c1.43.083 2.437-.885 2.437-.885-.236-1.49-1.085-2.216-1.264-2.354l-.018-.013-.016-.013a.217.217 0 0 1-.031-.02c.008-.092.016-.18.02-.27.011-.162.016-.323.016-.48v-.253l-.005-.098-.008-.135a1.891 1.891 0 0 0-.01-.13c-.003-.042-.008-.083-.013-.125l-.016-.124-.018-.122a6.215 6.215 0 0 0-2.032-3.73 6.015 6.015 0 0 0-3.222-1.46 6.292 6.292 0 0 0-.85-.048l-.107.002h-.063l-.044.003-.104.008a4.777 4.777 0 0 0-3.335 1.695c-.332.4-.592.84-.768 1.297a4.594 4.594 0 0 0-.312 1.817l.003.091c.005.055.007.11.013.164a3.615 3.615 0 0 0 .698 1.82 3.53 3.53 0 0 0 1.827 1.282c.33.098.66.14.971.137.039 0 .078 0 .114-.002l.063-.003c.02 0 .041-.003.062-.003.034-.002.065-.007.099-.01.007 0 .018-.003.028-.003l.031-.005.06-.008a1.18 1.18 0 0 0 .112-.02c.036-.008.072-.013.109-.024a2.634 2.634 0 0 0 .914-.415c.028-.02.056-.041.085-.065a.248.248 0 0 0 .039-.35.244.244 0 0 0-.309-.06l-.078.042c-.09.044-.184.083-.283.116a2.476 2.476 0 0 1-.475.096c-.028.003-.054.006-.083.006l-.083.002c-.026 0-.054 0-.08-.002l-.102-.006h-.012l-.024.006c-.016-.003-.031-.003-.044-.006-.031-.002-.06-.007-.091-.01a2.59 2.59 0 0 1-.724-.213 2.557 2.557 0 0 1-.667-.438 2.52 2.52 0 0 1-.805-1.475 2.306 2.306 0 0 1-.029-.444l.006-.122v-.023l.002-.031c.003-.021.003-.04.005-.06a3.163 3.163 0 0 1 1.352-2.29 3.12 3.12 0 0 1 .937-.43 2.946 2.946 0 0 1 .776-.101h.06l.07.002.045.003h.026l.07.005a4.041 4.041 0 0 1 1.635.49 3.94 3.94 0 0 1 1.602 1.662 3.77 3.77 0 0 1 .397 1.414l.005.076.003.075c.002.026.002.05.002.075 0 .024.003.052 0 .07v.065l-.002.073-.008.174a6.195 6.195 0 0 1-.08.639 5.1 5.1 0 0 1-.267.927 5.31 5.31 0 0 1-.624 1.13 5.052 5.052 0 0 1-3.237 2.014 4.82 4.82 0 0 1-.649.066l-.039.003h-.287a6.607 6.607 0 0 1-1.716-.265 6.776 6.776 0 0 1-3.4-2.274 6.75 6.75 0 0 1-.746-1.15 6.616 6.616 0 0 1-.714-2.596l-.005-.083-.002-.02v-.056l-.003-.073v-.096l-.003-.104v-.07l.003-.163c.008-.22.026-.45.054-.678a8.707 8.707 0 0 1 .28-1.355c.128-.444.286-.872.473-1.277a7.04 7.04 0 0 1 1.456-2.1 5.925 5.925 0 0 1 .953-.763c.169-.111.343-.213.524-.306.089-.05.182-.091.273-.135.047-.02.093-.042.138-.062a7.177 7.177 0 0 1 .714-.267l.145-.045c.049-.015.098-.026.148-.041.098-.029.197-.052.296-.076.049-.013.1-.02.15-.033l.15-.032.151-.028.076-.013.075-.01.153-.024c.057-.01.114-.013.171-.023l.169-.021c.036-.003.073-.008.106-.01l.073-.008.036-.003.042-.002c.057-.003.114-.008.171-.01l.086-.006h.023l.037-.003.145-.007a7.999 7.999 0 0 1 1.708.125 7.917 7.917 0 0 1 2.048.68 8.253 8.253 0 0 1 1.672 1.09l.09.077.089.078c.06.052.114.107.171.159.057.052.112.106.166.16.052.055.107.107.159.164a8.671 8.671 0 0 1 1.41 1.978c.012.026.028.052.04.078l.04.078.075.156c.023.051.05.1.07.153l.065.15a8.848 8.848 0 0 1 .45 1.34.19.19 0 0 0 .201.142.186.186 0 0 0 .172-.184c.01-.246.002-.532-.024-.856z",
  };
  // Brands with no Simple Icons mark are drawn in the same 24px box.
  var BR_EXTRA = {
    cron: '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 6.5V12l3.8 2.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
    webchat: '<path d="M5 3h14a3 3 0 0 1 3 3v8.5a3 3 0 0 1-3 3h-7.2L6.5 21.5v-4H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"/>',
    pi: '<text x="12" y="18.6" text-anchor="middle" font-family="Overpass, sans-serif" font-size="22" font-weight="800" fill="currentColor">&#960;</text>',
  };

  // The hue that belongs to each Connection, as a CSS custom property name.
  var HUE = {
    sentry: "--ln-sentry",
    gmail: "--ln-gmail",
    posthog: "--ln-posthog",
    github: "--ln-github",
    stripe: "--ln-stripe",
    intercom: "--ln-intercom",
    grafana: "--ln-grafana",
    cron: "--ln-cron",
    slack: "--ln-slack",
    discord: "--ln-discord",
    webchat: "--ln-webchat",
  };
  var NAME = {
    sentry: "Sentry",
    gmail: "Gmail",
    posthog: "PostHog",
    github: "GitHub",
    stripe: "Stripe",
    intercom: "Intercom",
    grafana: "Grafana",
    cron: "Cron",
    slack: "Slack",
    discord: "Discord",
    webchat: "Web chat",
  };

  function svg(attrs, body) {
    return "<svg " + attrs + ' aria-hidden="true" focusable="false">' + body + "</svg>";
  }
  function classOf(el, extra) {
    return (extra + " " + (el.getAttribute("class") || "")).trim();
  }
  function styleOf(el) {
    var s = el.getAttribute("style");
    return s ? ' style="' + s + '"' : "";
  }

  function iconSvg(name, cls, style) {
    return svg(
      'class="' + (cls || "icon") + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"' + (style || ""),
      I[name] || ""
    );
  }
  // A mark takes its state's color from system.css (.mk--wait and so on) unless the page adds its own.
  function markSvg(name, cls, style) {
    return svg('class="mk mk--' + name + (cls ? " " + cls : "") + '" viewBox="0 0 12 12"' + (style || ""), MK[name] || "");
  }
  function brandSvg(id, cls, style) {
    var body = BR[id] ? '<path fill="currentColor" d="' + BR[id] + '"/>' : BR_EXTRA[id] || "";
    return svg('class="' + (cls || "brand") + '" viewBox="0 0 24 24"' + (style || ""), body);
  }
  window.MetroBrand = brandSvg;
  window.MetroIcon = iconSvg;
  window.MetroMark = markSvg;

  // The office's "At 10x" view (?state=swarm) shows the same product with ten times the work.
  var AT_10X = document.documentElement.dataset.state === "swarm";

  // ---------------------------------------------------------------- the sidebar
  // Threads tab: only Threads live here, grouped by project. Runs belong to the Hercule tab.
  // A row is a title, a quiet meta line, and at the right a mark (waiting, working) or an age.
  var PROJECTS = [
    { name: "webshop", mark: "wait", threads: [
      { id: "fix3ds", title: "Fix 3-D Secure checkout for EU cards", meta: "Opus 5.5 · studio-mac", mark: "wait", href: "session-active.html" },
      { id: "stripe14", title: "Read the Stripe v14 changelog", meta: "Haiku 4.5 · build-box-2", age: "20m" },
      { id: "cart", title: "Refactor cart totals", meta: "Sonnet 5 · build-box-1", mark: "work" },
      { id: "css", title: "Tidy checkout CSS", meta: "Haiku 4.5", age: "2h" },
    ] },
    { name: "payments-api", mark: "work", threads: [
      { id: "payout", title: "Payout report for September", meta: "gpt-5.4 · build-box-1", mark: "work" },
      { id: "ideal", title: "Add iDEAL research", meta: "gpt-5.4 · build-box-2", age: "1h" },
    ] },
    { name: "ops", mark: "wait", threads: [
      { id: "grafana", title: "Migrate ops dashboards", meta: "qwen3-coder · studio-mac", mark: "wait" },
      { id: "secrets", title: "Rotate staging secrets", meta: "Sonnet 5 · build-box-1", mark: "work" },
    ] },
  ];
  var ASSISTANTS = [
    { id: "ada", title: "Ada", meta: "Web chat · Slack DM", mark: "work", href: "assistant.html" },
    { id: "milo", title: "Milo", meta: "Slack #ops", mark: "idle" },
    { id: "juno", title: "Juno", meta: "asleep · Discord #support", mark: "idle" },
  ];
  // Hercule tab: what waits on Rogier comes first, Runs included, one line of question each.
  var WAITING = [
    { title: "Fix 3-D Secure checkout", meta: "Run git push?", href: "session-active.html" },
    { title: "Ship release v2.15", meta: "Run · Publish to npm?" },
    { title: "Migrate ops dashboards", meta: "Keep the old Grafana folder?" },
  ];
  var WORK = [
    ["intake", "Intake", "tray", AT_10X ? "60" : "5", "intake.html"],
    ["checkin", "Check-in", "history", "09:00", "assistant.html"],
    ["tasks", "Tasks", "tasks", AT_10X ? "96" : "12"],
    ["runs", "Runs", "runs", AT_10X ? "38" : "6"],
    ["workflows", "Workflows", "workflow", AT_10X ? "14" : "6"],
  ];
  var SYSTEM = [
    ["fleet", "Fleet", "server", AT_10X ? "140 of 150" : "16 of 22", "office.html"],
    ["connections", "Connections", "plug", "11", "settings-connections.html"],
    ["notifications", "Notifications", "bell", "5"],
    ["settings", "Settings", "gear", "", "settings-appearance.html"],
  ];

  // The web app has fewer screens than the desktop app. A web page links to the desktop screen
  // when the web app has no page of its own for it, so no link in the prototype is dead.
  var ON_WEB = /\/web\/[^/]*$/.test(location.pathname);
  var WEB_PAGES = ["session-active.html", "session-empty.html", "intake.html", "decision.html", "assistant.html", "settings-providers.html"];
  function pageHref(href) {
    if (!href || href === "#" || !ON_WEB || href.indexOf("/") >= 0 || WEB_PAGES.indexOf(href) >= 0) return href || "#";
    return "../desktop/" + href;
  }

  function rowHtml(r, current) {
    var end = r.mark ? markSvg(r.mark) : '<span class="age">' + r.age + "</span>";
    return (
      '<a class="trow" href="' + pageHref(r.href) + '"' + (r.id && r.id === current ? ' aria-current="page"' : "") + ">" +
      '<span class="t-title">' + r.title + '</span><span class="t-end">' + end + "</span>" +
      '<span class="t-meta">' + r.meta + "</span></a>"
    );
  }
  function navHtml(n, current) {
    return (
      '<a class="nav-item" href="' + pageHref(n[4]) + '"' + (n[0] === current ? ' aria-current="page"' : "") + ">" +
      iconSvg(n[2]) + "<span>" + n[1] + '</span><span class="count">' + n[3] + "</span></a>"
    );
  }

  function threadsTabHtml(current) {
    var o =
      '<button class="side-cmd">' + iconSvg("compose") + "New thread<kbd>&#8984;N</kbd></button>" +
      '<button class="side-cmd">' + iconSvg("search") + "Search<kbd>&#8984;K</kbd></button>";
    PROJECTS.forEach(function (p) {
      o += '<section class="side-sec"><div class="proj-h">' + markSvg(p.mark) + "<span>" + p.name + "</span>" +
        '<button class="icon-btn icon-btn--xs" aria-label="New thread in ' + p.name + '">' + iconSvg("plus") + "</button></div>";
      // A Draft Thread shows at the top of its project until it is sent.
      if (current === "draft" && p.name === "webshop") {
        o += rowHtml({ id: "draft", title: "New thread", meta: "draft · new workspace", age: "now", href: "session-empty.html" }, current);
      }
      p.threads.forEach(function (r) { o += rowHtml(r, current); });
      o += "</section>";
    });
    o += '<section class="side-sec"><div class="side-label">Assistants</div>';
    ASSISTANTS.forEach(function (r) { o += rowHtml(r, current); });
    return o + "</section>";
  }
  function herculeTabHtml(current) {
    var o = '<section class="side-sec"><div class="side-label">Waiting on you<span class="count attn">' + (AT_10X ? 11 : 3) + "</span></div>";
    WAITING.forEach(function (r) { o += rowHtml({ title: r.title, meta: r.meta, mark: "wait", href: r.href }, current); });
    if (AT_10X) o += '<a class="side-more" href="#">8 more waiting</a>';
    o += '</section><section class="side-sec"><div class="side-label">Work</div>';
    WORK.forEach(function (n) { o += navHtml(n, current); });
    o += '</section><section class="side-sec"><div class="side-label">System</div>';
    SYSTEM.forEach(function (n) { o += navHtml(n, current); });
    return o + "</section>";
  }

  // Settings replace the two tabs with one list, the way an app's settings take over its sidebar,
  // so a settings page has one navigation column, not a sidebar and a second list beside it.
  // Runners have no settings page: they live in Fleet, which the Hercule sidebar already lists.
  var SETTINGS = [
    ["Personal", [
      ["profile", "Profile", "user"],
      ["appearance", "Appearance", "palette", "settings-appearance.html"],
      ["threads", "Threads", "thread"],
      ["assistants", "Assistants", "bot", "settings-assistants.html"],
    ]],
    ["Work", [
      ["connections", "Connections", "plug", "settings-connections.html"],
      ["providers", "Providers", "box", "../web/settings-providers.html"],
      ["identities", "Identities", "id"],
    ]],
    ["Safety", [
      ["permissions", "Permission profiles", "shield"],
      ["secrets", "Secrets", "key"],
      ["bounds", "Bounds", "gauge"],
    ]],
    ["Advanced", [
      ["plugins", "Plugins", "puzzle"],
      ["system", "System", "cpu"],
    ]],
  ];
  function settingsTabHtml(current) {
    var o = '<a class="side-cmd" href="' + pageHref("intake.html") + '">' + iconSvg("back") + "Back</a>";
    SETTINGS.forEach(function (group) {
      o += '<section class="side-sec"><div class="side-label">' + group[0] + "</div>";
      group[1].forEach(function (s) { o += navHtml([s[0], s[1], s[2], "", s[3]], current); });
      o += "</section>";
    });
    return o;
  }

  function sidebarHtml(face, current, web) {
    var o = web
      ? '<div class="side-top"><span class="brandline">' + logoSvg(18) + "<b>Hercule</b></span>"
      : '<div class="side-top"><span class="traffic"><i></i><i></i><i></i></span>';
    o += '<button class="icon-btn" aria-label="Hide sidebar">' + iconSvg("sidebar") + "</button></div>";
    if (face !== "settings") {
      o += '<div class="faces seg" role="tablist" aria-label="Sidebar">' +
        '<button role="tab" aria-selected="' + (face === "threads") + '">Threads</button>' +
        '<button role="tab" aria-selected="' + (face === "hercule") + '">Hercule' + (face === "threads" ? '<span class="dot-attn" aria-label="3 waiting"></span>' : "") + "</button></div>";
    }
    var body = face === "threads" ? threadsTabHtml(current) : face === "hercule" ? herculeTabHtml(current) : settingsTabHtml(current);
    o += '<div class="side-body">' + body + "</div>";
    var n = AT_10X ? [52, 11, 6, 71] : [8, 3, 1, 4];
    o +=
      '<div class="side-foot"><a class="pulse" href="' + pageHref("office.html") + '"><b>' + n[0] + "</b> working · " +
      '<span class="attn"><b>' + n[1] + "</b> waiting</span> · <b>" + n[2] + "</b> paused · <b>" + n[3] + "</b> idle</a>" +
      '<div class="me"><span class="avatar">R</span>Rogier<a class="icon-btn" href="' + pageHref("settings-appearance.html") + '" aria-label="Settings">' + iconSvg("gear") + "</a></div></div>";
    return o;
  }

  // The logomark: an H drawn as two lines joined by an interchange.
  function logoSvg(size, cls) {
    return (
      '<svg class="' + (cls || "logo") + '" width="' + size + '" height="' + size + '" viewBox="0 0 32 32" aria-hidden="true">' +
      '<path d="M8.5 5v22M23.5 5v22" style="stroke:var(--logo-a, var(--ink))" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M23.5 5v22" style="stroke:var(--logo-b, var(--ink))" stroke-width="5" stroke-linecap="round"/>' +
      '<rect x="4.2" y="11.6" width="23.6" height="8.8" rx="4.4" style="fill:var(--logo-cut, var(--bg));stroke:var(--ink)" stroke-width="2.4"/>' +
      "</svg>"
    );
  }
  window.MetroLogo = logoSvg;

  // The app icon: the logomark on a black enamel plate, its two lines in the red and yellow of
  // the first two lines on any map. It keeps fixed colors, because the Dock does not follow the
  // app's theme.
  function appIconSvg(size, cls) {
    return (
      '<svg class="' + (cls || "appicon") + '" width="' + size + '" height="' + size + '" viewBox="0 0 64 64" aria-hidden="true">' +
      '<rect x="3" y="3" width="58" height="58" rx="13.5" fill="#24201c"/>' +
      '<rect x="3.5" y="3.5" width="57" height="57" rx="13" fill="none" stroke="#fff" stroke-opacity=".14"/>' +
      '<path d="M21.5 15v34" stroke="#e5553f" stroke-width="8.5" stroke-linecap="round"/>' +
      '<path d="M42.5 15v34" stroke="#f1c24f" stroke-width="8.5" stroke-linecap="round"/>' +
      '<rect x="14.5" y="25.2" width="35" height="13.6" rx="6.8" fill="#fbf8f2" stroke="#24201c" stroke-width="3"/>' +
      "</svg>"
    );
  }
  window.MetroAppIcon = appIconSvg;

  function statusbarHtml(time) {
    return (
      "<span>" + (time || "9:41") + '</span><span class="island"></span><span class="sys">' +
      '<svg viewBox="0 0 18 12" width="18" height="12"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor"/><rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>' +
      '<svg viewBox="0 0 16 12" width="16" height="12"><path d="M8 11.3 5.6 8.8a3.4 3.4 0 0 1 4.8 0zM3.3 6.6a6.6 6.6 0 0 1 9.4 0l-1.2 1.2a4.9 4.9 0 0 0-7 0zM1 4.3a9.9 9.9 0 0 1 14 0l-1.2 1.2a8.2 8.2 0 0 0-11.6 0z" fill="currentColor"/></svg>' +
      '<svg viewBox="0 0 27 13" width="27" height="13"><rect x=".5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="9" rx="2.4" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" fill="currentColor" opacity=".45"/></svg>' +
      "</span>"
    );
  }

  var TABS = [
    ["intake", "Intake", "tray", "intake.html", 5],
    ["threads", "Threads", "thread", "session-active.html"],
    ["assistants", "Assistants", "bot", "assistant.html"],
    ["fleet", "Fleet", "server", "#"],
  ];
  function tabbarHtml(current) {
    return TABS.map(function (t) {
      return '<a href="' + t[3] + '"' + (t[0] === current ? ' aria-current="page"' : "") + ">" + iconSvg(t[2]) + t[1] + (t[4] ? '<span class="badge">' + t[4] + "</span>" : "") + "</a>";
    }).join("");
  }

  // ---------------------------------------------------------------- the departures board
  // The one live flow element: what came in, the Triage interchange, and what it became.
  //   <div data-flow="full">     a column per Connection, Triage, a column per outcome, next triage
  //   <div data-flow="compact">  the Connections folded into one column with their colors side by side
  //   <div data-flow="mini">     one line, for a Live Activity or a phone header
  //   data-scale="10x"           the same board with ten times the work
  // Under each column runs one line: a Connection's hue before Triage, Hercule's ink after it.
  var BOARD = {
    today: {
      total: 212,
      ins: [["sentry", 130], ["github", 38], ["gmail", 17], ["stripe", 12], ["intercom", 9], ["posthog", 3], ["grafana", 2], ["cron", 1]],
      triage: "09:00",
      took: "42s",
      next: "11:00",
      outs: [["Proposals", 5, "1 burning"], ["Offers", 2], ["Need a call", 2], ["FYI", 3], ["Handled quietly", 167]],
    },
    // 31,000 events a day is about 19,000 between 18:20 and 09:00.
    "10x": {
      total: 19040,
      ins: [["sentry", 11700], ["github", 3400], ["gmail", 1500], ["stripe", 1080], ["intercom", 810], ["posthog", 270], ["grafana", 190], ["cron", 90]],
      triage: "09:00",
      took: "3m 10s",
      next: "11:00",
      outs: [["Proposals", 60, "4 burning"], ["Offers", 18], ["Need a call", 9], ["FYI", 31], ["Handled quietly", 18512]],
    },
  };
  function formatCount(n) {
    return n.toLocaleString("en-US");
  }
  // The folded input line: each Connection's share of the width, on a log scale so that one
  // noisy source cannot hide the quiet ones.
  function foldedLineHtml(ins) {
    return '<span class="b-fold">' + ins.map(function (s) {
      return '<i style="--c:var(' + HUE[s[0]] + ");flex-grow:" + (1 + Math.log2(1 + s[1])).toFixed(2) + '"></i>';
    }).join("") + "</span>";
  }
  function outCellHtml(s, i) {
    var extra = s[2] ? '<small class="attn">' + s[2] + "</small>" : "";
    var quiet = i === 4 ? " b-quiet" : "";
    return '<div class="b-cell b-out' + quiet + '"><span class="b-lbl">' + s[0] + '</span><b class="b-num">' + formatCount(s[1]) + extra + '</b><i class="b-line"></i></div>';
  }
  // Events arrive continuously and wait for the next Triage, so the train runs only on the
  // input side (.b-ins) and stops at the Triage interchange. The mini board is a still line.
  function boardHtml(size, data) {
    var train = '<i class="b-train" aria-hidden="true"></i>';
    var x = '<div class="b-cell b-x"><span class="b-lbl">Triage<span class="b-took">' + data.took + '</span></span><b class="b-num">' + data.triage + '</b><i class="b-line"><i class="b-cap"></i></i></div>';
    var next = '<div class="b-cell b-next"><span class="b-lbl">Next</span><b class="b-num">' + data.next + '</b><i class="b-line"></i></div>';
    if (size === "full") {
      // Like a real departures board, the full board has a fixed number of platforms: the five
      // busiest Connections get one each and the quieter ones share the last, so the board keeps
      // its width at 3 Connections or 30.
      var busiest = data.ins.slice(0, 5), quieter = data.ins.slice(5);
      var ins = busiest.map(function (s) {
        return '<div class="b-cell b-in" style="--c:var(' + HUE[s[0]] + ')"><span class="b-lbl" title="' + NAME[s[0]] + '">' + brandSvg(s[0]) + '<span class="b-name">' + NAME[s[0]] + '</span></span><b class="b-num">' + formatCount(s[1]) + '</b><i class="b-line"></i></div>';
      }).join("");
      if (quieter.length) {
        var quieterNames = quieter.map(function (s) { return NAME[s[0]]; }).join(", ");
        var quieterCount = quieter.reduce(function (sum, s) { return sum + s[1]; }, 0);
        ins += '<div class="b-cell b-in b-all"><span class="b-lbl" title="' + quieterNames + '">' + quieter.length + ' more</span><b class="b-num">' + formatCount(quieterCount) + '</b><i class="b-line">' + foldedLineHtml(quieter) + "</i></div>";
      }
      return '<div class="b-ins">' + ins + train + "</div>" + x + '<div class="b-outs">' + data.outs.map(outCellHtml).join("") + next + "</div>";
    }
    if (size === "compact") {
      var all = '<div class="b-cell b-in b-all"><span class="b-lbl">Since 18:20</span><b class="b-num">' + formatCount(data.total) + '</b><i class="b-line">' + foldedLineHtml(data.ins) + "</i></div>";
      var outs = [data.outs[0], data.outs[2], data.outs[4]].map(function (s, i) { return outCellHtml(s, i === 2 ? 4 : i); }).join("");
      return '<div class="b-ins">' + all + train + "</div>" + x + '<div class="b-outs">' + outs + "</div>";
    }
    return foldedLineHtml(data.ins) + '<i class="b-cap"></i><i class="b-ink"></i>' +
      '<span class="b-say"><b>' + data.outs[0][1] + "</b> proposals · " + '<span class="attn">' + data.outs[0][2] + "</span></span>";
  }
  function drawBoard(el) {
    var size = el.dataset.flow || "full";
    var data = BOARD[el.dataset.scale === "10x" || AT_10X ? "10x" : "today"];
    el.classList.add("board", "board--" + size);
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", formatCount(data.total) + " events since yesterday 18:20; Triage at " + data.triage + " made " +
      data.outs.map(function (s) { return formatCount(s[1]) + " " + s[0].toLowerCase(); }).join(", ") + "; next triage " + data.next);
    el.innerHTML = boardHtml(size, data);
  }

  // ---------------------------------------------------------------- glass composer
  // The composer shrinks to a pill while the transcript is scrolled up, at every glass level;
  // at level 0 the pill is simply solid.
  function wireComposer(scroller) {
    var host = scroller.closest("[data-glass-host]") || scroller.parentElement;
    var composer = host.querySelector(".composer");
    var forced = document.documentElement.dataset.state === "scrolled";
    function atBottom() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    }
    function update() {
      var focused = composer && composer.contains(document.activeElement);
      host.classList.toggle("is-shrunk", !focused && !atBottom());
    }
    if (forced) {
      // Park the transcript so its last turns run underneath the shrunk composer.
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - Number(scroller.dataset.scrolledBy || 300));
      host.classList.add("is-shrunk");
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    scroller.addEventListener("scroll", update, { passive: true });
    if (composer) {
      composer.addEventListener("focusin", update);
      composer.addEventListener("focusout", function () { setTimeout(update, 0); });
      composer.addEventListener("click", function () {
        if (host.classList.contains("is-shrunk")) {
          scroller.scrollTo({ top: scroller.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        }
      });
    }
    if (!forced) update();
  }

  // ---------------------------------------------------------------- run
  function run() {
    document.querySelectorAll("[data-sidebar]").forEach(function (el) {
      el.innerHTML = sidebarHtml(el.dataset.sidebar, el.dataset.current, el.hasAttribute("data-web"));
    });
    document.querySelectorAll("[data-statusbar]").forEach(function (el) {
      el.innerHTML = statusbarHtml(el.dataset.statusbar);
    });
    document.querySelectorAll("[data-tabbar]").forEach(function (el) {
      el.innerHTML = tabbarHtml(el.dataset.tabbar);
    });
    document.querySelectorAll("[data-flow]").forEach(drawBoard);
    document.querySelectorAll("[data-appicon]").forEach(function (el) {
      el.outerHTML = appIconSvg(Number(el.dataset.appicon || 32), classOf(el, "appicon"));
    });
    document.querySelectorAll("[data-logo]").forEach(function (el) {
      el.outerHTML = logoSvg(Number(el.dataset.logo || 20), classOf(el, "logo"));
    });
    document.querySelectorAll("i[data-i]").forEach(function (el) {
      el.outerHTML = iconSvg(el.dataset.i, classOf(el, "icon"), styleOf(el));
    });
    document.querySelectorAll("i[data-mk]").forEach(function (el) {
      el.outerHTML = markSvg(el.dataset.mk, el.getAttribute("class"), styleOf(el));
    });
    document.querySelectorAll("i[data-brand]").forEach(function (el) {
      el.outerHTML = brandSvg(el.dataset.brand, classOf(el, "brand"), styleOf(el));
    });
    document.querySelectorAll("[data-line]").forEach(function (el) {
      el.style.setProperty("--c", "var(" + HUE[el.dataset.line] + ")");
    });
    document.querySelectorAll("[data-glass]").forEach(wireComposer);
    // ?state=scrolled parks a page's pane part way down, so rows run under its floating glass.
    if (document.documentElement.dataset.state === "scrolled") {
      document.querySelectorAll("[data-scrolled-to]").forEach(function (el) {
        el.scrollTop = Number(el.dataset.scrolledTo);
      });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
