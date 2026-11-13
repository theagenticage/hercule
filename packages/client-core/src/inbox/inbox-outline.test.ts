/** Tests how the Inbox's outline become what the rail draws, and the names they give a scope and an account. */
import { describe, expect, it } from "vitest";
import { buildInboxOutline } from "./cards.testing";
import { describeInboxRail, findAccountLabel, nameInboxScope } from "./inbox-outline";

const PLUGINS = [{ id: "linear", displayName: "Linear" }];
const time = (iso: string): string => iso.slice(11, 16);

describe("describeInboxRail", () => {
  it("gives the core's lists their icons and the first seven their digit, and a plugin's list its mark", () => {
    const counts = buildInboxOutline({
      savedQueries: [
        { id: "waits", name: "Someone waits on me", order: "waiting", signalKinds: [], count: 3 },
        {
          id: "linear/cycle",
          name: "This cycle",
          order: "newest",
          source: "linear",
          signalKinds: [],
          count: 1,
        },
      ],
    });
    const { savedQueries } = describeInboxRail(counts, PLUGINS, time);
    expect(savedQueries[0]).toMatchObject({ icon: "clock", shortcut: "1", count: 3 });
    expect(savedQueries[1]).toMatchObject({ icon: { pluginId: "linear" }, shortcut: "2" });
  });

  it("names a pin's account only when its source has several, and a failing source's time", () => {
    const counts = buildInboxOutline({
      pins: [
        {
          source: "linear",
          connectionId: "c2",
          key: "team",
          value: "Checkout",
          label: "Checkout",
          count: 2,
        },
      ],
      sources: [
        {
          source: "linear",
          count: 5,
          folded: false,
          accounts: [
            { connectionId: "c1", label: "Northwind", count: 3 },
            { connectionId: "c2", label: "Labs", count: 2 },
          ],
          facets: [
            {
              source: "linear",
              key: "project",
              label: "Project",
              plural: "Projects",
              more: 0,
              values: [
                {
                  value: "p1",
                  label: "Checkout revamp",
                  count: 0,
                  health: { shape: "half", tone: "attention", label: "At risk" },
                },
              ],
            },
          ],
        },
      ],
      failing: [{ source: "linear", updatedAt: "2026-11-12T08:40:00.000Z" }],
    });
    const rail = describeInboxRail(counts, PLUGINS, time);
    expect(rail.pins[0]?.accountLabel).toBe("Labs");
    expect(rail.sources[0]).toMatchObject({ name: "Linear", failingChangedAt: "08:40" });
    expect(rail.sources[0]?.facets[0]?.values[0]?.health).toBe("at-risk");
  });
});

describe("nameInboxScope", () => {
  const counts = buildInboxOutline({
    savedQueries: [
      { id: "waits", name: "Someone waits on me", order: "waiting", signalKinds: [], count: 3 },
    ],
    pins: [{ source: "linear", key: "team", value: "t1", label: "Checkout (pinned)", count: 2 }],
    sources: [
      {
        source: "linear",
        count: 5,
        folded: false,
        accounts: [],
        facets: [
          {
            source: "linear",
            key: "project",
            label: "Project",
            plural: "Projects",
            more: 0,
            values: [{ value: "p1", label: "Checkout revamp", count: 1 }],
          },
        ],
      },
    ],
  });

  it("names a saved query, falling back to its id", () => {
    expect(nameInboxScope({ kind: "saved-query", id: "waits" }, counts)).toBe(
      "Someone waits on me",
    );
    expect(nameInboxScope({ kind: "saved-query", id: "gone" }, counts)).toBe("gone");
  });

  it("names a value by its pin, else by its facet value, else as it was sent", () => {
    const value = (key: string, text: string) => ({
      kind: "value" as const,
      value: { source: "linear", key, value: text },
    });
    expect(nameInboxScope(value("team", "t1"), counts)).toBe("Checkout (pinned)");
    expect(nameInboxScope(value("project", "p1"), counts)).toBe("Checkout revamp");
    expect(nameInboxScope(value("project", "p9"), counts)).toBe("p9");
  });
});

