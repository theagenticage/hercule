/**
 * Tests the `entities` feed against the fake Linear: what a poll reports to
 * the host for each outcome of the reads, what it asks Linear, and how many
 * requests it costs.
 */
import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { EntityFact } from "@hercule/contract";
import {
  MAX_ENTITY_OBSERVATIONS,
  type EntityInventory,
  type EntityObservation,
} from "@hercule/plugin-host";
import type { LinearConnectionConfig } from "../connection-type";
import { LINEAR_ENTITY_KINDS } from "../entity-kinds";
import {
  buildFakeEntities,
  buildFakeIssue,
  buildFakeLinear,
  buildFakeWorld,
  buildIngestHarness,
  FAKE_STATES,
  OTHER_USER,
  runAgainstStub,
  stampAt,
  TEST_ORGANIZATION,
  type FakeIssue,
  type ReportedEntities,
} from "../testing";
import { pollWithConnection } from "./index";

/** The ref the host stores for the fake issue `id`. */
const refOf = (id: string): string => `linear:issue:${TEST_ORGANIZATION.id}/${id}`;

/**
 * Polls the `entities` feed once against a fake Linear holding `issues`, with
 * a fake host that wants `wanted` read, and returns the result with
 * everything the poll sent.
 */
const pollEntitiesFeed = async (
  issues: Array<FakeIssue>,
  options: {
    readonly wanted?: ReadonlyArray<string>;
    readonly config?: LinearConnectionConfig;
    readonly pageSize?: number;
  } = {},
) => {
  const fake = buildFakeLinear(buildFakeWorld(issues));
  if (options.pageSize !== undefined) fake.world.pageSize = options.pageSize;
  const { entities, reported } = buildFakeEntities({ issue: options.wanted ?? [] });
  const context = { ...buildIngestHarness().context, entities };
  const result = await runAgainstStub(
    pollWithConnection("entities", options.config ?? {}, context),
    fake,
  );
  const requestNames = fake.requests.map((request) => request.operationName);
  return { result, reported, fake, requestNames };
};

/** Returns the one inventory a poll reported. */
const reconciledIssues = (reported: ReportedEntities): EntityInventory => {
  expect(reported.reconciled).toHaveLength(1);
  return reported.reconciled[0]!;
};

/** Narrows an observation to the full variant, which has concerns. */
const full = (observation: EntityObservation | undefined) => {
  if (observation === undefined || observation.partial === true) {
    throw new Error("expected a full observation");
  }
  return observation;
};

