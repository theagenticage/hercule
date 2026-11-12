/** Tests how the Inbox's counts become what the rail draws. */
import { describe, expect, it } from "vitest";
import { buildInboxCounts } from "@hercule/client-core/inbox/testing";
import { describeInboxRail } from "./inbox-rail-props";

const PLUGINS = [{ id: "linear", displayName: "Linear" }];
const time = (iso: string): string => iso.slice(11, 16);

describe("describeInboxRail", () => {
  it("gives the core's lists their icons and the first seven their digit, and a plugin's list its mark", () => {
    const counts = buildInboxCounts({
      savedQueries: [
        { id: "waits", name: "Someone waits on me", order: "waiting", count: 3 },
        { id: "linear/cycle", name: "This cycle", order: "newest", source: "linear", count: 1 },
      ],
    });
    const { savedQueries } = describeInboxRail(counts, PLUGINS, time);
    expect(savedQueries[0]).toMatchObject({ icon: "clock", shortcut: "1", count: 3 });
    expect(savedQueries[1]).toMatchObject({ icon: { pluginId: "linear" }, shortcut: "2" });
  });

  it("names a pin's account only when its source has several, and a failing source's time", () => {
    const counts = buildInboxCounts({
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
      failing: [{ source: "linear", since: "2026-11-12T08:40:00.000Z" }],
    });
    const rail = describeInboxRail(counts, PLUGINS, time);
    expect(rail.pins[0]?.accountLabel).toBe("Labs");
    expect(rail.sources[0]).toMatchObject({ name: "Linear", failingSince: "08:40" });
    expect(rail.sources[0]?.facets[0]?.values[0]?.health).toBe("at-risk");
  });
});
