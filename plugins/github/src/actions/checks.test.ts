/**
 * Tests `checks.rerun`: which check suites it re-runs, the requests it sends
 * for each kind of suite, and when it refuses. The answers are shaped like
 * the examples in GitHub's REST documentation. How a failure becomes the
 * step's error is tested in `call.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import type { AnswerAction, DescribeLinePart } from "@hercule/plugin-host";
import {
  readStubRequestTarget,
  runAgainstStub,
  stubGithub,
  type GithubStub,
  type StubResponse,
} from "../testing";
import { checksRerun } from "./checks";
import { buildActionContext, readSuccess } from "./testing";

const ADDRESS = { repo: "octocat/hello-world", number: 1347 };
const HEAD_SHA = "6dcb09b5b57875f334f61aebed695e2e4193db5e";
const PULL_PATH = "/repos/octocat/hello-world/pulls/1347";
const SUITES_PATH = `/repos/octocat/hello-world/commits/${HEAD_SHA}/check-suites`;
const RUNS_PATH = "/repos/octocat/hello-world/actions/runs";

/** The route that lists the workflow run of check suite `suiteId`. */
const runsOf = (suiteId: number) => `GET ${RUNS_PATH}?check_suite_id=${String(suiteId)}`;

/** A pull request whose branch points at `sha`, as GitHub returns it. */
const buildGithubPullRequest = (sha: string) => ({
  node_id: "MDExOlB1bGxSZXF1ZXN0MQ==",
  html_url: "https://github.com/octocat/hello-world/pull/1347",
  number: 1347,
  state: "open",
  title: "Amazing new feature",
  user: { login: "octocat", id: 1 },
  body: null,
  labels: [],
  head: { ref: "new-topic", sha, repo: { full_name: "octocat/hello-world" } },
  base: { ref: "main" },
  draft: false,
  merged: false,
  mergeable: true,
});

/** A check suite, as GitHub lists it. Without overrides it is a failed GitHub Actions suite. */
const buildSuite = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: 5,
  status: "completed",
  conclusion: "failure",
  updated_at: "2026-10-11T09:00:00Z",
  latest_check_runs_count: 3,
  app: { slug: "github-actions", name: "GitHub Actions" },
  ...overrides,
});

const CIRCLE_SUITE = buildSuite({
  id: 7,
  app: { slug: "circleci-checks", name: "CircleCI Checks" },
});

/**
 * Builds a stub that answers each request by its method and path, written as
 * `GET /repos/...`, followed by `?check_suite_id=<id>` when the request
 * asks for one suite's workflow run. A request the table does not hold gets a
 * 404.
 */
const stubRoutes = (routes: Readonly<Record<string, StubResponse>>): GithubStub =>
  stubGithub((request) => {
    const { path, query } = readStubRequestTarget(request);
    const suite = query["check_suite_id"];
    return (
      routes[
        `${request.method} ${path}${suite === undefined ? "" : `?check_suite_id=${suite}`}`
      ] ?? {
        status: 404,
        body: { message: "Not Found" },
      }
    );
  });

/** Lists the requests a stub received as `METHOD path`, in order. */
const listRequests = (stub: GithubStub): ReadonlyArray<string> =>
  stub.requests.map((request) => `${request.method} ${readStubRequestTarget(request).path}`);

/** The routes of a pull request at the head commit, whose suites are `suites`. */
const buildRoutes = (
  suites: ReadonlyArray<unknown>,
  extra: Readonly<Record<string, StubResponse>> = {},
): Record<string, StubResponse> => ({
  [`GET ${PULL_PATH}`]: { status: 200, body: buildGithubPullRequest(HEAD_SHA) },
  [`GET ${SUITES_PATH}`]: {
    status: 200,
    body: { total_count: suites.length, check_suites: suites },
  },
  ...extra,
});

/** Runs the action and returns the error it failed with. */
const readFailure = async (
  stub: GithubStub,
  input: { repo: string; number: number; sha?: string } = ADDRESS,
) => {
  const outcome = await runAgainstStub(checksRerun.perform(input, buildActionContext()), stub);
  if (!Result.isFailure(outcome)) throw new Error("the action was expected to fail");
  return outcome.failure;
};

