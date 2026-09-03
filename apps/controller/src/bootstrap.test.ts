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
import { boot, hashToken, setupUrl, type BootOutcome } from "./bootstrap";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hydra-boot-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Boot the way `hydra serve` does, against the temporary home and the key file. */
const serve = (argv: ReadonlyArray<string> = []): Promise<BootOutcome> =>
  Effect.runPromise(boot({ argv: ["--home", home, ...argv], env: {}, masterKeyBackend: "file" }));

/** Boot the way `hydra serve` does, and hand the test the error it failed with. */
const serveError = (argv: ReadonlyArray<string> = [], at: string = home) =>
  Effect.runPromise(
    boot({ argv: ["--home", at, ...argv], env: {}, masterKeyBackend: "file" }).pipe(Effect.flip),
  );

/** Read the database the way an operator would: another connection, plain SQL. */
const query = <A>(sql: string, at: string = home): ReadonlyArray<A> => {
  const database = new Database(join(at, "data", "hydra.db"), { readonly: true });
  try {
    return database.query(sql).all() as ReadonlyArray<A>;
  } finally {
    database.close();
  }
};

const tokenIn = (url: string): string => new URL(url).searchParams.get("token")!;

const setupState = () =>
  query<{ token_hash: string | null; completed_at: string | null }>(
    "SELECT token_hash, completed_at FROM setup_state",
  )[0];

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("the first run", () => {
  it("creates the home layout and the config file, owner-only", async () => {
    const outcome = await serve();
    expect(mode(home)).toBe(0o700);
    for (const directory of ["data", "runner", "logs", "backups", "tls"]) {
      expect(existsSync(join(home, directory))).toBe(true);
      expect(mode(join(home, directory))).toBe(0o700);
    }
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("bind.port = 4937");
    expect(outcome.paths.databaseFile).toBe(join(home, "data", "hydra.db"));
  });

  it("opens the database in WAL and applies the migrations", async () => {
    await serve();
    const database = new Database(join(home, "data", "hydra.db"));
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
    expect(mode(join(home, "master.key"))).toBe(0o600);
  });

  it("writes the one-time setup URL at mode 0600, and stores only its hash", async () => {
    const outcome = await serve();
    const url = outcome.setupUrl!;
    expect(url).toBe(`http://127.0.0.1:4937/setup?token=${tokenIn(url)}`);
    expect(readFileSync(outcome.paths.setupUrlFile, "utf8").trim()).toBe(url);
    expect(mode(outcome.paths.setupUrlFile)).toBe(0o600);

    const state = setupState();
    expect(state?.token_hash).toBe(hashToken(tokenIn(url)));
    expect(state?.completed_at).toBeNull();
    // The token itself is nowhere in the database.
    expect(JSON.stringify(query("SELECT * FROM setup_state"))).not.toContain(tokenIn(url));
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
      expect(outcome.paths.databaseFile).toBe(join(moved, "data", "hydra.db"));
      expect(existsSync(join(moved, "data", "hydra.db"))).toBe(true);
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

describe("a second boot", () => {
  it("keeps the identity and the master key, and mints a fresh token", async () => {
    const first = await serve();
    const key = readFileSync(join(home, "master.key"), "utf8");
    const firstHash = setupState()?.token_hash;

    const second = await serve();

    expect(second.identityId).toBe(first.identityId);
    expect(readFileSync(join(home, "master.key"), "utf8")).toBe(key);
    expect(query("SELECT id FROM controller_identity")).toHaveLength(1);

    expect(second.setupUrl).not.toBe(first.setupUrl);
    expect(setupState()?.token_hash).toBe(hashToken(tokenIn(second.setupUrl!)));
    expect(setupState()?.token_hash).not.toBe(firstHash);
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
  it("deletes the setup URL, clears the token hash and mints no token", async () => {
    const first = await serve();
    const database = new Database(join(home, "data", "hydra.db"));
    try {
      // The outstanding token is left in the row: completing setup is what
      // clears it, and the invariant is the controller's to keep.
      database.run("UPDATE setup_state SET completed_at = '2026-09-04T00:00:00.000Z'");
    } finally {
      database.close();
    }
    expect(setupState()?.token_hash).not.toBeNull();

    const second = await serve();

    expect(second.setupUrl).toBeUndefined();
    expect(existsSync(first.paths.setupUrlFile)).toBe(false);
    expect(setupState()?.token_hash).toBeNull();
  });
});

describe("the setup URL", () => {
  it("brackets an IPv6 bind host", () => {
    expect(setupUrl("fd00::1", 4937, "t")).toBe("http://[fd00::1]:4937/setup?token=t");
    expect(setupUrl("::", 4937, "t")).toBe("http://127.0.0.1:4937/setup?token=t");
  });
});

describe("a boot that cannot start", () => {
  it("fails with the config error, and creates no database", async () => {
    const failure = await serveError(["-c", "bind.port=nope"]);
    expect(failure._tag).toBe("ConfigValueError");
    expect(existsSync(join(home, "data", "hydra.db"))).toBe(false);
  });

  it("mints no second master key over a database that already holds secrets", async () => {
    await serve();
    rmSync(join(home, "master.key"));

    const failure = await serveError();

    expect(failure._tag).toBe("MasterKeyError");
    expect(failure.message).toContain(join(home, "master.key"));
    expect(failure.message).toContain("1 encrypted secret row");
    expect(existsSync(join(home, "master.key"))).toBe(false);
  });

  it("names the database file when it is not a database", async () => {
    await serve();
    writeFileSync(join(home, "data", "hydra.db"), "this is not a SQLite database");
    rmSync(join(home, "data", "hydra.db-wal"), { force: true });
    rmSync(join(home, "data", "hydra.db-shm"), { force: true });

    const failure = await serveError();

    expect(failure._tag).toBe("DatabaseError");
    expect(failure.message).toContain(join(home, "data", "hydra.db"));
  });
});
