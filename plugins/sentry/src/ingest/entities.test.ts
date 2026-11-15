/**
 * Tests the `entities` feed through the ingest handle's poll, against the fake
 * Sentry and a fake of what the host passes for reporting entities.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import type { EntityInventory, EntityObservation, IngestEntities } from "@hercule/plugin-host";
import type { SentryConnectionConfig } from "../connection-type";
import { buildIssueRef } from "../refs";
import {
  buildFakeIssue,
  buildFakeSentry,
  buildFakeWorld,
  buildIngestHarness,
  runAgainstStub,
  stampAt,
  TEST_ACCOUNT_ID,
  type FakeIssue,
} from "../testing";
import { pollWithConnection } from "./index";

const ME = { type: "user", id: "88", name: "ada" } as const;
const MY_TEAM = { type: "team", id: "31", name: "platform" } as const;

/** A fake of the host's `IngestEntities` that records what the plugin reports. */
const buildFakeEntities = (wanted: ReadonlyArray<string> = []) => {
  const inventories: Array<EntityInventory> = [];
  const refreshes: Array<ReadonlyArray<EntityObservation>> = [];
  const missing: Array<readonly [string, string]> = [];
  const entities: IngestEntities = {
    reconcile: (inventory) => Effect.sync(() => void inventories.push(inventory)),
    refresh: (observations) => Effect.sync(() => void refreshes.push(observations)),
    listWanted: () => Effect.succeed(wanted),
    listTrackedBranches: () => Effect.succeed([]),
    reportMissing: (ref, reason) => Effect.sync(() => void missing.push([ref, reason])),
  };
  return { entities, inventories, refreshes, missing };
};

/** Builds a fake organization, and polls the `entities` feed once against it. */
const pollOnce = async (
  issues: Array<FakeIssue>,
  options: {
    wanted?: ReadonlyArray<string>;
    config?: SentryConnectionConfig;
    arrange?: (world: ReturnType<typeof buildFakeWorld>) => void;
  } = {},
) => {
  const world = buildFakeWorld(issues);
  options.arrange?.(world);
  const fake = buildFakeSentry(world);
  const recorded = buildFakeEntities(options.wanted);
  const harness = buildIngestHarness();
  const result = await runAgainstStub(
    pollWithConnection(
      "entities",
      options.config ?? {},
      { accountId: TEST_ACCOUNT_ID },
      {
        ...harness.context,
        entities: recorded.entities,
      },
    ),
    fake,
  );
  return { result, fake, ...recorded };
};

/** The issue lists the poll read: the requests with no `group` parameter. */
const inventoryRequests = (fake: ReturnType<typeof buildFakeSentry>) =>
  fake.requests.filter(
    (request) => request.path.endsWith("/issues/") && !request.params.has("group"),
  );

describe("the inventory", () => {
  it("searches for unresolved issues assigned to the user or their teams, with no project or environment", async () => {
    const { result, fake } = await pollOnce([buildFakeIssue("1", { assignedTo: ME })], {
      // The Connection's filters decide events only.
      config: { assignees: ["none"], projects: ["project:12"], environments: ["staging"] },
    });

    expect(Result.isSuccess(result) && result.success).toEqual({});
    const [request, ...others] = inventoryRequests(fake);
    expect(others).toEqual([]);
    expect(request?.params.get("query")).toBe(
      "is:unresolved assigned:[me, my_teams] lastSeen:-14d",
    );
    expect(request?.params.get("sort")).toBe("new");
    expect(request?.params.get("limit")).toBe("100");
    expect(request?.params.has("project")).toBe(false);
    expect(request?.params.has("environment")).toBe(false);
  });

  it("honours the Connection's lastSeenDays", async () => {
    const { fake } = await pollOnce([], { config: { lastSeenDays: 3 } });

    expect(inventoryRequests(fake)[0]?.params.get("query")).toBe(
      "is:unresolved assigned:[me, my_teams] lastSeen:-3d",
    );
  });

  it("reports the matching issues in one complete reconcile, with the reason of each", async () => {
    const { inventories } = await pollOnce([
      buildFakeIssue("1", { assignedTo: ME }),
      buildFakeIssue("2", { assignedTo: MY_TEAM }),
      buildFakeIssue("3", { assignedTo: null }),
      buildFakeIssue("4", { assignedTo: ME, status: "resolved", substatus: null }),
    ]);

    expect(inventories).toHaveLength(1);
    expect(inventories[0]?.kind).toBe("issue");
    expect(inventories[0]?.complete).toBe(true);
    expect(inventories[0]?.observations).toMatchObject([
      {
        ref: "sentry:issue:4501/2",
        concerns: ["assigned"],
        reason: "team-assigned",
        ownedByYou: false,
      },
      { ref: "sentry:issue:4501/1", concerns: ["assigned"], reason: "assigned", ownedByYou: true },
    ]);
  });

  it("leaves an issue that Sentry is deleting out of the inventory", async () => {
    const { inventories } = await pollOnce([
      buildFakeIssue("1", { assignedTo: ME, status: "pending_deletion", substatus: null }),
      buildFakeIssue("2", { assignedTo: ME }),
    ]);

    expect(inventories[0]?.observations.map((o) => o.ref)).toEqual(["sentry:issue:4501/2"]);
    expect(inventories[0]?.complete).toBe(true);
  });

  it("reports the 2,000 issues first seen most recently as incomplete when Sentry has more", async () => {
    const issues = Array.from({ length: 2001 }, (_, index) =>
      buildFakeIssue(String(index + 1), { assignedTo: ME, firstSeen: stampAt(-index - 1) }),
    );

    const { inventories, fake } = await pollOnce(issues);

    expect(inventories).toHaveLength(1);
    expect(inventories[0]?.complete).toBe(false);
    expect(inventories[0]?.observations).toHaveLength(2000);
    expect(inventories[0]?.observations[0]?.ref).toBe("sentry:issue:4501/1");
    expect(inventoryRequests(fake)).toHaveLength(20);
  });

  it("reports nothing when Sentry rate limits a page, and says when to poll again", async () => {
    const { result, inventories, refreshes, missing } = await pollOnce(
      [buildFakeIssue("1", { assignedTo: ME })],
      {
        wanted: [buildIssueRef("4501", "1")],
        arrange: (world) => {
          world.override = (request) =>
            request.path.endsWith("/issues/")
              ? {
                  status: 429,
                  headers: {
                    "x-sentry-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 17),
                  },
                }
              : undefined;
        },
      },
    );

    expect(Result.isSuccess(result) && result.success.nextAfterSeconds).toBeGreaterThanOrEqual(15);
    expect([inventories, refreshes, missing]).toEqual([[], [], []]);
  });
});

