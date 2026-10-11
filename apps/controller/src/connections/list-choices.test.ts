/**
 * Tests `connection.listChoices` on the real connection service, over a real
 * database, with a test connection type whose `listChoices` is a stub. The
 * stub records what the plugin was called with, so the tests check that the
 * core passes the connection's credentials and stored config through.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import { PluginError, type ConfigChoice } from "@hercule/plugin-host";
import { CurrentActor, type Actor } from "../actor";
import { buildHomePaths, HerculeHome } from "../config";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { ServingPromotionStateLayer } from "../promotion/testing";
import { PluginIntake } from "../intake-settings";
import { masterKeyLayer, Secrets, SecretLayer, secretsLayer } from "../secrets";
import { ActivePlugins } from "./active-plugins";
import { PluginConfigs } from "./plugin-configs";
import { ConnectionReferences } from "./references";
import { ConnectionTypes, ConnectionTypesLayer, type RegisteredConnectionType } from "./runtime";
import { ConnectionService, ConnectionServiceLayer } from "./service";

const TYPE = "test/team-type";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

let homes: Array<string> = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/** Whether the stack reports the test plugin as running. Each test sets it. */
let pluginIsActive = true;

const buildStack = () => {
  const home = mkdtempSync(join(tmpdir(), "hercule-list-choices-"));
  homes.push(home);
  return ConnectionServiceLayer.pipe(
    Layer.provide(Layer.succeed(ConnectionReferences)({ list: () => Effect.succeed([]) })),
    Layer.provide(
      Layer.succeed(ActivePlugins)({ isActive: () => Effect.sync(() => pluginIsActive) }),
    ),
    // Listing choices never reads Intake settings, so the stub has no methods.
    Layer.provide(Layer.mock(PluginIntake)({})),
    Layer.provideMerge(ConnectionTypesLayer),
    Layer.provideMerge(Layer.succeed(PluginConfigs)({ of: () => Effect.succeed({}) })),
    Layer.provideMerge(SecretLayer),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(ServingPromotionStateLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  );
};

interface Call {
  readonly field: string;
  readonly credentials: Record<string, string>;
  readonly config: unknown;
}

/**
 * Builds a connection type with a `team` field that loads choices and a
 * `note` field that does not. Its `listChoices` records each call and answers
 * with `answer`.
 */
const buildType = (
  calls: Array<Call>,
  answer: () => Effect.Effect<ReadonlyArray<ConfigChoice>, PluginError>,
): RegisteredConnectionType => ({
  pluginId: "test",
  contribution: {
    type: TYPE,
    displayName: "Team type",
    setup: [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }],
    configSchema: Schema.Struct({
      team: Schema.optionalKey(Schema.String.annotate({ choices: true })),
      note: Schema.optionalKey(Schema.String),
    }),
    validate: () => Effect.succeed({ displayName: "octocat", accountId: "583231" }),
    listChoices: (field, connection) => {
      calls.push({ field, ...connection });
      return answer();
    },
  },
  feeds: {},
});

/** Registers the type, creates a connection of it, and runs `use` on its id. */
const runWithConnection = <A, E>(
  type: RegisteredConnectionType,
  use: (id: string) => Effect.Effect<A, E, ConnectionService | Secrets>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(ConnectionTypes, (registry) => registry.replace([type]));
      const connections = yield* ConnectionService;
      const { id } = yield* connections.create({
        type: TYPE,
        config: { team: "backend" },
        credentials: { token: "secret-token" },
      });
      return yield* use(id);
    }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(buildStack())),
  );

/** Returns the message of a refusal, which the service's errors carry under `error`. */
const readMessage = (failure: unknown): string =>
  (failure as { error: { message: string } }).error.message;

/** Runs a call that must fail, and returns its failure. */
const readFailure = <A, E>(effect: Effect.Effect<A, E, ConnectionService | Secrets>) =>
  Effect.flip(effect);

/** Calls `connection.listChoices` for the `team` field of a connection. */
const listTeamChoices = (id: string) =>
  Effect.flatMap(ConnectionService, (connections) =>
    connections.listChoices({ id, field: "team" }),
  );

