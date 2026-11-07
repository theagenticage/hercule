/**
 * Tests the `entities` feed against a stub of GitHub's GraphQL API: what a
 * poll reports to the host for each outcome of the searches, what it asks
 * GitHub, and how many requests it costs.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { EntityFact } from "@hercule/contract";
import {
  AuthError,
  MAX_ENTITY_OBSERVATIONS,
  PluginError,
  type EntityInventory,
  type EntityObservation,
  type IngestEntities,
  type PollResult,
} from "@hercule/plugin-host";
import { readJsonBody } from "../actions/testing";
import {
  buildIngestHarness,
  expectValidGraphqlFragments,
  runAgainstStub,
  stubGithub,
  TEST_IDENTITY,
  type GithubStub,
  type StubResponse,
} from "../testing";
import { GITHUB_ENTITY_KINDS } from "../entity-kinds";
import { buildItemRef, buildRepoRef } from "../subject";
import { pollGithubFeed } from "./index";

const OPENED = "is:pr is:open archived:false author:@me";
const REVIEW_REQUESTED = "is:pr is:open archived:false review-requested:@me";
const ASSIGNED = "is:issue is:open archived:false assignee:@me";

const VIEWER = { login: "octocat" };

/** A pull request as GitHub's GraphQL returns it. Invented data. */
const pullRequestNode = (number: number, overrides: Record<string, unknown> = {}) => ({
  __typename: "PullRequest",
  number,
  title: `Pull request ${String(number)}`,
  url: `https://github.com/acme/storefront-web/pull/${String(number)}`,
  bodyText: "",
  isDraft: false,
  state: "OPEN",
  updatedAt: "2026-11-01T10:00:00Z",
  author: { login: "octocat" },
  repository: { nameWithOwner: "Acme/storefront-web", createdAt: "2024-01-05T08:00:00Z" },
  headRefName: "feature/slots",
  headRepository: { nameWithOwner: "Acme/storefront-web" },
  reviewDecision: null,
  additions: 120,
  deletions: 30,
  changedFiles: 4,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...overrides,
});

/** An issue as GitHub's GraphQL returns it. Invented data. */
const issueNode = (number: number, overrides: Record<string, unknown> = {}) => ({
  __typename: "Issue",
  number,
  title: `Issue ${String(number)}`,
  url: `https://github.com/acme/storefront-web/issues/${String(number)}`,
  bodyText: "",
  state: "OPEN",
  stateReason: null,
  updatedAt: "2026-11-01T10:00:00Z",
  repository: { nameWithOwner: "Acme/storefront-web", createdAt: "2024-01-05T08:00:00Z" },
  assignees: { totalCount: 1, nodes: [{ login: "octocat" }] },
  labels: { nodes: [{ name: "bug" }, { name: "checkout" }] },
  ...overrides,
});

/** One page of a search. */
interface Page {
  readonly nodes: ReadonlyArray<unknown>;
  /** What GitHub counted for the whole search; defaults to the nodes of this page. */
  readonly issueCount?: number;
}

/**
 * Builds the pages of one search as GitHub sends them. Page `n` is asked for
 * with the cursor `cursor-n`, and every page but the last says another follows.
 */
const searchPages = (pages: ReadonlyArray<Page>): Array<unknown> =>
  pages.map((page, index) => ({
    data: {
      viewer: VIEWER,
      search: {
        issueCount: page.issueCount ?? page.nodes.length,
        pageInfo: {
          hasNextPage: index < pages.length - 1,
          endCursor: `cursor-${String(index + 1)}`,
        },
        nodes: page.nodes,
      },
    },
  }));

interface GraphqlBody {
  readonly query: string;
  readonly variables: Record<string, string | number | null>;
}

/**
 * Builds a stub that answers each search by its qualifier and cursor from
 * `searches`, answers an alias query with `refresh`, and answers an
 * unlisted search with an empty result.
 */
