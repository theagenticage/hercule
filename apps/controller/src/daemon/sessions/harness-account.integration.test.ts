/**
 * Tests that the credential of a Provider Account reaches the runner that
 * needs it, in the `harnessAccount` of a probe or of a session's start.
 *
 * The key is stored encrypted in the controller's table and decrypted when a
 * frame is built. So it exists in plain text only in that frame, and in the
 * runner's memory for that one operation. The tests use the real API and the
 * real runner socket, because the frames that cross the socket are what they
 * check.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { HarnessDefinition, Plugin } from "@hercule/plugin-host";
import type { Session } from "@hercule/contract";
import type {
  CatalogModel,
  ModelDescriptor,
  ProbeRequest,
  RunnerFacts,
  SessionStart,
} from "@hercule/protocol";
import { withTransaction } from "../../db";
import { send } from "../../http/testing";
import { createPluginFixture, buildHarnessDefinition } from "../../plugins/testing";
import { modelCatalogRepository } from "../../provider-accounts";
import { buildProviderAccountOwner } from "../../secrets";
import {
  at,
  listFrames,
  reportEvent,
  waitForFrames,
  waitForSession,
  waitForStartFrames,
  findProviderAccountId,
  spawnSessionOrFail,
  waitUntil,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../../sessions/testing";

const KEY_VALUE = "a-paid-credential-nobody-else-holds";

/** The environment variable the keyed harness reads its key from. */
const KEY_VARIABLE = "KEYED_API_KEY";

/** A harness that reads a key from the environment, like pi. */
const KEYED: HarnessDefinition = buildHarnessDefinition("keyed", [
  {
    providerId: "harnesses/keyed",
    kinds: [{ kind: "api-key", modelArgument: "keyed/{model}", credentialVariable: KEY_VARIABLE }],
    models: "own-list",
  },
]);

/** A harness with no key, signed in on each machine, like Claude Code. */
const PLAIN: HarnessDefinition = buildHarnessDefinition("plain", [
  {
    providerId: "harnesses/plain",
    kinds: [{ kind: "subscription", modelArgument: "{model}" }],
    models: "all",
  },
]);

/** The variable the main harness of the two-harness provider reads its key from. */
const MAIN_KEY_VARIABLE = "MAIN_API_KEY";

/** The variable the second harness of the two-harness provider reads its key from. */
const SECOND_KEY_VARIABLE = "SECOND_API_KEY";

/** The harness an account of the two-harness provider runs in by default, like Claude Code. */
const MAIN: HarnessDefinition = buildHarnessDefinition("main", [
  {
    providerId: "harnesses/dual",
    kinds: [{ kind: "api-key", modelArgument: "{model}", credentialVariable: MAIN_KEY_VARIABLE }],
    models: "all",
  },
]);

/**
 * A second harness for the same provider and account kind, like pi next to
 * Claude Code. It can run any model of the provider, and the provider's
 * catalog is not read from it, so a session in it is told about the catalog
 * models it does not list.
 */
const SECOND: HarnessDefinition = buildHarnessDefinition("second", [
  {
    providerId: "harnesses/dual",
    kinds: [
      { kind: "api-key", modelArgument: "dual/{model}", credentialVariable: SECOND_KEY_VARIABLE },
    ],
    models: "all",
  },
]);

const buildPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({
    id: "harnesses",
    capabilities: ["harnesses", "providers"],
    definitions: [KEYED, PLAIN, MAIN, SECOND],
    providers: [
      {
        id: "dual",
        displayName: "Dual",
        kinds: [
          {
            id: "api-key",
            title: "API key",
            description: "A key for Dual, which two harnesses can use.",
            setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
            keyCheck: {
              url: "https://api.dual.test/v1/models",
              headers: { authorization: "Bearer {apiKey}" },
            },
            harnesses: ["harnesses/main", "harnesses/second"],
          },
        ],
        defaultHarnessId: "harnesses/main",
        catalogSource: { kind: "harness-probe", harnessId: "harnesses/main" },
        defaultSelection: "current-models",
      },
      {
        id: "keyed",
        displayName: "Keyed",
        kinds: [
          {
            id: "api-key",
            title: "API key",
            description: "A key for Keyed.",
            setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
            keyCheck: {
              url: "https://api.keyed.test/v1/models",
              headers: { authorization: "Bearer {apiKey}" },
            },
            harnesses: ["harnesses/keyed"],
          },
        ],
        defaultHarnessId: "harnesses/keyed",
        catalogSource: { kind: "harness-probe", harnessId: "harnesses/keyed" },
        defaultSelection: "current-models",
      },
      {
        id: "plain",
        displayName: "Plain",
        kinds: [
          {
            id: "subscription",
            title: "Subscription",
            description: "A plan signed in on each machine.",
            setup: [{ kind: "harness-login", method: "sign-in" }],
            harnesses: ["harnesses/plain"],
          },
        ],
        defaultHarnessId: "harnesses/plain",
        catalogSource: { kind: "harness-probe", harnessId: "harnesses/plain" },
        defaultSelection: "current-models",
      },
    ],
  }).plugin,
];

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  harnesses: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["harnesses/keyed", "harnesses/plain", "harnesses/main", "harnesses/second"],
  identityPort: 4939,
};

