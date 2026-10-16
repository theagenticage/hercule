import {
  chmodSync,
  existsSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
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
import { cleanTemporaries, createTemporaryDir, runGitOrThrow } from "../workspaces/testing";
import { buildSubstrateEnv } from "../workspaces";
import { takeInitialState, type InitialState } from "./checkout-edits";
import { startEditWatch, type AttachedConnection, type EditWatchConnection } from "./edit-watch";

const scopes: Array<Scope.Scope> = [];

afterAll(async () => {
  await Promise.all(scopes.map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))));
  await cleanTemporaries();
});

const ENV = buildSubstrateEnv({ PATH: process.env["PATH"], HOME: process.env["HOME"] });

/** Makes a repository with one commit. */
const makeRepository = () => {
  const dir = realpathSync(createTemporaryDir("hercule-edit-watch-"));
  runGitOrThrow(dir, "init", "-b", "main");
  writeFileSync(join(dir, "kept.txt"), "kept\n");
  runGitOrThrow(dir, "add", ".");
  runGitOrThrow(dir, "-c", "commit.gpgsign=false", "commit", "-m", "first");
  return { dir, checkout: { resourceId: "r-1", path: dir } };
};

const WORKER = "s-worker";
const REVIEWER = "s-reviewer";

/** Builds the `item.started` event of an item. */
const itemStarted = (sessionId: string, itemId: string, kind = "command_execution") =>
  ({ _tag: "item.started", sessionId, itemId, kind }) as unknown as ProviderEvent;

/** Builds the `item.completed` event of an item. */
const itemCompleted = (
  sessionId: string,
  itemId: string,
  kind = "command_execution",
  status = "completed",
) => ({ _tag: "item.completed", sessionId, itemId, kind, status }) as unknown as ProviderEvent;

/** Builds the `turn.completed` event of an agent: the session's own, or a subagent's. */
const turnCompleted = (sessionId: string, subagentId?: string) =>
  ({
    _tag: "turn.completed",
    sessionId,
    state: "interrupted",
    ...(subagentId === undefined ? {} : { subagentId }),
  }) as unknown as ProviderEvent;

/** Builds the event that parks an agent on a Request. */
const requestOpened = (sessionId: string, requestId: string, itemId: string, subagentId?: string) =>
  ({
    _tag: "request.opened",
    sessionId,
    request: { requestId, itemId },
    ...(subagentId === undefined ? {} : { subagentId }),
  }) as unknown as ProviderEvent;

/** Builds the event that ends a Request with a decision. */
const requestResolved = (sessionId: string, requestId: string, decision = "allow") =>
  ({ _tag: "request.resolved", sessionId, requestId, decision }) as unknown as ProviderEvent;

/** Returns the event as an agent of the session that is a subagent reports it. */
const fromSubagent = (event: ProviderEvent, subagentId: string): ProviderEvent =>
  ({ ...event, subagentId }) as unknown as ProviderEvent;

