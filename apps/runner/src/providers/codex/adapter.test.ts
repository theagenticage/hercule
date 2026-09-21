/**
 * The Codex adapter's probe, its install and the isolation it spawns an
 * app-server under, over a scripted app-server: nothing vendor-supplied runs.
 * The frames the script answers with are the shapes captured from codex 0.154.0,
 * not shapes invented here.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { CODEX_VERSION } from "@hercule/home/version";
import type { OutputSchema, ProbeResult, ProviderEvent, SessionSpec } from "@hercule/protocol";
import { INSTALL_DEADLINE } from "../install";
import { codexAdapter, CONTROL_DEADLINE, type CodexSeam } from "./adapter";
import { PROBE_DEADLINE } from "../probe";
import {
  API_KEY,
  type Answers,
  CHATGPT,
  cleanupHomes,
  contextIn,
  CWD,
  driving,
  FORKED,
  homing,
  INITIALIZE,
  PRIOR,
  RESUMED,
  refusal,
  scripted,
  SESSION,
  sentOf,
  settle,
  SILENT,
  SPEC,
  started,
  busy,
  taggedIn,
  THREAD,
  TURN,
  until,
  type Spawn,
} from "./testing";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));

afterAll(cleanupHomes);

const probing = (
  answers: Answers = {},
  options: { readonly dies?: boolean } = {},
): {
  readonly result: Promise<ProbeResult>;
  readonly spawns: Array<Spawn>;
  readonly home: string;
} => {
  const home = homing();
  const { seam, spawns } = scripted(answers, options);
  return { result: Effect.runPromise(codexAdapter(seam).probe(contextIn(home), {})), spawns, home };
};

const optionOf = (
  models: ProbeResult["models"],
  slug: string,
  id: string,
): Record<string, unknown> | undefined =>
  models.find((model) => model.slug === slug)?.options.find((option) => option.id === id);

const valuesOf = (option: Record<string, unknown> | undefined): ReadonlyArray<string> =>
  ((option?.["choices"] ?? []) as ReadonlyArray<{ readonly value: string }>).map(
    (choice) => choice.value,
  );

describe("what the Codex adapter reports about a machine", () => {
  it("takes the harness version out of the user agent, because initialize carries none", async () => {
    const { result } = probing();

    const probed = await result;
    expect(probed.harnessVersion).toBe("0.154.0");
  });

  it("says nothing about a user agent it cannot read a version out of", async () => {
    const { result } = probing({ initialize: () => ({ ...INITIALIZE, userAgent: "codex" }) });

    const probed = await result;
    // Null rather than a guess: `versionVerdict` reads that as "unknown".
    expect(probed.harnessVersion).toBeNull();
    expect(probed.auth.status).toBe("unauthenticated");
  });

  it("reports a logged-out machine as unauthenticated, naming nobody", async () => {
    const { result } = probing();

    const probed = await result;
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.auth.message).toBeUndefined();
    // The catalogue is still a fact about the machine: `model/list` answers
    // while logged out.
    expect(probed.models).not.toEqual([]);
  });

  it("names the ChatGPT account, its plan and its backend", async () => {
    const { result } = probing({ "account/read": () => CHATGPT });

    const probed = await result;
    expect(probed.auth).toMatchObject({
      status: "ok",
      identity: "rogier@example.com",
      planLabel: "pro",
      backend: "chatgpt",
    });
  });

  it("reports an API key as logged in with no identity to name", async () => {
    const { result } = probing({ "account/read": () => API_KEY });

    const probed = await result;
    expect(probed.auth.status).toBe("ok");
    expect(probed.auth.backend).toBe("apiKey");
    expect(probed.auth.identity).toBeUndefined();
  });

  it("maps each model to its slug, its name, and only the options it supports", async () => {
    const { result } = probing();

    const probed = await result;
    expect(probed.models.map((model) => model.slug)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
    expect(probed.models[0]).toMatchObject({ slug: "gpt-6-astra", name: "GPT-6-Astra" });
    expect(probed.models[0]?.isDefault).toBe(true);
    expect(probed.models[1]?.isDefault ?? false).toBe(false);

    const effort = optionOf(probed.models, "gpt-6-astra", "effort");
    expect(effort).toMatchObject({ kind: "select", default: "low" });
    expect(valuesOf(effort)).toEqual(["low", "medium", "high"]);
    expect(valuesOf(optionOf(probed.models, "gpt-5.5", "effort"))).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // A model the server lists no efforts for offers no effort choice.
    expect(optionOf(probed.models, "gpt-5.6-sol", "effort")).toBeUndefined();

    // `serviceTiers` lists only the tiers beyond the standard one and
    // `defaultServiceTier: null` means that one, so the
    // standard tier is a choice of Hercule's own and the default where Codex
    // names none - otherwise every turn would run on a paid tier nobody chose.
    expect(optionOf(probed.models, "gpt-6-astra", "serviceTier")).toMatchObject({
      kind: "select",
      default: "standard",
    });
    expect(valuesOf(optionOf(probed.models, "gpt-6-astra", "serviceTier"))).toEqual([
      "standard",
      "priority",
    ]);
    expect(valuesOf(optionOf(probed.models, "gpt-5.6-sol", "serviceTier"))).toEqual([
      "standard",
      "priority",
      "ultrafast",
    ]);
    // Offered only where the server named tiers: an empty select is a dead control.
    expect(optionOf(probed.models, "gpt-5.5", "serviceTier")).toBeUndefined();
  });

  it("reports an app-server that never answers initialize as an error, not as a blank row", async () => {
    const { result } = probing({ initialize: SILENT }, { dies: true });

    const probed = await result;
    expect(probed.harnessVersion).toBeNull();
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").not.toBe("");
    expect(probed.models).toEqual([]);
  });

  it("gives up on an app-server that answers nothing, and names the deadline", async () => {
    const home = homing();
    // A live child that simply never answers, which is what the deadline is
    // there for: a dead one is already reported by its stream ending.
    const { seam, spawns } = scripted({ initialize: SILENT });

    const probed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(codexAdapter(seam).probe(contextIn(home), {}));
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(PROBE_DEADLINE);
          return yield* Fiber.join(running);
        }),
        TestClock.layer(),
      ),
    );

    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").toContain(Duration.format(PROBE_DEADLINE));
    expect(probed.models).toEqual([]);
    // The child is the probe's own, so giving up on it means ending it.
    expect(spawns[0]?.kills()).toBe(1);
  });
});

describe("the process a probe runs on", () => {
  it("kills its own app-server, so a probe leaves nothing hosting", async () => {
    const { result, spawns } = probing();
    await result;

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.kills()).toBe(1);
  });

  it("spawns a fresh app-server for a second probe and for a session after one", async () => {
    const home = homing();
    const { seam, spawns } = scripted();
    const adapter = codexAdapter(seam);
    const ctx = contextIn(home);

    await Effect.runPromise(adapter.probe(ctx, {}));
    await Effect.runPromise(adapter.probe(ctx, {}));
    expect(spawns).toHaveLength(2);

    const started = Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx)).then(
      () => undefined,
      () => undefined,
    );
    await until("spawned a third app-server", () => spawns.length === 3);
    // A session's host is never the process a probe ran on: that one is dead.
    expect(spawns[2]?.kills()).toBe(0);
    await started;
  });

  it("keeps no host an app-server refused to initialize, and ends its child", async () => {
    const home = homing();
    let attempts = 0;
    const { seam, spawns } = scripted({
      initialize: () => {
        attempts += 1;
        return attempts === 1 ? refusal("the app-server could not start a session") : INITIALIZE;
      },
    });
    const adapter = codexAdapter(seam);
    const ctx = contextIn(home);

    const refused = await Effect.runPromise(Effect.flip(adapter.startSession(SESSION, SPEC, ctx)));

    expect(refused).toContain("could not start a session");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.kills()).toBe(1);

    // A host kept under the instance id would be one every later session talks
    // to and none of them can.
    const binding = await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));
    expect(binding.nativeSessionId).toBe(THREAD);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.kills()).toBe(0);
  });
});

describe("the home a session's app-server is given", () => {
  it("spawns the app-server with the updater off and its own Codex and HOME directories", async () => {
    const home = homing();
    const { seam, spawns } = scripted();
    const ctx = contextIn(home);

    const started = Effect.runPromise(codexAdapter(seam).startSession(SESSION, SPEC, ctx)).then(
      () => undefined,
      () => undefined,
    );
    await until("spawned an app-server", () => spawns.length === 1);

    const spawn = spawns[0]!;
    expect(spawn.command).toEqual([
      ctx.binary,
      "app-server",
      "--strict-config",
      "-c",
      "check_for_update_on_startup=false",
    ]);

    const codexHome = join(home, "codex");
    const neutral = join(home, "home");
    expect(spawn.env["CODEX_HOME"]).toBe(codexHome);
    // Relocated, because CODEX_HOME alone does not isolate skills: Codex reads
    // them from the user's own `~/.agents/skills`.
    expect(spawn.env["HOME"]).toBe(neutral);
    expect(existsSync(codexHome)).toBe(true);
    expect(existsSync(neutral)).toBe(true);
    expect(statSync(codexHome).mode & 0o777).toBe(0o700);
    expect(statSync(neutral).mode & 0o777).toBe(0o700);
    expect(readdirSync(neutral)).toEqual([]);
    for (const [key, value] of Object.entries(ctx.env)) {
      if (key === "HOME") continue;
      expect(spawn.env[key]).toBe(value);
    }
    await started;
  });
});

describe("the thread a session is given", () => {
  it("opens one in the session's directory, on its model and in its access mode", async () => {
    const { adapter, ctx, requests, seen } = driving();

    const binding = await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    expect(binding).toEqual({
      sessionId: SESSION,
      nativeSessionId: THREAD,
      instanceId: SPEC.instanceId,
    });
    expect(sentOf(requests, "thread/start")).toHaveLength(1);
    expect(sentOf(requests, "thread/start")[0]).toMatchObject({
      cwd: CWD,
      model: "gpt-5.5",
      ephemeral: false,
      // What `approval-required` is on a Codex thread.
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    await until("said the session started", () => taggedIn(seen, "session.started").length === 1);
    await settle();
    expect(taggedIn(seen, "session.started")).toHaveLength(1);
  });

  it("carries on a native thread by resuming it, naming the thread it was given", async () => {
    const { adapter, ctx, requests } = driving();
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } };

    const binding = await Effect.runPromise(adapter.startSession(SESSION, spec, ctx));

    expect(sentOf(requests, "thread/resume")).toEqual([
      expect.objectContaining({ threadId: PRIOR }),
    ]);
    expect(sentOf(requests, "thread/start")).toEqual([]);
    expect(binding.nativeSessionId).toBe(RESUMED);
  });

  it("branches off a native thread by forking it, and takes the new thread's id", async () => {
    const { adapter, ctx, requests } = driving();
    const spec: SessionSpec = { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "fork" } };

    const binding = await Effect.runPromise(adapter.startSession(SESSION, spec, ctx));

    expect(sentOf(requests, "thread/fork")).toEqual([expect.objectContaining({ threadId: PRIOR })]);
    expect(sentOf(requests, "thread/start")).toEqual([]);
    // The fork is a thread of its own: taking the id it was asked to fork from
    // would point the session at the thread it just left alone.
    expect(binding.nativeSessionId).toBe(FORKED);
  });

  it("fails with what the server said when a thread cannot be opened, and says nothing else", async () => {
    const { adapter, ctx, seen } = driving({
      "thread/start": () => refusal("no rollout found for thread id 00000000-0000"),
    });

    const refused = await Effect.runPromise(Effect.flip(adapter.startSession(SESSION, SPEC, ctx)));

    expect(refused).toContain("no rollout found");
    await settle();
    // A session that never started has not started: the supervisor reads
    // `session.started` as the session being live.
    expect(seen).toEqual([]);
    expect(await Effect.runPromise(adapter.listSessions)).toEqual([]);
  });
});

describe("what an input does to a Codex session", () => {
  it("opens a turn with the text when nothing is running", async () => {
    const run = await started();

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    expect(sent).toEqual({ turnId: TURN, delivery: "opened" });
    const opened = sentOf(run.requests, "turn/start");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ threadId: THREAD });
    expect(JSON.stringify(opened[0])).toContain("hello");
    expect(sentOf(run.requests, "turn/steer")).toEqual([]);
  });

  it("steers the running turn, naming the turn it expects to be steering", async () => {
    const run = await busy();

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "and the tests" }));

    expect(sent).toEqual({ turnId: TURN, delivery: "steered" });
    const steered = sentOf(run.requests, "turn/steer");
    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatchObject({ threadId: THREAD, expectedTurnId: TURN });
    expect(JSON.stringify(steered[0])).toContain("and the tests");
    // The first turn is the one the session opened; steering opened no second.
    expect(sentOf(run.requests, "turn/start")).toHaveLength(1);
  });

  it("opens a turn instead when the turn it meant to steer has moved on", async () => {
    const NEXT = "0199e0e7-0000-7000-8000-0000000000f9";
    let turns = 0;
    const run = await busy({
      "turn/steer": () => refusal(`expected turn ${TURN} is not the active turn`),
      "turn/start": () => {
        turns += 1;
        const id = turns === 1 ? TURN : NEXT;
        return { turn: { id, items: [], itemsView: "full", status: "inProgress" } };
      },
    });

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));

    // Never bounced: the input reaches the harness one way or the other, and
    // the adapter is the only authority on which way it went.
    expect(sent).toEqual({ turnId: NEXT, delivery: "opened" });
    expect(sentOf(run.requests, "turn/start")).toHaveLength(2);
  });

  it("opens a turn instead when the running turn cannot be steered at all", async () => {
    const NEXT = "0199e0e7-0000-7000-8000-0000000000f8";
    let turns = 0;
    const run = await busy({
      "turn/steer": () => refusal("activeTurnNotSteerable: the active turn is a review"),
      "turn/start": () => {
        turns += 1;
        const id = turns === 1 ? TURN : NEXT;
        return { turn: { id, items: [], itemsView: "full", status: "inProgress" } };
      },
    });

    const sent = await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "carry on" }));

    expect(sent).toEqual({ turnId: NEXT, delivery: "opened" });
    expect(sentOf(run.requests, "turn/steer")).toHaveLength(1);
    expect(sentOf(run.requests, "turn/start")).toHaveLength(2);
  });
});

describe("an app-server that stops answering a control request", () => {
  it("gives up on the interrupt rather than holding up every session on the machine", async () => {
    const { adapter, ctx, seen } = driving({ "turn/interrupt": SILENT });

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* adapter.startSession(SESSION, SPEC, ctx);
          yield* adapter.sendInput(SESSION, { text: "look around" });
          const stopping = yield* Effect.forkChild(adapter.stopSession(SESSION, "stopped"));
          // The runner handles session frames in the order they arrived, so a
          // stop that waited out the request deadline would stall the machine.
          yield* TestClock.adjust(CONTROL_DEADLINE);
          return yield* Fiber.join(stopping);
        }),
        TestClock.layer(),
      ),
    );

    expect(taggedIn(seen, "session.exited").map((event) => event.reason)).toEqual(["stopped"]);
  });

  it("reports one end when the thread closes while the stop is waiting", async () => {
    const run = driving({ "turn/interrupt": SILENT });
    await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));

    const stopping = Effect.runFork(run.adapter.stopSession(SESSION, "stopped"));
    await until(
      "asked the server to end the turn",
      () => sentOf(run.requests, "turn/interrupt").length === 1,
    );
    run.spawns[0]!.push({ method: "thread/closed", params: { threadId: THREAD } });
    await until("reported the session gone", () => taggedIn(run.seen, "session.exited").length > 0);
    await Effect.runPromise(Fiber.join(stopping));

    await settle();
    // The thread the server closed is the end that happened: the stop was
    // waiting on the harness while it came, and a second exit would be a second
    // row for one session's end.
    expect(taggedIn(run.seen, "session.exited").map((event) => event.reason)).toEqual([
      "idle_unload",
    ]);
  });
});

describe("a thread the server unloads by itself", () => {
  it("ends the session as an idle unload and holds it no longer", async () => {
    const run = await started();
    expect(await Effect.runPromise(run.adapter.listSessions)).toHaveLength(1);

    run.server.push({ method: "thread/closed", params: { threadId: THREAD } });

    await until(
      "reported the session gone",
      () => taggedIn(run.seen, "session.exited").length === 1,
    );
    // `idle_unload` is the one exit that leaves the native thread on disk, so
    // it is the one a later session can carry on from.
    expect(taggedIn(run.seen, "session.exited")[0]?.reason).toBe("idle_unload");
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });

  it("says nothing more when the supervisor stops a session that is already gone", async () => {
    const run = await started();
    run.server.push({ method: "thread/closed", params: { threadId: THREAD } });
    await until(
      "reported the session gone",
      () => taggedIn(run.seen, "session.exited").length === 1,
    );
    const reported = run.seen.length;

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    await settle();
    // A second exit would be a second row for one session's end.
    expect(run.seen).toHaveLength(reported);
    expect(taggedIn(run.seen, "session.exited")).toHaveLength(1);
  });
});

const OTHER_SESSION = "0199e0e7-0000-7000-8000-0000000000f7";

const OTHER_THREAD = "0199e0e7-0000-7000-8000-0000000000f6";

/** The token the runner put in each session's environment; they never match. */
const TOKENS = { [SESSION]: "token-of-the-first", [OTHER_SESSION]: "token-of-the-second" };

