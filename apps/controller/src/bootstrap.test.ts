import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HOST_API, PluginError, type Plugin } from "@hercule/plugin-host";
import { CurrentActor, type Actor } from "./actor";
import { boot, bootWith, hashToken, buildSetupUrl, type BootOutcome } from "./bootstrap";
import { Plugins } from "./plugins";
import { PromotionState } from "./promotion";

/** Listing plugins needs an actor, and a boot has none, so the test provides the user. */
const USER: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "x" },
};

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-boot-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Boots the way `hercule serve` does, against the temporary home and the key file. */
const serve = (argv: ReadonlyArray<string> = []): Promise<BootOutcome> =>
  Effect.runPromise(boot({ argv: ["--home", home, ...argv], env: {}, masterKeyBackend: "file" }));

/** Boots the way `hercule serve` does, and returns the error the boot failed with. */
const serveAndReadError = (argv: ReadonlyArray<string> = [], at: string = home) =>
  Effect.runPromise(
    boot({ argv: ["--home", at, ...argv], env: {}, masterKeyBackend: "file" }).pipe(Effect.flip),
  );

/** Reads the database the way an operator would: from another connection, with plain SQL. */
const query = <A>(sql: string, at: string = home): ReadonlyArray<A> => {
  const database = new Database(join(at, "data", "hercule.db"), { readonly: true });
  try {
    return database.query(sql).all() as ReadonlyArray<A>;
  } finally {
    database.close();
  }
};

const readSetupToken = (url: string): string => new URL(url).searchParams.get("token")!;

const readSetupState = () =>
  query<{ token_hash: string | null; completed_at: string | null }>(
    "SELECT token_hash, completed_at FROM setup_state",
  )[0];

const readFileMode = (path: string): number => statSync(path).mode & 0o777;

