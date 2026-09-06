/**
 * `runner.json`: the runner's whole durable identity. Written and read only
 * here, and read decoded rather than cast, so a hand-edited file reads as a bad
 * file rather than an undefined credential.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runnerDirIn } from "@hydra/home";

/**
 * The controller URL is here rather than in `config.toml` because it is not a
 * bootstrap key: it is part of who this runner belongs to.
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

const RUNNER_FILE_NAME = "runner.json";

export const runnerFileIn = (home: string): string => joinPath(runnerDirIn(home), RUNNER_FILE_NAME);

export class NotEnrolled extends Schema.TaggedError<NotEnrolled>()("NotEnrolled", {
  message: Schema.String,
}) {}

const decode = Schema.decodeUnknownEffect(RunnerFile);

/**
 * Written to a fresh file and renamed over the target. `mode` applies only on
 * creation, so writing into an existing `runner.json` would hold a new
 * credential at whatever mode the old one had, and a half-written one would
 * leave the machine with neither credential, of which the controller keeps only
 * hashes.
 */
export const writeRunnerFile = (path: string, contents: RunnerFile): void => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

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
