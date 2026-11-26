/**
 * Tests that a sign-in and a running `agy` never share one Harness Home,
 * through the runner's login and the Antigravity adapter. The sign-in is a
 * fake login process; the sessions and probes run on a fake `agy`.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import type { SessionSpec } from "@hercule/protocol";
import { cleanupHomes, CWD, settle, waitUntil } from "../testing";
import { LOGIN_IDLE, makeLogins, type LoginAnswer, type LoginSpawn } from "../login";
import { makeAntigravityAdapter } from "./adapter";
import {
  BINARY,
  buildContext,
  buildFakeAgy,
  createSignedInHome,
  noAnswer,
} from "./fake-agy.testing";

afterEach(() => {
  cleanupHomes();
});

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const ACCOUNT = "0199e0e7-0000-7000-8000-00000000000a";
const REQUEST = "0199e0e7-0000-7000-8000-0000000000a1";
const URL = "https://accounts.google.com/o/oauth2/auth?state=one";

const SPEC: SessionSpec = {
  providerAccountId: ACCOUNT,
  workspaceId: null,
  modelSelection: { model: "gemini-4-hydrogen", options: { effort: "high" } },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

/**
 * A fake login process that prints a link at once. `exitOnCode` is the exit
 * code it ends with when it is given a code, as `agy` does.
 */
const buildLoginMachine = (exitOnCode: number) => {
  const spawned: Array<{ readonly kill: () => void; readonly exit: (code: number) => void }> = [];
  const spawn: LoginSpawn = () => {
    let settleExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      settleExit = resolve;
    });
    const lines = [`${URL}\n`];
    const stdout = (async function* () {
      await Promise.resolve();
      yield* lines;
      await exited;
    })();
    spawned.push({ kill: () => settleExit(143), exit: settleExit });
    return {
      stdout,
      stderr: (async function* () {
        await exited;
        yield* [];
      })(),
      write: () => settleExit(exitOnCode),
      kill: () => settleExit(143),
      exited,
    };
  };
  return { spawn, spawned };
};

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

const failureOf = (answer: LoginAnswer): string =>
  answer._tag === "loginFailed" ? answer.message : `not a failure: ${answer._tag}`;

describe("a sign-in while sessions and probes run", () => {
  it("is refused while a session runs, and nothing is stopped; it works after the session ends", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home);
    const adapter = makeAntigravityAdapter(fake);
    const machine = buildLoginMachine(0);
    const logins = makeLogins(machine.spawn);
    const ctx = { ...buildContext(home, BINARY), cwd: CWD, mcpServers: [] };

    await run(adapter.startSession(SESSION, SPEC, ctx));
    const refused = await run(logins.start(REQUEST, ACCOUNT, adapter, ctx, "sign-in"));

    expect(failureOf(refused)).toContain("1 session");
    expect(machine.spawned).toHaveLength(0);
    expect(fake.spawns[0]!.hasExited).toBe(false);

    await run(adapter.stopSession(SESSION, "stopped"));
    const started = await run(logins.start(REQUEST, ACCOUNT, adapter, ctx, "sign-in"));

    expect(started._tag).toBe("loginUrl");
  });

  it("is refused while a probe runs", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, { scripts: { authenticate: noAnswer } });
    const adapter = makeAntigravityAdapter(fake);
    const logins = makeLogins(buildLoginMachine(0).spawn);
    const ctx = buildContext(home, BINARY);

    const refused = await run(
      Effect.gen(function* () {
        const probing = yield* Effect.forkChild(adapter.probe(ctx, { readUsage: false }));
        yield* Effect.promise(() =>
          waitUntil("the probe's agy got authenticate", () =>
            (fake.spawns[0]?.harness.received ?? []).some((m) => m.method === "authenticate"),
          ),
        );
        const answer = yield* logins.start(REQUEST, ACCOUNT, adapter, ctx, "sign-in");
        yield* Fiber.interrupt(probing);
        return answer;
      }),
    );

    expect(failureOf(refused)).toContain("a check of this account");
  });

  it("does not touch another account's home", async () => {
    const running = createSignedInHome();
    const other = createSignedInHome("bo@example.com");
    const adapter = makeAntigravityAdapter(buildFakeAgy(running));
    const logins = makeLogins(buildLoginMachine(0).spawn);

    await run(
      adapter.startSession(SESSION, SPEC, {
        ...buildContext(running, BINARY),
        cwd: CWD,
        mcpServers: [],
      }),
    );
    const answer = await run(
      logins.start(REQUEST, ACCOUNT, adapter, buildContext(other, BINARY), "sign-in"),
    );

    expect(answer._tag).toBe("loginUrl");
    await run(adapter.stopSession(SESSION, "stopped"));
  });
});

