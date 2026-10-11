/**
 * Tests the events about what people did on one item: which comments
 * mention the user, and which review requests are for the user or one of
 * their teams. The ingest harness checks each event against its kind's
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
import { emitCommentEvents, emitReviewRequestEvents, type ActivityPoll } from "./activity";

const REPO = "acme/webshop";
const PULL = { repo: REPO, kind: "pr" as const, number: 1293, title: "Faster checkout" };

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

describe("emitReviewRequestEvents", () => {
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
      emitReviewRequestEvents(poll, PULL, undefined, Effect.succeed([])),
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
      emitReviewRequestEvents(poll, PULL, "2026-10-11T11:00:00Z", Effect.succeed([])),
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

    const readRemoval = async (requestsNow: ReadonlyArray<string>) => {
      harness.events.length = 0;
      await runAgainstStub(
        emitReviewRequestEvents({ ...poll, teams }, PULL, undefined, Effect.succeed(requestsNow)),
        stub,
      );
      return harness.events[0]!.payload;
    };

    expect(await readRemoval(["team:acme/design"])).toMatchObject({
      team: "acme/payments",
      teamStillRequested: true,
    });
    expect(await readRemoval(["you"])).toMatchObject({ teamStillRequested: false });
  });
});