/** Two sessions of one instance, each with its own token and its own app-server. */
const pair = async (): Promise<ReturnType<typeof driving>> => {
  let opened = 0;
  const run = driving({
    "thread/start": () => {
      opened += 1;
      return { thread: { id: opened === 1 ? THREAD : OTHER_THREAD } };
    },
  });
  const withToken = (sessionId: keyof typeof TOKENS) => ({
    ...run.ctx,
    env: { ...run.ctx.env, HERCULE_TOKEN: TOKENS[sessionId] },
  });
  await Effect.runPromise(run.adapter.startSession(SESSION, SPEC, withToken(SESSION)));
  await Effect.runPromise(run.adapter.startSession(OTHER_SESSION, SPEC, withToken(OTHER_SESSION)));
  return run;
};

const exitsIn = (seen: ReadonlyArray<ProviderEvent>, sessionId: string): ReadonlyArray<string> =>
  taggedIn(seen, "session.exited")
    .filter((event) => event.sessionId === sessionId)
    .map((event) => event.reason);

describe("the app-server one session of an instance gets to itself", () => {
  it("is its own process, spawned with its own session token", async () => {
    const run = await pair();

    // Every shell command a Codex session runs is a child of its app-server and
    // inherits that process's environment. Two sessions on one process means
    // the second acting as the first: its credential, its grants, its stamp -
    // and a 401 for both the moment the first session's token is revoked (spec
    // 06 section 9.3).
    expect(run.spawns).toHaveLength(2);
    expect(run.spawns[0]?.env["HERCULE_TOKEN"]).toBe(TOKENS[SESSION]);
    expect(run.spawns[1]?.env["HERCULE_TOKEN"]).toBe(TOKENS[OTHER_SESSION]);
    expect(await Effect.runPromise(run.adapter.listSessions)).toHaveLength(2);
  });

  it("dies with the session that held it, and takes no other with it", async () => {
    const run = await pair();

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    // Killed, because a process left running holds a token that is already
    // dead; and only that one, because the other session has not ended.
    expect(run.spawns[0]?.kills()).toBe(1);
    expect(run.spawns[1]?.kills()).toBe(0);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([
      { sessionId: OTHER_SESSION, nativeSessionId: OTHER_THREAD, instanceId: SPEC.instanceId },
    ]);

    await Effect.runPromise(run.adapter.stopSession(OTHER_SESSION, "stopped"));
    expect(run.spawns[1]?.kills()).toBe(1);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([]);
  });

  it("ends the turn a stopped session was running and leaves the other alone", async () => {
    const run = await pair();
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "look around" }));

    await Effect.runPromise(run.adapter.stopSession(SESSION, "stopped"));

    // A turn left running would go on working in the workspace, with every
    // notification about it arriving for a session that is gone.
    expect(sentOf(run.requests, "turn/interrupt")).toEqual([{ threadId: THREAD, turnId: TURN }]);
    expect(exitsIn(run.seen, SESSION)).toEqual(["stopped"]);
    expect(exitsIn(run.seen, OTHER_SESSION)).toEqual([]);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([
      { sessionId: OTHER_SESSION, nativeSessionId: OTHER_THREAD, instanceId: SPEC.instanceId },
    ]);
  });

  it("reports the session on an app-server that stopped by itself, and only that one", async () => {
    const run = await pair();

    run.spawns[0]!.crash();

    await until(
      "reported the session gone",
      () => taggedIn(run.seen, "session.exited").length === 1,
    );
    expect(exitsIn(run.seen, SESSION)).toEqual(["process_exit"]);
    expect(exitsIn(run.seen, OTHER_SESSION)).toEqual([]);
    expect(await Effect.runPromise(run.adapter.listSessions)).toEqual([
      { sessionId: OTHER_SESSION, nativeSessionId: OTHER_THREAD, instanceId: SPEC.instanceId },
    ]);
  });

  it("says nothing about a thread no session on it holds", async () => {
    const run = await started();
    const reported = run.seen.length;

    run.server.push({ method: "thread/closed", params: { threadId: OTHER_THREAD } });

    await settle();
    // A thread this runner never opened is not this runner's to report on.
    expect(run.seen).toHaveLength(reported);
    expect(await Effect.runPromise(run.adapter.listSessions)).toHaveLength(1);
  });
});

