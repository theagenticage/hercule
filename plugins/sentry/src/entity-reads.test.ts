/**
 * Tests how a Sentry issue becomes an observation: the team rule, the status
 * and lifecycle table, who the issue concerns, and that the ref is the one
 * the issue's events carry.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  EntityKindDeclaration,
  EntityObservation,
  SavedQuery,
  type EntityObservation as Observation,
} from "@hercule/plugin-host";
import { SENTRY_ENTITY_KINDS, SENTRY_SAVED_QUERIES } from "./entity-kinds";
import {
  buildIssueObservation,
  readOrganizationTeams,
  type OrganizationTeams,
} from "./entity-reads";
import { buildIssueEvent } from "./ingest/events";
import { parseIssueRef } from "./refs";
import { ApiIssue, buildIssueBlock } from "./sentry-objects";
import {
  buildFakeIssue,
  buildFakeSentry,
  buildFakeWorld,
  renderFakeIssue,
  runAgainstStub,
  TEST_ORGANIZATION,
  TEST_TOKEN,
  TEST_USER,
  type FakeIssue,
} from "./testing";

const world = buildFakeWorld();

/** Builds an issue as Sentry returns it, from the fake's own rendering. */
const buildApiIssue = (overrides: Partial<FakeIssue> = {}): ApiIssue =>
  Schema.decodeUnknownSync(ApiIssue)(renderFakeIssue(world, buildFakeIssue("1001", overrides)));

/** Builds the teams of an organization whose projects are `ofProject`, with these team names. */
const buildTeams = (
  ofProject: Record<string, ReadonlyArray<string>>,
  names: Record<string, string> = { "31": "Platform", "32": "Payments" },
): OrganizationTeams => ({
  ofProject: new Map(Object.entries(ofProject)),
  names: new Map(Object.entries(names)),
});

const ONE_TEAM = buildTeams({ "11": ["31"] });
const TWO_TEAMS = buildTeams({ "11": ["31", "32"] });
const context = (teams: OrganizationTeams = ONE_TEAM) => ({
  organizationId: TEST_ORGANIZATION.id,
  userId: TEST_USER.id,
  teams,
});

/** Builds the observation of an issue that must not be gone, and checks the core would accept it. */
const observe = (
  overrides: Partial<FakeIssue> = {},
  teams: OrganizationTeams = ONE_TEAM,
  concerns: ReadonlyArray<"assigned"> = [],
) => {
  const observation = buildIssueObservation(buildApiIssue(overrides), context(teams), concerns);
  expect(observation).toBeDefined();
  expect(Schema.is(EntityObservation)(observation)).toBe(true);
  return observation as Extract<Observation, { partial?: false }>;
};

describe("the team rule", () => {
  it.each([
    [
      "a team holds the issue: that team",
      { type: "team", id: "32", name: "payments" },
      TWO_TEAMS,
      "Payments",
    ],
    [
      "a team holds it though the project has another team",
      { type: "team", id: "32", name: "payments" },
      ONE_TEAM,
      "Payments",
    ],
    [
      "a team no project lists holds it: the name on the assignment",
      { type: "team", id: "99", name: "ops" },
      ONE_TEAM,
      "ops",
    ],
    ["nobody holds it and the project has one team: that team", null, ONE_TEAM, "Platform"],
    [
      "a user holds it and the project has one team: that team",
      { type: "user", id: "88", name: "Ada" },
      ONE_TEAM,
      "Platform",
    ],
    ["nobody holds it and the project has two teams: no team", null, TWO_TEAMS, null],
    ["the project has no team: no team", null, buildTeams({ "11": [] }), null],
    ["the project is not listed: no team", null, buildTeams({}), null],
  ] as const)("%s", (_case, assignedTo, teams, team) => {
    expect(observe({ assignedTo }, teams).fields["team"]).toBe(team);
  });

  it("gives a team the same name whether it holds the issue or is the project's only team", () => {
    const assigned = observe({ assignedTo: { type: "team", id: "31", name: "platform" } });
    const onlyTeam = observe({ assignedTo: null });
    expect(assigned.fields["team"]).toBe("Platform");
    expect(onlyTeam.fields["team"]).toBe(assigned.fields["team"]);
  });
});

describe("status and lifecycle", () => {
  it.each([
    ["unresolved", "new", "open", "new"],
    ["unresolved", "escalating", "open", "escalating"],
    ["unresolved", "ongoing", "open", "ongoing"],
    ["unresolved", "regressed", "open", "regressed"],
    ["unresolved", null, "open", "ongoing"],
    ["unresolved", "archived_until_escalating", "open", "ongoing"],
    ["resolved", null, "completed", "resolved"],
    ["ignored", "archived_forever", "abandoned", "archived"],
  ] as const)("%s with substatus %s is %s, keyed %s", (status, substatus, lifecycle, key) => {
    const observation = observe({ status, substatus });
    expect(observation.lifecycle).toBe(lifecycle);
    expect(observation.status).toBe(key);
  });

  it("is open with no status key for a status the plugin does not know", () => {
    const observation = observe({ status: "something_new", substatus: null });
    expect(observation.lifecycle).toBe("open");
    expect(observation.status).toBeUndefined();
  });

  it.each(["pending_deletion", "deletion_in_progress", "pending_merge", "reprocessing"])(
    "has no observation while Sentry reports %s",
    (status) => {
      expect(buildIssueObservation(buildApiIssue({ status }), context(), [])).toBeUndefined();
    },
  );
});

