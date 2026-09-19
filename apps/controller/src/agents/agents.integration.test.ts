/**
 * The Agent over HTTP: the named, reusable configuration a session is spawned
 * from, through the real API with a real machine on the real runner socket.
 *
 * The machine is here because two of the things asserted need one: what a
 * provider says it can enforce (`unenforced` is read off the instance's
 * definition) and what a session referencing an agent does to a delete.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Plugin, ProviderDefinition } from "@hydra/plugin-host";
import type { ModelDescriptor, RunnerFacts } from "@hydra/protocol";
import type { Agent as AgentRecord, Session } from "@hydra/contract";
import { del, get, post, send } from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";
import {
  agentOn,
  at,
  profileNamed,
  profileOf,
  report,
  sessionWhen,
  spawned,
  startFrames,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../sessions/testing";

/** A provider that enforces a tool restriction natively, as Claude Code does. */
const CLAUDE: ProviderDefinition = providerDefinition("claude-provider", { token: "t" });

/** The same, as pi does. */
const PI: ProviderDefinition = providerDefinition("pi-provider", { token: "t" });

/** The one that stores a tool restriction and enforces nothing, as Codex does. */
const CODEX: ProviderDefinition = {
  ...providerDefinition("codex-provider", { token: "t" }),
  declared: {
    ...providerDefinition("codex-provider").declared,
    disallowedTools: "unsupported",
  },
};

const registry = (): ReadonlyArray<Plugin> => [
  fixture({ id: "providers", definitions: [CLAUDE, CODEX, PI] }).plugin,
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
  { slug: "clever", name: "Clever", isDefault: true, options: [] },
  { slug: "fast", name: "Fast", options: [] },
];

/**
 * Three, because the longest case here waits for the fleet to be probed, then
 * for a session to start, and then for it to exit.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, { plugins: registry(), facts: FACTS, models: MODELS });

/** An id shaped the way every Hydra id is, that nothing holds. */
const NOBODY = "0199e0e7-9999-7000-8000-000000000000";

const instanceOf = (arranged: Arranged, providerId: string): string => {
  const found = arranged.instances.find((instance) => instance.providerId === providerId);
  expect(found, providerId).toBeDefined();
  return found!.id;
};

/** One refusal, as the code it carries, the grant it names, and its whole text. */
interface Refusal {
  readonly code: string;
  readonly grant?: string;
  /** Everything the error said, for asserting which field or entry it named. */
  readonly text: string;
}