const SELECTED = {
  model: "gpt-6-astra",
  options: { effort: "high", serviceTier: "priority" },
} as const;

describe("the model a turn runs under", () => {
  it("carries the session's whole selection on the turn it opens", async () => {
    const run = await started();

    await Effect.runPromise(
      run.adapter.sendInput(SESSION, { text: "hello", modelSelection: SELECTED }),
    );

    // Sent every time rather than only where it changed: Codex takes all three
    // per turn, and a selection changed and changed back is still a change.
    expect(sentOf(run.requests, "turn/start")[0]).toMatchObject({
      model: "gpt-6-astra",
      effort: "high",
      serviceTier: "priority",
    });
  });

  it("names no model on a turn the caller chose none for", async () => {
    const run = await started();

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    const opened = sentOf(run.requests, "turn/start")[0] as Record<string, unknown>;
    // The thread's own model stands: naming one here would be Hercule choosing.
    expect(opened["model"]).toBeUndefined();
    expect(opened["effort"]).toBeUndefined();
    expect(opened["serviceTier"]).toBeUndefined();
  });

  it("sends no service tier for a selection of the standard one, and sends a chosen one", async () => {
    // "standard" is Hercule's name for the tier Codex runs on when it is told
    // none, so choosing it means leaving the field off.
    const opened = async (tier: string): Promise<Record<string, unknown>> => {
      const run = await started();
      await Effect.runPromise(
        run.adapter.sendInput(SESSION, {
          text: "hello",
          modelSelection: { model: "gpt-6-astra", options: { serviceTier: tier } },
        }),
      );
      return sentOf(run.requests, "turn/start")[0] as Record<string, unknown>;
    };

    expect((await opened("standard"))["serviceTier"]).toBeUndefined();
    expect((await opened("priority"))["serviceTier"]).toBe("priority");
  });

  it("opens the thread on the model and the tier the session was given", async () => {
    const run = driving();

    await Effect.runPromise(
      run.adapter.startSession(SESSION, { ...SPEC, modelSelection: SELECTED }, run.ctx),
    );

    expect(sentOf(run.requests, "thread/start")[0]).toMatchObject({
      model: "gpt-6-astra",
      serviceTier: "priority",
    });
  });
});

