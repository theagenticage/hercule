/**
 * Tests the Inbox in the packaged app, signed in to a real controller (spec
 * 17 §Inbox). One journey, kept to what only the packaged app proves:
 *
 * - the Inbox row in the sidebar says one card waits, and opens the Inbox;
 * - a pull request lies in Requests, and an issue lies under Ongoing on the
 *   surface of its repository;
 * - a click on the issue's row opens its card, and a real click on Take it
 *   inside the open card reaches its button (the sheet's veil does not cover
 *   it) and gives the issue a Task;
 * - T takes the pull request on: its card shows that a Task holds it, and the
 *   controller has a Task with its title;
 * - the card's On Work move goes to that Task on Work, where its card is drawn;
 * - a review request that reaches the pull request as a signal lands on its
 *   card as a new sentence, the card stays where it was, and the open card
 *   shows the signal as a line with its answers.
 *
 * GitHub cannot be reached offline, so the entities are written into the
 * scratch database while the controller is stopped, in the shape the GitHub
 * plugin reports them: a repository record, a pull request and an issue that
 * are `part of` it, and a Connection that reports their concerns. The
 * Connection holds no token, so the controller never polls it and the rows
 * stay as written. The invented world is Northwind Market's web shop.
 *
 * The same holds for the signal. A plugin raises a signal from an event only
 * after it builds the signal by reading GitHub, with the Connection's token,
 * at a fixed address, so no stub feed can stand in for GitHub in the packaged
 * binary. The signal is written into the database the way the plugin's
 * `build` lays it out and the router stores it (an `event` origin that names
 * the pull request's thread), and the controller reads it as it would read
 * one the plugin raised. The restart is what delivers it to the open app.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { replaceConnections } from "../../apps/desktop/scripts/connection-fixtures";
import { arrangeFleet, openSignedIn } from "./harness";

const CONNECTION_ID = "019a1234-5678-7000-8000-0000000000a1";
const REPOSITORY_ID = "019a1234-5678-7000-8000-0000000000b1";
const PULL_REQUEST_ID = "019a1234-5678-7000-8000-0000000000b2";
const ISSUE_ID = "019a1234-5678-7000-8000-0000000000b3";

const REVIEW_EVENT_DEDUP_KEY = "northwind-review-request-6241";
const REVIEW_SIGNAL_ID = "019a1234-5678-7000-8000-0000000000c1";

const REPOSITORY_REF = "github:repo:northwind/storefront-web";
const PULL_REQUEST_REF = "github:pr:northwind/storefront-web#6241";
const ISSUE_REF = "github:issue:northwind/storefront-web#412";

const PULL_REQUEST_TITLE = "Cache delivery slot lookups for five minutes";
const ISSUE_TITLE = "Basket total rounds the wrong way on multi-buy offers";

/** Returns the 16-byte form of a UUID, as the database stores an id. */
const toIdBytes = (id: string): Buffer => Buffer.from(id.replaceAll("-", ""), "hex");

/**
 * Writes the Northwind entities into the database of the stopped controller
 * whose Hercule Home is `home`: a repository, a pull request that asks for the
 * user's review, and an issue assigned to the user. Both are `part of` the
 * repository, as one GitHub Connection reports them. Fails when the write fails.
 */
