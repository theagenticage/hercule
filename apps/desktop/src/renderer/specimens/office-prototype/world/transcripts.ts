/**
 * PROTOTYPE - the transcripts the thread drawer shows: one believable thread
 * per session colleague, built from what the colleague asks, does and waits
 * on, so the drawer and the dossier card tell the same story.
 *
 * Today's sessions each follow a script written for them. The extra sessions
 * of the larger fleets share one script built from their title and area. The
 * Fix thread keeps the thread specimen's own records, FIX_THREAD.
 *
 * Each turn is timed against the session's `lastActivityAt`, which records.ts
 * sets from the colleague's state label:
 *
 * - a working colleague started its turn then, and its last item still runs;
 * - a waiting colleague opened its request then;
 * - any other colleague finished its turn then.
 */
import type { Session, TranscriptRow } from "@hercule/contract";
import type { ThreadScreenRecords } from "../../shell-page";
import { SPECIMEN_NOW } from "../../sidebar-fixture";
import { FIX_THREAD } from "../../thread-fixture";
import { SESSION_IDS } from "./fixture";
import type { Colleague, World } from "./types";

/** Removes the fields every event has from each event type of `Event`. */
type OmitEventBase<Event> = Event extends unknown
  ? Omit<Event, "eventId" | "sessionId" | "at">
  : never;

/** A provider event without the fields every event has, which `buildRows` fills in. */
type EventBody = OmitEventBase<TranscriptRow["event"]>;

/** The event that starts an item. */
type ItemStarted = Extract<EventBody, { _tag: "item.started" }>;

/** One item of a script: a tool call, a command, a file change, or a message. */
interface ScriptItem {
  readonly kind: ItemStarted["kind"];
  readonly detail?: NonNullable<ItemStarted["detail"]>;
  /** The text a message writes. */
  readonly text?: string;
}

/** One thread's turn: what the user asked, then what the agent did, in order. */
interface ThreadScript {
  readonly ask: string;
  readonly items: ReadonlyArray<ScriptItem>;
}

/** Returns a file read, as Claude Code reports it. */
const read = (path: string): ScriptItem => ({
  kind: "tool_call",
  detail: { name: "Read", input: { file_path: path }, kind: "native" },
});

/** Returns a shell command. */
const run = (command: string): ScriptItem => ({
  kind: "command_execution",
  detail: { name: "Bash", input: { command } },
});

/** Returns an edit of an existing file. */
const edit = (path: string): ScriptItem => ({
  kind: "file_change",
  detail: { name: "Edit", input: { file_path: path } },
});

/** Returns a new file written whole. */
const write = (path: string): ScriptItem => ({
  kind: "file_change",
  detail: { name: "Write", input: { file_path: path } },
});

/** Returns a tool call that the transcript summarises by its description. */
const callTool = (name: string, description: string): ScriptItem => ({
  kind: "tool_call",
  detail: { name, input: { description }, kind: "native" },
});

/** Returns a message of the agent's. */
const say = (text: string): ScriptItem => ({ kind: "assistant_message", text });

