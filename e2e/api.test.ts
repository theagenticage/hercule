/**
 * The walk an operator actually makes: start the controller, finish setup, log
 * in, and drive the API through the CLI under the key login minted.
 *
 * The steps are ordered and share one controller, because that is the property
 * under test - state carries from one command to the next. Raw `fetch` is used
 * only where no command expresses the case (a request with no credential, a
 * path no operation owns) and to check the CLI's `--json` against the wire.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  cli,
  jsonOf,
  startController,
  temporaryHome,
  type Controller,
} from "./harness";

/** The home the controller and the CLI share; the CLI writes its credential here. */
const state = temporaryHome();
/** A home with no credential file, for the environment-variable cases. */
const bare = temporaryHome();

let controller: Controller;
let port: number;
let url: string;
/** The bearer `setup complete` handed back. */
let setupBearer: string;
/** The API key `hydra login` minted and stored. */
let apiKey: string;

const credentialsFile = join(state.home, "credentials.json");
const setupUrlFile = join(state.home, "setup-url");

/** The CLI under the credential file in the shared home. */
const hydra = (args: ReadonlyArray<string>, stdin?: string) =>
  cli(args, { home: state.home, stdin });

/**
 * The CLI before a credential file exists. `setup read` and `setup complete`
 * carry no credential, so the only thing that can say which controller they
 * mean is `HYDRA_API_URL`.
 */
const beforeLogin = (args: ReadonlyArray<string>, stdin?: string) =>
  cli(args, { home: state.home, env: { HYDRA_API_URL: url }, stdin });

/** The CLI with no credential file, carrying a token in the environment. */
const withToken = (token: string, args: ReadonlyArray<string>, stdin?: string) =>
  cli(args, { home: bare.home, env: { HYDRA_TOKEN: token, HYDRA_API_URL: url }, stdin });

beforeAll(async () => {
  controller = await startController({ home: state.home });
  port = controller.port;
  url = controller.url;
}, 30_000);

afterAll(async () => {
  await controller.stop().catch(() => -1);
  state.remove();
  bare.remove();
});