describe("connection.listChoices", () => {
  it("calls the plugin with the credentials and stored config, and returns the choices", async () => {
    pluginIsActive = true;
    const calls: Array<Call> = [];
    const type = buildType(calls, () =>
      Effect.succeed([
        { value: "backend", label: "Backend" },
        { value: "web", label: "Web" },
      ]),
    );

    const answer = await runWithConnection(type, (id) =>
      Effect.flatMap(ConnectionService, (connections) =>
        connections.listChoices({ id, field: "team" }),
      ),
    );

    expect(answer).toEqual({
      choices: [
        { value: "backend", label: "Backend" },
        { value: "web", label: "Web" },
      ],
    });
    expect(calls).toEqual([
      { field: "team", credentials: { token: "secret-token" }, config: { team: "backend" } },
    ]);
  });

  it("refuses a caller without the connection.manage grant", async () => {
    pluginIsActive = true;
    const failure = await Effect.runPromise(
      Effect.flatMap(ConnectionService, (connections) =>
        Effect.flip(connections.listChoices({ id: "no-such-id", field: "team" })),
      ).pipe(Effect.provide(buildStack())),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "connection.manage" } },
    });
  });

  it("answers not found for a connection that does not exist", async () => {
    pluginIsActive = true;
    const type = buildType([], () => Effect.succeed([]));

    const failure = await runWithConnection(type, () =>
      readFailure(
        Effect.flatMap(ConnectionService, (connections) =>
          connections.listChoices({ id: "0199e0e7-0002-7000-8000-000000000000", field: "team" }),
        ),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });

  it.each([
    ["a field without the choices mark", "note"],
    ["a field the config schema does not have", "nothing"],
  ])("refuses %s with validation, and never calls the plugin", async (_label, field) => {
    pluginIsActive = true;
    const calls: Array<Call> = [];
    const type = buildType(calls, () => Effect.succeed([]));

    const failure = await runWithConnection(type, (id) =>
      readFailure(
        Effect.flatMap(ConnectionService, (connections) => connections.listChoices({ id, field })),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
    expect(calls).toEqual([]);
  });

  it("refuses with invalid_state when the plugin is not running, and says it may have failed to start", async () => {
    pluginIsActive = false;
    const calls: Array<Call> = [];
    const type = buildType(calls, () => Effect.succeed([]));

    const failure = await runWithConnection(type, (id) =>
      readFailure(
        Effect.flatMap(ConnectionService, (connections) =>
          connections.listChoices({ id, field: "team" }),
        ),
      ),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(readMessage(failure)).toContain("not running (disabled, or failed to start)");
    expect(readMessage(failure)).toContain("Settings");
    expect(calls).toEqual([]);
  });

  it("refuses with invalid_state when the credentials cannot be read", async () => {
    pluginIsActive = true;
    const calls: Array<Call> = [];
    const type = buildType(calls, () => Effect.succeed([]));

    const failure = await runWithConnection(type, (id) =>
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        yield* secrets.delete({ kind: "connection", id }, "token");
        const connections = yield* ConnectionService;
        return yield* Effect.flip(connections.listChoices({ id, field: "team" }));
      }),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(readMessage(failure)).toContain("holds no credentials");
    expect(calls).toEqual([]);
  });

  it("refuses with invalid_state, carrying the plugin's message, when the plugin fails", async () => {
    pluginIsActive = true;
    const type = buildType([], () =>
      Effect.fail(
        new PluginError({ message: "Sentry refused the token; reconnect the Connection" }),
      ),
    );

    const failure = await runWithConnection(type, (id) =>
      readFailure(
        Effect.flatMap(ConnectionService, (connections) =>
          connections.listChoices({ id, field: "team" }),
        ),
      ),
    );

    expect(failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: "Sentry refused the token; reconnect the Connection",
      },
    });
  });

  it("accepts exactly 1,000 choices and refuses 1,001 with invalid_state", async () => {
    pluginIsActive = true;
    const build = (count: number) =>
      buildType([], () =>
        Effect.succeed(
          Array.from({ length: count }, (_, index) => ({
            value: String(index),
            label: `Team ${String(index)}`,
          })),
        ),
      );
    const call = (id: string) =>
      Effect.flatMap(ConnectionService, (connections) =>
        connections.listChoices({ id, field: "team" }),
      );

    const accepted = await runWithConnection(build(1000), call);
    const refused = await runWithConnection(build(1001), (id) => readFailure(call(id)));

    expect(accepted.choices).toHaveLength(1000);
    expect(refused).toMatchObject({ error: { code: "invalid_state" } });
    expect(readMessage(refused)).toContain("1001");
  });

  it("refuses with invalid_state, carrying the defect's message, when the plugin dies", async () => {
    pluginIsActive = true;
    const type = buildType([], () => Effect.die(new Error("cannot read property of undefined")));

    const failure = await runWithConnection(type, (id) => readFailure(listTeamChoices(id)));

    expect(failure).toMatchObject({
      error: { code: "invalid_state", message: "cannot read property of undefined" },
    });
  });

  it("refuses with invalid_state when the plugin throws before it returns an effect", async () => {
    pluginIsActive = true;
    const type = buildType([], () => Effect.succeed([]));
    const throwing: RegisteredConnectionType = {
      ...type,
      contribution: {
        ...type.contribution,
        listChoices: () => {
          throw new Error("listChoices is not implemented");
        },
      },
    };

    const failure = await runWithConnection(throwing, (id) => readFailure(listTeamChoices(id)));

    expect(failure).toMatchObject({
      error: { code: "invalid_state", message: "listChoices is not implemented" },
    });
  });

  it("refuses with invalid_state when the plugin returns choices of the wrong shape", async () => {
    pluginIsActive = true;
    const type = buildType([], () =>
      Effect.succeed([{ value: 7, label: "Backend" }] as unknown as ReadonlyArray<ConfigChoice>),
    );

    const failure = await runWithConnection(type, (id) => readFailure(listTeamChoices(id)));

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(readMessage(failure)).toContain("wrong shape");
  });

  it("drops a choice with an empty value and a repeated value, keeping the first of each value", async () => {
    pluginIsActive = true;
    const type = buildType([], () =>
      Effect.succeed([
        { value: "", label: "Nobody" },
        { value: "backend", label: "Backend" },
        { value: "web", label: "Web" },
        { value: "backend", label: "Backend, again" },
      ]),
    );

    const answer = await runWithConnection(type, listTeamChoices);

    expect(answer.choices).toEqual([
      { value: "backend", label: "Backend" },
      { value: "web", label: "Web" },
    ]);
  });
});
