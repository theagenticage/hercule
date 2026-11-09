// Builds the mockup frames. The DOM and class names are the real components' (requests-side.tsx,
// request-card.tsx, link-lines.tsx); only the wrappers marked "mock" are new.

const GITHUB =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";

// Paths of the app's icons (apps/desktop/src/renderer/icons), plus two drawn for this mockup: group and sort.
const ICONS = {
  chevronDown: "M3.8 6.2L8 10.4l4.2-4.2",
  chevronRight: "M6.2 3.8L10.4 8l-4.2 4.2",
  link: "M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6",
  check: "M3.4 8.4l3 3 6.2-6.6",
  filter: "M2.6 3.6h10.8M4.6 8h6.8M6.6 12.4h2.8",
  sliders: "M3 5h5.4M11.6 5H13M3 11h1.4M7.6 11H13",
  group: "M2.6 3.4h3.2M5.4 7.2h8M5.4 10.2h8M2.6 13.2h3.2",
  sort: "M5 13V3M5 13l-2.2-2.2M5 13l2.2-2.2M11 3v10M11 3L8.8 5.2M11 3l2.2 2.2",
};
const KNOBS = '<circle cx="10" cy="5" r="1.6"/><circle cx="6" cy="11" r="1.6"/>';
const icon = (name, size = 16) =>
  `<svg class="ic" viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/>${name === "sliders" ? KNOBS : ""}</svg>`;

const WHERE_A = "rogierpennink · made-men/mafiamatrix · yours";
const CARDS = {
  a1: { title: "Review requested: Add rate limiting to the crime cooldown endpoints", wait: "3h", level: "fresh", where: WHERE_A },
  a2: { title: "Fix flaky bank robbery payout test in the nightly run", wait: "5h", level: "fresh", where: WHERE_A },
  a3: { title: "Bump drizzle-orm from 0.38.3 to 0.38.4", wait: "1d", level: "recent", where: WHERE_A },
  b1: { title: "BAC-754 Checkout totals drift when a voucher is removed from the basket", wait: "2d", level: "due", where: "miclairy · MatchWornShirt/monorepo · yours" },
  b2: { title: "Migrate the worker queue to the new scheduler API", wait: "2d", level: "due", where: "miclairy · MatchWornShirt/monorepo · yours" },
  b3: { title: "Update CODEOWNERS for the payments folder", wait: "4d", level: "over", where: "miclairy · MatchWornShirt/monorepo · yours" },
};

const peerLine = (hover) =>
  `<button type="button" tabindex="-1" class="inbox-hint${hover ? " is-hover" : ""}">${icon("link", 12)}<span>Linked to BAC-754</span></button>`;
const mentionLine = (hover) =>
  `<button type="button" tabindex="-1" class="inbox-hint${hover ? " is-hover" : ""}">${icon("link", 12)}<span>Mentions #21663</span><b>Link them</b></button>`;

const card = (c, current = false) => `
  <div class="inbox-request" role="listitem"${current ? " data-current" : ""} tabindex="-1">
    <i class="card-stock"></i>
    <span class="card-body">
      <span class="request-mark"><svg class="br" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${GITHUB}"/></svg></span>
      <p class="request-title" title="${c.title}">${c.title}</p>
      <span class="card-wait" data-level="${c.level}">${c.wait}</span>
      <span class="request-under"><span class="request-where">${c.where}</span></span>
    </span>
  </div>`;

/**
 * One bundle: a card and its lines. `lip` is "today" (lines float under the card, as the app
 * draws them), "tray", "sheet" or "tab"; the lines go in a `.lip` wrapper for the last three.
 * `hover` is "card" or "hint" to draw that hover state.
 */
const bundle = (c, { lines = [], lip = "today", hover = null } = {}) => {
  const html = lines.map((l) => l(hover === "hint" && l === lines[lines.length - 1])).join("");
  const inner = lines.length === 0 ? "" : lip === "today" ? html : `<div class="lip">${html}</div>`;
  const cls = lines.length > 0 && lip !== "today" ? ` lip-${lip}` : "";
  return `<div class="inbox-bundle${cls}">${card(c, hover === "card")}${inner}</div>`;
};

const heading = (tools = "") => `
  <div class="inbox-section-head">
    <h3 class="desk-heading"><span>Requests</span><span class="desk-heading-count">31</span></h3>
    ${tools}
  </div>`;

