import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  type Plugin,
} from "@hydra/plugin-host";
import { completeSetup, get, post, send, withServer, type ServerHarness } from "../http/testing";
import { CurrentActor, type Actor } from "../actor";
import { uuidFromString } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { Settings, SettingsLayer } from "./repository";
import { SettingsOperations, SettingsOperationsLayer } from "./service";

type Deps = SettingsOperations | Settings | AuditLog | SqlClient.SqlClient;

const layer = SettingsOperationsLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(SettingsLayer, AuditLogLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER_ID = "0199e0e7-0000-7000-8000-000000000000";

const USER: Actor = {
  _tag: "user",
  userId: USER_ID,
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** The row the user settings foreign key points at; the boot writes it at setup. */
const addUser = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    INSERT INTO users (id, username, password_hash, created_at, updated_at)
    VALUES (${uuidFromString(USER_ID)}, 'rogier', 'x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `,
);

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    Effect.andThen(addUser, effect).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
    ),
  );

/** Runs a call made by nobody: an in-process caller with no credential. */
const runAnonymous = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(Effect.andThen(addUser, effect).pipe(Effect.flip, Effect.provide(layer)));

describe("settings.read", () => {
  it("answers with the keys that are set, and nothing for the rest", async () => {
    const state = await run(
      Effect.gen(function* () {
        const store = yield* Settings;
        yield* store.set("retention.events", 30);
        yield* store.setForUser(USER_ID, "timezone", "Europe/Amsterdam");
        return yield* Effect.flatMap(SettingsOperations, (settings) => settings.read());
      }),
    );
    expect(state).toEqual({
      controller: { "retention.events": 30 },
      user: { timezone: "Europe/Amsterdam" },
    });
  });

  it("answers with two empty scopes on a store nobody has written", async () => {
    const state = await run(Effect.flatMap(SettingsOperations, (settings) => settings.read()));
    expect(state).toEqual({ controller: {}, user: {} });
  });

  it("refuses a caller with no credential, before reading anything", async () => {
    const error = await runAnonymous(
      Effect.flatMap(SettingsOperations, (settings) => settings.read()),
    );
    expect(error).toMatchObject({
      error: { code: "forbidden", details: { grant: "settings.read" } },
    });
  });
});

