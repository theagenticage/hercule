/**
 * Tests how the Add button on Work finds GitHub things: recognizing pasted
 * text, searching, and reading one item, the last two against a stub of
 * GitHub's GraphQL API.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { AuthError, PluginError } from "@hercule/plugin-host";
import { readJsonBody } from "./actions/testing";
import { TEST_TOKEN } from "./actions/testing";
import { recognizeGithubItems, resolveItem, searchItems } from "./entity-lookup";
import {
  expectValidGraphqlFragments,
  runAgainstStub,
  stubGithub,
  type StubResponse,
} from "./testing";

const REPOSITORY = { nameWithOwner: "Acme/storefront-web", createdAt: "2024-01-05T08:00:00Z" };

const pullRequest = (number: number) => ({
  __typename: "PullRequest",
  number,
  title: `Pull request ${String(number)}`,
  url: `https://github.com/acme/storefront-web/pull/${String(number)}`,
  isDraft: false,
  state: "OPEN",
  updatedAt: "2026-11-01T10:00:00Z",
  author: { login: "marta-vos" },
  repository: REPOSITORY,
  headRefName: "feature/slots",
  headRepository: { nameWithOwner: "Acme/storefront-web" },
  reviewDecision: null,
  additions: 3,
  deletions: 1,
  changedFiles: 1,
  commits: { nodes: [] },
});

const issue = (number: number) => ({
  __typename: "Issue",
  number,
  title: `Issue ${String(number)}`,
  url: `https://github.com/acme/storefront-web/issues/${String(number)}`,
  state: "OPEN",
  stateReason: null,
  updatedAt: "2026-11-01T10:00:00Z",
  repository: REPOSITORY,
  assignees: { totalCount: 0, nodes: [] },
  labels: { nodes: [] },
});

const answer = (data: unknown): StubResponse => ({
  status: 200,
  body: { data: { viewer: { login: "octocat" }, ...(data as object) } },
});

describe("recognizing GitHub text", () => {
  it("recognizes the address of a pull request and of an issue, with the same ref the signals use", () => {
    expect(
      recognizeGithubItems(
        "see https://github.com/Acme/storefront-web/pull/87/files and https://github.com/acme/storefront-web/issues/42.",
      ),
    ).toEqual([
      {
        recognized: "ref",
        form: "url",
        ref: "github:pr:acme/storefront-web#87",
        kind: "pull-request",
      },
      {
        recognized: "ref",
        form: "url",
        ref: "github:issue:acme/storefront-web#42",
        kind: "issue",
      },
    ]);
  });

  it("recognizes owner/repo#number as scoped, with no kind, because it names an issue or a pull request", () => {
    expect(recognizeGithubItems("fixes Acme/storefront-web#87")).toEqual([
      { recognized: "scoped", form: "identifier", identifier: "acme/storefront-web#87" },
    ]);
  });

  it("recognizes nothing in a bare #87, in other text or in other addresses", () => {
    expect(recognizeGithubItems("#87")).toEqual([]);
    expect(recognizeGithubItems("no reference here, ticket SHOP-123")).toEqual([]);
    expect(recognizeGithubItems("https://example.com/acme/storefront-web/pull/87")).toEqual([]);
    expect(recognizeGithubItems("https://github.com/acme/storefront-web")).toEqual([]);
  });

  it("names an item once however often the text repeats it, and does not read an address twice", () => {
    expect(
      recognizeGithubItems(
        "https://github.com/acme/storefront-web/pull/87#issuecomment-5 acme/storefront-web#9 acme/storefront-web#9",
      ),
    ).toHaveLength(2);
  });

  it("returns at most 20 recognitions", () => {
    const text = Array.from(
      { length: 30 },
      (_, index) => `acme/storefront-web#${String(index + 1)}`,
    );

    expect(recognizeGithubItems(text.join(" "))).toHaveLength(20);
  });
});

describe("searching GitHub", () => {
  it("sends one search request and reads at most the limit", async () => {
    const stub = stubGithub(() =>
      answer({
        search: { nodes: [pullRequest(1), issue(2), null, pullRequest(3)] },
      }),
    );

    const result = await runAgainstStub(searchItems(TEST_TOKEN, { text: "slots", limit: 2 }), stub);

    expect(stub.requests).toHaveLength(1);
    expectValidGraphqlFragments(stub);
    expect(Result.getOrThrow(result).map((found) => found.ref)).toEqual([
      "github:pr:acme/storefront-web#1",
      "github:issue:acme/storefront-web#2",
    ]);
    expect(readJsonBody(stub.requests[0])).toMatchObject({
      variables: { query: "slots", first: 2 },
    });
  });

  it("narrows the search to the repository of a scope", async () => {
    const stub = stubGithub(() => answer({ search: { nodes: [] } }));

    await runAgainstStub(
      searchItems(TEST_TOKEN, {
        text: "slots",
        scopeRef: "github:repo:Acme/storefront-web",
        limit: 20,
      }),
      stub,
    );

    expect(readJsonBody(stub.requests[0])).toMatchObject({
      variables: { query: "slots repo:acme/storefront-web" },
    });
  });

  it("reads the item itself when the text is a bare number and a scope is chosen", async () => {
    const stub = stubGithub(() => answer({ repository: { issueOrPullRequest: pullRequest(87) } }));

    const result = await runAgainstStub(
      searchItems(TEST_TOKEN, {
        text: "#87",
        scopeRef: "github:repo:acme/storefront-web",
        limit: 20,
      }),
      stub,
    );

    expect(stub.requests).toHaveLength(1);
    expectValidGraphqlFragments(stub);
    expect(Result.getOrThrow(result).map((found) => found.ref)).toEqual([
      "github:pr:acme/storefront-web#87",
    ]);
    expect(readJsonBody(stub.requests[0])).toMatchObject({
      variables: { owner: "acme", name: "storefront-web", number: 87 },
    });
  });

  it("refuses a scope that is not a repository, saying why", async () => {
    const stub = stubGithub(() => answer({ search: { nodes: [] } }));

    const result = await runAgainstStub(
      searchItems(TEST_TOKEN, { text: "slots", scopeRef: "linear:project:abc", limit: 20 }),
      stub,
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(stub.requests).toEqual([]);
  });

  it("fails with an AuthError when GitHub rejects the token", async () => {
    const stub = stubGithub(() => ({ status: 401, body: { message: "Bad credentials" } }));

    const result = await runAgainstStub(
      searchItems(TEST_TOKEN, { text: "slots", limit: 20 }),
      stub,
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(AuthError);
  });
});

describe("resolving a recognition", () => {
  it("reads an issue ref with a document that defines only the fragments it uses", async () => {
    const stub = stubGithub(() => answer({ t0: { issue: issue(42) } }));

    await runAgainstStub(
      resolveItem(TEST_TOKEN, {
        recognized: "ref",
        form: "url",
        ref: "github:issue:acme/storefront-web#42",
        kind: "issue",
      }),
      stub,
    );

    expectValidGraphqlFragments(stub);
  });

  it("reads the item a ref names", async () => {
    const stub = stubGithub(() => answer({ t0: { pullRequest: pullRequest(87) } }));

    const result = await runAgainstStub(
      resolveItem(TEST_TOKEN, {
        recognized: "ref",
        form: "url",
        ref: "github:pr:acme/storefront-web#87",
        kind: "pull-request",
      }),
      stub,
    );

    expectValidGraphqlFragments(stub);
    expect(Result.getOrThrow(result)).toMatchObject({
      found: { kind: "pull-request", ref: "github:pr:acme/storefront-web#87", concerns: [] },
    });
  });

  it("reads the item a scoped identifier names, whichever kind it is", async () => {
    const stub = stubGithub(() => answer({ repository: { issueOrPullRequest: issue(42) } }));

    const result = await runAgainstStub(
      resolveItem(TEST_TOKEN, {
        recognized: "scoped",
        form: "identifier",
        identifier: "acme/storefront-web#42",
      }),
      stub,
    );

    expectValidGraphqlFragments(stub);
    expect(Result.getOrThrow(result)).toMatchObject({
      found: { kind: "issue", ref: "github:issue:acme/storefront-web#42" },
    });
  });

  it("says unknown, never not-found or inaccessible, when GitHub answers null", async () => {
    const stub = stubGithub(() => ({
      status: 200,
      body: {
        data: { viewer: { login: "octocat" }, repository: null },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
      },
    }));

    const result = await runAgainstStub(
      resolveItem(TEST_TOKEN, {
        recognized: "scoped",
        form: "identifier",
        identifier: "acme/storefront-web#42",
      }),
      stub,
    );

    expect(Result.getOrThrow(result)).toEqual({ missing: "unknown" });
  });
});
