/**
 * Tests the Agent over HTTP: the named, reusable configuration a session is
 * spawned from. The tests use the real API, with a real machine on the real
 * runner socket.
 *
 * A machine is needed for two of the assertions:
 *
 * - `unenforced` is read from the instance's provider definition.
 * - A delete must be rejected while a session spawned from the agent still
 *   runs.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Plugin, ProviderDefinition } from "@hercule/plugin-host";
import type { ModelDescriptor, RunnerFacts } from "@hercule/protocol";
import type { Agent as AgentRecord, Assistant, Session } from "@hercule/contract";
import { del, get, post, readErrorBody, send } from "../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import {
  spawnThreadUnder,
  at,
  readProfileNamed,
  createProfile,
  reportEvent,
  waitForSession,
  spawnSessionOrFail,
  waitForStartFrames,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../sessions/testing";

/** A provider that enforces a tool restriction natively, as Claude Code does. */
const CLAUDE: ProviderDefinition = buildProviderDefinition("claude-provider", { token: "t" });

/** A provider that enforces a tool restriction natively, as pi does. */
const PI: ProviderDefinition = buildProviderDefinition("pi-provider", { token: "t" });

/** A provider that stores a tool restriction but enforces none, as Codex does. */
const CODEX: ProviderDefinition = {
  ...buildProviderDefinition("codex-provider", { token: "t" }),
  declared: {
    ...buildProviderDefinition("codex-provider").declared,
    disallowedTools: "unsupported",
  },
};

const buildPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({ id: "providers", definitions: [CLAUDE, CODEX, PI] }).plugin,
];

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["claude-provider", "codex-provider", "pi-provider"],
  identityPort: 4939,
};

const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", acceptsImages: true, isDefault: true, options: [] },
  { slug: "fast", name: "Fast", acceptsImages: true, options: [] },
];

/**
 * Three times the wait deadline, because the longest case here waits for the
 * fleet to be probed, then for a session to start, and then for it to exit.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, { plugins: buildPlugins(), facts: FACTS, models: MODELS });

/** A well-formed id that matches no record. */
const NOBODY = "0199e0e7-9999-7000-8000-000000000000";

const findInstanceId = (arranged: Arranged, providerId: string): string => {
  const found = arranged.instances.find((instance) => instance.providerId === providerId);
  expect(found, providerId).toBeDefined();
  return found!.id;
};

/** An error response: its code, the grant it names, and its full text. */
interface Refusal {
  readonly code: string;
  readonly grant?: string;
  /** The full response body, for asserting which field or entry the error names. */
  readonly text: string;
}

const parseRefusal = async (response: Response): Promise<Refusal> => {
  const text = await response.clone().text();
  const body = (await response.json()) as {
    readonly error: {
      readonly code: string;
      readonly details?: { readonly grant?: string };
    };
  };
  return {
    code: body.error.code,
    ...(body.error.details?.grant === undefined ? {} : { grant: body.error.details.grant }),
    text,
  };
};

const createAgent = (
  arranged: Arranged,
  fields: Record<string, unknown>,
  token = arranged.token,
): Promise<Response> => post(arranged.harness.base, "/api/v1/agents", fields, token);

const updateAgent = (
  arranged: Arranged,
  id: string,
  fields: Record<string, unknown>,
  token = arranged.token,
): Promise<Response> =>
  send("PATCH", arranged.harness.base, `/api/v1/agents/${id}`, { body: fields, token });

