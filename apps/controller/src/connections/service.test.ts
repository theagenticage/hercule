/**
 * Tests the connection service directly, over a real database, for what the
 * HTTP tests cannot reach:
 *
 * - the grant check the service runs inside its own methods. The HTTP
 *   transport checks the grant before it decodes the payload, but an
 *   in-process caller never goes through the transport, so these tests call
 *   the service with no current actor provided;
 * - the waits between the tries of a device flow's account check, which run
 *   on a `TestClock`;
 * - the messages that refuse a setup operation a type does not offer, and a
 *   device flow whose type changed while the user was approving it. Both need
 *   connection types the tests can register and replace at will.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Clock, Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { ConnectionValidationFailed, type SetupStep } from "@hercule/plugin-host";
import { CurrentActor, type Actor } from "../actor";
import { buildHomePaths, HerculeHome } from "../config";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { PluginConfigsLayer, PluginHostLayer } from "../plugins";
import { masterKeyLayer, SecretLayer, secretsLayer } from "../secrets";
import { ConnectionReferences } from "./references";
import { ConnectionTypes, ConnectionTypesLayer, type RegisteredConnectionType } from "./runtime";
import { ConnectionService, ConnectionServiceLayer } from "./service";
import { buildJsonResponse, createDeviceProvider, type DeviceProvider } from "./testing";

let homes: Array<string> = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/**
 * Builds the real service over the real repositories, a `:memory:` database and
 * a key file. This test builds no other domain, so no record names a
 * Connection.
 */
const buildStack = () => {
  const home = mkdtempSync(join(tmpdir(), "hercule-connection-service-"));
  homes.push(home);
  return ConnectionServiceLayer.pipe(
    Layer.provide(Layer.succeed(ConnectionReferences)({ list: () => Effect.succeed([]) })),
    Layer.provideMerge(PluginHostLayer),
    Layer.provideMerge(ConnectionTypesLayer),
    Layer.provideMerge(PluginConfigsLayer),
    Layer.provideMerge(SecretLayer),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  );
};

describe("the grant check", () => {
  it("runs first, for an in-process caller that never went through the HTTP transport", async () => {
    const failure = await Effect.runPromise(
      Effect.flatMap(ConnectionService, (connection) => Effect.flip(connection.query({}))).pipe(
        Effect.provide(buildStack()),
      ),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "connection.read" } },
    });
  });

  // Each device-flow method checks the grant before it decodes its input or
  // calls the provider, so even input that would fail to decode is refused
  // as forbidden.
  it("refuses to start a device flow", async () => {
    const failure = await Effect.runPromise(
      Effect.flatMap(ConnectionService, (connection) =>
        Effect.flip(connection.startDeviceFlow({ type: "no/such-type" })),
      ).pipe(Effect.provide(buildStack())),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "connection.manage" } },
    });
  });

  it("refuses to poll a device flow", async () => {
    const failure = await Effect.runPromise(
      Effect.flatMap(ConnectionService, (connection) =>
        Effect.flip(connection.pollDeviceFlow({ setupId: "no-such-setup" })),
      ).pipe(Effect.provide(buildStack())),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "connection.manage" } },
    });
  });
});

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** The qualified name of the test type. */
const DEVICE_TYPE = "test/device-type";

/** The input that starts a flow that creates a connection of the test type. */
const START = { type: DEVICE_TYPE, label: "work", labels: ["Code"] };

/**
 * Builds a registered type with a device flow against the provider, and the
 * given `validate`. A test that needs other setup steps passes them.
 */
const buildDeviceType = (
  provider: DeviceProvider,
  validate: RegisteredConnectionType["contribution"]["validate"],
  setup: ReadonlyArray<SetupStep> = [{ kind: "device" }],
): RegisteredConnectionType => ({
  pluginId: "test",
  contribution: {
    type: DEVICE_TYPE,
    displayName: "Device type",
    setup,
    device: {
      clientId: "device-client-1",
      deviceCodeUrl: `${provider.base}/device/code`,
      tokenUrl: `${provider.base}/token`,
      scopes: [],
    },
    validate,
  },
});

/**
 * Runs an effect as the user, over a fresh stack, on a `TestClock` that starts
 * at the epoch. The stack's types are the given ones and no others.
 */
const runAsUser = <A, E>(
  types: ReadonlyArray<RegisteredConnectionType>,
  effect: Effect.Effect<A, E, ConnectionService | ConnectionTypes>,
): Promise<A> =>
  Effect.runPromise(
    Effect.andThen(
      Effect.flatMap(ConnectionTypes, (registry) => registry.replace(types)),
      effect,
    ).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(buildStack()),
      Effect.provide(TestClock.layer()),
    ),
  );

