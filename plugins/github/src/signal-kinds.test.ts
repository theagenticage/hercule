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
import {
  buildAssignedSignal,
  buildChangesRequestedSignal,
  buildChecksFailedSignal,
  buildMentionSignal,
  buildReviewRequestSignal,
  cutCheckLog,
} from "./signal-kinds";
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

describe("the assigned signal", () => {
  /** An issue as `GET /repos/{owner}/{repo}/issues/{number}` returns it. */
  const ISSUE = {
    number: 1347,
    title: "Found a bug",
    body: "It crashes on start.",
    html_url: `https://github.com/${REPO}/issues/1347`,
    created_at: "2026-10-10T08:00:00Z",
    user: { login: "mona", id: 2 },
  };

  it("reads the item once and shows its description, with a Reply that is not primary", async () => {
    const stub = stubGithub(() => ({ status: 200, body: ISSUE }));
    const event = buildStoredEvent("github.issue.assigned", "issue", {});

    const draft = readDraft(await runAgainstStub(buildAssignedSignal(event, CONTEXT), stub));

    expect(stub.requests.map((request) => readStubRequestTarget(request).path)).toEqual([
      `/repos/${REPO}/issues/1347`,
    ]);
    expect(draft).toMatchObject({ title: "Found a bug", asker: "mona", place: `${REPO}#1347` });
    expect(draft.blocks).toEqual([
      {
        type: "messages",
        messages: [
          {
            author: { name: "mona" },
            at: "2026-10-10T08:00:00.000Z",
            text: "It crashes on start.",
            url: ISSUE.html_url,
          },
        ],
        omitted: 0,
      },
    ]);
    expect(draft.actions).toEqual([
      {
        id: "reply",
        label: "Reply",
        action: "issue.comment",
        input: { repo: REPO, number: 1347 },
        field: { name: "body", placeholder: "Write a reply" },
      },
    ]);
    expectDraftWithinContract(draft);
  });

  it("replies through pr.comment on a pull request, and has no asker when GitHub named no one", async () => {
    const stub = stubGithub(() => ({ status: 200, body: ISSUE }));
    const event = { ...buildStoredEvent("github.issue.assigned", "pr", {}), author: null };

    const draft = readDraft(await runAgainstStub(buildAssignedSignal(event, CONTEXT), stub));

    expect(draft.actions[0]?.action).toBe("pr.comment");
    expect(draft.asker).toBeUndefined();
  });

  it("leaves out the messages block when the item has no description", async () => {
    const stub = stubGithub(() => ({ status: 200, body: { ...ISSUE, body: null } }));
    const event = buildStoredEvent("github.issue.assigned", "issue", {});

    const draft = readDraft(await runAgainstStub(buildAssignedSignal(event, CONTEXT), stub));

    expect(draft.blocks).toEqual([]);
  });

  it("fails when GitHub refuses, so the core writes the signal from the event", async () => {
    const stub = stubGithub(() => ({ status: 404, body: { message: "Not Found" } }));
    const event = buildStoredEvent("github.issue.assigned", "issue", {});

    const result = await runAgainstStub(buildAssignedSignal(event, CONTEXT), stub);

    expect(Result.isFailure(result)).toBe(true);
  });
});

/** Returns the messages and `omitted` of a draft's first block, which must be a messages block. */
const readMessagesBlock = (
  draft: SignalDraft,
): { messages: ReadonlyArray<{ text: string }>; omitted: number } =>
  draft.blocks[0] as unknown as { messages: ReadonlyArray<{ text: string }>; omitted: number };