/** The code spec 06 section 10.2 names for an overloaded server. */
const OVERLOADED = -32001;

const TURN_ANSWER = { turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" } };

/**
 * Walks the three backoff steps on a test clock, one attempt at a time, and
 * checks nothing retried before the clock said it could. 750, 1250 and 2250 ms
 * are the spec's 500, 1000 and 2000 with the whole 250 ms of jitter allowed and
 * not a millisecond more: a step that advanced further would pass on a base
 * nobody chose.
 */
const backingOff = (attempts: () => number) =>
  Effect.gen(function* () {
    for (const step of [0, 1, 2]) {
      yield* Effect.promise(() => until(`sent attempt ${step + 1}`, () => attempts() > step));
      yield* Effect.promise(settle);
      expect(attempts(), `attempt ${step + 2} came before the backoff`).toBe(step + 1);
      yield* TestClock.adjust(Duration.millis(500 * 2 ** step + 250));
    }
  });

describe("a turn the server is too busy to open", () => {
  it("retries it on the spec's backoff and keeps the input", async () => {
    let attempts = 0;
    const { adapter, ctx, requests } = driving({
      "turn/start": () => {
        attempts += 1;
        return attempts < 4 ? refusal("the server is overloaded", OVERLOADED) : TURN_ANSWER;
      },
    });

    const sent = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* adapter.startSession(SESSION, SPEC, ctx);
          const sending = yield* Effect.forkChild(adapter.sendInput(SESSION, { text: "hi" }));
          yield* backingOff(() => attempts);
          return yield* Fiber.join(sending);
        }),
        TestClock.layer(),
      ),
    );

    expect(sent).toEqual({ turnId: TURN, delivery: "opened" });
    expect(sentOf(requests, "turn/start")).toHaveLength(4);
  });

  it("gives up after the third retry, and fails with what the server said", async () => {
    let attempts = 0;
    const { adapter, ctx, requests } = driving({
      "turn/start": () => {
        attempts += 1;
        return refusal("the server is overloaded", OVERLOADED);
      },
    });

    const refused = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* adapter.startSession(SESSION, SPEC, ctx);
          const sending = yield* Effect.forkChild(
            Effect.flip(adapter.sendInput(SESSION, { text: "hi" })),
          );
          yield* backingOff(() => attempts);
          return yield* Fiber.join(sending);
        }),
        TestClock.layer(),
      ),
    );

    expect(refused).toContain("overloaded");
    // Three retries, not four: the send is bounded.
    expect(sentOf(requests, "turn/start")).toHaveLength(4);
  });

  it("does not retry an error that is not an overload", async () => {
    const { adapter, ctx, requests } = driving({
      "turn/start": () => refusal("thread not found: 00000000-0000-0000-0000-000000000000"),
    });
    await Effect.runPromise(adapter.startSession(SESSION, SPEC, ctx));

    const refused = await Effect.runPromise(
      Effect.flip(adapter.sendInput(SESSION, { text: "hi" })),
    );

    expect(refused).toContain("thread not found");
    // Retrying a request the server refused on its merits would just refuse
    // three more times, four seconds later.
    expect(sentOf(requests, "turn/start")).toHaveLength(1);
  });
});

