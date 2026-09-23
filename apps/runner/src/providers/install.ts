/**
 * Installs a harness on a machine. Every vendor ships an install script that
 * is piped from curl into a shell and pinned to the release this build
 * supports, so adapters differ only in the command.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MAX_INSTALL_MESSAGE_LENGTH } from "@hercule/protocol";
import type { InstallOutcome } from "./index";
import type { Run } from "./process";

/** Long enough to download and run a vendor's installer over a slow connection. */
export const INSTALL_DEADLINE: Duration.Duration = Duration.minutes(5);

const LAST_LINES = 5;

/**
 * Returns the last few lines of the installer's output, where it reports what
 * went wrong, cut to the length the protocol allows. Returns a fixed message
 * when the output is empty.
 */
export const takeLastLines = (output: string): string => {
  const said = output.trimEnd().split("\n").slice(-LAST_LINES).join("\n");
  return said === ""
    ? "the installer failed without saying why"
    : said.slice(-MAX_INSTALL_MESSAGE_LENGTH);
};

export const makeInstall =
  (run: Run, command: ReadonlyArray<string>) =>
  (env: Readonly<Record<string, string | undefined>>): Effect.Effect<InstallOutcome> =>
    Effect.map(
      Effect.timeoutOption(run(command, env), INSTALL_DEADLINE),
      Option.match({
        onNone: () => ({
          ok: false,
          message: `the installer did not finish within ${Duration.format(INSTALL_DEADLINE)}`,
        }),
        onSome: (ran) =>
          ran.code === 0
            ? { ok: true }
            : { ok: false, message: takeLastLines(ran.stderr === "" ? ran.stdout : ran.stderr) },
      }),
    );
