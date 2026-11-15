/**
 * Tests how the Add button on Work finds Sentry things: recognizing pasted
 * text, searching, and reading one issue, the last two against the fake
 * Sentry.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { PluginError, type EntityRecognition } from "@hercule/plugin-host";
import { recognizeSentryIssues, resolveIssue, searchIssues } from "./entity-lookup";
import { buildIssueRef } from "./refs";
import {
  buildFakeIssue,
  buildFakeSentry,
  buildFakeWorld,
  runAgainstStub,
  TEST_ACCOUNT_ID,
  TEST_ORGANIZATION,
  TEST_TOKEN,
  type FakeIssue,
} from "./testing";

const scoped = (
  identifier: string,
  scopeHint?: string,
  form: "url" | "identifier" = scopeHint === undefined ? "identifier" : "url",
): EntityRecognition => ({
  recognized: "scoped",
  form,
  kind: "issue",
  identifier,
  ...(scopeHint === undefined ? {} : { scopeHint }),
});

describe("recognizing Sentry text", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly text: string;
    readonly expected: ReadonlyArray<EntityRecognition>;
  }> = [
    {
      name: "an organization address, with the organization as the hint",
      text: "https://acme.sentry.io/issues/4012/",
      expected: [scoped("4012", "acme")],
    },
    {
      name: "a path address",
      text: "https://sentry.io/organizations/acme/issues/4012/",
      expected: [scoped("4012", "acme")],
    },
    {
      name: "an address without the trailing slash",
      text: "https://acme.sentry.io/issues/4012",
      expected: [scoped("4012", "acme")],
    },
    {
      name: "an address with a query string or a fragment",
      text: "https://acme.sentry.io/issues/4012/?project=11 and https://sentry.io/organizations/acme/issues/4013/#details",
      expected: [scoped("4012", "acme"), scoped("4013", "acme")],
    },
    {
      name: "a short id, with no hint",
      text: "STOREFRONT-21C",
      expected: [scoped("STOREFRONT-21C")],
    },
    {
      name: "a short id whose project slug holds dashes and digits",
      text: "Seen in MY-APP-2-9Z yesterday.",
      expected: [scoped("MY-APP-2-9Z")],
    },
    {
      name: "a Linear key, which also reads as a short id",
      text: "Fixes SHOP-123, see (WEB-7).",
      expected: [scoped("SHOP-123"), scoped("WEB-7")],
    },
    {
      name: "the same issue named twice once",
      text: "STOREFRONT-21C STOREFRONT-21C https://acme.sentry.io/issues/4012/ https://ACME.sentry.io/issues/4012/",
      expected: [scoped("STOREFRONT-21C"), scoped("4012", "acme")],
    },
    {
      name: "an address with the same id in another organization as two",
      text: "https://acme.sentry.io/issues/4012/ https://globex.sentry.io/issues/4012/",
      expected: [scoped("4012", "acme"), scoped("4012", "globex")],
    },
    {
      name: "another site's address as nothing",
      text: "https://evil.com/sentry.io/organizations/acme/issues/4012/ https://sentry.io.evil.com/organizations/acme/issues/4012/ https://acme.sentry.io.evil.com/issues/4012/",
      expected: [],
    },
    {
      name: "a Sentry address that is not an issue as nothing",
      text: "https://acme.sentry.io/projects/webshop/ https://acme.sentry.io/issues/",
      expected: [],
    },
    {
      name: "the edge short ids: one letter, an underscore, a leading digit, a 13 character suffix",
      text: "A-1 MY_APP-1 3D-APP-1F WEB-0123456789ABC",
      expected: [
        scoped("A-1"),
        scoped("MY_APP-1"),
        scoped("3D-APP-1F"),
        scoped("WEB-0123456789ABC"),
      ],
    },
    {
      name: "a suffix with I, L, O or U, or longer than 13, as nothing",
      text: "WEB-1I WEB-1L WEB-1O WEB-1U WEB-0123456789ABCD",
      expected: [],
    },
    { name: "a date as nothing", text: "on 2024-01-15 we", expected: [] },
    {
      name: "an address whose issue segment runs on into a word as nothing",
      text: "https://acme.sentry.io/issues/123oops/ https://acme.sentry.io/issues/12-x/",
      expected: [],
    },
    {
      name: "an address with a 19 digit id",
      text: "https://acme.sentry.io/issues/1234567890123456789/)",
      expected: [scoped("1234567890123456789", "acme")],
    },
    {
      name: "an address that holds a short id in place of the id",
      text: "https://acme.sentry.io/issues/STOREFRONT-21C/ and https://sentry.io/organizations/acme/issues/STOREFRONT-21D/?x=1",
      expected: [scoped("STOREFRONT-21C", "acme"), scoped("STOREFRONT-21D", "acme")],
    },
    { name: "lower case words as nothing", text: "utf-8 and storefront-21c", expected: [] },
    {
      name: "a short id inside a longer word or path as nothing",
      text: "XSTOREFRONT-21Cx STOREFRONT-21C-x /docs/STOREFRONT-21C a.STOREFRONT-21C",
      expected: [],
    },
  ];

  it.each(cases)("recognizes $name", ({ text, expected }) => {
    expect(recognizeSentryIssues(text)).toEqual(expected);
  });

  it("returns at most 20 recognitions", () => {
    const text = Array.from({ length: 30 }, (_, index) => `SHOP-${String(index + 1)}`).join(" ");

    expect(recognizeSentryIssues(text)).toHaveLength(20);
  });
});

const access = { token: TEST_TOKEN, organization: TEST_ORGANIZATION };
const issueRef = (id: string): string => buildIssueRef(TEST_ORGANIZATION.id, id);

describe("searching Sentry", () => {
  const issues = (): Array<FakeIssue> => [
    buildFakeIssue("1", { title: "Checkout button throws" }),
    buildFakeIssue("2", { title: "Checkout totals are wrong", status: "resolved" }),
    buildFakeIssue("3", { title: "Checkout banner", status: "ignored" }),
    buildFakeIssue("4", { title: "Unrelated" }),
  ];

  it("sends one issues request with no status filter, so every status is searched, and returns unowned issues to find", async () => {
    const fake = buildFakeSentry(buildFakeWorld(issues()));

    const result = await runAgainstStub(
      searchIssues(access, TEST_ACCOUNT_ID, { text: "checkout", limit: 10 }),
      fake,
    );

    expect(Result.isSuccess(result) && result.success.map((o) => o.ref).sort()).toEqual(
      ["1", "2", "3"].map(issueRef),
    );
    expect(Result.isSuccess(result) && result.success[0]).toMatchObject({ concerns: [] });
    const [issuesRequest] = fake.requests.filter((request) => request.path.endsWith("/issues/"));
    expect(issuesRequest?.params.get("query")).toBe("checkout");
    expect(issuesRequest?.params.get("query")).not.toContain("is:");
    expect(fake.requests.filter((request) => request.path.endsWith("/issues/"))).toHaveLength(1);
  });

  it("finds an exact short id alone, through the short id lookup", async () => {
    const fake = buildFakeSentry(buildFakeWorld(issues()));

    const result = await runAgainstStub(
      searchIssues(access, TEST_ACCOUNT_ID, { text: "WEBSHOP-2", limit: 10 }),
      fake,
    );

    expect(Result.isSuccess(result) && result.success.map((o) => o.ref)).toEqual([issueRef("2")]);
    expect(
      fake.requests.find((r) => r.path.endsWith("/issues/"))?.params.get("shortIdLookup"),
    ).toBe("1");
  });

  it("asks for no more than the limit and returns no more", async () => {
    const fake = buildFakeSentry(buildFakeWorld(issues()));

    const result = await runAgainstStub(
      searchIssues(access, TEST_ACCOUNT_ID, { text: "checkout", limit: 2 }),
      fake,
    );

    expect(Result.isSuccess(result) && result.success).toHaveLength(2);
    expect(fake.requests.find((r) => r.path.endsWith("/issues/"))?.params.get("limit")).toBe("2");
  });

  it("returns no more than the limit when a short id matches more issues", async () => {
    const fake = buildFakeSentry(
      buildFakeWorld([
        buildFakeIssue("1", { shortId: "WEBSHOP-1" }),
        buildFakeIssue("2", { shortId: "WEBSHOP-1" }),
        buildFakeIssue("3", { shortId: "WEBSHOP-1" }),
      ]),
    );

    const result = await runAgainstStub(
      searchIssues(access, TEST_ACCOUNT_ID, { text: "WEBSHOP-1", limit: 2 }),
      fake,
    );

    expect(Result.isSuccess(result) && result.success).toHaveLength(2);
  });

  it("sends no projects request when the search finds nothing", async () => {
    const fake = buildFakeSentry(buildFakeWorld(issues()));

    const result = await runAgainstStub(
      searchIssues(access, TEST_ACCOUNT_ID, { text: "nothing matches this", limit: 10 }),
      fake,
    );

    expect(result).toEqual(Result.succeed([]));
    expect(fake.requests.filter((request) => request.path.endsWith("/projects/"))).toEqual([]);
  });

  it("refuses a scope, saying Sentry cannot search inside it, and sends nothing", async () => {
    const fake = buildFakeSentry(buildFakeWorld(issues()));

    const result = await runAgainstStub(
      searchIssues(access, TEST_ACCOUNT_ID, {
        text: "checkout",
        scopeRef: `sentry:project:${TEST_ORGANIZATION.id}/11`,
        limit: 10,
      }),
      fake,
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(fake.requests).toEqual([]);
  });
});

describe("resolving a recognition", () => {
  const world = () =>
    buildFakeWorld([
      buildFakeIssue("12", { shortId: "WEBSHOP-1A" }),
      buildFakeIssue("13", { status: "pending_deletion", substatus: null }),
    ]);

  it("reads the issue a ref names by its id", async () => {
    const fake = buildFakeSentry(world());

    const result = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, {
        recognized: "ref",
        form: "identifier",
        ref: issueRef("12"),
        kind: "issue",
      }),
      fake,
    );

    expect(result).toMatchObject(Result.succeed({ found: { ref: issueRef("12") } }));
  });

  it("says inaccessible for a ref of another organization, without reading an issue", async () => {
    const fake = buildFakeSentry(world());

    const result = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, {
        recognized: "ref",
        form: "identifier",
        ref: buildIssueRef("9999", "12"),
        kind: "issue",
      }),
      fake,
    );

    expect(result).toEqual(Result.succeed({ missing: "inaccessible" }));
    expect(fake.requests).toEqual([]);
  });

  it("reads the issue an address names when its hint is this organization, in any case", async () => {
    const fake = buildFakeSentry(world());

    const result = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, scoped("12", "ACME")),
      fake,
    );

    expect(result).toMatchObject(Result.succeed({ found: { ref: issueRef("12") } }));
  });

  it("says out of scope, before reading any issue, when the hint names another organization", async () => {
    const fake = buildFakeSentry(world());

    const result = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, scoped("12", "globex")),
      fake,
    );

    expect(result).toEqual(Result.succeed({ outOfScope: true }));
    expect(fake.requests).toEqual([]);
  });

  it("reads a short id, in any case", async () => {
    const fake = buildFakeSentry(world());

    const result = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, scoped("webshop-1a")),
      fake,
    );

    expect(result).toMatchObject(Result.succeed({ found: { ref: issueRef("12") } }));
  });

  it("reads the issue an address with a short id names", async () => {
    const fake = buildFakeSentry(world());

    const result = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, scoped("WEBSHOP-1A", "acme")),
      fake,
    );

    expect(result).toMatchObject(Result.succeed({ found: { ref: issueRef("12") } }));
  });

  it("says unknown for a short id Sentry answers 404 to, and for an id it does not return", async () => {
    const fake = buildFakeSentry(world());

    const shortId = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, scoped("WEBSHOP-ZZ")),
      fake,
    );
    const id = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, scoped("999", "acme")),
      fake,
    );

    expect(shortId).toEqual(Result.succeed({ missing: "unknown" }));
    expect(id).toEqual(Result.succeed({ missing: "unknown" }));
  });

  it("says not-found for an issue Sentry is deleting", async () => {
    const fake = buildFakeSentry(world());

    const result = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, scoped("13", "acme")),
      fake,
    );

    expect(result).toEqual(Result.succeed({ missing: "not-found" }));
  });

  it("refuses a ref that is not an issue's and an identifier that is not a short id, sending nothing", async () => {
    const fake = buildFakeSentry(world());

    const ref = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, {
        recognized: "ref",
        form: "identifier",
        ref: `sentry:project:${TEST_ORGANIZATION.id}/11`,
        kind: "project",
      }),
      fake,
    );
    const identifier = await runAgainstStub(
      resolveIssue(access, TEST_ACCOUNT_ID, scoped("12")),
      fake,
    );

    expect(Result.isFailure(ref) && ref.failure).toBeInstanceOf(PluginError);
    expect(Result.isFailure(identifier) && identifier.failure).toBeInstanceOf(PluginError);
    expect(fake.requests).toEqual([]);
  });
});