describe("the first run and everything after it", () => {
  it("1. answers only setup.read before setup completes", async () => {
    const setup = await fetch(`${url}/api/v1/setup`);
    expect(setup.status).toBe(200);
    expect(await setup.json()).toEqual({ complete: false });

    const noCredential = await fetch(`${url}/api/v1/settings`);
    expect(noCredential.status).toBe(401);
    expect(await noCredential.json()).toEqual({
      error: { code: "unauthenticated", message: expect.stringContaining("set up") as string },
    });

    const randomBearer = await fetch(`${url}/api/v1/settings`, {
      headers: { authorization: "Bearer 3vRDDgSRGmLRZ_not_a_token" },
    });
    expect(randomBearer.status).toBe(401);

    // A path under the API prefix that no operation owns is a 404 in the same
    // envelope shape as any other error, bundle or no bundle.
    const elsewhere = await fetch(`${url}/api/v1/dashboard`);
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.json()).toEqual({
      error: { code: "not_found", message: expect.any(String) as string },
    });
  });

  it("2. completes setup with the token from the setup-url file", async () => {
    const setupUrl = readFileSync(setupUrlFile, "utf8").trim();
    expect(setupUrl).toContain(`${url}/setup?token=`);
    const token = new URL(setupUrl).searchParams.get("token");
    expect(token).toBeTypeOf("string");

    const completed = await beforeLogin(
      [
        "setup",
        "complete",
        "--setup-token",
        token!,
        "--username",
        USERNAME,
        "--password-stdin",
        "--timezone",
        "Europe/Amsterdam",
        "--json",
      ],
      PASSWORD,
    );
    expect(completed.code).toBe(0);
    setupBearer = (jsonOf(completed) as { token: string }).token;
    expect(setupBearer).toBeTruthy();

    // The one-time URL is spent, so the file it lived in is gone.
    expect(existsSync(setupUrlFile)).toBe(false);

    const read = await beforeLogin(["setup", "read", "--json"]);
    expect(jsonOf(read)).toEqual({ complete: true });

    // A second completion cannot get through: the token was cleared, so the
    // setup gate answers before `invalid_state` is ever reached.
    const again = await beforeLogin(
      [
        "setup",
        "complete",
        "--setup-token",
        token!,
        "--username",
        USERNAME,
        "--password-stdin",
        "--timezone",
        "UTC",
        "--json",
      ],
      PASSWORD,
    );
    expect(again.code).toBe(1);
    expect(jsonOf(again)).toEqual({
      error: { code: "unauthenticated", message: expect.any(String) as string },
    });
  }, 15_000);

  it("3. logs in and writes a 0600 credential file that never shows the key", async () => {
    const login = await hydra(
      ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-laptop"],
      PASSWORD,
    );
    expect(login.code).toBe(0);

    const credential = JSON.parse(readFileSync(credentialsFile, "utf8")) as {
      url: string;
      apiKey: string;
    };
    expect(credential.url).toBe(url);
    expect(credential.apiKey).toBeTruthy();
    apiKey = credential.apiKey;
    expect(statSync(credentialsFile).mode & 0o777).toBe(0o600);

    // Neither the key nor the password may reach a terminal or a log.
    expect(login.stdout).toContain(credentialsFile);
    expect(login.stdout).not.toContain(apiKey);
    expect(login.stdout).not.toContain(PASSWORD);
    expect(controller.output()).not.toContain(apiKey);

    const json = await hydra(
      ["login", url, "--username", USERNAME, "--password-stdin", "--json"],
      PASSWORD,
    );
    expect(json.code).toBe(0);
    expect(Object.keys(jsonOf(json) as object).sort()).toEqual(["apiKeyId", "name", "url"]);
    expect(json.stdout).not.toContain(PASSWORD);
  }, 15_000);

  it("4a. lists the key login minted, without its token", async () => {
    const keys = await hydra(["apiKey", "query", "--json"]);
    expect(keys.code).toBe(0);
    const items = (jsonOf(keys) as { items: Array<Record<string, unknown>> }).items;
    const named = items.find((item) => item.name === "e2e-laptop");
    expect(named).toBeDefined();
    expect(named).not.toHaveProperty("token");
    expect(keys.stdout).not.toContain(apiKey);
    // The second, `--json` login used the hostname as the key name.
    expect(items).toHaveLength(2);
  });

  it("4b. reads the controller's identity and the timezone setup wrote", async () => {
    // The runner the controller spawned joins moments after the listener comes
    // up, and it is another process: under load the join can land after this
    // step would otherwise have read the setting.
    let identity = await hydra(["controller", "read", "--json"]);
    for (let waited = 0; waited < 10_000; waited += 100) {
      if ((jsonOf(identity) as { defaultRunnerId: string | null }).defaultRunnerId !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      identity = await hydra(["controller", "read", "--json"]);
    }
    expect(identity.code).toBe(0);
    expect(jsonOf(identity)).toEqual({
      id: expect.any(String) as string,
      publicKey: expect.any(String) as string,
      version: expect.any(String) as string,
      // The runner this controller spawned beside itself, which is the fleet's
      // first member and so what a placement falls back to.
      defaultRunnerId: expect.any(String) as string,
    });

    const settings = await hydra(["settings", "read", "--json"]);
    expect(settings.code).toBe(0);
    const state = jsonOf(settings) as { user: { timezone: string } };
    expect(state.user.timezone).toBe("Europe/Amsterdam");
  });

  it("4c. lists the shipped profiles, creates one, and resolves an id tail", async () => {
    const shipped = await hydra(["profile", "query", "--json"]);
    const profiles = (
      jsonOf(shipped) as { items: Array<{ id: string; name: string; shipped: boolean }> }
    ).items;
    expect(profiles.map((profile) => profile.name).sort()).toEqual([
      "assistant",
      "unrestricted",
      "worker",
    ]);
    expect(profiles.every((profile) => profile.shipped)).toBe(true);

    const created = await hydra([
      "profile",
      "create",
      "--name",
      "e2e",
      "--grants",
      "task.read",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const { id } = jsonOf(created) as { id: string };

    const byTail = await hydra(["profile", "read", id.slice(-8), "--json"]);
    expect(byTail.code).toBe(0);
    expect((jsonOf(byTail) as { id: string }).id).toBe(id);
  });

  it("4d. refuses to delete a shipped profile, on stderr, with exit 1", async () => {
    const assistant = (
      jsonOf(await hydra(["profile", "query", "--json"])) as {
        items: Array<{ id: string; name: string }>;
      }
    ).items.find((profile) => profile.name === "assistant")!;

    const refused = await hydra(["profile", "delete", assistant.id.slice(-8)]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("assistant");

    // Under `--json` too: the envelope is on stderr, so a caller piping stdout
    // into a parser is never handed an error where a result was expected.
    const asJson = await hydra(["profile", "delete", assistant.id, "--json"]);
    expect(asJson.code).toBe(1);
    expect(asJson.stdout).toBe("");
    expect(JSON.parse(asJson.stderr)).toEqual({
      error: { code: "invalid_state", message: expect.any(String) as string },
    });
  });

  it("4e. stores a secret by reference and never reads its value back", async () => {
    const secretValue = "s3cret-value-nobody-should-see";
    const set = await hydra(
      ["secret", "set", "plugin", "p1", "key1", "--value-stdin", "--json"],
      secretValue,
    );
    expect(set.code).toBe(0);
    expect(jsonOf(set)).toMatchObject({ ownerKind: "plugin", ownerId: "p1", name: "key1" });

    const listed = await hydra(["secret", "query", "--ownerKind", "plugin", "--json"]);
    expect(listed.code).toBe(0);
    expect((jsonOf(listed) as { items: Array<object> }).items).toContainEqual(
      expect.objectContaining({ ownerKind: "plugin", ownerId: "p1", name: "key1" }),
    );
    expect(listed.stdout).not.toContain(secretValue);

    // `--value` does not exist: a secret never sits in argv.
    const inArgv = await hydra(["secret", "set", "plugin", "p1", "key2", "--value", secretValue]);
    expect(inArgv.code).toBe(2);
    expect(inArgv.stderr).toContain("--value-stdin");

    // The `core` owner is the controller's own key material.
    const core = await hydra(
      ["secret", "set", "core", "controller", "x", "--value-stdin", "--json"],
      "x",
    );
    expect(core.code).toBe(1);
    expect(jsonOf(core)).toMatchObject({ error: { code: "validation" } });
  });

  // 403 cannot be reached end to end yet: the only actor is the user, who holds
  // every grant, and no session actor exists yet. The grant check is
  // unit-tested against every operation in the contract instead
  // (apps/controller/src/http/middleware.test.ts). Once session tokens exist,
  // the case belongs here.

  it("5. resolves credentials from the environment, and refuses the file in a session", async () => {
    const inSession = await cli(["controller", "read"], {
      home: state.home,
      env: { HYDRA_SESSION: "1" },
    });
    expect(inSession.code).toBe(3);
    expect(inSession.stderr).toContain("HYDRA_SESSION");
    expect(inSession.stderr).toContain(credentialsFile);

    const byEnv = await withToken(apiKey, ["controller", "read", "--json"]);
    expect(byEnv.code).toBe(0);
    expect(jsonOf(byEnv)).toHaveProperty("publicKey");

    const throwaway = jsonOf(
      await hydra(["apiKey", "create", "--name", "throwaway", "--json"]),
    ) as { id: string; token: string };
    expect(await withToken(throwaway.token, ["controller", "read", "--json"])).toMatchObject({
      code: 0,
    });

    const revoked = await hydra(["apiKey", "revoke", throwaway.id, "--json"]);
    expect(revoked.code).toBe(0);

    const dead = await withToken(throwaway.token, ["controller", "read", "--json"]);
    expect(dead.code).toBe(1);
    expect(jsonOf(dead)).toEqual({
      error: { code: "unauthenticated", message: expect.any(String) as string },
    });
  });

  it("6. prints help at any position, naming the grant the operation needs", async () => {
    const help = await hydra(["profile", "create", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("permission.write");
    expect(help.stdout).toContain("POST /api/v1/profiles");

    const late = await hydra(["profile", "create", "--name", "x", "--help"]);
    expect(late.stdout).toBe(help.stdout);
  });

  it("7. prints exactly what the route returned under --json", async () => {
    const viaCli = await hydra(["profile", "query", "--json"]);
    const viaFetch = await fetch(`${url}/api/v1/profiles`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(viaFetch.status).toBe(200);
    expect(jsonOf(viaCli)).toEqual(await viaFetch.json());
  });

  it("8. logs out a login bearer, and refuses to log out an API key", async () => {
    const bearer = (
      jsonOf(
        await withToken(
          apiKey,
          ["auth", "login", "--username", USERNAME, "--password-stdin", "--json"],
          PASSWORD,
        ),
      ) as { token: string }
    ).token;

    const alive = await fetch(`${url}/api/v1/settings`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(alive.status).toBe(200);

    const out = await withToken(bearer, ["auth", "logout", "--json"]);
    expect(out.code).toBe(0);
    expect(jsonOf(out)).toEqual({});

    const dead = await fetch(`${url}/api/v1/settings`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(dead.status).toBe(401);

    const key = await hydra(["auth", "logout", "--json"]);
    expect(key.code).toBe(1);
    expect(jsonOf(key)).toMatchObject({ error: { code: "validation" } });

    // The bearer setup handed back is a login token like any other, and it is
    // still alive: logging out one credential leaves the others alone.
    const fromSetup = await fetch(`${url}/api/v1/settings`, {
      headers: { authorization: `Bearer ${setupBearer}` },
    });
    expect(fromSetup.status).toBe(200);
  }, 15_000);

  it("9. stops on SIGTERM, closing the database, and opens the same home again", async () => {
    const wal = join(state.home, "data", "hydra.db-wal");
    // Under load the write-ahead log is not empty while the controller is up,
    // so the checkpoint below is a real transition rather than a no-op.
    expect(statSync(wal).size).toBeGreaterThan(0);

    const code = await controller.stop();
    expect(code).toBe(0);
    expect(controller.output()).toContain("Stopping Hydra.");

    // Exit 0 alone would also follow from `process.exit()`: the kernel releases
    // SQLite's locks either way. Closing the database is what checkpoints the
    // write-ahead log back into `hydra.db`, so an empty `-wal` is the
    // observable that separates a clean close from a killed process. SQLite
    // then removes the file where the platform lets it and truncates it to
    // zero where it does not, so both outcomes mean checkpointed.
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);

    controller = await startController({ home: state.home, port });
    expect(controller.output()).toContain("Hydra is set up.");
    expect(existsSync(setupUrlFile)).toBe(false);

    const read = await hydra(["setup", "read", "--json"]);
    expect(jsonOf(read)).toEqual({ complete: true });

    // The key from before the restart still works: nothing lived in memory.
    const identity = await hydra(["controller", "read", "--json"]);
    expect(identity.code).toBe(0);
  }, 30_000);
});
