import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Deferred, Effect, Layer } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { homePaths } from "@hydra/home";
import { AuthLayer } from "../auth";
import { HydraHome } from "../config";
import { ApiKeysLayer, CredentialsLayer, hashToken } from "../credentials";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer, type AuditKind, type AuditRow } from "../events";
import { controllerIdentityLayer, ControllerLayer } from "../identity";
import { masterKeyLayer, SecretLayer, secretsLayer } from "../secrets";
import { PermissionProfilesLayer, ProfilesLayer } from "../permissions";
import { SettingsLayer, SettingsOperationsLayer } from "../settings";
import { SetupLayer } from "../setup";
import { PasswordCost, TEST_PASSWORD_PARAMS, UserLayer, UsersLayer } from "../users";
import { serve } from "./server";

const SETUP_TOKEN = "a-setup-token";
const PASSWORD = "correct horse battery staple";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hydra-server-"));
  writeFileSync(join(home, "setup-url"), "http://127.0.0.1:4937/setup?token=a-setup-token\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const services = (at: string) =>
  Layer.mergeAll(
    SetupLayer,
    AuthLayer,
    ApiKeysLayer,
    UserLayer,
    SecretLayer,
    ControllerLayer,
    SettingsOperationsLayer,
    ProfilesLayer,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        UsersLayer,
        CredentialsLayer,
        SettingsLayer,
        PermissionProfilesLayer,
        AuditLogLayer,
        controllerIdentityLayer,
      ),
    ),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HydraHome, homePaths(at, join(at, "data")))),
  );

/** An address a fetch can use; the server binds an ephemeral port on loopback. */
const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  const address = server.address;
  if (address._tag !== "TcpAddress") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
});

/**
 * Runs the real controller application over a real socket. Everything a request
 * passes through in production is in this stack; only the database (memory) and
 * the port (ephemeral) differ.
 */
const withServer = (
  body: (
    base: string,
    audit: (kind: AuditKind) => Promise<ReadonlyArray<AuditRow>>,
  ) => Promise<void>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO setup_state (singleton, token_hash, completed_at)
                   VALUES (1, ${hashToken(SETUP_TOKEN)}, NULL)`;
        yield* serve;
        const base = yield* baseUrl;
        // The log this database holds, read the way anything else reads it: a
        // request's audit row is asserted through the same service that wrote it.
        const log = yield* AuditLog;
        const audit = (kind: AuditKind) => Effect.runPromise(Effect.orDie(log.listByKind(kind)));
        yield* Effect.promise(() => body(base, audit));
      }),
    ).pipe(
      Effect.provide(
        services(home).pipe(
          Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
        ),
      ),
      Effect.provideService(PasswordCost, TEST_PASSWORD_PARAMS),
    ),
  );

const post = (base: string, path: string, body: unknown, token?: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const get = (base: string, path: string, token: string): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

const del = (base: string, path: string, token: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });

const completeSetup = async (base: string): Promise<string> => {
  const response = await post(
    base,
    "/api/v1/setup/complete",
    { username: "rogier", password: PASSWORD, timezone: "Europe/Amsterdam" },
    SETUP_TOKEN,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
};

describe("before setup completes", () => {
  it("answers setup.read unauthenticated, so the web app knows where to route", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/v1/setup`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ complete: false });
    });
  });

  it("answers every other operation 401, credential or not", async () => {
    await withServer(async (base) => {
      const anonymous = await fetch(`${base}/api/v1/settings`);
      const withBearer = await fetch(`${base}/api/v1/settings`, {
        headers: { authorization: "Bearer looks-like-a-token" },
      });

      expect(anonymous.status).toBe(401);
      expect(withBearer.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });
  });

  it("answers login 401 as well: there is no user to log in as yet", async () => {
    await withServer(async (base) => {
      const response = await post(base, "/api/v1/auth/login", {
        username: "rogier",
        password: PASSWORD,
      });
      expect(response.status).toBe(401);
    });
  });

  it("refuses setup.complete without the setup token, and with the wrong one", async () => {
    await withServer(async (base) => {
      const input = { username: "rogier", password: PASSWORD, timezone: "Europe/Amsterdam" };
      expect((await post(base, "/api/v1/setup/complete", input)).status).toBe(401);
      expect((await post(base, "/api/v1/setup/complete", input, "wrong")).status).toBe(401);
    });
  });
});

describe("setup, login and logout", () => {
  it("completes setup once, and says so afterwards", async () => {
    await withServer(async (base) => {
      const token = await completeSetup(base);
      expect(token).not.toBe("");

      expect(await (await fetch(`${base}/api/v1/setup`)).json()).toEqual({ complete: true });

      const again = await post(
        base,
        "/api/v1/setup/complete",
        { username: "someone", password: PASSWORD, timezone: "UTC" },
        SETUP_TOKEN,
      );
      // The token is spent, so the gate answers before the state does.
      expect(again.status).toBe(401);
    });
  });

  it("logs in with the password and logs out again, and the token dies with it", async () => {
    await withServer(async (base) => {
      await completeSetup(base);

      const login = await post(base, "/api/v1/auth/login", {
        username: "rogier",
        password: PASSWORD,
      });
      expect(login.status).toBe(200);
      const { token } = (await login.json()) as { token: string };

      const logout = await post(base, "/api/v1/auth/logout", {}, token);
      expect(logout.status).toBe(200);

      const after = await post(base, "/api/v1/auth/logout", {}, token);
      expect(after.status).toBe(401);
    });
  });

  it("answers a wrong password 401 without saying which half was wrong", async () => {
    await withServer(async (base) => {
      await completeSetup(base);
      const response = await post(base, "/api/v1/auth/login", {
        username: "rogier",
        password: "guess",
      });

      expect(response.status).toBe(401);
      expect(JSON.stringify(await response.json())).not.toContain("rogier");
    });
  });
});

