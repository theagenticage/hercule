/**
 * Tests how a Sentry issue becomes an observation: the team rule, the status
 * and lifecycle table, who the issue concerns, and that the ref is the one
 * the issue's events carry.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { EntityObservation, type EntityObservation as Observation } from "@hercule/plugin-host";
import {
  buildIssueObservation,
  isDeletedInSentry,
  readIssueObservationContext,
  type IssueObservationContext,
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

/**
 * The limits the core puts on what an observation reports (see
 * `apps/controller/src/external-entities/slots.ts`): an identifier of at most
 * 64 characters and a person or owner name of at most 120. A plugin must not
 * import the controller, so they are written here. The core refuses a whole
 * inventory that holds one observation over them.
 */
const CORE_MAX_IDENTIFIER_LENGTH = 64;
const CORE_MAX_PERSON_NAME_LENGTH = 120;

/** Builds an issue as Sentry returns it, from the fake's own rendering. */
const buildApiIssue = (overrides: Partial<FakeIssue> = {}): ApiIssue =>
  Schema.decodeUnknownSync(ApiIssue)(renderFakeIssue(world, buildFakeIssue("1001", overrides)));

/**
 * Which teams own the project the issue is in (project 11), as the
 * organization's projects list them. `null` leaves the project out of the list.
 */
type ProjectTeams = ReadonlyArray<string> | null;
const ONE_TEAM: ProjectTeams = ["31"];
const TWO_TEAMS: ProjectTeams = ["31", "32"];

/** Reads the observation context from a fake organization whose project 11 has these teams. */
const readContext = async (
  projectTeams: ProjectTeams = ONE_TEAM,
): Promise<IssueObservationContext> => {
  const fakeWorld = buildFakeWorld();
  fakeWorld.projects =
    projectTeams === null
      ? []
      : [{ id: "11", slug: "webshop", name: "Webshop", teamIds: [...projectTeams] }];
  const result = await runAgainstStub(
    readIssueObservationContext(
      { token: TEST_TOKEN, organization: TEST_ORGANIZATION },
      TEST_USER.id,
    ),
    buildFakeSentry(fakeWorld),
  );
  if (result._tag !== "Success") throw new Error("the context could not be read");
  return result.success;
};

/** Builds the observation of an issue that must not be gone, and checks the core would accept it. */
const observeIssue = async (
  issue: ApiIssue,
  projectTeams: ProjectTeams = ONE_TEAM,
  concerns: ReadonlyArray<"assigned"> = [],
) => {
  const observation = buildIssueObservation(issue, await readContext(projectTeams), concerns);
  expect(observation).toBeDefined();
  expect(Schema.is(EntityObservation)(observation)).toBe(true);
  return observation as Extract<Observation, { partial?: false }>;
};

const observe = (
  overrides: Partial<FakeIssue> = {},
  projectTeams: ProjectTeams = ONE_TEAM,
  concerns: ReadonlyArray<"assigned"> = [],
) => observeIssue(buildApiIssue(overrides), projectTeams, concerns);