const stubGraphql = (
  searches: Readonly<Record<string, ReadonlyArray<unknown>>>,
  refresh: StubResponse = { status: 200, body: { data: { viewer: VIEWER } } },
): GithubStub =>
  stubGithub((request) => {
    const body = readJsonBody(request) as GraphqlBody;
    if (body.query.includes("repository(owner:")) return refresh;
    const pages = searches[String(body.variables["query"])] ?? searchPages([{ nodes: [] }]);
    const cursor = body.variables["after"];
    const index = cursor === null ? 0 : Number(String(cursor).replace("cursor-", ""));
    return { status: 200, body: pages[index] };
  });

/** What a fake host was told. */
interface Reported {
  readonly reconciled: Array<EntityInventory>;
  readonly refreshed: Array<ReadonlyArray<EntityObservation>>;
  readonly missing: Array<{ readonly ref: string; readonly reason: string }>;
  readonly listed: Array<{ readonly kind: string; readonly limit: number }>;
}

/** Builds the `entities` member of an ingest context, which records every call. */
const fakeEntities = (
  wanted: Readonly<Record<string, ReadonlyArray<string>>> = {},
): { readonly entities: IngestEntities; readonly reported: Reported } => {
  const reported: Reported = { reconciled: [], refreshed: [], missing: [], listed: [] };
  return {
    reported,
    entities: {
      // Like the host, refuses a call with more observations than it takes.
      reconcile: (inventory) =>
        inventory.observations.length > MAX_ENTITY_OBSERVATIONS
          ? Effect.fail(new PluginError({ message: "too many observations in one call" }))
          : Effect.sync(() => void reported.reconciled.push(inventory)),
      refresh: (observations) => Effect.sync(() => void reported.refreshed.push(observations)),
      listWanted: (kind, limit) =>
        Effect.sync(() => {
          reported.listed.push({ kind, limit });
          return wanted[kind] ?? [];
        }),
      reportMissing: (ref, reason) =>
        Effect.sync(() => void reported.missing.push({ ref, reason })),
    },
  };
};

/** Polls the entities feed once against `stub`, with a fake host. */
const pollEntitiesFeed = async (
  stub: GithubStub,
  wanted: Readonly<Record<string, ReadonlyArray<string>>> = {},
): Promise<{
  readonly result: Result.Result<PollResult, AuthError | PluginError>;
  readonly reported: Reported;
}> => {
  const { entities, reported } = fakeEntities(wanted);
  const context = { ...buildIngestHarness().context, entities };
  const result = await runAgainstStub(pollGithubFeed("entities", {}, context, TEST_IDENTITY), stub);
  return { result, reported };
};

/** Returns what the poll reported for one kind of entity. */
const reconciledKind = (reported: Reported, kind: string): EntityInventory => {
  const inventory = reported.reconciled.find((candidate) => candidate.kind === kind);
  if (inventory === undefined) throw new Error(`nothing was reconciled for ${kind}`);
  return inventory;
};

/** Narrows an observation to the full variant, which has concerns. */
const full = (observation: EntityObservation | undefined) => {
  if (observation === undefined || observation.partial === true) {
    throw new Error("expected a full observation");
  }
  return observation;
};

