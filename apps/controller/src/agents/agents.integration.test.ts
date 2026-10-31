/**
 * Tests the Agent over HTTP: the named, reusable configuration a session is
 * spawned from. The tests use the real API, with a real machine on the real
 * runner socket.
 *
 * A machine is needed for two of the assertions:
 *
 * - `unenforced` is read from the agent's harness definition.
 * - A delete must be rejected while a session spawned from the agent still
 *   runs.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Plugin, HarnessDefinition } from "@hercule/plugin-host";
import type { ModelDescriptor, RunnerFacts } from "@hercule/protocol";
import type { Agent as AgentRecord, Assistant, Session } from "@hercule/contract";
import { withTransaction } from "../db";
import { del, get, post, readErrorBody, send } from "../http/testing";
import { buildHarnessDefinition, buildPluginWithProviderPerHarness } from "../plugins/testing";
import {
  findProviderAccountId,
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

/** A harness that enforces a tool restriction natively, as Claude Code does. */
const CLAUDE: HarnessDefinition = buildHarnessDefinition("claude");

/** A harness that enforces a tool restriction natively, as pi does. */
const PI: HarnessDefinition = buildHarnessDefinition("pi");

/** A harness that stores a tool restriction but enforces none, as Codex does. */
const CODEX: HarnessDefinition = {
  ...buildHarnessDefinition("codex"),
  declared: {
    ...buildHarnessDefinition("codex").declared,
    disallowedTools: "unsupported",
  },
};

const buildPlugins = (): ReadonlyArray<Plugin> => [
  buildPluginWithProviderPerHarness("harnesses", [CLAUDE, CODEX, PI]),
];

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  harnesses: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["harnesses/claude", "harnesses/codex", "harnesses/pi"],
  identityPort: 4939,
};

