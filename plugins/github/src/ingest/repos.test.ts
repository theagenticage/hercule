/**
 * Tests the repos feed against a stub GitHub that serves one small, mutable
 * repository, so each test changes the repository between two polls and
 * checks the events the second poll emits.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { PluginError } from "@hercule/plugin-host";
import {
  buildIngestHarness,
  readStubRequestTarget,
  stubGithub,
  type IngestHarness,
  type StubResponse,
} from "../testing";
import { pollRepos } from "./repos";

const REPO = "octocat/hello-world";

/** One issue or pull request in the stub repository, in the shape GitHub lists it. */
interface StubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  user: { login: string };
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: { merged_at: string | null };
}

/** The stub repository: its items, the pull requests' head commits, reviews and comments. */
interface StubRepository {
  issues: Array<StubIssue>;
  heads: Record<number, string>;
  reviews: Record<
    number,
    Array<{ id: number; user: { login: string }; state: string; submitted_at: string | null }>
  >;
  comments: Array<{
    id: number;
    html_url: string;
    issue_url: string;
    created_at: string;
    updated_at: string;
  }>;
  /** The ETag of the issue listing; a test changes it whenever it changes the repository. */
  etag: string;
}

/** Builds an open issue, created and updated at `time`. */
const buildIssue = (number: number, time: string, extra: Partial<StubIssue> = {}): StubIssue => ({
  number,
  title: `Item ${String(number)}`,
  state: "open",
  user: { login: "mona" },
  labels: [],
  assignees: [],
  comments: 0,
  created_at: time,
  updated_at: time,
  closed_at: null,
  ...extra,
});

/** Builds an open pull request, created and updated at `time`. */
const buildPull = (number: number, time: string, extra: Partial<StubIssue> = {}): StubIssue =>
  buildIssue(number, time, { pull_request: { merged_at: null }, ...extra });

/** Returns a stub repository with one open issue and one open pull request. */
const buildRepository = (): StubRepository => ({
  issues: [
    buildIssue(1, "2026-10-01T09:00:00Z", { labels: [{ name: "bug" }] }),
    buildPull(2, "2026-10-01T09:30:00Z"),
  ],
  heads: { 2: "sha-a" },
  reviews: {},
  comments: [],
  etag: '"v1"',
});

/** Answers a request the way GitHub would for `repository`. */
const answerFrom =
  (repository: StubRepository) =>
  (request: HttpClientRequest.HttpClientRequest): StubResponse => {
    const { path, query } = readStubRequestTarget(request);
    const base = `/repos/${REPO}`;
    const byUpdate = (left: { updated_at: string }, right: { updated_at: string }) =>
      Date.parse(left.updated_at) - Date.parse(right.updated_at);
    if (path === `${base}/issues` && query["direction"] === "desc") {
      return { status: 200, body: [...repository.issues].sort(byUpdate).reverse().slice(0, 1) };
    }
    if (path === `${base}/issues` && query["state"] === "open") {
      return { status: 200, body: repository.issues.filter((issue) => issue.state === "open") };
    }
    if (path === `${base}/issues`) {
      if (request.headers["if-none-match"] === repository.etag) return { status: 304 };
      const since = Date.parse(query["since"] ?? "1970-01-01T00:00:00Z");
      const changed = repository.issues.filter((issue) => Date.parse(issue.updated_at) >= since);
      return { status: 200, body: changed.sort(byUpdate), headers: { etag: repository.etag } };
    }
    if (path === `${base}/pulls`) {
      const open = repository.issues.filter(
        (issue) => issue.pull_request && issue.state === "open",
      );
      return { status: 200, body: open.map((issue) => buildPullBody(repository, issue)) };
    }
    const pull = /\/pulls\/(\d+)(\/reviews)?$/.exec(path);
    if (pull) {
      const number = Number(pull[1]);
      if (pull[2]) return { status: 200, body: repository.reviews[number] ?? [] };
      const issue = repository.issues.find((item) => item.number === number)!;
      return { status: 200, body: buildPullBody(repository, issue) };
    }
    if (path === `${base}/issues/comments`) {
      const since = Date.parse(query["since"] ?? "1970-01-01T00:00:00Z");
      return {
        status: 200,
        body: repository.comments.filter((comment) => Date.parse(comment.updated_at) >= since),
      };
    }
    return { status: 404, body: { message: "Not Found" } };
  };