describe("the changes-requested signal", () => {
  const REVIEW_PATH = `/repos/${REPO}/pulls/1347/reviews/55`;
  const event = buildStoredEvent("github.pr.review-submitted", "pr", {
    subject: { title: "Amazing new feature" },
    reviewId: 55,
  });

  /** A review as `GET /repos/{owner}/{repo}/pulls/{number}/reviews/{id}` returns it. */
  const REVIEW = {
    id: 55,
    user: { login: "mona", id: 2, avatar_url: "https://avatars.githubusercontent.com/u/2?v=4" },
    body: "This needs a test.",
    html_url: `https://github.com/${REPO}/pull/1347#pullrequestreview-55`,
    submitted_at: "2026-10-11T09:00:00Z",
    state: "CHANGES_REQUESTED",
  };

  /** A review comment as GitHub lists it. */
  const buildReviewComment = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    user: { login: "mona", id: 2 },
    body: `Comment ${String(id)}`,
    html_url: `https://github.com/${REPO}/pull/1347#discussion_r${String(id)}`,
    created_at: "2026-10-11T09:00:01Z",
    path: "src/main.ts",
    line: 10,
    original_line: 8,
    ...extra,
  });

  /** A stub that answers the review with `review` and its comments with `comments`. */
  const stubReview = (review: object, comments: ReadonlyArray<object>) =>
    stubGithub((request) =>
      readStubRequestTarget(request).path === REVIEW_PATH
        ? { status: 200, body: review }
        : { status: 200, body: comments },
    );

  it("shows the review, then its comments with their file and line, and a Reply", async () => {
    const stub = stubReview(REVIEW, [
      buildReviewComment(1),
      // The reviewer's line moved off the diff: GitHub keeps the original line.
      buildReviewComment(2, { line: null, path: "README.md" }),
      buildReviewComment(3, { line: null, original_line: null, path: "docs" }),
    ]);

    const draft = readDraft(
      await runAgainstStub(buildChangesRequestedSignal(event, CONTEXT), stub),
    );

    expect(stub.requests.map((request) => readStubRequestTarget(request))).toEqual([
      { path: REVIEW_PATH, query: {} },
      { path: `${REVIEW_PATH}/comments`, query: { per_page: "100" } },
    ]);
    expect(draft).toMatchObject({
      title: "Amazing new feature",
      asker: "mona",
      place: `${REPO}#1347`,
    });
    expect(draft.blocks).toMatchObject([
      {
        type: "messages",
        omitted: 0,
        messages: [
          {
            author: { name: "mona", avatarUrl: REVIEW.user.avatar_url },
            at: "2026-10-11T09:00:00.000Z",
            text: "This needs a test.",
            url: REVIEW.html_url,
          },
          { text: "Comment 1", location: { path: "src/main.ts", line: 10 } },
          { text: "Comment 2", location: { path: "README.md", line: 8 } },
          { text: "Comment 3", location: { path: "docs" } },
        ],
      },
    ]);
    expect(draft.actions).toEqual([
      {
        id: "reply",
        label: "Reply",
        action: "pr.comment",
        input: { repo: REPO, number: 1347 },
        field: { name: "body", placeholder: "Write a reply" },
      },
    ]);
    expectDraftWithinContract(draft);
  });

  it("shows a review with no body as Requested changes", async () => {
    const stub = stubReview({ ...REVIEW, body: "" }, []);

    const draft = readDraft(
      await runAgainstStub(buildChangesRequestedSignal(event, CONTEXT), stub),
    );

    expect(draft.blocks).toMatchObject([{ omitted: 0, messages: [{ text: "Requested changes" }] }]);
    expectDraftWithinContract(draft);
  });

  it("falls back to the place when the event carries no title", async () => {
    const stub = stubReview(REVIEW, []);
    const untitled = { ...event, payload: { subject: {}, reviewId: 55 } };

    const draft = readDraft(
      await runAgainstStub(buildChangesRequestedSignal(untitled, CONTEXT), stub),
    );

    expect(draft.title).toBe(`${REPO}#1347`);
  });

  it("keeps the review and the newest comments when there are too many, and counts the rest", async () => {
    const stub = stubReview(
      REVIEW,
      Array.from({ length: 30 }, (_, index) => buildReviewComment(index + 1)),
    );

    const draft = readDraft(
      await runAgainstStub(buildChangesRequestedSignal(event, CONTEXT), stub),
    );

    const { messages, omitted } = readMessagesBlock(draft);
    expect(messages).toHaveLength(20);
    expect(messages[0]?.text).toBe("This needs a test.");
    expect(messages[1]?.text).toBe("Comment 12");
    expect(messages[19]?.text).toBe("Comment 30");
    expect(omitted).toBe(11);
    expectDraftWithinContract(draft);
  });

  it("reads the last page of a long review, and counts the comments before it", async () => {
    const api = `https://api.github.com${REVIEW_PATH}/comments`;
    const stub = stubGithub((request) => {
      const { path, query } = readStubRequestTarget(request);
      if (path === REVIEW_PATH) return { status: 200, body: REVIEW };
      if (query["page"] === "3") {
        return {
          status: 200,
          body: Array.from({ length: 50 }, (_, index) => buildReviewComment(201 + index)),
        };
      }
      return {
        status: 200,
        body: Array.from({ length: 100 }, (_, index) => buildReviewComment(index + 1)),
        headers: {
          link: `<${api}?per_page=100&page=2>; rel="next", <${api}?per_page=100&page=3>; rel="last"`,
        },
      };
    });

    const draft = readDraft(
      await runAgainstStub(buildChangesRequestedSignal(event, CONTEXT), stub),
    );

    // The review, the first page of comments, and the last page.
    expect(stub.requests).toHaveLength(3);
    const { messages, omitted } = readMessagesBlock(draft);
    expect(messages.at(-1)?.text).toBe("Comment 250");
    // 250 comments in all, 19 shown.
    expect(omitted).toBe(231);
    expectDraftWithinContract(draft);
  });

  it("fails when the event has no review id", async () => {
    const stub = stubReview(REVIEW, []);
    const withoutReview = { ...event, payload: { subject: {} } };

    const result = await runAgainstStub(buildChangesRequestedSignal(withoutReview, CONTEXT), stub);

    expect(Result.isFailure(result) && result.failure.message).toContain("unexpected payload");
    expect(stub.requests).toHaveLength(0);
  });
});