const refusal = async (response: Response): Promise<Refusal> => {
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

/** An agent, created the way every case here creates one: the four required fields. */
const agentFor = async (
  arranged: Arranged,
  instanceId: string,
  fields: Record<string, unknown> = {},
): Promise<AgentRecord> => {
  const profile = await profileNamed(arranged, "unrestricted");
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

const sessionsListed = async (
  arranged: Arranged,
  query: string,
): Promise<ReadonlyArray<Session>> => {
  const response = await get(arranged.harness.base, `/api/v1/sessions?${query}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Session> }).items;
};

/** A session spawned from an agent, driven to the status the case is about. */
const sessionFrom = async (arranged: Arranged, agentId: string): Promise<Session> =>
  spawned(arranged, { agentId, prompt: "assess this" });

const started = async (arranged: Arranged, session: Session): Promise<void> => {
  await startFrames(arranged, session.id, 1);
  report(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
    providerRefs: { nativeSessionId: `native-${session.id}` },
  });
  await sessionWhen(arranged, session.id, (one) => one.status === "idle");
};

const busy = async (arranged: Arranged, session: Session): Promise<void> => {
  await started(arranged, session);
  report(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "turn.started",
    turnId: "t1",
  });
  await sessionWhen(arranged, session.id, (one) => one.status === "busy");
};

const exited = async (arranged: Arranged, session: Session, seq: number): Promise<void> => {
  report(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });
  await sessionWhen(arranged, session.id, (one) => one.status === "exited");
};

describe("the agent over its five operations", () => {
  it("is created with the defaults a background identity gets, reads and lists the same way, takes an update, and is gone after a delete", async () => {
    await withFleet(async (arranged) => {
      const instanceId = instanceOf(arranged, "claude-provider");
      const profile = await profileNamed(arranged, "unrestricted");

      const created = await agentFor(arranged, instanceId);

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
      // Two fields on the call, one selection on the record: the choices
      // belong to the model named beside them.
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
      expect((await refusal(gone)).code).toBe("not_found");
      expect(await listAgents(arranged)).toEqual([]);
    });
  });

  it.each([
    { what: "an instance nobody holds", fields: { instanceId: NOBODY }, names: "instanceId" },
    {
      what: "a profile nobody holds",
      fields: { permissionProfileId: NOBODY },
      names: "permissionProfileId",
    },
    {
      what: "a tool family outside the five",
      fields: { disallowedTools: ["browse"] },
      names: "browse",
    },
    {
      what: "options with no model beside them",
      fields: { options: { effort: "high" } },
      names: "options",
    },
  ])("refuses a create naming $what, saying which", async ({ fields, names }) => {
    await withFleet(async (arranged) => {
      const profile = await profileNamed(arranged, "unrestricted");
      const response = await createAgent(arranged, {
        name: "assessor",
        systemPrompt: "You assess tasks.",
        instanceId: instanceOf(arranged, "claude-provider"),
        permissionProfileId: profile.id,
        ...fields,
      });

      const refused = await refusal(response);
      expect(refused.code).toBe("validation");
      expect(refused.text).toContain(names);
    });
  });

  it.each([
    { what: "an instance nobody holds", fields: { instanceId: NOBODY }, names: "instanceId" },
    {
      what: "a profile nobody holds",
      fields: { permissionProfileId: NOBODY },
      names: "permissionProfileId",
    },
    {
      what: "a tool family outside the five",
      fields: { disallowedTools: ["browse"] },
      names: "browse",
    },
    {
      what: "options with no model beside them",
      fields: { options: { effort: "high" } },
      names: "options",
    },
  ])("refuses an update naming $what, saying which", async ({ fields, names }) => {
    await withFleet(async (arranged) => {
      const agent = await agentFor(arranged, instanceOf(arranged, "claude-provider"));

      const refused = await refusal(await updateAgent(arranged, agent.id, fields));
      expect(refused.code).toBe("validation");
      expect(refused.text).toContain(names);
    });
  });

  it("refuses every call by an actor the profile never gave the grant to, naming it", async () => {
    await withFleet(async (arranged) => {
      const instanceId = instanceOf(arranged, "claude-provider");
      const agent = await agentFor(arranged, instanceId);
      const profile = await profileNamed(arranged, "unrestricted");
      const { token } = await agentOn(
        arranged,
        await profileOf(arranged, "no-agents", ["task.read"]),
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
        const refused = await refusal(response);
        expect(refused.code, operation).toBe("forbidden");
        expect(refused.grant, operation).toBe(grant);
      }
    });
  });
});

describe("what a provider says it will not enforce", () => {
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
  ])("says so on $what, at create and at read", async ({ provider, tools, unenforced }) => {
    await withFleet(async (arranged) => {
      const created = await agentFor(arranged, instanceOf(arranged, provider), {
        disallowedTools: tools,
      });

      expect(created.unenforced).toEqual(unenforced);
      expect((await readAgent(arranged, created.id)).unenforced).toEqual(unenforced);
    });
  });
});

describe("deleting an agent a session still points at", () => {
  it.each(["starting", "idle", "busy"])(
    "is refused while a session is %s, naming the session",
    async (status) => {
      await withFleet(async (arranged) => {
        const agent = await agentFor(arranged, instanceOf(arranged, "claude-provider"));
        const session = await sessionFrom(arranged, agent.id);
        if (status === "starting") await startFrames(arranged, session.id, 1);
        if (status === "idle") await started(arranged, session);
        if (status === "busy") await busy(arranged, session);
        await sessionWhen(arranged, session.id, (one) => one.status === status);

        const refused = await refusal(
          await del(arranged.harness.base, `/api/v1/agents/${agent.id}`, arranged.token),
        );

        expect(refused.code).toBe("invalid_state");
        expect(refused.text).toContain(session.id);
      });
    },
  );

  it("succeeds once every session it spawned has exited, and those sessions keep its id", async () => {
    await withFleet(async (arranged) => {
      const agent = await agentFor(arranged, instanceOf(arranged, "claude-provider"));
      const session = await sessionFrom(arranged, agent.id);
      await started(arranged, session);
      await exited(arranged, session, 2);

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
  it("answers one agent's sessions by its id, and only the threads for a thread listing", async () => {
    await withFleet(async (arranged) => {
      const instanceId = instanceOf(arranged, "claude-provider");
      const mine = await agentFor(arranged, instanceId);
      const other = await agentFor(arranged, instanceId);
      const ours = await sessionFrom(arranged, mine.id);
      const theirs = await sessionFrom(arranged, other.id);
      const thread = await spawned(arranged, { prompt: "by hand" });

      expect((await sessionsListed(arranged, `agentId=${mine.id}`)).map((one) => one.id)).toEqual([
        ours.id,
      ]);
      expect((await sessionsListed(arranged, `agentId=${other.id}`)).map((one) => one.id)).toEqual([
        theirs.id,
      ]);
      expect((await sessionsListed(arranged, "thread=true")).map((one) => one.id)).toEqual([
        thread.id,
      ]);
    });
  });

  it("refuses a listing that names an agent and asks for threads at once", async () => {
    await withFleet(async (arranged) => {
      const agent = await agentFor(arranged, instanceOf(arranged, "claude-provider"));

      const response = await get(
        arranged.harness.base,
        `/api/v1/sessions?agentId=${agent.id}&thread=true`,
        arranged.token,
      );

      expect(response.status).toBe(400);
      const refused = await refusal(response);
      expect(refused.code).toBe("validation");
      expect(refused.text).toContain("thread");
    });
  });
});

describe("the permission profile an agent spawns under", () => {
  it("refuses to delete a profile an agent names, saying which agent", async () => {
    await withFleet(async (arranged) => {
      const profile = await profileOf(arranged, "assessors", ["session.read"]);
      const agent = await agentFor(arranged, instanceOf(arranged, "claude-provider"), {
        name: "the-assessor",
        permissionProfileId: profile.id,
      });

      const refused = await refusal(
        await del(arranged.harness.base, `/api/v1/profiles/${profile.id}`, arranged.token),
      );
      expect(refused.code).toBe("invalid_state");
      expect(refused.text).toContain("the-assessor");

      // Pointed at another profile, the row it no longer names can go.
      const patched = await updateAgent(arranged, agent.id, {
        permissionProfileId: (await profileNamed(arranged, "worker")).id,
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
   * The delete above is what keeps this from happening through the API, so the
   * row is taken out underneath the agent the way a hand-edited database would.
   */
  it("refuses a spawn from an agent whose profile is gone", async () => {
    await withFleet(async (arranged) => {
      const profile = await profileOf(arranged, "doomed", ["session.read"]);
      const agent = await agentFor(arranged, instanceOf(arranged, "claude-provider"), {
        permissionProfileId: profile.id,
      });
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

      const refused = await refusal(
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