describe("a session start and a probe during a sign-in", () => {
  it("are refused with the reason, until the sign-in ends", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home);
    const adapter = makeAntigravityAdapter(fake);
    const machine = buildLoginMachine(1);
    const logins = makeLogins(machine.spawn);
    const ctx = { ...buildContext(home, BINARY), cwd: CWD, mcpServers: [] };

    await run(logins.start(REQUEST, ACCOUNT, adapter, ctx, "sign-in"));
    const start = await run(Effect.flip(adapter.startSession(SESSION, SPEC, ctx)));
    const probe = await run(adapter.probe(ctx, { readUsage: false }));

    expect(start._tag).toBe("AdapterFailed");
    expect(start.message).toContain("sign-in of this account is in progress");
    expect(probe.auth.status).toBe("error");
    expect(probe.auth.status === "error" ? probe.auth.message : "").toContain(
      "sign-in of this account is in progress",
    );
    expect(fake.spawns).toHaveLength(0);

    // The wrong code ends the login process, which frees the home.
    await run(logins.submit(ACCOUNT, "wrong"));
    await run(adapter.startSession(SESSION, SPEC, ctx));
    await run(adapter.stopSession(SESSION, "stopped"));
  });

  it("are not refused for another account's home", async () => {
    const signingIn = createSignedInHome();
    const other = createSignedInHome("bo@example.com");
    const adapter = makeAntigravityAdapter(buildFakeAgy(other));
    const logins = makeLogins(buildLoginMachine(0).spawn);

    await run(logins.start(REQUEST, ACCOUNT, adapter, buildContext(signingIn, BINARY), "sign-in"));
    const probe = await run(adapter.probe(buildContext(other, BINARY), { readUsage: false }));

    expect(probe.auth.status).toBe("ok");
  });
});

describe("a sign-in that succeeded", () => {
  it("refuses a session start until the first probe after it has finished", async () => {
    const home = createSignedInHome();
    const adapter = makeAntigravityAdapter(buildFakeAgy(home));
    const logins = makeLogins(buildLoginMachine(0).spawn);
    const ctx = { ...buildContext(home, BINARY), cwd: CWD, mcpServers: [] };
    await run(logins.start(REQUEST, ACCOUNT, adapter, ctx, "sign-in"));

    const answer = await run(logins.submit(ACCOUNT, "right"));
    const refused = await run(Effect.flip(adapter.startSession(SESSION, SPEC, ctx)));
    const probe = await run(adapter.probe(ctx, { readUsage: false }));
    await run(adapter.startSession(SESSION, SPEC, ctx));
    await run(adapter.stopSession(SESSION, "stopped"));

    expect(answer).toEqual({ _tag: "loginResult", ok: true });
    expect(refused.message).toContain("being checked");
    expect(probe.auth.status).toBe("ok");
  });
});

describe("the sign-in's lease", () => {
  const holdsHome = async (adapter: ReturnType<typeof makeAntigravityAdapter>, home: string) => {
    const ctx = { ...buildContext(home, BINARY), cwd: CWD, mcpServers: [] };
    const result = await run(Effect.result(adapter.startSession(SESSION, SPEC, ctx)));
    if (result._tag === "Success") await run(adapter.stopSession(SESSION, "stopped"));
    return result._tag === "Failure";
  };

  it("is released after a wrong code", async () => {
    const home = createSignedInHome();
    const adapter = makeAntigravityAdapter(buildFakeAgy(home));
    const logins = makeLogins(buildLoginMachine(1).spawn);
    await run(logins.start(REQUEST, ACCOUNT, adapter, buildContext(home, BINARY), "sign-in"));

    await run(logins.submit(ACCOUNT, "wrong"));

    expect(await holdsHome(adapter, home)).toBe(false);
  });

  it("is released after the runner stops the login", async () => {
    const home = createSignedInHome();
    const adapter = makeAntigravityAdapter(buildFakeAgy(home));
    const logins = makeLogins(buildLoginMachine(0).spawn);
    await run(logins.start(REQUEST, ACCOUNT, adapter, buildContext(home, BINARY), "sign-in"));
    expect(await holdsHome(adapter, home)).toBe(true);

    await run(logins.stopAll);

    expect(await holdsHome(adapter, home)).toBe(false);
  });

  it("is released when a new login replaces the old one, and the new login holds it", async () => {
    const home = createSignedInHome();
    const adapter = makeAntigravityAdapter(buildFakeAgy(home));
    const machine = buildLoginMachine(0);
    const logins = makeLogins(machine.spawn);
    const ctx = buildContext(home, BINARY);
    await run(logins.start(REQUEST, ACCOUNT, adapter, ctx, "sign-in"));

    const second = await run(logins.start(REQUEST, ACCOUNT, adapter, ctx, "sign-in"));

    expect(second._tag).toBe("loginUrl");
    expect(machine.spawned).toHaveLength(2);
    expect(await holdsHome(adapter, home)).toBe(true);
  });

  it("is released when the login sits idle until its timeout", async () => {
    const home = createSignedInHome();
    const adapter = makeAntigravityAdapter(buildFakeAgy(home));
    const logins = makeLogins(buildLoginMachine(0).spawn);
    await run(
      Effect.gen(function* () {
        yield* logins.start(REQUEST, ACCOUNT, adapter, buildContext(home, BINARY), "sign-in");
        yield* Effect.promise(settle);
        yield* TestClock.adjust(Duration.sum(LOGIN_IDLE, Duration.seconds(1)));
        yield* Effect.promise(settle);
      }),
    );

    expect(await holdsHome(adapter, home)).toBe(false);
  });
});