function seedEntities(home: string): void {
  replaceConnections(home, [{ id: CONNECTION_ID, label: "northwind", status: "needs-reauth" }]);
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    const now = new Date().toISOString();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const insertEntity = database.prepare(
      "INSERT INTO external_entities (id, ref, kind, noun, card, pace, patience, caption, home, " +
        "completeness, identifier, title, url, status, lifecycle, person, owner, facts, " +
        "source_updated_at, concerned_since, first_observed_at, updated_at, presented_by, " +
        "arrival_sequence) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'full', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)",
    );
    insertEntity.run(
      toIdBytes(REPOSITORY_ID),
      REPOSITORY_REF,
      "github/repository",
      "Repository",
      null,
      "context",
      0,
      "GitHub repository",
      null,
      "northwind/storefront-web",
      "storefront-web",
      "https://github.example/northwind/storefront-web",
      null,
      null,
      null,
      null,
      hourAgo,
      null,
      hourAgo,
      now,
      toIdBytes(CONNECTION_ID),
      null,
    );
    insertEntity.run(
      toIdBytes(PULL_REQUEST_ID),
      PULL_REQUEST_REF,
      "github/pull-request",
      "Pull request",
      "compact",
      "fast",
      24,
      null,
      "github/repository",
      "#6241",
      PULL_REQUEST_TITLE,
      "https://github.example/northwind/storefront-web/pull/6241",
      JSON.stringify({
        shape: "fork",
        tone: "quiet",
        label: "Open",
        norm: true,
        stage: "in-review",
      }),
      "open",
      JSON.stringify({ name: "juno-park" }),
      "juno-park",
      hourAgo,
      hourAgo,
      hourAgo,
      now,
      toIdBytes(CONNECTION_ID),
      1,
    );
    insertEntity.run(
      toIdBytes(ISSUE_ID),
      ISSUE_REF,
      "github/issue",
      "Issue",
      "rich",
      "slow",
      336,
      null,
      "github/repository",
      "#412",
      ISSUE_TITLE,
      "https://github.example/northwind/storefront-web/issues/412",
      JSON.stringify({ shape: "ring", tone: "quiet", label: "Open", norm: true }),
      "open",
      null,
      null,
      hourAgo,
      hourAgo,
      hourAgo,
      now,
      toIdBytes(CONNECTION_ID),
      null,
    );
    database.exec("UPDATE external_entity_arrival_counter SET last = 1");

    // The Connection reads all three, and reports the concerns of the two
    // things. The repository is a place, so it has none.
    const insertObservation = database.prepare(
      "INSERT INTO external_entity_observations (ref, connection_id, concerns, owned_by_you, " +
        "access, last_refreshed_at) VALUES (?, ?, ?, ?, 'ok', ?)",
    );
    insertObservation.run(REPOSITORY_REF, toIdBytes(CONNECTION_ID), "[]", 0, now);
    insertObservation.run(
      PULL_REQUEST_REF,
      toIdBytes(CONNECTION_ID),
      JSON.stringify(["review-requested"]),
      0,
      now,
    );
    insertObservation.run(
      ISSUE_REF,
      toIdBytes(CONNECTION_ID),
      JSON.stringify(["assigned"]),
      1,
      now,
    );

    const insertPartOf = database.prepare(
      "INSERT INTO external_entity_relation_claims (from_ref, relation, to_ref, claim_type, " +
        "connection_id, evidence_key, state, observed_at) " +
        "VALUES (?, 'part-of', ?, 'source', ?, '', 'current', ?)",
    );
    insertPartOf.run(PULL_REQUEST_REF, REPOSITORY_REF, toIdBytes(CONNECTION_ID), now);
    insertPartOf.run(ISSUE_REF, REPOSITORY_REF, toIdBytes(CONNECTION_ID), now);
  } finally {
    database.close();
  }
}

/**
 * Gives the pull request the words its kind declares: the sentence it says for
 * its concern, and the template of a review request, which a signal's asker
 * fills in. The controller stores both when it observes a pull request. Writes
 * into the database of the stopped controller whose Hercule Home is `home`.
 */
function seedReviewWording(home: string): void {
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    database
      .prepare(
        "UPDATE external_entities SET concern_reasons = ?, reason_templates = ? WHERE ref = ?",
      )
      .run(
        JSON.stringify({ "review-requested": { say: "Review requested", tone: "plain" } }),
        JSON.stringify({
          "review-requested": { say: "{person} asked for your review", tone: "plain" },
        }),
        PULL_REQUEST_REF,
      );
  } finally {
    database.close();
  }
}

/**
 * Writes the review request event of the pull request and the open signal the
 * GitHub plugin builds from it (kind `github/review-requested`, raised by
 * `juno-park`, with the review answers and Done), as the router stores them, into
 * the database of the stopped controller whose Hercule Home is `home`. The
 * signal names the event, so the router does not raise it a second time.
 */
