/**
 * Tests the events about what people did on one item: which comments
 * mention the user, which review requests are for the user, one of their
 * teams or made by the user, which assignments the history holds, and what a
 * review says about whose pull request it is on. The ingest harness checks each event against its kind's
 * schema, as the host does.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import {
  buildIngestHarness,
  runAgainstStub,
  stubGithub,
  TEST_ACCOUNT,
  TEST_IDENTITY,
} from "../testing";
import { TEST_TOKEN } from "../actions/testing";
import {
  emitCommentEvents,
  emitHistoryEvents,
  emitNewReviews,
  type ActivityPoll,
} from "./activity";

const REPO = "acme/webshop";
const PULL = { repo: REPO, kind: "pr" as const, number: 1293, title: "Faster checkout" };

/** Builds pull request 1293 as GitHub returns it, asking `reviewers` and `teams` for a review. */
const buildPullNow = (
  reviewers: Array<{ readonly login: string; readonly id: number }> = [],
  teams: Array<string> = [],
) => ({
  number: 1293,
  title: "Faster checkout",
  state: "open",
  user: TEST_ACCOUNT,
  head: { sha: "sha-a" },
  updated_at: "2026-10-11T10:00:00Z",
  requested_reviewers: reviewers,
  requested_teams: teams.map((slug) => ({ slug })),
});

/** Builds the poll the emitters read, with the user on the team `acme/payments`. */
const buildPoll = () => {
  const harness = buildIngestHarness();
  const poll: ActivityPoll = {
    repo: REPO,
    token: TEST_TOKEN,
    emit: harness.context.emit,
    identity: TEST_IDENTITY,
    teams: new Set(["acme/payments"]),
  };
  return { harness, poll };
};

/** Builds a comment by `user`, as GitHub lists it. */
const buildComment = (
  body: string,
  user: { readonly login: string; readonly id: number } | null = { login: "marta", id: 9 },
) => ({
  id: 77,
  html_url: `https://github.com/${REPO}/pull/1293#issuecomment-77`,
  issue_url: `https://api.github.com/repos/${REPO}/issues/1293`,
  user,
  body,
  created_at: "2026-10-11T09:00:00Z",
  updated_at: "2026-10-11T09:00:00Z",
});

describe("emitCommentEvents", () => {
  it("emits a mention beside the comment when it names the user", async () => {
    const { harness, poll } = buildPoll();
    const comment = buildComment("Looks good, but @octocat should check the totals.");

    await Effect.runPromise(emitCommentEvents(poll, PULL, comment, comment));

    expect(harness.events.map((event) => event.kind)).toEqual([
      "github.pr.commented",
      "github.mentioned",
    ]);
    expect(harness.events[1]).toMatchObject({
      dedupKey: "mentioned:77",
      author: "marta",
      title: `marta mentioned you on ${REPO}#1293`,
      payload: {
        commentId: 77,
        commentUrl: comment.html_url,
        excerpt: "Looks good, but @octocat should check the totals.",
        byYou: false,
      },
    });
  });

  it("emits no mention for a quoted mention or a longer login", async () => {
    const { harness, poll } = buildPoll();
    const comment = buildComment("> @octocat said so\n\nAsk @octocatz instead.");

    await Effect.runPromise(emitCommentEvents(poll, PULL, comment, comment));

    expect(harness.events.map((event) => event.kind)).toEqual(["github.pr.commented"]);
  });

  it("marks the user's own mention of themselves, which the signal rule skips", async () => {
    const { harness, poll } = buildPoll();
    const comment = buildComment("Note to self, @octocat", TEST_ACCOUNT);

    await Effect.runPromise(emitCommentEvents(poll, PULL, comment, comment));

    expect(harness.events).toMatchObject([
      { payload: { byYou: true } },
      { payload: { byYou: true } },
    ]);
  });
});

/** Builds one entry of a pull request's history. */
const buildEntry = (id: number, event: string, extra: object) => ({
  id,
  event,
  created_at: "2026-10-11T10:00:00Z",
  actor: { login: "marta", id: 9 },
  ...extra,
});