/** The scripts of today's sessions, by session id. The Fix thread has its own records. */
const SCRIPTS: Readonly<Record<string, ThreadScript>> = {
  [SESSION_IDS.read]: {
    ask: "Read the Stripe v14 changelog and list every breaking change that touches our checkout or the payments API.",
    items: [
      callTool("WebFetch", "stripe.com/docs/upgrades#2026-08-14"),
      read("src/checkout/payment.ts"),
      read("src/webhooks/charge.ts"),
      say(
        [
          "v14 has 11 breaking changes. Two of them touch us:",
          "",
          "- `confirmPayment` now returns `status: 'requires_action'` for cards that need " +
            "3‑D Secure. `handlePaymentResult` treats that as a failure.",
          "- Webhook payloads no longer carry `charges`, which `src/webhooks/charge.ts` reads.",
          "",
          "The other nine are in APIs we don't call. I would fix `requires_action` first: " +
            "EU cards fail at checkout until we do.",
        ].join("\n"),
      ),
    ],
  },
  [SESSION_IDS.migrate]: {
    ask: "Migrate the ops dashboards from Grafana 10 to the new Prometheus datasource. Keep every panel where it is.",
    items: [
      run("grafana-cli dashboards export --folder ops --out dashboards/"),
      edit("dashboards/ops-latency.json"),
      edit("dashboards/ops-queues.json"),
      edit("dashboards/ops-backups.json"),
      say(
        "Exported 14 dashboards and rewrote the 9 panels that read the old datasource. " +
          'The originals are still in the "Ops (legacy)" folder in Grafana.',
      ),
    ],
  },
  [SESSION_IDS.investigate]: {
    ask: "The nightly ops-db backup has timed out three nights running. Find out why.",
    items: [
      run("journalctl -u ops-db-backup --since '14 days ago'"),
      say(
        "`pg_dump` got slower once the `events` table passed 40 GB: from 18 minutes to 51, " +
          "against a 45-minute timeout. Checking how the dump reads that table.",
      ),
      run(
        "psql ops-db -c \"EXPLAIN ANALYZE SELECT count(*) FROM events WHERE created_at > now() - interval '1 day'\"",
      ),
    ],
  },
  [SESSION_IDS.refactor]: {
    ask: "The cart total is calculated in six places. Move it into one module.",
    items: [
      read("src/cart/cart.tsx"),
      read("src/checkout/summary.tsx"),
      write("src/cart/totals.ts"),
      edit("src/cart/cart.tsx"),
      edit("src/checkout/summary.tsx"),
      say(
        "Moved the totals into `src/cart/totals.ts` and replaced the 6 call sites. " +
          "Running the cart tests now.",
      ),
      run("pnpm test cart"),
    ],
  },
  [SESSION_IDS.webhook]: {
    ask: "Webhook retries hammer merchants whose endpoint is down. Add exponential backoff with jitter, capped at one hour.",
    items: [
      read("src/webhooks/retry.ts"),
      read("src/webhooks/queue.ts"),
      edit("src/webhooks/retry.ts"),
    ],
  },
  [SESSION_IDS.rounding]: {
    ask: "A customer paid €25.47 for 3 × €9.99 with 15% off. It should be €25.48. Fix the rounding.",
    items: [
      read("src/cart/discounts.ts"),
      run("pnpm vitest run src/cart/discounts.test.ts -t rounding"),
      say(
        "Reproduced: 3 × €9.99 with 15% off shows €25.47. We round each line before we add " +
          "them up, so three half cents are lost. Rounding once, on the total, gives €25.48.",
      ),
      edit("src/cart/discounts.ts"),
    ],
  },
  [SESSION_IDS.payout]: {
    ask: "Make the payout report for September: every Stripe payout, grouped by currency, as a CSV for finance.",
    items: [
      run("stripe payouts list --created.gte 2026-09-01 --all"),
      say("Pulled 1,204 payouts in four currencies. Grouping them by currency now."),
      write("reports/payouts-2026-09.csv"),
    ],
  },
  [SESSION_IDS.rotate]: {
    ask: "Rotate every staging secret older than 90 days, then restart the services that read them.",
    items: [
      run("vault kv list secret/staging"),
      run("scripts/rotate-secrets.sh --env staging --older-than 90d"),
      say(
        "Rotated 15 of the 23 secrets; the other 8 are younger than 90 days. " +
          "Restarting staging-api so it reads the new ones.",
      ),
      run("kubectl -n staging rollout restart deploy/staging-api"),
    ],
  },
  [SESSION_IDS.tidy]: {
    ask: "Remove the unused rules from the checkout stylesheets.",
    items: [
      run("npx purgecss --css 'src/checkout/**/*.css' --content 'src/checkout/**/*.tsx'"),
      edit("src/checkout/checkout.css"),
      edit("src/checkout/3ds-modal.css"),
      edit("src/checkout/summary.css"),
      say("Removed 41 unused rules across 3 files. Nothing on the checkout screens changed."),
    ],
  },
  [SESSION_IDS.label]: {
    ask: "Label the new GitHub issues by area, kind and priority.",
    items: [
      callTool("GitHub", "List the issues opened since 08:00"),
      callTool("GitHub", "Label 50 issues"),
      say(
        "Labelled 50 issues this hour. That is the hourly bound, so I stopped: " +
          "34 more events are held until you resume me.",
      ),
    ],
  },
  [SESSION_IDS.ship]: {
    ask: "Ship payments-api 2.15.0: bump the version, write the changelog, and publish to npm.",
    items: [
      edit("package.json"),
      edit("CHANGELOG.md"),
      run("pnpm pack"),
      say(
        "Bumped the version to 2.15.0, wrote the changelog and packed the tarball. " +
          "Publishing needs your go-ahead.",
      ),
    ],
  },
  [SESSION_IDS.ideal]: {
    ask: "Compare Stripe and Mollie for iDEAL: fees, settlement time, and how much code each needs.",
    items: [
      callTool("WebFetch", "stripe.com/docs/payments/ideal"),
      callTool("WebFetch", "docs.mollie.com/payments/ideal"),
      write("research/ideal.md"),
      say(
        "Wrote `research/ideal.md`. In short: Stripe costs €0.29 a payment and needs no new " +
          "code; Mollie costs €0.25 but needs a webhook handler of its own. I would stay with Stripe.",
      ),
    ],
  },
  [SESSION_IDS.draft]: {
    ask: "Draft a reply to Jonas at Kiteworks about the API rate limits. Keep it friendly, and offer the higher tier.",
    items: [
      callTool("Gmail", "Read Jonas's mail about API limits"),
      say(
        "Hi Jonas,\n\nThanks for the clear write-up. You're right that the standard tier caps " +
          "you at 100 requests a minute, and",
      ),
    ],
  },
};

