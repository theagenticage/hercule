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
  runAgainstStub,
  stubGithub,
  type IngestHarness,
  type StubResponse,
} from "../testing";
import { computeDigest } from "./digest";
import { MAX_ITEMS_PER_REPO, MAX_REQUESTS_PER_POLL, pollRepos } from "./repos";

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
  state_reason?: string | null;
  pull_request?: { merged_at: string | null };
}

/** One comment in the stub repository, in the shape GitHub lists it. */
interface StubComment {
  id: number;
  html_url: string;
  issue_url: string;
  created_at: string;
  updated_at: string;
}

/** The stub repository: its items, the pull requests' head commits, reviews and comments. */
interface StubRepository {
  issues: Array<StubIssue>;
  heads: Record<number, string>;
  reviews: Record<
    number,
    Array<{ id: number; user: { login: string }; state: string; submitted_at: string | null }>
  >;
  comments: Array<StubComment>;
  /** How many items one page of an issue listing of all or open issues holds; GitHub's is 100. */
  issuesPerPage: number;
  /** How many comments one page of the comment listing holds; GitHub's is 100. */
  commentsPerPage: number;
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
  issuesPerPage: 100,
  commentsPerPage: 100,
  etag: '"v1"',
});

/** Builds a comment on item `number`, created and updated at `time`. */
const buildComment = (
  id: number,
  number: number,
  time: string,
  kind: "issues" | "pull" = "issues",
): StubComment => ({
  id,
  html_url: `https://github.com/${REPO}/${kind}/${String(number)}#issuecomment-${String(id)}`,
  issue_url: `https://api.github.com/repos/${REPO}/issues/${String(number)}`,
  created_at: time,
  updated_at: time,
});

/**
 * Answers with the page of `listed` that the request's `page` asks for,
 * `size` items long, with a `Link` header to the next page when there is one.
 */
const answerPage = (
  request: HttpClientRequest.HttpClientRequest,
  listed: ReadonlyArray<unknown>,
  size: number,
  headers: Record<string, string> = {},
): StubResponse => {
  const { path, query } = readStubRequestTarget(request);
  const page = Number(query["page"] ?? "1");
  const next = new URL(`https://api.github.com${path}`);
  for (const [name, value] of Object.entries(query)) next.searchParams.set(name, value);
  next.searchParams.set("page", String(page + 1));
  return {
    status: 200,
    body: listed.slice((page - 1) * size, page * size),
    headers:
      listed.length > page * size ? { ...headers, link: `<${next.href}>; rel="next"` } : headers,
  };
};

