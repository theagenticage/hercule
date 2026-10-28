/**
 * The edit watch against real git and a real file clock. The rules of a
 * window's start and end are tested without either in `command-windows.test.ts`;
 * these tests check that events, marks, listings and connections fit together.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MAX_EDITED_FILES, type ProviderEvent, type RunnerToController } from "@hercule/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import { createSessionMarksDir, openFileClock } from "../edit-marks";
import { writeStartMark } from "../edit-marks/testing";
import { buildSubstrateEnv } from "../workspaces";
import { cleanTemporaries, createTemporaryDir, runGitOrThrow } from "../workspaces/testing";
import { takeInitialState, type InitialState } from "./checkout-edits";
import { startEditWatch, type AttachedConnection, type EditWatchConnection } from "./edit-watch";

const watchScopes: Array<Scope.Closeable> = [];

afterAll(async () => {
  await Promise.all(watchScopes.map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))));
  await cleanTemporaries();
});

const BASE_ENV = { PATH: process.env["PATH"], HOME: process.env["HOME"] };
const WORKER = "s-worker";
const REVIEWER = "s-reviewer";

/** Makes a repository with one commit, of `kept.txt`. */
const makeRepository = () => {
  const dir = realpathSync(createTemporaryDir("hercule-edit-watch-"));
  runGitOrThrow(dir, "init", "-b", "main");
  writeFileSync(join(dir, "kept.txt"), "kept\n");
  runGitOrThrow(dir, "add", ".");
  commit({ dir }, "-m", "first");
  return { dir, checkout: { resourceId: "r-1", path: dir } };
};

type Repository = ReturnType<typeof makeRepository>;

const write = (repository: { readonly dir: string }, name: string, content = "x\n") =>
  writeFileSync(join(repository.dir, name), content);

const commit = (repository: { readonly dir: string }, ...args: ReadonlyArray<string>) =>
  runGitOrThrow(repository.dir, "-c", "commit.gpgsign=false", "commit", ...args);

/** Builds a provider event from the fields the watch reads. */
const buildEvent = (fields: object) => fields as unknown as ProviderEvent;

const itemStarted = (sessionId: string, itemId: string, kind = "command_execution") =>
  buildEvent({ _tag: "item.started", sessionId, itemId, kind });

const itemCompleted = (
  sessionId: string,
  itemId: string,
  kind = "command_execution",
  status = "completed",
) => buildEvent({ _tag: "item.completed", sessionId, itemId, kind, status });

const turnCompleted = (sessionId: string) =>
  buildEvent({ _tag: "turn.completed", sessionId, state: "interrupted" });

const requestOpened = (sessionId: string, requestId: string, itemId: string) =>
  buildEvent({
    _tag: "request.opened",
    sessionId,
    request: { requestId, itemId, kind: "command_approval" },
  });

const requestResolved = (sessionId: string, requestId: string, decision: string) =>
  buildEvent({ _tag: "request.resolved", sessionId, requestId, decision });

const UNAVAILABLE: InitialState = { _tag: "unavailable", reason: "the workspace is the main one" };

/**
 * Makes a connection that records the frames written to it.
 *
 * - While `writeHold` is not done, a write waits. `state.writing` counts the
 *   writes that started.
 * - `baseEnv` is the environment its listings run git in.
 * - While `state.failing` is set, every write fails, as it does on a
 *   connection that is closing.
 */
const makeConnection = (
  writeHold?: Deferred.Deferred<void>,
  baseEnv: Readonly<Record<string, string | undefined>> = BASE_ENV,
) => {
  const frames: Array<RunnerToController> = [];
  const state = { writing: 0, failing: false };
  const connection: EditWatchConnection = {
    machine: { baseEnv },
    send: (frame) =>
      Effect.gen(function* () {
        state.writing += 1;
        if (writeHold !== undefined) yield* Deferred.await(writeHold);
        if (state.failing) return yield* Effect.fail("the connection is closing");
        frames.push(frame);
      }),
  };
  /** Returns the paths sent for one session, or for every session when none is named. */
  const listSentPaths = (sessionId?: string) =>
    frames.flatMap((frame) =>
      frame._tag === "filesEdited" && (sessionId === undefined || frame.sessionId === sessionId)
        ? frame.editedFiles.map((file) => file.path)
        : [],
    );
  return { connection, frames, paths: listSentPaths, state };
};

/**
 * Makes a `git` that waits while the hold is on, and returns the environment
 * to run it in. With `subcommand`, only that subcommand waits. A test uses it
 * to do something while a listing is inside git.
 */
const makeSlowGit = (subcommand?: string) => {
  const dir = realpathSync(createTemporaryDir("hercule-slow-git-"));
  const holdFile = join(dir, "hold");
  const enteredFile = join(dir, "entered");
  const matches =
    subcommand === undefined
      ? "block=1"
      : `for arg in "$@"; do [ "$arg" = "${subcommand}" ] && block=1; done`;
  writeFileSync(
    join(dir, "git"),
    `#!/bin/sh\nblock=0\n${matches}\nif [ "$block" = 1 ] && [ -f "${holdFile}" ]; then touch "${enteredFile}"; while [ -f "${holdFile}" ]; do sleep 0.02; done; fi\nexec "${Bun.which("git") ?? "git"}" "$@"\n`,
  );
  chmodSync(join(dir, "git"), 0o755);
  return {
    baseEnv: { PATH: `${dir}:${process.env["PATH"] ?? ""}`, HOME: process.env["HOME"] },
    hold: () => writeFileSync(holdFile, ""),
    release: () => rmSync(holdFile),
    hasEntered: () => existsSync(enteredFile),
  };
};

