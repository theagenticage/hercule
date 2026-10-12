/**
 * Tests what the Sentry plugin adds to the catalog, and its connection type:
 * `validate` and the choice lists of the config form, against the fake Sentry.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result, Schema, SchemaAST } from "effect";
import type {
  ConnectionTypeContribution,
  EventSourceContribution,
  Plugin,
  RegistrationHost,
  WorkflowActionContribution,
} from "@hercule/plugin-host";
import { SentryConnectionConfig } from "./connection-type";
import { sentry } from "./index";
import {
  buildFakeSentry,
  buildFakeWorld,
  runAgainstStub,
  TEST_ACCOUNT_ID,
  TEST_DISPLAY_NAME,
  TEST_TOKEN,
} from "./testing";

/** Runs `register` and returns everything the plugin contributed. */
const collectContributions = async (
  plugin: Plugin,
): Promise<{
  readonly types: ReadonlyArray<ConnectionTypeContribution>;
  readonly sources: ReadonlyArray<EventSourceContribution>;
  readonly actions: ReadonlyArray<WorkflowActionContribution>;
}> => {
  const types: Array<ConnectionTypeContribution> = [];
  const sources: Array<EventSourceContribution> = [];
  const actions: Array<WorkflowActionContribution> = [];
  const host: RegistrationHost = {
    connections: {
      registerType: (contribution) => Effect.sync(() => void types.push(contribution)),
    },
    eventSources: { register: (definition) => Effect.sync(() => void sources.push(definition)) },
    workflowActions: {
      register: (contribution) => Effect.sync(() => void actions.push(contribution)),
    },
  };
  await Effect.runPromise(plugin.register(host));
  return { types, sources, actions };
};

/** Returns the one connection type the plugin contributes. */
const readConnectionType = async (): Promise<ConnectionTypeContribution> => {
  const contribution = (await collectContributions(sentry)).types[0];
  if (contribution === undefined) throw new Error("the plugin registered no connection type");
  return contribution;
};

/** The event kinds the pipeline spec lists, written out because the list itself is what is tested. */
const KINDS = [
  "sentry.issue.entered",
  "sentry.issue.regressed",
  "sentry.issue.escalating",
  "sentry.issue.resolved",
  "sentry.issue.archived",
  "sentry.issue.left",
] as const;

