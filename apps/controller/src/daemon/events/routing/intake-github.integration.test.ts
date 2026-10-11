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
 * responses become these events. Most events here have no author. The ones
 * that do, such as the assignments and the ends of the later kinds, check what
 * a signal or an outcome takes from it: the asker, and "Merged by marta".
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
import {
  listOpenSignals,
  readSignal,
  waitForResolved,
  waitForSignalFrom,
} from "../../../signals/testing";
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
const ASSIGNED = "github/assigned";
const CHANGES_REQUESTED = "github/changes-requested";
const CHECKS_FAILED = "github/checks-failed";

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

/** The issue or pull request `GET /repos/o/r/issues/{number}` returns, for any number. GitHub answers it for both. */
const ISSUE = {
  title: "Login fails on Safari",
  body: "Signing in with a password does nothing on Safari 19.",
  html_url: "https://github.com/o/r/issues/101",
  created_at: "2026-10-09T15:30:00Z",
  user: { login: "marta", id: 1001 },
};

/** The id of the review `GET /repos/o/r/pulls/{number}/reviews/{id}` returns, for any pull request. */
const REVIEW_ID = 5001;

const REVIEW = {
  id: REVIEW_ID,
  user: { login: "marta", id: 1001 },
  body: "This needs a validation step before it ships.",
  state: "CHANGES_REQUESTED",
  html_url: `https://github.com/o/r/pull/111#pullrequestreview-${String(REVIEW_ID)}`,
  submitted_at: "2026-10-11T10:02:00Z",
};

/** The comments `GET .../reviews/{id}/comments` returns: one on a line of the diff, and one that later commits moved off it. */
const REVIEW_COMMENTS = [
  {
    id: 6001,
    user: { login: "marta", id: 1001 },
    body: "The email is not trimmed.",
    html_url: "https://github.com/o/r/pull/111#discussion_r6001",
    created_at: "2026-10-11T10:02:00Z",
    path: "src/login.ts",
    line: 42,
    original_line: 42,
  },
  {
    id: 6002,
    user: { login: "marta", id: 1001 },
    body: "Please add a test for the empty password.",
    html_url: "https://github.com/o/r/pull/111#discussion_r6002",
    created_at: "2026-10-11T10:02:00Z",
    path: "src/login.test.ts",
    line: null,
    original_line: 17,
  },
];

/** The commit the checks on the pull request ran on, and the one a later push made. */
const FIRST_HEAD_SHA = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const NEXT_HEAD_SHA = "c3d0be4a5f7e1b2d8a6c90f4e5b7a1d2c3e4f506";