const ENV: Readonly<Record<string, string | undefined>> = { PATH: "/usr/local/bin:/usr/bin" };

const installing = (
  answer: { readonly code: number; readonly stdout?: string; readonly stderr?: string },
  options: { readonly hangs?: boolean } = {},
): {
  readonly install: Effect.Effect<{ readonly ok: boolean; readonly message?: string }>;
  readonly commands: Array<ReadonlyArray<string>>;
  readonly envs: Array<Readonly<Record<string, string | undefined>>>;
} => {
  const commands: Array<ReadonlyArray<string>> = [];
  const envs: Array<Readonly<Record<string, string | undefined>>> = [];
  const seam: CodexSeam = {
    appServer: () => {
      throw new Error("installing must not start an app-server");
    },
    run: (command, env) => {
      commands.push(command);
      envs.push(env);
      return options.hangs === true
        ? Effect.never
        : Effect.succeed({
            code: answer.code,
            stdout: answer.stdout ?? "",
            stderr: answer.stderr ?? "",
          });
    },
  };
  return { install: codexAdapter(seam).install!(ENV), commands, envs };
};

describe("installing the Codex harness", () => {
  it("runs the vendor's install script pinned to the release this build talks to", async () => {
    const { install, commands, envs } = installing({ code: 0, stdout: "Installed codex" });

    const outcome = await Effect.runPromise(install);

    expect(outcome.ok).toBe(true);
    expect(commands).toEqual([
      [
        "bash",
        "-c",
        `curl -fsSL https://raw.githubusercontent.com/openai/codex/rust-v${CODEX_VERSION}/scripts/install/install.sh | CODEX_RELEASE=${CODEX_VERSION} CODEX_NON_INTERACTIVE=1 sh`,
      ],
    ]);
    expect(envs).toEqual([ENV]);
  });

  it("says what the installer said when it failed, rather than that it failed", async () => {
    const stderr = [
      "resolving the release",
      "  % Total    % Received",
      "curl: (22) The requested URL returned error: 404",
      "install.sh: could not download the archive",
      "install.sh: giving up",
      "install.sh: nothing was installed",
    ].join("\n");
    const { install } = installing({ code: 1, stderr });

    const outcome = await Effect.runPromise(install);

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? "").toContain("install.sh: nothing was installed");
    // The last five lines, so the banner above them is not what the user reads.
    expect(outcome.message ?? "").toContain("  % Total    % Received");
    expect(outcome.message ?? "").not.toContain("resolving the release");
  });

  it("gives up on an installer that outlives the deadline, and names it", async () => {
    const { install } = installing({ code: 0 }, { hangs: true });

    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(install);
          yield* TestClock.adjust(Duration.zero);
          yield* TestClock.adjust(INSTALL_DEADLINE);
          return yield* Fiber.join(running);
        }),
        TestClock.layer(),
      ),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? "").toContain(Duration.format(INSTALL_DEADLINE));
  });
});

