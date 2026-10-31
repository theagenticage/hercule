/**
 * Tests the assistant over HTTP: its create, read, list and update operations,
 * the defaults the server fills in from a name alone, and the web conversation
 * every assistant gets, which its record names as its main conversation.
 *
 * The controller runs with three Provider Accounts, like a fresh install
 * with the three shipped harnesses, so the default account has a real choice
 * to make. Setup runs first, so the default assistant `Hercule` is always
 * there too.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { HarnessDefinition } from "@hercule/plugin-host";
import type { Assistant, Conversation, ProviderAccount } from "@hercule/contract";
import {
  completeSetup,
  get,
  post,
  readErrorBody,
  send,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { nowIso, uuidFromString, withTransaction } from "../db";
import { buildHarnessDefinition } from "../plugins/testing";
import { providerAccountRepository } from "../provider-accounts";
import { buildFleetPlugin } from "../sessions/testing";

/** Three harnesses, in the order the shipped plugin registry lists the harnesses. */
const HARNESSES: ReadonlyArray<HarnessDefinition> = [
  buildHarnessDefinition("claude"),
  buildHarnessDefinition("codex"),
  buildHarnessDefinition("pi"),
];

/** The system prompt an assistant gets when the create names none. */
const SYSTEM_PROMPT =
  "You are a personal assistant running inside the user's own controller. The user talks to you in a chat. Answer briefly and plainly. Prefer delegating work over doing it yourself: use the `hercule` CLI to read and create tasks, start workflows and check on sessions. Do not edit files yourself; delegate that work.";

/**
 * The standing heartbeat prompt every new assistant gets. The scheduler queues
 * it on the assistant's conversation at each heartbeat. Spec 12 §8.2 owns it.
 */
const HEARTBEAT_PROMPT =
  "This is a scheduled heartbeat, not a message from the user. Check what you are waiting on: runs you started, subscriptions you hold, tasks you own, reminders that are due. Do not invent work and do not repeat old tasks from earlier in this conversation. If nothing needs the user's attention, reply exactly `NO_REPLY`. Otherwise write only the message the user should read: what changed, what you propose, plus any small updates worth mentioning alongside it. If a decision is needed, create a notification so it reaches the user wherever they are.";

/** A time before any record a test creates. */
const LONG_AGO = "2000-01-01T00:00:00.000Z";

/** A well-formed id that matches no record. */
const NOBODY = "0199e0e7-9999-7000-8000-000000000000";

/** A running controller after setup, and the user's token. */
interface Arranged {
  readonly harness: ServerHarness;
  readonly token: string;
}

/**
 * Gives the controller an account for each harness after the first. The test
 * controller seeds one account for the first harness, so these are newer than
 * it, and the first harness's account is the oldest.
 */
const addAccountsForOtherHarnesses = (harness: ServerHarness): Promise<void> =>
  Effect.runPromise(
    Effect.orDie(
      withTransaction(
        harness.sql,
        Effect.gen(function* () {
          const accounts = yield* providerAccountRepository;
          for (const definition of HARNESSES.slice(1)) {
            yield* accounts.insert({
              providerId: `harnesses/${definition.id}`,
              kind: "subscription",
              label: null,
              defaultHarnessId: `harnesses/${definition.id}`,
              at: yield* nowIso,
            });
          }
        }).pipe(Effect.provideService(SqlClient.SqlClient, harness.sql)),
      ),
    ),
  );

/** Runs `body` against a controller with the three Provider Accounts, after setup. */
const withAssistants = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  withServer(
    async (harness) => {
      await addAccountsForOtherHarnesses(harness);
      const token = await completeSetup(harness.base);
      await body({ harness, token });
    },
    { plugins: [buildFleetPlugin("harnesses", HARNESSES)] },
  );

const requestCreate = (arranged: Arranged, fields: Record<string, unknown>): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/assistants", fields, arranged.token);

const requestUpdate = (
  arranged: Arranged,
  id: string,
  fields: Record<string, unknown>,
): Promise<Response> =>
  send("PATCH", arranged.harness.base, `/api/v1/assistants/${id}`, {
    body: fields,
    token: arranged.token,
  });

/** Creates an assistant and fails the test unless the create succeeds. */
const createAssistant = async (
  arranged: Arranged,
  fields: Record<string, unknown>,
): Promise<Assistant> => {
  const response = await requestCreate(arranged, fields);
  expect(response.ok, await response.clone().text()).toBe(true);
  return (await response.json()) as Assistant;
};