const column = (body, caption, cls = "") =>
  `<figure><div class="col${/C1 open/.test(caption) ? " is-open" : /C2 filter/.test(caption) ? " is-open-small" : ""}"><aside class="inbox-narrow ${cls}">${body}</aside></div><figcaption>${caption}</figcaption></figure>`;
const variant = (title, text, frames) =>
  `<div class="variant"><h2>${title}</h2><p>${text}</p><div class="frames">${frames.join("")}</div></div>`;

// ---------- Controls ----------
const AUTHORS = ["DenisCorlade", "miclairy", "rogier-matchworn"];
const pick = (name, on) =>
  `<button type="button" role="menuitemradio" aria-checked="${on}" class="menu-pick${on ? " is-on" : ""}"><span class="menu-mark"></span><span>${name}</span>${on ? icon("check", 14) : ""}</button>`;
const head = (t) => `<p class="menu-h">${t}</p>`;
const menu = (label, inner) => `<div role="menu" aria-label="${label}" class="pop popover-menu menu--tool menu--tool-button-end mock-menu">${inner}</div>`;
const showRows = (chosen) => ["All", "Mine", ...AUTHORS].map((n) => pick(n, n === chosen)).join("");

const viewTrigger = ({ summary, open }) =>
  `<button type="button" class="view-trigger${summary ? " is-on" : ""}${open ? " is-open" : ""}" aria-haspopup="menu">${icon("sliders")}${summary ? `<span class="summary">${summary}</span>` : ""}</button>`;

const c1Menu = (s) => menu("View", head("Show") + showRows(s.show) + head("Group") + pick("None", s.group === "None") + pick("By place", s.group === "By place") + head("Sort") + pick("Newest first", s.sort === "Newest first") + pick("Oldest first", s.sort === "Oldest first"));

const list = (cards, grouped) => grouped
  ? `<div class="inbox-requests"><h3 class="inbox-requests-label">made-men/mafiamatrix</h3><div class="inbox-requests-group" role="list">${cards.slice(0, 3).map((c) => bundle(c)).join("")}</div></div>`
  : `<div class="inbox-requests"><div class="inbox-requests-group" role="list">${cards.map((c) => bundle(c)).join("")}</div></div>`;
const A = [CARDS.a1, CARDS.a2, CARDS.a3];
const NONDEFAULT = { show: "Mine", group: "By place", sort: "Oldest first" };
const DEFAULT = { show: "All", group: "None", sort: "Newest first" };

const todayOrder = `<button type="button" class="inbox-order" title="Order requests"><span>Oldest first</span>${icon("chevronDown")}</button>`;

const iconBtn = (name, { on, open }) => `<button type="button" class="icon-btn${on ? " is-on" : ""}${open ? " is-open" : ""}" aria-haspopup="menu" aria-label="${name}">${icon(name)}</button>`;
const c2Tools = ({ filter, group, sort }, open) => `<div class="head-tools">
  <span class="tool-wrap">${iconBtn("filter", { on: filter, open: open === "filter" })}${open === "filter" ? menu("Show", showRows("Mine").replace(/^(.*?<\/button>){2}/, (m) => m + '<i class="menu-line"></i>')) : ""}</span>
  <span class="tool-wrap">${iconBtn("group", { on: group, open: open === "group" })}</span>
  <span class="tool-wrap">${iconBtn("sort", { on: sort, open: open === "sort" })}</span></div>`;

document.querySelector('[data-slot="controls"]').innerHTML = [
  variant("Today", "The single order control with its three mixed orders.", [
    column(heading(todayOrder) + list(A, false), "Today (order select)"),
  ]),
  variant("C1 one View menu", "One trigger at the end of the heading. Icon only when everything is default; a short summary of what differs otherwise. One popover with three headed sections.", [
    column(heading(`<div class="head-tools"><span class="tool-wrap">${viewTrigger({})}</span></div>`) + list(A, false), "C1 closed, defaults"),
    column(heading(`<div class="head-tools"><span class="tool-wrap">${viewTrigger({ summary: "Mine · By place · Oldest" })}</span></div>`) + list(A, true), "C1 closed, non-defaults"),
    column(heading(`<div class="head-tools"><span class="tool-wrap">${viewTrigger({ summary: "Mine · By place · Oldest", open: true })}${c1Menu(NONDEFAULT)}</span></div>`) + list(A, true), "C1 open"),
  ]),
  variant("C2 three icon buttons", "Filter, group and sort as three 24px icon buttons, each with its own small menu. A button set to a non-default value turns ink and carries a small dot.", [
    column(heading(c2Tools({}, null)) + list(A, false), "C2 closed, defaults"),
    column(heading(c2Tools({ filter: true, group: true, sort: true }, null)) + list(A, true), "C2 closed, non-defaults"),
    column(heading(c2Tools({ filter: true, group: true, sort: true }, "filter")) + list(A, true), "C2 filter menu open"),
  ]),
].join("");