/**
 * Makes a `git` whose `diff-index` fails the first `failures` times, and
 * returns the environment to run it in. A test uses it to make a listing fail.
 */
const makeFailingGit = (failures: number) => {
  const dir = realpathSync(createTemporaryDir("hercule-failing-git-"));
  const counterFile = join(dir, "failures");
  writeFileSync(
    join(dir, "git"),
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "diff-index" ]; then\n    n=$(cat "${counterFile}" 2>/dev/null || echo 0)\n    if [ "$n" -lt ${String(failures)} ]; then echo $((n + 1)) > "${counterFile}"; echo "simulated git failure" >&2; exit 1; fi\n  fi\ndone\nexec "${Bun.which("git") ?? "git"}" "$@"\n`,
  );
  chmodSync(join(dir, "git"), 0o755);
  return { PATH: `${dir}:${process.env["PATH"] ?? ""}`, HOME: process.env["HOME"] };
};

/** Waits long enough for the worker to finish a pass that runs no git, before a test checks that something did not happen. */
const waitForQuietWorker = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * Starts a watch over a repository and adds the sessions, each with its own
 * marks directory. The watch's connection is attached unless `attached` is
 * false. The other options:
 *
 * - `prepare` changes the repository before its first state is taken.
 * - `initialState` replaces the state taken from the repository.
 * - `writeHold` and `baseEnv` go to the connection (`makeConnection`).
 */
const start = async (
  options: {
    readonly repository?: Repository;
    readonly prepare?: (repository: Repository) => void;
    readonly initialState?: InitialState;
    readonly sessions?: ReadonlyArray<string>;
    readonly attached?: boolean;
    readonly readsFilesEdited?: boolean;
    readonly writeHold?: Deferred.Deferred<void>;
    readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  } = {},
) => {
  const repository = options.repository ?? makeRepository();
  options.prepare?.(repository);
  const editMarksDir = realpathSync(createTemporaryDir("hercule-edit-marks-"));
  const clock = openFileClock(join(editMarksDir, "clock"));
  /**
   * Waits until the file clock has moved on. A write before this call is then
   * strictly older than a mark taken after it, even on a filesystem whose
   * clock ticks every few milliseconds.
   */
  const waitForClockTick = () => {
    const before = clock.takeMark();
    while (clock.takeMark() <= before);
  };
  // A file written by `prepare` can share a clock tick with the initial mark. The
  // attribution then treats it as a possible missed write and narrows its window
  // to that tick, which no later command holds. Waiting first keeps the file older.
  waitForClockTick();
  const initialState =
    options.initialState ??
    (await Effect.runPromise(
      takeInitialState([repository.checkout], buildSubstrateEnv(BASE_ENV), clock),
    ));
  const logs: Array<string> = [];
  const warnLogs: Array<string> = [];
  const state = { ended: 0 };
  let attached: AttachedConnection | undefined;
  const collecting = Logger.make<unknown, void>(({ message, logLevel }) => {
    logs.push(String(message));
    if (logLevel === "Warn") warnLogs.push(String(message));
  });
  /** Collects the log lines of `effect`, and of the fibers it forks, such as the worker. */
  const collectLogs = <A>(effect: Effect.Effect<A>) =>
    effect.pipe(
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.provide(Logger.layer([collecting])),
    );
  const watchScope = Effect.runSync(Scope.make());
  watchScopes.push(watchScope);
  const watch = await Effect.runPromise(
    collectLogs(
      Scope.provide(watchScope)(
        startEditWatch(initialState, {
          clock,
          readAttachedConnection: () => attached,
          onEnded: () => void (state.ended += 1),
        }),
      ),
    ),
  );
  const sessionMarksDirs = new Map<string, string>();
  /** Adds a session to the watch with a new marks directory, as each start of a session gets. */
  const addSession = (sessionId: string) => {
    const sessionMarksDir = createSessionMarksDir(editMarksDir, sessionId);
    sessionMarksDirs.set(sessionId, sessionMarksDir);
    watch.addSession(sessionId, sessionMarksDir);
  };
  for (const sessionId of options.sessions ?? [WORKER, REVIEWER]) addSession(sessionId);
  /** Makes `next` the attached connection without waking the watch. */
  const setAttached = (next: EditWatchConnection, readsFilesEdited = true) => {
    attached = { connection: next, readsFilesEdited };
  };
  /** Makes `next` the attached connection and wakes the watch, as the supervisor does. */
  const attach = (next: EditWatchConnection, readsFilesEdited = true) => {
    setAttached(next, readsFilesEdited);
    watch.requestReport();
  };
  const detach = () => {
    attached = undefined;
  };
  const connection = makeConnection(options.writeHold, options.baseEnv);
  if (options.attached !== false) attach(connection.connection, options.readsFilesEdited);
  /** Writes a start mark the way a harness's hook does before a tool runs, with a shell command's text. */
  const markStart = (sessionId: string, itemId: string, shellCommand?: string) => {
    waitForClockTick();
    writeStartMark(sessionMarksDirs.get(sessionId)!, { toolUseId: itemId, shellCommand });
  };
  const listMarkFiles = (sessionId: string) => readdirSync(sessionMarksDirs.get(sessionId)!);
  const observe = (event: ProviderEvent) => Effect.runSync(collectLogs(watch.observeEvent(event)));
  const remove = (sessionId: string) => watch.removeSession(sessionId);
  /** Completes an item, then waits for the clock, so later writes are outside its window. */
  const complete = (
    sessionId: string,
    itemId: string,
    kind = "command_execution",
    status = "completed",
  ) => {
    observe(itemCompleted(sessionId, itemId, kind, status));
    waitForClockTick();
  };
  /** Runs a command from its mark to its end. `effects` is what it does to the files. */
  const runCommand = (sessionId: string, itemId: string, effects?: () => void) => {
    markStart(sessionId, itemId);
    observe(itemStarted(sessionId, itemId));
    effects?.();
    waitForClockTick();
    complete(sessionId, itemId);
  };
  const countListings = () => logs.filter((line) => line.startsWith("edit listing:")).length;
  const countFailedListings = () =>
    logs.filter((line) => line.startsWith("edit listing dropped")).length;
  /**
   * Runs a command, then waits until a listing after it has attributed its
   * files, so the next step of a test cannot happen while git still lists.
   */
  const runListedCommand = async (sessionId: string, itemId: string, effects?: () => void) => {
    const before = countListings();
    runCommand(sessionId, itemId, effects);
    await vi.waitFor(() => expect(countListings()).toBeGreaterThan(before));
  };
  const findLogs = (text: string) => logs.filter((line) => line.includes(text));
  return {
    repository,
    watch,
    connection,
    logs,
    warnLogs,
    findLogs,
    state,
    addSession,
    attach,
    setAttached,
    detach,
    observe,
    remove,
    waitForClockTick,
    markStart,
    complete,
    listMarkFiles,
    runCommand,
    runListedCommand,
    countListings,
    countFailedListings,
  };
};

describe("who gets the files", () => {
  it("gives the files of a command to the session that ran it, while the other is idle", async () => {
    const { repository, connection, runCommand, listMarkFiles } = await start();
    runCommand(WORKER, "c-1", () => write(repository, "sed.txt"));
    // The mark was read and deleted when the item started.
    expect(listMarkFiles(WORKER)).toEqual([]);
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["sed.txt"]));
    expect(connection.paths(REVIEWER)).toEqual([]);
  });

  it("gives nothing to a reviewer whose commands change nothing, and does not blame it for the worker's next command", async () => {
    const { repository, connection, runCommand, runListedCommand } = await start();
    await runListedCommand(REVIEWER, "r-1");
    runCommand(WORKER, "c-1", () => write(repository, "later.txt"));
    await vi.waitFor(() => expect(connection.paths()).toEqual(["later.txt"]));
    expect(connection.frames).toHaveLength(1);
    expect(connection.paths(WORKER)).toEqual(["later.txt"]);
  });

  it("gives each session its own file when their commands overlap but the writes do not", async () => {
    const { repository, connection, markStart, complete, waitForClockTick } = await start();
    // The worker's command writes a.txt and runs on. The reviewer's command
    // starts after that write and writes b.txt after the worker's command
    // ended. The two windows overlap, but each file is in one window only.
    markStart(WORKER, "c-1");
    write(repository, "a.txt");
    markStart(REVIEWER, "r-1");
    complete(WORKER, "c-1");
    write(repository, "b.txt");
    waitForClockTick();
    complete(REVIEWER, "r-1");
    await vi.waitFor(() => expect(connection.paths()).toHaveLength(2));
    expect(connection.paths(WORKER)).toEqual(["a.txt"]);
    expect(connection.paths(REVIEWER)).toEqual(["b.txt"]);
  });

  it("drops a file that windows of both sessions hold, and logs it", async () => {
    const { repository, connection, runCommand, markStart, complete, findLogs } = await start();
    markStart(WORKER, "c-1");
    markStart(REVIEWER, "r-1");
    write(repository, "who.txt");
    complete(WORKER, "c-1");
    await vi.waitFor(() =>
      expect(findLogs("commands of several sessions were running")).toHaveLength(1),
    );
    expect(connection.paths()).toEqual([]);

    // The reviewer's command ends. The dropped file is part of the state now,
    // so it is nobody's.
    complete(REVIEWER, "r-1");
    markStart(WORKER, "c-2");
    markStart(REVIEWER, "r-2");
    write(repository, "again.txt");
    complete(WORKER, "c-2");
    complete(REVIEWER, "r-2");
    runCommand(WORKER, "c-3", () => write(repository, "alone.txt"));
    await vi.waitFor(() => expect(connection.paths()).toEqual(["alone.txt"]));
  });

  it.each([
    ["counts an edit tool item like a command", "file_change", ["a.txt"]],
    ["does not count an item that cannot write files", "tool_call", []],
  ])("%s", async (_, kind, expected) => {
    const { repository, connection, complete, runListedCommand } = await start({
      sessions: [WORKER],
    });
    // The item has no mark, so its window starts when the session joined.
    write(repository, "a.txt");
    complete(WORKER, "e-1", kind);
    await runListedCommand(WORKER, "c-2");
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(expected));
  });

  it("gives the files to a session whose item completes with no mark, and logs the unknown start", async () => {
    const { repository, connection, complete, warnLogs } = await start({ sessions: [WORKER] });
    write(repository, "background.txt");
    complete(WORKER, "c-1");
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["background.txt"]));
    expect(warnLogs).toEqual([
      `The start of a command or edit of session ${WORKER} is unknown, because the harness's start hook did not record it. It is taken to have started when the session joined the workspace`,
    ]);
  });

  it("starts a window at a start mark recorded in memory, as Claude Code's gate records it", async () => {
    const { repository, connection, watch, observe, complete, waitForClockTick } = await start();
    write(repository, "before.txt");
    waitForClockTick();
    watch.recordToolStart(WORKER, "c-1", undefined);
    observe(itemStarted(WORKER, "c-1"));
    write(repository, "during.txt");
    waitForClockTick();
    complete(WORKER, "c-1");
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["during.txt"]));
  });

  it("drops a file that no window holds and logs it", async () => {
    const { repository, connection, runListedCommand, logs } = await start();
    await runListedCommand(WORKER, "c-1");
    // The user's editor writes between two commands.
    write(repository, "ghost.txt");
    await runListedCommand(REVIEWER, "r-1");
    expect(connection.paths()).toEqual([]);
    expect(logs.some((line) => line.includes("no session's command was running"))).toBe(true);
  });

  it("gives a deleted file to the one session whose command ran since the previous listing", async () => {
    const { repository, connection, runCommand } = await start();
    runCommand(WORKER, "c-1", () => rmSync(join(repository.dir, "kept.txt")));
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["kept.txt"]));
  });

  it("gives the files of a moved directory to the one session whose command ran since the previous listing", async () => {
    // A rename keeps each file's ctime, so new-dir/f.txt has a ctime from
    // before the watch started.
    const { repository, connection, runCommand } = await start({
      prepare: (repository) => {
        mkdirSync(join(repository.dir, "old-dir"));
        write(repository, "old-dir/f.txt");
      },
    });
    runCommand(WORKER, "c-1", () =>
      renameSync(join(repository.dir, "old-dir"), join(repository.dir, "new-dir")),
    );
    await vi.waitFor(() =>
      expect(connection.paths(WORKER).sort()).toEqual(["new-dir/f.txt", "old-dir/f.txt"]),
    );
  });

  it("drops the files of a moved directory when two sessions had a command since the previous listing", async () => {
    const { repository, connection, runListedCommand, markStart, observe, findLogs } =
      await start();
    mkdirSync(join(repository.dir, "old-dir"));
    // The reviewer's long command writes old-dir/f.txt and keeps running.
    markStart(REVIEWER, "r-long");
    observe(itemStarted(REVIEWER, "r-long"));
    write(repository, "old-dir/f.txt");
    await runListedCommand(REVIEWER, "r-short");
    expect(connection.paths(REVIEWER)).toEqual(["old-dir/f.txt"]);
    // The worker moves the directory while the reviewer's command still runs.
    await runListedCommand(WORKER, "c-1", () =>
      renameSync(join(repository.dir, "old-dir"), join(repository.dir, "new-dir")),
    );
    await vi.waitFor(() =>
      expect(findLogs("commands of several sessions were running")).toHaveLength(1),
    );
    expect(connection.paths(WORKER)).toEqual([]);
    expect(connection.paths(REVIEWER)).toEqual(["old-dir/f.txt"]);
  });
});

