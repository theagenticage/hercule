/**
 * Tests the pull request actions: the requests each one sends to GitHub, in
 * order, and the output it builds from GitHub's answers. The answers are
 * shaped like the examples in GitHub's REST documentation. How a failure
 * becomes the step's error is tested in `call.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { stubAnswer, stubGithub, type StubResponse } from "../testing";
import { prComment, prCreate, prMerge, prRead, prReview, prUpdate } from "./pr";
import {
  buildActionContext,
  readJsonBody,
  readSuccess,
  runAgainstStub,
  TEST_TOKEN,
} from "./testing";

const API = "https://api.github.com";
const PULL_URL = `${API}/repos/octocat/hello-world/pulls/1347`;
const ADDRESS = { repo: "octocat/hello-world", number: 1347 };

/** A pull request, as GitHub's REST API returns it. */
const GITHUB_PULL_REQUEST = {
  url: PULL_URL,
  id: 1,
  node_id: "MDExOlB1bGxSZXF1ZXN0MQ==",
  html_url: "https://github.com/octocat/hello-world/pull/1347",
  number: 1347,
  state: "open",
  locked: false,
  title: "Amazing new feature",
  user: { login: "octocat", id: 1 },
  body: "Please pull these awesome changes in!",
  labels: [{ id: 208045946, name: "bug", color: "f29513" }],
  assignee: { login: "octocat", id: 1 },
  assignees: [{ login: "octocat", id: 1 }],
  requested_reviewers: [{ login: "other_user", id: 3 }],
  requested_teams: [],
  head: {
    label: "octocat:new-topic",
    ref: "new-topic",
    sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
    repo: { full_name: "octocat/hello-world" },
  },
  base: {
    label: "octocat:main",
    ref: "main",
    sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
    repo: { full_name: "octocat/hello-world" },
  },
  draft: false,
  merged: false,
  mergeable: true,
  mergeable_state: "clean",
};

/** The output the pull request actions build from `GITHUB_PULL_REQUEST`. */
const PULL_REQUEST = {
  number: 1347,
  title: "Amazing new feature",
  body: "Please pull these awesome changes in!",
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  labels: ["bug"],
  assignees: ["octocat"],
  requestedReviewers: ["other_user"],
  author: "octocat",
  url: "https://github.com/octocat/hello-world/pull/1347",
  headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
  headRef: "new-topic",
  baseRef: "main",
};

/**
 * Builds a stub that answers each request by its method and URL, written as
 * `GET https://...`. A request the table does not hold gets a 404.
 */
const stubRoutes = (routes: Readonly<Record<string, StubResponse>>) =>
  stubGithub(
    (request) =>
      routes[`${request.method} ${request.url}`] ?? { status: 404, body: { message: "Not Found" } },
  );

/** Lists the requests a stub received as `METHOD url`, in order. */
const listRequests = (stub: ReturnType<typeof stubRoutes>): ReadonlyArray<string> =>
  stub.requests.map((request) => `${request.method} ${request.url}`);

