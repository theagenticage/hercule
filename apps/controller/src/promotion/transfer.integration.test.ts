/**
 * The live promotion transfer over HTTP: A spends a token and streams a copy
 * of its data; B saves it, unpacks it into an empty Home, and reads a secret,
 * a thread and an attachment back under its own Master Key.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { buildHomePaths, type HomePaths } from "@hercule/home";
import { buildAttachmentPath } from "../attachments";
import { HerculeHome } from "../config";
import { mintToken } from "../credentials";
import { mintUuid, openDatabase, uuidToString } from "../db";
import {
  completeSetup,
  PASSWORD,
  post,
  readErrorBody,
  send,
  USERNAME,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { masterKeyLayer, Secrets, secretsLayer, type SecurityRunner } from "../secrets";
import { decodePromotionToken } from "./crypto";
import type { PromotionPreview } from "./exchange";
import { receiveTransfer, reserveHome } from "./receive";
import { createPromotionToken, requestTransfer } from "./testing";
import { NO_PROMOTION_TOKEN } from "./transfer";

const SECRET_VALUE = "ghp_promotion-transfer-secret";
const SECRET_OWNER = "0198e4b0-0000-7000-8000-000000000001";
const SECRET_PATH = `/api/v1/secrets/runner/${SECRET_OWNER}/api-token`;
const ATTACHMENT_BYTES = "attachment-from-a";

/** Decodes a promotion token to its bytes, and throws when it is not one. */
const decodeTokenOrThrow = (token: string): Uint8Array<ArrayBuffer> => {
  const bytes = decodePromotionToken(token);
  if (bytes === undefined) throw new Error(`not a promotion token: ${token}`);
  return bytes;
};

/**
 * Previews a transfer from A with `token`, as B does before it pulls one, and
 * returns the controller id the preview shows.
 */
const readPreviewedControllerId = async (base: string, token: string): Promise<string> => {
  const preview = (await (await requestTransfer(base, token, "GET")).json()) as PromotionPreview;
  return preview.controllerId;
};

/** Stores the test secret on A, and returns the status A answers with. */
const storeSecret = async (base: string, user: string): Promise<number> =>
  (await send("PUT", base, SECRET_PATH, { body: { value: SECRET_VALUE }, token: user })).status;

/** Inserts an attachment row on A and writes its file, and returns its id. */
const insertAttachment = async (harness: ServerHarness, bytes: string | Uint8Array) => {
  const id = mintUuid();
  const size = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
  await Effect.runPromise(
    Effect.orDie(
      harness.sql`
        INSERT INTO attachments (id, name, mime_type, size_bytes, sha256, created_at, actor)
        VALUES (${id}, 'a.png', 'image/png', ${size}, 'unchecked', ${new Date().toISOString()}, 'user')
      `,
    ),
  );
  const dataDir = join(harness.home, "data");
  const path = buildAttachmentPath(dataDir, uuidToString(id));
  mkdirSync(join(dataDir, "attachments"), { recursive: true });
  writeFileSync(path, bytes);
  return uuidToString(id);
};

const readFromDatabase = <A>(
  paths: HomePaths,
  query: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.orDie(
      Effect.gen(function* () {
        return yield* query(yield* SqlClient.SqlClient);
      }),
    ).pipe(Effect.provide(openDatabase(paths.databaseFile))),
  );

