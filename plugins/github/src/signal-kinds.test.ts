/**
 * Tests the `build` of each signal kind against a stub GitHub: the requests
 * it sends, and that the draft it returns passes the contract's block and
 * action schemas, which the core checks before it writes the signal.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import type { SignalBuildContext, SignalDraft, StoredEvent } from "@hercule/plugin-host";
import { BoundAction, KnownBlock } from "@hercule/contract";
import { TEST_TOKEN } from "./actions/testing";
import { buildMentionSignal, buildReviewRequestSignal } from "./signal-kinds";
import { buildItemRef } from "./subject";
import {
  readStubRequestTarget,
  runAgainstStub,
  stubGithub,
  TEST_ACCOUNT,
  TEST_IDENTITY,
} from "./testing";

const REPO = "octocat/hello-world";

const CONTEXT: SignalBuildContext = {
  connection: { id: "conn_1", config: {}, ...TEST_IDENTITY, displayName: TEST_IDENTITY.login },
  credentials: () => Effect.succeed({ pat: TEST_TOKEN }),
};

/** Builds a stored event about item `number` of the test repository. */
const buildStoredEvent = (
  kind: string,
  itemKind: "issue" | "pr",
  payload: Record<string, unknown>,
): StoredEvent => ({
  id: 7,
  kind,
  occurredAt: "2026-10-11T09:14:03Z",
  payload,
  refs: [buildItemRef({ repo: REPO, kind: itemKind, number: 1347 }), `github:repo:${REPO}`],
  url: null,
  title: "mona did something on octocat/hello-world#1347",
  author: "mona",
});

/** The fields of a draft action the contract's `BoundAction` checks; the core binds the rest. */
const DraftActionFields = Schema.Struct({
  id: BoundAction.fields.id,
  label: BoundAction.fields.label,
  primary: BoundAction.fields.primary,
  field: BoundAction.fields.field,
});

/** Checks that a draft's blocks and actions pass the contract's schemas. */
const expectDraftWithinContract = (draft: SignalDraft): void => {
  for (const block of draft.blocks) {
    expect(Schema.decodeUnknownResult(KnownBlock)(block)._tag, JSON.stringify(block)).toBe(
      "Success",
    );
  }
  for (const action of draft.actions) {
    const { id, label, primary, field } = action;
    const fields = {
      id,
      label,
      ...(primary === undefined ? {} : { primary }),
      ...(field === undefined ? {} : { field }),
    };
    expect(Schema.decodeUnknownResult(DraftActionFields)(fields)._tag).toBe("Success");
  }
};

/** Returns the draft a build succeeded with, or throws its error. */
const readDraft = (
  result: Result.Result<SignalDraft, { readonly message: string }>,
): SignalDraft => {
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};

/** A pull request as `GET /repos/{owner}/{repo}/pulls/{number}` returns it. */
const PULL = {
  number: 1347,
  title: "Amazing new feature",
  body: "Please pull these awesome changes in!",
  html_url: `https://github.com/${REPO}/pull/1347`,
  created_at: "2026-10-10T08:00:00Z",
  user: { login: "mona", id: 2, avatar_url: "https://avatars.githubusercontent.com/u/2?v=4" },
  head: { ref: "new-topic" },
  base: { ref: "main" },
  changed_files: 5,
  additions: 120,
  deletions: 7,
  commits: 3,
};

