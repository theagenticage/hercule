/**
 * Tests logging a provider instance in, with a stubbed spawn function. The
 * vendor's `claude auth login` prints a URL, then waits on stdin for the code
 * the user pastes back from the browser.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import { claudeCode } from "./claude-code";
import { codex } from "./codex/adapter";
import {
  COMPLAINT_GRACE,
  LOGIN_CODE_LIFETIME,
  LOGIN_IDLE,
  makeLogins,
  type LoginAnswer,
  type LoginChild,
  type LoginSpawn,
} from "./login";
import type { ProviderRunnerContext } from "./index";
import { NO_CONTROLLER_TOOL_IMAGES } from "./testing";

const INSTANCE = "0199e0e7-0000-7000-8000-00000000000a";

/** The request id of the `loginStart` that starts a test's login. */
const REQUEST = "0199e0e7-0000-7000-8000-0000000000a1";

const CONTEXT: ProviderRunnerContext = {
  cwd: null,
  attachmentsDir: null,
  toolImages: NO_CONTROLLER_TOOL_IMAGES,
  home: `/var/hercule/runner/providers/${INSTANCE}`,
  binary: "/usr/local/bin/claude",
  env: { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/rogier" },
  secrets: {},
  // Not read by a probe, an install or a login. The context type requires it
  // for the sessions this adapter also hosts.
  herculeTool: { skill: "", claudePluginDir: "/var/hercule/runner/storage/claude-plugin" },
};

const URL_ONE = "https://claude.ai/oauth/authorize?code=challenge-one";
const URL_TWO = "https://claude.ai/oauth/authorize?code=challenge-two";

const INVALID = "Invalid code. Please make sure the full code was copied.";

const createPipe = () => {
  const chunks: Array<string> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const streamChunks = async function* (): AsyncIterable<string> {
    for (;;) {
      while (chunks.length > 0) yield chunks.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  return {
    stream: streamChunks(),
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

interface Fake {
  readonly child: LoginChild;
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Makes the child print to stdout (`says`) or to stderr (`complains`). */
  readonly says: (line: string) => void;
  readonly complains: (line: string) => void;
  readonly stdin: ReadonlyArray<string>;
  readonly exit: (code: number) => void;
  readonly killed: () => boolean;
}

const createMachine = () => {
  const children: Array<Fake> = [];
  const spawn: LoginSpawn = (command, env) => {
    const out = createPipe();
    const err = createPipe();
    const stdin: Array<string> = [];
    let settle: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      settle = resolve;
    });
    let killed = false;
    const endChild = (code: number): void => {
      out.end();
      err.end();
      settle(code);
    };
    const child: LoginChild = {
      stdout: out.stream,
      stderr: err.stream,
      write: (text) => stdin.push(text),
      // A killed child's pipes may not close before it exits, so this fake
      // never closes them. That checks the login code does not rely on the
      // pipes closing after a kill.
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
      exit: endChild,
      killed: () => killed,
    });
    return child;
  };
  return { spawn, children };
};

const run = <A>(effect: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

describe("starting a login", () => {
  it("spawns the vendor's login against the instance's own config directory", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT),
        );
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
    expect(started.env["CLAUDE_CONFIG_DIR"]).toBe(CONTEXT.home);
    expect(started.env["HOME"]).toBe(CONTEXT.env["HOME"]);
    // A browser launch that succeeds makes the CLI switch to a localhost
    // callback, which a browser on another machine can never reach.
    expect(started.env["BROWSER"]).toBe("false");
  });

  it("returns the first URL and ignores anything the child prints after it", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT),
        );
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => {
          children[0]!.says(`${URL_ONE}\n${URL_TWO}\nPaste code here if prompted > `);
        });
        return yield* Fiber.join(starting);
      }),
    );

    expect(answer).toEqual({ _tag: "loginUrl", url: URL_ONE });
  });

  it("extracts the URL from the terminal hyperlink the vendor prints it in", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT),
        );
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => {
          // OSC 8 hyperlink: the target URL is inside the escape sequence, next to a visible copy.
          children[0]!.says(`\u001b]8;;${URL_ONE}\u0007${URL_ONE}\u001b]8;;\u0007\n`);
        });
        return yield* Fiber.join(starting);
      }),
    );

    expect(answer).toEqual({ _tag: "loginUrl", url: URL_ONE });
  });

  it("kills the previous login for the same instance", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const second = await run(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\n`));
        yield* Fiber.join(first);

        const next = yield* Effect.forkChild(driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[1]!.says(`${URL_TWO}\n`));
        return yield* Fiber.join(next);
      }),
    );

    // A pasted code only works with the URL of the child that printed it, so
    // only one login per instance can be waiting.
    expect(children[0]!.killed()).toBe(true);
    expect(second).toEqual({ _tag: "loginUrl", url: URL_TWO });
  });

  it("fails with the child's stderr output when it exits without printing a URL", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT),
        );
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
  const startLogin = (driver: ReturnType<typeof makeLogins>, children: ReadonlyArray<Fake>) =>
    Effect.gen(function* () {
      const starting = yield* Effect.forkChild(
        driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT),
      );
      yield* TestClock.adjust(Duration.zero);
      yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\nPaste code here if prompted > `));
      yield* Fiber.join(starting);
    });

  it("writes the code to the child's stdin and reports success when the child exits with 0", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        yield* startLogin(driver, children);
        const submitting = yield* Effect.forkChild(driver.submit(INSTANCE, "the-pasted-code"));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.exit(0));
        return yield* Fiber.join(submitting);
      }),
    );

    // The code ends with a newline because the CLI reads a whole line. Without
    // it the child would wait forever for a code it has already been given.
    expect(children[0]!.stdin.join("")).toBe("the-pasted-code\n");
    expect(answer).toEqual({ _tag: "loginResult", ok: true });
  });

  it("returns the CLI's error message and keeps the child running for another try", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const [refused, accepted] = await run(
      Effect.gen(function* () {
        yield* startLogin(driver, children);

        const first = yield* Effect.forkChild(driver.submit(INSTANCE, "half-a-code"));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.complains(`${INVALID}\n`));
        // A stderr line counts as a rejected code once the child is still running after the grace
        // period.
        yield* TestClock.adjust(COMPLAINT_GRACE);
        const refused = yield* Fiber.join(first);

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

  it("fails a submit when no login is in progress", async () => {
    const { spawn, children } = createMachine();

    const answer = await run(makeLogins(spawn).submit(INSTANCE, "a-code"));

    expect(answer).toMatchObject({ _tag: "loginFailed" });
    expect((answer as { message: string }).message).toContain("no login in progress");
    expect(children).toEqual([]);
  });

  it("kills a login left idle too long, and fails a later submit", async () => {
    expect(Duration.toMinutes(LOGIN_IDLE)).toBe(10);
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        yield* startLogin(driver, children);
        // Without the idle timeout, a browser tab closed on the URL would leave
        // the CLI blocked on stdin for as long as the daemon runs.
        yield* TestClock.adjust(LOGIN_IDLE);
        return yield* driver.submit(INSTANCE, "a-code-from-yesterday");
      }),
    );

    expect(children[0]!.killed()).toBe(true);
    expect(answer).toMatchObject({ _tag: "loginFailed" });
  });
});