/** Creates an agent with the four required fields, as every case here does. */
const createAgentForInstance = async (
  arranged: Arranged,
  instanceId: string,
  fields: Record<string, unknown> = {},
): Promise<AgentRecord> => {
  const profile = await readProfileNamed(arranged, "unrestricted");
  const response = await createAgent(arranged, {
    name: `agent-${crypto.randomUUID()}`,
    systemPrompt: "You assess tasks.",
    instanceId,
    permissionProfileId: profile.id,
    ...fields,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as AgentRecord;
};

const readAgent = async (arranged: Arranged, id: string): Promise<AgentRecord> => {
  const response = await get(arranged.harness.base, `/api/v1/agents/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as AgentRecord;
};

const listAgents = async (arranged: Arranged): Promise<ReadonlyArray<AgentRecord>> => {
  const response = await get(arranged.harness.base, "/api/v1/agents", arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<AgentRecord> }).items;
};

const listSessions = async (arranged: Arranged, query: string): Promise<ReadonlyArray<Session>> => {
  const response = await get(arranged.harness.base, `/api/v1/sessions?${query}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Session> }).items;
};

/** Spawns a session from an agent and returns it. */
const spawnSessionFor = async (arranged: Arranged, agentId: string): Promise<Session> =>
  spawnSessionOrFail(arranged, { agentId, prompt: "assess this" });

/**
 * Reports the session as started and waits until the runner has answered its
 * prompt. The fake runner answers `opened`, so the session is then `busy` with
 * the prompt's turn. The runner has reported one event, at sequence number 1.
 */
const driveSessionToBusy = async (arranged: Arranged, session: Session): Promise<void> => {
  await waitForStartFrames(arranged, session.id, 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
    providerRefs: { nativeSessionId: `native-${session.id}` },
  });
  await waitForSession(arranged, session.id, (one) => one.status === "busy");
};

/** Drives the session to `busy`, then reports its prompt's turn completed at sequence number 2. */
const driveSessionToIdle = async (arranged: Arranged, session: Session): Promise<void> => {
  await driveSessionToBusy(arranged, session);
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "turn.completed",
    turnId: "t1",
    state: "completed",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "idle");
};

const driveSessionToExited = async (
  arranged: Arranged,
  session: Session,
  seq: number,
): Promise<void> => {
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "exited");
};

