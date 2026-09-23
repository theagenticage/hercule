/**
 * Reads and writes `runner.json`, which holds the runner's durable identity.
 * Only this module touches the file. It decodes the file with a schema instead
 * of casting it, so a hand-edited file fails as an invalid file instead of
 * producing an undefined credential.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { locateRunnerDir } from "@hercule/home";

export const CONTROLLER_URL_SCHEMES: ReadonlyArray<string> = ["http:", "https:"];

/**
 * The contents of `runner.json`.
 *
 * The controller URL is stored here instead of in `config.toml` because it is
 * not a bootstrap key: it records which controller this runner belongs to.
 *
 * The URL is a plain string, not a validated URL. `set-controller` is how the
 * user fixes a runner whose URL does not parse, so an invalid URL must not
 * stop the rest of the file from being read.
 */
export const RunnerFile = Schema.Struct({
  runnerId: Schema.String,
  credential: Schema.String,
  controllerUrl: Schema.String,
  controllerIdentityId: Schema.String,
  controllerPublicKey: Schema.String,
  /** The directory's name, not its path, because the Hercule Home can move. */
  storageDirectory: Schema.String,
});

export type RunnerFile = Schema.Schema.Type<typeof RunnerFile>;

const RUNNER_FILE_NAME = "runner.json";

export const buildRunnerFilePath = (home: string): string =>
  joinPath(locateRunnerDir(home), RUNNER_FILE_NAME);

export class NotEnrolled extends Schema.TaggedError<NotEnrolled>()("NotEnrolled", {
  message: Schema.String,
}) {}

/**
 * Writes `runner.json` to a new temporary file and renames it over `path`.
 * Throws when the write or the rename fails.
 *
 * Writing into the existing file instead would cause two problems:
 *
 * - `mode` applies only when a file is created, so the new credential would
 *   keep whatever mode the old file had;
 * - a half-written file would lose both the old and the new credential, and
 *   the controller keeps only their hashes.
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
    const path = buildRunnerFilePath(home);
    const raw = yield* Effect.try({
      try: () => JSON.parse(readFileSync(path, "utf8")) as unknown,
      catch: () =>
        new NotEnrolled({
          message: `cannot read ${path}. Run \`hercule runner join <controller-url> --token <token>\` first.`,
        }),
    });
    return yield* Effect.mapError(
      Schema.decodeUnknownEffect(RunnerFile, { errors: "all" })(raw),
      (error) =>
        new NotEnrolled({
          message: `${path} is not a valid runner configuration: ${error.message}`,
        }),
    );
  });
