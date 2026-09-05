/**
 * Enlisting this machine with a controller. One function for both callers, the
 * command line and the child a controller spawns, because a second
 * implementation is how the two would drift apart.
 *
 * The storage directory is named at random, which is what makes a re-enlisted
 * machine harmless: it never opens a previous life's workspaces, and never
 * deletes them either.
 *
 * This module is the only writer of `runner.json`. Everything else reads it.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runnerDirIn } from "@hydra/home";
import { JoinAnswer } from "@hydra/protocol";
import { runnerFileIn, type RunnerFile } from "./runner-file";

/** Outside the operation table, so it is written here. */
const JOIN_PATH = "/api/v1/runners/join";

const STORAGE_NAME_BYTES = 8;

export class JoinError extends Schema.TaggedError<JoinError>()("JoinError", {
  message: Schema.String,
  /**
   * A controller not listening yet is ordinary for the child spawned before it
   * binds; a token it refused is not something waiting fixes.
   */
  retryable: Schema.Boolean,
}) {}

export interface JoinOptions {
  /** As the user typed it. */
  readonly controllerUrl: string;
  readonly token: string;
  readonly home: string;
  /** The global `fetch` unless a caller says otherwise. */
  readonly fetch?: typeof fetch;
}

export interface Joined {
  readonly runnerId: string;
  /** The name the controller assigned, which the owner may rename. */
  readonly name: string;
  readonly configPath: string;
  /** Absolute. */
  readonly storageDirectory: string;
}

const decodeAnswer = Schema.decodeUnknownEffect(JoinAnswer);

const refusal = (status: number, body: string): string => {
  try {
    const envelope = JSON.parse(body) as { error?: { message?: unknown } };
    const message = envelope.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Not the error envelope: something else is answering on that URL.
  }
  return `the controller answered ${String(status)}`;
};

const ask = (options: JoinOptions): Effect.Effect<JoinAnswer, JoinError> =>
  Effect.gen(function* () {
    const call = options.fetch ?? fetch;
    const url = yield* Effect.try({
      try: () => new URL(JOIN_PATH, options.controllerUrl).toString(),
      catch: () =>
        new JoinError({
          message: `${options.controllerUrl} is not a controller URL`,
          retryable: false,
        }),
    });
    const response = yield* Effect.tryPromise({
      try: () =>
        call(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.token}`,
          },
          body: "{}",
        }),
      catch: (cause) =>
        new JoinError({ message: `cannot reach ${url}: ${String(cause)}`, retryable: true }),
    });
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new JoinError({
          message: `cannot read the answer from ${url}: ${String(cause)}`,
          retryable: true,
        }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new JoinError({ message: refusal(response.status, body), retryable: false }),
      );
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: () => new JoinError({ message: `${url} did not answer with JSON`, retryable: false }),
    });
    return yield* Effect.mapError(
      decodeAnswer(parsed),
      () =>
        new JoinError({
          message: `${url} answered something this build cannot read`,
          retryable: false,
        }),
    );
  });

/** The files are written after the exchange, so a refused join leaves the home alone. */
export const join = (options: JoinOptions): Effect.Effect<Joined, JoinError> =>
  Effect.gen(function* () {
    const answer = yield* ask(options);
    const runnerDir = runnerDirIn(options.home);
    const storageName = Buffer.from(
      crypto.getRandomValues(new Uint8Array(STORAGE_NAME_BYTES)),
    ).toString("hex");
    const storageDirectory = joinPath(runnerDir, storageName);
    const configPath = runnerFileIn(options.home);
    const contents: RunnerFile = {
      runnerId: answer.runnerId,
      credential: answer.credential,
      controllerUrl: options.controllerUrl,
      controllerIdentityId: answer.controllerIdentityId,
      controllerPublicKey: answer.controllerPublicKey,
      storageDirectory: storageName,
    };

    yield* Effect.try({
      try: () => {
        mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
        // Never written into the target file: `mode` applies only on creation,
        // so overwriting an earlier `runner.json` would hold the new credential
        // at the old mode, and a half-written one would leave the machine with
        // neither credential, of which the controller keeps only hashes.
        const temporary = `${configPath}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, {
            mode: 0o600,
            flag: "wx",
          });
          renameSync(temporary, configPath);
        } catch (error) {
          rmSync(temporary, { force: true });
          throw error;
        }
      },
      catch: (cause) =>
        new JoinError({
          message: `cannot write ${configPath}: ${String(cause)}`,
          retryable: false,
        }),
    });

    return { runnerId: answer.runnerId, name: answer.name, configPath, storageDirectory };
  });
