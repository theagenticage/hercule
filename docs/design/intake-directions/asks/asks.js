// PROTOTYPE - Intake as a running list of asks: the fixtures for two users, the rendering, and the keys.
// Load it after crew.js. The first render happens before crew.js draws faces and marks; every later
// render draws its own through Crew.drawPlaceholders.
//
// An ask never leaves the data. Answering it gives it a resolution and snoozing it gives it a time
// to come back; which view shows it follows from those two fields:
//   To do        open and not snoozed
//   Later        open and snoozed by you
//   Done         resolved, here or on its own system
//   Everything   every event the user's sources sent, each with what came of it
//
// URL parameters, on top of the ones page.js reads:
//   ?user=rogier|noor                 whose Intake: the same screen under two different sets of plugins
//   ?mode=todo|later|done|everything  which view
//   ?filter=all|triage|<source>       the tab
//   ?stamp=<stamp>                    in Everything, only events with this stamp (see STAMPS)
//   ?ask=<id>                         the ask or event under the cursor, open in the detail pane
//   ?pane=closed                      hides the detail pane, so the list takes the full width
//   ?list=empty                       starts with every To do item answered: the inbox-zero state
//   ?state=xray                       labels each part with who provides it: a plugin, or the core
//   ?bar=off                          hides the prototype switcher, for screenshots
(function () {
  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var userKey = params.get("user") === "noor" ? "noor" : "rogier";

  /* ------------------------------------------------------------------ time */

  // The prototype's clock stands still at 11:20 on Friday 2 October 2026. A moment is a number of
  // minutes since the start of Thursday 1 October, so day 0 is yesterday and day 1 is today.
  var DAY = 1440;
  var TODAY = 1;
  var DAY_NAMES = ["Thursday", "Friday", "Saturday", "Sunday", "Monday"];

  /** Returns the moment at a clock time on a day: T(1, "09:05") is today at 09:05. Short, because the fixtures use it on every line. */
  function T(day, clock) {
    var parts = clock.split(":");
    return day * DAY + Number(parts[0]) * 60 + Number(parts[1]);
  }

  var NOW = T(TODAY, "11:20");
  var lastAction = NOW;

  /** Returns the moment of a new action. The clock stands still, so each action is a hair later than the one before and sorts above it. */
  function nextActionTime() {
    lastAction += 0.01;
    return lastAction;
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** Returns the day a moment falls on: 0 is yesterday, 1 is today. */
  function readDay(t) {
    return Math.floor(t / DAY);
  }

  /** Returns the clock time of a moment: "09:05". */
  function formatClock(t) {
    var minutes = Math.floor(t) % DAY;
    return pad(Math.floor(minutes / 60)) + ":" + pad(minutes % 60);
  }

  /** Returns a day the way a sentence names it: "today", "tomorrow", "yesterday" or "Monday". */
  function formatDay(day) {
    if (day === TODAY) return "today";
    if (day === TODAY + 1) return "tomorrow";
    if (day === TODAY - 1) return "yesterday";
    return DAY_NAMES[day];
  }

  /** Returns a moment the way a sentence names it: "today 14:00", "Monday 09:00". */
  function formatMoment(t) {
    return formatDay(readDay(t)) + " " + formatClock(t);
  }

  /** Returns a moment with "at" in it: "today at 10:47". */
  function formatMomentAt(t) {
    return formatDay(readDay(t)) + " at " + formatClock(t);
  }

  /** Returns a moment as short as the right edge of a row allows: "14:00" today, "Mon 09:00" on another day. */
  function formatShortMoment(t) {
    var day = readDay(t);
    return day === TODAY ? formatClock(t) : DAY_NAMES[day].slice(0, 3) + " " + formatClock(t);
  }

  /** Returns the date of a moment: "1 Oct". */
  function formatDate(t) {
    return readDay(t) + 1 + " Oct";
  }

  /** Returns the moment of the hourly triage run that read an event at this moment. */
  function findTriageRun(t) {
    return Math.ceil(t / 60) * 60;
  }

  /* ------------------------------------------------------------------ answers */

  // A describe line is the core's: it is built from the frozen operation, with live names in <b>.
  // The producer of an ask never writes it. `op` is what the answer runs, shown in the x-ray labels.
  function act(label, op, describe, fine, did) {
    return { type: "act", label: label, op: op, describe: describe, fine: fine, did: did };
  }
  function reply(label, op, describe, fine, placeholder, did) {
    return { type: "reply", label: label, op: op, describe: describe, fine: fine, placeholder: placeholder, did: did };
  }
  function hand(workflow, label, describe, fine) {
    return { type: "hand", label: label || 'Start "' + workflow + '"', face: workflow, op: "run.start", describe: describe, fine: fine, did: "Handed to " + workflow };
  }
  function done(system) {
    return { type: "done", label: "Done", op: "notification.resolve", describe: system ? "Takes it off your list. " + system + " is not told" : "Takes it off your list", did: "Done" };
  }
  function accept(task) {
    return { type: "act", label: "Accept", op: "task.update", describe: "Removes label <b>proposed</b> from Task <b>" + task + "</b>", did: "Accepted" };
  }
  function dismiss(task) {
    return { type: "dismiss", label: "Dismiss", op: task ? "task.update" : null, describe: task ? "Sets status to <b>cancelled</b> on Task <b>" + task + "</b>" : "Does nothing", did: "Dismissed" };
  }
  function choice(label, task, cancel) {
    return {
      type: "choice",
      label: label,
      op: "task.update",
      describe: cancel ? "Sets status to <b>cancelled</b> on Task <b>" + task + "</b>" : "Sets project to <b>" + label + "</b> on Task <b>" + task + "</b>",
      did: cancel ? "Not work" : "Project set to " + label,
    };
  }

  /** Returns the describe line of Stop asking: what stops, what still gets through, and what the other system keeps doing. */
  function describeStop(it) {
    return "Stops asks about <b>" + it.thread + "</b> here, unless someone names you. " + it.system + " still notifies you";
  }

  // How an ask left the list. `how` is one of:
  //   answer     you answered it here, with one of its answers
  //   hand       you handed it to a workflow here
  //   done       you took it off your list here, and nothing was sent
  //   stop       you stopped asks about its thread here
  //   elsewhere  you answered it on its own system, and the plugin resolved it
  //   withdrawn  the plugin withdrew it, because the thing it asked about went away
  function resolved(how, t, text, more) {
    var r = { how: how, t: t, text: text };
    for (var k in more) r[k] = more[k];
    return r;
  }

  // An event that raised no ask. `stamp` is one of STAMPS; `item` names the triage item it led to.
  function ev(t, src, type, title, stamp, more) {
    var e = { t: t, src: src, type: type, title: title, stamp: stamp };
    for (var k in more) e[k] = more[k];
    return e;
  }

  var WORKER = {
    "Fix bug": "Claude Code · Opus 5.5 · studio-mac",
    "Review PR": "Claude Code · Opus 5.5 · studio-mac",
    "Address review": "Claude Code · Opus 5.5 · studio-mac",
    Investigate: "Codex · gpt-5.4 · build-box-1",
    "Draft reply": "Claude Code · Haiku 4.5 · build-box-2",
    "Renew certificate": "Claude Code · Haiku 4.5 · build-box-2",
  };

  var SYSTEMS = {
    sentry: "Sentry",
    github: "GitHub",
    linear: "Linear",
    slack: "Slack",
    grafana: "Grafana",
    cron: "Cron",
    intercom: "Intercom",
    pagerduty: "PagerDuty",
    gmail: "Gmail",
    googlecalendar: "Calendar",
    stripe: "Stripe",
  };

  // The stamps an event can carry, in the order where the first match wins. Spec 10 §3 owns all but
  // the first two; "→ ask" and "stopped" are this prototype's additions.
  var STAMPS = [
    { key: "ask", label: "→ ask" },
    { key: "stopped", label: "stopped" },
    { key: "proposal", label: "→ proposal" },
    { key: "attached", label: "→ attached" },
    { key: "offer", label: "offer" },
    { key: "fyi", label: "FYI" },
    { key: "unsure", label: "unsure" },
    { key: "known", label: "known" },
    { key: "pending", label: "pending triage" },
    { key: "none", label: "no action" },
  ];
  // Events with these stamps went through triage. Events that raised an ask, or hit a stopped thread, did not.
  var TRIAGE_STAMPS = ["proposal", "attached", "offer", "fyi", "unsure", "known", "pending", "none"];

  /* ------------------------------------------------------------------ fixtures */

  // Each item is one decision Notification. An ask is raised by a plugin straight from its event;
  // a triage item comes from the hourly triage batch. `kindId` is the plugin's ask kind; `ref` and
  // `thread` name the thread it is about, and only an ask with a `thread` can be stopped.
  var USERS = {
    rogier: {
      selected: "slack",
      triage: { last: T(TODAY, "11:00"), next: T(TODAY, "12:00") },
      sources: ["sentry", "github", "linear", "slack"],
      connections: { sentry: "Sentry · acme", github: "GitHub · rogier", linear: "Linear · acme", slack: "Slack · acme", grafana: "Grafana · ops", cron: "Cron · ops", intercom: "Intercom · acme" },
      stops: [{ ref: "slack:thread:C03FRONT1/1790858400.112300", src: "slack", label: "#frontend · Dark mode tokens", since: T(0, "16:52"), until: null }],
      items: [
        {
          id: "alert",
          group: "now",
          src: "sentry",
          system: "Sentry",
          kind: "Alert for you",
          kindId: "sentry/alert-for-you",
          title: "Checkout fails for EU cards with 3-D Secure",
          who: "Sentry",
          place: "webshop-prod",
          age: "08:52",
          at: T(1, "08:52"),
          event: "sentry.issue.alert",
          eventTitle: "Alert rule fired on WEBSHOP-3DS",
          ref: "sentry:issue:WEBSHOP-3DS",
          state: "Fixing in a thread",
          asked: "Your alert rule assigned it to you at 08:52.",
          blocks: [
            { type: "signal", num: "412", label: "events, 188 users", sub: "since deploy #1289, yesterday 14:02" },
            {
              type: "work",
              face: "Fix bug",
              label: "You are on it",
              title: "Fix 3-D Secure checkout for EU cards",
              facts: "Fix bug · started by you at 09:02 · waiting on you: <b>Run git push?</b>",
              button: "Open the thread",
            },
            { type: "note", text: "Triage attached <b>1 customer conversation</b> to your Task at 10:00. It did not raise this again." },
          ],
          answers: [],
          open: "Open in Sentry",
          leaves: "Leaves your list when the issue is resolved in Sentry.",
          raised: "Sentry plugin · <code>sentry.issue.alert</code> for an alert rule that names you",
        },
        {
          id: "changes",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Changes requested",
          kindId: "github/changes-requested",
          title: "Move the promo banner to the CMS",
          who: "Sanne",
          place: "webshop #1298",
          age: "3h",
          at: T(1, "08:20"),
          event: "github.pull_request_review",
          eventTitle: "Sanne requested changes on #1298",
          ref: "github:pr:rogier/webshop#1298",
          thread: "webshop #1298",
          back: { at: T(1, "08:31"), until: T(1, "11:00") },
          asked: "Sanne reviewed your pull request at 08:20.",
          blocks: [
            {
              type: "thread",
              messages: [
                { who: "Sanne", at: "src/promo/banner.tsx:42", file: true, text: "This still reads the old flag. Read it from the CMS entry too, or the banner shows twice." },
                { who: "Sanne", at: "src/promo/cms.ts:18", file: true, text: "Cache this. It runs on every page view." },
              ],
            },
          ],
          answers: [
            hand("Address review", null, "Starts <b>Address review</b> on <b>webshop</b> with pull request <b>#1298</b> and its <b>2</b> review comments", WORKER["Address review"]),
            reply("Reply…", "github/review.reply", "Posts your reply to the review on <b>#1298</b> as <b>rogier</b>", "GitHub · rogier", "Reply to Sanne's review…", "Replied to Sanne"),
            done("GitHub"),
          ],
          open: "Open on GitHub",
          leaves: "Leaves your list when you push to #1298 or reply to the review, here or on GitHub.",
          raised: "GitHub plugin · <code>github.pull_request_review</code> on your pull request, state <code>changes_requested</code>",
        },
        {
          id: "review",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Review request",
          kindId: "github/review-requested",
          title: "Retry Stripe webhooks with backoff",
          who: "Marta",
          place: "payments-api #1294",
          age: "2h",
          at: T(1, "09:18"),
          event: "github.notification",
          eventTitle: "Marta requested your review on #1294",
          ref: "github:pr:rogier/payments-api#1294",
          thread: "payments-api #1294",
          waiting: true,
          asked: "Marta asked at 09:18 and is waiting on your review.",
          blocks: [
            { type: "change", files: 6, plus: 142, minus: 38, from: "marta/webhook-backoff", to: "main", checks: "4 checks passed" },
            { type: "words", who: "Marta", at: "09:18", text: "Stripe retries a failed webhook for three days, but we drop it after the first 500. This adds a queue with exponential backoff and a dead-letter table." },
          ],
          answers: [
            act("Approve", "github/pr.review", "Approves pull request <b>#1294</b> in <b>rogier/payments-api</b> as <b>rogier</b>", "GitHub · rogier", "Approved #1294"),
            reply("Comment…", "github/pr.review", "Posts your comment on <b>#1294</b> as <b>rogier</b>", "GitHub · rogier", "Comment on #1294…", "Commented on #1294"),
            hand("Review PR", 'Start "Review PR"', "Starts <b>Review PR</b> on <b>payments-api</b> with pull request <b>#1294</b>. You still approve it yourself", WORKER["Review PR"]),
            done("GitHub"),
          ],
          open: "Open on GitHub",
          leaves: "Leaves your list when you review #1294, here or on GitHub.",
          raised: "GitHub plugin · <code>github.notification</code> with reason <code>review_requested</code>",
        },
        {
          id: "checks",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Checks failed on your PR",
          kindId: "github/checks-failed",
          title: "Show VAT per line on invoices",
          who: "GitHub Actions",
          place: "webshop #1300",
          age: "1h",
          at: T(1, "10:21"),
          event: "github.check_suite",
          eventTitle: "Checks failed on #1300",
          ref: "github:pr:rogier/webshop#1300",
          thread: "webshop #1300",
          asked: "The checks on your pull request finished at 10:21.",
          blocks: [
            {
              type: "checks",
              rows: [
                { state: "failed", name: "test / invoices", time: "2m 14s", log: "✕ invoice › rounds VAT per line\n  expected 2.10, received 2.09" },
                { state: "done", name: "typecheck", time: "1m 02s" },
                { state: "done", name: "lint", time: "41s" },
              ],
            },
          ],
          answers: [
            hand("Fix bug", 'Start "Fix bug"', "Starts <b>Fix bug</b> on <b>webshop</b> with pull request <b>#1300</b> and the failing check <b>test / invoices</b>", WORKER["Fix bug"]),
            act("Re-run", "github/checks.rerun", "Re-runs <b>test / invoices</b> on <b>#1300</b>", "GitHub · rogier", "Re-running test / invoices"),
            done("GitHub"),
          ],
          open: "Open on GitHub",
          leaves: "Leaves your list when the checks pass or the pull request closes.",
          raised: "GitHub plugin · <code>github.check_suite</code> completed with a failure, on a pull request you opened",
        },
        {
          id: "linear",
          group: "asks",
          src: "linear",
          system: "Linear",
          kind: "Question for you",
          kindId: "linear/mentioned",
          title: "Refunds for partial captures",
          who: "Jonas",
          place: "PAY-212",
          age: "40m",
          at: T(1, "10:41"),
          event: "linear.comment.created",
          eventTitle: "Jonas mentioned you on PAY-212",
          ref: "linear:issue:PAY-212",
          thread: "PAY-212",
          waiting: true,
          asked: "Jonas mentioned you at 10:41 and is waiting on an answer.",
          blocks: [
            {
              type: "words",
              who: "Jonas",
              at: "10:41",
              text: '<span class="b-at">@rogier</span> should a partial refund go back through Stripe first, or through our ledger first? I need it to settle the API shape before the cycle ends.',
            },
            { type: "fields", rows: [["Status", "In progress"], ["Cycle", "41, ends Friday"], ["Team", "Payments"]] },
          ],
          answers: [reply("Reply", "linear/comment.create", "Posts your comment on <b>PAY-212</b> as <b>Rogier</b>", "Linear · acme", "Reply to Jonas on PAY-212…", "Replied on PAY-212"), done("Linear")],
          open: "Open in Linear",
          leaves: "Leaves your list when you comment on PAY-212, here or in Linear.",
          raised: "Linear plugin · <code>linear.comment.created</code> that mentions you",
        },
        {
          id: "slack",
          group: "asks",
          src: "slack",
          system: "Slack",
          kind: "Tagged in a thread",
          kindId: "slack/mentioned",
          title: "Codes with a trailing space are rejected",
          who: "Pieter",
          place: "#acceptance",
          age: "12m",
          at: T(1, "11:08"),
          event: "slack.message",
          eventTitle: "Pieter mentioned you in #acceptance",
          ref: "slack:thread:C05K2ACC9/1790931120.441900",
          thread: "#acceptance · Discount codes",
          asked: "Pieter tagged you at 11:08, about work you merged.",
          blocks: [
            {
              type: "thread",
              messages: [
                { who: "Sanne", at: "10:52", text: "Discount codes (#1287) are on acceptance." },
                { who: "Pieter", at: "11:08", mine: true, text: '<span class="b-at">@rogier</span> codes with a trailing space are rejected now. "SUMMER10 " fails, and it worked before. Customers paste them from emails.' },
                { who: "Sanne", at: "11:10", text: "Seen it twice this morning too." },
              ],
            },
            {
              type: "work",
              mark: "done",
              label: "Your work",
              title: "Discount codes ignore letter case",
              facts: "#1287 merged Tuesday 19:12 · on acceptance since 10:40",
              button: "Open the Task",
            },
          ],
          answers: [
            reply("Reply", "slack/thread.reply", "Posts your reply in the <b>#acceptance</b> thread as <b>@rogier</b>", "Slack · acme", "Reply in the thread…", "Replied in #acceptance"),
            hand("Fix bug", 'Start "Fix bug"', "Starts <b>Fix bug</b> on <b>webshop</b> with this thread and pull request <b>#1287</b>", WORKER["Fix bug"]),
            done("Slack"),
          ],
          open: "Open in Slack",
          leaves: "Leaves your list when you reply in the thread, here or in Slack.",
          raised: "Slack plugin · a message in a thread that mentions you",
        },
        {
          id: "backup",
          group: "triage",
          src: "grafana",
          system: "Grafana",
          kind: "Proposal",
          title: "Nightly backup job timing out on ops-db",
          who: "Triage",
          place: "ops",
          age: "11:00",
          at: T(1, "11:00"),
          line: "Proposal · ops · 3 nights in a row",
          asked: "Triage proposed this at 11:00.",
          blocks: [
            { type: "gist", text: "The ops-db backup has run past its 3-hour limit three nights in a row. The database grew 40% since August, and the job still copies it in one pass." },
            {
              type: "sources",
              rows: [
                { src: "grafana", text: "<b>3</b> alerts · backup took 4h 10m, limit 3h" },
                { src: "cron", text: "<b>3</b> failed runs of nightly-backup" },
              ],
            },
          ],
          answers: [
            hand("Investigate", null, "Starts <b>Investigate</b> on <b>ops</b> with task <b>Nightly backup job timing out on ops-db</b>", WORKER.Investigate),
            accept("Nightly backup job timing out on ops-db"),
            dismiss("Nightly backup job timing out on ops-db"),
          ],
          leaves: "Leaves your list when you answer it.",
          raised: "Triage at 11:00 · <code>triage.proposal</code>",
        },
        {
          id: "deps",
          group: "triage",
          src: "github",
          system: "GitHub",
          kind: "Offer",
          title: "Merge 4 dependency bumps",
          who: "Triage",
          place: "webshop",
          age: "11:00",
          at: T(1, "11:00"),
          line: "Offer · webshop · all green, patch versions",
          asked: "Triage offered this at 11:00.",
          blocks: [
            { type: "gist", text: "Four Dependabot pull requests with patch versions only. Every check passed, and none touches checkout." },
            {
              type: "sources",
              rows: [{ src: "github", text: "<b>4</b> pull requests · #1290, #1291, #1295, #1297" }],
            },
          ],
          answers: [act("Merge 4", "github/pr.merge", "Merges pull requests <b>#1290</b>, <b>#1291</b>, <b>#1295</b> and <b>#1297</b> in <b>rogier/webshop</b>", "GitHub · rogier", "Merged 4 pull requests"), dismiss(null)],
          leaves: "Leaves your list when you answer it.",
          raised: "Triage at 11:00 · <code>triage.offer</code>",
        },
        {
          id: "android",
          group: "triage",
          src: "intercom",
          system: "Intercom",
          kind: "Unsure",
          title: "App is slow on Android",
          who: "Triage",
          place: "which project?",
          age: "11:00",
          at: T(1, "11:00"),
          line: "Unsure · which project? · 7 conversations",
          asked: "Triage could not tell which project this belongs to.",
          blocks: [
            { type: "gist", text: "Seven customers say the app is slow on Android since Sunday. Both the webshop and payments-api shipped that day." },
            { type: "sources", rows: [{ src: "intercom", text: "<b>7</b> conversations since Sunday" }] },
          ],
          answers: [choice("webshop", "App is slow on Android"), choice("payments-api", "App is slow on Android"), choice("Not work", "App is slow on Android", true)],
          leaves: "Leaves your list when you answer it.",
          raised: "Triage at 11:00 · <code>triage.unsure</code>",
        },

        // Snoozed: on Later.
        {
          id: "l-1296",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Review request",
          kindId: "github/review-requested",
          title: "Lazy-load product images",
          who: "Pieter",
          place: "webshop #1296",
          age: "2h",
          at: T(1, "09:40"),
          event: "github.notification",
          eventTitle: "Pieter requested your review on #1296",
          ref: "github:pr:rogier/webshop#1296",
          thread: "webshop #1296",
          snooze: { at: T(1, "09:44"), until: T(1, "14:00") },
          asked: "Pieter asked at 09:40.",
          blocks: [
            { type: "change", files: 4, plus: 61, minus: 12, from: "pieter/lazy-images", to: "main", checks: "4 checks passed" },
            { type: "words", who: "Pieter", at: "09:40", text: "Images below the fold now load when they scroll into view. The product page drops from 2.1 MB to 640 KB." },
          ],
          answers: [
            act("Approve", "github/pr.review", "Approves pull request <b>#1296</b> in <b>rogier/webshop</b> as <b>rogier</b>", "GitHub · rogier", "Approved #1296"),
            reply("Comment…", "github/pr.review", "Posts your comment on <b>#1296</b> as <b>rogier</b>", "GitHub · rogier", "Comment on #1296…", "Commented on #1296"),
            hand("Review PR", 'Start "Review PR"', "Starts <b>Review PR</b> on <b>webshop</b> with pull request <b>#1296</b>. You still approve it yourself", WORKER["Review PR"]),
            done("GitHub"),
          ],
          open: "Open on GitHub",
          leaves: "Leaves your list when you review #1296, here or on GitHub.",
          raised: "GitHub plugin · <code>github.notification</code> with reason <code>review_requested</code>",
        },
        {
          id: "l-pay219",
          group: "asks",
          src: "linear",
          system: "Linear",
          kind: "Question for you",
          kindId: "linear/mentioned",
          title: "Checkout copy for the VAT line",
          who: "Sanne",
          place: "PAY-219",
          age: "1d",
          at: T(0, "17:30"),
          event: "linear.comment.created",
          eventTitle: "Sanne mentioned you on PAY-219",
          ref: "linear:issue:PAY-219",
          thread: "PAY-219",
          snooze: { at: T(0, "17:42"), until: T(4, "09:00") },
          asked: "Sanne mentioned you yesterday at 17:30.",
          blocks: [
            {
              type: "words",
              who: "Sanne",
              at: "yesterday 17:30",
              text: '<span class="b-at">@rogier</span> legal wants "incl. 21% VAT" under every price, not only under the total. Can the checkout copy change before the next release?',
            },
          ],
          answers: [reply("Reply", "linear/comment.create", "Posts your comment on <b>PAY-219</b> as <b>Rogier</b>", "Linear · acme", "Reply to Sanne on PAY-219…", "Replied on PAY-219"), done("Linear")],
          open: "Open in Linear",
          leaves: "Leaves your list when you comment on PAY-219, here or in Linear.",
          raised: "Linear plugin · <code>linear.comment.created</code> that mentions you",
        },

        // Resolved: on Done.
        {
          id: "d-1293",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Review request",
          kindId: "github/review-requested",
          title: "Show stock per warehouse",
          who: "Sanne",
          place: "webshop #1293",
          at: T(1, "08:58"),
          event: "github.notification",
          eventTitle: "Sanne requested your review on #1293",
          ref: "github:pr:rogier/webshop#1293",
          thread: "webshop #1293",
          asked: "Sanne asked at 08:58.",
          blocks: [{ type: "change", files: 9, plus: 210, minus: 44, from: "sanne/stock-per-warehouse", to: "main", checks: "4 checks passed" }],
          answers: [],
          open: "Open on GitHub",
          raised: "GitHub plugin · <code>github.notification</code> with reason <code>review_requested</code>",
          resolution: resolved("answer", T(1, "10:42"), "Approved #1293", { describe: "Approves pull request <b>#1293</b> in <b>rogier/webshop</b> as <b>rogier</b>", fine: "GitHub · rogier" }),
        },
        {
          id: "d-pay209",
          group: "asks",
          src: "linear",
          system: "Linear",
          kind: "Question for you",
          kindId: "linear/mentioned",
          title: "Currency for refunds in the ledger",
          who: "Jonas",
          place: "PAY-209",
          at: T(1, "08:12"),
          event: "linear.comment.created",
          eventTitle: "Jonas mentioned you on PAY-209",
          ref: "linear:issue:PAY-209",
          thread: "PAY-209",
          asked: "Jonas mentioned you at 08:12.",
          blocks: [{ type: "words", who: "Jonas", at: "08:12", text: '<span class="b-at">@rogier</span> do refunds go into the ledger in the customer\'s currency, or in euros?' }],
          answers: [],
          open: "Open in Linear",
          raised: "Linear plugin · <code>linear.comment.created</code> that mentions you",
          resolution: resolved("elsewhere", T(1, "10:15"), "Answered in Linear", {
            describe: "You commented on <b>PAY-209</b> in Linear, so the Linear plugin took it off your list",
            reply: "Both. Keep the customer's currency and the euro amount on every ledger line.",
          }),
        },
        {
          id: "d-flaky",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Checks failed on your PR",
          kindId: "github/checks-failed",
          title: "Round cart totals once, at checkout",
          who: "GitHub Actions",
          place: "webshop #1292",
          at: T(1, "09:31"),
          event: "github.check_suite",
          eventTitle: "Checks failed on #1292",
          ref: "github:pr:rogier/webshop#1292",
          thread: "webshop #1292",
          asked: "The checks on your pull request finished at 09:31.",
          blocks: [
            {
              type: "checks",
              rows: [
                { state: "failed", name: "test / cart", time: "1m 48s", log: "✕ cart › totals › applies the discount before VAT\n  timed out after 5000 ms" },
                { state: "done", name: "typecheck", time: "58s" },
              ],
            },
          ],
          answers: [],
          open: "Open on GitHub",
          raised: "GitHub plugin · <code>github.check_suite</code> completed with a failure, on a pull request you opened",
          resolution: resolved("hand", T(1, "09:47"), "Handed to Fix bug", {
            face: "Fix bug",
            describe: "Starts <b>Fix bug</b> on <b>webshop</b> with pull request <b>#1292</b> and the failing check <b>test / cart</b>",
            fine: WORKER["Fix bug"],
          }),
        },
        {
          id: "d-releases",
          group: "asks",
          src: "slack",
          system: "Slack",
          kind: "Tagged in a thread",
          kindId: "slack/mentioned",
          title: "Is the acceptance deploy blocked?",
          who: "Jonas",
          place: "#releases",
          at: T(1, "09:22"),
          event: "slack.message",
          eventTitle: "Jonas mentioned you in #releases",
          ref: "slack:thread:C04RELEAS/1790926920.000700",
          thread: "#releases · Acceptance deploy",
          asked: "Jonas tagged you at 09:22.",
          blocks: [{ type: "thread", messages: [{ who: "Jonas", at: "09:22", mine: true, text: '<span class="b-at">@rogier</span> is the acceptance deploy blocked on the migration?' }] }],
          answers: [],
          open: "Open in Slack",
          raised: "Slack plugin · a message in a thread that mentions you",
          resolution: resolved("answer", T(1, "09:31"), "Replied in #releases", {
            describe: "Posts your reply in the <b>#releases</b> thread as <b>@rogier</b>",
            fine: "Slack · acme",
            reply: "Not blocked. The migration runs first, then the deploy goes.",
          }),
        },
        {
          id: "d-1282",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Review request",
          kindId: "github/review-requested",
          title: "Remove the old promo flag",
          who: "Sanne",
          place: "webshop #1282",
          at: T(0, "16:10"),
          event: "github.notification",
          eventTitle: "Sanne requested your review on #1282",
          ref: "github:pr:rogier/webshop#1282",
          thread: "webshop #1282",
          asked: "Sanne asked yesterday at 16:10.",
          blocks: [{ type: "change", files: 3, plus: 4, minus: 61, from: "sanne/drop-promo-flag", to: "main", checks: "4 checks passed" }],
          answers: [],
          open: "Open on GitHub",
          raised: "GitHub plugin · <code>github.notification</code> with reason <code>review_requested</code>",
          snooze: { at: T(0, "16:20"), until: T(1, "11:00") },
          resolution: resolved("elsewhere", T(1, "09:05"), "Reviewed on GitHub", { describe: "You approved <b>#1282</b> on GitHub, so the GitHub plugin took it off your list" }),
        },
        {
          id: "d-pay200",
          group: "asks",
          src: "linear",
          system: "Linear",
          kind: "Assigned to you",
          kindId: "linear/assigned",
          title: "Write the weekly planning notes",
          who: "Sanne",
          place: "PAY-200",
          at: T(1, "08:30"),
          event: "linear.issue.updated",
          eventTitle: "Sanne assigned you PAY-200",
          ref: "linear:issue:PAY-200",
          thread: "PAY-200",
          asked: "Sanne assigned it to you at 08:30.",
          blocks: [{ type: "fields", rows: [["Status", "Todo"], ["Cycle", "41, ends Friday"], ["Team", "Payments"]] }],
          answers: [],
          open: "Open in Linear",
          raised: "Linear plugin · <code>linear.issue.updated</code> that assigns it to you",
          resolution: resolved("done", T(1, "08:40"), "Done, nothing sent", { describe: "Takes it off your list. Linear is not told" }),
        },
        {
          id: "d-1286",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Review request",
          kindId: "github/review-requested",
          title: "Try the new checkout copy",
          who: "Pieter",
          place: "webshop #1286",
          at: T(0, "15:40"),
          event: "github.notification",
          eventTitle: "Pieter requested your review on #1286",
          ref: "github:pr:rogier/webshop#1286",
          thread: "webshop #1286",
          asked: "Pieter asked yesterday at 15:40.",
          blocks: [{ type: "change", files: 2, plus: 18, minus: 18, from: "pieter/checkout-copy", to: "main", checks: "4 checks passed" }],
          answers: [],
          open: "Open on GitHub",
          raised: "GitHub plugin · <code>github.notification</code> with reason <code>review_requested</code>",
          resolution: resolved("withdrawn", T(1, "08:15"), "Withdrawn", { describe: "Pieter closed #1286 without merging it" }),
        },
        {
          id: "d-tokens",
          group: "asks",
          src: "slack",
          system: "Slack",
          kind: "Group mention",
          kindId: "slack/group-mentioned",
          title: "Dark mode tokens are ready for review",
          who: "Sanne",
          place: "#frontend",
          at: T(0, "16:40"),
          event: "slack.message",
          eventTitle: "Sanne mentioned @frontend in #frontend",
          ref: "slack:thread:C03FRONT1/1790858400.112300",
          thread: "#frontend · Dark mode tokens",
          asked: "Sanne mentioned @frontend, a group you are in, yesterday at 16:40.",
          blocks: [{ type: "thread", messages: [{ who: "Sanne", at: "16:40", mine: true, text: '<span class="b-at">@frontend</span> the dark mode tokens are ready for review. Comments in the thread, please.' }] }],
          answers: [],
          open: "Open in Slack",
          raised: "Slack plugin · a message that mentions a group you are in",
          resolution: resolved("stop", T(0, "16:52"), "Stopped asking", { describe: "Stops asks about <b>#frontend · Dark mode tokens</b> here, unless someone names you. Slack still notifies you" }),
        },
        {
          id: "d-1288",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Changes requested",
          kindId: "github/changes-requested",
          title: "Coupon field loses focus on mobile",
          who: "Sanne",
          place: "webshop #1288",
          at: T(0, "14:30"),
          event: "github.pull_request_review",
          eventTitle: "Sanne requested changes on #1288",
          ref: "github:pr:rogier/webshop#1288",
          thread: "webshop #1288",
          asked: "Sanne reviewed your pull request yesterday at 14:30.",
          blocks: [{ type: "thread", messages: [{ who: "Sanne", at: "src/cart/coupon.tsx:27", file: true, text: "This re-renders the whole form on every key. Keep the input outside the list." }] }],
          answers: [],
          open: "Open on GitHub",
          raised: "GitHub plugin · <code>github.pull_request_review</code> on your pull request, state <code>changes_requested</code>",
          resolution: resolved("hand", T(0, "15:20"), "Handed to Address review", {
            face: "Address review",
            describe: "Starts <b>Address review</b> on <b>webshop</b> with pull request <b>#1288</b> and its <b>1</b> review comment",
            fine: WORKER["Address review"],
          }),
        },
      ],
      events: [
        ev(T(1, "11:15"), "slack", "slack.message", "Marta in #payments: is the refund API frozen for this cycle?", "pending", { ref: "slack:message:C02PAYMNT/1790932500.001200" }),
        ev(T(1, "11:10"), "slack", "slack.message", "Sanne in #webshop: acceptance is green again after the restart", "pending", { ref: "slack:message:C02WEBSHP/1790932200.000400" }),
        ev(T(1, "10:58"), "github", "github.check_suite", "Checks passed on #1301 Track coupon usage per campaign", "none", { ref: "github:pr:rogier/webshop#1301", reason: "Checks on someone else's pull request" }),
        ev(T(1, "10:50"), "github", "github.deployment_status", "webshop deployed to acceptance", "fyi", { ref: "github:deployment:rogier/webshop/5521" }),
        ev(T(1, "10:47"), "github", "github.pull_request", "Pieter merged #1301 Track coupon usage per campaign", "none", { ref: "github:pr:rogier/webshop#1301", reason: "Not yours, and nobody asked you" }),
        ev(T(1, "10:36"), "slack", "slack.message", "Pieter in #general: lunch is at 12:30 today", "none", { ref: "slack:message:C01GENERL/1790930160.000900", reason: "Nothing asked of anyone" }),
        ev(T(1, "10:31"), "slack", "slack.message", "Sanne in #frontend: @frontend can someone check the contrast on the dark tokens?", "stopped", {
          ref: "slack:thread:C03FRONT1/1790858400.112300",
          body: { who: "Sanne", at: "10:31", text: '<span class="b-at">@frontend</span> can someone check the contrast on the dark tokens? The muted grey looks too light to me.' },
        }),
        ev(T(1, "10:12"), "linear", "linear.issue.updated", "Jonas moved PAY-215 to In progress", "none", { ref: "linear:issue:PAY-215", reason: "A status change, nothing to decide" }),
        ev(T(1, "10:05"), "sentry", "sentry.issue.updated", "18 more events on WEBSHOP-3DS", "known", { ref: "sentry:issue:WEBSHOP-3DS", task: "Fix 3-D Secure checkout for EU cards" }),
        ev(T(1, "10:02"), "grafana", "grafana.alert", "ops-db backup ran 4h 10m, limit 3h", "proposal", { ref: "grafana:alert:ops-db-backup", item: "backup" }),
        ev(T(1, "09:58"), "github", "github.pull_request", "Dependabot opened #1297 Bump stripe from 18.2.0 to 18.2.1", "offer", { ref: "github:pr:rogier/webshop#1297", item: "deps" }),
        ev(T(1, "09:50"), "github", "github.pull_request", "Marta opened #1302 Add Klarna to the payment options", "none", { ref: "github:pr:rogier/webshop#1302", reason: "Not yours, and nobody asked you" }),
        ev(T(1, "09:30"), "intercom", "intercom.conversation.created", "The app is so slow on my Pixel", "unsure", { ref: "intercom:conversation:7731", item: "android" }),
        ev(T(1, "09:25"), "sentry", "sentry.issue.created", "New issue: ResizeObserver loop limit exceeded", "none", { ref: "sentry:issue:WEBSHOP-41F", reason: "Known browser noise, 2 events" }),
        ev(T(1, "09:12"), "intercom", "intercom.conversation.created", "My card keeps failing at checkout", "attached", {
          ref: "intercom:conversation:7728",
          task: "Fix 3-D Secure checkout for EU cards",
          body: { who: "Eva Smit", at: "09:12", text: "I tried three times with my bank card. It asks for the code, and then the page goes blank." },
        }),
        ev(T(1, "08:44"), "slack", "slack.message", "Jonas in #payments: standup moves to 10:00", "none", { ref: "slack:message:C02PAYMNT/1790923440.000300", reason: "Nothing asked of you" }),
        ev(T(1, "08:05"), "linear", "linear.issue.created", "Sanne created PAY-218 Show refunds in the customer portal", "none", { ref: "linear:issue:PAY-218", reason: "Not assigned to you" }),
        ev(T(1, "07:30"), "linear", "linear.issue.updated", "Jonas moved PAY-208 to Done", "none", { ref: "linear:issue:PAY-208", reason: "A status change, nothing to decide" }),
        ev(T(1, "06:00"), "cron", "cron.run.failed", "nightly-backup failed after 3h", "proposal", { ref: "cron:run:nightly-backup/1002", item: "backup" }),
        ev(T(0, "18:10"), "github", "github.pull_request", "Pieter merged #1285 Show delivery dates in the cart", "none", { ref: "github:pr:rogier/webshop#1285", reason: "Not yours, and nobody asked you" }),
        ev(T(0, "14:02"), "sentry", "sentry.release", "Release webshop@2026.10.01.1 deployed", "none", { ref: "sentry:release:webshop@2026.10.01.1", reason: "A release, nothing failing" }),
        ev(T(0, "11:40"), "slack", "slack.message", "Pieter in #frontend: the new icon set is in Figma", "none", { ref: "slack:message:C03FRONT1/1790854800.000200", reason: "Nothing asked of you" }),
      ],
    },

    noor: {
      selected: "invite",
      triage: { last: T(TODAY, "11:00"), next: T(TODAY, "12:00") },
      sources: ["pagerduty", "gmail", "googlecalendar", "github", "intercom"],
      connections: { pagerduty: "PagerDuty · acme", gmail: "Gmail · work", googlecalendar: "Calendar · work", github: "GitHub · noor-d", intercom: "Intercom · acme", stripe: "Stripe · live", cron: "Cron · ops" },
      stops: [{ ref: "github:pr:acme/infra#88", src: "github", label: "acme/infra #88", since: T(0, "12:10"), until: null }],
      items: [
        {
          id: "page",
          group: "now",
          src: "pagerduty",
          system: "PagerDuty",
          kind: "Page",
          kindId: "pagerduty/page",
          title: "payments-api p95 latency above 2 s",
          who: "PagerDuty",
          place: "on call",
          age: "11:08",
          at: T(1, "11:08"),
          event: "pagerduty.incident.triggered",
          eventTitle: "Incident #4471 triggered: payments-api p95 latency above 2 s",
          ref: "pagerduty:incident:4471",
          state: "Escalates at 11:23",
          stateFail: true,
          asked: "You are on call. PagerDuty paged you at 11:08 and escalates to Pieter at 11:23.",
          blocks: [
            { type: "signal", num: "2.4 s", label: "p95 latency", sub: "above 2 s since 11:06, in 3 of 4 regions" },
            { type: "fields", rows: [["Service", "payments-api"], ["Incident", "#4471"], ["Escalates", "to Pieter at 11:23"]] },
          ],
          answers: [
            act("Acknowledge", "pagerduty/incident.acknowledge", "Acknowledges incident <b>#4471</b> as <b>Noor</b>. The escalation to <b>Pieter</b> stops", "PagerDuty · acme", "Acknowledged #4471"),
            hand("Investigate", 'Start "Investigate"', "Starts <b>Investigate</b> on <b>payments-api</b> with incident <b>#4471</b>", WORKER.Investigate),
          ],
          open: "Open in PagerDuty",
          leaves: "Leaves your list when the incident is acknowledged, here or in PagerDuty.",
          raised: "PagerDuty plugin · <code>pagerduty.incident.triggered</code> while you are on call",
        },
        {
          id: "email",
          group: "asks",
          src: "gmail",
          system: "Gmail",
          kind: "Email for you",
          kindId: "gmail/needs-reply",
          title: "Invoice INV-2291 has our old company name",
          who: "Marta Visser",
          place: "Brightline",
          age: "1h",
          at: T(1, "10:14"),
          event: "gmail.message.received",
          eventTitle: "Marta Visser: Invoice INV-2291 has our old company name",
          ref: "gmail:thread:18f2b7c1d4",
          thread: "Invoice INV-2291 has our old company name",
          back: { at: T(1, "10:20"), until: T(1, "11:00") },
          waiting: true,
          asked: "Marta Visser wrote at 10:14. Their books close on Friday.",
          blocks: [
            {
              type: "words",
              who: "Marta Visser",
              at: "10:14",
              text: "Hi Noor, invoice INV-2291 still shows Brightline Retail B.V. We have been Brightline Group since August. Could you send a corrected one? Our books close on Friday.",
            },
          ],
          answers: [
            reply("Reply", "gmail/message.reply", "Sends your reply to <b>Marta Visser</b> from <b>noor@acme.dev</b>", "Gmail · work", "Reply to Marta…", "Replied to Marta"),
            hand("Draft reply", 'Start "Draft reply"', "Starts <b>Draft reply</b> with this email. You see the draft before anything is sent", WORKER["Draft reply"]),
            done("Gmail"),
          ],
          open: "Open in Gmail",
          leaves: "Leaves your list when you reply, here or in Gmail.",
          raised: "Gmail plugin · <code>gmail.message.received</code>, addressed to you and not a newsletter",
        },
        {
          id: "invite",
          group: "asks",
          src: "googlecalendar",
          system: "Calendar",
          kind: "Invitation",
          kindId: "calendar/invited",
          title: "Q4 roadmap review",
          who: "Sanne",
          place: "Tuesday 14:00",
          age: "1h",
          at: T(1, "10:20"),
          event: "calendar.event.invited",
          eventTitle: "Sanne invited you to Q4 roadmap review",
          ref: "calendar:event:q4-roadmap-1006",
          asked: "Sanne invited you at 10:20. 4 of 6 guests have accepted.",
          blocks: [
            {
              type: "when",
              day: "Tuesday 6 October",
              from: 13,
              to: 16,
              slots: [
                { start: 13, end: 13.5, name: "Lunch" },
                { start: 14, end: 15, name: "Q4 roadmap review", ask: true },
                { start: 14.5, end: 15, name: "1:1 Pieter", clash: true },
              ],
              note: "Overlaps <b>1:1 Pieter</b> from 14:30 to 15:00",
            },
          ],
          answers: [
            act("Accept", "calendar/event.respond", "Accepts <b>Q4 roadmap review</b> on <b>Tuesday 14:00</b> as <b>noor@acme.dev</b>. <b>1:1 Pieter</b> still overlaps", "Calendar · work", "Accepted"),
            reply("Decline…", "calendar/event.respond", "Declines <b>Q4 roadmap review</b> and sends your note to <b>Sanne</b>", "Calendar · work", "A note for Sanne…", "Declined"),
          ],
          open: "Open in Calendar",
          leaves: "Leaves your list when you answer the invitation, here or in Calendar.",
          raised: "Calendar plugin · <code>calendar.event.invited</code> with your answer still open",
        },
        {
          id: "deploy",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Deployment approval",
          kindId: "github/deployment-review",
          title: "Deploy payments-api v2.15.0 to production",
          who: "Pieter",
          place: "acme/payments-api",
          age: "25m",
          at: T(1, "10:55"),
          event: "github.deployment_review.requested",
          eventTitle: "Pieter's deployment of payments-api v2.15.0 waits for your review",
          ref: "github:deployment:acme/payments-api/8812",
          waiting: true,
          asked: "Pieter started the deployment at 10:55. It waits for your approval.",
          blocks: [{ type: "change", files: 31, plus: 880, minus: 214, from: "v2.14.0", to: "v2.15.0", checks: "12 commits · 4 checks passed" }],
          answers: [
            act("Approve", "github/deployment.review", "Approves the <b>production</b> deployment of <b>v2.15.0</b> in <b>acme/payments-api</b> as <b>noor-d</b>", "GitHub · noor-d", "Approved v2.15.0"),
            reply("Reject…", "github/deployment.review", "Rejects the deployment of <b>v2.15.0</b> with your comment", "GitHub · noor-d", "Why not now…", "Rejected v2.15.0"),
          ],
          open: "Open on GitHub",
          leaves: "Leaves your list when someone reviews the deployment, here or on GitHub.",
          raised: "GitHub plugin · <code>github.deployment_review.requested</code> for an environment you protect",
        },
        {
          id: "intercom",
          group: "asks",
          src: "intercom",
          system: "Intercom",
          kind: "Assigned to you",
          kindId: "intercom/assigned",
          title: "Card payments fail at checkout since this morning",
          who: "Kiteworks",
          place: "Support",
          age: "18m",
          at: T(1, "11:02"),
          event: "intercom.conversation.assigned",
          eventTitle: "Sanne assigned you the Kiteworks conversation",
          ref: "intercom:conversation:5521",
          thread: "the Kiteworks conversation",
          waiting: true,
          asked: "Assigned to you at 11:02. Kiteworks is waiting on an answer.",
          blocks: [
            {
              type: "thread",
              messages: [
                { who: "Jonas at Kiteworks", at: "10:55", text: "Our customers can't pay with cards since this morning. Is this on your side?" },
                { who: "Sanne", at: "11:02", note: true, text: "Assigned to Noor." },
              ],
            },
          ],
          answers: [reply("Reply", "intercom/conversation.reply", "Sends your reply in the <b>Kiteworks</b> conversation as <b>Noor</b>", "Intercom · acme", "Reply to Kiteworks…", "Replied to Kiteworks"), done("Intercom")],
          open: "Open in Intercom",
          leaves: "Leaves your list when you reply or close the conversation, here or in Intercom.",
          raised: "Intercom plugin · <code>intercom.conversation.assigned</code> to you",
        },
        {
          id: "webhooks",
          group: "triage",
          src: "stripe",
          system: "Stripe",
          kind: "Proposal",
          title: "Stripe webhook retries rising",
          who: "Triage",
          place: "payments-api",
          age: "11:00",
          at: T(1, "11:00"),
          line: "Proposal · payments-api · up 4x since Sunday",
          asked: "Triage proposed this at 11:00.",
          blocks: [
            { type: "gist", text: "Stripe has retried four times as many webhooks since Sunday. Most retries follow a timeout from payments-api." },
            { type: "sources", rows: [{ src: "stripe", text: "<b>312</b> retried webhooks since Sunday" }] },
          ],
          answers: [
            hand("Investigate", null, "Starts <b>Investigate</b> on <b>payments-api</b> with task <b>Stripe webhook retries rising</b>", WORKER.Investigate),
            accept("Stripe webhook retries rising"),
            dismiss("Stripe webhook retries rising"),
          ],
          leaves: "Leaves your list when you answer it.",
          raised: "Triage at 11:00 · <code>triage.proposal</code>",
        },
        {
          id: "cert",
          group: "triage",
          src: "cron",
          system: "Cron",
          kind: "Offer",
          title: "Renew the certificate for status.acme.dev",
          who: "Triage",
          place: "ops",
          age: "11:00",
          at: T(1, "11:00"),
          line: "Offer · ops · expires in 12 days",
          asked: "Triage offered this at 11:00.",
          blocks: [
            { type: "gist", text: "The certificate for status.acme.dev expires on 14 October. It is the only one not renewed automatically." },
            { type: "sources", rows: [{ src: "cron", text: "<b>1</b> warning from the daily certificate check" }] },
          ],
          answers: [hand("Renew certificate", null, "Starts <b>Renew certificate</b> on <b>ops</b> for <b>status.acme.dev</b>", WORKER["Renew certificate"]), dismiss(null)],
          leaves: "Leaves your list when you answer it.",
          raised: "Triage at 11:00 · <code>triage.offer</code>",
        },

        // Snoozed: on Later.
        {
          id: "n-offsite",
          group: "asks",
          src: "googlecalendar",
          system: "Calendar",
          kind: "Invitation",
          kindId: "calendar/invited",
          title: "Offsite planning",
          who: "Pieter",
          place: "Wednesday 10:00",
          age: "1h",
          at: T(1, "09:50"),
          event: "calendar.event.invited",
          eventTitle: "Pieter invited you to Offsite planning",
          ref: "calendar:event:offsite-planning-1007",
          snooze: { at: T(1, "09:52"), until: T(1, "14:00") },
          asked: "Pieter invited you at 09:50. 3 of 5 guests have accepted.",
          blocks: [{ type: "fields", rows: [["When", "Wednesday 7 October, 10:00 to 12:00"], ["Where", "Room Amstel"], ["Guests", "5, 3 accepted"]] }],
          answers: [
            act("Accept", "calendar/event.respond", "Accepts <b>Offsite planning</b> on <b>Wednesday 10:00</b> as <b>noor@acme.dev</b>", "Calendar · work", "Accepted"),
            reply("Decline…", "calendar/event.respond", "Declines <b>Offsite planning</b> and sends your note to <b>Pieter</b>", "Calendar · work", "A note for Pieter…", "Declined"),
          ],
          open: "Open in Calendar",
          leaves: "Leaves your list when you answer the invitation, here or in Calendar.",
          raised: "Calendar plugin · <code>calendar.event.invited</code> with your answer still open",
        },
        {
          id: "n-contract",
          group: "asks",
          src: "gmail",
          system: "Gmail",
          kind: "Email for you",
          kindId: "gmail/needs-reply",
          title: "Renewal terms for 2027",
          who: "Ilse de Wit",
          place: "Legal",
          age: "1d",
          at: T(0, "16:30"),
          event: "gmail.message.received",
          eventTitle: "Ilse de Wit: Renewal terms for 2027",
          ref: "gmail:thread:18f2c0a9e1",
          thread: "Renewal terms for 2027",
          snooze: { at: T(0, "16:45"), until: T(4, "09:00") },
          asked: "Ilse de Wit wrote yesterday at 16:30.",
          blocks: [{ type: "words", who: "Ilse de Wit", at: "yesterday 16:30", text: "Hi Noor, the renewal terms for 2027 are attached. Can you confirm the payment terms by 9 October?" }],
          answers: [
            reply("Reply", "gmail/message.reply", "Sends your reply to <b>Ilse de Wit</b> from <b>noor@acme.dev</b>", "Gmail · work", "Reply to Ilse…", "Replied to Ilse"),
            hand("Draft reply", 'Start "Draft reply"', "Starts <b>Draft reply</b> with this email. You see the draft before anything is sent", WORKER["Draft reply"]),
            done("Gmail"),
          ],
          open: "Open in Gmail",
          leaves: "Leaves your list when you reply, here or in Gmail.",
          raised: "Gmail plugin · <code>gmail.message.received</code>, addressed to you and not a newsletter",
        },

        // Resolved: on Done.
        {
          id: "n-call",
          group: "asks",
          src: "gmail",
          system: "Gmail",
          kind: "Email for you",
          kindId: "gmail/needs-reply",
          title: "Can we move Thursday's call?",
          who: "Pieter",
          place: "Pieter",
          at: T(1, "09:40"),
          event: "gmail.message.received",
          eventTitle: "Pieter: Can we move Thursday's call?",
          ref: "gmail:thread:18f2b2e7a0",
          thread: "Can we move Thursday's call?",
          asked: "Pieter wrote at 09:40.",
          blocks: [{ type: "words", who: "Pieter", at: "09:40", text: "Hi Noor, something came up on Thursday morning. Can we move our call to the afternoon?" }],
          answers: [],
          open: "Open in Gmail",
          raised: "Gmail plugin · <code>gmail.message.received</code>, addressed to you and not a newsletter",
          resolution: resolved("answer", T(1, "10:02"), "Replied to Pieter", {
            describe: "Sends your reply to <b>Pieter</b> from <b>noor@acme.dev</b>",
            fine: "Gmail · work",
            reply: "Thursday 15:00 works for me. I moved it.",
          }),
        },
        {
          id: "n-refund",
          group: "asks",
          src: "intercom",
          system: "Intercom",
          kind: "Assigned to you",
          kindId: "intercom/assigned",
          title: "Refund for order 88231",
          who: "Lotte Bakker",
          place: "Support",
          at: T(1, "09:05"),
          event: "intercom.conversation.assigned",
          eventTitle: "Sanne assigned you the conversation with Lotte Bakker",
          ref: "intercom:conversation:5517",
          thread: "the conversation with Lotte Bakker",
          asked: "Assigned to you at 09:05.",
          blocks: [{ type: "thread", messages: [{ who: "Lotte Bakker", at: "09:01", text: "I returned order 88231 two weeks ago and still have no refund." }] }],
          answers: [],
          open: "Open in Intercom",
          raised: "Intercom plugin · <code>intercom.conversation.assigned</code> to you",
          resolution: resolved("hand", T(1, "09:20"), "Handed to Draft reply", {
            face: "Draft reply",
            describe: "Starts <b>Draft reply</b> with this conversation. You see the draft before anything is sent",
            fine: WORKER["Draft reply"],
          }),
        },
        {
          id: "n-sync",
          group: "asks",
          src: "googlecalendar",
          system: "Calendar",
          kind: "Invitation",
          kindId: "calendar/invited",
          title: "Payments sync",
          who: "Jonas",
          place: "Monday 10:00",
          at: T(1, "08:50"),
          event: "calendar.event.invited",
          eventTitle: "Jonas invited you to Payments sync",
          ref: "calendar:event:payments-sync-1005",
          asked: "Jonas invited you at 08:50.",
          blocks: [{ type: "fields", rows: [["When", "Monday 5 October, 10:00 to 10:30"], ["Guests", "4"]] }],
          answers: [],
          open: "Open in Calendar",
          raised: "Calendar plugin · <code>calendar.event.invited</code> with your answer still open",
          resolution: resolved("elsewhere", T(1, "09:12"), "Answered in Calendar", { describe: "You accepted it in Calendar, so the Calendar plugin took it off your list" }),
        },
        {
          id: "n-disk",
          group: "now",
          src: "pagerduty",
          system: "PagerDuty",
          kind: "Page",
          kindId: "pagerduty/page",
          title: "Disk 85% full on db-2",
          who: "PagerDuty",
          place: "on call",
          at: T(1, "07:40"),
          event: "pagerduty.incident.triggered",
          eventTitle: "Incident #4469 triggered: Disk 85% full on db-2",
          ref: "pagerduty:incident:4469",
          asked: "You are on call. PagerDuty paged you at 07:40.",
          blocks: [{ type: "signal", num: "85%", label: "disk used on db-2", sub: "above 80% since 07:38" }],
          answers: [],
          open: "Open in PagerDuty",
          raised: "PagerDuty plugin · <code>pagerduty.incident.triggered</code> while you are on call",
          resolution: resolved("withdrawn", T(1, "07:55"), "Withdrawn", { describe: "The incident resolved on its own after the log rotation ran" }),
        },
        {
          id: "n-deploy",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Deployment approval",
          kindId: "github/deployment-review",
          title: "Deploy payments-api v2.14.2 to production",
          who: "Pieter",
          place: "acme/payments-api",
          at: T(0, "14:50"),
          event: "github.deployment_review.requested",
          eventTitle: "Pieter's deployment of payments-api v2.14.2 waits for your review",
          ref: "github:deployment:acme/payments-api/8790",
          asked: "Pieter started the deployment yesterday at 14:50.",
          blocks: [{ type: "change", files: 4, plus: 38, minus: 9, from: "v2.14.1", to: "v2.14.2", checks: "3 commits · 4 checks passed" }],
          answers: [],
          open: "Open on GitHub",
          raised: "GitHub plugin · <code>github.deployment_review.requested</code> for an environment you protect",
          resolution: resolved("answer", T(0, "15:05"), "Approved v2.14.2", {
            describe: "Approves the <b>production</b> deployment of <b>v2.14.2</b> in <b>acme/payments-api</b> as <b>noor-d</b>",
            fine: "GitHub · noor-d",
          }),
        },
        {
          id: "n-board",
          group: "asks",
          src: "gmail",
          system: "Gmail",
          kind: "Email for you",
          kindId: "gmail/needs-reply",
          title: "Quarterly numbers for the board",
          who: "Femke Jansen",
          place: "Finance",
          at: T(0, "16:10"),
          event: "gmail.message.received",
          eventTitle: "Femke Jansen: Quarterly numbers for the board",
          ref: "gmail:thread:18f2a4410b",
          thread: "Quarterly numbers for the board",
          asked: "Femke Jansen wrote yesterday at 16:10.",
          blocks: [{ type: "words", who: "Femke Jansen", at: "yesterday 16:10", text: "Noor, the Q3 numbers for the board deck are in the shared folder. No action needed unless something looks off." }],
          answers: [],
          open: "Open in Gmail",
          raised: "Gmail plugin · <code>gmail.message.received</code>, addressed to you and not a newsletter",
          resolution: resolved("done", T(0, "17:30"), "Done, nothing sent", { describe: "Takes it off your list. Gmail is not told" }),
        },
        {
          id: "n-infra88",
          group: "asks",
          src: "github",
          system: "GitHub",
          kind: "Review request for your team",
          kindId: "github/team-review-requested",
          title: "Bump the Terraform AWS provider to 6.2",
          who: "Pieter",
          place: "acme/infra #88",
          at: T(0, "11:50"),
          event: "github.notification",
          eventTitle: "Review requested from @acme/platform on acme/infra #88",
          ref: "github:pr:acme/infra#88",
          thread: "acme/infra #88",
          asked: "Pieter asked @acme/platform, a team you are in, yesterday at 11:50.",
          blocks: [{ type: "change", files: 3, plus: 12, minus: 12, from: "pieter/aws-6.2", to: "main", checks: "2 checks passed" }],
          answers: [],
          open: "Open on GitHub",
          raised: "GitHub plugin · <code>github.notification</code> with reason <code>team_mention</code>",
          resolution: resolved("stop", T(0, "12:10"), "Stopped asking", { describe: "Stops asks about <b>acme/infra #88</b> here, unless someone names you. GitHub still notifies you" }),
        },
      ],
      events: [
        ev(T(1, "11:12"), "intercom", "intercom.conversation.created", "Northwind: where do I change my billing email?", "pending", { ref: "intercom:conversation:5523" }),
        ev(T(1, "10:52"), "github", "github.notification", "Review requested again from @acme/platform on acme/infra #88", "stopped", { ref: "github:pr:acme/infra#88" }),
        ev(T(1, "10:48"), "gmail", "gmail.message.received", "Pieter: Notes from the vendor call", "none", { ref: "gmail:thread:18f2b9d002", reason: "Sent to the team list, nothing asked of you" }),
        ev(T(1, "10:40"), "stripe", "stripe.webhook.retried", "Webhook endpoint failing: 41 retries in the last hour", "proposal", { ref: "stripe:webhook_endpoint:we_payments_api", item: "webhooks" }),
        ev(T(1, "10:30"), "gmail", "gmail.message.received", "The Payments Weekly #212", "none", { ref: "gmail:thread:18f2b8a1f3", reason: "A newsletter" }),
        ev(T(1, "09:58"), "github", "github.pull_request", "Marta merged acme/infra #87 Rotate the staging keys", "none", { ref: "github:pr:acme/infra#87", reason: "Not yours, and nobody asked you" }),
        ev(T(1, "09:30"), "googlecalendar", "calendar.event.updated", "Sanne moved Design sync to 15:30", "none", { ref: "calendar:event:design-sync-1002", reason: "You had already accepted it" }),
        ev(T(1, "09:15"), "intercom", "intercom.conversation.replied", "Hollandia: thanks, that fixed it", "none", { ref: "intercom:conversation:5509", reason: "The conversation was already closed" }),
        ev(T(1, "08:30"), "gmail", "gmail.message.received", "AWS: your invoice for September is available", "none", { ref: "gmail:thread:18f2b40c77", reason: "A receipt" }),
        ev(T(1, "08:00"), "cron", "cron.run.completed", "Certificate check: status.acme.dev expires in 12 days", "offer", { ref: "cron:run:cert-check/1002", item: "cert" }),
        ev(T(1, "07:20"), "stripe", "stripe.payout.paid", "Payout of €48,210.55 sent to your bank", "fyi", { ref: "stripe:payout:po_1Q8x2" }),
        ev(T(0, "18:00"), "pagerduty", "pagerduty.incident.resolved", "Incident #4460 resolved", "none", { ref: "pagerduty:incident:4460", reason: "Resolved, nothing to do" }),
        ev(T(0, "13:30"), "gmail", "gmail.message.received", "Facilities: the office move is on 16 October", "none", { ref: "gmail:thread:18f29e5531", reason: "Sent to all staff, nothing asked of you" }),
      ],
    },
  };

  /* ------------------------------------------------------------------ state */

  var user = USERS[userKey];
  var items = user.items;
  var stops = user.stops;
  var events = buildEvents();
  var MODES = ["todo", "later", "done", "everything"];
  var mode = MODES.indexOf(params.get("mode")) >= 0 ? params.get("mode") : "todo";
  var filter = params.get("filter") || "all";
  var stampFilter = params.get("stamp") || "all";
  var query = "";
  // Each view remembers its own selection, so switching views and back lands where you were.
  var selected = { todo: user.selected, later: null, done: null, everything: null };
  var toast = null;
  var toastSerial = 0;
  // The open snooze menu: the asks it snoozes, and where it opens. "pane" is under the open item,
  // "row" at the row it was opened from, "bar" above the bar for checked rows. Null when closed.
  var snoozeMenu = null;
  // The rows checked for one action on all of them, by id. Checks belong to the list on screen.
  var checked = [];
  var lastChange = null;
  // Whether you want the open item beside the list. The pane shows only while a record is selected,
  // so an empty list always has the full width.
  var paneWanted = params.get("pane") !== "closed";
  // Which list the page last drew, and how the next drawing moves: "in place" when it redraws that
  // same list, so the changes to it move; "at once" for another list, which appears without motion;
  // "first" for the page's first drawing.
  var drawnList = null;
  var motion = "first";

  var GROUPS = [
    { key: "now", label: "Now" },
    { key: "asks", label: "Asks" },
    { key: "triage", label: "From triage" },
  ];

  var SNOOZE_PRESETS = [
    { label: "In 1 hour", at: NOW + 60 },
    { label: "This afternoon", at: T(TODAY, "14:00") },
    { label: "Tomorrow", at: T(TODAY + 1, "09:00") },
    { label: "Monday", at: T(TODAY + 3, "09:00") },
    { label: "Pick a time…", at: null },
  ];

  /** Returns every event of the user, newest first: the fixtures, plus the event that raised each ask. */
  function buildEvents() {
    var list = user.events.map(function (e, i) {
      e.id = "ev-" + i;
      return e;
    });
    items.forEach(function (it) {
      if (!it.event) return;
      list.push({ id: "ev-" + it.id, t: it.at, src: it.src, type: it.event, title: it.eventTitle, stamp: "ask", ref: it.ref, item: it.id });
    });
    return list.sort(function (a, b) {
      return b.t - a.t;
    });
  }

  /** Returns the view an item belongs in: "done" once resolved, "later" while snoozed, otherwise "todo". */
  function readView(it) {
    if (it.resolution) return "done";
    if (it.snooze) return "later";
    return "todo";
  }

  /** Checks whether a record (an item or an event) belongs under the current tab. */
  function isInTab(record) {
    if (filter === "all") return true;
    if (record.stamp) return filter === "triage" ? TRIAGE_STAMPS.indexOf(record.stamp) >= 0 : record.src === filter;
    if (filter === "triage") return record.group === "triage";
    return record.group !== "triage" && record.src === filter;
  }

  /** Checks whether an event matches the search query, on its title, system, type, body and stamp. */
  function matchesQuery(e) {
    if (!query) return true;
    var stamp = describeStamp(e);
    var text = [e.title, SYSTEMS[e.src], e.type, e.body ? e.body.text : "", stamp.label, stamp.detail].join(" ").replace(/<[^>]+>/g, "");
    return text.toLowerCase().indexOf(query.toLowerCase()) >= 0;
  }

  /** Returns the records the list shows, in list order: items in To do, Later and Done, events in Everything. */
  function listRecords() {
    if (mode === "everything") {
      return events.filter(function (e) {
        return isInTab(e) && (stampFilter === "all" || e.stamp === stampFilter) && matchesQuery(e);
      });
    }
    var list = items.filter(function (it) {
      return readView(it) === mode && isInTab(it);
    });
    if (mode === "todo") {
      // By section, then what came back from a snooze, then oldest first: a to-do list, not a feed.
      return list.sort(function (a, b) {
        return rankGroup(a) - rankGroup(b) || (b.back ? 1 : 0) - (a.back ? 1 : 0) || a.at - b.at || items.indexOf(a) - items.indexOf(b);
      });
    }
    if (mode === "later") {
      return list.sort(function (a, b) {
        return a.snooze.until - b.snooze.until;
      });
    }
    return list.sort(function (a, b) {
      return b.resolution.t - a.resolution.t;
    });
  }

  function rankGroup(it) {
    return ["now", "asks", "triage"].indexOf(it.group);
  }

  /** Returns how many items are in a view under the current tab. */
  function countView(view) {
    return items.filter(function (it) {
      return readView(it) === view && isInTab(it);
    }).length;
  }

  /** Returns how many items are on To do under every tab: the number the sidebar shows. */
  function countTodo(src) {
    return items.filter(function (it) {
      if (readView(it) !== "todo") return false;
      if (!src) return true;
      if (src === "triage") return it.group === "triage";
      return it.group !== "triage" && it.src === src;
    }).length;
  }

  /** Returns the items resolved today, newest first. */
  function listClearedToday() {
    return items
      .filter(function (it) {
        return it.resolution && readDay(it.resolution.t) === TODAY;
      })
      .sort(function (a, b) {
        return b.resolution.t - a.resolution.t;
      });
  }

  function findItem(id) {
    return items.filter(function (it) {
      return it.id === id;
    })[0];
  }

  function findEvent(id) {
    return events.filter(function (e) {
      return e.id === id;
    })[0];
  }

  /** Returns the stop that covers a thread ref right now, or undefined when asks about it reach you. */
  function findActiveStop(ref) {
    return stops.filter(function (s) {
      return s.ref === ref && !s.until;
    })[0];
  }

  /** Returns the stop that covered a thread ref at a moment, or undefined when none did. A stop keeps its dates, so past events stay stamped. */
  function findStopAt(ref, t) {
    return stops.filter(function (s) {
      return s.ref === ref && s.since <= t && (!s.until || s.until > t);
    })[0];
  }

  /** Checks whether Stop asking is offered: only on an ask about a thread, never on a page, an invitation or a deployment. */
  function canStop(it) {
    return it.group === "asks" && !!it.thread;
  }

  /** Checks whether Snooze is offered: on anything open except what burns now. */
  function canSnooze(it) {
    return it.group !== "now";
  }

  /* ------------------------------------------------------------------ x-ray labels */

  // Marks an element with who provides it. `from` is "plugin" or "core".
  function x(from, label) {
    return ' data-x="' + label.replace(/"/g, "&quot;") + '" data-x-from="' + from + '"';
  }

  /* ------------------------------------------------------------------ the bar */

  function renderTabs() {
    var html = tab("all", "All", countTodo(), "");
    user.sources.forEach(function (src) {
      html += tab(src, '<i data-brand="' + src + '" data-size="14"></i>' + SYSTEMS[src], countTodo(src), x("plugin", SYSTEMS[src] + " plugin"));
    });
    html += tab("triage", '<i data-face="Triage" data-size="18"></i>Triage', countTodo("triage"), x("core", "Core"));
    document.querySelector("[data-asks-tabs]").innerHTML = html;
  }

  // A tab's count is always its To do count, in every view, and it is left out at zero.
  function tab(key, label, count, xray) {
    return '<a class="tab' + (filter === key ? " is-on" : "") + '" href="#" data-filter="' + key + '"' + xray + ">" + label + (count ? " <small>" + count + "</small>" : "") + "</a>";
  }

  function renderTriageStatus() {
    document.querySelector("[data-asks-triage]").innerHTML =
      '<i data-face="Triage" data-pose="idle" data-size="20"></i><span>Triage ran at <b>' + formatClock(user.triage.last) + "</b> · next at " + formatClock(user.triage.next) + "</span>";
  }

  /* ------------------------------------------------------------------ the list head */

  function renderHead() {
    var later = countView("later");
    var todo = countView("todo");
    var html =
      '<div class="seg asks-modes" role="group" aria-label="View"' +
      x("core", "Core: four views over the same records") +
      ">" +
      modeButton("todo", "To do", todo) +
      modeButton("later", "Later", later) +
      modeButton("done", "Done") +
      modeButton("everything", "Everything") +
      "</div>";
    if (mode === "everything") {
      html +=
        '<div class="asks-find">' +
        '<label class="field asks-search"' +
        x("core", "Needs an API filter: events have no text search yet") +
        '><i data-i="search" data-size="14"></i><input data-search type="search" placeholder="Search events" value="' +
        query.replace(/"/g, "&quot;") +
        '" /></label>' +
        '<label class="field field--select asks-stamp"' +
        x("core", "Core: one stamp per event, the first match wins") +
        "><select data-stamp aria-label=\"Stamp\">" +
        stampOptions() +
        "</select></label></div>";
    }
    document.querySelector("[data-asks-head]").innerHTML = html;
  }

  function modeButton(key, label, count) {
    return '<button data-mode="' + key + '" aria-pressed="' + (mode === key) + '">' + label + (count ? "<small>" + count + "</small>" : "") + "</button>";
  }

  // The options count the events under the current tab and search. A stamp no event has is left
  // out, except "stopped": it is the way to the list of stopped threads.
  function stampOptions() {
    var shown = events.filter(function (e) {
      return isInTab(e) && matchesQuery(e);
    });
    var html = '<option value="all">All events (' + shown.length + ")</option>";
    STAMPS.forEach(function (s) {
      var n = shown.filter(function (e) {
        return e.stamp === s.key;
      }).length;
      if (!n && s.key !== "stopped" && s.key !== stampFilter) return;
      html += '<option value="' + s.key + '"' + (stampFilter === s.key ? " selected" : "") + ">" + s.label + " (" + n + ")</option>";
    });
    return html;
  }

  /* ------------------------------------------------------------------ the list */

  function renderList() {
    var el = document.querySelector("[data-asks-list]");
    var html = mode === "todo" ? buildTodoList() : mode === "later" ? buildLaterList() : mode === "done" ? buildDoneList() : buildEventList();
    if (checked.length) html += buildBulkBar();
    else if (toast) html += buildToast();
    var wasZero = !!el.querySelector(".asks-zero");
    var shownToast = el.querySelector("[data-toast-serial]");
    el.innerHTML = html;
    // A new toast rises into place; one drawn again with the list stays still.
    var newToast = el.querySelector("[data-toast-serial]");
    if (newToast && (!shownToast || shownToast.dataset.toastSerial !== newToast.dataset.toastSerial)) newToast.classList.add("is-new");
    // Inbox zero celebrates when you reach it, or when the page opens on it; not on every visit to To do.
    var zero = el.querySelector(".asks-zero");
    if (zero && !wasZero && motion !== "at once") zero.classList.add("is-arriving");
  }

  /** Returns the name of the current tab for a sentence: "Slack", "triage", or "" under All. */
  function nameTab() {
    if (filter === "all") return "";
    return filter === "triage" ? "triage" : SYSTEMS[filter];
  }

  function buildTodoList() {
    var shown = listRecords();
    if (!shown.length && filter === "all") return buildZero();
    var html = "";
    GROUPS.forEach(function (g) {
      var rows = shown.filter(function (it) {
        return it.group === g.key;
      });
      if (!rows.length) return;
      var right = g.key === "triage" ? '<span class="asks-sec-right">' + countTriageWindow() + " events at " + formatClock(user.triage.last) + "</span>" : "";
      var label = g.key === "now" ? '<span class="dot dot--fail"></span>' + g.label : g.label + ' <span class="count">' + rows.length + "</span>";
      html += '<h2 class="section-h asks-sec" data-flip="sec-' + g.key + '">' + label + right + "</h2>";
      html += '<div class="asks-rows' + (g.key === "triage" ? " asks-rows--quiet" : "") + '">' + rows.map(row).join("") + "</div>";
    });
    if (!shown.length) html += '<p class="asks-empty" data-flip="empty">' + (nameTab() ? "Nothing from " + nameTab() + " waits on you." : "Nothing waits on you.") + "</p>";
    var cleared = listClearedToday();
    var onTheirOwn = cleared.filter(function (it) {
      return it.resolution.how === "elsewhere" || it.resolution.how === "withdrawn";
    }).length;
    html +=
      '<p class="asks-cleared" data-flip="cleared"' +
      x("core", "Core: counted from today's resolutions") +
      ">" +
      cleared.length +
      " cleared today." +
      (onTheirOwn ? " " + onTheirOwn + " of them left on " + (onTheirOwn === 1 ? "its" : "their") + " own: answered elsewhere or withdrawn." : "") +
      ' <a href="#" data-mode="done">See Done</a></p>';
    return html;
  }

  /** Returns how many events the last triage run read: those that arrived in the hour before it and went through triage. */
  function countTriageWindow() {
    return events.filter(function (e) {
      return e.t > user.triage.last - 60 && e.t <= user.triage.last && TRIAGE_STAMPS.indexOf(e.stamp) >= 0;
    }).length;
  }

  function buildLaterList() {
    var shown = listRecords();
    if (!shown.length) return '<p class="asks-empty">' + (nameTab() ? "Nothing from " + nameTab() + " is snoozed." : "Nothing snoozed. Press <kbd>H</kbd> on an ask to snooze it.") + "</p>";
    return buildDaySections(
      shown,
      function (it) {
        return readDay(it.snooze.until);
      },
      function (day) {
        return "Back " + formatDay(day);
      },
      row,
      "",
    );
  }

  function buildDoneList() {
    var shown = listRecords();
    if (!shown.length) return '<p class="asks-empty">' + (nameTab() ? "Nothing from " + nameTab() + " was cleared." : "Nothing cleared yet.") + "</p>";
    return buildDaySections(
      shown,
      function (it) {
        return readDay(it.resolution.t);
      },
      capitalizeDay,
      row,
      " asks-rows--quiet",
    );
  }

  function buildEventList() {
    var shown = listRecords();
    var html = stampFilter === "stopped" ? buildStopList() : "";
    if (!shown.length) return html + '<p class="asks-empty">No events match.</p>';
    return html + buildDaySections(shown, function (e) {
      return readDay(e.t);
    }, capitalizeDay, eventRow, " asks-rows--quiet");
  }

  function capitalizeDay(day) {
    var word = formatDay(day);
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  /** Returns the records under one heading per day, in the order they come in. */
  function buildDaySections(records, readRecordDay, formatHeading, buildRow, rowsClass) {
    var html = "";
    var day = null;
    var rows = [];
    function flush() {
      if (!rows.length) return;
      html += '<h2 class="section-h asks-sec" data-flip="sec-' + day + '">' + formatHeading(day) + ' <span class="count">' + rows.length + "</span></h2>";
      html += '<div class="asks-rows' + rowsClass + '">' + rows.map(buildRow).join("") + "</div>";
    }
    records.forEach(function (r) {
      var d = readRecordDay(r);
      if (d !== day) {
        flush();
        day = d;
        rows = [];
      }
      rows.push(r);
    });
    flush();
    return html;
  }

  // The threads you stopped. Each keeps its dates, so the events it stopped stay stamped "stopped".
  function buildStopList() {
    var active = stops.filter(function (s) {
      return !s.until;
    });
    var rows = active
      .map(function (s) {
        return (
          '<div class="asks-stop"><i data-brand="' + s.src + '" data-size="16"></i>' +
          '<span class="asks-stop-text"><b>' + s.label + "</b><small>Stopped " + formatDate(s.since) + " at " + formatClock(s.since) + "</small></span>" +
          '<button class="btn btn--sm" data-unstop="' + s.ref + '">Ask me again</button></div>'
        );
      })
      .join("");
    return (
      '<section class="asks-stops" data-flip="stops"' +
      x("core", "Core: the stop list, yours only · delayed until much later") +
      '><p class="asks-stops-h">' +
      (active.length ? "Asks about these threads stop here, unless someone names you." : "No threads stopped. Press <kbd>M</kbd> on an ask to stop asks about its thread.") +
      "</p>" +
      rows +
      "</section>"
    );
  }

  /** Returns the kind with its first letter in lower case, for use inside a line: "checks failed on your PR". */
  function lowerFirst(text) {
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  function row(it) {
    var view = readView(it);
    var sub;
    var end;
    var from;
    if (view === "done") {
      var r = it.resolution;
      sub = r.how === "withdrawn" ? "Withdrawn · " + r.describe : r.text;
      end = '<time class="ask-age">' + formatClock(r.t) + "</time>";
      from = x("core", "Core: resolved, and kept");
    } else {
      // A burning item leads with its state instead of the asker, who is the alerting system itself.
      sub = it.line || (it.state ? "" : it.who + " · ") + lowerFirst(it.kind) + " · " + it.place;
      if (it.state) sub = '<span class="ask-state' + (it.stateFail ? " ask-state--fail" : "") + '">' + it.state + "</span> · " + sub;
      if (view === "todo" && it.back) sub = '<span class="ask-state ask-back"><i data-i="alarm" data-size="12"></i>Back</span> · ' + sub;
      if (view === "later") {
        end = '<span class="ask-until"><i data-i="alarm" data-size="12"></i>' + formatShortMoment(it.snooze.until) + "</span>";
        from = x("core", "Core: snoozed by you. The ask stays open");
      } else {
        end = '<time class="ask-age">' + it.age + "</time>" + (it.waiting ? '<span class="ask-waiting">waiting</span>' : "");
        from = it.group === "triage" ? x("core", "Triage: " + it.kind) : x("plugin", it.system + " plugin: ask kind " + it.kindId);
      }
    }
    var acts = buildActs(it);
    var isChecked = checked.indexOf(it.id) >= 0;
    return (
      '<div class="ask-item' +
      (it.id === selected[mode] ? " is-on" : "") +
      (isChecked ? " is-checked" : "") +
      (snoozeMenu && snoozeMenu.place === "row" && snoozeMenu.ids[0] === it.id ? " has-menu" : "") +
      '" data-flip="' +
      it.id +
      '">' +
      (acts
        ? '<button class="ask-check" data-check="' + it.id + '" role="checkbox" aria-checked="' + isChecked + '" aria-label="Select" title="Select  X"><span class="ask-box"><i data-i="check" data-size="12"></i></span></button>'
        : "") +
      '<button class="ask-row' +
      (view === "todo" && it.group === "now" ? " ask-row--now" : "") +
      '" data-id="' +
      it.id +
      '"' +
      from +
      ">" +
      '<span class="ask-mark"><i data-brand="' +
      it.src +
      '" data-size="16"></i></span>' +
      '<span class="ask-text"><span class="ask-title">' +
      it.title +
      '</span><span class="ask-sub">' +
      sub +
      "</span></span>" +
      '<span class="ask-end">' +
      end +
      "</span></button>" +
      acts +
      (snoozeMenu && snoozeMenu.place === "row" && snoozeMenu.ids[0] === it.id ? buildSnoozeMenu() : "") +
      "</div>"
    );
  }

  /**
   * Returns the controls a row shows while the pointer is on it: Snooze (Unsnooze in Later) and
   * Done, each in a fixed place so they line up down the list. Returns "" for a row with neither:
   * one that burns now, or one already done. Triage's findings have no Done: each needs its own answer.
   */
  function buildActs(it) {
    var view = readView(it);
    if (view === "done" || !canSnooze(it)) return "";
    var empty = '<span class="ask-act-slot"></span>';
    var first = view === "later" ? buildAct("unsnooze", it, "undo", "Unsnooze", "U") : buildAct("snooze", it, "alarm", "Snooze", "H");
    var second = findAnswer(it, "done") ? buildAct("done", it, "check", "Done", "E") : empty;
    return '<span class="ask-acts"' + x("core", "Core: Snooze and Done on the row, while the pointer is on it") + ">" + first + second + "</span>";
  }

  function buildAct(key, it, icon, label, kbd) {
    var expanded = key === "snooze" ? ' aria-expanded="' + !!(snoozeMenu && snoozeMenu.place === "row" && snoozeMenu.ids[0] === it.id) + '"' : "";
    return '<button class="ask-act" data-act="' + key + '" data-for="' + it.id + '"' + expanded + ' aria-label="' + label + '" title="' + label + "  " + kbd + '"><i data-i="' + icon + '" data-size="14"></i></button>';
  }

  function eventRow(e) {
    var stamp = describeStamp(e);
    return (
      '<button class="ask-row' +
      (e.id === selected[mode] ? " is-on" : "") +
      '" data-flip="' +
      e.id +
      '" data-id="' +
      e.id +
      '"' +
      x("plugin", SYSTEMS[e.src] + " plugin: event " + e.type + " · the stamp is the core's") +
      ">" +
      '<span class="ask-mark"><i data-brand="' +
      e.src +
      '" data-size="16"></i></span>' +
      '<span class="ask-text"><span class="ask-title">' +
      e.title +
      '</span><span class="ask-sub"><span class="ev-stamp">' +
      stamp.label +
      "</span> · " +
      stamp.detail +
      "</span></span>" +
      '<span class="ask-end"><time class="ask-age">' +
      formatClock(e.t) +
      "</time></span></button>"
    );
  }

  /** Returns where an ask stands, for a line about it: "on your To do list", "snoozed until today 14:00", "approved #1293 · 10:42". */
  function describeItemState(it) {
    var view = readView(it);
    if (view === "todo") return "on your To do list";
    if (view === "later") return "snoozed until " + formatMoment(it.snooze.until);
    return lowerFirst(it.resolution.text) + " · " + formatShortMoment(it.resolution.t);
  }

  /** Returns an event's stamp as a label and the detail after it. Nothing is stored on the event: the stamp is worked out from what it led to. */
  function describeStamp(e) {
    var it = e.item ? findItem(e.item) : null;
    switch (e.stamp) {
      case "ask":
        return { label: "→ ask", detail: describeItemState(it) };
      case "stopped":
        return { label: "stopped", detail: "you stopped this thread on " + formatDate(findStopAt(e.ref, e.t).since) };
      case "proposal":
        return { label: "→ " + it.title, detail: "proposal" };
      case "attached":
        return { label: "→ " + e.task, detail: "attached" };
      case "offer":
        return { label: "offer", detail: it.title };
      case "unsure":
        return { label: "unsure", detail: it.title };
      case "fyi":
        return { label: "FYI", detail: "in the " + formatClock(findTriageRun(e.t)) + " triage summary" };
      case "known":
        return { label: "known", detail: e.task };
      case "pending":
        return { label: "pending triage", detail: "triage runs at " + formatClock(user.triage.next) };
      case "none":
        return { label: "no action", detail: e.reason };
    }
    throw new Error("No stamp " + e.stamp);
  }

  function buildToast() {
    return (
      '<div class="asks-toast" role="status" data-flip="toast" data-toast-serial="' +
      toast.serial +
      '">' +
      (toast.undo ? '<i data-mark="done" data-size="14"></i>' : '<i data-i="' + (toast.icon || "external") + '" data-size="14"></i>') +
      '<span class="asks-toast-text">' +
      toast.text +
      "</span>" +
      (toast.undo ? '<a href="#" data-undo>Undo</a>' : "") +
      "</div>"
    );
  }

  // The checked rows, and what can be done to all of them at once. It takes the toast's place.
  function buildBulkBar() {
    var doable = listCheckedDone().length;
    var canDone = doable > 0;
    var button = function (key, icon, label, kbd, title) {
      return '<button data-bulk="' + key + '"' + (key === "snooze" ? ' aria-expanded="' + !!(snoozeMenu && snoozeMenu.place === "bar") + '"' : "") + (title ? ' title="' + title + '"' : "") + '><i data-i="' + icon + '" data-size="14"></i>' + label + "<kbd>" + kbd + "</kbd></button>";
    };
    // Items from triage have no Done answer, so a mixed selection marks only some.
    var doneTitle = doable < checked.length ? "Marks " + doable + " of " + checked.length + " done. Items from triage need their own answer" : "";
    return (
      '<div class="asks-toast asks-bulk" role="toolbar" aria-label="Checked rows" data-flip="toast"' +
      x("core", "Core: one answer for many asks, Snooze and Done only") +
      ">" +
      '<span class="asks-toast-text"><b>' +
      checked.length +
      "</b> selected</span>" +
      (mode === "later" ? button("unsnooze", "undo", "Unsnooze", "U") : button("snooze", "alarm", "Snooze", "H")) +
      (canDone ? button("done", "check", "Done", "E", doneTitle) : "") +
      '<button class="asks-bulk-x" data-bulk="clear" aria-label="Clear the selection" title="Clear  Esc"><i data-i="close" data-size="14"></i></button>' +
      (snoozeMenu && snoozeMenu.place === "bar" ? buildSnoozeMenu() : "") +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ the pane */

  /** Decides how the drawing about to happen moves, from whether it draws the list already on screen. */
  function decideMotion() {
    var list = [mode, filter, stampFilter, query].join("|");
    motion = drawnList === null ? "first" : list === drawnList ? "in place" : "at once";
    drawnList = list;
  }

  /** Checks whether the detail pane shows: you want it, and a record is selected to fill it. */
  function isPaneOpen() {
    return paneWanted && !!selected[mode];
  }

  /**
   * Opens or closes the pane, and sets its button. The pane slides only when the list stays the
   * same list: answering the last item slides it away, while a switch of view or tab redraws at once.
   */
  function renderPane() {
    var asks = document.querySelector("[data-asks]");
    asks.classList.toggle("is-instant", motion !== "in place");
    asks.classList.toggle("is-wide", !isPaneOpen());
    var button = document.querySelector("[data-pane-toggle]");
    var open = isPaneOpen();
    button.disabled = !selected[mode];
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("aria-label", open ? "Hide the open item" : "Show the open item");
    button.title = open ? "Hide the open item  Esc" : "Show the open item  ↩";
  }

  /** Shows or hides the pane, keeping the cursor where it is. */
  function setPane(open) {
    paneWanted = open;
    snoozeMenu = null;
    render();
  }

  /* ------------------------------------------------------------------ list motion */

  // Crew Bureau's timings, read once so the list moves on the same clock as the rest of the interface.
  var rootStyle = getComputedStyle(root);
  var DUR_1 = parseFloat(rootStyle.getPropertyValue("--dur-1"));
  var DUR_2 = parseFloat(rootStyle.getPropertyValue("--dur-2"));
  var DUR_3 = parseFloat(rootStyle.getPropertyValue("--dur-3"));
  var EASE_OUT = rootStyle.getPropertyValue("--ease-out").trim();
  var reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  /** Returns where each part of the list is on screen, by its data-flip key, so the next drawing can move each part from there. */
  function measureList() {
    var parts = {};
    document.querySelectorAll("[data-asks-list] [data-flip]").forEach(function (el) {
      parts[el.dataset.flip] = { el: el, rect: el.getBoundingClientRect() };
    });
    return parts;
  }

  /**
   * Moves the newly drawn list on from where its parts were, as measured by measureList:
   * - a part that left fades out where it was;
   * - once it is gone, the parts that stayed slide to their new places;
   * - a part that arrived fades in once they have nearly made room for it.
   * The toast slides with the list when it was already there, and changes its words in place. A new
   * toast rises once the list has nearly settled, like an arriving row. So does a toast that moves
   * between the bottom of the list and its place under inbox zero: sliding there would send it across
   * the screen while the pane closes, so the old one fades out with the rows instead.
   */
  function animateList(before) {
    var after = measureList();
    if (before.toast && after.toast && !before.zero !== !after.zero) {
      fadeOutGhost(before.toast);
      delete before.toast;
    }
    var gone = Object.keys(before).filter(function (key) {
      return !after[key];
    });
    var moves = Object.keys(after)
      .filter(function (key) {
        return before[key];
      })
      .map(function (key) {
        return { el: after[key].el, dx: before[key].rect.left - after[key].rect.left, dy: before[key].rect.top - after[key].rect.top };
      })
      .filter(function (m) {
        return Math.abs(m.dx) >= 0.5 || Math.abs(m.dy) >= 0.5;
      });
    var slideAt = gone.length ? DUR_1 : 0;
    var arriveAt = moves.length ? slideAt + DUR_3 / 2 : slideAt;
    gone.forEach(function (key) {
      fadeOutGhost(before[key]);
    });
    moves.forEach(function (m) {
      m.el.animate({ transform: ["translate(" + m.dx + "px, " + m.dy + "px)", "none"] }, { duration: DUR_3, delay: slideAt, easing: EASE_OUT, fill: "backwards" });
    });
    Object.keys(after).forEach(function (key) {
      // Inbox zero and the toast have arrivals of their own.
      if (before[key] || key === "zero" || key === "toast") return;
      after[key].el.animate({ opacity: [0, 1] }, { duration: DUR_2, delay: arriveAt, easing: EASE_OUT, fill: "backwards" });
    });
    var toastEl = after.toast && after.toast.el;
    if (!toastEl) return;
    if (before.toast) {
      toastEl.classList.remove("is-new");
      if (before.toast.el.textContent === toastEl.textContent) return;
      Array.prototype.forEach.call(toastEl.children, function (child) {
        child.animate({ opacity: [0, 1] }, { duration: DUR_2, easing: EASE_OUT });
      });
    } else if (arriveAt) {
      // Under inbox zero the toast is centred in the list, which widens as the pane closes. It
      // waits for that, so it rises straight up instead of drifting sideways.
      var riseAt = after.zero ? Math.max(arriveAt, DUR_3) : arriveAt;
      toastEl.classList.remove("is-new");
      toastEl.animate({ opacity: [0, 1], transform: ["translateY(6px)", "none"] }, { duration: DUR_2, delay: riseAt, easing: EASE_OUT, fill: "backwards" });
    }
  }

  /**
   * Fades out a part that left the list, at the place it had. The part moves into a layer laid over
   * the list rather than into the list itself: there it neither stretches the scroll height nor is
   * wiped by the next drawing. Its container's classes come along, so a quiet row stays quiet while
   * it fades, and its data attributes are removed so no query or click can find it.
   */
  function fadeOutGhost(part) {
    var layer = document.querySelector("[data-asks-ghosts]");
    layer.style.top = document.querySelector("[data-asks-list]").offsetTop + "px";
    var box = layer.getBoundingClientRect();
    var ghost = part.el.parentNode ? part.el.parentNode.cloneNode(false) : document.createElement("div");
    ghost.appendChild(part.el);
    [ghost].concat(Array.prototype.slice.call(ghost.querySelectorAll("*"))).forEach(function (node) {
      Array.prototype.slice.call(node.attributes).forEach(function (a) {
        if (a.name.indexOf("data-") === 0) node.removeAttribute(a.name);
      });
    });
    // Put back into the page, a part with an arrival class would play its arrival again.
    ghost.querySelectorAll(".is-arriving, .is-new").forEach(function (node) {
      node.classList.remove("is-arriving", "is-new");
    });
    ghost.classList.add("asks-ghost");
    ghost.inert = true;
    ghost.style.cssText = "top:" + (part.rect.top - box.top) + "px;left:" + (part.rect.left - box.left) + "px;width:" + part.rect.width + "px;height:" + part.rect.height + "px";
    layer.appendChild(ghost);
    ghost.animate({ opacity: [1, 0] }, { duration: DUR_1, easing: "ease-in", fill: "forwards" }).onfinish = function () {
      ghost.remove();
    };
  }

  /* ------------------------------------------------------------------ the detail */

  // With nothing selected the pane is closed, and it keeps what it showed so it slides out whole.
  function renderDetail() {
    var el = document.querySelector("[data-asks-detail]");
    var id = selected[mode];
    if (!id) return;
    el.innerHTML = mode === "everything" ? buildEventDetail(findEvent(id)) : buildItemDetail(findItem(id));
    if (!snoozeMenu) el.scrollTop = 0;
  }

  // Inbox zero, in the list's place. Hercule in a brass sunburst; what you cleared today, and from
  // where; then when the list fills again.
  function buildZero() {
    var later = items
      .filter(function (it) {
        return readView(it) === "later";
      })
      .sort(function (a, b) {
        return a.snooze.until - b.snooze.until;
      });
    var next = later.length
      ? later.length +
        " snoozed, back " +
        joinWords(
          later.map(function (it) {
            return formatMoment(it.snooze.until);
          }),
        )
      : "Nothing snoozed";
    var cleared = listClearedToday();
    return (
      '<div class="asks-zero" data-flip="zero"' +
      x("core", "Core: To do is empty") +
      ">" +
      '<div class="asks-zero-art">' +
      buildSunburst() +
      '<span class="asks-zero-face"><i data-face="Hercule" data-pose="done" data-size="88"></i></span></div>' +
      '<h2 class="asks-zero-h">Inbox zero</h2>' +
      '<p class="asks-zero-line">Nothing waits on you. The rest of the ' +
      namePartOfDay(NOW) +
      " is yours.</p>" +
      '<p class="asks-zero-n"><span class="asks-zero-num">' +
      cleared.length +
      "</span>cleared today</p>" +
      buildTally(cleared) +
      '<p class="asks-zero-next">' +
      next +
      " · triage runs at " +
      formatClock(user.triage.next) +
      "</p></div>"
    );
  }

  /** Returns the part of the day a moment falls in, for a sentence: "morning", "afternoon" or "evening". */
  function namePartOfDay(t) {
    var hour = Math.floor(t % DAY) / 60;
    return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  }

  // The brass rays around Hercule, long and short in turn, as on the office clock. Each ray is its
  // own path so it can draw outward on arrival, the two halves sweeping down from the top.
  function buildSunburst() {
    var rays = "";
    var count = 32;
    for (var i = 0; i < count; i++) {
      var a = (i / count) * Math.PI * 2 - Math.PI / 2;
      var outer = i % 2 === 0 ? 100 : 84;
      rays +=
        '<path pathLength="1" style="--i:' + Math.min(i, count - i) + '" d="M' +
        (Math.cos(a) * 64).toFixed(1) + " " + (Math.sin(a) * 64).toFixed(1) + "L" +
        (Math.cos(a) * outer).toFixed(1) + " " + (Math.sin(a) * outer).toFixed(1) + '"/>';
    }
    return '<svg class="asks-zero-sun" viewBox="-108 -108 216 216" aria-hidden="true">' + rays + "</svg>";
  }

  // What you cleared today per source, in the order of the tabs. Each count opens Done on that tab.
  function buildTally(cleared) {
    var html = "";
    user.sources.concat("triage").forEach(function (src) {
      var n = cleared.filter(function (it) {
        return src === "triage" ? it.group === "triage" : it.group !== "triage" && it.src === src;
      }).length;
      if (!n) return;
      var name = src === "triage" ? "triage" : SYSTEMS[src];
      var mark = src === "triage" ? '<i data-face="Triage" data-size="16"></i>' : '<i data-brand="' + src + '" data-size="14"></i>';
      html += '<button data-tally="' + src + '" title="' + n + " cleared from " + name + '" aria-label="' + n + " cleared from " + name + '">' + mark + n + "</button>";
    });
    return html ? '<div class="asks-zero-tally">' + html + "</div>" : "";
  }

  /** Joins words the way a sentence lists them: "a", "a and b", "a, b and c". */
  function joinWords(words) {
    if (words.length < 2) return words.join("");
    return words.slice(0, -1).join(", ") + " and " + words[words.length - 1];
  }

  function buildHead(it) {
    var isTriage = it.group === "triage";
    return (
      '<header class="ad-head"' +
      (isTriage ? x("core", "Core: written by triage") : x("plugin", it.system + " plugin: kind, asker, place, link, who waits")) +
      ">" +
      '<div class="ad-kind"><span class="src">' +
      // A triage item was raised by triage, whatever its events were about.
      (isTriage ? '<i data-face="Triage" data-size="18"></i>' : '<i data-brand="' + it.src + '" data-size="14"></i>') +
      it.kind +
      "</span><span>·</span><span>" +
      it.place +
      "</span>" +
      '<span class="spacer"></span>' +
      (it.open ? '<a class="btn btn--quiet btn--sm" href="#" data-open>' + it.open + '<i data-i="external" data-size="13"></i></a>' : "") +
      "</div>" +
      '<h2 class="ad-title">' +
      it.title +
      "</h2>" +
      '<p class="ad-asked">' +
      it.asked +
      "</p></header>"
    );
  }

  // One line under the head about a snooze: it came back, it is hidden until a time, or it had been.
  function buildFlag(it) {
    var view = readView(it);
    if (view === "todo" && it.back)
      return (
        '<p class="ad-flag ad-flag--you"' +
        x("core", "Core: back from your snooze") +
        '><i data-i="alarm" data-size="14"></i>Back from snooze. You snoozed it ' +
        formatMomentAt(it.back.at).replace(/^today /, "") +
        " until " +
        formatClock(it.back.until) +
        ".</p>"
      );
    if (view === "later")
      return (
        '<p class="ad-flag"' +
        x("core", "Core: yours only. The ask stays open") +
        '><i data-i="alarm" data-size="14"></i>Snoozed ' +
        formatMomentAt(it.snooze.at).replace(/^today /, "") +
        " until " +
        formatMoment(it.snooze.until) +
        "." +
        (it.open ? " Answered " + nameSystemPlace(it) + " before then, it goes to Done." : "") +
        "</p>"
      );
    if (view === "done" && it.snooze) return '<p class="ad-flag"><i data-i="alarm" data-size="14"></i>You had snoozed it until ' + formatMoment(it.snooze.until) + ".</p>";
    return "";
  }

  /** Returns where an item's own system is, for a sentence: "on GitHub", "in Slack". */
  function nameSystemPlace(it) {
    return (it.system === "GitHub" ? "on " : "in ") + it.system;
  }

  function buildItemDetail(it) {
    var view = readView(it);
    var blocks = '<div class="ad-blocks">' + it.blocks.map(block).join("") + "</div>";
    var lower = view === "done" ? '<div class="ad-answers">' + buildOutcome(it) + "</div>" : buildAnswers(it);
    return '<article class="ad">' + buildHead(it) + buildFlag(it) + blocks + lower + buildFoot(it) + "</article>" + keysHtml(it);
  }

  function buildAnswers(it) {
    var mine = buildMine(it);
    if (!it.answers.length && !mine) return "";
    return '<div class="ad-answers">' + (it.answers.length ? answersHtml(it) : "") + mine + "</div>";
  }

  // What only you see: when it comes back, and whether its thread may ask again. Neither tells the other system.
  function buildMine(it) {
    if (!canSnooze(it)) return "";
    var view = readView(it);
    var html = "";
    if (view === "later") html += mineRow("unsnooze", '<i data-i="undo" data-size="14"></i>Unsnooze', "Puts it back on To do now", "", "U", x("core", "Core: yours only"));
    html += mineRow(
      "snooze",
      '<i data-i="alarm" data-size="14"></i>' + (view === "later" ? "Snooze again…" : "Snooze…"),
      view === "later" ? "Changes when it comes back. Only for you" : "Hides it from To do until a time you pick. Only for you",
      "",
      "H",
      x("core", "Core: yours only. The ask stays open"),
      snoozeMenu && snoozeMenu.place === "pane" ? buildSnoozeMenu() : "",
    );
    if (canStop(it))
      html += mineRow("stop", '<i data-i="pause" data-size="14"></i>Stop asking', describeStop(it), "Also takes this ask off your list", "M", x("core", "Core: stop list on the thread ref · delayed until much later"));
    return '<div class="ledger ad-mine">' + html + "</div>";
  }

  function mineRow(key, label, describe, fine, kbd, xray, extra) {
    return (
      '<div class="ans"' +
      xray +
      ">" +
      '<button class="btn btn--quiet" data-mine="' +
      key +
      '"' +
      (key === "snooze" ? ' aria-expanded="' + !!(snoozeMenu && snoozeMenu.place === "pane") + '"' : "") +
      ">" +
      label +
      "</button>" +
      '<span class="ans-desc">' +
      describe +
      (fine ? '<span class="ad-fine">' + fine + "</span>" : "") +
      "</span>" +
      "<kbd>" +
      kbd +
      "</kbd>" +
      (extra || "") +
      "</div>"
    );
  }

  function buildSnoozeMenu() {
    return (
      '<div class="pop asks-snooze" role="menu" aria-label="Snooze until">' +
      '<p class="asks-snooze-h">Snooze until</p>' +
      SNOOZE_PRESETS.map(function (p, i) {
        return (
          '<button role="menuitem" data-snooze="' + i + '"><span>' + p.label + "</span>" + (p.at ? "<time>" + formatShortMoment(p.at) + "</time>" : "<span></span>") + "<kbd>" + (i + 1) + "</kbd></button>"
        );
      }).join("") +
      "</div>"
    );
  }

  // How the ask left the list, in place of its answers. A resolved ask is final: its answers are inert.
  function buildOutcome(it) {
    var r = it.resolution;
    var by = r.how === "elsewhere" || r.how === "withdrawn" ? (r.how === "withdrawn" ? "Withdrawn by " : "Resolved by ") + it.system + " · " + formatMoment(r.t) : "Here · " + formatMoment(r.t) + " · by you";
    var icon =
      r.how === "hand"
        ? '<i data-face="' + r.face + '" data-pose="working" data-size="28"></i>'
        : r.how === "elsewhere"
          ? '<span class="b-work-mark ad-mark--quiet"><i data-brand="' + it.src + '" data-size="16"></i></span>'
          : r.how === "withdrawn"
            ? '<span class="b-work-mark ad-mark--quiet"><i data-mark="idle" data-size="16"></i></span>'
            : r.how === "stop"
              ? '<span class="b-work-mark ad-mark--quiet"><i data-i="pause" data-size="16"></i></span>'
              : '<span class="b-work-mark"><i data-mark="done" data-size="16"></i></span>';
    var stop = r.how === "stop" ? findActiveStop(it.ref) : null;
    var button = stop
      ? '<button class="btn btn--sm" data-unstop="' + it.ref + '">Ask me again</button>'
      : r.how === "hand"
        ? '<a class="btn btn--sm" href="#" data-toast="Opens the run of ' + r.face + '">Open the run</a>'
        : "";
    var asked = r.how === "stop" && !stop ? '<p class="ad-outcome-note">You asked for it again ' + formatMomentAt(findStopUntil(it.ref)) + ".</p>" : "";
    var said = r.reply ? '<div class="b-msg is-you"><div class="b-msg-head"><b>You</b><time>' + formatClock(r.t) + "</time></div><p>" + r.reply + "</p></div>" : "";
    return (
      '<section class="ad-outcome"' +
      x("core", "Core: the resolution, final") +
      ">" +
      '<div class="ad-outcome-top">' +
      icon +
      '<span class="b-work-text"><span class="b-work-label">' +
      (r.how === "withdrawn" || r.how === "elsewhere" ? "Left on its own" : "What you did") +
      "</span><b>" +
      r.text +
      "</b><span>" +
      by +
      "</span></span>" +
      button +
      "</div>" +
      '<p class="ad-outcome-desc">' +
      r.describe +
      (r.fine ? '<span class="ad-fine">' + r.fine + "</span>" : "") +
      "</p>" +
      said +
      asked +
      "</section>"
    );
  }

  /** Returns when the last stop on a thread ref ended. */
  function findStopUntil(ref) {
    return stops
      .filter(function (s) {
        return s.ref === ref && s.until;
      })
      .map(function (s) {
        return s.until;
      })
      .pop();
  }

  function buildFoot(it) {
    var view = readView(it);
    var isTriage = it.group === "triage";
    var seeEvent = it.event ? ' · <a href="#" data-goto="ev-' + it.id + '">See the event</a>' : "";
    var first;
    if (view === "done") {
      var r = it.resolution;
      var own = r.how === "elsewhere" || r.how === "withdrawn";
      var actor = own ? "plugin:" + it.src : "user";
      first =
        '<p class="ad-leaves"' +
        x("core", "Core: the notification's resolution") +
        '><i data-i="check" data-size="14"></i><span>Resolution <code>' +
        (r.how === "withdrawn" ? "withdrawn" : "decided") +
        "</code> by <code>" +
        actor +
        "</code> from <code>" +
        (own ? "plugin:" + it.src : "web") +
        "</code>, " +
        formatMoment(r.t) +
        "</span></p>";
    } else {
      first =
        '<p class="ad-leaves"' +
        x(isTriage ? "core" : "plugin", isTriage ? "Core: a decision stays until answered" : it.system + " plugin: when the ask resolves on its own") +
        '><i data-i="check" data-size="14"></i>' +
        it.leaves +
        "</p>";
    }
    return '<footer class="ad-foot">' + first + '<p class="ad-raised">Raised by ' + it.raised + seeEvent + "</p></footer>";
  }

  function keysHtml(it) {
    var keys = "<span><kbd>J</kbd><kbd>K</kbd> move</span>";
    if (readView(it) !== "done") {
      var suggested = suggestedAnswer(it);
      if (suggested) keys += "<span><kbd>↩</kbd> " + (suggested.type === "reply" ? "write the reply" : lowerFirst(suggested.label)) + "</span>";
      if (findAnswer(it, "reply") && (!suggested || suggested.type !== "reply")) keys += "<span><kbd>R</kbd> " + lowerFirst(findAnswer(it, "reply").label.replace("…", "")) + "</span>";
      if (findAnswer(it, "done")) keys += "<span><kbd>E</kbd> done</span>";
      if (canSnooze(it)) keys += "<span><kbd>H</kbd> snooze</span>";
      if (readView(it) === "later") keys += "<span><kbd>U</kbd> unsnooze</span>";
      if (canStop(it)) keys += "<span><kbd>M</kbd> stop asking</span>";
    }
    if (it.open) keys += "<span><kbd>O</kbd> open</span>";
    return '<div class="ad-keys">' + keys + "</div>";
  }

  /** Returns the one suggested answer of an item: its first answer that does something, or undefined when it has none. */
  function suggestedAnswer(it) {
    return it.answers.filter(function (a) {
      return a.type !== "done" && a.type !== "dismiss" && a.type !== "choice";
    })[0];
  }

  /** Returns the first answer of the given type, or undefined when the item has none. */
  function findAnswer(it, type) {
    return it.answers.filter(function (a) {
      return a.type === type;
    })[0];
  }

  function answersHtml(it) {
    var list = it.answers;
    var accent = suggestedAnswer(it);
    // An unsure item has equal choices and no suggestion.
    if (
      list.every(function (a) {
        return a.type === "choice";
      })
    ) {
      return (
        '<div class="ad-choices"' +
        x("core", "Core: choices from triage, none suggested") +
        ">" +
        list
          .map(function (a, i) {
            return '<div class="ad-choice"><button class="btn" data-answer="' + i + '">' + a.label + '</button><span class="ans-desc">' + a.describe + "</span></div>";
          })
          .join("") +
        "</div>"
      );
    }
    var html = "";
    // A reply that is the suggested answer is shown as its composer, ready to type in.
    if (accent && accent.type === "reply") html += composer(accent, list.indexOf(accent), true);
    var ledger = list
      .map(function (a, i) {
        if (a === accent && a.type === "reply") return "";
        return ans(a, i, a === accent);
      })
      .join("");
    if (ledger) html += '<div class="ledger">' + ledger + "</div>";
    return html;
  }

  function composer(a, i, accent) {
    return (
      '<div class="ad-compose card" data-compose="' + i + '"' + x("plugin", "Answer with one typed field: " + a.op) + ">" +
      '<textarea class="ad-compose-input" rows="3" placeholder="' + a.placeholder + '"></textarea>' +
      '<div class="ad-compose-row"><span class="ad-compose-desc"' + x("core", "Core: describe line") + ">" + a.describe + (a.fine ? '<span class="ad-fine">' + a.fine + "</span>" : "") + "</span>" +
      '<button class="btn btn--sm' + (accent ? " btn--accent" : "") + '" data-answer="' + i + '">Send <kbd>⌘↩</kbd></button></div></div>'
    );
  }

  function ans(a, i, accent) {
    var cls = "btn" + (accent ? " btn--accent" : "") + (a.type === "done" || a.type === "dismiss" ? " btn--quiet" : "");
    var face = a.face ? '<i data-face="' + a.face + '" data-size="18"></i>' : "";
    var key = accent ? "↩" : a.type === "reply" ? "R" : a.type === "done" ? "E" : "";
    var who =
      a.type === "hand"
        ? x("core", "Core answer: run.start, with the ask as input")
        : a.type === "done" || a.type === "dismiss"
          ? x("core", "Core answer")
          : a.type === "reply"
            ? x("plugin", "Answer with one typed field: " + a.op)
            : a.op && a.op.indexOf("/") > 0
              ? x("plugin", "Plugin action: " + a.op)
              : x("core", "Core answer: " + a.op);
    return (
      '<div class="ans"' + who + ' data-ans-row="' + i + '">' +
      '<button class="' + cls + '" data-answer="' + i + '">' + face + a.label + "</button>" +
      '<span class="ans-desc">' + (a.describe ? a.describe : "") + (a.fine ? '<span class="ad-fine">' + a.fine + "</span>" : "") + "</span>" +
      (key ? "<kbd>" + key + "</kbd>" : "<span></span>") +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ an event */

  function buildEventDetail(e) {
    var system = SYSTEMS[e.src];
    var it = e.item ? findItem(e.item) : null;
    var open = e.src === "cron" ? "" : system === "GitHub" ? "Open on GitHub" : "Open in " + system;
    var head =
      '<header class="ad-head"' +
      x("plugin", system + " plugin: the event as it arrived") +
      ">" +
      '<div class="ad-kind"><span class="src"><i data-brand="' +
      e.src +
      '" data-size="14"></i>' +
      system +
      '</span><span>·</span><span class="mono">' +
      e.type +
      '</span><span class="spacer"></span>' +
      (open ? '<a class="btn btn--quiet btn--sm" href="#" data-open>' + open + '<i data-i="external" data-size="13"></i></a>' : "") +
      "</div>" +
      '<h2 class="ad-title">' +
      e.title +
      "</h2>" +
      '<p class="ad-asked">Received ' +
      formatMomentAt(e.t) +
      ".</p></header>";
    // The event's own words, when it has them. The event that raised an ask shows the ask's first block.
    var body = e.body ? block({ type: "words", who: e.body.who, at: e.body.at, text: e.body.text }) : e.stamp === "ask" ? block(it.blocks[0]) : "";
    var fields =
      '<dl class="b-fields"' +
      x("plugin", "The event's refs and Connection") +
      '><div><dt>Ref</dt><dd><span class="mono">' +
      e.ref +
      "</span></dd></div><div><dt>Connection</dt><dd>" +
      user.connections[e.src] +
      "</dd></div></dl>";
    var keys = "<span><kbd>J</kbd><kbd>K</kbd> move</span>" + (open ? "<span><kbd>O</kbd> open</span>" : "");
    return '<article class="ad">' + head + '<div class="ad-blocks">' + body + buildCameOf(e) + fields + "</div></article>" + '<div class="ad-keys">' + keys + "</div>";
  }

  // What came of an event: its stamp in words, with the way to whatever it led to.
  function buildCameOf(e) {
    var it = e.item ? findItem(e.item) : null;
    var triage = '<i data-face="Triage" data-pose="idle" data-size="28"></i>';
    var run = formatMomentAt(findTriageRun(e.t));
    var o;
    switch (e.stamp) {
      case "ask":
        var view = readView(it);
        o = {
          icon:
            view === "done"
              ? '<span class="b-work-mark"><i data-mark="done" data-size="16"></i></span>'
              : '<span class="b-work-mark ad-mark--you"><i data-i="' + (view === "later" ? "alarm" : "bell") + '" data-size="16"></i></span>',
          label: "Raised an ask for you",
          title: it.title,
          facts: capitalizeFirst(describeItemState(it)),
          button: '<a class="btn btn--sm" href="#" data-goto="' + it.id + '">Open the ask</a>',
        };
        break;
      case "stopped":
        var stop = findStopAt(e.ref, e.t);
        o = {
          icon: '<span class="b-work-mark ad-mark--quiet"><i data-i="pause" data-size="16"></i></span>',
          label: "Stopped",
          title: stop.label,
          facts: "You stopped asks about this thread on " + formatDate(stop.since) + ", and this event does not name you. " + SYSTEMS[e.src] + " still notified you",
          button: findActiveStop(e.ref) ? '<button class="btn btn--sm" data-unstop="' + e.ref + '">Ask me again</button>' : "",
        };
        break;
      case "proposal":
        o = { icon: triage, label: "Triage proposed a Task", title: it.title, facts: "Triage " + run + " · " + describeItemState(it), button: '<a class="btn btn--sm" href="#" data-goto="' + it.id + '">Open the Proposal</a>' };
        break;
      case "attached":
        o = { icon: triage, label: "Triage attached it to your Task", title: e.task, facts: "Triage " + run + " · the Task existed before, so nothing new reached your list", button: taskButton(e.task) };
        break;
      case "known":
        o = { icon: triage, label: "Already part of your Task", title: e.task, facts: "Its ref was on the Task before triage " + run + ", so triage left it there", button: taskButton(e.task) };
        break;
      case "offer":
        o = { icon: triage, label: "Triage offered to do it", title: it.title, facts: "Triage " + run + " · " + describeItemState(it), button: '<a class="btn btn--sm" href="#" data-goto="' + it.id + '">Open the offer</a>' };
        break;
      case "unsure":
        o = { icon: triage, label: "Triage could not tell", title: it.title, facts: "Triage " + run + " · " + describeItemState(it), button: '<a class="btn btn--sm" href="#" data-goto="' + it.id + '">Open it</a>' };
        break;
      case "fyi":
        o = { icon: triage, label: "Triage listed it as FYI", title: "In the " + formatClock(findTriageRun(e.t)) + " triage summary", facts: "Nothing to decide, so nothing reached your list", button: "" };
        break;
      case "pending":
        o = { icon: '<i data-face="Triage" data-pose="waiting" data-size="28"></i>', label: "Pending triage", title: "Triage reads it at " + formatClock(user.triage.next), facts: "It arrived after the " + formatClock(user.triage.last) + " run", button: "" };
        break;
      case "none":
        o = { icon: triage, label: "No action", title: e.reason, facts: "Triage " + run, button: "" };
        break;
    }
    return (
      '<div class="b-work"' +
      x("core", "Core: the stamp, worked out from what the event led to. Nothing is stored on the event") +
      ">" +
      o.icon +
      '<span class="b-work-text"><span class="b-work-label">' +
      o.label +
      "</span><b>" +
      o.title +
      "</b><span>" +
      o.facts +
      "</span></span>" +
      o.button +
      "</div>"
    );
  }

  function taskButton(task) {
    return '<a class="btn btn--sm" href="#" data-toast="Opens the Task ' + task + '">Open the Task</a>';
  }

  function capitalizeFirst(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /* ------------------------------------------------------------------ blocks */

  // The palette of blocks the core knows how to draw. A plugin fills them with data; it never
  // ships markup. `work`, `note`, `gist` and `sources` are the core's own.
  function block(b) {
    switch (b.type) {
      case "words":
        return '<figure class="b-words"' + x("plugin", "Block: words, filled by the plugin") + ">" + msg(b) + "</figure>";
      case "thread":
        return '<div class="b-thread"' + x("plugin", "Block: thread, filled by the plugin") + ">" + b.messages.map(msg).join("") + "</div>";
      case "change":
        return (
          '<div class="b-change"' + x("plugin", "Block: change, filled by the plugin") + ">" +
          '<span class="b-change-files"><i data-i="diff" data-size="14"></i>' + b.files + " files</span>" +
          '<span class="plus">+' + b.plus + '</span><span class="minus">−' + b.minus + "</span>" +
          '<span class="b-change-ref"><i data-i="branch" data-size="14"></i><span class="mono">' + b.from + '</span><i data-i="arrow" data-size="12"></i><span class="mono">' + b.to + "</span></span>" +
          '<span class="b-change-checks"><i data-mark="done" data-size="14"></i>' + b.checks + "</span></div>"
        );
      case "checks":
        return (
          '<ul class="b-checks"' + x("plugin", "Block: checks, filled by the plugin") + ">" +
          b.rows
            .map(function (r) {
              return (
                '<li class="b-check b-check--' + r.state + '"><i data-mark="' + r.state + '" data-size="14"></i><span class="mono">' + r.name + "</span><time>" + r.time + "</time>" +
                (r.log ? '<pre class="b-log mono">' + r.log + "</pre>" : "") +
                "</li>"
              );
            })
            .join("") +
          "</ul>"
        );
      case "when":
        return whenBlock(b);
      case "signal":
        return (
          '<div class="b-signal"' + x("plugin", "Block: signal, filled by the plugin") + '><span class="deco-num">' + b.num + '</span><span class="b-signal-text"><b>' + b.label + "</b><span>" + b.sub + "</span></span></div>"
        );
      case "fields":
        return (
          '<dl class="b-fields"' + x("plugin", "Block: fields, filled by the plugin") + ">" +
          b.rows
            .map(function (r) {
              return "<div><dt>" + r[0] + "</dt><dd>" + r[1] + "</dd></div>";
            })
            .join("") +
          "</dl>"
        );
      case "work":
        return (
          '<div class="b-work"' + x("core", "Core: your Task or thread, matched by the ask's refs") + ">" +
          (b.face ? '<i data-face="' + b.face + '" data-pose="waiting" data-size="28"></i>' : '<span class="b-work-mark"><i data-mark="' + b.mark + '" data-size="16"></i></span>') +
          '<span class="b-work-text"><span class="b-work-label">' + b.label + "</span><b>" + b.title + "</b><span>" + b.facts + "</span></span>" +
          '<a class="btn btn--sm" href="#">' + b.button + "</a></div>"
        );
      case "note":
        return '<p class="b-note"' + x("core", "Core: triage attached, not raised again") + '><i data-face="Triage" data-size="20"></i><span>' + b.text + "</span></p>";
      case "gist":
        return '<p class="b-gist"' + x("core", "Core: the notification body triage wrote") + ">" + b.text + "</p>";
      case "sources":
        return (
          '<ul class="b-sources"' + x("core", "Core: the events triage used") + ">" +
          b.rows
            .map(function (r) {
              return '<li><i data-brand="' + r.src + '" data-size="14"></i><span>' + r.text + "</span></li>";
            })
            .join("") +
          "</ul>"
        );
    }
    throw new Error("No block type " + b.type);
  }

  function msg(m) {
    return (
      '<div class="b-msg' + (m.mine ? " is-you" : "") + (m.note ? " is-note" : "") + '">' +
      '<div class="b-msg-head"><b>' + m.who + "</b>" + (m.file ? '<span class="mono">' + m.at + "</span>" : "<time>" + m.at + "</time>") + "</div>" +
      "<p>" + m.text + "</p></div>"
    );
  }

  function whenBlock(b) {
    var span = b.to - b.from;
    function pct(h) {
      return ((h - b.from) / span) * 100 + "%";
    }
    var hours = "";
    for (var h = b.from; h < b.to; h++) hours += '<span class="b-when-hour" style="left:' + pct(h) + '">' + h + ":00</span>";
    // Lanes: the ask on top, the rest of the day below it.
    var slots = b.slots
      .map(function (s) {
        var cls = "b-when-slot" + (s.ask ? " is-ask" : "") + (s.clash ? " is-clash" : "");
        return '<span class="' + cls + '" style="left:' + pct(s.start) + ";width:calc(" + pct(s.end) + " - " + pct(s.start) + ')">' + s.name + "</span>";
      })
      .join("");
    return (
      '<div class="b-when"' + x("plugin", "Block: when, filled by the plugin") + ">" +
      '<div class="b-when-day">' + b.day + "</div>" +
      '<div class="b-when-track">' + hours + slots + "</div>" +
      '<p class="b-when-note"><span class="dot dot--fail"></span>' + b.note + "</p></div>"
    );
  }

  /* ------------------------------------------------------------------ actions */

  /**
   * Applies a change to some items, keeps what it changed for Undo, and shows what happened. When
   * the item under the cursor leaves the list, the cursor moves to the next item that stayed, or
   * the one before when none below did. Checks are cleared: they were for this change.
   */
  function change(list, apply, text) {
    var before = listRecords();
    var at = before
      .map(function (r) {
        return r.id;
      })
      .indexOf(selected[mode]);
    lastChange = {
      saved: list.map(function (it) {
        return { it: it, snooze: it.snooze, resolution: it.resolution, back: it.back };
      }),
      stops: stops.map(function (s) {
        return Object.assign({}, s);
      }),
      mode: mode,
      selected: selected[mode],
      checked: checked,
    };
    apply();
    var after = listRecords();
    if (at >= 0 && after.indexOf(before[at]) < 0) {
      var next = before
        .slice(at + 1)
        .concat(before.slice(0, at).reverse())
        .filter(function (r) {
          return after.indexOf(r) >= 0;
        })[0];
      selected[mode] = next ? next.id : null;
    }
    snoozeMenu = null;
    checked = [];
    showToast({ text: text, undo: true });
    render();
  }

  function showToast(next) {
    toastSerial += 1;
    toast = Object.assign({ serial: toastSerial }, next);
  }

  /** Puts back what the last change changed, with the cursor and checks as they were before it. */
  function undo() {
    if (!lastChange) return;
    var c = lastChange;
    c.saved.forEach(function (saved) {
      saved.it.snooze = saved.snooze;
      saved.it.resolution = saved.resolution;
      saved.it.back = saved.back;
    });
    stops = c.stops;
    mode = c.mode;
    selected[mode] = c.selected;
    checked = c.checked;
    lastChange = null;
    toast = null;
    render();
  }

  /** Resolves an item with one of its answers. `replyText` is what you typed, for an answer with a typed field. */
  function answer(it, a, replyText) {
    change(
      [it],
      function () {
        resolveWith(it, a, replyText);
      },
      a.did + " · " + it.title,
    );
  }

  function resolveWith(it, a, replyText) {
    var how = a.type === "hand" ? "hand" : a.type === "done" ? "done" : "answer";
    it.resolution = resolved(how, nextActionTime(), how === "done" ? "Done, nothing sent" : a.did, { describe: a.describe, fine: a.fine, face: a.face, reply: replyText || null });
  }

  /**
   * Marks every item that has a Done answer as done. Triage's findings have none: each needs its own
   * answer, so they stay, and the toast says how many did.
   */
  function markDone(list) {
    var done = list.filter(function (it) {
      return findAnswer(it, "done");
    });
    var skipped = list.length - done.length;
    // The toast holds one short line. Why triage items stay is on the bulk
    // bar's Done button, where the user decides.
    var text = done.length === 1 && !skipped ? "Done · " + done[0].title : "Marked " + done.length + " done";
    if (skipped) text += ". Kept " + skipped + " from triage";
    change(
      done,
      function () {
        done.forEach(function (it) {
          resolveWith(it, findAnswer(it, "done"));
        });
      },
      text,
    );
  }

  function snooze(list, until) {
    change(
      list,
      function () {
        list.forEach(function (it) {
          it.snooze = { at: nextActionTime(), until: until };
          it.back = null;
        });
      },
      "Snoozed " + (list.length === 1 ? "" : list.length + " ") + "until " + formatMoment(until) + (list.length === 1 ? " · " + list[0].title : ""),
    );
  }

  function unsnooze(list) {
    change(
      list,
      function () {
        list.forEach(function (it) {
          it.snooze = null;
        });
      },
      "Back on To do · " + (list.length === 1 ? list[0].title : list.length + " asks"),
    );
  }

  /** Resolves the ask and adds its thread to the stop list, so asks about that thread stop unless one names you. */
  function stopAsking(it) {
    change(
      [it],
      function () {
        var t = nextActionTime();
        it.resolution = resolved("stop", t, "Stopped asking", { describe: describeStop(it) });
        stops.push({ ref: it.ref, src: it.src, label: it.thread, since: t, until: null });
      },
      "Stopped asking about " + it.thread,
    );
  }

  /** Ends the stop on a thread. The stop keeps its dates, so the events it stopped stay stamped. */
  function askAgain(ref) {
    var stop = findActiveStop(ref);
    change(
      [],
      function () {
        findActiveStop(ref).until = nextActionTime();
      },
      "Asks about " + stop.label + " reach you again",
    );
  }

  function pickSnooze(i) {
    var preset = SNOOZE_PRESETS[i];
    if (preset.at) return snooze(snoozeMenu.ids.map(findItem), preset.at);
    snoozeMenu = null;
    showToast({ text: "The prototype has no time picker", icon: "clock" });
    render();
  }

  /**
   * Opens the snooze menu for some asks at a place, or closes it when it is already open there.
   * The first choice takes the focus, so 1 to 5 and the arrow keys work at once.
   */
  function toggleSnooze(ids, place) {
    snoozeMenu = snoozeMenu && snoozeMenu.place === place && snoozeMenu.ids[0] === ids[0] ? null : { ids: ids, place: place };
    render();
    // A row fading out of the list can still hold the menu it had open, so the query skips it.
    var menu = document.querySelector(".asks-snooze:not(.asks-ghost .asks-snooze)");
    if (!menu) return;
    // In the list, the menu opens below its row, or above it when the list ends too soon.
    if (place === "row" && menu.getBoundingClientRect().bottom > document.querySelector("[data-asks-list]").getBoundingClientRect().bottom) menu.classList.add("is-above");
    menu.querySelector("[data-snooze]").focus({ preventScroll: true });
  }

  function closeSnooze() {
    snoozeMenu = null;
    render();
  }

  /**
   * Opens the snooze menu where the H key means it: above the bar for the checked rows, under the
   * open item, or at the row under the cursor when the pane is closed. In Later the checked rows
   * have Unsnooze instead, so H does nothing there.
   */
  function snoozeFromKey(it) {
    if (checked.length) {
      if (mode === "todo") toggleSnooze(checked, "bar");
      return;
    }
    if (it && canSnooze(it)) toggleSnooze([it.id], isPaneOpen() ? "pane" : "row");
  }

  function clearChecks() {
    checked = [];
    snoozeMenu = null;
    render();
  }

  /** Returns the checked items that have a Done answer. */
  function listCheckedDone() {
    return checked.map(findItem).filter(function (it) {
      return findAnswer(it, "done");
    });
  }

  /** Checks or unchecks a row. Only rows with a control can be checked: what burns now, or is done, has none. */
  function toggleCheck(id) {
    var at = checked.indexOf(id);
    if (at >= 0) checked = checked.slice(0, at).concat(checked.slice(at + 1));
    else if (isCheckable(findItem(id))) checked = checked.concat(id);
    snoozeMenu = null;
    render();
  }

  function isCheckable(it) {
    return !!it && readView(it) !== "done" && canSnooze(it);
  }

  /** Checks every row from the cursor to a row, the way Shift-click selects a range. */
  function checkRange(id) {
    var ids = listRecords().map(function (r) {
      return r.id;
    });
    var a = ids.indexOf(selected[mode]);
    var b = ids.indexOf(id);
    ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (one) {
      if (checked.indexOf(one) < 0 && isCheckable(findItem(one))) checked = checked.concat(one);
    });
    selected[mode] = id;
    render();
  }

  /** Moves the cursor and checks the rows it leaves and lands on, the way Shift with J or K extends a selection. */
  function extendCheck(step) {
    if (mode !== "todo" && mode !== "later") return;
    if (checked.indexOf(selected[mode]) < 0 && isCheckable(findItem(selected[mode]))) checked = checked.concat(selected[mode]);
    move(step);
    if (checked.indexOf(selected[mode]) < 0 && isCheckable(findItem(selected[mode]))) checked = checked.concat(selected[mode]);
    render();
  }

  function select(id) {
    selected[mode] = id;
    toast = null;
    snoozeMenu = null;
    render();
    var on = document.querySelector("[data-asks-list] .is-on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }

  function setMode(next) {
    mode = next;
    toast = null;
    snoozeMenu = null;
    checked = [];
    render();
    var on = document.querySelector("[data-asks-list] .is-on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }

  /** Opens an ask or an event wherever it lives: an ask in its view, an event in Everything with nothing hiding it. */
  function openRecord(id) {
    if (id.indexOf("ev-") === 0) {
      filter = "all";
      stampFilter = "all";
      query = "";
      mode = "everything";
    } else {
      var it = findItem(id);
      mode = readView(it);
      if (!isInTab(it)) filter = "all";
    }
    selected[mode] = id;
    setMode(mode);
  }

  function move(step) {
    var shown = listRecords();
    var at = shown
      .map(function (r) {
        return r.id;
      })
      .indexOf(selected[mode]);
    var next = shown[Math.max(0, Math.min(shown.length - 1, at + step))];
    if (next) select(next.id);
  }

  /** Shows the composer of a reply answer and puts the cursor in it. A reply in the ledger turns into its composer first. */
  function openComposer(i) {
    var it = findItem(selected[mode]);
    var rowEl = document.querySelector('[data-ans-row="' + i + '"]');
    if (rowEl) {
      rowEl.outerHTML = composer(it.answers[i], i, false);
      window.Crew.drawPlaceholders(document.querySelector("[data-asks-detail]"));
    }
    var input = document.querySelector('[data-compose="' + i + '"] textarea');
    if (input) input.focus();
  }

  /** Runs an answer the way a click on its button would: a reply opens its composer, anything else is taken. */
  function take(it, a) {
    if (a.type === "reply") return openComposer(it.answers.indexOf(a));
    answer(it, a);
  }

  /** Sends the reply typed in a composer. An empty composer keeps the cursor and sends nothing. */
  function send(compose) {
    var it = findItem(selected[mode]);
    var input = compose.querySelector("textarea");
    var text = input.value.trim();
    if (!text) return input.focus();
    answer(it, it.answers[Number(compose.dataset.compose)], text);
  }

  /** Shows a note at the bottom of the list, with no Undo. */
  function showNote(text, icon) {
    showToast({ text: text, icon: icon });
    renderList();
    window.Crew.drawPlaceholders(document.querySelector("[data-asks-list]"));
  }

  /** Stands in for leaving the app: the prototype has nowhere to go, so it says where it would. */
  function openElsewhere() {
    var label = document.querySelector("[data-open]");
    if (label) showNote(label.textContent.replace(/^Open (on|in) /, "Opens ") + " in your browser", "external");
  }

  function syncUrl() {
    var url = new URL(location.href);
    var values = {
      mode: mode === "todo" ? null : mode,
      filter: filter === "all" ? null : filter,
      stamp: mode === "everything" && stampFilter !== "all" ? stampFilter : null,
      ask: selected[mode],
      pane: paneWanted ? null : "closed",
    };
    Object.keys(values).forEach(function (key) {
      if (values[key]) url.searchParams.set(key, values[key]);
      else url.searchParams.delete(key);
    });
    history.replaceState(null, "", url);
  }

  /** Keeps the selection inside the list: when the selected record is not shown, the first one is selected. */
  function keepSelectionShown() {
    var shown = listRecords();
    var ids = shown.map(function (r) {
      return r.id;
    });
    if (ids.indexOf(selected[mode]) < 0) selected[mode] = ids[0] || null;
  }

  /** Sets the sidebar's Intake count to the number on To do, and hides it at zero. crew.js draws the sidebar once, with a placeholder count. */
  function syncSidebarCount() {
    var count = document.querySelector('aside .nav-row[href="intake.html"] .count');
    if (!count) return;
    count.textContent = countTodo();
    count.style.display = countTodo() ? "" : "none";
  }

  function render(first) {
    decideMotion();
    var before = motion === "in place" && !reducedMotion.matches ? measureList() : null;
    keepSelectionShown();
    syncSidebarCount();
    renderTabs();
    renderTriageStatus();
    renderHead();
    renderList();
    renderDetail();
    renderPane();
    syncUrl();
    if (!first && window.Crew) window.Crew.drawPlaceholders(document.querySelector(".main"));
    // Measured after the icons are drawn, since an icon can change a part's size.
    if (before) animateList(before);
  }

  /** Renders what a search changes, and leaves the search field alone so typing in it carries on. */
  function renderResults() {
    decideMotion();
    keepSelectionShown();
    var select = document.querySelector("[data-stamp]");
    if (select) select.innerHTML = stampOptions();
    renderList();
    renderDetail();
    renderPane();
    syncUrl();
    window.Crew.drawPlaceholders(document.querySelector(".asks"));
  }

  document.addEventListener("click", function (e) {
    // A click anywhere but a snooze menu and the buttons that open one closes the menu.
    if (snoozeMenu && !e.target.closest(".asks-snooze, [data-mine='snooze'], [data-act='snooze'], [data-bulk='snooze']")) closeSnooze();
    var t = e.target.closest(
      "[data-id], [data-check], [data-act], [data-bulk], [data-filter], [data-mode], [data-tally], [data-answer], [data-undo], [data-open], [data-user], [data-xray-toggle], [data-pane-toggle], [data-mine], [data-snooze], [data-unstop], [data-goto], [data-toast], .main a[href='#']",
    );
    if (!t) return;
    e.preventDefault();
    if (t.dataset.id) {
      // Command-click checks a row and Shift-click checks the rows up to it, as in Mail and Finder.
      if (e.metaKey && document.querySelector('[data-check="' + t.dataset.id + '"]')) return toggleCheck(t.dataset.id);
      if (e.shiftKey && document.querySelector('[data-check="' + t.dataset.id + '"]')) return checkRange(t.dataset.id);
      // A plain click opens the row, even from the full-width list.
      paneWanted = true;
      return select(t.dataset.id);
    }
    if (t.dataset.check) return e.shiftKey ? checkRange(t.dataset.check) : toggleCheck(t.dataset.check);
    if (t.dataset.act) {
      var one = findItem(t.dataset.for);
      if (t.dataset.act === "snooze") return toggleSnooze([one.id], "row");
      if (t.dataset.act === "unsnooze") return unsnooze([one]);
      return markDone([one]);
    }
    if (t.dataset.bulk === "snooze") return toggleSnooze(checked, "bar");
    if (t.dataset.bulk === "unsnooze") return unsnooze(checked.map(findItem));
    if (t.dataset.bulk === "done") return markDone(checked.map(findItem));
    if (t.dataset.bulk === "clear") return clearChecks();
    if (t.hasAttribute("data-pane-toggle")) return setPane(!isPaneOpen());
    if (t.dataset.filter) {
      filter = t.dataset.filter;
      checked = [];
      return render();
    }
    if (t.dataset.mode) return setMode(t.dataset.mode);
    if (t.dataset.tally) {
      filter = t.dataset.tally;
      return setMode("done");
    }
    if (t.hasAttribute("data-undo")) return undo();
    if (t.hasAttribute("data-open")) return openElsewhere();
    if (t.dataset.user) {
      var url = new URL(location.href);
      ["user", "ask", "mode", "filter", "stamp"].forEach(function (key) {
        url.searchParams.delete(key);
      });
      url.searchParams.set("user", t.dataset.user);
      location.href = url.toString();
      return;
    }
    if (t.hasAttribute("data-xray-toggle")) return toggleXray();
    if (t.dataset.unstop) return askAgain(t.dataset.unstop);
    if (t.dataset.goto) return openRecord(t.dataset.goto);
    if (t.dataset.toast) return showNote(t.dataset.toast, "arrow");
    var it = findItem(selected[mode]);
    if (t.dataset.snooze !== undefined) return pickSnooze(Number(t.dataset.snooze));
    if (t.dataset.mine === "snooze") return toggleSnooze([it.id], "pane");
    if (t.dataset.mine === "unsnooze") return unsnooze([it]);
    if (t.dataset.mine === "stop") return stopAsking(it);
    if (t.dataset.answer !== undefined) {
      // Send in a composer takes the answer; a reply button anywhere else opens the composer.
      var compose = t.closest("[data-compose]");
      if (compose) return send(compose);
      return take(it, it.answers[Number(t.dataset.answer)]);
    }
  });

  document.addEventListener("input", function (e) {
    if (!e.target.matches("[data-search]")) return;
    query = e.target.value.trim();
    renderResults();
  });

  document.addEventListener("change", function (e) {
    if (!e.target.matches("[data-stamp]")) return;
    stampFilter = e.target.value;
    checked = [];
    render();
  });

  function toggleXray() {
    root.toggleAttribute("data-xray");
  }

  document.addEventListener("keydown", function (e) {
    var compose = e.target.closest("[data-compose]");
    if (compose) {
      if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        send(compose);
      } else if (e.key === "Escape") e.target.blur();
      return;
    }
    if (e.key === "Escape" && e.target.matches("input, select")) return e.target.blur();
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, select")) return;
    if (snoozeMenu) {
      var n = Number(e.key);
      if (n >= 1 && n <= SNOOZE_PRESETS.length) return pickSnooze(n - 1);
      if (e.key === "Escape" || e.key === "h") {
        e.preventDefault();
        return closeSnooze();
      }
    }
    if (e.key === "j") return move(1);
    if (e.key === "k") return move(-1);
    if (e.key === "J") return extendCheck(1);
    if (e.key === "K") return extendCheck(-1);
    if (e.key === "X") return toggleXray();
    if (e.key === "x" && selected[mode]) return toggleCheck(selected[mode]);
    // Esc lets go of one thing at a time: the menu, then the checks, then the pane.
    if (e.key === "Escape" && checked.length) return clearChecks();
    if (e.key === "Escape" && isPaneOpen()) return setPane(false);
    if (e.key === "Enter" && e.target.closest("button, a")) return;
    // With rows checked, E, H and U answer all of them.
    if (checked.length) {
      if (e.key === "e" && listCheckedDone().length) return markDone(checked.map(findItem));
      if (e.key === "h") return snoozeFromKey();
      if (e.key === "u" && mode === "later") return unsnooze(checked.map(findItem));
    }
    // With the pane closed, Enter opens the item under the cursor; the next Enter answers it.
    if (e.key === "Enter" && !isPaneOpen() && selected[mode]) {
      e.preventDefault();
      return setPane(true);
    }
    if (e.key === "o" && document.querySelector("[data-open]")) return openElsewhere();
    var it = mode === "everything" ? null : findItem(selected[mode]);
    if (!it || readView(it) === "done") return;
    // Stop asking is read in the pane before it is taken, so with the pane closed M only opens it.
    if (e.key === "m" && canStop(it) && !isPaneOpen()) return setPane(true);
    // A reply is typed in the pane, so R opens the pane on its way to the composer.
    if (e.key === "r" && findAnswer(it, "reply") && !isPaneOpen()) setPane(true);
    if (e.key === "Enter" && suggestedAnswer(it)) {
      e.preventDefault();
      take(it, suggestedAnswer(it));
    } else if (e.key === "r" && findAnswer(it, "reply")) {
      e.preventDefault();
      take(it, findAnswer(it, "reply"));
    } else if (e.key === "e" && findAnswer(it, "done")) markDone([it]);
    else if (e.key === "h") snoozeFromKey(it);
    else if (e.key === "u" && readView(it) === "later") unsnooze([it]);
    else if (e.key === "m" && canStop(it)) stopAsking(it);
  });

  /* ------------------------------------------------------------------ start */

  // ?list=empty: every To do item already answered, the way you would have, to show inbox zero.
  if (params.get("list") === "empty") {
    var t = NOW - 3;
    items
      .filter(function (it) {
        return readView(it) === "todo";
      })
      .forEach(function (it) {
        var a = suggestedAnswer(it) || it.answers[0];
        it.resolution = a
          ? resolved(a.type === "hand" ? "hand" : "answer", t, a.did, { describe: a.describe, fine: a.fine, face: a.face })
          : resolved("elsewhere", t, "Resolved in " + it.system, { describe: "The issue was resolved in " + it.system + ", so the " + it.system + " plugin took it off your list" });
        it.back = null;
        t -= 7;
      });
  }

  // ?ask names a record; without ?mode, the view is the one that record lives in.
  var asked = params.get("ask");
  if (asked) {
    if (!params.get("mode")) mode = asked.indexOf("ev-") === 0 ? "everything" : findItem(asked) ? readView(findItem(asked)) : mode;
    selected[mode] = asked;
  }

  if (root.dataset.state === "xray") root.setAttribute("data-xray", "");
  if (params.get("bar") === "off") root.setAttribute("data-bar-off", "");
  document.querySelectorAll("[data-user]").forEach(function (b) {
    b.setAttribute("aria-pressed", String(b.dataset.user === userKey));
  });
  render(true);
  // crew.js draws the sidebar when the document has loaded. This file loads after crew.js, so this
  // listener runs after that drawing.
  document.addEventListener("DOMContentLoaded", syncSidebarCount);
})();
