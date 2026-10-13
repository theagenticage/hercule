/**
 * Tests what the Linear plugin adds to the catalog, and its connection type:
 * `validate` and the choice lists of the config form, against the fake Linear.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result, Schema, SchemaAST } from "effect";
import type {
  ConnectionTypeContribution,
  EventSourceContribution,
  Plugin,
  RegistrationHost,
} from "@hercule/plugin-host";
import { LinearConnectionConfig } from "./connection-type";
import { linear } from "./index";
import {
  buildFakeLinear,
  buildFakeWorld,
  OTHER_USER,
  runAgainstStub,
  TEST_API_KEY,
  TEST_ORGANIZATION,
  TEST_USER,
  type FakeWorld,
} from "./testing";

/** Runs `register` and returns everything the plugin contributed. */
const collectContributions = async (
  plugin: Plugin,
): Promise<{
  readonly types: ReadonlyArray<ConnectionTypeContribution>;
  readonly sources: ReadonlyArray<EventSourceContribution>;
}> => {
  const types: Array<ConnectionTypeContribution> = [];
  const sources: Array<EventSourceContribution> = [];
  const host: RegistrationHost = {
    connections: {
      registerType: (contribution) => Effect.sync(() => void types.push(contribution)),
    },
    eventSources: { register: (definition) => Effect.sync(() => void sources.push(definition)) },
    workflowActions: { register: () => Effect.die("the plugin registers no workflow actions") },
  };
  await Effect.runPromise(plugin.register(host));
  return { types, sources };
};

/** Returns the one connection type the plugin contributes. */
const readConnectionType = async (): Promise<ConnectionTypeContribution> => {
  const contribution = (await collectContributions(linear)).types[0];
  if (contribution === undefined) throw new Error("the plugin registered no connection type");
  return contribution;
};

/** The event kinds the spec lists, written out because the list itself is what is tested. */
const KINDS = [
  "linear.issue.entered",
  "linear.issue.changed",
  "linear.issue.left",
  "linear.issue.closed",
  "linear.issue.unassigned",
  "linear.mentioned",
  "linear.assigned",
  "linear.notification",
  "linear.notification.archived",
] as const;

describe("what the linear plugin registers", () => {
  it("requests the capabilities its connection type and ingest use", () => {
    expect(linear.manifest).toMatchObject({
      id: "linear",
      displayName: "Linear",
      capabilities: ["connections", "event-sources", "events"],
    });
    expect(linear.manifest.mark?.paths).toHaveLength(1);
  });

  it("contributes one type with a redirect flow through the public client and a pasted key", async () => {
    const [type, ...others] = (await collectContributions(linear)).types;

    expect(others).toEqual([]);
    expect(type).toMatchObject({
      type: "linear",
      displayName: "Linear",
      setup: [
        { kind: "oauth" },
        { kind: "credentials", fields: [expect.objectContaining({ name: "apiKey" })] },
      ],
      oauth: {
        authorizationUrl: "https://linear.app/oauth/authorize",
        tokenUrl: "https://api.linear.app/oauth/token",
        scopes: ["read", "write"],
        extraParams: { prompt: "consent" },
        publicClient: {
          clientId: "900702e5f1522b44e9a312dfb21acc47",
          redirectUris: [
            "http://127.0.0.1:4937/oauth/callback",
            "http://localhost:4937/oauth/callback",
          ],
        },
      },
    });
    expect(type?.device).toBeUndefined();
  });

  it("contributes one event source with both feeds and every kind", async () => {
    const [source, ...others] = (await collectContributions(linear)).sources;

    expect(others).toEqual([]);
    expect(source?.id).toBe("linear");
    expect(source?.connectionType).toBe("linear/linear");
    expect(source?.feeds).toEqual({
      issues: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
      notifications: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
    });
    expect(Object.keys(source?.kinds ?? {}).sort()).toEqual([...KINDS].sort());
  });

  it("declares three signal kinds that read only the source's own event kinds", async () => {
    const source = (await collectContributions(linear)).sources[0]!;
    const signalKinds = source.signalKinds ?? [];

    expect(signalKinds.map((kind) => kind.word)).toEqual(["issue", "mention", "assigned"]);
    for (const kind of signalKinds) {
      for (const eventKind of [...kind.from, ...kind.ends.map((end) => end.eventKind)]) {
        expect(source.kinds[eventKind], `${kind.word} reads ${eventKind}`).toBeDefined();
      }
    }
  });
});

describe("the config of a Linear Connection", () => {
  it("accepts an empty config, which a new Connection has", () => {
    expect(Schema.decodeUnknownResult(LinearConnectionConfig)({})._tag).toBe("Success");
  });

  it("marks every field as chosen from a list", () => {
    for (const [name, field] of Object.entries(LinearConnectionConfig.fields)) {
      expect(SchemaAST.resolve(field.ast), name).toMatchObject({ choices: true });
    }
  });

  it("accepts only the open state types", () => {
    const decode = Schema.decodeUnknownResult(LinearConnectionConfig);

    expect(decode({ states: ["triage", "backlog", "unstarted", "started"] })._tag).toBe("Success");
    expect(decode({ states: ["completed"] })._tag).toBe("Failure");
  });
});

