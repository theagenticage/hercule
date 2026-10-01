/**
 * Joins this machine to a controller. Both callers use this one function: the
 * `hercule runner join` command and the child process a controller spawns. A
 * second implementation would drift apart from the first.
 *
 * The storage directory gets a random name. So a machine that joins again gets
 * a fresh directory: it never opens the workspaces of its previous
 * registration, and never deletes them either.
 */
import { mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { locateRunnerDir, locateRunnerFile } from "@hercule/home";
import { JoinAnswer } from "@hercule/protocol";
import { writeRunnerFile, type RunnerFile } from "./runner-file";

/** The join route is not in the operation table, so its path is written out here. */
const JOIN_PATH = "/api/v1/runners/join";

const STORAGE_NAME_BYTES = 8;

export class JoinError extends Schema.TaggedError<JoinError>()("JoinError", {
  message: Schema.String,
  /**
   * Whether trying again later can succeed. A controller that is not listening
   * yet is normal for the child spawned before the controller binds its port.
   * A rejected token does not get better by waiting.
   */
  retryable: Schema.Boolean,
}) {}

export interface JoinOptions {
  /** The URL exactly as the user typed it. */
  readonly controllerUrl: string;
  readonly token: string;
  readonly home: string;
  /** Whether this is a personal machine, which runs only work sent to it by name. */
  readonly reserved: boolean;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

export interface Joined {
  readonly runnerId: string;
  /** The name the controller assigned, which the owner may rename. */
  readonly name: string;
  readonly configPath: string;
  /** An absolute path. */
  readonly storageDirectory: string;
}

const decodeAnswer = Schema.decodeUnknownEffect(JoinAnswer);

const parseRefusalMessage = (status: number, body: string): string => {
  try {
    const envelope = JSON.parse(body) as { error?: { message?: unknown } };
    const message = envelope.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // The body is not JSON, so something other than a controller is
    // probably listening on that URL.
  }
  return `the controller responded with HTTP ${String(status)}`;
};

const requestJoin = (options: JoinOptions): Effect.Effect<JoinAnswer, JoinError> =>
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
          body: JSON.stringify({ reserved: options.reserved }),
        }),
      catch: (cause) =>
        new JoinError({ message: `cannot reach ${url}: ${String(cause)}`, retryable: true }),
    });
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new JoinError({
          message: `cannot read the response from ${url}: ${String(cause)}`,
          retryable: true,
        }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new JoinError({ message: parseRefusalMessage(response.status, body), retryable: false }),
      );
    }
    const parsed = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: () => new JoinError({ message: `${url} did not respond with JSON`, retryable: false }),
    });
    return yield* Effect.mapError(
      decodeAnswer(parsed),
      () =>
        new JoinError({
          message: `${url} sent a join response this version of the runner cannot parse`,
          retryable: false,
        }),
    );
  });

/**
 * Asks the controller to join this machine, then writes `runner.json` and
 * creates the storage directory. Returns the new runner's id and name and the
 * paths it wrote. Fails with a `JoinError` when the request fails or the files
 * cannot be written.
 *
 * The files are written only after the controller accepts the join, so a
 * rejected join leaves the Hercule Home unchanged.
 */
export const join = (options: JoinOptions): Effect.Effect<Joined, JoinError> =>
  Effect.gen(function* () {
    const answer = yield* requestJoin(options);
    const runnerDir = locateRunnerDir(options.home);
    const storageName = Buffer.from(
      crypto.getRandomValues(new Uint8Array(STORAGE_NAME_BYTES)),
    ).toString("hex");
    const storageDirectory = joinPath(runnerDir, storageName);
    const configPath = locateRunnerFile(options.home);
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
        writeRunnerFile(configPath, contents);
      },
      catch: (cause) =>
        new JoinError({
          message: `cannot write ${configPath}: ${String(cause)}`,
          retryable: false,
        }),
    });

    return { runnerId: answer.runnerId, name: answer.name, configPath, storageDirectory };
  });
