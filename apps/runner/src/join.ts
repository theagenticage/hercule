/**
 * Enlisting this machine with a controller.
 *
 * One function, two callers: `hydra runner join`, which reads the token off the
 * command line, and the local runner the controller spawns, which reads it off
 * stdin. Neither has anything of its own to do here - a join is a join - and a
 * second implementation is how the two would drift apart.
 *
 * What it leaves behind is the runner's whole durable identity: `runner.json`,
 * mode 0600, and a storage directory named at random. The random name is what
 * makes a re-enlisted machine harmless: it never opens a previous life's
 * workspaces or caches, and it never deletes them either - they stay where they
 * are for a person to look through.
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

/** Where a machine joins. Outside the operation table, so it is written here. */
const JOIN_PATH = "/api/v1/runners/join";

/** How many random bytes name a storage directory. */
const STORAGE_NAME_BYTES = 8;

/** The join could not be completed, said in one line a person can act on. */
export class JoinError extends Schema.TaggedError<JoinError>()("JoinError", {
  message: Schema.String,
  /**
   * Whether trying the same join again could work. A controller that is not
   * listening yet is the ordinary case for the runner a controller spawns
   * before it binds; a token it refused is not something waiting fixes.
   */
  retryable: Schema.Boolean,
}) {}

/** What a join needs to know. */
export interface JoinOptions {
  /** Where the controller answers, as the user typed it. */
  readonly controllerUrl: string;
  /** The single-use join token. */
  readonly token: string;
  /** This machine's Hydra Home. */
  readonly home: string;
  /** How the controller is called; the global one unless a caller says otherwise. */
  readonly fetch?: typeof fetch;
}

/** What a machine is once it has joined. */
export interface Joined {
  readonly runnerId: string;
  /** The name the controller assigned. The owner renames it whenever they like. */
  readonly name: string;
  /** The `runner.json` this join wrote. */
  readonly configPath: string;
  /** The storage directory this enrolment owns, absolute. */
  readonly storageDirectory: string;
}

const decodeAnswer = Schema.decodeUnknownEffect(JoinAnswer);

/** What the controller said went wrong, or the status when it said nothing usable. */
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

/** The join exchange itself: one request, one answer. */
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

/**
 * Enlists this machine and persists what it was given.
 *
 * The files are written after the exchange succeeds, so a refused join leaves
 * the home exactly as it found it.
 */
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
        // Everything under here is this runner's alone, workspaces and provider
        // homes included.
        mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
        // Never written into the target file. `mode` applies only when a file
        // is created, so writing over an earlier enrolment's `runner.json`
        // would hold the new credential at the old mode until a chmod; and a
        // write that fails halfway would leave a machine holding neither
        // credential, both of which the controller keeps only the hash of. A
        // fresh file is 0600 from its first byte and the rename is atomic.
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