/** Reads an assistant and fails the test unless the read succeeds. */
const readAssistant = async (arranged: Arranged, id: string): Promise<Assistant> => {
  const response = await get(arranged.harness.base, `/api/v1/assistants/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Assistant;
};

/** Returns the first page of `assistant.query`, in its default order. */
const listAssistants = async (arranged: Arranged): Promise<ReadonlyArray<Assistant>> => {
  const response = await get(arranged.harness.base, "/api/v1/assistants", arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Assistant> }).items;
};

/** Returns the first page of `conversation.query` for one assistant. */
const listConversations = async (
  arranged: Arranged,
  assistantId: string,
): Promise<ReadonlyArray<Conversation>> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/conversations?assistantId=${assistantId}`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Conversation> }).items;
};

/** Returns every Provider Account, oldest first: by creation time, then by id. */
const listAccountsOldestFirst = async (
  arranged: Arranged,
): Promise<ReadonlyArray<ProviderAccount>> => {
  const response = await get(arranged.harness.base, "/api/v1/provider-accounts", arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  const accounts = (await response.json()) as ReadonlyArray<ProviderAccount>;
  expect(accounts).toHaveLength(HARNESSES.length);
  return [...accounts].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
};

/** Returns the id of the permission profile with this name. */
const findProfileId = async (arranged: Arranged, name: string): Promise<string> => {
  const response = await get(arranged.harness.base, "/api/v1/profiles", arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  const items = (
    (await response.json()) as {
      items: ReadonlyArray<{ id: string; name: string }>;
    }
  ).items;
  const found = items.find((profile) => profile.name === name);
  expect(found, name).toBeDefined();
  return found!.id;
};

describe("assistant.create", () => {
  it("fills every default from a name alone", async () => {
    await withAssistants(async (arranged) => {
      const [oldest] = await listAccountsOldestFirst(arranged);
      const profileId = await findProfileId(arranged, "assistant");

      const created = await createAssistant(arranged, { name: "Ada" });

      expect(created.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(created.name).toBe("Ada");
      expect(created.systemPrompt).toBe(SYSTEM_PROMPT);
      expect(created.providerAccountId).toBe(oldest!.id);
      expect(created.harnessId).toBeNull();
      expect(created.permissionProfileId).toBe(profileId);
      expect(created.accessMode).toBe("full-access");
      expect(created.model).toBeNull();
      expect(created.disallowedTools).toEqual(["edit"]);
      // `toStrictEqual`, so a `timezone` key with any value fails: no default
      // timezone is set on either.
      expect(created.heartbeat).toStrictEqual({
        enabled: true,
        schedule: "0 7-23 * * *",
        prompt: HEARTBEAT_PROMPT,
        target: "web",
      });
      expect(created.rotation).toStrictEqual({
        contextFraction: 0.7,
        maxContextTokens: 200000,
        dailyAt: "04:00",
      });
      expect(created.reply).toBe("turn-end");
      expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(created.updatedAt).toBe(created.createdAt);

      expect(await readAssistant(arranged, created.id)).toEqual(created);
    });
  });

  it("records the create in the audit log as the user", async () => {
    await withAssistants(async (arranged) => {
      const before = await arranged.harness.audit("assistant.created");

      await createAssistant(arranged, { name: "Ada" });

      const after = await arranged.harness.audit("assistant.created");
      expect(after).toHaveLength(before.length + 1);
      expect(after.at(-1)?.actor).toBe("user");
    });
  });

  it("creates exactly one web conversation for the new assistant, and names it as the main conversation", async () => {
    await withAssistants(async (arranged) => {
      const created = await createAssistant(arranged, { name: "Ada" });

      const conversations = await listConversations(arranged, created.id);
      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({
        assistantId: created.id,
        channel: "web",
        containerKey: null,
      });
      expect(created.mainConversationId).toBe(conversations[0]!.id);
      expect((await readAssistant(arranged, created.id)).mainConversationId).toBe(
        conversations[0]!.id,
      );
    });
  });

  it.each([
    { what: "an empty name", fields: { name: "" } },
    { what: "a name of 129 characters", fields: { name: "a".repeat(129) } },
    {
      what: "an account that does not exist",
      fields: { name: "Ada", providerAccountId: NOBODY },
    },
    {
      what: "a profile that does not exist",
      fields: { name: "Ada", permissionProfileId: NOBODY },
    },
    {
      what: "a heartbeat timezone the runtime does not know",
      fields: {
        name: "Ada",
        heartbeat: {
          enabled: true,
          schedule: "0 9 * * *",
          timezone: "Mars/Olympus",
          prompt: "Check in.",
          target: "web",
        },
      },
    },
    {
      what: "a rotation timezone the runtime does not know",
      fields: {
        name: "Ada",
        rotation: {
          contextFraction: 0.7,
          maxContextTokens: 200000,
          dailyAt: "04:00",
          timezone: "Mars/Olympus",
        },
      },
    },
  ])("rejects $what as a validation error", async ({ fields }) => {
    await withAssistants(async (arranged) => {
      const refused = await readErrorBody(await requestCreate(arranged, fields));
      expect(refused.code, refused.text).toBe("validation");
    });
  });

  it("rejects a harness the named account cannot run, and a harness with no account on the default account", async () => {
    await withAssistants(async (arranged) => {
      const [oldest, next] = await listAccountsOldestFirst(arranged);

      for (const fields of [
        { name: "Ada", providerAccountId: next!.id, harnessId: oldest!.defaultHarnessId },
        // The default account is the oldest, which cannot run the next one's harness.
        { name: "Ada", harnessId: next!.defaultHarnessId },
      ]) {
        const refused = await readErrorBody(await requestCreate(arranged, fields));
        expect(refused.code, refused.text).toBe("validation");
        expect(refused.text).toContain("harnessId");
      }
    });
  });

  it("stores the harness it is created with", async () => {
    await withAssistants(async (arranged) => {
      const [, next] = await listAccountsOldestFirst(arranged);

      const created = await createAssistant(arranged, {
        name: "Ada",
        providerAccountId: next!.id,
        harnessId: next!.defaultHarnessId,
      });

      expect(created.providerAccountId).toBe(next!.id);
      expect(created.harnessId).toBe(next!.defaultHarnessId);
    });
  });

  it("skips an account whose default harness this build no longer carries when it picks the default", async () => {
    await withAssistants(async (arranged) => {
      const [oldest, next] = await listAccountsOldestFirst(arranged);
      // A row left behind by a harness plugin that was removed: no session
      // could start on it, so the default must not be this account.
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            arranged.harness.sql,
            arranged.harness.sql`UPDATE provider_accounts SET default_harness_id = 'retired/retired'
                               WHERE id = ${uuidFromString(oldest!.id)}`,
          ),
        ),
      );

      const created = await createAssistant(arranged, { name: "Ada" });
      expect(created.providerAccountId).toBe(next!.id);
    });
  });

  it("fails with invalid_state when there is no provider account to default to", async () => {
    await withAssistants(async (arranged) => {
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            arranged.harness.sql,
            arranged.harness.sql`DELETE FROM provider_accounts`,
          ),
        ),
      );

      const response = await requestCreate(arranged, { name: "Ada" });
      expect(response.status).toBe(409);
      const refused = await readErrorBody(response);
      expect(refused.code, refused.text).toBe("invalid_state");
      expect(refused.message).toContain("this version cannot add one yet");
      expect((await listAssistants(arranged)).map((assistant) => assistant.name)).toEqual([
        "Hercule",
      ]);
    });
  });

  it("fails with invalid_state when the shipped assistant profile was renamed, and never picks a user's profile of that name", async () => {
    await withAssistants(async (arranged) => {
      const shipped = await findProfileId(arranged, "assistant");
      const renamed = await send("PATCH", arranged.harness.base, `/api/v1/profiles/${shipped}`, {
        body: { name: "helper" },
        token: arranged.token,
      });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
      const impostor = await post(
        arranged.harness.base,
        "/api/v1/profiles",
        { name: "assistant", grants: ["task.read"] },
        arranged.token,
      );
      expect(impostor.status, await impostor.clone().text()).toBe(200);

      const response = await requestCreate(arranged, { name: "Ada" });
      expect(response.status).toBe(409);
      const refused = await readErrorBody(response);
      expect(refused.code, refused.text).toBe("invalid_state");
      expect(refused.message).toContain("permissionProfileId");

      // Naming a profile still works while the shipped one is gone.
      const named = await createAssistant(arranged, { name: "Ada", permissionProfileId: shipped });
      expect(named.permissionProfileId).toBe(shipped);
    });
  });
});

