// PROTOTYPE - Tide: the shared script every Tide page loads (deferred, after the stylesheets).
//
// It does five things, all before the page's load event so a screenshot sees the result:
//   1. Expands marks: <i data-m="working"></i> becomes an inline SVG from the mark family below,
//      <i data-b="sentry"></i> a monochrome source mark, <i data-logo></i> the Hercule logomark.
//      Inline SVG (not <use href="marks.svg#...">) because external sprites fail under file://.
//   2. Builds the shell chrome a page asks for: the desktop sidebar ([data-side]), the web rail
//      ([data-rail]), the mobile status bar and tab bar ([data-status], [data-tabs]).
//   3. Draws time: the titlebar tideline ([data-tideline]) and every tide chart ([data-tide]),
//      all from one event set, so every count on every page agrees.
//   4. Runs the composer glass on session pages: the composer shrinks and turns see-through while
//      the transcript scrolls, and restores at the bottom or on focus. ?state=scrolled forces it.
//   5. Wires the few live interactions (segmented switches, theme options inside a page).
(function () {
  "use strict";
  var root = document.documentElement;

  // ------------------------------------------------------------------ marks (16px grid, 1.5 stroke)
  var MARKS = {
    // state
    working:
      '<path class="wv" d="M-8 8.6q2-3.6 4 0t4 0t4 0t4 0t4 0t4 0t4 0t4 0"/>',
    decision:
      '<circle class="fill" cx="8" cy="8" r="6.6"/><path class="knock" d="M6.25 6.35a1.8 1.8 0 1 1 2.55 1.65c-.55.26-.8.66-.8 1.2v.25"/><circle class="knock-dot" cx="8" cy="11.35" r=".85"/>',
    unsure:
      '<circle cx="8" cy="8" r="5.9" stroke-dasharray="2.4 1.9"/><path d="M6.35 6.45a1.7 1.7 0 1 1 2.4 1.55c-.5.24-.75.62-.75 1.1v.2"/><circle class="dot" cx="8" cy="11.1" r=".8"/>',
    queued: '<circle cx="8" cy="8" r="5" stroke-dasharray="2.2 2"/>',
    paused: '<path d="M6 4.75v6.5M10 4.75v6.5"/>',
    done: '<path d="M3.6 8.5l2.9 2.9 5.9-6.4"/>',
    failed: '<path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/>',
    cancelled: '<circle cx="8" cy="8" r="5"/><path d="M4.6 11.4l6.8-6.8"/>',
    skipped: '<path d="M3.8 4.6L7.2 8l-3.4 3.4M8.6 4.6L12 8l-3.4 3.4"/>',
    idle: '<circle cx="8" cy="8" r="4.6"/>',
    asleep: '<path d="M12.6 10.1A5.2 5.2 0 1 1 6.9 3.1a4.1 4.1 0 0 0 5.7 7z"/>',
    unreachable: '<path d="M11.9 5.1A5 5 0 0 1 9.8 12.6M6.2 12.6A5 5 0 0 1 4.1 5.1M6 3.4A5 5 0 0 1 10 3.4"/><path d="M8 6.2v2.4"/><circle class="dot" cx="8" cy="10.6" r=".8"/>',
    // entities
    task: '<rect x="2.9" y="2.9" width="10.2" height="10.2" rx="3.2"/>',
    run: '<path d="M5 3.6v8.8l7.2-4.4z"/>',
    session:
      '<path d="M3 4.6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4.3a2 2 0 0 1-2 2H7.6L4.6 13.4v-2.6A2 2 0 0 1 3 8.9z"/>',
    workflow:
      '<circle cx="3.9" cy="8" r="1.6"/><circle cx="12.1" cy="4" r="1.6"/><circle cx="12.1" cy="12" r="1.6"/><path d="M5.5 8h1.7c1.6 0 1.6-4 3.3-4M7.2 8c1.6 0 1.6 4 3.3 4"/>',
    // time
    heartbeat: '<circle cx="8" cy="9.4" r="1.9"/><path d="M4.9 6.3a4.4 4.4 0 0 1 6.2 0M2.7 4.1a7.5 7.5 0 0 1 10.6 0"/>',
    reminder: '<path d="M4.2 14V2.6M4.2 3.2h7.6l-2 2.7 2 2.7H4.2"/>',
    triage: '<path d="M2.6 3.4h10.8l-4.1 4.9v4.5l-2.6-1.3V8.3z"/>',
    clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.9V8l2 1.3"/>',
    now: '<path d="M8 2v12"/><circle class="fill" cx="8" cy="8" r="2.4"/>',
    offer: '<path d="M9.2 2.2L4 9h3.9l-1.1 4.8L12 7H8z"/>',
    fyi: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.4v3.6"/><circle class="dot" cx="8" cy="5.2" r=".8"/>',
    notice: '<path d="M8 2.6l5.9 10.3H2.1z"/><path d="M8 6.7v2.8"/><circle class="dot" cx="8" cy="11.1" r=".75"/>',
    event: '<circle class="fill" cx="8" cy="8" r="2.2"/>',
    attach: '<path d="M10.5 5.2L6 9.7a1.4 1.4 0 0 0 2 2l4.6-4.6a2.8 2.8 0 0 0-4-4L4 7.7a4.2 4.2 0 0 0 6 6l3.6-3.6"/>',
    // navigation
    intake: '<path d="M1.8 11.2q1.55-2.3 3.1 0t3.1 0t3.1 0t3.1 0"/><path d="M8 2.3v5.4M5.6 5.4L8 7.8l2.4-2.4"/>',
    checkin: '<path d="M3.1 8.6a5 5 0 1 0 1.5-4.1"/><path d="M3.3 2.8v2.6h2.6"/><path d="M8 5.6V8.3l1.9 1.2"/>',
    fleet: '<rect x="2.6" y="2.6" width="10.8" height="4.4" rx="1.3"/><rect x="2.6" y="9" width="10.8" height="4.4" rx="1.3"/><path d="M5 4.8h.01M5 11.2h.01"/>',
    connections: '<path d="M6 2.5v3M10 2.5v3M4.4 5.5h7.2v2.6a3.6 3.6 0 0 1-7.2 0zM8 11.7V14"/>',
    bell: '<path d="M4.1 11.2V7.6a3.9 3.9 0 0 1 7.8 0v3.6l1.1 1.4H3z"/><path d="M6.6 14.2h2.8"/>',
    settings: '<path d="M2.6 5h5.6M11.8 5h1.6M2.6 11h1.6M7.8 11h5.6"/><circle cx="10" cy="5" r="1.7"/><circle cx="6" cy="11" r="1.7"/>',
    office: '<path d="M8 2.2l5.4 3v5.6L8 13.8l-5.4-3V5.2z"/><path d="M2.6 5.2L8 8.2l5.4-3M8 8.2v5.6"/>',
    list: '<path d="M5.8 4.5h7.4M5.8 8h7.4M5.8 11.5h7.4"/><circle class="dot" cx="3" cy="4.5" r=".9"/><circle class="dot" cx="3" cy="8" r=".9"/><circle class="dot" cx="3" cy="11.5" r=".9"/>',
    profile: '<circle cx="8" cy="5.6" r="2.7"/><path d="M3 13.6c.6-2.6 2.6-3.8 5-3.8s4.4 1.2 5 3.8"/>',
    appearance: '<circle cx="8" cy="8" r="5.6"/><path class="fill" d="M8 2.4a5.6 5.6 0 0 1 0 11.2z"/>',
    providers: '<path d="M8 2.2c.5 3.1 2.7 5.3 5.8 5.8-3.1.5-5.3 2.7-5.8 5.8-.5-3.1-2.7-5.3-5.8-5.8 3.1-.5 5.3-2.7 5.8-5.8z"/>',
    identities: '<circle cx="6" cy="6" r="2.3"/><path d="M1.9 13c.5-2.2 2.1-3.3 4.1-3.3s3.6 1.1 4.1 3.3"/><path d="M10.4 3.9a2.2 2.2 0 0 1 0 4.2M11.8 9.9c1.3.4 2 1.4 2.3 3.1"/>',
    shield: '<path d="M8 2.1l5 2v3.8c0 3-2.1 5.1-5 6-2.9-.9-5-3-5-6V4.1z"/>',
    key: '<circle cx="5.4" cy="10.6" r="2.7"/><path d="M7.4 8.6l5.4-5.4M10.8 5.2l1.6 1.6M9.4 6.6l1.2 1.2"/>',
    gauge: '<path d="M2.6 11.4a5.4 5.4 0 1 1 10.8 0"/><path d="M8 11.4l2.6-3.2"/>',
    plugins: '<path d="M3 3h3.8v1.6a1.2 1.2 0 0 0 2.4 0V3H13v3.8h-1.6a1.2 1.2 0 0 0 0 2.4H13V13H9.2v-1.6a1.2 1.2 0 0 0-2.4 0V13H3z"/>',
    system: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6L5 5M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/>',
    // composer and ui
    plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    send: '<path d="M8 12.8V3.6M4.2 7.4L8 3.6l3.8 3.8"/>',
    stop: '<rect class="fill" x="5" y="5" width="6" height="6" rx="1.2"/>',
    mic: '<rect x="6" y="2" width="4" height="7.6" rx="2"/><path d="M3.8 7.8a4.2 4.2 0 0 0 8.4 0M8 12v2.2"/>',
    "chev-down": '<path d="M4.6 6.4L8 9.8l3.4-3.4"/>',
    "chev-up": '<path d="M4.6 9.6L8 6.2l3.4 3.4"/>',
    "chev-right": '<path d="M6.4 4.6L9.8 8l-3.4 3.4"/>',
    "chev-left": '<path d="M9.6 4.6L6.2 8l3.4 3.4"/>',
    search: '<circle cx="7.1" cy="7.1" r="4.3"/><path d="M10.3 10.3l3.3 3.3"/>',
    branch: '<circle cx="5" cy="3.9" r="1.5"/><circle cx="5" cy="12.1" r="1.5"/><circle cx="11" cy="5.4" r="1.5"/><path d="M5 5.4v5.2M11 6.9c0 2.6-3.2 2.6-5.4 4.1"/>',
    machine: '<rect x="2.4" y="3" width="11.2" height="7.6" rx="1.6"/><path d="M6 13.6h4M8 10.6v3"/>',
    worktree: '<path d="M2.5 4.6a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v5.8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
    sidebar: '<rect x="2.2" y="3" width="11.6" height="10" rx="2"/><path d="M6.4 3v10"/>',
    close: '<path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/>',
    more: '<circle class="dot" cx="3.6" cy="8" r="1"/><circle class="dot" cx="8" cy="8" r="1"/><circle class="dot" cx="12.4" cy="8" r="1"/>',
    globe: '<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c1.7 1.6 2.4 3.5 2.4 5.6S9.7 12 8 13.6C6.3 12 5.6 10.1 5.6 8S6.3 4 8 2.4z"/>',
    sun: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.9v1.3M8 12.8v1.3M1.9 8h1.3M12.8 8h1.3M3.7 3.7l.9.9M11.4 11.4l.9.9M12.3 3.7l-.9.9M4.6 11.4l-.9.9"/>',
    calendar: '<rect x="2.6" y="3.4" width="10.8" height="10" rx="2"/><path d="M2.6 6.6h10.8M5.6 2v2.6M10.4 2v2.6"/>',
    lock: '<rect x="3.4" y="7.2" width="9.2" height="6.4" rx="1.8"/><path d="M5.4 7.2V5.4a2.6 2.6 0 0 1 5.2 0v1.8"/>',
    external: '<path d="M9.2 2.8h4v4M13.2 2.8L7.4 8.6M11.6 9.6v2.6a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1h2.6"/>',
    file: '<path d="M4 2.6h5l3 3v7.8a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8z"/><path d="M9 2.6v3h3"/>',
    diff: '<path d="M5 2.8v5M2.5 5.3h5M9 11.3h5"/><path d="M11.8 2.6L4.2 13.4"/>',
    test: '<path d="M6.2 2.4h3.6M6.8 2.4v4.2L3.2 12.2a1 1 0 0 0 .9 1.5h7.8a1 1 0 0 0 .9-1.5L9.2 6.6V2.4"/><path d="M4.6 10h6.8"/>',
    return: '<path d="M12.6 3.6v3.8a1.6 1.6 0 0 1-1.6 1.6H3.8M6.4 6.4L3.8 9l2.6 2.6"/>',
    webchat: '<path d="M2.8 4.2a1.6 1.6 0 0 1 1.6-1.6h7.2a1.6 1.6 0 0 1 1.6 1.6v5.2a1.6 1.6 0 0 1-1.6 1.6H7.4l-3 2.4V11A1.6 1.6 0 0 1 2.8 9.4z"/><path d="M5.6 6.8h4.8"/>',
    cron: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.9V8l2 1.3"/>',
    filter: '<path d="M2.6 4h10.8M4.6 8h6.8M6.6 12h2.8"/>',
    eye: '<path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="2"/>',
    voice: '<path d="M3 6.4v3.2M5.4 4.4v7.2M8 2.6v10.8M10.6 4.4v7.2M13 6.4v3.2"/>',
    copy: '<rect x="5.4" y="5.4" width="8" height="8" rx="1.6"/><path d="M10.6 5.4V3.6a1 1 0 0 0-1-1H3.6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.8"/>',
    pin: '<path d="M8 14s4.6-4.1 4.6-7.6a4.6 4.6 0 0 0-9.2 0C3.4 9.9 8 14 8 14z"/><circle cx="8" cy="6.4" r="1.6"/>',
    battery: '<rect x="1.5" y="4.6" width="11.4" height="6.8" rx="2"/><path d="M14.4 7v2"/>',
    haptic: '<path d="M5.6 4.6v6.8M10.4 4.6v6.8M3 6.4v3.2M13 6.4v3.2"/><rect x="7.2" y="3.2" width="1.6" height="9.6" rx=".8" class="fill"/>',
    swipe: '<path d="M2.8 8h10.4M10.2 5l3 3-3 3"/>',
    reply: '<path d="M6.4 4L2.8 7.6l3.6 3.6"/><path d="M2.8 7.6h6.4a4 4 0 0 1 4 4v.8"/>',
    rotate: '<path d="M12.8 7.2A4.9 4.9 0 0 0 4 5.1M3.2 8.8A4.9 4.9 0 0 0 12 10.9"/><path d="M3.6 2.6v2.8h2.8M12.4 13.4v-2.8H9.6"/>',
    memory: '<path d="M4.4 2.8h7.2a1 1 0 0 1 1 1v9.4l-4.6-2.6-4.6 2.6V3.8a1 1 0 0 1 1-1z"/>',
    bolt: '<path d="M9.2 2.2L4 9h3.9l-1.1 4.8L12 7H8z"/>',
    project: '<rect x="2.6" y="4" width="10.8" height="8.6" rx="1.8"/><path d="M2.6 6.6h10.8M5.6 4V2.8h4.8V4"/>',
    command: '<path d="M6 6h4v4H6zM6 6V4.6a1.6 1.6 0 1 0-1.6 1.6H6M10 6V4.6a1.6 1.6 0 1 1 1.6 1.6H10M6 10v1.4a1.6 1.6 0 1 1-1.6-1.6H6M10 10v1.4a1.6 1.6 0 1 0 1.6-1.6H10"/>',
  };

  // Source marks (Simple Icons, CC0), always drawn in currentColor.
  var BRANDS = {
    github:
      "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
    gmail:
      "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
    sentry:
      "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
    slack:
      "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
    discord:
      "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
    intercom:
      "M21 0H3C1.343 0 0 1.343 0 3v18c0 1.658 1.343 3 3 3h18c1.658 0 3-1.342 3-3V3c0-1.657-1.342-3-3-3zm-5.801 4.399c0-.44.36-.8.802-.8.44 0 .8.36.8.8v10.688c0 .442-.36.801-.8.801-.443 0-.802-.359-.802-.801V4.399zM11.2 3.994c0-.44.357-.799.8-.799s.8.359.8.799v11.602c0 .44-.357.8-.8.8s-.8-.36-.8-.8V3.994zm-4 .405c0-.44.359-.8.799-.8.443 0 .802.36.802.8v10.688c0 .442-.36.801-.802.801-.44 0-.799-.359-.799-.801V4.399zM3.199 6c0-.442.36-.8.802-.8.44 0 .799.358.799.8v7.195c0 .441-.359.8-.799.8-.443 0-.802-.36-.802-.8V6zM20.52 18.202c-.123.105-3.086 2.593-8.52 2.593-5.433 0-8.397-2.486-8.521-2.593-.335-.288-.375-.792-.086-1.128.285-.334.79-.375 1.125-.09.047.041 2.693 2.211 7.481 2.211 4.848 0 7.456-2.186 7.479-2.207.334-.289.839-.25 1.128.086.289.336.25.84-.086 1.128zm.281-5.007c0 .441-.36.8-.801.8-.441 0-.801-.36-.801-.8V6c0-.442.361-.8.801-.8.441 0 .801.357.801.8v7.195z",
    posthog:
      "M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z",
    stripe:
      "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
    anthropic:
      "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
    openai:
      "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  };
  // Grafana's full mark is large; a simplified ring keeps it recognisable at 12-14px.
  BRANDS.grafana =
    "M12 2.2c1 0 1.9.6 2.4 1.4 1.2.2 2.3.7 3.2 1.4 1-.2 2 .1 2.6.8-.1 1-.6 1.8-1.3 2.3.5 1 .8 2.1.8 3.3l1.9 1.3c-.2 1.1-1 2-2.1 2.3a8.2 8.2 0 0 1-1.9 2.9c.1 1.1-.4 2.1-1.2 2.7-1-.2-1.8-.8-2.2-1.6a8.3 8.3 0 0 1-3.3.2c-.7.8-1.8 1.2-2.8 1-.5-.9-.6-2-.2-2.9A8 8 0 0 1 5 14.3c-1.1-.1-2-.8-2.4-1.7.4-1 1.3-1.6 2.3-1.8.1-1.3.5-2.4 1.1-3.4-.4-1-.3-2.1.3-3 1 0 2 .4 2.6 1.1.7-.4 1.5-.7 2.3-.9.3-1 .9-1.8 1.8-2.4zm0 5.5a4.3 4.3 0 1 0 4.2 5.1h-2.3a2.1 2.1 0 1 1-.4-2.7l1.6-1.6A4.3 4.3 0 0 0 12 7.7z";

  function markSvg(name, extraClass) {
    var inner = MARKS[name];
    if (inner == null) {
      console.warn("Unknown mark: " + name);
      inner = "";
    }
    return (
      '<svg class="m m-' + name + (extraClass ? " " + extraClass : "") +
      '" viewBox="0 0 16 16" aria-hidden="true">' + inner + "</svg>"
    );
  }
  function brandSvg(name) {
    if (name === "pi") return '<span class="b b-pi" aria-hidden="true">π</span>';
    if (name === "cron") return markSvg("cron", "b");
    if (name === "webchat") return markSvg("webchat", "b");
    var d = BRANDS[name];
    if (!d) {
      console.warn("Unknown brand: " + name);
      return "";
    }
    return '<svg class="b b-' + name + '" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  }
  // The logomark: an H made of two tide-gauge posts, its crossbar a wave, and a coral Now dot
  // riding the crest. The dot is the only color that never changes.
  var LOGO =
    '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true">' +
    '<rect class="logo-post" x="6.5" y="4.5" width="4.4" height="23" rx="2.2"/>' +
    '<rect class="logo-post" x="21.1" y="4.5" width="4.4" height="23" rx="2.2"/>' +
    '<path class="logo-wave" d="M3.6 17.6c2.6-3.5 5.1-3.5 7.6 0s5.1 3.5 7.6 0 5.1-3.5 7.6 0 2.5 1.7 2.5 1.7"/>' +
    '<circle class="logo-now" cx="15" cy="10.6" r="2.6"/>' +
    "</svg>";

  function expandMarks(scope) {
    scope.querySelectorAll("i[data-m]").forEach(function (el) {
      var cls = el.className ? " " + el.className : "";
      el.outerHTML = markSvg(el.dataset.m, cls.trim());
    });
    scope.querySelectorAll("i[data-b]").forEach(function (el) {
      el.outerHTML = brandSvg(el.dataset.b);
    });
    scope.querySelectorAll("i[data-logo]").forEach(function (el) {
      el.outerHTML = LOGO;
    });
  }

  // ------------------------------------------------------------------ time and events
  // Minutes relative to midnight of Tuesday 29 September 2026. Now is 09:41.
  var NOW = 9 * 60 + 41;
  var LAST_CHECKED = -(5 * 60 + 40); // yesterday 18:20
  function clockLabel(min) {
    var m = ((min % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }
  function seededRandom(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Draws `count` event times from weighted spans [from, to, weight].
  function sampleEvents(count, spans, seed) {
    var rand = seededRandom(seed);
    var total = spans.reduce(function (s, p) { return s + (p[1] - p[0]) * p[2]; }, 0);
    var out = [];
    for (var i = 0; i < count; i++) {
      var r = rand() * total;
      for (var j = 0; j < spans.length; j++) {
        var w = (spans[j][1] - spans[j][0]) * spans[j][2];
        if (r <= w || j === spans.length - 1) {
          out.push(spans[j][0] + (r / w) * (spans[j][1] - spans[j][0]));
          break;
        }
        r -= w;
      }
    }
    return out.sort(function (a, b) { return a - b; });
  }
  // The 212 events since Rogier last checked, per Connection (counts from the fixture).
  var SINCE = LAST_CHECKED;
  var EVENTS = {
    sentry: sampleEvents(131, [[SINCE, -60, 4], [-60, 420, 0.7], [420, NOW, 5.5]], 11),
    github: sampleEvents(4, [[SINCE, NOW, 1]], 12).concat(sampleEvents(34, [[482, 494, 1]], 13)).sort(function (a, b) { return a - b; }),
    gmail: sampleEvents(17, [[SINCE, -120, 1], [380, NOW, 2.2]], 14),
    stripe: sampleEvents(12, [[SINCE, NOW, 1]], 15),
    intercom: sampleEvents(9, [[SINCE, -60, 1], [420, NOW, 1.6]], 16),
    posthog: [ -300, 380, 545 ],
    grafana: [ 356, 363 ],
  };
  var ALL_EVENTS = Object.keys(EVENTS).reduce(function (a, k) { return a.concat(EVENTS[k]); }, []);

  // A smooth path through points with Catmull-Rom splines converted to cubic Beziers.
  function smoothPath(points) {
    if (points.length < 2) return "";
    var d = "M" + points[0][0].toFixed(1) + " " + points[0][1].toFixed(1);
    for (var i = 0; i < points.length - 1; i++) {
      var p0 = points[i - 1] || points[i];
      var p1 = points[i];
      var p2 = points[i + 1];
      var p3 = points[i + 2] || p2;
      var c1x = p1[0] + (p2[0] - p0[0]) / 6;
      var c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6;
      var c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += "C" + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) + " " + p2[0].toFixed(1) + " " + p2[1].toFixed(1);
    }
    return d;
  }
  // Counts events into buckets and returns a smoothed, square-root-scaled series of [x, y] points.
  // The square root keeps a burst (34 bot issues in ten minutes) from flattening the rest of the tide.
  // peak (0-1) scales the highest point, so charts drawn side by side can share one scale.
  function tidePoints(events, from, to, width, height, bucket, floor, peak) {
    var n = Math.ceil((to - from) / bucket);
    var counts = new Array(n).fill(0);
    events.forEach(function (t) {
      if (t >= from && t < to) counts[Math.floor((t - from) / bucket)]++;
    });
    var smooth = counts.map(function (c, i) {
      var a = counts[i - 1] == null ? c : counts[i - 1];
      var b = counts[i + 1] == null ? c : counts[i + 1];
      return (a + 2 * c + b) / 4;
    });
    var max = Math.max.apply(null, smooth.map(Math.sqrt)) || 1;
    var pts = smooth.map(function (c, i) {
      var x = ((i + 0.5) * bucket / (to - from)) * width;
      return [x, height - (floor || 0) - (Math.sqrt(c) / max) * (height - (floor || 0) - 2) * (peak || 1)];
    });
    pts.unshift([0, pts[0][1]]);
    pts.push([width, pts[pts.length - 1][1]]);
    return pts;
  }

  // Renders a tide chart into el. Options come from data attributes:
  //   data-tide="since|day|lane:<source>|spark:<seed>"   which events to draw
  //   data-from / data-to (minutes)                      the window; defaults to since-last-checked..now
  //   data-now="off"                                     hide the Now line
  //   data-night="on"                                    shade 23:00-07:00
  //   data-ticks="on"                                    mark the triage passes (odd hours)
  //   data-future="<to>"                                 continue the axis past Now to <to>, hollow
  //   data-peak="0.4"                                    scale the highest point, to compare charts
  function renderTide(el) {
    var kind = el.dataset.tide;
    var from = el.dataset.from != null ? Number(el.dataset.from) : SINCE;
    var to = el.dataset.to != null ? Number(el.dataset.to) : NOW;
    var w = el.clientWidth || Number(el.dataset.w) || 300;
    var h = el.clientHeight || Number(el.dataset.h) || 60;
    var bucket = Number(el.dataset.bucket || 20);
    var x = function (t) { return ((t - from) / (to - from)) * w; };
    var events;
    if (kind === "since" || kind === "day") events = ALL_EVENTS;
    else if (kind.indexOf("lane:") === 0) events = EVENTS[kind.slice(5)] || [];
    else if (kind.indexOf("spark:") === 0) {
      var parts = kind.slice(6).split(",");
      var seed = Number(parts[0]);
      var total = Number(parts[1] || 60);
      // A day's rhythm: steady by day, low at night (23:00-07:00), busiest in the morning.
      events = sampleEvents(total, [[from, -60, 1], [-60, 420, 0.22], [420, to, 1.5]], seed);
      if (el.dataset.gapFrom) {
        var gf = Number(el.dataset.gapFrom);
        events = events.filter(function (t) { return t < gf; });
      }
    } else events = ALL_EVENTS;

    var nowX = x(NOW);
    var pastW = Math.min(w, nowX);
    var svg = '<svg viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" preserveAspectRatio="none" aria-hidden="true">';
    if (el.dataset.night === "on") {
      [[-60, 420], [1380, 1860]].forEach(function (n) {
        var a = Math.max(0, x(n[0]));
        var b = Math.min(w, x(n[1]));
        if (b > a) svg += '<rect class="t-night" x="' + a.toFixed(1) + '" y="0" width="' + (b - a).toFixed(1) + '" height="' + h + '"/>';
      });
    }
    if (el.dataset.ticks === "on") {
      for (var t = Math.ceil(from / 60) * 60; t <= to; t += 60) {
        var hour = ((t / 60) % 24 + 24) % 24;
        if (hour % 2 === 1 && (hour >= 7 || hour <= 23) && !(hour > 23 || hour < 7)) {
          var tx = x(t);
          svg += '<path class="t-triage" d="M' + tx.toFixed(1) + " " + (h - 1) + "v-5" + '"/>';
        }
      }
    }
    var pts = tidePoints(events, from, Math.min(to, NOW), pastW, h, bucket, Number(el.dataset.floor || 3), Number(el.dataset.peak || 1));
    var line = smoothPath(pts);
    svg += '<path class="t-fill" d="' + line + "L" + pastW.toFixed(1) + " " + h + "L0 " + h + 'Z"/>';
    svg += '<path class="t-line" d="' + line + '"/>';
    if (el.dataset.gapFrom) {
      var gx = x(Number(el.dataset.gapFrom));
      svg += '<rect class="t-gap" x="' + gx.toFixed(1) + '" y="0" width="' + (nowX - gx).toFixed(1) + '" height="' + h + '"/>';
      svg += '<path class="t-gap-line" d="M' + gx.toFixed(1) + " " + (h - 1.5) + "H" + nowX.toFixed(1) + '"/>';
    }
    if (to > NOW) {
      svg += '<path class="t-future" d="M' + nowX.toFixed(1) + " " + (h - 1.5) + "H" + w + '"/>';
    }
    if (el.dataset.now !== "off" && nowX <= w + 0.5) {
      svg += '<path class="t-now" d="M' + (nowX - 0.75).toFixed(1) + " 0V" + h + '"/>';
    }
    svg += "</svg>";
    el.innerHTML = svg + el.innerHTML;
  }

  // Draws the event ticks of one Connection on the shared axis (the "what came in" lanes).
  function renderTicks(el) {
    var src = el.dataset.ticksOf;
    var from = el.dataset.from != null ? Number(el.dataset.from) : SINCE;
    var to = el.dataset.to != null ? Number(el.dataset.to) : NOW;
    var w = el.clientWidth;
    var h = el.clientHeight;
    var list = EVENTS[src] || [];
    var s = '<svg viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">';
    s += '<path class="k-base" d="M0 ' + (h / 2) + "H" + w + '"/>';
    list.forEach(function (t) {
      var x = ((t - from) / (to - from)) * w;
      s += '<path class="k-tick" d="M' + x.toFixed(1) + " " + (h / 2 - 5) + "v10" + '"/>';
    });
    s += "</svg>";
    el.innerHTML = s;
  }

  // Draws one small square per event, grouped by what triage made of it, so the few that surfaced
  // stand out against the many handled quietly. data-receipt="lead:1,proposal:5,...,none:198".
  function renderReceipt(el) {
    var h = "";
    el.dataset.receipt.split(",").forEach(function (part) {
      var kv = part.split(":");
      for (var i = 0; i < Number(kv[1]); i++) h += '<i class="rc rc-' + kv[0] + '"></i>';
    });
    el.innerHTML = h;
  }

  // Draws Ada's heartbeat strip: one mark per hour from 07 to 23. Quiet past beats are hollow grey,
  // the beat that spoke is filled sea, the Now line sits at 09:41, and future beats are hollow
  // sea-glass. data-w sets the width; data-labels="off" hides the hour labels.
  function renderBeats(el) {
    var w = Number(el.dataset.w || 280);
    var x0 = 6;
    var x1 = w - 6;
    var x = function (h) { return x0 + ((h - 7) / 16) * (x1 - x0); };
    var s = '<svg viewBox="0 0 ' + w + ' 44" width="' + w + '" height="44" role="img" aria-label="Heartbeats today: 07:00 and 08:00 quiet, 09:00 spoke, next at 10:00">';
    s += '<path class="bt-axis" d="M' + x0 + " 14H" + x1 + '"/>';
    for (var h = 7; h <= 23; h++) {
      var cls = h < 9 ? "bt-quiet" : h === 9 ? "bt-spoke" : "bt-future";
      s += '<circle class="' + cls + '" cx="' + x(h).toFixed(1) + '" cy="14" r="' + (h === 9 ? 4.5 : h < 9 ? 3.5 : 3) + '"/>';
      if (h === 7 || h === 13 || h === 18 || h === 23) {
        s += '<text class="bt-label" x="' + x(h).toFixed(1) + '" y="38" text-anchor="middle">' + (h < 10 ? "0" : "") + h + "</text>";
      }
    }
    var nx = x(NOW / 60);
    s += '<path class="bt-now" d="M' + nx.toFixed(1) + ' 3V25"/>';
    s += '<text class="bt-label now" x="' + nx.toFixed(1) + '" y="38" text-anchor="middle">' + clockLabel(NOW) + "</text>";
    el.innerHTML = s + "</svg>";
  }

  // ------------------------------------------------------------------ shell: the desktop sidebar
  var THREADS = [
    {
      project: "webshop", lane: "webshop", count: 2, group: "worktree · 3ds-eu-cards",
      rows: [
        { id: "fix-3ds", mark: "decision", cls: "now", title: "Fix 3-D Secure checkout for EU cards", age: "39m", meta: "fix/3ds-eu-cards · Opus 5.5" },
        { id: "cart", mark: "working", cls: "live", title: "Refactor cart totals", age: "22m", meta: "refactor/cart-totals · Sonnet 5" },
      ],
    },
    {
      project: "payments-api", lane: "payments", count: 1, group: "worktree · ideal-research",
      rows: [{ id: "ideal", mark: "idle", cls: "quiet", title: "Add iDEAL research", age: "1h", meta: "research/ideal · gpt-5.4" }],
    },
    {
      project: "ops", lane: "ops", count: 1, group: "ops · studio-mac",
      rows: [{ id: "grafana", mark: "decision", cls: "now", title: "Migrate ops dashboards", age: "14m", meta: "main · qwen3-coder 30b" }],
    },
  ];
  var ASSISTANTS = [
    { id: "ada", name: "Ada", mark: "working", cls: "live", where: "Web chat · Slack DM", presence: "working" },
    { id: "milo", name: "Milo", mark: "idle", cls: "quiet", where: "Slack #ops", presence: "idle" },
    { id: "juno", name: "Juno", mark: "asleep", cls: "quiet", where: "Discord · reconnecting", presence: "asleep" },
  ];
  var NAV = [
    { id: "intake", label: "Intake", mark: "intake", count: "6", href: "intake.html" },
    { id: "checkin", label: "Check-in", mark: "checkin", count: "3", countCls: "now", href: "office.html" },
    { id: "tasks", label: "Tasks", mark: "task" },
    { id: "runs", label: "Runs", mark: "run" },
    { id: "workflows", label: "Workflows", mark: "workflow" },
    { sep: true },
    { id: "fleet", label: "Fleet", mark: "fleet" },
    { id: "connections", label: "Connections", mark: "connections", href: "settings-connections.html" },
    { id: "notifications", label: "Notifications", mark: "bell", count: "4" },
    { id: "settings", label: "Settings", mark: "settings", href: "settings-appearance.html" },
  ];
  var SETTINGS_NAV = [
    ["profile", "Profile", "profile"],
    ["appearance", "Appearance", "appearance", "settings-appearance.html"],
    ["threads", "Threads", "session"],
    ["assistants", "Assistants", "heartbeat", "settings-assistants.html"],
    ["connections", "Connections", "connections", "settings-connections.html"],
    ["providers", "Providers", "providers"],
    ["machines", "Machines", "fleet"],
    ["identities", "Identities", "identities"],
    ["profiles", "Permission profiles", "shield"],
    ["secrets", "Secrets", "key"],
    ["bounds", "Bounds", "gauge"],
    ["plugins", "Plugins", "plugins"],
    ["system", "System", "system"],
  ];

  function lights() {
    return '<span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>';
  }
  function avatar(name, extra) {
    return '<span class="av av-' + name.toLowerCase() + (extra ? " " + extra : "") + '">' + name[0] + "</span>";
  }
  function faceSwitch(face) {
    return (
      '<div class="seg face" role="tablist">' +
      '<button role="tab" aria-selected="' + (face === "threads") + '">Threads</button>' +
      '<button role="tab" aria-selected="' + (face === "hercule") + '">Hercule<b class="seg-count now">3</b></button>' +
      "</div>"
    );
  }
  function sidebarFoot() {
    return (
      '<div class="side-foot">' +
      '<button class="pulse"><i data-m="working" class="live"></i><span>23 sessions · 3 runners</span><b class="pulse-cap">1 at cap</b></button>' +
      '<div class="side-foot-row"><button class="ghost-row"><i data-m="fyi"></i>Marks</button><button class="ghost-row"><i data-m="appearance"></i>Theme<span class="faint theme-name">Sand</span></button></div>' +
      "</div>"
    );
  }
  function buildSidebar(el) {
    var face = el.dataset.side;
    var active = el.dataset.active || "";
    var h = '<div class="side-top">' + lights() + '<span class="side-top-tools"><button class="icon-btn" aria-label="Hide sidebar"><i data-m="sidebar"></i></button></span></div>';
    if (face === "settings") {
      h += '<a class="side-back" href="intake.html"><i data-m="chev-left"></i>Back to Hercule</a>';
      h += '<div class="side-label">Settings</div><nav class="nav">';
      SETTINGS_NAV.forEach(function (s) {
        h += '<a class="nav-item' + (s[0] === active ? " is-active" : "") + '"' + (s[3] ? ' href="' + s[3] + '"' : "") + '><i data-m="' + s[2] + '"></i><span>' + s[1] + "</span></a>";
      });
      h += "</nav>";
      h += '<div class="side-spacer"></div><div class="side-foot"><div class="side-note"><i data-logo></i><span>Hercule 1.4 · studio-mac</span></div></div>';
      el.innerHTML = h;
      return;
    }
    h += faceSwitch(face);
    if (face === "hercule") {
      h += '<nav class="nav">';
      NAV.forEach(function (n) {
        if (n.sep) { h += '<hr class="nav-sep">'; return; }
        h += '<a class="nav-item' + (n.id === active ? " is-active" : "") + '"' + (n.href ? ' href="' + n.href + '"' : "") + '><i data-m="' + n.mark + '"></i><span>' + n.label + "</span>" + (n.count ? '<b class="count ' + (n.countCls || "") + '">' + n.count + "</b>" : "") + "</a>";
      });
      h += "</nav>";
    } else {
      h += '<div class="side-new"><a class="new-thread" href="session-empty.html"><i data-m="plus"></i><span>Create new thread</span><kbd>⌘N</kbd></a><button class="icon-btn" aria-label="New project"><i data-m="project"></i></button></div>';
      h += '<div class="threads">';
      THREADS.forEach(function (g) {
        h += '<div class="t-group"><div class="t-head"><span class="lane-dot lane-' + g.lane + '"></span><span>' + g.project + '</span><span class="faint">' + g.count + '</span><button class="icon-btn sm" aria-label="New thread in ' + g.project + '"><i data-m="plus"></i></button></div>';
        h += '<div class="t-ws">' + g.group + "</div>";
        var rows = g.rows;
        // A Draft Thread shows in its project until its first message is sent.
        if (active === "draft" && g.project === "webshop") {
          rows = [{ id: "draft", mark: "queued", cls: "future", title: "New thread", age: "now", meta: "draft · from main" }].concat(rows);
        }
        rows.forEach(function (r) {
          h += '<a class="t-row' + (r.id === active ? " is-active" : "") + '"' + (r.id === "fix-3ds" ? ' href="session-active.html"' : "") + '><i data-m="' + r.mark + '" class="' + r.cls + '"></i><span class="t-title">' + r.title + '</span><span class="t-age">' + r.age + '</span><span class="t-meta">' + r.meta + "</span></a>";
        });
        h += "</div>";
      });
      h += "</div>";
    }
    h += '<div class="side-label">Assistants</div><div class="assistants">';
    ASSISTANTS.forEach(function (a) {
      h += '<a class="a-row' + (a.id === active ? " is-active" : "") + '"' + (a.id === "ada" ? ' href="assistant.html"' : "") + ">" + avatar(a.name, a.presence) + '<span class="a-name">' + a.name + '</span><i data-m="' + a.mark + '" class="' + a.cls + '"></i><span class="a-where">' + a.where + "</span></a>";
    });
    h += "</div>";
    if (face === "threads") h += '<a class="side-all" href="office.html">All sessions<i data-m="chev-right"></i></a>';
    h += '<div class="side-spacer"></div>' + sidebarFoot();
    el.innerHTML = h;
  }

  // ------------------------------------------------------------------ the titlebar tideline
  // A glass capsule: the last few hours of the tide on the left, the Now line with its time tab,
  // and what is scheduled next as hollow sea-glass marks on the right.
  var UPCOMING = [
    { t: 600, label: "Ada's heartbeat", mark: "heartbeat" },
    { t: 660, label: "triage", mark: "triage" },
  ];
  function buildTideline(el) {
    var mode = el.dataset.tideline;
    var from = Number(el.dataset.from || 6 * 60);
    var to = Number(el.dataset.to || 12 * 60);
    var w = Number(el.dataset.w || 300);
    var html = "";
    if (mode === "session") {
      // The session's own hour: turns as sea segments, waiting on Rogier in coral, the queued
      // input as a hollow mark just past Now.
      from = 9 * 60; to = 10 * 60;
      var xs = function (t) { return ((t - from) / (to - from)) * w; };
      var segs = [[2, 4.3, "turn"], [5, 9.9, "turn"], [10.2, 13, "turn"], [13, 41, "wait"]];
      var s = '<svg class="tl-svg" viewBox="0 0 ' + w + ' 30" width="' + w + '" height="30" aria-hidden="true">';
      s += '<path class="tl-axis" d="M0 21H' + w + '"/>';
      segs.forEach(function (g) {
        var a = xs(from + g[0]);
        var b = xs(from + g[1]);
        var wait = g[2] === "wait";
        s += '<rect class="tl-' + g[2] + '" x="' + a.toFixed(1) + '" y="' + (wait ? 19.5 : 17) + '" width="' + (b - a).toFixed(1) + '" height="' + (wait ? 3 : 8) + '" rx="' + (wait ? 1.5 : 2) + '"/>';
      });
      var nx = xs(NOW);
      s += '<circle class="tl-queued" cx="' + (nx + 14).toFixed(1) + '" cy="21" r="3.6"/>';
      s += '<path class="tl-now" d="M' + nx.toFixed(1) + ' 1V29"/>';
      s += "</svg>";
      html = s + '<span class="tl-tab mono" style="left:' + xs(from + 2).toFixed(1) + 'px;color:var(--faint)">09:02</span>';
      html += '<span class="tl-tab mono" style="right:' + (w - nx + 5).toFixed(1) + 'px">09:41</span>';
      el.innerHTML = '<span class="tl-track" style="width:' + w + 'px">' + html + '</span><span class="tl-next">waiting on you <b class="mono">28m</b></span>';
      el.classList.add("tideline", "tideline--session");
      return;
    }
    var x = function (t) { return ((t - from) / (to - from)) * w; };
    var svg = '<svg class="tl-svg" viewBox="0 0 ' + w + ' 30" width="' + w + '" height="30" aria-hidden="true">';
    var pts = tidePoints(ALL_EVENTS, from, NOW, x(NOW), 30, 15, 6);
    var line = smoothPath(pts);
    svg += '<path class="tl-fill" d="' + line + "L" + x(NOW).toFixed(1) + " 30L0 30Z" + '"/>';
    svg += '<path class="tl-line" d="' + line + '"/>';
    for (var t = from + 60; t < to; t += 60) {
      if (t < NOW) svg += '<path class="tl-hour" d="M' + x(t).toFixed(1) + ' 24v6"/>';
    }
    svg += '<path class="tl-futureaxis" d="M' + x(NOW).toFixed(1) + ' 24.5H' + w + '"/>';
    UPCOMING.forEach(function (u) {
      svg += '<circle class="tl-soon" cx="' + x(u.t).toFixed(1) + '" cy="15" r="4"><title>' + u.label + " " + clockLabel(u.t) + "</title></circle>";
    });
    svg += '<path class="tl-now" d="M' + x(NOW).toFixed(1) + ' 0V30"/>';
    svg += "</svg>";
    html = svg;
    html += '<span class="tl-tab mono" style="right:' + (w - x(NOW) + 5).toFixed(1) + 'px">09:41</span>';
    el.innerHTML = '<span class="tl-track" style="width:' + w + 'px">' + html + '</span><span class="tl-next"><i data-m="triage"></i>next triage <b class="mono">11:00</b></span>';
    el.classList.add("tideline");
  }

  // ------------------------------------------------------------------ mobile chrome
  function buildStatusBar(el) {
    var dark = el.dataset.status === "light-on-dark";
    el.classList.add("statusbar");
    if (dark) el.classList.add("statusbar--inverse");
    el.innerHTML =
      '<span class="sb-time">9:41</span><span class="sb-island" aria-hidden="true"></span>' +
      '<span class="sb-icons" aria-hidden="true">' +
      '<svg viewBox="0 0 18 12" width="18" height="12"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>' +
      '<svg viewBox="0 0 16 12" width="16" height="12"><path d="M8 2.2c2.4 0 4.6.9 6.2 2.5l1.2-1.2A10.4 10.4 0 0 0 8 .5 10.4 10.4 0 0 0 .6 3.5l1.2 1.2A8.7 8.7 0 0 1 8 2.2zm0 3.5c1.4 0 2.8.6 3.8 1.5L13 6a7 7 0 0 0-10 0l1.2 1.2c1-1 2.4-1.5 3.8-1.5zm0 3.4c.6 0 1.1.2 1.5.6L8 11.2 6.5 9.7c.4-.4.9-.6 1.5-.6z"/></svg>' +
      '<svg viewBox="0 0 27 13" width="27" height="13"><rect class="sb-bat" x=".5" y=".5" width="23" height="12" rx="3.6"/><rect x="2.2" y="2.2" width="17.4" height="8.6" rx="2.2"/><path d="M25.2 4.4v4.2c.8-.3 1.3-1.1 1.3-2.1s-.5-1.8-1.3-2.1z"/></svg>' +
      "</span>";
  }
  var TABS = [
    ["now", "Now", "now", "intake.html"],
    ["threads", "Threads", "session", "session-active.html"],
    ["ada", "Ada", null, "assistant.html"],
    ["settings", "Settings", "settings", "settings.html"],
  ];
  function buildTabs(el) {
    var active = el.dataset.tabs;
    var h = "";
    TABS.forEach(function (t) {
      var icon = t[2] ? '<i data-m="' + t[2] + '"></i>' : avatar("Ada", "working tab-av");
      var badge = t[0] === "now" ? '<b class="tab-badge">3</b>' : "";
      h += '<a class="tab' + (t[0] === active ? " is-active" : "") + '" href="' + t[3] + '">' + icon + badge + "<span>" + t[1] + "</span></a>";
    });
    el.classList.add("tabbar");
    el.innerHTML = h;
  }

  // ------------------------------------------------------------------ the web rail
  var RAIL = [
    ["intake", "Intake", "intake", "intake.html", "6"],
    ["checkin", "Check-in", "checkin", null, "3"],
    ["threads", "Threads", "session", "session-active.html"],
    ["assistants", "Ada", "heartbeat", "assistant.html"],
    ["tasks", "Tasks", "task"],
    ["runs", "Runs", "run"],
    ["workflows", "Workflows", "workflow"],
  ];
  function buildRail(el) {
    var active = el.dataset.rail;
    var h = '<a class="rail-logo" href="intake.html" aria-label="Hercule"><i data-logo></i></a><nav class="rail-nav">';
    RAIL.forEach(function (r) {
      h += '<a class="rail-item' + (r[0] === active ? " is-active" : "") + '"' + (r[3] ? ' href="' + r[3] + '"' : "") + ' title="' + r[1] + '"><i data-m="' + r[2] + '"></i><span>' + r[1] + "</span>" + (r[4] ? '<b class="rail-count' + (r[0] === "checkin" ? " now" : "") + '">' + r[4] + "</b>" : "") + "</a>";
    });
    h += '</nav><div class="side-spacer"></div><nav class="rail-nav">';
    h += '<a class="rail-item" title="Notifications"><i data-m="bell"></i><span>Alerts</span></a>';
    h += '<a class="rail-item' + (active === "settings" ? " is-active" : "") + '" href="settings-providers.html" title="Settings"><i data-m="settings"></i><span>Settings</span></a>';
    h += '<span class="rail-me">R</span></nav>';
    el.classList.add("rail");
    el.innerHTML = h;
  }

  // ------------------------------------------------------------------ composer glass
  // While the transcript scrolls, the composer shrinks and turns see-through; it restores when the
  // reader stops at the bottom or focuses it. ?state=scrolled holds the shrunken state.
  function wireComposerGlass() {
    var scroller = document.querySelector("[data-transcript]");
    var composer = document.querySelector("[data-composer]");
    if (!scroller || !composer) return;
    var forced = root.dataset.state === "scrolled";
    // Setting scrollTop from code also fires a scroll event; that one must not shrink the composer.
    var fromCode = false;
    var settle;
    function atBottom() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 12;
    }
    function placeScroll() {
      fromCode = true;
      requestAnimationFrame(function () { requestAnimationFrame(function () { fromCode = false; }); });
      if (forced) {
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - Number(scroller.dataset.scrolledBy || 280));
        composer.classList.add("is-shrunk");
      } else {
        scroller.scrollTop = scroller.scrollHeight;
        composer.classList.remove("is-shrunk");
      }
    }
    placeScroll();
    // Web fonts change line heights after the first layout, so place the scroll again once they are in.
    if (document.fonts) document.fonts.ready.then(placeScroll);
    if (forced) return;
    scroller.addEventListener("scroll", function () {
      if (fromCode || composer.contains(document.activeElement)) return;
      composer.classList.toggle("is-shrunk", !atBottom());
      clearTimeout(settle);
      settle = setTimeout(function () {
        if (atBottom()) composer.classList.remove("is-shrunk");
      }, 160);
    }, { passive: true });
    composer.addEventListener("focusin", function () {
      composer.classList.remove("is-shrunk");
    });
  }

  // ------------------------------------------------------------------ small live interactions
  function wireSegments() {
    document.addEventListener("click", function (e) {
      var b = e.target.closest(".seg button, .seg [role=tab]");
      if (b && !b.closest("[data-static]")) {
        b.parentElement.querySelectorAll("button, [role=tab]").forEach(function (o) {
          o.setAttribute("aria-selected", String(o === b));
        });
      }
      var t = e.target.closest("[data-set-theme]");
      if (t) {
        root.dataset.theme = t.dataset.setTheme;
        document.querySelectorAll("[data-set-theme]").forEach(function (o) {
          o.setAttribute("aria-pressed", String(o === t));
        });
      }
      var sw = e.target.closest(".switch");
      if (sw) sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true"));
    });
  }

  function init() {
    document.querySelectorAll("[data-side]").forEach(buildSidebar);
    document.querySelectorAll("[data-rail]").forEach(buildRail);
    document.querySelectorAll("[data-status]").forEach(buildStatusBar);
    document.querySelectorAll("[data-tabs]").forEach(buildTabs);
    document.querySelectorAll("[data-tideline]").forEach(buildTideline);
    expandMarks(document);
    document.querySelectorAll("[data-tide]").forEach(renderTide);
    document.querySelectorAll("[data-ticks-of]").forEach(renderTicks);
    document.querySelectorAll("[data-receipt]").forEach(renderReceipt);
    document.querySelectorAll("[data-beats]").forEach(renderBeats);
    var themeName = { light: "Sand", sand: "Sand", shell: "Shell", dark: "Kelp", kelp: "Kelp", driftwood: "Driftwood", "low-tide": "Low Tide" };
    document.querySelectorAll(".theme-name").forEach(function (n) {
      n.textContent = themeName[root.dataset.theme] || "Sand";
    });
    // A theme picker shows the page's own theme as chosen, so ?theme=dark marks Kelp.
    var canonical = { light: "sand", dark: "kelp" }[root.dataset.theme] || root.dataset.theme || "sand";
    document.querySelectorAll("[data-set-theme]").forEach(function (o) {
      o.setAttribute("aria-pressed", String(o.dataset.setTheme === canonical));
    });
    wireComposerGlass();
    wireSegments();
    root.classList.add("is-ready");
  }

  window.Tide = { markSvg: markSvg, brandSvg: brandSvg, LOGO: LOGO, EVENTS: EVENTS, NOW: NOW, clockLabel: clockLabel, expandMarks: expandMarks, renderTide: renderTide };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
