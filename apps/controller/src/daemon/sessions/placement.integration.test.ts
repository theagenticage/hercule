/**
 * Tests placing a session: the user's settings or the Agent decide what it
 * runs, placement decides which runner, and the requested workspace is
 * provisioned before the session can start.
 *
 * The tests use the real API and the real runner socket, because some checks
 * are only visible there: the frames sent to the runner.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Plugin, ProviderDefinition } from "@hercule/plugin-host";
import {
  MAX_OUTPUT_SCHEMA_LENGTH,
  type ModelDescriptor,
  type RunnerFacts,
} from "@hercule/protocol";
import { get, post, send } from "../../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../../plugins/testing";
import {
  spawnThreadUnder,
  findInstanceId,
  listInputs,
  readProfileNamed,
  createProfile,
  readSession,
  spawnSession,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../../sessions/testing";
import { listFramesTagged, readWorkspace, createRepo } from "../../workspaces/testing";

/** A provider that supports everything natively, and is not the thread default. */
const ALPHA: ProviderDefinition = buildProviderDefinition("alpha-provider", { token: "t" });

/** The provider the tests set as the thread default. */
const BETA: ProviderDefinition = buildProviderDefinition("beta-provider", { token: "t" });

/** A provider that stores a tool restriction but does not enforce it, like Codex. */
const GAMMA: ProviderDefinition = {
  ...buildProviderDefinition("gamma-provider", { token: "t" }),
  declared: {
    ...buildProviderDefinition("gamma-provider").declared,
    disallowedTools: "unsupported",
  },
};

const buildPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({ id: "providers", definitions: [ALPHA, BETA, GAMMA] }).plugin,
];

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [{ name: "git", version: "2.50.1", path: "/usr/bin/git" }],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["alpha-provider", "beta-provider", "gamma-provider"],
  identityPort: 4939,
};

/**
 * `clever` is the runner's default model. So in these tests `fast` can only
 * come from a setting or an Agent, and `swift` only from the spawn call.
 */
const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", isDefault: true, options: [] },
  // The only model with an option, so tests can check that options stay with
  // their model when a call picks another model.
  {
    slug: "fast",
    name: "Fast",
    options: [
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        choices: [
          { value: "high", label: "High" },
          { value: "low", label: "Low" },
        ],
        default: "low",
      },
    ],
  },
  { slug: "swift", name: "Swift", options: [] },
];

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, { plugins: buildPlugins(), facts: FACTS, models: MODELS });

/** Sets the user's thread defaults through the settings API, as the settings screen does. */
const setThreadDefaults = async (
  arranged: Arranged,
  values: Record<string, unknown>,
): Promise<void> => {
  const response = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
    body: { user: values },
    token: arranged.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Reads the spec stored on the session's row. */
const readStoredSpec = async (arranged: Arranged, id: string): Promise<Record<string, unknown>> => {
  const [row] = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ readonly spec: string }>`
        SELECT spec FROM sessions WHERE id = unhex(replace(${id}, '-', ''))`,
    ),
  );
  expect(row, "the session was stored with no row").toBeDefined();
  return JSON.parse(row!.spec) as Record<string, unknown>;
};

/** Waits for the first workspace provision frame sent to the runner, and returns it. */
const waitForProvisionFrame = (arranged: Arranged): Promise<Record<string, unknown>> =>
  waitUntil(
    "told the runner to provision the workspace",
    () => listFramesTagged(arranged.wire, "workspaceProvision")[0],
  );

const buildEphemeralWorkspace = (resourceId: string) => ({
  kind: "ephemeral" as const,
  checkouts: [{ resourceId }],
});