/** Built rather than written, so the literals are not in this file for it to find. */
const grepping = (pattern: string): string =>
  Bun.spawnSync({
    cmd: ["bash", "-c", `grep -rn '${pattern}' apps/runner/src --include=*.ts || true`],
    cwd: root,
  })
    .stdout.toString()
    .split("\n")
    .filter((line) => line !== "" && !line.includes("/generated/"))
    .join("\n");

describe("the two Codex surfaces this adapter must never reach for", () => {
  it("calls neither the shell-command method nor the process one", () => {
    // A runner that let a harness spawn its own processes would host work
    // outside every session boundary Hercule places.
    expect(grepping(["thread/shell", "Command", "\\|process/", "spawn"].join(""))).toBe("");
  });

  it("never names the user's own Codex home", () => {
    // The only Codex home a runner may touch is the one built from `ctx.home`.
    expect(grepping(["~/\\", ".codex\\|$HOME/\\", ".codex"].join(""))).toBe("");
  });
});

/** What the runner resolved once, at start, for every adapter. */
const TOOL = {
  skill: "# hercule\n\nCall `hercule --help` to find out what this controller can do.\n",
  claudePluginDir: "/var/hercule/runner/storage/claude-plugin",
};

/**
 * What an Agent puts on a Codex session: instructions of its own and a schema
 * every turn has to answer under (spec 06 section 7). `disallowedTools` rides
 * along on the spec too, and Codex enforces none of it.
 */
const OUTPUT_SCHEMA: OutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["accept", "dismiss"] },
    confidence: { type: "number" },
  },
};

const SYSTEM_PROMPT = "You assess tasks and answer with a verdict.";

const STRUCTURED: SessionSpec = {
  ...SPEC,
  systemPrompt: SYSTEM_PROMPT,
  outputSchema: OUTPUT_SCHEMA,
};

const ANSWER = { verdict: "accept", confidence: 0.9 };

describe("hercule-as-a-tool on a Codex thread", () => {
  /** The Agent's instructions above the skill, as one text. */
  const INSTRUCTED = `${SYSTEM_PROMPT}\n\n${TOOL.skill}`;

  const OPENINGS: ReadonlyArray<readonly [string, SessionSpec, string]> = [
    ["thread/start", SPEC, TOOL.skill],
    [
      "thread/resume",
      { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "resume" } },
      TOOL.skill,
    ],
    ["thread/fork", { ...SPEC, continue: { nativeSessionId: PRIOR, mode: "fork" } }, TOOL.skill],
    ["thread/start", STRUCTURED, INSTRUCTED],
    [
      "thread/resume",
      { ...STRUCTURED, continue: { nativeSessionId: PRIOR, mode: "resume" } },
      INSTRUCTED,
    ],
    [
      "thread/fork",
      { ...STRUCTURED, continue: { nativeSessionId: PRIOR, mode: "fork" } },
      INSTRUCTED,
    ],
  ];

  it.each(OPENINGS)(
    "carries the session's own instructions as %s's developer instructions",
    async (method, spec, instructions) => {
      const { adapter, ctx, requests } = driving();

      await Effect.runPromise(adapter.startSession(SESSION, spec, { ...ctx, herculeTool: TOOL }));

      // The channel #73 found, and the only one: a session that cannot be told
      // the CLI exists never calls it (spec 06 section 9.1). An Agent's own
      // prompt shares it, and a thread continued from one carries both.
      expect(sentOf(requests, method)).toEqual([
        expect.objectContaining({ developerInstructions: instructions }),
      ]);
    },
  );

  it("writes no AGENTS.md into the scratch directory it runs in", async () => {
    const scratch = homing();
    const { adapter, ctx } = driving({}, scratch);

    await Effect.runPromise(adapter.startSession(SESSION, SPEC, { ...ctx, herculeTool: TOOL }));
    await settle();

    // The retired channel (spec 06 section 9.1, amended 2026-09-14): a file
    // here is instructions the harness reads out of a directory Hercule says is
    // empty, and one more copy of the skill to keep current.
    expect(existsSync(join(scratch, "AGENTS.md"))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });
});

