/**
 * A secret-valued instance field reaching the machine that needs it.
 *
 * The value lives encrypted in the controller's own table and is decrypted at
 * send time, so the only place it exists in the clear is the frame that carries
 * it and the runner's memory for that one operation. Driven over the real API
 * and the real runner socket, because the frame crossing the wire is the whole
 * of what is asserted here.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import { secret, type Plugin, type ProviderDefinition } from "@hercule/plugin-host";
import type { ModelDescriptor, ProbeRequest, RunnerFacts, SessionStart } from "@hercule/protocol";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import { send } from "../http/testing";
import {
  listFrames,
  waitForFrames,
  findInstanceId,
  spawnSessionOrFail,
  waitUntil,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../sessions/testing";

const KEY_TITLE = "Z.ai API key";
const KEY_DESCRIPTION = "From your Z.ai Coding Plan subscription.";
const KEY_VALUE = "a-paid-credential-nobody-else-holds";

/** A provider whose config has one secret-valued field, the way pi's has. */
const KEYED: ProviderDefinition = {
  ...buildProviderDefinition("keyed-provider", { token: "t" }),
  configSchema: Schema.Struct({
    token: Schema.String,
    zaiApiKey: secret({ title: KEY_TITLE, description: KEY_DESCRIPTION }),
  }),
};

/** A provider that marked nothing secret, for the frames that carry none. */
const PLAIN: ProviderDefinition = buildProviderDefinition("plain-provider", { token: "t" });

const buildPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({ id: "keyed", definitions: [KEYED, PLAIN] }).plugin,
];

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["keyed-provider", "plain-provider"],
  identityPort: 4939,
};

const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", isDefault: true, options: [] },
];

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, { plugins: buildPlugins(), facts: FACTS, models: MODELS });

const setKey = async (arranged: Arranged, instanceId: string, value: string): Promise<void> => {
  const response = await send(
    "PUT",
    arranged.harness.base,
    `/api/v1/secrets/provider-instance/${instanceId}/zaiApiKey`,
    { body: { value }, token: arranged.token },
  );
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Asks the machine about one instance, and answers with the probe it sent. */
const probeNow = async (arranged: Arranged, instanceId: string): Promise<ProbeRequest> => {
  const before = listFrames<ProbeRequest>(arranged.wire, "probeRequest").length;
  const response = await send(
    "POST",
    arranged.harness.base,
    `/api/v1/runners/${arranged.runnerId}/probe`,
    { body: { instanceId }, token: arranged.token },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return waitUntil("sent the probe it was asked for", () =>
    listFrames<ProbeRequest>(arranged.wire, "probeRequest")
      .slice(before)
      .find((frame) => frame.instanceId === instanceId),
  );
};

describe("the secrets a frame carries to a runner", () => {
  it("puts the stored key on the probe, under the name the plugin gave it", async () => {
    await withFleet(async (arranged) => {
      const keyed = findInstanceId(arranged, "keyed-provider");
      await setKey(arranged, keyed, KEY_VALUE);

      const probe = await probeNow(arranged, keyed);

      expect(probe.secrets).toEqual({ zaiApiKey: KEY_VALUE });
    });
  });

  it("carries an empty set where the key has not been entered, rather than nothing at all", async () => {
    await withFleet(async (arranged) => {
      const keyed = await probeNow(arranged, findInstanceId(arranged, "keyed-provider"));
      const plain = await probeNow(arranged, findInstanceId(arranged, "plain-provider"));

      expect(keyed.secrets).toEqual({});
      expect(plain.secrets).toEqual({});
    });
  });

  it("puts the stored key on the frame that starts a session on that instance", async () => {
    await withFleet(async (arranged) => {
      const keyed = findInstanceId(arranged, "keyed-provider");
      await setKey(arranged, keyed, KEY_VALUE);

      const session = await spawnSessionOrFail(arranged, { prompt: "hello", instanceId: keyed });
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;

      expect(start.sessionId).toBe(session.id);
      expect(start.secrets).toEqual({ zaiApiKey: KEY_VALUE });
      // Never in the config: the config is stored, and this value is not.
      expect(JSON.stringify(start.config)).not.toContain(KEY_VALUE);
      expect(JSON.stringify(start.spec)).not.toContain(KEY_VALUE);
    });
  });

  it("starts a session on an instance with no key set carrying an empty set", async () => {
    await withFleet(async (arranged) => {
      await spawnSessionOrFail(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "plain-provider"),
      });
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;

      expect(start.secrets).toEqual({});
    });
  });
  it("carries the fields the plugin declares and nothing else stored under that owner", async () => {
    await withFleet(async (arranged) => {
      const keyed = findInstanceId(arranged, "keyed-provider");
      await setKey(arranged, keyed, KEY_VALUE);
      // Left behind by a plugin that dropped the field, or put there by hand:
      // nobody's credential, and no business on a machine.
      const stray = await send(
        "PUT",
        arranged.harness.base,
        `/api/v1/secrets/provider-instance/${keyed}/strayValue`,
        { body: { value: "nothing declares this" }, token: arranged.token },
      );
      expect(stray.status, await stray.clone().text()).toBe(200);

      const probe = await probeNow(arranged, keyed);

      expect(probe.secrets).toEqual({ zaiApiKey: KEY_VALUE });
    });
  });
  it("fails the probe rather than sending one without a key that will not decrypt", async () => {
    await withFleet(async (arranged) => {
      const keyed = findInstanceId(arranged, "keyed-provider");
      await setKey(arranged, keyed, KEY_VALUE);
      // A Master Key that is not the one the row was written under reads as a
      // row that will not decrypt, which is the one way a running controller
      // cannot arrange.
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness
            .sql`UPDATE secrets SET ciphertext = X'00' WHERE owner_kind = 'provider-instance'`,
        ),
      );
      const before = listFrames<ProbeRequest>(arranged.wire, "probeRequest").length;

      const response = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/probe`,
        { body: { instanceId: keyed }, token: arranged.token },
      );

      const refused = (await response.json()) as {
        readonly error: { readonly code: string; readonly message?: string };
      };
      expect(refused.error.code).toBe("invalid_state");
      expect(refused.error.message ?? "").toContain("zaiApiKey");
      expect(refused.error.message ?? "").toContain("could not be decrypted");
      // Nothing went to the machine: a probe without the key would answer that
      // nobody had entered one.
      expect(listFrames<ProbeRequest>(arranged.wire, "probeRequest").slice(before)).toEqual([]);
    });
  });
  it("leaves the session whose key will not decrypt queued, and starts the rest", async () => {
    await withFleet(async (arranged) => {
      const keyed = findInstanceId(arranged, "keyed-provider");
      await setKey(arranged, keyed, KEY_VALUE);
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness
            .sql`UPDATE secrets SET ciphertext = X'00' WHERE owner_kind = 'provider-instance'`,
        ),
      );

      const stuck = await spawnSessionOrFail(arranged, { prompt: "hello", instanceId: keyed });
      // Claimed in the same walk, behind the one that cannot be read: a batch
      // rolled back whole would take this one with it.
      const running = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "plain-provider"),
      });

      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(start.sessionId).toBe(running.id);
      expect(listFrames<SessionStart>(arranged.wire, "sessionStart")).toHaveLength(1);
      // Still queued rather than starting: nothing was told to run it, so
      // nothing is waiting for it to report.
      const read = await send("GET", arranged.harness.base, `/api/v1/sessions/${stuck.id}`, {
        token: arranged.token,
      });
      expect(((await read.json()) as { readonly status: string }).status).toBe("queued");
    });
  });
});