describe("placeSession", () => {
  it("carries the user's thread defaults into the stored spec", async () => {
    await withFleet(async (arranged) => {
      const beta = findInstanceId(arranged, "beta-provider");
      const worker = await readProfileNamed(arranged, "worker");
      await setThreadDefaults(arranged, {
        "thread.instanceId": beta,
        "thread.model": "fast",
        "thread.accessMode": "auto",
        "thread.profileId": worker.id,
      });

      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });

      expect(session.instanceId).toBe(beta);
      expect(session.permissionProfileId).toBe(worker.id);
      expect(session.accessMode).toBe("auto");
      expect(session.modelSelection).toEqual({ model: "fast", options: {} });
      expect(await readStoredSpec(arranged, session.id)).toMatchObject({
        instanceId: beta,
        modelSelection: { model: "fast", options: {} },
        accessMode: "auto",
      });
    });
  });

  it("places the session on the chosen runner, in the new workspace, with the prompt as its first input", async () => {
    await withFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");

      const session = await spawnSessionOrFail(arranged, {
        prompt: "take a look",
        workspace: buildEphemeralWorkspace(web),
      });

      expect(session.runnerId).toBe(arranged.runnerId);
      expect(session.workspaceId).not.toBeNull();
      const workspace = await readWorkspace(arranged, String(session.workspaceId));
      expect(workspace.runnerId).toBe(arranged.runnerId);

      const inputs = await listInputs(arranged, session.id);
      expect(inputs.map((one) => one.text)).toEqual(["take a look"]);
      expect(inputs[0]?.source).toBe("user");

      expect((await waitForProvisionFrame(arranged))["workspaceId"]).toBe(session.workspaceId);

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

/** Parses an error response into its code and its full body text. */
const parseRefusal = async (
  response: Response,
): Promise<{ readonly code: string; readonly text: string }> => {
  const text = await response.clone().text();
  const body = (await response.json()) as { readonly error: { readonly code: string } };
  return { code: body.error.code, text };
};

/** Creates an agent through the API. */
const createAgent = async (
  arranged: Arranged,
  fields: Record<string, unknown>,
): Promise<{ readonly id: string }> => {
  const response = await post(arranged.harness.base, "/api/v1/agents", fields, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { readonly id: string };
};

/** Waits for the session's start frame and returns the spec it carries. */
const readStartedSpec = async (
  arranged: Arranged,
  sessionId: string,
): Promise<Record<string, unknown>> => {
  const [frame] = await waitForStartFrames(arranged, sessionId, 1);
  return { ...frame!.spec };
};

/** A schema inside the supported subset, which the lint accepts. */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["accept", "dismiss"] } },
};