/** Answers a request the way GitHub would for `repository`, named `repo`. */
const answerFrom =
  (repository: StubRepository, repo: string = REPO) =>
  (request: HttpClientRequest.HttpClientRequest): StubResponse => {
    const { path, query } = readStubRequestTarget(request);
    const base = `/repos/${repo}`;
    const byUpdate = (left: { updated_at: string }, right: { updated_at: string }) =>
      Date.parse(left.updated_at) - Date.parse(right.updated_at);
    if (path === `${base}/issues` && query["state"] === "closed") {
      const since = Date.parse(query["since"]!);
      const closed = repository.issues.filter(
        (issue) => issue.state === "closed" && Date.parse(issue.updated_at) >= since,
      );
      return { status: 200, body: closed.sort(byUpdate).reverse() };
    }
    if (path === `${base}/issues` && query["direction"] === "desc") {
      return { status: 200, body: [...repository.issues].sort(byUpdate).reverse().slice(0, 1) };
    }
    if (path === `${base}/issues` && query["state"] === "open") {
      const open = repository.issues.filter((issue) => issue.state === "open");
      return answerPage(request, open, repository.issuesPerPage);
    }
    if (path === `${base}/issues`) {
      if (request.headers["if-none-match"] === repository.etag) return { status: 304 };
      const since = Date.parse(query["since"] ?? "1970-01-01T00:00:00Z");
      const changed = repository.issues.filter((issue) => Date.parse(issue.updated_at) >= since);
      return answerPage(request, changed.sort(byUpdate), repository.issuesPerPage, {
        etag: repository.etag,
      });
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
      const listed = repository.comments
        .filter((comment) => Date.parse(comment.updated_at) >= since)
        .sort(byUpdate);
      return answerPage(request, listed, repository.commentsPerPage);
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

/**
 * Polls the feed once over `watchList`, against `route`. Returns the result,
 * success or failure, the path and query of each request sent, and the
 * requests themselves.
 */
const poll = async (
  harness: IngestHarness,
  route: (request: HttpClientRequest.HttpClientRequest) => StubResponse,
  watchList: ReadonlyArray<string> = [REPO],
) => {
  const stub = stubGithub(route);
  const result = await runAgainstStub(pollRepos("token", harness.context, watchList), stub);
  return { result, requests: stub.requests.map(readStubRequestTarget), sent: stub.requests };
};

/** Returns the time `seconds` after `time`, both in GitHub's format, such as `2026-10-01T10:00:05Z`. */
const addSeconds = (time: string, seconds: number): string =>
  new Date(Date.parse(time) + seconds * 1000).toISOString().replace(".000Z", "Z");

/** Returns a harness whose feed has polled `repository` once, so it has a baseline. */
const baseline = async (repository: StubRepository): Promise<IngestHarness> => {
  const harness = buildIngestHarness();
  await poll(harness, answerFrom(repository));
  return harness;
};

/** Returns each recorded event as `kind dedupKey`, for a compact comparison. */
const listEvents = (harness: IngestHarness) =>
  harness.events.map((event) => `${event.kind} ${event.dedupKey}`);

/**
 * Returns each recorded event as `kind dedupKey`, once per dedup key, in the
 * order of first emission. The host writes an event whose key it has seen
 * before as nothing, so this is what the host keeps.
 */
const listWrittenEvents = (harness: IngestHarness) => [...new Set(listEvents(harness))];

/** Returns the `owner/repo` a request path such as `/repos/octocat/hello-world/issues` is for. */
const readRepoOf = (path: string): string => path.split("/").slice(2, 4).join("/");

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
      `github.issue.labeled issue.labeled:${REPO}#3:2026-10-01T10:00:00Z:${computeDigest(["+triage"])}`,
      `github.issue.assigned issue.assigned:${REPO}#3:2026-10-01T10:00:00Z:${computeDigest(["hubot"])}`,
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
      `github.pr.labeled pr.labeled:${REPO}#3:2026-10-01T10:00:00Z:${computeDigest(["+feature"])}`,
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
      `github.issue.labeled issue.labeled:${REPO}#1:2026-10-01T09:00:00Z:${computeDigest(["+wontfix", "-bug"])}`,
      `github.issue.assigned issue.assigned:${REPO}#1:2026-10-01T09:00:00Z:${computeDigest(["hubot"])}`,
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
      `github.issue.reopened issue.reopened:${REPO}#1:2026-10-01T11:00:00Z`,
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

  it("emits changes made in the same second as the last poll's snapshot", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    const time = "2026-10-01T11:00:00Z";
    repository.issues[0] = { ...repository.issues[0]!, title: "Renamed", updated_at: time };
    repository.issues[1] = { ...repository.issues[1]!, title: "Renamed", updated_at: time };
    repository.etag = '"v2"';
    await poll(harness, answerFrom(repository));
    expect(harness.events).toEqual([]);
    // Later in the same second: GitHub's `updated_at` counts whole seconds,
    // so neither item's update time moves. Only the ETag tells that something
    // changed.
    repository.issues[0] = {
      ...repository.issues[0],
      labels: [{ name: "bug" }, { name: "triage" }],
      comments: 1,
    };
    repository.comments.push(buildComment(501, 1, time));
    repository.issues[1] = {
      ...repository.issues[1],
      state: "closed",
      closed_at: time,
      pull_request: { merged_at: time },
    };
    repository.reviews[2] = [
      { id: 101, user: { login: "hubot" }, state: "APPROVED", submitted_at: time },
    ];
    repository.etag = '"v3"';

    await poll(harness, answerFrom(repository));

    expect(listEvents(harness)).toEqual([
      `github.issue.labeled issue.labeled:${REPO}#1:${time}:${computeDigest(["+triage"])}`,
      `github.pr.merged pr.merged:${REPO}#2`,
      "github.pr.review-submitted pr.review-submitted:101",
      "github.issue.commented issue.commented:501",
    ]);
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
    // The listing, the pull request for its head, its reviews, and the
    // repository's comments, which are read whenever an item changed.
    expect(requests.map((request) => request.path)).toEqual([
      `/repos/${REPO}/issues`,
      `/repos/${REPO}/pulls/2`,
      `/repos/${REPO}/pulls/2/reviews`,
      `/repos/${REPO}/issues/comments`,
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

  it("emits a comment that replaced a deleted one, though the comment count stayed the same", async () => {
    const repository = buildRepository();
    repository.issues[0] = { ...repository.issues[0]!, comments: 1 };
    repository.comments.push(buildComment(500, 1, "2026-10-01T09:00:00Z"));
    const harness = await baseline(repository);
    repository.comments = [buildComment(501, 1, "2026-10-01T11:00:00Z")];
    repository.issues[0] = { ...repository.issues[0], updated_at: "2026-10-01T11:00:00Z" };
    repository.etag = '"v2"';

    const { requests } = await poll(harness, answerFrom(repository));

    expect(listEvents(harness)).toEqual(["github.issue.commented issue.commented:501"]);
    expect(requests.filter((request) => request.path.endsWith("/issues/comments"))).toHaveLength(1);
  });

  it("reads a snapshot stored with the comment count it no longer keeps", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    // An earlier version of the feed kept each item's comment count.
    const stored = harness.state.get(`repos/${REPO}`) as {
      items: Record<string, Record<string, unknown>>;
    };
    for (const item of Object.values(stored.items)) item["comments"] = 0;
    repository.issues[0] = {
      ...repository.issues[0]!,
      labels: [],
      updated_at: "2026-10-01T11:00:00Z",
    };
    repository.etag = '"v2"';

    const { result } = await poll(harness, answerFrom(repository));

    expect(Result.isSuccess(result)).toBe(true);
    expect(listEvents(harness)).toEqual([
      `github.issue.labeled issue.labeled:${REPO}#1:2026-10-01T09:00:00Z:${computeDigest(["-bug"])}`,
    ]);
    expect(harness.state.get(`repos/${REPO}`)).not.toHaveProperty(["items", "1", "comments"]);
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
    expect(harness.state.get(`repos/${REPO}`)).toMatchObject({ items: { "3": { state: "open" } } });
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure).toBeInstanceOf(PluginError);
    expect(result.failure.message).toBe(
      "The repos feed could not poll octocat/gone: GitHub returned status 404 for " +
        "GET /repos/octocat/gone/issues: Not Found. " +
        "The other repositories on the watch list are still polled. " +
        "If a repository was deleted, renamed or hidden from the Connection's account, " +
        "unlink its repo Resource or remove it from the Connection's extra repositories.",
    );
  });

  it("fails naming the listing when GitHub's next-page link points outside its API", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.issues.push(buildIssue(3, "2026-10-01T10:00:00Z"));
    repository.etag = '"v2"';
    const route = (request: HttpClientRequest.HttpClientRequest): StubResponse => {
      const answer = answerFrom(repository)(request);
      return readStubRequestTarget(request).path === `/repos/${REPO}/issues`
        ? { ...answer, headers: { ...answer.headers, link: '<https://example.com/x>; rel="next"' } }
        : answer;
    };

    const { result, requests } = await poll(harness, route);

    expect(requests.map((request) => request.path)).toEqual([`/repos/${REPO}/issues`]);
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure.message).toContain(
      `${REPO}: Reading the next page of GET /repos/${REPO}/issues failed. ` +
        "The request to https://example.com was not sent",
    );
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

  it("keeps every dedup key within the host's limit, for the longest names GitHub allows", async () => {
    // GitHub allows 39 characters for an owner and 100 for a repository.
    const repo = `${"o".repeat(39)}/${"r".repeat(100)}`;
    const repository = buildRepository();
    repository.issues = [
      buildIssue(99999998, "2026-10-01T09:00:00Z"),
      buildPull(99999999, "2026-10-01T09:30:00Z"),
    ];
    repository.heads = { 99999999: "a".repeat(40) };
    const harness = buildIngestHarness();
    await poll(harness, answerFrom(repository, repo), [repo]);
    const labels = Array.from({ length: 20 }, (_, index) => ({
      name: `${"l".repeat(48)}${String(index).padStart(2, "0")}`,
    }));
    const assignees = Array.from({ length: 10 }, (_, index) => ({
      login: `${"u".repeat(37)}${String(index).padStart(2, "0")}`,
    }));
    repository.issues[0] = {
      ...repository.issues[0]!,
      labels,
      assignees,
      state: "closed",
      updated_at: "2026-10-01T11:00:00Z",
      closed_at: "2026-10-01T11:00:00Z",
    };
    repository.issues[1] = { ...repository.issues[1]!, labels, updated_at: "2026-10-01T11:01:00Z" };
    repository.heads[99999999] = "b".repeat(40);
    repository.etag = '"v2"';

    // The harness refuses a key longer than 200 characters, as the host does.
    const { result } = await poll(harness, answerFrom(repository, repo), [repo]);

    expect(Result.isSuccess(result)).toBe(true);
    expect(harness.events.map((event) => event.kind)).toEqual([
      "github.issue.labeled",
      "github.issue.assigned",
      "github.issue.closed",
      "github.pr.labeled",
      "github.pr.synchronized",
    ]);
  });

  it("builds the same keys again after a poll that emitted its events but could not save them", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    repository.issues[0] = {
      ...repository.issues[0]!,
      assignees: [{ login: "hubot" }],
      updated_at: "2026-10-01T11:00:00Z",
    };
    repository.issues[1] = { ...repository.issues[1]!, updated_at: "2026-10-01T11:01:00Z" };
    repository.etag = '"v2"';
    // The issue's events are emitted, then the pull request fails the poll, so nothing is saved.
    const failing = (request: HttpClientRequest.HttpClientRequest): StubResponse =>
      readStubRequestTarget(request).path === `/repos/${REPO}/pulls/2`
        ? { status: 500, body: { message: "Server Error" } }
        : answerFrom(repository)(request);
    const first = await poll(harness, failing);
    expect(Result.isFailure(first.result)).toBe(true);
    // The issue changes again before the next poll.
    repository.issues[0] = {
      ...repository.issues[0],
      title: "Renamed",
      updated_at: "2026-10-01T11:30:00Z",
    };
    repository.etag = '"v3"';

    await poll(harness, answerFrom(repository));

    const assigned = harness.events
      .filter((event) => event.kind === "github.issue.assigned")
      .map((event) => event.dedupKey);
    expect(assigned).toHaveLength(2);
    expect(assigned[1]).toBe(assigned[0]);
  });

  it("emits no comment or review from before the first poll, even one in the newest update's second", async () => {
    const repository = buildRepository();
    // The newest update is a pull request closed just before the first poll,
    // with a review in an earlier second, and a review and a comment in its
    // update's second.
    repository.issues[1] = {
      ...repository.issues[1]!,
      state: "closed",
      comments: 1,
      closed_at: "2026-10-01T09:45:00Z",
      updated_at: "2026-10-01T10:00:00Z",
    };
    repository.comments.push(buildComment(500, 2, "2026-10-01T10:00:00Z", "pull"));
    repository.reviews[2] = [
      { id: 99, user: { login: "mona" }, state: "APPROVED", submitted_at: "2026-10-01T09:50:00Z" },
      {
        id: 100,
        user: { login: "hubot" },
        state: "APPROVED",
        submitted_at: "2026-10-01T10:00:00Z",
      },
    ];
    const harness = await baseline(repository);

    // Every listing after the baseline repeats the newest item, so two polls
    // that GitHub does not answer with 304 both diff it again.
    const { result } = await poll(harness, answerFrom(repository));
    repository.etag = '"v2"';
    await poll(harness, answerFrom(repository));

    expect(Result.isSuccess(result)).toBe(true);
    expect(harness.events).toEqual([]);
    expect(harness.state.get(`repos/${REPO}`)).toMatchObject({
      items: { "2": { fromBaseline: true } },
    });

    // A label added after the close is diffed, because the closed item is in the snapshot.
    repository.issues[1] = {
      ...repository.issues[1],
      labels: [{ name: "late" }],
      updated_at: "2026-10-01T10:30:00Z",
    };
    repository.etag = '"v3"';

    await poll(harness, answerFrom(repository));

    expect(listEvents(harness)).toEqual([
      `github.pr.labeled pr.labeled:${REPO}#2:2026-10-01T10:00:00Z:${computeDigest(["+late"])}`,
    ]);
    expect(harness.state.get(`repos/${REPO}`)).not.toHaveProperty(["items", "2", "fromBaseline"]);
  });

  it("emits reopened for an old issue missing from the snapshot only when GitHub says it was reopened", async () => {
    const repository = buildRepository();
    const harness = await baseline(repository);
    // Two old open issues the snapshot does not hold, as after a close more
    // than seven days ago, or a transfer from another repository.
    repository.issues.push(
      buildIssue(7, "2026-09-01T09:00:00Z", {
        state_reason: "reopened",
        updated_at: "2026-10-01T11:00:00Z",
      }),
      buildIssue(8, "2026-09-01T09:00:00Z", {
        state_reason: null,
        updated_at: "2026-10-01T11:05:00Z",
      }),
    );
    repository.etag = '"v2"';

    await poll(harness, answerFrom(repository));

    expect(listEvents(harness)).toEqual([
      `github.issue.reopened issue.reopened:${REPO}#7:2026-10-01T11:00:00Z`,
    ]);
  });

  it("reads the rest of a comment listing that stopped at its page limit on the next poll", async () => {
    const repository = buildRepository();
    repository.commentsPerPage = 1;
    const harness = await baseline(repository);
    await poll(harness, answerFrom(repository));
    repository.issues[0] = {
      ...repository.issues[0]!,
      comments: 11,
      updated_at: "2026-10-01T11:10:00Z",
    };
    for (let minute = 0; minute <= 10; minute += 1) {
      const time = `2026-10-01T11:${String(minute).padStart(2, "0")}:00Z`;
      repository.comments.push(buildComment(600 + minute, 1, time));
    }
    repository.etag = '"v2"';

    // Ten pages of one comment each is the limit.
    await poll(harness, answerFrom(repository));

    expect(harness.events).toHaveLength(10);
    expect(harness.state.get(`repos/${REPO}`)).toMatchObject({
      pendingComments: { since: "2026-10-01T11:09:00Z", createdAfter: "2026-10-01T09:30:00Z" },
    });

    // The issue listing answers 304 now, and the comments are still read.
    const { requests } = await poll(harness, answerFrom(repository));

    expect(requests[0]!.path).toBe(`/repos/${REPO}/issues`);
    expect(requests[1]!.query).toMatchObject({ since: "2026-10-01T11:09:00Z" });
    // The last comment read is read again; the host writes its event once.
    const keys = new Set(harness.events.map((event) => event.dedupKey));
    expect(keys.size).toBe(11);
    expect(keys.has("issue.commented:610")).toBe(true);
    expect(harness.state.get(`repos/${REPO}`)).not.toHaveProperty("pendingComments");
  });

  describe("with more changes waiting than one poll diffs", () => {
    const BASELINE_TIME = "2026-10-01T08:00:00Z";
    const CHANGE_TIME = "2026-10-01T10:00:00Z";

    /** Returns a stub repository with `count` open pull requests, each created a second after the last. */
    const buildPullRepository = (count: number): StubRepository => {
      const repository = buildRepository();
      repository.issues = Array.from({ length: count }, (_, index) =>
        buildPull(index + 1, addSeconds(BASELINE_TIME, index)),
      );
      repository.heads = Object.fromEntries(
        repository.issues.map((issue) => [issue.number, "sha-a"]),
      );
      return repository;
    };

    /** Labels every item `stale`, each updated a second after the last from `CHANGE_TIME` on, and changes the ETag. */
    const labelEveryItem = (repository: StubRepository) => {
      repository.issues = repository.issues.map((issue, index) => ({
        ...issue,
        labels: [{ name: "stale" }],
        updated_at: addSeconds(CHANGE_TIME, index),
      }));
      repository.etag = '"v2"';
    };

    it("diffs its budget in one poll, stopping at a whole second, and the rest in the next", async () => {
      const repository = buildPullRepository(MAX_ITEMS_PER_REPO + MAX_ITEMS_PER_REPO / 2);
      const harness = await baseline(repository);
      labelEveryItem(repository);

      await poll(harness, answerFrom(repository));

      const lastDiffed = addSeconds(CHANGE_TIME, MAX_ITEMS_PER_REPO - 1);
      expect(harness.events).toHaveLength(MAX_ITEMS_PER_REPO);
      const firstState = harness.state.get(`repos/${REPO}`);
      expect(firstState).toMatchObject({
        cursor: lastDiffed,
        items: {
          [String(MAX_ITEMS_PER_REPO)]: { updatedAt: lastDiffed },
          [String(MAX_ITEMS_PER_REPO + 1)]: {
            updatedAt: addSeconds(BASELINE_TIME, MAX_ITEMS_PER_REPO),
          },
        },
      });
      // A 304 on the next poll would hide the items this one did not reach.
      expect(firstState).not.toHaveProperty("etag");

      const { sent } = await poll(harness, answerFrom(repository));

      expect(sent[0]!.headers["if-none-match"]).toBeUndefined();
      // Each label is emitted exactly once, even for the item in the cursor's
      // second, which the second poll diffs again.
      expect(listEvents(harness)).toEqual(
        repository.issues.map(
          (issue) =>
            `github.pr.labeled pr.labeled:${REPO}#${String(issue.number)}:${issue.created_at}:${computeDigest(["+stale"])}`,
        ),
      );
      expect(harness.state.get(`repos/${REPO}`)).toMatchObject({
        cursor: repository.issues.at(-1)!.updated_at,
        etag: '"v2"',
      });
    });

    it("moves on past a second that holds more items than its budget", async () => {
      const repository = buildRepository();
      const count = MAX_ITEMS_PER_REPO + 20;
      for (let index = 0; index < count; index += 1) {
        repository.issues.push(buildIssue(10 + index, BASELINE_TIME));
      }
      const harness = await baseline(repository);
      // Every one of them is labeled in the same second, as a bot might.
      for (const issue of repository.issues.slice(2)) {
        issue.labels = [{ name: "stale" }];
        issue.updated_at = CHANGE_TIME;
      }
      repository.etag = '"v2"';

      await poll(harness, answerFrom(repository));

      // A second is never split, so the poll diffs them all.
      expect(harness.events).toHaveLength(count);
      expect(harness.state.get(`repos/${REPO}`)).toMatchObject({ cursor: CHANGE_TIME });

      // Two of them change again, in the next two seconds. The listing now
      // starts with the cursor's second, which holds more than the budget.
      const labelAgain = (number: number, seconds: number) => {
        const issue = repository.issues.find((item) => item.number === number)!;
        issue.labels = [...issue.labels, { name: "later" }];
        issue.updated_at = addSeconds(CHANGE_TIME, seconds);
      };
      labelAgain(10, 1);
      labelAgain(11, 2);
      repository.etag = '"v3"';
      const buildLaterKey = (number: number) =>
        `github.issue.labeled issue.labeled:${REPO}#${String(number)}:${CHANGE_TIME}:${computeDigest(["+later"])}`;

      await poll(harness, answerFrom(repository));

      expect(listWrittenEvents(harness).slice(count)).toEqual([buildLaterKey(10)]);
      expect(harness.state.get(`repos/${REPO}`)).toMatchObject({
        cursor: addSeconds(CHANGE_TIME, 1),
      });

      await poll(harness, answerFrom(repository));

      expect(listWrittenEvents(harness).slice(count)).toEqual([
        buildLaterKey(10),
        buildLaterKey(11),
      ]);
    });

    it("starts each poll after the repository it polled last, so a busy one cannot hold up the others", async () => {
      const other = "octocat/spoon-knife";
      const busy = buildPullRepository(MAX_ITEMS_PER_REPO);
      const quiet = buildRepository();
      const route = (request: HttpClientRequest.HttpClientRequest): StubResponse =>
        readRepoOf(readStubRequestTarget(request).path) === other
          ? answerFrom(quiet, other)(request)
          : answerFrom(busy)(request);
      const harness = buildIngestHarness();
      await poll(harness, route, [REPO, other]);
      labelEveryItem(busy);
      quiet.issues[0] = { ...quiet.issues[0]!, labels: [], updated_at: "2026-10-01T11:00:00Z" };
      quiet.etag = '"v2"';

      // The first poll ended with the quiet repository, so this one starts
      // with the busy one. Its head commits and reviews spend the budget.
      const second = await poll(harness, route, [REPO, other]);

      expect(second.requests.length).toBeGreaterThanOrEqual(MAX_REQUESTS_PER_POLL);
      expect(new Set(second.requests.map((request) => readRepoOf(request.path)))).toEqual(
        new Set([REPO]),
      );
      expect(harness.events).toHaveLength(MAX_ITEMS_PER_REPO);

      const third = await poll(harness, route, [REPO, other]);

      expect(readRepoOf(third.requests[0]!.path)).toBe(other);
      expect(listEvents(harness)).toContain(
        `github.issue.labeled issue.labeled:${other}#1:2026-10-01T09:00:00Z:${computeDigest(["-bug"])}`,
      );
    });

    it("keeps no ETag when the listing stopped at its page limit", async () => {
      const repository = buildRepository();
      // One item per page, and ten pages is the limit.
      repository.issuesPerPage = 1;
      const harness = await baseline(repository);
      for (let index = 0; index < 12; index += 1) {
        repository.issues.push(buildIssue(10 + index, addSeconds(CHANGE_TIME, index)));
      }
      repository.etag = '"v2"';

      await poll(harness, answerFrom(repository));

      // The listing repeats the cursor's item first, so ten pages hold nine new issues.
      expect(harness.events).toHaveLength(9);
      expect(harness.state.get(`repos/${REPO}`)).not.toHaveProperty("etag");

      const { sent } = await poll(harness, answerFrom(repository));

      expect(sent[0]!.headers["if-none-match"]).toBeUndefined();
      expect(listWrittenEvents(harness)).toEqual(
        Array.from(
          { length: 12 },
          (_, index) => `github.issue.opened issue.opened:${REPO}#${String(10 + index)}`,
        ),
      );
      expect(harness.state.get(`repos/${REPO}`)).toMatchObject({ etag: '"v2"' });
    });
  });

  describe("with more repositories waiting than one poll reaches", () => {
    /** Open issues in each repository, listed one per page. */
    const OPEN_ISSUES = 30;
    /** One baseline: the newest item, a page per open issue, closed issues and open pull requests. */
    const BASELINE_REQUESTS = 1 + OPEN_ISSUES + 1 + 1;

    /** Returns twenty watched repositories, sorted, and a route that answers for each. */
    const buildWatchedRepositories = () => {
      const repositories = new Map<string, StubRepository>();
      for (let index = 0; index < 20; index += 1) {
        const repository = buildRepository();
        repository.issues = Array.from({ length: OPEN_ISSUES }, (_, number) =>
          buildIssue(number + 1, addSeconds("2026-10-01T09:00:00Z", number)),
        );
        repository.heads = {};
        repository.issuesPerPage = 1;
        repositories.set(`octocat/repo-${String(index).padStart(2, "0")}`, repository);
      }
      const route = (request: HttpClientRequest.HttpClientRequest): StubResponse => {
        const repo = readRepoOf(readStubRequestTarget(request).path);
        return answerFrom(repositories.get(repo)!, repo)(request);
      };
      return { watchList: [...repositories.keys()], route };
    };

    /** Returns the repositories a poll sent requests for, in the order it first did. */
    const listPolledRepos = (requests: ReadonlyArray<{ path: string }>) => [
      ...new Set(requests.map((request) => readRepoOf(request.path))),
    ];

    it("baselines them over several polls, each within its request budget and one repository", async () => {
      const { watchList, route } = buildWatchedRepositories();
      const harness = buildIngestHarness();
      const polled: Array<Array<string>> = [];

      while (!watchList.every((repo) => harness.state.has(`repos/${repo}`))) {
        expect(polled.length).toBeLessThan(
          Math.ceil((watchList.length * BASELINE_REQUESTS) / MAX_REQUESTS_PER_POLL) + 1,
        );
        const { result, requests } = await poll(harness, route, watchList);
        expect(Result.isSuccess(result)).toBe(true);
        expect(requests.length).toBeLessThanOrEqual(MAX_REQUESTS_PER_POLL - 1 + BASELINE_REQUESTS);
        polled.push(listPolledRepos(requests));
      }

      // Every page counts, so the first poll stops once its baselines have
      // sent the budget.
      expect(polled[0]).toHaveLength(Math.ceil(MAX_REQUESTS_PER_POLL / BASELINE_REQUESTS));
      // Each poll goes on where the last one stopped, and no repository is polled twice.
      expect(polled.flat()).toEqual(watchList);
      expect(harness.events).toEqual([]);

      // After the last repository, the turn wraps around to the first.
      const { requests } = await poll(harness, route, watchList);

      expect(listPolledRepos(requests)).toEqual(watchList);
    });

    it("keeps its turn when the repository it polled last leaves the watch list", async () => {
      const { watchList, route } = buildWatchedRepositories();
      const harness = buildIngestHarness();
      await poll(harness, route, watchList);
      const lastPolled = watchList.filter((repo) => harness.state.has(`repos/${repo}`)).at(-1)!;

      const { requests } = await poll(
        harness,
        route,
        watchList.filter((repo) => repo !== lastPolled),
      );

      expect(readRepoOf(requests[0]!.path)).toBe(watchList[watchList.indexOf(lastPolled) + 1]);
    });
  });
});