describe("a git command that may import content", () => {
  it("credits nobody for the files a conflicted merge wrote, and credits a later edit of one", async () => {
    const repository = makeRepository();
    write(repository, "conflict.txt", "base\n");
    runGitOrThrow(repository.dir, "add", ".");
    commit(repository, "-m", "base");
    runGitOrThrow(repository.dir, "switch", "-c", "incoming");
    write(repository, "imported.txt", "theirs\n");
    write(repository, "conflict.txt", "theirs\n");
    runGitOrThrow(repository.dir, "add", ".");
    commit(repository, "-m", "incoming");
    runGitOrThrow(repository.dir, "switch", "main");
    write(repository, "conflict.txt", "ours\n");
    commit(repository, "-am", "ours");
    const { connection, markStart, observe, complete, runListedCommand, findLogs } = await start({
      repository,
    });

    markStart(WORKER, "merge", "git merge incoming --no-edit");
    observe(itemStarted(WORKER, "merge"));
    // The merge stops on the conflict, so HEAD does not move and both files differ from it.
    expect(() => runGitOrThrow(repository.dir, "merge", "incoming", "--no-edit")).toThrow();
    complete(WORKER, "merge");
    await vi.waitFor(() => expect(findLogs("a git command that may bring in")).toHaveLength(1));
    expect(connection.paths(WORKER)).toEqual([]);

    await runListedCommand(WORKER, "edit", () => write(repository, "imported.txt", "mine\n"));
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["imported.txt"]));
  });
});