describe("the refresh", () => {
  it("reads wanted issues by id in one request, with their lifecycle", async () => {
    const { refreshes, missing, fake } = await pollOnce(
      [
        buildFakeIssue("1", { status: "resolved", substatus: null }),
        buildFakeIssue("2", { status: "ignored", substatus: "archived_forever" }),
        buildFakeIssue("3", { status: "unresolved", substatus: "regressed" }),
      ],
      { wanted: ["1", "2", "3"].map((id) => buildIssueRef("4501", id)) },
    );

    const observations = refreshes.flat();
    expect(observations).toMatchObject([
      { ref: "sentry:issue:4501/1", lifecycle: "completed", status: "resolved" },
      { ref: "sentry:issue:4501/2", lifecycle: "abandoned", status: "archived" },
      { ref: "sentry:issue:4501/3", lifecycle: "open", status: "regressed" },
    ]);
    // A refresh touches no concern.
    expect(observations.some((o) => "concerns" in o && o.concerns.length > 0)).toBe(false);
    expect(missing).toEqual([]);
    const reads = fake.requests.filter((request) => request.params.has("group"));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.params.getAll("group")).toEqual(["1", "2", "3"]);
    expect(reads[0]?.params.get("query")).toBe("");
  });

  it("reports an unparseable ref or another organization's ref inaccessible, without a request", async () => {
    const { missing, refreshes, fake } = await pollOnce([], {
      wanted: ["sentry:issue:9999/1", "sentry:issue:oops", "github:pr:acme/x#1"],
    });

    expect(missing).toEqual([
      ["sentry:issue:9999/1", "inaccessible"],
      ["sentry:issue:oops", "inaccessible"],
      ["github:pr:acme/x#1", "inaccessible"],
    ]);
    expect(refreshes).toEqual([]);
    expect(fake.requests.some((request) => request.params.has("group"))).toBe(false);
  });

  it("reports an issue Sentry did not return, or is deleting, as deleted", async () => {
    const { missing, refreshes } = await pollOnce(
      [buildFakeIssue("1"), buildFakeIssue("2", { status: "pending_merge", substatus: null })],
      { wanted: ["1", "2", "3"].map((id) => buildIssueRef("4501", id)) },
    );

    expect(refreshes.flat().map((o) => o.ref)).toEqual(["sentry:issue:4501/1"]);
    expect(missing).toEqual([
      ["sentry:issue:4501/2", "deleted"],
      ["sentry:issue:4501/3", "deleted"],
    ]);
  });
});

describe("the feed dispatch", () => {
  it("fails for a feed it does not have", async () => {
    const fake = buildFakeSentry(buildFakeWorld());
    const result = await runAgainstStub(
      pollWithConnection("nope", {}, { accountId: TEST_ACCOUNT_ID }, buildIngestHarness().context),
      fake,
    );

    expect(Result.isFailure(result) && result.failure.message).toContain('no feed "nope"');
  });

  it("fails when the host gave no way to report entities", async () => {
    const fake = buildFakeSentry(buildFakeWorld());
    const result = await runAgainstStub(
      pollWithConnection(
        "entities",
        {},
        { accountId: TEST_ACCOUNT_ID },
        buildIngestHarness().context,
      ),
      fake,
    );

    expect(Result.isFailure(result) && result.failure.message).toContain("entities feed");
  });
});
