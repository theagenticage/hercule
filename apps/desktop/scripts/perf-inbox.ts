/**
 * The desktop perf script's Inbox scenario: what the Inbox costs, row by row
 * of spec 17 §What the Inbox costs. Pass `--inbox-only` to `perf.ts`.
 *
 * GitHub cannot be reached offline, so the Inbox's world is written into the
 * stopped controller's database, in the shape the GitHub plugin reports it,
 * as the desktop end-to-end suite does. The
 * invented world is Northwind Market's (see `writeInboxWorld`):
 *
 * - one GitHub Connection that holds no token, so the controller never polls
 *   it and the rows stay as written;
 * - 10 repositories, the places;
 * - 300 cards, each `part of` one repository: 60 pull requests that ask for
 *   the user's review, which lie in Requests, and 240 issues assigned to the
 *   user, which lie under Ongoing;
 * - 300 open signals, one on each card: a review request on each pull
 *   request and a mention on each issue, each about an event of its own.
 *
 * The launches (see `measureInbox`): a thread open, to compare with, and the
 * Inbox. Each is measured by `measureDeskLaunch` (see `perf-work.ts`), and
 * the Inbox launch has no steps of its own yet.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ThreadFixture } from "./perf-fixture.ts";
import {
  findIdleThreadId,
  measureDeskLaunch,
  openDeskScreenOnce,
  reportDeskLaunch,
  traceFrames,
  type DeskLaunchPlan,
} from "./perf-work.ts";

/** The Connection that presents every card. It holds no token, so it is never polled. */
export const INBOX_CONNECTION_ID = "019a2000-0000-7000-8000-0000000000c0";

/** The repositories of the invented world, under the owner `northwind`. */
const REPOSITORIES = [
  "storefront-web",
  "checkout-api",
  "delivery-slots",
  "pricing",
  "catalog",
  "loyalty",
  "payments-gateway",
  "warehouse",
  "mobile-app",
  "ops-runbooks",
] as const;

/** How many cards the world holds, and how many of them are pull requests: every fifth. */
export const INBOX_CARDS = 300;
const PULL_REQUEST_EVERY = 5;

/** Words the cards' titles are made of, so no two cards read alike. */
const SUBJECTS = [
  "basket total",
  "delivery slot lookup",
  "loyalty points",
  "refund flow",
  "stock count",
  "price rounding",
  "checkout button",
  "order email",
  "search ranking",
  "depot handover",
] as const;
const CHANGES = [
  "is wrong on multi-buy offers",
  "times out at the Friday peak",
  "shows stale numbers",
  "needs a retry",
  "fails for gift cards",
  "loses its place on reload",
] as const;

/** Returns the 16-byte form of a UUID, as the database stores an id. */
const toIdBytes = (id: string): Buffer => Buffer.from(id.replaceAll("-", ""), "hex");

/** Builds the id of the `index`th row of a table of the world: a version 7 UUID under a prefix of its own per table. */
const buildWorldId = (table: number, index: number): string =>
  `019a2000-0000-7000-8${table.toString(16).padStart(3, "0")}-${index.toString(16).padStart(12, "0")}`;

/** One card of the world: what its rows are built from. */
export interface InboxCard {
  readonly id: string;
  readonly ref: string;
  readonly repository: string;
  readonly isPullRequest: boolean;
  readonly number: number;
  readonly title: string;
}

/** Returns the `index`th card of the world. */
export function buildInboxCard(index: number): InboxCard {
  const repository = REPOSITORIES[index % REPOSITORIES.length]!;
  const isPullRequest = index % PULL_REQUEST_EVERY === 0;
  const number = 1_000 + index;
  const subject = SUBJECTS[index % SUBJECTS.length]!;
  const change = CHANGES[Math.floor(index / SUBJECTS.length) % CHANGES.length]!;
  return {
    id: buildWorldId(1, index),
    ref: `github:${isPullRequest ? "pr" : "issue"}:northwind/${repository}#${String(number)}`,
    repository,
    isPullRequest,
    number,
    title: `The ${subject} ${change}`,
  };
}

/** Returns the External Ref of the repository `name`. */
export const buildRepositoryRef = (name: string): string => `github:repo:northwind/${name}`;

/**
 * Writes the invented world into `database`, the stopped controller's, and
 * replaces any of it that is there already: the Connection, the
 * repositories, the cards, what the Connection observes of each, and each
 * card's place. The open signals and their events are written the first time
 * only, because nothing removes them. Call it from `prepareLaunch`'s
 * `writeDatabase`, which runs after the fixture has replaced the
 * Connections, which removes this one and, with it, what it observed.
 */
