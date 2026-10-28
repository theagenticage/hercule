/**
 * Tests the checks feed against a stub GitHub that serves one repository's
 * open pull requests and the check suites on their head commits. The feed
 * compares GitHub's times with the clock, so the stub's times are set
 * relative to now.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import {
  buildIngestHarness,
  readStubRequestTarget,
  stubGithub,
  type IngestHarness,
  type StubResponse,
  TEST_IDENTITY,
  answerUserRequests,
  isUserRequest,
} from "../testing";
import type { GithubCheckSuite } from "../github-objects";
import { pollChecks, rollUpConclusion } from "./checks";

const REPO = "octocat/hello-world";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The id of each app's check suite. Running a check again keeps its suite, and so its id. */
const SUITE_IDS: Readonly<Record<string, number>> = {
  "GitHub Actions": 1,
  Codecov: 2,
  Dependabot: 3,
};

/** Returns the ISO 8601 time `offsetMs` from now. */
const fromNow = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

/** Builds a check suite of `app` with this status and conclusion. */
const buildSuite = (
  app: string,
  status: string,
  conclusion: string | null,
  updatedAt = fromNow(60_000),
  runs = 1,
): GithubCheckSuite => ({
  id: SUITE_IDS[app] ?? 99,
  status,
  conclusion,
  updated_at: updatedAt,
  latest_check_runs_count: runs,
  app: { name: app, slug: app.toLowerCase().replaceAll(" ", "-") },
});

/** One open pull request in the stub repository. */
interface StubPull {
  number: number;
  title: string;
  sha: string;
  updatedAt: string;
  /** The login of the pull request's author; "mona" when absent. */
  author?: string;
}

/** Builds a check run named `name` in the shape `GET .../check-runs` lists it. */
const buildCheckRun = (name: string, conclusion: string | null, id = 1) => ({
  id,
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  html_url: null,
  app: { name: "GitHub Actions", slug: "github-actions" },
  output: { title: null, summary: null, text: null, annotations_count: 0 },
});

/** The stub repository: its open pull requests and the check suites on each commit. */
interface StubRepository {
  /** The latest check runs of each commit, as `GET .../check-runs?filter=latest` lists them. */
  checkRuns: Record<string, Array<ReturnType<typeof buildCheckRun>>>;
  /** When set, the check-runs request fails with this status. */
  checkRunsFailure?: number;
  /** The open pull requests, most recently updated first, as GitHub sorts them. */
  pulls: Array<StubPull>;
  /** How many pull requests one page of the listing holds; GitHub's is 100. */
  pullsPerPage: number;
  suites: Record<string, Array<GithubCheckSuite>>;
  /** How many check suites one page holds; GitHub's is 100. */
  suitesPerPage: number;
  /** The ETag of the pull request listing; a test changes it whenever it changes the pull requests. */
  pullsEtag: string;
}

/**
 * Answers a request the way GitHub would for `repository`, named `repo`.
 * Each page of a commit's suites is tagged by its own content, as GitHub
 * tags each page, so a change on a later page leaves the first page's tag
 * the same.
 */
const answerFrom =
  (repository: StubRepository, repo: string = REPO) =>
  (request: HttpClientRequest.HttpClientRequest): StubResponse => {
    const { path, query } = readStubRequestTarget(request);
    if (path === `/repos/${repo}/pulls`) {
      if (request.headers["if-none-match"] === repository.pullsEtag) return { status: 304 };
      const page = Number(query["page"] ?? "1");
      const size = repository.pullsPerPage;
      const next = `https://api.github.com${path}?page=${String(page + 1)}`;
      return {
        status: 200,
        headers: {
          etag: repository.pullsEtag,
          ...(repository.pulls.length > page * size ? { link: `<${next}>; rel="next"` } : {}),
        },
        body: repository.pulls.slice((page - 1) * size, page * size).map((pull) => ({
          number: pull.number,
          title: pull.title,
          state: "open",
          user: { login: pull.author ?? "mona" },
          head: { sha: pull.sha },
          updated_at: pull.updatedAt,
        })),
      };
    }
    const runs = /\/commits\/([^/]+)\/check-runs$/.exec(path);
    if (runs) {
      if (repository.checkRunsFailure !== undefined) {
        return { status: repository.checkRunsFailure, body: { message: "Server Error" } };
      }
      const listed = repository.checkRuns[runs[1]!] ?? [];
      return { status: 200, body: { total_count: listed.length, check_runs: listed } };
    }
    const commit = /\/commits\/([^/]+)\/check-suites$/.exec(path);
    if (commit) {
      const suites = repository.suites[commit[1]!] ?? [];
      const page = Number(query["page"] ?? "1");
      const size = repository.suitesPerPage;
      const body = {
        total_count: suites.length,
        check_suites: suites.slice((page - 1) * size, page * size),
      };
      const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("hex")}"`;
      if (request.headers["if-none-match"] === etag) return { status: 304 };
      const next = `https://api.github.com${path}?page=${String(page + 1)}`;
      return {
        status: 200,
        headers: {
          etag,
          ...(suites.length > page * size ? { link: `<${next}>; rel="next"` } : {}),
        },
        body,
      };
    }
    return { status: 404, body: { message: "Not Found" } };
  };