describe("the entities feed's inventory", () => {
  it("pages the assigned issues to their end and reports them as one complete inventory", async () => {
    const issues = [1, 2, 3, 4, 5].map((number) => buildFakeIssue(number));

    const { result, reported, requestNames } = await pollEntitiesFeed(issues, { pageSize: 2 });

    expect(Result.isSuccess(result)).toBe(true);
    const inventory = reconciledIssues(reported);
    expect(inventory.kind).toBe("issue");
    expect(inventory.complete).toBe(true);
    expect(inventory.observations.map((observation) => observation.ref).sort()).toEqual(
      issues.map((issue) => refOf(issue.id)),
    );
    expect(requestNames).toEqual([
      "LinearIdentity",
      "LinearAssignedIssues",
      "LinearAssignedIssues",
      "LinearAssignedIssues",
    ]);
  });

  it("reports an issue as assigned and owned by the user, with its fields for the kind table", async () => {
    const issue = buildFakeIssue(7, {
      priority: 1,
      projectMilestone: { id: "milestone-beta", name: "Beta" },
    });

    const { reported } = await pollEntitiesFeed([issue]);

    expect(full(reconciledIssues(reported).observations[0])).toMatchObject({
      kind: "issue",
      ref: refOf("issue-7"),
      url: issue.url,
      lifecycle: "open",
      status: "todo",
      concerns: ["assigned"],
      ownedByYou: true,
      fields: {
        key: "ENG-7",
        assignee: "Ada Lovelace",
        priority: 3,
        milestone: "Beta",
        archived: null,
      },
    });
  });

  it("reports nothing and asks for a wait when Linear rate limits the read", async () => {
    const fake = buildFakeLinear(buildFakeWorld([buildFakeIssue(1)]));
    fake.world.override = (request) =>
      request.operationName === "LinearAssignedIssues"
        ? {
            status: 400,
            headers: { "retry-after": "45" },
            body: {
              errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }],
            },
          }
        : undefined;
    const { entities, reported } = buildFakeEntities({ issue: [refOf("issue-1")] });

    const result = await runAgainstStub(
      pollWithConnection("entities", {}, { ...buildIngestHarness().context, entities }),
      fake,
    );

    expect(result).toEqual(Result.succeed({ nextAfterSeconds: 45 }));
    expect(reported.reconciled).toEqual([]);
    expect(reported.refreshed).toEqual([]);
  });

  it("reports nothing when a later page fails", async () => {
    const fake = buildFakeLinear(buildFakeWorld([1, 2, 3].map((n) => buildFakeIssue(n))));
    fake.world.pageSize = 2;
    let pages = 0;
    fake.world.override = (request) =>
      request.operationName === "LinearAssignedIssues" && (pages += 1) === 2
        ? { status: 500, body: {} }
        : undefined;
    const { entities, reported } = buildFakeEntities();

    const result = await runAgainstStub(
      pollWithConnection("entities", {}, { ...buildIngestHarness().context, entities }),
      fake,
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(reported.reconciled).toEqual([]);
  });

  it("lists the issues assigned to the user from every team, whatever the Connection's filters watch", async () => {
    const operations = buildFakeIssue(2, {
      team: { id: "team-ops", key: "OPS", name: "Operations" },
    });
    const issues = [
      buildFakeIssue(1),
      operations,
      buildFakeIssue(3, { assignee: { ...OTHER_USER } }),
      buildFakeIssue(4, { state: { ...FAKE_STATES.completed } }),
    ];

    const { reported, fake, requestNames } = await pollEntitiesFeed(issues, {
      config: { teams: ["team-ops"], assignees: ["anyone"], labels: ["label-bug"] },
    });

    expect(
      reconciledIssues(reported)
        .observations.map((observation) => observation.ref)
        .sort(),
    ).toEqual([refOf("issue-1"), refOf("issue-2")]);
    // The filters of the config would need their own check of ids; the inventory has none.
    expect(requestNames).not.toContain("LinearConfigCheck");
    expect(
      fake.requests.find((r) => r.operationName === "LinearAssignedIssues")?.variables,
    ).toMatchObject({
      filter: {
        assignee: { isMe: { eq: true } },
        state: { type: { in: ["triage", "backlog", "unstarted", "started"] } },
      },
    });
  });

  it("reports the newest issues with complete false when there are more than the host takes", async () => {
    const base = Date.now();
    const issues = Array.from({ length: MAX_ENTITY_OBSERVATIONS + 1 }, (_, index) =>
      buildFakeIssue(index + 1, { updatedAt: new Date(base - index * 1000).toISOString() }),
    );

    const { reported, requestNames } = await pollEntitiesFeed(issues);

    const inventory = reconciledIssues(reported);
    expect(inventory.complete).toBe(false);
    expect(inventory.observations).toHaveLength(MAX_ENTITY_OBSERVATIONS);
    const refs = new Set(inventory.observations.map((observation) => observation.ref));
    expect(refs.has(refOf("issue-1"))).toBe(true);
    expect(refs.has(refOf(`issue-${String(MAX_ENTITY_OBSERVATIONS + 1)}`))).toBe(false);
    expect(requestNames.filter((name) => name === "LinearAssignedIssues")).toHaveLength(8);
  });

  it("reports an inventory of exactly the host's limit as complete", async () => {
    const issues = Array.from({ length: MAX_ENTITY_OBSERVATIONS }, (_, index) =>
      buildFakeIssue(index + 1),
    );

    const { reported } = await pollEntitiesFeed(issues);

    expect(reconciledIssues(reported).complete).toBe(true);
  });
});

describe("the entities feed's refresh", () => {
  /** Reads `issue` through the refresh and returns the one observation it reported. */
  const refreshOne = async (issue: FakeIssue) => {
    const { reported } = await pollEntitiesFeed([issue], { wanted: [refOf(issue.id)] });
    expect(reported.missing).toEqual([]);
    expect(reported.refreshed).toHaveLength(1);
    return full(reported.refreshed[0]?.[0]);
  };

  const lifecycleTable: ReadonlyArray<{
    readonly state: { id: string; name: string; type: string };
    readonly lifecycle: string;
    readonly status: string;
  }> = [
    { state: FAKE_STATES.triage, lifecycle: "open", status: "triage" },
    { state: FAKE_STATES.backlog, lifecycle: "open", status: "backlog" },
    { state: FAKE_STATES.unstarted, lifecycle: "open", status: "todo" },
    { state: FAKE_STATES.started, lifecycle: "open", status: "started" },
    {
      state: { id: "state-review", name: "In Review", type: "started" },
      lifecycle: "open",
      status: "review",
    },
    { state: FAKE_STATES.completed, lifecycle: "completed", status: "done" },
    { state: FAKE_STATES.canceled, lifecycle: "abandoned", status: "canceled" },
    {
      state: { id: "state-dup", name: "Duplicate", type: "duplicate" },
      lifecycle: "abandoned",
      status: "duplicate",
    },
  ];

  it.each(lifecycleTable)(
    "reads the state $state.name ($state.type) as $lifecycle, status $status",
    async ({ state, lifecycle, status }) => {
      const observation = await refreshOne(buildFakeIssue(1, { state }));

      expect(observation).toMatchObject({ lifecycle, status, concerns: [] });
    },
  );

  it("keeps an archived or trashed issue readable, with its lifecycle from its state and an Archived fact", async () => {
    const archived = await refreshOne(
      buildFakeIssue(1, { archivedAt: stampAt(-5), state: { ...FAKE_STATES.completed } }),
    );
    const trashed = await refreshOne(buildFakeIssue(2, { trashed: true }));

    expect(archived).toMatchObject({ lifecycle: "completed", fields: { archived: "Archived" } });
    expect(trashed).toMatchObject({ lifecycle: "open", fields: { archived: "Archived" } });
  });

  it("reports an issue Linear does not return as inaccessible, never deleted, and still refreshes the rest", async () => {
    const { reported } = await pollEntitiesFeed([buildFakeIssue(1)], {
      wanted: [refOf("issue-1"), refOf("issue-gone")],
    });

    expect(reported.missing).toEqual([{ ref: refOf("issue-gone"), reason: "inaccessible" }]);
    expect(reported.refreshed[0]?.map((observation) => observation.ref)).toEqual([
      refOf("issue-1"),
    ]);
  });

  it("reports an issue of another workspace as inaccessible without asking Linear", async () => {
    const { reported, requestNames } = await pollEntitiesFeed([], {
      wanted: ["linear:issue:org-elsewhere/issue-9"],
    });

    expect(reported.missing).toEqual([
      { ref: "linear:issue:org-elsewhere/issue-9", reason: "inaccessible" },
    ]);
    expect(requestNames).not.toContain("LinearIssueLookup");
  });
});

