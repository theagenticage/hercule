/**
 * Tests for the local runner the controller spawns and supervises.
 *
 * Every test runs a real boot with a real child process. Only the command
 * differs from the default: the default command is the Bun binary this test
 * already runs in, so without a stub child the supervisor could not be tested
 * at all. The stub writes what it received to a file, so the tests check what
 * the child really saw (its argv, its environment and the bytes on its stdin),
 * not what the controller believes it sent.
 *
 * What the tests check:
 *
 * - the stdout and stdin handshake;
 * - the first boot's join token and the join that follows;
 * - that the second boot sends no token;
 * - that an unreadable first line stops the boot;
 * - the restart schedule and the crash-loop record;
 * - what a stop does to a child that exits on SIGTERM, and to one that does
 *   not.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Duration, Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { bootWith, type BootOutcome, type ControllerServices } from "../bootstrap";
import { operationLayers, serve } from "../http";
import { EvaluationErrorNotifierLayer } from "../subscriptions";
import { Settings } from "../settings";
import {
  CRASH_LOOP_LIMIT,
  CRASH_LOOP_WINDOW,
  createCrashCounter,
  LOCAL_RUNNER_BACKOFF,
  LOCAL_RUNNER_COMMAND,
  LOCAL_RUNNER_STOP_DEADLINE,
  RunnerAlerts,
  type LocalRunnerOptions,
} from "./local";
import { runnerRepository } from "./repository";

const homes: Array<string> = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const createTemporaryHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hercule-local-"));
  homes.push(home);
  return home;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Checks whether a process is still running. Signal 0 checks without sending a signal. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Returns a free port, found by binding one and releasing it. The boot needs
 * the address before it runs, because the child is told where to join.
 */
const findFreePort = async (): Promise<number> => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = Number(server.port);
  await server.stop(true);
  return port;
};

/**
 * The stub child, a script rather than the real binary: it starts in
 * milliseconds, does exactly what a test needs, and records everything it
 * receives.
 */
const CHILD = `
import { appendFileSync } from "node:fs";

const argv = Bun.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const state = flag("--state");
const record = (entry) => appendFileSync(state, JSON.stringify(entry) + "\\n");

// Installed before anything else. The parent stops waiting at its own
// deadline, so a handler installed after the announcement could race the
// signal, and a child without a handler would die silently.
if (flag("--deaf") === undefined) {
  process.on("SIGTERM", () => {
    record({ what: "sigterm", at: Date.now() });
    process.exit(0);
  });
} else {
  process.on("SIGTERM", () => record({ what: "sigterm-ignored", at: Date.now() }));
}

record({ what: "spawned", at: Date.now(), pid: process.pid, argv: Bun.argv, env: { ...process.env } });
process.stdout.write(flag("--announce") + "\\n");

const exitAfter = flag("--exit");
if (exitAfter !== undefined) process.exit(Number(exitAfter));

let text = "";
for await (const chunk of Bun.stdin.stream()) text += new TextDecoder().decode(chunk);
record({ what: "stdin", at: Date.now(), text });

// What a real local runner does with the enrolment: an ordinary join over
// loopback, retried until the controller is listening.
if (text.trim() !== "") {
  const line = JSON.parse(text.trim());
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(new URL("/api/v1/runners/join", line.controllerUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + line.token },
        body: "{}",
      });
      if (response.ok) {
        record({ what: "joined", at: Date.now(), answer: await response.json() });
        break;
      }
      record({ what: "refused", at: Date.now(), status: response.status });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

await new Promise(() => {});
`;

/** One entry the stub child recorded. */
interface Note {
  readonly what: string;
  readonly at: number;
  readonly pid?: number;
  readonly argv?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly answer?: { readonly runnerId: string };
}

/**
 * Builds a stub child in this home, and returns its command and a reader for
 * its notes. Each child has its own notes file, because a home outlives a
 * boot: two boots of one home have two children, and each receives different
 * input.
 */
let children = 0;
const buildStubChild = (
  home: string,
  announce: string,
  extra: ReadonlyArray<string> = [],
): { readonly command: ReadonlyArray<string>; readonly notes: () => ReadonlyArray<Note> } => {
  children += 1;
  const script = join(home, `child-${String(children)}.ts`);
  const state = join(home, `child-${String(children)}.jsonl`);
  writeFileSync(script, CHILD);
  return {
    command: [process.execPath, "run", script, "--state", state, "--announce", announce, ...extra],
    // The child can still be writing its last line while the test reads the
    // file. Only lines that end with a line break are complete, so the text
    // after the last line break is ignored.
    notes: () =>
      existsSync(state)
        ? readFileSync(state, "utf8")
            .split("\n")
            .slice(0, -1)
            .map((line) => JSON.parse(line) as Note)
        : [],
  };
};