const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", imageInput: { maxBytes: null }, isDefault: true, options: [] },
];

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, { plugins: buildPlugins(), facts: FACTS, models: MODELS });

/**
 * Stores a key for an account the way the update operation does, but without
 * its follow-up probes, so a test that counts probe frames sees only its own.
 */
const setKey = (arranged: Arranged, providerAccountId: string, value: string): Promise<void> =>
  storeSecret(arranged, providerAccountId, "apiKey", value);

/** Stores one secret owned by an account, in its own transaction. */
const storeSecret = (
  arranged: Arranged,
  providerAccountId: string,
  name: string,
  value: string,
): Promise<void> =>
  Effect.runPromise(
    Effect.asVoid(
      Effect.orDie(
        withTransaction(
          arranged.harness.sql,
          arranged.harness.secrets.set(
            buildProviderAccountOwner(providerAccountId),
            name,
            Redacted.make(value),
          ),
        ),
      ),
    ),
  );

/** Corrupts every stored key. That looks the same as a row written under another Master Key. */
const corruptStoredKeys = (arranged: Arranged): Promise<void> =>
  Effect.runPromise(
    Effect.asVoid(
      Effect.orDie(
        withTransaction(
          arranged.harness.sql,
          arranged.harness
            .sql`UPDATE secrets SET ciphertext = X'00' WHERE owner_kind = 'provider-account'`,
        ),
      ),
    ),
  );