export function writeInboxWorld(database: DatabaseSync): void {
  const now = new Date().toISOString();
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const connection = toIdBytes(INBOX_CONNECTION_ID);
  database.exec("BEGIN");
  database
    .prepare(
      "INSERT OR REPLACE INTO connections (id, plugin_id, type, label, display_name, account_id, " +
        "status, status_detail, labels, config, created_at, updated_at, feed_intervals) " +
        "VALUES (?, 'github', 'github/github', 'northwind', 'northwind', 'northwind', " +
        "'needs-reauth', NULL, '[]', '{}', ?, ?, '{}')",
    )
    .run(connection, now, now);
  const insertEntity = database.prepare(
    "INSERT OR REPLACE INTO external_entities (id, ref, kind, noun, card, pace, patience, " +
      "caption, home, completeness, identifier, title, url, status, lifecycle, person, owner, " +
      "facts, concern_reasons, reason_templates, source_updated_at, concerned_since, " +
      "first_observed_at, updated_at, presented_by, arrival_sequence) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'full', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertObservation = database.prepare(
    "INSERT OR REPLACE INTO external_entity_observations (ref, connection_id, concerns, " +
      "owned_by_you, access, last_refreshed_at) VALUES (?, ?, ?, ?, 'ok', ?)",
  );
  const insertPartOf = database.prepare(
    "INSERT OR IGNORE INTO external_entity_relation_claims (from_ref, relation, to_ref, " +
      "claim_type, connection_id, evidence_key, state, observed_at) " +
      "VALUES (?, 'part-of', ?, 'source', ?, '', 'current', ?)",
  );
  for (const [index, name] of REPOSITORIES.entries()) {
    const ref = buildRepositoryRef(name);
    insertEntity.run(
      toIdBytes(buildWorldId(0, index)),
      ref,
      "github/repository",
      "Repository",
      null,
      "context",
      0,
      "GitHub repository",
      null,
      `northwind/${name}`,
      name,
      `https://github.example/northwind/${name}`,
      null,
      null,
      null,
      null,
      null,
      null,
      hoursAgo(48),
      null,
      hoursAgo(48),
      now,
      connection,
      null,
    );
    insertObservation.run(ref, connection, "[]", 0, now);
  }
  for (let index = 0; index < INBOX_CARDS; index += 1) {
    const card = buildInboxCard(index);
    // Spread the cards over the last two days, so their ages differ.
    const since = hoursAgo(2 + (index % 46));
    insertEntity.run(
      toIdBytes(card.id),
      card.ref,
      card.isPullRequest ? "github/pull-request" : "github/issue",
      card.isPullRequest ? "Pull request" : "Issue",
      card.isPullRequest ? "compact" : "rich",
      card.isPullRequest ? "fast" : "slow",
      card.isPullRequest ? 24 : 336,
      null,
      "github/repository",
      `#${String(card.number)}`,
      card.title,
      `https://github.example/northwind/${card.repository}/${card.isPullRequest ? "pull" : "issues"}/${String(card.number)}`,
      JSON.stringify(
        card.isPullRequest
          ? { shape: "fork", tone: "quiet", label: "Open", norm: true, stage: "in-review" }
          : { shape: "ring", tone: "quiet", label: "Open", norm: true },
      ),
      "open",
      card.isPullRequest ? JSON.stringify({ name: "juno-park" }) : null,
      card.isPullRequest ? "juno-park" : null,
      card.isPullRequest
        ? JSON.stringify({ "review-requested": { say: "Review requested", tone: "plain" } })
        : null,
      card.isPullRequest
        ? JSON.stringify({
            "review-requested": { say: "{person} asked for your review", tone: "plain" },
          })
        : null,
      since,
      since,
      since,
      now,
      connection,
      index + 1,
    );
    insertObservation.run(
      card.ref,
      connection,
      JSON.stringify([card.isPullRequest ? "review-requested" : "assigned"]),
      card.isPullRequest ? 0 : 1,
      now,
    );
    insertPartOf.run(card.ref, buildRepositoryRef(card.repository), connection, now);
  }
  database.prepare("UPDATE external_entity_arrival_counter SET last = ?").run(INBOX_CARDS);
  const hasSignals =
    database.prepare("SELECT 1 FROM signals WHERE id = ?").get(toIdBytes(buildWorldId(2, 0))) !==
    undefined;
  if (!hasSignals) {
    for (let index = 0; index < INBOX_CARDS; index += 1) {
      writeCardSignal(database, buildInboxCard(index), index, hoursAgo(1 + (index % 20)));
    }
  }
  database.exec("COMMIT");
}

