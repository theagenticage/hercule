/**
 * Tests the steps an operator actually takes: start the controller, finish
 * setup, log in, and use the API through the CLI with the key login created.
 *
 * The steps run in order and share one controller, because that is what is
 * being tested: state carries from one command to the next. Raw `fetch` is
 * used only where no command covers the case (a request with no credential, a
 * path no operation owns) and to compare the CLI's `--json` with the raw
 * response.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  runCli,
  startController,
  type Controller,
} from "../scripts/controller-process";
import { parseJsonOutput, createTemporaryHome, type TemporaryHome } from "./harness";

/** The home the controller and the CLI share; the CLI writes its credential here. */
let state: TemporaryHome;
/** A home with no credential file, for the environment-variable cases. */
let bare: TemporaryHome;

let controller: Controller;
let port: number;
let url: string;
/** The bearer token `setup complete` returned. */
let setupBearer: string;
/** The API key `hercule login` created and stored. */
let apiKey: string;

let credentialsFile: string;
let setupUrlFile: string;

/** Runs the CLI with the credential file in the shared home. */
const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, stdin });

/**
 * Runs the CLI before a credential file exists. `setup read` and `setup
 * complete` send no credential, so `HERCULE_API_URL` is the only way to tell
 * them which controller to use.
 */
const runCliBeforeLogin = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, env: { HERCULE_API_URL: url }, stdin });

/** Runs the CLI with no credential file, and a token in the environment. */
const runCliWithToken = (token: string, args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: bare.home, env: { HERCULE_TOKEN: token, HERCULE_API_URL: url }, stdin });

beforeAll(async () => {
  state = createTemporaryHome();
  bare = createTemporaryHome();
  credentialsFile = join(state.home, "credentials.json");
  setupUrlFile = join(state.home, "setup-url");
  controller = await startController({ home: state.home });
  port = controller.port;
  url = controller.url;
}, 30_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state?.remove();
  bare?.remove();
});