describe("settings.update", () => {
  it("writes the keys it names, leaves the rest alone, and answers with the whole state", async () => {
    const state = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        yield* settings.update({ controller: { "backup.keep": 14 } });
        return yield* settings.update({
          user: { timezone: "UTC", "topics.order": ["intake", "checkin"] },
        });
      }),
    );
    expect(state).toEqual({
      controller: { "backup.keep": 14 },
      user: { timezone: "UTC", "topics.order": ["intake", "checkin"] },
    });
  });

  it("replaces a key that is already set", async () => {
    const state = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        yield* settings.update({ user: { timezone: "UTC" } });
        return yield* settings.update({ user: { timezone: "Europe/Amsterdam" } });
      }),
    );
    expect(state.user).toEqual({ timezone: "Europe/Amsterdam" });
  });

  it("stamps the keys it wrote, and never their values", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        const audit = yield* AuditLog;
        yield* settings.update({
          controller: { "backup.time": "03:30" },
          user: { timezone: "UTC" },
        });
        return yield* audit.listByKind("settings.updated");
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toBe("user");
    expect(entries[0]?.payload).toEqual({
      keys: [
        { scope: "controller", key: "backup.time" },
        { scope: "user", key: "timezone" },
      ],
    });
    expect(JSON.stringify(entries[0]?.payload)).not.toContain("03:30");
  });

  it("refuses a patch that names no key, and writes no audit row", async () => {
    const error = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        const audit = yield* AuditLog;
        const failure = yield* Effect.flip(settings.update({}));
        expect(yield* audit.listByKind("settings.updated")).toEqual([]);
        return failure;
      }),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });

  it("refuses a patch whose scopes are empty objects", async () => {
    const error = await run(
      Effect.flatMap(SettingsOperations, (settings) =>
        Effect.flip(settings.update({ controller: {}, user: {} })),
      ),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });

  it("writes the user scope under the caller's own id", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        const sql = yield* SqlClient.SqlClient;
        yield* settings.update({ user: { timezone: "UTC" } });
        return yield* sql<{
          readonly key: string;
        }>`SELECT key FROM user_settings WHERE user_id = ${uuidFromString(USER_ID)}`;
      }),
    );
    expect(rows).toEqual([{ key: "timezone" }]);
  });

  it("writes a thread row density and reads it back", async () => {
    const state = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        yield* settings.update({ user: { "ui.threadRows": "plain" } });
        return yield* settings.read();
      }),
    );
    expect(state.user).toEqual({ "ui.threadRows": "plain" });
  });

  it("refuses a thread row density outside the two the shell offers", async () => {
    const error = await run(
      Effect.flatMap(SettingsOperations, (settings) =>
        Effect.flip(settings.update({ user: { "ui.threadRows": "rich" } as never })),
      ),
    );
    expect(error).toMatchObject({ _tag: "SettingError", scope: "user", key: "ui.threadRows" });
  });

  it("writes both session timeouts in whole minutes and reads them back", async () => {
    const state = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsOperations;
        yield* settings.update({
          controller: {
            "session.inactivityTimeoutMinutes": 5,
            "session.absoluteTimeoutMinutes": 60,
          },
        });
        return yield* settings.read();
      }),
    );
    expect(state.controller).toEqual({
      "session.inactivityTimeoutMinutes": 5,
      "session.absoluteTimeoutMinutes": 60,
    });
  });

  it("refuses a session timeout that is zero or not a whole number of minutes", async () => {
    // A session may not be given no time at all, and a fraction of a minute is
    // not something the wire's milliseconds can be derived from honestly.
    for (const key of [
      "session.inactivityTimeoutMinutes",
      "session.absoluteTimeoutMinutes",
    ] as const) {
      for (const value of [0, -1, 1.5]) {
        const error = await run(
          Effect.flatMap(SettingsOperations, (settings) =>
            Effect.flip(settings.update({ controller: { [key]: value } })),
          ),
        );
        expect(error, `${key} = ${String(value)}`).toMatchObject({
          _tag: "SettingError",
          scope: "controller",
          key,
        });
      }
    }
  });

  it("writes nothing when the caller may not write", async () => {
    const error = await runAnonymous(
      Effect.flatMap(SettingsOperations, (settings) =>
        settings.update({ user: { timezone: "UTC" } }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });

    const state = await run(Effect.flatMap(SettingsOperations, (settings) => settings.read()));
    expect(state.user).toEqual({});
  });
});

/**
 * The keys a thread's workspace and the expiry sweep read.
 *
 * These go over the wire rather than through the service, because the closed
 * key set and the values each key admits are the contract's, and a value the
 * schema refuses is a `validation` refusal a caller can act on.
 */
const PAT = "ghp_a-token";

