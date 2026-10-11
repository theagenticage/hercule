/**
 * Tests the GitHub plugin's signal kinds through the whole event pipeline of
 * a running controller (spec 08 §5.1, spec 10 §9.2). The controller loads the
 * shipped GitHub plugin, and a GitHub Connection is created through the API.
 * Each event is written to the log as the plugin ingests it through that
 * Connection, with the payload the plugin's feeds build. The intake routing
 * table runs the kinds' rules and ends, and the plugin's real `build` reads
 * GitHub to lay out the signal.
 *
 * The events are written directly rather than polled, because a feed polls
 * at most once every 30 seconds, and each end needs an event after the
 * signal exists. The feeds' own tests, in the plugin, check how GitHub's
 * responses become these events. The events here have no author, so the
 * tests do not check what a signal or an outcome takes from it, such as the
 * asker.
 *
 * No request reaches GitHub. `fetch` is replaced for the whole file by one
 * that answers requests to api.github.com from the recorded-shaped responses
 * below and passes every other request on, so the test's own calls to the
 * controller still work. It is installed once, before any request, because
 * Effect's fetch client keeps the first `fetch` it reads.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Signal } from "@hercule/contract";
import { post } from "../../../http/testing";
import type { Arranged } from "../../../sessions/testing";
import { WAIT_DEADLINE_MS } from "../../../sessions/testing";
import { listOpenSignals, waitForResolved, waitForSignalFrom } from "../../../signals/testing";
import { createConnection } from "../../../workflows/testing";
import {
  ingestEvent,
  readMatchedInputRows,
  runEffect,
  waitOutSeveralTicks,
  waitUntilRouted,
  spawnSubscriber,
  subscribeThread,
  waitForMatchedInputRows,
  withPipeline,
} from "../../testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

const REVIEW_REQUESTED = "github/review-requested";
const TEAM_REVIEW_REQUESTED = "github/team-review-requested";
const MENTIONED = "github/mentioned";

const PR_TITLE = "Add the login form";

/** The pull request `GET /repos/o/r/pulls/{number}` returns, for any number. */
const PULL = {
  title: PR_TITLE,
  body: "Adds the login form and its tests.",
  html_url: "https://github.com/o/r/pull/87",
  created_at: "2026-10-10T08:00:00Z",
  user: { login: "marta", id: 1001 },
  head: { ref: "feature/login" },
  base: { ref: "main" },
  changed_files: 3,
  additions: 40,
  deletions: 2,
  commits: 2,
};

/** The id of the comment that mentions the user. */
const MENTION_COMMENT_ID = 3002;

/** The comments `GET /repos/o/r/issues/{number}/comments` returns: one before the mention, then the mention. */
const COMMENTS = [
  {
    id: 3001,
    html_url: "https://github.com/o/r/pull/89#issuecomment-3001",
    issue_url: "https://api.github.com/repos/o/r/issues/89",
    user: { login: "marta", id: 1001 },
    body: "The tests fail on Windows.",
    created_at: "2026-10-11T09:00:00Z",
    updated_at: "2026-10-11T09:00:00Z",
  },
  {
    id: MENTION_COMMENT_ID,
    html_url: "https://github.com/o/r/pull/89#issuecomment-3002",
    issue_url: "https://api.github.com/repos/o/r/issues/89",
    user: { login: "marta", id: 1001 },
    body: "@octocat can you look?",
    created_at: "2026-10-11T09:14:03Z",
    updated_at: "2026-10-11T09:14:03Z",
  },
];

/**
 * Returns the body GitHub answers a request with. `GET /user` names the
 * Connection's account, which the Connection type checks when it is
 * created. Any other path, such as the feeds' polls after the Connection
 * opens, gets an empty list, as from a repository with no activity.
 */
const answerGithub = (path: string): unknown => {
  if (path === "/user") return { login: "octocat", id: 583231 };
  if (/^\/repos\/o\/r\/pulls\/\d+$/.test(path)) return PULL;
  if (/^\/repos\/o\/r\/issues\/\d+\/comments$/.test(path)) return COMMENTS;
  if (path === "/search/issues") return { total_count: 0, items: [] };
  return [];
};

const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  Object.assign(
    (...[input, init]: Parameters<typeof globalThis.fetch>) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.origin === "https://api.github.com"
        ? Promise.resolve(Response.json(answerGithub(url.pathname)))
        : realFetch(input, init);
    },
    { preconnect: realFetch.preconnect },
  ),
);
afterAll(() => {
  vi.unstubAllGlobals();
});

/** The External Ref of pull request `number` in `o/r`. */
const prRef = (number: number): string => `github:pr:o/r#${String(number)}`;

/** The `subject` block of an event about pull request `number` in `o/r`. */
const buildSubject = (number: number) => ({
  repo: "o/r",
  number,
  title: PR_TITLE,
  url: `https://github.com/o/r/pull/${String(number)}`,
});

/** A controller with the GitHub plugin, the user's token, and the id of one GitHub Connection. */
interface GithubController {
  readonly arranged: Arranged;
  readonly reader: { readonly base: string; readonly token: string };
  readonly connectionId: string;
}