describe("findAccountLabel", () => {
  const accounts = [
    { connectionId: "c1", label: "Northwind" },
    { connectionId: "c2", label: "Labs" },
  ];

  it("names the account only when the source has several", () => {
    expect(findAccountLabel(accounts, ["c2"])).toBe("Labs");
    expect(findAccountLabel(accounts.slice(0, 1), ["c1"])).toBeUndefined();
    expect(findAccountLabel(accounts, ["other"])).toBeUndefined();
  });
});

describe("describeInboxRail repository names", () => {
  const buildRepositoryValue = (value: string, count: number) => ({ value, label: value, count });
  const buildFacet = (connectionId: string, values: ReturnType<typeof buildRepositoryValue>[]) => ({
    source: "github",
    connectionId,
    key: "repo",
    label: "Repository",
    plural: "Repositories",
    more: 0,
    values,
  });
  const buildPin = (connectionId: string, value: string) => ({
    source: "github",
    connectionId,
    key: "repo",
    value,
    label: value,
    count: 1,
  });
  const outline = buildInboxOutline({
    pins: [buildPin("c1", "acme/site"), buildPin("c1", "labs/site"), buildPin("c2", "acme/site")],
    sources: [
      {
        source: "github",
        count: 4,
        folded: false,
        accounts: [],
        facets: [
          buildFacet("c1", [
            buildRepositoryValue("acme/site", 2),
            buildRepositoryValue("labs/site", 1),
            buildRepositoryValue("acme/api", 1),
          ]),
          buildFacet("c2", [buildRepositoryValue("acme/site", 1)]),
        ],
      },
    ],
  });

  it("names the values of each account on its own, so a name shared across accounts has no owner", () => {
    const [first, second] = describeInboxRail(outline, [], time).sources[0]!.facets;
    expect(first!.values.map(({ label, owner }) => [owner, label])).toEqual([
      ["acme", "site"],
      ["labs", "site"],
      [undefined, "api"],
    ]);
    expect(second!.values[0]).toMatchObject({ label: "site", title: "acme/site" });
    expect(second!.values[0]!.owner).toBeUndefined();
  });

  it("names pins the same way, one account at a time, and keeps the value for the search", () => {
    const { pins } = describeInboxRail(outline, [], time);
    expect(pins.map(({ owner, label }) => [owner, label])).toEqual([
      ["acme", "site"],
      ["labs", "site"],
      [undefined, "site"],
    ]);
    expect(pins[0]).toMatchObject({ value: "acme/site", title: "acme/site" });
  });
  it("keeps a pinned repository's owner when its duplicate in the account is not pinned", () => {
    const rail = describeInboxRail({ ...outline, pins: [buildPin("c1", "acme/site")] }, [], time);
    expect(rail.pins[0]).toMatchObject({
      label: "site",
      owner: "acme",
      title: "acme/site",
      value: "acme/site",
    });
  });

  it.each([
    ["repo", ["NorthwindMarket/storefront-web", "NorthwindMarket/ops"], ["storefront-web", "ops"]],
    ["team", ["a/b", "c/b"], ["a/b", "c/b"]],
    ["repo", ["monorepo"], ["monorepo"]],
  ])("keeps full values and tooltips while naming %s entries", (key, labels, expected) => {
    const rail = describeInboxRail(
      buildInboxOutline({
        sources: [
          {
            source: "github",
            count: 2,
            folded: false,
            accounts: [],
            facets: [
              {
                ...buildFacet(
                  "c1",
                  labels.map((label) => buildRepositoryValue(label, 1)),
                ),
                key,
              },
            ],
          },
        ],
      }),
      [],
      time,
    );
    const values = rail.sources[0]!.facets[0]!.values;
    expect(values.map((value) => value.label)).toEqual(expected);
    expect(values.map((value) => value.value)).toEqual(labels);
    expect(values.map((value) => value.title)).toEqual(labels);
    expect(values.every((value) => value.owner === undefined)).toBe(true);
  });
});
