/**
 * Placing a thread: the user's settings decide what it runs, the fleet decides
 * where, and the working area it asked for is made before it can start.
 *
 * Driven over the real API and the real runner socket, because one of the
 * things asserted here is only visible there: what crosses the wire to the
 * machine.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Plugin, ProviderDefinition } from "@hydra/plugin-host";
import type { ModelDescriptor, RunnerFacts } from "@hydra/protocol";
import { send } from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";
import {
  instanceOf,
  inputsOf,
  profileNamed,
  spawned,
  until,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../sessions/testing";
import { framesTagged, readWorkspace, repo } from "../workspaces/testing";

/** Everything native, and not the instance the thread defaults will name. */
const ALPHA: ProviderDefinition = providerDefinition("alpha-provider", { token: "t" });

/** The instance the thread defaults name. */
const BETA: ProviderDefinition = providerDefinition("beta-provider", { token: "t" });

const registry = (): ReadonlyArray<Plugin> => [
  fixture({ id: "providers", definitions: [ALPHA, BETA] }).plugin,
];

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [{ name: "git", version: "2.50.1", path: "/usr/bin/git" }],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["alpha-provider", "beta-provider"],
  identityPort: 4939,
};

/** `clever` is what a machine offers by default, so `fast` can only come from a setting. */
const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", isDefault: true, options: [] },
  { slug: "fast", name: "Fast", options: [] },
];

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, { plugins: registry(), facts: FACTS, models: MODELS });

/** The user's thread defaults, written the way the settings screen writes them. */
const threadDefaults = async (
  arranged: Arranged,
  values: Record<string, unknown>,
): Promise<void> => {
  const response = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
    body: { user: values },
    token: arranged.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

/** The spec document the session was stored with, read off its row. */
const specOf = async (arranged: Arranged, id: string): Promise<Record<string, unknown>> => {
  const [row] = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ readonly spec: string }>`
        SELECT spec FROM sessions WHERE id = unhex(replace(${id}, '-', ''))`,
    ),
  );
  expect(row, "the session was stored with no row").toBeDefined();
  return JSON.parse(row!.spec) as Record<string, unknown>;
};

/** The workspace frame the machine was told to act on, once it is on the wire. */
const provisionFrame = (arranged: Arranged): Promise<Record<string, unknown>> =>
  until(
    "told the machine to make the working area",
    () => framesTagged(arranged.wire, "workspaceProvision")[0],
  );

const ephemeral = (resourceId: string) => ({
  kind: "ephemeral" as const,
  checkouts: [{ resourceId }],
});

describe("placeSession", () => {
  it("carries the user's thread defaults into the stored spec", async () => {
    await withFleet(async (arranged) => {
      const beta = instanceOf(arranged, "beta-provider");
      const worker = await profileNamed(arranged, "worker");
      await threadDefaults(arranged, {
        "thread.instanceId": beta,
        "thread.model": "fast",
        "thread.accessMode": "auto",
        "thread.profileId": worker.id,
      });

      const session = await spawned(arranged, { prompt: "hello" });

      expect(session.instanceId).toBe(beta);
      expect(session.permissionProfileId).toBe(worker.id);
      expect(session.accessMode).toBe("auto");
      expect(session.modelSelection).toEqual({ model: "fast", options: {} });
      expect(await specOf(arranged, session.id)).toMatchObject({
        instanceId: beta,
        modelSelection: { model: "fast", options: {} },
        accessMode: "auto",
      });
    });
  });

  it("puts the session on the runner it placed, in the workspace it opened, with the prompt as its first input", async () => {
    await withFleet(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");

      const session = await spawned(arranged, {
        prompt: "take a look",
        workspace: ephemeral(web),
      });

      expect(session.runnerId).toBe(arranged.runnerId);
      expect(session.workspaceId).not.toBeNull();
      const workspace = await readWorkspace(arranged, String(session.workspaceId));
      expect(workspace.runnerId).toBe(arranged.runnerId);

      const inputs = await inputsOf(arranged, session.id);
      expect(inputs.map((one) => one.text)).toEqual(["take a look"]);
      expect(inputs[0]?.source).toBe("user");

      expect((await provisionFrame(arranged))["workspaceId"]).toBe(session.workspaceId);

      const entries = await arranged.harness.audit("session.spawned");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
      expect(entries[0]?.payload).toMatchObject({
        sessionId: session.id,
        instanceId: session.instanceId,
        runnerId: arranged.runnerId,
      });
    });
  });
});