/** Runs `body` against a controller with the GitHub plugin and one GitHub Connection. */
const withGithubConnection = (body: (controller: GithubController) => Promise<void>) =>
  withPipeline(async (arranged) => {
    const reader = { base: arranged.harness.base, token: arranged.token };
    const connectionId = await createConnection(reader.base, reader.token, "github/github", {
      pat: "ghp_test",
    });
    await body({ arranged, reader, connectionId });
  });

/**
 * Writes one GitHub event about pull request `number` to the log as the
 * plugin ingests it through the Connection, with the refs the plugin's feeds
 * give it, and returns its id.
 */
const emitGithubEvent = (
  { arranged, connectionId }: GithubController,
  kind: string,
  number: number,
  fields: Record<string, unknown>,
): Promise<number> =>
  ingestEvent(arranged.harness, {
    pluginId: "github",
    connectionId,
    kind,
    title: PR_TITLE,
    refs: [prRef(number), "github:repo:o/r"],
    payload: { subject: buildSubject(number), ...fields },
  });

/** Emits a review request on pull request `number` to the user by name. */
const requestReviewFromYou = (controller: GithubController, number: number) =>
  emitGithubEvent(controller, "github.pr.review-requested", number, {
    reviewer: "you",
    requestedBy: "marta",
    byYou: false,
    toYou: true,
  });

/** Emits a review request on pull request `number` to the user's team `o/reviewers`. */
const requestReviewFromTeam = (controller: GithubController, number: number) =>
  emitGithubEvent(controller, "github.pr.review-requested", number, {
    reviewer: "team",
    team: "o/reviewers",
    requestedBy: "marta",
    byYou: false,
    toYou: false,
  });

/** Returns each action's id and the operation it runs, in order. */
const listOperations = (signal: Signal) =>
  signal.actions.map((action) => [action.id, action.operation]);

describe("raising GitHub's signals", () => {
  it("raises a review request to the user with the pull request's change and description, and decides it when the user approves on GitHub", async () => {
    await withGithubConnection(async (controller) => {
      const { reader, connectionId } = controller;
      const requested = await requestReviewFromYou(controller, 87);

      const signal = await waitForSignalFrom(reader, REVIEW_REQUESTED, requested);

      expect(signal).toMatchObject({
        origin: { type: "event", eventId: requested, connectionId, threadRef: prRef(87) },
        title: PR_TITLE,
        place: "o/r#87",
        priority: "high",
        blocks: [
          {
            type: "change",
            from: "feature/login",
            to: "main",
            files: 3,
            additions: 40,
            deletions: 2,
            commits: 2,
          },
          {
            type: "messages",
            messages: [
              {
                author: { name: "marta" },
                at: "2026-10-10T08:00:00.000Z",
                text: "Adds the login form and its tests.",
                url: "https://github.com/o/r/pull/87",
              },
            ],
            omitted: 0,
          },
        ],
      });
      expect(signal).not.toHaveProperty("buildError");
      expect(signal.actions.map((action) => action.label)).toEqual([
        "Approve",
        "Request changes",
        "Comment",
        "Done",
      ]);
      const address = { repo: "o/r", number: 87 };
      expect(listOperations(signal)).toEqual([
        [
          "approve",
          { op: "github/pr.review", connectionId, input: { ...address, verdict: "approve" } },
        ],
        [
          "request-changes",
          {
            op: "github/pr.review",
            connectionId,
            input: { ...address, verdict: "request-changes" },
          },
        ],
        ["comment", { op: "github/pr.comment", connectionId, input: address }],
        ["done", null],
      ]);
      expect(signal.actions.some((action) => action.primary === true)).toBe(false);
      expect(signal.actions[3]!.describeLine).toEqual([
        { kind: "text", text: "Takes it off your list. GitHub is not told" },
      ]);

      await emitGithubEvent(controller, "github.pr.review-submitted", 87, {
        reviewer: "octocat",
        verdict: "approved",
        byYou: true,
      });

      expect(await waitForResolved(reader, signal.id)).toMatchObject({
        status: "resolved",
        resolution: { kind: "decided", actionId: "approve", outcome: "Approved on GitHub" },
      });
    });
  });

  it("withdraws a review request when the request is removed on GitHub", async () => {
    await withGithubConnection(async (controller) => {
      const requested = await requestReviewFromYou(controller, 88);
      const signal = await waitForSignalFrom(controller.reader, REVIEW_REQUESTED, requested);

      await emitGithubEvent(controller, "github.pr.review-request-removed", 88, {
        reviewer: "you",
        byYou: false,
      });

      expect(await waitForResolved(controller.reader, signal.id)).toMatchObject({
        status: "resolved",
        resolution: { kind: "withdrawn", outcome: "Review request removed" },
      });
    });
  });

  it("keeps a team review request open while another of the user's teams is still asked, and withdraws it when none is", async () => {
    await withGithubConnection(async (controller) => {
      const { arranged, reader } = controller;
      const requested = await requestReviewFromTeam(controller, 93);
      const signal = await waitForSignalFrom(reader, TEAM_REVIEW_REQUESTED, requested);
      const removeTeam = (teamStillRequested: boolean) =>
        emitGithubEvent(controller, "github.pr.review-request-removed", 93, {
          reviewer: "team",
          team: "o/a",
          teamStillRequested,
          byYou: false,
        });

      const stillAsked = await removeTeam(true);
      await waitUntilRouted(arranged.harness, stillAsked);
      await waitOutSeveralTicks();
      expect(
        (await listOpenSignals(reader, TEAM_REVIEW_REQUESTED)).map((open) => open.id),
      ).toContain(signal.id);

      await removeTeam(false);
      expect(await waitForResolved(reader, signal.id)).toMatchObject({
        status: "resolved",
        resolution: { kind: "withdrawn", outcome: "Review request removed" },
      });
    });
  });

  it("does not withdraw a review request when someone emits github.pr.merged by hand", async () => {
    await withGithubConnection(async (controller) => {
      const { arranged, reader, connectionId } = controller;
      const requested = await requestReviewFromYou(controller, 90);
      const signal = await waitForSignalFrom(reader, REVIEW_REQUESTED, requested);

      const response = await post(
        reader.base,
        "/api/v1/events/emit",
        {
          kind: "github.pr.merged",
          connectionId,
          refs: [prRef(90), "github:repo:o/r"],
          payload: { subject: buildSubject(90) },
        },
        reader.token,
      );
      expect(response.ok, await response.clone().text()).toBe(true);
      const { eventId } = (await response.json()) as { readonly eventId: number };
      await waitUntilRouted(arranged.harness, eventId);
      await waitOutSeveralTicks();

      expect((await listOpenSignals(reader, REVIEW_REQUESTED)).map((open) => open.id)).toContain(
        signal.id,
      );
    });
  });

  it("raises a mention with the comments up to it and Reply as the primary answer", async () => {
    await withGithubConnection(async (controller) => {
      const { reader, connectionId } = controller;
      const mentioned = await emitGithubEvent(controller, "github.mentioned", 89, {
        commentId: MENTION_COMMENT_ID,
        commentUrl: "https://github.com/o/r/pull/89#issuecomment-3002",
        excerpt: "@octocat can you look?",
        byYou: false,
      });

      const signal = await waitForSignalFrom(reader, MENTIONED, mentioned);

      expect(signal).toMatchObject({
        title: PR_TITLE,
        place: "o/r#89",
        priority: "normal",
        blocks: [
          {
            type: "messages",
            messages: [
              { author: { name: "marta" }, text: "The tests fail on Windows." },
              { author: { name: "marta" }, text: "@octocat can you look?", mentionsYou: true },
            ],
            omitted: 0,
          },
        ],
      });
      expect(signal.blocks[0]).not.toHaveProperty("messages.0.mentionsYou");
      expect(listOperations(signal)).toEqual([
        ["reply", { op: "github/pr.comment", connectionId, input: { repo: "o/r", number: 89 } }],
        ["done", null],
      ]);
      expect(signal.actions[0]).toMatchObject({ label: "Reply", primary: true });
    });
  });
});

