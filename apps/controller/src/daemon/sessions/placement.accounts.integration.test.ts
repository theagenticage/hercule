/**
 * Tests where a session on each kind of Provider Account can be placed: a key
 * account and a valid token account run on every runner that has the harness,
 * with no snapshot at all, an expired token and a missing key run nowhere, and
 * a subscription signed in on each machine runs only where a probe shows it
 * signed in. The tests use the real API and a fake runner on the real socket.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { HarnessDefinition, Plugin } from "@hercule/plugin-host";
import type { ModelDescriptor, RunnerFacts } from "@hercule/protocol";
import { nowIso, uuidFromString, withTransaction } from "../../db";
import { buildHarnessDefinition, createPluginFixture } from "../../plugins/testing";
import { providerAccountRepository } from "../../provider-accounts";
import { buildProviderAccountOwner } from "../../secrets";
import {
  findProviderAccountId,
  spawnSession,
  spawnSessionOrFail,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../../sessions/testing";

const PROVIDER_ID = "accounts/tk";
const HARNESS_ID = "accounts/tk";

/** A harness that runs all three kinds of account. */
const TK: HarnessDefinition = buildHarnessDefinition("tk", [
  {
    providerId: PROVIDER_ID,
    kinds: [
      { kind: "api-key", credentialVariable: "TK_API_KEY" },
      { kind: "subscription-token", credentialVariable: "TK_TOKEN" },
      { kind: "subscription" },
    ],
    modelArgument: "{model}",
    models: "all",
  },
]);

const buildPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({
    id: "accounts",
    capabilities: ["harnesses", "providers"],
    definitions: [TK],
    providers: [
      {
        id: "tk",
        displayName: "Tk",
        kinds: [
          {
            id: "api-key",
            title: "API key",
            description: "A key for Tk.",
            setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
            keyCheck: {
              url: "https://api.tk.test/v1/models",
              headers: { authorization: "Bearer {apiKey}" },
            },
            harnesses: [HARNESS_ID],
          },
          {
            id: "subscription-token",
            title: "Subscription token",
            description: "A token that works on every machine.",
            setup: [{ kind: "harness-login", method: "create-token" }],
            harnesses: [HARNESS_ID],
          },
          {
            id: "subscription",
            title: "Subscription",
            description: "A plan signed in on each machine.",
            setup: [{ kind: "harness-login", method: "sign-in" }],
            harnesses: [HARNESS_ID],
          },
        ],
        defaultHarnessId: HARNESS_ID,
        catalogSource: { kind: "harness-probe", harnessId: HARNESS_ID },
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
  toolchains: [],
  harnesses: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: [HARNESS_ID],
  identityPort: 4939,
};

const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", imageInput: { maxBytes: null }, isDefault: true, options: [] },
];

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, { plugins: buildPlugins(), facts: FACTS, models: MODELS });

/** Adds an account of Tk of this kind and returns its id. Its snapshots are left to the probes. */
const addAccount = (arranged: Arranged, kind: string, expiresAt?: string): Promise<string> =>
  Effect.runPromise(
    Effect.orDie(
      Effect.gen(function* () {
        const sql = arranged.harness.sql;
        const accounts = yield* providerAccountRepository;
        const at = yield* nowIso;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const account = yield* accounts.insert({
              providerId: PROVIDER_ID,
              kind,
              label: kind,
              defaultHarnessId: HARNESS_ID,
              at,
            });
            if (expiresAt !== undefined)
              yield* accounts.setCredentialExpiry(account.id, expiresAt, at);
            return account.id;
          }),
        );
      }).pipe(Effect.provideService(SqlClient.SqlClient, arranged.harness.sql)),
    ),
  );

const run = (effect: Effect.Effect<unknown, unknown, never>): Promise<unknown> =>
  Effect.runPromise(Effect.orDie(effect));

const storeSecret = (arranged: Arranged, accountId: string, name: string): Promise<unknown> =>
  run(
    withTransaction(
      arranged.harness.sql,
      arranged.harness.secrets.set(
        buildProviderAccountOwner(accountId),
        name,
        Redacted.make("a-credential"),
      ),
    ),
  );