describe("a command that waits to be allowed", () => {
  it("holds writes from the allow on, not from its mark", async () => {
    const { repository, connection, watch, markStart, observe, complete, waitForClockTick } =
      await start();
    markStart(REVIEWER, "r-1");
    observe(requestOpened(REVIEWER, "q-1", "r-1"));
    markStart(WORKER, "c-1");
    write(repository, "a.txt");
    waitForClockTick();
    watch.takeAllowMark(REVIEWER, "q-1");
    observe(requestResolved(REVIEWER, "q-1", "allow"));
    write(repository, "b.txt");
    complete(WORKER, "c-1");
    complete(REVIEWER, "r-1");
    // a.txt was written before the allow, so only the worker's window holds
    // it. Both windows hold b.txt.
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["a.txt"]));
    expect(connection.paths(REVIEWER)).toEqual([]);
  });

  it("forgets a command whose Request was denied", async () => {
    const { repository, connection, markStart, observe, complete, runListedCommand } =
      await start();
    markStart(REVIEWER, "r-1");
    observe(requestOpened(REVIEWER, "q-1", "r-1"));
    observe(requestResolved(REVIEWER, "q-1", "deny"));
    // Claude Code reports a denied tool as failed, not declined.
    complete(REVIEWER, "r-1", "command_execution", "failed");
    await runListedCommand(WORKER, "c-1", () => write(repository, "a.txt"));
    expect(connection.paths(WORKER)).toEqual(["a.txt"]);
  });
});