/** Polls the child's notes until `ready` returns true or `within` passes, and returns them. */
const waitForNotes = async (
  notes: () => ReadonlyArray<Note>,
  ready: (all: ReadonlyArray<Note>) => boolean,
  within = 10_000,
): Promise<ReadonlyArray<Note>> => {
  for (let waited = 0; waited < within && !ready(notes()); waited += 20) await delay(20);
  return notes();
};

/**
 * Boots a controller that supervises the given child, with the server
 * listening, and runs `body`. The child joins over loopback like the real one,
 * so the fleet ends up with a real row from a real join.
 */
const bootAndHold = <A>(
  home: string,
  port: number,
  local: LocalRunnerOptions,
  body: (outcome: BootOutcome) => Effect.Effect<A, never, ControllerServices>,
): Promise<A> =>
  Effect.runPromise(
    bootWith(
      {
        argv: ["--home", home, "-c", "bind.host=127.0.0.1", "-c", `bind.port=${String(port)}`],
        env: {},
        masterKeyBackend: "file",
        localRunner: local,
      },
      (outcome) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* serve(undefined);
            return yield* body(outcome);
          }).pipe(
            Effect.provide(operationLayers),
            Effect.provide(EvaluationErrorNotifierLayer),
            Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port, reusePort: true })),
          ),
        ),
    ).pipe(Effect.orDie),
  );

