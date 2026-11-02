// PROTOTYPE - what The Firm reads that ../shared/world-plus.js does not hold.
//
// Load it after ../../sidebar-directions/shared/world.js and ../shared/world-plus.js. It adds
// window.FIRM and never changes a fact the world states.
//
//   assistants   each assistant's title, provider and model (shared/CONTENT.md, Assistants)
//   standup      what each member answers when Rogier asks its team for a stand-up: one line in
//                its own voice, written by one model call per member, only on demand. A session
//                with no line here answers with its latest headline.
//   stressUsage  token usage for world.js's ten-thread team (the stress state), which world-plus
//                does not stamp. The swarm shows that team, because it is the one team big enough
//                for the span-of-control hint. Codex reports no usage, so its four are null.
//   origins      how a run's origin reads after "by": the trigger's source, or the person.
(function () {
  "use strict";

  if (!window.WORLD || !window.WORLD.helpers) throw new Error("the-firm-data.js: load world.js and world-plus.js first");

  window.FIRM = {
    assistants: {
      Ada: { title: "personal assistant", provider: "claude", model: "Sonnet 5", doing: "answering your backup question in Web chat" },
      Milo: { title: "ops assistant", provider: "codex", model: "gpt-5.4", doing: "watching Slack #ops" },
      Juno: { title: "support assistant", provider: "claude", model: "Haiku 4.5", doing: "asleep until a message wakes it" },
    },

    standup: {
      // webshop
      t3ds: "Fix written, 24 checkout tests pass. I'm waiting on you to push.",
      tStripe: "Done at 09:21: four v14 changes touch checkout. I told the lead.",
      t3dsReview: "1 finding so far, still reading status handling.",
      tCart: "Discount maths is in computeTotals. Now fixing the rounding tests found.",
      tCartTests: "1 property fails: rounding at 3 decimals. Shrinking the case now.",
      tCss: "PR #1281 is open and CI is green. It only needs a merge.",
      tA11y: "Report delivered at 08:56: 6 issues, 2 of them on the card form.",
      // payments-api
      tPayout: "1,284 payouts grouped. Writing the CSV, ~21-24m to go.",
      tPayoutCheck: "Stripe's numbers are in. I'm stuck until you say how refunds count.",
      tResult: "Fixing the blocking finding on GET /v1/payouts/:id, then I ask to push.",
      tResultReview: "3 findings, 1 blocking, sent at 09:31. Idle until the fix lands.",
      tIdeal: "Answered at 08:41: the Payment Element needs the least code.",
      // ops
      tDash: "14 dashboards moved. I'm waiting on you about the old Grafana folder.",
      tDashAlerts: "All 31 alerts fire, 2 point at removed panels. Nothing left for me.",
      tSecrets: "9 of 14 secrets rotated, ~2m each.",
      tSecretsVerify: "Just started: restarting staging services one at a time.",
      // no project
      tBun: "Answered at 06:58: 3 changes in Bun 1.4 affect the webshop build.",
    },

    stressUsage: {
      xLead: 4180000, xReview: null, xTests: null, xDocs: 620000, xInventory: 118000,
      xMobile: null, xBench: null, xRefunds: 1240000, xChangelog: 64000, xStripe: 52000,
    },

    origins: {
      user: "you",
      "trigger: Gmail": "Gmail",
      "trigger: GitHub issue opened": "GitHub",
      "trigger: Cron": "schedule",
    },
  };
})();