describe("when a window ends", () => {
  it("counts a command that ran and completed while git was listing, for the next listing", async () => {
    // Git waits only at its reflog call, which runs after it listed the
    // changed files. The worker writes then, so this listing never sees the
    // file, and the next one must credit it to the worker.
    const slowGit = makeSlowGit("reflog");
    const { repository, connection, runCommand } = await start({ baseEnv: slowGit.baseEnv });
    slowGit.hold();
    runCommand(REVIEWER, "r-1");
    await vi.waitFor(() => expect(slowGit.hasEntered()).toBe(true));
    runCommand(WORKER, "c-1", () => write(repository, "late.txt"));
    slowGit.release();
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["late.txt"]));
    expect(connection.paths(REVIEWER)).toEqual([]);
  });

  it("credits a listing to the session whose window holds the file, when another session runs a command during it", async () => {
    const slowGit = makeSlowGit();
    const { repository, connection, observe, markStart, runCommand, complete } = await start({
      baseEnv: slowGit.baseEnv,
    });
    markStart(WORKER, "c-1");
    write(repository, "worker.txt");
    slowGit.hold();
    complete(WORKER, "c-1");
    await vi.waitFor(() => expect(slowGit.hasEntered()).toBe(true));
    observe(requestOpened(WORKER, "q-1", "c-2"));
    runCommand(REVIEWER, "r-1");
    slowGit.release();
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["worker.txt"]));
  });

  it("lists on the next connection a command that finished while none was up, after its session parked", async () => {
    const { repository, connection, observe, runCommand, attach } = await start({
      attached: false,
    });
    runCommand(WORKER, "c-1", () => write(repository, "a.txt"));
    observe(requestOpened(WORKER, "q-1", "c-2"));
    attach(connection.connection);
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["a.txt"]));
  });

  // A harness can report a turn's end before the start of a command that
  // already runs, and an old turn's end after the next turn's gate.
  it.each([
    ["before its item started", false],
    ["after its item started", true],
  ])("keeps a command's window open when a turn's end arrives %s", async (_, started) => {
    const { repository, connection, markStart, observe, complete, findLogs } = await start();
    markStart(WORKER, "c-1");
    observe(turnCompleted(WORKER));
    if (started) observe(itemStarted(WORKER, "c-1"));
    markStart(REVIEWER, "r-1");
    write(repository, "late.txt");
    complete(REVIEWER, "r-1");
    await vi.waitFor(() =>
      expect(findLogs("commands of several sessions were running")).toHaveLength(1),
    );
    expect(connection.paths()).toEqual([]);
  });

  it("keeps a window open while its process runs, and closes it when the process ends", async () => {
    const { repository, connection, watch, markStart, observe, complete, runCommand } =
      await start();
    markStart(REVIEWER, "r-1");
    observe(itemStarted(REVIEWER, "r-1"));
    watch.recordProcessStart(REVIEWER, "r-1");
    complete(REVIEWER, "r-1");
    // The process still runs after its item completed, and writes.
    write(repository, "server.log");
    watch.recordProcessEnd(REVIEWER, "r-1");
    runCommand(WORKER, "c-1", () => write(repository, "a.txt"));
    await vi.waitFor(() => expect(connection.paths()).toHaveLength(2));
    expect(connection.paths(REVIEWER)).toEqual(["server.log"]);
    expect(connection.paths(WORKER)).toEqual(["a.txt"]);
  });

  it("attributes the partial edits of a session that exits in the middle of a command", async () => {
    const { repository, connection, markStart, remove, state } = await start({
      sessions: [WORKER],
    });
    markStart(WORKER, "c-1");
    write(repository, "partial.txt");
    remove(WORKER);
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["partial.txt"]));
    await vi.waitFor(() => expect(state.ended).toBe(1));
  });

  it("drops the files that a session exiting in the middle of a command shares with another session's command", async () => {
    const { repository, connection, markStart, remove, findLogs } = await start();
    markStart(WORKER, "c-1");
    markStart(REVIEWER, "r-1");
    write(repository, "who.txt");
    remove(WORKER);
    await vi.waitFor(() =>
      expect(findLogs("commands of several sessions were running")).toHaveLength(1),
    );
    expect(connection.paths()).toEqual([]);
  });

  it("reads no mark that a session leaves after it exited", async () => {
    const { repository, connection, markStart, remove, runListedCommand } = await start();
    remove(REVIEWER);
    // A hook that ran just before the harness died, read after the exit.
    markStart(REVIEWER, "late");
    await runListedCommand(WORKER, "c-1", () => write(repository, "a.txt"));
    await runListedCommand(WORKER, "c-2", () => write(repository, "b.txt"));
    expect(connection.paths(WORKER)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("a listing that fails", () => {
  it("is tried again at the next command, and the changes made meanwhile are kept", async () => {
    const { repository, connection, runCommand, countFailedListings } = await start({
      sessions: [WORKER],
    });
    // Without its .git directory the folder is no repository, so the listing fails.
    runCommand(WORKER, "c-1", () => {
      write(repository, "a.txt");
      renameSync(join(repository.dir, ".git"), join(repository.dir, ".git-away"));
    });
    await vi.waitFor(() => expect(countFailedListings()).toBe(1));
    expect(connection.frames).toEqual([]);
    renameSync(join(repository.dir, ".git-away"), join(repository.dir, ".git"));
    runCommand(WORKER, "c-2");
    await vi.waitFor(() => expect(connection.paths()).toEqual(["a.txt"]));
  });

  it("logs a warning each time", async () => {
    const { repository, runCommand, warnLogs, countFailedListings } = await start();
    runCommand(WORKER, "c-1", () => {
      write(repository, "a.txt");
      renameSync(join(repository.dir, ".git"), join(repository.dir, ".git-away"));
    });
    await vi.waitFor(() => expect(countFailedListings()).toBe(1));
    runCommand(WORKER, "c-2");
    await vi.waitFor(() => expect(countFailedListings()).toBe(2));
    expect(warnLogs).toHaveLength(2);
    expect(warnLogs[0]).toContain("Could not list the edits made by shell commands");
  });

  it("is tried again for an exited session while another session keeps the watch alive", async () => {
    const { repository, connection, watch, markStart, remove, countFailedListings } = await start({
      baseEnv: makeFailingGit(1),
    });
    markStart(WORKER, "c-1");
    write(repository, "partial.txt");
    remove(WORKER);
    await vi.waitFor(() => expect(countFailedListings()).toBe(1));
    // A new connection makes the watch run the listing that is still due.
    watch.requestReport();
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["partial.txt"]));
  });

  it("ends the watch with a warning in the log when no session is left to try again", async () => {
    const { markStart, remove, state, warnLogs } = await start({
      sessions: [WORKER],
      baseEnv: makeFailingGit(1000),
    });
    markStart(WORKER, "c-1");
    remove(WORKER);
    await vi.waitFor(() => expect(state.ended).toBe(1));
    expect(warnLogs).toHaveLength(1);
  });
});

describe("what counts as a change", () => {
  it("gives the files of the session's own commit to it", async () => {
    const { repository, connection, runCommand } = await start();
    runCommand(WORKER, "c-1", () => {
      write(repository, "committed.txt");
      runGitOrThrow(repository.dir, "add", ".");
      commit(repository, "-m", "second");
    });
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["committed.txt"]));
  });

  it("counts only what an amend changed", async () => {
    const { repository, connection, runListedCommand } = await start({
      prepare: (repository) => {
        write(repository, "prior.txt");
        runGitOrThrow(repository.dir, "add", ".");
        commit(repository, "-m", "prior");
      },
    });
    await runListedCommand(WORKER, "c-1", () => commit(repository, "--amend", "-m", "new message"));
    await runListedCommand(WORKER, "c-2", () => {
      write(repository, "added.txt");
      runGitOrThrow(repository.dir, "add", "added.txt");
      commit(repository, "--amend", "--no-edit");
    });
    expect(connection.paths()).toEqual(["added.txt"]);
    expect(connection.frames).toHaveLength(1);
  });

  it("does not blame a session for a file that was already changed, until it changes again", async () => {
    const { repository, connection, runListedCommand } = await start({
      prepare: (repository) => write(repository, "dirty.txt", "found like this\n"),
    });
    await runListedCommand(WORKER, "c-1");
    await runListedCommand(WORKER, "c-2", () => write(repository, "other.txt"));
    await runListedCommand(WORKER, "c-3", () =>
      write(repository, "dirty.txt", "changed by the session, longer\n"),
    );
    await vi.waitFor(() => expect(connection.paths()).toEqual(["other.txt", "dirty.txt"]));
  });

  it("finds a changed file that is restored to HEAD", async () => {
    const { repository, connection, runCommand } = await start({
      prepare: (repository) => write(repository, "kept.txt", "the user's work\n"),
    });
    runCommand(WORKER, "c-1", () => runGitOrThrow(repository.dir, "checkout", "--", "kept.txt"));
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["kept.txt"]));
  });

  it("finds a file whose size and modification time were put back", async () => {
    const { repository, connection, runCommand } = await start();
    runCommand(WORKER, "c-1", () => {
      // The same size as "kept\n", so only the ctime shows the change.
      write(repository, "kept.txt", "kepx\n");
      utimesSync(join(repository.dir, "kept.txt"), new Date(0), new Date(0));
    });
    await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["kept.txt"]));
  });

  it("reports a changed symbolic link as itself", async () => {
    const { repository, connection, runListedCommand } = await start({ sessions: [WORKER] });
    await runListedCommand(WORKER, "c-1", () =>
      symlinkSync("kept.txt", join(repository.dir, "link.txt")),
    );
    expect(connection.paths(WORKER)).toEqual(["link.txt"]);
  });
});

