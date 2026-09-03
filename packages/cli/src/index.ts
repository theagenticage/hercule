/**
 * The CLI role: every API-facing verb, spoken over HTTP only.
 *
 * `setup-url` is the one exception and always will be: it is a filesystem read
 * of `<home>/setup-url`, needing no credential, because it is what a user has
 * before they have any credential at all (spec 15 section 7).
 */
import { readFileSync } from "node:fs";
import { Result } from "effect";
import { parseGlobalOptions, resolveHomePath, setupUrlFileIn } from "@hydra/home";

/** What `hydra setup-url` prints, or the reason there is nothing to print. */
export function readSetupUrl(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Result.Result<string, string> {
  const options = parseGlobalOptions(argv);
  if (Result.isFailure(options)) {
    return Result.fail(`${options.failure.option}: ${options.failure.message}`);
  }
  const file = setupUrlFileIn(resolveHomePath(options.success.home, env));
  try {
    return Result.succeed(readFileSync(file, "utf8").trim());
  } catch {
    // The controller deletes the file the moment setup completes, so an absent
    // file is one of two ordinary states, never a crash.
    return Result.fail(
      `No setup URL in ${file}: either setup is already complete, or \`hydra serve\` has not run yet.`,
    );
  }
}

const USAGE = "usage: hydra <verb> [--home <dir>] [-c key=value]";

export function run(argv: readonly string[]): void {
  const options = parseGlobalOptions(argv);
  const verb = Result.isSuccess(options) ? options.success.rest[0] : undefined;

  if (verb !== "setup-url") {
    // Stub until the CLI ticket lands; the verbs it will carry are spec 15
    // section 2 and the public API of spec 11.
    console.log(["cli", ...argv].join(" "));
    if (verb === undefined) console.log(USAGE);
    return;
  }

  const url = readSetupUrl(argv, process.env);
  if (Result.isFailure(url)) {
    console.error(`hydra: ${url.failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(url.success);
}