/** Returns a repository with one pull request, updated an hour ago, whose checks are still running. */
const buildRepository = (): StubRepository => ({
  pulls: [{ number: 7, title: "Add a feature", sha: "sha-a", updatedAt: fromNow(-3_600_000) }],
  pullsPerPage: 100,
  suites: { "sha-a": [buildSuite("GitHub Actions", "in_progress", null)] },
  checkRuns: {},
  suitesPerPage: 100,
  pullsEtag: '"p1"',
});

/** Polls the feed once, against `repository`, and returns the paths of the requests sent. */
const poll = async (
  harness: IngestHarness,
  repository: StubRepository,
  windowDays = 7,
  repo = REPO,
) => {
  const stub = stubGithub(answerUserRequests(answerFrom(repository, repo)));
  await Effect.runPromise(
    pollChecks("token", harness.context, [repo], windowDays, TEST_IDENTITY).pipe(
      Effect.provide(stub.layer),
    ),
  );
  return stub.requests
    .filter((request) => !isUserRequest(request))
    .map((request) => readStubRequestTarget(request).path);
};

/** Returns a harness whose feed has baselined the repository. */
const baseline = async (repository: StubRepository, repo = REPO): Promise<IngestHarness> => {
  const harness = buildIngestHarness();
  await poll(harness, repository, 7, repo);
  return harness;
};

/** Returns the conclusion of each recorded event, in order. */
const listConclusions = (harness: IngestHarness) =>
  harness.events.map((event) => (event.payload as { conclusion: string }).conclusion);

