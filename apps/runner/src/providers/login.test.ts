/**
 * Logging a provider instance in, from the runner's side.
 *
 * The vendor's `claude auth login` is a child process that prints a URL, then
 * blocks on stdin waiting for the code the user pastes back from the browser.
 * It is reached through an injected spawn seam, so what the runner makes of a
 * child that prints a URL, complains about a code, or is left open for ever can
 * be stated without a browser, a network or an account.
 *
 * The ten-minute idle limit is asserted as the exported constant and driven on
 * a `TestClock`, which is the only way to wait it out.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { claudeCode } from "./claude-code";
import { COMPLAINT_GRACE, LOGIN_IDLE, logins, type LoginChild, type LoginSpawn } from "./login";
import type { ProviderRunnerContext } from "./index";

const INSTANCE = "0199e0e7-0000-7000-8000-00000000000a";

const CONTEXT: ProviderRunnerContext = {
  home: `/var/hydra/runner/providers/${INSTANCE}`,
  binary: "/usr/local/bin/claude",
  env: { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/rogier" },
};

/** The authorize URL the CLI prints, as it prints it. */
const URL_ONE = "https://claude.ai/oauth/authorize?code=challenge-one";
const URL_TWO = "https://claude.ai/oauth/authorize?code=challenge-two";

/** What the CLI says about a code that was not pasted whole. */
const INVALID = "Invalid code. Please make sure the full code was copied.";

/** A pipe a test pushes chunks onto, the way a child writes to one. */
const pipe = () => {
  const chunks: Array<string> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const stream = async function* (): AsyncIterable<string> {
    for (;;) {
      while (chunks.length > 0) yield chunks.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  return {
    stream: stream(),
    write: (text: string) => {
      chunks.push(text);
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
  };
};

/** One login child, and everything a test needs to play it and read it back. */
interface Fake {
  readonly child: LoginChild;
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** What the child printed to stdout, and to stderr. */
  readonly says: (line: string) => void;
  readonly complains: (line: string) => void;
  /** Everything written to the child's stdin, in order. */
  readonly stdin: ReadonlyArray<string>;
  readonly exit: (code: number) => void;
  readonly killed: () => boolean;
}

/** A machine whose logins are played by the test rather than really spawned. */
const machine = () => {
  const children: Array<Fake> = [];
  const spawn: LoginSpawn = (command, env) => {
    const out = pipe();
    const err = pipe();
    const stdin: Array<string> = [];
    let settle: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      settle = resolve;
    });
    let killed = false;
    const ends = (code: number): void => {
      out.end();
      err.end();
      settle(code);
    };
    const child: LoginChild = {
      stdout: out.stream,
      stderr: err.stream,
      write: (text) => stdin.push(text),
      // A killed child's pipes need not reach their end before its exit does,
      // so this fake never ends them: it is the pessimistic case, and it is
      // what makes the driver's own wait on the exit load-bearing.
      kill: () => {
        killed = true;
        settle(143);
      },
      exited,
    };
    children.push({
      child,
      command,
      env,
      stdin,
      says: out.write,
      complains: err.write,
      exit: ends,
      killed: () => killed,
    });
    return child;
  };
  return { spawn, children };
};

/** Runs an effect on a clock a test can move. */
const run = <A>(effect: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

describe("starting a login", () => {
  it("spawns the vendor's login against the instance's own config directory", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => {
          children[0]!.says(`Opening browser to sign in…\n${URL_ONE}\n`);
        });
        return yield* Fiber.join(starting);
      }),
    );

    expect(answer).toEqual({ _tag: "loginUrl", url: URL_ONE });
    const started = children[0]!;
    expect(started.command.join(" ")).toContain("auth login");
    expect(started.command[0]).toBe(CONTEXT.binary);
    // The credential this login writes belongs to this instance and to nothing
    // else, and the user's own `~/.claude` is never touched.
    expect(started.env["CLAUDE_CONFIG_DIR"]).toBe(CONTEXT.home);
    expect(started.env["HOME"]).toBe(CONTEXT.env["HOME"]);
    // A browser launch that succeeds makes the CLI switch to a localhost
    // callback, which a browser on another machine can never reach.
    expect(started.env["BROWSER"]).toBe("false");
  });

  it("answers with the first URL and ignores whatever the child prints after it", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => {
          children[0]!.says(`${URL_ONE}\n${URL_TWO}\nPaste code here if prompted > `);
        });
        return yield* Fiber.join(starting);
      }),
    );

    expect(answer).toEqual({ _tag: "loginUrl", url: URL_ONE });
  });

  it("takes the address out of the terminal hyperlink the vendor prints it in", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => {
          // OSC 8: the target sits inside the escape, beside a visible copy.
          children[0]!.says(`\u001b]8;;${URL_ONE}\u0007${URL_ONE}\u001b]8;;\u0007\n`);
        });
        return yield* Fiber.join(starting);
      }),
    );

    expect(answer).toEqual({ _tag: "loginUrl", url: URL_ONE });
  });

  it("kills the login it was already holding for that instance", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    const second = await run(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\n`));
        yield* Fiber.join(first);

        const next = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[1]!.says(`${URL_TWO}\n`));
        return yield* Fiber.join(next);
      }),
    );

    // The code a user pastes is only good for the URL of the child that printed
    // it, so two logins for one instance cannot both be waiting.
    expect(children[0]!.killed()).toBe(true);
    expect(second).toEqual({ _tag: "loginUrl", url: URL_TWO });
  });

  it("says what the child said when it ended without printing a URL", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => {
          children[0]!.complains("claude: could not reach platform.claude.com\n");
          children[0]!.exit(1);
        });
        return yield* Fiber.join(starting);
      }),
    );

    expect(answer).toMatchObject({ _tag: "loginFailed" });
    expect((answer as { message: string }).message).toContain("could not reach");
  });
});

describe("submitting a login code", () => {
  /** Gets a login as far as the child prompting for the code. */
  const waiting = (driver: ReturnType<typeof logins>, children: ReadonlyArray<Fake>) =>
    Effect.gen(function* () {
      const starting = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
      yield* TestClock.adjust(Duration.zero);
      yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\nPaste code here if prompted > `));
      yield* Fiber.join(starting);
    });

  it("writes the code to the child's stdin and reports the login it finished", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        yield* waiting(driver, children);
        const submitting = yield* Effect.forkChild(driver.submit(INSTANCE, "the-pasted-code"));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.exit(0));
        return yield* Fiber.join(submitting);
      }),
    );

    // A newline, because the CLI is reading a line: without it the child waits
    // for ever on a code it has already been given.
    expect(children[0]!.stdin.join("")).toBe("the-pasted-code\n");
    expect(answer).toEqual({ _tag: "loginResult", ok: true });
  });

  it("hands back the CLI's own complaint and keeps the child for another try", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    const [refused, accepted] = await run(
      Effect.gen(function* () {
        yield* waiting(driver, children);

        const first = yield* Effect.forkChild(driver.submit(INSTANCE, "half-a-code"));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.complains(`${INVALID}\n`));
        // A complaint is a refusal once the child has proved it is staying.
        yield* TestClock.adjust(COMPLAINT_GRACE);
        const refused = yield* Fiber.join(first);

        // The child is still up and still prompting, so the user gets another
        // go without starting the whole exchange again.
        const second = yield* Effect.forkChild(driver.submit(INSTANCE, "the-whole-code"));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.exit(0));
        return [refused, yield* Fiber.join(second)] as const;
      }),
    );

    expect(refused).toMatchObject({ _tag: "loginResult", ok: false });
    expect((refused as { message: string }).message).toContain("Invalid code");
    expect(children[0]!.killed()).toBe(false);
    expect(children[0]!.stdin.join("")).toBe("half-a-code\nthe-whole-code\n");
    expect(accepted).toEqual({ _tag: "loginResult", ok: true });
  });

  it("has nothing to hand a code to when no login is in progress", async () => {
    const { spawn, children } = machine();

    const answer = await run(logins(spawn).submit(INSTANCE, "a-code"));

    expect(answer).toMatchObject({ _tag: "loginFailed" });
    expect((answer as { message: string }).message).toContain("no login in progress");
    expect(children).toEqual([]);
  });

  it("kills a login nobody ever finished, and has nothing to submit to after", async () => {
    expect(Duration.toMinutes(LOGIN_IDLE)).toBe(10);
    const { spawn, children } = machine();
    const driver = logins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        yield* waiting(driver, children);
        // A tab closed on the URL leaves the CLI blocked on stdin for the life
        // of the daemon.
        yield* TestClock.adjust(LOGIN_IDLE);
        return yield* driver.submit(INSTANCE, "a-code-from-yesterday");
      }),
    );

    expect(children[0]!.killed()).toBe(true);
    expect(answer).toMatchObject({ _tag: "loginFailed" });
  });
});

