/**
 * How the pi adapter launches a session and what an input does to one, over a
 * scripted pi: nothing vendor-supplied runs. The flags are pi 0.85.1's own and
 * the commands and responses are the shapes `dist/modes/rpc/rpc-types.d.ts`
 * declares.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { SessionSpec } from "@hydra/protocol";
import {
  busy,
  cleanupHomes,
  driving,
  KEY,
  PRIOR,
  refusal,
  SESSION,
  sentOf,
  settle,
  SPEC,
  started,
  taggedIn,
  until,
} from "./testing";

afterAll(cleanupHomes);

/** The flags every pi this adapter starts is launched with, in order. */
const flagsFor = (home: string): ReadonlyArray<string> => [
  "--mode",
  "rpc",
  "--no-context-files",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-approve",
  "--offline",
  "-e",
  join(home, "hydra-extension.ts"),
  "--session-dir",
  join(home, "sessions"),
  "--session-id",
  SESSION,
  "--model",
  "zai/glm-5.3",
  "--thinking",
  "high",
];

/** A session file pi would have written for a native session of that id. */
const priorSessionFile = (home: string, id: string): string => {
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-09-19T10-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", id, timestamp: 0 })}\n`);
  return path;
};

const after = (argv: ReadonlyArray<string>, flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1];

describe("the pi a session is launched as", () => {
  it("launches it with the user's own material, extensions and approvals all off", async () => {
    const run = await started();

    expect(run.child.command).toEqual([run.ctx.binary, ...flagsFor(run.ctx.home)]);
  });

  it("starts it in the session's own directory", async () => {
    const run = await started();

    // pi resolves every relative path against the directory it runs in, so a
    // child that inherited the runner's own would write the user's work into
    // whatever directory the daemon was launched from.
    expect(run.child.cwd).toBe(run.ctx.cwd);
  });

  it("gives it the instance's own agent directory and the Z.ai key, and skips the update check", async () => {
    const run = await started();

    expect(run.child.env["PI_CODING_AGENT_DIR"]).toBe(run.ctx.home);
    expect(run.child.env["PI_SKIP_VERSION_CHECK"]).toBe("1");
    expect(run.child.env["ZAI_API_KEY"]).toBe(KEY);
  });

  it("runs on the instance's key alone, never on one the machine exports", async () => {
    const run = driving();
    const ctx = {
      ...run.ctx,
      secrets: {},
      env: { ...run.ctx.env, ZAI_API_KEY: "the runner daemon's own key" },
    };

    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, ctx));
    const probed = await Effect.runPromise(run.adapter.probe(ctx, {}));

    // An instance nobody has entered a key on would otherwise run on whatever
    // the machine exports, and report itself as logged in on it.
    expect(run.spawns[0]!.env["ZAI_API_KEY"]).toBeUndefined();
    expect(probed.auth.status).toBe("unauthenticated");
  });

  it("writes the extension pi loads, and parks its decision on the abort signal", async () => {
    const run = await started();

    const path = join(run.ctx.home, "hydra-extension.ts");
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).not.toBe("");
    // Without the signal an abort leaves the dialog waiting forever, and the
    // session with it.
    expect(source).toContain("signal: ctx.signal");
  });

  it("carries on a native session by its file, never by its id", async () => {
    const run = driving();
    const path = priorSessionFile(run.ctx.home, PRIOR);
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } };

    await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));

    // An id would make pi look the session up, and ask on stdin - Hydra's own
    // JSON channel - whether to fork it into this directory.
    expect(after(run.spawns[0]!.command, "--session")).toBe(path);
    expect(run.spawns[0]!.command).not.toContain("--fork");
  });

  it("branches off a native session by its file", async () => {
    const run = driving();
    const path = priorSessionFile(run.ctx.home, PRIOR);
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "fork" } };

    await Effect.runPromise(run.adapter.startSession(SESSION, spec, run.ctx));

    expect(after(run.spawns[0]!.command, "--fork")).toBe(path);
  });

  it("refuses a session whose transcript is gone, rather than launching a pi that hangs", async () => {
    const run = driving();
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } };

    const refused = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, spec, run.ctx)),
    );

    expect(refused).toContain(PRIOR);
    expect(run.spawns).toEqual([]);
    // The start is what failed, and the supervisor reports a failed start: an
    // exit from here as well would be one end reported twice.
    await settle();
    expect(taggedIn(run.seen, "session.exited")).toEqual([]);
  });
});