function seedReviewRequestSignal(home: string): void {
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    const now = new Date().toISOString();
    const event = database
      .prepare(
        "INSERT INTO events (source, connection_id, system, kind, occurred_at, received_at, " +
          "dedup_key, refs, url, payload) VALUES ('github', ?, 'github', " +
          "'github.pr.review-requested', ?, ?, ?, ?, ?, ?)",
      )
      .run(
        toIdBytes(CONNECTION_ID),
        now,
        now,
        REVIEW_EVENT_DEDUP_KEY,
        JSON.stringify([PULL_REQUEST_REF, REPOSITORY_REF]),
        "https://github.example/northwind/storefront-web/pull/6241",
        JSON.stringify({
          reviewer: "you",
          requestedBy: "juno-park",
          byYou: false,
          toYou: true,
        }),
      );
    const eventId = Number(event.lastInsertRowid);
    const address = { repo: "northwind/storefront-web", number: 6241 };
    database
      .prepare(
        "INSERT INTO signals (id, kind, origin, title, asker, place, priority, blocks, actions, " +
          "match, status, created_at, connection_id, thread_ref) " +
          "VALUES (?, 'github/review-requested', ?, ?, 'juno-park', ?, 'high', '[]', ?, '{}', " +
          "'open', ?, ?, ?)",
      )
      .run(
        toIdBytes(REVIEW_SIGNAL_ID),
        JSON.stringify({
          type: "event",
          eventId,
          connectionId: CONNECTION_ID,
          threadRef: PULL_REQUEST_REF,
        }),
        PULL_REQUEST_TITLE,
        "northwind/storefront-web#6241",
        JSON.stringify([
          {
            id: "approve",
            label: "Approve",
            operation: {
              op: "github/pr.review",
              connectionId: CONNECTION_ID,
              input: { ...address, verdict: "approve" },
            },
          },
          {
            id: "comment",
            label: "Comment",
            operation: { op: "github/pr.comment", connectionId: CONNECTION_ID, input: address },
            field: { name: "body", placeholder: "Write a comment" },
          },
          { id: "done", label: "Done", operation: null },
        ]),
        now,
        toIdBytes(CONNECTION_ID),
        PULL_REQUEST_REF,
      );
    database
      .prepare("INSERT INTO signal_events (signal_id, event_id) VALUES (?, ?)")
      .run(toIdBytes(REVIEW_SIGNAL_ID), eventId);
  } finally {
    database.close();
  }
}