describe("more than one login at a time", () => {
  it("does not let a replaced login take the one that replaced it down", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    // Two tabs, or the Sessions button and the Fleet row: the first start is
    // still waiting for a URL when the second arrives.
    const [first, second] = await run(
      Effect.gen(function* () {
        const one = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        const two = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[1]!.says(`${URL_TWO}\n`));
        return [yield* Fiber.join(one), yield* Fiber.join(two)] as const;
      }),
    );

    expect(first).toMatchObject({ _tag: "loginFailed" });
    expect(second).toEqual({ _tag: "loginUrl", url: URL_TWO });
    expect(children[1]!.killed()).toBe(false);

    // And the surviving login is the one a pasted code reaches.
    const answer = await run(
      Effect.gen(function* () {
        const submitting = yield* Effect.forkChild(driver.submit(INSTANCE, "the-whole-code"));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[1]!.exit(0));
        return yield* Fiber.join(submitting);
      }),
    );

    expect(answer).toEqual({ _tag: "loginResult", ok: true });
  });

  it("ends the logins it is holding when the runner stops", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\n`));
        yield* Fiber.join(starting);
        // A vendor blocked on stdin does not notice the daemon is gone, and it
        // is holding a prompt for a credential.
        yield* driver.stopAll;
      }),
    );

    expect(children[0]!.killed()).toBe(true);
  });

  it("has nothing to paste into once the vendor has given up on its own", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\n`));
        yield* Fiber.join(starting);
        yield* Effect.sync(() => children[0]!.exit(1));
        yield* TestClock.adjust(Duration.zero);
        return yield* driver.submit(INSTANCE, "a-code");
      }),
    );

    expect(answer).toMatchObject({ _tag: "loginFailed" });
    expect((answer as { message: string }).message).toContain("no login in progress");
  });

  it("reads a login that finished as one that worked, whatever it said on the way out", async () => {
    const { spawn, children } = machine();
    const driver = logins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(driver.start(INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\n`));
        yield* Fiber.join(starting);

        const submitting = yield* Effect.forkChild(driver.submit(INSTANCE, "the-whole-code"));
        yield* TestClock.adjust(Duration.zero);
        // A vendor writes to stderr on its way out for reasons of its own.
        yield* Effect.sync(() => {
          children[0]!.complains("\n(node:412) ExperimentalWarning: something\n");
          children[0]!.exit(0);
        });
        yield* TestClock.adjust(COMPLAINT_GRACE);
        return yield* Fiber.join(submitting);
      }),
    );

    expect(answer).toEqual({ _tag: "loginResult", ok: true });
  });
});