describe("more than one login at a time", () => {
  it("does not let a replaced login kill the login that replaced it", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    // For example two tabs, or the Sessions button and the Fleet row: the first
    // start is still waiting for a URL when the second arrives.
    const [first, second] = await run(
      Effect.gen(function* () {
        const one = yield* Effect.forkChild(driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        const two = yield* Effect.forkChild(driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT));
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[1]!.says(`${URL_TWO}\n`));
        return [yield* Fiber.join(one), yield* Fiber.join(two)] as const;
      }),
    );

    expect(first).toMatchObject({ _tag: "loginFailed" });
    expect(second).toEqual({ _tag: "loginUrl", url: URL_TWO });
    expect(children[1]!.killed()).toBe(false);

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
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT),
        );
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\n`));
        yield* Fiber.join(starting);
        // A vendor blocked on stdin does not notice that the daemon has stopped,
        // and it would keep waiting for a credential.
        yield* driver.stopAll;
      }),
    );

    expect(children[0]!.killed()).toBe(true);
  });

  it("fails a submit after the vendor has exited on its own", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT),
        );
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

  it("reports success for a login that exits with 0, even if it wrote to stderr while exiting", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT),
        );
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\n`));
        yield* Fiber.join(starting);

        const submitting = yield* Effect.forkChild(driver.submit(INSTANCE, "the-whole-code"));
        yield* TestClock.adjust(Duration.zero);
        // Vendors sometimes write warnings to stderr as they exit.
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

