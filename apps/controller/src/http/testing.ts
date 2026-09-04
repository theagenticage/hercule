/**
 * The controller, over a real socket, for tests (spec 04, Repository interfaces:
 * no mock repositories).
 *
 * Everything a request passes through in production is in this stack - the
 * envelope, the pre-setup gate, the derived routes, both credential gates and
 * every service. Only the database (`:memory:`), the master key (a file in a
 * temporary home) and the port (ephemeral) differ.
 *
 * `server.test.ts` still carries its own copy of this stack, written before this
 * module existed. Folding it in is a tidy-up for whoever touches that file next.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { homePaths } from "@hydra/home";
import { AuthLayer } from "../auth";
import { HydraHome } from "../config";
import { ApiKeysLayer, CredentialsLayer, hashToken } from "../credentials";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer, type AuditKind, type AuditRow } from "../events";
import { ControllerIdentity, controllerIdentityLayer, ControllerLayer } from "../identity";
import { masterKeyLayer, SecretLayer, secretsLayer } from "../secrets";
import { PermissionProfilesLayer, ProfilesLayer } from "../permissions";
import { SettingsLayer, SettingsOperationsLayer } from "../settings";
import { SetupLayer } from "../setup";
import { PasswordCost, TEST_PASSWORD_PARAMS, UserLayer, UsersLayer } from "../users";
import { seed } from "../seed";
import { serve } from "./server";

/** The setup token the harness seeds, and the password `completeSetup` uses. */
export const SETUP_TOKEN = "a-setup-token";
export const PASSWORD = "correct horse battery staple";
export const USERNAME = "rogier";

/** Every service the routes resolve, over one `:memory:` database. */
const services = (home: string) =>
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
        PermissionProfilesLayer,
      ),
    ),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HydraHome, homePaths(home, join(home, "data")))),
  );

/** An address a fetch can use; the server binds an ephemeral port on loopback. */
const baseUrl = Effect.map(HttpServer.HttpServer, (server) => {
  const address = server.address;
  if (address._tag !== "TcpAddress") throw new Error("expected a TCP address");
  return `http://127.0.0.1:${address.port}`;
});

/** Reads back what a request wrote to the audit log. */
export type AuditReader = (kind: AuditKind) => Promise<ReadonlyArray<AuditRow>>;

/**
 * Runs the real controller application over a real socket for the length of
 * `body`, in a temporary home that is removed afterwards.
 */
export const withServer = (
  body: (base: string, audit: AuditReader) => Promise<void>,
): Promise<void> => {
  const home = mkdtempSync(join(tmpdir(), "hydra-http-"));
  writeFileSync(join(home, "setup-url"), `http://127.0.0.1:4937/setup?token=${SETUP_TOKEN}\n`);

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO setup_state (singleton, token_hash, completed_at)
                   VALUES (1, ${hashToken(SETUP_TOKEN)}, NULL)`;
        // The boot creates the identity and seeds the shipped defaults before
        // anything binds, so the harness does both the same way: a request sees
        // the three shipped profiles and the controller settings a real
        // controller has (spec 15 section 7).
        yield* Effect.flatMap(ControllerIdentity, (identity) => identity.ensure);
        yield* seed;
        yield* serve;
        const base = yield* baseUrl;
        // The log this database holds, read the way anything else reads it: a
        // request's audit row is asserted through the service that wrote it.
        const log = yield* AuditLog;
        const audit: AuditReader = (kind) => Effect.runPromise(Effect.orDie(log.listByKind(kind)));
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
  ).finally(() => rmSync(home, { recursive: true, force: true }));
};

/** A request with a JSON body, and optionally a bearer token. */
export const send = (
  method: string,
  base: string,
  path: string,
  options: { readonly body?: unknown; readonly token?: string } = {},
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    ...(options.body === undefined
      ? {}
      : {
          body: typeof options.body === "string" ? options.body : JSON.stringify(options.body),
        }),
  });

/** A POST with a JSON body, the shape most of these tests need. */
export const post = (
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> =>
  send("POST", base, path, { body, ...(token === undefined ? {} : { token }) });

/** Finishes first run and answers with the bearer token setup handed back. */
export const completeSetup = async (base: string): Promise<string> => {
  const response = await send("POST", base, "/api/v1/setup/complete", {
    body: { username: USERNAME, password: PASSWORD, timezone: "Europe/Amsterdam" },
    token: SETUP_TOKEN,
  });
  if (response.status !== 200) throw new Error(`setup.complete answered ${response.status}`);
  return ((await response.json()) as { token: string }).token;
};