// ---------- Groups ----------
const groupHead = (style, { name, count, open, hover }) => {
  const cv = icon(open ? "chevronDown" : "chevronRight");
  const h = hover ? " is-hover" : "";
  if (style === "g1")
    return `<button type="button" class="group-head${h}" aria-expanded="${open}">${cv}<span class="name">${name}</span>${open ? "" : `<span class="group-count">${count}</span>`}</button>`;
  if (style === "g2")
    return `<button type="button" class="group-head${h}" aria-expanded="${open}"><span class="name">${name}</span><span class="group-count">${count}</span>${cv}</button>`;
  return `<h3 class="inbox-requests-label">${name}</h3>`;
};
const group = (style, name, cards, open, hover) =>
  groupHead(style, { name, count: cards.length, open, hover }) +
  (open ? `<div class="inbox-requests-group" role="list">${cards.map((c) => bundle(c)).join("")}</div>` : "");
const B = [CARDS.b1, CARDS.b2, CARDS.b3];
const PA = "made-men/mafiamatrix";
const PB = "MatchWornShirt/monorepo";
const groupsCol = (style, caption, { openA, openB, hoverA, hoverB }) =>
  column(heading() + `<div class="inbox-requests">${group(style, PA, A, openA, hoverA)}${group(style, PB, B, openB, hoverB)}</div>`, caption, style);

document.querySelector('[data-slot="groups"]').innerHTML = [
  variant("Today", "Plain faint text label, not a control.", [
    groupsCol("today", "Today (both groups open)", { openA: true, openB: true }),
  ]),
  variant("G1 chevron before the name", "The whole header is the button. The chevron sits in the column of the card marks and the name starts where the card titles do. A collapsed group shows its count after the name.", [
    groupsCol("g1", "G1 first open, second collapsed", { openA: true, openB: false }),
    groupsCol("g1", "G1 hover on an open header", { openA: true, openB: false, hoverA: true }),
    groupsCol("g1", "G1 hover on the collapsed header", { openA: true, openB: false, hoverB: true }),
  ]),
  variant("G2 count and chevron at the end", "Name at the cards' text edge on the left; count and chevron at the right end. The count is always shown here.", [
    groupsCol("g2", "G2 first open, second collapsed", { openA: true, openB: false }),
    groupsCol("g2", "G2 hover on an open header", { openA: true, openB: false, hoverA: true }),
    groupsCol("g2", "G2 hover on the collapsed header", { openA: true, openB: false, hoverB: true }),
  ]),
].join("");

// ---------- Lips ----------
const lipColumn = (lip, caption) => {
  const one = [peerLine];
  const two = [peerLine, mentionLine];
  const body = [
    bundle(CARDS.a2),
    bundle(CARDS.a1, { lines: one, lip }),
    bundle(CARDS.b1, { lines: two, lip }),
    bundle(CARDS.b2, { lines: two, lip, hover: "card" }),
    bundle(CARDS.b3, { lines: two, lip, hover: "hint" }),
    bundle(CARDS.a3),
  ].join("");
  return column(`<div class="inbox-requests"><div class="inbox-requests-group" role="list">${body}</div></div>`, caption);
};
document.querySelector('[data-slot="lips"]').innerHTML = [
  variant("Today", "Top to bottom: plain card, one line, two lines, card hovered, hint hovered (shows Link them), plain card.", [lipColumn("today", "Today (lines float under the card)")]),
  variant("L1 tray", "A recessed strip tucked under the card, inset 8px at each side, top hidden under the card. The card's shadow falls on it when it rises.", [lipColumn("tray", "L1 tray")]),
  variant("L2 same sheet", "Card and lines are one sheet. A soft hairline divides them, inset to the card's 12px padding. The whole sheet rises on hover.", [lipColumn("sheet", "L2 same sheet")]),
  variant("L3 tab", "A fit-content tab hanging from the card's lower left. Same fill and hairline as the card; it covers the card's bottom hairline so there is no seam.", [lipColumn("tab", "L3 tab")]),
].join("");