describe("validating a Linear credential", () => {
  const validate = async (
    credentials: Readonly<Record<string, string>>,
    arrange: (world: FakeWorld) => void = () => undefined,
  ) => {
    const world = buildFakeWorld();
    arrange(world);
    const type = await readConnectionType();
    return runAgainstStub(type.validate(credentials), buildFakeLinear(world));
  };

  it("returns the workspace and user ids as the account, and their names as the display name", async () => {
    const result = await validate({ apiKey: TEST_API_KEY });

    expect(Result.isSuccess(result) && result.success).toEqual({
      accountId: `${TEST_ORGANIZATION.id}:${TEST_USER.id}`,
      displayName: "Acme · Ada Lovelace",
    });
  });

  it("sends the access token of the redirect flow as a bearer token", async () => {
    const result = await validate({ accessToken: "lin_oauth_invented" }, (world) => {
      world.apiKey = "Bearer lin_oauth_invented";
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  it("fails when Linear refuses the credential", async () => {
    const result = await validate({ apiKey: "lin_api_wrong" });

    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "ConnectionValidationFailed",
      message: "Linear rejected the credential.",
    });
  });

  it("fails when the credentials hold neither a key nor a token", async () => {
    const result = await validate({});

    expect(Result.isFailure(result) && result.failure._tag).toBe("ConnectionValidationFailed");
  });
});

describe("the choices of the config form", () => {
  const listChoices = async (
    field: string,
    config: LinearConnectionConfig = {},
    arrange: (world: FakeWorld) => void = () => undefined,
  ) => {
    const world = buildFakeWorld();
    arrange(world);
    const type = await readConnectionType();
    return runAgainstStub(
      type.listChoices!(field, { credentials: { apiKey: TEST_API_KEY }, config }),
      buildFakeLinear(world),
    );
  };

  it("lists the teams by key and name", async () => {
    const result = await listChoices("teams");

    expect(Result.isSuccess(result) && result.success).toEqual([
      { value: "team-eng", label: "ENG · Engineering" },
      { value: "team-ops", label: "OPS · Operations" },
    ]);
  });

  it("lists No project, then the projects of the chosen teams", async () => {
    const result = await listChoices("projects", { teams: ["team-ops"] });

    expect(Result.isSuccess(result) && result.success).toEqual([
      { value: "none", label: "No project" },
      { value: "project-oncall", label: "On-call tooling" },
    ]);
  });

  it("lists the milestones of the chosen projects, and none without a project", async () => {
    const chosen = await listChoices("projectMilestones", { projects: ["project-checkout"] });
    expect(Result.isSuccess(chosen) && chosen.success).toEqual([
      { value: "milestone-beta", label: "Checkout revamp › Beta" },
    ]);

    const none = await listChoices("projectMilestones", { projects: ["none"] });
    expect(Result.isSuccess(none) && none.success).toEqual([]);
  });

  it("lists the workspace's labels and the chosen teams', without group labels", async () => {
    const result = await listChoices("labels", { teams: ["team-eng"] });

    expect(Result.isSuccess(result) && result.success).toEqual([
      { value: "label-bug", label: "Bug" },
      { value: "label-web", label: "Area › Web" },
    ]);
  });

  it("lists Me, Unassigned and Anyone, then the members", async () => {
    const result = await listChoices("assignees");

    expect(Result.isSuccess(result) && result.success).toEqual([
      { value: "me", label: "Me" },
      { value: "none", label: "Unassigned" },
      { value: "anyone", label: "Anyone" },
      { value: `user:${TEST_USER.id}`, label: TEST_USER.name },
      { value: `user:${OTHER_USER.id}`, label: OTHER_USER.name },
    ]);
  });

  it("lists the four open states by Linear's names, without reading Linear", async () => {
    const result = await listChoices("states", {}, (world) => {
      world.override = () => ({ status: 500 });
    });

    expect(Result.isSuccess(result) && result.success.map((choice) => choice.label)).toEqual([
      "Triage",
      "Backlog",
      "Todo",
      "In progress",
    ]);
  });

  it("follows the pages of a long list", async () => {
    const result = await listChoices("assignees", {}, (world) => {
      world.pageSize = 1;
    });

    expect(Result.isSuccess(result) && result.success).toHaveLength(5);
  });

  it("fails, instead of cutting it, when a list has more than 1,000 items", async () => {
    const result = await listChoices("teams", {}, (world) => {
      world.teams = Array.from({ length: 1001 }, (_, index) => ({
        id: `team-${String(index)}`,
        key: `T${String(index)}`,
        name: `Team ${String(index)}`,
      }));
    });

    expect(Result.isFailure(result) && result.failure.message).toBe(
      "The Linear workspace has more than 1,000 teams to choose from.",
    );
  });

  it("fails with a plain PluginError when Linear refuses the credential", async () => {
    const result = await listChoices("teams", {}, (world) => {
      world.apiKey = "lin_api_another-key";
    });

    expect(Result.isFailure(result) && result.failure._tag).toBe("PluginError");
  });

  it("fails for a field it has no list for", async () => {
    const result = await listChoices("lastSeenDays");

    expect(Result.isFailure(result) && result.failure.message).toContain("lastSeenDays");
  });
});