describe("an edit watch", () => {
  /**
   * A connection that records its frames. While `gate` is closed, a frame
   * waits to be written, and `writing` counts the frames that started. A
   * gate that never opens holds a check inside its write until the
   * connection's scope closes. `baseEnv` is the environment its checks run
   * git in. While `state.failing` is set, every write fails.
   */
  const makeConnection = (
    gate?: Deferred.Deferred<void>,
    baseEnv: Readonly<Record<string, string | undefined>> = {
      PATH: process.env["PATH"],
      HOME: process.env["HOME"],
    },
  ) => {
    const scope = Effect.runSync(Scope.make());
    scopes.push(scope);
    const frames: Array<RunnerToController> = [];
    const state = { writing: 0, failing: false };
    const connection: EditWatchConnection = {
      machine: { baseEnv },
      send: (frame) =>
        Effect.gen(function* () {
          state.writing += 1;
          if (gate !== undefined) yield* Deferred.await(gate);
          if (state.failing) return yield* Effect.fail("the connection is closing");
          frames.push(frame);
        }),
    };
    /** The paths sent for one session, or for every session when none is named. */
    const paths = (sessionId?: string) =>
      frames.flatMap((frame) =>
        frame._tag === "filesEdited" && (sessionId === undefined || frame.sessionId === sessionId)
          ? frame.editedFiles.map((file) => file.path)
          : [],
      );
    return { connection, frames, paths, state, scope };
  };

  /**
   * Starts a watch over a repository with its first state taken, and adds the
   * sessions. `attach` makes a connection the current one and tells the
   * watch, as the supervisor does. `logs` collects the log lines of every
   * effect run through `run`.
   * `prepare` changes the repository before the first state is taken.
   */
  const start = async (
    options: {
      readonly repository?: ReturnType<typeof makeRepository>;
      readonly prepare?: (repository: ReturnType<typeof makeRepository>) => void;
      readonly sessions?: ReadonlyArray<string>;
    } = {},
  ) => {
    const repository = options.repository ?? makeRepository();
    options.prepare?.(repository);
    const initialState = await Effect.runPromise(takeInitialState([repository.checkout], ENV));
    return startOn(repository, initialState, options.sessions ?? [WORKER, REVIEWER]);
  };

  const startOn = async (
    repository: ReturnType<typeof makeRepository>,
    initialState: InitialState,
    sessions: ReadonlyArray<string>,
  ) => {
    const warnings: Array<{ readonly sessionId: string; readonly message: string }> = [];
    const logs: Array<string> = [];
    const warnLogs: Array<string> = [];
    // While set, a warning is not written, as when its connection is closing.
    const warnState = { failing: false };
    const state = { ended: 0 };
    let attached: AttachedConnection | undefined;
    const collecting = Logger.make<unknown, void>(({ message, logLevel }) => {
      logs.push(String(message));
      if (logLevel === "Warn") warnLogs.push(String(message));
    });
    const watchScope = Effect.runSync(Scope.make());
    scopes.push(watchScope);
    const watch = await Effect.runPromise(
      Scope.provide(watchScope)(
        startEditWatch(initialState, {
          readAttachedConnection: () => attached,
          warn: (sessionId, message) =>
            Effect.sync(() => {
              if (warnState.failing) return false;
              warnings.push({ sessionId, message });
              return true;
            }),
          onEnded: () => void (state.ended += 1),
        }),
      ).pipe(
        // The worker fiber inherits these, so its log lines are collected too.
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(Logger.layer([collecting])),
      ),
    );
    for (const sessionId of sessions) watch.addSession(sessionId);
    const run = (effect: Effect.Effect<void>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.provide(Logger.layer([collecting])),
        ),
      );
    const setAttached = (connection: EditWatchConnection, readsFilesEdited: boolean) => {
      attached = { connection, readsFilesEdited };
    };
    const attach = (connection: EditWatchConnection, readsFilesEdited: boolean) => {
      setAttached(connection, readsFilesEdited);
      return run(watch.requestReport());
    };
    const detach = () => {
      attached = undefined;
    };
    const observe = (event: ProviderEvent) => run(watch.observeEvent(event));
    const remove = (sessionId: string) => run(watch.removeSession(sessionId));
    /** A command of a session that runs to its end, with nothing else going on. */
    const runCommand = async (sessionId: string, itemId: string) => {
      await observe(itemStarted(sessionId, itemId));
      await observe(itemCompleted(sessionId, itemId));
    };
    const countChecks = () => logs.filter((line) => line.startsWith("edit check:")).length;
    /**
     * A command that runs to its end, and then waits until the check it asked
     * for has listed and attributed. Without the wait, the next step of a
     * test could happen while git is still listing, and count as part of it.
     */
    const runCheckedCommand = async (sessionId: string, itemId: string) => {
      const before = countChecks();
      await runCommand(sessionId, itemId);
      await vi.waitFor(() => expect(countChecks()).toBeGreaterThan(before));
    };
    const listWarnings = (sessionId: string) =>
      warnings.filter((warning) => warning.sessionId === sessionId);
    return {
      repository,
      watch,
      warnings,
      listWarnings,
      logs,
      warnLogs,
      warnState,
      state,
      run,
      attach,
      setAttached,
      detach,
      observe,
      remove,
      runCommand,
      runCheckedCommand,
      countChecks,
    };
  };

  const write = (repository: { readonly dir: string }, name: string, content = "x\n") =>
    writeFileSync(join(repository.dir, name), content);

  /**
   * Makes a `git` that waits while the hold is on, and returns the
   * environment to run it in. It waits only for the call of one git
   * subcommand when `subcommand` is given, and for every call otherwise. A
   * test uses it to do something while a check is inside git.
   */
  const makeSlowGit = (subcommand?: string) => {
    const dir = realpathSync(createTemporaryDir("hercule-slow-git-"));
    const holdFile = join(dir, "hold");
    const enteredFile = join(dir, "entered");
    const realGit = Bun.which("git") ?? "git";
    const matches =
      subcommand === undefined
        ? "block=1"
        : `for arg in "$@"; do [ "$arg" = "${subcommand}" ] && block=1; done`;
    writeFileSync(
      join(dir, "git"),
      `#!/bin/sh\nblock=0\n${matches}\nif [ "$block" = 1 ] && [ -f "${holdFile}" ]; then touch "${enteredFile}"; while [ -f "${holdFile}" ]; do sleep 0.02; done; fi\nexec "${realGit}" "$@"\n`,
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
   * Makes a `git` whose `diff-index` call fails the first `failures` times,
   * and returns the environment to run it in. A test uses it to make a
   * listing fail.
   */
  const makeFailingGit = (failures: number) => {
    const dir = realpathSync(createTemporaryDir("hercule-failing-git-"));
    const counterFile = join(dir, "failures");
    const realGit = Bun.which("git") ?? "git";
    writeFileSync(
      join(dir, "git"),
      `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "diff-index" ]; then\n    n=$(cat "${counterFile}" 2>/dev/null || echo 0)\n    if [ "$n" -lt ${String(failures)} ]; then echo $((n + 1)) > "${counterFile}"; echo "simulated git failure" >&2; exit 1; fi\n  fi\ndone\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(dir, "git"), 0o755);
    return { baseEnv: { PATH: `${dir}:${process.env["PATH"] ?? ""}`, HOME: process.env["HOME"] } };
  };

  describe("who gets the files", () => {
    it("gives the files of a command to the session that ran it, while the other is idle", async () => {
      const { repository, runCommand, attach, warnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      write(repository, "sed.txt");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["sed.txt"]));
      expect(connection.paths(REVIEWER)).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it("gives nothing to a reviewer whose commands change nothing, and does not blame it for the worker's next command", async () => {
      const { repository, runCommand, runCheckedCommand, attach } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await runCheckedCommand(REVIEWER, "r-1");
      write(repository, "later.txt");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(connection.paths()).toEqual(["later.txt"]));
      // Checks run in order, so anything the reviewer's check found came first.
      expect(connection.frames).toHaveLength(1);
      expect(connection.paths(WORKER)).toEqual(["later.txt"]);
    });

    it("drops the files and warns each session once when both were busy at the same time", async () => {
      const {
        repository,
        runCheckedCommand,
        observe,
        attach,
        warnings,
        listWarnings,
        countChecks,
      } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(WORKER, "c-1"));
      await observe(itemStarted(REVIEWER, "r-1"));
      write(repository, "who.txt");
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
      expect(listWarnings(WORKER)[0]?.message).toContain("at the same time");
      expect(listWarnings(WORKER)[0]?.message).toContain("edit tools still are");
      expect(listWarnings(REVIEWER)).toHaveLength(1);

      // The reviewer's command ends. The dropped file is part of the state
      // now, so it is nobody's.
      const afterFirst = countChecks();
      await observe(itemCompleted(REVIEWER, "r-1"));
      await vi.waitFor(() => expect(countChecks()).toBeGreaterThan(afterFirst));
      // The same two sessions overlap again. They are not warned twice.
      await observe(itemStarted(WORKER, "c-2"));
      await observe(itemStarted(REVIEWER, "r-2"));
      write(repository, "again.txt");
      const beforeSecond = countChecks();
      await observe(itemCompleted(WORKER, "c-2"));
      await vi.waitFor(() => expect(countChecks()).toBeGreaterThan(beforeSecond));
      const beforeThird = countChecks();
      await observe(itemCompleted(REVIEWER, "r-2"));
      await vi.waitFor(() => expect(countChecks()).toBeGreaterThan(beforeThird));
      // A later check finds the worker alone.
      write(repository, "alone.txt");
      await runCheckedCommand(WORKER, "c-3");
      expect(connection.paths()).toEqual(["alone.txt"]);
      expect(connection.paths(WORKER)).toEqual(["alone.txt"]);
      expect(warnings).toHaveLength(2);
    });

    it("counts an edit tool item as busy", async () => {
      const { repository, observe, attach, warnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(REVIEWER, "e-1", "file_change"));
      write(repository, "who.txt");
      await observe(itemStarted(WORKER, "c-1"));
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
      expect(connection.paths()).toEqual([]);
    });

    it("does not count an item that cannot write files as busy", async () => {
      const { repository, observe, attach } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(REVIEWER, "t-1", "tool_call"));
      write(repository, "a.txt");
      await observe(itemStarted(WORKER, "c-1"));
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["a.txt"]));
    });

    it("stops counting the items of a turn that ended", async () => {
      const { repository, runCheckedCommand, observe, attach, warnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      // A command that never completes, because its turn was interrupted.
      await observe(itemStarted(REVIEWER, "r-1"));
      await observe(turnCompleted(REVIEWER));
      // The first check still finds the reviewer busy since its start. There
      // is nothing to attribute, so nobody is warned. After it, the reviewer
      // counts no more.
      await runCheckedCommand(WORKER, "c-0");
      write(repository, "a.txt");
      await runCheckedCommand(WORKER, "c-1");
      expect(connection.paths(WORKER)).toEqual(["a.txt"]);
      expect(warnings).toEqual([]);
    });

    it("counts a session as busy when its item completes without a start", async () => {
      const { repository, runCheckedCommand, observe, attach } = await start({
        sessions: [WORKER],
      });
      const connection = makeConnection();
      await attach(connection.connection, true);
      write(repository, "background.txt");
      // The item completes without a start, so the session counts as busy until now.
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["background.txt"]));
      await runCheckedCommand(WORKER, "c-2");
      expect(connection.paths()).toEqual(["background.txt"]);
    });
  });

  describe("when a session counts as busy", () => {
    it("counts a command that started and completed while git was listing, for the next check", async () => {
      // Git waits only at its reflog call, which runs after it listed the
      // changed files. The worker writes then, so this listing never sees the
      // file, and the next one must credit it to the worker.
      const slowGit = makeSlowGit("reflog");
      const { repository, runCommand, attach, warnings } = await start();
      const connection = makeConnection(undefined, slowGit.baseEnv);
      await attach(connection.connection, true);
      slowGit.hold();
      await runCommand(REVIEWER, "r-1");
      await vi.waitFor(() => expect(slowGit.hasEntered()).toBe(true));
      write(repository, "late.txt");
      await runCommand(WORKER, "c-1");
      slowGit.release();
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["late.txt"]));
      expect(connection.paths(REVIEWER)).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it("credits a listing to the session whose command finished, when another session parks and completes a command during it", async () => {
      const slowGit = makeSlowGit();
      const { repository, observe, runCommand, attach, warnings } = await start();
      const connection = makeConnection(undefined, slowGit.baseEnv);
      await attach(connection.connection, true);
      write(repository, "worker.txt");
      slowGit.hold();
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(slowGit.hasEntered()).toBe(true));
      await observe(itemStarted(WORKER, "c-2"));
      await observe(requestOpened(WORKER, "q-1", "c-2"));
      await runCommand(REVIEWER, "r-1");
      slowGit.release();
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["worker.txt"]));
      expect(warnings).toEqual([]);
    });

    it("credits files to the session whose command finished while no connection was up, when it parked afterwards", async () => {
      const { repository, observe, runCommand, attach, warnings } = await start();
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await observe(itemStarted(WORKER, "c-2"));
      await observe(requestOpened(WORKER, "q-1", "c-2"));
      const connection = makeConnection();
      await attach(connection.connection, true);
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["a.txt"]));
      expect(warnings).toEqual([]);
    });

    it("does not count a command that started and was declined", async () => {
      const { repository, observe, runCheckedCommand, attach, warnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(REVIEWER, "r-1"));
      await observe(itemCompleted(REVIEWER, "r-1", "command_execution", "declined"));
      write(repository, "a.txt");
      await runCheckedCommand(WORKER, "c-1");
      expect(connection.paths(WORKER)).toEqual(["a.txt"]);
      expect(warnings).toEqual([]);
    });

    it("lists a command's files for a session whose turn ended with the command open, before the session is forgotten", async () => {
      const { repository, observe, remove, attach, state } = await start({ sessions: [WORKER] });
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(WORKER, "c-1"));
      write(repository, "a.txt");
      await observe(turnCompleted(WORKER));
      await remove(WORKER);
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["a.txt"]));
      await vi.waitFor(() => expect(state.ended).toBe(1));
    });

    it("gives a file that appeared between commands to the session whose command asked for the listing", async () => {
      const { repository, runCheckedCommand, observe, attach, logs } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await runCheckedCommand(WORKER, "c-1");
      // A file appears while nobody runs anything. A declined command never ran, so
      // the next command that finishes is the only one the file can belong to.
      write(repository, "ghost.txt");
      await observe(itemCompleted(WORKER, "c-2", "command_execution", "declined"));
      await runCheckedCommand(REVIEWER, "r-1");
      expect(connection.paths(REVIEWER)).toEqual(["ghost.txt"]);
      expect(logs.some((line) => line.includes("no session was busy"))).toBe(false);
    });

    it("does not count an agent parked on a Request as busy", async () => {
      const { repository, runCheckedCommand, observe, attach, warnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(REVIEWER, "r-1"));
      await observe(requestOpened(REVIEWER, "q-1", "r-1"));
      write(repository, "a.txt");
      await runCheckedCommand(WORKER, "c-1");
      expect(connection.paths(WORKER)).toEqual(["a.txt"]);
      expect(warnings).toEqual([]);
    });

    it("counts an agent again once its Request is allowed", async () => {
      const { repository, observe, attach, warnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(REVIEWER, "r-1"));
      await observe(requestOpened(REVIEWER, "q-1", "r-1"));
      await observe(requestResolved(REVIEWER, "q-1", "allow"));
      write(repository, "a.txt");
      await observe(itemStarted(WORKER, "c-1"));
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
      expect(connection.paths()).toEqual([]);
    });

    it("does not count an agent whose command was denied", async () => {
      const { repository, runCheckedCommand, observe, attach, warnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(REVIEWER, "r-1"));
      await observe(requestOpened(REVIEWER, "q-1", "r-1"));
      await observe(requestResolved(REVIEWER, "q-1", "deny"));
      await observe(itemCompleted(REVIEWER, "r-1", "command_execution", "declined"));
      write(repository, "a.txt");
      await runCheckedCommand(WORKER, "c-1");
      expect(connection.paths(WORKER)).toEqual(["a.txt"]);
      expect(warnings).toEqual([]);
    });

    it("does not count a declined command that completes without a start", async () => {
      const { repository, runCheckedCommand, observe, attach, warnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemCompleted(REVIEWER, "r-1", "command_execution", "declined"));
      write(repository, "a.txt");
      await runCheckedCommand(WORKER, "c-1");
      expect(connection.paths(WORKER)).toEqual(["a.txt"]);
      expect(warnings).toEqual([]);
    });

    it("keeps a session busy when a subagent's turn ends", async () => {
      const { repository, observe, runCheckedCommand, attach, warnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(REVIEWER, "r-1"));
      await observe(turnCompleted(REVIEWER, "sub-1"));
      // A listing starts a new window. The reviewer's item counts in the next one only if it is still open.
      await runCheckedCommand(WORKER, "c-0");
      write(repository, "a.txt");
      await observe(itemStarted(WORKER, "c-1"));
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
    });

    it("keeps a session busy while its subagent runs a command after the session's own turn ended", async () => {
      const { repository, observe, runCheckedCommand, attach, warnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(fromSubagent(itemStarted(REVIEWER, "r-1"), "sub-1"));
      await observe(turnCompleted(REVIEWER));
      await runCheckedCommand(WORKER, "c-0");
      write(repository, "a.txt");
      await observe(itemStarted(WORKER, "c-1"));
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
    });

    it("attributes the partial edits of a session that exits in the middle of a command", async () => {
      const { repository, observe, remove, state, attach } = await start({ sessions: [WORKER] });
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(WORKER, "c-1"));
      write(repository, "partial.txt");
      await remove(WORKER);
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["partial.txt"]));
      await vi.waitFor(() => expect(state.ended).toBe(1));
    });

    it("warns a session that exited in the middle of a command when its files were dropped", async () => {
      const { repository, observe, remove, attach, listWarnings } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(WORKER, "c-1"));
      await observe(itemStarted(REVIEWER, "r-1"));
      write(repository, "who.txt");
      await remove(WORKER);
      await vi.waitFor(() => expect(listWarnings(WORKER)).toHaveLength(1));
      expect(listWarnings(REVIEWER)).toHaveLength(1);
      expect(connection.paths()).toEqual([]);
    });

    it("does not count the items of a session that exited, after its last listing ran", async () => {
      const { repository, observe, remove, runCheckedCommand, attach, warnings, logs } =
        await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(WORKER, "c-1"));
      await remove(WORKER);
      // The exit asks for one last listing. Wait for it before the file appears.
      await vi.waitFor(() =>
        expect(logs.some((line) => line.startsWith("edit check:"))).toBe(true),
      );
      write(repository, "a.txt");
      await runCheckedCommand(REVIEWER, "r-1");
      expect(connection.paths(REVIEWER)).toEqual(["a.txt"]);
      expect(warnings).toEqual([]);
    });
  });

  describe("a listing that fails", () => {
    it("is tried again for an exited session while another session keeps the watch alive", async () => {
      const failingGit = makeFailingGit(1);
      const { repository, observe, remove, watch, run, attach, logs } = await start();
      const connection = makeConnection(undefined, failingGit.baseEnv);
      await attach(connection.connection, true);
      await observe(itemStarted(WORKER, "c-1"));
      write(repository, "partial.txt");
      await remove(WORKER);
      await vi.waitFor(() =>
        expect(logs.some((line) => line.startsWith("edit check dropped"))).toBe(true),
      );
      // A new connection asks again for the listing that is still wanted.
      await run(watch.requestReport());
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["partial.txt"]));
    });

    it("ends the watch with a warning in the log when no session is left to wait for it", async () => {
      const failingGit = makeFailingGit(1000);
      const { observe, remove, attach, state, warnLogs } = await start({ sessions: [WORKER] });
      const connection = makeConnection(undefined, failingGit.baseEnv);
      await attach(connection.connection, true);
      await observe(itemStarted(WORKER, "c-1"));
      await remove(WORKER);
      await vi.waitFor(() => expect(state.ended).toBe(1));
      expect(warnLogs).toHaveLength(1);
    });
  });

  describe("what counts as a change", () => {
    it("gives the files of the session's own commit to it", async () => {
      const { repository, runCheckedCommand, attach } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      write(repository, "committed.txt");
      runGitOrThrow(repository.dir, "add", ".");
      runGitOrThrow(repository.dir, "-c", "commit.gpgsign=false", "commit", "-m", "second");
      await runCheckedCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["committed.txt"]));
    });

    it("counts only what an amend changed", async () => {
      const { repository, runCheckedCommand, attach } = await start({
        prepare: (repository) => {
          write(repository, "prior.txt");
          runGitOrThrow(repository.dir, "add", ".");
          runGitOrThrow(repository.dir, "-c", "commit.gpgsign=false", "commit", "-m", "prior");
        },
      });
      const connection = makeConnection();
      await attach(connection.connection, true);
      runGitOrThrow(
        repository.dir,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--amend",
        "-m",
        "new message",
      );
      await runCheckedCommand(WORKER, "c-1");
      write(repository, "added.txt");
      runGitOrThrow(repository.dir, "add", "added.txt");
      runGitOrThrow(repository.dir, "-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit");
      await runCheckedCommand(WORKER, "c-2");
      await vi.waitFor(() => expect(connection.paths()).toEqual(["added.txt"]));
      expect(connection.frames).toHaveLength(1);
    });

    it("does not blame a session for a file that was already changed, until it changes again", async () => {
      const { repository, runCheckedCommand, attach } = await start({
        prepare: (repository) => write(repository, "dirty.txt", "found like this\n"),
      });
      const connection = makeConnection();
      await attach(connection.connection, true);
      await runCheckedCommand(WORKER, "c-1");
      write(repository, "other.txt");
      await runCheckedCommand(WORKER, "c-2");
      await vi.waitFor(() => expect(connection.paths()).toEqual(["other.txt"]));
      write(repository, "dirty.txt", "changed by the session, longer\n");
      await runCheckedCommand(WORKER, "c-3");
      await vi.waitFor(() => expect(connection.paths()).toEqual(["other.txt", "dirty.txt"]));
    });

    it("finds a changed file that is restored to HEAD", async () => {
      const { repository, runCheckedCommand, attach } = await start({
        prepare: (repository) => write(repository, "kept.txt", "the user's work\n"),
      });
      const connection = makeConnection();
      await attach(connection.connection, true);
      runGitOrThrow(repository.dir, "checkout", "--", "kept.txt");
      await runCheckedCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["kept.txt"]));
    });
  });

  describe("sending", () => {
    it("sends a new file once, and only the new files in the next frame", async () => {
      const { repository, runCommand, attach, warnings } = await start({ sessions: [WORKER] });
      const first = makeConnection();
      await attach(first.connection, true);
      write(repository, "first.txt");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(first.paths()).toEqual(["first.txt"]));

      // A command that changes nothing, then one that adds a file. Checks run
      // in order, so a repeat of the first file would come before the second.
      await runCommand(WORKER, "c-2");
      write(repository, "second.txt");
      await runCommand(WORKER, "c-3");
      await vi.waitFor(() => expect(first.paths()).toContain("second.txt"));
      expect(first.paths()).toEqual(["first.txt", "second.txt"]);
      expect(warnings).toEqual([]);
    });

    it("sends more files than one frame holds in several frames, and loses none", async () => {
      const { repository, runCommand, attach } = await start({ sessions: [WORKER] });
      const connection = makeConnection();
      await attach(connection.connection, true);
      const total = MAX_EDITED_FILES + 44;
      for (let index = 0; index < total; index += 1) write(repository, `file-${String(index)}.txt`);
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(connection.paths()).toHaveLength(total));
      expect(
        connection.frames.map((frame) =>
          frame._tag === "filesEdited" ? frame.editedFiles.length : 0,
        ),
      ).toEqual([MAX_EDITED_FILES, 44]);
      expect(new Set(connection.paths()).size).toBe(total);
    });

    it("runs one more check for a command that finished during a check", async () => {
      const { repository, runCommand, attach } = await start({ sessions: [WORKER] });
      const gate = Deferred.makeUnsafe<void>();
      const connection = makeConnection(gate);
      await attach(connection.connection, true);
      write(repository, "first.txt");
      await runCommand(WORKER, "c-1");
      // The check is inside its first write, so it has listed `first.txt` only.
      await vi.waitFor(() => expect(connection.state.writing).toBe(1));

      write(repository, "second.txt");
      await runCommand(WORKER, "c-2");
      Effect.runSync(Deferred.succeed(gate, undefined));
      await vi.waitFor(() => expect(connection.paths()).toHaveLength(2));
      expect(connection.paths()).toEqual(["first.txt", "second.txt"]);
    });

    it("uses a connection that attached without telling the watch, as soon as a command finishes", async () => {
      const { repository, runCommand, warnings, setAttached } = await start({
        sessions: [WORKER],
      });
      // The state of a session that starts at the moment a connection attaches:
      // the supervisor's list of watches missed it, but the connection is up.
      const connection = makeConnection();
      setAttached(connection.connection, true);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(connection.paths()).toEqual(["a.txt"]));
      expect(warnings).toEqual([]);
    });

    it("sends every attributed file again on a new connection, with no command after it", async () => {
      const { repository, runCheckedCommand, attach } = await start();
      const first = makeConnection();
      await attach(first.connection, true);
      write(repository, "a.txt");
      await runCheckedCommand(WORKER, "c-1");
      write(repository, "b.txt");
      await runCheckedCommand(REVIEWER, "r-1");
      await vi.waitFor(() => expect(first.paths()).toEqual(["a.txt", "b.txt"]));
      // The first connection ends before the next one attaches.
      await Effect.runPromise(Scope.close(first.scope, Exit.void));

      const second = makeConnection();
      await attach(second.connection, true);
      await vi.waitFor(() => expect(second.paths()).toHaveLength(2));
      expect(second.paths(WORKER)).toEqual(["a.txt"]);
      expect(second.paths(REVIEWER)).toEqual(["b.txt"]);
    });

    it("checks on the next connection when a command finished while none was up", async () => {
      const { repository, runCommand, attach } = await start();
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      const connection = makeConnection();
      await attach(connection.connection, true);
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["a.txt"]));
    });

    it("repeats a check whose listing failed on the next command", async () => {
      const { repository, runCommand, logs, attach } = await start({ sessions: [WORKER] });
      const connection = makeConnection();
      write(repository, "a.txt");
      // Without its .git directory the folder is no repository, so the check
      // the command asks for fails.
      renameSync(join(repository.dir, ".git"), join(repository.dir, ".git-away"));
      await attach(connection.connection, true);
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(logs.join("\n")).toContain("edit check dropped"));
      expect(connection.frames).toEqual([]);
      renameSync(join(repository.dir, ".git-away"), join(repository.dir, ".git"));
      await runCommand(WORKER, "c-2");
      await vi.waitFor(() => expect(connection.paths()).toEqual(["a.txt"]));
    });

    it("checks again on the next connection when the connection closed before the check started", async () => {
      const { repository, remove, runCommand, state, setAttached, attach } = await start({
        sessions: [WORKER],
      });
      // The connection's scope is already closed when the command finishes, as
      // it is while a connection is closing and still attached.
      const closing = makeConnection();
      await Effect.runPromise(Scope.close(closing.scope, Exit.void));
      setAttached(closing.connection, true);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      expect(closing.paths()).toEqual([]);

      const next = makeConnection();
      await attach(next.connection, true);
      await vi.waitFor(() => expect(next.paths(WORKER)).toEqual(["a.txt"]));
      await remove(WORKER);
      await vi.waitFor(() => expect(state.ended).toBe(1));
    });

    it("keeps a session that exited until its files were written", async () => {
      const { repository, remove, runCheckedCommand, state, attach } = await start({
        sessions: [WORKER],
      });
      const failing = makeConnection();
      failing.state.failing = true;
      await attach(failing.connection, true);
      write(repository, "a.txt");
      await runCheckedCommand(WORKER, "c-1");
      await remove(WORKER);
      expect(failing.paths()).toEqual([]);
      expect(state.ended).toBe(0);

      const next = makeConnection();
      await attach(next.connection, true);
      await vi.waitFor(() => expect(next.paths(WORKER)).toEqual(["a.txt"]));
      await vi.waitFor(() => expect(state.ended).toBe(1));
    });

    it("keeps the files attributed to a session that starts again under the same id", async () => {
      const { repository, remove, runCheckedCommand, watch, state, attach } = await start({
        sessions: [WORKER],
      });
      const failing = makeConnection();
      failing.state.failing = true;
      await attach(failing.connection, true);
      write(repository, "a.txt");
      await runCheckedCommand(WORKER, "c-1");
      await remove(WORKER);
      watch.addSession(WORKER);

      const next = makeConnection();
      await attach(next.connection, true);
      await vi.waitFor(() => expect(next.paths(WORKER)).toEqual(["a.txt"]));
      // The session is back, so the watch does not end.
      expect(state.ended).toBe(0);
    });

    it("warns each session once when a listing fails", async () => {
      const { repository, runCommand, listWarnings, logs, attach } = await start();
      const connection = makeConnection();
      write(repository, "a.txt");
      renameSync(join(repository.dir, ".git"), join(repository.dir, ".git-away"));
      await attach(connection.connection, true);
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(listWarnings(REVIEWER)).toHaveLength(1));
      expect(listWarnings(WORKER)).toHaveLength(1);
      expect(listWarnings(WORKER)[0]?.message).toContain("could not be listed");
      const failures = () => logs.filter((line) => line.includes("edit check dropped")).length;
      await runCommand(WORKER, "c-2");
      await vi.waitFor(() => expect(failures()).toBe(2));
      expect(listWarnings(WORKER)).toHaveLength(1);
    });

    it("reports a changed symbolic link as itself", async () => {
      const { repository, runCheckedCommand, attach } = await start({ sessions: [WORKER] });
      const connection = makeConnection();
      await attach(connection.connection, true);
      symlinkSync("kept.txt", join(repository.dir, "link.txt"));
      await runCheckedCommand(WORKER, "c-1");
      expect(connection.paths(WORKER)).toEqual(["link.txt"]);
    });

    it("sends the files to the connection that attached while a check ran on the previous one", async () => {
      const slowGit = makeSlowGit();
      const { repository, runCommand, attach } = await start({ sessions: [WORKER] });
      const first = makeConnection(undefined, slowGit.baseEnv);
      await attach(first.connection, true);
      write(repository, "a.txt");
      slowGit.hold();
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(slowGit.hasEntered()).toBe(true));
      const second = makeConnection();
      await attach(second.connection, true);
      slowGit.release();
      await vi.waitFor(() => expect(second.paths(WORKER)).toEqual(["a.txt"]));
      expect(first.paths()).toEqual([]);
    });

    it("lists and sends on the next connection after the scope of a connection closed during a check", async () => {
      const slowGit = makeSlowGit();
      const { repository, runCommand, attach } = await start({ sessions: [WORKER] });
      const first = makeConnection(undefined, slowGit.baseEnv);
      await attach(first.connection, true);
      write(repository, "a.txt");
      slowGit.hold();
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(slowGit.hasEntered()).toBe(true));
      first.state.failing = true;
      await Effect.runPromise(Scope.close(first.scope, Exit.void));
      slowGit.release();
      const second = makeConnection();
      await attach(second.connection, true);
      write(repository, "b.txt");
      await runCommand(WORKER, "c-2");
      await vi.waitFor(() => expect(second.paths(WORKER)).toEqual(["a.txt", "b.txt"]));
    });

    it("sends a warning again when its write failed, at the next request", async () => {
      const { repository, observe, attach, warnState, warnings, countChecks } = await start();
      const first = makeConnection();
      await attach(first.connection, true);
      warnState.failing = true;
      await observe(itemStarted(WORKER, "c-1"));
      await observe(itemStarted(REVIEWER, "r-1"));
      write(repository, "who.txt");
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(countChecks()).toBe(1));
      expect(warnings).toEqual([]);
      warnState.failing = false;
      // The same connection is asked again, so only the owed warnings can be what is sent.
      await attach(first.connection, true);
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
    });

    it("sends no frame to a controller without the capability, and warns each session once", async () => {
      const { repository, runCommand, listWarnings, state, remove, attach } = await start();
      const connection = makeConnection();
      await attach(connection.connection, false);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await runCommand(WORKER, "c-2");
      await runCommand(REVIEWER, "r-1");
      await vi.waitFor(() => expect(listWarnings(REVIEWER)).toHaveLength(1));
      expect(listWarnings(WORKER)).toHaveLength(1);
      expect(listWarnings(WORKER)[0]?.message).toContain("controller does not read them");
      // Nothing runs and nothing is owed, so the last exit ends the watch.
      await remove(WORKER);
      await remove(REVIEWER);
      await vi.waitFor(() => expect(state.ended).toBe(1));
      expect(connection.state.writing).toBe(0);
    });

    it("drops a check that waited for a connection when the next controller cannot read the files", async () => {
      const { runCommand, remove, state, attach } = await start({ sessions: [WORKER] });
      await runCommand(WORKER, "c-1");
      await attach(makeConnection().connection, false);
      await remove(WORKER);
      await vi.waitFor(() => expect(state.ended).toBe(1));
    });
  });

  describe("when the watch ends", () => {
    it("ends at once when the last session exits with nothing owed", async () => {
      const { remove, state } = await start();
      await remove(WORKER);
      await vi.waitFor(() => expect(state.ended).toBe(0));
      await remove(REVIEWER);
      await vi.waitFor(() => expect(state.ended).toBe(1));
    });

    it("keeps the watch for the sessions that are left", async () => {
      const { repository, runCommand, remove, state, attach } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await remove(WORKER);
      write(repository, "a.txt");
      await runCommand(REVIEWER, "r-1");
      await vi.waitFor(() => expect(connection.paths(REVIEWER)).toEqual(["a.txt"]));
      expect(state.ended).toBe(0);
    });

    it("still sends the files when the last session exits during the check, and ends after it", async () => {
      const { repository, runCommand, remove, state, attach } = await start({
        sessions: [WORKER],
      });
      const gate = Deferred.makeUnsafe<void>();
      const connection = makeConnection(gate);
      await attach(connection.connection, true);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(connection.state.writing).toBe(1));

      await remove(WORKER);
      expect(state.ended).toBe(0);
      Effect.runSync(Deferred.succeed(gate, undefined));
      await vi.waitFor(() => expect(state.ended).toBe(1));
      expect(connection.paths()).toEqual(["a.txt"]);
    });

    it("sends the files of an exited session on the next connection when the check was cut off", async () => {
      const { repository, runCommand, remove, state, attach, detach } = await start({
        sessions: [WORKER],
      });
      // The write waits at this gate, and fails once the connection is closing.
      const gate = Deferred.makeUnsafe<void>();
      const cutOff = makeConnection(gate);
      await attach(cutOff.connection, true);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(cutOff.state.writing).toBe(1));
      await remove(WORKER);
      detach();
      cutOff.state.failing = true;
      Effect.runSync(Deferred.succeed(gate, undefined));
      expect(cutOff.paths()).toEqual([]);
      expect(state.ended).toBe(0);

      const next = makeConnection();
      await attach(next.connection, true);
      await vi.waitFor(() => expect(state.ended).toBe(1));
      expect(next.paths(WORKER)).toEqual(["a.txt"]);
    });

    it("lists again on the next connection when the listing was cut off", async () => {
      const slowGit = makeSlowGit();
      const { repository, runCommand, attach, detach } = await start({ sessions: [WORKER] });
      const slow = makeConnection(undefined, slowGit.baseEnv);
      await attach(slow.connection, true);
      write(repository, "a.txt");
      slowGit.hold();
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(slowGit.hasEntered()).toBe(true));
      detach();
      await Effect.runPromise(Scope.close(slow.scope, Exit.void));
      slowGit.release();

      const next = makeConnection();
      await attach(next.connection, true);
      await vi.waitFor(() => expect(next.paths(WORKER)).toEqual(["a.txt"]));
    });

    it("does not send the files of an exited session again once they were delivered", async () => {
      const { repository, runCommand, remove, state, attach } = await start({
        sessions: [WORKER, REVIEWER],
      });
      const first = makeConnection();
      await attach(first.connection, true);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(first.paths()).toEqual(["a.txt"]));
      await remove(WORKER);
      await Effect.runPromise(Scope.close(first.scope, Exit.void));

      const second = makeConnection();
      await attach(second.connection, true);
      write(repository, "b.txt");
      await runCommand(REVIEWER, "r-1");
      await vi.waitFor(() => expect(second.paths()).toEqual(["b.txt"]));
      expect(state.ended).toBe(0);
    });

    it("does nothing when a connection attaches after the watch ended", async () => {
      const { repository, remove, state, attach, observe, countChecks } = await start({
        sessions: [WORKER],
      });
      await remove(WORKER);
      await vi.waitFor(() => expect(state.ended).toBe(1));
      write(repository, "a.txt");
      const connection = makeConnection();
      // The worker is gone, so a late request has nothing to wake: no frame is
      // sent and the end is not reported again.
      await attach(connection.connection, true);
      await observe(itemCompleted(WORKER, "c-9"));
      expect(connection.frames).toEqual([]);
      expect(state.ended).toBe(1);
      expect(countChecks()).toBe(0);
    });
  });

  describe("a workspace that is not observed", () => {
    it("warns each session once with the reason, when its first command finishes", async () => {
      const repository = makeRepository();
      const { runCommand, listWarnings, remove, state, attach } = await startOn(
        repository,
        { _tag: "unavailable", reason: "the workspace is the main one" },
        [WORKER, REVIEWER],
      );
      const connection = makeConnection();
      await attach(connection.connection, true);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await runCommand(WORKER, "c-2");
      await runCommand(REVIEWER, "r-1");
      await vi.waitFor(() => expect(listWarnings(REVIEWER)).toHaveLength(1));
      expect(listWarnings(WORKER)).toHaveLength(1);
      expect(listWarnings(WORKER)[0]?.message).toContain("the workspace is the main one");
      await remove(WORKER);
      await remove(REVIEWER);
      await vi.waitFor(() => expect(state.ended).toBe(1));
      expect(connection.state.writing).toBe(0);
    });

    it("holds the warning until a connection is up, then writes it once", async () => {
      const repository = makeRepository();
      const { runCommand, warnings, attach } = await startOn(
        repository,
        { _tag: "unavailable", reason: "the workspace is the main one" },
        [WORKER],
      );
      await runCommand(WORKER, "c-1");
      expect(warnings).toEqual([]);
      await attach(makeConnection().connection, true);
      await vi.waitFor(() => expect(warnings).toHaveLength(1));
      await runCommand(WORKER, "c-2");
      expect(warnings).toHaveLength(1);
    });

    it("warns once, naming the checkout and git's first error line, when git cannot read it", async () => {
      const repository = makeRepository();
      // HEAD names a branch with no commit, so git cannot compare with it.
      runGitOrThrow(repository.dir, "checkout", "--orphan", "unborn");
      const { runCommand, warnings, remove, state, attach } = await start({
        repository,
        sessions: [WORKER],
      });
      const connection = makeConnection();
      await attach(connection.connection, true);
      await runCommand(WORKER, "c-1");
      await runCommand(WORKER, "c-2");
      await vi.waitFor(() => expect(warnings).toHaveLength(1));
      expect(warnings[0]?.message).toContain(repository.dir);
      expect(warnings[0]?.message).toContain("git failed");
      await remove(WORKER);
      await vi.waitFor(() => expect(state.ended).toBe(1));
      expect(connection.state.writing).toBe(0);
    });
  });
});