describe("what the sentry plugin registers", () => {
  it("requests the capabilities its connection type, ingest and actions use", () => {
    expect(sentry.manifest).toMatchObject({
      id: "sentry",
      displayName: "Sentry",
      capabilities: ["connections", "event-sources", "events", "workflow-actions"],
    });
    expect(sentry.manifest.mark?.paths).toHaveLength(1);
  });

  it("contributes one type with a device flow and a pasted token", async () => {
    const [type, ...others] = (await collectContributions(sentry)).types;

    expect(others).toEqual([]);
    expect(type).toMatchObject({
      type: "sentry",
      displayName: "Sentry",
      setup: [
        { kind: "device" },
        {
          kind: "credentials",
          fields: [
            expect.objectContaining({ name: "token" }),
            expect.objectContaining({ name: "organization" }),
          ],
        },
      ],
      device: {
        clientId: "12818eb01f62888cbadc934d75abae8a8ee25c67398491a81aba0208d4a987f4",
        deviceCodeUrl: "https://sentry.io/oauth/device/code/",
        tokenUrl: "https://sentry.io/oauth/token/",
        scopes: [
          "org:read",
          "project:read",
          "team:read",
          "member:read",
          "event:read",
          "event:write",
        ],
      },
    });
    expect(type?.oauth).toBeUndefined();
  });

  it("contributes one event source with the issues feed and every kind", async () => {
    const [source, ...others] = (await collectContributions(sentry)).sources;

    expect(others).toEqual([]);
    expect(source?.id).toBe("sentry");
    expect(source?.connectionType).toBe("sentry/sentry");
    expect(source?.feeds).toEqual({
      issues: { defaultIntervalSeconds: 60, minIntervalSeconds: 30 },
    });
    expect(Object.keys(source?.kinds ?? {}).sort()).toEqual([...KINDS].sort());
  });

  it("offers entered, regressed and escalating to triage, and not the kinds that only end a signal", async () => {
    const kinds = (await collectContributions(sentry)).sources[0]?.kinds ?? {};

    expect(
      Object.entries(kinds).map(([kind, declaration]) => [kind, declaration.availableToTriage]),
    ).toEqual(
      expect.arrayContaining([
        ["sentry.issue.entered", true],
        ["sentry.issue.regressed", true],
        ["sentry.issue.escalating", true],
        ["sentry.issue.resolved", false],
        ["sentry.issue.archived", false],
        ["sentry.issue.left", false],
      ]),
    );
  });

  it("declares three signal kinds that read only the source's own event kinds", async () => {
    const source = (await collectContributions(sentry)).sources[0]!;
    const signalKinds = source.signalKinds ?? [];

    expect(signalKinds.map((kind) => kind.word)).toEqual(["issue", "regressed", "escalating"]);
    for (const kind of signalKinds) {
      for (const eventKind of [...kind.from, ...kind.ends.map((end) => end.eventKind)]) {
        expect(source.kinds[eventKind], `${kind.word} reads ${eventKind}`).toBeDefined();
      }
    }
  });

  it("registers the three actions, which a Signal's answer may also run", async () => {
    const { actions } = await collectContributions(sentry);

    expect(actions.map((action) => action.id)).toEqual([
      "issue.resolve",
      "issue.archive",
      "issue.assign",
    ]);
    for (const action of actions) {
      expect(action.connection).toEqual({ type: "sentry/sentry" });
      expect(action.usableIn).toEqual(["workflow.step", "signal.answer"]);
    }
  });
});

describe("the config of a Sentry Connection", () => {
  it("accepts an empty config, which a Connection from before a field existed has", () => {
    expect(Schema.decodeUnknownResult(SentryConnectionConfig)({})._tag).toBe("Success");
  });

  it("marks the three lists as chosen from Sentry, and the window as an ordinary number", () => {
    const fields = SentryConnectionConfig.fields;
    const annotationsOf = (field: Schema.Top) => SchemaAST.resolve(field.ast);

    for (const name of ["assignees", "projects", "environments"] as const) {
      expect(annotationsOf(fields[name]), name).toMatchObject({ choices: true });
    }
    expect(annotationsOf(fields.lastSeenDays)).toMatchObject({ default: 14 });
    expect(annotationsOf(fields.lastSeenDays)).not.toHaveProperty("choices");
  });

  it("limits the window to 1 through 90 days", () => {
    const decode = Schema.decodeUnknownResult(SentryConnectionConfig);

    expect(decode({ lastSeenDays: 1 })._tag).toBe("Success");
    expect(decode({ lastSeenDays: 90 })._tag).toBe("Success");
    expect(decode({ lastSeenDays: 0 })._tag).toBe("Failure");
    expect(decode({ lastSeenDays: 91 })._tag).toBe("Failure");
    expect(decode({ lastSeenDays: 1.5 })._tag).toBe("Failure");
  });
});

