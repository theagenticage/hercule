/**
 * Tests the runner's side of a text generation with fake adapters: how every
 * way the call can end becomes an outcome, that the call's scratch directory is
 * removed on every path, and that no more than the limit run at once.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Deferred, Duration, Effect, Fiber } from "effect";
import {
  MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER,
  type TextGenerationOutcome,
  type TextGenerationRequest,
} from "@hercule/protocol";
import type { HarnessAdapter, HarnessRunnerContext } from "./harnesses";
import { NO_CONTROLLER_UPLOADER, waitUntil } from "./harnesses/testing";
import { makeTextGenerator } from "./text-generation";

const BINARY = "/usr/local/bin/harness";

const REQUEST: TextGenerationRequest = {
  _tag: "textGenerationRequest",
  requestId: "request-1",
  harnessId: "fake",
  harnessAccount: {
    providerAccountId: "account-1",
    harnessHome: "providers/account-1",
    modelArgument: "{model}",
  },
  spec: {
    model: "fake-model",
    instructions: "Write a title.",
    input: "A conversation about tests.",
    outputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
};

const OK: TextGenerationOutcome = { outcome: "ok", value: { title: "Tests" }, usage: null };

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "hercule-text-generation-"));
});

afterEach(() => {
  chmodSync(scratchDir, 0o700);
  rmSync(scratchDir, { recursive: true, force: true });
});

/** Builds an adapter whose `generateText` is `generateText`; nothing else of it is used. */
const buildAdapter = (generateText: HarnessAdapter["generateText"]): HarnessAdapter =>
  ({ harnessId: "fake", binaryName: "harness", generateText }) as unknown as HarnessAdapter;

const buildContext = (binary: string | undefined): HarnessRunnerContext => ({
  cwd: null,
  attachmentsDir: null,
  editMarks: null,
  attachmentUploader: NO_CONTROLLER_UPLOADER,
  home: scratchDir,
  binary,
  env: {},
  modelArgument: "{model}",
  herculeTool: { orientation: "", skill: "", claudePluginDir: join(scratchDir, "claude-plugin") },
});

/** Builds the function under test around `adapter`. */
const buildGenerator = (
  adapter: HarnessAdapter | undefined,
  options: { readonly deadlineMillis?: number; readonly binary?: string | null } = {},
) =>
  makeTextGenerator({
    scratchDir,
    findAdapter: (harnessId) => (harnessId === "fake" ? adapter : undefined),
    // `null` means a machine without the binary.
    buildContext: () =>
      buildContext(options.binary === null ? undefined : (options.binary ?? BINARY)),
    deadline: Duration.millis(options.deadlineMillis ?? 5_000),
  });

/** Returns the failed message of an outcome, or fails the test when it is not `failed`. */
const readFailedMessage = (outcome: TextGenerationOutcome): string => {
  if (outcome.outcome !== "failed") throw new Error(`expected failed, got ${outcome.outcome}`);
  return outcome.message;
};