/** Returns a pull request as `GET /pulls/{n}` returns it. */
const buildPullBody = (repository: StubRepository, issue: StubIssue) => ({
  number: issue.number,
  title: issue.title,
  state: issue.state,
  user: issue.user,
  head: { sha: repository.heads[issue.number] },
  updated_at: issue.updated_at,
});

/** Polls the feed once over `watchList`, against `route`. Returns the result, success or failure, and the requests sent. */
const poll = async (
  harness: IngestHarness,
  route: (request: HttpClientRequest.HttpClientRequest) => StubResponse,
  watchList: ReadonlyArray<string> = [REPO],
) => {
  const stub = stubGithub(route);
  const result = await Effect.runPromise(
    Effect.result(pollRepos("token", harness.context, watchList).pipe(Effect.provide(stub.layer))),
  );
  return { result, requests: stub.requests.map(readStubRequestTarget) };
};

/** Returns a harness whose feed has polled `repository` once, so it has a baseline. */
const baseline = async (repository: StubRepository): Promise<IngestHarness> => {
  const harness = buildIngestHarness();
  await poll(harness, answerFrom(repository));
  return harness;
};

/** Returns each recorded event as `kind dedupKey`, for a compact comparison. */
const listEvents = (harness: IngestHarness) =>
  harness.events.map((event) => `${event.kind} ${event.dedupKey}`);

