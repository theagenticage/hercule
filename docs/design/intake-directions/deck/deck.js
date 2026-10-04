// PROTOTYPE - the Deck direction's fixtures, rendering and keys, shared by its three pages.
// Load it after crew.js: it renders into the page's [data-deck-*] slots before crew.js draws
// faces and marks, and it syncs the shell's counts after crew.js has drawn the shell.
//
// URL parameters, on top of the ones page.js reads:
//   ?d=<card id>     the card in focus (the web app's /intake/d/<id>)
//   ?topic=<name>    deal only one topic's decisions
(function () {
  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var state = root.dataset.state || "default";
  var platform = /\/mobile\//.test(location.pathname) ? "mobile" : /\/web\//.test(location.pathname) ? "web" : "desktop";
  var swarm = state === "swarm";

  /* ------------------------------------------------------------------ fixtures */

  var WORKER = {
    "Fix bug": "Claude Code · Opus 5.5 · studio-mac",
    Investigate: "Codex · gpt-5.4 · build-box-1",
    "Draft reply": "Claude Code · Haiku 4.5 · build-box-2",
  };
  var SYSTEM = { sentry: "Sentry", gmail: "Gmail", posthog: "PostHog", github: "GitHub", intercom: "Intercom", grafana: "Grafana", stripe: "Stripe", cron: "Cron", linear: "Linear" };
  var GROUPS = [
    { key: "now", label: "Now" },
    { key: "call", label: "Needs a call" },
    { key: "today", label: "Today" },
    { key: "later", label: "When you can" },
  ];

  // Answer builders. A describe line is the core's: live names and values sit in <b>.
  function start(workflow, project, task) {
    return { label: 'Start "' + workflow + '"', face: workflow, primary: true, describe: "Starts <b>" + workflow + "</b> on <b>" + project + "</b> with task <b>" + task + "</b>", fine: WORKER[workflow], sends: workflow + " · " + project };
  }
  function startAll(n, workflow, project) {
    return { label: "Start all " + n, face: workflow, primary: true, describe: "Starts <b>" + n + "</b> runs of <b>" + workflow + "</b> on <b>" + project + "</b>, one per Task above", fine: WORKER[workflow], sends: n + " runs of " + workflow };
  }
  function accept(task, primary) {
    return { label: "Accept", icon: "check", primary: !!primary, describe: "Removes label <b>proposed</b> from Task <b>" + task + "</b>", sends: "Accept" };
  }
  function acceptAll(n, primary) {
    return { label: "Accept all " + n, icon: "check", primary: !!primary, describe: "Removes label <b>proposed</b> from the <b>" + n + "</b> Tasks above", sends: "Accept " + n };
  }
  function dismissTask(task) {
    return { label: "Dismiss", icon: "close", quiet: true, describe: "Sets status to <b>cancelled</b> on Task <b>" + task + "</b>", sends: "Dismiss" };
  }
  function dismissAll(n) {
    return { label: "Dismiss all " + n, icon: "close", quiet: true, describe: "Sets status to <b>cancelled</b> on the <b>" + n + "</b> Tasks above", sends: "Dismiss " + n };
  }
  function dismissOffer(fine) {
    return { label: "Dismiss", icon: "close", quiet: true, describe: "Does nothing", fine: fine, sends: "Dismiss" };
  }
  function setProject(label, task) {
    return { label: label, glyph: label, describe: "Sets project to <b>" + label + "</b> on Task <b>" + task + "</b>", sends: "Project " + label };
  }

  var LEAD_TASK = "Checkout fails for EU cards with 3-D Secure";
  var ANDROID_TASK = "App is slow on Android";

  var LEAD = {
    id: "lead", group: "now", kind: "Proposal", topic: "Checkout", priority: 4, project: "webshop", seen: "first seen 08:52",
    title: LEAD_TASK,
    gist: "Since deploy #1289, card payments that need 3-D Secure fail at checkout for EU customers. The new Stripe SDK returns <code>requires_action</code>, and <code>handlePaymentResult</code> treats it as a failure.",
    short: "Since deploy #1289, EU card payments that need 3-D Secure fail at checkout.",
    from: [
      { brand: "sentry", conn: "Sentry · webshop-prod", count: "<b>412</b> events · <b>188</b> users" },
      { brand: "gmail", conn: "Gmail · rogier@personal", count: "<b>3</b> customer emails" },
      { brand: "posthog", conn: "PostHog · webshop", count: "<b>-18%</b> conversion, EU" },
      { brand: "github", conn: "GitHub · rogier", count: "deploy <b>#1289</b>, yesterday 14:02" },
    ],
    answers: [start("Fix bug", "webshop", LEAD_TASK), accept(LEAD_TASK), dismissTask(LEAD_TASK)],
    note: { face: "Triage", text: "I can also draft a reply to the 3 customers once the fix ships.", later: true },
    evidence: {
      why: "All three signals start after deploy #1289 and involve EU cards that need 3-D Secure, so I made them one urgent Task: checkout is losing sales now.",
      excerpts: [
        { brand: "sentry", conn: "Sentry · webshop-prod", head: "<code>PaymentError: authentication_required</code>", body: "412 events from 188 users since yesterday 14:06. Thrown in <code>handlePaymentResult</code> (checkout/pay.ts:88)." },
        { brand: "gmail", conn: "Gmail · rogier@personal", head: "3 customer emails", body: "\"Card declined at checkout\" · \"Can't pay with my Rabobank card\" · \"Payment keeps failing\"" },
        { brand: "posthog", conn: "PostHog · webshop", head: "Checkout conversion -18%", body: "Since 14:10 yesterday, EU visitors only. Other regions are flat." },
        { brand: "github", conn: "GitHub · rogier", head: "Deploy #1289 to rogier/webshop", body: "Yesterday 14:02: \"Upgrade Stripe SDK to v14\"." },
      ],
      history: "First seen by triage at&nbsp;08:52 · proposed as urgent at&nbsp;09:00",
    },
  };

  var ANDROID = {
    id: "android", group: "call", kind: "Unsure", topic: "Customers",
    title: ANDROID_TASK,
    gist: "Customers say the app is slow on Android since Sunday. Nothing in the conversations names a page, so it may be the shop or the payment step.",
    short: "Customers say the app is slow on Android since Sunday.",
    from: [{ brand: "intercom", conn: "Intercom · support", count: "<b>7</b> conversations since Sunday" }],
    answers: [
      setProject("webshop", ANDROID_TASK),
      setProject("payments-api", ANDROID_TASK),
      { label: "Not work", icon: "close", quiet: true, describe: "Sets status to <b>cancelled</b> on Task <b>" + ANDROID_TASK + "</b>", sends: "Not work" },
    ],
    note: { face: "Triage", text: "I can't tell which project this belongs to." },
  };

  var BREAKER = {
    id: "breaker", group: "call", kind: "Breaker tripped", topic: "Releases",
    title: "Label new issues held 34 events",
    gist: "The workflow's Spawn Bound (20 per hour) tripped at 08:14 after a bot opened 34 issues.",
    from: [{ brand: "github", conn: "GitHub · rogier", count: "<b>34</b> issues opened by a bot" }],
    answers: [
      { label: "Resume", icon: "play", describe: "Resumes <b>Label new issues</b>: the <b>34</b> held events start runs at <b>20 per hour</b>, the rest as the window frees up", sends: "Resume" },
      { label: "Resume and discard", icon: "play", describe: "Resumes <b>Label new issues</b> and discards the <b>34</b> held events", sends: "Resume and discard" },
      { label: "Edit the trigger", kind: "opens", trail: "arrow", describe: "Opens the trigger of <b>Label new issues</b>, where its Spawn Bound lives" },
    ],
    note: { icon: "pause", text: "Not answering keeps the 34 events held." },
  };

  var BACKUP_TASK = "Nightly backup job timing out on ops-db";
  var BACKUP = {
    id: "backup", group: "today", kind: "Proposal", topic: "Infrastructure", priority: 3, project: "ops",
    title: BACKUP_TASK,
    gist: "3 nights in a row; the job hits its 2h limit at 04:00.",
    from: [
      { brand: "grafana", conn: "Grafana · ops", count: "<b>2</b> alerts" },
      { brand: "cron", conn: "Cron · schedules", count: "<b>3</b> runs over 2h" },
    ],
    answers: [start("Investigate", "ops", BACKUP_TASK), accept(BACKUP_TASK), dismissTask(BACKUP_TASK)],
  };

  var MARTA = {
    id: "marta", group: "today", kind: "Offer", topic: "Customers",
    title: "Draft a reply to Marta at Brightline",
    gist: "Asks for invoice INV-2291 in the company name, not hers.",
    from: [{ brand: "gmail", conn: "Gmail · rogier@personal", count: "<b>1</b> email" }],
    answers: [
      { label: "Draft reply", face: "Draft reply", primary: true, describe: "Starts <b>Draft reply</b> with thread <b>Invoice INV-2291</b> from <b>Gmail · rogier@personal</b>", fine: "You review the draft before anything is sent.", sends: "Draft reply · Marta at Brightline" },
      dismissOffer(),
    ],
  };

  var WEBHOOK_TASK = "Stripe webhook retries rising";
  var WEBHOOK = {
    id: "webhook", group: "today", kind: "Proposal", topic: "Checkout", priority: 2, project: "payments-api", seen: "first seen 07:40",
    title: WEBHOOK_TASK,
    gist: "Since 07:40 Stripe retries more webhook deliveries; the payments-api handler times out on some.",
    from: [
      { brand: "stripe", conn: "Stripe · live", count: "<b>11</b> retried deliveries" },
      { brand: "sentry", conn: "Sentry · webshop-prod", count: "<b>1</b> timeout issue" },
    ],
    answers: [start("Investigate", "payments-api", WEBHOOK_TASK), accept(WEBHOOK_TASK), dismissTask(WEBHOOK_TASK)],
  };

  var MERGE = {
    id: "merge", group: "today", kind: "Offer", topic: "Releases",
    title: "Merge 4 dependency bumps",
    gist: "All green, patch versions only.",
    from: [{ brand: "github", conn: "GitHub · rogier", count: "<b>4</b> pull requests" }],
    members: ["#1301 stripe 14.0.1 → 14.0.2", "#1302 vite 6.2.3 → 6.2.4", "#1304 react-dom 19.1.0 → 19.1.1", "#1305 eslint 9.24.0 → 9.24.1"],
    answers: [
      { label: "Merge all 4", icon: "branch", primary: true, describe: "Merges <b>#1301 #1302 #1304 #1305</b> in <b>rogier/webshop</b> as <b>GitHub · rogier</b>", sends: "Merge 4 pull requests" },
      { label: "Review first", kind: "opens", trail: "external", describe: "Opens the 4 pull requests" },
      dismissOffer("Triage won't offer these again."),
    ],
  };

  var SSL_TASK = "SSL certificate for status.acme.dev expires in 12 days";
  var SSL = {
    id: "ssl", group: "later", kind: "Proposal", topic: "Infrastructure", priority: 1, project: "ops",
    title: SSL_TASK,
    gist: "The certificate runs out on 11 October and nothing renews it automatically.",
    from: [{ brand: "cron", conn: "Cron · schedules", count: "<b>1</b> certificate check" }],
    answers: [start("Fix bug", "ops", SSL_TASK), accept(SSL_TASK), dismissTask(SSL_TASK)],
  };

  var IDEAL_TASK = "Add iDEAL as a payment method";
  var IDEAL = {
    id: "ideal", group: "later", kind: "Proposal", topic: "Checkout", priority: 1, project: "webshop",
    title: IDEAL_TASK,
    gist: "5 customers asked to pay with iDEAL at checkout.",
    from: [{ brand: "intercom", conn: "Intercom · support", count: "<b>5</b> requests" }],
    answers: [accept(IDEAL_TASK, true), dismissTask(IDEAL_TASK)],
  };

  var DECK = [LEAD, ANDROID, BREAKER, BACKUP, MARTA, WEBHOOK, MERGE, SSL, IDEAL];

  // At 10x triage batches alike decisions: 90 decisions arrive as 13 cards.
  var SWARM = [
    LEAD,
    ANDROID,
    BREAKER,
    {
      id: "s-fix9", group: "today", kind: "Proposals", topic: "Checkout", count: 9, priority: 2, project: "webshop", split: true,
      title: 'Start "Fix bug" on 9 checkout errors',
      gist: "9 new Sentry errors in checkout since 18:20, each its own Task. None of them blocks a payment.",
      from: [{ brand: "sentry", conn: "Sentry · webshop-prod", count: "<b>9</b> issues · <b>214</b> events" }],
      members: ["Apple Pay sheet closes on iOS 19", "Coupon field rejects pasted codes", "Shipping cost shows €0 for Belgium", "Klarna redirect loses the cart", "Order confirmation email sent twice", "Address autocomplete fails on Safari", "Gift card balance not applied", "Checkout button double-submits", "VAT missing on invoices for Spain"],
      answers: [startAll(9, "Fix bug", "webshop"), acceptAll(9), dismissAll(9)],
    },
    WEBHOOK,
    {
      id: "s-infra8", group: "today", kind: "Proposals", topic: "Infrastructure", count: 8, priority: 2, project: "ops", split: true,
      title: "Investigate 8 alerts on ops machines",
      gist: "Grafana alerts and failed Cron jobs on ops machines overnight, each its own Task.",
      from: [
        { brand: "grafana", conn: "Grafana · ops", count: "<b>6</b> alerts" },
        { brand: "cron", conn: "Cron · schedules", count: "<b>2</b> failed jobs" },
      ],
      members: [BACKUP_TASK, "Disk at 86% on build-box-1", "Redis memory climbing on cache-2", "Slow queries on the orders table", "Grafana alert flapping on ops-db", "Log shipping delayed by 40 min", "Staging deploys failing on build-box-2", "DNS lookups timing out in eu-west"],
      answers: [startAll(8, "Investigate", "ops"), acceptAll(8), dismissAll(8)],
    },
    {
      id: "s-replies20", group: "today", kind: "Offers", topic: "Customers", count: 20, split: true,
      title: "Draft replies to 20 customers",
      gist: "20 customers wrote about an order or an invoice; each needs a short answer.",
      from: [{ brand: "gmail", conn: "Gmail · rogier@personal", count: "<b>20</b> emails" }],
      members: ["Marta at Brightline", "Sem at Polderhuis", "Noor at Fietsfabriek", "Lucas at Kaaskamer", "Emma at Bloemenhof", "Daan at Tegelwerk", "Julia at Zeilschool", "Finn at Koffiebrander", "Sara at Linnenkast", "Milan at Drukkerij Vos", "Tess at Groenteboer", "Bram at Houtwerf", "Lotte at Visafslag", "Ruben at Atelier Mol", "Isa at Boekhandel Kok", "Thijs at Bakfiets & Co", "Fleur at Theehuis", "Lars at Rijwiel", "Evi at Pottenbakker", "Jesse at Glashuis"],
      flow: true,
      answers: [
        { label: "Draft all 20", face: "Draft reply", primary: true, describe: "Starts <b>20</b> runs of <b>Draft reply</b>, one per email above, from <b>Gmail · rogier@personal</b>", fine: "You review each draft before anything is sent.", sends: "20 runs of Draft reply" },
        dismissOffer(),
      ],
    },
    {
      id: "s-accept14", group: "today", kind: "Proposals", topic: "Customers", count: 14, priority: 2, split: true,
      title: "Accept 14 customer requests",
      gist: "Feature requests from Intercom conversations. None blocks a sale.",
      from: [{ brand: "intercom", conn: "Intercom · support", count: "<b>14</b> conversations" }],
      members: ["Export orders as CSV", "Dark mode for the account page", "Invoice address per order", "PayPal Pay Later", "Order notes field", "Bulk discount for 10+ items", "Gift wrapping option", "Save cart across devices", "Wishlist sharing", "Delivery date picker", "Reorder from order history", "Show stock per size", "Klarna for Belgium", "Multiple shipping addresses"],
      answers: [acceptAll(14, true), dismissAll(14)],
    },
    {
      id: "s-vendor6", group: "today", kind: "Offers", topic: "Customers", count: 6, split: true,
      title: 'Reply "approved" to 6 vendor emails',
      gist: "6 vendors ask you to approve a proof, a rate or a renewal.",
      from: [{ brand: "gmail", conn: "Gmail · rogier@personal", count: "<b>6</b> emails" }],
      members: ["Printful · proof for tote bag v2", "Sendcloud · new rates from 1 November", "Mollie · updated terms", "Packhelp · box artwork", "Moneybird · annual plan renewal", "PostNL · new pickup window"],
      answers: [
        { label: "Reply to all 6", icon: "send", primary: true, describe: "Replies <b>approved</b> to the <b>6</b> emails above as <b>Gmail · rogier@personal</b>", sends: "6 replies" },
        { label: "Review first", kind: "opens", trail: "external", describe: "Opens the 6 emails" },
        dismissOffer(),
      ],
    },
    {
      id: "merge12", group: "today", kind: "Offer", topic: "Releases",
      title: "Merge 12 dependency bumps",
      gist: "All green, patch versions only.",
      from: [{ brand: "github", conn: "GitHub · rogier", count: "<b>12</b> pull requests" }],
      members: ["#1301 stripe 14.0.1 → 14.0.2", "#1302 vite 6.2.3 → 6.2.4", "#1304 react-dom 19.1.0 → 19.1.1", "#1305 eslint 9.24.0 → 9.24.1", "#1306 typescript 5.9.2 → 5.9.3", "#1307 vitest 3.2.1 → 3.2.2", "#1308 prettier 3.6.0 → 3.6.1", "#1309 postcss 8.5.3 → 8.5.4", "#1310 @types/node 22.15.2 → 22.15.3", "#1311 date-fns 4.1.0 → 4.1.1", "#1312 msw 2.8.4 → 2.8.5", "#1313 tailwindcss 4.1.7 → 4.1.8"],
      answers: [
        { label: "Merge all 12", icon: "branch", primary: true, describe: "Merges the <b>12</b> pull requests above in <b>rogier/webshop</b> as <b>GitHub · rogier</b>", sends: "Merge 12 pull requests" },
        { label: "Review first", kind: "opens", trail: "external", describe: "Opens the 12 pull requests" },
        dismissOffer("Triage won't offer these again."),
      ],
    },
    {
      id: "s-close9", group: "today", kind: "Offer", topic: "Releases",
      title: "Close 9 duplicate issues",
      gist: '9 issues repeat #1240, "Checkout button misaligned on iPad".',
      from: [{ brand: "github", conn: "GitHub · rogier", count: "<b>9</b> issues" }],
      members: ["#1271", "#1273", "#1276", "#1279", "#1280", "#1283", "#1284", "#1286", "#1288"],
      flow: true,
      answers: [
        { label: "Close all 9", icon: "close", kind: "unavailable", describe: "Cannot be taken: the GitHub plugin changed this action's inputs at 08:30, after triage proposed it" },
        dismissOffer("Triage won't offer these again."),
      ],
    },
    {
      id: "s-release5", group: "today", kind: "Proposals", topic: "Releases", count: 5, priority: 2, project: "payments-api", split: true,
      title: "Accept 5 release follow-ups",
      gist: "Follow-ups from the payments-api v2.15 release.",
      from: [{ brand: "github", conn: "GitHub · rogier", count: "<b>5</b> issues" }],
      members: ["Changelog for v2.15", "Tag payments-api 2.15.0 in Sentry", "Bump the SDK in webshop after 2.15", "Remove the v1 webhook route", "Update the release checklist"],
      answers: [acceptAll(5, true), dismissAll(5)],
    },
    {
      id: "s-low22", group: "later", kind: "Proposals", topic: "Mixed", topics: { Checkout: 8, Infrastructure: 6, Customers: 3, Releases: 2 }, count: 22, priority: 1, split: true,
      title: "Accept the 22 low-priority proposals",
      gist: "Small fixes and chores across every topic; triage rated each one low.",
      from: [
        { brand: "sentry", conn: "Sentry · webshop-prod", count: "<b>8</b>" },
        { brand: "grafana", conn: "Grafana · ops", count: "<b>6</b>" },
        { brand: "github", conn: "GitHub · rogier", count: "<b>5</b>" },
        { brand: "intercom", conn: "Intercom · support", count: "<b>3</b>" },
      ],
      members: ["Footer links on checkout", "Button copy on the payment step", "Coupon tooltip typo", "Trust badges alignment", "Card logo order", "Postcode field width", "Order summary spacing", "Remove the old PayPal badge", "Rotate old SSH keys on build-box-2", "Prune Docker images weekly", "Grafana panel titles", "Uptime check for the docs site", "Cron log retention", "Upgrade Node on build-box-2", "Typo in the order email", "FAQ link in the footer", "Return form wording", "Release notes template", "Tag naming for hotfixes", "Clean up old feature flags", "Rename the staging bucket", "Dependabot schedule"],
      answers: [acceptAll(22, true), dismissAll(22)],
    },
  ];

  /* ------------------------------------------------------------------ deck state */

  var cards = swarm ? SWARM : DECK;
  var topic = params.get("topic");
  var answered = {};
  var held = null; // { card, answer, left }
  var timer = null;
  var evidenceOpen = state === "evidence";
  var helpOpen = false;

  // 09:44: Rogier answered five on the desktop; Draft reply to Marta is still held for Undo.
  var at0944 = state === "panel" || state === "lock" || state === "chat";
  if (at0944) {
    ["lead", "android", "breaker", "backup", "marta"].forEach(function (id) { answered[id] = true; });
    held = { card: MARTA, answer: MARTA.answers[0], left: 4 };
  }
  if (state === "clear") cards.forEach(function (c) { answered[c.id] = true; });
  // ?state=held, on the phone: Start "Fix bug" was just swiped, and the client holds it for Undo.
  if (state === "held") {
    answered.lead = true;
    held = { card: LEAD, answer: LEAD.answers[0], left: 4 };
  }

  function decisionsIn(card) {
    return card.count || 1;
  }
  function inTopic(card) {
    if (!topic) return true;
    return card.topic.toLowerCase() === topic || Object.keys(card.topics || {}).some(function (t) { return t.toLowerCase() === topic; });
  }
  function dealt() {
    return cards.filter(inTopic);
  }
  function open() {
    return dealt().filter(function (c) { return !answered[c.id]; });
  }
  function remaining() {
    return open().reduce(function (n, c) { return n + decisionsIn(c); }, 0);
  }
  function findCard(id) {
    for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return cards[i];
    return null;
  }
  var current = findCard(params.get("d")) || open()[0] || null;
  if (current && answered[current.id]) current = open()[0] || null;
  if (at0944) current = WEBHOOK;

  /** Returns the open cards after the current one, wrapping, so J deals the next undecided card. */
  function upNext() {
    var list = open();
    var i = list.indexOf(current);
    return list.slice(i + 1).concat(list.slice(0, Math.max(i, 0)));
  }
  /** Returns about how long the open decisions take to answer: 13 seconds a card, at least 1 minute. */
  function estimate(list) {
    var seconds = list.length * 13 + list.filter(function (c) { return c.count; }).length * 8;
    return "about " + Math.max(1, Math.round(seconds / 60)) + " min";
  }

  /* ------------------------------------------------------------------ rendering */

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }
  function faceTag(name, pose, size) {
    return '<i data-face="' + esc(name) + '" data-pose="' + (pose || "idle") + '" data-size="' + size + '"></i>';
  }
  function iconTag(name, size) {
    return '<i data-i="' + name + '" data-size="' + (size || 16) + '"></i>';
  }
  function brandTag(name, size) {
    return '<i data-brand="' + name + '" data-size="' + (size || 14) + '"></i>';
  }
  function hrefFor(id) {
    var p = new URLSearchParams(location.search);
    p.set("d", id);
    return "?" + p.toString();
  }
  function bars(p) {
    return '<span class="bars" data-p="' + p + '"><i></i><i></i><i></i><i></i></span>';
  }
  var PRIORITY = { 4: "Urgent", 3: "High", 2: "Medium", 1: "Low" };
  var PROJ = { webshop: "proj--webshop", "payments-api": "proj--payments", ops: "proj--ops" };

  /** Builds the strip: how many decisions, how long, one segment per card in deal order, and the last triage. */
  function renderStrip(el) {
    var list = dealt();
    var left = remaining();
    var total = list.reduce(function (n, c) { return n + decisionsIn(c); }, 0);
    var head =
      '<div class="deck-strip-head">' +
      '<span class="deco-num">' + (left || total) + "</span>" +
      '<span class="deck-estimate">' +
      (left ? (left === 1 ? "decision" : "decisions") + (swarm ? " in " + open().length + " cards" : "") + " · " + estimate(open()) : "answered") +
      "</span>" +
      '<span class="spacer"></span>' +
      '<span class="deck-triage">' + faceTag("Triage", "idle", 20) + '<span>Last triage <b>09:00</b> · 42s · next <b>11:00</b></span></span>' +
      '<button class="btn btn--sm">Triage now</button>' +
      "</div>";
    el.innerHTML = head + pipsHtml(list);
  }
  /** Builds the strip's segments: one group per deal group, one segment per card, as wide as its decisions. */
  function pipsHtml(list) {
    var groups = GROUPS.map(function (g) {
      var inGroup = list.filter(function (c) { return c.group === g.key; });
      if (!inGroup.length) return "";
      var weight = inGroup.reduce(function (n, c) { return n + decisionsIn(c); }, 0);
      return (
        '<div class="deck-pip-group" style="flex-grow:' + weight + '">' +
        '<span class="deck-pip-label">' + g.label + "</span>" +
        '<span class="deck-pip-row">' +
        inGroup.map(function (c) {
          var cls = "deck-pip" + (answered[c.id] ? " is-answered" : "") + (c === current ? " is-current" : "") + (c.group === "now" ? " is-burning" : "");
          return '<a class="' + cls + '" href="' + hrefFor(c.id) + '" data-go="' + c.id + '" style="flex-grow:' + decisionsIn(c) + '" title="' + esc(c.title) + (c.count ? " · " + c.count + " decisions" : "") + '"></a>';
        }).join("") +
        "</span></div>"
      );
    }).join("");
    return '<div class="deck-pips">' + groups + "</div>";
  }

  function kindLine(card) {
    return (
      '<div class="deck-kind">' +
      "<b>" + card.kind + (card.count ? " · " + card.count : "") + "</b>" +
      (card.topic === "Mixed" ? "<span>4 topics</span>" : "<span>" + card.topic + "</span>") +
      (card.priority ? '<span class="deck-priority' + (card.priority === 4 ? " is-urgent" : "") + '">' + bars(card.priority) + PRIORITY[card.priority] + "</span>" : "") +
      (card.project ? '<span class="proj ' + PROJ[card.project] + '">' + card.project + "</span>" : "") +
      '<span class="spacer"></span>' +
      (card.seen ? '<span class="deck-seen">' + card.seen + "</span>" : "") +
      "</div>"
    );
  }
  function madeFrom(card) {
    return (
      '<ul class="made-from">' +
      card.from.map(function (f) {
        return '<li class="made-from-entry">' + brandTag(f.brand) + '<span class="made-from-count">' + f.count + '</span><span class="made-from-conn">' + f.conn + "</span></li>";
      }).join("") +
      "</ul>"
    );
  }
  function members(card) {
    if (!card.members) return "";
    // The phone has no room for a column of members, so they always run on as one sentence there.
    if (card.flow || platform === "mobile") {
      var shown = card.members.slice(0, platform === "mobile" ? 3 : 6);
      var more = card.members.length - shown.length;
      return '<p class="batch-flow">' + shown.join(", ") + (more ? ' <span>and ' + more + " more</span>" : "") + "</p>";
    }
    var max = platform === "mobile" ? 4 : platform === "web" ? 11 : 24;
    var list = card.members.slice(0, max);
    var rest = card.members.length - list.length;
    return (
      '<ol class="batch-members' + (card.members.length > 6 ? " batch-members--two" : "") + '">' +
      list.map(function (m) { return "<li>" + m + "</li>"; }).join("") +
      (rest ? '<li class="batch-more">and ' + rest + " more</li>" : "") +
      "</ol>"
    );
  }
  /** Returns the indexes of the answers the number keys reach, in ledger order: every answer but the accent one, which ↩ takes, and those that cannot be taken. */
  function numberedAnswers(card) {
    return card.answers.map(function (a, i) { return i; }).filter(function (i) {
      return !card.answers[i].primary && card.answers[i].kind !== "unavailable";
    });
  }
  function keyFor(card, i) {
    var a = card.answers[i];
    if (a.kind === "unavailable") return "";
    if (a.primary) return "<kbd>↩</kbd>";
    return "<kbd>" + (numberedAnswers(card).indexOf(i) + 1) + "</kbd>";
  }
  function buttonLead(a, size) {
    if (a.face) return faceTag(a.face, "idle", size || 20);
    return "";
  }
  function ledger(card) {
    return (
      '<div class="ledger">' +
      card.answers.map(function (a, i) {
        var cls = "btn" + (a.primary && a.kind !== "unavailable" ? " btn--accent" : "") + (a.quiet ? " btn--quiet" : "");
        var label = buttonLead(a) + a.label + (a.trail ? iconTag(a.trail, 14) : "");
        var button =
          a.kind === "opens"
            ? '<a class="' + cls + '" href="#" data-answer="' + i + '">' + label + "</a>"
            : '<button class="' + cls + '" data-answer="' + i + '"' + (a.kind === "unavailable" ? " disabled" : "") + ">" + label + "</button>";
        return (
          '<div class="ans' + (a.kind === "unavailable" ? " answer-unavailable" : "") + '">' +
          button +
          '<span class="ans-desc describe-line">' + a.describe + (a.fine ? '<small class="answer-fine">' + a.fine + "</small>" : "") + "</span>" +
          keyFor(card, i) +
          "</div>"
        );
      }).join("") +
      "</div>"
    );
  }
  function note(card, mobile) {
    if (!card.note || (mobile && card.note.later)) return "";
    var lead = card.note.face ? faceTag(card.note.face, "idle", 18) : iconTag(card.note.icon, 14);
    return '<p class="deck-note">' + lead + "<span>" + card.note.text + "</span></p>";
  }
  function cardFoot(card) {
    var mobile = platform === "mobile";
    // On the phone, Evidence sits in the swipe line under the card, so only a batch keeps a foot, for Split.
    if (mobile && !card.split) return "";
    return (
      '<div class="deck-card-foot">' +
      (mobile ? "" : '<button class="btn btn--quiet btn--sm" data-evidence>' + iconTag("eye", 14) + "Evidence <kbd>Space</kbd></button>") +
      (card.split ? '<button class="btn btn--quiet btn--sm" data-split>' + iconTag("list", 14) + "Split into " + card.count + (mobile ? "" : " <kbd>S</kbd>") + "</button>" : "") +
      '<span class="spacer"></span>' +
      (platform === "web" ? '<a class="deck-link" href="' + hrefFor(card.id) + '" title="Copy the link to this decision">' + iconTag("link", 13) + "/intake/d/" + card.id + "</a>" : "") +
      "</div>"
    );
  }

  /** Builds the one decision card in focus. On a phone the answers live in the dock, not in the card. */
  function cardHtml(card) {
    var mobile = platform === "mobile";
    return (
      '<article class="card deck-card" data-card="' + card.id + '">' +
      kindLine(card) +
      '<h2 class="deck-title">' + card.title + "</h2>" +
      '<p class="deck-gist">' + (mobile && card.short ? card.short : card.gist) + "</p>" +
      members(card) +
      madeFrom(card) +
      (mobile ? note(card, true) : ledger(card) + note(card)) +
      cardFoot(card) +
      "</article>"
    );
  }
  function peeksHtml() {
    return upNext()
      .slice(0, 2)
      .map(function (c, i) {
        return (
          '<a class="deck-peek" href="' + hrefFor(c.id) + '" data-go="' + c.id + '">' +
          (platform === "mobile" ? "" : '<span class="deck-peek-kind">' + c.kind + "</span>") +
          '<span class="deck-peek-title">' + c.title + "</span>" +
          (i === 0 && platform !== "mobile" ? "<kbd>J</kbd>" : "") +
          "</a>"
        );
      })
      .join("");
  }
  function renderTable(el) {
    if (!current) {
      el.innerHTML = "";
      return;
    }
    // In the hotkey panel the panel is the container, so the card drops its own card chrome.
    var html = cardHtml(current);
    if (el.closest(".deck-panel")) html = html.replace('class="card deck-card"', 'class="deck-card deck-card--bare"');
    el.innerHTML = (platform === "mobile" ? underHtml(current) : "") + html + '<div class="deck-peeks">' + peeksHtml() + "</div>";
  }

  /** Returns the indexes of the answers the two swipes take: right the accent answer, left the quiet one that declines; -1 when the card has none. */
  function swipeAnswers(card) {
    return {
      right: card.answers.findIndex(function (a) { return a.primary && a.kind !== "unavailable"; }),
      left: card.answers.findIndex(function (a) { return a.quiet; }),
    };
  }
  /** Builds what a swipe uncovers under the card: the accent answer on the left edge, the declining one on the right. */
  function underHtml(card) {
    var s = swipeAnswers(card);
    var right = card.answers[s.right];
    var left = card.answers[s.left];
    return (
      '<div class="deck-under" data-dir="' + (state === "swipe" ? "right" : "") + '" aria-hidden="true">' +
      '<span class="deck-under-right">' + (right ? buttonLead(right, 28) + right.label + '<span class="haptic">' + iconTag("wave", 11) + "tick at the threshold</span>" : "") + "</span>" +
      '<span class="deck-under-left">' + (left ? left.label + iconTag("close", 16) : "") + "</span>" +
      "</div>"
    );
  }
  /** Builds the line under the card that names what each swipe does on this card. */
  function renderSwipe(el) {
    if (!current) {
      el.innerHTML = "";
      return;
    }
    var s = swipeAnswers(current);
    el.innerHTML =
      "<span>" + (s.left >= 0 ? "← " + current.answers[s.left].label : "") + "</span>" +
      '<button class="deck-swipe-up" data-evidence>↑ Evidence</button>' +
      "<span>" + (s.right >= 0 ? current.answers[s.right].label + " →" : "") + "</span>";
  }

  /** Builds the phone's answer dock: every answer as a thumb-sized row, the describe line under its label. */
  function renderDock(el) {
    if (!current) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = current.answers.map(function (a, i) {
      var cls = "m-ans" + (a.primary && a.kind !== "unavailable" ? " m-ans--accent" : "") + (a.quiet ? " m-ans--quiet" : "") + (a.kind === "unavailable" ? " answer-unavailable" : "");
      var glyph = a.face
        ? faceTag(a.face, "idle", 26)
        : a.glyph
        ? '<i class="answer-glyph"><i class="answer-swatch ' + PROJ[a.glyph] + '"></i></i>'
        : '<i class="answer-glyph">' + iconTag(a.icon || a.trail || "arrow", 18) + "</i>";
      var describe = a.describe.replace(/<(\/?)b>/g, "<$1strong>");
      var tag = a.kind === "opens" ? "a" : "button";
      return (
        "<" + tag + ' class="' + cls + '" data-answer="' + i + '"' + (tag === "a" ? ' href="#"' : "") + (a.kind === "unavailable" ? " disabled" : "") + ">" +
        glyph +
        "<b>" + a.label + "</b>" +
        '<span class="describe-line">' + describe + (a.fine ? '<small class="answer-fine">' + a.fine + "</small>" : "") + "</span>" +
        "</" + tag + ">"
      );
    }).join("");
  }

  /** Builds the dossier: why triage made the card, one excerpt per source with a link out, and its history. */
  function renderEvidence(el) {
    var card = current || LEAD;
    var ev = card.evidence || {
      excerpts: card.from.map(function (f) {
        return { brand: f.brand, conn: f.conn, head: f.count, body: "" };
      }),
    };
    el.innerHTML =
      '<div class="evidence-head"><span class="section-h">Evidence</span><span class="spacer"></span>' +
      (platform === "mobile" ? "" : "<kbd>Esc</kbd>") +
      '<button class="icon-btn" data-evidence title="Close the evidence">' + iconTag("close") + "</button></div>" +
      '<h3 class="evidence-title">' + card.title + "</h3>" +
      (ev.why ? '<p class="evidence-why">' + faceTag("Triage", "idle", 22) + "<span>" + ev.why + "</span></p>" : "") +
      '<ul class="evidence-list">' +
      ev.excerpts.map(function (x) {
        return (
          '<li class="evidence-item">' +
          '<div class="evidence-source">' + brandTag(x.brand) + "<span>" + x.conn + "</span></div>" +
          '<p class="evidence-excerpt"><b>' + x.head + "</b>" + (x.body ? "<span>" + x.body + "</span>" : "") + "</p>" +
          '<a class="evidence-open" href="#" target="_blank" rel="noreferrer">Open in ' + (SYSTEM[x.brand] === "Cron" ? "Hercule" : SYSTEM[x.brand]) + iconTag("external", 12) + "</a>" +
          "</li>"
        );
      }).join("") +
      "</ul>" +
      (ev.history
        ? '<p class="evidence-history">' + ev.history + "</p>"
        : "");
  }

  // What earlier answers set moving (CONTENT.md's sessions), plus the answer held for Undo.
  var MOVING = [
    { name: "Cart total rounding on discounts", pose: "working", meta: "Fix bug · webshop · 14m" },
    { name: "Draft reply to Jonas at Kiteworks", pose: "working", meta: "Draft reply · payments-api · 1m" },
    { name: "Ship release v2.15", pose: "waiting", ask: "Publish 2.15.0 to npm?", href: "#" },
    { name: "Label new issues", pose: "paused", meta: "Paused · bound tripped · 34 held", go: "breaker" },
  ];
  function heldHtml() {
    if (!held) return "";
    return (
      '<div class="held-row">' +
      (held.answer.face ? faceTag(held.answer.face, "idle", 24) : '<span class="held-glyph">' + iconTag(held.answer.icon || "check", 14) + "</span>") +
      '<span class="moving-text"><b>' + (held.answer.sends || held.answer.label) + '</b><span class="held-when">Sends in <span class="held-seconds">' + held.left + " s</span></span></span>" +
      (platform === "mobile" ? '<button class="btn btn--lg" data-undo>' + iconTag("undo", 16) + "Undo" : '<button class="btn btn--sm" data-undo>' + iconTag("undo", 14) + "Undo <kbd>U</kbd>") + "</button>" +
      "</div>"
    );
  }
  function renderHeld(el) {
    el.innerHTML = heldHtml();
  }
  // After the deck is clear: what this morning's answers set moving, newest first.
  var STARTED = [
    { name: "Fix 3-D Secure checkout", pose: "working", meta: "Fix bug · webshop · 3m" },
    { name: "Investigate backup timeouts", pose: "working", meta: "Investigate · ops · 2m" },
    { name: "Draft reply to Marta at Brightline", pose: "working", meta: "Draft reply · 2m" },
    { name: "Label new issues", pose: "working", meta: "Resumed · 34 held, 20 per hour" },
    { name: "Webhook retry backoff", pose: "working", meta: "Investigate · payments-api · 1m" },
    { name: "Renew status page SSL", pose: "working", meta: "Fix bug · ops · 1m" },
  ];
  // The web rail is shorter than the desktop one, so it lists fewer started runs and links the rest.
  var STARTED_SHOWN = platform === "web" ? 4 : STARTED.length;
  /** Returns how many runs the Moving list stands for, shown beside its heading. */
  function movingCount() {
    if (swarm) return 64;
    if (root.dataset.state === "clear") return STARTED.length + 3;
    return MOVING.length;
  }
  function renderMoving(el) {
    var clear = root.dataset.state === "clear";
    var rows = heldHtml();
    rows += (clear ? STARTED.slice(0, STARTED_SHOWN) : MOVING).map(function (m) {
      var tail = m.ask
        ? '<a class="moving-ask" href="' + m.href + '">' + '<i data-mark="waiting" data-size="12"></i>' + m.ask + "</a>"
        : m.go
        ? '<a class="moving-meta moving-meta--link" href="' + hrefFor(m.go) + '" data-go="' + m.go + '"><i data-mark="paused" data-size="12"></i>' + m.meta + "</a>"
        : '<span class="moving-meta">' + m.meta + "</span>";
      return (
        '<div class="moving-row">' + faceTag(m.name, m.pose, 24) +
        '<span class="moving-text"><b>' + m.name + "</b>" + tail + "</span>" +
        "</div>"
      );
    }).join("");
    if (swarm) rows += '<a class="moving-more" href="#">60 more in Runs' + iconTag("arrow", 13) + "</a>";
    if (clear) rows += '<a class="moving-more" href="#">' + (movingCount() - STARTED_SHOWN) + " more in Runs" + iconTag("arrow", 13) + "</a>";
    el.innerHTML = rows;
  }

  // The quiet shelf: everything since the marker that asks nothing of Rogier, folded.
  var QUIET = swarm
    ? { fyi: 30, attached: 12, none: "1,955", ci: "1,412", bots: 380, letters: 162 }
    : { fyi: 3, attached: 1, none: 166, ci: 118, bots: 31, letters: 16 };
  function openAll(n) {
    return '<a class="moving-more" href="#">Open all ' + n + iconTag("arrow", 13) + "</a>";
  }
  // The last triage's one-paragraph summary, in the triage's own voice.
  var TRIAGE_SUMMARY = swarm
    ? "One is urgent: EU card payments that need 3-D Secure fail since deploy #1289. I batched alike proposals so the 90 decisions fit on 13 cards, and held 34 GitHub events when Label new issues tripped its bound."
    : "One is urgent: EU card payments that need 3-D Secure fail since deploy #1289; Sentry, three customer emails and PostHog all point at it. Label new issues tripped its bound at 08:14 on a bot's 34 issues, so I held them. Most of the rest needs nothing: passing CI runs, bot comments and newsletters.";
  function renderShelf(el) {
    // ?state=shelf opens the fold that holds the event from a system with no brand mark.
    var opened = "";
    var shelfOpen = state === "shelf" ? " open" : "";
    // On the phone's triage sheet the summary is the reason the sheet was opened.
    var summaryOpen = state === "triage" ? " open" : "";
    el.innerHTML =
      '<details class="shelf-fold"' + summaryOpen + ">" +
      "<summary>" + faceTag("Triage", "idle", 20) + '<span class="shelf-label">What triage saw at 09:00</span></summary>' +
      '<div class="shelf-body"><p class="shelf-summary">' + TRIAGE_SUMMARY + "</p></div></details>" +
      '<details class="shelf-fold"' + opened + ">" +
      '<summary><span class="shelf-label"><b class="shelf-num">' + QUIET.fyi + '</b> FYI</span><span class="shelf-marks">' + brandTag("github", 13) + brandTag("posthog", 13) + brandTag("stripe", 13) + "</span></summary>" +
      '<div class="shelf-body">' +
      '<p class="shelf-line">' + brandTag("github", 12) + "<span>payments-api <b>v2.14.0</b> was published</span></p>" +
      '<p class="shelf-line">' + brandTag("posthog", 12) + "<span>Sign-ups up <b>+9%</b> week over week</span></p>" +
      '<p class="shelf-line">' + brandTag("stripe", 12) + "<span>Payout of <b>€18,240</b> arrives Thursday</span></p>" +
      (swarm ? openAll(QUIET.fyi) : "") +
      "</div></details>" +
      '<details class="shelf-fold"' + opened + ">" +
      '<summary><span class="shelf-label"><b class="shelf-num">' + QUIET.attached + '</b> attached to Tasks</span><span class="shelf-marks">' + brandTag("sentry", 13) + "</span></summary>" +
      '<div class="shelf-body"><p class="shelf-line">' + brandTag("sentry", 12) + "<span><b>1</b> event added to Cart total rounding on discounts</span></p>" + (swarm ? openAll(QUIET.attached) : "") + "</div></details>" +
      '<details class="shelf-fold"' + shelfOpen + ">" +
      '<summary><span class="shelf-label"><b class="shelf-num">' + QUIET.none + '</b> no action</span><span class="shelf-marks">' + brandTag("github", 13) + brandTag("gmail", 13) + '<span class="src-x" role="img" aria-label="hetzner">h</span></span></summary>' +
      '<div class="shelf-body">' +
      '<p class="shelf-line"><span class="src-x" role="img" aria-label="hetzner">h</span><span>Hetzner&nbsp;· invoice for September&nbsp;· via Gmail&nbsp;· rogier@personal</span></p>' +
      '<p class="shelf-line">' + brandTag("github", 12) + "<span><b>" + QUIET.ci + "</b> CI runs that passed</span></p>" +
      '<p class="shelf-line">' + brandTag("github", 12) + "<span><b>" + QUIET.bots + "</b> bot comments on pull requests</span></p>" +
      '<p class="shelf-line">' + brandTag("gmail", 12) + "<span><b>" + QUIET.letters + "</b> newsletters</span></p>" +
      openAll(QUIET.none) +
      "</div></details>" +
      '<div class="shelf-connection">' + brandTag("linear", 14) +
      "<p class=\"shelf-new\"><b>Linear · product</b> is new<span>Listening since Mon 17:55, nothing&nbsp;yet&nbsp;· files to Releases</span></p></div>";
  }

  function renderTabs(el) {
    var counts = { all: 0 };
    open().forEach(function (c) {
      counts.all += decisionsIn(c);
      if (c.topics) Object.keys(c.topics).forEach(function (t) { counts[t.toLowerCase()] = (counts[t.toLowerCase()] || 0) + c.topics[t]; });
      else counts[c.topic.toLowerCase()] = (counts[c.topic.toLowerCase()] || 0) + decisionsIn(c);
    });
    el.querySelectorAll("[data-topic]").forEach(function (tab) {
      var key = tab.dataset.topic;
      var p = new URLSearchParams(location.search);
      p.delete("d");
      if (key === "all") p.delete("topic");
      else p.set("topic", key);
      tab.href = "?" + p.toString();
      tab.classList.toggle("is-on", (topic || "all") === key);
      var small = tab.querySelector("small");
      if (small) small.textContent = counts[key] || "";
    });
  }

  /** Builds the Live Activity on the lock screen: the count, the strip, and the card in focus with its two swipe answers as buttons. */
  function renderActivity(el) {
    if (!current) {
      el.innerHTML = "";
      return;
    }
    var s = swipeAnswers(current);
    var left = remaining();
    el.innerHTML =
      '<div class="deck-la-head">' + '<i data-logo="20"></i><b>Intake</b>' +
      "<span>" + left + " decisions · " + estimate(open()) + "</span></div>" +
      pipsHtml(dealt()) +
      '<p class="deck-la-kind">' + current.kind + " · " + current.topic + (current.project ? " · " + current.project : "") + "</p>" +
      '<p class="deck-la-title">' + current.title + "</p>" +
      '<div class="deck-la-go">' +
      (s.left >= 0 ? '<button class="is-quiet" data-answer="' + s.left + '">' + current.answers[s.left].label + "</button>" : "") +
      (s.right >= 0 ? '<button class="is-accent" data-answer="' + s.right + '">' + current.answers[s.right].label + "</button>" : "") +
      "</div>";
  }

  /**
   * Builds one decision as one chat message, as spec 12 section 11.6 pins it: the title, the body,
   * one line per answer (label · describe line, fine print under it), one button per answer
   * carrying the label only, and a link back. A decided message keeps only its outcome line.
   */
  function chatMessage(card, time, outcome) {
    var head =
      '<div class="deck-chat-by"><b>Hercule</b><span class="deck-chat-app">App</span><time>' + time + "</time>" + (outcome ? '<span class="deck-chat-edited">(edited)</span>' : "") + "</div>" +
      '<p class="deck-chat-kind">' + card.kind + " · " + card.topic + (card.priority ? " · " + PRIORITY[card.priority] : "") + (card.project ? " · " + card.project : "") + "</p>" +
      '<p class="deck-chat-title">' + card.title + "</p>";
    var body = outcome
      ? '<p class="deck-chat-outcome">' + iconTag("check", 14) + "<span>" + outcome + "</span></p>"
      : '<p class="deck-chat-gist">' + card.gist + "</p>" +
        '<p class="deck-chat-from">' + card.from.map(function (f) { return f.count + " <span>from " + f.conn + "</span>"; }).join(" · ") + "</p>" +
        '<ul class="deck-chat-answers">' +
        card.answers.map(function (a) {
          return '<li><b>' + a.label + "</b> · " + a.describe + (a.fine ? "<small>" + a.fine + "</small>" : "") + "</li>";
        }).join("") +
        "</ul>" +
        '<div class="deck-chat-buttons">' +
        card.answers.map(function (a, i) {
          return '<button class="deck-chat-btn' + (a.primary ? " is-primary" : "") + '" data-answer="' + i + '">' + a.label + "</button>";
        }).join("") +
        "</div>" +
        '<a class="deck-chat-link" href="#">' + iconTag("link", 12) + "Open in Hercule</a>";
    return '<article class="deck-chat-msg"><span class="deck-chat-av"><i data-logo="36"></i></span><div class="deck-chat-body">' + head + body + "</div></article>";
  }
  function renderChat(el) {
    el.innerHTML =
      '<div class="deck-chat-day">Today</div>' +
      chatMessage(BACKUP, "09:00", '<b>Start "Investigate"</b> - decided on the desktop') +
      chatMessage(WEBHOOK, "09:00");
  }

  function draw(selector, fn) {
    document.querySelectorAll(selector).forEach(function (el) {
      fn(el);
      if (window.Crew) Crew.drawPlaceholders(el);
    });
  }
  function render() {
    root.classList.toggle("is-evidence", evidenceOpen);
    root.classList.toggle("is-help", helpOpen);
    draw("[data-deck-strip]", renderStrip);
    draw("[data-deck-table]", renderTable);
    draw("[data-deck-dock]", renderDock);
    draw("[data-deck-evidence]", renderEvidence);
    draw("[data-deck-moving]", renderMoving);
    draw("[data-deck-held]", renderHeld);
    draw("[data-deck-shelf]", renderShelf);
    draw("[data-deck-tabs]", renderTabs);
    draw("[data-deck-swipe]", renderSwipe);
    draw("[data-deck-activity]", renderActivity);
    draw("[data-deck-chat]", renderChat);
    syncShell();
  }

  /** Writes the open decision count into the shell crew.js drew: sidebar, web tab and title, phone tab bar. */
  function syncShell() {
    var left = remaining();
    var total = cards.reduce(function (n, c) { return n + (answered[c.id] ? 0 : decisionsIn(c)); }, 0);
    document.querySelectorAll(".nav-row.is-on .count, .wtab.is-on .count, .tb.is-on .tb-badge").forEach(function (b) {
      b.textContent = total;
      b.style.display = total ? "" : "none";
    });
    if (platform === "web") document.title = (total ? "(" + total + ") " : "") + "Intake · Hercule";
    document.querySelectorAll("[data-deck-left]").forEach(function (n) { n.textContent = left; });
    document.querySelectorAll("[data-deck-moving-count]").forEach(function (n) { n.textContent = movingCount(); });
    if (at0944) document.querySelectorAll(".status-time").forEach(function (t) { t.textContent = "9:44"; });
    // crew.js draws Runs once. The clear deck has started 5 more runs, and Undo can leave the clear
    // state again, so the Runs count is written on every render.
    var runs = root.dataset.state === "clear" ? 11 : swarm ? 64 : 6;
    document.querySelectorAll(".nav-row .count, .wtab .count").forEach(function (b) {
      if (b.parentElement.textContent.trim().indexOf("Runs") === 0) b.textContent = runs;
    });
  }

  /* ------------------------------------------------------------------ answering */

  function go(id) {
    var card = findCard(id);
    if (!card) return;
    current = card;
    if (platform === "web") history.replaceState(null, "", hrefFor(id));
    render();
  }
  function step(dir) {
    var list = dealt();
    var i = list.indexOf(current);
    for (var k = 1; k <= list.length; k++) {
      var c = list[(i + dir * k + list.length * k) % list.length];
      if (!answered[c.id]) return go(c.id);
    }
  }
  function commitHeld() {
    clearInterval(timer);
    timer = null;
    held = null;
  }
  /** Answers the current card: the client holds the answer for 5 seconds so U can take it back. */
  function answer(i) {
    if (!current) return;
    var a = current.answers[i];
    if (!a || a.kind === "unavailable" || a.kind === "opens") return;
    if (held) commitHeld();
    held = { card: current, answer: a, left: 5 };
    answered[current.id] = true;
    current = upNext()[0] || null;
    if (!current) root.dataset.state = "clear";
    timer = setInterval(function () {
      held.left -= 1;
      if (held.left <= 0) {
        commitHeld();
        render();
      } else {
        document.querySelectorAll(".held-seconds").forEach(function (s) { s.textContent = held.left + " s"; });
      }
    }, 1000);
    render();
  }
  function undo() {
    if (!held) return;
    answered[held.card.id] = false;
    current = held.card;
    commitHeld();
    if (root.dataset.state === "clear") root.dataset.state = swarm ? "swarm" : "default";
    render();
  }
  /** Replaces a batch card with one card per member, each with the batch's answers for one Task. */
  function split() {
    if (!current || !current.split) return;
    var batch = current;
    var singles = batch.members.map(function (m, k) {
      return {
        id: batch.id + "-" + (k + 1), group: batch.group, kind: batch.kind.replace(/s$/, ""), topic: batch.topic === "Mixed" ? "Mixed" : batch.topic, topics: batch.topics, priority: batch.priority, project: batch.project,
        title: m, gist: batch.gist, from: batch.from.slice(0, 1),
        answers: batch.answers.map(function (a) {
          return { label: a.label.replace(/ all \d+$/, "").replace(/^Start$/, 'Start "' + a.face + '"').replace(/^Draft$/, "Draft reply").replace(/^Reply to$/, "Reply"), face: a.face, icon: a.icon, primary: a.primary, quiet: a.quiet, kind: a.kind, trail: a.trail, describe: a.describe.replace(/the <b>\d+<\/b> (Tasks|emails) above/, "Task <b>" + m + "</b>"), fine: a.fine, sends: a.label };
        }),
      };
    });
    var i = cards.indexOf(batch);
    cards = cards.slice(0, i).concat(singles, cards.slice(i + 1));
    current = singles[0];
    render();
  }

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (k === "Escape") {
      evidenceOpen = false;
      helpOpen = false;
    } else if (k === "Enter") {
      var p = current ? current.answers.findIndex(function (a) { return a.primary; }) : -1;
      if (p >= 0) answer(p);
    } else if (/^[1-9]$/.test(k)) {
      var n = current ? numberedAnswers(current)[Number(k) - 1] : undefined;
      if (n !== undefined) answer(n);
    }
    else if (k === "j" || k === "ArrowDown") step(1);
    else if (k === "k" || k === "ArrowUp") step(-1);
    else if (k === " ") evidenceOpen = !evidenceOpen;
    else if (k === "u") undo();
    else if (k === "s") split();
    else if (k === "?") helpOpen = !helpOpen;
    else return;
    e.preventDefault();
    render();
  });
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-go], [data-answer], [data-evidence], [data-undo], [data-split]");
    if (!t) return;
    e.preventDefault();
    if (t.dataset.go) go(t.dataset.go);
    else if (t.hasAttribute("data-answer")) answer(Number(t.dataset.answer));
    else if (t.hasAttribute("data-evidence")) {
      evidenceOpen = !evidenceOpen;
      render();
    } else if (t.hasAttribute("data-undo")) undo();
    else if (t.hasAttribute("data-split")) split();
  });

  // Phone: drag the card. Right answers the primary, left dismisses, up opens the evidence.
  if (platform === "mobile") {
    var drag = null;
    document.addEventListener("pointerdown", function (e) {
      var card = e.target.closest(".deck-card");
      if (!card || e.target.closest("button, a")) return;
      drag = { card: card, under: card.parentElement.querySelector(".deck-under"), x: e.clientX, y: e.clientY };
      card.setPointerCapture(e.pointerId);
    });
    document.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var dy = Math.min(0, e.clientY - drag.y);
      drag.card.style.transform = "translate(" + dx + "px," + dy + "px) rotate(" + dx / 24 + "deg)";
      if (drag.under) drag.under.dataset.dir = dx > 0 ? "right" : "left";
    });
    document.addEventListener("pointerup", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      drag.card.style.transform = "";
      drag = null;
      var s = swipeAnswers(current);
      if (dx > 96 && s.right >= 0) answer(s.right);
      else if (dx < -96 && s.left >= 0) answer(s.left);
      else if (dy < -80) {
        evidenceOpen = true;
        render();
      } else render();
    });
  }

  render();
  // crew.js draws the shell on DOMContentLoaded, after this script; sync its counts once it has.
  document.addEventListener("DOMContentLoaded", syncShell);
  window.Deck = { cards: function () { return cards; }, answer: answer, undo: undo };
})();
