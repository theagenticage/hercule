/**
 * The local runner the controller spawns and supervises.
 *
 * Everything here is driven through a real boot with a real child process, and
 * the only thing that differs from what ships is the command: the shipped one
 * is the Bun binary this test is already running inside, so a supervisor that
 * could not be handed a stub child could not be tested at all. The stub
 * writes what it was given into a file, so what the test asserts is what the
 * child really saw - its argv, its environment and the bytes on its stdin -
 * rather than what the controller believes it sent.
 *
 * What is asserted: the stdout handshake in both directions, the first boot's
 * token and the join it yields, the second boot's silence, a first line that
 * makes no sense stopping the boot, the respawn schedule and the crash-loop
 * record, and what the drain does to a child that goes quietly and to one that
 * does not.
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
import { Settings } from "../settings";
import {
  CRASH_LOOP_LIMIT,
  CRASH_LOOP_WINDOW,
  crashCounter,
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

const temporaryHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hydra-local-"));
  homes.push(home);
  return home;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a process is still on the machine. Signal 0 asks without asking for anything. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A port nothing is on, taken by binding one and letting it go. The boot needs
 * the address before it runs, because the child is told where to join.
 */
const freePort = async (): Promise<number> => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = Number(server.port);
  await server.stop(true);
  return port;
};

/**
 * The child, as a script rather than the real binary: it starts in
 * milliseconds, it does exactly what a test needs of it, and it writes down
 * everything it was handed.
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

record({ what: "spawned", at: Date.now(), pid: process.pid, argv: Bun.argv, env: { ...process.env } });
process.stdout.write(flag("--announce") + "\\n");

const exitAfter = flag("--exit");
if (exitAfter !== undefined) process.exit(Number(exitAfter));

let text = "";
for await (const chunk of Bun.stdin.stream()) text += new TextDecoder().decode(chunk);
record({ what: "stdin", at: Date.now(), text });

// What a real local runner does with what it was handed: the ordinary join,
// over loopback, retried until the controller is listening.
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

if (flag("--deaf") === undefined) {
  process.on("SIGTERM", () => {
    record({ what: "sigterm", at: Date.now() });
    process.exit(0);
  });
} else {
  process.on("SIGTERM", () => record({ what: "sigterm-ignored", at: Date.now() }));
}
await new Promise(() => {});
`;

/** One thing a child wrote down. */
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
 * A stub child in this home, and the notes it leaves. Each of these keeps its
 * own notes, because a home outlives a boot: two boots of one home are two
 * children, and what the second was handed is not what the first was.
 */
let children = 0;
const childIn = (
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
    notes: () =>
      existsSync(state)
        ? readFileSync(state, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Note)
        : [],
  };
};

/** Waits for something the child wrote, or gives up. */
const until = async (
  notes: () => ReadonlyArray<Note>,
  ready: (all: ReadonlyArray<Note>) => boolean,
  within = 10_000,
): Promise<ReadonlyArray<Note>> => {
  for (let waited = 0; waited < within && !ready(notes()); waited += 20) await delay(20);
  return notes();
};

/**
 * A boot that supervises the given child while `body` runs, with the listener
 * up: the child joins over loopback the way the real one does, so what the
 * fleet ends up holding is a real row from a real join.
 */
const bootHolding = <A>(
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
            Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port, reusePort: true })),
          ),
        ),
    ).pipe(Effect.orDie),
  );