describe("pr.read", () => {
  it("reads the pull request with the Connection's token and returns its fields", async () => {
    const stub = stubAnswer(200, GITHUB_PULL_REQUEST);

    const outcome = await runAgainstStub(prRead.perform(ADDRESS, buildActionContext()), stub);

    expect(readSuccess(outcome)).toEqual(PULL_REQUEST);
    expect(listRequests(stub)).toEqual([`GET ${PULL_URL}`]);
    expect(stub.requests[0]?.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("returns null for mergeable while GitHub is still working it out", async () => {
    const stub = stubAnswer(200, { ...GITHUB_PULL_REQUEST, mergeable: null });

    const outcome = await runAgainstStub(prRead.perform(ADDRESS, buildActionContext()), stub);

    expect(readSuccess(outcome).mergeable).toBeNull();
  });
});

describe("pr.comment", () => {
  it("posts the comment to the pull request's conversation", async () => {
    const stub = stubAnswer(201, {
      id: 7,
      html_url: "https://github.com/octocat/hello-world/pull/1347#issuecomment-7",
      body: "Looks good",
    });

    const outcome = await runAgainstStub(
      prComment.perform({ ...ADDRESS, body: "Looks good" }, buildActionContext()),
      stub,
    );

    expect(readSuccess(outcome)).toEqual({
      id: 7,
      url: "https://github.com/octocat/hello-world/pull/1347#issuecomment-7",
    });
    expect(listRequests(stub)).toEqual([
      `POST ${API}/repos/octocat/hello-world/issues/1347/comments`,
    ]);
    expect(readJsonBody(stub.requests[0])).toEqual({ body: "Looks good" });
  });
});

describe("pr.review", () => {
  it("submits the verdict in GitHub's word and returns it in the plugin's", async () => {
    const stub = stubAnswer(200, {
      id: 80,
      node_id: "MDE3OlB1bGxSZXF1ZXN0UmV2aWV3ODA=",
      user: { login: "octocat", id: 1 },
      body: "Please rename the function.",
      state: "CHANGES_REQUESTED",
      html_url: "https://github.com/octocat/hello-world/pull/1347#pullrequestreview-80",
      commit_id: "ecdd80bb57125d7ba9641ffaa4d7d2c19d3f3091",
    });

    const outcome = await runAgainstStub(
      prReview.perform(
        { ...ADDRESS, event: "request-changes", body: "Please rename the function." },
        buildActionContext(),
      ),
      stub,
    );

    expect(readSuccess(outcome)).toEqual({
      id: 80,
      state: "changes-requested",
      url: "https://github.com/octocat/hello-world/pull/1347#pullrequestreview-80",
    });
    expect(listRequests(stub)).toEqual([`POST ${PULL_URL}/reviews`]);
    expect(readJsonBody(stub.requests[0])).toEqual({
      event: "REQUEST_CHANGES",
      body: "Please rename the function.",
    });
  });

  it("requires a body unless the review approves", () => {
    const decode = Schema.decodeUnknownResult(prReview.input);

    expect(Result.isSuccess(decode({ ...ADDRESS, event: "approve" }))).toBe(true);
    expect(Result.isFailure(decode({ ...ADDRESS, event: "comment" }))).toBe(true);
    expect(Result.isFailure(decode({ ...ADDRESS, event: "request-changes" }))).toBe(true);
    expect(Result.isFailure(decode({ ...ADDRESS, event: "dismiss", body: "x" }))).toBe(true);
  });
});

describe("pr.update", () => {
  it("sends each kind of change to its own endpoint, then returns the pull request afterwards", async () => {
    const stub = stubRoutes({
      [`PATCH ${PULL_URL}`]: { status: 200, body: GITHUB_PULL_REQUEST },
      [`PATCH ${API}/repos/octocat/hello-world/issues/1347`]: { status: 200, body: {} },
      [`POST ${PULL_URL}/requested_reviewers`]: { status: 201, body: GITHUB_PULL_REQUEST },
      [`GET ${PULL_URL}`]: {
        status: 200,
        body: { ...GITHUB_PULL_REQUEST, title: "Better title", labels: [{ name: "ready" }] },
      },
    });

    const outcome = await runAgainstStub(
      prUpdate.perform(
        {
          ...ADDRESS,
          title: "Better title",
          base: "develop",
          labels: ["ready"],
          reviewers: ["hubot"],
        },
        buildActionContext(),
      ),
      stub,
    );

    expect(readSuccess(outcome)).toEqual({
      ...PULL_REQUEST,
      title: "Better title",
      labels: ["ready"],
    });
    expect(listRequests(stub)).toEqual([
      `PATCH ${PULL_URL}`,
      `PATCH ${API}/repos/octocat/hello-world/issues/1347`,
      `POST ${PULL_URL}/requested_reviewers`,
      `GET ${PULL_URL}`,
    ]);
    expect(readJsonBody(stub.requests[0])).toEqual({ title: "Better title", base: "develop" });
    expect(readJsonBody(stub.requests[1])).toEqual({ labels: ["ready"] });
    expect(readJsonBody(stub.requests[2])).toEqual({ reviewers: ["hubot"] });
  });

  it("marks a draft ready for review through GitHub's GraphQL API", async () => {
    let draft = true;
    const stub = stubGithub((request) => {
      if (request.url === `${API}/graphql`) {
        draft = false;
        return {
          status: 200,
          body: {
            data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_1" } } },
          },
        };
      }
      return { status: 200, body: { ...GITHUB_PULL_REQUEST, draft } };
    });

    const outcome = await runAgainstStub(
      prUpdate.perform({ ...ADDRESS, draft: false }, buildActionContext()),
      stub,
    );

    expect(readSuccess(outcome).draft).toBe(false);
    expect(listRequests(stub)).toEqual([
      `GET ${PULL_URL}`,
      `POST ${API}/graphql`,
      `GET ${PULL_URL}`,
    ]);
    const graphql = readJsonBody(stub.requests[1]) as {
      readonly query: string;
      readonly variables: unknown;
    };
    expect(graphql.query).toContain("markPullRequestReadyForReview");
    expect(graphql.variables).toEqual({ id: "MDExOlB1bGxSZXF1ZXN0MQ==" });
    expect(stub.requests[1]?.headers["authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("sends no GraphQL request when the pull request is already in the asked draft state", async () => {
    const stub = stubAnswer(200, GITHUB_PULL_REQUEST);

    const outcome = await runAgainstStub(
      prUpdate.perform({ ...ADDRESS, draft: false }, buildActionContext()),
      stub,
    );

    expect(Result.isSuccess(outcome)).toBe(true);
    expect(listRequests(stub)).toEqual([`GET ${PULL_URL}`, `GET ${PULL_URL}`]);
  });

  it("fails with GitHub's GraphQL error when the draft state cannot change", async () => {
    const stub = stubRoutes({
      [`GET ${PULL_URL}`]: { status: 200, body: GITHUB_PULL_REQUEST },
      [`POST ${API}/graphql`]: {
        status: 200,
        body: {
          data: { convertPullRequestToDraft: null },
          errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
        },
      },
    });

    const outcome = await runAgainstStub(
      prUpdate.perform({ ...ADDRESS, draft: true }, buildActionContext()),
      stub,
    );

    if (!Result.isFailure(outcome)) throw new Error("the action was expected to fail");
    expect(outcome.failure.code).toBe("forbidden");
    expect(outcome.failure.message).toContain("Resource not accessible by integration");
  });

  it("refuses an update that changes nothing, and an empty list of reviewers", () => {
    const decode = Schema.decodeUnknownResult(prUpdate.input);

    expect(Result.isFailure(decode(ADDRESS))).toBe(true);
    expect(Result.isFailure(decode({ ...ADDRESS, reviewers: [] }))).toBe(true);
    expect(Result.isSuccess(decode({ ...ADDRESS, draft: true }))).toBe(true);
  });
});

describe("pr.merge", () => {
  const MERGED = {
    sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
    merged: true,
    message: "Pull Request successfully merged",
  };

  it("merges with the method, commit text and sha the step gives", async () => {
    const stub = stubAnswer(200, MERGED);

    const outcome = await runAgainstStub(
      prMerge.perform(
        {
          ...ADDRESS,
          method: "squash",
          commitTitle: "Add the feature (#1347)",
          sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
        },
        buildActionContext(),
      ),
      stub,
    );

    expect(readSuccess(outcome)).toEqual({ ...MERGED, branchDeleted: false });
    expect(listRequests(stub)).toEqual([`PUT ${PULL_URL}/merge`]);
    expect(readJsonBody(stub.requests[0])).toEqual({
      merge_method: "squash",
      commit_title: "Add the feature (#1347)",
      sha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
    });
  });

  it("deletes the branch after the merge when deleteBranch is true", async () => {
    const stub = stubRoutes({
      [`GET ${PULL_URL}`]: {
        status: 200,
        body: { ...GITHUB_PULL_REQUEST, head: { ...GITHUB_PULL_REQUEST.head, ref: "feature/x" } },
      },
      [`PUT ${PULL_URL}/merge`]: { status: 200, body: MERGED },
      [`DELETE ${API}/repos/octocat/hello-world/git/refs/heads/feature/x`]: { status: 204 },
    });

    const outcome = await runAgainstStub(
      prMerge.perform({ ...ADDRESS, deleteBranch: true }, buildActionContext()),
      stub,
    );

    expect(readSuccess(outcome)).toEqual({ ...MERGED, branchDeleted: true });
    expect(listRequests(stub)).toEqual([
      `GET ${PULL_URL}`,
      `PUT ${PULL_URL}/merge`,
      `DELETE ${API}/repos/octocat/hello-world/git/refs/heads/feature/x`,
    ]);
  });

  it("succeeds when the branch was already deleted by the repository", async () => {
    const stub = stubRoutes({
      [`GET ${PULL_URL}`]: { status: 200, body: GITHUB_PULL_REQUEST },
      [`PUT ${PULL_URL}/merge`]: { status: 200, body: MERGED },
      [`DELETE ${API}/repos/octocat/hello-world/git/refs/heads/new-topic`]: {
        status: 422,
        body: { message: "Reference does not exist" },
      },
    });

    const outcome = await runAgainstStub(
      prMerge.perform({ ...ADDRESS, deleteBranch: true }, buildActionContext()),
      stub,
    );

    expect(readSuccess(outcome)).toEqual({ ...MERGED, branchDeleted: true });
  });

  it("says the merge happened when the branch could not be deleted", async () => {
    const stub = stubRoutes({
      [`GET ${PULL_URL}`]: { status: 200, body: GITHUB_PULL_REQUEST },
      [`PUT ${PULL_URL}/merge`]: { status: 200, body: MERGED },
      [`DELETE ${API}/repos/octocat/hello-world/git/refs/heads/new-topic`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });

    const outcome = await runAgainstStub(
      prMerge.perform({ ...ADDRESS, deleteBranch: true }, buildActionContext()),
      stub,
    );

    if (!Result.isFailure(outcome)) throw new Error("the action was expected to fail");
    expect(outcome.failure.code).toBe("forbidden");
    expect(outcome.failure.message).toContain(`was merged as ${MERGED.sha}`);
  });

  it("refuses before merging when the branch to delete is in a fork that is gone", async () => {
    const stub = stubAnswer(200, {
      ...GITHUB_PULL_REQUEST,
      head: { ...GITHUB_PULL_REQUEST.head, repo: null },
    });

    const outcome = await runAgainstStub(
      prMerge.perform({ ...ADDRESS, deleteBranch: true }, buildActionContext()),
      stub,
    );

    if (!Result.isFailure(outcome)) throw new Error("the action was expected to fail");
    expect(outcome.failure.code).toBe("conflict");
    expect(listRequests(stub)).toEqual([`GET ${PULL_URL}`]);
  });

  it("reports a pull request that cannot be merged as conflict", async () => {
    const stub = stubAnswer(405, { message: "Pull Request is not mergeable" });

    const outcome = await runAgainstStub(prMerge.perform(ADDRESS, buildActionContext()), stub);

    if (!Result.isFailure(outcome)) throw new Error("the action was expected to fail");
    expect(outcome.failure.code).toBe("conflict");
    expect(outcome.failure.message).toContain("Pull Request is not mergeable");
  });
});

describe("pr.create", () => {
  it("opens the pull request from the pushed branch and returns it", async () => {
    const stub = stubAnswer(201, { ...GITHUB_PULL_REQUEST, draft: true });

    const outcome = await runAgainstStub(
      prCreate.perform(
        {
          repo: "octocat/hello-world",
          head: "new-topic",
          base: "main",
          title: "Amazing new feature",
          body: "Please pull these awesome changes in!",
          draft: true,
        },
        buildActionContext(),
      ),
      stub,
    );

    expect(readSuccess(outcome)).toEqual({ ...PULL_REQUEST, draft: true });
    expect(listRequests(stub)).toEqual([`POST ${API}/repos/octocat/hello-world/pulls`]);
    expect(readJsonBody(stub.requests[0])).toEqual({
      title: "Amazing new feature",
      head: "new-topic",
      base: "main",
      body: "Please pull these awesome changes in!",
      draft: true,
    });
  });
});
