/**
 * Putting a harness on a machine. Every vendor ships the same shape - a script
 * curled into a shell, pinned to the release this build talks to - so what
 * differs between adapters is the command and nothing else.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MAX_INSTALL_MESSAGE_LENGTH } from "@hercule/protocol";
import type { InstallOutcome } from "./index";
import type { Run } from "./process";

/** Downloading and running somebody else's installer over a slow link. */
export const INSTALL_DEADLINE: Duration.Duration = Duration.minutes(5);

const LAST_LINES = 5;

/** What the installer said last, which is where it says what went wrong. */
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