describe("assistant.update", () => {
  /** A heartbeat and a rotation that differ from the defaults in every field. */
  const HEARTBEAT = {
    enabled: false,
    schedule: "0 9 * * 1-5",
    timezone: "Europe/Amsterdam",
    prompt: "Check on the runs you started.",
    target: "web",
  };
  const ROTATION = {
    contextFraction: 0.5,
    maxContextTokens: 100000,
    dailyAt: "05:30",
    timezone: "Europe/Amsterdam",
  };

  it.each([
    {
      what: "a name and a reply mode",
      build: () => Promise.resolve({ name: "Bea", reply: "segments" }),
    },
    {
      what: "every field it takes",
      build: async (arranged: Arranged) => {
        const accounts = await listAccountsOldestFirst(arranged);
        return {
          name: "Bea",
          systemPrompt: "You keep an eye on the builds.",
          providerAccountId: accounts.at(-1)!.id,
          permissionProfileId: await findProfileId(arranged, "unrestricted"),
          accessMode: "auto",
          reply: "segments",
          heartbeat: HEARTBEAT,
          rotation: ROTATION,
        };
      },
    },
  ])(
    "with $what changes only those fields, moves updatedAt and audits the changed keys",
    async ({ build }) => {
      await withAssistants(async (arranged) => {
        const created = await createAssistant(arranged, { name: "Ada" });
        const fields: Record<string, unknown> = await build(arranged);
        // Timestamps have millisecond precision, so the update could land in
        // the same millisecond as the create. The agent row, which holds the
        // assistant's updatedAt, is moved into the past instead of waiting,
        // because the controller runs on a real listener that no test clock
        // can drive.
        await Effect.runPromise(
          Effect.orDie(
            withTransaction(
              arranged.harness.sql,
              arranged.harness.sql`UPDATE agents SET updated_at = ${LONG_AGO}
                                 WHERE id = ${uuidFromString(created.id)}`,
            ),
          ),
        );

        const response = await requestUpdate(arranged, created.id, fields);
        expect(response.status, await response.clone().text()).toBe(200);
        const updated = (await response.json()) as Assistant;

        const { updatedAt, ...rest } = updated;
        const { updatedAt: createdUpdatedAt, ...createdRest } = created;
        expect(rest).toEqual({ ...createdRest, ...fields });
        expect(updatedAt).not.toBe(LONG_AGO);
        expect(Date.parse(updatedAt)).toBeGreaterThanOrEqual(Date.parse(createdUpdatedAt));
        expect(await readAssistant(arranged, created.id)).toEqual(updated);

        const audited = await arranged.harness.audit("assistant.updated");
        expect(audited).toHaveLength(1);
        expect(audited[0]!.actor).toBe("user");
        expect(audited[0]!.payload.changed).toEqual(Object.keys(fields).sort());
      });
    },
  );

  it.each([
    { what: "a reply mode that does not exist", fields: { reply: "never" } },
    {
      what: "a heartbeat schedule that is not a cron expression",
      fields: { heartbeat: { ...HEARTBEAT, schedule: "nope" } },
    },
    {
      what: "a heartbeat timezone the runtime does not know",
      fields: { heartbeat: { ...HEARTBEAT, timezone: "Mars/Olympus" } },
    },
    {
      what: "a rotation timezone the runtime does not know",
      fields: { rotation: { ...ROTATION, timezone: "Mars/Olympus" } },
    },
  ])("rejects $what as a validation error", async ({ fields }) => {
    await withAssistants(async (arranged) => {
      const created = await createAssistant(arranged, { name: "Ada" });

      const refused = await readErrorBody(await requestUpdate(arranged, created.id, fields));
      expect(refused.code, refused.text).toBe("validation");
    });
  });

  it("refuses a harness the account cannot run, and an account that cannot run the harness it names", async () => {
    await withAssistants(async (arranged) => {
      const [oldest, next] = await listAccountsOldestFirst(arranged);
      const created = await createAssistant(arranged, {
        name: "Ada",
        providerAccountId: oldest!.id,
        harnessId: oldest!.defaultHarnessId,
      });

      for (const fields of [
        { harnessId: next!.defaultHarnessId },
        { providerAccountId: next!.id, harnessId: oldest!.defaultHarnessId },
      ]) {
        const refused = await readErrorBody(await requestUpdate(arranged, created.id, fields));
        expect(refused.code, refused.text).toBe("validation");
        expect(refused.text).toContain("harnessId");
      }
      expect(await readAssistant(arranged, created.id)).toEqual(created);

      // Moving without naming a harness puts the assistant on the new
      // account's default harness.
      const moved = await requestUpdate(arranged, created.id, { providerAccountId: next!.id });
      expect(moved.status, await moved.clone().text()).toBe(200);
      expect(await moved.json()).toMatchObject({ providerAccountId: next!.id, harnessId: null });
    });
  });

  it("keeps a saved zone the runtime does not know editable, and refuses a new one", async () => {
    await withAssistants(async (arranged) => {
      const created = await createAssistant(arranged, { name: "Ada" });
      // A zone saved before the controller checked zones.
      const legacy = { ...HEARTBEAT, timezone: "Mars/Olympus" };
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            arranged.harness.sql,
            arranged.harness.sql`UPDATE assistants SET heartbeat = ${JSON.stringify(legacy)}
                               WHERE agent_id = ${uuidFromString(created.id)}`,
          ),
        ),
      );

      const kept = await requestUpdate(arranged, created.id, {
        heartbeat: { ...legacy, prompt: "Only write when it matters." },
      });
      expect(kept.status, await kept.clone().text()).toBe(200);
      expect(((await kept.json()) as Assistant).heartbeat.prompt).toBe(
        "Only write when it matters.",
      );

      const moved = await requestUpdate(arranged, created.id, {
        heartbeat: { ...legacy, timezone: "Venus/Maxwell" },
      });
      expect((await readErrorBody(moved)).code).toBe("validation");
    });
  });

  it("updates an id that names no assistant as not_found, before it checks the fields", async () => {
    await withAssistants(async (arranged) => {
      for (const fields of [{ name: "Bea" }, { providerAccountId: NOBODY }]) {
        const response = await requestUpdate(arranged, NOBODY, fields);
        expect(response.status).toBe(404);
        expect((await readErrorBody(response)).code).toBe("not_found");
      }
    });
  });
});

