/**
 * Joins this machine to a controller. Both callers use `join`: the `hercule
 * runner join` command, through `runJoinCommand`, and the child process a
 * controller spawns. A second implementation would drift apart from the first.
 *
 * The storage directory gets a random name. So a machine that joins again gets
 * a fresh directory: it never opens the workspaces of its previous
 * registration, and never deletes them either.
 */
import { mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { holdsControllerDatabase, locateRunnerDir, locateRunnerFile } from "@hercule/home";
import { JoinAnswer } from "@hercule/protocol";
import {
  describeStatus,
  installService,
  prepareServiceInstall,
  type ServiceError,
  type ServiceInstallRequest,
  type Supervisor,
} from "@hercule/service";
import { parseErrorEnvelopeMessage } from "./error-envelope";
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
        new JoinError({
          message:
            parseErrorEnvelopeMessage(body) ??
            `the controller responded with HTTP ${String(response.status)}`,
          retryable: false,
        }),
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

/** What `hercule runner join` was asked to do, and where its output goes. */
export interface JoinCommandOptions extends JoinOptions {
  /**
   * The service unit to install once this machine has joined, and the
   * Supervisor that installs it, or `undefined` with `--no-service`.
   */
  readonly service:
    | {
        readonly request: ServiceInstallRequest;
        readonly supervisor: Layer.Layer<Supervisor, ServiceError>;
      }
    | undefined;
  /** Writes one line for the person running the command. */
  readonly out: (line: string) => void;
}

/** Returns `text` with a full stop at the end, unless it already ends a sentence. */
const endSentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * Runs `hercule runner join`: joins this machine, then installs the runner's
 * service unit unless `options.service` is `undefined`, and prints what it did
 * and the service's status. Fails with a `JoinError` whose message says what
 * to do next.
 *
 * Every refusal it can know about runs before the join, because the join
 * spends the token and a second try needs a new one:
 *
 * - a Hercule Home that holds a controller database is refused, even without
 *   a service, because its `runner.json` belongs to the controller's own
 *   runner, which would then dial the other controller;
 * - a `config.toml` that cannot be used is refused, because the runner daemon
 *   would fail on it the same way;
 * - every check `installService` runs, and the Supervisor's `prepare`, runs
 *   before the join when a service is to be installed.
 */
export const runJoinCommand = (options: JoinCommandOptions): Effect.Effect<void, JoinError> =>
  Effect.gen(function* () {
    const refuse = (message: string) => new JoinError({ message, retryable: false });
    const service = options.service;

    if (
      yield* Effect.mapError(holdsControllerDatabase(options.home), (error) =>
        refuse(error.message),
      )
    ) {
      return yield* refuse(
        `The Hercule Home ${options.home} holds a controller database, and its runner.json belongs to the controller's own runner, so joining would point that runner at another controller. To make this machine a separate runner, give it its own Home with --home.`,
      );
    }
    if (service !== undefined) {
      yield* prepareServiceInstall(service.request).pipe(
        Effect.provide(service.supervisor),
        Effect.mapError((error) =>
          refuse(
            `${endSentence(error.message)} To join without installing the service, add --no-service.`,
          ),
        ),
      );
    }

    const joined = yield* join(options);
    options.out(`This machine joined as ${joined.name}.`);
    options.out(`Its credential is in ${joined.configPath}.`);
    if (service === undefined) return;

    // The wait for a started runner can take half a minute.
    options.out("Installing the service unit for `hercule runner`.");
    const status = yield* installService(service.request).pipe(
      Effect.provide(service.supervisor),
      Effect.mapError((error) =>
        refuse(
          `The service was not installed. ${endSentence(error.message)} This machine has joined, so once that is fixed, run \`hercule service install\` rather than joining again.`,
        ),
      ),
    );
    options.out(describeStatus(status));
  });