describe("Inbox", () => {
  it("shows a pull request in Requests and an issue under Ongoing, takes the pull request on with T, and goes to its Task on Work", async () => {
    const arranged = await arrangeFleet();
    await arranged.restartController(() => {
      seedEntities(arranged.home);
    });
    const { page } = await openSignedIn(arranged.url);

    // The sidebar's Inbox row counts the one card with a clock on it.
    await page
      .getByRole("tablist", { name: "Sidebar" })
      .getByRole("tab", { name: "Hercule" })
      .click();
    const row = page
      .getByRole("navigation", { name: "Hercule", exact: true })
      .getByRole("link", { name: /^Inbox/ });
    await expect.poll(() => row.getAttribute("aria-label")).toMatch(/^Inbox, 1 waiting/);
    await row.click();

    // The pull request lies in Requests. The issue lies on the surface of its
    // repository, under Ongoing.
    const request = page.locator(`.inbox-request[data-card-id="${PULL_REQUEST_ID}"]`);
    await request.waitFor();
    expect(await request.locator(".request-title").textContent()).toBe(PULL_REQUEST_TITLE);
    expect(await page.locator('aside[aria-label="Requests"] .inbox-request').count()).toBe(1);
    const repository = page.locator(".inbox-place", { hasText: "storefront-web" });
    await repository.waitFor();
    const issue = repository.locator(`.inbox-row[data-card-id="${ISSUE_ID}"]`);
    expect(await issue.locator(".row-title").textContent()).toBe(ISSUE_TITLE);

    // The issue's card opens, and Take it inside it is clicked with the mouse.
    // Playwright refuses a click whose target another element covers, so this
    // fails when the sheet's veil lies over the sheet's buttons.
    await issue.click();
    const openCard = page.locator(".open-card");
    await openCard.waitFor();
    await openCard.getByRole("button", { name: /^Take it/ }).click();
    await expect
      .poll(async () =>
        (await arranged.client.task.queryBoard()).cards.some((each) => each.title === ISSUE_TITLE),
      )
      .toBe(true);
    await openCard.waitFor({ state: "hidden" });

    // Focus is on a button (the sidebar's row, or the card the sheet closed
    // into), and the page's keys only act when focus is on the page, so it lets go.
    // Under the pointer, the pull request is the current card, and T takes it on.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await request.hover();
    await expect.poll(() => request.getAttribute("data-current")).not.toBeNull();
    await page.keyboard.press("t");
    await expect.poll(() => request.getAttribute("data-has-task")).not.toBeNull();
    const [task] = (await arranged.client.task.queryBoard()).cards.filter(
      (card) => card.title === PULL_REQUEST_TITLE,
    );
    expect(task).toBeDefined();

    // The held card offers On Work in the place of Take it, and it goes to the
    // Task on Work, where the Task's card is drawn. (After a Take, the keys
    // move on to the next card that waits, so G would act on none.)
    await request.hover();
    await request.getByRole("button", { name: "On Work" }).click();
    const card = page.locator(`.work-desk [data-card-id="${task!.id}"]`);
    await card.waitFor();
    expect(await card.textContent()).toContain(PULL_REQUEST_TITLE);
  });

  it("lands a review request that reaches the pull request as a signal on its card as a new sentence, leaves the card where it was, and shows the signal and its answers in the open card", async () => {
    const arranged = await arrangeFleet();
    await arranged.restartController(() => {
      seedEntities(arranged.home);
      seedReviewWording(arranged.home);
    });
    const { page } = await openSignedIn(arranged.url);
    await page
      .getByRole("tablist", { name: "Sidebar" })
      .getByRole("tab", { name: "Hercule" })
      .click();
    await page
      .getByRole("navigation", { name: "Hercule", exact: true })
      .getByRole("link", { name: /^Inbox/ })
      .click();

    // The card says what its Connection reports, in the kind's words.
    const request = page.locator(`.inbox-request[data-card-id="${PULL_REQUEST_ID}"]`);
    const sentence = request.locator(".request-said");
    await request.waitFor();
    await expect.poll(() => sentence.textContent()).toBe("Review requested");
    const before = await request.boundingBox();
    expect(before).not.toBeNull();

    // The review request arrives as a signal. The app reads the Inbox again
    // when it reconnects, and the same card now says who asked. A request in
    // the narrow column names the person alone when the sentence is the usual
    // one (a plain tone), because the column's title already says what a
    // request is.
    await arranged.restartController(() => {
      seedReviewRequestSignal(arranged.home);
    });
    await expect.poll(() => sentence.textContent()).toBe("juno-park");

    // The card stayed: the same one, in the same place, and no second card.
    expect(await page.locator('aside[aria-label="Requests"] .inbox-request').count()).toBe(1);
    // (A landing motion may still be moving the card for a moment, so the
    // position is polled rather than read once.)
    await expect.poll(async () => (await request.boundingBox())?.y).toBe(before!.y);

    // The open card shows the signal as a line, opened, with its answers.
    await request.click();
    const openCard = page.locator(".open-card");
    await openCard.waitFor();
    const timeline = openCard.getByRole("region", { name: "Timeline" });
    await expect
      .poll(async () => (await timeline.locator(".open-card-signals li").allTextContents()).length)
      .toBe(1);
    const answers = openCard.locator(".open-card-answers");
    await answers.getByRole("button", { name: "Approve" }).waitFor();
    await answers.getByRole("button", { name: "Comment" }).waitFor();
    await answers.getByRole("button", { name: "Done" }).waitFor();
  });
});
