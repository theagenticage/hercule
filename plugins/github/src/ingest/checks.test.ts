/**
 * Tests the checks feed against a stub GitHub that serves one repository's
 * open pull requests and the check suites on their head commits. The feed
 * compares GitHub's times with the clock, so the stub's times are set
 * relative to now.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  buildIngestHarness,
  readStubRequestTarget,
  stubGithub,
  type IngestHarness,
  type StubResponse,
} from "../testing";
import type { GithubCheckSuite } from "./feed-objects";
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
  app: { name: app },
});

/** One open pull request in the stub repository. */
interface StubPull {
  number: number;
  title: string;
  sha: string;
  updatedAt: string;
}

/** The stub repository: its open pull requests and the check suites on each commit. */
interface StubRepository {
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
          user: { login: "mona" },
          head: { sha: pull.sha },
          updated_at: pull.updatedAt,
        })),
      };
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
  const stub = stubGithub(answerFrom(repository, repo));
  await Effect.runPromise(
    pollChecks("token", harness.context, [repo], windowDays).pipe(Effect.provide(stub.layer)),
  );
  return stub.requests.map((request) => readStubRequestTarget(request).path);
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

    await poll(harness, repository);

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
    });
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
    const stub = stubGithub(answerFrom(repository));

    await Effect.runPromise(
      pollChecks("token", harness.context, [REPO], 7).pipe(Effect.provide(stub.layer)),
    );

    expect(stub.requests.map((request) => request.headers["if-none-match"])).toEqual([
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