/**
 * A device login uses only the first of the two calls. The vendor prints
 * a URL *and* a one-time code, reads nothing, and the browser completes the
 * login with the vendor. Nothing is submitted to it; its child runs until its
 * own timer ends it, and is then forgotten.
 */
describe("a device login", () => {
  // A real directory, because the adapter creates the instance's Codex home and
  // neutral home when it builds the command, just as it does for a session.
  const CODEX_CONTEXT: ProviderRunnerContext = {
    cwd: null,
    attachmentsDir: null,
    toolImages: NO_CONTROLLER_TOOL_IMAGES,
    home: mkdtempSync(join(tmpdir(), "hercule-login-")),
    binary: "/usr/local/bin/codex",
    env: { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/rogier" },
    secrets: {},
    // Not read by a probe, an install or a login. The context type requires it
    // for the sessions this adapter also hosts.
    herculeTool: { skill: "", claudePluginDir: "/var/hercule/runner/storage/claude-plugin" },
  };

  afterAll(() => {
    rmSync(CODEX_CONTEXT.home, { recursive: true, force: true });
  });

  const DEVICE_URL = "https://auth.openai.com/codex/device";
  const USER_CODE = "CH61-0FI2N";

  /**
   * The answer to a device login started with the test clock at zero: the
   * code's whole lifetime is still ahead of it.
   */
  const DEVICE_ANSWER: LoginAnswer = {
    _tag: "loginUrl",
    url: DEVICE_URL,
    userCode: USER_CODE,
    expiresInSeconds: Duration.toSeconds(LOGIN_CODE_LIFETIME),
  };

  /** The lines `codex login --device-auth` printed, taken from a recording. */
  const RECORDED = ((): ReadonlyArray<string> => {
    const lines = readFileSync(
      new URL("./codex/device-auth.sample.txt", import.meta.url),
      "utf8",
    ).split("\n");
    // The file starts with a header that describes the recording. The captured
    // output is everything after the first blank line.
    return lines.slice(lines.indexOf("") + 1);
  })();

  /**
   * Makes the child print the recorded lines. The recording notes that the
   * vendor colours this output, which a text file cannot keep, so the colour
   * codes are added back: the login code must handle the line a terminal would
   * really receive, not a cleaned-up one.
   */
  const printRecordedLogin = (children: ReadonlyArray<Fake>): void => {
    // The newest child is the login being started. If the driver spawned
    // nothing, the test should fail on its assertion, not here.
    for (const line of RECORDED) children.at(-1)?.says(`\u001b[36m${line}\u001b[0m\n`);
  };

  const startLogin = (
    driver: ReturnType<typeof makeLogins>,
    children: ReadonlyArray<Fake>,
    instanceId = INSTANCE,
    requestId = REQUEST,
  ) =>
    Effect.gen(function* () {
      const starting = yield* Effect.forkChild(
        driver.start(requestId, instanceId, codex, CODEX_CONTEXT),
      );
      yield* TestClock.adjust(Duration.zero);
      yield* Effect.sync(() => printRecordedLogin(children));
      return yield* Fiber.join(starting);
    });

  it("reads both the URL and the one-time code from the vendor's output", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(startLogin(driver, children));

    expect(answer).toStrictEqual(DEVICE_ANSWER);
  });

  it("returns the URL only once the code has been read too", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);
    let early: LoginAnswer | undefined;

    const [pending, answer] = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          Effect.tap(driver.start(REQUEST, INSTANCE, codex, CODEX_CONTEXT), (given) =>
            Effect.sync(() => {
              early = given;
            }),
          ),
        );
        yield* TestClock.adjust(Duration.zero);
        // Two separate chunks, as a pipe may deliver them: the URL, then the code.
        yield* Effect.sync(() => children[0]?.says(`Open this link\n${DEVICE_URL}\n`));
        yield* TestClock.adjust(Duration.zero);
        const pending = yield* Effect.sync(() => early);
        yield* Effect.sync(() => children[0]?.says(`Enter this code\n${USER_CODE}\n`));
        return [pending, yield* Fiber.join(starting)] as const;
      }),
    );

    expect(pending).toBeUndefined();
    expect(answer).toStrictEqual(DEVICE_ANSWER);
  });

  it("returns the URL and code when the output ends right after the code", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, codex, CODEX_CONTEXT),
        );
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => {
          printRecordedLogin(children);
          // The child exits right after the last line, which closes the pipe.
          children[0]?.exit(0);
        });
        return yield* Fiber.join(starting);
      }),
    );

    expect(answer).toStrictEqual(DEVICE_ANSWER);
  });

  it("fails with the child's stderr output when it prints a URL but no code", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, codex, CODEX_CONTEXT),
        );
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => {
          children[0]?.says(`Open this link to sign in\n${DEVICE_URL}\n`);
          children[0]?.complains("Device authorization is not enabled for this account.\n");
          children[0]?.exit(1);
        });
        return yield* Fiber.join(starting);
      }),
    );

    // A URL with no code leads to a page the user cannot get past, so this is a
    // failure, not a partial answer. The message comes from stderr, not from
    // stdout, where the code would have been printed.
    expect(answer).toMatchObject({ _tag: "loginFailed" });
    expect((answer as { message: string }).message).toContain("not enabled for this account");
  });

  it("reports the missing code when the child prints a URL and nothing on stderr", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, codex, CODEX_CONTEXT),
        );
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => {
          children[0]?.says(`Open this link to sign in\n${DEVICE_URL}\n`);
          children[0]?.exit(1);
        });
        return yield* Fiber.join(starting);
      }),
    );

    // The child wrote no error, and the URL did arrive, so the message says the
    // code is what is missing.
    expect(answer).toStrictEqual({
      _tag: "loginFailed",
      message: "the login printed no code to type",
    });
  });

  it("returns no user code for a paste login", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT),
        );
        yield* TestClock.adjust(Duration.zero);
        yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\n`));
        return yield* Fiber.join(starting);
      }),
    );

    expect(answer).toStrictEqual({ _tag: "loginUrl", url: URL_ONE });
  });

  it("fails a submit and writes nothing to the child", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        yield* startLogin(driver, children);
        return yield* driver.submit(INSTANCE, USER_CODE);
      }),
    );

    expect(answer).toMatchObject({
      _tag: "loginFailed",
      message: "this login does not accept a code here; type the code it showed into the browser",
    });
    // The browser completes this login; the code is shown to the user, never written to the child.
    expect(children[0]!.stdin).toEqual([]);
    // Nothing was written, so the child is not killed and keeps polling.
    expect(children[0]!.killed()).toBe(false);
  });

  it("keeps a device login past the idle timeout, and kills it when its code expires", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const [early, answer] = await run(
      Effect.gen(function* () {
        yield* startLogin(driver, children);
        // A device login shows no activity between printing the code and
        // exiting, so the idle timeout for paste logins must not kill it.
        yield* TestClock.adjust(LOGIN_IDLE);
        const early = yield* Effect.sync(() => children[0]!.killed());
        // By now the printed code has expired, so the login cannot succeed.
        yield* TestClock.adjust(Duration.subtract(LOGIN_CODE_LIFETIME, LOGIN_IDLE));
        return [early, yield* driver.submit(INSTANCE, USER_CODE)] as const;
      }),
    );

    expect(early).toBe(false);
    expect(children[0]!.killed()).toBe(true);
    // The login was killed and forgotten, so no login is held for the instance.
    expect(answer).toMatchObject({ _tag: "loginFailed", message: "no login in progress" });
  });

  it("counts the code's lifetime from when it was printed", async () => {
    const { spawn, children } = createMachine();
    const driver = makeLogins(spawn);

    const answer = await run(
      Effect.gen(function* () {
        const starting = yield* Effect.forkChild(
          driver.start(REQUEST, INSTANCE, codex, CODEX_CONTEXT),
        );
        yield* TestClock.adjust(Duration.seconds(5));
        yield* Effect.sync(() => printRecordedLogin(children));
        return yield* Fiber.join(starting);
      }),
    );

    // The clock started at the spawn, and the vendor took five seconds to print.
    expect(answer).toMatchObject({ expiresInSeconds: Duration.toSeconds(LOGIN_CODE_LIFETIME) - 5 });
  });

  describe("reporting the end of a device login", () => {
    /** An instance whose device login ends last, after the one a test checks. */
    const SENTINEL = "0199e0e7-0000-7000-8000-00000000000b";

    /** The request id of the sentinel's login. */
    const SENTINEL_REQUEST = "0199e0e7-0000-7000-8000-0000000000b1";

    /** Attaches a connection the way a runner's socket does, and returns the queue it reports into. */
    const attachQueue = (driver: ReturnType<typeof makeLogins>) =>
      Effect.gen(function* () {
        const reports = yield* Queue.unbounded<string>();
        yield* driver.attachConnection((frame) => Queue.offer(reports, frame.requestId));
        return reports;
      });

    /**
     * Ends a device login on the sentinel instance, waits for its report, and
     * returns every report that came before it. Child exits are handled in
     * the order they happen, so a report caused earlier in the test has
     * arrived by then.
     */
    const listReportsBeforeSentinel = (
      driver: ReturnType<typeof makeLogins>,
      children: ReadonlyArray<Fake>,
      reports: Queue.Queue<string>,
    ) =>
      Effect.gen(function* () {
        yield* startLogin(driver, children, SENTINEL, SENTINEL_REQUEST);
        yield* Effect.sync(() => children.at(-1)!.exit(0));
        const before: Array<string> = [];
        for (;;) {
          const requestId = yield* Queue.take(reports);
          if (requestId === SENTINEL_REQUEST) return before;
          before.push(requestId);
        }
      });

    /**
     * Runs `body` with a connection attached, then the sentinel login, and
     * returns the request ids reported before the sentinel's.
     */
    const collectReports = (
      driver: ReturnType<typeof makeLogins>,
      children: ReadonlyArray<Fake>,
      body: Effect.Effect<void>,
    ): Promise<ReadonlyArray<string>> =>
      run(
        Effect.scoped(
          Effect.gen(function* () {
            const reports = yield* attachQueue(driver);
            yield* body;
            return yield* listReportsBeforeSentinel(driver, children, reports);
          }),
        ),
      );

    it("reports a device login whose vendor exits on its own", async () => {
      const { spawn, children } = createMachine();
      const driver = makeLogins(spawn);

      const reported = await collectReports(
        driver,
        children,
        Effect.gen(function* () {
          yield* startLogin(driver, children);
          // The user typed the code in the browser, so the vendor exits.
          yield* Effect.sync(() => children[0]!.exit(0));
        }),
      );

      expect(reported).toEqual([REQUEST]);
    });

    it("reports a device login whose code expired", async () => {
      const { spawn, children } = createMachine();
      const driver = makeLogins(spawn);

      const reported = await collectReports(
        driver,
        children,
        Effect.gen(function* () {
          yield* startLogin(driver, children);
          yield* TestClock.adjust(LOGIN_CODE_LIFETIME);
        }),
      );

      expect(children[0]!.killed()).toBe(true);
      // Reported once: the kill that ends the child must not report it again.
      expect(reported).toEqual([REQUEST]);
    });

    it("does not report a login that was replaced or stopped with the runner", async () => {
      const { spawn, children } = createMachine();
      const driver = makeLogins(spawn);

      const reported = await collectReports(
        driver,
        children,
        Effect.gen(function* () {
          yield* startLogin(driver, children);
          // The second login replaces the first, whose end means nothing now.
          const second = yield* Effect.forkChild(
            driver.start(REQUEST, INSTANCE, codex, CODEX_CONTEXT),
          );
          yield* TestClock.adjust(Duration.zero);
          yield* Effect.sync(() => {
            for (const line of RECORDED) children[1]?.says(`${line}\n`);
            children[0]!.exit(1);
          });
          yield* Fiber.join(second);
          yield* driver.stopAll;
          yield* Effect.sync(() => children[1]!.exit(1));
        }),
      );

      expect(reported).toEqual([]);
    });

    it("reports a login that replaced another under its own request id", async () => {
      const { spawn, children } = createMachine();
      const driver = makeLogins(spawn);
      const replacing = "0199e0e7-0000-7000-8000-0000000000a2";

      const reported = await collectReports(
        driver,
        children,
        Effect.gen(function* () {
          yield* startLogin(driver, children);
          yield* startLogin(driver, children, INSTANCE, replacing);
          yield* Effect.sync(() => {
            children[0]!.exit(1);
            children[1]!.exit(0);
          });
        }),
      );

      expect(reported).toEqual([replacing]);
    });

    it("does not report a paste login, whose submit already waits for its end", async () => {
      const { spawn, children } = createMachine();
      const driver = makeLogins(spawn);

      const reported = await collectReports(
        driver,
        children,
        Effect.gen(function* () {
          const starting = yield* Effect.forkChild(
            driver.start(REQUEST, INSTANCE, claudeCode, CONTEXT),
          );
          yield* TestClock.adjust(Duration.zero);
          yield* Effect.sync(() => children[0]!.says(`${URL_ONE}\n`));
          yield* Fiber.join(starting);
          yield* Effect.sync(() => children[0]!.exit(0));
        }),
      );

      expect(reported).toEqual([]);
    });

    it("stops reporting once the connection that attached it closes", async () => {
      const { spawn, children } = createMachine();
      const driver = makeLogins(spawn);

      const [whileOpen, afterClose, nextConnection] = await run(
        Effect.gen(function* () {
          const { reports, whileOpen } = yield* Effect.scoped(
            Effect.gen(function* () {
              const reports = yield* attachQueue(driver);
              yield* startLogin(driver, children);
              yield* Effect.sync(() => children[0]!.exit(0));
              return { reports, whileOpen: yield* Queue.take(reports) };
            }),
          );
          // This login ends while no connection is attached.
          yield* startLogin(driver, children);
          yield* Effect.sync(() => children[1]!.exit(0));
          // Started before the next connection attaches, which gives the
          // exit above time to be handled first.
          yield* startLogin(driver, children, SENTINEL, SENTINEL_REQUEST);
          const next = yield* Effect.scoped(
            Effect.gen(function* () {
              const reports = yield* attachQueue(driver);
              yield* Effect.sync(() => children[2]!.exit(0));
              return yield* Queue.take(reports);
            }),
          );
          return [whileOpen, yield* Queue.size(reports), next] as const;
        }),
      );

      expect(whileOpen).toBe(REQUEST);
      // The closed connection received nothing more. The next connection
      // probes every instance when it arrives, which makes up for the report
      // nobody could receive.
      expect(afterClose).toBe(0);
      expect(nextConnection).toBe(SENTINEL_REQUEST);
    });
  });
});