describe("placeSession from an Agent", () => {
  /** Creates the agent the tests start from, with every field that has to be copied to the session. */
  const createAssessor = async (
    arranged: Arranged,
    fields: Record<string, unknown> = {},
  ): Promise<{ readonly id: string; readonly profileId: string; readonly instanceId: string }> => {
    const profile = await readProfileNamed(arranged, "worker");
    const instanceId = findInstanceId(arranged, "alpha-provider");
    const agent = await createAgent(arranged, {
      name: `assessor-${crypto.randomUUID()}`,
      systemPrompt: "You assess tasks.",
      instanceId,
      permissionProfileId: profile.id,
      accessMode: "auto-accept-edits",
      model: "fast",
      disallowedTools: ["edit", "shell"],
      ...fields,
    });
    return { id: agent.id, profileId: profile.id, instanceId };
  };

  it("copies every value of the agent onto the session and onto the start frame", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);

      const session = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "assess this",
      });

      expect(session.agentId).toBe(agent.id);
      expect(session.permissionProfileId).toBe(agent.profileId);
      expect(session.instanceId).toBe(agent.instanceId);
      expect(session.requestedAccessMode).toBe("auto-accept-edits");
      expect(session.modelSelection.model).toBe("fast");
      expect(session.unenforced).toEqual([]);

      const spec = await readStartedSpec(arranged, session.id);
      expect(spec["systemPrompt"]).toBe("You assess tasks.");
      expect(spec["disallowedTools"]).toEqual(["edit", "shell"]);
      expect(spec["accessMode"]).toBe("auto-accept-edits");
      expect(spec["outputSchema"]).toBeUndefined();
    });
  });

  it("uses the call's model without the agent's options, which belong to the agent's model", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, { model: "fast", options: { effort: "high" } });

      const session = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "assess this",
        model: "swift",
      });

      // An option belongs to the model that offers it. Keeping `effort` for a
      // model that does not declare it would run the session with a value
      // nobody chose for that model.
      expect(session.modelSelection).toEqual({ model: "swift", options: {} });
    });
  });

  it("lets values in the spawn call override the agent's", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);

      const session = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "assess this",
        model: "swift",
        accessMode: "full-access",
      });

      expect(session.modelSelection.model).toBe("swift");
      expect(session.requestedAccessMode).toBe("full-access");
    });
  });

  it("falls back to the instance's default model and to full-access when the agent sets neither", async () => {
    await withFleet(async (arranged) => {
      // Set, but must not be used: an Agent replaces the thread defaults, so
      // using them here would run the agent's session with a value nobody
      // set on the agent.
      await setThreadDefaults(arranged, { "thread.model": "fast" });
      const bare = await createAgent(arranged, {
        name: `bare-${crypto.randomUUID()}`,
        systemPrompt: "You assess tasks.",
        instanceId: findInstanceId(arranged, "alpha-provider"),
        permissionProfileId: (await readProfileNamed(arranged, "worker")).id,
      });

      const session = await spawnSessionOrFail(arranged, {
        agentId: bare.id,
        prompt: "assess this",
      });

      expect(session.modelSelection.model).toBe("clever");
      expect(session.requestedAccessMode).toBe("full-access");
    });
  });

  it.each(["instanceId", "permissionProfileId"])(
    "refuses a spawn that names %s beside the agent it comes from",
    async (field) => {
      await withFleet(async (arranged) => {
        const agent = await createAssessor(arranged);
        const value =
          field === "instanceId"
            ? agent.instanceId
            : (await readProfileNamed(arranged, "worker")).id;

        const refused = await parseRefusal(
          await spawnSession(arranged, {
            agentId: agent.id,
            prompt: "assess this",
            [field]: value,
          }),
        );

        expect(refused.code).toBe("validation");
        expect(refused.text).toContain(field);
      });
    },
  );

  it("fails with not_found for an agent that does not exist", async () => {
    await withFleet(async (arranged) => {
      const response = await spawnSession(arranged, {
        agentId: "0199e0e7-9999-7000-8000-000000000000",
        prompt: "assess this",
      });

      expect(response.status).toBe(404);
      expect((await parseRefusal(response)).code).toBe("not_found");
    });
  });

  it("lets a session with session.spawn spawn from an agent whose grants are no wider than its own", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        permissionProfileId: (await createProfile(arranged, "narrow", ["session.read"])).id,
      });
      const { token } = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "spawner", ["session.spawn", "session.read"]),
      );

      const response = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        { agentId: agent.id, prompt: "assess this" },
        token,
      );

      expect(response.status, await response.clone().text()).toBe(200);
      expect(((await response.json()) as { agentId: string }).agentId).toBe(agent.id);
    });
  });

  it("forbids that session to spawn from an agent whose profile grants more than its own", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        permissionProfileId: (await readProfileNamed(arranged, "unrestricted")).id,
      });
      const { token } = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "spawner-2", ["session.spawn", "session.read"]),
      );

      const response = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        { agentId: agent.id, prompt: "assess this" },
        token,
      );

      expect(response.status, await response.clone().text()).toBe(403);
      const refused = (await response.json()) as {
        readonly error: { readonly code: string; readonly details?: { readonly grant?: string } };
      };
      expect(refused.error.code).toBe("forbidden");
      expect(refused.error.details?.grant).toBe("session.spawn");
    });
  });

  it("forbids that session to ask for an access mode more permissive than the agent's", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        permissionProfileId: (await createProfile(arranged, "narrow-3", ["session.read"])).id,
      });
      const { token } = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "spawner-3", ["session.spawn", "session.read"]),
      );

      const response = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        { agentId: agent.id, prompt: "assess this", accessMode: "full-access" },
        token,
      );

      expect(response.status, await response.clone().text()).toBe(403);
      const refused = await parseRefusal(response);
      expect(refused.code).toBe("forbidden");
      // The grant rule allows this agent, because its profile is narrower than
      // the spawner's. So the error must come from the access mode rule.
      expect(refused.text).toContain("access mode");
    });
  });

  it("lets that session ask for a less permissive access mode than the agent's", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        permissionProfileId: (await createProfile(arranged, "narrow-4", ["session.read"])).id,
      });
      const { token } = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "spawner-4", ["session.spawn", "session.read"]),
      );

      const response = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        { agentId: agent.id, prompt: "assess this", accessMode: "approval-required" },
        token,
      );

      expect(response.status, await response.clone().text()).toBe(200);
      // The agent runs on auto-accept-edits. A spawner may give its worker less
      // access than that, never more.
      expect(((await response.json()) as { requestedAccessMode: string }).requestedAccessMode).toBe(
        "approval-required",
      );
    });
  });

  it("leaves a running session and its start spec unchanged when the agent is edited", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);
      const session = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "assess this",
      });
      // The fake runner answers the input the start carries, which moves the
      // session from `starting` to `busy`. Taken before that answer, the
      // snapshot would differ from the later read for a reason that has
      // nothing to do with the edit.
      const before = await waitForSession(arranged, session.id, (one) => one.status === "busy");
      const specBefore = await readStartedSpec(arranged, session.id);

      const patched = await send("PATCH", arranged.harness.base, `/api/v1/agents/${agent.id}`, {
        body: {
          name: "somebody-else",
          systemPrompt: "You do something else entirely.",
          instanceId: findInstanceId(arranged, "beta-provider"),
          permissionProfileId: (await readProfileNamed(arranged, "unrestricted")).id,
          accessMode: "approval-required",
          model: "clever",
          disallowedTools: [],
        },
        token: arranged.token,
      });
      expect(patched.status, await patched.clone().text()).toBe(200);

      expect(await readSession(arranged, session.id)).toEqual(before);
      expect(await readStartedSpec(arranged, session.id)).toEqual(specBefore);
      expect(specBefore["systemPrompt"]).toBe("You assess tasks.");
    });
  });

  it("lists on the session the spec fields the provider does not enforce", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        instanceId: findInstanceId(arranged, "gamma-provider"),
        disallowedTools: ["edit"],
      });

      const session = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "assess this",
      });

      expect(session.unenforced).toEqual(["disallowedTools"]);
      expect((await readSession(arranged, session.id)).unenforced).toEqual(["disallowedTools"]);
    });
  });

  it("sends a schema inside the subset on the start frame unchanged", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);

      const session = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "assess this",
        outputSchema: SCHEMA,
      });

      expect((await readStartedSpec(arranged, session.id))["outputSchema"]).toEqual(SCHEMA);
    });
  });

  it("rejects a schema outside the subset, says which rule it breaks, and spawns nothing", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);

      const refused = await parseRefusal(
        await spawnSession(arranged, {
          agentId: agent.id,
          prompt: "assess this",
          outputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["verdict"],
            properties: { verdict: { type: "string", oneOf: [{ type: "string" }] } },
          },
        }),
      );

      expect(refused.code).toBe("validation");
      expect(refused.text).toContain("oneOf");
      expect(refused.text).toContain("/properties/verdict");

      const listing = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
      expect(listing.status, await listing.clone().text()).toBe(200);
      expect(((await listing.json()) as { items: ReadonlyArray<unknown> }).items).toEqual([]);
    });
  });

  it("rejects a schema over the size limit before anything is written", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);
      // Valid in every other way, so the error is about its size. The size is
      // checked when the input is decoded, before the lint runs.
      const keys = Array.from({ length: 2_000 }, (_, index) => `field-${String(index)}`);
      const properties = Object.fromEntries(keys.map((key) => [key, { type: "string" }]));

      const refused = await parseRefusal(
        await spawnSession(arranged, {
          agentId: agent.id,
          prompt: "assess this",
          outputSchema: {
            type: "object",
            additionalProperties: false,
            required: keys,
            properties,
          },
        }),
      );

      expect(refused.code).toBe("validation");
      expect(refused.text).toContain(String(MAX_OUTPUT_SCHEMA_LENGTH));

      const listing = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
      expect(((await listing.json()) as { items: ReadonlyArray<unknown> }).items).toEqual([]);
    });
  });
});