/** Asks the controller to probe one account, and returns the probe frame the runner received. */
const probeNow = async (arranged: Arranged, providerAccountId: string): Promise<ProbeRequest> => {
  const before = listFrames<ProbeRequest>(arranged.wire, "probeRequest").length;
  const response = await send(
    "POST",
    arranged.harness.base,
    `/api/v1/runners/${arranged.runnerId}/probe`,
    { body: { providerAccountId }, token: arranged.token },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return waitUntil("sent the probe it was asked for", () =>
    listFrames<ProbeRequest>(arranged.wire, "probeRequest")
      .slice(before)
      .find((frame) => frame.harnessAccount.providerAccountId === providerAccountId),
  );
};

describe("the harness account a frame carries to a runner", () => {
  it("puts the stored key on the probe, under the variable and model argument the harness declares", async () => {
    await withFleet(async (arranged) => {
      const keyed = findProviderAccountId(arranged, "harnesses/keyed");
      await setKey(arranged, keyed, KEY_VALUE);

      const probe = await probeNow(arranged, keyed);

      expect(probe.harnessAccount).toEqual({
        providerAccountId: keyed,
        harnessHome: `providers/homes/${keyed}/harnesses/keyed`,
        modelArgument: "keyed/{model}",
        credentialVariables: [KEY_VARIABLE],
        credential: { variable: KEY_VARIABLE, value: KEY_VALUE },
      });
    });
  });

  it("lists the variables the harness declares on every probe, so the runner removes them, and sends no credential for a harness that has none", async () => {
    await withFleet(async (arranged) => {
      const keyed = await probeNow(arranged, findProviderAccountId(arranged, "harnesses/keyed"));
      const plain = await probeNow(arranged, findProviderAccountId(arranged, "harnesses/plain"));

      expect(keyed.harnessAccount.credentialVariables).toEqual([KEY_VARIABLE]);
      expect(plain.harnessAccount.credentialVariables).toEqual([]);
      expect("credential" in plain.harnessAccount).toBe(false);
    });
  });

  it("puts the stored key on the frame that starts a session on that account, and nowhere else in it", async () => {
    await withFleet(async (arranged) => {
      const keyed = findProviderAccountId(arranged, "harnesses/keyed");
      await setKey(arranged, keyed, KEY_VALUE);

      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        providerAccountId: keyed,
      });
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;

      expect(start.sessionId).toBe(session.id);
      expect(start.harnessAccount.credential).toEqual({ variable: KEY_VARIABLE, value: KEY_VALUE });
      expect(JSON.stringify(start.spec)).not.toContain(KEY_VALUE);
    });
  });

  it("sends no credential when starting a session on an account whose harness has none", async () => {
    await withFleet(async (arranged) => {
      await spawnSessionOrFail(arranged, {
        prompt: "hello",
        providerAccountId: findProviderAccountId(arranged, "harnesses/plain"),
      });
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;

      expect("credential" in start.harnessAccount).toBe(false);
    });
  });

  it("sends only the account's key, not other secrets stored for the account", async () => {
    await withFleet(async (arranged) => {
      const keyed = findProviderAccountId(arranged, "harnesses/keyed");
      await setKey(arranged, keyed, KEY_VALUE);
      // Left behind by a kind that dropped the field, or inserted by hand: it
      // is nobody's credential, and must not be sent to a runner.
      await storeSecret(arranged, keyed, "strayValue", "nothing declares this");

      const probe = await probeNow(arranged, keyed);

      expect(JSON.stringify(probe)).not.toContain("nothing declares this");
      expect(probe.harnessAccount.credential).toEqual({ variable: KEY_VARIABLE, value: KEY_VALUE });
    });
  });

  it("fails the probe when the key cannot be decrypted, rather than sending it without the key", async () => {
    await withFleet(async (arranged) => {
      const keyed = findProviderAccountId(arranged, "harnesses/keyed");
      await setKey(arranged, keyed, KEY_VALUE);
      await corruptStoredKeys(arranged);
      const before = listFrames<ProbeRequest>(arranged.wire, "probeRequest").length;

      const response = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/probe`,
        { body: { providerAccountId: keyed }, token: arranged.token },
      );

      const refused = (await response.json()) as {
        readonly error: { readonly code: string; readonly message?: string };
      };
      expect(refused.error.code).toBe("invalid_state");
      expect(refused.error.message ?? "").toContain("could not be decrypted");
      // Nothing was sent to the runner: a probe without the key would report
      // that no key was entered.
      expect(listFrames<ProbeRequest>(arranged.wire, "probeRequest").slice(before)).toEqual([]);
    });
  });

  it("ends a session whose key cannot be decrypted, with the reason, and starts the others", async () => {
    await withFleet(async (arranged) => {
      const keyed = findProviderAccountId(arranged, "harnesses/keyed");
      await setKey(arranged, keyed, KEY_VALUE);
      await corruptStoredKeys(arranged);

      const stuck = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        providerAccountId: keyed,
      });
      // Claimed in the same dispatch, after the session whose key cannot be
      // read. If the whole batch rolled back, this one would not start either.
      const running = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        providerAccountId: findProviderAccountId(arranged, "harnesses/plain"),
      });

      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(start.sessionId).toBe(running.id);
      expect(listFrames<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(1);
      // Ended, not starting and not waiting: the runner was never told to run
      // it, and retrying could never mend a key that does not decrypt. The
      // user reads why in the thread's exit.
      const read = await send("GET", arranged.harness.base, `/api/v1/sessions/${stuck.id}`, {
        token: arranged.token,
      });
      expect(((await read.json()) as { readonly status: string }).status).toBe("exited");
      const transcript = await send(
        "GET",
        arranged.harness.base,
        `/api/v1/sessions/${stuck.id}/transcript`,
        { token: arranged.token },
      );
      expect(await transcript.text()).toContain("could not be decrypted");
    });
  });

  it.each([
    {
      name: "a new account gets the second harness's own home and key variable",
      hasLegacyHome: false,
      harnessId: "harnesses/second",
      home: (id: string) => `providers/homes/${id}/harnesses/second`,
      keyVariable: SECOND_KEY_VARIABLE,
    },
    {
      name: "an account with a legacy home gets a derived home in the harness the folder does not belong to",
      hasLegacyHome: true,
      harnessId: "harnesses/second",
      home: (id: string) => `providers/homes/${id}/harnesses/second`,
      keyVariable: SECOND_KEY_VARIABLE,
    },
    {
      name: "an account with a legacy home keeps that folder in the harness it belongs to",
      hasLegacyHome: true,
      harnessId: "harnesses/main",
      home: (id: string) => `providers/${id}`,
      keyVariable: MAIN_KEY_VARIABLE,
    },
  ])(
    "$name when a session starts there",
    async ({ hasLegacyHome, harnessId, home, keyVariable }) => {
      await withFleet(async (arranged) => {
        const dual = findProviderAccountId(arranged, "harnesses/main");
        await setKey(arranged, dual, KEY_VALUE);
        if (hasLegacyHome) {
          await Effect.runPromise(
            Effect.orDie(
              withTransaction(
                arranged.harness.sql,
                arranged.harness.sql`
                UPDATE provider_accounts
                SET legacy_home_folder = ${dual}, legacy_home_harness_id = 'harnesses/main'
                WHERE id = unhex(replace(${dual}, '-', ''))`,
              ),
            ),
          );
        }

        await spawnSessionOrFail(arranged, { prompt: "hello", providerAccountId: dual, harnessId });
        const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;

        expect(start.harnessId).toBe(harnessId);
        expect(start.harnessAccount).toMatchObject({
          providerAccountId: dual,
          harnessHome: home(dual),
          credentialVariables: [keyVariable],
          credential: { variable: keyVariable, value: KEY_VALUE },
        });
      });
    },
  );
});

/** A model that only the provider's API lists, with the details a probe does not give. */
const API_ONLY_MODEL: CatalogModel = {
  slug: "api-only",
  name: "API only",
  imageInput: null,
  options: [],
  maker: "Dual",
  contextWindow: 200_000,
  inputPrice: 1.5,
  reasoning: true,
};

/**
 * Stores a catalog for the account that holds the model the runner lists and
 * `API_ONLY_MODEL`, as if it had been read from the provider's API.
 */
const storeCatalogWithApiOnlyModel = async (
  arranged: Arranged,
  providerAccountId: string,
): Promise<void> => {
  await Effect.runPromise(
    Effect.orDie(
      withTransaction(
        arranged.harness.sql,
        Effect.flatMap(modelCatalogRepository, (catalogs) =>
          catalogs.recordSuccess(
            providerAccountId,
            [{ ...MODELS[0]! }, API_ONLY_MODEL],
            at,
            // Later than the stamp of any probe, so a probe that is still
            // running cannot replace these models.
            "2999-01-01T00:00:00.000Z",
          ),
        ),
      ).pipe(Effect.provideService(SqlClient.SqlClient, arranged.harness.sql)),
    ),
  );
};

/** Ends a session the way a runner does: its native id is bound, then it reports that it exited. */
const endSession = async (arranged: Arranged, session: Session): Promise<void> => {
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "busy");
  arranged.wire.send({
    _tag: "sessionsReport",
    sessions: [
      {
        sessionId: session.id,
        nativeSessionId: "native-1",
        providerAccountId: session.providerAccountId,
      },
    ],
  });
  await waitForSession(arranged, session.id, (one) => one.nativeSessionId !== null);
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "exited");
};

describe("the catalog models on a session's start frame", () => {
  it("carries them on a start, a resume and a fork in a harness that runs any model, and the others on none", async () => {
    await withFleet(async (arranged) => {
      const dual = findProviderAccountId(arranged, "harnesses/main");
      await setKey(arranged, dual, KEY_VALUE);
      await storeCatalogWithApiOnlyModel(arranged, dual);

      const parent = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        providerAccountId: dual,
        harnessId: "harnesses/second",
      });
      await waitForStartFrames(arranged, parent.id, 1);
      await endSession(arranged, parent);
      const forked = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/sessions/${parent.id}/continue`,
        { body: { mode: "fork", prompt: "more" }, token: arranged.token },
      );
      expect(forked.status, await forked.clone().text()).toBe(200);
      const child = (await forked.json()) as Session;
      const resumed = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/sessions/${parent.id}/input`,
        { body: { text: "still there?" }, token: arranged.token },
      );
      expect(resumed.status, await resumed.clone().text()).toBe(200);

      const [start, resume] = await waitForStartFrames(arranged, parent.id, 2);
      const [fork] = await waitForStartFrames(arranged, child.id, 1);
      expect(resume!.spec.continue?.mode).toBe("resume");
      expect(fork!.spec.continue?.mode).toBe("fork");
      // The whole catalog is sent, with what a runner needs and without the
      // catalog's prices and maker.
      for (const frame of [start!, resume!, fork!]) {
        expect(frame.catalogModels).toEqual([
          { slug: "clever", name: "Clever", imageInput: { maxBytes: null } },
          {
            slug: "api-only",
            name: "API only",
            imageInput: null,
            contextWindow: 200_000,
            reasoning: true,
          },
        ]);
      }

      // The harness the catalog is read from lists what the catalog holds.
      const inMain = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        providerAccountId: dual,
        harnessId: "harnesses/main",
      });
      const [main] = await waitForStartFrames(arranged, inMain.id, 1);
      expect(main!.harnessId).toBe("harnesses/main");
      expect("catalogModels" in main!).toBe(false);
    });
  });
});
