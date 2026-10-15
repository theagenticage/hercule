import { realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_EDITED_FILES, type ProviderEvent, type RunnerToController } from "@hercule/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { cleanTemporaries, createTemporaryDir, runGitOrThrow } from "../workspaces/testing";
import { buildSubstrateEnv } from "../workspaces";
import { takeChangeBaseline } from "./checkout-edits";
import {
  isFinishedCommand,
  startEditWatch,
  type AttachedConnection,
  type EditWatchConnection,
} from "./edit-watch";

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

describe("telling a finished command from one that never ran", () => {
  const item = (kind: string, status: string) =>
    ({ _tag: "item.completed", kind, status }) as unknown as ProviderEvent;

  it("counts a completed or failed command, and nothing else", () => {
    expect(isFinishedCommand(item("command_execution", "completed"))).toBe(true);
    expect(isFinishedCommand(item("command_execution", "failed"))).toBe(true);
    expect(isFinishedCommand(item("command_execution", "declined"))).toBe(false);
    expect(isFinishedCommand(item("file_change", "completed"))).toBe(false);
    expect(isFinishedCommand({ _tag: "turn.completed" } as unknown as ProviderEvent)).toBe(false);
  });
});

describe("an edit watch", () => {
  /**
   * A connection that records its frames. While `gate` is closed, a frame
   * waits to be written, and `writing` counts the frames that started. A
   * gate that never opens holds a check inside its write until the
   * connection's scope closes.
   */
  const makeConnection = (gate?: Deferred.Deferred<void>) => {
    const scope = Effect.runSync(Scope.make());
    scopes.push(scope);
    const frames: Array<RunnerToController> = [];
    const state = { writing: 0 };
    const connection: EditWatchConnection = {
      scope,
      machine: { baseEnv: { PATH: process.env["PATH"], HOME: process.env["HOME"] } },
      send: (frame) =>
        Effect.gen(function* () {
          state.writing += 1;
          if (gate !== undefined) yield* Deferred.await(gate);
          frames.push(frame);
        }),
    };
    const paths = () =>
      frames.flatMap((frame) =>
        frame._tag === "filesEdited" ? frame.editedFiles.map((file) => file.path) : [],
      );
    return { connection, frames, paths, state, scope };
  };

  /**
   * Starts a watch over a repository, with a real baseline, and records what
   * it reports. `attach` makes a connection the current one and tells the
   * watch, as the supervisor does.
   */
  const start = async (
    options: { readonly repository?: ReturnType<typeof makeRepository> } = {},
  ) => {
    const repository = options.repository ?? makeRepository();
    const baseline = await Effect.runPromise(takeChangeBaseline([repository.checkout], ENV));
    const warnings: Array<string> = [];
    const state = { ended: 0 };
    let attached: AttachedConnection | undefined;
    const watch = startEditWatch([repository.checkout], baseline, {
      sessionId: "s-1",
      cwd: repository.dir,
      readAttachedConnection: () => attached,
      warn: (message) => Effect.sync(() => void warnings.push(message)),
      onEnded: () => void (state.ended += 1),
    });
    const run = (effect: Effect.Effect<void>) => Effect.runPromise(effect);
    const setAttached = (connection: EditWatchConnection, readsFilesEdited: boolean) => {
      attached = { connection, readsFilesEdited };
    };
    const attach = (connection: EditWatchConnection, readsFilesEdited: boolean) => {
      setAttached(connection, readsFilesEdited);
      return run(watch.connectionAttached());
    };
    const detach = () => {
      attached = undefined;
    };
    return { repository, watch, warnings, state, run, attach, setAttached, detach };
  };

  const write = (repository: { readonly dir: string }, name: string) =>
    writeFileSync(join(repository.dir, name), "x\n");

  it("sends a new file once, and only the new files in the next frame", async () => {
    const { repository, watch, warnings, run, attach } = await start();
    const first = makeConnection();
    await attach(first.connection, true);
    write(repository, "first.txt");
    await run(watch.commandFinished());
    await vi.waitFor(() => expect(first.paths()).toEqual(["first.txt"]));

    // A command that changes nothing, then one that adds a file. Checks run
    // in order, so a repeat of the first file would come before the second.
    await run(watch.commandFinished());
    write(repository, "second.txt");
    await run(watch.commandFinished());
    await vi.waitFor(() => expect(first.paths()).toContain("second.txt"));
    expect(first.paths()).toEqual(["first.txt", "second.txt"]);
    expect(warnings).toEqual([]);
  });

  it("sends more files than one frame holds in several frames, and loses none", async () => {
    const { repository, watch, run, attach } = await start();
    const connection = makeConnection();
    await attach(connection.connection, true);
    const total = MAX_EDITED_FILES + 44;
    for (let index = 0; index < total; index += 1) write(repository, `file-${String(index)}.txt`);
    await run(watch.commandFinished());
    await vi.waitFor(() => expect(connection.paths()).toHaveLength(total));
    expect(
      connection.frames.map((frame) =>
        frame._tag === "filesEdited" ? frame.editedFiles.length : 0,
      ),
    ).toEqual([MAX_EDITED_FILES, 44]);
    expect(new Set(connection.paths()).size).toBe(total);
  });

  it("runs one more check for a command that finished during a check", async () => {
    const { repository, watch, run, attach } = await start();
    const gate = Deferred.makeUnsafe<void>();
    const connection = makeConnection(gate);
    await attach(connection.connection, true);
    write(repository, "first.txt");
    await run(watch.commandFinished());
    // The check is inside its first write, so it has listed `first.txt` only.
    await vi.waitFor(() => expect(connection.state.writing).toBe(1));

    write(repository, "second.txt");
    await run(watch.commandFinished());
    Effect.runSync(Deferred.succeed(gate, undefined));
    await vi.waitFor(() => expect(connection.paths()).toHaveLength(2));
    expect(connection.paths()).toEqual(["first.txt", "second.txt"]);
  });

  it("uses a connection that attached without telling the watch, as soon as a command finishes", async () => {
    const { repository, watch, warnings, run, setAttached } = await start();
    // The state of a session that starts at the moment a connection attaches:
    // the supervisor's list of watches missed it, but the connection is up.
    const connection = makeConnection();
    setAttached(connection.connection, true);
    write(repository, "a.txt");
    await run(watch.commandFinished());
    await vi.waitFor(() => expect(connection.paths()).toEqual(["a.txt"]));
    expect(warnings).toEqual([]);
  });

  it("sends the files again on a new connection, with no command after it", async () => {
    const { repository, watch, run, attach } = await start();
    const first = makeConnection();
    await attach(first.connection, true);
    write(repository, "a.txt");
    await run(watch.commandFinished());
    await vi.waitFor(() => expect(first.paths()).toEqual(["a.txt"]));
    // The first connection ends before the next one attaches.
    await Effect.runPromise(Scope.close(first.scope, Exit.void));

    const second = makeConnection();
    await attach(second.connection, true);
    await vi.waitFor(() => expect(second.paths()).toEqual(["a.txt"]));
  });

  it("checks on the next connection when a command finished while none was up", async () => {
    const { repository, watch, run, attach } = await start();
    write(repository, "a.txt");
    await run(watch.commandFinished());
    const connection = makeConnection();
    await attach(connection.connection, true);
    await vi.waitFor(() => expect(connection.paths()).toEqual(["a.txt"]));
  });

  it("repeats a check whose listing failed on the next command", async () => {
    const { repository, watch, run, attach } = await start();
    const connection = makeConnection();
    await attach(connection.connection, true);
    write(repository, "a.txt");
    // Without its .git directory the folder is no repository, so git fails.
    renameSync(join(repository.dir, ".git"), join(repository.dir, ".git-away"));
    await run(watch.commandFinished());
    renameSync(join(repository.dir, ".git-away"), join(repository.dir, ".git"));
    await run(watch.commandFinished());
    await vi.waitFor(() => expect(connection.paths()).toEqual(["a.txt"]));
  });

  it("still sends the files when the session exits during the check, and ends after it", async () => {
    const { repository, watch, state, run, attach } = await start();
    const gate = Deferred.makeUnsafe<void>();
    const connection = makeConnection(gate);
    await attach(connection.connection, true);
    write(repository, "a.txt");
    await run(watch.commandFinished());
    await vi.waitFor(() => expect(connection.state.writing).toBe(1));

    watch.sessionExited();
    expect(state.ended).toBe(0);
    Effect.runSync(Deferred.succeed(gate, undefined));
    await vi.waitFor(() => expect(state.ended).toBe(1));
    expect(connection.paths()).toEqual(["a.txt"]);
  });

  it("sends the files of an exited session on the next connection when the check was cut off", async () => {
    const { repository, watch, state, run, attach, detach } = await start();
    // This gate never opens: the check stays inside its write until the scope closes.
    const cutOff = makeConnection(Deferred.makeUnsafe<void>());
    await attach(cutOff.connection, true);
    write(repository, "a.txt");
    await run(watch.commandFinished());
    await vi.waitFor(() => expect(cutOff.state.writing).toBe(1));
    watch.sessionExited();
    detach();
    await Effect.runPromise(Scope.close(cutOff.scope, Exit.void));
    expect(cutOff.paths()).toEqual([]);
    expect(state.ended).toBe(0);

    const next = makeConnection();
    await attach(next.connection, true);
    await vi.waitFor(() => expect(state.ended).toBe(1));
    expect(next.paths()).toEqual(["a.txt"]);
  });

  it("ends at once when the session exits with nothing pending", async () => {
    const { watch, state } = await start();
    watch.sessionExited();
    expect(state.ended).toBe(1);
  });

  it("sends no frame to a controller without the capability, and warns once", async () => {
    const { repository, watch, warnings, state, run, attach } = await start();
    const connection = makeConnection();
    await attach(connection.connection, false);
    write(repository, "a.txt");
    await run(watch.commandFinished());
    await run(watch.commandFinished());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("controller does not read them");
    // Nothing runs and nothing is pending, so the exit ends the watch at once.
    watch.sessionExited();
    expect(state.ended).toBe(1);
    expect(connection.state.writing).toBe(0);
  });

  it("drops a check that waited for a connection when the next controller cannot read the files", async () => {
    const { watch, state, run, attach } = await start();
    await run(watch.commandFinished());
    await attach(makeConnection().connection, false);
    watch.sessionExited();
    expect(state.ended).toBe(1);
  });

  it("warns once, naming the checkout and git's first error line, when git cannot read it", async () => {
    const repository = makeRepository();
    // HEAD names a branch with no commit, so git cannot compare with it.
    runGitOrThrow(repository.dir, "checkout", "--orphan", "unborn");
    const { watch, warnings, state, run, attach } = await start({ repository });
    const connection = makeConnection();
    await attach(connection.connection, true);
    await run(watch.commandFinished());
    await run(watch.commandFinished());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(repository.dir);
    expect(warnings[0]).toContain("git failed");
    watch.sessionExited();
    expect(state.ended).toBe(1);
    expect(connection.state.writing).toBe(0);
  });

  it("stops observing for good when the workspace is shared, and warns once", async () => {
    const { repository, watch, warnings, state, run, attach } = await start();
    const connection = makeConnection();
    await attach(connection.connection, true);
    watch.workspaceShared();
    write(repository, "a.txt");
    await run(watch.commandFinished());
    await run(watch.commandFinished());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("shared");
    watch.sessionExited();
    expect(state.ended).toBe(1);
    expect(connection.state.writing).toBe(0);
  });

  it("warns only while a connection is up", async () => {
    const { watch, warnings, run, attach } = await start();
    watch.workspaceShared();
    await run(watch.commandFinished());
    expect(warnings).toEqual([]);
    await attach(makeConnection().connection, true);
    await run(watch.commandFinished());
    expect(warnings).toHaveLength(1);
  });

  it("does nothing when a connection attaches after the watch ended", async () => {
    const { repository, watch, state, attach } = await start();
    watch.sessionExited();
    expect(state.ended).toBe(1);
    write(repository, "a.txt");
    const connection = makeConnection();
    await attach(connection.connection, true);
    expect(connection.state.writing).toBe(0);
    // A check would be forked and running by now.
    await Effect.runPromise(Effect.yieldNow);
    expect(connection.state.writing).toBe(0);
  });

  it("observes nothing and warns of nothing in a session without checkouts", async () => {
    const warnings: Array<string> = [];
    const state = { ended: 0 };
    const connection = makeConnection();
    const watch = startEditWatch(
      [],
      { _tag: "taken", checkouts: [] },
      {
        sessionId: "s-1",
        cwd: "/",
        readAttachedConnection: () => ({
          connection: connection.connection,
          readsFilesEdited: false,
        }),
        warn: (message) => Effect.sync(() => void warnings.push(message)),
        onEnded: () => void (state.ended += 1),
      },
    );
    await Effect.runPromise(watch.commandFinished());
    expect(warnings).toEqual([]);
    watch.sessionExited();
    expect(state.ended).toBe(1);
  });
});
