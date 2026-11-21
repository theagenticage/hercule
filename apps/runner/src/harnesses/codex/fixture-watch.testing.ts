/**
 * A watch on the events an adapter emits, for the tests that drive a real
 * Codex and wait for what it does.
 */
import { Effect, Fiber, Stream } from "effect";
import { onTestFailed, onTestFinished } from "vitest";
import type { HarnessEvent } from "@hercule/protocol";

/**
 * Lists the tags of the events seen so far, with the text of each warning, the
 * subagent each event belongs to, and the state of each completed turn, so a
 * test that hangs shows what Codex reported on the way.
 */
const describeEvents = (seen: ReadonlyArray<HarnessEvent>): string =>
  seen
    .map((event) => {
      if (event._tag === "runtime.warning") return `runtime.warning (${event.message})`;
      const subagent = "subagentId" in event ? ` ${event.subagentId ?? "root"}` : "";
      const state = event._tag === "turn.completed" ? ` ${event.state}` : "";
      const usage =
        event._tag === "session.usage.updated"
          ? ` ${(event.usage ?? event.usageReport.counts).inputTokens} input tokens`
          : "";
      return `${event._tag}${subagent}${state}${usage}`;
    })
    .join(", ");

/** What a test reads from, and waits on, while it drives a real Codex. */
export interface FixtureWatch {
  /** The events recorded so far, in the order the adapter emitted them. */
  readonly seen: Array<HarnessEvent>;
  /** Starts recording an adapter's events. A test records one stream at a time. */
  readonly record: (events: Stream.Stream<HarnessEvent>) => void;
  /** Stops recording, and returns once the recording has stopped. */
  readonly stopRecording: () => Promise<void>;
  /**
   * Checks the pending waits again. A fixture whose state a wait reads, such
   * as the mock model or a wrapped app-server, calls this after each change;
   * a recorded event checks them on its own.
   */
  readonly changed: () => void;
  /** Returns once `holds` returns true. `what` names the wait if the test fails. */
  readonly until: (what: string, holds: () => boolean) => Promise<void>;
}

/**
 * Creates the watch for the current test, which must call it from inside its
 * body. A wait is checked when its condition can have changed: on each
 * recorded event and on each `changed()` call. It never polls and has no
 * deadline of its own, so a slow machine only makes a test slower. A hang is
 * caught by the test's own timeout. The watch then logs what each pending wait
 * was waiting for and every event seen, and fails the waits, so the test's
 * `finally` starts to stop its session and its mock model. Vitest does not
 * wait for that `finally`: after a hang, the next test can start while it
 * still runs. The recording stops when the test finishes.
 */
export const createFixtureWatch = (): FixtureWatch => {
  const seen: Array<HarnessEvent> = [];
  const waits = new Set<{
    readonly what: string;
    readonly holds: () => boolean;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }>();
  let recording: Fiber.Fiber<void> | undefined;
  const changed = () => {
    for (const wait of waits) {
      if (!wait.holds()) continue;
      waits.delete(wait);
      wait.resolve();
    }
  };
  const stopRecording = async () => {
    if (recording === undefined) return;
    await Effect.runPromise(Fiber.interrupt(recording));
    recording = undefined;
  };
  onTestFailed(() => {
    for (const wait of waits) {
      const error = new Error(`still waiting for ${wait.what}; saw ${describeEvents(seen)}`);
      console.error(error.message);
      wait.reject(error);
    }
    waits.clear();
  });
  onTestFinished(stopRecording);
  return {
    seen,
    record: (events) => {
      recording = Effect.runFork(
        Stream.runForEach(events, (event) =>
          Effect.sync(() => {
            seen.push(event);
            changed();
          }),
        ),
      );
    },
    stopRecording,
    changed,
    until: (what, holds) =>
      holds()
        ? Promise.resolve()
        : new Promise((resolve, reject) => void waits.add({ what, holds, resolve, reject })),
  };
};
