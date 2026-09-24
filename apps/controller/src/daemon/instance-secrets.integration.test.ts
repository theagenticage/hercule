/**
 * Tests that a provider instance's secret field reaches the runner that needs
 * it.
 *
 * The value is stored encrypted in the controller's table and decrypted when
 * a frame is built. So it exists in plain text only in that frame, and in the
 * runner's memory for that one operation. The tests use the real API and the
 * real runner socket, because the frames that cross the socket are what they
 * check.
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

/** A provider whose config has one secret field, like pi's. */
const KEYED: ProviderDefinition = {
  ...buildProviderDefinition("keyed-provider", { token: "t" }),
  configSchema: Schema.Struct({
    token: Schema.String,
    zaiApiKey: secret({ title: KEY_TITLE, description: KEY_DESCRIPTION }),
  }),
};

/** A provider with no secret fields, for frames that carry no secrets. */
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

/** Asks the controller to probe one instance, and returns the probe frame the runner received. */
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

  it("sends an empty set of secrets when the key has not been entered, rather than leaving the field out", async () => {
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
      // Never in the config: the config is stored in plain text, and this value
      // must not be.
      expect(JSON.stringify(start.config)).not.toContain(KEY_VALUE);
      expect(JSON.stringify(start.spec)).not.toContain(KEY_VALUE);
    });
  });

  it("sends an empty set of secrets when starting a session on an instance with no key set", async () => {
    await withFleet(async (arranged) => {
      await spawnSessionOrFail(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "plain-provider"),
      });
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;

      expect(start.secrets).toEqual({});
    });
  });
  it("sends only the secret fields the plugin declares, not other secrets stored for the instance", async () => {
    await withFleet(async (arranged) => {
      const keyed = findInstanceId(arranged, "keyed-provider");
      await setKey(arranged, keyed, KEY_VALUE);
      // Left behind by a plugin that dropped the field, or inserted by hand:
      // it is nobody's credential, and must not be sent to a runner.
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
  it("fails the probe when the key cannot be decrypted, rather than sending it without the key", async () => {
    await withFleet(async (arranged) => {
      const keyed = findInstanceId(arranged, "keyed-provider");
      await setKey(arranged, keyed, KEY_VALUE);
      // Corrupt the ciphertext. That looks the same as a row written under a
      // different Master Key, which a running controller has no way to set up.
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
      // Nothing was sent to the runner: a probe without the key would report
      // that no key was entered.
      expect(listFrames<ProbeRequest>(arranged.wire, "probeRequest").slice(before)).toEqual([]);
    });
  });
  it("leaves a session whose key cannot be decrypted queued, and starts the others", async () => {
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
      // Claimed in the same dispatch, after the session whose key cannot be
      // read. If the whole batch rolled back, this one would not start either.
      const running = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        instanceId: findInstanceId(arranged, "plain-provider"),
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
