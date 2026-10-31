/**
 * Tests, with a real child process, that a text generation returns only after
 * its harness has exited. The fake harnesses of the adapter tests cannot show
 * this: they exit when told to, in no time.
 *
 * - pi: a small script (see `text-generation-harness.fixture.ts`) behind the
 *   real pi adapter and the real process spawner.
 * - Claude Code: a small script (see
 *   `text-generation-claude-harness.fixture.ts`) behind the real Claude Code
 *   adapter and the real vendor SDK. The SDK starts and ends the CLI, and its
 *   own close returns before the CLI has exited, so only the real SDK can
 *   show that the adapter waits for the process.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import type { TextGenerationOutcome, TextGenerationRequest } from "@hercule/protocol";
import { claudeCode } from "./harnesses/claude-code";
import { makePiAdapter } from "./harnesses/pi/adapter";
import { spawnPi, STOP_GRACE } from "./harnesses/process";
import { NO_CONTROLLER_UPLOADER } from "./harnesses/testing";
import { makeTextGenerator } from "./text-generation";

const HARNESS = join(import.meta.dirname, "text-generation-harness.fixture.ts");
const CLAUDE_HARNESS = join(import.meta.dirname, "text-generation-claude-harness.fixture.ts");

const REQUEST: TextGenerationRequest = {
  _tag: "textGenerationRequest",
  requestId: "request-1",
  instanceId: "instance-1",
  harnessId: "pi",
  config: {},
  secrets: {},
  spec: {
    model: "fake-model",
    instructions: "Write a title.",
    input: "A conversation about tests.",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: { title: { type: "string" } },
    },
  },
};

/** How the fixture harness answers and how it reacts to SIGTERM; see the fixture. */
interface HarnessBehaviour {
  readonly answer: "submit" | "silent";
  readonly onSigterm: "ignore" | number;
  readonly deadlineMillis: number;
}

let root: string;
let proofDir: string;
let scratchDir: string;
/** The exit of every child the test spawned. A failing test kills only these children. */
let exits: Array<Promise<number>>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hercule-text-generation-lifecycle-"));
  proofDir = join(root, "proof");
  scratchDir = join(root, "scratch");
  mkdirSync(proofDir);
  exits = [];
});

afterEach(async () => {
  for (const pid of readPids()) {
    if (isRunning(pid)) process.kill(pid, "SIGKILL");
  }
  await Promise.all(exits);
  rmSync(root, { recursive: true, force: true });
});

/** Checks whether the process with `pid` still runs. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Makes one text generation against the fixture harness and measures it. */
const generateWith = async (behaviour: HarnessBehaviour) => {
  const directories: Array<string> = [];
  const adapter = makePiAdapter({
    spawn: (_command, env, cwd) => {
      directories.push(cwd!);
      const child = spawnPi(
        [process.execPath, HARNESS],
        {
          ...env,
          HARNESS_PROOF_DIR: proofDir,
          HARNESS_ANSWER: behaviour.answer,
          HARNESS_ON_SIGTERM: String(behaviour.onSigterm),
        },
        cwd,
      );
      exits.push(child.exited);
      waitForHarnesses(directories.length);
      return child;
    },
    run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    killProcessesHolding: () => Effect.void,
  });
  const generate = makeTextGenerator({
    scratchDir,
    findAdapter: () => adapter,
    buildContext: () => ({
      cwd: null,
      attachmentsDir: null,
      editMarks: null,
      attachmentUploader: NO_CONTROLLER_UPLOADER,
      home: root,
      binary: "pi",
      env: { PATH: process.env["PATH"] ?? "" },
      secrets: {},
      herculeTool: { orientation: "", skill: "", claudePluginDir: join(root, "claude-plugin") },
    }),
    deadline: Duration.millis(behaviour.deadlineMillis),
  });

  const startedAt = Date.now();
  const outcome: TextGenerationOutcome = await Effect.runPromise(generate(REQUEST));
  // Read at once: a harness still exiting after the call returned is the failure under test.
  return {
    outcome,
    elapsedMillis: Date.now() - startedAt,
    stillRunning: readPids().filter(isRunning),
    directoriesLeft: directories.filter((directory) => existsSync(directory)),
  };
};