describe("sending", () => {
  it("sends a new file once, and only the new files in the next frame", async () => {
    const { repository, connection, runCommand } = await start({ sessions: [WORKER] });
    runCommand(WORKER, "c-1", () => write(repository, "first.txt"));
    await vi.waitFor(() => expect(connection.paths()).toEqual(["first.txt"]));
    // A command that changes nothing, then one that adds a file. Listings run
    // in order, so a repeat of the first file would come before the second.
    runCommand(WORKER, "c-2");
    runCommand(WORKER, "c-3", () => write(repository, "second.txt"));
    await vi.waitFor(() => expect(connection.paths()).toContain("second.txt"));
    expect(connection.paths()).toEqual(["first.txt", "second.txt"]);
  });

  it("sends more files than one frame holds in several frames, and loses none", async () => {
    const { repository, connection, runCommand } = await start({ sessions: [WORKER] });
    const total = MAX_EDITED_FILES + 44;
    runCommand(WORKER, "c-1", () => {
      for (let index = 0; index < total; index += 1) write(repository, `file-${String(index)}.txt`);
    });
    await vi.waitFor(() => expect(connection.paths()).toHaveLength(total));
    expect(
      connection.frames.map((frame) =>
        frame._tag === "filesEdited" ? frame.editedFiles.length : 0,
      ),
    ).toEqual([MAX_EDITED_FILES, 44]);
    expect(new Set(connection.paths()).size).toBe(total);
  });

  it("runs one more listing for a command that finished during a listing", async () => {
    const writeHold = Deferred.makeUnsafe<void>();
    const { repository, connection, runCommand } = await start({
      sessions: [WORKER],
      writeHold,
    });
    runCommand(WORKER, "c-1", () => write(repository, "first.txt"));
    // The worker waits inside its first write, so it has listed first.txt only.
    await vi.waitFor(() => expect(connection.state.writing).toBe(1));
    runCommand(WORKER, "c-2", () => write(repository, "second.txt"));
    Effect.runSync(Deferred.succeed(writeHold, undefined));
    await vi.waitFor(() => expect(connection.paths()).toEqual(["first.txt", "second.txt"]));
  });

  it("uses a connection that attached without waking the watch, as soon as a command finishes", async () => {
    // A session that starts at the moment a connection attaches: the
    // supervisor's list of watches missed it, but the connection is up.
    const { repository, connection, runCommand, setAttached } = await start({
      sessions: [WORKER],
      attached: false,
    });
    setAttached(connection.connection);
    runCommand(WORKER, "c-1", () => write(repository, "a.txt"));
    await vi.waitFor(() => expect(connection.paths()).toEqual(["a.txt"]));
  });

  it("sends every attributed file again on a new connection, with no command after it", async () => {
    const { repository, connection, runListedCommand, attach } = await start();
    await runListedCommand(WORKER, "c-1", () => write(repository, "a.txt"));
    await runListedCommand(REVIEWER, "r-1", () => write(repository, "b.txt"));
    await vi.waitFor(() => expect(connection.paths()).toEqual(["a.txt", "b.txt"]));

    const next = makeConnection();
    attach(next.connection);
    await vi.waitFor(() => expect(next.paths()).toHaveLength(2));
    expect(next.paths(WORKER)).toEqual(["a.txt"]);
    expect(next.paths(REVIEWER)).toEqual(["b.txt"]);
  });

  it.each([
    ["was closing", false],
    ["went away while it wrote them", true],
  ])(
    "keeps a session that exited until its files were written, when the connection %s",
    async (_, cutOff) => {
      const writeHold = Deferred.makeUnsafe<void>();
      const { repository, connection, runCommand, remove, attach, detach, state } = await start({
        sessions: [WORKER],
        writeHold,
      });
      if (!cutOff) {
        connection.state.failing = true;
        Effect.runSync(Deferred.succeed(writeHold, undefined));
      }
      runCommand(WORKER, "c-1", () => write(repository, "a.txt"));
      await vi.waitFor(() => expect(connection.state.writing).toBe(1));
      remove(WORKER);
      if (cutOff) {
        detach();
        connection.state.failing = true;
        Effect.runSync(Deferred.succeed(writeHold, undefined));
      }
      await waitForQuietWorker();
      expect(state.ended).toBe(0);

      const next = makeConnection();
      attach(next.connection);
      await vi.waitFor(() => expect(next.paths(WORKER)).toEqual(["a.txt"]));
      await vi.waitFor(() => expect(state.ended).toBe(1));
      expect(connection.paths()).toEqual([]);
    },
  );

  it("keeps the files attributed to a session that starts again under the same id", async () => {
    const { repository, connection, remove, addSession, runListedCommand, attach, state } =
      await start({ sessions: [WORKER] });
    connection.state.failing = true;
    await runListedCommand(WORKER, "c-1", () => write(repository, "a.txt"));
    remove(WORKER);
    addSession(WORKER);

    const next = makeConnection();
    attach(next.connection);
    await vi.waitFor(() => expect(next.paths(WORKER)).toEqual(["a.txt"]));
    // The session is back, so the watch does not end.
    expect(state.ended).toBe(0);
  });

  it.each([
    ["another connection attached", "attach"],
    ["the connection was closing", "close"],
    ["the connection went away", "detach"],
  ] as const)(
    "sends a listing's files on the next connection when %s during the listing",
    async (_, change) => {
      const slowGit = makeSlowGit();
      const { repository, connection, markStart, complete, attach, detach } = await start({
        sessions: [WORKER],
        baseEnv: slowGit.baseEnv,
      });
      markStart(WORKER, "c-1");
      write(repository, "a.txt");
      slowGit.hold();
      complete(WORKER, "c-1");
      await vi.waitFor(() => expect(slowGit.hasEntered()).toBe(true));
      const next = makeConnection();
      if (change === "attach") attach(next.connection);
      else if (change === "close") connection.state.failing = true;
      else detach();
      slowGit.release();
      if (change !== "attach") attach(next.connection);
      await vi.waitFor(() => expect(next.paths(WORKER)).toEqual(["a.txt"]));
      expect(connection.paths()).toEqual([]);
    },
  );

  it.each([
    ["the controller does not read them", { readsFilesEdited: false }, "controller does not read"],
    [
      "the workspace is not observed",
      { initialState: UNAVAILABLE },
      "the workspace is the main one",
    ],
  ])("sends no frame when %s, and logs why", async (_, options, reason) => {
    const { repository, connection, runCommand, findLogs, remove, state } = await start(options);
    runCommand(WORKER, "c-1", () => write(repository, "a.txt"));
    runCommand(WORKER, "c-2");
    runCommand(REVIEWER, "r-1");
    await vi.waitFor(() => expect(findLogs(reason).length).toBeGreaterThan(0));
    // Nothing runs and nothing is owed, so the last exit ends the watch.
    remove(WORKER);
    remove(REVIEWER);
    await vi.waitFor(() => expect(state.ended).toBe(1));
    expect(connection.state.writing).toBe(0);
  });

  it("drops a listing that waited for a connection when the next controller does not read the files", async () => {
    const { connection, runCommand, remove, attach, state } = await start({
      sessions: [WORKER],
      attached: false,
    });
    runCommand(WORKER, "c-1");
    attach(connection.connection, false);
    remove(WORKER);
    await vi.waitFor(() => expect(state.ended).toBe(1));
  });
});

