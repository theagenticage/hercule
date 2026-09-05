/**
 * `hydra runner --local`: the runner a controller spawns beside itself.
 *
 * It is an ordinary runner in every way but its first two seconds. A controller
 * that starts a child has no way to ask it who it is - `runner.json` belongs to
 * the runner, and a controller that read it would be a second reader of a file
 * with one owner - so the child says so itself, on the one pipe the two of them
 * share, before it does anything else. A machine that has never joined says that
 * instead, and is handed a single-use token back on its stdin: the one place a
 * token can travel that `ps` does not show and no grandchild inherits.
 *
 * After the handshake there is nothing local about it: the same join and the
 * same daemon as a machine somebody enlisted by hand.
 */
import { existsSync } from "node:fs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { LocalAnnouncement, LocalEnrolment } from "@hydra/protocol";
import { daemon } from "./daemon";
import { join, JoinError } from "./join";
import { readRunnerFile, runnerFileIn, type NotEnrolled } from "./runner-file";

/** How long the child waits between join attempts a retry might fix. */
const JOIN_RETRY_INTERVAL = Duration.millis(250);

const encodeAnnouncement = Schema.encodeUnknownSync(LocalAnnouncement);
const decodeEnrolment = Schema.decodeUnknownEffect(LocalEnrolment);

/**
 * Says one thing on stdout, as one line and nothing more. The controller reads
 * exactly this much and then leaves the pipe to whatever the runner logs, so a
 * second line here would be read as a second answer.
 */
const announce = (said: LocalAnnouncement): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(encodeAnnouncement(said))}\n`);
  });

/**
 * The first line the controller writes back, or nothing when it closes the pipe
 * without writing one. Reading stops at the newline rather than at end of file,
 * so a controller that holds the pipe open is not waited on.
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

/** Enlists this machine with what the controller handed it on stdin. */
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
    // are made against a listener that is not up yet. A refusal is not one of
    // those: a token the controller will not take is not a token time fixes.
    yield* join({
      controllerUrl: enrolment.controllerUrl,
      token: enrolment.token,
      home,
    }).pipe(
      Effect.retry({
        while: (error: JoinError) => error.retryable,
        schedule: Schedule.spaced(JOIN_RETRY_INTERVAL),
      }),
    );
  });

/** Runs the local runner: the handshake, then the ordinary daemon. */
export const local = (home: string): Effect.Effect<void, NotEnrolled | JoinError> =>
  Effect.gen(function* () {
    // Whether the file is there, not whether it reads: a machine holding a
    // `runner.json` nobody can parse should say so rather than quietly enlist
    // again and leave the row it already has behind.
    if (existsSync(runnerFileIn(home))) {
      const enrolled = yield* readRunnerFile(home);
      yield* announce({ runnerId: enrolled.runnerId });
    } else {
      yield* announce({ join: true });
      yield* enrol(home);
    }
    return yield* daemon(home);
  });
