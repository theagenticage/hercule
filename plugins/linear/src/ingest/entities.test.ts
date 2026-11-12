/**
 * Tests the `entities` feed against the fake Linear: what a poll reports to
 * the host for each outcome of the reads, what it asks Linear, and how many
 * requests it costs.
 */
import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { EntityFact } from "@hercule/contract";
import {
  EntityObservation,
  MAX_ENTITY_OBSERVATIONS,
  MAX_ENTITY_RELATIONS,
  type EntityInventory,
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
  type FakeWorld,
  type ReportedEntities,
} from "../testing";
import { ApiIssue } from "../linear-objects";
import { buildIssueContextFields } from "./entity-context";
import { pollWithConnection } from "./index";

/** The ref the host stores for the fake issue `id`. */
const refOf = (id: string): string => `linear:issue:${TEST_ORGANIZATION.id}/${id}`;

/** The ref the host stores for the fake place of `kind` with the id `id`. */
const placeRef = (kind: string, id: string): string =>
  `linear:${kind}:${TEST_ORGANIZATION.id}/${id}`;

/**
 * Polls the `entities` feed once against a fake Linear holding `issues`, with
 * a fake host that wants `wanted` read, and returns the result with
 * everything the poll sent.
 */
const pollEntitiesFeed = async (
  issues: Array<FakeIssue>,
  options: {
    readonly wanted?: ReadonlyArray<string>;
    /** The refs the host wants read, by unqualified kind word, besides the issues in `wanted`. */
    readonly wantedPlaces?: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly config?: LinearConnectionConfig;
    readonly pageSize?: number;
    /** Changes the fake workspace before the poll. */
    readonly prepare?: (world: FakeWorld) => void;
  } = {},
) => {
  const fake = buildFakeLinear(buildFakeWorld(issues));
  if (options.pageSize !== undefined) fake.world.pageSize = options.pageSize;
  options.prepare?.(fake.world);
  const { entities, reported } = buildFakeEntities({
    ...options.wantedPlaces,
    issue: options.wanted ?? [],
  });
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
  const inventories = reported.reconciled.filter(({ kind }) => kind === "issue");
  expect(inventories).toHaveLength(1);
  return inventories[0]!;
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
      "LinearIssueContext",
      "LinearProjects",
    ]);
  });

  it("reports an issue as assigned and owned by the user, with its fields for the kind table", async () => {
    const issue = buildFakeIssue(7, {
      priority: 1,
      project: { id: "project-checkout", name: "Checkout revamp" },
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
        team: placeRef("team", "team-eng"),
        project: placeRef("project", "project-checkout"),
        status: "Todo",
        priority: "urgent",
        priorityLevel: 3,
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
    expect(requestNames.filter((name) => name === "LinearAssignedIssues")).toHaveLength(9);
  });

  it("reads the whole inventory whatever the page size, and keeps the newest issues of it", async () => {
    const base = Date.now();
    const count = MAX_ENTITY_OBSERVATIONS + 30;
    // Oldest first, so the newest issues are on the last pages.
    const issues = Array.from({ length: count }, (_, index) =>
      buildFakeIssue(index + 1, { updatedAt: new Date(base + index * 1000).toISOString() }),
    );

    const { reported, requestNames } = await pollEntitiesFeed(issues, { pageSize: 100 });

    const inventory = reconciledIssues(reported);
    expect(inventory.complete).toBe(false);
    expect(inventory.observations).toHaveLength(MAX_ENTITY_OBSERVATIONS);
    const refs = new Set(inventory.observations.map((observation) => observation.ref));
    expect(refs.has(refOf(`issue-${String(count)}`))).toBe(true);
    expect(refs.has(refOf("issue-31"))).toBe(true);
    expect(refs.has(refOf("issue-30"))).toBe(false);
    expect(requestNames.filter((name) => name === "LinearAssignedIssues")).toHaveLength(
      Math.ceil(count / 100),
    );
  });

  it("reports nothing when a page after the host's limit fails", async () => {
    const issues = Array.from({ length: MAX_ENTITY_OBSERVATIONS + 30 }, (_, index) =>
      buildFakeIssue(index + 1),
    );
    let pages = 0;

    const { reported, result } = await pollEntitiesFeed(issues, {
      prepare: (world) => {
        world.override = (request) =>
          request.operationName === "LinearAssignedIssues" && (pages += 1) === 9
            ? { status: 500, body: {} }
            : undefined;
      },
    });

    expect(Result.isFailure(result)).toBe(true);
    expect(reported.reconciled).toEqual([]);
  });

  it("reports an inventory of exactly the host's limit as complete", async () => {
    const issues = Array.from({ length: MAX_ENTITY_OBSERVATIONS }, (_, index) =>
      buildFakeIssue(index + 1),
    );

    const { reported } = await pollEntitiesFeed(issues);

    expect(reconciledIssues(reported).complete).toBe(true);
  });
});