const deleteSnapshots = (arranged: Arranged, accountId: string): Promise<unknown> =>
  run(
    withTransaction(
      arranged.harness.sql,
      arranged.harness.sql`DELETE FROM capability_snapshots
                           WHERE provider_account_id = ${uuidFromString(accountId)}`,
    ),
  );

const setSnapshotsAuth = (
  arranged: Arranged,
  accountId: string,
  status: string,
): Promise<unknown> =>
  run(
    withTransaction(
      arranged.harness.sql,
      arranged.harness.sql`UPDATE capability_snapshots SET auth_status = ${status}
                           WHERE provider_account_id = ${uuidFromString(accountId)}`,
    ),
  );

const removeHarnessFromRunner = (arranged: Arranged): Promise<unknown> =>
  run(
    withTransaction(
      arranged.harness.sql,
      arranged.harness.sql`UPDATE runners
                           SET facts = json_replace(facts, '$.harnesses[0].present', json('false'))`,
    ),
  );

const messageOf = async (response: Response): Promise<string> => {
  expect(response.status).toBe(409);
  return JSON.stringify(await response.json());
};

describe("placing a session on a key account", () => {
  it("places it with no snapshot at all when the session names its model", async () => {
    await withFleet(async (arranged) => {
      const key = findProviderAccountId(arranged, HARNESS_ID);
      await deleteSnapshots(arranged, key);

      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        providerAccountId: key,
        model: "clever",
      });

      expect(session.runnerId).toBe(arranged.runnerId);
    });
  });

  it("fails with a message about the model list when no model is named and none was ever reported", async () => {
    await withFleet(async (arranged) => {
      const key = findProviderAccountId(arranged, HARNESS_ID);
      await deleteSnapshots(arranged, key);

      const response = await spawnSession(arranged, { prompt: "hello", providerAccountId: key });

      expect(await messageOf(response)).toContain(
        "No model list for Tk in Harness tk yet. Try again in a moment.",
      );
    });
  });

  it("fails and says the key is missing when no key is stored", async () => {
    await withFleet(async (arranged) => {
      const key = await addAccount(arranged, "api-key");

      const response = await spawnSession(arranged, {
        prompt: "hello",
        providerAccountId: key,
        model: "clever",
      });

      expect(await messageOf(response)).toContain("has no key. Add one in Settings");
    });
  });

  it("fails and says the harness is not installed when no runner has it", async () => {
    await withFleet(async (arranged) => {
      await removeHarnessFromRunner(arranged);

      const response = await spawnSession(arranged, {
        prompt: "hello",
        providerAccountId: findProviderAccountId(arranged, HARNESS_ID),
        model: "clever",
      });

      expect(await messageOf(response)).toContain("is not installed on any connected machine");
    });
  });
});

describe("placing a session on a token account", () => {
  it("places it while the token has not expired", async () => {
    await withFleet(async (arranged) => {
      const token = await addAccount(arranged, "subscription-token", "2999-01-01T00:00:00.000Z");
      await storeSecret(arranged, token, "token");

      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        providerAccountId: token,
        model: "clever",
      });

      expect(session.runnerId).toBe(arranged.runnerId);
    });
  });

  it("fails and names the day the token expired", async () => {
    await withFleet(async (arranged) => {
      const token = await addAccount(arranged, "subscription-token", "2000-01-01T00:00:00.000Z");
      await storeSecret(arranged, token, "token");

      const response = await spawnSession(arranged, {
        prompt: "hello",
        providerAccountId: token,
        model: "clever",
      });

      expect(await messageOf(response)).toContain("token expired on 2000-01-01");
    });
  });
});

describe("placing a session on a subscription signed in on each machine", () => {
  it("refuses a runner whose snapshot says it is not signed in", async () => {
    await withFleet(async (arranged) => {
      const subscription = await addAccount(arranged, "subscription");
      await setSnapshotsAuth(arranged, subscription, "unauthenticated");

      const response = await spawnSession(arranged, {
        prompt: "hello",
        providerAccountId: subscription,
      });

      expect(await messageOf(response)).toContain("is not signed in on any connected machine");
    });
  });
});