describe("the team rule", () => {
  it.each([
    [
      "a team holds the issue: that team",
      { type: "team", id: "32", name: "payments" },
      TWO_TEAMS,
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
    ["the project has no team: no team", null, [], null],
    ["the project is not listed: no team", null, null, null],
  ] as const)("%s", async (_case, assignedTo, teams, team) => {
    expect((await observe({ assignedTo }, teams)).fields["team"]).toBe(team);
  });

  it("gives a team the same name whether it holds the issue or is the project's only team", async () => {
    const assigned = await observe({ assignedTo: { type: "team", id: "31", name: "platform" } });
    const onlyTeam = await observe({ assignedTo: null });
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
  ] as const)("%s with substatus %s is %s, keyed %s", async (status, substatus, lifecycle, key) => {
    const observation = await observe({ status, substatus });
    expect(observation.lifecycle).toBe(lifecycle);
    expect(observation.status).toBe(key);
  });

  it("is open with no status key for a status the plugin does not know", async () => {
    const observation = await observe({ status: "something_new", substatus: null });
    expect(observation.lifecycle).toBe("open");
    expect(observation.status).toBeUndefined();
  });

  it.each(["pending_deletion", "deletion_in_progress", "pending_merge", "reprocessing"])(
    "has no observation while Sentry reports %s",
    async (status) => {
      expect(
        buildIssueObservation(buildApiIssue({ status }), await readContext(), []),
      ).toBeUndefined();
    },
  );

  it.each([
    ["pending_deletion", true],
    ["deletion_in_progress", true],
    ["pending_merge", true],
    // Temporary, and the issue comes back: not evidence of a deletion.
    ["reprocessing", false],
    ["unresolved", false],
  ])("%s is deleted in Sentry: %s", (status, deleted) => {
    expect(isDeletedInSentry(buildApiIssue({ status }))).toBe(deleted);
  });
});

describe("who the issue concerns", () => {
  const user = { type: "user", id: "88", name: "Ada Lovelace" } as const;
  const team = { type: "team", id: "31", name: "platform" } as const;

  it("is the user's own and says so when it is assigned to the user", async () => {
    const observation = await observe({ assignedTo: user }, ONE_TEAM, ["assigned"]);
    expect(observation).toMatchObject({
      concerns: ["assigned"],
      ownedByYou: true,
      reason: "assigned",
    });
    expect(observation.fields["assignee"]).toBe("Ada Lovelace");
  });

  it("is not the user's own and names the team when a team holds it", async () => {
    const observation = await observe({ assignedTo: team }, ONE_TEAM, ["assigned"]);
    expect(observation).toMatchObject({
      concerns: ["assigned"],
      ownedByYou: false,
      reason: "team-assigned",
    });
    expect(observation.fields["assignee"]).toBeNull();
  });

  it("is not the user's own and has no reason when someone else holds it", async () => {
    const other = { type: "user", id: "89", name: "Grace Hopper" } as const;
    const observation = await observe({ assignedTo: other });
    expect(observation.ownedByYou).toBe(false);
    expect(observation.reason).toBeUndefined();
  });

  it("keeps the reason from the assignment when the report names no concern", async () => {
    // A refresh reports no concerns; it must not clear a reason an inventory gave.
    const own = await observe({ assignedTo: user });
    expect(own).toMatchObject({ concerns: [], ownedByYou: true, reason: "assigned" });
    const held = await observe({ assignedTo: team });
    expect(held).toMatchObject({ concerns: [], ownedByYou: false, reason: "team-assigned" });
  });
});

describe("the fields", () => {
  it("reports what Sentry says, in the forms the core accepts", async () => {
    const observation = await observe({
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

  it("reports an unknown level as no severity, and an unreadable count as no events", async () => {
    const observation = await observe({ level: "sample", count: "many" });
    expect(observation.fields["severity"]).toBeNull();
    expect(observation.fields["events"]).toBeNull();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "reports %s users as no users",
    async (userCount) => {
      expect((await observe({ userCount })).fields["users"]).toBeNull();
    },
  );

  it("uses the short id as the title when the title is empty", async () => {
    expect((await observe({ title: "  " })).title).toBe("WEBSHOP-1001");
  });

  it("links to the issue on the organization's own host when the permalink is not a web link", async () => {
    const observation = await observeIssue({
      ...buildApiIssue(),
      permalink: "javascript:alert(1)",
    });
    expect(observation.url).toBe("https://acme.sentry.io/issues/1001/");
  });

  it("links to the issue on the organization's own host when the permalink is too long", async () => {
    const permalink = `https://acme.sentry.io/issues/1001/?${"q".repeat(3000)}`;
    const observation = await observeIssue({ ...buildApiIssue(), permalink });
    expect(observation.url).toBe("https://acme.sentry.io/issues/1001/");
  });

  it("cuts a short id and a name to the limits the core refuses an inventory for", async () => {
    const issue = {
      ...buildApiIssue(),
      shortId: "S".repeat(67),
      assignedTo: { type: "user" as const, id: TEST_USER.id, name: "N".repeat(121) },
    };
    const observation = await observeIssue(issue);
    const { shortId, assignee } = observation.fields as { shortId: string; assignee: string };
    expect(shortId.length).toBeLessThanOrEqual(CORE_MAX_IDENTIFIER_LENGTH);
    expect(assignee.length).toBeLessThanOrEqual(CORE_MAX_PERSON_NAME_LENGTH);
    expect(shortId.length).toBeGreaterThan(0);
    expect(assignee.length).toBeGreaterThan(0);
  });
});

describe("the ref", () => {
  it("is byte-identical to the first ref of the issue's events", async () => {
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
    const observation = buildIssueObservation(issue, await readContext(), []);
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

describe("readIssueObservationContext", () => {
  it("names the organization and the user, and the teams by the project's listing", async () => {
    const context = await readContext();
    expect(context).toMatchObject({
      organizationId: TEST_ORGANIZATION.id,
      organizationSlug: TEST_ORGANIZATION.slug,
      userId: TEST_USER.id,
    });
  });

  it("gives a project in a list of more than 10 pages no team instead of failing", async () => {
    const fakeWorld = buildFakeWorld();
    fakeWorld.projects = Array.from({ length: 1001 }, (_, index) => ({
      id: String(index + 11),
      slug: `project-${String(index)}`,
      name: `Project ${String(index)}`,
      teamIds: ["31"],
    }));
    const result = await runAgainstStub(
      readIssueObservationContext(
        { token: TEST_TOKEN, organization: TEST_ORGANIZATION },
        TEST_USER.id,
      ),
      buildFakeSentry(fakeWorld),
    );
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    const lastProjectIssue = (id: string) =>
      buildIssueObservation(
        Schema.decodeUnknownSync(ApiIssue)({
          ...renderFakeIssue(world, buildFakeIssue("1001")),
          project: { id, slug: "p", name: "P" },
        }),
        result.success,
        [],
      );
    // The first page's project has its team; the 1,001st, past the last page read, has none.
    expect(lastProjectIssue("11")?.fields).toMatchObject({ team: "Platform" });
    expect(lastProjectIssue("1011")?.fields).toMatchObject({ team: null });
  });
});
