/**
 * Tests, with a real child process, that a text generation returns only after
 * its harness has exited. The harness is a small script (see
 * `text-generation-harness.fixture.ts`) behind the real pi adapter and the
 * real process spawner. The fake harnesses of the adapter tests cannot show
 * this: they exit when told to, in no time.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import type { TextGenerationOutcome, TextGenerationRequest } from "@hercule/protocol";
import { makePiAdapter } from "./providers/pi/adapter";
import { spawnPi, STOP_GRACE } from "./providers/process";
import { NO_CONTROLLER_UPLOADER } from "./providers/testing";
import { makeTextGenerator } from "./text-generation";

const HARNESS = join(import.meta.dirname, "text-generation-harness.fixture.ts");

const REQUEST: TextGenerationRequest = {
  _tag: "textGenerationRequest",
  requestId: "request-1",
  instanceId: "instance-1",
  providerId: "pi",
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
      attachmentUploader: NO_CONTROLLER_UPLOADER,
      home: root,
      binary: "pi",
      env: { PATH: process.env["PATH"] ?? "" },
      secrets: {},
      herculeTool: { skill: "", claudePluginDir: join(root, "claude-plugin") },
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

/** Returns the pids the fixture harness has written so far. */
const readPids = (): Array<number> =>
  readdirSync(proofDir)
    .filter((name) => name.startsWith("pid-"))
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
