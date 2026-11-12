// PROTOTYPE - the invented Northwind Market world: what the controller's Inbox read would return.
// Every person, company and repository here is invented. Times are minutes before "now".
window.World = (function () {
  "use strict";

  var H = 60, D = 24 * 60;

  // Two Sentry organisations hold things, so Sentry browses by account. Both have a team called Checkout.
  var ACCOUNTS = {
    github: ["northwind"],
    linear: ["Northwind"],
    sentry: ["northwind", "northwind-labs"],
    gmail: ["you@northwind.market"],
    slack: ["northwind"],
    quayside: ["Northwind depots"],
  };

  // Every Linear project the source knows, with its health: a facet lists them even with nothing of yours.
  var PROJECTS = [
    { name: "Checkout revamp", health: "at-risk" },
    { name: "Payment retries", health: "on-track" },
    { name: "Winter sale", health: "off-track" },
    { name: "Search relevance", health: "on-track" },
    { name: "Mobile 3.0", health: "on-track" },
    { name: "Loyalty points", health: "on-track" },
    { name: "Warehouse sync", health: "at-risk" },
    { name: "Gift cards", health: "on-track" },
  ];

  // The workflows that can take things, with what each answers. Faces are drawn from the name.
  var WORKFLOWS = {
    review: { name: "Review PR", line: "Reviews the change and leaves its notes as a draft review", takes: ["github/pull-request"], ends: ["review"] },
    fixcheck: { name: "Fix a failing check", line: "Reproduces the failure and pushes a fix to the branch", takes: ["github/pull-request"], ends: ["checks"], when: "failing" },
    triage: { name: "Triage errors", line: "Finds the cause and the change that brought it", takes: ["sentry/issue"], ends: ["regressed"] },
    reply: { name: "Draft a reply", line: "Drafts an answer for you to send", takes: ["gmail/thread"], ends: [] },
  };

  function msg(author, at, text, you) { return { author: author, at: at, text: text, you: !!you }; }

  /** Builds the normal day: a few dozen things, one linked group of four, one long chain, and triage. */
  function buildNormal() {
    var things = [];
    function add(t) {
      t.fields = t.fields || {};
      t.signals = t.signals || [];
      t.history = t.history || [];
      t.blocks = t.blocks || [];
      t.account = t.account || ACCOUNTS[Kinds.KINDS[t.kind].source][0];
      things.push(t);
      return t;
    }

    // ---- The hero group: delivery cost before payment ----
    add({
      id: "shop-142", kind: "linear/issue", key: "SHOP-142", title: "Show the delivery cost before the payment step",
      status: "started", mine: 1, opened: 9 * D, updated: 2 * H,
      fields: { team: "Storefront", project: "Checkout revamp", status: "In Progress", priority: "High", assignee: "you" },
      signals: [{ id: "s1", kind: "assigned", by: "Noa", at: 9 * D, quiet: 1 }],
      blocks: [
        { type: "fields", rows: [["Status", "In Progress"], ["Priority", "High"], ["Project", "Checkout revamp"], ["Cycle", "Cycle 47 · ends Friday"], ["Estimate", "3 points"]] },
        { type: "text", title: "Description", text: "Shoppers only see the delivery cost once they reach the payment step, and 14% of them leave there. Show it on the basket and on the delivery step, with the same rounding Finance uses on the invoice." },
      ],
      history: [[9 * D, "Noa created it and assigned it to you"], [6 * D, "Moved to In Progress"], [3 * D, "Mei linked #6244"], [2 * H, "Omar commented"]],
    });
    add({
      id: "pr-6244", kind: "github/pull-request", number: 6244, title: "Show the delivery cost on the payment step",
      status: "failing", opened: 3 * D, updated: 2 * H,
      fields: { repo: "storefront-web", author: "Mei", checks: "Failing", review: "Requested" },
      signals: [
        { id: "s2", kind: "review", by: "Mei", at: 26 * H },
        { id: "s3", kind: "mention", by: "Omar", at: 2 * H, blocks: [{ type: "messages", items: [msg("Omar Haddad", 2 * H, "@you the delivery cost now rounds before VAT on the payment step. Is that what Finance asked for? See `delivery-cost.ts` line 88.", 1)] }] },
      ],
      blocks: [
        { type: "change", head: "mei/delivery-cost-step", base: "main", files: 6, add: 142, del: 38, checks: "1 failing, 11 passed" },
        { type: "checks", rows: [{ name: "e2e / checkout-eu", state: "failed", log: ["✕ shows the delivery cost before payment (4.2s)", "  Expected: \"€4.95\"", "  Received: \"€4.90\""] }], passed: 11 },
        { type: "text", title: "Description", text: "Adds the delivery cost to the payment step's summary, rounded the way the invoice rounds it. Closes SHOP-142." },
      ],
      history: [[3 * D, "Mei opened it"], [26 * H, "Mei asked for your review"], [20 * H, "e2e / checkout-eu failed"], [2 * H, "Omar mentioned you"]],
    });
    add({
      id: "sn-1z9", kind: "sentry/issue", key: "STOREFRONT-1Z9", title: "TypeError: Cannot read properties of undefined (reading 'deliveryCost')",
      status: "escalating", mine: 1, opened: 6 * D, updated: 4,
      fields: { team: "Checkout", project: "storefront-web", level: "error", events: 1204, users: 312 },
      signals: [{ id: "s4", kind: "assigned", by: "Sentry", system: 1, at: 6 * D, quiet: 1 }],
      blocks: [
        { type: "trend", caption: "Events, last 14 days", values: [2, 3, 2, 4, 3, 5, 9, 14, 22, 31, 48, 70, 96, 128] },
        { type: "fields", rows: [["Level", "error"], ["First seen", "6 days ago, in 2026.11.06-1"], ["Last seen", "4 minutes ago"], ["Users", "312"], ["Browser", "Safari 19 · 61%"]] },
        { type: "code", title: "Stack trace", lines: ["at computeSummary (checkout/summary.ts:41:23)", "at PaymentStep.render (checkout/payment-step.tsx:88:12)", "at renderWithHooks (react-dom.production.js:1:2210)"] },
      ],
      history: [[6 * D, "First seen in 2026.11.06-1"], [6 * D, "Assigned to you by an ownership rule"], [2 * D, "You linked it to #6244"], [4, "312 users so far"]],
    });
    add({
      id: "sl-2201", kind: "slack/thread", title: "Is the delivery cost change going out on Thursday?",
      opened: 5 * H, updated: 50,
      fields: { channel: "#checkout", from: "Juno" },
      signals: [{ id: "s5", kind: "mention", by: "Juno", at: 50, blocks: [{ type: "messages", items: [msg("Juno Okafor", 5 * H, "Marketing wants to announce the new checkout on Thursday. Is the delivery cost change in by then?"), msg("Noa Levi", 3 * H, "Depends on #6244, I think."), msg("Juno Okafor", 50, "@you can you confirm before the 4pm stand-up?", 1)] }] }],
      history: [[5 * H, "Juno started the thread in #checkout"], [50, "Juno mentioned you"]],
    });

    // ---- Waits on me, alone ----
    add({
      id: "pr-6213", kind: "github/pull-request", number: 6213, title: "Move the order schema to the shared package",
      status: "open", opened: 4 * D, updated: 30 * H,
      fields: { repo: "storefront-web", author: "Tessa", checks: "Passing", review: "Requested" },
      signals: [{ id: "s6", kind: "review", by: "Tessa", at: 30 * H }],
      blocks: [
        { type: "change", head: "tessa/shared-order-schema", base: "main", files: 23, add: 412, del: 389, checks: "14 passed" },
        { type: "text", title: "Description", text: "Moves `OrderSchema` and its codecs to `@northwind/shared` so the mobile app can import them. No behaviour change." },
      ],
      history: [[4 * D, "Tessa opened it"], [30 * H, "Tessa asked for your review"]],
    });
    add({
      id: "gm-quote", kind: "gmail/thread", title: "Quote for 400 insulated delivery crates",
      opened: 3 * D, updated: 2 * D,
      fields: { from: "Harbourline Packaging", label: "Suppliers" },
      signals: [{ id: "s7", kind: "asked", by: "Harbourline Packaging", at: 2 * D, blocks: [{ type: "messages", items: [msg("Elif Sahin, Harbourline", 3 * D, "Please find our quote attached: 400 insulated crates at €11.20 each, delivered to Rotterdam in week 49."), msg("Elif Sahin, Harbourline", 2 * D, "Could you confirm by Friday? After that we cannot hold the week 49 slot.", 1)] }] }],
      history: [[3 * D, "Elif sent the quote"], [2 * D, "Elif asked you to confirm by Friday"]],
    });
    add({
      id: "pr-1302", kind: "github/pull-request", number: 1302, title: "Round loyalty points down at checkout",
      status: "failing", mine: 1, opened: 2 * D, updated: 8 * H,
      fields: { repo: "payments-api", author: "you", checks: "Failing", review: "None" },
      signals: [{ id: "s8", kind: "checks", by: "GitHub Actions", system: 1, at: 8 * H }],
      blocks: [
        { type: "change", head: "you/loyalty-rounding", base: "main", files: 3, add: 41, del: 12, checks: "2 failing, 9 passed" },
        { type: "checks", rows: [{ name: "unit / points", state: "failed", log: ["✕ rounds 10.5 points down to 10", "  Expected: 10", "  Received: 11"] }, { name: "lint", state: "failed" }], passed: 9 },
      ],
      history: [[2 * D, "You opened it"], [8 * H, "unit / points and lint failed"]],
    });
    add({
      id: "chk-31", kind: "linear/issue", key: "CHK-31", title: "Audit the wording of the checkout errors",
      status: "todo", opened: 12 * D, updated: 3 * H,
      fields: { team: "Checkout", project: "Checkout revamp", status: "Todo", priority: "Medium", assignee: "Sanne" },
      signals: [{ id: "s9", kind: "mention", by: "Sanne", at: 3 * H, blocks: [{ type: "messages", items: [msg("Sanne de Vries", 3 * H, "@you could you check the Dutch copy for the card errors? I am not sure \"Kaart geweigerd\" is friendly enough.", 1)] }] }],
      blocks: [{ type: "fields", rows: [["Status", "Todo"], ["Priority", "Medium"], ["Project", "Checkout revamp"], ["Assignee", "Sanne de Vries"]] }],
      history: [[12 * D, "Sanne created it"], [3 * H, "Sanne mentioned you"]],
    });
    add({
      id: "sn-21c", kind: "sentry/issue", key: "STOREFRONT-21C", title: "ChunkLoadError: Loading chunk 812 failed",
      status: "regressed", mine: 1, opened: 34 * D, updated: 35,
      fields: { team: "Checkout", project: "storefront-web", level: "error", events: 312, users: 97 },
      signals: [{ id: "s10", kind: "regressed", by: "Sentry", system: 1, at: 35 }],
      blocks: [
        { type: "trend", caption: "Events, last 14 days", values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 61, 247] },
        { type: "fields", rows: [["Level", "error"], ["Resolved", "8 days ago, in 2026.11.04-2"], ["Came back", "35 minutes ago, in 2026.11.12-1"], ["Users", "97"]] },
      ],
      history: [[34 * D, "First seen"], [8 * D, "Ana resolved it"], [35, "It came back in 2026.11.12-1"]],
    });
    add({
      id: "gm-invoice", kind: "gmail/thread", title: "Invoice NM-2291 is overdue: approve or dispute?",
      opened: 6 * D, updated: 5 * D,
      fields: { from: "Ruth Abebe", label: "Finance" },
      signals: [{ id: "s11", kind: "asked", by: "Ruth", at: 5 * D, blocks: [{ type: "messages", items: [msg("Ruth Abebe", 5 * D, "The courier invoice NM-2291 (€2,840) is two weeks overdue. Can you approve it, or tell me what to dispute?", 1)] }] }],
      history: [[5 * D, "Ruth asked you"]],
    });
    add({
      id: "pr-6230", kind: "github/pull-request", number: 6230, title: "Drop the unused wishlist endpoints",
      status: "open", opened: 5 * D, updated: 2 * D,
      fields: { repo: "platform-core", author: "Theo", checks: "Passing", review: "Requested" },
      signals: [{ id: "s12", kind: "review", by: "Theo", at: 2 * D }],
      blocks: [{ type: "change", head: "theo/drop-wishlist", base: "main", files: 9, add: 12, del: 640, checks: "8 passed" }],
      history: [[5 * D, "Theo opened it"], [2 * D, "Theo asked for your review"]],
    });
    add({
      id: "sl-2240", kind: "slack/thread", title: "Who owns the payment webhook alert?",
      opened: 70, updated: 40,
      fields: { channel: "#incidents", from: "Lars" },
      signals: [{ id: "s13", kind: "mention", by: "Lars", at: 40, blocks: [{ type: "messages", items: [msg("Lars Eriksen", 70, "The payment webhook alert fired twice tonight and nobody picked it up."), msg("Lars Eriksen", 40, "@you is that still yours, or did it move to Payments?", 1)] }] }],
      history: [[40, "Lars mentioned you in #incidents"]],
    });
    add({
      id: "po-2291", kind: "quayside/order", key: "PO-2291", title: "Chilled crates for the Rotterdam depot",
      status: "signoff", opened: 4 * D, updated: 3 * D,
      fields: { round: "Week 47 round", site: "Rotterdam depot", amount: "€4,120" },
      signals: [{ id: "s14", kind: "signoff", by: "Quayside", system: 1, at: 3 * D }],
      blocks: [{ type: "fields", rows: [["Amount", "€4,120"], ["Supplier", "Harbourline Packaging"], ["Due", "21 November"], ["Round", "Week 47 round"]] }],
      history: [[4 * D, "Raised by Kwame"], [3 * D, "Waits for your sign-off"]],
    });
    add({
      id: "mob-77", kind: "linear/issue", key: "MOB-77", title: "Crash on the order tracking screen after a refund",
      status: "started", opened: 8 * D, updated: 6 * H,
      fields: { team: "Mobile", project: "Mobile 3.0", status: "In Progress", priority: "Urgent", assignee: "Kwame" },
      signals: [{ id: "s15", kind: "mention", by: "Kwame", at: 6 * H, blocks: [{ type: "messages", items: [msg("Kwame Mensah", 6 * H, "@you does the refund webhook still send `amount_refunded` as a string? The app expects a number.", 1)] }] }],
      blocks: [{ type: "fields", rows: [["Status", "In Progress"], ["Priority", "Urgent"], ["Project", "Mobile 3.0"], ["Assignee", "Kwame Mensah"]] }],
      history: [[6 * H, "Kwame mentioned you"]],
    });
    add({
      id: "gm-hiring", kind: "gmail/thread", title: "Interview loop for the senior checkout engineer",
      opened: 2 * D, updated: 22 * H,
      fields: { from: "Priya Raman", label: "Hiring" },
      signals: [{ id: "s16", kind: "asked", by: "Priya", at: 22 * H, blocks: [{ type: "messages", items: [msg("Priya Raman", 22 * H, "Could you take the system design interview on Tuesday or Wednesday afternoon? Reply with the slot that suits you.", 1)] }] }],
      history: [[22 * H, "Priya asked you"]],
    });
    add({
      id: "pr-6260", kind: "github/pull-request", number: 6260, title: "Lazy-load the product carousel below the fold",
      status: "draft", opened: 26 * H, updated: 6 * H,
      fields: { repo: "storefront-web", author: "Felix", checks: "Passing", review: "None" },
      signals: [{ id: "s17", kind: "mention", by: "Felix", at: 6 * H, blocks: [{ type: "messages", items: [msg("Felix Brandt", 6 * H, "@you thoughts on the 600px threshold? It saves 180 KB on the home page but the carousel pops in on fast scrolls.", 1)] }] }],
      blocks: [{ type: "change", head: "felix/lazy-carousel", base: "main", files: 4, add: 88, del: 20, checks: "6 passed" }],
      history: [[26 * H, "Felix opened it as a draft"], [6 * H, "Felix mentioned you"]],
    });
    add({
      id: "sl-2255", kind: "slack/thread", title: "Promo banner copy before 3pm?",
      opened: 2 * H, updated: 2 * H,
      fields: { channel: "#storefront", from: "Wren" },
      signals: [{ id: "s18", kind: "mention", by: "Wren", at: 2 * H, blocks: [{ type: "messages", items: [msg("Wren Calloway", 2 * H, "@you can you look at the winter promo banner copy before 3pm? Legal wants \"up to 30%\" not \"30% off\".", 1)] }] }],
      history: [[2 * H, "Wren mentioned you in #storefront"]],
    });

    // ---- The long chain: payment retries, one group of fourteen ----
    var chain = [
      { id: "pay-88", kind: "linear/issue", key: "PAY-88", title: "Retry a failed card payment once on a gateway timeout", status: "started", mine: 1, fields: { team: "Payments", project: "Payment retries", status: "In Progress", priority: "High", assignee: "you" }, opened: 21 * D },
      { id: "pr-1204", kind: "github/pull-request", number: 1204, title: "Retry card payments once on a gateway timeout", status: "open", fields: { repo: "payments-api", author: "Amara", checks: "Passing", review: "Requested" }, signals: [{ id: "c1", kind: "review", by: "Amara", at: 4 * D }], opened: 6 * D },
      { id: "pay-91", kind: "linear/issue", key: "PAY-91", title: "Make payment retries idempotent", status: "review", fields: { team: "Payments", project: "Payment retries", status: "In Review", priority: "High", assignee: "Amara" }, opened: 18 * D },
      { id: "pr-1210", kind: "github/pull-request", number: 1210, title: "Add an idempotency key to the retry", status: "approved", fields: { repo: "payments-api", author: "Amara", checks: "Passing", review: "Approved" }, opened: 9 * D },
      { id: "sn-7k", kind: "sentry/issue", key: "PAYMENTS-API-7K", title: "GatewayTimeout: Kestrel Pay did not answer in 10s", status: "ongoing", account: "northwind", fields: { team: "Payments", project: "payments-api", level: "warning", events: 88, users: 41 }, opened: 15 * D },
      { id: "pay-93", kind: "linear/issue", key: "PAY-93", title: "Show shoppers that we are retrying", status: "todo", fields: { team: "Payments", project: "Payment retries", status: "Todo", priority: "Medium", assignee: "Tomás" }, signals: [{ id: "c2", kind: "mention", by: "Tomás", at: 9 * H, blocks: [{ type: "messages", items: [msg("Tomás Ortega", 9 * H, "@you should the spinner say \"Trying again\" or nothing at all?", 1)] }] }], opened: 14 * D },
      { id: "pr-1215", kind: "github/pull-request", number: 1215, title: "Say \"Trying again\" while a payment retries", status: "draft", fields: { repo: "storefront-web", author: "Tomás", checks: "Passing", review: "None" }, opened: 5 * D },
      { id: "gm-kestrel", kind: "gmail/thread", title: "Kestrel Pay: retry guidance for timeouts", fields: { from: "Kestrel Pay support", label: "Suppliers" }, opened: 12 * D },
      { id: "pay-95", kind: "linear/issue", key: "PAY-95", title: "Alert when retries pass 2% of payments", status: "backlog", fields: { team: "Payments", project: "Payment retries", status: "Backlog", priority: "Low", assignee: "Lars" }, opened: 11 * D },
      { id: "pr-1221", kind: "github/pull-request", number: 1221, title: "Count retries in the payments dashboard", status: "merged", fields: { repo: "payments-api", author: "Lars", checks: "Passing", review: "Approved" }, opened: 8 * D },
      { id: "pay-97", kind: "linear/issue", key: "PAY-97", title: "Retry 3-D Secure challenges that time out", status: "triage", fields: { team: "Payments", project: "Payment retries", status: "Triage", priority: "Medium", assignee: "Amara" }, opened: 4 * D },
      { id: "pr-1226", kind: "github/pull-request", number: 1226, title: "Back off between retries with jitter", status: "open", fields: { repo: "payments-api", author: "Amara", checks: "Passing", review: "Requested" }, opened: 3 * D },
      { id: "sl-2190", kind: "slack/thread", title: "Retry rollout plan for Monday", fields: { channel: "#payments", from: "Amara" }, opened: 2 * D },
      { id: "pay-99", kind: "linear/issue", key: "PAY-99", title: "Document the retry policy for support", status: "todo", fields: { team: "Payments", project: "Payment retries", status: "Todo", priority: "Low", assignee: "Ruth" }, opened: 2 * D },
    ];
    chain.forEach(function (t) { t.updated = t.updated || Math.min(t.opened, 2 * D); add(t); });

    // ---- A link suggestion and a Proposal ----
    add({
      id: "pr-6251", kind: "github/pull-request", number: 6251, title: "Cache delivery slot lookups for five minutes",
      status: "open", opened: 5 * D, updated: 20 * H,
      fields: { repo: "storefront-web", author: "Juno", checks: "Passing", review: "Requested" },
      signals: [{ id: "s19", kind: "review", by: "Juno", at: 20 * H }],
      blocks: [{ type: "change", head: "juno/shop-150-slot-cache", base: "main", files: 5, add: 96, del: 14, checks: "12 passed" }],
      history: [[5 * D, "Juno opened it"], [20 * H, "Juno asked for your review"]],
    });
    add({
      id: "shop-150", kind: "linear/issue", key: "SHOP-150", title: "Delivery slots take four seconds to load",
      status: "todo", mine: 1, opened: 10 * D, updated: 4 * D,
      fields: { team: "Storefront", project: "Checkout revamp", status: "Todo", priority: "High", assignee: "you" },
      blocks: [{ type: "fields", rows: [["Status", "Todo"], ["Priority", "High"], ["Project", "Checkout revamp"]] }],
    });
    add({ id: "gm-kp-fail", kind: "gmail/thread", title: "Kestrel Pay: webhook deliveries are failing", opened: 9 * H, updated: 9 * H, fields: { from: "Kestrel Pay alerts", label: "Suppliers" }, blocks: [{ type: "messages", items: [msg("Kestrel Pay alerts", 9 * H, "142 webhook deliveries to https://api.northwind.market/hooks/kestrel failed in the last hour with 504.")] }] });
    add({ id: "sn-9q", kind: "sentry/issue", key: "PAYMENTS-API-9Q", title: "WebhookTimeout: handler took longer than 30s", status: "new", account: "northwind", opened: 9 * H, updated: 12, fields: { team: "Payments", project: "payments-api", level: "error", events: 142, users: 0 } });
    add({ id: "sl-2261", kind: "slack/thread", title: "Kestrel webhooks timing out again", opened: 8 * H, updated: 7 * H, fields: { channel: "#incidents", from: "Lars" } });

    // ---- Mine, Updates and With Hercule ----
    add({ id: "plat-210", kind: "linear/issue", key: "PLAT-210", title: "Rotate the staging database credentials", status: "todo", mine: 1, opened: 6 * D, updated: 6 * D, fields: { team: "Platform", project: "Warehouse sync", status: "Todo", priority: "High", assignee: "you" } });
    add({ id: "chk-40", kind: "linear/issue", key: "CHK-40", title: "Remember the last address a shopper used", status: "backlog", mine: 1, opened: 15 * D, updated: 15 * D, fields: { team: "Checkout", project: "Checkout revamp", status: "Backlog", priority: "Medium", assignee: "you" } });
    add({ id: "pr-6270", kind: "github/pull-request", number: 6270, title: "Add a loading state to the address finder", status: "approved", mine: 1, opened: 2 * D, updated: 3 * H, fields: { repo: "storefront-web", author: "you", checks: "Passing", review: "Approved" }, history: [[2 * D, "You opened it"], [3 * H, "Theo approved it"]], note: "Theo approved it" });
    add({ id: "shop-163", kind: "linear/issue", key: "SHOP-163", title: "Retry a failed card payment once from the basket", status: "review", opened: 13 * D, updated: 5 * H, fields: { team: "Storefront", project: "Checkout revamp", status: "In Review", priority: "Medium", assignee: "Mei" }, note: "Moved to In Review" });
    add({ id: "sn-3b", kind: "sentry/issue", key: "PAYMENTS-API-3B", title: "KeyError: 'currency' in refund handler", status: "resolved", account: "northwind", opened: 20 * D, updated: 7 * H, fields: { team: "Payments", project: "payments-api", level: "error", events: 12, users: 4 }, note: "Resolved in 2026.11.11-3" });
    add({ id: "sn-labs-4", kind: "sentry/issue", key: "LABS-REC-4", title: "Recommendation model returned no items for a basket", status: "ongoing", account: "northwind-labs", mine: 1, opened: 9 * D, updated: 3 * H, fields: { team: "Checkout", project: "labs-recommender", level: "warning", events: 2318, users: 640 }, signals: [{ id: "s20", kind: "assigned", by: "Sentry", system: 1, at: 9 * D, quiet: 1 }] });
    add({ id: "sn-labs-9", kind: "sentry/issue", key: "LABS-CHK-9", title: "Experiment flag missing for returning shoppers", status: "new", account: "northwind-labs", opened: 26 * H, updated: 26 * H, fields: { team: "Checkout", project: "labs-checkout-exp", level: "info", events: 64, users: 31 }, signals: [{ id: "s21", kind: "regressed", by: "Sentry", system: 1, at: 26 * H }],
      blocks: [{ type: "trend", caption: "Events, last 14 days", values: [3, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 46] }, { type: "fields", rows: [["Level", "info"], ["Resolved", "5 days ago"], ["Came back", "yesterday, in labs 2026.11.11-1"], ["Users", "31"]] }],
      history: [[19 * D, "First seen"], [5 * D, "Bram resolved it"], [26 * H, "It came back in labs 2026.11.11-1"]] });
    add({ id: "pr-6198", kind: "github/pull-request", number: 6198, title: "Bump the image CDN client to 4.2", status: "open", opened: 2 * D, updated: 40, fields: { repo: "storefront-web", author: "Wren", checks: "Passing", review: "Requested" }, held: { by: "Review PR", task: "Review the image CDN bump", since: 40 }, signals: [{ id: "s22", kind: "review", by: "Wren", at: 2 * D, done: true }], history: [[2 * D, "Wren asked for your review"], [40, "You handed it to Review PR"]] });
    add({ id: "chk-28", kind: "linear/issue", key: "CHK-28", title: "Keep the basket when a session expires", status: "started", mine: 1, opened: 7 * D, updated: 2 * H, fields: { team: "Checkout", project: "Checkout revamp", status: "In Progress", priority: "High", assignee: "you" }, held: { by: "you", task: "Keep the basket when a session expires", since: 2 * D } });
    add({ id: "po-2304", kind: "quayside/order", key: "PO-2304", title: "Spare scanners for returns", status: "held", opened: 9 * D, updated: 2 * D, fields: { round: "Week 46 round", site: "Utrecht hub", amount: "€860" }, note: "Delivery moved to Monday" });
    add({ id: "gm-news", kind: "gmail/thread", title: "Northwind engineering weekly: 11 November", opened: 26 * H, updated: 26 * H, fields: { from: "Engineering updates", label: "Newsletters" } });

    var links = [
      ["shop-142", "pr-6244", { type: "source", by: "Linear" }],
      ["pr-6244", "sn-1z9", { type: "person", by: "you" }],
      ["shop-142", "sl-2201", { type: "person", by: "Noa" }],
      ["pay-88", "pr-1204", { type: "source", by: "Linear" }],
      ["pr-1204", "pay-91", { type: "source", by: "GitHub" }],
      ["pay-91", "pr-1210", { type: "source", by: "Linear" }],
      ["pr-1210", "sn-7k", { type: "person", by: "Amara" }],
      ["sn-7k", "pay-93", { type: "person", by: "Tomás" }],
      ["pay-93", "pr-1215", { type: "source", by: "Linear" }],
      ["pr-1215", "gm-kestrel", { type: "person", by: "Tomás" }],
      ["gm-kestrel", "pay-95", { type: "person", by: "Lars" }],
      ["pay-95", "pr-1221", { type: "source", by: "Linear" }],
      ["pr-1221", "pay-97", { type: "person", by: "Lars" }],
      ["pay-97", "pr-1226", { type: "source", by: "Linear" }],
      ["pr-1226", "sl-2190", { type: "person", by: "Amara" }],
      ["sl-2190", "pay-99", { type: "person", by: "Ruth" }],
    ];

    var triage = [
      { id: "prop-kp", type: "proposal", by: "Triage", at: 2 * H, title: "Stop the Kestrel Pay webhooks timing out", why: "Three reports of one failure tonight: Kestrel's alert email, the Sentry error and Lars's thread in #incidents all name the webhook handler, and all started at 23:10.", things: ["gm-kp-fail", "sn-9q", "sl-2261"], project: "payments" },
      { id: "link-6251", type: "link", by: "Hercule", at: 40, things: ["pr-6251", "shop-150"], why: "#6251's branch is named shop-150-slot-cache, and both change how delivery slots load." },
    ];

    return { things: things, links: links, triage: triage };
  }

  /** Builds the light day: five things that ask, no groups, one Proposal. */
  function buildLight() {
    var w = buildNormal();
    var keep = ["gm-quote", "pr-6213", "sl-2240", "chk-31", "po-2291", "pr-6270", "plat-210", "gm-kp-fail", "sn-9q", "sl-2261"];
    w.things = w.things.filter(function (t) { return keep.indexOf(t.id) >= 0; });
    w.links = [];
    w.triage = w.triage.filter(function (x) { return x.type === "proposal"; });
    return w;
  }

  // A small seeded random, so the extreme load is the same on every load and in every capture.
  function seeded(seed) {
    return function () {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  /** Builds the extreme day: the normal one plus 2,400 generated things across every source and account. */
  function buildExtreme() {
    var w = buildNormal();
    var r = seeded(7);
    var pick = function (a) { return a[Math.floor(r() * a.length)]; };
    var people = ["Ines", "Omar", "Mei", "Tessa", "Juno", "Felix", "Priya", "Theo", "Wren", "Noa", "Sanne", "Kwame", "Lars", "Amara", "Tomás", "Ruth", "Ana", "Bram", "Chloé", "Dev"];
    var verbs = ["Fix", "Show", "Cache", "Retry", "Remove", "Rename", "Split", "Log", "Measure", "Move", "Speed up", "Translate", "Validate", "Round", "Hide"];
    var objects = ["the basket total", "delivery slots", "the address finder", "gift card balances", "the order history page", "refund emails", "the product carousel", "VAT on invoices", "the search filters", "stock levels at the depot", "the returns label", "promo codes", "the loyalty balance", "payment webhooks", "the mobile cart badge"];
    var tails = ["", "", " for returning shoppers", " on slow connections", " in the Dutch store", " after a refund", " when a session expires", " on iOS 19", " before the winter sale"];
    var repos = ["storefront-web", "payments-api", "platform-core", "mobile-app", "infra", "search-service", "warehouse-sync", "design-system"];
    var teams = ["Checkout", "Storefront", "Payments", "Platform", "Mobile", "Data", "Search", "Growth"];
    var labs = ["Checkout", "Recommendations", "Pricing"];
    var errs = ["TypeError: Cannot read properties of null (reading 'id')", "ChunkLoadError: Loading chunk failed", "GatewayTimeout: upstream did not answer", "KeyError: 'sku'", "RangeError: Invalid time value", "NetworkError when attempting to fetch resource"];
    var extraProjects = ["Returns portal", "Price rules", "Depot scanners", "Mobile wallet", "Store pickup", "Supplier portal", "Search ranking", "Gift wrapping", "Order tracking", "Fraud checks", "Tax engine", "Checkout A/B", "Saved baskets", "Bulk orders", "Click and collect", "Same-day delivery", "Klarna-style instalments", "Accessibility pass", "Dark mode", "Holiday banners", "Image pipeline", "Courier API", "Product reviews", "Coupons 2.0", "Address book", "Wishlist sunset", "Mobile onboarding", "Data warehouse", "Cost dashboards", "Incident runbooks", "Status page", "Vendor invoices"];
    extraProjects.forEach(function (name, i) { PROJECTS_EXTREME.push({ name: name, health: ["on-track", "at-risk", "off-track", "on-track"][i % 4] }); });
    var allProjects = PROJECTS.concat(PROJECTS_EXTREME).map(function (p) { return p.name; });
    for (var i = 0; i < 2400; i++) {
      var kind = pick(["github/pull-request", "github/pull-request", "linear/issue", "linear/issue", "linear/issue", "sentry/issue", "sentry/issue", "gmail/thread", "slack/thread"]);
      var who = pick(people);
      var at = Math.floor(r() * r() * 30 * D) + 3;
      var t = { id: "x" + i, kind: kind, opened: at + Math.floor(r() * 5 * D), updated: at, fields: {}, signals: [] };
      var asks = r() < 0.32;
      if (kind === "github/pull-request") {
        t.number = 7000 + i; t.title = pick(verbs) + " " + pick(objects) + pick(tails);
        t.status = pick(["open", "open", "draft", "failing", "approved"]);
        t.fields = { repo: pick(repos), author: who, checks: t.status === "failing" ? "Failing" : "Passing", review: asks ? "Requested" : "None" };
        if (asks) t.signals.push({ id: "xs" + i, kind: r() < 0.7 ? "review" : "mention", by: who, at: at });
      } else if (kind === "linear/issue") {
        var team = pick(teams);
        t.key = team.slice(0, 3).toUpperCase() + "-" + (300 + i); t.title = pick(verbs) + " " + pick(objects) + pick(tails);
        t.status = pick(["todo", "todo", "started", "review", "backlog", "triage"]);
        t.fields = { team: team, project: pick(allProjects), status: Kinds.KINDS[kind].statuses[t.status].word, priority: pick(["Urgent", "High", "Medium", "Low"]), assignee: r() < 0.3 ? "you" : who };
        t.mine = t.fields.assignee === "you" ? 1 : 0;
        if (asks) t.signals.push({ id: "xs" + i, kind: "mention", by: who, at: at });
      } else if (kind === "sentry/issue") {
        var labsAcc = r() < 0.3;
        t.account = labsAcc ? "northwind-labs" : "northwind";
        t.key = (labsAcc ? "LABS-" : "STOREFRONT-") + (i + 100).toString(36).toUpperCase(); t.title = pick(errs);
        t.status = pick(["new", "ongoing", "escalating", "regressed"]);
        t.fields = { team: labsAcc ? pick(labs) : pick(teams), project: labsAcc ? "labs-" + pick(["recommender", "checkout-exp", "pricing"]) : pick(repos), level: pick(["error", "error", "warning", "fatal", "info"]), events: Math.floor(r() * r() * 48000), users: Math.floor(r() * r() * 9000) };
        t.mine = r() < 0.4 ? 1 : 0;
        if (asks && t.status === "regressed") t.signals.push({ id: "xs" + i, kind: "regressed", by: "Sentry", system: 1, at: at });
      } else if (kind === "gmail/thread") {
        t.title = pick(["Re: ", "Fwd: ", ""]) + pick(["Quote for ", "Question about ", "Invoice for ", "Delivery of ", "Contract for "]) + pick(objects);
        t.fields = { from: who + " " + pick(["Haddad", "Okafor", "Lindqvist", "Brandt", "Raman"]), label: pick(["Suppliers", "Customers", "Finance", "Hiring", "Newsletters"]) };
        if (asks) t.signals.push({ id: "xs" + i, kind: "asked", by: who, at: at });
      } else {
        t.title = pick(["Can someone look at ", "Heads up about ", "Is anyone on ", "Plan for "]) + pick(objects) + "?";
        t.fields = { channel: pick(["#checkout", "#incidents", "#payments", "#storefront", "#mobile", "#random", "#deploys"]), from: who };
        if (asks) t.signals.push({ id: "xs" + i, kind: "mention", by: who, at: at });
      }
      w.things.push(Object.assign(t, { history: [], blocks: [], account: t.account || ACCOUNTS[Kinds.KINDS[kind].source][0] }));
    }
    // A very long title, and a huge count, on things the first screen shows.
    w.things.push({ id: "x-long", kind: "linear/issue", key: "SHOP-1999", title: "Make sure the delivery cost, the service fee and the VAT on both are shown with the same rounding on the basket, the delivery step, the payment step, the confirmation email and the PDF invoice", status: "triage", opened: 40 * D, updated: 41 * D, account: "Northwind", fields: { team: "Storefront", project: "Checkout revamp", status: "Triage", priority: "High", assignee: "Ines" }, signals: [{ id: "x-long-s", kind: "mention", by: "Ines", at: 41 * D }], history: [], blocks: [] });
    w.things.push({ id: "x-huge", kind: "sentry/issue", key: "STOREFRONT-HUGE", title: "NetworkError when attempting to fetch resource", status: "escalating", opened: 60 * D, updated: 1, account: "northwind", mine: 1, fields: { team: "Storefront", project: "storefront-web", level: "error", events: 1284033, users: 211904 }, signals: [{ id: "x-huge-s", kind: "regressed", by: "Sentry", system: 1, at: 22 * D }], history: [], blocks: [] });
    // A dozen extra link suggestions and Proposals.
    for (var k = 0; k < 9; k++) w.triage.push({ id: "xt" + k, type: k % 3 ? "link" : "proposal", by: k % 3 ? "Hercule" : "Triage", at: (k + 1) * 47, title: pick(verbs) + " " + pick(objects), why: "These name the same thing and started within the same hour.", things: ["x" + (k * 7), "x" + (k * 7 + 3)] });
    return w;
  }
  var PROJECTS_EXTREME = [];

  // Things that arrive while the user reads: the "N new" bar holds them back.
  var ARRIVALS = [
    { id: "pr-6281", kind: "github/pull-request", number: 6281, title: "Show the delivery cost in the basket drawer", status: "open", opened: 1, updated: 1, fields: { repo: "storefront-web", author: "Mei", checks: "Running", review: "Requested" }, signals: [{ id: "a1", kind: "review", by: "Mei", at: 1 }], history: [[1, "Mei asked for your review"]] },
    { id: "gm-crates2", kind: "gmail/thread", title: "Re: Quote for 400 insulated delivery crates", opened: 2, updated: 2, fields: { from: "Harbourline Packaging", label: "Suppliers" }, signals: [{ id: "a2", kind: "asked", by: "Harbourline Packaging", at: 2, blocks: [{ type: "messages", items: [msg("Elif Sahin, Harbourline", 2, "A reminder that we need your answer by Friday to hold the week 49 slot.", 1)] }] }] },
    { id: "sl-2270", kind: "slack/thread", title: "Basket drawer screenshot for the release notes?", opened: 3, updated: 3, fields: { channel: "#storefront", from: "Wren" }, signals: [{ id: "a3", kind: "mention", by: "Wren", at: 3 }] },
  ];

  // The user's two declared settings: pins in the rail (inbox.pins) and folded Browse sources (inbox.browseFolded).
  var SETTINGS = {
    pins: [{ source: "linear", field: "project", value: "Checkout revamp" }, { source: "sentry", account: "northwind", field: "team", value: "Checkout" }],
    browseFolded: ["github", "sentry", "gmail", "slack", "quayside"],
  };

  return {
    SETTINGS: SETTINGS,
    ACCOUNTS: ACCOUNTS,
    WORKFLOWS: WORKFLOWS,
    projects: function (load) { return load === "extreme" ? PROJECTS.concat(PROJECTS_EXTREME) : PROJECTS; },
    build: function (load) { return load === "light" ? buildLight() : load === "extreme" ? buildExtreme() : buildNormal(); },
    arrivals: function () { return JSON.parse(JSON.stringify(ARRIVALS)); },
  };
})();
