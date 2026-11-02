// PROTOTYPE - the heavy morning the List and the Kanban draw: about 70 live sessions.
//
// Load it after ../../sidebar-directions/shared/world.js. It reads WORLD (the book's morning:
// 16 threads, their partners, the swarm's 19 threads, the Done shelf, the assistants) and builds
// window.HEAVY. It never changes WORLD, so other books that load world.js see the same facts.
//
// Every session carries a `digest`, the small record ../SIGNALS.md proposes: what the session is
// doing now, how far along it is, where it works and how its last check went. The digest only
// holds what Hercule can observe, so in this world:
//   - plans come from Hercule's own progress tool (`via: "hercule"`), and only for tasks of more
//     than three steps; short questions and research threads have none;
//   - a test run's outcome is "unknown" when its output had no summary line Hercule recognises
//     (about a third of runs; the command was piped through tail or grep);
//   - the focus is computed from the files the session edited, or from the files it read when it
//     has edited nothing yet, and ignores root-level files every agent reads (AGENTS.md,
//     CLAUDE.md, package.json, lockfiles).
//
// "Now" is Tuesday 29 September 2026, 09:41. Times are "HH:MM" that morning; "Mon HH:MM" and
// "Sun HH:MM" are earlier days.
(function () {
  "use strict";

  var W = window.WORLD;
  var NOW = "09:41";

  /* ------------------------------------------------------------------ small helpers */

  // Minutes since midnight on the morning of the 29th; earlier days are negative.
  function minutes(t) {
    if (t == null) return null;
    var days = 0;
    var m = /^(Mon|Sun|yesterday) (\d\d):(\d\d)$/.exec(t);
    if (m) {
      days = m[1] === "Sun" ? -2 : -1;
      return days * 1440 + Number(m[2]) * 60 + Number(m[3]);
    }
    var h = /^(\d\d):(\d\d)$/.exec(t);
    return h ? Number(h[1]) * 60 + Number(h[2]) : null;
  }

  // Root-level files every agent reads. They never count towards a focus.
  var ROOT_NOISE = /^(AGENTS\.md|CLAUDE\.md|README\.md|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lock|tsconfig\.json)$/;

  /*
   * Works out where a session works, by the rule in SIGNALS.md §3 (focus):
   *   - edits weigh 3 each (times the number of edits); reads weigh 1 and count only when the
   *     session has edited nothing in the turn;
   *   - root-level files are skipped;
   *   - the focus is the deepest folder holding at least 60% of the weight; when no folder
   *     below the root does, it is the two heaviest top-level folders, and `fallback` is true.
   * Returns null when there is no file to go by.
   */
  function computeFocus(edits, reads) {
    var files = [];
    edits.forEach(function (e) { files.push({ path: e[0], how: "edit", times: e[1] || 1 }); });
    reads.forEach(function (p) { files.push({ path: p, how: "read", times: 1 }); });
    var counted = files.filter(function (f) {
      if (f.path.indexOf("/") < 0 && ROOT_NOISE.test(f.path)) return false;
      if (f.path.indexOf("/") < 0) return false; // any other root-level file has no folder
      return edits.length ? f.how === "edit" : true;
    });
    if (!counted.length) return null;
    var weight = {};
    var total = 0;
    var fileWeight = {};
    counted.forEach(function (f) {
      var w = f.how === "edit" ? 3 * f.times : 1;
      total += w;
      fileWeight[f.path] = (fileWeight[f.path] || 0) + w;
      var parts = f.path.split("/");
      for (var i = 1; i < parts.length; i++) {
        var dir = parts.slice(0, i).join("/");
        weight[dir] = (weight[dir] || 0) + w;
      }
    });
    var best = null;
    Object.keys(weight).forEach(function (dir) {
      if (weight[dir] / total < 0.6) return;
      if (!best || dir.split("/").length > best.split("/").length) best = dir;
    });
    var hot = Object.keys(fileWeight).sort(function (a, b) { return fileWeight[b] - fileWeight[a]; })[0];
    var fallback = false;
    if (!best) {
      fallback = true;
      best = Object.keys(weight)
        .filter(function (d) { return d.indexOf("/") < 0; })
        .sort(function (a, b) { return weight[b] - weight[a]; })
        .slice(0, 2)
        .join(", ");
    }
    return {
      path: best,
      file: hot,
      files: files.map(function (f) { return f.times > 1 ? { path: f.path, how: f.how, times: f.times } : { path: f.path, how: f.how }; }),
      basis: edits.length ? "edits" : "reads",
      fallback: fallback,
    };
  }

  // Turns a list like ["x Find the cause", "> Fix it", "- Push"] into a plan. "x" is done, ">"
  // is the step in progress, "-" is still to do. `current` is the in-progress wording the agent
  // gave (the way Claude's activeForm reads).
  function buildPlan(lines, current, updatedAt) {
    if (!lines) return null;
    var steps = lines.map(function (l) {
      var mark = l.charAt(0);
      return { text: l.slice(2), status: mark === "x" ? "done" : mark === ">" ? "doing" : "todo" };
    });
    var done = steps.filter(function (s) { return s.status === "done"; }).length;
    return { via: "hercule", done: done, total: steps.length, current: current || null, steps: steps, updatedAt: updatedAt || null };
  }

  /*
   * Builds a digest from a compact description:
   *   phase, basis   the phase now and why ("edited totals.ts 40s ago")
   *   act            what it is doing now (working sessions only)
   *   turn, turns    when the current turn started, and how many turns it has had
   *   plan, cur, upd the progress list, the in-progress wording, when the list last changed
   *   ms             milestones: changed, tested, passing ("HH:MM" | false | "unknown"), failedAt,
   *                  committed, pushed, prOpen, prNumber
   *   edits, reads   [[path, times]] and [path] of the turn that sets the focus
   *   check          [class, command, outcome, at, counts]
   */
  function digest(d) {
    var ms = d.ms || {};
    return {
      activity: d.act || null,
      phase: d.phase,
      phaseBasis: d.basis,
      plan: buildPlan(d.plan, d.cur, d.upd),
      milestones: {
        changed: ms.changed || null,
        tested: ms.tested || null,
        passing: ms.passing === undefined ? null : ms.passing,
        failedAt: ms.failedAt || null,
        committed: ms.committed || null,
        pushed: ms.pushed || null,
        prOpen: ms.prOpen || null,
        prNumber: ms.prNumber || null,
      },
      focus: computeFocus(d.edits || [], d.reads || []),
      lastCheck: d.check
        ? (function () {
            var c = { class: d.check[0], command: d.check[1], outcome: d.check[2], at: d.check[3] };
            if (d.check[4]) c.counts = d.check[4];
            return c;
          })()
        : null,
      turnStartedAt: d.turn || null,
      turnCount: d.turns || 1,
    };
  }

  /* ------------------------------------------------------------------ the digests of the book's sessions */

  // Keyed by the ids in world.js. File paths agree with ../../overview-directions/shared/world-plus.js.
  var D = {
    // ---------------------------------------------------------------- webshop, the morning
    t3ds: {
      phase: "waiting", basis: "asked to push at 09:31", turn: "09:21", turns: 2,
      plan: ["x Find the cause", "x Write a failing test", "x Fix handlePaymentResult", "x Run the checkout tests", "> Push the branch", "- Open a pull request"],
      cur: "Pushing the branch", upd: "09:31",
      ms: { changed: "09:24", tested: "09:28", passing: "09:28", committed: "09:29" },
      edits: [["src/checkout/payment.ts", 2], ["src/checkout/payment.test.ts"], ["src/checkout/3ds-modal.tsx"]],
      reads: ["src/lib/stripe.ts", "src/checkout/payment-errors.ts", "src/checkout/checkout-page.tsx", "AGENTS.md"],
      check: ["test", "pnpm test checkout", "passed", "09:28", "24 passed"],
    },
    tStripe: {
      phase: "resting", basis: "idle since 09:21", turns: 1,
      reads: ["src/lib/stripe.ts", "src/checkout/payment.ts"],
    },
    t3dsReview: {
      phase: "verifying", basis: "running pnpm test checkout --grep status since 09:39", act: "Running pnpm test checkout --grep status", turn: "09:30",
      plan: ["x List the statuses v14 returns", "x Check each one is handled", "> Test the edge statuses", "- Report to the lead"],
      cur: "Testing the edge statuses", upd: "09:38",
      ms: { tested: "09:36", passing: false, failedAt: "09:36" },
      reads: ["src/checkout/payment.ts", "src/checkout/3ds-modal.tsx", "src/checkout/sepa.ts", "src/checkout/payment-errors.ts", "src/checkout/payment.test.ts", "src/lib/stripe.ts"],
      check: ["test", "pnpm test checkout --grep status", "failed", "09:36", "1 failed, 11 passed"],
    },
    tCart: {
      phase: "changing", basis: "edited totals.ts 30s ago", act: "Editing totals.ts", turn: "09:19",
      plan: ["x Map where totals are computed", "> Move discount maths into computeTotals", "- Update the cart page", "- Run the cart tests", "- Open a pull request"],
      cur: "Moving discount maths into computeTotals", upd: "09:23",
      ms: { changed: "09:25" },
      edits: [["src/cart/totals.ts", 3], ["src/cart/discounts.ts"], ["src/cart/coupon.ts"], ["src/cart/cart-store.ts"], ["src/cart/cart-page.tsx"], ["src/cart/totals.test.ts"], ["src/checkout/payment.ts"], ["src/lib/money.ts"]],
      reads: ["src/cart/README.md"],
    },
    tCartTests: {
      phase: "verifying", basis: "running pnpm test cart --property since 09:40", act: "Running pnpm test cart --property", turn: "09:24",
      plan: ["x Write 4 properties", "x Run 1,000 cases each", "> Shrink the failing case", "- Report to the lead"],
      cur: "Shrinking the failing case", upd: "09:40",
      ms: { changed: "09:28", tested: "09:31", passing: false, failedAt: "09:40" },
      edits: [["src/cart/totals.property.test.ts"]],
      reads: ["src/cart/totals.ts", "src/cart/discounts.ts"],
      check: ["test", "pnpm test cart --property", "failed", "09:40", "1 failed, 3 passed"],
    },
    tCss: {
      phase: "resting", basis: "idle since 07:40", turns: 2,
      plan: ["x Find unused rules", "x Remove them", "x Compare the screenshots", "x Open a pull request"], upd: "07:40",
      ms: { changed: "07:20", tested: "07:36", passing: "07:36", committed: "07:38", pushed: "07:39", prOpen: "07:40", prNumber: 1281 },
      edits: [["styles/checkout.css"], ["styles/cart.css"], ["src/checkout/card-form.module.css"], ["styles/buttons.css"]],
      check: ["test", "pnpm test:visual checkout", "passed", "07:36", "38 passed"],
    },
    tA11y: {
      phase: "resting", basis: "idle since 08:56", turns: 1,
      plan: ["x Run axe on the checkout", "x Check the card form by hand", "x Walk every keyboard path", "x List the issues"], upd: "08:56",
      ms: { changed: "08:52" },
      edits: [["src/checkout/card-form.module.css"]],
      reads: ["src/checkout/card-form.tsx", "src/checkout/checkout-page.tsx", "src/checkout/address-form.tsx"],
    },
    // ---------------------------------------------------------------- payments-api, the morning
    tPayout: {
      phase: "changing", basis: "edited report-csv.ts 1m ago", act: "Editing report-csv.ts", turn: "09:32",
      plan: ["x Query September payouts", "x Group by merchant and currency", "> Write the CSV and summary", "- Check totals against Stripe", "- Deliver the report"],
      cur: "Writing the CSV and summary", upd: "09:36",
      ms: { changed: "09:36" },
      edits: [["src/reports/september-payouts.ts", 2], ["src/reports/report-csv.ts"]],
      reads: ["src/payouts/payouts.service.ts", "src/platform/balance.ts"],
    },
    tPayoutCheck: {
      phase: "waiting", basis: "asked at 09:39", turn: "09:35",
    },
    tResult: {
      phase: "changing", basis: "edited payouts.controller.ts 20s ago", act: "Editing payouts.controller.ts", turn: "09:31", turns: 3,
      plan: ["x Inventory the payout endpoints", "x Migrate the endpoints to Result types", "x Contract tests pass", "x Open a draft pull request", "> Fix the blocking finding", "- Fix the second finding", "- Get a clean review", "- Mark the pull request ready"],
      cur: "Fixing the blocking finding on GET /v1/payouts/:id", upd: "09:31",
      ms: { changed: "08:52", tested: "09:05", passing: "09:05", committed: "09:08", pushed: "09:09", prOpen: "09:09", prNumber: 1287 },
      edits: [["src/payouts/payouts.controller.ts", 2], ["src/payouts/payout-error.ts"]],
      reads: ["src/result/errors.ts", "test/payouts.contract.test.ts"],
      check: ["test", "pnpm test payouts", "passed", "09:05", "212 passed"],
    },
    tResultReview: {
      phase: "resting", basis: "idle since 09:34", turns: 2,
      reads: ["src/payouts/payouts.controller.ts", "src/payouts/payout-error.ts", "src/result/errors.ts", "src/refunds/reversals.ts"],
    },
    tIdeal: {
      phase: "resting", basis: "idle since 08:41", turns: 1,
      reads: ["docs/payment-methods.md", "src/platform/client.ts"],
    },
    // ---------------------------------------------------------------- ops, the morning
    tDash: {
      phase: "waiting", basis: "asked at 09:36", turn: "09:20", turns: 3,
      plan: ["x Export the old dashboards", "x Convert them to Grafana 11", "x Import them", "> Decide what to do with the old folder", "- Re-point the alerts"],
      cur: "Deciding what to do with the old folder", upd: "09:07",
      ms: { changed: "09:02", committed: "09:06" },
      edits: [
        ["grafana/dashboards/checkout.json"], ["grafana/dashboards/payments.json"], ["grafana/dashboards/infra.json"], ["grafana/dashboards/backups.json"],
        ["grafana/dashboards/certs.json"], ["grafana/dashboards/queues.json"], ["grafana/dashboards/postgres.json"], ["grafana/dashboards/redis.json"],
        ["grafana/dashboards/nginx.json"], ["grafana/dashboards/runners.json"], ["grafana/dashboards/webhooks.json"], ["grafana/dashboards/payouts.json"],
        ["grafana/dashboards/uptime.json"], ["grafana/dashboards/costs.json"],
      ],
      reads: ["grafana/legacy/old-checkout.json", "grafana/alerts/infra-alerts.yaml"],
    },
    tDashAlerts: {
      phase: "resting", basis: "idle since 09:29", turns: 1,
      reads: ["grafana/alerts/checkout-alerts.yaml", "grafana/alerts/infra-alerts.yaml", "grafana/alerts/backup-alerts.yaml"],
    },
    tSecrets: {
      phase: "changing", basis: "edited staging.sops.yaml 15s ago", act: "Editing staging.sops.yaml", turn: "09:30",
      plan: ["x List the staging secrets", "> Rotate each secret", "- Restart the services", "- Check each service reads the new secrets"],
      cur: "Rotating secret 10 of 14", upd: "09:41",
      ms: { changed: "09:33" },
      edits: [["secrets/staging/staging.sops.yaml", 10]],
      reads: ["secrets/staging/rotate.sh"],
    },
    // ---------------------------------------------------------------- no project
    tBun: { phase: "resting", basis: "idle since 06:58", turns: 1 },

    // ---------------------------------------------------------------- the swarm: webshop
    sImg: {
      phase: "changing", basis: "edited image-loader.ts 1m ago", act: "Editing image-loader.ts", turn: "09:08",
      plan: ["x Measure the current LCP", "> Lazy-load the images below the fold", "- Serve AVIF with a fallback", "- Measure again"],
      cur: "Lazy-loading the images below the fold", upd: "09:14",
      ms: { changed: "09:15" },
      edits: [["src/catalog/product-image.tsx"], ["src/catalog/image-loader.ts", 2]],
      reads: ["styles/catalog.css"],
    },
    sImgLcp: {
      phase: "resting", basis: "idle since 09:26", turns: 1,
      reads: ["src/catalog/product-page.tsx", "src/catalog/product-image.tsx"],
      check: ["build", "pnpm build", "passed", "09:20"],
    },
    sApple: {
      phase: "changing", basis: "edited apple-pay.ts 2m ago", act: "Editing apple-pay.ts", turn: "09:14", turns: 4,
      plan: ["x Register the Apple Pay domain", "x Add the payment request button", "> Wire the payment sheet", "- Handle the shipping contact", "- Run the checkout tests", "- Open a pull request"],
      cur: "Wiring the payment sheet", upd: "09:14",
      ms: { changed: "08:34", tested: "09:10", passing: "unknown", committed: "09:12" },
      edits: [["src/checkout/apple-pay.ts", 3], ["src/checkout/checkout-page.tsx"], ["src/lib/money.ts"]],
      reads: ["src/checkout/payment.ts"],
      check: ["test", "pnpm test checkout 2>&1 | tail -20", "unknown", "09:10"],
    },
    sAppleReview: {
      phase: "resting", basis: "idle since 09:15", turns: 1,
      reads: ["src/checkout/apple-pay.ts", "public/.well-known/apple-developer-merchantid-domain-association"],
    },
    sAppleE2e: {
      phase: "waiting", basis: "asked at 09:37", turn: "09:30", turns: 2,
      ms: { changed: "09:08" },
      edits: [["e2e/apple-pay.spec.ts"]],
    },
    sCoupon: {
      phase: "changing", basis: "edited coupon.ts 40s ago", act: "Editing coupon.ts", turn: "09:33",
      ms: { changed: "09:36" },
      edits: [["src/cart/coupon.ts", 2]],
      reads: ["src/cart/discounts.ts"],
    },
    sDe: {
      phase: "resting", basis: "idle since Mon 17:30", turns: 2,
      ms: { changed: "Mon 16:20", committed: "Mon 17:20", pushed: "Mon 17:22" },
      edits: [["src/i18n/de.json"]],
    },
    sDeTone: {
      phase: "resting", basis: "asleep since Mon 17:05", turns: 1,
      reads: ["src/i18n/de.json"],
    },
    // ---------------------------------------------------------------- the swarm: payments-api
    sSig: {
      phase: "resting", basis: "idle since 09:20", turns: 2,
      plan: ["x Add a second signing secret", "x Accept both during the switch", "x Write the migration", "- Get a clean review"], upd: "09:05",
      ms: { changed: "08:50", tested: "09:00", passing: "09:00", committed: "09:02" },
      edits: [["src/webhooks/signing.ts"], ["db/migrations/0042-webhook-secret.sql"]],
      check: ["test", "pnpm test webhooks", "passed", "09:00", "48 passed"],
    },
    sSigReview: {
      phase: "waiting", basis: "asked at 09:38", turn: "09:05", turns: 1,
      reads: ["src/webhooks/signing.ts", "db/migrations/0042-webhook-secret.sql"],
    },
    sRefunds: {
      phase: "resting", basis: "idle since Mon 11:40", turns: 1,
      reads: ["src/refunds/refunds.service.ts", "src/refunds/reversals.ts"],
    },
    sRate: {
      phase: "verifying", basis: "running pnpm test rate-limit since 09:39", act: "Running pnpm test rate-limit", turn: "09:15",
      plan: ["x Add a token bucket per merchant", "x Wire it into the payout routes", "> Run the rate-limit tests", "- Load-test it"],
      cur: "Running the rate-limit tests", upd: "09:39",
      ms: { changed: "09:18", tested: "09:39" },
      edits: [["src/platform/rate-limit.ts", 2], ["src/payouts/payouts.routes.ts"]],
    },
    sRateLoad: {
      phase: "queued", basis: "queued at 09:39: build-box-1 is at its cap", turn: null, turns: 0,
    },
    // ---------------------------------------------------------------- the swarm: ops
    sPg: {
      phase: "verifying", basis: "running make -C extensions pg_partman since 09:38; failed at 09:12 and 09:33", act: "Running make -C extensions pg_partman", turn: "08:55", turns: 3,
      plan: ["x Read the 18 release notes", "x Update postgresql.conf", "x Plan the replica", "> Build pg_partman for 18", "- Upgrade staging", "- Upgrade production"],
      cur: "Building pg_partman for 18", upd: "08:58",
      ms: { changed: "08:20", committed: "08:45" },
      edits: [["postgres/extensions.sql"], ["postgres/postgresql.conf"], ["postgres/replica.tf"], ["postgres/upgrade-18.md"]],
      check: ["build", "make -C extensions pg_partman", "failed", "09:33", "exit 2"],
    },
    sPgRollback: {
      phase: "waiting", basis: "asked at 09:34", turn: "09:20", turns: 2,
      reads: ["postgres/replica.tf", "postgres/upgrade-18.md"],
    },
    sPgExt: {
      phase: "resting", basis: "idle since 09:02", turns: 1,
      reads: ["postgres/extensions.sql"],
    },
    sBackups: {
      phase: "changing", basis: "edited backup.sh 6m ago, then ran rclone copy", act: "Running rclone copy backups/ b2:ops-backups", turn: "09:20",
      plan: ["x Create the new bucket", "> Copy last week's backups", "- Point the job at the bucket", "- Run one backup"],
      cur: "Copying last week's backups", upd: "09:30",
      ms: { changed: "09:24" },
      edits: [["backups/b2-bucket.tf"], ["backups/backup.sh"]],
    },
    sDisk: {
      phase: "waiting", basis: "asked at 09:40", turn: "09:36", turns: 1,
      reads: ["hosts/build-box-1.yaml", "hosts/compose.yaml"],
    },
    sTalk: { phase: "resting", basis: "asleep since Sun 21:48", turns: 1 },
  };

  /* ------------------------------------------------------------------ new sessions of the heavy morning */

  // Fields as in world.js, plus machine, branch and kind (worktree | main | scratch | none).
  function n(id, title, project, provider, model, machine, branch, kind, pose, started, last, extra, d) {
    var s = { id: id, title: title, project: project, provider: provider, model: model, machine: machine, branch: branch, kind: kind, pose: pose, started: started, last: last, lead: null, role: null };
    Object.keys(extra || {}).forEach(function (k) { s[k] = extra[k]; });
    s._d = d;
    return s;
  }

  var NEW = [
    // ---------------------------------------------------------------- webshop
    n("n01", "Fix the flaky checkout e2e test on CI", "webshop", "claude", "Sonnet 5", "build-box-1", "fix/flaky-checkout-e2e", "worktree", "working", "08:44", "09:41", {}, {
      phase: "verifying", basis: "running pnpm test:e2e checkout since 09:39; failed at 09:18 and 09:37", act: "Running pnpm test:e2e checkout", turn: "08:49",
      plan: ["x Reproduce it on CI", "x Wait for the card iframe properly", "> Run the e2e suite three times in a row", "- Open a pull request"],
      cur: "Running the e2e suite again", upd: "09:16",
      ms: { changed: "09:05", tested: "09:18", passing: false, failedAt: "09:37" },
      edits: [["e2e/checkout.spec.ts", 2], ["e2e/helpers/card-iframe.ts"]],
      reads: ["playwright.config.ts", "e2e/fixtures/cards.ts"],
      check: ["test", "pnpm test:e2e checkout", "failed", "09:37", "2 failed, 46 passed"],
    }),
    n("n02", "Find why the checkout e2e test flakes only on CI", "webshop", "codex", "gpt-5.4", "build-box-1", "fix/flaky-checkout-e2e", "worktree", "working", "09:20", "09:41", { lead: "n01", role: "diagnosis" }, {
      phase: "exploring", basis: "read 3 files, no edit yet", act: "Reading ci.yml", turn: "09:20",
      reads: [".github/workflows/ci.yml", "e2e/checkout.spec.ts", "e2e/fixtures/cards.ts", "package.json"],
    }),
    n("n03", "Send order confirmation emails in Dutch", "webshop", "claude", "Sonnet 5", "studio-mac", "feat/nl-order-emails", "worktree", "working", "09:28", "09:41", {}, {
      phase: "exploring", basis: "read 3 files, no edit yet", act: "Reading layout.tsx", turn: "09:28",
      plan: ["> Read the email templates", "- Add the Dutch strings", "- Translate the confirmation email", "- Preview every email", "- Open a pull request"],
      cur: "Reading the email templates", upd: "09:29",
      reads: ["src/emails/order-confirmation.tsx", "src/emails/layout.tsx", "src/i18n/en.json"],
    }),
    n("n04", "Move product search to Meilisearch", "webshop", "claude", "Opus 5.5", "build-box-2", "feat/meilisearch", "worktree", "working", "08:10", "09:41", {}, {
      phase: "changing", basis: "edited search-endpoint.ts 1m ago", act: "Editing search-endpoint.ts", turn: "09:12", turns: 3,
      plan: ["x Run Meilisearch locally", "x Write the indexer", "x Sync products when they change", "> Swap the search endpoint", "- Keep Postgres search as a fallback", "- Compare the two", "- Remove the old search", "- Run the search tests", "- Open a pull request"],
      cur: "Swapping the search endpoint", upd: "09:12",
      ms: { changed: "08:30", tested: "08:58", passing: "unknown", committed: "09:00" },
      edits: [["src/search/search-endpoint.ts", 2], ["src/search/meili-client.ts"]],
      reads: ["src/search/postgres-search.ts"],
      check: ["test", "pnpm test search | tail -5", "unknown", "08:58"],
    }),
    n("n05", "Benchmark Meilisearch against Postgres search", "webshop", "codex", "gpt-5.4-mini", "build-box-2", "feat/meilisearch", "worktree", "idle", "09:00", "09:26", { lead: "n04", role: "benchmark" }, {
      phase: "resting", basis: "idle since 09:26", turns: 1,
      ms: { changed: "09:08", tested: "09:24", passing: "unknown" },
      edits: [["bench/search.bench.ts"]],
      reads: ["src/search/meili-client.ts"],
      check: ["test", "pnpm test search --bench | grep p95", "unknown", "09:24"],
    }),
    n("n06", "Review the Meilisearch index settings", "webshop", "claude", "Sonnet 5", "build-box-2", "feat/meilisearch", "worktree", "idle", "09:02", "09:19", { lead: "n04", role: "review" }, {
      phase: "resting", basis: "idle since 09:19", turns: 1,
      reads: ["src/search/index-settings.ts", "src/search/indexer.ts"],
    }),
    n("n07", "Wishlist: save items for later", "webshop", "claude", "Sonnet 5", "studio-mac", "feat/wishlist", "worktree", "working", "08:35", "09:41", {}, {
      phase: "changing", basis: "edited wishlist-page.tsx 2m ago", act: "Editing wishlist-page.tsx", turn: "09:22", turns: 2,
      plan: ["x Add the wishlist store", "x Add the heart button", "> Build the wishlist page", "- Move items to the cart", "- Run the wishlist tests", "- Open a pull request"],
      cur: "Building the wishlist page", upd: "09:22",
      ms: { changed: "08:41" },
      edits: [["src/wishlist/wishlist-page.tsx", 2], ["src/wishlist/wishlist-store.ts"]],
      reads: ["src/cart/cart-page.tsx"],
    }),
    n("n08", "Write end-to-end tests for the wishlist", "webshop", "codex", "gpt-5.4-mini", "studio-mac", "feat/wishlist", "worktree", "working", "09:10", "09:41", { lead: "n07", role: "tests" }, {
      phase: "verifying", basis: "running pnpm test:e2e wishlist since 09:40; failed at 09:36", act: "Running pnpm test:e2e wishlist", turn: "09:30", turns: 2,
      plan: ["x Write the add path", "x Write the remove path", "> Run them against the dev server", "- Write the move-to-cart path"],
      cur: "Running them against the dev server", upd: "09:30",
      ms: { changed: "09:18", tested: "09:36", passing: false, failedAt: "09:36" },
      edits: [["e2e/wishlist.spec.ts"]],
      check: ["test", "pnpm test:e2e wishlist", "failed", "09:36", "1 failed, 5 passed"],
    }),
    n("n09", "Why did the cart page bundle grow by 40 KB?", "webshop", "claude", "Haiku 4.5", "build-box-1", "main", "main", "idle", "08:12", "08:24", {}, {
      phase: "resting", basis: "idle since 08:24", turns: 1,
      reads: ["vite.config.ts", "src/cart/cart-page.tsx", "src/cart/cart-store.ts", "src/lib/date.ts"],
      check: ["build", "pnpm build --analyze", "passed", "08:22"],
    }),
    n("n10", "Upgrade React Router to 8", "webshop", "claude", "Opus 5.5", "build-box-2", "chore/react-router-8", "worktree", "working", "07:50", "09:41", {}, {
      phase: "shipping", basis: "pushed at 09:40, now running gh pr create", act: "Running gh pr create", turn: "09:34", turns: 4,
      plan: ["x Read the migration guide", "x Update the routes", "x Fix the loaders", "x Fix the tests", "x Check every route loads", "x Commit", "> Open the pull request", "- Ask for a review"],
      cur: "Opening the pull request", upd: "09:40",
      ms: { changed: "08:05", tested: "08:50", passing: "09:31", committed: "09:38", pushed: "09:40" },
      reads: ["src/routes/index.tsx", "src/routes/checkout.tsx"],
      check: ["test", "pnpm test", "passed", "09:31", "412 passed"],
    }),
    n("n11", "Check every route still loads after the React Router upgrade", "webshop", "codex", "gpt-5.4", "build-box-2", "chore/react-router-8", "worktree", "idle", "09:05", "09:33", { lead: "n10", role: "route check" }, {
      phase: "resting", basis: "idle since 09:33", turns: 1,
      ms: { changed: "09:12", tested: "09:20", passing: "09:33" },
      edits: [["e2e/routes.spec.ts"]],
      reads: ["src/routes/index.tsx"],
      check: ["test", "pnpm test:e2e routes", "passed", "09:33", "41 passed"],
    }),
    n("n12", "Draft copy for the autumn sale banner", "webshop", "pi", "qwen3-coder 30b", "studio-mac", "main", "main", "idle", "09:05", "09:14", {}, {
      phase: "resting", basis: "idle since 09:14", turns: 1,
      ms: { changed: "09:12" },
      edits: [["src/content/banners/autumn.md"]],
    }),
    n("n13", "Fix the out-of-stock badge on mobile", "webshop", "claude", "Sonnet 5", "build-box-1", "fix/oos-badge-mobile", "worktree", "idle", "08:55", "09:08", {}, {
      phase: "resting", basis: "idle since 09:08", turns: 1,
      ms: { changed: "09:02", tested: "09:06", passing: "unknown", committed: "09:07" },
      edits: [["styles/product-card.css"], ["src/catalog/product-card.tsx"]],
      reads: ["src/catalog/stock.ts"],
      check: ["test", "pnpm test catalog | tail -3", "unknown", "09:06"],
    }),
    n("n14", "Summarise last week's checkout feedback from Intercom", "webshop", "claude", "Sonnet 5", "studio-mac", null, "scratch", "idle", "08:00", "08:12", { startedBy: "assistant:Ada" }, {
      phase: "resting", basis: "idle since 08:12", turns: 1,
    }),

    // ---------------------------------------------------------------- payments-api
    n("p01", "Add SEPA Direct Debit payouts", "payments-api", "claude", "Opus 5.5", "studio-mac", "feat/sepa-payouts", "worktree", "working", "08:15", "09:41", {}, {
      phase: "changing", basis: "edited sepa-payouts.ts 45s ago", act: "Editing sepa-payouts.ts", turn: "09:25", turns: 3,
      plan: ["x Model the mandate", "x Store mandates", "> Create SEPA payouts", "- Handle returned payouts", "- Run the contract tests", "- Write the docs", "- Get a clean review", "- Open a pull request"],
      cur: "Creating SEPA payouts", upd: "09:25",
      ms: { changed: "08:40", tested: "09:10", passing: "unknown", committed: "09:15" },
      edits: [["src/sepa/sepa-payouts.ts", 2], ["src/sepa/mandates.ts"]],
      reads: ["src/payouts/payouts.service.ts"],
      check: ["test", "pnpm test sepa 2>&1 | tail -15", "unknown", "09:10"],
    }),
    n("p02", "Adversarial review of the SEPA mandate flow", "payments-api", "codex", "gpt-5.4", "studio-mac", "feat/sepa-payouts", "worktree", "working", "09:16", "09:41", { lead: "p01", role: "review" }, {
      phase: "exploring", basis: "read 3 files and searched 2, no edit", act: "Searching for createPayout", turn: "09:16",
      reads: ["src/sepa/mandates.ts", "src/sepa/sepa-payouts.ts", "src/sepa/mandate.test.ts"],
    }),
    n("p03", "Generate the 2025 tax export for the Netherlands", "payments-api", "codex", "gpt-5.4", "build-box-2", "report/tax-export-nl", "worktree", "working", "08:50", "09:41", {}, {
      phase: "changing", basis: "edited tax-export-nl.ts 3m ago", act: "Editing tax-export-nl.ts", turn: "09:20", turns: 2,
      plan: ["x Find every taxable payout", "x Group them by quarter", "> Write the export", "- Check the totals against the ledger", "- Deliver the export"],
      cur: "Writing the export", upd: "09:20",
      ms: { changed: "09:22" },
      edits: [["src/reports/tax-export-nl.ts", 2]],
      reads: ["src/reports/report-csv.ts", "src/platform/ledger.ts"],
    }),
    n("p04", "Check the tax export totals against the ledger", "payments-api", "claude", "Sonnet 5", "build-box-2", "report/tax-export-nl", "worktree", "idle", "09:10", "09:18", { lead: "p03", role: "check" }, {
      phase: "resting", basis: "idle since 09:18", turns: 1,
      ms: { tested: "09:17", passing: "09:17" },
      reads: ["src/reports/tax-export-nl.ts", "src/platform/ledger.ts"],
      check: ["test", "pnpm test reports", "passed", "09:17", "14 passed"],
    }),
    n("p05", "Investigate the 502s on POST /v1/refunds", "payments-api", "claude", "Sonnet 5", "build-box-1", "main", "main", "idle", "09:02", "09:29", { startedBy: "assistant:Milo" }, {
      phase: "resting", basis: "idle since 09:29", turns: 1,
      reads: ["src/refunds/refunds.controller.ts", "src/refunds/refunds.service.ts", "src/platform/client.ts"],
    }),
    n("p06", "Speed up the payout list query", "payments-api", "claude", "Sonnet 5", "build-box-2", "perf/payout-list", "worktree", "working", "08:30", "09:41", {}, {
      phase: "shipping", basis: "pushed at 09:39, now running gh pr create", act: "Running gh pr create", turn: "09:36", turns: 3,
      plan: ["x Find the slow query", "x Add the index", "x Rewrite the pagination", "x Run the payout tests", "> Open the pull request"],
      cur: "Opening the pull request", upd: "09:37",
      ms: { changed: "08:55", tested: "09:20", passing: "09:34", committed: "09:37", pushed: "09:39" },
      reads: ["src/payouts/payout-list.ts", "src/payouts/payout-list.test.ts"],
      check: ["test", "pnpm test payouts", "passed", "09:34", "64 passed"],
    }),
    n("p07", "Write the migration for the payout_batches table", "payments-api", "codex", "gpt-5.4-mini", "build-box-1", "feat/payout-batches", "worktree", "idle", "09:00", "09:21", {}, {
      phase: "resting", basis: "idle since 09:21", turns: 1,
      ms: { changed: "09:05", tested: "09:19", passing: "unknown", committed: "09:20" },
      edits: [["db/migrations/0043-payout-batches.sql"], ["db/migrations/0043-payout-batches.down.sql"]],
      reads: ["src/payouts/payout-batch.ts"],
      check: ["test", "pnpm test db | grep -E 'pass|fail'", "unknown", "09:19"],
    }),
    n("p08", "Rotate the Stripe restricted API keys", "payments-api", "claude", "Haiku 4.5", "build-box-2", "main", "main", "idle", "07:30", "07:52", {}, {
      phase: "resting", basis: "idle since 07:52", turns: 1,
      plan: ["x List the restricted keys", "x Create the new keys", "x Update the secrets", "x Revoke the old keys"], upd: "07:51",
      ms: { changed: "07:40", committed: "07:50", pushed: "07:51" },
      edits: [["config/stripe.sops.yaml"]],
    }),
    n("p09", "Can we refund to a different card than the one charged?", "payments-api", "claude", "Haiku 4.5", "build-box-2", null, "scratch", "idle", "09:12", "09:15", {}, {
      phase: "resting", basis: "idle since 09:15", turns: 1,
    }),
    n("p10", "Typecheck the SDK against the new Result types", "payments-api", "codex", "gpt-5.4-mini", "studio-mac", "rogier/result-types", "worktree", "working", "09:12", "09:41", { lead: "tResult", role: "typecheck" }, {
      phase: "verifying", basis: "running pnpm typecheck since 09:40; 19 errors at 09:31, 12 at 09:38", act: "Running pnpm typecheck", turn: "09:12",
      plan: ["x Point the SDK at the new types", "> Fix the type errors", "- Typecheck clean", "- Report to the lead"],
      cur: "Fixing the type errors", upd: "09:31",
      ms: { changed: "09:20" },
      edits: [["sdk/src/payouts.ts", 2], ["sdk/src/errors.ts"]],
      reads: ["src/result/errors.ts"],
      check: ["typecheck", "pnpm typecheck", "failed", "09:38", "12 errors"],
    }),
    n("p11", "Document the webhook retry policy", "payments-api", "claude", "Sonnet 5", "build-box-1", "docs/webhook-retries", "worktree", "idle", "09:00", "09:20", {}, {
      phase: "resting", basis: "idle since 09:20", turns: 1,
      plan: ["x Read the retry code", "x Write the policy page", "x Add examples", "x Link it from the API docs"], upd: "09:19",
      ms: { changed: "09:10", committed: "09:19" },
      edits: [["docs/webhooks.md", 2]],
      reads: ["src/webhooks/retry.ts"],
    }),
    n("p12", "Draft the payments-api 2.16 release notes", "payments-api", "claude", "Sonnet 5", "studio-mac", "main", "main", "idle", "09:15", "09:24", { startedBy: "assistant:Ada" }, {
      phase: "resting", basis: "idle since 09:24", turns: 1,
      ms: { changed: "09:22" },
      edits: [["docs/releases/2.16.md"]],
      reads: ["CHANGELOG.md"],
    }),

    // ---------------------------------------------------------------- ops
    n("o01", "Move the status page to the new CDN", "ops", "claude", "Sonnet 5", "build-box-1", "ops/status-cdn", "worktree", "working", "08:20", "09:41", {}, {
      phase: "shipping", basis: "committed at 09:39, now running git push", act: "Running git push", turn: "09:28", turns: 3,
      plan: ["x Create the CDN zone", "x Point the DNS", "x Upload the status page", "x Check the TLS certificate", "> Push the change", "- Remove the old origin"],
      cur: "Pushing the change", upd: "09:39",
      ms: { changed: "08:40", committed: "09:39" },
      edits: [["cdn/status-page.tf"]],
      reads: ["dns/zones.tf"],
      check: ["build", "make status-page", "passed", "09:20"],
    }),
    n("o02", "Tune the alert thresholds for queue depth", "ops", "pi", "qwen3-coder 30b", "studio-mac", "ops/queue-alerts", "worktree", "idle", "09:00", "09:17", {}, {
      phase: "resting", basis: "idle since 09:17", turns: 1,
      ms: { changed: "09:15" },
      edits: [["grafana/alerts/queue-alerts.yaml"]],
    }),
    n("o03", "Renew the wildcard certificate for *.staging", "ops", "claude", "Haiku 4.5", "build-box-2", "main", "main", "idle", "07:05", "07:20", {}, {
      phase: "resting", basis: "idle since 07:20", turns: 1,
      ms: { changed: "07:12", committed: "07:18", pushed: "07:19" },
      edits: [["certs/staging-wildcard.tf"]],
    }),
    n("o04", "Plan the cleanup of /var/lib/docker on build-box-1", "ops", "codex", "gpt-5.4", "build-box-1", null, "scratch", "idle", "09:38", "09:40", { lead: "sDisk", role: "cleanup plan" }, {
      phase: "resting", basis: "idle since 09:40", turns: 1,
    }),
    n("o05", "Upgrade Redis to 8 on staging", "ops", "claude", "Sonnet 5", "build-box-1", "ops/redis-8", "worktree", "working", "09:26", "09:41", {}, {
      phase: "exploring", basis: "read 3 files, no edit yet", act: "Reading sentinel.conf", turn: "09:26",
      plan: ["> Read the Redis 8 upgrade notes", "- Update the compose file", "- Run the staging smoke tests", "- Push the change", "- Upgrade staging", "- Watch it for a day"],
      cur: "Reading the Redis 8 upgrade notes", upd: "09:27",
      reads: ["redis/redis.conf", "redis/sentinel.conf", "hosts/compose.yaml", "CLAUDE.md"],
    }),
    n("o06", "Write a runbook for the backup timeouts", "ops", "claude", "Sonnet 5", "studio-mac", "main", "main", "idle", "09:36", "09:40", { startedBy: "assistant:Milo" }, {
      phase: "resting", basis: "idle since 09:40", turns: 1,
      ms: { changed: "09:39" },
      edits: [["runbooks/backup-timeouts.md"]],
      reads: ["backups/backup.sh"],
    }),
    n("o07", "Check the Terraform plan for the new backup bucket", "ops", "codex", "gpt-5.4", "build-box-1", "ops/backup-bucket", "worktree", "idle", "09:25", "09:31", { lead: "sBackups", role: "plan check" }, {
      phase: "resting", basis: "idle since 09:31", turns: 1,
      reads: ["backups/b2-bucket.tf"],
    }),

    // ---------------------------------------------------------------- no project
    n("x01", "Compare three ways to cache LLM prompts", null, "claude", "Opus 5.5", "studio-mac", null, "none", "working", "09:30", "09:41", {}, {
      phase: "exploring", basis: "searched the web 6 times, no files", act: "Searching the web for prompt caching benchmarks", turn: "09:30",
    }),
    n("x02", "Plan the agenda for the team offsite", null, "claude", "Haiku 4.5", "studio-mac", null, "none", "asleep", "Mon 15:00", "Mon 15:20", { startedBy: "assistant:Ada" }, {
      phase: "resting", basis: "asleep since Mon 15:20", turns: 1,
    }),
  ];

  /* ------------------------------------------------------------------ who Rogier follows, and when he last looked */

  var FOLLOWING = { t3ds: true, tCartTests: true, tResult: true, sPg: true, n04: true, p01: true, n11: true };

  // When Rogier last opened each session. The book's values agree with world-plus.js; null means never.
  var LAST_SEEN = {
    t3ds: "09:41", tStripe: "09:22", t3dsReview: "09:32", tCart: "09:20", tCartTests: null,
    tCss: "07:45", tA11y: "08:50", tPayout: "09:33", tPayoutCheck: null, tResult: "09:15",
    tResultReview: "09:20", tIdeal: "08:45", tDash: "09:10", tDashAlerts: null, tSecrets: "09:31",
    tBun: "07:00",
    sImg: "09:10", sImgLcp: null, sApple: "09:05", sAppleReview: null, sAppleE2e: "09:03",
    sCoupon: "09:34", sDe: "Mon 17:31", sDeTone: null, sSig: "09:21", sSigReview: null,
    sRefunds: "Mon 11:45", sRate: "09:16", sRateLoad: null, sPg: "08:32", sPgRollback: "08:33",
    sPgExt: null, sBackups: "09:21", sDisk: null, sTalk: "Sun 21:50",
    n01: "08:50", n02: null, n03: "09:29", n04: "09:13", n05: null, n06: "09:20", n07: "09:23",
    n08: null, n09: "08:25", n10: "09:35", n11: null, n12: "09:15", n13: "09:00", n14: null,
    p01: "09:26", p02: null, p03: "09:21", p04: "09:20", p05: null, p06: "09:30", p07: "09:22",
    p08: "08:00", p09: null, p10: null, p11: "09:05", p12: null,
    o01: "09:29", o02: "09:18", o03: "07:30", o04: null, o05: "09:27", o06: null, o07: "09:32",
    x01: "09:31", x02: null,
  };

  /* ------------------------------------------------------------------ build the sessions */

  // world.js keeps a thread's machine and branch on its workspace; the swarm keeps them on the thread.
  function placeOf(t) {
    var ws = W.workspaces[t.workspace];
    if (ws) {
      var kind = ws.kind === "none" ? "none" : ws.kind;
      return { machine: ws.machine, branch: ws.kind === "worktree" || ws.kind === "main" ? ws.branch : null, kind: kind };
    }
    return { machine: t.machine, branch: t.branch || null, kind: t.branch === "main" ? "main" : t.branch ? "worktree" : "none" };
  }

  function startedByOf(t) {
    if (t.startedBy) return t.startedBy;
    if (!t.lead) return "user";
    return t.joined === "added" ? "user" : "session:" + t.lead;
  }

  // Sessions an assistant started, per world-plus.js.
  var ASSISTANT_STARTED = { sDisk: "assistant:Milo" };

  var sessions = [];
  W.threads.concat(W.swarm.threads).forEach(function (t) {
    var place = placeOf(t);
    var s = {
      id: t.id, title: t.title, project: t.project, provider: t.provider, model: t.model,
      machine: place.machine, branch: place.branch, kind: place.kind,
      pose: t.pose, queued: t.status === "queued",
      lead: t.lead || null, role: t.role || null,
      startedBy: ASSISTANT_STARTED[t.id] || startedByOf(t),
      started: t.started, last: t.last,
    };
    if (t.pose === "waiting") {
      s.ask = t.ask;
      s.askShort = t.askShort;
      s.askKind = t.status; // "approval" or "question"
    }
    s.digest = digest(D[t.id]);
    sessions.push(s);
  });
  NEW.forEach(function (t) {
    var s = {
      id: t.id, title: t.title, project: t.project, provider: t.provider, model: t.model,
      machine: t.machine, branch: t.branch, kind: t.kind,
      pose: t.pose, queued: false, lead: t.lead, role: t.role,
      startedBy: t.startedBy || (t.lead ? "session:" + t.lead : "user"),
      started: t.started, last: t.last,
    };
    s.digest = digest(t._d);
    sessions.push(s);
  });
  sessions.forEach(function (s) {
    s.following = !!FOLLOWING[s.id];
    s.lastSeen = LAST_SEEN.hasOwnProperty(s.id) ? LAST_SEEN[s.id] : null;
  });

  /* ------------------------------------------------------------------ runs, Done today, counts */

  // The runs of the morning, as world-plus.js tells them. The Ship release step waits on Rogier.
  var RUNS = [
    { id: "runShip", workflow: "Ship release", title: "Ship release v2.15", project: "payments-api", machine: "build-box-2", status: "running", started: "09:05",
      waiting: { session: "rShip", step: "publish", ask: "Publish payments-api 2.15.0 to npm?", askShort: "Publish to npm?", since: "09:33" },
      steps: [{ label: "Write the changelog", state: "completed" }, { label: "Build and test", state: "completed" }, { label: "Publish to npm", state: "waiting" }, { label: "Announce the release", state: "pending" }] },
    { id: "runWebhook", workflow: "Fix bug", title: "Webhook retry backoff", project: "payments-api", machine: "build-box-1", status: "running", started: "09:20",
      steps: [{ label: "Reproduce", state: "completed" }, { label: "Write the fix", state: "running" }, { label: "Test", state: "pending" }, { label: "Open a PR", state: "pending" }] },
    { id: "runRounding", workflow: "Fix bug", title: "Cart total rounding on discounts", project: "webshop", machine: "build-box-1", status: "running", started: "09:25",
      steps: [{ label: "Reproduce", state: "completed" }, { label: "Write the fix", state: "running" }, { label: "Test", state: "pending" }, { label: "Open a PR", state: "pending" }] },
    { id: "runBackup", workflow: "Investigate", title: "Investigate backup timeouts", project: "ops", machine: "build-box-1", status: "running", started: "09:35",
      steps: [{ label: "Investigate", state: "running" }, { label: "Report", state: "pending" }] },
    { id: "runLabel", workflow: "Label new issues", title: "Label new issues", project: "webshop", machine: "build-box-1", status: "paused", started: "08:00",
      pausedReason: "The Spawn Bound (20 per hour) tripped at 08:14.", steps: [{ label: "Label the issue", state: "paused" }] },
    { id: "runJonas", workflow: "Draft reply", title: "Draft reply to Jonas at Kiteworks", project: "payments-api", machine: "build-box-2", status: "running", started: "09:40",
      steps: [{ label: "Draft the reply", state: "running" }, { label: "Send it", state: "pending" }] },
    { id: "runNightly", workflow: "Nightly backup check", title: "Nightly backup check", project: "ops", machine: "build-box-1", status: "completed", started: "04:30", ended: "04:33",
      steps: [{ label: "Check last night's backup", state: "completed" }, { label: "Post to Slack #ops", state: "completed" }] },
  ];

  // Sessions marked Done this morning, newest first. The first one is world.js's Done shelf entry.
  var DONE_TODAY = [
    { id: "d01", title: "Add the iDEAL logo to checkout", project: "webshop", provider: "claude", model: "Sonnet 5", doneAt: "09:25", lead: null, role: null },
    { id: "d02", title: "Remove the old PayPal button", project: "webshop", provider: "claude", model: "Haiku 4.5", doneAt: "09:10", lead: null, role: null },
    { id: "dCert", title: "Renew the status page TLS certificate", project: "ops", provider: "claude", model: "Sonnet 5", doneAt: "08:55", lead: null, role: null },
    { id: "d03", title: "Fix the broken coupon link in the newsletter", project: "webshop", provider: "claude", model: "Sonnet 5", doneAt: "08:40", lead: null, role: null },
    { id: "d04", title: "Export August refunds for accounting", project: "payments-api", provider: "codex", model: "gpt-5.4", doneAt: "08:30", lead: null, role: null },
    { id: "d05", title: "Bump Vite to 8", project: "webshop", provider: "claude", model: "Sonnet 5", doneAt: "08:20", lead: null, role: null },
    { id: "d06", title: "Fix the payout webhook signature check", project: "payments-api", provider: "claude", model: "Opus 5.5", doneAt: "08:05", lead: null, role: null },
    { id: "d07", title: "Review the payout webhook signature fix", project: "payments-api", provider: "codex", model: "gpt-5.4", doneAt: "08:05", lead: "d06", role: "review" },
    { id: "d08", title: "Why is checkout slow on Safari?", project: "webshop", provider: "claude", model: "Haiku 4.5", doneAt: "07:55", lead: null, role: null },
    { id: "d09", title: "Clean up old Grafana users", project: "ops", provider: "pi", model: "qwen3-coder 30b", doneAt: "07:40", lead: null, role: null },
    { id: "d10", title: "Patch OpenSSL on build-box-2", project: "ops", provider: "claude", model: "Sonnet 5", doneAt: "07:15", lead: null, role: null },
    { id: "d11", title: "Summarise yesterday's Sentry errors", project: null, provider: "claude", model: "Haiku 4.5", doneAt: "07:05", lead: null, role: null, startedBy: "assistant:Ada" },
  ];

  function count(pose) {
    return sessions.filter(function (s) { return s.pose === pose; }).length;
  }
  var waitingRuns = RUNS.filter(function (r) { return r.waiting; }).length;
  var COUNTS = {
    total: sessions.length,
    working: count("working"),
    waitingThreads: count("waiting"),
    waiting: count("waiting") + waitingRuns, // what every "waiting on you" count shows: threads and the run step
    idle: count("idle"),
    asleep: count("asleep"),
    doneToday: DONE_TODAY.length,
  };

  var PROJECTS = [
    { id: "webshop", name: "webshop", tint: "webshop" },
    { id: "payments-api", name: "payments-api", tint: "payments" },
    { id: "ops", name: "ops", tint: "ops" },
  ];

  window.HEAVY = {
    now: NOW,
    today: "Tuesday 29 September 2026",
    projects: PROJECTS,
    sessions: sessions,
    runs: RUNS,
    doneToday: DONE_TODAY,
    assistants: W.assistants,
    counts: COUNTS,
    session: function (id) {
      for (var i = 0; i < sessions.length; i++) if (sessions[i].id === id) return sessions[i];
      return null;
    },
    teamOf: function (leadId) {
      return sessions.filter(function (s) { return s.id === leadId || s.lead === leadId; });
    },
    minutes: minutes,
  };
})();
