// Metro Wayfinding - the page kit.
// PROTOTYPE. Loaded with `defer` by every page. It:
//   - replaces <i data-i="name">, <i data-mk="state"> and <i data-brand="id"> with inline SVG,
//   - draws a Proposal's "made from" glyph from <i data-strip="sentry gmail">,
//   - fills the shared chrome: [data-sidebar], [data-setnav], [data-statusbar], [data-tabbar],
//     and the identity: [data-logo] (the logomark) and [data-appicon] (the app icon),
//   - draws the Intake flow diagram into <svg data-netmap>,
//   - runs the glass composer: it shrinks while the transcript is scrolled up.
// Inline SVG (not <use>) keeps every mark styleable and animatable by system.css.
(function () {
  "use strict";

  // ---------------------------------------------------------------- icons: 16px grid, 1.4 stroke
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
    bell: '<path d="M4.2 10.8V7.4a3.8 3.8 0 0 1 7.6 0v3.4l1 1.5H3.2zM6.6 14.1h2.8"/>',
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
    system: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3"/>',
    intake: '<path d="M1.8 4h3.6l2.8 3M1.8 8h7.2M1.8 12h3.6l2.8-3"/><rect x="9.2" y="5.4" width="4.8" height="5.2" rx="2.4"/>',
    checkin: '<path d="M2.6 4.2h7M2.6 8h5M2.6 11.8h4"/><path d="m9.6 10.6 1.7 1.7 3-3.4"/>',
    task: '<rect x="3" y="3" width="10" height="10" rx="2.8"/>',
    run: '<path d="M4.6 3v10a.7.7 0 0 0 1.1.6l7.3-5a.7.7 0 0 0 0-1.2L5.7 2.4a.7.7 0 0 0-1.1.6z"/>',
    workflow: '<circle cx="3.6" cy="8" r="1.7"/><circle cx="12.4" cy="3.8" r="1.7"/><circle cx="12.4" cy="12.2" r="1.7"/><path d="M5.3 8h3l2.6-3.2M8.3 8l2.6 3.2"/>',
    fleet: '<rect x="2.2" y="2.6" width="11.6" height="4.4" rx="1.3"/><rect x="2.2" y="9" width="11.6" height="4.4" rx="1.3"/><path d="M4.8 4.8h.01M4.8 11.2h.01" stroke-width="2"/>',
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
    marks: '<path d="M2.6 8h4.2"/><rect x="7.4" y="5.4" width="6" height="5.2" rx="2.6"/>',
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
    split: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M8 3v10"/>',
    back: '<path d="M10 3 5 8l5 5" stroke-width="1.8"/>',
    gear: '<circle cx="8" cy="8" r="2"/><path d="M6.9 1.9h2.2l.4 1.7 1.2.7 1.7-.5 1.1 1.9-1.3 1.2v1.4l1.3 1.2-1.1 1.9-1.7-.5-1.2.7-.4 1.7H6.9l-.4-1.7-1.2-.7-1.7.5-1.1-1.9 1.3-1.2V7.3L2.5 6.1l1.1-1.9 1.7.5 1.2-.7z"/>',
    code: '<path d="m5.6 4.4-3.4 3.6 3.4 3.6M10.4 4.4l3.4 3.6-3.4 3.6"/>',
    commit: '<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>',
    fullscreen: '<path d="M2.8 6V2.8H6M10 2.8h3.2V6M13.2 10v3.2H10M6 13.2H2.8V10"/>',
  };

  // ---------------------------------------------------------------- marks: 12px grid
  // The six state marks. Each means one thing on every screen, and the book explains each once.
  // The word beside a mark says the detail (asleep, queued, bound tripped); the mark stays one of six.
  var MK = {
    work: '<circle class="halo" cx="6" cy="6" r="5" fill="currentColor" opacity=".35"/><circle cx="6" cy="6" r="2.7" fill="currentColor"/>',
    wait: '<circle cx="6" cy="6" r="3.9" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    done: '<circle cx="6" cy="6" r="5" fill="currentColor"/><path d="m3.7 6.1 1.6 1.6 3-3.3" fill="none" stroke="var(--casing)" style="stroke:var(--casing)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    fail: '<path d="m2.8 2.8 6.4 6.4M9.2 2.8 2.8 9.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    paused: '<circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.8 4.3v3.4M7.2 4.3v3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    idle: '<circle cx="6" cy="6" r="3.9" fill="none" stroke="currentColor" stroke-width="1.3"/>',
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
    pi: '<text x="12" y="18.6" text-anchor="middle" font-family="Overpass Mono, monospace" font-size="21" font-weight="700" fill="currentColor">&#960;</text>',
  };

  // Line hue per Connection, as a CSS custom property name.
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
    you: "--trunk",
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
  window.MetroHue = HUE;

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
      'class="' + cls + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"' + (style || ""),
      I[name] || ""
    );
  }
  // Each mark carries its own color class (mk-work, mk-wait...), so a mark looks the same on every
  // screen whatever the row around it says.
  function markSvg(name, cls, style) {
    return svg('class="' + ("mk mk-" + name + " " + (cls || "")).trim() + '" viewBox="0 0 12 12"' + (style || ""), MK[name] || "");
  }
  function brandSvg(id, cls, style) {
    var body = BR[id] ? '<path fill="currentColor" d="' + BR[id] + '"/>' : BR_EXTRA[id] || "";
    return svg('class="' + cls + '" viewBox="0 0 24 24"' + (style || ""), body);
  }
  window.MetroBrand = brandSvg;
  window.MetroIcon = iconSvg;
  window.MetroMark = markSvg;

  // ---------------------------------------------------------------- the made-from glyph
  // Draws a Proposal's "made from": one short line per source Connection, in that Connection's
  // hue, running into a neutral capsule that stands for the Proposal. It is the one row glyph that
  // borrows the map, because it shows something that moved: events merging into one piece of work.
  // State never rides on it; a state mark sits beside it when one is needed.
  //   <i data-strip="sentry gmail posthog github" data-size="s|l">
  function stripSvg(el) {
    var lines = el.dataset.strip.split(/\s+/);
    var k = el.dataset.size === "s" ? 0.8 : el.dataset.size === "l" ? 1.5 : 1;
    var n = lines.length;
    var H = 24 * k;
    var W = 26 * k;
    var sp = (n >= 4 ? 4 : n === 3 ? 4.6 : 5.2) * k;
    var lw = (n >= 4 ? 2.3 : 2.6) * k;
    var span = (n - 1) * sp;
    var cy = H / 2;
    var capX = 17 * k;
    var capW = 8.4 * k;
    var o = "";
    lines.forEach(function (ln, i) {
      var y = cy - span / 2 + i * sp;
      o += '<line x1="' + 2 * k + '" y1="' + y + '" x2="' + capX + '" y2="' + y + '" style="stroke:var(' + HUE[ln] + ')" stroke-width="' + lw + '" stroke-linecap="round"/>';
    });
    o += '<rect x="' + (capX - capW / 2) + '" y="' + (cy - (span + capW) / 2) + '" width="' + capW + '" height="' + (span + capW) + '" rx="' + capW / 2 + '" style="fill:var(--casing);stroke:var(--trunk)" stroke-width="' + 1.9 * k + '"/>';
    return svg('class="' + classOf(el, "strip") + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '"', o);
  }

  // ---------------------------------------------------------------- shared chrome
  // The office's "At 10x" view (?state=swarm) shows the same product with ten times the work.
  var AT_10X = document.documentElement.dataset.state === "swarm";

  // What waits on Rogier, Threads and Runs alike. It heads both sidebar faces, one row each: the
  // item's title, then the question on one line.
  var WAITING = [
    { id: "fix3ds", title: "Fix 3-D Secure checkout for EU cards", ask: "Run git push?", href: "session-active.html" },
    { id: "grafana", title: "Migrate ops dashboards", ask: "Keep the old Grafana folder?" },
    { id: "release", title: "Ship release v2.15", ask: "Publish 2.15.0 to npm?", run: true },
  ];

  // The Threads face (spec 14, the sidebar), modelled on t3-code: Threads grouped by project. A row
  // is the title, a quiet meta line (branch · machine), and at the right the state mark when the
  // Thread is working or waiting on you, or its age when it is idle.
  var PROJECTS = [
    { name: "webshop", rows: [
      { id: "fix3ds", title: "Fix 3-D Secure checkout for EU cards", meta: "fix/3ds-eu-cards · studio-mac", mk: "wait", href: "session-active.html" },
      { id: "stripe14", title: "Read the Stripe v14 changelog", meta: "fix/3ds-eu-cards · studio-mac", age: "20m" },
      { id: "cart", title: "Refactor cart totals", meta: "refactor/cart-totals · build-box-1", mk: "work" },
      { id: "css", title: "Tidy checkout CSS", meta: "tidy/checkout-css · build-box-1", age: "2h" },
    ] },
    { name: "payments-api", rows: [
      { id: "payout", title: "Payout report for September", meta: "payout-report-sep · build-box-1", mk: "work" },
      { id: "ideal", title: "Add iDEAL research", meta: "research/ideal · build-box-2", age: "1h" },
    ] },
    { name: "ops", rows: [
      { id: "grafana", title: "Migrate ops dashboards", meta: "migrate-dashboards · studio-mac", mk: "wait" },
      { id: "secrets", title: "Rotate staging secrets", meta: "rotate-staging · build-box-1", mk: "work" },
    ] },
  ];
  // Assistants show presence as a mark and a word: working, idle, asleep.
  var ASSISTANTS = [
    { id: "ada", title: "Ada", presence: "working", mk: "work", href: "assistant.html" },
    { id: "milo", title: "Milo", presence: "idle", mk: "idle" },
    { id: "juno", title: "Juno", presence: "asleep", mk: "idle" },
  ];

  // The current Thread is highlighted where it lives, in its project, and not a second time here.
  function waitingHtml() {
    var o = '<section class="side-sec side-waiting" aria-label="Waiting on you"><h2 class="side-label">Waiting on you<span>' + (AT_10X ? 11 : 3) + "</span></h2>";
    WAITING.forEach(function (w) {
      o +=
        '<a class="wt-row" href="' + (w.href || "#") + '">' +
        markSvg("wait", "") +
        '<span class="wt-title">' + w.title + (w.run ? '<span class="wt-kind">Run</span>' : "") + "</span>" +
        '<span class="wt-ask">' + w.ask + "</span></a>";
    });
    return o + "</section>";
  }

  function threadRow(r, current) {
    var end = r.mk ? markSvg(r.mk, "") : '<span class="tl-age">' + r.age + "</span>";
    return (
      '<a class="tl-row" href="' + (r.href || "#") + '"' + (r.id === current ? ' aria-current="page"' : "") + ">" +
      '<span class="tl-title">' + r.title + "</span>" +
      '<span class="tl-end">' + end + "</span>" +
      '<span class="tl-meta">' + r.meta + "</span></a>"
    );
  }

  function threadsFaceHtml(current) {
    var o =
      '<button class="side-action">' + iconSvg("compose", "") + "New thread<kbd>&#8984;N</kbd></button>" +
      '<button class="side-action">' + iconSvg("search", "") + "Search<kbd>&#8984;K</kbd></button>";
    o += waitingHtml();
    PROJECTS.forEach(function (p) {
      o +=
        '<section class="side-sec" aria-label="' + p.name + '"><div class="side-proj">' + iconSvg("folder", "") + p.name +
        '<button class="icon-btn" aria-label="New thread in ' + p.name + '">' + iconSvg("plus", "") + "</button></div>";
      // A Draft Thread shows at the top of its project until it is sent.
      if (current === "draft" && p.name === "webshop") {
        o += threadRow({ id: "draft", title: "New thread", meta: "new worktree · studio-mac", age: "draft", href: "session-empty.html" }, current);
      }
      p.rows.forEach(function (r) { o += threadRow(r, current); });
      o += "</section>";
    });
    o += '<section class="side-sec" aria-label="Assistants"><h2 class="side-label">Assistants</h2>';
    ASSISTANTS.forEach(function (a) {
      o +=
        '<a class="as-row" href="' + (a.href || "#") + '"' + (a.id === current ? ' aria-current="page"' : "") + ">" +
        '<span class="as-av">' + a.title[0] + "</span>" + a.title +
        '<span class="as-pr">' + markSvg(a.mk, "") + a.presence + "</span></a>";
    });
    return o + "</section>";
  }

  // The Hercule face, modelled on Aurora's without its glows: sections set apart by space and a
  // small label, never by a line. Every count sits in one right-aligned column.
  var NAV = [
    ["Work", [
      ["intake", "Intake", "intake", AT_10X ? 83 : 9, "intake.html"],
      ["checkin", "Check-in", "checkin", "09:00"],
      ["tasks", "Tasks", "task", AT_10X ? 96 : 12],
      ["runs", "Runs", "run", AT_10X ? 52 : 6],
      ["workflows", "Workflows", "workflow", AT_10X ? 14 : 6],
    ]],
    ["System", [
      ["fleet", "Fleet", "fleet", AT_10X ? 140 : 16, "office.html"],
      ["connections", "Connections", "plug", 11, "settings-connections.html"],
      ["notifications", "Notifications", "bell", AT_10X ? 12 : 5],
      ["settings", "Settings", "gear", "", "settings-appearance.html"],
    ]],
  ];

  function herculeFaceHtml(current) {
    var o = '<button class="side-action">' + iconSvg("search", "") + "Search<kbd>&#8984;K</kbd></button>";
    o += waitingHtml();
    NAV.forEach(function (sec) {
      o += '<nav class="side-sec" aria-label="' + sec[0] + '"><h2 class="side-label">' + sec[0] + "</h2>";
      sec[1].forEach(function (n) {
        o +=
          '<a class="nav-row" href="' + (n[4] || "#") + '"' + (n[0] === current ? ' aria-current="page"' : "") + ">" +
          iconSvg(n[2], "") + n[1] + '<span class="count">' + n[3] + "</span></a>";
      });
      o += "</nav>";
    });
    return o;
  }

  function sidebarHtml(face, current, web) {
    var o = web ? '<div class="side-top side-top--web"><span class="logo-row">' + logoSvg(20) + "<b>Hercule</b></span><button class=\"icon-btn\" aria-label=\"Hide sidebar\">" + iconSvg("sidebar", "") + "</button></div>" :
      '<div class="side-top"><div class="traffic"><i></i><i></i><i></i></div><button class="icon-btn" aria-label="Hide sidebar">' + iconSvg("sidebar", "") + "</button></div>";
    o +=
      '<div class="faces" role="group" aria-label="Sidebar face"><button aria-pressed="' + (face === "threads") + '">Threads</button><button aria-pressed="' + (face === "hercule") + '">Hercule</button></div>';
    o += '<div class="side-body">' + (face === "threads" ? threadsFaceHtml(current) : herculeFaceHtml(current)) + "</div>";
    var n = AT_10X ? [70, 11, 6, 53] : [8, 3, 1, 4];
    o +=
      '<div class="side-foot"><a class="pulse" href="office.html" aria-label="' + (n[0] + n[1] + n[2] + n[3]) + ' live sessions, open the office">' +
      "<b>" + n[0] + "</b> working · " + '<b class="attn">' + n[1] + "</b> waiting · " + "<b>" + n[2] + "</b> paused · " + "<b>" + n[3] + "</b> idle</a>" +
      '<div class="me"><span class="avatar">R</span>Rogier<button class="icon-btn" aria-label="Settings">' + iconSvg("gear", "") + "</button></div></div>";
    return o;
  }

  var SETNAV = [
    ["profile", "Profile", "user"],
    ["appearance", "Appearance", "palette", "settings-appearance.html"],
    ["threads", "Threads", "thread"],
    ["assistants", "Assistants", "bot", "settings-assistants.html"],
    ["connections", "Connections", "plug", "settings-connections.html"],
    ["providers", "Providers", "box", "../web/settings-providers.html"],
    ["machines", "Machines", "server"],
    ["identities", "Identities", "id"],
    ["permissions", "Permission profiles", "shield"],
    ["secrets", "Secrets", "key"],
    ["bounds", "Bounds", "bound"],
    ["plugins", "Plugins", "puzzle"],
    ["system", "System", "system"],
  ];
  function setnavHtml(current) {
    return SETNAV.map(function (s) {
      return '<a href="' + (s[3] || "#") + '"' + (s[0] === current ? ' aria-current="page"' : "") + ">" + iconSvg(s[2], "") + s[1] + "</a>";
    }).join("");
  }

  // The logomark: an H drawn as two lines joined by an interchange.
  function logoSvg(size, cls) {
    return (
      '<svg class="' + (cls || "logo") + '" width="' + size + '" height="' + size + '" viewBox="0 0 32 32" aria-hidden="true">' +
      '<path d="M8.5 5v22M23.5 5v22" style="stroke:var(--logo-a, var(--ink))" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M23.5 5v22" style="stroke:var(--logo-b, var(--ink))" stroke-width="5" stroke-linecap="round"/>' +
      '<rect x="4.2" y="11.6" width="23.6" height="8.8" rx="4.4" style="fill:var(--casing, #fff);stroke:var(--ink)" stroke-width="2.4"/>' +
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
      '<defs><linearGradient id="ai-plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b352f"/><stop offset="1" stop-color="#1b1815"/></linearGradient>' +
      '<linearGradient id="ai-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>' +
      '<rect x="3" y="3" width="58" height="58" rx="13.5" fill="url(#ai-plate)"/>' +
      '<rect x="3" y="3" width="58" height="58" rx="13.5" fill="url(#ai-sheen)"/>' +
      '<rect x="3.5" y="3.5" width="57" height="57" rx="13" fill="none" stroke="#fff" stroke-opacity=".14"/>' +
      '<path d="M21.5 15v34" stroke="#e5553f" stroke-width="8.5" stroke-linecap="round"/>' +
      '<path d="M42.5 15v34" stroke="#f1c24f" stroke-width="8.5" stroke-linecap="round"/>' +
      '<rect x="14.5" y="25.2" width="35" height="13.6" rx="6.8" fill="#fbf8f2" stroke="#1b1815" stroke-width="3"/>' +
      "</svg>"
    );
  }
  window.MetroAppIcon = appIconSvg;

  function statusbarHtml(time, dark) {
    return (
      "<span>" + (time || "9:41") + '</span><span class="island"></span><span class="sys">' +
      '<svg viewBox="0 0 18 12" width="18" height="12"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor"/><rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>' +
      '<svg viewBox="0 0 16 12" width="16" height="12"><path d="M8 11.3 5.6 8.8a3.4 3.4 0 0 1 4.8 0zM3.3 6.6a6.6 6.6 0 0 1 9.4 0l-1.2 1.2a4.9 4.9 0 0 0-7 0zM1 4.3a9.9 9.9 0 0 1 14 0l-1.2 1.2a8.2 8.2 0 0 0-11.6 0z" fill="currentColor"/></svg>' +
      '<svg viewBox="0 0 27 13" width="27" height="13"><rect x=".5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="9" rx="2.4" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" fill="currentColor" opacity=".45"/></svg>' +
      "</span>"
    );
  }

  var TABS = [
    ["intake", "Intake", "intake", "intake.html", 9],
    ["threads", "Threads", "thread", "session-active.html"],
    ["assistants", "Assistants", "bot", "assistant.html"],
    ["fleet", "Fleet", "fleet", "#"],
  ];
  function tabbarHtml(current) {
    return TABS.map(function (t) {
      return '<a href="' + t[3] + '"' + (t[0] === current ? ' aria-current="page"' : "") + ">" + iconSvg(t[2], "") + t[1] + (t[4] ? '<span class="badge">' + t[4] + "</span>" : "") + "</a>";
    }).join("");
  }

  // ---------------------------------------------------------------- the Intake flow diagram
  // What came in since yesterday 18:20, drawn as lines into the Triage capsule and out to what each
  // event became. Line weight grows with the number of events on a log scale, so a flood of Sentry
  // events stays one line instead of a longer list. Each outcome ends in its state mark: waiting on
  // you, paused (held), done (attached), idle (FYI), or a plain end bar for "no action".
  var IN = [
    ["sentry", 130],
    ["github", 38],
    ["gmail", 17],
    ["stripe", 12],
    ["intercom", 9],
    ["posthog", 3],
    ["grafana", 2],
    ["cron", 1],
  ];
  var OUT = [
    ["5 proposals", 5, "wait"],
    ["2 offers", 2, "wait"],
    ["1 unsure", 1, "wait"],
    ["34 held", 34, "paused"],
    ["1 attached", 1, "done"],
    ["3 FYI", 3, "idle"],
    ["166 no action", 166, "end"],
  ];
  function weight(n) {
    return 1.5 + 0.8 * Math.log2(1 + n);
  }
  // Reads a diagram's sources and outcomes from the element, or falls back to today's numbers.
  //   data-in="sentry:1300 github:380"   data-out="60 proposals:60:wait;2,287 no action:2287:end"
  function readNetmapData(el) {
    var ins = el.dataset.in
      ? el.dataset.in.split(/\s+/).map(function (p) { var q = p.split(":"); return [q[0], Number(q[1])]; })
      : IN;
    var outs = el.dataset.out
      ? el.dataset.out.split(";").map(function (p) { var q = p.split(":"); return [q[0], Number(q[1]), q[2]]; })
      : OUT;
    return { ins: ins, outs: outs };
  }
  function drawNetmap(el) {
    var W = Number(el.getAttribute("width"));
    var H = Number(el.getAttribute("height"));
    var data = readNetmapData(el);
    var IN_ = data.ins;
    var OUT_ = data.outs;
    var labelW = Number(el.dataset.labelw || 118);
    var outLabelW = Number(el.dataset.outw || 88);
    var rowH = Number(el.dataset.row || 26);
    var top = Number(el.dataset.top || 34);
    var capX = Math.round(labelW + (W - labelW - outLabelW) * Number(el.dataset.capAt || 0.5));
    var capW = 22;
    var gap = 2;
    var total = IN_.reduce(function (a, s) { return a + weight(s[1]); }, 0) + gap * (IN_.length - 1);
    var cy = top + ((IN_.length - 1) * rowH) / 2;
    var capH = total + 14;
    var o = "";
    var acc = cy - total / 2;
    IN_.forEach(function (s, i) {
      var w = weight(s[1]);
      var ry = top + i * rowH;
      var by = acc + w / 2;
      acc += w + gap;
      var dy = Math.abs(by - ry);
      var bendEnd = capX - capW / 2 - 8;
      var bendStart = bendEnd - dy;
      var x0 = labelW + 14;
      var d = "M" + x0 + " " + ry + " H" + bendStart.toFixed(1) + " L" + bendEnd.toFixed(1) + " " + by.toFixed(1) + " H" + capX;
      o += '<path d="' + d + '" fill="none" style="stroke:var(--casing)" stroke-width="' + (w + 3) + '" stroke-linecap="round" stroke-linejoin="round"/>';
      o += '<path d="' + d + '" fill="none" style="stroke:var(' + HUE[s[0]] + ')" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"/>';
      o += '<g transform="translate(0 ' + (ry - 7) + ')" style="color:var(--ink)">' + brandSvg(s[0], "", "").replace("<svg ", '<svg width="14" height="14" ') + "</g>";
      o += '<text class="lbl" x="21" y="' + (ry + 4.2) + '">' + NAME[s[0]] + "</text>";
      o += '<text class="num-ink" x="' + labelW + '" y="' + (ry + 4) + '" text-anchor="end">' + s[1].toLocaleString("en-US") + "</text>";
    });
    var outTotal = OUT_.reduce(function (a, s) { return a + weight(s[1]); }, 0) + gap * (OUT_.length - 1);
    var acc2 = cy - outTotal / 2;
    var outRow = Number(el.dataset.outrow || rowH * 1.15);
    var oTop = cy - ((OUT_.length - 1) * outRow) / 2;
    var sx = W - outLabelW;
    OUT_.forEach(function (s, i) {
      var w = weight(s[1]);
      var by = acc2 + w / 2;
      acc2 += w + gap;
      var ry = oTop + i * outRow;
      var dy = Math.abs(by - ry);
      var bs = capX + capW / 2 + 8;
      var be = bs + dy;
      var end = sx - 12;
      var quiet = s[2] === "end";
      var d = "M" + capX + " " + by.toFixed(1) + " H" + bs + " L" + be.toFixed(1) + " " + ry.toFixed(1) + " H" + (quiet ? end : end - 7);
      o += '<path d="' + d + '" fill="none" style="stroke:var(--casing)" stroke-width="' + (w + 3) + '" stroke-linejoin="round"/>';
      o += '<path d="' + d + '" fill="none" style="stroke:var(' + (quiet ? "--line" : "--trunk") + ')" stroke-width="' + w + '" stroke-linejoin="round"/>';
      if (quiet) {
        o += '<path d="M' + end + " " + (ry - 7) + "V" + (ry + 7) + '" style="stroke:var(--faint)" stroke-width="2.5" stroke-linecap="round"/>';
      } else {
        o += '<g transform="translate(' + (end - 6) + " " + (ry - 6) + ')">' + markSvg(s[2], "").replace("<svg ", '<svg width="12" height="12" ') + "</g>";
      }
      var parts = s[0].split(" ");
      o += '<text x="' + (sx + 2) + '" y="' + (ry + 4) + '"><tspan class="num-ink">' + parts[0] + '</tspan><tspan class="lbl lbl-muted" dx="4">' + parts.slice(1).join(" ") + "</tspan></text>";
    });
    // The Triage capsule, labelled above the diagram and timed below it, clear of every line.
    o += '<rect x="' + (capX - capW / 2) + '" y="' + (cy - capH / 2) + '" width="' + capW + '" height="' + capH + '" rx="' + capW / 2 + '" style="fill:var(--casing);stroke:var(--trunk)" stroke-width="2.5"/>';
    o += '<text class="cap-lbl" x="' + capX + '" y="' + Math.max(12, top - 12) + '" text-anchor="middle">Triage</text>';
    o += '<text class="num" x="' + capX + '" y="' + (H - 3) + '" text-anchor="middle">' + (el.dataset.when || "09:00 · 42s · next 11:00") + "</text>";
    el.innerHTML = o;
  }

  // ---------------------------------------------------------------- glass composer
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
      // The current row can sit below the fold (an Assistant is last in the list). Scroll the list
      // so that row shows, the way a real sidebar keeps the open item in view.
      var list = el.querySelector(".side-body");
      var cur = list && list.querySelector('[aria-current="page"]');
      var below = cur ? cur.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom : 0;
      if (below > 0) list.scrollTop = below + 24;
      // A list that runs past its top or bottom edge fades out there instead of cutting a row in half.
      if (list) {
        list.classList.toggle("side-body--above", list.scrollTop > 0);
        list.classList.toggle("side-body--more", list.scrollHeight - list.scrollTop > list.clientHeight + 1);
      }
    });
    document.querySelectorAll("[data-setnav]").forEach(function (el) {
      el.innerHTML = setnavHtml(el.dataset.setnav);
    });
    document.querySelectorAll("[data-statusbar]").forEach(function (el) {
      el.innerHTML = statusbarHtml(el.dataset.statusbar);
    });
    document.querySelectorAll("[data-tabbar]").forEach(function (el) {
      el.innerHTML = tabbarHtml(el.dataset.tabbar);
    });
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
      el.outerHTML = markSvg(el.dataset.mk, el.getAttribute("class") || "", styleOf(el));
    });
    document.querySelectorAll("i[data-brand]").forEach(function (el) {
      el.outerHTML = brandSvg(el.dataset.brand, classOf(el, "brand"), styleOf(el));
    });
    document.querySelectorAll("i[data-strip]").forEach(function (el) {
      el.outerHTML = stripSvg(el);
    });
    document.querySelectorAll("[data-line]").forEach(function (el) {
      el.style.setProperty("--c", "var(" + HUE[el.dataset.line] + ")");
    });
    document.querySelectorAll("svg[data-netmap]").forEach(drawNetmap);
    document.querySelectorAll("[data-glass]").forEach(wireComposer);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
