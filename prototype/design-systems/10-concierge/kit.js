// Concierge kit: the shared marks sprite, a few expanders, the desktop sidebar, the web top bar,
// the phone chrome, and the glass composer. Loaded with `defer` on every page.
(function () {
  "use strict";
  var M = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
  var marks = {
    // state marks, 12px grid
    q: '<path d="M3.9 4.2a2.1 2.1 0 1 1 3 1.9c-.6.35-.9.75-.9 1.4v.3" stroke-width="1.4"/><path d="M6 10.1h.01" stroke-width="1.7"/>',
    queued: '<circle cx="6" cy="6" r="3.5"/>',
    paused: '<path d="M4.2 2.8v6.4M7.8 2.8v6.4" stroke-width="1.4"/>',
    done: '<path d="m2.4 6.4 2.5 2.5 4.8-5.4" stroke-width="1.35"/>',
    failed: '<path d="m3.2 3.2 5.6 5.6M8.8 3.2 3.2 8.8" stroke-width="1.35"/>',
    cancelled: '<path d="M2.9 6h6.2" stroke-width="1.35"/>',
    skipped: '<path d="m2.8 3.3 2.7 2.7-2.7 2.7M6.6 3.3 9.3 6 6.6 8.7"/>',
    // entity glyphs
    task: '<rect x="2.2" y="2.2" width="7.6" height="7.6" rx="2.2"/>',
    run: '<path d="M3.6 2.4 9.7 6l-6.1 3.6z"/>',
    session: '<path d="M3.4 2.3h5.2a1.6 1.6 0 0 1 1.6 1.6v3a1.6 1.6 0 0 1-1.6 1.6H5.6L3.2 10.2V8.5a1.6 1.6 0 0 1-1.4-1.6v-3a1.6 1.6 0 0 1 1.6-1.6z"/>',
    workflow: '<circle cx="3" cy="3" r="1.3"/><circle cx="3" cy="9" r="1.3"/><circle cx="9.2" cy="6" r="1.3"/><path d="M4.3 3.4c2 .4 2.6 1.6 3.6 2.4M4.3 8.6c2-.4 2.6-1.6 3.6-2.4"/>',
    // intake kinds
    offer: '<path d="M1.4 9.3h9.2M2.3 9.3a3.7 3.7 0 0 1 7.4 0M6 5.6V3.9M4.8 3.2h2.4" stroke-width="1.3"/>',
    fyi: '<path d="M6 5.4v3.4" stroke-width="1.35"/><path d="M6 3.3h.01" stroke-width="1.7"/>',
    attached: '<path d="M6.8 3.9 4.3 6.4a1.3 1.3 0 0 0 1.8 1.8l3-3a2.2 2.2 0 0 0-3.1-3.1L3 5.1a3.1 3.1 0 0 0 4.4 4.4l1.8-1.8"/>',
    held: '<rect x="2.3" y="2.3" width="7.4" height="7.4" rx="1.4"/><path d="M5 4.6v2.8M7 4.6v2.8"/>',
    reminder: '<circle cx="6" cy="6.4" r="3.7"/><path d="M6 4.5v2l1.2.8M2.6 2.6l1.1-.9M9.4 2.6l-1.1-.9"/>',
    notice: '<path d="M6 2.2 10.3 9.6H1.7z"/><path d="M6 5.2v2" stroke-width="1.3"/><path d="M6 8.4h.01" stroke-width="1.5"/>',
  };
  var icons = {
    search: '<circle cx="7.2" cy="7.2" r="4.3"/><path d="m10.4 10.4 3.1 3.1"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    mic: '<rect x="6" y="2.4" width="4" height="7.2" rx="2"/><path d="M3.9 7.8a4.1 4.1 0 0 0 8.2 0M8 11.9v1.8"/>',
    send: '<path d="M8 12.6V3.6M4.4 7.1 8 3.5l3.6 3.6"/>',
    stop: '<rect x="5" y="5" width="6" height="6" rx="1.3" fill="currentColor" stroke="none"/>',
    down: '<path d="m4.6 6.4 3.4 3.4 3.4-3.4"/>',
    right: '<path d="m6.4 4.6 3.4 3.4-3.4 3.4"/>',
    left: '<path d="M9.6 4.6 6.2 8l3.4 3.4"/>',
    up: '<path d="m4.6 9.6 3.4-3.4 3.4 3.4"/>',
    gear: '<path d="M8 1.8 9.2 1.9 9.9 3.5 10.7 3.9 12.4 3.6 13.2 4.6 12.5 6.1 12.8 7 14.2 8 14.1 9.2 12.5 9.9 12.1 10.7 12.4 12.4 11.4 13.2 9.9 12.5 9 12.8 8 14.2 6.8 14.1 6.1 12.5 5.3 12.1 3.6 12.4 2.8 11.4 3.5 9.9 3.2 9 1.8 8 1.9 6.8 3.5 6.1 3.9 5.3 3.6 3.6 4.6 2.8 6.1 3.5 7 3.2Z"/><circle cx="8" cy="8" r="2.1"/>',
    sliders: '<path d="M2.8 5h10.4M2.8 11h10.4"/><circle cx="6" cy="5" r="1.6" fill="var(--ic-fill, var(--raised))"/><circle cx="10.2" cy="11" r="1.6" fill="var(--ic-fill, var(--raised))"/>',
    shield: '<path d="M8 2.3 12.6 4v3.7c0 3-2.2 5-4.6 5.9-2.4-.9-4.6-2.9-4.6-5.9V4z"/><path d="m6 8 1.5 1.5L10.2 6.7"/>',
    branch: '<circle cx="5" cy="3.8" r="1.4"/><circle cx="5" cy="12.2" r="1.4"/><circle cx="11" cy="5.4" r="1.4"/><path d="M5 5.2v5.6M11 6.8c0 2.4-2.6 2.6-5.3 4.1"/>',
    folder: '<path d="M2.5 4.8a1.3 1.3 0 0 1 1.3-1.3h2.7l1.5 1.5h4.2a1.3 1.3 0 0 1 1.3 1.3v5.2a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3z"/>',
    machine: '<rect x="2.3" y="3" width="11.4" height="7.6" rx="1.6"/><path d="M6 13.2h4M8 10.6v2.6"/>',
    clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.3l2.1 1.3"/>',
    bell: '<path d="M4.3 11V7.4a3.7 3.7 0 0 1 7.4 0V11l1 1.2H3.3zM6.6 13.6a1.5 1.5 0 0 0 2.8 0"/>',
    out: '<path d="M6.3 3.8h5.9v5.9M12.2 3.8 4.4 11.6"/>',
    close: '<path d="m4.4 4.4 7.2 7.2M11.6 4.4l-7.2 7.2"/>',
    more: '<circle cx="3.8" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.2" cy="8" r="1" fill="currentColor"/>',
    sidebar: '<rect x="2.3" y="3" width="11.4" height="10" rx="2"/><path d="M6.4 3v10"/>',
    compose: '<path d="M7 3H4.3A1.8 1.8 0 0 0 2.5 4.8v7a1.8 1.8 0 0 0 1.8 1.8h7a1.8 1.8 0 0 0 1.8-1.8V9"/><path d="m7 9 .4-2L12.2 2.2l1.6 1.6L9 8.6z"/>',
    list: '<path d="M6 4.3h7.5M6 8h7.5M6 11.7h7.5"/><circle cx="3" cy="4.3" r=".8" fill="currentColor"/><circle cx="3" cy="8" r=".8" fill="currentColor"/><circle cx="3" cy="11.7" r=".8" fill="currentColor"/>',
    cube: '<path d="M8 2.2 13.2 5v6L8 13.8 2.8 11V5z"/><path d="M2.8 5 8 7.9 13.2 5M8 7.9v5.9"/>',
    clip: '<path d="M10.8 5.4 6.3 9.9a1.5 1.5 0 0 0 2.1 2.1l4.8-4.8a2.8 2.8 0 0 0-4-4L4.4 8a4.1 4.1 0 0 0 5.8 5.8l3.1-3.1"/>',
    wave: '<path d="M2.6 7v2M5.3 5v6M8 2.8v10.4M10.7 5v6M13.4 7v2"/>',
    arrow: '<path d="M3.2 8h9.4M9 4.4 12.6 8 9 11.6"/>',
    file: '<path d="M4.2 2.3h4.9l2.9 2.9v8.5H4.2z"/><path d="M9 2.4v2.9h2.9"/>',
    diff: '<path d="M4.2 2.3h4.9l2.9 2.9v8.5H4.2z"/><path d="M6.4 7h3.2M8 5.4v3.2M6.4 11h3.2"/>',
    home: '<path d="M2.8 7.3 8 3l5.2 4.3V13H9.6V9.8H6.4V13H2.8z"/>',
    tray: '<path d="M2.5 9.2 4.2 3.8h7.6l1.7 5.4V12.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M2.5 9.2h3.2l.8 1.5h3l.8-1.5h3.2"/>',
    grid: '<rect x="2.6" y="2.6" width="4.4" height="4.4" rx="1.1"/><rect x="9" y="2.6" width="4.4" height="4.4" rx="1.1"/><rect x="2.6" y="9" width="4.4" height="4.4" rx="1.1"/><rect x="9" y="9" width="4.4" height="4.4" rx="1.1"/>',
    user: '<circle cx="8" cy="5.6" r="2.6"/><path d="M3 13.4a5 5 0 0 1 10 0"/>',
    key: '<circle cx="5.4" cy="10.6" r="2.6"/><path d="m7.3 8.7 5.4-5.4M10.8 5.2l1.6 1.6M9.2 6.8l1.2 1.2"/>',
    plug: '<path d="M5.5 2.5v3M10.5 2.5v3M4 5.5h8v2.2a4 4 0 0 1-8 0zM8 11.7v2"/>',
    link: '<path d="M6.8 9.2 9.2 6.8M7.2 4.8l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1M8.8 11.2l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1"/>',
    brush: '<path d="M13 3 7.8 8.6M7.4 8.2l.9 1-1.5 2.7c-.7 1.2-2.4 1.6-4.3 1.1 1-.8.8-2.1 1.6-3.1z"/>',
    moon: '<path d="M12.6 9.8A5.4 5.4 0 1 1 6.2 3.4a4.3 4.3 0 0 0 6.4 6.4z"/>',
    sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1"/>',
    lock: '<rect x="3.4" y="7" width="9.2" height="6.6" rx="1.6"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
    phone: '<rect x="4.4" y="1.8" width="7.2" height="12.4" rx="1.8"/><path d="M7.2 12h1.6"/>',
    globe: '<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c1.6 1.6 2.3 3.5 2.3 5.6S9.6 12 8 13.6C6.4 12 5.7 10.1 5.7 8S6.4 4 8 2.4z"/>',
    bolt: '<path d="M8.8 1.8 3.8 9h3.6l-.8 5.2 5-7.2H8z"/>',
    database: '<ellipse cx="8" cy="4" rx="4.8" ry="1.8"/><path d="M3.2 4v8c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8V4M3.2 8c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8"/>',
    cron: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/>',
    haptic: '<path d="M5 4v8M11 4v8M2.6 6v4M13.4 6v4"/><rect x="6.8" y="3" width="2.4" height="10" rx="1.2"/>',
    return: '<path d="M12.6 4v3.2a1.8 1.8 0 0 1-1.8 1.8H3.6M6.2 6.4 3.6 9l2.6 2.6"/>',
    check: '<path d="m3.2 8.4 3 3 6.6-7"/>',
    swipe: '<path d="M3 8h10M10 5l3 3-3 3"/>',
    ear: '<path d="M4.6 6.4a3.6 3.6 0 1 1 7 1.3c-.5 1-1.6 1.6-1.9 2.6-.3 1.2-.4 2.9-2.1 2.9a1.8 1.8 0 0 1-1.8-1.6"/><path d="M6.6 6.6a1.6 1.6 0 1 1 3 .8"/>',
    keyboard: '<rect x="1.8" y="4" width="12.4" height="8" rx="1.6"/><path d="M4.4 6.6h.1M6.8 6.6h.1M9.2 6.6h.1M11.6 6.6h.1M5.6 9.4h4.8"/>',
    torch: '<path d="M5.2 1.8h5.6v2.4L9.6 6.4v7.8H6.4V6.4L5.2 4.2z"/><path d="M8 8.8v1.6"/>',
    camera: '<path d="M2 5.4c0-.8.6-1.4 1.4-1.4h1.8l1.1-1.6h3.4L10.8 4h1.8c.8 0 1.4.6 1.4 1.4v6.2c0 .8-.6 1.4-1.4 1.4H3.4c-.8 0-1.4-.6-1.4-1.4z"/><circle cx="8" cy="8.4" r="2.4"/>',
  };
  var root = document.documentElement;
  var BRANDS = "<symbol fill=\"currentColor\" id=\"b-github\" viewBox=\"0 0 24 24\"><path d=\"M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12\"/></symbol><symbol fill=\"currentColor\" id=\"b-gmail\" viewBox=\"0 0 24 24\"><path d=\"M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z\"/></symbol><symbol fill=\"currentColor\" id=\"b-sentry\" viewBox=\"0 0 24 24\"><path d=\"M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z\"/></symbol><symbol fill=\"currentColor\" id=\"b-posthog\" viewBox=\"0 0 24 24\"><path d=\"M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z\"/></symbol><symbol fill=\"currentColor\" id=\"b-intercom\" viewBox=\"0 0 24 24\"><path d=\"M21 0H3C1.343 0 0 1.343 0 3v18c0 1.658 1.343 3 3 3h18c1.658 0 3-1.342 3-3V3c0-1.657-1.342-3-3-3zm-5.801 4.399c0-.44.36-.8.802-.8.44 0 .8.36.8.8v10.688c0 .442-.36.801-.8.801-.443 0-.802-.359-.802-.801V4.399zM11.2 3.994c0-.44.357-.799.8-.799s.8.359.8.799v11.602c0 .44-.357.8-.8.8s-.8-.36-.8-.8V3.994zm-4 .405c0-.44.359-.8.799-.8.443 0 .802.36.802.8v10.688c0 .442-.36.801-.802.801-.44 0-.799-.359-.799-.801V4.399zM3.199 6c0-.442.36-.8.802-.8.44 0 .799.358.799.8v7.195c0 .441-.359.8-.799.8-.443 0-.802-.36-.802-.8V6zM20.52 18.202c-.123.105-3.086 2.593-8.52 2.593-5.433 0-8.397-2.486-8.521-2.593-.335-.288-.375-.792-.086-1.128.285-.334.79-.375 1.125-.09.047.041 2.693 2.211 7.481 2.211 4.848 0 7.456-2.186 7.479-2.207.334-.289.839-.25 1.128.086.289.336.25.84-.086 1.128zm.281-5.007c0 .441-.36.8-.801.8-.441 0-.801-.36-.801-.8V6c0-.442.361-.8.801-.8.441 0 .801.357.801.8v7.195z\"/></symbol><symbol fill=\"currentColor\" id=\"b-grafana\" viewBox=\"0 0 24 24\"><path d=\"M23.02 10.59a8.578 8.578 0 0 0-.862-3.034 8.911 8.911 0 0 0-1.789-2.445c.337-1.342-.413-2.505-.413-2.505-1.292-.08-2.113.4-2.416.62-.052-.02-.102-.044-.154-.064-.22-.089-.446-.172-.677-.247-.231-.073-.47-.14-.711-.197a9.867 9.867 0 0 0-.875-.161C14.557.753 12.94 0 12.94 0c-1.804 1.145-2.147 2.744-2.147 2.744l-.018.093c-.098.029-.2.057-.298.088-.138.042-.275.094-.413.143-.138.055-.275.107-.41.166a8.869 8.869 0 0 0-1.557.87l-.063-.029c-2.497-.955-4.716.195-4.716.195-.203 2.658.996 4.33 1.235 4.636a11.608 11.608 0 0 0-.607 2.635C1.636 12.677.953 15.014.953 15.014c1.926 2.214 4.171 2.351 4.171 2.351.003-.002.006-.002.006-.005.285.509.615.994.986 1.446.156.19.32.371.488.548-.704 2.009.099 3.68.099 3.68 2.144.08 3.553-.937 3.849-1.173a9.784 9.784 0 0 0 3.164.501h.08l.055-.003.107-.002.103-.005.003.002c1.01 1.44 2.788 1.646 2.788 1.646 1.264-1.332 1.337-2.653 1.337-2.94v-.058c0-.02-.003-.039-.003-.06.265-.187.52-.387.758-.6a7.875 7.875 0 0 0 1.415-1.7c1.43.083 2.437-.885 2.437-.885-.236-1.49-1.085-2.216-1.264-2.354l-.018-.013-.016-.013a.217.217 0 0 1-.031-.02c.008-.092.016-.18.02-.27.011-.162.016-.323.016-.48v-.253l-.005-.098-.008-.135a1.891 1.891 0 0 0-.01-.13c-.003-.042-.008-.083-.013-.125l-.016-.124-.018-.122a6.215 6.215 0 0 0-2.032-3.73 6.015 6.015 0 0 0-3.222-1.46 6.292 6.292 0 0 0-.85-.048l-.107.002h-.063l-.044.003-.104.008a4.777 4.777 0 0 0-3.335 1.695c-.332.4-.592.84-.768 1.297a4.594 4.594 0 0 0-.312 1.817l.003.091c.005.055.007.11.013.164a3.615 3.615 0 0 0 .698 1.82 3.53 3.53 0 0 0 1.827 1.282c.33.098.66.14.971.137.039 0 .078 0 .114-.002l.063-.003c.02 0 .041-.003.062-.003.034-.002.065-.007.099-.01.007 0 .018-.003.028-.003l.031-.005.06-.008a1.18 1.18 0 0 0 .112-.02c.036-.008.072-.013.109-.024a2.634 2.634 0 0 0 .914-.415c.028-.02.056-.041.085-.065a.248.248 0 0 0 .039-.35.244.244 0 0 0-.309-.06l-.078.042c-.09.044-.184.083-.283.116a2.476 2.476 0 0 1-.475.096c-.028.003-.054.006-.083.006l-.083.002c-.026 0-.054 0-.08-.002l-.102-.006h-.012l-.024.006c-.016-.003-.031-.003-.044-.006-.031-.002-.06-.007-.091-.01a2.59 2.59 0 0 1-.724-.213 2.557 2.557 0 0 1-.667-.438 2.52 2.52 0 0 1-.805-1.475 2.306 2.306 0 0 1-.029-.444l.006-.122v-.023l.002-.031c.003-.021.003-.04.005-.06a3.163 3.163 0 0 1 1.352-2.29 3.12 3.12 0 0 1 .937-.43 2.946 2.946 0 0 1 .776-.101h.06l.07.002.045.003h.026l.07.005a4.041 4.041 0 0 1 1.635.49 3.94 3.94 0 0 1 1.602 1.662 3.77 3.77 0 0 1 .397 1.414l.005.076.003.075c.002.026.002.05.002.075 0 .024.003.052 0 .07v.065l-.002.073-.008.174a6.195 6.195 0 0 1-.08.639 5.1 5.1 0 0 1-.267.927 5.31 5.31 0 0 1-.624 1.13 5.052 5.052 0 0 1-3.237 2.014 4.82 4.82 0 0 1-.649.066l-.039.003h-.287a6.607 6.607 0 0 1-1.716-.265 6.776 6.776 0 0 1-3.4-2.274 6.75 6.75 0 0 1-.746-1.15 6.616 6.616 0 0 1-.714-2.596l-.005-.083-.002-.02v-.056l-.003-.073v-.096l-.003-.104v-.07l.003-.163c.008-.22.026-.45.054-.678a8.707 8.707 0 0 1 .28-1.355c.128-.444.286-.872.473-1.277a7.04 7.04 0 0 1 1.456-2.1 5.925 5.925 0 0 1 .953-.763c.169-.111.343-.213.524-.306.089-.05.182-.091.273-.135.047-.02.093-.042.138-.062a7.177 7.177 0 0 1 .714-.267l.145-.045c.049-.015.098-.026.148-.041.098-.029.197-.052.296-.076.049-.013.1-.02.15-.033l.15-.032.151-.028.076-.013.075-.01.153-.024c.057-.01.114-.013.171-.023l.169-.021c.036-.003.073-.008.106-.01l.073-.008.036-.003.042-.002c.057-.003.114-.008.171-.01l.086-.006h.023l.037-.003.145-.007a7.999 7.999 0 0 1 1.708.125 7.917 7.917 0 0 1 2.048.68 8.253 8.253 0 0 1 1.672 1.09l.09.077.089.078c.06.052.114.107.171.159.057.052.112.106.166.16.052.055.107.107.159.164a8.671 8.671 0 0 1 1.41 1.978c.012.026.028.052.04.078l.04.078.075.156c.023.051.05.1.07.153l.065.15a8.848 8.848 0 0 1 .45 1.34.19.19 0 0 0 .201.142.186.186 0 0 0 .172-.184c.01-.246.002-.532-.024-.856z\"/></symbol><symbol fill=\"currentColor\" id=\"b-stripe\" viewBox=\"0 0 24 24\"><path d=\"M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z\"/></symbol><symbol fill=\"currentColor\" id=\"b-slack\" viewBox=\"0 0 24 24\"><path d=\"M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z\"/></symbol><symbol fill=\"currentColor\" id=\"b-discord\" viewBox=\"0 0 24 24\"><path d=\"M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z\"/></symbol><symbol fill=\"currentColor\" id=\"b-claude\" viewBox=\"0 0 24 24\"><path d=\"m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z\"/></symbol><symbol fill=\"currentColor\" id=\"b-openai\" viewBox=\"0 0 24 24\"><path d=\"M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z\"/></symbol><symbol fill=\"currentColor\" id=\"b-anthropic\" viewBox=\"0 0 24 24\"><path d=\"M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z\"/></symbol><symbol fill=\"currentColor\" id=\"b-linear\" viewBox=\"0 0 24 24\"><path d=\"M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z\"/></symbol><symbol fill=\"currentColor\" id=\"b-datadog\" viewBox=\"0 0 24 24\"><path d=\"M19.57 17.04l-1.997-1.316-1.665 2.782-1.937-.567-1.706 2.604.087.82 9.274-1.71-.538-5.794zm-8.649-2.498l1.488-.204c.241.108.409.15.697.223.45.117.97.23 1.741-.16.18-.088.553-.43.704-.625l6.096-1.106.622 7.527-10.444 1.882zm11.325-2.712l-.602.115L20.488 0 .789 2.285l2.427 19.693 2.306-.334c-.184-.263-.471-.581-.96-.989-.68-.564-.44-1.522-.039-2.127.53-1.022 3.26-2.322 3.106-3.956-.056-.594-.15-1.368-.702-1.898-.02.22.017.432.017.432s-.227-.289-.34-.683c-.112-.15-.2-.199-.319-.4-.085.233-.073.503-.073.503s-.186-.437-.216-.807c-.11.166-.137.48-.137.48s-.241-.69-.186-1.062c-.11-.323-.436-.965-.343-2.424.6.421 1.924.321 2.44-.439.171-.251.288-.939-.086-2.293-.24-.868-.835-2.16-1.066-2.651l-.028.02c.122.395.374 1.223.47 1.625.293 1.218.372 1.642.234 2.204-.116.488-.397.808-1.107 1.165-.71.358-1.653-.514-1.713-.562-.69-.55-1.224-1.447-1.284-1.883-.062-.477.275-.763.445-1.153-.243.07-.514.192-.514.192s.323-.334.722-.624c.165-.109.262-.178.436-.323a9.762 9.762 0 0 0-.456.003s.42-.227.855-.392c-.318-.014-.623-.003-.623-.003s.937-.419 1.678-.727c.509-.208 1.006-.147 1.286.257.367.53.752.817 1.569.996.501-.223.653-.337 1.284-.509.554-.61.99-.688.99-.688s-.216.198-.274.51c.314-.249.66-.455.66-.455s-.134.164-.259.426l.03.043c.366-.22.797-.394.797-.394s-.123.156-.268.358c.277-.002.838.012 1.056.037 1.285.028 1.552-1.374 2.045-1.55.618-.22.894-.353 1.947.68.903.888 1.609 2.477 1.259 2.833-.294.295-.874-.115-1.516-.916a3.466 3.466 0 0 1-.716-1.562 1.533 1.533 0 0 0-.497-.85s.23.51.23.96c0 .246.03 1.165.424 1.68-.039.076-.057.374-.1.43-.458-.554-1.443-.95-1.604-1.067.544.445 1.793 1.468 2.273 2.449.453.927.186 1.777.416 1.997.065.063.976 1.197 1.15 1.767.306.994.019 2.038-.381 2.685l-1.117.174c-.163-.045-.273-.068-.42-.153.08-.143.241-.5.243-.572l-.063-.111c-.348.492-.93.97-1.414 1.245-.633.359-1.363.304-1.838.156-1.348-.415-2.623-1.327-2.93-1.566 0 0-.01.191.048.234.34.383 1.119 1.077 1.872 1.56l-1.605.177.759 5.908c-.337.048-.39.071-.757.124-.325-1.147-.946-1.895-1.624-2.332-.599-.384-1.424-.47-2.214-.314l-.05.059a2.851 2.851 0 0 1 1.863.444c.654.413 1.181 1.481 1.375 2.124.248.822.42 1.7-.248 2.632-.476.662-1.864 1.028-2.986.237.3.481.705.876 1.25.95.809.11 1.577-.03 2.106-.574.452-.464.69-1.434.628-2.456l.714-.104.258 1.834 11.827-1.424zM15.05 6.848c-.034.075-.085.125-.007.37l.004.014.013.032.032.073c.14.287.295.558.552.696.067-.011.136-.019.207-.023.242-.01.395.028.492.08.009-.048.01-.119.005-.222-.018-.364.072-.982-.626-1.308-.264-.122-.634-.084-.757.068a.302.302 0 0 1 .058.013c.186.066.06.13.027.207m1.958 3.392c-.092-.05-.52-.03-.821.005-.574.068-1.193.267-1.328.372-.247.191-.135.523.047.66.511.382.96.638 1.432.575.29-.038.546-.497.728-.914.124-.288.124-.598-.058-.698m-5.077-2.942c.162-.154-.805-.355-1.556.156-.554.378-.571 1.187-.041 1.646.053.046.096.078.137.104a4.77 4.77 0 0 1 1.396-.412c.113-.125.243-.345.21-.745-.044-.542-.455-.456-.146-.749\"/></symbol>";

  function sym(id, vb, body, attrs) {
    return '<symbol id="' + id + '" viewBox="' + vb + '" ' + (attrs || "") + ">" + body + "</symbol>";
  }
  var sprite = "";
  Object.keys(marks).forEach(function (k) { sprite += sym("m-" + k, "0 0 12 12", marks[k], M + ' stroke-width="1.2"'); });
  Object.keys(icons).forEach(function (k) { sprite += sym("i-" + k, "0 0 16 16", icons[k], M + ' stroke-width="1.3"'); });
  sprite += BRANDS;
  // The Hercule mark: the orb resting on the front desk.
  sprite += sym("logo", "0 0 24 24",
    '<defs><radialGradient id="lg-orb" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="var(--logo-hi, oklch(88% 0.09 70))"/><stop offset=".55" stop-color="var(--logo-mid, var(--accent))"/><stop offset="1" stop-color="var(--logo-lo, oklch(45% 0.15 35))"/></radialGradient></defs>' +
    '<circle cx="12" cy="10.4" r="6.6" fill="url(#lg-orb)"/><ellipse cx="9.8" cy="7.9" rx="2.1" ry="1.3" fill="#fff" opacity=".55" transform="rotate(-30 9.8 7.9)"/>' +
    '<path d="M3.6 20.2h16.8" stroke="var(--logo-desk, currentColor)" stroke-width="2.2" stroke-linecap="round" fill="none"/>');

  function svg(id, cls, vb) {
    return '<svg class="' + cls + '" viewBox="' + vb + '" aria-hidden="true"><use href="#' + id + '"/></svg>';
  }
  var EQ = '<span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>';
  function expand(scope) {
    scope.querySelectorAll("[data-i]").forEach(function (el) { el.innerHTML = svg("i-" + el.dataset.i, "", "0 0 16 16"); el.removeAttribute("data-i"); el.classList.add("ic"); });
    scope.querySelectorAll("[data-m]").forEach(function (el) {
      var m = el.dataset.m;
      el.classList.add("mk", "mk-" + m);
      el.innerHTML = m === "working" ? EQ : svg("m-" + m, "", "0 0 12 12");
      el.removeAttribute("data-m");
    });
    scope.querySelectorAll("[data-b]").forEach(function (el) {
      var b = el.dataset.b;
      el.classList.add("br");
      el.innerHTML = b === "pi" ? '<span class="br-pi">&pi;</span>' : b === "cron" ? svg("i-cron", "", "0 0 16 16") : b === "webchat" ? svg("m-session", "", "0 0 12 12") : svg("b-" + b, "", "0 0 24 24");
      el.removeAttribute("data-b");
    });
    scope.querySelectorAll("[data-logo]").forEach(function (el) { el.innerHTML = svg("logo", "", "0 0 24 24"); el.removeAttribute("data-logo"); el.classList.add("logo"); });
  }

  /* ---------- desktop sidebar ---------- */
  function row(o) {
    return '<a class="srow' + (o.active ? " is-active" : "") + '" href="' + (o.href || "#") + '">' +
      '<i class="glyph" data-m="' + o.kind + '" style="color:var(--project-' + o.project + ')"></i>' +
      '<span class="srow-t">' + o.title + "</span>" +
      '<span class="srow-s">' + o.state + "</span></a>";
  }
  function side(el) {
    var page = el.dataset.side;
    // At 10x (?state=10x) every count in the sidebar follows the larger fleet.
    var ten = root.dataset.state === "10x";
    var more = function (n, label, href) { return '<a class="srow srow-more" href="' + (href || "#") + '"><span class="srow-t">' + n + " more " + label + '</span><span class="srow-s"><i data-i="right"></i></span></a>'; };
    var h = '<div class="side-bar"><span class="traffic"><i></i><i></i><i></i></span><span class="side-tools"><i data-i="sidebar"></i><i data-i="compose"></i></span></div>';
    if (page === "settings") {
      var a = el.dataset.active;
      var items = [["Profile", "user"], ["Appearance", "brush"], ["Threads", "list"], ["Assistants", "orb"], ["Connections", "plug"], ["Providers", "bolt"], ["Machines", "machine"], ["Identities", "key"], ["Permission profiles", "shield"], ["Secrets", "lock"], ["Bounds", "held"], ["Plugins", "grid"], ["System", "gear"]];
      var links = { Appearance: "settings-appearance.html", Assistants: "settings-assistants.html", Connections: "settings-connections.html" };
      h += '<a class="side-back" href="assistant.html"><i data-i="left"></i>Back to Ada</a><div class="side-h">Settings</div><nav class="side-nav">';
      items.forEach(function (it) {
        var ic = it[1] === "orb" ? '<i class="orb" data-v="ada" data-p="idle" style="--size:12px"></i>' : it[1] === "held" ? '<i data-m="held"></i>' : '<i data-i="' + it[1] + '"></i>';
        h += '<a class="nav' + (a === it[0] ? " is-active" : "") + '" href="' + (links[it[0]] || "#") + '">' + ic + "<span>" + it[0] + "</span></a>";
      });
      h += "</nav>";
    } else {
      h += '<nav class="side-nav">' +
        '<a class="nav nav-ada' + (page === "home" ? " is-active" : "") + '" href="assistant.html"><i class="orb" data-v="ada" data-p="working" style="--size:18px"></i><span><b>Ada</b><small>working · heartbeat 09:00</small></span><kbd class="kbd">&#8984;J</kbd></a>' +
        '<a class="nav' + (page === "intake" ? " is-active" : "") + '" href="intake.html"><i data-i="tray"></i><span>Intake</span><em class="count count-attn">' + (ten ? "72" : "8") + '</em></a>' +
        '<a class="nav' + (page === "office" ? " is-active" : "") + '" href="office.html"><i data-i="cube"></i><span>Office</span><em class="count">' + (ten ? "140" : "23") + ' live</em></a>' +
        "</nav>" +
        '<div class="side-scroll">' +
        '<div class="grp"><span class="grp-h"><i data-m="q" class="c-attn"></i>Waiting on you<em class="c-attn">' + (ten ? 11 : 3) + '</em></span>' +
        row({ kind: "session", project: "webshop", title: "Fix 3-D Secure checkout for EU cards", state: "git push", active: page === "thread", href: "session-active.html" }) +
        row({ kind: "run", project: "payments-api", title: "Ship release v2.15", state: "npm" }) +
        row({ kind: "session", project: "ops", title: "Migrate ops dashboards", state: "question" }) +
        (ten ? more(8, "waiting", "intake.html") : "") +
        "</div>" +
        '<div class="grp"><span class="grp-h"><i data-m="working"></i>Working<em>' + (ten ? 52 : 8) + '</em></span>' +
        row({ kind: "session", project: "webshop", title: "Refactor cart totals", state: "22m" }) +
        row({ kind: "run", project: "ops", title: "Investigate backup timeouts", state: "6m" }) +
        row({ kind: "run", project: "payments-api", title: "Webhook retry backoff", state: "3m" }) +
        more(ten ? 49 : 5, "working", "office.html") +
        "</div>" +
        '<div class="grp"><span class="grp-h"><i data-m="paused"></i>Paused<em>' + (ten ? 3 : 1) + '</em></span>' +
        row({ kind: "run", project: "webshop", title: "Label new issues", state: "bound" }) +
        (ten ? more(2, "paused", "office.html") : "") +
        "</div>" +
        '<div class="grp"><span class="grp-h"><i data-m="queued"></i>Idle<em>' + (ten ? 74 : 11) + '</em></span>' +
        (page === "draft" ? '<a class="srow is-active" href="session-empty.html"><i class="glyph" data-m="session" style="color:var(--project-webshop)"></i><span class="srow-t">New thread in webshop</span><span class="srow-s">draft</span></a>' : "") +
        row({ kind: "session", project: "payments-api", title: "Add iDEAL research", state: "1h" }) +
        more(ten ? 73 : 10, "idle") +
        "</div>" +
        '<div class="grp"><span class="grp-h">Assistants</span>' +
        '<a class="srow srow-asst" href="#"><i class="orb" data-v="milo" data-p="idle" style="--size:14px"></i><span class="srow-t">Milo</span><span class="srow-s">idle</span></a>' +
        '<a class="srow srow-asst" href="#"><i class="orb" data-v="juno" data-p="asleep" style="--size:14px"></i><span class="srow-t">Juno</span><span class="srow-s">asleep</span></a>' +
        "</div></div>";
    }
    h += '<div class="side-foot"><span class="avatar">R</span><span class="side-me"><b>Rogier</b><small class="fleet"><i style="--f:.83"></i><i style="--f:1" class="is-full"></i><i style="--f:.375"></i>' + (ten ? "9 machines · 80 of 86" : "3 machines · 16 of 22") + '</small></span><a class="side-gear" href="settings-appearance.html"><i data-i="gear"></i></a></div>';
    el.innerHTML = h;
  }

  /* ---------- mobile chrome ---------- */
  function phone(el) {
    var status = '<div class="status"><span class="status-time">9:41</span><span class="island"></span><span class="status-r">' +
      '<svg width="18" height="11" viewBox="0 0 18 11"><rect x="0" y="7" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5" width="3" height="6" rx="1" fill="currentColor"/><rect x="10" y="2.5" width="3" height="8.5" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="11" rx="1" fill="currentColor"/></svg>' +
      '<svg width="16" height="11" viewBox="0 0 16 11"><path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.1-1.2A10.3 10.3 0 0 0 8 .6 10.3 10.3 0 0 0 .9 3.4L2 4.6a8.6 8.6 0 0 1 6-2.4zm0 3.3c1.4 0 2.6.5 3.6 1.4l1.1-1.2A6.9 6.9 0 0 0 8 3.9a6.9 6.9 0 0 0-4.7 1.8l1.1 1.2c1-.9 2.2-1.4 3.6-1.4zm0 3.2c.5 0 1 .2 1.3.5L8 10.6 6.7 9.2c.3-.3.8-.5 1.3-.5z" fill="currentColor"/></svg>' +
      '<svg width="27" height="12" viewBox="0 0 27 12"><rect x=".5" y=".5" width="22" height="11" rx="3.4" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="16.5" height="8" rx="2" fill="currentColor"/><path d="M24.5 4v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill="currentColor" opacity=".45"/></svg>' +
      "</span></div>";
    el.insertAdjacentHTML("afterbegin", status);
    el.insertAdjacentHTML("beforeend", '<div class="homebar"></div>');
    var tab = el.dataset.tab;
    var ten = root.dataset.state === "10x";
    if (tab) {
      var t = function (id, label, icon, href, extra) {
        return '<a class="tab' + (tab === id ? " is-active" : "") + '" href="' + href + '">' + icon + "<span>" + label + "</span>" + (extra || "") + "</a>";
      };
      el.insertAdjacentHTML("beforeend", '<nav class="tabbar">' +
        t("ada", "Ada", '<i class="orb" data-v="ada" data-p="working" style="--size:22px"></i>', "assistant.html") +
        t("intake", "Intake", '<i data-i="tray"></i>', "intake.html", '<em class="tab-badge">' + (ten ? 72 : 8) + "</em>") +
        '<a class="tab tab-ask" href="assistant.html" aria-label="Hold to talk to Ada"><span class="ask-btn"><i data-i="mic"></i></span></a>' +
        t("office", "Office", '<i data-i="cube"></i>', "session-active.html", '<em class="tab-badge">' + (ten ? 11 : 3) + "</em>") +
        t("settings", "Settings", '<i data-i="gear"></i>', "settings.html") +
        "</nav>");
    }
  }

  /* ---------- web top bar ----------
   * The web app has no sidebar: one bar carries the brand, the three places, Ask Ada and what
   * waits on you. data-web names the open page: ada, intake, office, thread or settings. */
  function webbar(el) {
    var page = el.dataset.web;
    var ten = root.dataset.state === "10x";
    var on = function (id) { return page === id ? ' class="is-on"' : ""; };
    el.innerHTML =
      '<a class="wbrand" href="assistant.html"><i data-logo></i>Hercule</a>' +
      '<nav class="wnav">' +
      "<a" + on("ada") + ' href="assistant.html"><i class="orb" data-v="ada" data-p="working" style="--size:14px"></i>Ada</a>' +
      "<a" + on("intake") + ' href="intake.html"><i data-i="tray"></i>Intake<em class="count count-attn">' + (ten ? 72 : 8) + "</em></a>" +
      "<a" + on("office") + ' href="#"><i data-i="cube"></i>Office<em class="count">' + (ten ? 140 : 23) + " live</em></a>" +
      "</nav>" +
      '<label class="wask"><i class="orb" data-v="ada" data-p="working" style="--size:12px"></i><span class="grow">Ask Ada, or jump to any thread</span><kbd class="kbd">/</kbd></label>' +
      '<span class="end"><a class="wwait" href="session-active.html"><i data-m="q"></i>' + (ten ? 11 : 3) + " waiting on you</a>" +
      '<a class="avatar' + (page === "settings" ? " is-on" : "") + '" href="settings-providers.html" title="Settings">R</a></span>';
  }

  /* ---------- the glass composer ---------- */
  function glass(sc) {
    var comp = document.querySelector(sc.dataset.glass);
    if (!comp) return;
    var forced = root.dataset.state === "scrolled";
    function update() {
      if (forced) return;
      var atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 32;
      comp.classList.toggle("is-compact", !atBottom && !comp.contains(document.activeElement));
    }
    sc.addEventListener("scroll", update, { passive: true });
    comp.addEventListener("focusin", function () { forced = false; comp.classList.remove("is-compact"); });
    comp.addEventListener("focusout", update);
    if (forced) {
      comp.classList.add("is-compact");
      sc.scrollTop = Math.max(0, sc.scrollHeight - sc.clientHeight - Number(sc.dataset.scrolledBy || 420));
    } else {
      sc.scrollTop = sc.scrollHeight;
    }
  }

  // Returns how far below the top of the scroll container's content an element sits.
  // Measured from the boxes, so it holds however deeply the element is nested.
  function offsetWithin(sc, el) {
    return el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  }

  function start() {
    // Every page carries the app icon as its favicon. Without one, the browser asks the server for
    // /favicon.ico, which does not exist, and logs a 404.
    if (!document.querySelector("link[rel=icon]")) document.head.insertAdjacentHTML("beforeend", '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E%3Cdefs%3E%3CradialGradient id=\'g\' cx=\'38%25\' cy=\'32%25\' r=\'70%25\'%3E%3Cstop offset=\'0\' stop-color=\'%23f7cfa2\'/%3E%3Cstop offset=\'.55\' stop-color=\'%23d66931\'/%3E%3Cstop offset=\'1\' stop-color=\'%238c3714\'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx=\'14\' cy=\'13.5\' r=\'9.5\' fill=\'url%28%23g%29\'/%3E%3Cellipse cx=\'11\' cy=\'10\' rx=\'3\' ry=\'1.9\' fill=\'%23fff\' opacity=\'.55\' transform=\'rotate%28-30 11 10%29\'/%3E%3Cpath d=\'M3.5 28.5h21\' stroke=\'%233b2a1f\' stroke-width=\'3.2\' stroke-linecap=\'round\'/%3E%3C/svg%3E">');
    document.body.insertAdjacentHTML("afterbegin", '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' + sprite + "</defs></svg>");
    document.querySelectorAll("[data-side]").forEach(side);
    document.querySelectorAll(".phone").forEach(phone);
    document.querySelectorAll("[data-web]").forEach(webbar);
    expand(document);
    document.querySelectorAll("[data-start='bottom']").forEach(function (sc) { sc.scrollTop = sc.scrollHeight; });
    document.querySelectorAll("[data-start-at]").forEach(function (sc) {
      var t = sc.querySelector(sc.dataset.startAt);
      if (t) sc.scrollTop = offsetWithin(sc, t) - Number(sc.dataset.startOffset || 16);
    });
    // ?state=scrolled shows a phone list part-way down, where the swipe rows are.
    if (root.dataset.state === "scrolled") document.querySelectorAll("[data-scrolled-at]").forEach(function (sc) {
      var t = sc.querySelector(sc.dataset.scrolledAt);
      if (t) sc.scrollTop = offsetWithin(sc, t) - 8;
    });
    document.querySelectorAll("[data-glass]").forEach(glass);
    // Theme and accent pickers show what is actually applied (?theme= may have changed it).
    var alias = { light: "linen", dark: "espresso" };
    var theme = alias[root.dataset.theme] || root.dataset.theme;
    var tops = document.querySelectorAll("[data-set-theme]");
    if ([].some.call(tops, function (b) { return b.dataset.setTheme === theme; })) tops.forEach(function (b) { b.classList.toggle("is-on", b.dataset.setTheme === theme); });
    // Segmented controls and theme options on settings pages switch live.
    document.addEventListener("click", function (e) {
      var s = e.target.closest(".seg button, .seg a");
      if (s && s.parentElement.classList.contains("seg") && !s.getAttribute("href")) {
        s.parentElement.querySelectorAll(".is-on").forEach(function (b) { b.classList.remove("is-on"); });
        s.classList.add("is-on");
      }
      var th = e.target.closest("[data-set-theme]");
      if (th) {
        root.dataset.theme = th.dataset.setTheme;
        document.querySelectorAll("[data-set-theme]").forEach(function (b) { b.classList.toggle("is-on", b === th); });
      }
      var ac = e.target.closest("[data-set-accent]");
      if (ac) {
        root.dataset.accent = ac.dataset.setAccent;
        document.querySelectorAll("[data-set-accent]").forEach(function (b) { b.classList.toggle("is-on", b === ac); });
      }
      var tg = e.target.closest(".toggle");
      if (tg) tg.classList.toggle("is-on");
    });
    root.classList.add("is-ready");
  }
  window.Concierge = { expand: expand };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
