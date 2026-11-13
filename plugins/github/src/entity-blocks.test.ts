/**
 * Tests the blocks the Inbox pane draws for a pull request or an issue,
 * against a stub of GitHub's GraphQL API.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { AuthError, PluginError } from "@hercule/plugin-host";
import { readJsonBody, TEST_TOKEN } from "./actions/testing";
import { readItemBlocks } from "./entity-blocks";
import { runAgainstStub, stubGithub, type StubResponse } from "./testing";

const PULL_REF = "github:pr:acme/storefront-web#87";
const ISSUE_REF = "github:issue:acme/storefront-web#42";

const answer = (repository: unknown): StubResponse => ({
  status: 200,
  body: { data: { repository } },
});

const pullRequest = (overrides: Record<string, unknown> = {}) => ({
  body: "Adds the delivery cost.\n",
  headRefName: "mei/delivery-cost-step",
  baseRefName: "main",
  changedFiles: 6,
  additions: 142,
  deletions: 38,
  commits: {
    totalCount: 4,
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              checkRunCountsByState: [
                { state: "FAILURE", count: 1 },
                { state: "SUCCESS", count: 1 },
                { state: "IN_PROGRESS", count: 1 },
              ],
              statusContextCountsByState: [{ state: "SUCCESS", count: 1 }],
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "e2e / checkout-eu",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  detailsUrl: "https://github.com/acme/storefront-web/runs/1",
                },
                {
                  __typename: "CheckRun",
                  name: "unit",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  detailsUrl: null,
                },
                {
                  __typename: "CheckRun",
                  name: "lint",
                  status: "IN_PROGRESS",
                  conclusion: null,
                  detailsUrl: null,
                },
                {
                  __typename: "StatusContext",
                  context: "deploy/preview",
                  state: "SUCCESS",
                  targetUrl: null,
                },
              ],
            },
          },
        },
      },
    ],
  },
  ...overrides,
});

const issue = (overrides: Record<string, unknown> = {}) => ({
  body: "The spinner never stops.",
  comments: { totalCount: 3 },
  milestone: { title: "Checkout revamp" },
  ...overrides,
});

describe("reading the blocks of a pull request", () => {
  it("returns the change with its check counts, the checks that need attention, then the description, in one request", async () => {
    const stub = stubGithub(() => answer({ pullRequest: pullRequest() }));

    const result = await runAgainstStub(readItemBlocks(TEST_TOKEN, PULL_REF), stub);

    expect(stub.requests).toHaveLength(1);
    expect(readJsonBody(stub.requests[0])).toMatchObject({
      variables: { owner: "acme", name: "storefront-web", number: 87 },
    });
    expect(Result.getOrThrow(result)).toEqual([
      {
        type: "change",
        from: "mei/delivery-cost-step",
        to: "main",
        files: 6,
        additions: 142,
        deletions: 38,
        commits: 4,
        checks: { passed: 2, failed: 1, pending: 1 },
      },
      {
        type: "checks",
        rows: [
          {
            name: "e2e / checkout-eu",
            state: "failed",
            url: "https://github.com/acme/storefront-web/runs/1",
          },
          { name: "lint", state: "pending" },
        ],
        passed: 2,
        omitted: 0,
      },
      { type: "text", markdown: "Adds the delivery cost." },
    ]);
  });

  it("leaves out the checks block when nothing failed or waits, and the check counts when there are no checks", async () => {
    const stub = stubGithub(() =>
      answer({
        pullRequest: pullRequest({
          body: "",
          commits: { totalCount: 1, nodes: [{ commit: { statusCheckRollup: null } }] },
        }),
      }),
    );

    const blocks = Result.getOrThrow(
      await runAgainstStub(readItemBlocks(TEST_TOKEN, PULL_REF), stub),
    );

    expect(blocks).toEqual([
      {
        type: "change",
        from: "mei/delivery-cost-step",
        to: "main",
        files: 6,
        additions: 142,
        deletions: 38,
        commits: 1,
      },
    ]);
  });

  it("cuts a description over 32 KB and says it was cut", async () => {
    const stub = stubGithub(() =>
      answer({ pullRequest: pullRequest({ body: "x".repeat(40 * 1024) }) }),
    );

    const blocks = Result.getOrThrow(
      await runAgainstStub(readItemBlocks(TEST_TOKEN, PULL_REF), stub),
    );

    const markdown = String(blocks.find((block) => block.type === "text")?.["markdown"]);
    expect(markdown.length).toBeLessThanOrEqual(32 * 1024);
    expect(markdown).toContain("Open it on GitHub to read the rest.");
  });
});

it("counts every check, not only the 100 listed: a failing 101st check still shows", async () => {
  const stub = stubGithub(() =>
    answer({
      pullRequest: pullRequest({
        commits: {
          totalCount: 2,
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    checkRunCountsByState: [
                      { state: "SUCCESS", count: 100 },
                      { state: "TIMED_OUT", count: 1 },
                    ],
                    statusContextCountsByState: [],
                    nodes: Array.from({ length: 100 }, (_, index) => ({
                      __typename: "CheckRun",
                      name: `job ${String(index)}`,
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      detailsUrl: null,
                    })),
                  },
                },
              },
            },
          ],
        },
      }),
    }),
  );

  const blocks = Result.getOrThrow(
    await runAgainstStub(readItemBlocks(TEST_TOKEN, PULL_REF), stub),
  );

  expect(blocks[0]).toMatchObject({ checks: { passed: 100, failed: 1, pending: 0 } });
  expect(blocks[1]).toEqual({ type: "checks", rows: [], passed: 100, omitted: 1 });
});

describe("reading the blocks of an issue", () => {
  it("returns the description, then the milestone and the number of comments", async () => {
    const stub = stubGithub(() => answer({ issue: issue() }));

    const result = await runAgainstStub(readItemBlocks(TEST_TOKEN, ISSUE_REF), stub);

    expect(Result.getOrThrow(result)).toEqual([
      { type: "text", markdown: "The spinner never stops." },
      {
        type: "fields",
        rows: [
          { label: "Milestone", value: "Checkout revamp" },
          { label: "Comments", value: "3" },
        ],
      },
    ]);
  });

  it("returns no blocks for an issue with no description, milestone or comments", async () => {
    const stub = stubGithub(() =>
      answer({ issue: issue({ body: "", milestone: null, comments: { totalCount: 0 } }) }),
    );

    const result = await runAgainstStub(readItemBlocks(TEST_TOKEN, ISSUE_REF), stub);

    expect(Result.getOrThrow(result)).toEqual([]);
  });
});

describe("failing to read blocks", () => {
  it("fails with an AuthError when GitHub rejects the token, without the token in the message", async () => {
    const stub = stubGithub(() => ({ status: 401, body: { message: "Bad credentials" } }));

    const result = await runAgainstStub(readItemBlocks(TEST_TOKEN, PULL_REF), stub);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(AuthError);
    expect(Result.isFailure(result) && result.failure.message).not.toContain(TEST_TOKEN);
  });

  it("fails with a PluginError when GitHub answers null for the item", async () => {
    const stub = stubGithub(() => answer({ pullRequest: null }));

    const result = await runAgainstStub(readItemBlocks(TEST_TOKEN, PULL_REF), stub);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(Result.isFailure(result) && result.failure.message).toContain("could not find");
  });

  it("fails with a PluginError for a ref that is not a pull request or an issue, sending nothing", async () => {
    const stub = stubGithub(() => answer(null));

    const result = await runAgainstStub(
      readItemBlocks(TEST_TOKEN, "github:repo:acme/storefront-web"),
      stub,
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(stub.requests).toEqual([]);
  });
});