describe("the agent over its five operations", () => {
  it("is created with the defaults for a background agent, reads and lists the same way, accepts an update, and is gone after a delete", async () => {
    await withFleet(async (arranged) => {
      const instanceId = findInstanceId(arranged, "claude-provider");
      const profile = await readProfileNamed(arranged, "unrestricted");

      const created = await createAgentForInstance(arranged, instanceId);

      expect(created.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(created.systemPrompt).toBe("You assess tasks.");
      expect(created.instanceId).toBe(instanceId);
      expect(created.permissionProfileId).toBe(profile.id);
      expect(created.accessMode).toBe("full-access");
      expect(created.model).toBeNull();
      expect(created.disallowedTools).toEqual([]);
      expect(created.unenforced).toEqual([]);
      expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(created.updatedAt).toBe(created.createdAt);

      expect(await readAgent(arranged, created.id)).toEqual(created);
      expect(await listAgents(arranged)).toEqual([created]);

      const patched = await updateAgent(arranged, created.id, {
        model: "fast",
        options: { effort: "high" },
        disallowedTools: ["edit"],
        accessMode: "auto",
      });
      expect(patched.status, await patched.clone().text()).toBe(200);
      const updated = (await patched.json()) as AgentRecord;
      // The call takes two fields and the record stores one selection. The
      // options belong to the model sent with them.
      expect(updated.model).toEqual({ model: "fast", options: { effort: "high" } });
      expect(updated.disallowedTools).toEqual(["edit"]);
      expect(updated.accessMode).toBe("auto");
      expect(updated.createdAt).toBe(created.createdAt);
      expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));
      expect(updated.updatedAt).not.toBe(created.updatedAt);
      expect(await readAgent(arranged, created.id)).toEqual(updated);

      const deleted = await del(
        arranged.harness.base,
        `/api/v1/agents/${created.id}`,
        arranged.token,
      );
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      expect(await deleted.json()).toEqual({});

      const gone = await get(arranged.harness.base, `/api/v1/agents/${created.id}`, arranged.token);
      expect(gone.status).toBe(404);
      expect((await parseRefusal(gone)).code).toBe("not_found");
      expect(await listAgents(arranged)).toEqual([]);
    });
  });

  it.each([
    {
      what: "an instance that does not exist",
      fields: { instanceId: NOBODY },
      names: "instanceId",
    },
    {
      what: "a profile that does not exist",
      fields: { permissionProfileId: NOBODY },
      names: "permissionProfileId",
    },
    {
      what: "a tool family outside the five",
      fields: { disallowedTools: ["browse"] },
      names: "browse",
    },
    {
      what: "options without a model",
      fields: { options: { effort: "high" } },
      names: "options",
    },
  ])("rejects a create with $what, and names the field", async ({ fields, names }) => {
    await withFleet(async (arranged) => {
      const profile = await readProfileNamed(arranged, "unrestricted");
      const response = await createAgent(arranged, {
        name: "assessor",
        systemPrompt: "You assess tasks.",
        instanceId: findInstanceId(arranged, "claude-provider"),
        permissionProfileId: profile.id,
        ...fields,
      });

      const refused = await parseRefusal(response);
      expect(refused.code).toBe("validation");
      expect(refused.text).toContain(names);
    });
  });

  it.each([
    {
      what: "an instance that does not exist",
      fields: { instanceId: NOBODY },
      names: "instanceId",
    },
    {
      what: "a profile that does not exist",
      fields: { permissionProfileId: NOBODY },
      names: "permissionProfileId",
    },
    {
      what: "a tool family outside the five",
      fields: { disallowedTools: ["browse"] },
      names: "browse",
    },
    {
      what: "options without a model",
      fields: { options: { effort: "high" } },
      names: "options",
    },
  ])("rejects an update with $what, and names the field", async ({ fields, names }) => {
    await withFleet(async (arranged) => {
      const agent = await createAgentForInstance(
        arranged,
        findInstanceId(arranged, "claude-provider"),
      );

      const refused = await parseRefusal(await updateAgent(arranged, agent.id, fields));
      expect(refused.code).toBe("validation");
      expect(refused.text).toContain(names);
    });
  });

  it("rejects every call by an actor whose profile lacks the grant, and names the grant", async () => {
    await withFleet(async (arranged) => {
      const instanceId = findInstanceId(arranged, "claude-provider");
      const agent = await createAgentForInstance(arranged, instanceId);
      const profile = await readProfileNamed(arranged, "unrestricted");
      const { token } = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "no-agents", ["task.read"]),
      );
      const base = arranged.harness.base;

      const calls: ReadonlyArray<readonly [string, Promise<Response>, string]> = [
        [
          "create",
          post(
            base,
            "/api/v1/agents",
            {
              name: "sneaky",
              systemPrompt: "x",
              instanceId,
              permissionProfileId: profile.id,
            },
            token,
          ),
          "agent.write",
        ],
        [
          "update",
          send("PATCH", base, `/api/v1/agents/${agent.id}`, {
            body: { accessMode: "auto" },
            token,
          }),
          "agent.write",
        ],
        ["delete", del(base, `/api/v1/agents/${agent.id}`, token), "agent.write"],
        ["query", get(base, "/api/v1/agents", token), "agent.read"],
        ["read", get(base, `/api/v1/agents/${agent.id}`, token), "agent.read"],
      ];

      for (const [operation, pending, grant] of calls) {
        const response = await pending;
        expect(response.status, operation).toBe(403);
        const refused = await parseRefusal(response);
        expect(refused.code, operation).toBe("forbidden");
        expect(refused.grant, operation).toBe(grant);
      }
    });
  });
});

describe("what a provider declares it will not enforce", () => {
  it.each([
    {
      what: "a Codex instance with a restriction",
      provider: "codex-provider",
      tools: ["edit"],
      unenforced: ["disallowedTools"],
    },
    {
      what: "a Codex instance with no restriction",
      provider: "codex-provider",
      tools: [],
      unenforced: [],
    },
    {
      what: "a Claude Code instance with a restriction",
      provider: "claude-provider",
      tools: ["edit"],
      unenforced: [],
    },
    {
      what: "a pi instance with a restriction",
      provider: "pi-provider",
      tools: ["edit"],
      unenforced: [],
    },
  ])(
    "reports unenforced for $what, at create and at read",
    async ({ provider, tools, unenforced }) => {
      await withFleet(async (arranged) => {
        const created = await createAgentForInstance(arranged, findInstanceId(arranged, provider), {
          disallowedTools: tools,
        });

        expect(created.unenforced).toEqual(unenforced);
        expect((await readAgent(arranged, created.id)).unenforced).toEqual(unenforced);
      });
    },
  );
});

