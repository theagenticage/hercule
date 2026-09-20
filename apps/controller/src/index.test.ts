import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { HerculeHomeError } from "./config";
import { explain, STILL_STOPPING, untilStopped } from "./index";

describe("explain", () => {
  it("says what Hercule was doing to the path, not always creating it", () => {
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
   * The signals are emitted rather than sent. `process.emit` runs the same
   * listeners `process.kill` would; sending a real SIGTERM to the test runner
   * would take the runner down with it if the handler ever came off early,
   * which is precisely the failure this is about.
   */
  const signal = (name: "SIGINT" | "SIGTERM"): void => {
    process.emit(name);
  };

  it("stops on the first signal, and answers every later one instead of dying", async () => {
    const said: Array<string> = [];
    const log = console.log;
    console.log = (line: unknown) => said.push(String(line));

    const before = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const stopped = yield* untilStopped;

            signal("SIGTERM");
            yield* stopped;

            // The drain is under way. Both signals still land on Hercule - the
            // handlers are still installed - and neither of them stops it
            // again.
            signal("SIGTERM");
            signal("SIGINT");
            yield* stopped;
          }),
        ),
      );
    } finally {
      console.log = log;
    }

    expect(said.filter((line) => line === STILL_STOPPING)).toHaveLength(2);
    // And the handlers came off with the scope, so a second boot in one
    // process starts from nothing.
    expect(process.listenerCount("SIGTERM") + process.listenerCount("SIGINT")).toBe(before);
  });
});
