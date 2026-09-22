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
import type { Plugin, ProviderDefinition } from "@hercule/plugin-host";
import {
  MAX_OUTPUT_SCHEMA_LENGTH,
  type ModelDescriptor,
  type RunnerFacts,
} from "@hercule/protocol";
import { get, post, send } from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";
import {
  agentOn,
  instanceOf,
  inputsOf,
  profileNamed,
  createProfile,
  readSession,
  spawn,
  spawned,
  startFrames,
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

/** The one that stores a tool restriction and enforces none of it, as Codex does. */
const GAMMA: ProviderDefinition = {
  ...providerDefinition("gamma-provider", { token: "t" }),
  declared: {
    ...providerDefinition("gamma-provider").declared,
    disallowedTools: "unsupported",
  },
};

const registry = (): ReadonlyArray<Plugin> => [
  fixture({ id: "providers", definitions: [ALPHA, BETA, GAMMA] }).plugin,
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
 * `clever` is what a machine offers by default, so `fast` can only come from a
 * setting or an Agent, and `swift` only from the call that spawns the session.
 */
const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", isDefault: true, options: [] },
  // The one model with a choice of its own, so that options have a model to
  // belong to and a call naming another model has choices to leave behind.
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
      expect(await readStoredSpec(arranged, session.id)).toMatchObject({
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

/** One refusal, as the code it carries and everything it said. */
const parseRefusal = async (
  response: Response,
): Promise<{ readonly code: string; readonly text: string }> => {
  const text = await response.clone().text();
  const body = (await response.json()) as { readonly error: { readonly code: string } };
  return { code: body.error.code, text };
};

/** An agent of the test's own making, through the API that makes one. */
const createAgent = async (
  arranged: Arranged,
  fields: Record<string, unknown>,
): Promise<{ readonly id: string }> => {
  const response = await post(arranged.harness.base, "/api/v1/agents", fields, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { readonly id: string };
};

/** The spec the machine was told to start, off the frame that carried it. */
const readStartedSpec = async (
  arranged: Arranged,
  sessionId: string,
): Promise<Record<string, unknown>> => {
  const [frame] = await startFrames(arranged, sessionId, 1);
  return { ...frame!.spec };
};

/** A schema inside the subset the lint accepts. */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["accept", "dismiss"] } },
};

describe("placeSession from an Agent", () => {
  /** The agent every case here starts from: every field the copy has to carry. */
  const createAssessor = async (
    arranged: Arranged,
    fields: Record<string, unknown> = {},
  ): Promise<{ readonly id: string; readonly profileId: string; readonly instanceId: string }> => {
    const profile = await profileNamed(arranged, "worker");
    const instanceId = instanceOf(arranged, "alpha-provider");
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

  it("copies the agent's every value onto the session and onto the frame the machine is told", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);

      const session = await spawned(arranged, { agentId: agent.id, prompt: "assess this" });

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

  it("opens on the call's model with none of the agent's options, which were its model's", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, { model: "fast", options: { effort: "high" } });

      const session = await spawned(arranged, {
        agentId: agent.id,
        prompt: "assess this",
        model: "swift",
      });

      // A choice belongs to the model that offered it: carrying `effort` onto
      // a model that never declared it would run the session on a value
      // nobody put there.
      expect(session.modelSelection).toEqual({ model: "swift", options: {} });
    });
  });

  it("lets the values the spawning call names beat the agent's", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);

      const session = await spawned(arranged, {
        agentId: agent.id,
        prompt: "assess this",
        model: "swift",
        accessMode: "full-access",
      });

      expect(session.modelSelection.model).toBe("swift");
      expect(session.requestedAccessMode).toBe("full-access");
    });
  });

  it("falls back to the instance's default model and to full-access where the agent names neither", async () => {
    await withFleet(async (arranged) => {
      // Set, and not to be read: an Agent answers what the thread defaults
      // answer for a Thread, so reaching them here would run the agent's
      // session under a value nobody put on the agent.
      await threadDefaults(arranged, { "thread.model": "fast" });
      const bare = await createAgent(arranged, {
        name: `bare-${crypto.randomUUID()}`,
        systemPrompt: "You assess tasks.",
        instanceId: instanceOf(arranged, "alpha-provider"),
        permissionProfileId: (await profileNamed(arranged, "worker")).id,
      });

      const session = await spawned(arranged, { agentId: bare.id, prompt: "assess this" });

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
          field === "instanceId" ? agent.instanceId : (await profileNamed(arranged, "worker")).id;

        const refused = await parseRefusal(
          await spawn(arranged, { agentId: agent.id, prompt: "assess this", [field]: value }),
        );

        expect(refused.code).toBe("validation");
        expect(refused.text).toContain(field);
      });
    },
  );

  it("answers not_found for an agent nobody holds", async () => {
    await withFleet(async (arranged) => {
      const response = await spawn(arranged, {
        agentId: "0199e0e7-9999-7000-8000-000000000000",
        prompt: "assess this",
      });

      expect(response.status).toBe(404);
      expect((await parseRefusal(response)).code).toBe("not_found");
    });
  });

  it("lets a session holding session.spawn spawn from an agent bounded by no more than itself", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        permissionProfileId: (await createProfile(arranged, "narrow", ["session.read"])).id,
      });
      const { token } = await agentOn(
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

  it("refuses that same session an agent whose profile grants more than its own", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        permissionProfileId: (await profileNamed(arranged, "unrestricted")).id,
      });
      const { token } = await agentOn(
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

  it("refuses that same session an access mode more permissive than the agent's own", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        permissionProfileId: (await createProfile(arranged, "narrow-3", ["session.read"])).id,
      });
      const { token } = await agentOn(
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
      // The grant rule lets this agent through - its profile is narrower than
      // the spawner's - so the refusal has to be the mode's own.
      expect(refused.text).toContain("access mode");
    });
  });

  it("lets that same session take the mode down from the agent's own", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        permissionProfileId: (await createProfile(arranged, "narrow-4", ["session.read"])).id,
      });
      const { token } = await agentOn(
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
      // The agent runs on auto-accept-edits; a spawner may hand its worker
      // less of the machine than that, never more.
      expect(((await response.json()) as { requestedAccessMode: string }).requestedAccessMode).toBe(
        "approval-required",
      );
    });
  });

  it("leaves a running session and the spec its machine was told untouched when the agent is edited", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);
      const session = await spawned(arranged, { agentId: agent.id, prompt: "assess this" });
      const before = await readSession(arranged, session.id);
      const specBefore = await readStartedSpec(arranged, session.id);

      const patched = await send("PATCH", arranged.harness.base, `/api/v1/agents/${agent.id}`, {
        body: {
          name: "somebody-else",
          systemPrompt: "You do something else entirely.",
          instanceId: instanceOf(arranged, "beta-provider"),
          permissionProfileId: (await profileNamed(arranged, "unrestricted")).id,
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

  it("says on the session which of its spec the provider will not act on", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        instanceId: instanceOf(arranged, "gamma-provider"),
        disallowedTools: ["edit"],
      });

      const session = await spawned(arranged, { agentId: agent.id, prompt: "assess this" });

      expect(session.unenforced).toEqual(["disallowedTools"]);
      expect((await readSession(arranged, session.id)).unenforced).toEqual(["disallowedTools"]);
    });
  });

  it("carries a schema inside the subset onto the frame byte for byte", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);

      const session = await spawned(arranged, {
        agentId: agent.id,
        prompt: "assess this",
        outputSchema: SCHEMA,
      });

      expect((await readStartedSpec(arranged, session.id))["outputSchema"]).toEqual(SCHEMA);
    });
  });

  it("refuses a schema outside the subset, saying what it broke, and spawns nothing", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);

      const refused = await parseRefusal(
        await spawn(arranged, {
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

  it("refuses a schema past the bound before anything is written", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged);
      // Inside the subset in every other way: what is refused is its size, and
      // it is refused where a schema is decoded rather than where it is linted.
      const keys = Array.from({ length: 2_000 }, (_, index) => `field-${String(index)}`);
      const properties = Object.fromEntries(keys.map((key) => [key, { type: "string" }]));

      const refused = await parseRefusal(
        await spawn(arranged, {
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
