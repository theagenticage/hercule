/**
 * `runner.json`: everything this machine is, once it is a runner.
 *
 * The file is the runner's whole durable identity - the credential it holds its
 * connection with, the controller it belongs to, and the name of the storage
 * directory this enrolment owns. `./join.ts` is the only writer; everything
 * else reads it through here, decoded rather than cast, because a file somebody
 * edited by hand should read as a bad file rather than as a runner with an
 * undefined credential.
 */
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runnerDirIn } from "@hydra/home";

/**
 * Everything `runner.json` holds. The controller URL is here rather than in
 * `config.toml` because it is not a bootstrap key: it is part of who this
 * runner belongs to, and `hydra runner set-controller` is what changes it.
 */
export const RunnerFile = Schema.Struct({
  runnerId: Schema.String,
  credential: Schema.String,
  controllerUrl: Schema.String,
  controllerIdentityId: Schema.String,
  controllerPublicKey: Schema.String,
  /** The directory's name, not its path: the home it sits in can move. */
  storageDirectory: Schema.String,
});

export type RunnerFile = Schema.Schema.Type<typeof RunnerFile>;

/** The file that holds what this runner is, once it is one. */
const RUNNER_FILE_NAME = "runner.json";

/** Where `runner.json` sits in a Hydra Home. */
export const runnerFileIn = (home: string): string => joinPath(runnerDirIn(home), RUNNER_FILE_NAME);

/** This machine has not joined a controller, or cannot say what it joined. */
export class NotEnrolled extends Schema.TaggedError<NotEnrolled>()("NotEnrolled", {
  message: Schema.String,
}) {}

const decode = Schema.decodeUnknownEffect(RunnerFile);

/** What this machine joined, or why that cannot be read. */
export const readRunnerFile = (home: string): Effect.Effect<RunnerFile, NotEnrolled> =>
  Effect.gen(function* () {
    const path = runnerFileIn(home);
    const raw = yield* Effect.try({
      try: () => JSON.parse(readFileSync(path, "utf8")) as unknown,
      catch: () =>
        new NotEnrolled({
          message: `cannot read ${path}. Run \`hydra runner join <controller-url> --token <token>\` first.`,
        }),
    });
    return yield* Effect.mapError(
      decode(raw),
      () => new NotEnrolled({ message: `${path} is not a runner's configuration` }),
    );
  });