describe("the known-work check", () => {
  it("raises no team review request a session's Subscription already received, but still raises the user's own, and raises both without a Subscription", async () => {
    await withGithubConnection(async (controller) => {
      const { arranged, reader } = controller;
      const thread = await spawnSubscriber(arranged, "reviewer");
      const subscriptionId = await subscribeThread(arranged, thread, prRef(91));

      const handledTeam = await requestReviewFromTeam(controller, 91);
      const handledYou = await requestReviewFromYou(controller, 91);
      const team = await requestReviewFromTeam(controller, 92);
      const you = await requestReviewFromYou(controller, 92);

      // The session received both requests on #91, and neither on #92.
      await waitForMatchedInputRows(arranged.harness, subscriptionId, (rows) => rows.length === 2);
      expect(
        (await readMatchedInputRows(arranged.harness, subscriptionId)).map((row) => row.event_id),
      ).toEqual([handledTeam, handledYou]);

      // The team request on #92 has no session working on it, so it raises,
      // with the team kind's normal priority.
      expect(await waitForSignalFrom(reader, TEAM_REVIEW_REQUESTED, team)).toMatchObject({
        priority: "normal",
        title: PR_TITLE,
      });
      // A review request to the user by name raises even when a session
      // already received it.
      await waitForSignalFrom(reader, REVIEW_REQUESTED, handledYou);
      await waitForSignalFrom(reader, REVIEW_REQUESTED, you);

      // Raises are delivered oldest event first, so once the newest event's
      // signal exists, the team request on #91 has had its turn: it has
      // neither a signal nor a raise still waiting to be delivered.
      expect(
        (await listOpenSignals(reader, TEAM_REVIEW_REQUESTED)).map(
          (signal) => signal.origin.type === "event" && signal.origin.eventId,
        ),
      ).toEqual([team]);
      expect(
        await runEffect(
          arranged.harness.sql`SELECT event_id FROM signal_raises WHERE event_id = ${handledTeam}`,
        ),
      ).toEqual([]);
    });
  });
});
