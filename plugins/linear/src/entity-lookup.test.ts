/**
 * Tests how the Add button on Work finds Linear things: recognizing pasted
 * text, searching, and reading one issue, the last two against the fake
 * Linear.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { AuthError, PluginError, type EntityRecognition } from "@hercule/plugin-host";
import {
  readIssueBlocks,
  recognizeLinearIssues,
  resolveIssue,
  searchIssues,
} from "./entity-lookup";
import {
  buildFakeIssue,
  buildFakeLinear,
  buildFakeWorld,
  FAKE_STATES,
  runAgainstStub,
  stampAt,
  stubLinear,
  TEST_API_KEY,
  TEST_ORGANIZATION,
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

describe("recognizing Linear text", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly text: string;
    readonly expected: ReadonlyArray<EntityRecognition>;
  }> = [
    {
      name: "an address, with the workspace as the hint",
      text: "https://linear.app/acme/issue/ENG-123",
      expected: [scoped("ENG-123", "acme")],
    },
    {
      name: "an address with the title slug",
      text: "see https://linear.app/acme/issue/ENG-123/checkout-does-nothing for it",
      expected: [scoped("ENG-123", "acme")],
    },
    {
      name: "an address written with a lower case key, as the identifier in capitals",
      text: "https://linear.app/acme/issue/eng-123/slug",
      expected: [scoped("ENG-123", "acme")],
    },
    { name: "a bare identifier, with no hint", text: "ENG-123", expected: [scoped("ENG-123")] },
    {
      name: "a bare identifier in a sentence",
      text: "Fixes ENG-123, see (OPS-9).",
      expected: [scoped("ENG-123"), scoped("OPS-9")],
    },
    {
      name: "the address and the bare form of one issue as two recognitions",
      text: "https://linear.app/acme/issue/ENG-1/x and ENG-1",
      expected: [scoped("ENG-1", "acme"), scoped("ENG-1")],
    },
    { name: "one issue named twice once", text: "ENG-5 and ENG-5", expected: [scoped("ENG-5")] },
    { name: "an identifier in lower case as nothing", text: "eng-123 and utf-8", expected: [] },
    {
      name: "an identifier inside a longer word as nothing",
      text: "XENG-123x ENG-123x",
      expected: [],
    },
    {
      name: "another site's address as nothing",
      text: "https://example.com/acme/issue/ENG-1",
      expected: [],
    },
    {
      name: "a Linear address that is not an issue as nothing",
      text: "https://linear.app/acme/project/checkout-1",
      expected: [],
    },
  ];

  it.each(cases)("recognizes $name", ({ text, expected }) => {
    expect(recognizeLinearIssues(text)).toEqual(expected);
  });

  it("returns at most 20 recognitions", () => {
    const text = Array.from({ length: 30 }, (_, index) => `ENG-${String(index + 1)}`).join(" ");

    expect(recognizeLinearIssues(text)).toHaveLength(20);
  });
});

describe("searching Linear", () => {
  const issues = (): Array<FakeIssue> => [
    buildFakeIssue(1, { title: "Checkout button does nothing" }),
    buildFakeIssue(2, {
      title: "Checkout totals are wrong",
      team: { id: "team-ops", key: "OPS", name: "Operations" },
      project: { id: "project-checkout", name: "Checkout revamp" },
    }),
    buildFakeIssue(3, { title: "Checkout banner" }),
    buildFakeIssue(4, { title: "Unrelated" }),
  ];

  it("sends one search request, reads no more than the limit, and returns them as unowned issues to find", async () => {
    const fake = buildFakeLinear(buildFakeWorld(issues()));

    const result = await runAgainstStub(
      searchIssues(TEST_API_KEY, { text: "checkout", limit: 2 }),
      fake,
    );

    expect(Result.isSuccess(result) && result.success.map((o) => o.ref)).toEqual([
      `linear:issue:${TEST_ORGANIZATION.id}/issue-1`,
      `linear:issue:${TEST_ORGANIZATION.id}/issue-2`,
    ]);
    expect(Result.isSuccess(result) && result.success[0]).toMatchObject({ concerns: [] });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.variables).toMatchObject({ term: "checkout", first: 2 });
  });

  it.each([
    {
      scope: `linear:team:${TEST_ORGANIZATION.id}/team-ops`,
      filter: { team: { id: { eq: "team-ops" } } },
    },
    {
      scope: `linear:project:${TEST_ORGANIZATION.id}/project-checkout`,
      filter: { project: { id: { eq: "project-checkout" } } },
    },
    {
      scope: `linear:initiative:${TEST_ORGANIZATION.id}/init-1`,
      filter: { project: { initiatives: { some: { id: { eq: "init-1" } } } } },
    },
  ])("narrows the search to $scope", async ({ scope, filter }) => {
    // The fake cannot judge an initiative filter, so this only reads what was sent.
    const stub = stubLinear(() => ({
      status: 200,
      body: {
        data: {
          searchIssues: { nodes: [] },
          viewer: { id: "user-ada" },
          organization: { id: TEST_ORGANIZATION.id, urlKey: "acme" },
        },
      },
    }));

    await runAgainstStub(
      searchIssues(TEST_API_KEY, { text: "checkout", scopeRef: scope, limit: 10 }),
      stub,
    );

    expect(stub.requests[0]?.variables["filter"]).toEqual(filter);
  });

  it("finds only the issues of the team of the scope", async () => {
    const fake = buildFakeLinear(buildFakeWorld(issues()));

    const result = await runAgainstStub(
      searchIssues(TEST_API_KEY, {
        text: "checkout",
        scopeRef: `linear:team:${TEST_ORGANIZATION.id}/team-ops`,
        limit: 10,
      }),
      fake,
    );

    expect(Result.isSuccess(result) && result.success.map((o) => o.ref)).toEqual([
      `linear:issue:${TEST_ORGANIZATION.id}/issue-2`,
    ]);
  });

  it("refuses a scope Linear cannot search inside, saying so, and sends nothing", async () => {
    const fake = buildFakeLinear(buildFakeWorld(issues()));

    const result = await runAgainstStub(
      searchIssues(TEST_API_KEY, {
        text: "checkout",
        scopeRef: `linear:milestone:${TEST_ORGANIZATION.id}/milestone-beta`,
        limit: 10,
      }),
      fake,
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(fake.requests).toEqual([]);
  });
});

describe("resolving a recognition", () => {
  const issueRef = `linear:issue:${TEST_ORGANIZATION.id}/issue-12`;

  it("reads the issue a scoped identifier names in the workspace the hint names", async () => {
    const fake = buildFakeLinear(buildFakeWorld([buildFakeIssue(12)]));

    const result = await runAgainstStub(resolveIssue(TEST_API_KEY, scoped("ENG-12", "acme")), fake);

    expect(result).toMatchObject(Result.succeed({ found: { ref: issueRef } }));
    expect(fake.requests[0]?.variables["filter"]).toEqual({
      team: { key: { eq: "ENG" } },
      number: { eq: 12 },
    });
  });

  it("reads a bare identifier, and one written in lower case in an address", async () => {
    const fake = buildFakeLinear(buildFakeWorld([buildFakeIssue(12)]));

    const bare = await runAgainstStub(resolveIssue(TEST_API_KEY, scoped("ENG-12")), fake);
    const lower = await runAgainstStub(resolveIssue(TEST_API_KEY, scoped("ENG-12", "ACME")), fake);

    expect(bare).toMatchObject(Result.succeed({ found: { ref: issueRef } }));
    expect(lower).toMatchObject(Result.succeed({ found: { ref: issueRef } }));
  });

  it("says out of scope when the hint names another workspace", async () => {
    const fake = buildFakeLinear(buildFakeWorld([buildFakeIssue(12)]));

    const result = await runAgainstStub(
      resolveIssue(TEST_API_KEY, scoped("ENG-12", "globex")),
      fake,
    );

    expect(result).toEqual(Result.succeed({ outOfScope: true }));
  });

  it("says unknown, never not-found or inaccessible, when Linear returns no issue", async () => {
    const fake = buildFakeLinear(buildFakeWorld([buildFakeIssue(12)]));

    const result = await runAgainstStub(resolveIssue(TEST_API_KEY, scoped("ENG-99", "acme")), fake);

    expect(result).toEqual(Result.succeed({ missing: "unknown" }));
  });

  it("reads an archived issue, keeping its state's lifecycle", async () => {
    const fake = buildFakeLinear(
      buildFakeWorld([
        buildFakeIssue(12, { archivedAt: stampAt(-9), state: { ...FAKE_STATES.completed } }),
      ]),
    );

    const result = await runAgainstStub(resolveIssue(TEST_API_KEY, scoped("ENG-12")), fake);

    expect(result).toMatchObject(
      Result.succeed({ found: { lifecycle: "completed", fields: { archived: "Archived" } } }),
    );
  });

  it("reads the issue a ref names by its id, and says inaccessible for a ref of another workspace", async () => {
    const fake = buildFakeLinear(buildFakeWorld([buildFakeIssue(12)]));

    const found = await runAgainstStub(
      resolveIssue(TEST_API_KEY, {
        recognized: "ref",
        form: "identifier",
        ref: issueRef,
        kind: "issue",
      }),
      fake,
    );
    const elsewhere = await runAgainstStub(
      resolveIssue(TEST_API_KEY, {
        recognized: "ref",
        form: "identifier",
        ref: "linear:issue:org-globex/issue-12",
        kind: "issue",
      }),
      fake,
    );

    expect(found).toMatchObject(Result.succeed({ found: { ref: issueRef } }));
    expect(elsewhere).toEqual(Result.succeed({ missing: "inaccessible" }));
  });

  it("refuses an identifier that is not KEY-123, saying what Linear reads", async () => {
    const fake = buildFakeLinear(buildFakeWorld([]));

    const result = await runAgainstStub(resolveIssue(TEST_API_KEY, scoped("12")), fake);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(fake.requests).toEqual([]);
  });
});

describe("reading the blocks of an issue", () => {
  const issueRef = `linear:issue:${TEST_ORGANIZATION.id}/issue-12`;

  it("returns the facts the kind does not declare, then the description, in one request", async () => {
    const fake = buildFakeLinear(
      buildFakeWorld([
        buildFakeIssue(12, {
          dueDate: "2026-11-21",
          estimate: 3,
          labels: {
            nodes: [
              { id: "l1", name: "Bug" },
              { id: "l2", name: "Checkout" },
            ],
          },
        }),
      ]),
    );

    const result = await runAgainstStub(readIssueBlocks(TEST_API_KEY, issueRef), fake);

    // The creator's name is not what this test is about, only that the row is there.
    const anyText: unknown = expect.any(String);
    expect(result).toEqual(
      Result.succeed([
        {
          type: "fields",
          rows: [
            { label: "Labels", value: "Bug, Checkout" },
            { label: "Due", value: "2026-11-21" },
            { label: "Estimate", value: "3" },
            { label: "Creator", value: anyText },
          ],
        },
        {
          type: "text",
          title: "Description",
          markdown: "Pressing the button logs a TypeError and the order is not placed.",
        },
      ]),
    );
    expect(fake.requests).toHaveLength(1);
  });

  it("leaves out the blocks an issue has nothing for", async () => {
    const fake = buildFakeLinear(
      buildFakeWorld([buildFakeIssue(12, { description: null, creator: null })]),
    );

    const result = await runAgainstStub(readIssueBlocks(TEST_API_KEY, issueRef), fake);

    expect(result).toEqual(Result.succeed([]));
  });

  it("cuts a description that is too long and says it was cut", async () => {
    const fake = buildFakeLinear(
      buildFakeWorld([buildFakeIssue(12, { description: "x".repeat(20_000), creator: null })]),
    );

    const result = await runAgainstStub(readIssueBlocks(TEST_API_KEY, issueRef), fake);

    const markdown = Result.isSuccess(result) ? String(result.success[0]?.["markdown"]) : "";
    expect(markdown.length).toBeLessThan(17_000);
    expect(markdown).toContain("The description is cut here");
  });

  it("fails with an AuthError when Linear refuses the credential", async () => {
    const fake = buildFakeLinear(buildFakeWorld([buildFakeIssue(12)]));

    const result = await runAgainstStub(readIssueBlocks("wrong-key", issueRef), fake);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(AuthError);
  });

  it("fails with a PluginError for an issue Linear does not return, or one of another workspace", async () => {
    const fake = buildFakeLinear(buildFakeWorld([buildFakeIssue(12)]));

    const missing = await runAgainstStub(
      readIssueBlocks(TEST_API_KEY, `linear:issue:${TEST_ORGANIZATION.id}/issue-99`),
      fake,
    );
    const elsewhere = await runAgainstStub(
      readIssueBlocks(TEST_API_KEY, "linear:issue:org-globex/issue-12"),
      fake,
    );

    expect(Result.isFailure(missing) && missing.failure).toBeInstanceOf(PluginError);
    expect(Result.isFailure(elsewhere) && elsewhere.failure).toBeInstanceOf(PluginError);
  });

  it("fails with a PluginError for a ref that is not an issue's, sending nothing", async () => {
    const fake = buildFakeLinear(buildFakeWorld([]));

    const result = await runAgainstStub(
      readIssueBlocks(TEST_API_KEY, `linear:team:${TEST_ORGANIZATION.id}/team-eng`),
      fake,
    );

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(fake.requests).toEqual([]);
  });
});