describe("the review request signal", () => {
  const event = buildStoredEvent("github.pr.review-requested", "pr", { reviewer: "you" });

  it("reads the pull request once and shows its totals, its description and three answers", async () => {
    const stub = stubGithub(() => ({ status: 200, body: PULL }));

    const draft = readDraft(await runAgainstStub(buildReviewRequestSignal(event, CONTEXT), stub));

    expect(stub.requests.map((request) => readStubRequestTarget(request).path)).toEqual([
      `/repos/${REPO}/pulls/1347`,
    ]);
    expect(draft).toMatchObject({
      title: "Amazing new feature",
      asker: "mona",
      place: `${REPO}#1347`,
    });
    expect(draft.blocks).toEqual([
      {
        type: "change",
        from: "new-topic",
        to: "main",
        files: 5,
        additions: 120,
        deletions: 7,
        commits: 3,
      },
      {
        type: "messages",
        messages: [
          {
            author: { name: "mona", avatarUrl: PULL.user.avatar_url },
            at: "2026-10-10T08:00:00.000Z",
            text: "Please pull these awesome changes in!",
            url: PULL.html_url,
          },
        ],
        omitted: 0,
      },
    ]);
    expect(draft.actions.map((action) => [action.id, action.action, action.primary])).toEqual([
      ["approve", "pr.review", undefined],
      ["request-changes", "pr.review", undefined],
      ["comment", "pr.comment", undefined],
    ]);
    expectDraftWithinContract(draft);
  });

  it("leaves out the messages block when the pull request has no description", async () => {
    const stub = stubGithub(() => ({ status: 200, body: { ...PULL, body: "  " } }));

    const draft = readDraft(await runAgainstStub(buildReviewRequestSignal(event, CONTEXT), stub));

    expect(draft.blocks.map((block) => block.type)).toEqual(["change"]);
  });

  it("cuts a title and a description longer than the contract allows", async () => {
    const stub = stubGithub(() => ({
      status: 200,
      body: { ...PULL, title: "t".repeat(600), body: "b".repeat(20_000) },
    }));

    const draft = readDraft(await runAgainstStub(buildReviewRequestSignal(event, CONTEXT), stub));

    expect(draft.title).toHaveLength(512);
    expect(draft.blocks[1]).toMatchObject({ messages: [{ truncated: true }] });
    expectDraftWithinContract(draft);
  });

  it("fails when GitHub refuses, so the core writes the signal from the event", async () => {
    const stub = stubGithub(() => ({ status: 404, body: { message: "Not Found" } }));

    const result = await runAgainstStub(buildReviewRequestSignal(event, CONTEXT), stub);

    expect(Result.isFailure(result)).toBe(true);
  });
});

/** Builds a comment on the test issue, as GitHub lists it. */
const buildComment = (
  id: number,
  body: string,
  user: object | null = { login: "mona", id: 2 },
) => ({
  id,
  html_url: `https://github.com/${REPO}/issues/1347#issuecomment-${String(id)}`,
  issue_url: `https://api.github.com/repos/${REPO}/issues/1347`,
  user,
  body,
  created_at: `2026-10-11T09:0${String(id % 10)}:00Z`,
  updated_at: `2026-10-11T09:0${String(id % 10)}:00Z`,
});

describe("the mention signal", () => {
  const comments = [
    buildComment(1, "First"),
    buildComment(2, "Second", TEST_ACCOUNT),
    buildComment(3, "Third", null),
    buildComment(4, "Fourth"),
    buildComment(5, "@octocat can you look?"),
    buildComment(6, "After"),
  ];

  it("shows the mention and the three comments before it, and replies on the issue", async () => {
    const stub = stubGithub(() => ({ status: 200, body: comments }));
    const event = buildStoredEvent("github.mentioned", "issue", {
      subject: { title: "Found a bug" },
      commentId: 5,
    });

    const draft = readDraft(await runAgainstStub(buildMentionSignal(event, CONTEXT), stub));

    expect(readStubRequestTarget(stub.requests[0]!)).toEqual({
      path: `/repos/${REPO}/issues/1347/comments`,
      query: { per_page: "100" },
    });
    expect(draft).toMatchObject({ title: "Found a bug", asker: "mona", place: `${REPO}#1347` });
    // The deleted account of the third comment shows as GitHub shows it: ghost.
    expect(draft.blocks).toMatchObject([
      {
        type: "messages",
        omitted: 1,
        messages: [
          { text: "Second" },
          { text: "Third", author: { name: "ghost" } },
          { text: "Fourth" },
          { text: "@octocat can you look?", mentionsYou: true },
        ],
      },
    ]);
    expect(draft.actions).toEqual([
      {
        id: "reply",
        label: "Reply",
        action: "issue.comment",
        input: { repo: REPO, number: 1347 },
        primary: true,
        field: { name: "body", placeholder: "Write a reply" },
      },
    ]);
    expectDraftWithinContract(draft);
  });

  it("replies through pr.comment on a pull request", async () => {
    const stub = stubGithub(() => ({ status: 200, body: comments }));
    const event = buildStoredEvent("github.mentioned", "pr", { subject: {}, commentId: 1 });

    const draft = readDraft(await runAgainstStub(buildMentionSignal(event, CONTEXT), stub));

    expect(draft.title).toBe(event.title);
    expect(draft.blocks[0]).toMatchObject({ omitted: 0, messages: [{ mentionsYou: true }] });
    expect(draft.actions[0]?.action).toBe("pr.comment");
  });

  it("fails when the comment is gone, so the core writes the signal from the event", async () => {
    const stub = stubGithub(() => ({ status: 200, body: comments }));
    const event = buildStoredEvent("github.mentioned", "issue", { subject: {}, commentId: 99 });

    const result = await runAgainstStub(buildMentionSignal(event, CONTEXT), stub);

    expect(Result.isFailure(result) && result.failure.message).toContain("comment 99");
  });
});