describe("the first run and everything after it", () => {
  it("1. allows only setup.read before setup completes", async () => {
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

    const completed = await runCliBeforeLogin(
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
    setupBearer = (parseJsonOutput(completed) as { token: string }).token;
    expect(setupBearer).toBeTruthy();

    // The one-time URL has been used, so the file that held it is gone.
    expect(existsSync(setupUrlFile)).toBe(false);

    const read = await runCliBeforeLogin(["setup", "read", "--json"]);
    expect(parseJsonOutput(read)).toEqual({ complete: true });

    // A second completion fails: the token was cleared, so the setup gate
    // rejects the request before `invalid_state` is ever reached.
    const again = await runCliBeforeLogin(
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
    expect(parseJsonOutput(again)).toEqual({
      error: { code: "unauthenticated", message: expect.any(String) as string },
    });
  }, 15_000);

  it("3. logs in and writes a 0600 credential file that never shows the key", async () => {
    const login = await runLoggedInCli(
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

    const json = await runLoggedInCli(
      ["login", url, "--username", USERNAME, "--password-stdin", "--json"],
      PASSWORD,
    );
    expect(json.code).toBe(0);
    expect(Object.keys(parseJsonOutput(json) as object).sort()).toEqual([
      "apiKeyId",
      "name",
      "url",
    ]);
    expect(json.stdout).not.toContain(PASSWORD);
  }, 15_000);

  it("4a. lists the key login created, without its token", async () => {
    const keys = await runLoggedInCli(["api-key", "list", "--json"]);
    expect(keys.code).toBe(0);
    const items = (parseJsonOutput(keys) as { items: Array<Record<string, unknown>> }).items;
    const named = items.find((item) => item.name === "e2e-laptop");
    expect(named).toBeDefined();
    expect(named).not.toHaveProperty("token");
    expect(keys.stdout).not.toContain(apiKey);
    // The second, `--json` login used the hostname as the key name.
    expect(items).toHaveLength(2);
  });

  it("4b. reads the controller's identity and the timezone setup wrote", async () => {
    // The runner the controller started joins moments after the listener is
    // up, and it is another process: under load, the join can finish after
    // this step would otherwise have read the setting.
    let identity = await runLoggedInCli(["controller", "read", "--json"]);
    for (let waited = 0; waited < 10_000; waited += 100) {
      if (
        (parseJsonOutput(identity) as { defaultRunnerId: string | null }).defaultRunnerId !== null
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      identity = await runLoggedInCli(["controller", "read", "--json"]);
    }
    expect(identity.code).toBe(0);
    expect(parseJsonOutput(identity)).toEqual({
      id: expect.any(String) as string,
      publicKey: expect.any(String) as string,
      version: expect.any(String) as string,
      // The runner this controller started next to itself, which is the
      // fleet's first member and so the one placement falls back to.
      defaultRunnerId: expect.any(String) as string,
    });

    const settings = await runLoggedInCli(["settings", "read", "--json"]);
    expect(settings.code).toBe(0);
    const state = parseJsonOutput(settings) as { user: { timezone: string } };
    expect(state.user.timezone).toBe("Europe/Amsterdam");
  });

  it("4c. lists the shipped profiles, creates one, and resolves an id tail", async () => {
    const shipped = await runLoggedInCli(["profile", "list", "--json"]);
    const profiles = (
      parseJsonOutput(shipped) as { items: Array<{ id: string; name: string; shipped: boolean }> }
    ).items;
    expect(profiles.map((profile) => profile.name).sort()).toEqual([
      "assistant",
      "unrestricted",
      "worker",
    ]);
    expect(profiles.every((profile) => profile.shipped)).toBe(true);

    const created = await runLoggedInCli([
      "profile",
      "create",
      "--name",
      "e2e",
      "--grant",
      "task.read",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const { id } = parseJsonOutput(created) as { id: string };

    const byTail = await runLoggedInCli(["profile", "read", id.slice(-8), "--json"]);
    expect(byTail.code).toBe(0);
    expect((parseJsonOutput(byTail) as { id: string }).id).toBe(id);
  });

  it("4d. fails to delete a shipped profile, on stderr, with exit 1", async () => {
    const assistant = (
      parseJsonOutput(await runLoggedInCli(["profile", "list", "--json"])) as {
        items: Array<{ id: string; name: string }>;
      }
    ).items.find((profile) => profile.name === "assistant")!;

    const refused = await runLoggedInCli(["profile", "delete", assistant.id.slice(-8)]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("assistant");

    // With `--json` too: the envelope is on stderr, so a caller piping stdout
    // into a parser never gets an error where it expected a result.
    const asJson = await runLoggedInCli(["profile", "delete", assistant.id, "--json"]);
    expect(asJson.code).toBe(1);
    expect(asJson.stdout).toBe("");
    expect(JSON.parse(asJson.stderr)).toEqual({
      error: { code: "invalid_state", message: expect.any(String) as string },
    });
  });

  it("4e. stores a secret by reference and never reads its value back", async () => {
    const secretValue = "s3cret-value-nobody-should-see";
    const set = await runLoggedInCli(
      ["secret", "set", "plugin", "p1", "key1", "--value-stdin", "--json"],
      secretValue,
    );
    expect(set.code).toBe(0);
    expect(parseJsonOutput(set)).toMatchObject({
      ownerKind: "plugin",
      ownerId: "p1",
      name: "key1",
    });

    const listed = await runLoggedInCli(["secret", "list", "--owner-kind", "plugin", "--json"]);
    expect(listed.code).toBe(0);
    expect((parseJsonOutput(listed) as { items: Array<object> }).items).toContainEqual(
      expect.objectContaining({ ownerKind: "plugin", ownerId: "p1", name: "key1" }),
    );
    expect(listed.stdout).not.toContain(secretValue);

    // `--value` does not exist: a secret never sits in argv.
    const inArgv = await runLoggedInCli([
      "secret",
      "set",
      "plugin",
      "p1",
      "key2",
      "--value",
      secretValue,
    ]);
    expect(inArgv.code).toBe(2);
    expect(inArgv.stderr).toContain("--value-stdin");

    // The `core` owner is the controller's own key material.
    const core = await runLoggedInCli(
      ["secret", "set", "core", "controller", "x", "--value-stdin", "--json"],
      "x",
    );
    expect(core.code).toBe(1);
    expect(parseJsonOutput(core)).toMatchObject({ error: { code: "validation" } });
  });

  // 403 is not tested in this walk: the user holds every grant. A session
  // token's 403 is tested in
  // apps/controller/src/http/session-actor.integration.test.ts.

  it("5. reads credentials from the environment, and does not use the file in a session", async () => {
    const inSession = await runCli(["controller", "read"], {
      home: state.home,
      env: { HERCULE_SESSION: "1" },
    });
    expect(inSession.code).toBe(3);
    expect(inSession.stderr).toContain("HERCULE_SESSION");
    expect(inSession.stderr).toContain(credentialsFile);

    const byEnv = await runCliWithToken(apiKey, ["controller", "read", "--json"]);
    expect(byEnv.code).toBe(0);
    expect(parseJsonOutput(byEnv)).toHaveProperty("publicKey");

    const throwaway = parseJsonOutput(
      await runLoggedInCli(["api-key", "create", "--name", "throwaway", "--json"]),
    ) as { id: string; token: string };
    expect(await runCliWithToken(throwaway.token, ["controller", "read", "--json"])).toMatchObject({
      code: 0,
    });

    const revoked = await runLoggedInCli(["api-key", "revoke", throwaway.id, "--json"]);
    expect(revoked.code).toBe(0);

    const dead = await runCliWithToken(throwaway.token, ["controller", "read", "--json"]);
    expect(dead.code).toBe(1);
    expect(parseJsonOutput(dead)).toEqual({
      error: { code: "unauthenticated", message: expect.any(String) as string },
    });
  });

  it("6. prints help at any position, with the grant the operation needs", async () => {
    const help = await runLoggedInCli(["profile", "create", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("permission.write");
    expect(help.stdout).toContain("POST /api/v1/profiles");

    const late = await runLoggedInCli(["profile", "create", "--name", "x", "--help"]);
    expect(late.stdout).toBe(help.stdout);
  });

  it("7. prints exactly what the route returned under --json", async () => {
    const viaCli = await runLoggedInCli(["profile", "list", "--json"]);
    const viaFetch = await fetch(`${url}/api/v1/profiles`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(viaFetch.status).toBe(200);
    expect(parseJsonOutput(viaCli)).toEqual(await viaFetch.json());
  });

  it("8. logs out a login bearer token, and rejects logging out an API key", async () => {
    // `auth.login` and `auth.logout` have no command at all: the CLI exchanges
    // a password for an API key with `hercule login` and never holds a bearer
    // token. The web app uses these endpoints, so this test calls them over
    // HTTP.
    const post = (path: string, body: unknown, token?: string) =>
      fetch(`${url}/api/v1${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });

    const login = await post("/auth/login", { username: USERNAME, password: PASSWORD });
    expect(login.status).toBe(200);
    const bearer = ((await login.json()) as { token: string }).token;

    const alive = await fetch(`${url}/api/v1/settings`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(alive.status).toBe(200);

    const out = await post("/auth/logout", {}, bearer);
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({});

    const dead = await fetch(`${url}/api/v1/settings`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(dead.status).toBe(401);

    const key = await post("/auth/logout", {}, apiKey);
    expect(key.status).toBe(400);
    expect(await key.json()).toMatchObject({ error: { code: "validation" } });

    // The bearer token setup returned is a login token like any other, and it
    // is still valid: logging out one credential leaves the others alone.
    const fromSetup = await fetch(`${url}/api/v1/settings`, {
      headers: { authorization: `Bearer ${setupBearer}` },
    });
    expect(fromSetup.status).toBe(200);
  }, 15_000);

  it("9. stops on SIGTERM, closing the database, and opens the same home again", async () => {
    const wal = join(state.home, "data", "hercule.db-wal");
    // The write-ahead log is not empty while the controller is running, so the
    // checkpoint below is a real change rather than a no-op.
    expect(statSync(wal).size).toBeGreaterThan(0);

    const code = await controller.stop();
    expect(code).toBe(0);
    expect(controller.output()).toContain("Stopping Hercule.");

    // Exit 0 alone would also follow from `process.exit()`: the kernel releases
    // SQLite's locks either way. Closing the database is what checkpoints the
    // write-ahead log back into `hercule.db`, so an empty `-wal` is what
    // separates a clean close from a killed process. SQLite then removes the
    // file where the platform lets it and truncates it to zero where it does
    // not, so both outcomes mean checkpointed.
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);

    controller = await startController({ home: state.home, port });
    expect(controller.output()).toContain("Hercule is set up.");
    expect(existsSync(setupUrlFile)).toBe(false);

    const read = await runLoggedInCli(["setup", "read", "--json"]);
    expect(parseJsonOutput(read)).toEqual({ complete: true });

    // The key from before the restart still works: nothing lived in memory.
    const identity = await runLoggedInCli(["controller", "read", "--json"]);
    expect(identity.code).toBe(0);
  }, 30_000);
});