/**
 * Blocks until `count` fixture harnesses have written their pid, which each
 * does only once its SIGTERM handler is in place. Fails after 10 seconds.
 *
 * Without this wait, a short deadline can end the call while the harness is
 * still starting. Its SIGTERM then arrives before the handler exists, the
 * default action ends the process at once, and the test no longer shows what
 * happens to a harness that ignores SIGTERM. The wait blocks the whole thread,
 * so the deadline cannot fire during it.
 */
const waitForHarnesses = (count: number): void => {
  const givesUpAt = Date.now() + 10_000;
  while (readPids().length < count) {
    if (Date.now() > givesUpAt) throw new Error(`the fixture harness did not start in 10 seconds`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};

/** Returns the pids the fixture harness has written so far. */
const readPids = (): Array<number> =>
  readdirSync(proofDir)
    .filter((name) => name.startsWith("pid-") && !name.endsWith(".partial"))
    .map((name) => Number(readFileSync(join(proofDir, name), "utf8")));

describe("a text generation with a real harness process", () => {
  it("returns an answer only after a slow harness has exited, without a SIGKILL", async () => {
    const result = await generateWith({ answer: "submit", onSigterm: 300, deadlineMillis: 10_000 });

    expect(result.outcome).toMatchObject({ outcome: "ok", value: { title: "A valid title" } });
    expect(result.stillRunning).toEqual([]);
    expect(result.directoriesLeft).toEqual([]);
    expect(result.elapsedMillis).toBeGreaterThanOrEqual(300);
    expect(result.elapsedMillis).toBeLessThan(Duration.toMillis(STOP_GRACE));
  });

  it("kills a harness that ignores SIGTERM after the grace, and returns only then", async () => {
    const result = await generateWith({
      answer: "submit",
      onSigterm: "ignore",
      deadlineMillis: 10_000,
    });

    expect(result.outcome).toMatchObject({ outcome: "ok" });
    expect(result.stillRunning).toEqual([]);
    expect(result.directoriesLeft).toEqual([]);
    expect(result.elapsedMillis).toBeGreaterThanOrEqual(Duration.toMillis(STOP_GRACE));
  });

  it("reports a timeout only after the harness that never answered has exited", async () => {
    const result = await generateWith({
      answer: "silent",
      onSigterm: "ignore",
      deadlineMillis: 100,
    });

    expect(result.outcome).toEqual({ outcome: "timeout" });
    expect(result.stillRunning).toEqual([]);
    expect(result.directoriesLeft).toEqual([]);
    expect(result.elapsedMillis).toBeGreaterThanOrEqual(Duration.toMillis(STOP_GRACE));
  });
});

/** How the fixture Claude Code CLI answers and how it reacts to its stdin closing; see the fixture. */
interface ClaudeBehaviour {
  readonly answer: "submit" | "silent" | "crash";
  readonly onStdinEnd: "exit" | "ignore";
  readonly deadlineMillis: number;
}

/**
 * Makes `count` text generations at once with the real Claude Code adapter
 * against the fixture CLI. Returns every outcome, the time the calls took, and
 * what is left once the last call has returned.
 */
const generateWithClaude = async (behaviour: ClaudeBehaviour, count = 1) => {
  const generate = makeTextGenerator({
    scratchDir,
    findAdapter: () => claudeCode,
    buildContext: () => ({
      cwd: null,
      attachmentsDir: null,
      editMarks: null,
      attachmentUploader: NO_CONTROLLER_UPLOADER,
      home: root,
      binary: CLAUDE_HARNESS,
      env: {
        PATH: process.env["PATH"] ?? "",
        HARNESS_PROOF_DIR: proofDir,
        HARNESS_ANSWER: behaviour.answer,
        HARNESS_ON_STDIN_END: behaviour.onStdinEnd,
      },
      secrets: {},
      herculeTool: { orientation: "", skill: "", claudePluginDir: join(root, "claude-plugin") },
    }),
    deadline: Duration.millis(behaviour.deadlineMillis),
  });
  const request: TextGenerationRequest = { ...REQUEST, harnessId: "claude-code" };

  const startedAt = Date.now();
  const outcomes: Array<TextGenerationOutcome> = await Promise.all(
    Array.from({ length: count }, () => Effect.runPromise(generate(request))),
  );
  const elapsedMillis = Date.now() - startedAt;
  // Read at once: a CLI still exiting after the call returned is the failure under test.
  const pids = readPids();
  return {
    outcomes,
    elapsedMillis,
    pids,
    stillRunning: pids.filter(isRunning),
    directoriesLeft: pids
      .map((pid) => readFileSync(join(proofDir, `cwd-${String(pid)}`), "utf8"))
      .filter((directory) => existsSync(directory)),
  };
};

describe("a Claude Code text generation with the real SDK and a CLI that ignores SIGTERM", () => {
  // Each call takes about 4 seconds when the CLI stays: the SDK waits 2
  // seconds for the exit, and the runner then gives SIGTERM STOP_GRACE.
  const SLOW = { timeout: 30_000 };

  it("returns an answer only after the CLI has been killed", SLOW, async () => {
    const result = await generateWithClaude({
      answer: "submit",
      onStdinEnd: "ignore",
      deadlineMillis: 10_000,
    });

    expect(result.outcomes).toMatchObject([{ outcome: "ok", value: { title: "A valid title" } }]);
    expect(result.pids).toHaveLength(1);
    expect(result.stillRunning).toEqual([]);
    expect(result.directoriesLeft).toEqual([]);
  });

  it("reports a timeout only after the CLI that never answered has exited", SLOW, async () => {
    const result = await generateWithClaude({
      answer: "silent",
      onStdinEnd: "ignore",
      deadlineMillis: 200,
    });

    expect(result.outcomes).toEqual([{ outcome: "timeout" }]);
    expect(result.pids).toHaveLength(1);
    expect(result.stillRunning).toEqual([]);
    expect(result.directoriesLeft).toEqual([]);
  });

  it("leaves no CLI running after a batch of 11 calls", SLOW, async () => {
    const batch = await generateWithClaude(
      { answer: "submit", onStdinEnd: "ignore", deadlineMillis: 20_000 },
      10,
    );
    // The 11th call starts as soon as the first ten are done, as the
    // controller's next call would once ten slots are free.
    const eleventh = await generateWithClaude({
      answer: "submit",
      onStdinEnd: "ignore",
      deadlineMillis: 20_000,
    });

    expect(batch.outcomes.map((outcome) => outcome.outcome)).toEqual(Array(10).fill("ok"));
    expect(batch.pids).toHaveLength(10);
    expect(batch.stillRunning).toEqual([]);
    expect(batch.directoriesLeft).toEqual([]);
    expect(eleventh.outcomes).toMatchObject([{ outcome: "ok" }]);
    expect(eleventh.pids).toHaveLength(11);
    expect(eleventh.stillRunning).toEqual([]);
    expect(eleventh.directoriesLeft).toEqual([]);
  });

  it("does not wait when the CLI exits on its own", SLOW, async () => {
    const result = await generateWithClaude({
      answer: "submit",
      onStdinEnd: "exit",
      deadlineMillis: 10_000,
    });

    expect(result.outcomes).toMatchObject([{ outcome: "ok" }]);
    expect(result.stillRunning).toEqual([]);
    expect(result.elapsedMillis).toBeLessThan(Duration.toMillis(STOP_GRACE));
  });

  it("reports a CLI that crashed by its exit code, never by its error output", SLOW, async () => {
    const result = await generateWithClaude({
      answer: "crash",
      onStdinEnd: "ignore",
      deadlineMillis: 10_000,
    });

    const [outcome] = result.outcomes;
    expect(outcome?.outcome).toBe("failed");
    expect(outcome).toHaveProperty("message");
    // The message is stored and shown, and error output can hold a credential.
    const { message } = outcome as { readonly message: string };
    expect(message).toMatch(/exited with code 3/);
    expect(message).not.toContain("sk-ant-");
    expect(result.stillRunning).toEqual([]);
  });

  it(
    "starts the CLI in the call's scratch folder with the instance's config directory",
    SLOW,
    async () => {
      const result = await generateWithClaude({
        answer: "submit",
        onStdinEnd: "exit",
        deadlineMillis: 10_000,
      });

      const launch = JSON.parse(
        readFileSync(join(proofDir, `launch-${String(result.pids[0])}`), "utf8"),
      ) as {
        readonly cwd: string;
        readonly configDir: string;
        readonly autoMemoryDisabled: string;
      };
      expect(launch.configDir).toBe(root);
      expect(launch.autoMemoryDisabled).toBe("1");
      // `realpathSync` because macOS reports a temporary folder through /private.
      expect(dirname(launch.cwd)).toBe(realpathSync(scratchDir));
    },
  );
});