describe("the first run", () => {
  it("creates the home layout and the config file, owner-only", async () => {
    const outcome = await serve();
    expect(readFileMode(home)).toBe(0o700);
    for (const directory of ["data", "runner", "logs", "backups", "tls"]) {
      expect(existsSync(join(home, directory))).toBe(true);
      expect(readFileMode(join(home, directory))).toBe(0o700);
    }
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("bind.port = 4937");
    expect(outcome.paths.databaseFile).toBe(join(home, "data", "hercule.db"));
  });

  it("writes its process log into <home>/logs/controller.log, owner-only", async () => {
    await serve();
    expect(readFileMode(join(home, "logs", "controller.log"))).toBe(0o600);
  });

  it("opens the database in WAL and applies the migrations", async () => {
    await serve();
    const database = new Database(join(home, "data", "hercule.db"));
    try {
      expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally {
      database.close();
    }
    expect(query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual(
      expect.arrayContaining([{ name: "secrets" }, { name: "setup_state" }]),
    );
  });

  it("seeds the shipped profiles and the controller settings", async () => {
    await serve();
    expect(
      query<{ name: string }>("SELECT name FROM permission_profiles ORDER BY name").map(
        (row) => row.name,
      ),
    ).toEqual(["assistant", "unrestricted", "worker"]);
    expect(
      query<{ key: string }>(
        "SELECT key FROM settings WHERE scope = 'controller' ORDER BY key",
      ).map((row) => row.key),
    ).toEqual([
      "backup.keep",
      "backup.time",
      "retention.conversations",
      "retention.events",
      "retention.security",
    ]);
  });

  it("creates the controller identity and the master key", async () => {
    const outcome = await serve();
    expect(outcome.identityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(query("SELECT id FROM controller_identity")).toHaveLength(1);
    expect(readFileMode(join(home, "master.key"))).toBe(0o600);
  });

  it("writes the one-time setup URL at mode 0600, and stores only its hash", async () => {
    const outcome = await serve();
    const url = outcome.setupUrl!;
    expect(url).toBe(`http://127.0.0.1:4937/setup?token=${readSetupToken(url)}`);
    expect(readFileSync(outcome.paths.setupUrlFile, "utf8").trim()).toBe(url);
    expect(readFileMode(outcome.paths.setupUrlFile)).toBe(0o600);

    const state = readSetupState();
    expect(state?.token_hash).toBe(hashToken(readSetupToken(url)));
    expect(state?.completed_at).toBeNull();
    // The token itself is nowhere in the database.
    expect(JSON.stringify(query("SELECT * FROM setup_state"))).not.toContain(readSetupToken(url));
  });

  it("writes a Data Root that moves with the home", async () => {
    await serve();
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain('data.dir = "data"');

    const moved = `${home}-moved`;
    renameSync(home, moved);
    try {
      const outcome = await Effect.runPromise(
        boot({ argv: ["--home", moved], env: {}, masterKeyBackend: "file" }),
      );
      expect(outcome.paths.databaseFile).toBe(join(moved, "data", "hercule.db"));
      expect(existsSync(join(moved, "data", "hercule.db"))).toBe(true);
      expect(query("SELECT id FROM controller_identity", moved)).toHaveLength(1);
    } finally {
      rmSync(moved, { recursive: true, force: true });
      home = moved;
    }
  });

  it("renders a reachable host when the bind host is a wildcard", async () => {
    const outcome = await serve(["-c", "bind.host=0.0.0.0", "-c", "bind.port=8080"]);
    expect(outcome.setupUrl).toContain("http://127.0.0.1:8080/setup?token=");
  });
});

describe("bootWith", () => {
  it("boots sealed after a seal, and serving again with --force-unseal", async () => {
    const bootAndReadPhase = (argv: ReadonlyArray<string>) =>
      Effect.runPromise(
        bootWith({ argv: ["--home", home, ...argv], env: {}, masterKeyBackend: "file" }, () =>
          Effect.flatMap(PromotionState, (promotion) => promotion.phase),
        ),
      );
    const tokenId = "0199f0b7-0002-7000-8000-000000000000";
    await Effect.runPromise(
      bootWith({ argv: ["--home", home], env: {}, masterKeyBackend: "file" }, () =>
        Effect.gen(function* () {
          const promotion = yield* PromotionState;
          yield* promotion.freeze(tokenId);
          yield* promotion.seal(tokenId, "http://b.example:9");
        }),
      ),
    );

    const sealed = await bootAndReadPhase([]);
    expect(sealed._tag === "Sealed" && sealed.seal.newAddress).toBe("http://b.example:9");
    expect((await bootAndReadPhase(["--force-unseal"]))._tag).toBe("Serving");
    expect((await bootAndReadPhase([]))._tag).toBe("Serving");
  });

  it("keeps the database open for whatever runs after the boot, and closes it after", async () => {
    const rows = await Effect.runPromise(
      bootWith({ argv: ["--home", home], env: {}, masterKeyBackend: "file" }, (outcome) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          expect(outcome.setupUrl).toBeDefined();
          return yield* sql<{ readonly name: string }>`SELECT name FROM permission_profiles`;
        }),
      ),
    );

    expect(rows).toHaveLength(3);
    // Nothing holds the file once the effect is done, so another writer can open it.
    const database = new Database(join(home, "data", "hercule.db"));
    try {
      expect(database.query("PRAGMA journal_mode").all()).toEqual([{ journal_mode: "wal" }]);
    } finally {
      database.close();
    }
  });
});

/**
 * Builds a plugin with one provider that either starts or fails to start. That
 * is enough to test what a boot does with one of each; the catalog and the
 * plugin lifecycle are tested in their own modules.
 */
const buildBootPlugin = (id: string, failure?: string): Plugin => ({
  manifest: {
    id,
    displayName: `Plugin ${id}`,
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    host.providers!.register({
      id: `${id}-provider`,
      displayName: `Provider ${id}`,
      binaryName: "harness",
      supportsMultipleInstances: true,
      configSchema: Schema.Struct({}),
      defaultConfig: {},
      declared: {
        steering: "native",
        fork: "native",
        modelSwitch: "in-session",
        accessModes: {
          "approval-required": "native",
          "auto-accept-edits": "native",
          auto: "native",
          "full-access": "native",
        },
        mcpPassthrough: "native",
        disallowedTools: "native",
        structuredOutput: "supported",
      },
    }),
  activate: () =>
    failure === undefined
      ? Effect.succeed(Effect.void)
      : Effect.fail(new PluginError({ message: failure })),
});

describe("a boot with a plugin that will not start", () => {
  it("still completes, and lists the plugin as errored beside the ones that started", async () => {
    const details = await Effect.runPromise(
      bootWith(
        {
          argv: ["--home", home],
          env: {},
          masterKeyBackend: "file",
          plugins: [
            buildBootPlugin("broken", "the harness binary is missing"),
            buildBootPlugin("healthy"),
          ],
        },
        () =>
          Effect.provideService(
            Effect.flatMap(Plugins, (plugins) => plugins.query()),
            CurrentActor,
            USER,
          ),
      ),
    );

    expect(details.map((detail) => detail.id)).toEqual(["broken", "healthy"]);
    expect(details[0]?.status).toEqual({
      _tag: "errored",
      message: "the harness binary is missing",
    });
    expect(details[1]?.status).toEqual({ _tag: "active" });
    // Registration ran before activation, so the failure did not undo it.
    expect(details[0]?.contributions.map((c) => c.id)).toEqual(["broken-provider"]);
    // No user asked for this boot, so the entry's actor is the system rather
    // than whoever logged in last.
    expect(
      query<{ actor: string | null }>("SELECT actor FROM events WHERE kind = 'plugin.errored'"),
    ).toEqual([{ actor: "system" }]);
  });
});

describe("a second boot", () => {
  it("keeps the identity and the master key, and creates a new token", async () => {
    const first = await serve();
    const key = readFileSync(join(home, "master.key"), "utf8");
    const firstHash = readSetupState()?.token_hash;

    const second = await serve();

    expect(second.identityId).toBe(first.identityId);
    expect(readFileSync(join(home, "master.key"), "utf8")).toBe(key);
    expect(query("SELECT id FROM controller_identity")).toHaveLength(1);

    expect(second.setupUrl).not.toBe(first.setupUrl);
    expect(readSetupState()?.token_hash).toBe(hashToken(readSetupToken(second.setupUrl!)));
    expect(readSetupState()?.token_hash).not.toBe(firstHash);
    expect(readFileSync(second.paths.setupUrlFile, "utf8").trim()).toBe(second.setupUrl);
  });

  it("seeds nothing twice", async () => {
    await serve();
    await serve();
    expect(query("SELECT name FROM permission_profiles")).toHaveLength(3);
    expect(query("SELECT key FROM settings")).toHaveLength(5);
  });
});

describe("once setup is complete", () => {
  it("deletes the setup URL, clears the token hash and creates no token", async () => {
    const first = await serve();
    const database = new Database(join(home, "data", "hercule.db"));
    try {
      // The outstanding token is left in the row. Completing setup clears it
      // normally, but the controller must not rely on that, so the boot clears
      // it too.
      database.run("UPDATE setup_state SET completed_at = '2026-09-04T00:00:00.000Z'");
    } finally {
      database.close();
    }
    expect(readSetupState()?.token_hash).not.toBeNull();

    const second = await serve();

    expect(second.setupUrl).toBeUndefined();
    expect(existsSync(first.paths.setupUrlFile)).toBe(false);
    expect(readSetupState()?.token_hash).toBeNull();
  });
});

describe("the setup URL", () => {
  it("brackets an IPv6 bind host", () => {
    expect(buildSetupUrl("fd00::1", 4937, "t")).toBe("http://[fd00::1]:4937/setup?token=t");
    expect(buildSetupUrl("::", 4937, "t")).toBe("http://127.0.0.1:4937/setup?token=t");
  });
});

describe("a boot that cannot start", () => {
  it("fails with the config error, and creates no database", async () => {
    const failure = await serveAndReadError(["-c", "bind.port=nope"]);
    expect(failure._tag).toBe("ConfigValueError");
    expect(existsSync(join(home, "data", "hercule.db"))).toBe(false);
  });

  it("creates no second master key for a database that already has secrets", async () => {
    await serve();
    rmSync(join(home, "master.key"));

    const failure = await serveAndReadError();

    expect(failure._tag).toBe("MasterKeyError");
    expect(failure.message).toContain(join(home, "master.key"));
    expect(failure.message).toContain("1 encrypted secret row");
    expect(existsSync(join(home, "master.key"))).toBe(false);
  });

  it("includes the file name when the database file is not a database", async () => {
    await serve();
    writeFileSync(join(home, "data", "hercule.db"), "this is not a SQLite database");
    rmSync(join(home, "data", "hercule.db-wal"), { force: true });
    rmSync(join(home, "data", "hercule.db-shm"), { force: true });

    const failure = await serveAndReadError();

    expect(failure._tag).toBe("DatabaseError");
    expect(failure.message).toContain(join(home, "data", "hercule.db"));
  });
});