const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", imageInput: { maxBytes: null }, isDefault: true, options: [] },
  { slug: "fast", name: "Fast", imageInput: { maxBytes: null }, options: [] },
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
const createAgentOnAccount = async (
  arranged: Arranged,
  providerAccountId: string,
  fields: Record<string, unknown> = {},
): Promise<AgentRecord> => {
  const profile = await readProfileNamed(arranged, "unrestricted");
  const response = await createAgent(arranged, {
    name: `agent-${crypto.randomUUID()}`,
    systemPrompt: "You assess tasks.",
    providerAccountId,
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
    harnessRefs: { nativeSessionId: `native-${session.id}` },
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
      const providerAccountId = findProviderAccountId(arranged, "harnesses/claude");
      const profile = await readProfileNamed(arranged, "unrestricted");

      const created = await createAgentOnAccount(arranged, providerAccountId);

      expect(created.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(created.systemPrompt).toBe("You assess tasks.");
      expect(created.providerAccountId).toBe(providerAccountId);
      // No harness named: its sessions run in the account's default harness.
      expect(created.harnessId).toBeNull();
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
      what: "an account that does not exist",
      fields: { providerAccountId: NOBODY },
      names: "providerAccountId",
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
        providerAccountId: findProviderAccountId(arranged, "harnesses/claude"),
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
      what: "an account that does not exist",
      fields: { providerAccountId: NOBODY },
      names: "providerAccountId",
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
      const agent = await createAgentOnAccount(
        arranged,
        findProviderAccountId(arranged, "harnesses/claude"),
      );

      const refused = await parseRefusal(await updateAgent(arranged, agent.id, fields));
      expect(refused.code).toBe("validation");
      expect(refused.text).toContain(names);
    });
  });

  it("rejects every call by an actor whose profile lacks the grant, and names the grant", async () => {
    await withFleet(async (arranged) => {
      const providerAccountId = findProviderAccountId(arranged, "harnesses/claude");
      const agent = await createAgentOnAccount(arranged, providerAccountId);
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
              providerAccountId,
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

describe("the harness an agent runs in", () => {
  it("stores a harness the account can run, and puts the agent back on the default with null", async () => {
    await withFleet(async (arranged) => {
      const providerAccountId = findProviderAccountId(arranged, "harnesses/claude");
      const created = await createAgentOnAccount(arranged, providerAccountId, {
        harnessId: "harnesses/claude",
      });
      expect(created.harnessId).toBe("harnesses/claude");

      const reset = await updateAgent(arranged, created.id, { harnessId: null });
      expect(reset.status, await reset.clone().text()).toBe(200);
      expect(((await reset.json()) as AgentRecord).harnessId).toBeNull();
    });
  });

  it("reports unenforced for the account's default harness when the agent names none", async () => {
    await withFleet(async (arranged) => {
      const created = await createAgentOnAccount(
        arranged,
        findProviderAccountId(arranged, "harnesses/codex"),
        { disallowedTools: ["edit"] },
      );

      expect(created.harnessId).toBeNull();
      expect(created.unenforced).toEqual(["disallowedTools"]);
    });
  });

  it("rejects a create that names a harness the account cannot run, and names harnessId", async () => {
    await withFleet(async (arranged) => {
      const profile = await readProfileNamed(arranged, "unrestricted");
      const refused = await parseRefusal(
        await createAgent(arranged, {
          name: "assessor",
          systemPrompt: "You assess tasks.",
          providerAccountId: findProviderAccountId(arranged, "harnesses/claude"),
          harnessId: "harnesses/codex",
          permissionProfileId: profile.id,
        }),
      );

      expect(refused.code).toBe("validation");
      expect(refused.text).toContain("harnessId");
    });
  });

  it("rejects moving an agent to an account that cannot run the harness it names, and keeps the agent as it was", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAgentOnAccount(
        arranged,
        findProviderAccountId(arranged, "harnesses/claude"),
        { harnessId: "harnesses/claude" },
      );

      const refused = await parseRefusal(
        await updateAgent(arranged, agent.id, {
          providerAccountId: findProviderAccountId(arranged, "harnesses/codex"),
          harnessId: "harnesses/claude",
        }),
      );

      expect(refused.code).toBe("validation");
      expect(refused.text).toContain("harnessId");
      expect(await readAgent(arranged, agent.id)).toEqual(agent);
    });
  });

  it("puts an agent on the new account's default harness when it moves and names no harness", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAgentOnAccount(
        arranged,
        findProviderAccountId(arranged, "harnesses/claude"),
        { harnessId: "harnesses/claude" },
      );

      const response = await updateAgent(arranged, agent.id, {
        providerAccountId: findProviderAccountId(arranged, "harnesses/codex"),
      });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ harnessId: null });
    });
  });

  it("moves an agent to another account when it names that account's harness too", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAgentOnAccount(
        arranged,
        findProviderAccountId(arranged, "harnesses/claude"),
        { harnessId: "harnesses/claude" },
      );
      const codexAccountId = findProviderAccountId(arranged, "harnesses/codex");

      const response = await updateAgent(arranged, agent.id, {
        providerAccountId: codexAccountId,
        harnessId: "harnesses/codex",
      });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        providerAccountId: codexAccountId,
        harnessId: "harnesses/codex",
      });
    });
  });
});