describe("promotion transfer", () => {
  const homes: Array<string> = [];
  afterEach(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    homes.length = 0;
  });

  /** Creates an empty Home for B, removed after the test. */
  const createHomeB = (): HomePaths => {
    const home = mkdtempSync(join(tmpdir(), "hercule-promote-recv-"));
    homes.push(home);
    return buildHomePaths(home, join(home, "data"));
  };

  /** Saves the transfer `response` streams into a file in a new directory, and returns its path. */
  const saveTransfer = async (response: Response): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "hercule-promote-download-"));
    homes.push(dir);
    const path = join(dir, "transfer");
    await Bun.write(path, response);
    return path;
  };

  /**
   * A `security` CLI that stores items in memory. Linux CI has no Keychain;
   * this is the command shape the macOS store sends, the same fake the
   * master-key tests use.
   */
  const createFakeSecurityRunner = (): SecurityRunner => {
    const items = new Map<string, string>();
    return (argv) => {
      const command = argv[1];
      const account = argv[argv.indexOf("-a") + 1];
      const fail = { exitCode: 1, stdout: "", stderr: "" };
      const missing = { exitCode: 44, stdout: "", stderr: "" };
      if (account === undefined) return Promise.resolve(fail);
      if (command === "find-generic-password") {
        const value = items.get(account);
        return Promise.resolve(
          value === undefined ? missing : { exitCode: 0, stdout: `${value}\n`, stderr: "" },
        );
      }
      if (command === "add-generic-password") {
        if (items.has(account)) return Promise.resolve({ exitCode: 45, stdout: "", stderr: "" });
        const value = argv[argv.indexOf("-w") + 1];
        if (value === undefined) return Promise.resolve(fail);
        items.set(account, value);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (command === "delete-generic-password") {
        if (!items.has(account)) return Promise.resolve(missing);
        items.delete(account);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve(fail);
    };
  };

  it("refuses a wrong token, an expired token, and a reused token", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);

      const wrong = await requestTransfer(harness.base, "not-a-promotion-token");
      expect(wrong.status).toBe(401);
      expect((await readErrorBody(wrong)).message).toBe(NO_PROMOTION_TOKEN);

      const expiredToken = await createPromotionToken(harness.base, user);
      await Effect.runPromise(
        Effect.orDie(
          harness.sql`
            UPDATE promotion_tokens
            SET created_at = ${"2000-01-01T00:00:00.000Z"},
                expires_at = ${"2000-01-01T00:15:00.000Z"}
          `,
        ),
      );
      const expired = await requestTransfer(harness.base, expiredToken);
      expect(expired.status).toBe(401);
      expect((await readErrorBody(expired)).message).toBe(NO_PROMOTION_TOKEN);

      const token = await createPromotionToken(harness.base, user);
      const first = await requestTransfer(harness.base, token);
      expect(first.status).toBe(200);
      await first.arrayBuffer();
      const reused = await requestTransfer(harness.base, token);
      expect(reused.status).toBe(401);
      expect((await readErrorBody(reused)).message).toBe(NO_PROMOTION_TOKEN);
    });
  });

  it("copies a secret, a thread and an attachment to a new Home, and leaves A's data as it was", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      expect(await storeSecret(harness.base, user)).toBe(200);
      const readCiphertext = Effect.orDie(
        harness.sql<{ readonly ciphertext: Uint8Array }>`SELECT ciphertext FROM secrets`,
      );
      const ciphertextBefore = await Effect.runPromise(readCiphertext);

      const sessionId = mintUuid();
      const now = new Date().toISOString();
      await Effect.runPromise(
        Effect.orDie(
          Effect.gen(function* () {
            yield* harness.sql`
              INSERT INTO sessions (
                id, permission_profile_id, instance_id, runner_id,
                requested_access_mode, access_mode, spec, title, status,
                created_at, last_activity_at
              ) VALUES (
                ${sessionId}, ${mintUuid()}, ${mintUuid()}, ${mintUuid()},
                'full', 'full', ${'{"prompt":"a thread"}'}, 'a thread', 'idle',
                ${now}, ${now}
              )
            `;
            for (let position = 1; position <= 3; position++) {
              yield* harness.sql`
                INSERT INTO session_stream (session_id, position, runner_seq, at, event)
                VALUES (
                  ${sessionId},
                  ${position},
                  ${position},
                  ${now},
                  ${JSON.stringify({ turn: position, text: `turn ${String(position)}` })}
                )
              `;
            }
          }),
        ),
      );
      const attachmentId = await insertAttachment(harness, ATTACHMENT_BYTES);
      // A file with no row, like an upload that never finished, stays behind.
      writeFileSync(join(harness.home, "data", "attachments", "upload.tmp"), "partial");

      const token = await createPromotionToken(harness.base, user);
      const controllerId = await readPreviewedControllerId(harness.base, token);
      const response = await requestTransfer(harness.base, token);
      expect(response.status).toBe(200);
      const transferFile = await saveTransfer(response);
      // A removes its copy of the database once the stream has ended.
      await vi.waitFor(
        () => expect(readdirSync(join(harness.home, "data", "promotion-transfer"))).toEqual([]),
        { timeout: 5_000 },
      );

      const paths = createHomeB();
      const received = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(reserveHome(paths, "file"), (home) =>
            receiveTransfer(home, decodeTokenOrThrow(token), controllerId, transferFile),
          ),
        ),
      );
      expect(received.controllerId).toBe(controllerId);
      expect(readdirSync(paths.dataDir).sort()).toEqual(["attachments", "hercule.db"].sort());
      expect(readdirSync(join(paths.dataDir, "attachments"))).toEqual([attachmentId]);
      expect(await Bun.file(buildAttachmentPath(paths.dataDir, attachmentId)).text()).toBe(
        ATTACHMENT_BYTES,
      );
      expect((await Bun.file(paths.masterKeyFile).stat()).mode & 0o777).toBe(0o600);

      const plaintext = await Effect.runPromise(
        Effect.gen(function* () {
          const secrets = yield* Secrets;
          const value = yield* secrets.get({ kind: "runner", id: SECRET_OWNER }, "api-token");
          return Option.isNone(value) ? "" : Redacted.value(value.value);
        }).pipe(
          Effect.provide(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
          Effect.provide(openDatabase(paths.databaseFile)),
          Effect.provide(Layer.succeed(HerculeHome, paths)),
        ),
      );
      expect(plaintext).toBe(SECRET_VALUE);

      const turns = await readFromDatabase(
        paths,
        (sql) =>
          sql<{ readonly event: string }>`SELECT event FROM session_stream ORDER BY position`,
      );
      expect(turns.map((row) => JSON.parse(row.event) as { turn: number; text: string })).toEqual([
        { turn: 1, text: "turn 1" },
        { turn: 2, text: "turn 2" },
        { turn: 3, text: "turn 3" },
      ]);
      const audited = await readFromDatabase(
        paths,
        (sql) =>
          sql<{ readonly kind: string }>`SELECT kind FROM events WHERE kind LIKE 'controller.%'`,
      );
      expect(audited.map((row) => row.kind).sort()).toEqual([
        "controller.promotion.started",
        "controller.promotionToken.minted",
      ]);

      expect(await Effect.runPromise(readCiphertext)).toEqual(ciphertextBefore);
    });
  });

  it("copies a secret from a Keychain-backed controller onto a file-backed Home", async () => {
    await withServer(
      async (harness) => {
        const user = await completeSetup(harness.base);
        expect(await storeSecret(harness.base, user)).toBe(200);
        expect(existsSync(join(harness.home, "master.key"))).toBe(false);

        const token = await createPromotionToken(harness.base, user);
        const controllerId = await readPreviewedControllerId(harness.base, token);
        const transferFile = await saveTransfer(await requestTransfer(harness.base, token));

        const paths = createHomeB();
        await Effect.runPromise(
          Effect.scoped(
            Effect.flatMap(reserveHome(paths, "file"), (home) =>
              receiveTransfer(home, decodeTokenOrThrow(token), controllerId, transferFile),
            ),
          ),
        );
        expect(existsSync(paths.masterKeyFile)).toBe(true);
        expect((await Bun.file(paths.masterKeyFile).stat()).mode & 0o777).toBe(0o600);

        const plaintext = await Effect.runPromise(
          Effect.gen(function* () {
            const secrets = yield* Secrets;
            const value = yield* secrets.get({ kind: "runner", id: SECRET_OWNER }, "api-token");
            return Option.isNone(value) ? "" : Redacted.value(value.value);
          }).pipe(
            Effect.provide(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
            Effect.provide(openDatabase(paths.databaseFile)),
            Effect.provide(Layer.succeed(HerculeHome, paths)),
          ),
        );
        expect(plaintext).toBe(SECRET_VALUE);
      },
      { masterKeyBackend: "keychain", securityRunner: createFakeSecurityRunner() },
    );
  });

  it("refuses a transfer the token was not made for, and leaves B's Home empty", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      expect(await storeSecret(harness.base, user)).toBe(200);
      await insertAttachment(harness, ATTACHMENT_BYTES);
      const token = await createPromotionToken(harness.base, user);
      const controllerId = await readPreviewedControllerId(harness.base, token);
      const transferFile = await saveTransfer(await requestTransfer(harness.base, token));

      const paths = createHomeB();
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.flatMap(reserveHome(paths, "file"), (home) =>
            receiveTransfer(home, decodeTokenOrThrow(mintToken()), controllerId, transferFile),
          ),
        ),
      );
      expect(JSON.stringify(exit)).toContain("do not decrypt with this token");
      expect(existsSync(paths.databaseFile)).toBe(false);
      expect(existsSync(join(paths.dataDir, "attachments"))).toBe(false);
      expect(existsSync(paths.masterKeyFile)).toBe(false);
    });
  });

  it("freezes mutations after the copy, and refuses a write that skips the gate", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);
      const response = await requestTransfer(harness.base, token);
      expect(response.status).toBe(200);
      await response.arrayBuffer();

      const read = await fetch(`${harness.base}/api/v1/controller`, {
        headers: { authorization: `Bearer ${user}`, connection: "close" },
      });
      expect(read.status).toBe(200);

      const mutating = await send("PUT", harness.base, SECRET_PATH, {
        body: { value: SECRET_VALUE },
        token: user,
      });
      expect(mutating.status).toBe(409);
      expect((await readErrorBody(mutating)).code).toBe("promotion_in_progress");

      const login = await post(harness.base, "/api/v1/auth/login", {
        username: USERNAME,
        password: PASSWORD,
      });
      expect(login.status).toBe(409);
      expect((await readErrorBody(login)).code).toBe("promotion_in_progress");

      // A write after the copy would be on A and never on B. A writer that
      // forgot the freeze is refused by the database itself, so the mistake
      // fails loudly instead of leaving the two machines apart.
      const now = new Date().toISOString();
      const refused = await Effect.runPromise(
        Effect.flip(
          harness.sql`
            INSERT INTO sessions (
              id, permission_profile_id, instance_id, runner_id,
              requested_access_mode, access_mode, spec, title, status,
              created_at, last_activity_at
            ) VALUES (
              ${mintUuid()}, ${mintUuid()}, ${mintUuid()}, ${mintUuid()},
              'full', 'full', ${'{"prompt":"after the copy"}'}, 'lost after copy', 'idle',
              ${now}, ${now}
            )
          `,
        ),
      );
      expect(String(refused.reason.cause)).toContain("attempt to write a readonly database");
    });
  });

  it("serves again at once when B cancels, and refuses a cancel with a token never spent", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const token = await createPromotionToken(harness.base, user);

      const unspent = await requestTransfer(harness.base, token, "DELETE");
      expect(unspent.status).toBe(401);

      await (await requestTransfer(harness.base, token)).arrayBuffer();
      expect(await storeSecret(harness.base, user)).toBe(409);

      const cancel = await requestTransfer(harness.base, token, "DELETE");
      expect(cancel.status).toBe(204);
      expect(await storeSecret(harness.base, user)).toBe(200);

      const again = await requestTransfer(harness.base, token, "DELETE");
      expect(again.status).toBe(204);

      // Only the cancel that ended the freeze is audited.
      const audited = await Effect.runPromise(
        Effect.orDie(
          harness.sql<{ readonly kind: string }>`
            SELECT kind FROM events WHERE kind LIKE 'controller.promotion.%' ORDER BY id
          `,
        ),
      );
      expect(audited.map((row) => row.kind)).toEqual([
        "controller.promotion.started",
        "controller.promotion.cancelled",
      ]);
    });
  });

  it("refuses a transfer whose attachment file is gone, names it, and serves again", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const id = await insertAttachment(harness, ATTACHMENT_BYTES);
      const path = buildAttachmentPath(join(harness.home, "data"), id);
      rmSync(path);
      const token = await createPromotionToken(harness.base, user);

      const refused = await requestTransfer(harness.base, token);
      expect(refused.status).toBe(409);
      const body = await readErrorBody(refused);
      expect(body.code).toBe("invalid_state");
      expect(body.message).toContain(path);
      expect(await storeSecret(harness.base, user)).toBe(200);
    });
  });

  it("serves again when B hangs up before the transfer finishes", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      // Large enough that the stream is still sending when the caller hangs up.
      await insertAttachment(harness, new Uint8Array(64 * 1024 * 1024));
      const token = await createPromotionToken(harness.base, user);

      const abort = new AbortController();
      const response = await requestTransfer(harness.base, token, "POST", abort.signal);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      abort.abort();
      await reader.cancel().catch(() => undefined);

      const deadline = Date.now() + 10_000;
      let status = await storeSecret(harness.base, user);
      while (status === 409 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await storeSecret(harness.base, user);
      }
      expect(status).toBe(200);
    });
  });
});
