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
 * - 300 things, each `part of` one repository: 60 pull requests that ask for
 *   the user's review and 240 issues assigned to the user;
 * - 300 open signals, one on each thing: a review request on each pull
 *   request and a mention on each issue, each about an event of its own.
 *
 * All of them lie in "Someone waits on me", the Inbox's first saved query.
 *
 * The launches (see `measureInbox`): a thread open, to compare with, and the
 * Inbox. Each is measured by `measureDeskLaunch` (see `perf-work.ts`), and
 * the Inbox launch then runs `measureInboxSteps`.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { ThreadFixture } from "./perf-fixture.ts";
import type { PageDriver } from "./perf-measures.ts";
import {
  findIdleThreadId,
  measureDeskLaunch,
  measureStep,
  openDeskScreenOnce,
  pressKeyWith,
  printStep,
  reportDeskLaunch,
  traceFrames,
  type DeskLaunchPlan,
  type StepContext,
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

/** The statements that write the rows of one thing: the thing itself, what the Connection observes of it, and its place. */
interface WorldStatements {
  readonly insertEntity: StatementSync;
  readonly insertObservation: StatementSync;
  readonly insertPartOf: StatementSync;
}

/** Prepares the statements of `WorldStatements` on `database`. */
function prepareWorldStatements(database: DatabaseSync): WorldStatements {
  return {
    insertEntity: database.prepare(
      "INSERT OR REPLACE INTO external_entities (id, ref, kind, noun, card, pace, patience, " +
        "caption, home, completeness, identifier, title, url, status, lifecycle, person, owner, " +
        "facts, concern_reasons, reason_templates, source_updated_at, concerned_since, " +
        "first_observed_at, updated_at, presented_by, arrival_sequence) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'full', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    insertObservation: database.prepare(
      "INSERT OR REPLACE INTO external_entity_observations (ref, connection_id, concerns, " +
        "owned_by_you, access, last_refreshed_at) VALUES (?, ?, ?, ?, 'ok', ?)",
    ),
    insertPartOf: database.prepare(
      "INSERT OR IGNORE INTO external_entity_relation_claims (from_ref, relation, to_ref, " +
        "claim_type, connection_id, evidence_key, state, observed_at) " +
        "VALUES (?, 'part-of', ?, 'source', ?, '', 'current', ?)",
    ),
  };
}

/**
 * Writes the rows of the `index`th thing of the world: the thing itself, what
 * the Connection observes of it, and its place, a repository. `since` is when
 * it last changed and `now` when the Connection read it. Runs inside the
 * caller's transaction, if any.
 */
function writeCardRows(
  { insertEntity, insertObservation, insertPartOf }: WorldStatements,
  index: number,
  now: string,
  since: string,
): void {
  const connection = toIdBytes(INBOX_CONNECTION_ID);
  const card = buildInboxCard(index);
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
  const statements = prepareWorldStatements(database);
  const { insertEntity, insertObservation } = statements;
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
    // Spread the cards over the last two days, so their ages differ.
    writeCardRows(statements, index, now, hoursAgo(2 + (index % 46)));
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

/** An expression that is true in the page once the Inbox has drawn its frame and its first rows. */
const INBOX_DRAWN = `document.querySelector(".ib") !== null && document.querySelector(".ib-rows > .ib-row") !== null`;

/** The rows the list has mounted. The copies of rows that are leaving the list are not children of `.ib-rows`. */
const MOUNTED_ROWS = `document.querySelectorAll(".ib-rows > .ib-row")`;

/** An expression for the mounted row at the 1-based `position` in the list, or null. */
const rowAt = (position: number): string =>
  `document.querySelector('.ib-rows > .ib-row[aria-posinset="${String(position)}"]')`;

/** An expression for the position of the current row, or 0 when none is mounted. */
const CURRENT_POSITION = `Number(document.querySelector(".ib-rows > .ib-row.is-current")?.getAttribute("aria-posinset") ?? 0)`;

/** An expression for the title the pane shows, or null. */
const PANE_TITLE = `(document.querySelector('[aria-label="The open thing"] .ib-pane-title')?.firstChild?.textContent?.trim() ?? null)`;

/** An expression for the list's scrolling element. */
const SCROLLER = `document.querySelector(".ib-scroll")`;

/** How long the page is quiet for before a step is measured, in milliseconds. */
const QUIET_MS = 500;

/** How many rows the walk with J steps over, and the pause after each step in milliseconds. */
const WALK_ROWS = 50;
const WALK_PAUSE_MS = 60;

/** The key code bit of the modifier that undoes on this platform: Meta on a Mac, Ctrl elsewhere. */
const UNDO_MODIFIER = process.platform === "darwin" ? 4 : 2;

/**
 * Opens the controller's database while it runs and calls `write` in one
 * transaction. SQLite waits up to five seconds for the controller's own writes.
 */
function writeWhileRunning(databasePath: string, write: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN");
    write(database);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

/** Writes a review request or a mention on the `index`th thing of the world, which the Inbox holds already. */
function writeLandingSignal(databasePath: string, index: number): void {
  writeWhileRunning(databasePath, (database) => {
    writeCardSignal(database, buildInboxCard(index), 10_000 + index, new Date().toISOString());
  });
}

/**
 * Writes one more thing after the world's last, a pull request with its open
 * signal, so it arrives in "Someone waits on me" while the Inbox is open. Its
 * signal is older than every other, so the list, which is ordered by the
 * longest wait, ranks it first and it lies in the first page. A newer one would
 * rank last, past the first page, and the list would not show it as new.
 */
function writeArrivingThing(databasePath: string): void {
  writeWhileRunning(databasePath, (database) => {
    const now = new Date().toISOString();
    const waitingSince = new Date(Date.now() - 30 * 3_600_000).toISOString();
    writeCardRows(prepareWorldStatements(database), INBOX_CARDS, now, waitingSince);
    writeCardSignal(database, buildInboxCard(INBOX_CARDS), INBOX_CARDS, waitingSince);
    database.prepare("UPDATE external_entity_arrival_counter SET last = ?").run(INBOX_CARDS + 1);
  });
}

/**
 * Measures what the Inbox's list and pane cost once it has drawn (see the top
 * of this file), step by step. Each step prints its own table, or its frames
 * line, as it ends:
 *
 * - "Opening a card": a click on a row, and the pane showing that thing;
 * - walking 50 rows with J, the pane following each;
 * - scrolling to the end of the 300 things, which a virtual list mounts a few
 *   rows at a time, and the second page the controller sends;
 * - "A signal landing on a thing the list holds", the old Inbox's "A signal
 *   landing on a pull request's card": a signal on the first row, and the
 *   read it causes;
 * - a new thing arriving while the list is open: the "N new" pill appears and
 *   no row moves;
 * - dismissing the first thing with E, and putting it back with the undo key.
 *
 * The first and the fourth step are the old Inbox's, under the old names
 * where the thing measured is the same, so a run of the old build compares
 * with them row by row. The old build's list had pull requests on top, so its
 * landing was on a pull request; this list is ordered by wait and has
 * issues on top.
 */
async function measureInboxSteps(
  context: StepContext,
  driver: PageDriver,
  fixture: ThreadFixture,
): Promise<void> {
  const { page } = context;
  const settle = async () => {
    await driver.waitForAnimationsToEnd(8_000).catch(() => undefined);
    await context.collector.waitForQuietReads(QUIET_MS);
  };
  const scrollToTop = async () => {
    await driver.evaluate(`void (${SCROLLER}.scrollTop = 0)`);
    await driver.waitFor(`${rowAt(1)} !== null`, "the first row did not come back");
  };
  await settle();

  // The pane opens on a thing.
  const title = await driver.evaluate<string>(
    `${rowAt(4)}.querySelector(".ib-row-title").textContent`,
  );
  const opening = await traceFrames(page, 1_200, async () => {
    await driver.click(rowAt(4));
    await driver.waitFor(`${PANE_TITLE} === ${JSON.stringify(title)}`, "the pane did not open");
  });
  printFrames("Opening a card", opening);
  const reads = await measureStep(context, 1, () => sleep(300));
  printStep("the open card's reads, after it opened", reads, null);

  // A walk down the list with J: the current row, the puck and the pane move on each key.
  await driver.click(rowAt(1));
  await driver.waitFor(`${CURRENT_POSITION} === 1`, "the first row did not become current");
  await settle();
  let walkFrames: Awaited<ReturnType<typeof traceFrames>> | undefined;
  const walked = await measureStep(context, WALK_ROWS, async () => {
    walkFrames = await traceFrames(page, 15_000, async () => {
      for (let position = 2; position <= WALK_ROWS + 1; position += 1) {
        await driver.pressKey("j");
        await driver.waitFor(
          `${CURRENT_POSITION} === ${String(position)}`,
          `J did not reach row ${String(position)}`,
        );
        await sleep(WALK_PAUSE_MS);
      }
    });
  });
  printFrames(`Walking ${String(WALK_ROWS)} rows with J`, walkFrames!);
  printStep(`walking ${String(WALK_ROWS)} rows with J`, walked, "row");

  // The list is virtual: however far it scrolls, it keeps a few rows mounted.
  await settle();
  let mostMounted = 0;
  const scrolled = await measureStep(context, 1, async () => {
    for (let at = 0; at < 120; at += 1) {
      const state = await driver.evaluate<{ mounted: number; isLastMounted: boolean }>(`(() => {
        const scroller = ${SCROLLER};
        scroller.scrollTop += 600;
        return {
          mounted: ${MOUNTED_ROWS}.length,
          isLastMounted: ${rowAt(INBOX_CARDS)} !== null,
        };
      })()`);
      mostMounted = Math.max(mostMounted, state.mounted);
      if (state.isLastMounted) return;
      await sleep(80);
    }
    throw new Error(`the list never mounted its last row, ${String(INBOX_CARDS)}`);
  });
  console.log(
    `Scrolling to the end of ${String(INBOX_CARDS)} things: at most ${String(mostMounted)} rows mounted at once\n`,
  );
  printStep("scrolling to the end of the list", scrolled, null);

  // A signal on a thing the list holds, then a raised signal whose push makes the Inbox read again.
  await scrollToTop();
  await settle();
  const firstRef = await driver.evaluate<string>(`${rowAt(1)}.dataset.ref`);
  const index = Array.from({ length: INBOX_CARDS }, (_, each) => each).find(
    (each) => buildInboxCard(each).ref === firstRef,
  );
  if (index === undefined) throw new Error(`the first row, ${firstRef}, is not of the world`);
  const raise = (title: string) =>
    fixture.call("POST", "/signals/raise", {
      kind: "fyi",
      title,
      reason: "Raised by the perf script to make the Inbox read again.",
      eventIds: [],
    });
  writeLandingSignal(fixture.databasePath, index);
  let landingFrames: Awaited<ReturnType<typeof traceFrames>> | undefined;
  const landing = await measureStep(context, 1, async () => {
    landingFrames = await traceFrames(page, 2_500, async () => {
      await raise("The depot rota changed");
    });
  });
  printFrames("A signal landing on a thing the list holds", landingFrames!);
  printStep("a signal landing on a thing the list holds", landing, null);

  // A new thing arrives: the list holds still behind a pill, and no row moves.
  await settle();
  const readRows = () =>
    driver.evaluate<Array<{ ref: string; top: number }>>(
      `[...${MOUNTED_ROWS}].slice(0, 8).map((row) => ({ ref: row.dataset.ref, top: row.getBoundingClientRect().top }))`,
    );
  const rowsBefore = await readRows();
  writeArrivingThing(fixture.databasePath);
  let arrivalFrames: Awaited<ReturnType<typeof traceFrames>> | undefined;
  const arrival = await measureStep(context, 1, async () => {
    arrivalFrames = await traceFrames(page, 2_500, async () => {
      await raise("The depot rota changed again");
    });
  });
  printFrames("A new thing arriving live", arrivalFrames!);
  printStep("a new thing arriving live", arrival, null);
  const pill = await driver.evaluate<string | null>(
    `document.querySelector(".ib-newbar-count")?.textContent ?? null`,
  );
  const rowsAfter = await readRows();
  const hasMoved = rowsBefore.some(
    (row, at) => row.ref !== rowsAfter[at]?.ref || row.top !== rowsAfter[at]?.top,
  );
  console.log(
    `The "N new" pill: ${pill === null ? "NOT SHOWN" : `"${pill}"`}; the first ${String(rowsBefore.length)} rows ${hasMoved ? "MOVED" : "did not move"}\n`,
  );

  // E dismisses the first thing, and the undo key puts it back.
  await scrollToTop();
  await driver.click(rowAt(1));
  const ref = await driver.evaluate<string>(`${rowAt(1)}.dataset.ref`);
  const isMounted = `[...${MOUNTED_ROWS}].some((row) => row.dataset.ref === ${JSON.stringify(ref)})`;
  await settle();
  let dismissFrames: Awaited<ReturnType<typeof traceFrames>> | undefined;
  const dismissed = await measureStep(context, 1, async () => {
    dismissFrames = await traceFrames(page, 1_500, async () => {
      await driver.pressKey("e");
      await driver.waitFor(`!(${isMounted})`, "the dismissed thing did not leave the list");
    });
  });
  printFrames("Dismissing the first thing with E", dismissFrames!);
  printStep("dismissing the first thing with E", dismissed, null);
  await settle();
  let undoFrames: Awaited<ReturnType<typeof traceFrames>> | undefined;
  const undone = await measureStep(context, 1, async () => {
    undoFrames = await traceFrames(page, 1_500, async () => {
      await pressKeyWith(page, "z", "KeyZ", UNDO_MODIFIER);
      await driver.waitFor(isMounted, "the undo did not bring the thing back");
    });
  });
  printFrames("Undoing the dismissal", undoFrames!);
  printStep("undoing the dismissal", undone, null);
}

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
    reportDeskLaunch(
      await measureDeskLaunch(
        userDataDir,
        fixture,
        plan,
        plan.path === "/inbox" ? measureInboxSteps : null,
      ),
    );
  }
}