describe("the entities feed's inventory", () => {
  it("pages a search to its end and reports every result", async () => {
    const first = Array.from({ length: 100 }, (_, index) => pullRequestNode(index + 1));
    const second = Array.from({ length: 30 }, (_, index) => pullRequestNode(index + 101));
    const stub = stubGraphql({
      [OPENED]: searchPages([
        { nodes: first, issueCount: 130 },
        { nodes: second, issueCount: 130 },
      ]),
    });

    const { result, reported } = await pollEntitiesFeed(stub);

    expect(Result.isSuccess(result)).toBe(true);
    const inventory = reconciledKind(reported, "pull-request");
    expect(inventory.observations).toHaveLength(130);
    expect(inventory.complete).toBe(true);
  });

  it("reports nothing when the last page fails", async () => {
    const [firstPage] = searchPages([{ nodes: [pullRequestNode(1)] }, { nodes: [] }]);
    const stub = stubGithub((request) => {
      const body = readJsonBody(request) as GraphqlBody;
      return body.variables["after"] === "cursor-1"
        ? { status: 502, body: { message: "Bad Gateway" } }
        : { status: 200, body: firstPage };
    });

    const { result, reported } = await pollEntitiesFeed(stub);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(reported.reconciled).toEqual([]);
    expect(reported.listed).toEqual([]);
  });

  it("reports nothing and asks for a wait when GitHub rate limits a search", async () => {
    const stub = stubGithub(() => ({
      status: 429,
      body: { message: "rate limit" },
      headers: { "retry-after": "90" },
    }));

    const { result, reported } = await pollEntitiesFeed(stub);

    expect(Result.getOrThrow(result)).toEqual({ nextAfterSeconds: 90 });
    expect(reported.reconciled).toEqual([]);
  });

  it("treats a GraphQL rate limit inside a 200 as a wait too", async () => {
    const stub = stubGithub(() => ({
      status: 200,
      body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
      headers: { "retry-after": "45" },
    }));

    const { result, reported } = await pollEntitiesFeed(stub);

    expect(Result.getOrThrow(result)).toEqual({ nextAfterSeconds: 45 });
    expect(reported.reconciled).toEqual([]);
  });

  it("fails the poll and reports nothing when an answer carries errors", async () => {
    const stub = stubGithub(() => ({
      status: 200,
      body: {
        data: { viewer: VIEWER },
        errors: [{ type: "FORBIDDEN", message: "Resource protected by SAML enforcement" }],
      },
    }));

    const { result, reported } = await pollEntitiesFeed(stub);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(Result.isFailure(result) && result.failure.message).toContain("SAML");
    expect(reported.reconciled).toEqual([]);
  });

  it("fails with an AuthError when GitHub rejects the token", async () => {
    const stub = stubGithub(() => ({ status: 401, body: { message: "Bad credentials" } }));

    const { result, reported } = await pollEntitiesFeed(stub);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(AuthError);
    expect(reported.reconciled).toEqual([]);
  });

  it("marks a kind incomplete when GitHub counts more results than it let the search read", async () => {
    const stub = stubGraphql({
      [OPENED]: searchPages([{ nodes: [pullRequestNode(1)], issueCount: 1500 }]),
      [ASSIGNED]: searchPages([{ nodes: [issueNode(7)] }]),
    });

    const { reported } = await pollEntitiesFeed(stub);

    expect(reconciledKind(reported, "pull-request").complete).toBe(false);
    expect(reconciledKind(reported, "issue").complete).toBe(true);
  });

  it("reports one pull request found by two searches once, with both concerns", async () => {
    const stub = stubGraphql({
      [OPENED]: searchPages([{ nodes: [pullRequestNode(5)] }]),
      [REVIEW_REQUESTED]: searchPages([{ nodes: [pullRequestNode(5), pullRequestNode(6)] }]),
    });

    const { reported } = await pollEntitiesFeed(stub);

    const observations = reconciledKind(reported, "pull-request").observations.map(full);
    expect(observations.map((observation) => [observation.title, observation.concerns])).toEqual([
      ["Pull request 5", ["opened", "review-requested"]],
      ["Pull request 6", ["review-requested"]],
    ]);
  });

  it("reports each ref exactly as the signals build it, and each item as part of its repository", async () => {
    const stub = stubGraphql({
      [OPENED]: searchPages([{ nodes: [pullRequestNode(87)] }]),
      [ASSIGNED]: searchPages([{ nodes: [issueNode(42)] }]),
    });

    const { reported } = await pollEntitiesFeed(stub);

    const pullRequest = full(reconciledKind(reported, "pull-request").observations[0]);
    const issue = full(reconciledKind(reported, "issue").observations[0]);
    expect(pullRequest.ref).toBe(
      buildItemRef({ repo: "Acme/storefront-web", kind: "pr", number: 87 }),
    );
    expect(issue.ref).toBe(
      buildItemRef({ repo: "Acme/storefront-web", kind: "issue", number: 42 }),
    );
    for (const observation of [pullRequest, issue]) {
      expect(observation.relations).toEqual({
        complete: true,
        partOf: [buildRepoRef("acme/storefront-web")],
        linked: [],
      });
    }
  });

  it("reports an item's description as a text for the host to search, and no text for an empty one", async () => {
    const stub = stubGraphql({
      [OPENED]: searchPages([
        {
          nodes: [
            pullRequestNode(1, { bodyText: "Part of SHOP-123, see the ticket." }),
            pullRequestNode(2, { bodyText: "   " }),
          ],
        },
      ]),
      [ASSIGNED]: searchPages([{ nodes: [issueNode(3, { bodyText: "Blocked by SHOP-9" })] }]),
    });

    const { reported } = await pollEntitiesFeed(stub);

    const [described, empty] = reconciledKind(reported, "pull-request").observations.map(full);
    expect(described?.texts).toEqual([
      {
        evidenceKey: "description",
        text: "Part of SHOP-123, see the ticket.",
        revision: "2026-11-01T10:00:00Z",
      },
    ]);
    expect(empty?.texts).toBeUndefined();
    expect(full(reconciledKind(reported, "issue").observations[0]).texts).toMatchObject([
      { evidenceKey: "description", text: "Blocked by SHOP-9" },
    ]);
    expect(reconciledKind(reported, "repository").observations[0]).not.toHaveProperty("texts");
    expectValidGraphqlFragments(stub);
  });

  it("reports each repository seen once, as a context record with no concerns", async () => {
    const stub = stubGraphql({
      [OPENED]: searchPages([{ nodes: [pullRequestNode(1), pullRequestNode(2)] }]),
      [ASSIGNED]: searchPages([{ nodes: [issueNode(3)] }]),
    });

    const { reported } = await pollEntitiesFeed(stub);

    expect(reported.reconciled.map((inventory) => inventory.kind)).toEqual([
      "repository",
      "pull-request",
      "issue",
    ]);
    expect(reconciledKind(reported, "repository")).toMatchObject({
      complete: true,
      observations: [
        {
          kind: "repository",
          ref: "github:repo:acme/storefront-web",
          title: "Acme/storefront-web",
          url: "https://github.com/acme/storefront-web",
          concerns: [],
        },
      ],
    });
  });

  it("reports a pull request's facts, its target and its head, and a fork whose head is gone", async () => {
    const stub = stubGraphql({
      [OPENED]: searchPages([
        {
          nodes: [
            pullRequestNode(1, { headRepository: { nameWithOwner: "Octocat/Storefront-Web" } }),
            pullRequestNode(2, { headRepository: null }),
          ],
        },
      ]),
    });

    const { reported } = await pollEntitiesFeed(stub);

    const [fork, deleted] = reconciledKind(reported, "pull-request").observations.map(full);
    expect(fork).toMatchObject({
      lifecycle: "open",
      status: "open",
      ownedByYou: true,
      fields: {
        number: 1,
        repo: "acme/storefront-web",
        author: "octocat",
        diff: "+120 -30",
        files: 4,
      },
      repository: {
        target: { remote: "github.com/acme/storefront-web" },
        head: { remote: "github.com/octocat/storefront-web", branch: "feature/slots" },
      },
    });
    expect(deleted?.repository).toEqual({ target: { remote: "github.com/acme/storefront-web" } });
  });

  it.each([
    ["a draft", { isDraft: true }, "draft"],
    [
      "failed checks",
      { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } },
      "failing",
    ],
    ["changes requested", { reviewDecision: "CHANGES_REQUESTED" }, "changes"],
    ["an approval", { reviewDecision: "APPROVED" }, "approved"],
    [
      "failed checks and an approval",
      {
        reviewDecision: "APPROVED",
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "ERROR" } } }] },
      },
      "failing",
    ],
    ["no checks at all", { commits: { nodes: [] } }, "open"],
  ])("gives %s the status %s", async (_, overrides, status) => {
    const stub = stubGraphql({
      [OPENED]: searchPages([{ nodes: [pullRequestNode(1, overrides)] }]),
    });

    const { reported } = await pollEntitiesFeed(stub);

    expect(full(reconciledKind(reported, "pull-request").observations[0]).status).toBe(status);
  });

  it("owns every issue the assigned search finds, even when the user is past the assignees read", async () => {
    const stub = stubGraphql({
      [ASSIGNED]: searchPages([
        {
          nodes: [
            issueNode(1),
            issueNode(2, {
              assignees: {
                totalCount: 7,
                nodes: ["a", "b", "c", "d", "e"].map((login) => ({ login })),
              },
            }),
          ],
        },
      ]),
    });

    const { reported } = await pollEntitiesFeed(stub);

    const issues = reconciledKind(reported, "issue").observations.map(full);
    expect(issues.map((issue) => issue.ownedByYou)).toEqual([true, true]);
    expect(issues[0]).toMatchObject({
      fields: {
        number: 1,
        repo: "acme/storefront-web",
        assignee: "octocat",
        labels: "bug, checkout",
      },
      concerns: ["assigned"],
    });
    expectValidGraphqlFragments(stub);
  });

  it("never reports more than the host takes in one call, and keeps each work kind whole", async () => {
    // The most the searches can find: 1,000 per search, each item in its own repository.
    const searchOf = (build: (number: number) => unknown, first: number) =>
      searchPages(
        Array.from({ length: 10 }, (_, page) => ({
          nodes: Array.from({ length: 100 }, (__, index) => build(first + page * 100 + index)),
          issueCount: 1000,
        })),
      );
    const inRepository = (number: number) => ({
      nameWithOwner: `Acme/repo-${String(number)}`,
      createdAt: "2024-01-05T08:00:00Z",
    });
    const stub = stubGraphql({
      [OPENED]: searchOf((n) => pullRequestNode(n, { repository: inRepository(n) }), 0),
      [REVIEW_REQUESTED]: searchOf(
        (n) => pullRequestNode(n, { repository: inRepository(n) }),
        1000,
      ),
      [ASSIGNED]: searchOf((n) => issueNode(n, { repository: inRepository(n) }), 2000),
    });

    const { result, reported } = await pollEntitiesFeed(stub);

    expect(Result.isSuccess(result)).toBe(true);
    // The repositories go in one complete call, because a second complete call
    // would unlist what the first one listed. The first 2,000 by name are
    // listed; the other 1,000 are left to the host's refresh of wanted refs.
    const repositories = reported.reconciled.filter(({ kind }) => kind === "repository");
    expect(repositories.map(({ complete }) => complete)).toEqual([true]);
    const listed = repositories[0]!.observations.map(({ ref }) => ref);
    expect(listed).toHaveLength(2000);
    expect(listed).toEqual([...listed].sort());
    expect(reconciledKind(reported, "pull-request").observations).toHaveLength(2000);
    expect(reconciledKind(reported, "issue").observations).toHaveLength(1000);
  });

  it("keeps an issue's labels within the public bound of a word fact", async () => {
    const names = ["a".repeat(50), "b".repeat(50), "c", "d"];
    const stub = stubGraphql({
      [ASSIGNED]: searchPages([
        {
          nodes: [
            issueNode(1, { labels: { nodes: names.map((name) => ({ name })) } }),
            issueNode(2, { labels: { nodes: [{ name: "bug" }, { name: "checkout" }] } }),
            issueNode(3, { labels: { nodes: [] } }),
          ],
        },
      ]),
    });

    const { reported } = await pollEntitiesFeed(stub);

    const [crowded, short, none] = reconciledKind(reported, "issue").observations.map(full);
    expect(crowded?.fields["labels"]).toBe(`${"a".repeat(50)} +3`);
    expect(short?.fields["labels"]).toBe("bug, checkout");
    expect(none?.fields["labels"]).toBeNull();
    // The real declaration shows the field as a word fact, and the contract bounds that text.
    const issueKind = GITHUB_ENTITY_KINDS.find((kind) => kind.word === "issue");
    expect(issueKind?.facts).toContainEqual({ field: "labels", form: "word" });
    const decodeFact = Schema.decodeUnknownSync(EntityFact);
    expect(() => decodeFact({ form: "word", text: crowded?.fields["labels"] })).not.toThrow();
  });
});