describe("checks.rerun", () => {
  it("re-runs only the failed jobs of a GitHub Actions suite, and names it after its workflow", async () => {
    const stub = stubRoutes(
      buildRoutes([buildSuite()], {
        [runsOf(5)]: {
          status: 200,
          body: { workflow_runs: [{ id: 30433642, name: "CI" }] },
        },
        "POST /repos/octocat/hello-world/actions/runs/30433642/rerun-failed-jobs": { status: 201 },
      }),
    );

    const outcome = await runAgainstStub(checksRerun.perform(ADDRESS, buildActionContext()), stub);

    expect(readSuccess(outcome)).toEqual({ sha: HEAD_SHA, rerun: [{ name: "CI" }] });
    expect(listRequests(stub)).toEqual([
      `GET ${PULL_PATH}`,
      `GET ${SUITES_PATH}`,
      `GET ${RUNS_PATH}`,
      "POST /repos/octocat/hello-world/actions/runs/30433642/rerun-failed-jobs",
    ]);
    expect(readStubRequestTarget(stub.requests[2]!).query).toEqual({
      check_suite_id: "5",
      per_page: "1",
    });
  });

  it("names a suite after its app when the workflow run has no name", async () => {
    const stub = stubRoutes(
      buildRoutes([buildSuite()], {
        [runsOf(5)]: { status: 200, body: { workflow_runs: [{ id: 11, name: null }] } },
        "POST /repos/octocat/hello-world/actions/runs/11/rerun-failed-jobs": { status: 201 },
      }),
    );

    const outcome = await runAgainstStub(checksRerun.perform(ADDRESS, buildActionContext()), stub);

    expect(readSuccess(outcome).rerun).toEqual([{ name: "GitHub Actions" }]);
  });

  it("looks up the workflow run of each failed suite by its own id", async () => {
    const stub = stubRoutes(
      buildRoutes([buildSuite({ id: 5 }), buildSuite({ id: 6 })], {
        [runsOf(5)]: { status: 200, body: { workflow_runs: [{ id: 11, name: "CI" }] } },
        [runsOf(6)]: { status: 200, body: { workflow_runs: [{ id: 12, name: "Deploy" }] } },
        "POST /repos/octocat/hello-world/actions/runs/11/rerun-failed-jobs": { status: 201 },
        "POST /repos/octocat/hello-world/actions/runs/12/rerun-failed-jobs": { status: 201 },
      }),
    );

    const outcome = await runAgainstStub(checksRerun.perform(ADDRESS, buildActionContext()), stub);

    expect(readSuccess(outcome).rerun).toEqual([{ name: "CI" }, { name: "Deploy" }]);
  });

  it("asks any other app to run its suite again", async () => {
    const stub = stubRoutes(
      buildRoutes([CIRCLE_SUITE], {
        "POST /repos/octocat/hello-world/check-suites/7/rerequest": { status: 201 },
      }),
    );

    const outcome = await runAgainstStub(checksRerun.perform(ADDRESS, buildActionContext()), stub);

    expect(readSuccess(outcome)).toEqual({ sha: HEAD_SHA, rerun: [{ name: "CircleCI Checks" }] });
    expect(listRequests(stub)).toEqual([
      `GET ${PULL_PATH}`,
      `GET ${SUITES_PATH}`,
      "POST /repos/octocat/hello-world/check-suites/7/rerequest",
    ]);
  });

  it("re-runs a mix of both kinds", async () => {
    const stub = stubRoutes(
      buildRoutes([buildSuite(), CIRCLE_SUITE], {
        [runsOf(5)]: { status: 200, body: { workflow_runs: [{ id: 11, name: "CI" }] } },
        "POST /repos/octocat/hello-world/actions/runs/11/rerun-failed-jobs": { status: 201 },
        "POST /repos/octocat/hello-world/check-suites/7/rerequest": { status: 201 },
      }),
    );

    const outcome = await runAgainstStub(checksRerun.perform(ADDRESS, buildActionContext()), stub);

    expect(readSuccess(outcome).rerun).toEqual([{ name: "CI" }, { name: "CircleCI Checks" }]);
  });

  it("leaves passing, running and empty suites alone", async () => {
    const stub = stubRoutes(
      buildRoutes(
        [
          buildSuite({ id: 1, conclusion: "success" }),
          buildSuite({ id: 2, conclusion: "neutral" }),
          buildSuite({ id: 3, conclusion: "skipped" }),
          buildSuite({ id: 4, status: "in_progress", conclusion: null }),
          buildSuite({ id: 5, latest_check_runs_count: 0 }),
          { ...CIRCLE_SUITE, conclusion: "timed_out" },
        ],
        {
          "POST /repos/octocat/hello-world/check-suites/7/rerequest": { status: 201 },
        },
      ),
    );

    const outcome = await runAgainstStub(checksRerun.perform(ADDRESS, buildActionContext()), stub);

    expect(readSuccess(outcome).rerun).toEqual([{ name: "CircleCI Checks" }]);
    expect(listRequests(stub).filter((request) => request.startsWith("POST"))).toEqual([
      "POST /repos/octocat/hello-world/check-suites/7/rerequest",
    ]);
  });

  it("finds the failed suites on a later page", async () => {
    const stub = stubGithub((request) => {
      const { path, query } = readStubRequestTarget(request);
      if (path === PULL_PATH) return { status: 200, body: buildGithubPullRequest(HEAD_SHA) };
      if (request.method === "POST") return { status: 201 };
      return query["page"] === "2"
        ? { status: 200, body: { total_count: 2, check_suites: [CIRCLE_SUITE] } }
        : {
            status: 200,
            body: { total_count: 2, check_suites: [buildSuite({ id: 1, conclusion: "success" })] },
            headers: {
              link: `<https://api.github.com${SUITES_PATH}?per_page=100&page=2>; rel="next"`,
            },
          };
    });

    const outcome = await runAgainstStub(checksRerun.perform(ADDRESS, buildActionContext()), stub);

    expect(readSuccess(outcome).rerun).toEqual([{ name: "CircleCI Checks" }]);
  });

  it("refuses when no check failed", async () => {
    const stub = stubRoutes(buildRoutes([buildSuite({ conclusion: "success" })]));

    const error = await readFailure(stub);

    expect(error.code).toBe("conflict");
    expect(error.message).toContain("No failed checks are left to re-run");
    expect(error.message).toContain("passed, or they are already running again");
    expect(listRequests(stub)).toEqual([`GET ${PULL_PATH}`, `GET ${SUITES_PATH}`]);
  });

  it("refuses when the pull request has new commits since the given sha", async () => {
    const stub = stubRoutes(buildRoutes([buildSuite()]));

    const error = await readFailure(stub, {
      ...ADDRESS,
      sha: "0000000000000000000000000000000000000001",
    });

    expect(error.code).toBe("conflict");
    expect(error.message).toContain("new commits");
    expect(listRequests(stub)).toEqual([`GET ${PULL_PATH}`]);
  });

  it("re-runs when the given sha is still the head commit", async () => {
    const stub = stubRoutes(
      buildRoutes([CIRCLE_SUITE], {
        "POST /repos/octocat/hello-world/check-suites/7/rerequest": { status: 201 },
      }),
    );

    const outcome = await runAgainstStub(
      checksRerun.perform({ ...ADDRESS, sha: HEAD_SHA }, buildActionContext()),
      stub,
    );

    expect(readSuccess(outcome).sha).toBe(HEAD_SHA);
  });

  it("re-runs nothing when a GitHub Actions suite has no workflow run", async () => {
    const stub = stubRoutes(
      buildRoutes([buildSuite(), CIRCLE_SUITE], {
        [runsOf(5)]: { status: 200, body: { workflow_runs: [] } },
      }),
    );

    const error = await readFailure(stub);

    expect(error.code).toBe("not_found");
    expect(listRequests(stub).filter((request) => request.startsWith("POST"))).toEqual([]);
  });

  it("maps GitHub's refusals to the step's error codes", async () => {
    const forbidden = stubRoutes(
      buildRoutes([CIRCLE_SUITE], {
        "POST /repos/octocat/hello-world/check-suites/7/rerequest": {
          status: 403,
          body: { message: "Resource not accessible by personal access token" },
        },
      }),
    );
    const missing = stubRoutes({});

    expect((await readFailure(forbidden)).code).toBe("forbidden");
    expect((await readFailure(missing)).code).toBe("not_found");
  });

  it("says which suites were already re-run when a later one fails", async () => {
    const stub = stubRoutes(
      buildRoutes([buildSuite(), CIRCLE_SUITE], {
        [runsOf(5)]: { status: 200, body: { workflow_runs: [{ id: 11, name: "CI" }] } },
        "POST /repos/octocat/hello-world/actions/runs/11/rerun-failed-jobs": { status: 201 },
        "POST /repos/octocat/hello-world/check-suites/7/rerequest": {
          status: 422,
          body: { message: "Validation Failed" },
        },
      }),
    );

    const error = await readFailure(stub);

    expect(error.code).toBe("validation");
    expect(error.message).toContain("Could not re-run the checks of CircleCI Checks");
    expect(error.message).toContain("Already re-run, and not undone: CI.");
  });
});

describe("the answer lines of checks.rerun", () => {
  /** Joins a describe line into plain text, with the marked parts in `**`. */
  const joinLine = (parts: ReadonlyArray<DescribeLinePart>): string =>
    parts.map((part) => (part.kind === "marked" ? `**${part.text}**` : part.text)).join("");
  const answer = checksRerun as Pick<AnswerAction, "describe" | "outcome">;

  it("names the pull request", () => {
    const input = { repo: "acme/webshop", number: 1293, sha: HEAD_SHA };

    expect(joinLine(answer.describe(input))).toBe(
      "Re-runs the failed checks on pull request **#1293** in **acme/webshop**",
    );
    expect(answer.outcome?.(input)).toBe("Re-ran the failed checks on #1293");
  });

  it("still describes an input that names no pull request", () => {
    expect(joinLine(answer.describe({}))).toBe(
      "Re-runs the failed checks on a GitHub pull request",
    );
    expect(answer.outcome?.({})).toBe("Re-ran the failed checks on the pull request");
  });
});
