/**
 * Runs `hercule runner --local`: an ordinary runner, except for how it starts.
 *
 * Only the runner reads `runner.json`, so the controller cannot read which
 * runner its child process is. Instead the child writes its runner id to the
 * pipe they share. A machine that has never joined writes that instead, and
 * the controller sends a join token back on stdin. Stdin is the one channel
 * that `ps` does not show and that no grandchild process inherits. Once that
 * join succeeds, the child writes the runner id it was given as a second line,
 * so the controller knows its local runner without waiting for a restart.
 */
import { existsSync } from "node:fs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { locateRunnerFile } from "@hercule/home";
import { LocalAnnouncement, LocalEnrolment } from "@hercule/protocol";
import { runDaemon, type ToolingUnavailable } from "./daemon";
import type { RunnerRetired } from "./socket";
import { join, JoinError } from "./join";
import { readRunnerFile, type NotEnrolled } from "./runner-file";

const JOIN_RETRY_INTERVAL = Duration.millis(250);

const encodeAnnouncement = Schema.encodeUnknownSync(LocalAnnouncement);
const decodeEnrolment = Schema.decodeUnknownEffect(LocalEnrolment);

/**
 * Writes one announcement to stdout as a single line. The controller reads the
 * first line, and a second one only after a request to join; everything after
 * that is copied to its logs, so a third announcement would be read as log
 * output.
 */
const announce = (said: LocalAnnouncement): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(encodeAnnouncement(said))}\n`);
  });

/**
 * Reads the first line of stdin, or `undefined` when stdin closes first.
 * Reading stops at the newline instead of end of file, because the controller
 * keeps the pipe open.
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

/**
 * Reads the join request the controller writes on stdin, joins with it, and
 * returns the runner id the join gave this machine. Fails with a `JoinError`
 * when stdin closes first, when the request cannot be read, or when the
 * controller refuses the join.
 */
const enrol = (home: string): Effect.Effect<string, JoinError> =>
  Effect.gen(function* () {
    const line = yield* firstStdinLine;
    if (line === undefined) {
      return yield* Effect.fail(
        new JoinError({
          message: "stdin closed before a join request arrived",
          retryable: false,
        }),
      );
    }
    const enrolment = yield* Effect.mapError(
      Effect.flatMap(
        Effect.try({ try: () => JSON.parse(line) as unknown, catch: () => undefined }),
        decodeEnrolment,
      ),
      () =>
        new JoinError({
          message:
            "the join request on stdin is invalid: expected JSON with a controller URL and a token",
          retryable: false,
        }),
    );
    // The controller spawns its runner before it binds its port, so the first
    // attempts may find nothing listening. Retry only those failures, not a
    // rejected join.
    const joined = yield* join({
      controllerUrl: enrolment.controllerUrl,
      token: enrolment.token,
      home,
      // The controller's own machine takes any work the fleet is given.
      reserved: false,
    }).pipe(
      Effect.retry({
        while: (error: JoinError) => error.retryable,
        schedule: Schedule.spaced(JOIN_RETRY_INTERVAL),
      }),
    );
    return joined.runnerId;
  });

export const runLocalRunner = (
  home: string,
): Effect.Effect<void, NotEnrolled | JoinError | RunnerRetired | ToolingUnavailable> =>
  Effect.gen(function* () {
    // Check whether the file exists, not whether it parses: a machine with an
    // invalid `runner.json` should report the error instead of joining again.
    if (existsSync(locateRunnerFile(home))) {
      const enrolled = yield* readRunnerFile(home);
      yield* announce({ runnerId: enrolled.runnerId });
    } else {
      yield* announce({ join: true });
      yield* announce({ runnerId: yield* enrol(home) });
    }
    return yield* runDaemon(home);
  });