describe("the order of the checks", () => {
  it("answers 401 before 400: a malformed body under no credential is unauthenticated", async () => {
    await withServer(async (base) => {
      const bearer = await completeSetup(base);

      const anonymous = await post(base, "/api/v1/user/password", { nonsense: true });
      expect(anonymous.status).toBe(401);

      const authenticated = await post(base, "/api/v1/user/password", { nonsense: true }, bearer);
      expect(authenticated.status).toBe(400);
      const body = (await authenticated.json()) as {
        error: { code: string; details: { issues: ReadonlyArray<unknown> } };
      };
      expect(body.error.code).toBe("validation");
      expect(body.error.details.issues.length).toBeGreaterThan(0);
    });
  });

  it("answers a path no operation owns with the envelope, not an empty body", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });
});

describe("API keys over the wire", () => {
  it("mints a key, lists it without its token, uses it, and revokes it", async () => {
    await withServer(async (base, audit) => {
      const bearer = await completeSetup(base);

      const minted = await post(base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      expect(minted.status).toBe(200);
      const key = (await minted.json()) as { id: string; name: string; token: string };
      expect(key.name).toBe("laptop");

      const listed = await get(base, "/api/v1/api-keys", bearer);
      expect(listed.status).toBe(200);
      const page = (await listed.json()) as { items: ReadonlyArray<Record<string, unknown>> };
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ id: key.id, name: "laptop" });
      expect(JSON.stringify(page)).not.toContain(key.token);

      // The key authenticates in its own right, without the login bearer.
      expect((await get(base, "/api/v1/api-keys", key.token)).status).toBe(200);

      const revoked = await del(base, `/api/v1/api-keys/${key.id}`, bearer);
      expect(revoked.status).toBe(200);
      expect((await get(base, "/api/v1/api-keys", key.token)).status).toBe(401);

      const again = await del(base, `/api/v1/api-keys/${key.id}`, bearer);
      expect(again.status).toBe(404);

      expect(await audit("auth.apiKey.minted")).toMatchObject([
        { actor: "user", payload: { id: key.id, name: "laptop" } },
      ]);
      expect(await audit("auth.apiKey.revoked")).toMatchObject([
        { actor: "user", payload: { id: key.id } },
      ]);
    });
  });

  it("refuses an id that is not a canonical uuid before it looks for a key", async () => {
    await withServer(async (base) => {
      const bearer = await completeSetup(base);
      const response = await del(base, "/api/v1/api-keys/not-an-id", bearer);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    });
  });
});

describe("changing the password over the wire", () => {
  it("takes the new password afterwards and refuses the old one", async () => {
    await withServer(async (base, audit) => {
      const bearer = await completeSetup(base);
      const next = "an entirely different passphrase";

      const wrong = await post(base, "/api/v1/user/password", { current: "guess", next }, bearer);
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toMatchObject({
        error: { code: "validation", details: { issues: [{ path: ["current"] }] } },
      });

      const changed = await post(
        base,
        "/api/v1/user/password",
        { current: PASSWORD, next },
        bearer,
      );
      expect(changed.status).toBe(200);

      const old = await post(base, "/api/v1/auth/login", {
        username: "rogier",
        password: PASSWORD,
      });
      expect(old.status).toBe(401);
      const fresh = await post(base, "/api/v1/auth/login", { username: "rogier", password: next });
      expect(fresh.status).toBe(200);

      // The credentials issued under the old password still work: spec 13
      // section 4 asks for no revocation, and a rotation is not a compromise.
      expect((await get(base, "/api/v1/api-keys", bearer)).status).toBe(200);

      expect(await audit("user.passwordChanged")).toMatchObject([{ actor: "user", payload: {} }]);
      expect(await audit("setup.completed")).toMatchObject([{ actor: "user" }]);
      expect(await audit("auth.login.succeeded")).toHaveLength(1);
      expect(await audit("auth.login.failed")).toMatchObject([
        { actor: "user", payload: { username: "rogier" } },
      ]);
    });
  });
});

describe("stopping", () => {
  it("stops accepting once the scope closes, so the port is free again", async () => {
    let base = "";
    await withServer(async (address) => {
      base = address;
      expect((await fetch(`${base}/api/v1/setup`)).status).toBe(200);
    });

    await expect(fetch(`${base}/api/v1/setup`)).rejects.toThrow();
  });
});

describe("a client that hangs up", () => {
  it("interrupts the fiber handling its request", async () => {
    const interrupted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const stopped = yield* Deferred.make<void>();

          const routes = HttpRouter.add(
            "GET",
            "/slow",
            Effect.as(Deferred.succeed(started, undefined), HttpServerResponse.empty()).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
            ),
          );

          yield* HttpServer.serveEffect()(yield* HttpRouter.toHttpEffect(routes));
          const base = yield* baseUrl;

          const controller = new AbortController();
          yield* Effect.sync(() => {
            void fetch(`${base}/slow`, { signal: controller.signal }).catch(() => undefined);
          });
          yield* Deferred.await(started);
          yield* Effect.sync(() => controller.abort());

          return yield* Effect.as(Deferred.await(stopped), true);
        }),
      ).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
      ),
    );

    expect(interrupted).toBe(true);
  });
});