describe("assistant.query and assistant.read", () => {
  it("lists every assistant, oldest first", async () => {
    await withAssistants(async (arranged) => {
      const ada = await createAssistant(arranged, { name: "Ada" });
      const bea = await createAssistant(arranged, { name: "Bea" });

      const listed = await listAssistants(arranged);
      // Setup made `Hercule` before either of these.
      expect(listed.map((assistant) => assistant.name)).toEqual(["Hercule", "Ada", "Bea"]);
      expect(listed.slice(1)).toEqual([ada, bea]);
    });
  });

  it("names each listed assistant's own web conversation as its main conversation", async () => {
    await withAssistants(async (arranged) => {
      await createAssistant(arranged, { name: "Ada" });
      await createAssistant(arranged, { name: "Bea" });

      const listed = await listAssistants(arranged);
      expect(listed).toHaveLength(3);
      for (const assistant of listed) {
        const [web] = await listConversations(arranged, assistant.id);
        expect(assistant.mainConversationId, assistant.name).toBe(web!.id);
      }
    });
  });

  it("reads an id that names no assistant as not_found", async () => {
    await withAssistants(async (arranged) => {
      // The route exists and reads a real assistant, so the not_found below
      // is about the id rather than about a missing route.
      const [hercule] = await listAssistants(arranged);
      expect((await readAssistant(arranged, hercule!.id)).name).toBe("Hercule");

      const response = await get(
        arranged.harness.base,
        `/api/v1/assistants/${NOBODY}`,
        arranged.token,
      );
      expect(response.status).toBe(404);
      expect((await readErrorBody(response)).code).toBe("not_found");
    });
  });

  it("reads a plain agent's id as not_found, because a plain agent is not an assistant", async () => {
    await withAssistants(async (arranged) => {
      const [account] = await listAccountsOldestFirst(arranged);
      const agent = await post(
        arranged.harness.base,
        "/api/v1/agents",
        {
          name: "reviewer",
          systemPrompt: "Review the change.",
          providerAccountId: account!.id,
          permissionProfileId: await findProfileId(arranged, "unrestricted"),
        },
        arranged.token,
      );
      expect(agent.status, await agent.clone().text()).toBe(200);
      const { id } = (await agent.json()) as { id: string };

      const response = await get(arranged.harness.base, `/api/v1/assistants/${id}`, arranged.token);
      expect(response.status).toBe(404);
      expect((await readErrorBody(response)).code).toBe("not_found");
    });
  });
});

describe("conversation.read", () => {
  it("reads an id that names no conversation as not_found", async () => {
    await withAssistants(async (arranged) => {
      // The route exists and reads a real conversation, so the not_found
      // below is about the id rather than about a missing route.
      const [hercule] = await listAssistants(arranged);
      const [conversation] = await listConversations(arranged, hercule!.id);
      const found = await get(
        arranged.harness.base,
        `/api/v1/conversations/${conversation!.id}`,
        arranged.token,
      );
      expect(found.status, await found.clone().text()).toBe(200);

      const response = await get(
        arranged.harness.base,
        `/api/v1/conversations/${NOBODY}`,
        arranged.token,
      );
      expect(response.status).toBe(404);
      expect((await readErrorBody(response)).code).toBe("not_found");
    });
  });
});