describe("what an input does to a pi session", () => {
  it("prompts when nothing is running, and says it opened a turn", async () => {
    const run = await started();

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    expect(sent.delivery).toBe("opened");
    expect(sent.turnId).not.toBe("");
    expect(sentOf(run.sent, "prompt")).toEqual([expect.objectContaining({ message: "hello" })]);
    expect(sentOf(run.sent, "steer")).toEqual([]);
  });

  it("steers the running turn instead of opening a second one", async () => {
    const run = await busy();

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "and the tests" }));

    expect(sent.delivery).toBe("steered");
    expect(sentOf(run.sent, "steer")).toEqual([
      expect.objectContaining({ message: "and the tests" }),
    ]);
    // The first prompt is the one the input before it sent; steering sent no second.
    expect(sentOf(run.sent, "prompt")).toHaveLength(1);
  });

  it("reports the user's own message as an item of the turn it opened", async () => {
    const run = await started();

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    await until(
      "reported the user's message",
      () => taggedIn(run.seen, "item.completed").length === 1,
    );
    const item = taggedIn(run.seen, "item.started")[0];
    expect(item?.kind).toBe("user_message");
    expect(JSON.stringify(item?.detail)).toContain("hello");
  });

  it("changes the model and its thinking level before prompting on it", async () => {
    const run = await started();

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, {
        text: "hello",
        modelSelection: { model: "glm-5.3-flash", options: { thinking: "low" } },
      }),
    );

    expect(run.sent.map((one) => one.type)).toEqual(["set_model", "set_thinking_level", "prompt"]);
    expect(sentOf(run.sent, "set_model")[0]).toMatchObject({
      provider: "zai",
      modelId: "glm-5.3-flash",
    });
    expect(sentOf(run.sent, "set_thinking_level")[0]).toMatchObject({ level: "low" });
  });

  it("fails the input with what pi said when the model cannot be changed", async () => {
    const run = await started({
      answers: { set_model: () => refusal("Model not found: zai/glm-9") },
    });

    const refused = await Effect.runPromise(
      Effect.flip(
        run.adapter.sendInput(SESSION, {
          text: "hello",
          modelSelection: { model: "glm-9", options: {} },
        }),
      ),
    );

    expect(refused).toContain("Model not found");
    // Nothing was asked on a model pi refused to switch to.
    expect(sentOf(run.sent, "prompt")).toEqual([]);
  });

  it("prompts again after a prompt pi refused, rather than steering", async () => {
    const run = await started({ answers: { prompt: () => refusal("busy") } });

    await Effect.runPromise(Effect.flip(run.adapter.sendInput(SESSION, { text: "hello" })));
    await Effect.runPromise(Effect.flip(run.adapter.sendInput(SESSION, { text: "hello again" })));

    // A refused prompt opened no turn, and steering one that never started is
    // an input pi refuses too: the session would take nothing from then on.
    expect(sentOf(run.sent, "prompt")).toHaveLength(2);
    expect(sentOf(run.sent, "steer")).toEqual([]);
  });
});

describe("a pi that dies while its turn is running", () => {
  it("fails the turn with what it complained about, and says the same on the exit", async () => {
    const run = await busy();
    const complaint = "pi: the model provider refused the request";

    run.child.crash(complaint);

    await until("said the session ended", () => taggedIn(run.seen, "session.exited").length === 1);
    const completed = taggedIn(run.seen, "turn.completed")[0];
    // Not interrupted: that is the word for a stop the user asked for, and a
    // turn that reads as stopped on purpose hides that the session crashed.
    expect(completed?.state).toBe("failed");
    expect(JSON.stringify(completed?.error)).toContain(complaint);
    const exited = taggedIn(run.seen, "session.exited")[0];
    expect(exited?.reason).toBe("process_exit");
    expect(JSON.stringify(exited?.message)).toContain(complaint);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });
});

describe("a session the supervisor stops", () => {
  it("kills a pi that stayed behind after its stdin closed", async () => {
    const run = await started({ lingers: true });

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    // A pi parked on a question is waiting for its answer on the stdin that
    // was just closed: nothing it hears will ever make it leave.
    expect(run.child.stdinClosed()).toBe(true);
    expect(run.child.kills()).toBe(1);
    expect(taggedIn(run.seen, "session.exited")[0]?.reason).toBe("stopped");
    // The entry goes only once its pi is gone: a second one started on this
    // transcript while the first was still writing would corrupt it. A pi that
    // did go needs no warning about one that stayed.
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
    expect(taggedIn(run.seen, "runtime.warning")).toEqual([]);
  }, 10_000);

  it("holds the session until its pi is gone, so nothing starts under the id meanwhile", async () => {
    const run = await started({ lingers: true });
    run.child.push({ type: "agent_start" });
    await until("reported the turn open", () => taggedIn(run.seen, "turn.started").length === 1);

    const stopping = Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));
    const refused = await Effect.runPromise(
      Effect.flip(run.adapter.startSession(SESSION, SPEC, run.ctx)),
    );
    await stopping;

    expect(refused).toContain("still running");
    // The turn goes with the session: a turn left open is a thread that reads
    // as working for as long as anyone looks at it.
    expect(taggedIn(run.seen, "turn.completed")[0]?.state).toBe("interrupted");
    expect(run.spawns).toHaveLength(1);
  }, 10_000);

  it("closes pi's stdin, lets it leave, and reports the reason it was given", async () => {
    const run = await started();

    await Effect.runPromise(run.adapter.stopSession(SESSION, "idle_unload"));

    await until("said the session ended", () => taggedIn(run.seen, "session.exited").length === 1);
    // Stdin's end is pi's own cue to leave: killing it would lose the
    // transcript flush that makes the session resumable.
    expect(run.child.stdinClosed()).toBe(true);
    expect(run.child.kills()).toBe(0);
    expect(taggedIn(run.seen, "session.exited")[0]?.reason).toBe("idle_unload");
    await settle();
    expect(taggedIn(run.seen, "session.exited")).toHaveLength(1);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });
});
