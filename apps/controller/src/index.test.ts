import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { HerculeHomeError } from "./config";
import { explain, STILL_STOPPING, untilStopped } from "./index";

describe("explain", () => {
  it("says what Hercule was doing to the path, which is not always creating it", () => {
    const path = "/home/x/.hercule/setup-url";
    const cause = new Error("EACCES: permission denied");
    expect(explain(new HerculeHomeError({ action: "create", path, cause }))).toContain(
      `Cannot create ${path}`,
    );
    expect(explain(new HerculeHomeError({ action: "write", path, cause }))).toContain(
      `Cannot write ${path}`,
    );
    expect(explain(new HerculeHomeError({ action: "remove", path, cause }))).toContain(
      `Cannot remove ${path}`,
    );
    expect(explain(new HerculeHomeError({ action: "secure", path, cause }))).toContain(
      `Cannot secure ${path}`,
    );
    expect(explain(new HerculeHomeError({ action: "write", path, cause }))).toContain(
      "permission denied",
    );
  });
});

describe("the stop request", () => {
  /**
   * Emits a signal rather than sending it. `process.emit` runs the same
   * listeners `process.kill` would. Sending a real SIGTERM would kill the test
   * runner if the handler were ever removed too early, which is exactly the bug
   * these tests look for.
   */
  const sendSignal = (name: "SIGINT" | "SIGTERM"): void => {
    process.emit(name);
  };

  it("stops on the first signal, and handles every later one instead of dying", async () => {
    const said: Array<string> = [];
    const log = console.log;
    console.log = (line: unknown) => said.push(String(line));

    const before = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const stopped = yield* untilStopped;

            sendSignal("SIGTERM");
            yield* stopped;

            // The drain is under way. Both signals still reach Hercule's
            // handlers, which are still installed, and neither signal stops it
            // again.
            sendSignal("SIGTERM");
            sendSignal("SIGINT");
            yield* stopped;
          }),
        ),
      );
    } finally {
      console.log = log;
    }

    expect(said.filter((line) => line === STILL_STOPPING)).toHaveLength(2);
    // The handlers were removed when the scope closed, so a second boot in the
    // same process starts clean.
    expect(process.listenerCount("SIGTERM") + process.listenerCount("SIGINT")).toBe(before);
  });
});