describe("emitHistoryEvents", () => {
  const history = [
    buildEntry(1, "review_requested", {
      requested_reviewer: TEST_ACCOUNT,
      review_requester: { login: "marta", id: 9 },
    }),
    buildEntry(2, "review_requested", { requested_team: { slug: "payments" } }),
    buildEntry(3, "review_requested", { requested_team: { slug: "design" } }),
    buildEntry(4, "review_requested", { requested_reviewer: { login: "mona", id: 2 } }),
    buildEntry(5, "review_request_removed", { requested_reviewer: TEST_ACCOUNT }),
    buildEntry(6, "labeled", {}),
  ];

  it("emits the requests to the user and their teams, and the removals, and nothing else", async () => {
    const { harness, poll } = buildPoll();
    const stub = stubGithub(() => ({ status: 200, body: history }));

    const result = await runAgainstStub(
      emitHistoryEvents(poll, PULL, undefined, Effect.succeed(buildPullNow())),
      stub,
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(harness.events).toMatchObject([
      {
        kind: "github.pr.review-requested",
        dedupKey: "pr.review-requested:1",
        payload: { reviewer: "you" },
      },
      {
        kind: "github.pr.review-requested",
        dedupKey: "pr.review-requested:2",
        payload: { reviewer: "team" },
      },
      {
        kind: "github.pr.review-request-removed",
        dedupKey: "pr.review-request-removed:5",
        payload: { reviewer: "you" },
      },
    ]);
    expect(harness.events[0]).toMatchObject({
      author: "marta",
      title: `marta requested your review on ${REPO}#1293`,
      payload: { requestedBy: "marta", byYou: false, toYou: true },
    });
    expect(harness.events[1]).toMatchObject({
      title: `marta requested a review from acme/payments on ${REPO}#1293`,
      payload: { team: "acme/payments", toYou: false },
    });
  });

  it("skips the entries from before the poll's start", async () => {
    const { harness, poll } = buildPoll();
    const stub = stubGithub(() => ({ status: 200, body: history }));

    await runAgainstStub(
      emitHistoryEvents(poll, PULL, "2026-10-11T11:00:00Z", Effect.succeed(buildPullNow())),
      stub,
    );

    expect(harness.events).toEqual([]);
  });

  it("says on a team's removal whether the pull request still asks another of the user's teams", async () => {
    const { harness, poll } = buildPoll();
    const teams = new Set(["acme/payments", "acme/design"]);
    const removal = buildEntry(7, "review_request_removed", {
      requested_team: { slug: "payments" },
    });
    const stub = stubGithub(() => ({ status: 200, body: [removal] }));

    const readRemoval = async (pullNow: ReturnType<typeof buildPullNow>) => {
      harness.events.length = 0;
      await runAgainstStub(
        emitHistoryEvents({ ...poll, teams }, PULL, undefined, Effect.succeed(pullNow)),
        stub,
      );
      return harness.events[0]!.payload;
    };

    expect(await readRemoval(buildPullNow([], ["design"]))).toMatchObject({
      team: "acme/payments",
      teamStillRequested: true,
    });
    expect(await readRemoval(buildPullNow([TEST_ACCOUNT]))).toMatchObject({
      teamStillRequested: false,
    });
  });

  it("emits a request the user made to someone else as reviewer other, with no team", async () => {
    const { harness, poll } = buildPoll();
    const asked = {
      actor: TEST_ACCOUNT,
      review_requester: TEST_ACCOUNT,
    };
    const stub = stubGithub(() => ({
      status: 200,
      body: [
        buildEntry(21, "review_requested", {
          ...asked,
          requested_reviewer: { login: "mona", id: 2 },
        }),
        buildEntry(22, "review_requested", { ...asked, requested_team: { slug: "design" } }),
      ],
    }));

    await runAgainstStub(
      emitHistoryEvents(poll, PULL, undefined, Effect.succeed(buildPullNow())),
      stub,
    );

    expect(harness.events).toMatchObject([
      {
        kind: "github.pr.review-requested",
        dedupKey: "pr.review-requested:21",
        author: "octocat",
        title: `octocat requested a review from mona on ${REPO}#1293`,
        payload: { reviewer: "other", requestedBy: "octocat", byYou: true, toYou: false },
      },
      {
        dedupKey: "pr.review-requested:22",
        title: `octocat requested a review from acme/design on ${REPO}#1293`,
        payload: { reviewer: "other", byYou: true, toYou: false },
      },
    ]);
    for (const event of harness.events) expect(event.payload).not.toHaveProperty("team");
  });

  it("emits nothing for a request to someone else that another person made, or that the user took back", async () => {
    const { harness, poll } = buildPoll();
    const stub = stubGithub(() => ({
      status: 200,
      body: [
        buildEntry(23, "review_requested", { requested_reviewer: { login: "mona", id: 2 } }),
        buildEntry(24, "review_request_removed", {
          actor: TEST_ACCOUNT,
          requested_reviewer: { login: "mona", id: 2 },
        }),
      ],
    }));

    await runAgainstStub(
      emitHistoryEvents(poll, PULL, undefined, Effect.succeed(buildPullNow())),
      stub,
    );

    expect(harness.events).toEqual([]);
  });
});

describe("emitHistoryEvents, for assignments", () => {
  const ISSUE = { repo: REPO, kind: "issue" as const, number: 88, title: "Totals are off" };

  /** Reads `history` as the history of `item`, and returns the events emitted. */
  const readHistory = async (
    item: typeof ISSUE | typeof PULL,
    history: Array<object>,
    start?: string,
  ) => {
    const { harness, poll } = buildPoll();
    const stub = stubGithub(() => ({ status: 200, body: history }));
    await runAgainstStub(
      emitHistoryEvents(poll, item, start, Effect.succeed(buildPullNow())),
      stub,
    );
    return harness.events;
  };

  it("emits an assignment to the user by someone else", async () => {
    const events = await readHistory(ISSUE, [
      buildEntry(11, "assigned", { assignee: TEST_ACCOUNT }),
    ]);

    expect(events).toMatchObject([
      {
        kind: "github.issue.assigned",
        dedupKey: "issue.assigned:11",
        author: "marta",
        title: `marta assigned octocat to ${REPO}#88`,
        payload: { assignee: "octocat", toYou: true, byYou: false },
      },
    ]);
  });

  it("emits an assignment to someone else, and one the user made", async () => {
    const events = await readHistory(ISSUE, [
      buildEntry(12, "assigned", { assignee: { login: "mona", id: 2 } }),
      buildEntry(13, "assigned", { actor: TEST_ACCOUNT, assignee: { login: "mona", id: 2 } }),
    ]);

    expect(events).toMatchObject([
      { author: "marta", payload: { assignee: "mona", toYou: false, byYou: false } },
      { author: "octocat", payload: { assignee: "mona", toYou: false, byYou: true } },
    ]);
  });

  it("emits an unassignment with its own kind and key", async () => {
    const events = await readHistory(ISSUE, [
      buildEntry(14, "unassigned", { assignee: TEST_ACCOUNT }),
    ]);

    expect(events).toMatchObject([
      {
        kind: "github.issue.unassigned",
        dedupKey: "issue.unassigned:14",
        title: `marta unassigned octocat from ${REPO}#88`,
        payload: { assignee: "octocat", toYou: true, byYou: false },
      },
    ]);
  });

  it("gives an assignment on a pull request the pull request's refs", async () => {
    const events = await readHistory(PULL, [
      buildEntry(15, "assigned", { assignee: TEST_ACCOUNT }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]!.refs).toContain(`github:pr:${REPO}#1293`);
    expect(events[0]!.refs).not.toContain(`github:issue:${REPO}#1293`);
  });

  it("leaves the author empty when GitHub names no actor, and skips an entry with no assignee", async () => {
    const events = await readHistory(ISSUE, [
      buildEntry(16, "assigned", { actor: null, assignee: TEST_ACCOUNT }),
      buildEntry(17, "assigned", { assignee: null }),
    ]);

    expect(events).toMatchObject([{ dedupKey: "issue.assigned:16", author: null }]);
  });

  it("skips the assignments from before the poll's start", async () => {
    const events = await readHistory(
      ISSUE,
      [buildEntry(18, "assigned", { assignee: TEST_ACCOUNT })],
      "2026-10-11T10:00:01Z",
    );

    expect(events).toEqual([]);
  });
});

describe("emitNewReviews", () => {
  const review = {
    id: 5001,
    user: { login: "marta", id: 9 },
    state: "CHANGES_REQUESTED",
    submitted_at: "2026-10-11T10:00:00Z",
  };

  /** Reads one review of the pull request, saying whether the pull request is the user's. */
  const readReviews = async (onYourPullRequest: boolean) => {
    const { harness, poll } = buildPoll();
    const stub = stubGithub(() => ({ status: 200, body: [review] }));
    await runAgainstStub(emitNewReviews(poll, PULL, undefined, onYourPullRequest), stub);
    return harness.events;
  };

  it("carries the review's id and says the pull request is the user's", async () => {
    expect(await readReviews(true)).toMatchObject([
      {
        kind: "github.pr.review-submitted",
        dedupKey: "pr.review-submitted:5001",
        payload: {
          reviewer: "marta",
          verdict: "changes-requested",
          reviewId: 5001,
          byYou: false,
          onYourPullRequest: true,
        },
      },
    ]);
  });

  it("says when the pull request is somebody else's", async () => {
    expect(await readReviews(false)).toMatchObject([{ payload: { onYourPullRequest: false } }]);
  });
});