describe("the fragment check of the tests", () => {
  const check = (query: string) => {
    const stub = stubGithub(() => ({ status: 200, body: {} }));
    stub.requests.push(
      HttpClientRequest.post("https://api.github.com/graphql").pipe(
        HttpClientRequest.bodyJsonUnsafe({ query }),
      ),
    );
    return () => expectValidGraphqlFragments(stub);
  };

  it("refuses a fragment that is defined and never spread, and one spread and never defined", () => {
    const spread = "query { a { ...One } }\nfragment One on A { x }";
    expect(check(spread)).not.toThrow();
    expect(check(`${spread}\nfragment Two on B { y }`)).toThrow("Two is defined but never used");
    expect(check("query { a { ...One } }")).toThrow("One is spread but not defined");
  });

  it("refuses a fragment only another unused fragment spreads", () => {
    expect(
      check(
        "query { a { ...One } }\nfragment One on A { x }\nfragment Two on B { ...Three }\nfragment Three on C { z }",
      ),
    ).toThrow("never used");
  });
});

describe("the entities feed's request count", () => {
  it("sends one request per page of each concern, and one more for the refresh", async () => {
    const stub = stubGraphql({
      [OPENED]: searchPages([
        { nodes: [pullRequestNode(1)], issueCount: 2 },
        { nodes: [pullRequestNode(2)], issueCount: 2 },
      ]),
    });

    await pollEntitiesFeed(stub, { "pull-request": ["github:pr:acme/storefront-web#9"] });

    // Two pages of the first search, one page each of the others, one refresh.
    expect(stub.requests).toHaveLength(2 + 1 + 1 + 1);
  });

  it("sends no refresh request when the host wants nothing read", async () => {
    const stub = stubGraphql({});

    const { reported } = await pollEntitiesFeed(stub);

    expect(stub.requests).toHaveLength(3);
    expect(reported.listed).toEqual([
      { kind: "pull-request", limit: 50 },
      { kind: "issue", limit: 50 },
      { kind: "repository", limit: 50 },
    ]);
  });
});