describe("the entities feed's request count", () => {
  it("sends one paged read and one batched refresh, never one request per issue", async () => {
    const issues = Array.from({ length: 30 }, (_, index) => buildFakeIssue(index + 1));
    const wanted = Array.from({ length: 20 }, (_, index) => refOf(`issue-${String(index + 100)}`));

    const { fake, requestNames, reported } = await pollEntitiesFeed(issues, { wanted });

    expect(requestNames).toEqual(["LinearIdentity", "LinearAssignedIssues", "LinearIssueLookup"]);
    expect(fake.requests[2]?.variables["filter"]).toEqual({
      id: { in: wanted.map((ref) => ref.split("/")[1]) },
    });
    expect(reported.listed).toEqual([{ kind: "issue", limit: 50 }]);
  });

  it("sends no refresh request when the host wants nothing read", async () => {
    const { requestNames } = await pollEntitiesFeed([buildFakeIssue(1)]);

    expect(requestNames).toEqual(["LinearIdentity", "LinearAssignedIssues"]);
  });
});

describe("the entities feed and the issues feed", () => {
  it("name an issue by the same ref", async () => {
    const fake = buildFakeLinear(buildFakeWorld([buildFakeIssue(1)]));
    const harness = buildIngestHarness();
    // The first poll of the issues feed only learns the watched set.
    await runAgainstStub(pollWithConnection("issues", {}, harness.context), fake);
    fake.world.issues.push(buildFakeIssue(2));
    await runAgainstStub(pollWithConnection("issues", {}, harness.context), fake);
    const entered = harness.events.find((event) => event.kind === "linear.issue.entered");

    const { entities, reported } = buildFakeEntities();
    await runAgainstStub(
      pollWithConnection("entities", {}, { ...harness.context, entities }),
      fake,
    );

    const inventoried = reconciledIssues(reported).observations.find(
      (observation) => observation.ref === entered?.refs[0],
    );
    expect(inventoried).toBeDefined();
    expect(entered?.refs[0]).toBe(refOf("issue-2"));
  });
});

describe("the kind table of an issue", () => {
  const issueKind = LINEAR_ENTITY_KINDS.find((kind) => kind.word === "issue")!;

  it("covers every status the feed reports, and every field its templates and facts read", async () => {
    const states = [
      FAKE_STATES.triage,
      FAKE_STATES.backlog,
      FAKE_STATES.unstarted,
      FAKE_STATES.started,
      FAKE_STATES.completed,
      FAKE_STATES.canceled,
      { id: "state-dup", name: "Duplicate", type: "duplicate" },
      { id: "state-review", name: "In Review", type: "started" },
    ];
    const issues = states.map((state, index) =>
      buildFakeIssue(index + 1, {
        state,
        priority: (index % 4) + 1,
        projectMilestone: { id: "milestone-beta", name: "Beta" },
        archivedAt: index === 0 ? stampAt(-1) : null,
      }),
    );

    const { reported } = await pollEntitiesFeed(issues, {
      wanted: issues.map((issue) => refOf(issue.id)),
    });

    const observations = (reported.refreshed[0] ?? []).map(full);
    expect(observations).toHaveLength(states.length);
    for (const observation of observations) {
      expect(Object.keys(issueKind.status ?? {})).toContain(observation.status);
      for (const [, name] of issueKind.identifier.matchAll(/\{([\w-]+)\}/g)) {
        expect(observation.fields[name!]).toBeTruthy();
      }
      // Each fact the table declares reads a field in the form the public API takes.
      for (const fact of issueKind.facts) {
        const value = observation.fields[fact.field];
        if (value === null || value === undefined) continue;
        const shown =
          fact.form === "bars"
            ? { form: "bars", level: Number(value) }
            : { form: "word", text: String(value) };
        expect(() => Schema.decodeUnknownSync(EntityFact)(shown)).not.toThrow();
      }
    }
  });
});