describe("cutting a check log", () => {
  it("removes ANSI escape codes and trailing blank lines", () => {
    expect(cutCheckLog("\u001b[31mError:\u001b[0m boom\r\nsecond\n\n  \n")).toBe(
      "Error: boom\nsecond",
    );
  });

  it("keeps the last 40 lines", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${String(index + 1)}`);

    const log = cutCheckLog(lines.join("\n"));

    expect(log?.split("\n")).toEqual(lines.slice(-40));
  });

  it("keeps the end of a log that is still over 8 KB", () => {
    const log = cutCheckLog(`start\n${"x".repeat(20_000)}end`);

    expect(log).toHaveLength(8 * 1024);
    expect(log?.endsWith("xend")).toBe(true);
  });

  it("returns nothing when nothing is left", () => {
    expect(cutCheckLog("")).toBeUndefined();
    expect(cutCheckLog("\n  \n\u001b[0m\n")).toBeUndefined();
  });
});

describe("the checks-failed signal", () => {
  const COMMIT_PATH = `/repos/${REPO}/commits/abc123/check-runs`;
  const event = {
    ...buildStoredEvent("github.pr.checks-completed", "pr", {
      subject: { title: "Amazing new feature" },
      headSha: "abc123",
    }),
    author: null,
  };

  /** A check run as the commit's `check-runs` list returns it; a success unless `extra` says otherwise. */
  const buildCheckRun = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${REPO}/runs/${String(id)}`,
    app: { name: "GitHub Actions", slug: "github-actions" },
    output: { title: null, summary: null, text: null, annotations_count: 0 },
    ...extra,
  });

  /** A failed check run that reported `text`. */
  const buildFailedRun = (id: number, name: string, text: string | null = "boom") =>
    buildCheckRun(id, name, {
      conclusion: "failure",
      output: { title: null, summary: null, text, annotations_count: 0 },
    });

  /** A stub that answers the commit's check runs with `runs`. */
  const stubRuns = (runs: ReadonlyArray<object>) =>
    stubGithub(() => ({ status: 200, body: { total_count: runs.length, check_runs: runs } }));

  it("shows failed checks first, then pending ones, and counts the passed ones", async () => {
    const stub = stubGithub((request) => {
      if (readStubRequestTarget(request).path === COMMIT_PATH) {
        return {
          status: 200,
          body: {
            total_count: 6,
            check_runs: [
              buildCheckRun(1, "lint"),
              buildCheckRun(2, "unit", {
                conclusion: "failure",
                output: { title: null, summary: null, text: null, annotations_count: 2 },
              }),
              buildCheckRun(3, "deploy", { status: "in_progress", conclusion: null }),
              buildCheckRun(4, "skipped", { conclusion: "skipped" }),
              buildFailedRun(5, "e2e", "\u001b[31mexpected 1\u001b[0m\nreceived 2\n\n"),
              buildCheckRun(6, "types", { conclusion: "timed_out", html_url: "http://insecure" }),
            ],
          },
        };
      }
      return {
        status: 200,
        body: [
          { path: "src/a.ts", start_line: 4, message: "Expected true" },
          { path: "src/b.ts", start_line: 9, message: "Line one\nLine two" },
        ],
      };
    });

    const draft = readDraft(await runAgainstStub(buildChecksFailedSignal(event, CONTEXT), stub));

    expect(stub.requests.map((request) => readStubRequestTarget(request))).toEqual([
      { path: COMMIT_PATH, query: { filter: "latest", per_page: "100" } },
      { path: `/repos/${REPO}/check-runs/2/annotations`, query: { per_page: "50" } },
    ]);
    expect(draft).toMatchObject({
      title: "Amazing new feature",
      asker: "GitHub Actions",
      place: `${REPO}#1347`,
    });
    expect(draft.blocks).toEqual([
      {
        type: "checks",
        passed: 2,
        omitted: 0,
        rows: [
          {
            name: "unit",
            state: "failed",
            url: `https://github.com/${REPO}/runs/2`,
            log: "src/a.ts:4 Expected true\nsrc/b.ts:9 Line one\nLine two",
          },
          {
            name: "e2e",
            state: "failed",
            url: `https://github.com/${REPO}/runs/5`,
            log: "expected 1\nreceived 2",
          },
          // The link of this run is not https, so the row has none.
          { name: "types", state: "failed" },
          { name: "deploy", state: "pending", url: `https://github.com/${REPO}/runs/3` },
        ],
      },
    ]);
    expect(draft.actions).toEqual([
      {
        id: "rerun",
        label: "Re-run failed checks",
        action: "checks.rerun",
        input: { repo: REPO, number: 1347, sha: "abc123" },
        primary: true,
      },
    ]);
    expectDraftWithinContract(draft);
  });

  it("uses the summary when the check has no text, and no log when it reported nothing", async () => {
    const stub = stubRuns([
      buildCheckRun(1, "lint", {
        conclusion: "failure",
        output: { title: null, summary: "3 problems", text: "", annotations_count: 0 },
      }),
      buildFailedRun(2, "unit", null),
    ]);

    const draft = readDraft(await runAgainstStub(buildChecksFailedSignal(event, CONTEXT), stub));

    const { rows } = draft.blocks[0] as unknown as { rows: ReadonlyArray<object> };
    expect(rows[0]).toMatchObject({ name: "lint", log: "3 problems" });
    expect(rows[1]).toMatchObject({ name: "unit", state: "failed" });
    expect(rows[1]).not.toHaveProperty("log");
    expectDraftWithinContract(draft);
  });

  it("cuts the rows to the limit, counts the rest, and reads the logs of the first five only", async () => {
    const failed = Array.from({ length: 25 }, (_, index) =>
      buildFailedRun(index + 1, `job ${String(index + 1)}`),
    );
    const stub = stubRuns([...failed, buildCheckRun(99, "lint")]);

    const draft = readDraft(await runAgainstStub(buildChecksFailedSignal(event, CONTEXT), stub));

    const block = draft.blocks[0] as unknown as {
      rows: ReadonlyArray<{ name: string; log?: string }>;
      passed: number;
      omitted: number;
    };
    expect(block.rows).toHaveLength(20);
    expect(block.omitted).toBe(5);
    expect(block.passed).toBe(1);
    expect(block.rows.filter((row) => row.log !== undefined).map((row) => row.name)).toEqual([
      "job 1",
      "job 2",
      "job 3",
      "job 4",
      "job 5",
    ]);
    expectDraftWithinContract(draft);
  });

  it("sends at most eight requests: three pages of check runs and five annotations", async () => {
    const api = `https://api.github.com${COMMIT_PATH}`;
    const stub = stubGithub((request) => {
      const { path, query } = readStubRequestTarget(request);
      if (path !== COMMIT_PATH) {
        return { status: 200, body: [{ path: "a.ts", start_line: 1, message: "bad" }] };
      }
      const page = Number(query["page"] ?? "1");
      return {
        status: 200,
        body: {
          total_count: 500,
          check_runs: Array.from({ length: 100 }, (_, index) =>
            page === 1 && index < 7
              ? buildCheckRun(index + 1, `job ${String(index + 1)}`, {
                  conclusion: "failure",
                  output: { title: null, summary: null, text: null, annotations_count: 1 },
                })
              : buildCheckRun(page * 1000 + index, `ok ${String(page)}-${String(index)}`),
          ),
        },
        headers: { link: `<${api}?page=${String(page + 1)}>; rel="next"` },
      };
    });

    const draft = readDraft(await runAgainstStub(buildChecksFailedSignal(event, CONTEXT), stub));

    expect(stub.requests).toHaveLength(8);
    expect(draft.blocks).toMatchObject([{ passed: 293, omitted: 0 }]);
    expectDraftWithinContract(draft);
  });

  it("cuts a long check name, and has no asker when the failed check has no app", async () => {
    const stub = stubRuns([{ ...buildFailedRun(1, "n".repeat(300)), app: null }]);

    const draft = readDraft(await runAgainstStub(buildChecksFailedSignal(event, CONTEXT), stub));

    expect(draft.asker).toBeUndefined();
    expect(draft.blocks[0]).toMatchObject({ rows: [{ name: `${"n".repeat(255)}…` }] });
    expectDraftWithinContract(draft);
  });

  it("fails when GitHub refuses, so the core writes the signal from the event", async () => {
    const stub = stubGithub(() => ({ status: 404, body: { message: "Not Found" } }));

    const result = await runAgainstStub(buildChecksFailedSignal(event, CONTEXT), stub);

    expect(Result.isFailure(result)).toBe(true);
  });
});