/** Counts the join tokens this home has created. */
const tokensMinted = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM runner_join_tokens`,
  ),
  (rows) => Number(rows[0]?.n ?? 0),
);

/** Returns the names of this home's runner rows, sorted. */
const runnerNames = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly name: string }>`SELECT name FROM runners ORDER BY name`,
  ),
  (rows) => rows.map((row) => row.name),
);

/** Short deadlines a test can wait for. The crash window keeps its default. */
const FAST = {
  backoff: { first: Duration.millis(20), cap: Duration.millis(60) },
  stopDeadline: Duration.millis(200),
  handshakeDeadline: Duration.millis(200),
};

describe("the command the controller spawns", () => {
  it("is this process's own binary, started as a local runner", () => {
    // Spawn, never fork (spec 15 section 4). A compiled Hercule spawns
    // `process.execPath` to start another Hercule.
    expect(LOCAL_RUNNER_COMMAND).toEqual([process.execPath, "runner", "--local"]);
  });

  it("respawns after 1 second doubling to 30, and gives a stopping child 10 seconds", () => {
    expect(Duration.toMillis(LOCAL_RUNNER_BACKOFF.first)).toBe(1_000);
    expect(Duration.toMillis(LOCAL_RUNNER_BACKOFF.cap)).toBe(30_000);
    expect(Duration.toMillis(LOCAL_RUNNER_STOP_DEADLINE)).toBe(10_000);
  });
});

describe("the first boot of an empty home", () => {
  it("sends the child a join token on stdin, and the child joins as a runner", async () => {
    const home = createTemporaryHome();
    const port = await findFreePort();
    const child = buildStubChild(home, JSON.stringify({ join: true }));

    const seen = await bootAndHold(home, port, { ...FAST, command: child.command }, () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          waitForNotes(child.notes, (notes) => notes.some((note) => note.what === "joined")),
        );
        const id = String(child.notes().find((note) => note.what === "joined")?.answer?.runnerId);
        const runners = yield* runnerRepository;
        return {
          names: yield* Effect.orDie(runnerNames),
          minted: yield* Effect.orDie(tokensMinted),
          defaultRunnerId: yield* Effect.orDie((yield* Settings).defaultRunnerId()),
          row: Option.getOrThrow(yield* Effect.orDie(runners.read(id))),
        };
      }),
    );

    const notes = child.notes();
    // One child, spawned once: a supervisor that spawned twice would have two
    // runners joining from one machine.
    expect(notes.filter((note) => note.what === "spawned")).toHaveLength(1);

    // The handshake: the controller read the child's first line, answered on
    // its stdin, and closed stdin. The child's read finished, which is the
    // only way it could get as far as joining.
    const stdin = notes.find((note) => note.what === "stdin");
    expect(stdin, "the controller never wrote to the child's stdin").toBeDefined();
    const handed = JSON.parse(String(stdin?.text).trim()) as {
      token: string;
      controllerUrl: string;
    };
    expect(handed.token).not.toBe("");
    expect(handed.controllerUrl).toContain(String(port));

    // The token is never in argv, which `ps` shows, and never in the
    // environment, which every grandchild inherits.
    const spawned = notes.find((note) => note.what === "spawned")!;
    for (const argument of spawned.argv ?? []) expect(argument).not.toContain(handed.token);
    for (const value of Object.values(spawned.env ?? {})) {
      expect(value).not.toContain(handed.token);
    }

    // The join was an ordinary one and created an ordinary row, and the
    // controller made the fleet's first runner the default runner.
    const joined = notes.find((note) => note.what === "joined");
    expect(joined?.answer?.runnerId).toBeDefined();
    expect(seen.names).toHaveLength(1);
    expect(seen.minted).toBe(1);
    expect(seen.defaultRunnerId).toBe(joined?.answer?.runnerId);
    // The controller's own machine is the fleet's general-purpose runner:
    // reserved is something a person asks for on a machine of their own.
    expect(seen.row.reserved).toBe(false);
  }, 30_000);

  it("creates no token and no join for a child that already has its runner id", async () => {
    const home = createTemporaryHome();
    const port = await findFreePort();

    // The first boot, so the home is no longer empty.
    const first = buildStubChild(home, JSON.stringify({ join: true }));
    const before = await bootAndHold(home, port, { ...FAST, command: first.command }, () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          waitForNotes(first.notes, (notes) => notes.some((note) => note.what === "joined")),
        );
        return {
          minted: yield* Effect.orDie(tokensMinted),
          names: yield* Effect.orDie(runnerNames),
          defaultRunnerId: yield* Effect.orDie((yield* Settings).defaultRunnerId()),
        };
      }),
    );
    const runnerId = String(first.notes().find((note) => note.what === "joined")?.answer?.runnerId);

    // Then the next boot: the child reads its own `runner.json` and announces
    // its runner id, so the controller has nothing to send it.
    const again = buildStubChild(home, JSON.stringify({ runnerId }));
    const after = await bootAndHold(home, port, { ...FAST, command: again.command }, (outcome) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          waitForNotes(again.notes, (notes) => notes.some((note) => note.what === "stdin")),
        );
        return {
          minted: yield* Effect.orDie(tokensMinted),
          names: yield* Effect.orDie(runnerNames),
          defaultRunnerId: yield* Effect.orDie((yield* Settings).defaultRunnerId()),
          held: outcome.localRunner?.runnerId(),
        };
      }),
    );

    // Nothing was written to the child's stdin; it was simply closed.
    expect(again.notes().find((note) => note.what === "stdin")?.text).toBe("");
    expect(after.minted).toBe(before.minted);
    expect(after.names).toEqual(before.names);
    expect(after.defaultRunnerId).toBe(before.defaultRunnerId);
    // The local runner's id is kept only in this process.
    expect(after.held).toBe(runnerId);
  }, 40_000);

  it("stops the boot when the child's first line is not a valid announcement", async () => {
    const home = createTemporaryHome();
    const port = await findFreePort();
    const child = buildStubChild(home, "hello, I am a runner");

    const outcome = await Effect.runPromise(
      Effect.result(
        bootWith(
          {
            argv: ["--home", home, "-c", "bind.host=127.0.0.1", "-c", `bind.port=${String(port)}`],
            env: {},
            masterKeyBackend: "file",
            localRunner: { ...FAST, command: child.command },
          },
          () => Effect.void,
        ),
      ),
    );

    expect(outcome._tag).toBe("Failure");
    const message = outcome._tag === "Failure" ? String(outcome.failure.message) : "";
    expect(message).not.toBe("");
    // Nothing joined based on a line nobody could read.
    expect(child.notes().filter((note) => note.what === "spawned")).toHaveLength(1);
    // The child was stopped with the boot that spawned it. A child left
    // behind would hold a socket nobody watches, and the next attempt would
    // start a second one next to it.
    const pid = child.notes().find((note) => note.what === "spawned")?.pid;
    expect(pid).toBeDefined();
    for (let waited = 0; waited < 5_000 && isAlive(pid!); waited += 20) await delay(20);
    expect(isAlive(pid!), `process ${String(pid)} outlived the boot that spawned it`).toBe(false);
  }, 30_000);

  it("does not replace a child it was asked to stop", async () => {
    const home = createTemporaryHome();
    const port = await findFreePort();
    const child = buildStubChild(home, JSON.stringify({ runnerId: crypto.randomUUID() }), [
      "--exit",
      "3",
    ]);

    // Stopped during the run, while the supervisor is still watching. The
    // scope closing at the end of a boot would end the supervisor anyway, so
    // this is the only way to check that a stop is not treated as a crash.
    const spawns = await bootAndHold(home, port, { ...FAST, command: child.command }, (outcome) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          waitForNotes(child.notes, (notes) => notes.some((note) => note.what === "spawned")),
        );
        yield* outcome.localRunner!.stop;
        // Long enough for several backoffs, so a restart would have happened.
        yield* Effect.promise(() => delay(300));
        return child.notes().filter((note) => note.what === "spawned").length;
      }),
    );

    expect(spawns).toBe(1);
  }, 30_000);

  it("boots anyway when the child prints nothing at all", async () => {
    const home = createTemporaryHome();
    const port = await findFreePort();

    // A runner that cannot start (a `runner.json` nobody can parse, a machine
    // out of file handles) is a crash for the supervisor to handle. A
    // controller that refused to start because of it would make its whole API
    // depend on a file it is not even allowed to read.
    const outcome = await Effect.runPromise(
      Effect.result(
        bootWith(
          {
            argv: ["--home", home, "-c", "bind.host=127.0.0.1", "-c", `bind.port=${String(port)}`],
            env: {},
            masterKeyBackend: "file",
            localRunner: { ...FAST, command: [process.execPath, "-e", "process.exit(1)"] },
          },
          () => Effect.void,
        ),
      ),
    );

    expect(outcome._tag).toBe("Success");
  }, 30_000);

  it("stops waiting for a child that is running but prints nothing", async () => {
    const home = createTemporaryHome();
    const port = await findFreePort();

    const started = Date.now();
    const outcome = await Effect.runPromise(
      Effect.result(
        bootWith(
          {
            argv: ["--home", home, "-c", "bind.host=127.0.0.1", "-c", `bind.port=${String(port)}`],
            env: {},
            masterKeyBackend: "file",
            localRunner: {
              ...FAST,
              // A child that starts, prints nothing and never exits. The server
              // does not listen until the handshake is over, so waiting for it
              // would hold up the whole API.
              command: [process.execPath, "-e", "await new Promise(() => {})"],
              handshakeDeadline: Duration.millis(100),
            },
          },
          () => Effect.void,
        ),
      ),
    );

    expect(outcome._tag).toBe("Success");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

describe("supervising the child", () => {
  it("uses the default crash-loop window and count", () => {
    expect(CRASH_LOOP_LIMIT).toBe(3);
    expect(Duration.toMillis(CRASH_LOOP_WINDOW)).toBe(5 * 60 * 1000);
  });

  it("restarts a child that exits, waiting longer each time up to the cap", async () => {
    const home = createTemporaryHome();
    const port = await findFreePort();
    // It announces its runner id and then exits, over and over.
    const child = buildStubChild(home, JSON.stringify({ runnerId: crypto.randomUUID() }), [
      "--exit",
      "3",
    ]);

    await bootAndHold(home, port, { ...FAST, command: child.command }, () =>
      Effect.promise(() =>
        waitForNotes(child.notes, (notes) => notes.filter((n) => n.what === "spawned").length >= 6),
      ),
    );

    const starts = child
      .notes()
      .filter((note) => note.what === "spawned")
      .map((note) => note.at);
    // Restarted without a limit: six starts so far.
    expect(starts.length).toBeGreaterThanOrEqual(6);

    const gaps = starts.slice(1).map((at, index) => at - starts[index]!);
    // 20, 40, then the cap of 60 forever. Each wait is a lower bound: a
    // machine under load takes longer, never less.
    expect(gaps[0]).toBeGreaterThanOrEqual(20);
    expect(gaps[1]).toBeGreaterThanOrEqual(40);
    expect(gaps[2]).toBeGreaterThanOrEqual(60);
    expect(gaps[3]).toBeGreaterThanOrEqual(60);
    expect(gaps[4]).toBeGreaterThanOrEqual(60);
  }, 30_000);

  it("records a crash loop once per window, and calls the alert listener", async () => {
    const home = createTemporaryHome();
    const port = await findFreePort();
    const runnerId = crypto.randomUUID();
    const child = buildStubChild(home, JSON.stringify({ runnerId }), ["--exit", "3"]);
    const alerted: Array<{ runnerId: string | undefined; count: number }> = [];

    const audited = await Effect.runPromise(
      bootWith(
        {
          argv: ["--home", home, "-c", "bind.host=127.0.0.1", "-c", `bind.port=${String(port)}`],
          env: {},
          masterKeyBackend: "file",
          localRunner: { ...FAST, command: child.command },
        },
        () =>
          Effect.gen(function* () {
            // Five exits: well past the three that make a loop, and all within
            // the same five minutes.
            yield* Effect.promise(() =>
              waitForNotes(
                child.notes,
                (notes) => notes.filter((n) => n.what === "spawned").length >= 5,
              ),
            );
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              readonly payload: string;
            }>`SELECT payload FROM events WHERE kind = 'runner.crashLooping' ORDER BY id`;
          }),
      ).pipe(
        Effect.orDie,
        Effect.provideService(RunnerAlerts, {
          crashLooping: (id: string | undefined, count: number) =>
            Effect.sync(() => {
              alerted.push({ runnerId: id, count });
            }),
        }),
      ),
    );

    // One audit entry for the window, however many more times it exits within it.
    expect(audited).toHaveLength(1);
    expect(JSON.parse(String(audited[0]?.payload))).toMatchObject({
      runnerId,
      count: CRASH_LOOP_LIMIT,
    });
    expect(alerted).toEqual([{ runnerId, count: CRASH_LOOP_LIMIT }]);
  }, 30_000);
});

describe("stopping", () => {
  it("asks the child to stop, and does not start another in its place", async () => {
    const home = createTemporaryHome();
    const port = await findFreePort();
    const child = buildStubChild(home, JSON.stringify({ runnerId: crypto.randomUUID() }));

    await bootAndHold(home, port, { ...FAST, command: child.command }, () =>
      Effect.promise(() =>
        waitForNotes(child.notes, (notes) => notes.some((n) => n.what === "stdin")),
      ),
    );

    // The boot returned, so the drain has run.
    const notes = await waitForNotes(child.notes, (all) =>
      all.some((note) => note.what === "sigterm"),
    );
    expect(notes.some((note) => note.what === "sigterm")).toBe(true);
    // A child the controller stopped did not crash.
    await delay(200);
    expect(child.notes().filter((note) => note.what === "spawned")).toHaveLength(1);
  }, 30_000);

  it("kills a child that is still running when the drain's deadline passes", async () => {
    const home = createTemporaryHome();
    const port = await findFreePort();
    const child = buildStubChild(home, JSON.stringify({ runnerId: crypto.randomUUID() }), [
      "--deaf",
      "1",
    ]);

    const started = Date.now();
    await bootAndHold(home, port, { ...FAST, command: child.command }, () =>
      Effect.promise(() =>
        waitForNotes(child.notes, (notes) => notes.some((n) => n.what === "stdin")),
      ),
    );
    const took = Date.now() - started;

    // It received SIGTERM and kept running; the drain stopped waiting.
    expect(child.notes().some((note) => note.what === "sigterm-ignored")).toBe(true);
    // The boot returned rather than hanging on a child that will not exit.
    expect(took).toBeLessThan(20_000);
    expect(child.notes().filter((note) => note.what === "spawned")).toHaveLength(1);
  }, 30_000);
});

describe("counting exits within a window", () => {
  const minute = 60_000;

  it("returns nothing until enough exits fall within the window", () => {
    const loop = createCrashCounter(3, 5 * minute);
    expect(loop.record(0)).toBeUndefined();
    expect(loop.record(1_000)).toBeUndefined();
    expect(loop.record(2_000)).toBe(3);
  });

  it("does not count exits that are older than the window", () => {
    const loop = createCrashCounter(3, 5 * minute);
    // One exit an hour, forever: an unhealthy runner, but not a crash loop.
    for (let hour = 0; hour < 10; hour++) expect(loop.record(hour * 60 * minute)).toBeUndefined();
  });

  it("reports once, and again only after the window has passed", () => {
    const loop = createCrashCounter(3, 5 * minute);
    loop.record(0);
    loop.record(1);
    expect(loop.record(2)).toBe(3);
    // It keeps exiting, which is the same crash loop, not a new one.
    for (let at = 3; at < 5 * minute; at += 30_000) expect(loop.record(at)).toBeUndefined();
    // A window has passed since the last report, so this is a new report.
    expect(loop.record(6 * minute)).toBeGreaterThanOrEqual(3);
  });
});