/** Returns a check run as `GET /repos/o/r/commits/{sha}/check-runs` lists it. */
const buildCheckRun = (
  id: number,
  name: string,
  conclusion: "success" | "failure" | "neutral",
  annotationsCount = 0,
) => ({
  id,
  name,
  status: "completed",
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/7001/job/${String(id)}`,
  app: { id: 15368, slug: "github-actions", name: "GitHub Actions" },
  output: { title: null, summary: null, text: null, annotations_count: annotationsCount },
});

/**
 * The check runs `GET /repos/o/r/commits/{sha}/check-runs` returns for each
 * commit: one failure with two annotations beside two passing runs, then, on
 * the later commit, a different failure.
 */
const CHECK_RUNS_BY_SHA: Record<string, unknown> = {
  [FIRST_HEAD_SHA]: {
    total_count: 3,
    check_runs: [
      buildCheckRun(8001, "build", "success"),
      buildCheckRun(8002, "test", "failure", 2),
      buildCheckRun(8003, "typecheck", "neutral"),
    ],
  },
  [NEXT_HEAD_SHA]: {
    total_count: 2,
    check_runs: [
      buildCheckRun(8004, "build", "success"),
      buildCheckRun(8005, "lint", "failure", 1),
    ],
  },
};

/** The annotations `GET /repos/o/r/check-runs/{id}/annotations` returns, by check run id. */
const ANNOTATIONS_BY_CHECK_RUN: Record<string, unknown> = {
  "8002": [
    {
      path: "src/login.test.ts",
      start_line: 12,
      end_line: 12,
      annotation_level: "failure",
      title: "login rejects an empty password",
      message: "Expected 401, received 200",
    },
    {
      path: "src/login.test.ts",
      start_line: 30,
      end_line: 31,
      annotation_level: "failure",
      title: "login trims the email",
      message: "Expected 'a@b.c', received ' a@b.c'",
    },
  ],
  "8005": [
    {
      path: "src/login.ts",
      start_line: 7,
      end_line: 7,
      annotation_level: "failure",
      title: "no-unused-vars",
      message: "'token' is defined but never used",
    },
  ],
};

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
  if (/^\/repos\/o\/r\/issues\/\d+$/.test(path)) return ISSUE;
  if (/^\/repos\/o\/r\/pulls\/\d+\/reviews\/\d+$/.test(path)) return REVIEW;
  if (/^\/repos\/o\/r\/pulls\/\d+\/reviews\/\d+\/comments$/.test(path)) return REVIEW_COMMENTS;
  const checkRuns = /^\/repos\/o\/r\/commits\/(\w+)\/check-runs$/.exec(path);
  if (checkRuns !== null) return CHECK_RUNS_BY_SHA[checkRuns[1]!];
  const annotations = /^\/repos\/o\/r\/check-runs\/(\d+)\/annotations$/.exec(path);
  if (annotations !== null) return ANNOTATIONS_BY_CHECK_RUN[annotations[1]!];
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

/** The External Ref of issue `number` in `o/r`. */
const issueRef = (number: number): string => `github:issue:o/r#${String(number)}`;

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
 * give it, and returns its id. `author` is who caused the event, and `item`
 * is `issue` for an event about an issue rather than a pull request.
 */
const emitGithubEvent = (
  { arranged, connectionId }: GithubController,
  kind: string,
  number: number,
  fields: Record<string, unknown>,
  { author, item = "pr" }: { readonly author?: string; readonly item?: "issue" | "pr" } = {},
): Promise<number> =>
  ingestEvent(arranged.harness, {
    pluginId: "github",
    connectionId,
    kind,
    title: PR_TITLE,
    refs: [item === "pr" ? prRef(number) : issueRef(number), "github:repo:o/r"],
    ...(author === undefined ? {} : { author }),
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

/** Returns the ids of the events the open signals of `kind` were raised from. */
const listOpenSignalEvents = async (
  reader: GithubController["reader"],
  kind: string,
): Promise<ReadonlyArray<number | false>> =>
  (await listOpenSignals(reader, kind)).map(
    (signal) => signal.origin.type === "event" && signal.origin.eventId,
  );

describe("assignments", () => {
  /** Emits an assignment event on issue `number`, by default of the user to it by someone else. */
  const emitAssignment = (
    controller: GithubController,
    kind: "assigned" | "unassigned",
    number: number,
    fields: Record<string, unknown>,
    author?: string,
  ) =>
    emitGithubEvent(
      controller,
      `github.issue.${kind}`,
      number,
      { assignee: "octocat", toYou: true, byYou: false, ...fields },
      { item: "issue", ...(author === undefined ? {} : { author }) },
    );

  it("raises an assignment by someone else with the description and Reply, and none the user made or that names another account", async () => {
    await withGithubConnection(async (controller) => {
      const { reader, connectionId } = controller;
      // The two that raise nothing come first: raises are delivered oldest
      // event first, so once the last one's signal exists they have had their turn.
      await emitAssignment(controller, "assigned", 102, { byYou: true }, "octocat");
      await emitAssignment(controller, "assigned", 103, { assignee: "marta", toYou: false });
      const assigned = await emitAssignment(controller, "assigned", 101, {}, "marta");

      const signal = await waitForSignalFrom(reader, ASSIGNED, assigned);

      expect(signal).toMatchObject({
        title: ISSUE.title,
        asker: "marta",
        place: "o/r#101",
        priority: "normal",
        blocks: [
          {
            type: "messages",
            messages: [
              {
                author: { name: "marta" },
                at: "2026-10-09T15:30:00.000Z",
                text: ISSUE.body,
                url: ISSUE.html_url,
              },
            ],
            omitted: 0,
          },
        ],
      });
      expect(listOperations(signal)).toEqual([
        [
          "reply",
          { op: "github/issue.comment", connectionId, input: { repo: "o/r", number: 101 } },
        ],
        ["done", null],
      ]);
      expect(signal.actions[0]).not.toHaveProperty("primary");
      expect(await listOpenSignalEvents(reader, ASSIGNED)).toEqual([assigned]);
    });
  });

  it.each([
    {
      name: "the user is unassigned by someone else",
      item: "issue" as const,
      kind: "github.issue.unassigned",
      fields: { assignee: "octocat", toYou: true, byYou: false },
      author: "marta",
      outcome: "Unassigned by marta",
    },
    {
      name: "the user unassigns themselves",
      item: "issue" as const,
      kind: "github.issue.unassigned",
      fields: { assignee: "octocat", toYou: true, byYou: true },
      author: "octocat",
      outcome: "You unassigned yourself on GitHub",
    },
    {
      name: "the issue is closed",
      item: "issue" as const,
      kind: "github.issue.closed",
      fields: {},
      author: "marta",
      outcome: "Closed by marta",
    },
    {
      name: "the pull request is merged",
      item: "pr" as const,
      kind: "github.pr.merged",
      fields: {},
      author: "marta",
      outcome: "Merged by marta",
    },
    {
      name: "the pull request is closed",
      item: "pr" as const,
      kind: "github.pr.closed",
      fields: {},
      author: "marta",
      outcome: "Closed by marta",
    },
  ])("withdraws an assignment when $name", async ({ item, kind, fields, author, outcome }) => {
    await withGithubConnection(async (controller) => {
      const assigned = await emitGithubEvent(
        controller,
        "github.issue.assigned",
        101,
        { assignee: "octocat", toYou: true, byYou: false },
        { item, author: "marta" },
      );
      const signal = await waitForSignalFrom(controller.reader, ASSIGNED, assigned);
      if (item === "pr")
        expect(signal.actions[0]!.operation).toMatchObject({ op: "github/pr.comment" });

      // Someone else's unassignment comes first and must not end the signal: its
      // outcome would be "Unassigned", not the one expected below.
      await emitAssignment(controller, "unassigned", 101, { assignee: "marta", toYou: false });
      await emitGithubEvent(controller, kind, 101, fields, { item, author });

      expect(await waitForResolved(controller.reader, signal.id)).toMatchObject({
        status: "resolved",
        resolution: { kind: "withdrawn", outcome },
      });
    });
  });
});

describe("changes requested", () => {
  /** Emits a review on pull request `number`, by default one by marta that requests changes on the user's pull request. */
  const submitReview = (
    controller: GithubController,
    number: number,
    fields: Record<string, unknown> = {},
  ) =>
    emitGithubEvent(
      controller,
      "github.pr.review-submitted",
      number,
      {
        reviewer: "marta",
        verdict: "changes-requested",
        reviewId: REVIEW_ID,
        byYou: false,
        onYourPullRequest: true,
        ...fields,
      },
      { author: "marta" },
    );

  it("raises changes requested on the user's pull request with the review, its comments and Reply, and none on another's pull request or for an approval", async () => {
    await withGithubConnection(async (controller) => {
      const { reader, connectionId } = controller;
      await submitReview(controller, 112, { onYourPullRequest: false });
      await submitReview(controller, 113, { verdict: "approved" });
      const requested = await submitReview(controller, 111);

      const signal = await waitForSignalFrom(reader, CHANGES_REQUESTED, requested);

      expect(signal).toMatchObject({
        title: PR_TITLE,
        asker: "marta",
        place: "o/r#111",
        priority: "normal",
        blocks: [
          {
            type: "messages",
            messages: [
              {
                author: { name: "marta" },
                at: "2026-10-11T10:02:00.000Z",
                text: REVIEW.body,
                url: REVIEW.html_url,
              },
              {
                text: "The email is not trimmed.",
                location: { path: "src/login.ts", line: 42 },
              },
              {
                text: "Please add a test for the empty password.",
                location: { path: "src/login.test.ts", line: 17 },
              },
            ],
            omitted: 0,
          },
        ],
      });
      expect(listOperations(signal)).toEqual([
        ["reply", { op: "github/pr.comment", connectionId, input: { repo: "o/r", number: 111 } }],
        ["done", null],
      ]);
      expect(await listOpenSignalEvents(reader, CHANGES_REQUESTED)).toEqual([requested]);
    });
  });

  it.each([
    {
      name: "the user asks the reviewer again",
      kind: "github.pr.review-requested",
      fields: { reviewer: "other", requestedBy: "octocat", byYou: true, toYou: false },
      resolution: "decided",
      outcome: "Asked for another review on GitHub",
    },
    {
      name: "the pull request is closed",
      kind: "github.pr.closed",
      fields: {},
      resolution: "withdrawn",
      outcome: "Closed by marta",
    },
  ])("ends changes requested when $name", async ({ kind, fields, resolution, outcome }) => {
    await withGithubConnection(async (controller) => {
      const requested = await submitReview(controller, 111);
      const signal = await waitForSignalFrom(controller.reader, CHANGES_REQUESTED, requested);

      await emitGithubEvent(controller, kind, 111, fields, { author: "marta" });

      expect(await waitForResolved(controller.reader, signal.id)).toMatchObject({
        status: "resolved",
        resolution: { kind: resolution, outcome },
      });
    });
  });
});

describe("failed checks", () => {
  /** Emits the end of the checks on pull request `number`'s head commit, by default a failure of `test` on the user's pull request. */
  const completeChecks = (
    controller: GithubController,
    number: number,
    fields: Record<string, unknown> = {},
  ) =>
    emitGithubEvent(controller, "github.pr.checks-completed", number, {
      conclusion: "failure",
      suites: [{ name: "CI", conclusion: "failure" }],
      headSha: FIRST_HEAD_SHA,
      failedChecks: ["test"],
      onYourPullRequest: true,
      ...fields,
    });

  /** The fields of a checks event whose checks all passed. */
  const PASSED = { conclusion: "success", failedChecks: [] };

  it("raises failed checks on the user's pull request with the failed check's log and Re-run, and none on another's pull request or for a success", async () => {
    await withGithubConnection(async (controller) => {
      const { reader, connectionId } = controller;
      await completeChecks(controller, 132, { onYourPullRequest: false });
      await completeChecks(controller, 133, PASSED);
      const failed = await completeChecks(controller, 131);

      const signal = await waitForSignalFrom(reader, CHECKS_FAILED, failed);

      expect(signal).toMatchObject({
        title: PR_TITLE,
        asker: "GitHub Actions",
        place: "o/r#131",
        priority: "normal",
        blocks: [
          {
            type: "checks",
            rows: [
              {
                name: "test",
                state: "failed",
                url: "https://github.com/o/r/actions/runs/7001/job/8002",
                log: "src/login.test.ts:12 Expected 401, received 200\nsrc/login.test.ts:30 Expected 'a@b.c', received ' a@b.c'",
              },
            ],
            passed: 2,
            omitted: 0,
          },
        ],
      });
      expect(listOperations(signal)).toEqual([
        [
          "rerun",
          {
            op: "github/checks.rerun",
            connectionId,
            input: { repo: "o/r", number: 131, sha: FIRST_HEAD_SHA },
          },
        ],
        ["done", null],
      ]);
      expect(signal.actions[0]).toMatchObject({ label: "Re-run failed checks", primary: true });
      expect(await listOpenSignalEvents(reader, CHECKS_FAILED)).toEqual([failed]);
    });
  });

  it.each([
    {
      name: "a later run of the checks passes",
      kind: "github.pr.checks-completed",
      fields: PASSED,
      outcome: "Checks passed",
    },
    {
      name: "the pull request is merged",
      kind: "github.pr.merged",
      fields: {},
      outcome: "Merged by marta",
    },
  ])("withdraws failed checks when $name", async ({ kind, fields, outcome }) => {
    await withGithubConnection(async (controller) => {
      const failed = await completeChecks(controller, 131);
      const signal = await waitForSignalFrom(controller.reader, CHECKS_FAILED, failed);

      await emitGithubEvent(controller, kind, 131, fields, { author: "marta" });

      expect(await waitForResolved(controller.reader, signal.id)).toMatchObject({
        status: "resolved",
        resolution: { kind: "withdrawn", outcome },
      });
    });
  });

  it("replaces failed checks with the failure on a newer head commit instead of ending them", async () => {
    await withGithubConnection(async (controller) => {
      const { reader } = controller;
      const first = await completeChecks(controller, 131);
      const older = await waitForSignalFrom(reader, CHECKS_FAILED, first);

      const second = await completeChecks(controller, 131, {
        headSha: NEXT_HEAD_SHA,
        failedChecks: ["lint"],
      });
      const newer = await waitForSignalFrom(reader, CHECKS_FAILED, second);

      expect(newer.blocks).toMatchObject([
        {
          type: "checks",
          rows: [{ name: "lint", log: "src/login.ts:7 'token' is defined but never used" }],
        },
      ]);
      expect(await readSignal(reader, older.id)).toMatchObject({
        status: "resolved",
        replacedBy: newer.id,
        resolution: { kind: "withdrawn", outcome: "Replaced by a newer one", origin: "core" },
      });
    });
  });
});