describe("when the watch ends", () => {
  it("ends at once when the last session exits with nothing owed", async () => {
    const { remove, state } = await start();
    remove(WORKER);
    await waitForQuietWorker();
    expect(state.ended).toBe(0);
    remove(REVIEWER);
    await vi.waitFor(() => expect(state.ended).toBe(1));
  });

  it("keeps the watch for the sessions that are left", async () => {
    const { repository, connection, runCommand, remove, state } = await start();
    remove(WORKER);
    runCommand(REVIEWER, "r-1", () => write(repository, "a.txt"));
    await vi.waitFor(() => expect(connection.paths(REVIEWER)).toEqual(["a.txt"]));
    expect(state.ended).toBe(0);
  });

  it("still sends the files when the last session exits during the listing, and ends after it", async () => {
    const writeHold = Deferred.makeUnsafe<void>();
    const { repository, connection, runCommand, remove, state } = await start({
      sessions: [WORKER],
      writeHold,
    });
    runCommand(WORKER, "c-1", () => write(repository, "a.txt"));
    await vi.waitFor(() => expect(connection.state.writing).toBe(1));
    remove(WORKER);
    expect(state.ended).toBe(0);
    Effect.runSync(Deferred.succeed(writeHold, undefined));
    await vi.waitFor(() => expect(state.ended).toBe(1));
    expect(connection.paths()).toEqual(["a.txt"]);
  });

  it("does not send the files of an exited session again once they were delivered", async () => {
    const { repository, connection, runCommand, remove, attach, state } = await start();
    runCommand(WORKER, "c-1", () => write(repository, "a.txt"));
    await vi.waitFor(() => expect(connection.paths()).toEqual(["a.txt"]));
    remove(WORKER);

    const next = makeConnection();
    attach(next.connection);
    runCommand(REVIEWER, "r-1", () => write(repository, "b.txt"));
    await vi.waitFor(() => expect(next.paths()).toEqual(["b.txt"]));
    expect(state.ended).toBe(0);
  });

  it("does nothing when a connection attaches after the watch ended", async () => {
    const { repository, remove, state, attach, observe, countListings } = await start({
      sessions: [WORKER],
      attached: false,
    });
    remove(WORKER);
    await vi.waitFor(() => expect(state.ended).toBe(1));
    write(repository, "a.txt");
    // The worker is gone, so a late wake does nothing: no frame is sent and
    // the end is not reported again.
    const next = makeConnection();
    attach(next.connection);
    observe(itemCompleted(WORKER, "c-9"));
    await waitForQuietWorker();
    expect(next.frames).toEqual([]);
    expect(state.ended).toBe(1);
    expect(countListings()).toBe(0);
  });
});

describe("a workspace that is not observed", () => {
  it("logs once, naming the checkout and git's first error line, when git cannot read it", async () => {
    const repository = makeRepository();
    // HEAD names a branch with no commit, so git cannot compare with it.
    runGitOrThrow(repository.dir, "checkout", "--orphan", "unborn");
    const { connection, runCommand, findLogs, remove, state } = await start({
      repository,
      sessions: [WORKER],
    });
    runCommand(WORKER, "c-1");
    runCommand(WORKER, "c-2");
    const notObserved = findLogs("are not observed in this workspace");
    expect(notObserved).toHaveLength(1);
    expect(notObserved[0]).toContain(repository.dir);
    expect(notObserved[0]).toContain("git failed");
    remove(WORKER);
    await vi.waitFor(() => expect(state.ended).toBe(1));
    expect(connection.state.writing).toBe(0);
  });
});