/** Waits, in real time, until a condition holds, for at most two seconds. */
const waitFor = (condition: () => boolean): Effect.Effect<void> =>
  Effect.promise(async () => {
    const deadline = Date.now() + 2000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("the condition never held");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The fiber that met the condition goes on to schedule its next wait on
    // the test clock. Moving the clock before that wait exists would skip it.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

describe("the account check at the end of a device flow", () => {
  let provider: DeviceProvider | undefined;
  afterEach(async () => {
    await provider?.stop();
    provider = undefined;
  });

  /**
   * Starts a device flow, lets the user approve it, and polls it on a forked
   * fiber. Moves the test clock through the check's two waits, one second
   * and then two, and returns the poll's answer and the time of each check.
   */
  const pollThroughRetries = (failures: number) => {
    const started = createDeviceProvider();
    provider = started;
    const checkedAt: Array<number> = [];
    const type = buildDeviceType(started, () =>
      Effect.gen(function* () {
        checkedAt.push(yield* Clock.currentTimeMillis);
        if (checkedAt.length <= failures) {
          return yield* Effect.fail(
            new ConnectionValidationFailed({ message: "the provider answered 502" }),
          );
        }
        return { displayName: "octocat" };
      }),
    );
    return runAsUser(
      [type],
      Effect.gen(function* () {
        const connection = yield* ConnectionService;
        const { setupId, interval } = yield* connection.startDeviceFlow(START);
        started.answers.token = () =>
          buildJsonResponse({ access_token: "the-token", token_type: "bearer" });
        yield* TestClock.adjust(Duration.seconds(interval));

        const poll = yield* Effect.forkChild(connection.pollDeviceFlow({ setupId }));
        yield* waitFor(() => checkedAt.length === 1);
        yield* TestClock.adjust(Duration.seconds(1));
        yield* waitFor(() => checkedAt.length === 2);
        yield* TestClock.adjust(Duration.seconds(2));
        const answer = yield* Fiber.join(poll);

        // The approval is spent either way, so the flow is over.
        const again = yield* connection.pollDeviceFlow({ setupId });
        const { items } = yield* connection.query({});
        const gaps = checkedAt.slice(1).map((at, index) => at - (checkedAt[index] ?? 0));
        return { answer, again, items, gaps };
      }),
    );
  };

  it("tries again after one second and then two, and writes the connection once a try passes", async () => {
    const { answer, again, items, gaps } = await pollThroughRetries(2);

    expect(answer).toMatchObject({ status: "done", connection: { displayName: "octocat" } });
    expect(gaps).toEqual([1000, 2000]);
    expect(again).toMatchObject({ status: "expired" });
    expect(items).toHaveLength(1);
  });

  it("answers failed, and creates nothing, when all three tries fail", async () => {
    const { answer, again, items, gaps } = await pollThroughRetries(3);

    expect(answer).toEqual({
      status: "failed",
      message:
        "the provider approved the sign-in, but checking the account failed: " +
        "the provider answered 502. Start again to get a new code",
    });
    expect(gaps).toEqual([1000, 2000]);
    expect(again).toMatchObject({ status: "expired" });
    expect(items).toEqual([]);
  });
});

describe("a device flow whose type changed while the user was approving it", () => {
  it("answers failed, and ends the flow, when the type no longer has a device flow", async () => {
    const provider = createDeviceProvider();
    try {
      const type = buildDeviceType(provider, () => Effect.succeed({ displayName: "octocat" }));
      const { answer, again } = await runAsUser(
        [type],
        Effect.gen(function* () {
          const connection = yield* ConnectionService;
          const { setupId, interval } = yield* connection.startDeviceFlow(START);
          // A new build of the plugin dropped the device flow.
          yield* Effect.flatMap(ConnectionTypes, (registry) =>
            registry.replace([
              {
                pluginId: type.pluginId,
                contribution: {
                  type: DEVICE_TYPE,
                  displayName: "Device type",
                  setup: [{ kind: "credentials", fields: [{ name: "pat", label: "Token" }] }],
                  validate: type.contribution.validate,
                },
              },
            ]),
          );
          yield* TestClock.adjust(Duration.seconds(interval));
          const answer = yield* connection.pollDeviceFlow({ setupId });
          const again = yield* connection.pollDeviceFlow({ setupId });
          return { answer, again };
        }),
      );

      expect(answer).toEqual({
        status: "failed",
        message: `the type ${DEVICE_TYPE} no longer has a device flow in this build`,
      });
      expect(again).toMatchObject({ status: "expired" });
      // The provider is never asked to exchange the code.
      expect(provider.tokenRequests).toEqual([]);
    } finally {
      await provider.stop();
    }
  });
});

describe("the refusal of a setup operation the type does not offer", () => {
  const PAIRING_TYPE = "test/pairing-type";

  /** Builds a type whose only setup step is the given one. */
  const buildType = (type: string, setup: ReadonlyArray<SetupStep>): RegisteredConnectionType => ({
    pluginId: "test",
    contribution: {
      type,
      displayName: type,
      setup,
      validate: () => Effect.succeed({ displayName: "account" }),
    },
  });

  it("says that nothing can set up a type with no credentials, oauth or device step", async () => {
    const failure = await runAsUser(
      [buildType(PAIRING_TYPE, [{ kind: "pairing" }])],
      Effect.flatMap(ConnectionService, (connection) =>
        Effect.flip(
          connection.create({
            type: PAIRING_TYPE,
            label: "work",
            labels: ["Code"],
            credentials: { pat: "x" },
          }),
        ),
      ),
    );

    expect(failure).toMatchObject({
      error: {
        code: "validation",
        message:
          `the type ${PAIRING_TYPE} takes no pasted credentials, because its setup has no ` +
          "credentials step: no operation can set it up, because its setup has no credentials, " +
          "oauth or device step",
      },
    });
  });

  it("names the device flow when a type that has one is asked for a redirect flow", async () => {
    const provider = createDeviceProvider();
    try {
      const failure = await runAsUser(
        [buildDeviceType(provider, () => Effect.succeed({ displayName: "octocat" }))],
        Effect.flatMap(ConnectionService, (connection) =>
          Effect.flip(connection.startOAuth({ ...START, origin: "http://127.0.0.1:3000" })),
        ),
      );

      expect(failure).toMatchObject({
        error: {
          code: "validation",
          message:
            `the type ${DEVICE_TYPE} has no redirect flow, because its setup has no oauth step: ` +
            "set it up with connection.startDeviceFlow instead",
        },
      });
    } finally {
      await provider.stop();
    }
  });
});
