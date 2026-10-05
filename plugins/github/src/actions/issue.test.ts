/**
 * Tests the issue actions: the request each one sends to GitHub, and the
 * output it builds from GitHub's answer. The answers are shaped like the
 * examples in GitHub's REST documentation. How a failure becomes the step's
 * error is tested in `call.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { runAgainstStub, stubAnswer } from "../testing";
import { issueComment, issueRead, issueUpdate } from "./issue";
import { buildActionContext, readJsonBody, readSuccess, TEST_TOKEN } from "./testing";

/** An issue, as GitHub's REST API returns it. */
const GITHUB_ISSUE = {
  id: 1,
  node_id: "MDU6SXNzdWUx",
  url: "https://api.github.com/repos/octocat/hello-world/issues/1347",
  html_url: "https://github.com/octocat/hello-world/issues/1347",
  number: 1347,
  state: "open",
  state_reason: null,
  title: "Found a bug",
  body: "I'm having a problem with this.",
  user: { login: "octocat", id: 1, type: "User" },
  labels: [{ id: 208045946, name: "bug", color: "f29513", default: true }],
  assignee: { login: "hubot", id: 2 },
  assignees: [{ login: "hubot", id: 2 }],
  locked: false,
  comments: 0,
  created_at: "2011-04-22T13:33:48Z",
  updated_at: "2011-04-22T13:33:48Z",
};

/** The output `issue.read` and `issue.update` build from `GITHUB_ISSUE`. */
const ISSUE = {
  number: 1347,
  title: "Found a bug",
  body: "I'm having a problem with this.",
  state: "open",
  stateReason: null,
  labels: ["bug"],
  assignees: ["hubot"],
  author: "octocat",
  url: "https://github.com/octocat/hello-world/issues/1347",
};

describe("issue.read", () => {
  it("reads the issue with the Connection's token and returns its fields", async () => {
    const stub = stubAnswer(200, GITHUB_ISSUE);

    const outcome = await runAgainstStub(
      issueRead.perform({ repo: "octocat/hello-world", number: 1347 }, buildActionContext()),
      stub,
    );

    expect(readSuccess(outcome)).toEqual(ISSUE);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.method).toBe("GET");
    expect(stub.requests[0]?.url).toBe(
      "https://api.github.com/repos/octocat/hello-world/issues/1347",
    );
    expect(stub.requests[0]?.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("returns null for an empty body and no author, as GitHub sends them", async () => {
    const stub = stubAnswer(200, { ...GITHUB_ISSUE, body: null, user: null, assignees: null });

    const outcome = await runAgainstStub(
      issueRead.perform({ repo: "octocat/hello-world", number: 1347 }, buildActionContext()),
      stub,
    );

    expect(readSuccess(outcome)).toEqual({ ...ISSUE, body: null, author: null, assignees: [] });
  });
});

describe("issue.comment", () => {
  it("posts the comment and returns its id and URL", async () => {
    const stub = stubAnswer(201, {
      id: 1,
      node_id: "MDEyOklzc3VlQ29tbWVudDE=",
      url: "https://api.github.com/repos/octocat/hello-world/issues/comments/1",
      html_url: "https://github.com/octocat/hello-world/issues/1347#issuecomment-1",
      body: "Me too",
      user: { login: "octocat", id: 1 },
    });

    const outcome = await runAgainstStub(
      issueComment.perform(
        { repo: "octocat/hello-world", number: 1347, body: "Me too" },
        buildActionContext(),
      ),
      stub,
    );

    expect(readSuccess(outcome)).toEqual({
      id: 1,
      url: "https://github.com/octocat/hello-world/issues/1347#issuecomment-1",
    });
    expect(stub.requests[0]?.method).toBe("POST");
    expect(stub.requests[0]?.url).toBe(
      "https://api.github.com/repos/octocat/hello-world/issues/1347/comments",
    );
    expect(readJsonBody(stub.requests[0])).toEqual({ body: "Me too" });
  });
});

describe("issue.update", () => {
  it("sends only the fields the step sets, in GitHub's names, and returns the issue afterwards", async () => {
    const closed = {
      ...GITHUB_ISSUE,
      state: "closed",
      state_reason: "not_planned",
      labels: [],
      assignees: [],
    };
    const stub = stubAnswer(200, closed);

    const outcome = await runAgainstStub(
      issueUpdate.perform(
        {
          repo: "octocat/hello-world",
          number: 1347,
          state: "closed",
          stateReason: "not_planned",
          labels: [],
        },
        buildActionContext(),
      ),
      stub,
    );

    expect(readSuccess(outcome)).toEqual({
      ...ISSUE,
      state: "closed",
      stateReason: "not_planned",
      labels: [],
      assignees: [],
    });
    expect(stub.requests[0]?.method).toBe("PATCH");
    expect(stub.requests[0]?.url).toBe(
      "https://api.github.com/repos/octocat/hello-world/issues/1347",
    );
    expect(readJsonBody(stub.requests[0])).toEqual({
      state: "closed",
      state_reason: "not_planned",
      labels: [],
    });
  });

  it("refuses an update that changes nothing", () => {
    const decode = Schema.decodeUnknownResult(issueUpdate.input);

    expect(Result.isFailure(decode({ repo: "octocat/hello-world", number: 1 }))).toBe(true);
    expect(Result.isSuccess(decode({ repo: "octocat/hello-world", number: 1, title: "x" }))).toBe(
      true,
    );
  });
});