describe("validating a Sentry token", () => {
  const validate = async (
    credentials: Readonly<Record<string, string>>,
    arrange: (world: ReturnType<typeof buildFakeWorld>) => void = () => undefined,
  ) => {
    const world = buildFakeWorld();
    arrange(world);
    const type = await readConnectionType();
    return runAgainstStub(type.validate(credentials), buildFakeSentry(world));
  };

  it("returns the organization and user ids as the account, and their names as the display name", async () => {
    const result = await validate({ token: TEST_TOKEN, organization: "acme" });

    expect(Result.isSuccess(result) && result.success).toEqual({
      accountId: TEST_ACCOUNT_ID,
      displayName: TEST_DISPLAY_NAME,
    });
    expect(TEST_ACCOUNT_ID).toBe("4501:88");
    expect(TEST_DISPLAY_NAME).toBe("Acme · ada");
  });

  it("accepts the access token of the device flow, which names no organization", async () => {
    const result = await validate({ accessToken: TEST_TOKEN });

    expect(Result.isSuccess(result) && result.success.accountId).toBe(TEST_ACCOUNT_ID);
  });

  it("fails when the organization slug is not one the token reaches", async () => {
    const result = await validate({ token: TEST_TOKEN, organization: "elsewhere" });

    const message = Result.isFailure(result) ? result.failure.message : "";
    expect(message).toContain('Sentry has no organization "elsewhere"');
    expect(message).toContain("reconnect the Connection with its new slug");
  });

  it("fails when Sentry refuses the token", async () => {
    const result = await validate({ token: "not-the-token", organization: "acme" });

    expect(Result.isFailure(result) && result.failure._tag).toBe("ConnectionValidationFailed");
  });

  it("fails when the credentials hold no token", async () => {
    const result = await validate({ organization: "acme" });

    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("the choices of the config form", () => {
  const listChoices = async (
    field: string,
    arrange: (world: ReturnType<typeof buildFakeWorld>) => void = () => undefined,
  ) => {
    const world = buildFakeWorld();
    arrange(world);
    const type = await readConnectionType();
    return runAgainstStub(
      type.listChoices!(field, {
        credentials: { token: TEST_TOKEN, organization: "acme" },
        config: {},
      }),
      buildFakeSentry(world),
    );
  };

  it("lists the four fixed assignees, then the teams, then the members with a user", async () => {
    const result = await listChoices("assignees");

    expect(Result.isSuccess(result) && result.success).toEqual([
      { value: "me", label: "Me" },
      { value: "my_teams", label: "My teams" },
      { value: "none", label: "Unassigned" },
      { value: "anyone", label: "Anyone" },
      { value: "team:31", label: "#platform" },
      { value: "team:32", label: "#payments" },
      { value: "user:88", label: "Ada Lovelace" },
      { value: "user:89", label: "Grace Hopper" },
    ]);
  });

  it("lists the teams, then the projects", async () => {
    const result = await listChoices("projects");

    expect(Result.isSuccess(result) && result.success).toEqual([
      { value: "team:31", label: "All projects of #platform" },
      { value: "team:32", label: "All projects of #payments" },
      { value: "project:11", label: "webshop" },
      { value: "project:12", label: "billing" },
    ]);
  });

  it("lists the environments by name", async () => {
    const result = await listChoices("environments");

    expect(Result.isSuccess(result) && result.success).toEqual([
      { value: "production", label: "production" },
      { value: "staging", label: "staging" },
    ]);
  });

  it("follows the pages of a long list", async () => {
    const result = await listChoices("assignees", (world) => {
      world.pageSize = 1;
    });

    expect(Result.isSuccess(result) && result.success).toHaveLength(8);
  });

  it("returns every choice, even past the 1,000 the host accepts", async () => {
    const result = await listChoices("assignees", (world) => {
      world.teams = Array.from({ length: 500 }, (_, index) => ({
        id: String(1000 + index),
        slug: `team-${String(index)}`,
      }));
      world.members = Array.from({ length: 600 }, (_, index) => ({
        id: String(2000 + index),
        name: `Member ${String(index)}`,
        email: `member-${String(index)}@acme.test`,
        userId: String(3000 + index),
        username: `member-${String(index)}`,
      }));
    });

    expect(Result.isSuccess(result) && result.success).toHaveLength(4 + 500 + 600);
  });

  it("fails, saying the list is too long to read, instead of cutting it", async () => {
    const result = await listChoices("environments", (world) => {
      world.environments = Array.from({ length: 1200 }, (_, index) => `env-${String(index)}`);
    });

    expect(Result.isFailure(result) && result.failure.message).toBe(
      "The organization's environments list is too long to read: it has more than 10 pages.",
    );
  });

  it("fails for a field it has no list for", async () => {
    const result = await listChoices("lastSeenDays");

    expect(Result.isFailure(result) && result.failure.message).toContain("lastSeenDays");
  });
});