describe("the repos feed", () => {
  it("emits nothing on a repository's first poll, and records its open items", async () => {
    const repository = buildRepository();
    const harness = buildIngestHarness();

    const { result, requests } = await poll(harness, answerFrom(repository));

    expect(Result.isSuccess(result)).toBe(true);
    expect(harness.events).toEqual([]);
    expect(requests.map((request) => request.path)).toEqual([
      `/repos/${REPO}/issues`,
      `/repos/${REPO}/issues`,
      `/repos/${REPO}/pulls`,
    ]);
    expect(harness.state.get(`repos/${REPO}`)).toMatchObject({
      cursor: "2026-10-01T09:30:00Z",
      items: {
        "1": { pullRequest: false, state: "open", labels: ["bug"] },
        "2": { pullRequest: true, state: "open", headSha: "sha-a" },
      },
    });
  });

  it("sends one conditional request when nothing changed, and emits nothing", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    // The first steady poll stores the listing's ETag.
    await poll(harness, answerFrom(repository));

    const { requests } = await poll(harness, answerFrom(repository));

    expect(requests).toHaveLength(1);
    expect(harness.events).toEqual([]);
  });

  it("sends the stored ETag as If-None-Match", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    await poll(harness, answerFrom(repository));
    const stub = stubGithub(answerFrom(repository));

    await Effect.runPromise(
      pollRepos("token", harness.context, [REPO]).pipe(Effect.provide(stub.layer)),
    );

    expect(stub.requests[0]!.headers["if-none-match"]).toBe('"v1"');
  });

  it("emits a new issue as opened, then its labels and assignees", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.issues.push(
      buildIssue(3, "2026-10-01T10:00:00Z", {
        labels: [{ name: "triage" }],
        assignees: [{ login: "hubot" }],
      }),
    );
    repository.etag = '"v2"';

    await poll(harness, answerFrom(repository));

    expect(listEvents(harness)).toEqual([
      `github.issue.opened issue.opened:${REPO}#3`,
      `github.issue.labeled issue.labeled:${REPO}#3:+triage:-:2026-10-01T10:00:00Z`,
      `github.issue.assigned issue.assigned:${REPO}#3:hubot:2026-10-01T10:00:00Z`,
    ]);
    const [opened, labeled] = harness.events;
    expect(opened!.occurredAt).toBe("2026-10-01T10:00:00Z");
    expect(opened!.refs).toEqual([`github:issue:${REPO}#3`, `github:repo:${REPO}`]);
    expect(opened!.url).toBe(`https://github.com/${REPO}/issues/3`);
    expect(labeled!.payload).toMatchObject({ added: ["triage"], removed: [] });
  });

  it("emits a new pull request as opened, then its labels, and nothing for its assignee", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.issues.push(
      buildPull(3, "2026-10-01T10:00:00Z", {
        labels: [{ name: "feature" }],
        assignees: [{ login: "hubot" }],
      }),
    );
    repository.heads[3] = "sha-c";
    repository.etag = '"v2"';

    const { result } = await poll(harness, answerFrom(repository));

    expect(Result.isSuccess(result)).toBe(true);
    expect(listEvents(harness)).toEqual([
      `github.pr.opened pr.opened:${REPO}#3`,
      `github.pr.labeled pr.labeled:${REPO}#3:+feature:-:2026-10-01T10:00:00Z`,
    ]);
    expect(harness.events[0]!.url).toBe(`https://github.com/${REPO}/pull/3`);
    expect(harness.state.get(`repos/${REPO}`)).toMatchObject({
      items: { "3": { pullRequest: true, headSha: "sha-c" } },
    });
  });

  it("emits a closed issue, a label change and a new assignee", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.issues[0] = {
      ...repository.issues[0]!,
      state: "closed",
      labels: [{ name: "wontfix" }],
      assignees: [{ login: "hubot" }],
      updated_at: "2026-10-01T11:00:00Z",
      closed_at: "2026-10-01T11:00:00Z",
    };
    repository.etag = '"v2"';

    await poll(harness, answerFrom(repository));

    expect(listEvents(harness)).toEqual([
      `github.issue.labeled issue.labeled:${REPO}#1:+wontfix:-bug:2026-10-01T11:00:00Z`,
      `github.issue.assigned issue.assigned:${REPO}#1:hubot:2026-10-01T11:00:00Z`,
      `github.issue.closed issue.closed:${REPO}#1:2026-10-01T11:00:00Z`,
    ]);
    expect(harness.events[0]!.payload).toMatchObject({ added: ["wontfix"], removed: ["bug"] });
  });

  it("emits a reopened issue", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.issues[0] = {
      ...repository.issues[0]!,
      state: "closed",
      updated_at: "2026-10-01T11:00:00Z",
      closed_at: "2026-10-01T11:00:00Z",
    };
    repository.etag = '"v2"';
    await poll(harness, answerFrom(repository));
    repository.issues[0] = {
      ...repository.issues[0],
      state: "open",
      updated_at: "2026-10-01T12:00:00Z",
      closed_at: null,
    };
    repository.etag = '"v3"';

    await poll(harness, answerFrom(repository));

    expect(listEvents(harness).at(-1)).toBe(
      `github.issue.reopened issue.reopened:${REPO}#1:2026-10-01T12:00:00Z`,
    );
  });

  it("tells a merged pull request from one closed without merging", async () => {
    const repository = buildRepository();
    repository.issues.push(buildPull(3, "2026-10-01T09:40:00Z"));
    repository.heads[3] = "sha-c";
    const harness = await baseline(repository);
    repository.issues[1] = {
      ...repository.issues[1]!,
      state: "closed",
      updated_at: "2026-10-01T11:00:00Z",
      closed_at: "2026-10-01T11:00:00Z",
      pull_request: { merged_at: "2026-10-01T11:00:00Z" },
    };
    repository.issues[2] = {
      ...repository.issues[2]!,
      state: "closed",
      updated_at: "2026-10-01T11:05:00Z",
      closed_at: "2026-10-01T11:05:00Z",
    };
    repository.etag = '"v2"';

    await poll(harness, answerFrom(repository));

    expect(listEvents(harness)).toEqual([
      `github.pr.merged pr.merged:${REPO}#2`,
      `github.pr.closed pr.closed:${REPO}#3:2026-10-01T11:05:00Z`,
    ]);
    expect(harness.events[0]!.url).toBe(`https://github.com/${REPO}/pull/2`);
  });

  it("emits a new head commit and each review submitted since the last poll", async () => {
    const repository = buildRepository();
    repository.reviews[2] = [
      { id: 100, user: { login: "old" }, state: "APPROVED", submitted_at: "2026-10-01T09:10:00Z" },
    ];
    const harness = await baseline(repository);
    repository.issues[1] = { ...repository.issues[1]!, updated_at: "2026-10-01T11:00:00Z" };
    repository.heads[2] = "sha-b";
    repository.reviews[2].push(
      {
        id: 101,
        user: { login: "hubot" },
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-10-01T10:30:00Z",
      },
      { id: 102, user: { login: "hubot" }, state: "PENDING", submitted_at: null },
      {
        id: 103,
        user: { login: "mona" },
        state: "DISMISSED",
        submitted_at: "2026-10-01T10:40:00Z",
      },
    );
    repository.etag = '"v2"';

    const { requests } = await poll(harness, answerFrom(repository));

    expect(listEvents(harness)).toEqual([
      `github.pr.synchronized pr.synchronized:${REPO}#2:sha-b`,
      `github.pr.review-submitted pr.review-submitted:101`,
    ]);
    expect(harness.events[1]!.payload).toMatchObject({
      reviewer: "hubot",
      verdict: "changes-requested",
    });
    // The listing, the pull request for its head, and its reviews.
    expect(requests.map((request) => request.path)).toEqual([
      `/repos/${REPO}/issues`,
      `/repos/${REPO}/pulls/2`,
      `/repos/${REPO}/pulls/2/reviews`,
    ]);
  });

  it("emits the comments created since the last poll, on issues and pull requests alike", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.issues[0] = {
      ...repository.issues[0]!,
      comments: 1,
      updated_at: "2026-10-01T11:00:00Z",
    };
    repository.issues[1] = {
      ...repository.issues[1]!,
      comments: 2,
      updated_at: "2026-10-01T11:01:00Z",
    };
    repository.comments.push(
      // An old comment edited since: not new, so it emits nothing.
      {
        id: 500,
        html_url: `https://github.com/${REPO}/pull/2#issuecomment-500`,
        issue_url: `https://api.github.com/repos/${REPO}/issues/2`,
        created_at: "2026-10-01T09:20:00Z",
        updated_at: "2026-10-01T10:59:00Z",
      },
      {
        id: 501,
        html_url: `https://github.com/${REPO}/issues/1#issuecomment-501`,
        issue_url: `https://api.github.com/repos/${REPO}/issues/1`,
        created_at: "2026-10-01T11:00:00Z",
        updated_at: "2026-10-01T11:00:00Z",
      },
      {
        id: 502,
        html_url: `https://github.com/${REPO}/pull/2#issuecomment-502`,
        issue_url: `https://api.github.com/repos/${REPO}/issues/2`,
        created_at: "2026-10-01T11:01:00Z",
        updated_at: "2026-10-01T11:01:00Z",
      },
    );
    repository.etag = '"v2"';

    const { requests } = await poll(harness, answerFrom(repository));

    expect(listEvents(harness)).toEqual([
      "github.issue.commented issue.commented:501",
      "github.pr.commented pr.commented:502",
    ]);
    expect(harness.events[1]!.payload).toMatchObject({ subject: { number: 2, title: "Item 2" } });
    expect(requests.filter((request) => request.path.endsWith("/issues/comments"))).toHaveLength(1);
  });

  it("baselines a repository added to the watch list later, and forgets one that left", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    const other = "octocat/spoon-knife";
    const route = (request: HttpClientRequest.HttpClientRequest): StubResponse =>
      readStubRequestTarget(request).path.startsWith(`/repos/${other}/`)
        ? {
            status: 200,
            body: request.url.endsWith("/pulls") ? [] : [buildIssue(9, "2026-10-01T08:00:00Z")],
          }
        : answerFrom(repository)(request);

    await poll(harness, route, [REPO, other]);

    expect(harness.events).toEqual([]);
    expect(harness.state.has(`repos/${other}`)).toBe(true);

    await poll(harness, route, [other]);

    expect(harness.state.has(`repos/${REPO}`)).toBe(false);
  });

  it("polls every repository when one fails, then fails naming it", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.issues.push(buildIssue(3, "2026-10-01T10:00:00Z"));
    repository.etag = '"v2"';
    const route = (request: HttpClientRequest.HttpClientRequest): StubResponse =>
      readStubRequestTarget(request).path.startsWith("/repos/octocat/gone/")
        ? { status: 404, body: { message: "Not Found" } }
        : answerFrom(repository)(request);

    const { result } = await poll(harness, route, ["octocat/gone", REPO]);

    expect(listEvents(harness)).toEqual([`github.issue.opened issue.opened:${REPO}#3`]);
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure).toBeInstanceOf(PluginError);
    expect(result.failure.message).toContain("octocat/gone");
    expect(result.failure.message).toContain("Not Found");
  });

  it("drops a closed item from its snapshot seven days after it closed", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.issues[0] = {
      ...repository.issues[0]!,
      state: "closed",
      updated_at: "2026-10-01T11:00:00Z",
      closed_at: "2026-10-01T11:00:00Z",
    };
    repository.etag = '"v2"';
    await poll(harness, answerFrom(repository));
    repository.issues[1] = {
      ...repository.issues[1]!,
      title: "Renamed",
      updated_at: "2026-10-09T11:00:00Z",
    };
    repository.etag = '"v3"';

    await poll(harness, answerFrom(repository));

    const state = harness.state.get(`repos/${REPO}`) as { items: Record<string, unknown> };
    expect(Object.keys(state.items)).toEqual(["2"]);
  });
});