describe("the outcome of a text generation", () => {
  it("returns what the adapter returns", async () => {
    const generate = buildGenerator(buildAdapter(() => Effect.succeed(OK)));

    await expect(Effect.runPromise(generate(REQUEST))).resolves.toEqual(OK);
  });

  it("reports a timeout, and interrupts the adapter, when the call outlives the deadline", async () => {
    let interrupted = false;
    const generate = buildGenerator(
      buildAdapter(() =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
      ),
      { deadlineMillis: 50 },
    );

    await expect(Effect.runPromise(generate(REQUEST))).resolves.toEqual({ outcome: "timeout" });
    expect(interrupted).toBe(true);
  });

  it("fails when this build has no adapter for the harness", async () => {
    const generate = buildGenerator(undefined);

    const message = readFailedMessage(await Effect.runPromise(generate(REQUEST)));

    expect(message).toContain("fake");
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("fails, without making a scratch directory, when the machine has no binary", async () => {
    let called = false;
    const generate = buildGenerator(
      buildAdapter(() => {
        called = true;
        return Effect.succeed(OK);
      }),
      { binary: null },
    );

    await expect(Effect.runPromise(generate(REQUEST))).resolves.toEqual({
      outcome: "failed",
      message: "no harness on this machine",
    });
    expect(called).toBe(false);
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  it("fails with the adapter's message when the adapter fails", async () => {
    const generate = buildGenerator(buildAdapter(() => Effect.fail("could not start the harness")));

    await expect(Effect.runPromise(generate(REQUEST))).resolves.toEqual({
      outcome: "failed",
      message: "could not start the harness",
    });
  });

  it("fails with a message that is not empty when the adapter fails with an empty one", async () => {
    const generate = buildGenerator(buildAdapter(() => Effect.fail("")));

    const message = readFailedMessage(await Effect.runPromise(generate(REQUEST)));

    expect(message.length).toBeGreaterThan(0);
  });

  it("fails with a message that is not empty when the adapter returns an empty one", async () => {
    const generate = buildGenerator(
      buildAdapter(() => Effect.succeed({ outcome: "failed", message: "" })),
    );

    const message = readFailedMessage(await Effect.runPromise(generate(REQUEST)));

    expect(message.length).toBeGreaterThan(0);
  });

  it.each(["   ", "\n\t "])(
    "fails with a message that is not blank when the adapter fails with %j",
    async (blank) => {
      const generate = buildGenerator(buildAdapter(() => Effect.fail(blank)));

      const message = readFailedMessage(await Effect.runPromise(generate(REQUEST)));

      expect(message.trim()).not.toBe("");
    },
  );

  it("fails with a message that is not blank when the adapter returns a blank one", async () => {
    const generate = buildGenerator(
      buildAdapter(() => Effect.succeed({ outcome: "failed", message: " \n " })),
    );

    const message = readFailedMessage(await Effect.runPromise(generate(REQUEST)));

    expect(message.trim()).not.toBe("");
  });

  it("gives an invalid-output outcome a fixed reason, whatever the adapter reports", async () => {
    const generate = buildGenerator(
      buildAdapter(() =>
        Effect.succeed({
          outcome: "invalid-output",
          reason: "/PRIVATE_CUSTOMER_KEY_73dbfa must be a string",
        }),
      ),
    );

    const outcome = await Effect.runPromise(generate(REQUEST));

    expect(outcome.outcome).toBe("invalid-output");
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_CUSTOMER_KEY_73dbfa");
    expect(outcome.outcome === "invalid-output" && outcome.reason.trim()).not.toBe("");
  });

  it("fails, instead of failing the effect, when the adapter hits a defect", async () => {
    const generate = buildGenerator(buildAdapter(() => Effect.die(new Error("a bug"))));

    const message = readFailedMessage(await Effect.runPromise(generate(REQUEST)));

    expect(message).toContain("a bug");
  });
});

describe("the scratch directory of a text generation", () => {
  /** Runs one call with `behaviour` and returns the directory the adapter was given. */
  const runAndFindDirectory = async (
    behaviour: (cwd: string) => ReturnType<HarnessAdapter["generateText"]>,
    deadlineMillis = 5_000,
  ): Promise<string> => {
    let cwd = "";
    const generate = buildGenerator(
      buildAdapter((ctx) => {
        cwd = ctx.cwd;
        return behaviour(ctx.cwd);
      }),
      { deadlineMillis },
    );
    await Effect.runPromise(generate(REQUEST));
    return cwd;
  };

  it("is empty, readable by this user only, and inside the runner's scratch directory", async () => {
    let mode = 0;
    let parent = "";
    let entries = -1;
    await runAndFindDirectory((cwd) =>
      Effect.sync(() => {
        mode = statSync(cwd).mode & 0o777;
        parent = dirname(cwd);
        entries = readdirSync(cwd).length;
        return OK;
      }),
    );

    expect(mode).toBe(0o700);
    expect(parent).toBe(scratchDir);
    expect(entries).toBe(0);
  });

  it("is removed after an answer", async () => {
    const cwd = await runAndFindDirectory(() => Effect.succeed(OK));
    expect(existsSync(cwd)).toBe(false);
  });

  it("is removed, with the files the adapter wrote in it, after an adapter error", async () => {
    let wrote = false;
    const cwd = await runAndFindDirectory((dir) =>
      Effect.sync(() => {
        writeFileSync(join(dir, "file.txt"), "x");
        wrote = true;
      }).pipe(Effect.flatMap(() => Effect.fail("broken"))),
    );
    expect(wrote).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it("is removed after a defect", async () => {
    const cwd = await runAndFindDirectory(() => Effect.die(new Error("a bug")));
    expect(existsSync(cwd)).toBe(false);
  });

  it("is removed after a timeout", async () => {
    const cwd = await runAndFindDirectory(() => Effect.never, 50);
    expect(existsSync(cwd)).toBe(false);
  });

  it("is removed when the caller gives up", async () => {
    let cwd = "";
    const generate = buildGenerator(
      buildAdapter((ctx) => {
        cwd = ctx.cwd;
        return Effect.never;
      }),
    );
    const fiber = Effect.runFork(generate(REQUEST));
    await waitUntil("started the adapter", () => cwd !== "");
    expect(existsSync(cwd)).toBe(true);

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(existsSync(cwd)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "does not change the outcome when it cannot be removed",
    async () => {
      const generate = buildGenerator(
        buildAdapter(() =>
          // A runner scratch directory that cannot be written to makes the removal fail.
          Effect.sync(() => {
            chmodSync(scratchDir, 0o500);
            return OK;
          }),
        ),
      );

      await expect(Effect.runPromise(generate(REQUEST))).resolves.toEqual(OK);
    },
  );
});

describe("the limit on text generations at once", () => {
  const LIMIT = MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER;

  it("runs as many as the limit together, fails the next at once, and frees a slot when one ends", async () => {
    const gate = Deferred.makeUnsafe<void>();
    let running = 0;
    const generate = buildGenerator(
      buildAdapter(() =>
        Effect.suspend(() => {
          running += 1;
          return Deferred.await(gate).pipe(Effect.as(OK));
        }),
      ),
    );

    const calls = Array.from({ length: LIMIT }, () => Effect.runPromise(generate(REQUEST)));
    await waitUntil("started every call", () => running === LIMIT);

    const message = readFailedMessage(await Effect.runPromise(generate(REQUEST)));
    expect(message).toContain(String(LIMIT));
    expect(running).toBe(LIMIT);

    Deferred.doneUnsafe(gate, Effect.void);
    for (const outcome of await Promise.all(calls)) expect(outcome).toEqual(OK);

    await expect(Effect.runPromise(generate(REQUEST))).resolves.toEqual(OK);
  });

  describe("while the adapter is still stopping its harness", () => {
    /**
     * Starts `LIMIT` calls whose adapter, once it has its answer or is
     * interrupted, takes until `released` resolves to finish. Returns the
     * calls and the directories the adapter was given.
     */
    const startSlowlyStoppingCalls = (
      released: Promise<void>,
      behaviour: Effect.Effect<TextGenerationOutcome, string>,
      deadlineMillis = 5_000,
    ) => {
      const directories: Array<string> = [];
      const generate = buildGenerator(
        buildAdapter((ctx) =>
          Effect.suspend(() => {
            directories.push(ctx.cwd);
            return behaviour;
          }).pipe(Effect.ensuring(Effect.promise(() => released))),
        ),
        { deadlineMillis },
      );
      const calls = Array.from({ length: LIMIT }, () => Effect.runPromise(generate(REQUEST)));
      return { generate, calls, directories };
    };

    /** Fails the test unless the next call is refused and every directory still exists. */
    const expectSlotsAndDirectoriesHeld = async (
      generate: ReturnType<typeof buildGenerator>,
      directories: ReadonlyArray<string>,
    ) => {
      const refused = readFailedMessage(await Effect.runPromise(generate(REQUEST)));
      expect(refused).toContain(String(LIMIT));
      expect(directories).toHaveLength(LIMIT);
      for (const directory of directories) expect(existsSync(directory)).toBe(true);
    };

    it("keeps the slot and the directory after an answer", async () => {
      const released = Promise.withResolvers<void>();
      const { generate, calls, directories } = startSlowlyStoppingCalls(
        released.promise,
        Effect.succeed(OK),
      );
      await waitUntil("started every call", () => directories.length === LIMIT);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await expectSlotsAndDirectoriesHeld(generate, directories);

      released.resolve();
      for (const outcome of await Promise.all(calls)) expect(outcome).toEqual(OK);
      for (const directory of directories) expect(existsSync(directory)).toBe(false);
      await expect(Effect.runPromise(generate(REQUEST))).resolves.toEqual(OK);
    });

    it("keeps the slot and the directory after the deadline", async () => {
      const released = Promise.withResolvers<void>();
      const { generate, calls, directories } = startSlowlyStoppingCalls(
        released.promise,
        Effect.never,
        50,
      );
      await waitUntil("started every call", () => directories.length === LIMIT);

      // Well past the deadline, with the harness still not gone.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await expectSlotsAndDirectoriesHeld(generate, directories);

      released.resolve();
      for (const outcome of await Promise.all(calls))
        expect(outcome).toEqual({ outcome: "timeout" });
      for (const directory of directories) expect(existsSync(directory)).toBe(false);
      await expect(Effect.runPromise(generate(REQUEST))).resolves.toEqual({ outcome: "timeout" });
    });

    it("keeps the slot and the directory after the caller gives up", async () => {
      const released = Promise.withResolvers<void>();
      const directories: Array<string> = [];
      const generate = buildGenerator(
        buildAdapter((ctx) =>
          Effect.suspend(() => {
            directories.push(ctx.cwd);
            return Effect.never;
          }).pipe(Effect.ensuring(Effect.promise(() => released.promise))),
        ),
      );
      const fibers = Array.from({ length: LIMIT }, () => Effect.runFork(generate(REQUEST)));
      await waitUntil("started every call", () => directories.length === LIMIT);

      const interruptions = fibers.map((fiber) => Effect.runPromise(Fiber.interrupt(fiber)));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expectSlotsAndDirectoriesHeld(generate, directories);

      released.resolve();
      await Promise.all(interruptions);
      for (const directory of directories) expect(existsSync(directory)).toBe(false);
    });
  });
});
