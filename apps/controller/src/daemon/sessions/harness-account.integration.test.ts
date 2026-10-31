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
import type { HarnessDefinition, Plugin } from "@hercule/plugin-host";
import type { ModelDescriptor, ProbeRequest, RunnerFacts, SessionStart } from "@hercule/protocol";
import { withTransaction } from "../../db";
import { send } from "../../http/testing";
import { createPluginFixture, buildHarnessDefinition } from "../../plugins/testing";
import { buildProviderAccountOwner } from "../../secrets";
import {
  listFrames,
  waitForFrames,
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
    kinds: [{ kind: "api-key", credentialVariable: KEY_VARIABLE }],
    modelArgument: "keyed/{model}",
    models: "own-list",
  },
]);

/** A harness with no key, signed in on each machine, like Claude Code. */
const PLAIN: HarnessDefinition = buildHarnessDefinition("plain", [
  {
    providerId: "harnesses/plain",
    kinds: [{ kind: "subscription" }],
    modelArgument: "{model}",
    models: "all",
  },
]);

const buildPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({
    id: "harnesses",
    capabilities: ["harnesses", "providers"],
    definitions: [KEYED, PLAIN],
    providers: [
      {
        id: "keyed",
        displayName: "Keyed",
        kinds: [
          {
            id: "api-key",
            title: "API key",
            description: "A key for Keyed.",
            setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
            harnesses: ["harnesses/keyed"],
          },
        ],
      },
      {
        id: "plain",
        displayName: "Plain",
        kinds: [
          {
            id: "subscription",
            title: "Subscription",
            description: "A plan signed in on each machine.",
            setup: [{ kind: "harness-login" }],
            harnesses: ["harnesses/plain"],
          },
        ],
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
  adapters: ["harnesses/keyed", "harnesses/plain"],
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
        credential: { variable: KEY_VARIABLE, value: KEY_VALUE },
      });
    });
  });

  it("sends the variable alone when the key has not been entered, so the runner removes it, and no credential for a harness that has none", async () => {
    await withFleet(async (arranged) => {
      const keyed = await probeNow(arranged, findProviderAccountId(arranged, "harnesses/keyed"));
      const plain = await probeNow(arranged, findProviderAccountId(arranged, "harnesses/plain"));

      expect(keyed.harnessAccount.credential).toEqual({ variable: KEY_VARIABLE });
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

  it("leaves a session whose key cannot be decrypted queued, and starts the others", async () => {
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
      // Still queued, not starting: the runner was never told to run it, so
      // nothing waits for a report about it.
      const read = await send("GET", arranged.harness.base, `/api/v1/sessions/${stuck.id}`, {
        token: arranged.token,
      });
      expect(((await read.json()) as { readonly status: string }).status).toBe("queued");
    });
  });
});