describe("the entities feed's refresh", () => {
  const MERGED_REF = "github:pr:acme/storefront-web#9";

  it("reads a pull request that left the open searches and reports it merged", async () => {
    const stub = stubGraphql(
      {},
      {
        status: 200,
        body: {
          data: {
            viewer: VIEWER,
            t0: { pullRequest: pullRequestNode(9, { state: "MERGED" }) },
          },
        },
      },
    );

    const { reported } = await pollEntitiesFeed(stub, { "pull-request": [MERGED_REF] });
    expectValidGraphqlFragments(stub);

    expect(reported.refreshed).toHaveLength(1);
    expect(full(reported.refreshed[0]?.[0])).toMatchObject({
      ref: MERGED_REF,
      lifecycle: "completed",
      status: "merged",
      reason: "merged",
      concerns: [],
    });
  });

  it("reads a pull request closed without a merge as abandoned", async () => {
    const stub = stubGraphql(
      {},
      {
        status: 200,
        body: {
          data: { viewer: VIEWER, t0: { pullRequest: pullRequestNode(9, { state: "CLOSED" }) } },
        },
      },
    );

    const { reported } = await pollEntitiesFeed(stub, { "pull-request": [MERGED_REF] });
    expectValidGraphqlFragments(stub);

    expect(full(reported.refreshed[0]?.[0])).toMatchObject({
      lifecycle: "abandoned",
      status: "closed",
    });
  });

  it.each([
    ["OPEN", null, "open", "open"],
    ["CLOSED", "COMPLETED", "completed", "closed"],
    ["CLOSED", "NOT_PLANNED", "abandoned", "closed"],
    ["CLOSED", "DUPLICATE", "abandoned", "closed"],
    ["CLOSED", null, "completed", "closed"],
  ])(
    "reads an issue that is %s with the reason %s as %s",
    async (state, stateReason, lifecycle, status) => {
      const stub = stubGraphql(
        {},
        {
          status: 200,
          body: { data: { viewer: VIEWER, t0: { issue: issueNode(4, { state, stateReason }) } } },
        },
      );

      const { reported } = await pollEntitiesFeed(stub, {
        issue: ["github:issue:acme/storefront-web#4"],
      });
      expectValidGraphqlFragments(stub);

      expect(full(reported.refreshed[0]?.[0])).toMatchObject({ lifecycle, status });
    },
  );

  it("reads a repository that is wanted", async () => {
    const stub = stubGraphql(
      {},
      {
        status: 200,
        body: {
          data: {
            viewer: VIEWER,
            t0: { nameWithOwner: "Acme/storefront-web", createdAt: "2024-01-05T08:00:00Z" },
          },
        },
      },
    );

    const { reported } = await pollEntitiesFeed(stub, {
      repository: ["github:repo:acme/storefront-web"],
    });
    expectValidGraphqlFragments(stub);

    expect(reported.refreshed[0]?.[0]).toMatchObject({ kind: "repository", concerns: [] });
  });

  it("reports a ref GitHub answers with null as inaccessible, never deleted, and still refreshes the rest", async () => {
    const stub = stubGraphql(
      {},
      {
        status: 200,
        body: {
          data: {
            viewer: VIEWER,
            t0: { pullRequest: null },
            t1: { issue: issueNode(4) },
          },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest" }],
        },
      },
    );

    const { result, reported } = await pollEntitiesFeed(stub, {
      "pull-request": [MERGED_REF],
      issue: ["github:issue:acme/storefront-web#4"],
    });
    expectValidGraphqlFragments(stub);

    expect(Result.isSuccess(result)).toBe(true);
    expect(reported.missing).toEqual([{ ref: MERGED_REF, reason: "inaccessible" }]);
    expect(reported.refreshed[0]).toHaveLength(1);
  });

  describe("who an issue is owned by", () => {
    const readIssue = async (assignees: {
      totalCount: number;
      nodes: Array<{ login: string }>;
    }) => {
      const stub = stubGraphql(
        {},
        {
          status: 200,
          body: { data: { viewer: VIEWER, t0: { issue: issueNode(4, { assignees }) } } },
        },
      );
      const { reported } = await pollEntitiesFeed(stub, {
        issue: ["github:issue:acme/storefront-web#4"],
      });
      return full(reported.refreshed[0]?.[0]);
    };

    it("is the user when the user is among the assignees", async () => {
      const issue = await readIssue({
        totalCount: 2,
        nodes: [{ login: "marta-vos" }, { login: "OctoCat" }],
      });

      expect(issue.ownedByYou).toBe(true);
    });

    it("is not the user when every assignee was read and the user is not one", async () => {
      const issue = await readIssue({ totalCount: 1, nodes: [{ login: "marta-vos" }] });

      expect(issue.ownedByYou).toBe(false);
    });

    it("says nothing when the assignees were cut and the user is not among those read", async () => {
      const issue = await readIssue({
        totalCount: 6,
        nodes: ["a", "b", "c", "d", "e"].map((login) => ({ login })),
      });

      expect("ownedByYou" in issue).toBe(false);
    });
  });

  it("keeps the stored inventory when the refresh fails", async () => {
    const stub = stubGraphql(
      { [OPENED]: searchPages([{ nodes: [pullRequestNode(1)] }]) },
      { status: 502, body: { message: "Bad Gateway" } },
    );

    const { result, reported } = await pollEntitiesFeed(stub, { "pull-request": [MERGED_REF] });

    expect(Result.isFailure(result)).toBe(true);
    expect(reported.reconciled).toHaveLength(3);
    expect(reported.refreshed).toEqual([]);
  });
});