/** GitHub as a connection type, checked here rather than against api.github.com. */
const githubPlugin: Plugin = {
  manifest: {
    id: "github",
    displayName: "GitHub",
    hostApi: HOST_API,
    capabilities: ["connections"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerConnectionType(host, {
      type: "github",
      displayName: "GitHub",
      setup: [{ kind: "credentials", fields: [{ name: "pat", label: "Personal access token" }] }],
      validate: (credentials: Record<string, string>) =>
        credentials["pat"] === PAT
          ? Effect.succeed({ displayName: "octocat" })
          : Effect.fail(new ConnectionValidationFailed({ message: "GitHub rejected the token." })),
    }),
  activate: () => Effect.succeed(Effect.void),
};

const mailerPlugin: Plugin = {
  manifest: {
    id: "mailer",
    displayName: "Mailer",
    hostApi: HOST_API,
    capabilities: ["connections"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerConnectionType(host, {
      type: "mailbox",
      displayName: "Mailbox",
      setup: [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }],
      validate: () => Effect.succeed({ displayName: "work@example.com" }),
    }),
  activate: () => Effect.succeed(Effect.void),
};

interface SettingsState {
  readonly controller: Record<string, unknown>;
  readonly user: Record<string, unknown>;
}

const withSettings = (
  body: (base: string, token: string, harness: ServerHarness) => Promise<void>,
): Promise<void> =>
  withServer(
    async (harness) => {
      const token = await completeSetup(harness.base);
      await body(harness.base, token, harness);
    },
    { plugins: [githubPlugin, mailerPlugin] },
  );

const patch = (base: string, token: string, body: unknown): Promise<Response> =>
  send("PATCH", base, "/api/v1/settings", { body, token });

const readSettings = async (base: string, token: string): Promise<SettingsState> => {
  const response = await get(base, "/api/v1/settings", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as SettingsState;
};

const refusedCode = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

const connect = async (
  base: string,
  token: string,
  type: string,
  credentials: Record<string, string>,
): Promise<string> => {
  const response = await post(
    base,
    "/api/v1/connections",
    { type, label: "work", labels: ["Code"], credentials },
    token,
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

describe("the thread workspace default", () => {
  // D-21 R3: two values, not three. `none` could never be read back as itself -
  // a project with repos never offers it and one without has nothing else - so
  // it always meant unset, which is what absent already means.
  it("takes each of the two a thread may open in, and reads it back", async () => {
    await withSettings(async (base, token) => {
      for (const value of ["primary", "ephemeral"]) {
        const response = await patch(base, token, { user: { "thread.workspace": value } });
        expect(response.status, `${value}: ${await response.clone().text()}`).toBe(200);
        expect((await readSettings(base, token)).user["thread.workspace"]).toBe(value);
      }
    });
  });

  it("is absent until it is written, so the default lives in one place", async () => {
    await withSettings(async (base, token) => {
      expect((await readSettings(base, token)).user["thread.workspace"]).toBeUndefined();
    });
  });

  /**
   * D-21 R3: narrowing a key's type must not brick the settings screen for
   * whoever had the old value. A row this build cannot read is left out, which
   * is what unset already meant here.
   */
  it("reads a stored value this build no longer takes as unset", async () => {
    await withSettings(async (base, token, harness) => {
      await Effect.runPromise(
        Effect.orDie(
          harness.sql`INSERT INTO user_settings (user_id, key, value, updated_at)
                      SELECT id, 'thread.workspace', '"none"', '2026-09-16T00:00:00.000Z'
                      FROM users LIMIT 1`,
        ),
      );
      expect((await readSettings(base, token)).user["thread.workspace"]).toBeUndefined();
    });
  });

  it("refuses a value that is not one of the two, `none` among them", async () => {
    await withSettings(async (base, token) => {
      for (const value of ["worktree", "none"]) {
        const response = await patch(base, token, { user: { "thread.workspace": value } });
        expect(await refusedCode(response), value).toBe("validation");
        expect((await readSettings(base, token)).user["thread.workspace"]).toBeUndefined();
      }
    });
  });
});

describe("the GitHub connection threads use", () => {
  it("takes a github connection and takes it back off again", async () => {
    await withSettings(async (base, token) => {
      const github = await connect(base, token, "github/github", { pat: PAT });

      const set = await patch(base, token, { user: { "thread.githubConnectionId": github } });
      expect(set.status, await set.clone().text()).toBe(200);
      expect((await readSettings(base, token)).user["thread.githubConnectionId"]).toBe(github);

      const cleared = await patch(base, token, { user: { "thread.githubConnectionId": null } });
      expect(cleared.status, await cleared.clone().text()).toBe(200);
      expect((await readSettings(base, token)).user["thread.githubConnectionId"]).toBeNull();
    });
  });

  it("refuses a connection that is not a github one", async () => {
    await withSettings(async (base, token) => {
      const mailbox = await connect(base, token, "mailer/mailbox", { token: "t" });
      const response = await patch(base, token, {
        user: { "thread.githubConnectionId": mailbox },
      });
      expect(await refusedCode(response)).toBe("validation");
      expect((await readSettings(base, token)).user["thread.githubConnectionId"]).toBeUndefined();
    });
  });
});

describe("the workspace expiry windows", () => {
  it("takes whole positive numbers of hours and days", async () => {
    await withSettings(async (base, token) => {
      const response = await patch(base, token, {
        controller: { "workspace.orphanTtlHours": 6, "workspace.idleTtlDays": 90 },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect((await readSettings(base, token)).controller).toMatchObject({
        "workspace.orphanTtlHours": 6,
        "workspace.idleTtlDays": 90,
      });
    });
  });

  it("refuses zero, a negative window and a fraction of one", async () => {
    await withSettings(async (base, token) => {
      for (const key of ["workspace.orphanTtlHours", "workspace.idleTtlDays"]) {
        for (const value of [0, -1, 1.5]) {
          const response = await patch(base, token, { controller: { [key]: value } });
          expect(await refusedCode(response), `${key} = ${String(value)}`).toBe("validation");
        }
      }
      expect(await readSettings(base, token)).toMatchObject({ controller: {} });
    });
  });
});