describe("the entities feed's project listing", () => {
  const projectInventories = (reported: ReportedEntities) =>
    reported.reconciled.filter(({ kind }) => kind === "project");

  it("reports every project of the workspace, with its health, in one complete call", async () => {
    const { reported } = await pollEntitiesFeed([], {
      prepare: (world) => {
        world.projects[1]!.health = "atRisk";
      },
    });

    const inventories = projectInventories(reported);
    expect(inventories).toHaveLength(1);
    expect(inventories[0]!.complete).toBe(true);
    expect(inventories[0]!.observations.map((observation) => observation.ref)).toEqual([
      placeRef("project", "project-checkout"),
      placeRef("project", "project-oncall"),
    ]);
    expect(full(inventories[0]!.observations[1])).toMatchObject({
      kind: "project",
      title: "On-call tooling",
      status: "at-risk",
      concerns: [],
    });
  });

  it("lists a project no issue sits in, and makes one call however many pages Linear has", async () => {
    const { reported, requestNames } = await pollEntitiesFeed([buildFakeIssue(1)], {
      pageSize: 1,
    });

    expect(projectInventories(reported)).toHaveLength(1);
    expect(projectInventories(reported)[0]!.observations).toHaveLength(2);
    expect(requestNames.filter((name) => name === "LinearProjects")).toHaveLength(2);
  });

  it("reports each project with the initiatives and teams it is part of", async () => {
    const { reported } = await pollEntitiesFeed([], {
      prepare: (world) => {
        world.projects[0]!.initiativeIds = ["initiative-q4"];
      },
    });

    expect(full(projectInventories(reported)[0]!.observations[0]).relations).toEqual({
      complete: true,
      partOf: [placeRef("initiative", "initiative-q4"), placeRef("team", "team-eng")],
      linked: [],
    });
  });

  it("reads every page, keeps the smallest refs whatever the order Linear lists in, and asks for pages Linear can afford", async () => {
    const count = MAX_ENTITY_OBSERVATIONS + 5;
    const { reported, fake } = await pollEntitiesFeed([], {
      prepare: (world) => {
        // More pages than any fixed page limit, listed in reverse of ref order.
        world.projects = Array.from({ length: count }, (_, index) => ({
          id: `p-${String(index).padStart(5, "0")}`,
          name: `Project ${String(index)}`,
          url: `https://linear.app/acme/project/p-${String(index)}`,
          teamIds: [],
        })).reverse();
      },
    });

    const listing = fake.requests.filter(({ operationName }) => operationName === "LinearProjects");
    expect(listing).toHaveLength(Math.ceil(count / 50));
    expect(listing.every(({ variables }) => variables["first"] === 50)).toBe(true);
    const [inventory] = projectInventories(reported);
    expect(inventory!.observations).toHaveLength(MAX_ENTITY_OBSERVATIONS);
    expect(inventory!.observations[0]!.ref).toBe(placeRef("project", "p-00000"));
    expect(inventory!.observations.at(-1)!.ref).toBe(
      placeRef("project", `p-${String(MAX_ENTITY_OBSERVATIONS - 1).padStart(5, "0")}`),
    );
  });

  it("still refreshes what the host wants when the project listing fails", async () => {
    const fake = buildFakeLinear(buildFakeWorld([buildFakeIssue(1)]));
    fake.world.override = (request) =>
      request.operationName === "LinearProjects" ? { status: 500, body: {} } : undefined;
    const { entities, reported } = buildFakeEntities({ team: [placeRef("team", "team-eng")] });

    const result = await runAgainstStub(
      pollWithConnection("entities", {}, { ...buildIngestHarness().context, entities }),
      fake,
    );

    expect(Result.isSuccess(result)).toBe(false);
    expect(reported.reconciled.map(({ kind }) => kind)).toEqual(["issue"]);
    expect(reported.refreshed.flat().map(({ ref }) => ref)).toEqual([placeRef("team", "team-eng")]);
  });
});