/**
 * Writes one open signal on `card`, about an event of its own, as the GitHub
 * plugin builds it and the router stores it: a review request on a pull
 * request, a mention on an issue. `index` names the signal and its event, and
 * `at` is when both arrived. Runs inside the caller's transaction, if any.
 */
function writeCardSignal(database: DatabaseSync, card: InboxCard, index: number, at: string): void {
  const connection = toIdBytes(INBOX_CONNECTION_ID);
  const repo = `northwind/${card.repository}`;
  const event = database
    .prepare(
      "INSERT INTO events (source, connection_id, system, kind, occurred_at, received_at, " +
        "dedup_key, refs, url, payload) VALUES ('github', ?, 'github', ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      connection,
      card.isPullRequest ? "github.pr.review-requested" : "github.mentioned",
      at,
      at,
      `northwind-perf-${String(index)}`,
      JSON.stringify([card.ref, buildRepositoryRef(card.repository)]),
      `https://github.example/${repo}/${card.isPullRequest ? "pull" : "issues"}/${String(card.number)}`,
      JSON.stringify(
        card.isPullRequest
          ? { reviewer: "you", requestedBy: "juno-park", byYou: false, toYou: true }
          : { byYou: false, author: "mira-okafor" },
      ),
    );
  const signalId = buildWorldId(2, index);
  database
    .prepare(
      "INSERT INTO signals (id, kind, origin, title, asker, place, priority, blocks, actions, " +
        "match, status, created_at, connection_id, thread_ref) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, '{}', 'open', ?, ?, ?)",
    )
    .run(
      toIdBytes(signalId),
      card.isPullRequest ? "github/review-requested" : "github/mentioned",
      JSON.stringify({
        type: "event",
        eventId: Number(event.lastInsertRowid),
        connectionId: INBOX_CONNECTION_ID,
        threadRef: card.ref,
      }),
      card.title,
      card.isPullRequest ? "juno-park" : "mira-okafor",
      `${repo}#${String(card.number)}`,
      card.isPullRequest ? "high" : "normal",
      JSON.stringify([{ id: "done", label: "Done", operation: null }]),
      at,
      connection,
      card.ref,
    );
  database
    .prepare("INSERT INTO signal_events (signal_id, event_id) VALUES (?, ?)")
    .run(toIdBytes(signalId), Number(event.lastInsertRowid));
}

/** Prints what `traceFrames` measured, as one line under `name`. */
export function printFrames(name: string, frames: Awaited<ReturnType<typeof traceFrames>>): void {
  console.log(
    `${name}: ${String(frames.frames)} frames over ${frames.recordedMs.toFixed(0)} ms; ` +
      `${String(frames.droppedFrames)} dropped (longest gap ${frames.longestGapMs.toFixed(1)} ms against ${frames.usualGapMs.toFixed(1)} ms usual); ` +
      `style and layout ${frames.usualStyleLayoutMs.toFixed(2)} ms usual, ${frames.longestStyleLayoutMs.toFixed(2)} ms at most a frame, ` +
      `${String(frames.framesOver2Ms)} frames over 2 ms; longest task ${frames.longestTaskMs.toFixed(1)} ms; ` +
      `animations ${String(frames.animations)} (${String(frames.animationsNotComposited)} not on the compositor)\n`,
  );
}

/** An expression that is true in the page once the Inbox has drawn its frame. */
const INBOX_DRAWN = `document.querySelector(".ib") !== null`;

/**
 * Measures the Inbox (see the top of this file): writes the world, then
 * measures a launch with a thread open and one on the Inbox. Each launch
 * starts from a fresh `prepareLaunch`, because a streamed turn makes its
 * thread's age recent.
 */
export async function measureInbox(fixture: ThreadFixture, userDataDir: string): Promise<void> {
  const threadId = await findIdleThreadId(fixture);
  const plans: DeskLaunchPlan[] = [
    {
      name: "a thread open, to compare with",
      path: `/threads/${threadId}`,
      drawn: `document.querySelector('[aria-label="Transcript"]') !== null`,
    },
    { name: `the Inbox, ${String(INBOX_CARDS)} cards`, path: "/inbox", drawn: INBOX_DRAWN },
  ];
  for (const plan of plans) {
    await fixture.prepareLaunch({ twoMinuteRow: false, writeDatabase: writeInboxWorld });
    await openDeskScreenOnce(userDataDir, plan);
    reportDeskLaunch(await measureDeskLaunch(userDataDir, fixture, plan, null));
  }
}