/** A turn's final agent message, which is where a Codex answer is read off. */
const agentMessage = (text: string): Record<string, unknown> => ({
  type: "agentMessage",
  id: "0199e0e7-0000-7000-8000-0000000000e1",
  text,
});

/** An item that is not an agent message, so a turn can end without an answer. */
const COMMAND: Record<string, unknown> = {
  type: "commandExecution",
  id: "0199e0e7-0000-7000-8000-0000000000e2",
  command: "echo hi",
  cwd: CWD,
  status: "completed",
  commandActions: [],
  aggregatedOutput: "hi\n",
  exitCode: 0,
};

/**
 * Ends the running turn, with its items announced one by one and carried on
 * the completion as well: the app-server does both, so an adapter may read the
 * final message off either and this script never decides which.
 */
const completeTurn = (
  run: ReturnType<typeof driving>,
  items: ReadonlyArray<Record<string, unknown>>,
  status: "completed" | "failed" | "interrupted" = "completed",
): void => {
  const server = run.spawns[0]!;
  for (const item of items) {
    server.push({
      method: "item/completed",
      params: { threadId: THREAD, turnId: TURN, item, completedAtMs: 1789373122124 },
    });
  }
  server.push({
    method: "turn/completed",
    params: { threadId: THREAD, turn: { id: TURN, items, itemsView: "full", status } },
  });
};

/** Runs one turn that ends with these items, and answers its `turn.completed`. */
const runTurnToCompletion = async (
  spec: SessionSpec,
  items: ReadonlyArray<Record<string, unknown>>,
  status: "completed" | "failed" | "interrupted" = "completed",
): Promise<Extract<ProviderEvent, { _tag: "turn.completed" }>> => {
  const run = driving();
  await Effect.runPromise(
    run.adapter.startSession(SESSION, spec, { ...run.ctx, herculeTool: TOOL }),
  );
  await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
  completeTurn(run, items, status);
  await until("closed the turn", () => taggedIn(run.seen, "turn.completed").length === 1);
  return taggedIn(run.seen, "turn.completed")[0]!;
};

describe("a Codex session the controller spawned from an Agent", () => {
  it("carries the agent's instructions above the skill as the thread's developer instructions", async () => {
    const { adapter, ctx, requests } = driving();

    await Effect.runPromise(
      adapter.startSession(SESSION, STRUCTURED, { ...ctx, herculeTool: TOOL }),
    );

    // Both, in that order, and nothing else: the skill is how a session learns
    // the CLI exists (spec 06 section 9.1) and dropping it for the Agent's
    // prompt would take the tool away from every session an Agent spawns.
    expect(sentOf(requests, "thread/start")).toEqual([
      expect.objectContaining({
        developerInstructions: `${SYSTEM_PROMPT}\n\n${TOOL.skill}`,
      }),
    ]);
  });

  it("opens every turn of the session under the schema, not just the first", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, run.ctx));

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
    completeTurn(run, [agentMessage(JSON.stringify(ANSWER))]);
    await until("closed the first turn", () => taggedIn(run.seen, "turn.completed").length === 1);
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "And this one." }));

    // Codex takes the schema per turn, so a session that sent it once would
    // answer prose from its second turn on.
    const opened = sentOf(run.requests, "turn/start");
    expect(opened).toHaveLength(2);
    expect(opened[0]).toMatchObject({ outputSchema: OUTPUT_SCHEMA });
    expect(opened[1]).toMatchObject({ outputSchema: OUTPUT_SCHEMA });
  });

  it("names no schema on a turn of a session that was given none", async () => {
    const run = await started();

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "hello" }));

    // The field is absent, and is not null. A Thread answers prose, and a
    // schema field on every turn would make this adapter say something the
    // spec never said.
    const opened = sentOf(run.requests, "turn/start")[0] as Record<string, unknown>;
    expect("outputSchema" in opened).toBe(false);
  });

  it("sends exactly what it sends without them when the spec takes tool families away", async () => {
    const startAndSend = async (spec: SessionSpec): Promise<ReadonlyArray<unknown>> => {
      const run = driving();
      await Effect.runPromise(
        run.adapter.startSession(SESSION, spec, { ...run.ctx, herculeTool: TOOL }),
      );
      await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
      return [...sentOf(run.requests, "thread/start"), ...sentOf(run.requests, "turn/start")];
    };

    // Codex declares `disallowedTools: unsupported` (#224), and the record the
    // caller reads already says so: an adapter that invented an enforcement
    // here would be the silent substitution the spec forbids.
    expect(await startAndSend({ ...STRUCTURED, disallowedTools: ["edit", "shell"] })).toEqual(
      await startAndSend(STRUCTURED),
    );
  });
});