describe("the checks feed", () => {
  it("sends no request and emits nothing on a repository's first poll", async () => {
    const harness = buildIngestHarness();

    const requests = await poll(harness, buildRepository());

    expect(requests).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.state.get(`checks/${REPO}`)).toMatchObject({ pullRequests: [], heads: {} });
  });

  it("emits one rolled-up event when every suite on the head commit has completed", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    await poll(harness, repository);
    expect(harness.events).toEqual([]);
    repository.suites["sha-a"] = [
      buildSuite("GitHub Actions", "completed", "success"),
      buildSuite("Codecov", "completed", "neutral"),
      // An app that never ran on this commit: it stays queued and does not count.
      buildSuite("Dependabot", "queued", null, fromNow(0), 0),
    ];

    const requests = await poll(harness, repository);

    expect(harness.events).toHaveLength(1);
    const event = harness.events[0]!;
    expect(event.kind).toBe("github.pr.checks-completed");
    expect(event.dedupKey).toMatch(
      /^pr\.checks-completed:octocat\/hello-world#7:sha-a:[0-9a-f]{8}$/,
    );
    expect(event.refs).toEqual([`github:pr:${REPO}#7`, `github:repo:${REPO}`]);
    expect(event.url).toBe(`https://github.com/${REPO}/pull/7`);
    expect(event.payload).toEqual({
      subject: {
        repo: REPO,
        number: 7,
        title: "Add a feature",
        author: "mona",
        state: "open",
        url: `https://github.com/${REPO}/pull/7`,
      },
      conclusion: "success",
      suites: [
        { name: "GitHub Actions", conclusion: "success" },
        { name: "Codecov", conclusion: "neutral" },
      ],
      headSha: "sha-a",
      failedChecks: [],
      onYourPullRequest: false,
    });
    // A passing verdict needs no check-run names, so none are requested.
    expect(requests.some((path) => path.endsWith("/check-runs"))).toBe(false);
  });

  it("emits one event, within the host's size limits, when a commit has 100 large check suites", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    // GitHub sends each suite with its repository nested in it, about 9 KB as JSON.
    const repositoryFacts = {
      description: "y".repeat(1500),
      urls: Array.from(
        { length: 150 },
        (_, index) => `https://api.github.com/repos/${REPO}/${String(index)}`,
      ),
    };
    repository.suites["sha-a"] = Array.from(
      { length: 100 },
      (_, index) =>
        ({
          ...buildSuite("GitHub Actions", "completed", "success"),
          id: index + 1,
          repository: repositoryFacts,
        }) as GithubCheckSuite,
    );

    // The harness fails an emit over the host's limit, as the host does, and
    // that fails the poll.
    await poll(harness, repository);

    expect(harness.events).toHaveLength(1);
  });

  it("names the failed check runs, sorted and without duplicates, on a failure verdict", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "failure")];
    repository.checkRuns["sha-a"] = [
      buildCheckRun("test", "failure", 1),
      buildCheckRun("build", "success", 2),
      buildCheckRun("lint", "timed_out", 3),
      buildCheckRun("deploy", null, 4),
      buildCheckRun("test", "failure", 5),
      buildCheckRun("docs", "skipped", 6),
      buildCheckRun("e2e", "neutral", 7),
    ];
    const stub = stubGithub(answerUserRequests(answerFrom(repository)));

    await Effect.runPromise(
      pollChecks("token", harness.context, [REPO], 7, TEST_IDENTITY).pipe(
        Effect.provide(stub.layer),
      ),
    );

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]!.payload).toMatchObject({
      conclusion: "failure",
      headSha: "sha-a",
      failedChecks: ["lint", "test"],
    });
    const runRequests = stub.requests
      .map(readStubRequestTarget)
      .filter((target) => target.path.endsWith("/check-runs"));
    expect(runRequests).toEqual([
      {
        path: `/repos/${REPO}/commits/sha-a/check-runs`,
        query: { filter: "latest", per_page: "100" },
      },
    ]);
  });

  it("sets onYourPullRequest when the user wrote the pull request", async () => {
    const repository = buildRepository();
    repository.pulls[0] = { ...repository.pulls[0]!, author: TEST_IDENTITY.login };
    const harness = await baseline(repository);
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "success")];

    await poll(harness, repository);

    expect(harness.events[0]!.payload).toMatchObject({ onYourPullRequest: true });
  });

  it("knows a pull request is the user's from state stored before onYourPullRequest, on a 304 listing", async () => {
    const repository = buildRepository();
    repository.pulls[0] = { ...repository.pulls[0]!, author: TEST_IDENTITY.login };
    const harness = await baseline(repository);
    await poll(harness, repository);
    // The state an older version stored: the same snapshot, without the field.
    const stored = harness.state.get(`checks/${REPO}`) as {
      pullRequests: Array<Record<string, unknown>>;
    };
    for (const snapshot of stored.pullRequests) delete snapshot["onYourPullRequest"];
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "failure")];
    repository.checkRuns["sha-a"] = [buildCheckRun("test", "failure")];

    // The pull request listing is unchanged, so GitHub answers 304.
    await poll(harness, repository);

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]!.payload).toMatchObject({ onYourPullRequest: true });
  });

  it("sets onYourPullRequest on the user's own pull request outside the watch list", async () => {
    const other = "other/repo";
    const repository = buildRepository();
    const route = (request: HttpClientRequest.HttpClientRequest): StubResponse => {
      const { path } = readStubRequestTarget(request);
      if (path === "/search/issues") {
        return {
          status: 200,
          body: {
            total_count: 1,
            items: [
              {
                number: 7,
                title: "Add a feature",
                repository_url: `https://api.github.com/repos/${other}`,
                updated_at: fromNow(-3_600_000),
              },
            ],
          },
        };
      }
      if (path === `/repos/${other}/pulls/7`) {
        const { pulls } = repository;
        return {
          status: 200,
          body: {
            number: 7,
            title: "Add a feature",
            state: "open",
            user: { login: TEST_IDENTITY.login },
            head: { sha: pulls[0]!.sha },
            updated_at: pulls[0]!.updatedAt,
          },
        };
      }
      return answerFrom(repository, other)(request);
    };
    const harness = buildIngestHarness();
    const pollOwn = async () => {
      const stub = stubGithub(route);
      await Effect.runPromise(
        pollChecks("token", harness.context, [], 7, TEST_IDENTITY).pipe(Effect.provide(stub.layer)),
      );
    };
    await pollOwn();
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "success")];

    await pollOwn();

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]!.payload).toMatchObject({ onYourPullRequest: true });
  });

  it("checks nothing on an own pull request the search lists as open that GitHub says is closed", async () => {
    const other = "other/repo";
    const repository = buildRepository();
    const route = (request: HttpClientRequest.HttpClientRequest): StubResponse => {
      const { path } = readStubRequestTarget(request);
      if (path === "/search/issues") {
        return {
          status: 200,
          body: {
            total_count: 1,
            items: [
              {
                number: 7,
                title: "Add a feature",
                repository_url: `https://api.github.com/repos/${other}`,
                updated_at: fromNow(-3_600_000),
              },
            ],
          },
        };
      }
      if (path === `/repos/${other}/pulls/7`) {
        const { pulls } = repository;
        return {
          status: 200,
          body: {
            number: 7,
            title: "Add a feature",
            state: "closed",
            user: { login: TEST_IDENTITY.login },
            head: { sha: pulls[0]!.sha },
            updated_at: pulls[0]!.updatedAt,
          },
        };
      }
      return answerFrom(repository, other)(request);
    };
    const harness = buildIngestHarness();
    const pollOwn = async () => {
      const stub = stubGithub(route);
      await Effect.runPromise(
        pollChecks("token", harness.context, [], 7, TEST_IDENTITY).pipe(Effect.provide(stub.layer)),
      );
    };
    await pollOwn();
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "success")];

    await pollOwn();

    expect(harness.events).toEqual([]);
  });

  it("emits nothing when the check runs cannot be read, and tries again at the next poll", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "failure")];
    repository.checkRuns["sha-a"] = [buildCheckRun("test", "failure")];
    repository.checkRunsFailure = 500;

    await poll(harness, repository).catch(() => undefined);

    expect(harness.events).toEqual([]);

    delete repository.checkRunsFailure;
    await poll(harness, repository);

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]!.payload).toMatchObject({ failedChecks: ["test"] });
  });

  it("emits once per verdict and head commit, asking again with the commit's ETag", async () => {
    const repository = buildRepository();
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "failure")];
    const harness = await baseline(repository);
    await poll(harness, repository);
    expect(harness.events).toHaveLength(1);

    const quiet = await poll(harness, repository);

    expect(quiet).toEqual([`/repos/${REPO}/pulls`, `/repos/${REPO}/commits/sha-a/check-suites`]);
    expect(harness.events).toHaveLength(1);

    repository.pulls[0] = { ...repository.pulls[0]!, sha: "sha-b", updatedAt: fromNow(0) };
    repository.suites["sha-b"] = [buildSuite("GitHub Actions", "completed", "success")];
    repository.pullsEtag = '"p2"';
    await poll(harness, repository);

    expect(harness.events.map((event) => event.dedupKey.split(":").at(-2))).toEqual([
      "sha-a",
      "sha-b",
    ]);
  });

  it("emits again when a check run again turns a failure into a success", async () => {
    const repository = buildRepository();
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "failure")];
    const harness = await baseline(repository);
    await poll(harness, repository);
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "in_progress", null)];
    await poll(harness, repository);
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "success")];

    await poll(harness, repository);

    expect(listConclusions(harness)).toEqual(["failure", "success"]);
    const [first, second] = harness.events;
    expect(second!.dedupKey).not.toBe(first!.dedupKey);
  });

  it("emits nothing more when a check run again fails again", async () => {
    const repository = buildRepository();
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "failure")];
    const harness = await baseline(repository);
    await poll(harness, repository);
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "in_progress", null)];
    await poll(harness, repository);
    repository.suites["sha-a"] = [
      buildSuite("GitHub Actions", "completed", "failure", fromNow(120_000)),
    ];

    await poll(harness, repository);

    expect(listConclusions(harness)).toEqual(["failure"]);
  });

  it("sends the stored ETags, and reuses the pull requests on a 304", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    await poll(harness, repository);
    const stub = stubGithub(answerUserRequests(answerFrom(repository)));

    await Effect.runPromise(
      pollChecks("token", harness.context, [REPO], 7, TEST_IDENTITY).pipe(
        Effect.provide(stub.layer),
      ),
    );

    const repositoryRequests = stub.requests.filter((request) => !isUserRequest(request));
    expect(repositoryRequests.map((request) => request.headers["if-none-match"])).toEqual([
      '"p1"',
      expect.stringMatching(/^"/),
    ]);
    expect(harness.events).toEqual([]);
  });

  it("records checks that completed before the repository was watched, without an event", async () => {
    const repository = buildRepository();
    repository.suites["sha-a"] = [
      buildSuite("GitHub Actions", "completed", "success", fromNow(-600_000)),
    ];
    const harness = await baseline(repository);

    await poll(harness, repository);
    await poll(harness, repository);

    expect(harness.events).toEqual([]);
    const state = harness.state.get(`checks/${REPO}`) as {
      heads: Record<string, { verdict?: string }>;
    };
    expect(state.heads["sha-a"]?.verdict).toMatch(/^[0-9a-f]{8}$/);
  });

  it("asks nothing about a pull request not updated within the window", async () => {
    const repository = buildRepository();
    repository.pulls[0] = { ...repository.pulls[0]!, updatedAt: fromNow(-3 * DAY_MS) };
    const harness = await baseline(repository);

    const requests = await poll(harness, repository, 2);

    expect(requests).toEqual([`/repos/${REPO}/pulls`]);
    expect(harness.state.get(`checks/${REPO}`)).toMatchObject({ pullRequests: [] });
  });

  it("reads every page of open pull requests", async () => {
    const repository = buildRepository();
    repository.pulls.push({
      number: 8,
      title: "Fix a bug",
      sha: "sha-c",
      updatedAt: fromNow(-7_200_000),
    });
    repository.pullsPerPage = 1;
    repository.suites["sha-c"] = [buildSuite("GitHub Actions", "completed", "success")];
    const harness = await baseline(repository);

    const requests = await poll(harness, repository);

    expect(requests).toContain(`/repos/${REPO}/commits/sha-c/check-suites`);
    expect(listConclusions(harness)).toEqual(["success"]);
  });

  it("waits for a suite on a later page, and reports once it finishes", async () => {
    const finished = Array.from({ length: 100 }, (_, index) => ({
      ...buildSuite(`App ${String(index)}`, "completed", "success"),
      id: 1000 + index,
    }));
    const running = { ...buildSuite("Late app", "in_progress", null), id: 2000 };
    const repository = buildRepository();
    repository.suites["sha-a"] = [...finished, running];
    const harness = await baseline(repository);

    const requests = await poll(harness, repository);

    expect(requests.filter((path) => path.endsWith("/check-suites"))).toHaveLength(2);
    expect(harness.events).toEqual([]);

    // The first page stays the same, and so does its ETag.
    repository.suites["sha-a"] = [
      ...finished,
      { ...running, status: "completed", conclusion: "success" },
    ];
    await poll(harness, repository);

    expect(harness.events).toHaveLength(1);
    const payload = harness.events[0]!.payload as { suites: Array<{ name: string }> };
    expect(payload.suites).toHaveLength(101);
    expect(payload.suites.at(-1)).toEqual({ name: "Late app", conclusion: "success" });
  });

  it("reports nothing for a commit with more pages of suites than it reads", async () => {
    const repository = buildRepository();
    repository.suitesPerPage = 1;
    repository.suites["sha-a"] = Array.from({ length: 4 }, (_, index) => ({
      ...buildSuite(`App ${String(index)}`, "completed", "success"),
      id: 1000 + index,
    }));
    const harness = await baseline(repository);

    const requests = await poll(harness, repository);

    expect(requests.filter((path) => path.endsWith("/check-suites"))).toHaveLength(3);
    expect(harness.events).toEqual([]);
    expect(harness.state.get(`checks/${REPO}`)).toMatchObject({ heads: { "sha-a": {} } });
  });

  it("keeps the dedup key within the host's limit, for the longest names GitHub allows", async () => {
    // GitHub allows 39 characters for an owner and 100 for a repository.
    const repo = `${"o".repeat(39)}/${"r".repeat(100)}`;
    const sha = "a".repeat(40);
    const repository = buildRepository();
    repository.pulls[0] = { ...repository.pulls[0]!, number: 99999999, sha };
    repository.suites[sha] = [buildSuite("GitHub Actions", "completed", "success")];
    const harness = await baseline(repository, repo);

    // The harness refuses a key longer than 200 characters, as the host does.
    await poll(harness, repository, 7, repo);

    expect(harness.events).toHaveLength(1);
  });
});

describe("rollUpConclusion", () => {
  const conclude = (...conclusions: Array<string | null>) =>
    rollUpConclusion(conclusions.map((conclusion) => buildSuite("app", "completed", conclusion)));

  it("is success when one suite succeeded and the rest were neutral or skipped", () => {
    expect(conclude("success", "neutral", "skipped")).toBe("success");
  });

  it("is failure when any suite concluded anything else", () => {
    expect(conclude("success", "failure")).toBe("failure");
    expect(conclude("success", "timed_out")).toBe("failure");
    expect(conclude("cancelled")).toBe("failure");
    expect(conclude("action_required")).toBe("failure");
  });

  it("is neutral when every suite was neutral or skipped", () => {
    expect(conclude("neutral", "skipped")).toBe("neutral");
  });
});
