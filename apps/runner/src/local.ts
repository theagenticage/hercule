/**
 * `hercule runner --local`: an ordinary runner in every way but its first two
 * seconds.
 *
 * `runner.json` has one owner, so a controller cannot read who its child is; the
 * child says so itself on the pipe they share. A machine that has never joined
 * says that instead, and is handed a token back on stdin, the one place a token
 * travels that `ps` does not show and no grandchild inherits.
 */
import { existsSync } from "node:fs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { LocalAnnouncement, LocalEnrolment } from "@hercule/protocol";
import { daemon, type ToolingUnavailable } from "./daemon";
import type { RunnerRetired } from "./socket";
import { join, JoinError } from "./join";
import { readRunnerFile, runnerFileIn, type NotEnrolled } from "./runner-file";

const JOIN_RETRY_INTERVAL = Duration.millis(250);

const encodeAnnouncement = Schema.encodeUnknownSync(LocalAnnouncement);
const decodeEnrolment = Schema.decodeUnknownEffect(LocalEnrolment);

/**
 * One line and nothing more: the controller reads exactly this much and leaves
 * the pipe to the runner's logs, so a second line reads as a second answer.
 */
const announce = (said: LocalAnnouncement): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(encodeAnnouncement(said))}\n`);
  });

/**
 * Reading stops at the newline rather than at end of file, so a controller that
 * holds the pipe open is not waited on.
 */
const firstStdinLine = Effect.promise(async () => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of Bun.stdin.stream()) {
    text += decoder.decode(chunk, { stream: true });
    const newline = text.indexOf("\n");
    if (newline >= 0) return text.slice(0, newline);
  }
  return undefined;
});

const enrol = (home: string): Effect.Effect<void, JoinError> =>
  Effect.gen(function* () {
    const line = yield* firstStdinLine;
    if (line === undefined) {
      return yield* Effect.fail(
        new JoinError({
          message: "nothing wrote a join token to this runner's stdin",
          retryable: false,
        }),
      );
    }
    const enrolment = yield* Effect.mapError(
      Effect.flatMap(
        Effect.try({ try: () => JSON.parse(line) as unknown, catch: () => undefined }),
        decodeEnrolment,
      ),
      () => new JoinError({ message: "that is not a join this runner can make", retryable: false }),
    );
    // The controller spawns its runner before it binds, so the first attempts
    // meet a listener that is not up. A refusal is not one of those.
    yield* join({
      controllerUrl: enrolment.controllerUrl,
      token: enrolment.token,
      home,
      // The machine the controller is on takes whatever the fleet is given.
      reserved: false,
    }).pipe(
      Effect.retry({
        while: (error: JoinError) => error.retryable,
        schedule: Schedule.spaced(JOIN_RETRY_INTERVAL),
      }),
    );
  });

export const local = (
  home: string,
): Effect.Effect<void, NotEnrolled | JoinError | RunnerRetired | ToolingUnavailable> =>
  Effect.gen(function* () {
    // Whether the file is there, not whether it reads: a machine holding an
    // unparseable `runner.json` should say so rather than enlist again.
    if (existsSync(runnerFileIn(home))) {
      const enrolled = yield* readRunnerFile(home);
      yield* announce({ runnerId: enrolled.runnerId });
    } else {
      yield* announce({ join: true });
      yield* enrol(home);
    }
    return yield* daemon(home);
  });
