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
import * as SqlClient from "effect/sql/SqlClient";
import type { Session } from "@hercule/contract";
import type { Plugin, HarnessDefinition } from "@hercule/plugin-host";
import {
  MAX_OUTPUT_SCHEMA_LENGTH,
  type ModelDescriptor,
  type RunnerFacts,
  type SessionStart,
  type TextGenerationOutcome,
  type TextGenerationRequest,
} from "@hercule/protocol";
import { nowIso, uuidFromString, withTransaction } from "../../db";
import { del, get, post, send } from "../../http/testing";
import {
  buildHarnessDefinition,
  buildPluginWithProviderPerHarness,
  createPluginFixture,
} from "../../plugins/testing";
import { providerAccountRepository } from "../../provider-accounts";
import {
  spawnThreadUnder,
  findProviderAccountId,
  listFrames,
  listInputs,
  readProfileNamed,
  createProfile,
  readSession,
  readSessionToken,
  reportEvent,
  spawnSession,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  at,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../../sessions/testing";
import {
  createGithubConnection,
  createRepo,
  githubPlugin,
  GITHUB_PAT,
  listFramesTagged,
  provisionWorkspaceOrFail,
  readWorkspace,
  reportWorkspaceReady,
  type Frame,
} from "../../workspaces/testing";

/** A harness that supports everything natively, and is not the thread default. */
const ALPHA: HarnessDefinition = buildHarnessDefinition("alpha");

/** The harness the tests set as the thread default. */
const BETA: HarnessDefinition = buildHarnessDefinition("beta");

/** A harness that stores a tool restriction but does not enforce it, like Codex. */
const GAMMA: HarnessDefinition = {
  ...buildHarnessDefinition("gamma"),
  declared: {
    ...buildHarnessDefinition("gamma").declared,
    disallowedTools: "unsupported",
  },
};

/** What both multi-harness harnesses run: one provider's subscription, signed in on each machine. */
const MULTI_RUN = {
  providerId: "multi/multi",
  kinds: [{ kind: "subscription" }],
  modelArgument: "{model}",
  models: "all",
} as const;

/** The harness an account of the `multi` provider starts in. */
const DELTA = buildHarnessDefinition("delta", [MULTI_RUN]);

/** The harness an account of the `multi` provider runs in only when a call, an agent or a default names it. */
const EPSILON = buildHarnessDefinition("epsilon", [MULTI_RUN]);

const buildPlugins = (): ReadonlyArray<Plugin> => [
  buildPluginWithProviderPerHarness("harnesses", [ALPHA, BETA, GAMMA]),
  // One provider that two harnesses run, so one account can be placed in either.
  createPluginFixture({
    id: "multi",
    capabilities: ["harnesses", "providers"],
    definitions: [DELTA, EPSILON],
    providers: [
      {
        id: "multi",
        displayName: "Multi",
        kinds: [
          {
            id: "subscription",
            title: "Subscription",
            description: "A plan signed in on each machine.",
            setup: [{ kind: "harness-login", method: "sign-in" }],
            harnesses: ["multi/delta", "multi/epsilon"],
          },
        ],
        defaultHarnessId: "multi/delta",
        catalogSource: { kind: "harness-probe", harnessId: "multi/delta" },
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
  toolchains: [{ name: "git", version: "2.50.1", path: "/usr/bin/git" }],
  harnesses: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: [
    "harnesses/alpha",
    "harnesses/beta",
    "harnesses/gamma",
    "multi/delta",
    "multi/epsilon",
  ],
  identityPort: 4939,
};

/**
 * `clever` is the runner's default model. So in these tests `fast` can only
 * come from a setting or an Agent, and `swift` only from the spawn call.
 */
const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", imageInput: { maxBytes: null }, isDefault: true, options: [] },
  // The only model with an option, so tests can check that options stay with
  // their model when a call picks another model.
  {
    slug: "fast",
    name: "Fast",
    imageInput: { maxBytes: null },
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
  { slug: "swift", name: "Swift", imageInput: { maxBytes: null }, options: [] },
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
      const beta = findProviderAccountId(arranged, "harnesses/beta");
      const worker = await readProfileNamed(arranged, "worker");
      await setThreadDefaults(arranged, {
        "thread.providerAccountId": beta,
        "thread.model": "fast",
        "thread.accessMode": "auto",
        "thread.profileId": worker.id,
      });

      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });

      expect(session.providerAccountId).toBe(beta);
      expect(session.permissionProfileId).toBe(worker.id);
      expect(session.accessMode).toBe("auto");
      expect(session.modelSelection).toEqual({ model: "fast", options: {} });
      expect(await readStoredSpec(arranged, session.id)).toMatchObject({
        providerAccountId: beta,
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
        providerAccountId: session.providerAccountId,
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

/** Creates a project as the user and returns its id. */
const createProject = async (arranged: Arranged, name: string): Promise<string> => {
  const response = await post(arranged.harness.base, "/api/v1/projects", { name }, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly id: string }).id;
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
  ): Promise<{
    readonly id: string;
    readonly profileId: string;
    readonly providerAccountId: string;
  }> => {
    const profile = await readProfileNamed(arranged, "worker");
    const providerAccountId = findProviderAccountId(arranged, "harnesses/alpha");
    const agent = await createAgent(arranged, {
      name: `assessor-${crypto.randomUUID()}`,
      systemPrompt: "You assess tasks.",
      providerAccountId,
      permissionProfileId: profile.id,
      accessMode: "auto-accept-edits",
      model: "fast",
      disallowedTools: ["edit", "shell"],
      ...fields,
    });
    return { id: agent.id, profileId: profile.id, providerAccountId };
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
      expect(session.providerAccountId).toBe(agent.providerAccountId);
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

  it("uses the call's model and access mode over the agent's, without the agent's options, which belong to the agent's model", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, { model: "fast", options: { effort: "high" } });

      const session = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "assess this",
        model: "swift",
        accessMode: "full-access",
      });

      expect(session.requestedAccessMode).toBe("full-access");
      // An option belongs to the model that offers it. Keeping `effort` for a
      // model that does not declare it would run the session with a value
      // nobody chose for that model.
      expect(session.modelSelection).toEqual({ model: "swift", options: {} });
    });
  });

  it("falls back to the account's default model and to full-access when the agent sets neither", async () => {
    await withFleet(async (arranged) => {
      // Set, but must not be used: an Agent replaces the thread defaults, so
      // using them here would run the agent's session with a value nobody
      // set on the agent.
      await setThreadDefaults(arranged, { "thread.model": "fast" });
      const bare = await createAgent(arranged, {
        name: `bare-${crypto.randomUUID()}`,
        systemPrompt: "You assess tasks.",
        providerAccountId: findProviderAccountId(arranged, "harnesses/alpha"),
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

  it.each(["providerAccountId", "harnessId", "permissionProfileId"])(
    "refuses a spawn that names %s beside the agent it comes from",
    async (field) => {
      await withFleet(async (arranged) => {
        const agent = await createAssessor(arranged);
        const value =
          field === "providerAccountId"
            ? agent.providerAccountId
            : field === "harnessId"
              ? "harnesses/alpha"
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
          providerAccountId: findProviderAccountId(arranged, "harnesses/beta"),
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

  it("lists on the session the spec fields the harness does not enforce", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAssessor(arranged, {
        providerAccountId: findProviderAccountId(arranged, "harnesses/gamma"),
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

describe("the harness a session is placed in", () => {
  const DELTA_ID = "multi/delta";
  const EPSILON_ID = "multi/epsilon";

  /** Asks the controller to probe an account in a harness on the fleet's runner, which the fake runner answers as signed in. */
  const probeProviderAccount = async (
    arranged: Arranged,
    providerAccountId: string,
    harnessId?: string,
  ): Promise<void> => {
    const response = await post(
      arranged.harness.base,
      `/api/v1/runners/${arranged.runnerId}/probe`,
      { providerAccountId, ...(harnessId === undefined ? {} : { harnessId }) },
      arranged.token,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };

  /**
   * Runs `body` with three accounts of the `multi` provider: `first` starts
   * in delta, `epsilonAccount` in epsilon, and `second` (labelled) in delta.
   * Every account is signed in on the runner in its default harness, and
   * `first` also in epsilon.
   */
  const withMulti = (
    body: (
      arranged: Arranged,
      accounts: { first: string; epsilonAccount: string; second: string },
    ) => Promise<void>,
  ): Promise<void> =>
    withFleet(async (arranged) => {
      const first = findProviderAccountId(arranged, DELTA_ID);
      const epsilonAccount = findProviderAccountId(arranged, EPSILON_ID);
      const inserted = await arranged.harness.runWithLiveSessions(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const accounts = yield* providerAccountRepository;
          return yield* withTransaction(
            sql,
            accounts.insert({
              providerId: "multi/multi",
              kind: "subscription",
              label: "second",
              defaultHarnessId: DELTA_ID,
              at: yield* nowIso,
            }),
          );
        }),
      );
      if (inserted._tag !== "Success") throw new Error("the second account was not inserted");
      const second = inserted.value.id;
      await probeProviderAccount(arranged, second);
      await probeProviderAccount(arranged, first, EPSILON_ID);
      await body(arranged, { first, epsilonAccount, second });
    });

  /** Spawns a Thread as the user, failing the test if it is refused. */
  const spawnThread = (arranged: Arranged, fields: Record<string, unknown>) =>
    spawnSessionOrFail(arranged, { prompt: "hello", ...fields });

  it("stores the account's default harness when nothing names one", async () => {
    await withMulti(async (arranged, { first, epsilonAccount }) => {
      const delta = await spawnThread(arranged, { providerAccountId: first });
      const epsilon = await spawnThread(arranged, { providerAccountId: epsilonAccount });

      expect(delta.harnessId).toBe(DELTA_ID);
      expect(epsilon.harnessId).toBe(EPSILON_ID);
      const [start] = await waitForStartFrames(arranged, epsilon.id, 1);
      expect(start!.harnessId).toBe(EPSILON_ID);
    });
  });

  it("takes the harness of the call over every default", async () => {
    await withMulti(async (arranged, { first }) => {
      await setThreadDefaults(arranged, {
        "thread.providerAccountId": first,
        "thread.harnessId": DELTA_ID,
      });

      const session = await spawnThread(arranged, { harnessId: EPSILON_ID });

      expect(session.providerAccountId).toBe(first);
      expect(session.harnessId).toBe(EPSILON_ID);
    });
  });

  it("takes the user's thread.harnessId when the Thread runs on the thread default's account, and the account's default harness on another", async () => {
    await withMulti(async (arranged, { first, second }) => {
      await setThreadDefaults(arranged, {
        "thread.providerAccountId": first,
        "thread.harnessId": EPSILON_ID,
      });

      const onDefaultAccount = await spawnThread(arranged, {});
      const onOtherAccount = await spawnThread(arranged, { providerAccountId: second });

      expect(onDefaultAccount).toMatchObject({ providerAccountId: first, harnessId: EPSILON_ID });
      // A harness default belongs to its account: the other account is placed
      // in its own default, never in a harness nobody chose for it.
      expect(onOtherAccount).toMatchObject({ providerAccountId: second, harnessId: DELTA_ID });
    });
  });

  it("takes the caller's harness for a session's spawn on the caller's account, and the account's default on another", async () => {
    await withMulti(async (arranged, { first, second }) => {
      const caller = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "thread-starter", ["session.spawn", "thread.start"]),
        { providerAccountId: first, harnessId: EPSILON_ID },
      );
      const spawnAs = async (fields: Record<string, unknown>): Promise<Session> => {
        const response = await post(
          arranged.harness.base,
          "/api/v1/sessions",
          { prompt: "a job for you", ...fields },
          caller.token,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        return (await response.json()) as Session;
      };

      expect(await spawnAs({})).toMatchObject({ providerAccountId: first, harnessId: EPSILON_ID });
      expect(await spawnAs({ providerAccountId: second })).toMatchObject({
        providerAccountId: second,
        harnessId: DELTA_ID,
      });
      expect(await spawnAs({ harnessId: DELTA_ID })).toMatchObject({
        providerAccountId: first,
        harnessId: DELTA_ID,
      });
    });
  });

  it("takes the agent's harness, or the account's default when the agent names none", async () => {
    await withMulti(async (arranged, { first }) => {
      const profile = await readProfileNamed(arranged, "worker");
      const inEpsilon = await createAgent(arranged, {
        name: "in-epsilon",
        systemPrompt: "You assess tasks.",
        providerAccountId: first,
        harnessId: EPSILON_ID,
        permissionProfileId: profile.id,
      });
      const inDefault = await createAgent(arranged, {
        name: "in-default",
        systemPrompt: "You assess tasks.",
        providerAccountId: first,
        permissionProfileId: profile.id,
      });

      const epsilon = await spawnThread(arranged, { agentId: inEpsilon.id });
      const delta = await spawnThread(arranged, { agentId: inDefault.id });

      expect(epsilon.harnessId).toBe(EPSILON_ID);
      expect(delta.harnessId).toBe(DELTA_ID);
    });
  });

  it("refuses a harness the account's provider does not allow, and says which", async () => {
    await withMulti(async (arranged, { first }) => {
      const response = await spawnSession(arranged, {
        prompt: "hello",
        providerAccountId: first,
        harnessId: "harnesses/alpha",
      });

      expect(response.status, await response.clone().text()).toBe(400);
      const refused = await parseRefusal(response);
      expect(refused.code).toBe("validation");
      expect(refused.text).toContain("harnessId");
    });
  });

  it("refuses a harness the account is not signed in to on any runner, as it refuses an account that is not signed in", async () => {
    await withMulti(async (arranged, { epsilonAccount }) => {
      // A probe in the harness shows a runner signed out of it, as when the
      // user signed out of that harness on the machine.
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            arranged.harness.sql,
            arranged.harness.sql`
              UPDATE capability_snapshots SET auth_status = 'unauthenticated'
              WHERE provider_account_id = ${uuidFromString(epsilonAccount)}
                AND harness_id = ${DELTA_ID}`,
          ),
        ),
      );
      const response = await spawnSession(arranged, {
        prompt: "hello",
        providerAccountId: epsilonAccount,
        harnessId: DELTA_ID,
      });

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).toContain("signed in");
    });
  });

  it("checks a model's options against the snapshot of the account in the chosen harness", async () => {
    await withMulti(async (arranged, { first }) => {
      const response = await spawnSession(arranged, {
        prompt: "hello",
        providerAccountId: first,
        harnessId: EPSILON_ID,
        model: "fast",
        options: { effort: "medium" },
      });

      expect(response.status, await response.clone().text()).toBe(400);
      expect((await parseRefusal(response)).code).toBe("validation");
    });
  });

  it("applies the thread default's model only on its own account and harness, and takes the runner's default model on any other", async () => {
    await withMulti(async (arranged, { first, second }) => {
      await setThreadDefaults(arranged, {
        "thread.providerAccountId": first,
        "thread.model": "fast",
      });

      const onDefaults = await spawnThread(arranged, {});
      // The default harness named outright is still the default's harness.
      const onDefaultHarness = await spawnThread(arranged, { harnessId: DELTA_ID });
      const onOtherAccount = await spawnThread(arranged, { providerAccountId: second });
      const onOtherHarness = await spawnThread(arranged, { harnessId: EPSILON_ID });

      expect(onDefaults.modelSelection.model).toBe("fast");
      expect(onDefaultHarness.modelSelection.model).toBe("fast");
      expect(onOtherAccount.modelSelection.model).toBe("clever");
      expect(onOtherHarness.modelSelection.model).toBe("clever");
    });
  });

  it("applies a saved thread.model when thread.providerAccountId was never saved", async () => {
    await withMulti(async (arranged) => {
      // Settings > Threads saves only the model when the user leaves the
      // prefilled account unchanged.
      await setThreadDefaults(arranged, { "thread.model": "fast" });

      const thread = await spawnThread(arranged, {});

      expect(thread.modelSelection.model).toBe("fast");
    });
  });

  it("ignores a thread default whose account no longer exists, and places the Thread by the next rule", async () => {
    await withMulti(async (arranged, { second }) => {
      await setThreadDefaults(arranged, {
        "thread.providerAccountId": second,
        "thread.harnessId": DELTA_ID,
        "thread.model": "fast",
      });
      await Effect.runPromise(
        withTransaction(
          arranged.harness.sql,
          arranged.harness.sql`DELETE FROM provider_accounts WHERE id = ${uuidFromString(second)}`,
        ).pipe(Effect.orDie),
      );

      const response = await spawnSession(arranged, { prompt: "hello" });

      expect(response.status, await response.clone().text()).toBe(200);
      const thread = (await response.json()) as Session;
      expect(thread.providerAccountId).not.toBe(second);
      // The model chosen for the deleted account does not follow the Thread.
      expect(thread.modelSelection.model).toBe("clever");
    });
  });
});

describe("placeSession for a session that starts a Thread", () => {
  /** Spawns as the session holding `token`, with `fields` beside a prompt. */
  const spawnAs = (arranged: Arranged, token: string, fields: Record<string, unknown> = {}) =>
    post(arranged.harness.base, "/api/v1/sessions", { prompt: "a job for you", ...fields }, token);

  /** Spawns as the session and returns the new Thread, failing the test if the spawn fails. */
  const spawnThreadAs = async (
    arranged: Arranged,
    token: string,
    fields: Record<string, unknown> = {},
  ): Promise<Session> => {
    const response = await spawnAs(arranged, token, fields);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Session;
  };

  /**
   * Starts the session that will call `session.spawn`: a Thread on a profile
   * that may start Threads, running with `fields`. The values are none of
   * the defaults, so a copy of them cannot be mistaken for a default.
   */
  const startCaller = async (arranged: Arranged, fields: Record<string, unknown> = {}) =>
    spawnThreadUnder(
      arranged,
      await createProfile(arranged, "thread-starter", ["session.spawn", "thread.start"]),
      {
        providerAccountId: findProviderAccountId(arranged, "harnesses/alpha"),
        model: "fast",
        options: { effort: "high" },
        accessMode: "auto-accept-edits",
        ...fields,
      },
    );

  it("copies the caller's model and options when the Thread runs on the caller's account", async () => {
    await withFleet(async (arranged) => {
      const caller = await startCaller(arranged);
      const alpha = findProviderAccountId(arranged, "harnesses/alpha");

      const implicit = await spawnThreadAs(arranged, caller.token);
      const explicit = await spawnThreadAs(arranged, caller.token, { providerAccountId: alpha });

      for (const thread of [implicit, explicit]) {
        expect(thread.providerAccountId).toBe(alpha);
        expect(thread.modelSelection).toEqual({ model: "fast", options: { effort: "high" } });
      }
    });
  });

  it("takes the other account's default model when the Thread runs on another account", async () => {
    await withFleet(async (arranged) => {
      const caller = await startCaller(arranged);
      const beta = findProviderAccountId(arranged, "harnesses/beta");

      const thread = await spawnThreadAs(arranged, caller.token, { providerAccountId: beta });

      // A model belongs to its account in its harness, and options to their model, so the
      // caller's `fast` and `effort` are not carried over.
      expect(thread.providerAccountId).toBe(beta);
      expect(thread.modelSelection).toEqual({ model: "clever", options: {} });
    });
  });

  it("uses exactly the model and options the call names", async () => {
    await withFleet(async (arranged) => {
      const caller = await startCaller(arranged);

      const both = await spawnThreadAs(arranged, caller.token, {
        model: "fast",
        options: { effort: "low" },
      });
      const modelOnly = await spawnThreadAs(arranged, caller.token, { model: "swift" });

      expect(both.modelSelection).toEqual({ model: "fast", options: { effort: "low" } });
      // The caller's options belong to the caller's model, not to `swift`.
      expect(modelOnly.modelSelection).toEqual({ model: "swift", options: {} });
    });
  });

  it("ignores the user's thread settings and takes the caller's values", async () => {
    await withFleet(async (arranged) => {
      const caller = await startCaller(arranged);
      await setThreadDefaults(arranged, {
        "thread.providerAccountId": findProviderAccountId(arranged, "harnesses/beta"),
        "thread.model": "swift",
        "thread.accessMode": "full-access",
        "thread.profileId": (await readProfileNamed(arranged, "worker")).id,
      });

      const thread = await spawnThreadAs(arranged, caller.token);

      expect(thread).toMatchObject({
        providerAccountId: caller.session.providerAccountId,
        permissionProfileId: caller.session.permissionProfileId,
        requestedAccessMode: "auto-accept-edits",
        modelSelection: { model: "fast", options: { effort: "high" } },
      });
    });
  });

  it("pushes as the caller's GitHub Connection, not the user's default", async () => {
    await sharedWithFleet(
      async (arranged) => {
        const callers = await createGithubConnection(arranged, { pat: GITHUB_PAT });
        const usersDefault = await createGithubConnection(arranged, { pat: "ghp_another-token" });
        await setThreadDefaults(arranged, { "github.defaultConnectionId": callers });
        const caller = await startCaller(arranged);
        await setThreadDefaults(arranged, { "github.defaultConnectionId": usersDefault });

        const thread = await spawnThreadAs(arranged, caller.token);

        const [start] = await waitForStartFrames(arranged, thread.id, 1);
        expect((start as unknown as Frame)["ghToken"]).toBe(GITHUB_PAT);
      },
      { plugins: [...buildPlugins(), githubPlugin], facts: FACTS, models: MODELS },
    );
  });

  it("files the Thread under the caller's project, and under another project when the call names one", async () => {
    await withFleet(async (arranged) => {
      const inherited = await createProject(arranged, "Bun upgrade");
      const named = await createProject(arranged, "Docs");
      const caller = await startCaller(arranged, { projectId: inherited });

      expect((await spawnThreadAs(arranged, caller.token)).projectId).toBe(inherited);
      expect((await spawnThreadAs(arranged, caller.token, { projectId: named })).projectId).toBe(
        named,
      );
    });
  });

  it("files the Thread under no project when the caller's project was deleted since", async () => {
    await withFleet(async (arranged) => {
      const gone = await createProject(arranged, "Old project");
      const caller = await startCaller(arranged, { projectId: gone });
      const deleted = await del(arranged.harness.base, `/api/v1/projects/${gone}`, arranged.token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);

      const thread = await spawnThreadAs(arranged, caller.token);

      expect(thread.projectId).toBeNull();
    });
  });

  it("copies none of an Agent caller's own spec into the Thread", async () => {
    await withFleet(async (arranged) => {
      const agent = await createAgent(arranged, {
        name: `starter-${crypto.randomUUID()}`,
        systemPrompt: "You start Threads.",
        providerAccountId: findProviderAccountId(arranged, "harnesses/alpha"),
        permissionProfileId: (
          await createProfile(arranged, "agent-thread-starter", ["session.spawn", "thread.start"])
        ).id,
        disallowedTools: ["edit"],
      });
      const caller = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "go",
        outputSchema: SCHEMA,
      });
      const [callerStart] = await waitForStartFrames(arranged, caller.id, 1);
      // The caller runs with all three, so their absence below is not a default.
      expect(callerStart!.spec.systemPrompt).toBe("You start Threads.");
      expect(callerStart!.spec.disallowedTools).toEqual(["edit"]);
      expect(callerStart!.spec.outputSchema).toEqual(SCHEMA);
      const token = readSessionToken(callerStart!);

      const thread = await spawnThreadAs(arranged, token);

      // The prompt, the tool limits and the output schema belong to the
      // Agent's job, not to a Thread that the job starts.
      expect(thread.agentId).toBeNull();
      const spec = await readStartedSpec(arranged, thread.id);
      expect(spec["systemPrompt"]).toBeUndefined();
      expect(spec["disallowedTools"]).toBeUndefined();
      expect(spec["outputSchema"]).toBeUndefined();
    });
  });
});

describe("placeSession for a session's spawn: where it runs", () => {
  /**
   * Starts the calling session on the fleet's first runner: a Thread on a
   * profile that may start Threads and spawn, with `fields` beside it.
   */
  const startCaller = async (arranged: Arranged, fields: Record<string, unknown> = {}) =>
    spawnThreadUnder(
      arranged,
      await createProfile(arranged, `caller-${crypto.randomUUID()}`, [
        "session.spawn",
        "thread.start",
      ]),
      { runnerId: arranged.runnerId, ...fields },
    );

  /** Spawns as the session holding `token` and returns the response. */
  const spawnAs = (arranged: Arranged, token: string, fields: Record<string, unknown> = {}) =>
    post(arranged.harness.base, "/api/v1/sessions", { prompt: "review this", ...fields }, token);

  /** Spawns as the session and returns the new session, failing the test if the spawn fails. */
  const spawnAsOrFail = async (
    arranged: Arranged,
    token: string,
    fields: Record<string, unknown> = {},
  ): Promise<Session> => {
    const response = await spawnAs(arranged, token, fields);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Session;
  };

  /** Creates an Agent on a profile with no grants, which any session may spawn from. */
  const createReviewer = async (arranged: Arranged): Promise<string> =>
    (
      await createAgent(arranged, {
        name: `reviewer-${crypto.randomUUID()}`,
        systemPrompt: "You review changes.",
        providerAccountId: findProviderAccountId(arranged, "harnesses/alpha"),
        permissionProfileId: (await createProfile(arranged, `reviewer-${crypto.randomUUID()}`, []))
          .id,
      })
    ).id;

  /** Provisions a workspace of a new repo on the fleet's first runner and reports it ready. */
  const provisionReadyWorkspace = async (arranged: Arranged): Promise<string> => {
    const web = await createRepo(arranged, `https://github.com/acme/web-${crypto.randomUUID()}`);
    const workspace = await provisionWorkspaceOrFail(arranged, {
      resourceId: web,
      runnerId: arranged.runnerId,
    });
    return (await reportWorkspaceReady(arranged, workspace.id)).id;
  };

  it("runs on the caller's runner, a reserved one too, where placement would choose another", async () => {
    await withFleet(async (arranged) => {
      const second = await arranged.enlist();
      const caller = await startCaller(arranged);
      // `reserved` is set directly on the row, because `runner.update` does not
      // allow reserving the fleet's default runner, and the first runner is
      // the default.
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            arranged.harness.sql,
            arranged.harness.sql`
            UPDATE runners SET reserved = 1
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
          ),
        ),
      );

      // The user's spawn is placed: the reserved runner is skipped.
      expect((await spawnSessionOrFail(arranged, { prompt: "hello" })).runnerId).toBe(
        second.runnerId,
      );
      // The session's spawns follow it, whether a Thread or from an Agent.
      const thread = await spawnAsOrFail(arranged, caller.token);
      const fromAgent = await spawnAsOrFail(arranged, caller.token, {
        agentId: await createReviewer(arranged),
      });
      for (const spawned of [thread, fromAgent]) {
        expect(spawned.runnerId).toBe(arranged.runnerId);
        expect(spawned.workspaceId).toBeNull();
      }
    });
  });

  it("joins the caller's workspace when the call names neither a workspace nor another runner", async () => {
    await withFleet(async (arranged) => {
      const workspaceId = await provisionReadyWorkspace(arranged);
      const caller = await startCaller(arranged, { workspace: { kind: "existing", workspaceId } });

      const implicit = await spawnAsOrFail(arranged, caller.token);
      const sameRunner = await spawnAsOrFail(arranged, caller.token, {
        runnerId: arranged.runnerId,
      });
      const fromAgent = await spawnAsOrFail(arranged, caller.token, {
        agentId: await createReviewer(arranged),
      });

      for (const spawned of [implicit, sameRunner, fromAgent]) {
        expect(spawned.runnerId).toBe(arranged.runnerId);
        expect(spawned.workspaceId).toBe(workspaceId);
      }
      // Joining the caller's workspace provisions nothing new.
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(1);
    });
  });

  it("leaves the caller's workspace when the call names another workspace or another runner", async () => {
    await withFleet(async (arranged) => {
      const second = await arranged.enlist();
      const workspaceId = await provisionReadyWorkspace(arranged);
      const caller = await startCaller(arranged, { workspace: { kind: "existing", workspaceId } });
      const docs = await createRepo(arranged, "https://github.com/acme/docs");

      const ownWorkspace = await spawnAsOrFail(arranged, caller.token, {
        workspace: buildEphemeralWorkspace(docs),
      });
      const otherRunner = await spawnAsOrFail(arranged, caller.token, {
        runnerId: second.runnerId,
      });

      // A new workspace the call asks for is made on the caller's runner.
      expect(ownWorkspace.runnerId).toBe(arranged.runnerId);
      expect(ownWorkspace.workspaceId).not.toBeNull();
      expect(ownWorkspace.workspaceId).not.toBe(workspaceId);
      // Another runner cannot reach the caller's files, so it gets none.
      expect(otherRunner.runnerId).toBe(second.runnerId);
      expect(otherRunner.workspaceId).toBeNull();
    });
  });

  it("refuses when the caller's runner is draining, and says how to choose another", async () => {
    await withFleet(async (arranged) => {
      const second = await arranged.enlist();
      const caller = await startCaller(arranged);
      const drained = await post(
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/drain`,
        {},
        arranged.token,
      );
      expect(drained.status, await drained.clone().text()).toBe(200);

      const refused = await spawnAs(arranged, caller.token);

      expect(refused.status).toBe(409);
      const { code, text } = await parseRefusal(refused);
      expect(code).toBe("invalid_state");
      expect(text).toContain("draining");
      expect(text).toContain("send runnerId");
      expect(
        (await spawnAsOrFail(arranged, caller.token, { runnerId: second.runnerId })).runnerId,
      ).toBe(second.runnerId);
    });
  });
});

/** Spawns a session, lets it start, then ends it with a native id, so it can be forked. */
const spawnAndEnd = async (arranged: Arranged, body: unknown): Promise<Session> => {
  const session = await spawnSessionOrFail(arranged, body);
  await waitForStartFrames(arranged, session.id, 1);
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
  return await waitForSession(arranged, session.id, (one) => one.status === "exited");
};

/** Forks a session, with a `dedupKey` when given. */
const fork = (
  arranged: Arranged,
  parentId: string,
  prompt: string,
  dedupKey?: string,
): Promise<Response> =>
  post(
    arranged.harness.base,
    `/api/v1/sessions/${parentId}/continue`,
    { mode: "fork", prompt, ...(dedupKey === undefined ? {} : { dedupKey }) },
    arranged.token,
  );

/** Reads the stored `needs_refinement` of a session: null when no title was generated. */
const readNeedsRefinement = async (
  arranged: Arranged,
  id: string,
): Promise<number | null | undefined> => {
  const [row] = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ readonly needs_refinement: number | null }>`
        SELECT needs_refinement FROM sessions WHERE id = unhex(replace(${id}, '-', ''))`,
    ),
  );
  return row?.needs_refinement;
};

describe("placeSession generates a Thread title", () => {
  /** Runs `body` with the fake runner answering every text generation with `answer`, or never answering when it is undefined. */
  const withTitles = (
    answer: TextGenerationOutcome | undefined,
    body: (
      arranged: Arranged,
      requests: () => ReadonlyArray<TextGenerationRequest>,
    ) => Promise<void>,
  ): Promise<void> =>
    sharedWithFleet(
      async (arranged) => {
        arranged.wire.setTextGenerationAnswer(() => answer);
        // None of the fixture harnesses is one `automatic` tries, so the
        // Thread title runs on the account the test chooses.
        const chosen = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
          body: {
            controller: {
              "textGeneration.model": {
                providerAccountId: findProviderAccountId(arranged, "harnesses/alpha"),
                model: "clever",
              },
            },
          },
          token: arranged.token,
        });
        expect(chosen.status, await chosen.clone().text()).toBe(200);
        await body(arranged, () =>
          listFrames<TextGenerationRequest>(arranged.wire, "textGenerationRequest"),
        );
      },
      { plugins: buildPlugins(), facts: FACTS, models: MODELS },
    );

  const answers: TextGenerationOutcome = {
    outcome: "ok",
    value: { title: "Fix the login redirect", needsRefinement: true, role: "fix" },
    usage: null,
  };

  it("replaces the cut-short title with the generated title and role, asking once", async () => {
    await withTitles(answers, async (arranged, requests) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "login redirect is broken" });

      expect(session.title).toBe("login redirect is broken");
      expect(session.role).toBeNull();
      const generated = await waitForSession(
        arranged,
        session.id,
        (one) => one.title === "Fix the login redirect" && one.role !== null,
      );
      expect(generated.role).toBe("fix");
      expect(await readNeedsRefinement(arranged, session.id)).toBe(1);
      expect(requests()).toHaveLength(1);
      // The role is asked for as a required string with no length limit.
      const schema = requests()[0]?.spec.outputSchema as {
        readonly required: ReadonlyArray<string>;
        readonly properties: Record<string, Record<string, unknown>>;
      };
      expect(schema.required).toContain("role");
      expect(schema.properties.role).toEqual({ type: "string" });
    });
  });

  it("keeps the role spawn gave, and still generates the title", async () => {
    await withTitles(answers, async (arranged) => {
      const session = await spawnSessionOrFail(arranged, {
        prompt: "login redirect is broken",
        role: "review",
      });

      expect(session.role).toBe("review");
      const renamed = await waitForSession(
        arranged,
        session.id,
        (one) => one.title === "Fix the login redirect",
      );
      expect(renamed.role).toBe("review");
      expect((await readSession(arranged, session.id)).role).toBe("review");
    });
  });

  it("answers a spawn with an invalid role with a validation error on the role", async () => {
    await withTitles(answers, async (arranged) => {
      const refused = await parseRefusal(
        await spawnSession(arranged, { prompt: "hello", role: " " }),
      );

      expect(refused.code).toBe("validation");
      expect(refused.text).toContain("role");
    });
  });

  it("sends the first message only, cut to 4000 characters", async () => {
    await withTitles(answers, async (arranged, requests) => {
      const prompt = `${"a".repeat(3990)}\nsecond line ${"b".repeat(2000)}`;

      await spawnSessionOrFail(arranged, { prompt });

      await waitUntil("asked for a title", () => (requests().length > 0 ? true : undefined));
      expect(requests()).toHaveLength(1);
      expect(requests()[0]?.spec.input).toBe(prompt.slice(0, 4000));
      expect(requests()[0]?.spec.instructions).not.toContain("a".repeat(20));
    });
  });

  it("asks for no title for an agent's session or a message with no text", async () => {
    await withTitles(answers, async (arranged, requests) => {
      const profile = await readProfileNamed(arranged, "worker");
      const agent = await createAgent(arranged, {
        name: "titleless",
        systemPrompt: "You assess tasks.",
        providerAccountId: findProviderAccountId(arranged, "harnesses/alpha"),
        permissionProfileId: profile.id,
        accessMode: "auto-accept-edits",
        model: "fast",
      });
      await spawnSessionOrFail(arranged, { agentId: agent.id, prompt: "assess this" });
      await spawnSessionOrFail(arranged, { prompt: " \n " });

      // A Thread that does have text, spawned last: when its request has
      // arrived, the two spawns above had their chance to ask first.
      await spawnSessionOrFail(arranged, { prompt: "a real message" });
      await waitUntil("asked for a title", () => (requests().length > 0 ? true : undefined));
      expect(requests().map((request) => request.spec.input)).toEqual(["a real message"]);
    });
  });

  it("starts the turn at once while the title is still being generated", async () => {
    await withTitles(undefined, async (arranged, requests) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "slow title" });

      await waitForStartFrames(arranged, session.id, 1);
      await waitUntil("asked for a title", () => (requests().length > 0 ? true : undefined));
      const after = await readSession(arranged, session.id);
      expect(after.title).toBe("slow title");
      expect(await listInputs(arranged, session.id)).toHaveLength(1);
    });
  });

  it("keeps the cut-short title and starts the turn when the generation fails", async () => {
    await withTitles(
      { outcome: "failed", message: "the harness could not start" },
      async (arranged, requests) => {
        const session = await spawnSessionOrFail(arranged, { prompt: "title will fail" });

        await waitUntil("asked for a title", () => (requests().length > 0 ? true : undefined));
        await waitForStartFrames(arranged, session.id, 1);
        // Nothing happens after a failure, so there is nothing to wait for.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const after = await readSession(arranged, session.id);
        expect(after.title).toBe("title will fail");
        expect(await readNeedsRefinement(arranged, session.id)).toBeNull();
      },
    );
  });

  it("generates a title and a role for a fork of a Thread, and takes no role from its parent", async () => {
    await withTitles(answers, async (arranged, requests) => {
      const parent = await spawnAndEnd(arranged, { prompt: "start the work", role: "review" });
      await waitUntil("asked for the parent's title", () =>
        requests().length === 1 ? true : undefined,
      );

      const response = await fork(arranged, parent.id, "now do the tests");
      expect(response.status, await response.clone().text()).toBe(200);
      const child = (await response.json()) as Session;

      expect(child.role).toBeNull();
      const generated = await waitForSession(arranged, child.id, (one) => one.role !== null);
      expect(generated.role).toBe("fix");
      expect(generated.title).toBe("Fix the login redirect");
      expect(requests().map((request) => request.spec.input)).toEqual([
        "start the work",
        "now do the tests",
      ]);
      expect((await readSession(arranged, parent.id)).role).toBe("review");
    });
  });

  it("asks for no title or role for a fork of an agent's session", async () => {
    await withTitles(answers, async (arranged, requests) => {
      const profile = await readProfileNamed(arranged, "worker");
      const agent = await createAgent(arranged, {
        name: "forked",
        systemPrompt: "You assess tasks.",
        providerAccountId: findProviderAccountId(arranged, "harnesses/alpha"),
        permissionProfileId: profile.id,
        accessMode: "auto-accept-edits",
        model: "fast",
      });
      const parent = await spawnAndEnd(arranged, { agentId: agent.id, prompt: "assess this" });
      const response = await fork(arranged, parent.id, "assess it again");
      expect(response.status, await response.clone().text()).toBe(200);

      // A Thread spawned last: when its request has arrived, the fork above
      // had its chance to ask first.
      await spawnSessionOrFail(arranged, { prompt: "a real message" });
      await waitUntil("asked for a title", () => (requests().length > 0 ? true : undefined));
      expect(requests().map((request) => request.spec.input)).toEqual(["a real message"]);
    });
  });
});