describe("who the issue concerns", () => {
  const user = { type: "user", id: "88", name: "Ada Lovelace" } as const;
  const team = { type: "team", id: "31", name: "platform" } as const;

  it("is the user's own and says so when it is assigned to the user", () => {
    const observation = observe({ assignedTo: user }, ONE_TEAM, ["assigned"]);
    expect(observation).toMatchObject({
      concerns: ["assigned"],
      ownedByYou: true,
      reason: "assigned",
    });
    expect(observation.fields["assignee"]).toBe("Ada Lovelace");
  });

  it("is not the user's own and names the team when a team holds it", () => {
    const observation = observe({ assignedTo: team }, ONE_TEAM, ["assigned"]);
    expect(observation).toMatchObject({
      concerns: ["assigned"],
      ownedByYou: false,
      reason: "team-assigned",
    });
    expect(observation.fields["assignee"]).toBeNull();
  });

  it("is not the user's own when someone else holds it", () => {
    const other = { type: "user", id: "89", name: "Grace Hopper" } as const;
    expect(observe({ assignedTo: other }).ownedByYou).toBe(false);
  });

  it("has no reason when it concerns nobody", () => {
    const observation = observe({ assignedTo: user });
    expect(observation.concerns).toEqual([]);
    expect(observation.reason).toBeUndefined();
    expect(observation.ownedByYou).toBe(true);
  });
});

describe("the fields", () => {
  it("reports what Sentry says, in the forms the core accepts", () => {
    const observation = observe({
      level: "warning",
      count: "312",
      userCount: 97,
      firstSeen: "2026-10-12T08:00:00.123456Z",
      lastSeen: "2026-10-12T08:30:00Z",
    });
    expect(observation.fields).toEqual({
      shortId: "WEBSHOP-1001",
      team: "Platform",
      project: "webshop",
      severity: "warning",
      events: 312,
      users: 97,
      firstSeen: "2026-10-12T08:00:00.123Z",
      lastSeen: "2026-10-12T08:30:00.000Z",
      assignee: null,
    });
    expect(observation.sourceCreatedAt).toBe("2026-10-12T08:00:00.123Z");
    expect(observation.sourceUpdatedAt).toBe("2026-10-12T08:30:00.000Z");
    expect(observation.url).toBe("https://acme.sentry.io/issues/1001/");
  });

  it("reports an unknown level as no severity, and an unreadable count as no events", () => {
    const observation = observe({ level: "sample", count: "many" });
    expect(observation.fields["severity"]).toBeNull();
    expect(observation.fields["events"]).toBeNull();
  });

  it("uses the short id as the title when the title is empty", () => {
    expect(observe({ title: "  " }).title).toBe("WEBSHOP-1001");
  });
});

describe("the ref", () => {
  it("is byte-identical to the first ref of the issue's events", () => {
    const issue = buildApiIssue();
    const event = buildIssueEvent({
      kind: "entered",
      organization: TEST_ORGANIZATION,
      issue: buildIssueBlock(issue),
      fields: {},
      dedupKey: "k",
      occurredAt: issue.lastSeen,
      fallbackTime: issue.lastSeen,
    });
    const observation = buildIssueObservation(issue, context(), []);
    expect(observation?.ref).toBe(event.refs[0]);
    expect(parseIssueRef(observation!.ref)).toEqual({
      organizationId: TEST_ORGANIZATION.id,
      issueId: "1001",
    });
  });

  it.each([
    "sentry:project:4501/11",
    "sentry:issue:4501",
    "sentry:issue:acme/1001",
    "sentry:issue:4501/10a",
  ])("is not parsed from %s", (ref) => {
    expect(parseIssueRef(ref)).toBeUndefined();
  });
});

describe("readOrganizationTeams", () => {
  it("returns the team ids of each project and the name of each team", async () => {
    const sentry = buildFakeSentry(buildFakeWorld());
    const teams = await runAgainstStub(
      readOrganizationTeams({ token: TEST_TOKEN, organization: TEST_ORGANIZATION }),
      sentry,
    );
    expect(teams).toMatchObject({
      _tag: "Success",
      success: {
        ofProject: new Map([
          ["11", ["31"]],
          ["12", ["32"]],
        ]),
        names: new Map([
          ["31", "platform"],
          ["32", "payments"],
        ]),
      },
    });
  });
});

describe("what the plugin declares", () => {
  it("is accepted by the host's schemas", () => {
    for (const kind of SENTRY_ENTITY_KINDS) {
      expect(() => Schema.decodeUnknownSync(EntityKindDeclaration)(kind)).not.toThrow();
    }
    for (const query of SENTRY_SAVED_QUERIES) {
      expect(() => Schema.decodeUnknownSync(SavedQuery)(query)).not.toThrow();
    }
  });
});
