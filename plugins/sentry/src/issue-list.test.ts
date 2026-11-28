/**
 * Tests the reads of the organization's issue list against the fake Sentry:
 * the request each read sends, how pages and batches are followed, and how the
 * result is cut.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { findIssues, listIssues, lookUpIssues } from "./issue-list";
import {
  buildFakeIssue,
  buildFakeSentry,
  buildFakeWorld,
  runAgainstStub,
  stampAt,
  TEST_ORGANIZATION,
  TEST_TOKEN,
  type FakeIssue,
} from "./testing";

const access = { token: TEST_TOKEN, organization: TEST_ORGANIZATION };

const listRequests = (fake: ReturnType<typeof buildFakeSentry>) =>
  fake.requests.filter((request) => request.path.endsWith("/issues/"));

const buildManyIssues = (count: number): Array<FakeIssue> =>
  Array.from({ length: count }, (_, index) =>
    buildFakeIssue(String(index + 1), { firstSeen: stampAt(-index - 1) }),
  );

describe("listing issues", () => {
  it("asks for the search, newest first, a full page, no graphs, and the filters", async () => {
    const fake = buildFakeSentry(buildFakeWorld([buildFakeIssue("1")]));

    await runAgainstStub(
      listIssues(
        access,
        {
          query: "is:unresolved",
          sort: "new",
          projectIds: ["11"],
          environments: ["production", "staging"],
        },
        1000,
      ),
      fake,
    );

    const [request, ...others] = listRequests(fake);
    expect(others).toEqual([]);
    expect(request?.origin).toBe(TEST_ORGANIZATION.regionUrl);
    expect(request?.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(request?.params.get("query")).toBe("is:unresolved");
    expect(request?.params.get("sort")).toBe("new");
    expect(request?.params.get("limit")).toBe("100");
    expect(request?.params.get("groupStatsPeriod")).toBe("");
    expect(request?.params.has("collapse")).toBe(false);
    expect(request?.params.getAll("project")).toEqual(["11"]);
    expect(request?.params.getAll("environment")).toEqual(["production", "staging"]);
  });

  it("sends no project or environment without filters", async () => {
    const fake = buildFakeSentry(buildFakeWorld([]));

    await runAgainstStub(listIssues(access, { query: "", sort: "new" }, 100), fake);

    expect(listRequests(fake)[0]?.params.has("project")).toBe(false);
    expect(listRequests(fake)[0]?.params.has("environment")).toBe(false);
  });

  it("follows the pages to the end and says nothing is left", async () => {
    const fake = buildFakeSentry(buildFakeWorld(buildManyIssues(250)));

    const result = await runAgainstStub(listIssues(access, { query: "", sort: "new" }, 1000), fake);

    expect(Result.isSuccess(result) && result.success.issues).toHaveLength(250);
    expect(Result.isSuccess(result) && result.success.hasMore).toBe(false);
    expect(listRequests(fake)).toHaveLength(3);
  });

  it("stops after enough pages for maxIssues and says Sentry has more", async () => {
    const fake = buildFakeSentry(buildFakeWorld(buildManyIssues(250)));

    const result = await runAgainstStub(listIssues(access, { query: "", sort: "new" }, 200), fake);

    expect(Result.isSuccess(result) && result.success.issues).toHaveLength(200);
    expect(Result.isSuccess(result) && result.success.hasMore).toBe(true);
    expect(listRequests(fake)).toHaveLength(2);
  });
});

describe("looking up issues by id", () => {
  it("finds an issue of any status, with an empty query so no status is filtered", async () => {
    const fake = buildFakeSentry(
      buildFakeWorld([
        buildFakeIssue("1", { status: "resolved", substatus: null }),
        buildFakeIssue("2"),
      ]),
    );

    const result = await runAgainstStub(lookUpIssues(access, ["1", "3"]), fake);

    expect(Result.isSuccess(result) && [...result.success.keys()]).toEqual(["1"]);
    const [request] = listRequests(fake);
    expect(request?.params.get("query")).toBe("");
    expect(request?.params.getAll("group")).toEqual(["1", "3"]);
    expect(request?.params.get("groupStatsPeriod")).toBe("");
  });

  it("reads 100 ids per request", async () => {
    const fake = buildFakeSentry(buildFakeWorld(buildManyIssues(150)));
    const ids = Array.from({ length: 150 }, (_, index) => String(index + 1));

    const result = await runAgainstStub(lookUpIssues(access, ids), fake);

    expect(Result.isSuccess(result) && result.success.size).toBe(150);
    expect(listRequests(fake).map((request) => request.params.getAll("group").length)).toEqual([
      100, 50,
    ]);
  });

  it("sends nothing for no ids", async () => {
    const fake = buildFakeSentry(buildFakeWorld([buildFakeIssue("1")]));

    await runAgainstStub(lookUpIssues(access, []), fake);

    expect(fake.requests).toEqual([]);
  });
});

describe("finding issues by text", () => {
  it("sends the text with the short id lookup, one page, and no status filter", async () => {
    const fake = buildFakeSentry(buildFakeWorld([buildFakeIssue("1", { title: "Checkout" })]));

    const result = await runAgainstStub(findIssues(access, "checkout", 10), fake);

    expect(Result.isSuccess(result) && result.success.map((issue) => issue.id)).toEqual(["1"]);
    const [request, ...others] = listRequests(fake);
    expect(others).toEqual([]);
    expect(request?.params.get("query")).toBe("checkout");
    expect(request?.params.get("shortIdLookup")).toBe("1");
    expect(request?.params.get("limit")).toBe("10");
    expect(request?.params.get("groupStatsPeriod")).toBe("");
  });

  it("asks for no more than a page", async () => {
    const fake = buildFakeSentry(buildFakeWorld([]));

    await runAgainstStub(findIssues(access, "checkout", 500), fake);

    expect(listRequests(fake)[0]?.params.get("limit")).toBe("100");
  });

  it("returns no more than the limit when a short id matches more issues", async () => {
    const fake = buildFakeSentry(
      buildFakeWorld([
        buildFakeIssue("1", { shortId: "WEBSHOP-1" }),
        buildFakeIssue("2", { shortId: "WEBSHOP-1" }),
        buildFakeIssue("3", { shortId: "WEBSHOP-1" }),
      ]),
    );

    const result = await runAgainstStub(findIssues(access, "WEBSHOP-1", 2), fake);

    expect(Result.isSuccess(result) && result.success).toHaveLength(2);
  });
});