describe("what a harness declares it will not enforce", () => {
  it.each([
    {
      what: "a Codex agent with a restriction",
      harness: "harnesses/codex",
      tools: ["edit"],
      unenforced: ["disallowedTools"],
    },
    {
      what: "a Codex agent with no restriction",
      harness: "harnesses/codex",
      tools: [],
      unenforced: [],
    },
    {
      what: "a Claude Code agent with a restriction",
      harness: "harnesses/claude",
      tools: ["edit"],
      unenforced: [],
    },
    {
      what: "a pi agent with a restriction",
      harness: "harnesses/pi",
      tools: ["edit"],
      unenforced: [],
    },
  ])(
    "reports unenforced for $what, at create and at read",
    async ({ harness, tools, unenforced }) => {
      await withFleet(async (arranged) => {
        const created = await createAgentOnAccount(
          arranged,
          findProviderAccountId(arranged, harness),
          {
            disallowedTools: tools,
          },
        );

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
        const agent = await createAgentOnAccount(
          arranged,
          findProviderAccountId(arranged, "harnesses/claude"),
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
      const agent = await createAgentOnAccount(
        arranged,
        findProviderAccountId(arranged, "harnesses/claude"),
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
      const providerAccountId = findProviderAccountId(arranged, "harnesses/claude");
      const mine = await createAgentOnAccount(arranged, providerAccountId);
      const other = await createAgentOnAccount(arranged, providerAccountId);
      const ours = await spawnSessionFor(arranged, mine.id);
      const theirs = await spawnSessionFor(arranged, other.id);
      const thread = await spawnSessionOrFail(arranged, { prompt: "by hand" });

      expect((await listSessions(arranged, `agentId=${mine.id}`)).map((one) => one.id)).toEqual([
        ours.id,
      ]);
      expect((await listSessions(arranged, `agentId=${other.id}`)).map((one) => one.id)).toEqual([
        theirs.id,
      ]);
      expect((await listSessions(arranged, "kind=thread")).map((one) => one.id)).toEqual([
        thread.id,
      ]);
    });
  });

  it("rejects a listing that names an agent and also asks for the kind thread", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAgentOnAccount(
        arranged,
        findProviderAccountId(arranged, "harnesses/claude"),
      );

      const response = await get(
        arranged.harness.base,
        `/api/v1/sessions?agentId=${agent.id}&kind=thread`,
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
      const agent = await createAgentOnAccount(
        arranged,
        findProviderAccountId(arranged, "harnesses/claude"),
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
      const agent = await createAgentOnAccount(
        arranged,
        findProviderAccountId(arranged, "harnesses/claude"),
        {
          permissionProfileId: profile.id,
        },
      );
      await Effect.runPromise(
        Effect.provideService(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            withTransaction(sql, sql`DELETE FROM permission_profiles WHERE name = 'doomed'`),
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
      const plain = await createAgentOnAccount(
        arranged,
        findProviderAccountId(arranged, "harnesses/claude"),
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
        providerAccountId: assistant.providerAccountId,
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
        await updateAgent(arranged, assistant.id, { providerAccountId: NOBODY }),
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

describe("a profile that holds a grant only the user gives", () => {
  /**
   * A workflow's agent step runs with its Agent's profile, with no check
   * against the session that made the Agent. So a session that could put an
   * Agent or an assistant on the shipped `assistant` profile, which holds
   * `skill.write`, could pass on a grant only the user gives.
   */
  const REFUSAL =
    /^Only the user puts an Agent or an assistant on a profile that holds `skill\.write` or `skill\.apply`/;

  const createAssistantAs = (
    arranged: Arranged,
    fields: Record<string, unknown>,
    token: string,
  ): Promise<Response> => post(arranged.harness.base, "/api/v1/assistants", fields, token);

  const updateAssistantAs = (
    arranged: Arranged,
    id: string,
    fields: Record<string, unknown>,
    token: string,
  ): Promise<Response> =>
    send("PATCH", arranged.harness.base, `/api/v1/assistants/${id}`, { body: fields, token });

  it("refuses a session that puts an Agent or an assistant on it, and changes nothing", async () => {
    await withFleet(async (arranged) => {
      const providerAccountId = findProviderAccountId(arranged, "harnesses/claude");
      const assistantProfile = await readProfileNamed(arranged, "assistant");
      const worker = await readProfileNamed(arranged, "worker");
      const agent = await createAgentOnAccount(arranged, providerAccountId);
      const assistantResponse = await createAssistantAs(
        arranged,
        { name: "Ada", permissionProfileId: worker.id },
        arranged.token,
      );
      expect(assistantResponse.status, await assistantResponse.clone().text()).toBe(200);
      const assistant = (await assistantResponse.json()) as Assistant;
      const { token } = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "unrestricted"),
      );

      const calls: ReadonlyArray<readonly [string, Promise<Response>]> = [
        [
          "agent.create",
          createAgent(
            arranged,
            {
              name: "borrower",
              systemPrompt: "x",
              providerAccountId,
              permissionProfileId: assistantProfile.id,
            },
            token,
          ),
        ],
        [
          "agent.update",
          updateAgent(arranged, agent.id, { permissionProfileId: assistantProfile.id }, token),
        ],
        [
          "assistant.create naming the profile",
          createAssistantAs(
            arranged,
            { name: "Bea", permissionProfileId: assistantProfile.id },
            token,
          ),
        ],
        // With no profile named, an assistant gets the shipped `assistant` profile.
        [
          "assistant.create on the default profile",
          createAssistantAs(arranged, { name: "Cy" }, token),
        ],
        [
          "assistant.update",
          updateAssistantAs(
            arranged,
            assistant.id,
            { permissionProfileId: assistantProfile.id },
            token,
          ),
        ],
      ];
      for (const [operation, pending] of calls) {
        const refused = await readErrorBody(await pending);
        expect(refused.code, `${operation}: ${refused.text}`).toBe("forbidden");
        expect(refused.grant, operation).toBe("agent.write");
        expect(refused.message, operation).toMatch(REFUSAL);
      }

      expect((await readAgent(arranged, agent.id)).permissionProfileId).toBe(
        agent.permissionProfileId,
      );
      expect((await readAgent(arranged, assistant.id)).permissionProfileId).toBe(worker.id);
      expect((await listAgents(arranged)).map((one) => one.id)).toEqual([agent.id]);
    });
  });

  it("lets a session name a profile without them, and lets the user name any profile", async () => {
    await withFleet(async (arranged) => {
      const providerAccountId = findProviderAccountId(arranged, "harnesses/claude");
      const assistantProfile = await readProfileNamed(arranged, "assistant");
      const worker = await readProfileNamed(arranged, "worker");
      const { token } = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "unrestricted"),
      );
      const fields = { name: "assessor", systemPrompt: "x", providerAccountId };

      const calls: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
        [
          "a session's agent.create",
          () => createAgent(arranged, { ...fields, permissionProfileId: worker.id }, token),
        ],
        [
          "a session's assistant.create",
          () => createAssistantAs(arranged, { name: "Ada", permissionProfileId: worker.id }, token),
        ],
        [
          "the user's agent.create",
          () => createAgent(arranged, { ...fields, permissionProfileId: assistantProfile.id }),
        ],
        [
          "the user's assistant.create",
          () => createAssistantAs(arranged, { name: "Bea" }, arranged.token),
        ],
      ];
      const created: Array<string> = [];
      for (const [operation, call] of calls) {
        const response = await call();
        expect(response.status, `${operation}: ${await response.clone().text()}`).toBe(200);
        created.push(((await response.json()) as { readonly id: string }).id);
      }
      const [sessionAgent, sessionAssistant, userAgent, userAssistant] = created as [
        string,
        string,
        string,
        string,
      ];

      const updates: ReadonlyArray<readonly [string, Promise<Response>]> = [
        [
          "a session's agent.update",
          updateAgent(arranged, userAgent, { permissionProfileId: worker.id }, token),
        ],
        [
          "a session's assistant.update",
          updateAssistantAs(arranged, userAssistant, { permissionProfileId: worker.id }, token),
        ],
        [
          "the user's agent.update",
          updateAgent(arranged, sessionAgent, { permissionProfileId: assistantProfile.id }),
        ],
        [
          "the user's assistant.update",
          updateAssistantAs(
            arranged,
            sessionAssistant,
            { permissionProfileId: assistantProfile.id },
            arranged.token,
          ),
        ],
      ];
      for (const [operation, pending] of updates) {
        const response = await pending;
        expect(response.status, `${operation}: ${await response.clone().text()}`).toBe(200);
      }
    });
  });
});