describe("the fields of an issue", () => {
  it.each([
    [0, "none", null],
    [1, "urgent", 3],
    [2, "high", 3],
    [3, "medium", 2],
    [4, "low", 1],
  ])(
    "reports Linear's priority %i as %s, and the bars level %s",
    async (priority, value, level) => {
      const { reported } = await pollEntitiesFeed([buildFakeIssue(1, { priority })]);

      expect(full(reconciledIssues(reported).observations[0]).fields).toMatchObject({
        priority: value,
        priorityLevel: level,
      });
    },
  );

  it("reports no project for an issue outside any project, and the workflow state's name as its status", async () => {
    const { reported } = await pollEntitiesFeed([
      buildFakeIssue(1, { state: { id: "state-qa", name: "QA", type: "started" } }),
    ]);

    expect(full(reconciledIssues(reported).observations[0]).fields).toMatchObject({
      project: null,
      status: "QA",
    });
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

  it("splits a refresh of more places and issues than the host takes into calls it accepts", async () => {
    const children = Array.from({ length: MAX_ENTITY_OBSERVATIONS }, (_, index) =>
      buildFakeIssue(index + 1),
    );
    const parents = children.map((_, index) =>
      buildFakeIssue(10_000 + index, { assignee: { ...OTHER_USER } }),
    );
    const wanted = buildFakeIssue(99_999, {
      assignee: { ...OTHER_USER },
      state: { ...FAKE_STATES.completed },
    });

    const { reported, result } = await pollEntitiesFeed([...children, ...parents, wanted], {
      wanted: [refOf(wanted.id)],
      prepare: (world) => {
        children.forEach((child, index) => {
          world.parents[child.id] = parents[index]!.id;
        });
      },
    });

    expect(Result.isSuccess(result)).toBe(true);
    expect(reported.refreshed.map((call) => call.length)).toEqual([MAX_ENTITY_OBSERVATIONS, 1]);
    const refs = reported.refreshed.flat().map((observation) => observation.ref);
    expect(new Set(refs).size).toBe(MAX_ENTITY_OBSERVATIONS + 1);
    expect(refs).toContain(refOf(wanted.id));
  }, 30_000);

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
  it("sends one paged read, one batched context read and one batched refresh, never one request per issue", async () => {
    const issues = Array.from({ length: 30 }, (_, index) => buildFakeIssue(index + 1));
    const wanted = Array.from({ length: 20 }, (_, index) => refOf(`issue-${String(index + 100)}`));

    const { fake, requestNames, reported } = await pollEntitiesFeed(issues, { wanted });

    expect(requestNames).toEqual([
      "LinearIdentity",
      "LinearAssignedIssues",
      "LinearIssueContext",
      "LinearIssueLookup",
      "LinearProjects",
    ]);
    expect(fake.requests[3]?.variables["filter"]).toEqual({
      id: { in: wanted.map((ref) => ref.split("/")[1]) },
    });
    expect(reported.listed.map(({ kind }) => kind)).toEqual([
      "issue",
      "project",
      "initiative",
      "milestone",
      "team",
    ]);
  });

  it("reads the context of 120 issues in three requests", async () => {
    const issues = Array.from({ length: 120 }, (_, index) => buildFakeIssue(index + 1));

    const { requestNames } = await pollEntitiesFeed(issues);

    expect(requestNames.filter((name) => name === "LinearIssueContext")).toHaveLength(3);
    expect(requestNames).toHaveLength(1 + 1 + 3 + 1);
  });

  it("sends no refresh request when the host wants nothing read", async () => {
    const { requestNames } = await pollEntitiesFeed([buildFakeIssue(1)]);

    expect(requestNames).toEqual([
      "LinearIdentity",
      "LinearAssignedIssues",
      "LinearIssueContext",
      "LinearProjects",
    ]);
  });

  it("sends one request for each kind of place the host wants, however many it wants", async () => {
    const wantedPlaces = {
      project: ["project-checkout", "project-oncall"].map((id) => placeRef("project", id)),
      team: ["team-eng", "team-ops"].map((id) => placeRef("team", id)),
    };

    const { requestNames } = await pollEntitiesFeed([], { wantedPlaces });

    expect(requestNames).toEqual([
      "LinearIdentity",
      "LinearAssignedIssues",
      "LinearProjectContext",
      "LinearTeamContext",
      "LinearProjects",
    ]);
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

describe("the context of an issue", () => {
  /** Polls with a parent issue in another project, a project, a milestone and attachments. */
  const pollWithContext = (options: {
    readonly attachments?: Array<string>;
    readonly description?: string | null;
    readonly prepare?: (world: FakeWorld) => void;
  }) => {
    const child = buildFakeIssue(1, {
      project: { id: "project-checkout", name: "Checkout revamp" },
      projectMilestone: { id: "milestone-beta", name: "Beta" },
      description: options.description === undefined ? "Fixes the button." : options.description,
    });
    const parent = buildFakeIssue(2, {
      assignee: { ...OTHER_USER },
      project: { id: "project-oncall", name: "On-call tooling" },
      title: "Checkout epic",
    });
    return pollEntitiesFeed([child, parent], {
      prepare: (world) => {
        world.parents[child.id] = parent.id;
        world.attachments[child.id] = options.attachments ?? [];
        options.prepare?.(world);
      },
    });
  };

  /** The observation the inventory reported for the issue `id`. */
  const inventoried = (reported: ReportedEntities, id: string) =>
    full(reconciledIssues(reported).observations.find((o) => o.ref === refOf(id)));

  it("lists every place above an issue by every path, each once: its parent, project, milestone and team", async () => {
    const { reported } = await pollWithContext({});

    expect(inventoried(reported, "issue-1").relations).toEqual({
      complete: true,
      partOf: [
        refOf("issue-2"),
        placeRef("project", "project-checkout"),
        placeRef("milestone", "milestone-beta"),
        placeRef("team", "team-eng"),
      ],
      linked: [],
      linkedUrls: [],
    });
  });

  it("reports the parent issue as a partial observation, so it is a place until it is read in full", async () => {
    const { reported } = await pollWithContext({});

    // The parent is not assigned to the user, so only the context read knows it.
    expect(reported.refreshed.flat()).toEqual([
      expect.objectContaining({
        kind: "issue",
        ref: refOf("issue-2"),
        title: "Checkout epic",
        partial: true,
        fields: { key: "ENG-2" },
      }),
    ]);
  });

  it("reports the attachments' links, each once, and leaves out links nobody can open", async () => {
    const { reported } = await pollWithContext({
      attachments: [
        "https://github.com/acme/web/pull/7",
        "https://github.com/acme/web/pull/7",
        "slack://channel?id=C1",
        "https://github.com/acme/web/pull/8",
      ],
    });

    expect(inventoried(reported, "issue-1").relations).toMatchObject({
      complete: true,
      linkedUrls: ["https://github.com/acme/web/pull/7", "https://github.com/acme/web/pull/8"],
    });
  });

  it("reports the description as a text with the issue's update time as its revision", async () => {
    const { reported } = await pollWithContext({});

    const observation = inventoried(reported, "issue-1");
    expect(observation.texts).toEqual([
      {
        evidenceKey: "description",
        text: "Fixes the button.",
        revision: observation.sourceUpdatedAt,
      },
    ]);
  });

  it("reports an empty text for an issue without a description, so old hints clear", async () => {
    const { reported } = await pollWithContext({ description: null });

    const observation = inventoried(reported, "issue-1");
    expect(observation.texts).toEqual([
      { evidenceKey: "description", text: "", revision: observation.sourceUpdatedAt },
    ]);
  });

  it("says the relations are not complete when the attachments have another page", async () => {
    const attachments = Array.from(
      { length: 51 },
      (_, i) => `https://example.com/doc/${String(i)}`,
    );

    const { reported } = await pollWithContext({ attachments });

    const { relations } = inventoried(reported, "issue-1");
    expect(relations?.complete).toBe(false);
    expect(relations?.linkedUrls).toHaveLength(50);
  });

  it("says the relations are not complete when more links are listed than one observation holds", () => {
    const issue = buildFakeIssue(1);
    const attachments = Array.from(
      { length: MAX_ENTITY_RELATIONS + 6 },
      (_, index) => `https://example.com/doc/${String(index)}`,
    );

    const { relations } = buildIssueContextFields(
      Schema.decodeUnknownSync(ApiIssue)(issue),
      { id: TEST_ORGANIZATION.id, urlKey: TEST_ORGANIZATION.urlKey },
      {
        id: issue.id,
        parent: null,
        attachments: {
          nodes: attachments.map((url) => ({ url })),
          pageInfo: { hasNextPage: false },
        },
      },
    );

    expect(relations?.complete).toBe(false);
    expect(relations?.linkedUrls).toHaveLength(MAX_ENTITY_RELATIONS);
  });

  it("reports an issue whose context read failed with what the issue itself knows, and not complete", async () => {
    const { reported, result } = await pollWithContext({
      prepare: (world) => {
        world.override = (request) =>
          request.operationName === "LinearIssueContext" ? { status: 500, body: {} } : undefined;
      },
    });

    expect(Result.isSuccess(result)).toBe(true);
    const { relations, texts } = inventoried(reported, "issue-1");
    expect(relations).toEqual({
      complete: false,
      partOf: [
        placeRef("project", "project-checkout"),
        placeRef("milestone", "milestone-beta"),
        placeRef("team", "team-eng"),
      ],
      linked: [],
    });
    expect(texts).toHaveLength(1);
    expect(reported.refreshed).toEqual([]);
  });

  it("reports nothing and asks for a wait when Linear rate limits the context read", async () => {
    const { reported, result } = await pollWithContext({
      prepare: (world) => {
        world.override = (request) =>
          request.operationName === "LinearIssueContext"
            ? {
                status: 400,
                headers: { "retry-after": "30" },
                body: { errors: [{ message: "limited", extensions: { code: "RATELIMITED" } }] },
              }
            : undefined;
      },
    });

    expect(result).toEqual(Result.succeed({ nextAfterSeconds: 30 }));
    expect(reported.reconciled).toEqual([]);
  });

  it("reads the context of a refreshed issue too", async () => {
    const issue = buildFakeIssue(5, { assignee: { ...OTHER_USER } });

    const { reported } = await pollEntitiesFeed([issue], {
      wanted: [refOf(issue.id)],
      prepare: (world) => {
        world.attachments[issue.id] = ["https://github.com/acme/web/pull/9"];
      },
    });

    expect(full(reported.refreshed[0]?.[0]).relations?.linkedUrls).toEqual([
      "https://github.com/acme/web/pull/9",
    ]);
  });

  it("reports observations the host's schema accepts", async () => {
    const { reported } = await pollWithContext({
      attachments: ["https://github.com/acme/web/pull/7"],
    });

    for (const observation of [
      ...reconciledIssues(reported).observations,
      ...reported.refreshed.flat(),
    ]) {
      expect(() => Schema.decodeUnknownSync(EntityObservation)(observation)).not.toThrow();
    }
  });
});

describe("the context of a place", () => {
  const initiatives = [
    { id: "init-growth", name: "Grow checkout", url: "https://linear.app/acme/initiative/growth" },
    {
      id: "init-q4",
      name: "Q4 bets",
      url: "https://linear.app/acme/initiative/q4",
      parentId: "init-growth",
      health: "atRisk" as const,
      targetDate: "2026-12-31",
    },
  ];

  /** Polls with the host wanting `wantedPlaces`, over a workspace that holds the initiatives. */
  const pollPlaces = (
    wantedPlaces: Readonly<Record<string, ReadonlyArray<string>>>,
    prepare: (world: FakeWorld) => void = () => {},
  ) =>
    pollEntitiesFeed([], {
      wantedPlaces,
      prepare: (world) => {
        world.initiatives = initiatives;
        prepare(world);
      },
    });

  /** Returns the one observation reported for a place. */
  const refreshedPlace = (reported: ReportedEntities, ref: string) =>
    full(reported.refreshed.flat().find((observation) => observation.ref === ref));

  it("reports a project in two initiatives and a team as its parents, with what Linear says of its health, date and progress", async () => {
    const { reported } = await pollPlaces(
      { project: [placeRef("project", "project-checkout")] },
      (world) => {
        const project = world.projects[0]!;
        Object.assign(project, {
          initiativeIds: ["init-growth", "init-q4"],
          health: "offTrack",
          progress: 0.4,
          targetDate: "2026-12-01",
        });
      },
    );

    const project = refreshedPlace(reported, placeRef("project", "project-checkout"));
    expect(project).toMatchObject({
      kind: "project",
      title: "Checkout revamp",
      status: "off-track",
      progress: { fraction: 0.4 },
      targetDate: "2026-12-01T12:00:00.000Z",
      concerns: [],
      relations: {
        complete: true,
        partOf: [
          placeRef("initiative", "init-growth"),
          placeRef("initiative", "init-q4"),
          placeRef("team", "team-eng"),
        ],
      },
    });
  });

  it("reports the progress Linear gives and never works it out from the issues it can see", async () => {
    const done = buildFakeIssue(1, {
      project: { id: "project-checkout", name: "Checkout revamp" },
      state: { ...FAKE_STATES.completed },
    });

    const { reported } = await pollEntitiesFeed([done], {
      wantedPlaces: { project: [placeRef("project", "project-checkout")] },
      prepare: (world) => {
        world.projects[0]!.progress = 0.25;
      },
    });

    // The only issue of the project is done, which would make 100% if it were counted.
    expect(refreshedPlace(reported, placeRef("project", "project-checkout")).progress).toEqual({
      fraction: 0.25,
    });
  });

  it("says a project's relations are not complete when Linear has more initiatives than it listed", async () => {
    const many = Array.from({ length: 51 }, (_, index) => `init-${String(index)}`);

    const { reported } = await pollPlaces(
      { project: [placeRef("project", "project-checkout")] },
      (world) => {
        world.projects[0]!.initiativeIds = many;
      },
    );

    const { relations } = refreshedPlace(reported, placeRef("project", "project-checkout"));
    expect(relations?.complete).toBe(false);
    expect(relations?.partOf).toHaveLength(50 + 1);
  });

  it("says a project's relations are not complete when each parent was listed but too many for one observation", async () => {
    const initiativeIds = Array.from({ length: 50 }, (_, index) => `init-${String(index)}`);
    const teamIds = Array.from({ length: 30 }, (_, index) => `team-${String(index)}`);

    const { reported } = await pollPlaces(
      { project: [placeRef("project", "project-checkout")] },
      (world) => {
        Object.assign(world.projects[0]!, { initiativeIds, teamIds });
      },
    );

    const { relations } = refreshedPlace(reported, placeRef("project", "project-checkout"));
    expect(relations?.complete).toBe(false);
    expect(relations?.partOf).toHaveLength(MAX_ENTITY_RELATIONS);
  });

  it("counts a parent Linear lists twice once, and keeps the relations complete", async () => {
    const initiativeIds = Array.from({ length: 50 }, (_, index) => `init-${String(index % 40)}`);

    const { reported } = await pollPlaces(
      { project: [placeRef("project", "project-checkout")] },
      (world) => {
        Object.assign(world.projects[0]!, { initiativeIds });
      },
    );

    const { relations } = refreshedPlace(reported, placeRef("project", "project-checkout"));
    expect(relations?.complete).toBe(true);
    expect(relations?.partOf).toHaveLength(40 + 1);
  });

  it("reports an initiative with its parent initiative, and a milestone under its project, and a team with no progress they were not given", async () => {
    const { reported } = await pollPlaces({
      initiative: [placeRef("initiative", "init-q4")],
      milestone: [placeRef("milestone", "milestone-beta")],
      team: [placeRef("team", "team-ops")],
    });

    const initiative = refreshedPlace(reported, placeRef("initiative", "init-q4"));
    expect(initiative).toMatchObject({
      status: "at-risk",
      targetDate: "2026-12-31T12:00:00.000Z",
      relations: { complete: true, partOf: [placeRef("initiative", "init-growth")] },
    });
    expect(initiative.progress).toBeUndefined();
    // The milestone is part of its project, so an issue is drawn under the project once.
    expect(refreshedPlace(reported, placeRef("milestone", "milestone-beta"))).toMatchObject({
      kind: "milestone",
      title: "Beta",
      relations: { complete: true, partOf: [placeRef("project", "project-checkout")] },
    });
    const team = refreshedPlace(reported, placeRef("team", "team-ops"));
    expect(team).toMatchObject({ kind: "team", title: "Operations" });
    expect(team.relations).toBeUndefined();
  });

  it("leaves a project Linear does not return as a claim with no record, reported inaccessible", async () => {
    const { reported } = await pollPlaces({
      project: [placeRef("project", "project-oncall"), placeRef("project", "project-secret")],
    });

    expect(reported.missing).toEqual([
      { ref: placeRef("project", "project-secret"), reason: "inaccessible" },
    ]);
    expect(reported.refreshed.flat().map((observation) => observation.ref)).toEqual([
      placeRef("project", "project-oncall"),
    ]);
  });

  it("reports observations the host's schema accepts", async () => {
    const { reported } = await pollPlaces(
      {
        project: [placeRef("project", "project-checkout")],
        initiative: [placeRef("initiative", "init-q4")],
        milestone: [placeRef("milestone", "milestone-beta")],
        team: [placeRef("team", "team-eng")],
      },
      (world) => {
        Object.assign(world.projects[0]!, { initiativeIds: ["init-q4"], health: "onTrack" });
      },
    );

    expect(reported.refreshed.flat()).toHaveLength(4);
    for (const observation of reported.refreshed.flat()) {
      expect(() => Schema.decodeUnknownSync(EntityObservation)(observation)).not.toThrow();
    }
  });
});
