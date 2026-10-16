import { chmodSync, existsSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

describe("an edit watch", () => {
  /**
   * A connection that records its frames. While `gate` is closed, a frame
   * waits to be written, and `writing` counts the frames that started. A
   * gate that never opens holds a check inside its write until the
   * connection's scope closes. `baseEnv` is the environment its checks run
   * git in.
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
    const state = { writing: 0 };
    const connection: EditWatchConnection = {
      scope,
      machine: { baseEnv },
      send: (frame) =>
        Effect.gen(function* () {
          state.writing += 1;
          if (gate !== undefined) yield* Deferred.await(gate);
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
   * effect run through `run`, including the checks it forks, and
   * `connectionReads` counts how often the watch asked for the connection.
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

  const startOn = (
    repository: ReturnType<typeof makeRepository>,
    initialState: InitialState,
    sessions: ReadonlyArray<string>,
  ) => {
    const warnings: Array<{ readonly sessionId: string; readonly message: string }> = [];
    const logs: Array<string> = [];
    const state = { ended: 0, connectionReads: 0 };
    let attached: AttachedConnection | undefined;
    const watch = startEditWatch([repository.checkout], initialState, {
      cwd: repository.dir,
      readAttachedConnection: () => {
        state.connectionReads += 1;
        return attached;
      },
      warn: (sessionId, message) => Effect.sync(() => void warnings.push({ sessionId, message })),
      onEnded: () => void (state.ended += 1),
    });
    for (const sessionId of sessions) watch.addSession(sessionId);
    const collecting = Logger.make<unknown, void>(({ message }) => {
      logs.push(String(message));
    });
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
    const warningsOf = (sessionId: string) =>
      warnings.filter((warning) => warning.sessionId === sessionId);
    return {
      repository,
      watch,
      warnings,
      warningsOf,
      logs,
      state,
      run,
      attach,
      setAttached,
      detach,
      observe,
      runCommand,
      runCheckedCommand,
      countChecks,
    };
  };

  const write = (repository: { readonly dir: string }, name: string, content = "x\n") =>
    writeFileSync(join(repository.dir, name), content);

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
      const { repository, runCheckedCommand, observe, attach, warnings, warningsOf, countChecks } =
        await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      await observe(itemStarted(WORKER, "c-1"));
      await observe(itemStarted(REVIEWER, "r-1"));
      write(repository, "who.txt");
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
      expect(warningsOf(WORKER)[0]?.message).toContain("at the same time");
      expect(warningsOf(WORKER)[0]?.message).toContain("edit tools still are");
      expect(warningsOf(REVIEWER)).toHaveLength(1);

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

    it("counts a session that became busy while git was listing", async () => {
      // A `git` that waits while `hold` exists lets the test start the
      // reviewer's item while the check is inside git.
      const dir = realpathSync(createTemporaryDir("hercule-slow-git-"));
      const hold = join(dir, "hold");
      const entered = join(dir, "entered");
      const realGit = Bun.which("git") ?? "git";
      writeFileSync(
        join(dir, "git"),
        `#!/bin/sh\nif [ -f "${hold}" ]; then touch "${entered}"; while [ -f "${hold}" ]; do sleep 0.02; done; fi\nexec "${realGit}" "$@"\n`,
      );
      chmodSync(join(dir, "git"), 0o755);
      const { repository, observe, run, watch, warnings, attach } = await start();
      const connection = makeConnection(undefined, {
        PATH: `${dir}:${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"],
      });
      await attach(connection.connection, true);
      write(repository, "who.txt");
      writeFileSync(hold, "");
      await observe(itemStarted(WORKER, "c-1"));
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(existsSync(entered)).toBe(true));
      await run(watch.observeEvent(itemStarted(REVIEWER, "r-1")));
      rmSync(hold);
      await vi.waitFor(() => expect(warnings).toHaveLength(2));
      expect(connection.paths()).toEqual([]);
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
      await observe({
        _tag: "turn.completed",
        sessionId: REVIEWER,
        state: "interrupted",
      } as unknown as ProviderEvent);
      // The first check still finds the reviewer busy since its start, and
      // there is nothing to attribute. After it, the reviewer counts no more.
      await runCheckedCommand(WORKER, "c-0");
      write(repository, "a.txt");
      await runCheckedCommand(WORKER, "c-1");
      expect(connection.paths(WORKER)).toEqual(["a.txt"]);
      expect(warnings).toHaveLength(2);
    });

    it("counts a session as busy when its item completes without a start", async () => {
      const { repository, runCommand, observe, attach } = await start({ sessions: [WORKER] });
      const connection = makeConnection();
      await attach(connection.connection, true);
      write(repository, "background.txt");
      // The item completes without a start, so the session counts as busy until now.
      await observe(itemCompleted(WORKER, "c-1"));
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["background.txt"]));
      await runCommand(WORKER, "c-2");
      expect(connection.paths()).toEqual(["background.txt"]);
    });
  });

  describe("what counts as a change", () => {
    it("gives the files of the session's own commit to it", async () => {
      const { repository, runCommand, attach } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      write(repository, "committed.txt");
      runGitOrThrow(repository.dir, "add", ".");
      runGitOrThrow(repository.dir, "-c", "commit.gpgsign=false", "commit", "-m", "second");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(connection.paths(WORKER)).toEqual(["committed.txt"]));
    });

    it("counts only what an amend changed", async () => {
      const { repository, runCommand, attach } = await start({
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
      await runCommand(WORKER, "c-1");
      write(repository, "added.txt");
      runGitOrThrow(repository.dir, "add", "added.txt");
      runGitOrThrow(repository.dir, "-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit");
      await runCommand(WORKER, "c-2");
      await vi.waitFor(() => expect(connection.paths()).toEqual(["added.txt"]));
      expect(connection.frames).toHaveLength(1);
    });

    it("does not blame a session for a file that was already changed, until it changes again", async () => {
      const { repository, runCommand, attach } = await start({
        prepare: (repository) => write(repository, "dirty.txt", "found like this\n"),
      });
      const connection = makeConnection();
      await attach(connection.connection, true);
      await runCommand(WORKER, "c-1");
      write(repository, "other.txt");
      await runCommand(WORKER, "c-2");
      await vi.waitFor(() => expect(connection.paths()).toEqual(["other.txt"]));
      write(repository, "dirty.txt", "changed by the session, longer\n");
      await runCommand(WORKER, "c-3");
      await vi.waitFor(() => expect(connection.paths()).toEqual(["other.txt", "dirty.txt"]));
    });

    it("finds a changed file that is restored to HEAD", async () => {
      const { repository, runCommand, attach } = await start({
        prepare: (repository) => write(repository, "kept.txt", "the user's work\n"),
      });
      const connection = makeConnection();
      await attach(connection.connection, true);
      runGitOrThrow(repository.dir, "checkout", "--", "kept.txt");
      await runCommand(WORKER, "c-1");
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

    it("sends no frame to a controller without the capability, and warns each session once", async () => {
      const { repository, runCommand, warningsOf, state, watch, attach } = await start();
      const connection = makeConnection();
      await attach(connection.connection, false);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await runCommand(WORKER, "c-2");
      await runCommand(REVIEWER, "r-1");
      expect(warningsOf(WORKER)).toHaveLength(1);
      expect(warningsOf(WORKER)[0]?.message).toContain("controller does not read them");
      expect(warningsOf(REVIEWER)).toHaveLength(1);
      // Nothing runs and nothing is owed, so the last exit ends the watch at once.
      watch.removeSession(WORKER);
      watch.removeSession(REVIEWER);
      expect(state.ended).toBe(1);
      expect(connection.state.writing).toBe(0);
    });

    it("drops a check that waited for a connection when the next controller cannot read the files", async () => {
      const { runCommand, watch, state, attach } = await start({ sessions: [WORKER] });
      await runCommand(WORKER, "c-1");
      await attach(makeConnection().connection, false);
      watch.removeSession(WORKER);
      expect(state.ended).toBe(1);
    });
  });

  describe("when the watch ends", () => {
    it("ends at once when the last session exits with nothing owed", async () => {
      const { watch, state } = await start();
      watch.removeSession(WORKER);
      expect(state.ended).toBe(0);
      watch.removeSession(REVIEWER);
      expect(state.ended).toBe(1);
    });

    it("keeps the watch for the sessions that are left", async () => {
      const { repository, runCommand, watch, state, attach } = await start();
      const connection = makeConnection();
      await attach(connection.connection, true);
      watch.removeSession(WORKER);
      write(repository, "a.txt");
      await runCommand(REVIEWER, "r-1");
      await vi.waitFor(() => expect(connection.paths(REVIEWER)).toEqual(["a.txt"]));
      expect(state.ended).toBe(0);
    });

    it("still sends the files when the last session exits during the check, and ends after it", async () => {
      const { repository, runCommand, watch, state, attach } = await start({
        sessions: [WORKER],
      });
      const gate = Deferred.makeUnsafe<void>();
      const connection = makeConnection(gate);
      await attach(connection.connection, true);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(connection.state.writing).toBe(1));

      watch.removeSession(WORKER);
      expect(state.ended).toBe(0);
      Effect.runSync(Deferred.succeed(gate, undefined));
      await vi.waitFor(() => expect(state.ended).toBe(1));
      expect(connection.paths()).toEqual(["a.txt"]);
    });

    it("sends the files of an exited session on the next connection when the check was cut off", async () => {
      const { repository, runCommand, watch, state, attach, detach } = await start({
        sessions: [WORKER],
      });
      // This gate never opens: the check stays inside its write until the scope closes.
      const cutOff = makeConnection(Deferred.makeUnsafe<void>());
      await attach(cutOff.connection, true);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(cutOff.state.writing).toBe(1));
      watch.removeSession(WORKER);
      detach();
      await Effect.runPromise(Scope.close(cutOff.scope, Exit.void));
      expect(cutOff.paths()).toEqual([]);
      expect(state.ended).toBe(0);

      const next = makeConnection();
      await attach(next.connection, true);
      await vi.waitFor(() => expect(state.ended).toBe(1));
      expect(next.paths(WORKER)).toEqual(["a.txt"]);
    });

    it("lists again on the next connection when the listing was cut off", async () => {
      const dir = realpathSync(createTemporaryDir("hercule-slow-git-"));
      const hold = join(dir, "hold");
      const entered = join(dir, "entered");
      const realGit = Bun.which("git") ?? "git";
      writeFileSync(
        join(dir, "git"),
        `#!/bin/sh\nif [ -f "${hold}" ]; then touch "${entered}"; while [ -f "${hold}" ]; do sleep 0.02; done; fi\nexec "${realGit}" "$@"\n`,
      );
      chmodSync(join(dir, "git"), 0o755);
      const { repository, runCommand, attach, detach } = await start({ sessions: [WORKER] });
      const slow = makeConnection(undefined, {
        PATH: `${dir}:${process.env["PATH"] ?? ""}`,
        HOME: process.env["HOME"],
      });
      await attach(slow.connection, true);
      write(repository, "a.txt");
      writeFileSync(hold, "");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(existsSync(entered)).toBe(true));
      detach();
      await Effect.runPromise(Scope.close(slow.scope, Exit.void));
      rmSync(hold);

      const next = makeConnection();
      await attach(next.connection, true);
      await vi.waitFor(() => expect(next.paths(WORKER)).toEqual(["a.txt"]));
    });

    it("does not send the files of an exited session again once they were delivered", async () => {
      const { repository, runCommand, watch, state, attach } = await start({
        sessions: [WORKER, REVIEWER],
      });
      const first = makeConnection();
      await attach(first.connection, true);
      write(repository, "a.txt");
      await runCommand(WORKER, "c-1");
      await vi.waitFor(() => expect(first.paths()).toEqual(["a.txt"]));
      watch.removeSession(WORKER);
      await Effect.runPromise(Scope.close(first.scope, Exit.void));

      const second = makeConnection();
      await attach(second.connection, true);
      write(repository, "b.txt");
      await runCommand(REVIEWER, "r-1");
      await vi.waitFor(() => expect(second.paths()).toEqual(["b.txt"]));
      expect(state.ended).toBe(0);
    });

    it("does nothing when a connection attaches after the watch ended", async () => {
      const { repository, watch, state, attach } = await start({ sessions: [WORKER] });
      watch.removeSession(WORKER);
      expect(state.ended).toBe(1);
      write(repository, "a.txt");
      const connection = makeConnection();
      const readsBefore = state.connectionReads;
      await attach(connection.connection, true);
      // Requesting a check starts by asking for the connection, so an ended
      // watch that asks for none started no check.
      expect(state.connectionReads).toBe(readsBefore);
    });
  });

  describe("a workspace that is not observed", () => {
    it("warns each session once with the reason, when its first command finishes", async () => {
      const repository = makeRepository();
      const { runCommand, warningsOf, watch, state, attach } = startOn(
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
      expect(warningsOf(WORKER)).toHaveLength(1);
      expect(warningsOf(WORKER)[0]?.message).toContain("the workspace is the main one");
      expect(warningsOf(REVIEWER)).toHaveLength(1);
      watch.removeSession(WORKER);
      watch.removeSession(REVIEWER);
      expect(state.ended).toBe(1);
      expect(connection.state.writing).toBe(0);
    });

    it("warns only while a connection is up", async () => {
      const repository = makeRepository();
      const { runCommand, warnings, attach } = startOn(
        repository,
        { _tag: "unavailable", reason: "the workspace is the main one" },
        [WORKER],
      );
      await runCommand(WORKER, "c-1");
      expect(warnings).toEqual([]);
      await attach(makeConnection().connection, true);
      await runCommand(WORKER, "c-2");
      expect(warnings).toHaveLength(1);
    });

    it("warns once, naming the checkout and git's first error line, when git cannot read it", async () => {
      const repository = makeRepository();
      // HEAD names a branch with no commit, so git cannot compare with it.
      runGitOrThrow(repository.dir, "checkout", "--orphan", "unborn");
      const { runCommand, warnings, watch, state, attach } = await start({
        repository,
        sessions: [WORKER],
      });
      const connection = makeConnection();
      await attach(connection.connection, true);
      await runCommand(WORKER, "c-1");
      await runCommand(WORKER, "c-2");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(repository.dir);
      expect(warnings[0]?.message).toContain("git failed");
      watch.removeSession(WORKER);
      expect(state.ended).toBe(1);
      expect(connection.state.writing).toBe(0);
    });

    it("observes nothing and warns of nothing in a workspace without checkouts", async () => {
      const warnings: Array<string> = [];
      const state = { ended: 0 };
      const connection = makeConnection();
      const watch = startEditWatch(
        [],
        { _tag: "taken", checkouts: [] },
        {
          cwd: "/",
          readAttachedConnection: () => ({
            connection: connection.connection,
            readsFilesEdited: false,
          }),
          warn: (_sessionId, message) => Effect.sync(() => void warnings.push(message)),
          onEnded: () => void (state.ended += 1),
        },
      );
      watch.addSession(WORKER);
      await Effect.runPromise(watch.observeEvent(itemStarted(WORKER, "c-1")));
      await Effect.runPromise(watch.observeEvent(itemCompleted(WORKER, "c-1")));
      expect(warnings).toEqual([]);
      watch.removeSession(WORKER);
      expect(state.ended).toBe(1);
    });
  });
});