describe("what a Codex turn under an output schema answers with", () => {
  it("reports the final agent message as the turn's result when it satisfies the schema", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, [agentMessage(JSON.stringify(ANSWER))]);

    expect(completed.state).toBe("completed");
    expect(completed.structuredResult).toEqual({ outcome: "ok", value: ANSWER });
  });

  it("reports a schema failure when the final agent message is not JSON at all", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, [
      agentMessage("I had a look and I would accept it."),
    ]);

    // The adapter chooses the wording. The test only asserts that a reason is
    // present.
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringMatching(/\S/) as string,
    });
  });

  it("reports a schema failure naming the field when the message is JSON the schema refuses", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, [
      agentMessage(JSON.stringify({ verdict: "maybe", confidence: 0.9 })),
    ]);

    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringContaining("verdict") as string,
    });
  });

  it("reports a schema failure saying there was no final message when the turn ended on another item", async () => {
    const completed = await runTurnToCompletion(STRUCTURED, [
      agentMessage(JSON.stringify(ANSWER)),
      COMMAND,
    ]);

    // Answered at once rather than retried: a retry is optional in spec 06
    // section 7 and this feature does not build one. An earlier message is not
    // the answer either - the turn went on working after it.
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringMatching(/\S/) as string,
    });
  });

  it("says nothing about a result on a session that was never given a schema", async () => {
    const completed = await runTurnToCompletion(SPEC, [agentMessage(JSON.stringify(ANSWER))]);

    // The key is absent, and is not an `ok` over no schema. A Thread answers
    // prose, and a key on every turn of every session would give "ok" a second
    // meaning.
    expect("structuredResult" in completed).toBe(false);
  });

  it("says nothing about the schema on a turn that failed or was interrupted", async () => {
    const failed = await runTurnToCompletion(STRUCTURED, [COMMAND], "failed");
    const interrupted = await runTurnToCompletion(STRUCTURED, [COMMAND], "interrupted");

    // The end is about the turn and not about the schema. A `schema-failure`
    // here would claim that an answer was judged and rejected.
    expect("structuredResult" in failed).toBe(false);
    expect("structuredResult" in interrupted).toBe(false);
  });

  it("judges each turn on its own answer, never on the turn before it", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));
    completeTurn(run, [agentMessage(JSON.stringify(ANSWER))]);
    await until("closed the first turn", () => taggedIn(run.seen, "turn.completed").length === 1);

    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "And this one." }));
    run.spawns[0]!.push({
      method: "turn/started",
      params: {
        threadId: THREAD,
        turn: { id: TURN, items: [], itemsView: "full", status: "inProgress" },
      },
    });
    completeTurn(run, []);
    await until("closed the second turn", () => taggedIn(run.seen, "turn.completed").length === 2);

    // An answer that outlived its turn would report the first turn's value as
    // the second turn's answer. Nobody could tell that stale result from a
    // fresh one.
    expect(taggedIn(run.seen, "turn.completed")[1]!.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: "the turn ended without a final agent message",
    });
  });

  it("reads the answer off the items the turn announced, not off the completion's own list", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Assess this task." }));

    // This completion carries a partial view of its items, which the
    // app-server states itself. A list the app-server never promised was
    // complete is not a turn's answer.
    run.spawns[0]!.push({
      method: "turn/completed",
      params: {
        threadId: THREAD,
        turn: {
          id: TURN,
          items: [agentMessage(JSON.stringify(ANSWER))],
          itemsView: "summary",
          status: "completed",
        },
      },
    });
    await until("closed the turn", () => taggedIn(run.seen, "turn.completed").length === 1);

    expect(taggedIn(run.seen, "turn.completed")[0]!.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: "the turn ended without a final agent message",
    });
  });
});

/**
 * What the API answers when the schema itself cannot be constrained on,
 * captured from codex 0.154.0 against the impossible fixture: the turn fails
 * before the model is sampled, and the name Codex gives the response format is
 * in the message.
 */
const REFUSED = [
  '{\n  "type": "error",\n  "error": {\n    "type": "invalid_request_error",',
  '\n    "code": "invalid_json_schema",',
  '\n    "message": "Invalid schema for response_format \'codex_output_schema\': ',
  "context=('properties', 'answer'), const value b does not validate against ",
  "{'type': 'string', 'enum': ['a']}.\",\n    \"param\": \"text.format.schema\"\n  },",
  '\n  "status": 400\n}',
].join("");

describe("a Codex turn the harness refused the schema of", () => {
  it("reports the refusal as the schema failure, on the turn's own end state", async () => {
    const run = driving();
    await Effect.runPromise(run.adapter.startSession(SESSION, STRUCTURED, run.ctx));
    await Effect.runPromise(run.adapter.sendInput(SESSION, { text: "Answer." }));

    run.spawns[0]!.push({
      method: "turn/completed",
      params: {
        threadId: THREAD,
        turn: {
          id: TURN,
          items: [],
          itemsView: "full",
          status: "failed",
          error: { message: REFUSED, codexErrorInfo: "other" },
        },
      },
    });
    await until("closed the turn", () => taggedIn(run.seen, "turn.completed").length === 1);

    // The sentence the harness wrote, and the state the harness reported: a
    // turn that never reached the model failed, and it failed over the schema.
    // The envelope around the sentence - a status, a param, a type - is the
    // transport's, and a transcript line showing it would say nothing.
    const completed = taggedIn(run.seen, "turn.completed")[0]!;
    expect(completed.state).toBe("failed");
    expect(completed.structuredResult).toEqual({
      outcome: "schema-failure",
      reason: expect.stringMatching(/^Invalid schema for response_format/) as string,
    });
  });
});