describe("placeSession and continueSession with a dedupKey", () => {
  /** Counts the rows of a table, to prove a repeat wrote nothing. */
  const countRows = async (arranged: Arranged, table: "sessions" | "workspaces") => {
    const [row] = await Effect.runPromise(
      Effect.orDie(
        arranged.harness.sql<{
          readonly n: number;
        }>`SELECT COUNT(*) AS n FROM ${arranged.harness.sql(table)}`,
      ),
    );
    return row!.n;
  };

  /**
   * Starts a workspace-less session with no key and waits for its start
   * frame. The controller sends frames to a runner in order, so once this
   * one has arrived, a frame an earlier repeat wrongly sent would have too.
   */
  const waitForOrderedFrames = async (arranged: Arranged): Promise<void> => {
    const sentinel = await spawnSessionOrFail(arranged, { prompt: "sentinel" });
    await waitForStartFrames(arranged, sentinel.id, 1);
  };

  /** The ids of the sessions the runner was told to start, in order. */
  const listStartedSessionIds = (arranged: Arranged): ReadonlyArray<string> =>
    listFrames<SessionStart>(arranged.wire, "sessionStart").map((frame) => frame.sessionId);

  it("returns the first session of a repeated spawn and starts nothing", async () => {
    await withFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const first = await spawnSessionOrFail(arranged, {
        prompt: "build it",
        workspace: buildEphemeralWorkspace(web),
        dedupKey: "build-1",
      });
      await waitForProvisionFrame(arranged);
      const sessionsBefore = await countRows(arranged, "sessions");
      const workspacesBefore = await countRows(arranged, "workspaces");

      // Nothing but the key is compared: another prompt and no workspace.
      const repeat = await spawnSessionOrFail(arranged, {
        prompt: "something else",
        dedupKey: "build-1",
      });
      await waitForOrderedFrames(arranged);

      expect(repeat.id).toBe(first.id);
      // The +1 is the sentinel session of `waitForOrderedFrames`.
      expect(await countRows(arranged, "sessions")).toBe(sessionsBefore + 1);
      expect(await countRows(arranged, "workspaces")).toBe(workspacesBefore);
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(1);
      expect(listStartedSessionIds(arranged)).not.toContain(repeat.id);
      expect(await arranged.harness.audit("session.spawned")).toHaveLength(2);
    });
  });

  it("does real work for the same key from another actor, and keeps each actor's repeat apart", async () => {
    await withFleet(async (arranged) => {
      const caller = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "thread-starter", ["session.spawn", "thread.start"]),
      );
      const fromUser = await spawnSessionOrFail(arranged, { prompt: "a", dedupKey: "k" });

      const fromSession = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        { prompt: "a", dedupKey: "k" },
        caller.token,
      );
      expect(fromSession.status, await fromSession.clone().text()).toBe(200);
      const second = (await fromSession.json()) as Session;
      const repeated = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        { prompt: "a", dedupKey: "k" },
        caller.token,
      );
      expect(((await repeated.json()) as Session).id).toBe(second.id);

      expect(second.id).not.toBe(fromUser.id);
      expect(second.id).not.toBe(caller.session.id);
      expect((await spawnSessionOrFail(arranged, { prompt: "a", dedupKey: "k" })).id).toBe(
        fromUser.id,
      );
    });
  });

  it("returns an exited session as it is now, without resuming it", async () => {
    await withFleet(async (arranged) => {
      const first = await spawnAndEnd(arranged, { prompt: "work", dedupKey: "once" });

      const repeat = await spawnSessionOrFail(arranged, { prompt: "work", dedupKey: "once" });
      await waitForOrderedFrames(arranged);

      expect(repeat.id).toBe(first.id);
      expect(repeat.status).toBe("exited");
      expect(listStartedSessionIds(arranged).filter((id) => id === first.id)).toHaveLength(1);
      expect((await readSession(arranged, first.id)).status).toBe("exited");
    });
  });

  it("returns the first session of a repeat even when the call could no longer be placed", async () => {
    await withFleet(async (arranged) => {
      const profile = await readProfileNamed(arranged, "worker");
      const agent = await createAgent(arranged, {
        name: "short-lived",
        systemPrompt: "You assess tasks.",
        providerAccountId: findProviderAccountId(arranged, "harnesses/alpha"),
        permissionProfileId: profile.id,
      });
      const first = await spawnAndEnd(arranged, {
        agentId: agent.id,
        prompt: "assess",
        dedupKey: "assess-1",
      });
      const deleted = await del(
        arranged.harness.base,
        `/api/v1/agents/${agent.id}`,
        arranged.token,
      );
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      const withoutKey = await spawnSession(arranged, { agentId: agent.id, prompt: "assess" });
      expect(withoutKey.status).toBe(404);

      const repeat = await spawnSessionOrFail(arranged, {
        agentId: agent.id,
        prompt: "assess",
        dedupKey: "assess-1",
      });

      expect(repeat.id).toBe(first.id);
    });
  });

  it("returns the first fork of a repeated continue, and keeps spawn and continue keys apart", async () => {
    await withFleet(async (arranged) => {
      // The parent used the key "shared" for its spawn.
      const parent = await spawnAndEnd(arranged, { prompt: "start", dedupKey: "shared" });

      const response = await fork(arranged, parent.id, "go on", "shared");
      expect(response.status, await response.clone().text()).toBe(200);
      const child = (await response.json()) as Session;
      const sessionsBefore = await countRows(arranged, "sessions");
      const repeat = await fork(arranged, parent.id, "go on differently", "shared");
      const repeated = (await repeat.json()) as Session;
      await waitForOrderedFrames(arranged);

      expect(child.id).not.toBe(parent.id);
      expect(child.parentSessionId).toBe(parent.id);
      expect(repeated.id).toBe(child.id);
      // The +1 is the sentinel session of `waitForOrderedFrames`.
      expect(await countRows(arranged, "sessions")).toBe(sessionsBefore + 1);
      expect(listStartedSessionIds(arranged).filter((id) => id === child.id)).toHaveLength(1);
    });
  });
});