/** How many join tokens this home has ever minted. */
const tokensMinted = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM runner_join_tokens`,
  ),
  (rows) => Number(rows[0]?.n ?? 0),
);

/** The runner rows this home holds, by name. */
const runnerNames = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly name: string }>`SELECT name FROM runners ORDER BY name`,
  ),
  (rows) => rows.map((row) => row.name),
);

/** A backoff a test can wait out, and the crash window the build ships. */
const FAST = {
  backoff: { first: Duration.millis(20), cap: Duration.millis(60) },
  stopDeadline: Duration.millis(200),
  handshakeDeadline: Duration.millis(200),
};

describe("the command the controller spawns", () => {
  it("is the binary this process is, told to be a local runner", () => {
    // Spec 15 section 4: spawn, never fork, and `process.execPath` is what a
    // compiled Hydra spawns to get another one.
    expect(LOCAL_RUNNER_COMMAND).toEqual([process.execPath, "runner", "--local"]);
  });

  it("respawns after 1 second doubling to 30, and gives a stopping child 10 seconds", () => {
    expect(Duration.toMillis(LOCAL_RUNNER_BACKOFF.first)).toBe(1_000);
    expect(Duration.toMillis(LOCAL_RUNNER_BACKOFF.cap)).toBe(30_000);
    expect(Duration.toMillis(LOCAL_RUNNER_STOP_DEADLINE)).toBe(10_000);
  });
});

describe("the first boot of an empty home", () => {
  it("hands the child a join token on stdin and ends with the runner it joined as", async () => {
    const home = temporaryHome();
    const port = await freePort();
    const child = childIn(home, JSON.stringify({ join: true }));

    const seen = await bootHolding(home, port, { ...FAST, command: child.command }, () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          until(child.notes, (notes) => notes.some((note) => note.what === "joined")),
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
    // runners joining as one machine.
    expect(notes.filter((note) => note.what === "spawned")).toHaveLength(1);

    // The handshake: the controller read the child's first line and answered on
    // its stdin, then closed it - the child's read finished, which is the only
    // way it got as far as joining.
    const stdin = notes.find((note) => note.what === "stdin");
    expect(stdin, "the controller never wrote to the child's stdin").toBeDefined();
    const handed = JSON.parse(String(stdin?.text).trim()) as {
      token: string;
      controllerUrl: string;
    };
    expect(handed.token).not.toBe("");
    expect(handed.controllerUrl).toContain(String(port));

    // Never in argv, which `ps` shows, and never in the environment, which
    // every grandchild inherits.
    const spawned = notes.find((note) => note.what === "spawned")!;
    for (const argument of spawned.argv ?? []) expect(argument).not.toContain(handed.token);
    for (const value of Object.values(spawned.env ?? {})) {
      expect(value).not.toContain(handed.token);
    }

    // The join was an ordinary one and left an ordinary row, and the controller
    // took the fleet's first member as the runner work falls back to.
    const joined = notes.find((note) => note.what === "joined");
    expect(joined?.answer?.runnerId).toBeDefined();
    expect(seen.names).toHaveLength(1);
    expect(seen.minted).toBe(1);
    expect(seen.defaultRunnerId).toBe(joined?.answer?.runnerId);
    // The machine the controller is on is the fleet's general-purpose one:
    // reserved is a thing a person asks for about a machine of their own.
    expect(seen.row.reserved).toBe(false);
  }, 30_000);

  it("mints nothing and joins nothing for a child that already knows who it is", async () => {
    const home = temporaryHome();
    const port = await freePort();

    // The first boot, so the home is no longer empty.
    const first = childIn(home, JSON.stringify({ join: true }));
    const before = await bootHolding(home, port, { ...FAST, command: first.command }, () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          until(first.notes, (notes) => notes.some((note) => note.what === "joined")),
        );
        return {
          minted: yield* Effect.orDie(tokensMinted),
          names: yield* Effect.orDie(runnerNames),
          defaultRunnerId: yield* Effect.orDie((yield* Settings).defaultRunnerId()),
        };
      }),
    );
    const runnerId = String(first.notes().find((note) => note.what === "joined")?.answer?.runnerId);

    // And the boot after it: the child reads its own `runner.json` and says who
    // it is, and the controller has nothing to hand it.
    const again = childIn(home, JSON.stringify({ runnerId }));
    const after = await bootHolding(home, port, { ...FAST, command: again.command }, (outcome) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          until(again.notes, (notes) => notes.some((note) => note.what === "stdin")),
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
    // The only place the local runner's identity lives is this process.
    expect(after.held).toBe(runnerId);
  }, 40_000);

  it("stops the boot when the child's first line is not one of the two it can be", async () => {
    const home = temporaryHome();
    const port = await freePort();
    const child = childIn(home, "hello, I am a runner");

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
    // Nothing was enlisted on the strength of a line nobody could read.
    expect(child.notes().filter((note) => note.what === "spawned")).toHaveLength(1);
    // And the child went with the boot that spawned it. One left behind would
    // hold a socket with nothing on this end watching it, and the next attempt
    // would put a second one beside it.
    const pid = child.notes().find((note) => note.what === "spawned")?.pid;
    expect(pid).toBeDefined();
    for (let waited = 0; waited < 5_000 && alive(pid!); waited += 20) await delay(20);
    expect(alive(pid!), `process ${String(pid)} outlived the boot that spawned it`).toBe(false);
  }, 30_000);

  it("puts nothing in the place of a child it was asked to stop", async () => {
    const home = temporaryHome();
    const port = await freePort();
    const child = childIn(home, JSON.stringify({ runnerId: crypto.randomUUID() }), ["--exit", "3"]);

    // Stopped from inside the run, while the supervisor is still watching: the
    // scope closing at the end of a boot would end the supervisor anyway, so it
    // is the only way to see that a stop is not read as a crash.
    const spawns = await bootHolding(home, port, { ...FAST, command: child.command }, (outcome) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          until(child.notes, (notes) => notes.some((note) => note.what === "spawned")),
        );
        yield* outcome.localRunner!.stop;
        // Several backoffs' worth of chances to start another one.
        yield* Effect.promise(() => delay(300));
        return child.notes().filter((note) => note.what === "spawned").length;
      }),
    );

    expect(spawns).toBe(1);
  }, 30_000);

  it("starts anyway when the child says nothing at all", async () => {
    const home = temporaryHome();
    const port = await freePort();

    // A runner that cannot start - a `runner.json` nobody can parse, a machine
    // out of file handles - is a crash for the supervisor to answer. A
    // controller that refused to start over it would hold its whole API
    // hostage to a file it is not even allowed to read.
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

  it("gives up on a child that is alive and saying nothing, rather than waiting on it", async () => {
    const home = temporaryHome();
    const port = await freePort();

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
              // A child that starts, says nothing and never exits. Nothing binds
              // until the handshake is over, so waiting it out is the whole API
              // held up by one silent process.
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
  it("records the shipped crash-loop window and count", () => {
    expect(CRASH_LOOP_LIMIT).toBe(3);
    expect(Duration.toMillis(CRASH_LOOP_WINDOW)).toBe(5 * 60 * 1000);
  });

  it("respawns a child that exits, waiting longer each time up to the cap", async () => {
    const home = temporaryHome();
    const port = await freePort();
    // It announces who it is and then dies, over and over.
    const child = childIn(home, JSON.stringify({ runnerId: crypto.randomUUID() }), ["--exit", "3"]);

    await bootHolding(home, port, { ...FAST, command: child.command }, () =>
      Effect.promise(() =>
        until(child.notes, (notes) => notes.filter((n) => n.what === "spawned").length >= 6),
      ),
    );

    const starts = child
      .notes()
      .filter((note) => note.what === "spawned")
      .map((note) => note.at);
    // Retried without a limit: six lives and counting.
    expect(starts.length).toBeGreaterThanOrEqual(6);

    const gaps = starts.slice(1).map((at, index) => at - starts[index]!);
    // 20, 40, then the cap of 60 for ever. Each wait is only ever a lower
    // bound: a machine under load takes longer, never less.
    expect(gaps[0]).toBeGreaterThanOrEqual(20);
    expect(gaps[1]).toBeGreaterThanOrEqual(40);
    expect(gaps[2]).toBeGreaterThanOrEqual(60);
    expect(gaps[3]).toBeGreaterThanOrEqual(60);
    expect(gaps[4]).toBeGreaterThanOrEqual(60);
  }, 30_000);

  it("records a crash loop once for the window it happened in, and tells the alerts seam", async () => {
    const home = temporaryHome();
    const port = await freePort();
    const runnerId = crypto.randomUUID();
    const child = childIn(home, JSON.stringify({ runnerId }), ["--exit", "3"]);
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
            // Five deaths: well past the three that make a loop, and all of
            // them inside the same five minutes.
            yield* Effect.promise(() =>
              until(child.notes, (notes) => notes.filter((n) => n.what === "spawned").length >= 5),
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

    // One row for the window, however many more times it dies inside it.
    expect(audited).toHaveLength(1);
    expect(JSON.parse(String(audited[0]?.payload))).toMatchObject({
      runnerId,
      count: CRASH_LOOP_LIMIT,
    });
    expect(alerted).toEqual([{ runnerId, count: CRASH_LOOP_LIMIT }]);
  }, 30_000);
});

describe("stopping", () => {
  it("asks the child to stop and lets it go, without putting another in its place", async () => {
    const home = temporaryHome();
    const port = await freePort();
    const child = childIn(home, JSON.stringify({ runnerId: crypto.randomUUID() }));

    await bootHolding(home, port, { ...FAST, command: child.command }, () =>
      Effect.promise(() => until(child.notes, (notes) => notes.some((n) => n.what === "stdin"))),
    );

    // The boot returned, which means the drain has run.
    const notes = await until(child.notes, (all) => all.some((note) => note.what === "sigterm"));
    expect(notes.some((note) => note.what === "sigterm")).toBe(true);
    // A child the controller stopped is not a child that crashed.
    await delay(200);
    expect(child.notes().filter((note) => note.what === "spawned")).toHaveLength(1);
  }, 30_000);

  it("kills a child that is still there when the drain's deadline passes", async () => {
    const home = temporaryHome();
    const port = await freePort();
    const child = childIn(home, JSON.stringify({ runnerId: crypto.randomUUID() }), ["--deaf", "1"]);

    const started = Date.now();
    await bootHolding(home, port, { ...FAST, command: child.command }, () =>
      Effect.promise(() => until(child.notes, (notes) => notes.some((n) => n.what === "stdin"))),
    );
    const took = Date.now() - started;

    // It heard the signal and went on living; the drain stopped waiting.
    expect(child.notes().some((note) => note.what === "sigterm-ignored")).toBe(true);
    // The boot returned rather than hanging on a child that will not go.
    expect(took).toBeLessThan(20_000);
    expect(child.notes().filter((note) => note.what === "spawned")).toHaveLength(1);
  }, 30_000);
});

describe("counting deaths against a window", () => {
  const minute = 60_000;

  it("says nothing until enough of them fall together", () => {
    const loop = crashCounter(3, 5 * minute);
    expect(loop.record(0)).toBeUndefined();
    expect(loop.record(1_000)).toBeUndefined();
    expect(loop.record(2_000)).toBe(3);
  });

  it("does not count deaths the window has already let go of", () => {
    const loop = crashCounter(3, 5 * minute);
    // One an hour, for ever: a machine that is not well, but not looping.
    for (let hour = 0; hour < 10; hour++) expect(loop.record(hour * 60 * minute)).toBeUndefined();
  });

  it("tells the story once, and again only once the window has passed", () => {
    const loop = crashCounter(3, 5 * minute);
    loop.record(0);
    loop.record(1);
    expect(loop.record(2)).toBe(3);
    // It goes on dying, which is the same outbreak and not a second one.
    for (let at = 3; at < 5 * minute; at += 30_000) expect(loop.record(at)).toBeUndefined();
    // A window has passed since it was last told, so this is a new one.
    expect(loop.record(6 * minute)).toBeGreaterThanOrEqual(3);
  });
});