/** Returns the script of a session from a larger fleet, built from its title and area. */
const buildGenericScript = (colleague: Colleague): ThreadScript => ({
  ask: `${colleague.title}. Keep the change small, and add a test.`,
  items: [
    read(`src/${colleague.area}/index.ts`),
    say(`I found where this lives in \`src/${colleague.area}\`. Making the change now.`),
    edit(`src/${colleague.area}/index.ts`),
    run(`pnpm test ${colleague.area}`),
  ],
});

/** The one turn of every office thread. */
const TURN_ID = "turn-1";

/** Seconds each item takes: a message is written quickly, a tool runs a little longer. */
const ITEM_SECONDS = 6;

/**
 * Returns the steps of `script` for `colleague`, each with the time it
 * happened. A working colleague's last item has started but not completed;
 * a waiting colleague ends on its request; anyone else ends the turn.
 */
const buildSteps = (
  colleague: Colleague,
  session: Session,
  script: ThreadScript,
): ReadonlyArray<readonly [at: number, body: EventBody]> => {
  const anchor = Date.parse(session.lastActivityAt ?? new Date(SPECIMEN_NOW).toISOString());
  const working = colleague.pose === "working";
  const count = script.items.length;
  // A working turn runs from the anchor to just before now. Any other turn
  // ended at the anchor, a minute after its last item started.
  const start = working ? anchor : anchor - (count * 50 + 60) * 1000;
  const end = working ? SPECIMEN_NOW - 15_000 : anchor - 60_000;
  const gap = (end - start) / Math.max(1, count);
  const steps: Array<readonly [number, EventBody]> = [
    [start, { _tag: "turn.started", turnId: TURN_ID, model: session.modelSelection.model }],
    [
      start,
      {
        _tag: "item.started",
        turnId: TURN_ID,
        itemId: "it-ask",
        kind: "user_message",
        detail: { text: script.ask },
      },
    ],
    [
      start,
      {
        _tag: "item.completed",
        turnId: TURN_ID,
        itemId: "it-ask",
        kind: "user_message",
        detail: { text: script.ask },
        status: "completed",
      },
    ],
  ];
  script.items.forEach((item, index) => {
    const itemId = `it-${String(index + 1)}`;
    const from = start + 20_000 + index * gap;
    const to = from + ITEM_SECONDS * 1000;
    const fields = {
      turnId: TURN_ID,
      itemId,
      kind: item.kind,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
    };
    steps.push([from, { _tag: "item.started", ...fields }]);
    if (item.text !== undefined) {
      steps.push([
        to,
        {
          _tag: "content.delta",
          turnId: TURN_ID,
          itemId,
          streamKind: "assistant_text",
          delta: item.text,
        },
      ]);
    }
    const running = working && index === count - 1;
    if (!running) steps.push([to, { _tag: "item.completed", ...fields, status: "completed" }]);
  });
  if (session.openRequest !== null) {
    steps.push([anchor, { _tag: "request.opened", request: session.openRequest }]);
  } else if (!working) {
    steps.push([
      anchor,
      {
        _tag: "turn.completed",
        turnId: TURN_ID,
        state: colleague.pose === "failed" ? "failed" : "completed",
        ...(colleague.pose === "failed"
          ? { error: `pnpm test ${colleague.area} failed: 2 of 48 tests.` }
          : {}),
      },
    ]);
  }
  return steps;
};

/** Returns the transcript rows of `steps` for `sessionId`, with positions from 1. */
const buildRows = (
  sessionId: string,
  steps: ReadonlyArray<readonly [at: number, body: EventBody]>,
): TranscriptRow[] =>
  steps.map(([time, body], index) => {
    const at = new Date(time).toISOString();
    return {
      position: index + 1,
      at,
      event: { ...body, eventId: `event-${String(index + 1)}`, sessionId, at },
    };
  });

/**
 * Returns what the thread screen reads for every session colleague of
 * `world`, given `threads`, the sessions the sidebar lists (records.ts), so
 * the drawer and the sidebar show the same session. Fails when a session
 * colleague has no session in `threads`.
 */
export function buildThreadScreenRecords(
  world: World,
  threads: ReadonlyArray<Session>,
): ReadonlyArray<ThreadScreenRecords> {
  const sessions = new Map(threads.map((session) => [session.id, session]));
  return world.colleagues
    .filter((colleague) => colleague.role === "session")
    .map((colleague) => {
      if (colleague.id === FIX_THREAD.session.id) return FIX_THREAD;
      const session = sessions.get(colleague.id);
      if (session === undefined) {
        throw new Error(`The sidebar lists no session for the colleague ${colleague.id}.`);
      }
      const script = SCRIPTS[colleague.id] ?? buildGenericScript(colleague);
      return {
        session,
        transcript: buildRows(session.id, buildSteps(colleague, session, script)),
        queuedInputs: [],
      };
    });
}
