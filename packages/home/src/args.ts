import { Result, Schema } from "effect";

/** A malformed global option on the command line (`--home`, `-c key=value`). */
export class InvalidOptionError extends Schema.TaggedError<InvalidOptionError>()(
  "InvalidOptionError",
  { option: Schema.String, message: Schema.String },
) {}

/** The two global options, stripped from `argv` before a role reads it. */
export interface GlobalOptions {
  /** `--home <dir>` / `--home=<dir>` / `HERCULE_HOME`; the last one on the line wins. */
  readonly home: string | undefined;
  /** `-c key=value`, in the order given; a repeated key is decided by the last one. */
  readonly overrides: ReadonlyArray<readonly [key: string, value: string]>;
  /** Everything that is not a global option, in order. */
  readonly rest: ReadonlyArray<string>;
  /**
   * Where `rest[0]` sat in `argv`, or `argv.length` when there is no such
   * token. The dispatcher routes on the verb and hands the role the rest of the
   * line untouched, so it needs the position and not just the token.
   */
  readonly verbIndex: number;
}

/**
 * Split `argv` into the global options and the arguments the role reads.
 *
 * `--home <dir>` locates the config file and `-c key=value` overrides any
 * bootstrap key; both may appear anywhere on the line, because the dispatcher
 * hands them to the role along with the role's own arguments.
 *
 * Pure, and free of the database by construction: the dispatcher routes on it,
 * the CLI resolves its home with it, and the runner will too - and neither the
 * dispatcher nor the runner links controller state.
 */
export function parseGlobalOptions(
  argv: ReadonlyArray<string>,
): Result.Result<GlobalOptions, InvalidOptionError> {
  let home: string | undefined;
  const overrides: Array<readonly [string, string]> = [];
  const rest: Array<string> = [];
  let verbIndex = argv.length;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--home") {
      const value = argv[++i];
      if (value === undefined) {
        return Result.fail(
          new InvalidOptionError({ option: token, message: "--home needs a directory" }),
        );
      }
      home = value;
    } else if (token.startsWith("--home=")) {
      home = token.slice("--home=".length);
      if (home === "") {
        return Result.fail(
          new InvalidOptionError({ option: token, message: "--home needs a directory" }),
        );
      }
    } else if (token === "-c") {
      const assignment = argv[++i];
      if (assignment === undefined) {
        return Result.fail(
          new InvalidOptionError({ option: token, message: "-c needs key=value" }),
        );
      }
      const separator = assignment.indexOf("=");
      if (separator <= 0) {
        return Result.fail(
          new InvalidOptionError({
            option: `-c ${assignment}`,
            message: "an override is written key=value",
          }),
        );
      }
      overrides.push([assignment.slice(0, separator), assignment.slice(separator + 1)]);
    } else {
      if (rest.length === 0) verbIndex = i;
      rest.push(token);
    }
  }

  return Result.succeed({ home, overrides, rest, verbIndex });
}