describe("deleting an agent a session still points at", () => {
  it.each(["starting", "idle", "busy"])(
    "is rejected while a session is %s, and names the session",
    async (status) => {
      await withFleet(async (arranged) => {
        const agent = await createAgentForInstance(
          arranged,
          findInstanceId(arranged, "claude-provider"),
        );
        // The runner leaves a starting session's start unanswered, so the
        // session cannot move on to `busy`.
        if (status === "starting") arranged.wire.answering(() => undefined);
        const session = await spawnSessionFor(arranged, agent.id);
        if (status === "starting") await waitForStartFrames(arranged, session.id, 1);
        if (status === "idle") await driveSessionToIdle(arranged, session);
        if (status === "busy") await driveSessionToBusy(arranged, session);
        await waitForSession(arranged, session.id, (one) => one.status === status);

        const refused = await parseRefusal(
          await del(arranged.harness.base, `/api/v1/agents/${agent.id}`, arranged.token),
        );

        expect(refused.code).toBe("invalid_state");
        expect(refused.text).toContain(session.id);
      });
    },
  );

  it("succeeds once every session it spawned has exited, and those sessions keep its id", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAgentForInstance(
        arranged,
        findInstanceId(arranged, "claude-provider"),
      );
      const session = await spawnSessionFor(arranged, agent.id);
      await driveSessionToBusy(arranged, session);
      await driveSessionToExited(arranged, session, 2);

      const deleted = await del(
        arranged.harness.base,
        `/api/v1/agents/${agent.id}`,
        arranged.token,
      );
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      const response = await get(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}`,
        arranged.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect(((await response.json()) as Session).agentId).toBe(agent.id);
    });
  });
});

describe("listing sessions by what spawned them", () => {
  it("returns one agent's sessions by its id, and only the threads for a thread listing", async () => {
    await withFleet(async (arranged) => {
      const instanceId = findInstanceId(arranged, "claude-provider");
      const mine = await createAgentForInstance(arranged, instanceId);
      const other = await createAgentForInstance(arranged, instanceId);
      const ours = await spawnSessionFor(arranged, mine.id);
      const theirs = await spawnSessionFor(arranged, other.id);
      const thread = await spawnSessionOrFail(arranged, { prompt: "by hand" });

      expect((await listSessions(arranged, `agentId=${mine.id}`)).map((one) => one.id)).toEqual([
        ours.id,
      ]);
      expect((await listSessions(arranged, `agentId=${other.id}`)).map((one) => one.id)).toEqual([
        theirs.id,
      ]);
      expect((await listSessions(arranged, "thread=true")).map((one) => one.id)).toEqual([
        thread.id,
      ]);
    });
  });

  it("rejects a listing that names an agent and also asks for threads", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAgentForInstance(
        arranged,
        findInstanceId(arranged, "claude-provider"),
      );

      const response = await get(
        arranged.harness.base,
        `/api/v1/sessions?agentId=${agent.id}&thread=true`,
        arranged.token,
      );

      expect(response.status).toBe(400);
      const refused = await parseRefusal(response);
      expect(refused.code).toBe("validation");
      expect(refused.text).toContain("thread");
    });
  });
});

describe("the permission profile an agent spawns under", () => {
  it("rejects deleting a profile that an agent names, and names the agent", async () => {
    await withFleet(async (arranged) => {
      const profile = await createProfile(arranged, "assessors", ["session.read"]);
      const agent = await createAgentForInstance(
        arranged,
        findInstanceId(arranged, "claude-provider"),
        {
          name: "the-assessor",
          permissionProfileId: profile.id,
        },
      );

      const refused = await parseRefusal(
        await del(arranged.harness.base, `/api/v1/profiles/${profile.id}`, arranged.token),
      );
      expect(refused.code).toBe("invalid_state");
      expect(refused.text).toContain("the-assessor");

      // Once the agent points at another profile, the profile it left can be
      // deleted.
      const patched = await updateAgent(arranged, agent.id, {
        permissionProfileId: (await readProfileNamed(arranged, "worker")).id,
      });
      expect(patched.status, await patched.clone().text()).toBe(200);
      const deleted = await del(
        arranged.harness.base,
        `/api/v1/profiles/${profile.id}`,
        arranged.token,
      );
      expect(deleted.status, await deleted.clone().text()).toBe(200);
    });
  });

  /**
   * The delete above prevents this state through the API, so the test removes
   * the profile row directly, the way a hand-edited database would.
   */
  it("rejects a spawn from an agent whose profile was deleted", async () => {
    await withFleet(async (arranged) => {
      const profile = await createProfile(arranged, "doomed", ["session.read"]);
      const agent = await createAgentForInstance(
        arranged,
        findInstanceId(arranged, "claude-provider"),
        {
          permissionProfileId: profile.id,
        },
      );
      await Effect.runPromise(
        Effect.provideService(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql`DELETE FROM permission_profiles WHERE name = 'doomed'`,
          ),
          SqlClient.SqlClient,
          arranged.harness.sql,
        ),
      );

      const refused = await parseRefusal(
        await post(
          arranged.harness.base,
          "/api/v1/sessions",
          { agentId: agent.id, prompt: "assess this" },
          arranged.token,
        ),
      );

      expect(refused.code).toBe("invalid_state");
      expect(refused.text).toContain(profile.id);
    });
  });
});

describe("an assistant seen through the agent operations", () => {
  const ASSISTANT_REFUSAL = "this agent is an assistant; use assistant.update or assistant.delete";
  const SPAWN_REFUSAL =
    "an assistant's sessions belong to its conversation; send it a message with conversation.send";

  /** Creates an assistant from a name alone. */
  const createAssistant = async (arranged: Arranged): Promise<Assistant> => {
    const response = await post(
      arranged.harness.base,
      "/api/v1/assistants",
      { name: "Ada" },
      arranged.token,
    );
    expect(response.ok, await response.clone().text()).toBe(true);
    return (await response.json()) as Assistant;
  };

  it("lists a plain agent and no assistant", async () => {
    await withFleet(async (arranged) => {
      await createAssistant(arranged);
      const plain = await createAgentForInstance(
        arranged,
        findInstanceId(arranged, "claude-provider"),
      );

      expect((await listAgents(arranged)).map((agent) => agent.id)).toEqual([plain.id]);
    });
  });

  it("reads an assistant's agent fields, and none of its assistant fields", async () => {
    await withFleet(async (arranged) => {
      const assistant = await createAssistant(arranged);

      const read = await readAgent(arranged, assistant.id);
      expect(read).toMatchObject({
        id: assistant.id,
        name: assistant.name,
        systemPrompt: assistant.systemPrompt,
        instanceId: assistant.instanceId,
        permissionProfileId: assistant.permissionProfileId,
        accessMode: assistant.accessMode,
        disallowedTools: assistant.disallowedTools,
      });
      expect(read).not.toHaveProperty("heartbeat");
      expect(read).not.toHaveProperty("rotation");
      expect(read).not.toHaveProperty("reply");
    });
  });

  it("refuses to update or delete an assistant, and points at the assistant operations", async () => {
    await withFleet(async (arranged) => {
      const assistant = await createAssistant(arranged);

      const updated = await readErrorBody(
        await updateAgent(arranged, assistant.id, { name: "Bea" }),
      );
      expect(updated.code, updated.text).toBe("invalid_state");
      expect(updated.message).toBe(ASSISTANT_REFUSAL);

      // The refusal comes before the fields are checked, so an edit that
      // would also be invalid still points at the assistant operations.
      const invalid = await readErrorBody(
        await updateAgent(arranged, assistant.id, { instanceId: NOBODY }),
      );
      expect(invalid.code, invalid.text).toBe("invalid_state");
      expect(invalid.message).toBe(ASSISTANT_REFUSAL);

      const deleted = await readErrorBody(
        await del(arranged.harness.base, `/api/v1/agents/${assistant.id}`, arranged.token),
      );
      expect(deleted.code, deleted.text).toBe("invalid_state");
      expect(deleted.message).toBe(ASSISTANT_REFUSAL);
    });
  });

  it("refuses to spawn a session from an assistant, and writes no session", async () => {
    await withFleet(async (arranged) => {
      const assistant = await createAssistant(arranged);

      const refused = await readErrorBody(
        await post(
          arranged.harness.base,
          "/api/v1/sessions",
          { agentId: assistant.id, prompt: "assess this" },
          arranged.token,
        ),
      );
      expect(refused.code, refused.text).toBe("invalid_state");
      expect(refused.message).toBe(SPAWN_REFUSAL);
      expect(await listSessions(arranged, "")).toEqual([]);
    });
  });
});
