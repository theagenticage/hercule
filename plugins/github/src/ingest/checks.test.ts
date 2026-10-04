/**
 * Tests the checks feed against a stub GitHub that serves one repository's
 * open pull requests and the check suites on their head commits. The feed
 * compares GitHub's times with the clock, so the stub's times are set
 * relative to now.
 */
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
  status,
  conclusion,
  updated_at: updatedAt,
  latest_check_runs_count: runs,
  app: { name: app },
});

/** The stub repository: its open pull requests and the check suites on each commit. */
interface StubRepository {
  pulls: Array<{ number: number; title: string; sha: string; updatedAt: string }>;
  suites: Record<string, Array<GithubCheckSuite>>;
  /** The ETag of the pull request listing; a test changes it whenever it changes the pull requests. */
  pullsEtag: string;
}

/** Answers a request the way GitHub would for `repository`. A commit's suites are tagged by their content. */
const answerFrom =
  (repository: StubRepository) =>
  (request: HttpClientRequest.HttpClientRequest): StubResponse => {
    const { path } = readStubRequestTarget(request);
    if (path === `/repos/${REPO}/pulls`) {
      if (request.headers["if-none-match"] === repository.pullsEtag) return { status: 304 };
      return {
        status: 200,
        headers: { etag: repository.pullsEtag },
        body: repository.pulls.map((pull) => ({
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
      const etag = `"${JSON.stringify(suites).length.toString()}-${String(suites.length)}"`;
      if (request.headers["if-none-match"] === etag) return { status: 304 };
      return {
        status: 200,
        headers: { etag },
        body: { total_count: suites.length, check_suites: suites },
      };
    }
    return { status: 404, body: { message: "Not Found" } };
  };

/** Returns a repository with one pull request, updated an hour ago, whose checks are still running. */
const buildRepository = (): StubRepository => ({
  pulls: [{ number: 7, title: "Add a feature", sha: "sha-a", updatedAt: fromNow(-3_600_000) }],
  suites: { "sha-a": [buildSuite("GitHub Actions", "in_progress", null)] },
  pullsEtag: '"p1"',
});

/** Polls the feed once, against `repository`, and returns the paths of the requests sent. */
const poll = async (harness: IngestHarness, repository: StubRepository, windowDays = 7) => {
  const stub = stubGithub(answerFrom(repository));
  await Effect.runPromise(
    pollChecks("token", harness.context, [REPO], windowDays).pipe(Effect.provide(stub.layer)),
  );
  return stub.requests.map((request) => readStubRequestTarget(request).path);
};

/** Returns a harness whose feed has baselined the repository. */
const baseline = async (repository: StubRepository): Promise<IngestHarness> => {
  const harness = buildIngestHarness();
  await poll(harness, repository);
  return harness;
};

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
    expect(event.dedupKey).toBe(`pr.checks-completed:${REPO}#7:sha-a`);
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

  it("emits once per head commit, and asks no more about a commit that completed", async () => {
    const repository = buildRepository();
    repository.suites["sha-a"] = [buildSuite("GitHub Actions", "completed", "failure")];
    const harness = await baseline(repository);
    await poll(harness, repository);
    expect(harness.events).toHaveLength(1);

    const quiet = await poll(harness, repository);

    expect(quiet).toEqual([`/repos/${REPO}/pulls`]);
    expect(harness.events).toHaveLength(1);

    repository.pulls[0] = { ...repository.pulls[0]!, sha: "sha-b", updatedAt: fromNow(0) };
    repository.suites["sha-b"] = [buildSuite("GitHub Actions", "completed", "success")];
    repository.pullsEtag = '"p2"';
    await poll(harness, repository);

    expect(harness.events.map((event) => event.dedupKey)).toEqual([
      `pr.checks-completed:${REPO}#7:sha-a`,
      `pr.checks-completed:${REPO}#7:sha-b`,
    ]);
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

  it("marks checks that completed before the repository was watched done, without an event", async () => {
    const repository = buildRepository();
    repository.suites["sha-a"] = [
      buildSuite("GitHub Actions", "completed", "success", fromNow(-600_000)),
    ];
    const harness = await baseline(repository);

    await poll(harness, repository);
    const requests = await poll(harness, repository);

    expect(harness.events).toEqual([]);
    expect(requests).toEqual([`/repos/${REPO}/pulls`]);
  });

  it("asks nothing about a pull request not updated within the window", async () => {
    const repository = buildRepository();
    repository.pulls[0] = { ...repository.pulls[0]!, updatedAt: fromNow(-3 * DAY_MS) };
    const harness = await baseline(repository);

    const requests = await poll(harness, repository, 2);

    expect(requests).toEqual([`/repos/${REPO}/pulls`]);
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
