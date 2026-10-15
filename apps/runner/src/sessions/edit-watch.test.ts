import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { MAX_EDITED_FILES, type ProviderEvent, type RunnerToController } from "@hercule/protocol";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { buildSubstrateEnv } from "../workspaces";
import {
  cleanTemporaries,
  cloneUserCheckout,
  createTemporaryDir,
  makeRemote,
  runGitOrThrow,
} from "../workspaces/testing";
import {
  isFinishedCommand,
  listSessionEdits,
  startEditWatch,
  takeChangeBaseline,
  type CheckoutBaseline,
  type EditWatchConnection,
} from "./edit-watch";

const scopes: Array<Scope.Scope> = [];

afterAll(async () => {
  await Promise.all(scopes.map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))));
  await cleanTemporaries();
});

const ENV = buildSubstrateEnv({ PATH: process.env["PATH"], HOME: process.env["HOME"] });

const commit = (dir: string, message: string) => {
  runGitOrThrow(dir, "add", ".");
  runGitOrThrow(dir, "-c", "commit.gpgsign=false", "commit", "-m", message);
};

/** Makes a repository with `kept.txt` and `dirty.txt` committed and `.gitignore` ignoring `*.log`. */
const makeRepository = () => {
  const dir = realpathSync(createTemporaryDir("hercule-edit-watch-"));
  runGitOrThrow(dir, "init", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), "*.log\n");
  writeFileSync(join(dir, "kept.txt"), "kept\n");
  writeFileSync(join(dir, "dirty.txt"), "dirty\n");
  commit(dir, "first");
  return { dir, checkout: { resourceId: "r-1", path: dir } };
};

const takeBaseline = async (checkout: { resourceId: string; path: string }) => {
  const baseline = await Effect.runPromise(takeChangeBaseline([checkout], ENV));
  if (baseline._tag !== "taken") throw new Error(`no baseline: ${baseline.reason}`);
  return baseline.checkouts;
};

const listEdits = async (baselines: ReadonlyArray<CheckoutBaseline>) =>
  [...(await Effect.runPromise(listSessionEdits(baselines, ENV)))].sort();

describe("the files a session changed since it started", () => {
  it("lists uncommitted, untracked and deleted files, and not ignored ones", async () => {
    const { dir, checkout } = makeRepository();
    const baselines = await takeBaseline(checkout);
    expect(await listEdits(baselines)).toEqual([]);

    writeFileSync(join(dir, "kept.txt"), "changed\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "new file.txt"), "new\n");
    writeFileSync(join(dir, "debug.log"), "ignored\n");
    rmSync(join(dir, "dirty.txt"));

    expect(await listEdits(baselines)).toEqual(
      [join(dir, "dirty.txt"), join(dir, "kept.txt"), join(dir, "sub", "new file.txt")].sort(),
    );
  });

  it("still lists a file the session changed and then committed, even in one command", async () => {
    const { dir, checkout } = makeRepository();
    const baselines = await takeBaseline(checkout);
    // Like `sed -i ... && git commit -am ...`: no check happens in between.
    writeFileSync(join(dir, "kept.txt"), "changed\n");
    commit(dir, "second");
    expect(await listEdits(baselines)).toEqual([join(dir, "kept.txt")]);
    // The file stays listed, and a later check does not forget it.
    expect(await listEdits(baselines)).toEqual([join(dir, "kept.txt")]);
  });

  it("keeps a space at the start of a file name", async () => {
    const { dir, checkout } = makeRepository();
    const baselines = await takeBaseline(checkout);
    writeFileSync(join(dir, " leading.txt"), "new\n");
    expect(await listEdits(baselines)).toEqual([join(dir, " leading.txt")]);
  });

  it("lists only what an amend changed, not the files of the commit it replaced", async () => {
    const { dir, checkout } = makeRepository();
    writeFileSync(join(dir, "prior.txt"), "work from before the session\n");
    commit(dir, "prior");
    const baselines = await takeBaseline(checkout);

    runGitOrThrow(dir, "-c", "commit.gpgsign=false", "commit", "--amend", "-m", "message only");
    expect(await listEdits(baselines)).toEqual([]);

    writeFileSync(join(dir, "added.txt"), "added\n");
    runGitOrThrow(dir, "add", "added.txt");
    runGitOrThrow(dir, "-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit");
    expect(await listEdits(baselines)).toEqual([join(dir, "added.txt")]);
  });

  it("lists paths relative to a linked worktree's own root", async () => {
    const { dir } = makeRepository();
    const worktree = join(realpathSync(createTemporaryDir("hercule-worktree-")), "wt");
    runGitOrThrow(dir, "worktree", "add", "-b", "other", worktree);
    const baselines = await takeBaseline({ resourceId: "r-1", path: worktree });
    writeFileSync(join(worktree, "kept.txt"), "changed\n");
    writeFileSync(join(worktree, "added.txt"), "added\n");
    expect(await listEdits(baselines)).toEqual(
      [join(worktree, "added.txt"), join(worktree, "kept.txt")].sort(),
    );
  });
});

describe("a file that was already changed when the session started", () => {
  it("is not listed until it changes again", async () => {
    const { dir, checkout } = makeRepository();
    writeFileSync(join(dir, "kept.txt"), "the user's work\n");
    writeFileSync(join(dir, "untracked.txt"), "the user's file\n");
    const baselines = await takeBaseline(checkout);
    expect(await listEdits(baselines)).toEqual([]);

    writeFileSync(join(dir, "kept.txt"), "the session's work, longer\n");
    expect(await listEdits(baselines)).toEqual([join(dir, "kept.txt")]);

    // The same size, only the modification time moves.
    utimesSync(join(dir, "untracked.txt"), new Date(), new Date(Date.now() + 60_000));
    expect(await listEdits(baselines)).toEqual(
      [join(dir, "kept.txt"), join(dir, "untracked.txt")].sort(),
    );
  });

  it("is listed when the session deletes it", async () => {
    const { dir, checkout } = makeRepository();
    writeFileSync(join(dir, "kept.txt"), "the user's work\n");
    const baselines = await takeBaseline(checkout);
    rmSync(join(dir, "kept.txt"));
    expect(await listEdits(baselines)).toEqual([join(dir, "kept.txt")]);
  });

  it("is listed when the session restores it to HEAD", async () => {
    const { dir, checkout } = makeRepository();
    writeFileSync(join(dir, "kept.txt"), "the user's work\n");
    const baselines = await takeBaseline(checkout);
    runGitOrThrow(dir, "checkout", "--", "kept.txt");
    expect(await listEdits(baselines)).toEqual([join(dir, "kept.txt")]);
  });
});

describe("commits that did not come from the session", () => {
  /** A clone of a remote that has a commit of its own, with the session's baseline taken. */
  const startInClone = async () => {
    const remote = makeRemote();
    const dir = realpathSync(cloneUserCheckout(remote));
    const baselines = await takeBaseline({ resourceId: "r-1", path: dir });
    const pushUpstream = (file: string) => {
      writeFileSync(join(remote.work, file), "upstream\n");
      commit(remote.work, `upstream ${file}`);
      runGitOrThrow(remote.work, "push", remote.path, "main");
    };
    return { remote, dir, baselines, pushUpstream };
  };

  it("are not listed after a pull", async () => {
    const { dir, baselines, pushUpstream } = await startInClone();
    pushUpstream("upstream.txt");
    runGitOrThrow(dir, "pull");
    expect(await listEdits(baselines)).toEqual([]);
  });

  it("are not listed after a rebase, while the session's own commit is", async () => {
    const { dir, baselines, pushUpstream } = await startInClone();
    writeFileSync(join(dir, "mine.txt"), "mine\n");
    commit(dir, "mine");
    pushUpstream("upstream.txt");
    runGitOrThrow(dir, "pull", "--rebase");
    expect(await listEdits(baselines)).toEqual([join(dir, "mine.txt")]);
  });

  it("are not listed after a checkout of another branch", async () => {
    const { remote, dir, baselines } = await startInClone();
    runGitOrThrow(remote.work, "checkout", "-b", "other");
    writeFileSync(join(remote.work, "other.txt"), "other\n");
    commit(remote.work, "other");
    runGitOrThrow(remote.work, "push", remote.path, "other");
    runGitOrThrow(dir, "fetch");
    runGitOrThrow(dir, "checkout", "other");
    expect(await listEdits(baselines)).toEqual([]);
  });
});

describe("a checkout whose own configuration is hostile", () => {
  it("never runs a program from core.fsmonitor or a clean filter", async () => {
    const { dir, checkout } = makeRepository();
    const markers = createTemporaryDir("hercule-markers-");
    const fsmonitorMarker = join(markers, "fsmonitor");
    const filterMarker = join(markers, "filter");
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=hostile\n");
    commit(dir, "attributes");
    appendFileSync(
      join(dir, ".git", "config"),
      `[core]\n\tfsmonitor = touch ${fsmonitorMarker}\n[filter "hostile"]\n\tclean = sh -c 'touch ${filterMarker}; cat'\n`,
    );
    const baselines = await takeBaseline(checkout);
    writeFileSync(join(dir, "kept.txt"), "changed\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    expect(await listEdits(baselines)).toEqual([join(dir, "kept.txt"), join(dir, "new.txt")]);
    expect(existsSync(fsmonitorMarker)).toBe(false);
    expect(existsSync(filterMarker)).toBe(false);
  });
});

describe("the baseline of a checkout the session cannot be observed in", () => {
  it("is unavailable, naming the checkout and git's first error line, outside a repository", async () => {
    const dir = realpathSync(createTemporaryDir("hercule-not-a-repository-"));
    const baseline = await Effect.runPromise(
      takeChangeBaseline([{ resourceId: "r-1", path: dir }], ENV),
    );
    expect(baseline._tag).toBe("unavailable");
    const reason = baseline._tag === "unavailable" ? baseline.reason : "";
    expect(reason).toContain(dir);
    expect(reason).toContain("not a git repository");
    expect(reason).not.toContain("\n");
  });

  it("is unavailable when more than 10,000 files differ from HEAD", async () => {
    const { dir, checkout } = makeRepository();
    mkdirSync(join(dir, "many"));
    for (let index = 0; index <= 10_000; index += 1) {
      writeFileSync(join(dir, "many", `${String(index)}.txt`), "x");
    }
    const baseline = await Effect.runPromise(takeChangeBaseline([checkout], ENV));
    expect(baseline).toMatchObject({ _tag: "unavailable" });
    expect(baseline._tag === "unavailable" ? baseline.reason : "").toContain("10000");
  });
});

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

  /** Starts a watch over a fresh repository, with a real baseline, and records what it reports. */
  const start = async (
    options: { readonly repository?: ReturnType<typeof makeRepository> } = {},
  ) => {
    const repository = options.repository ?? makeRepository();
    const baseline = await Effect.runPromise(takeChangeBaseline([repository.checkout], ENV));
    const warnings: Array<string> = [];
    const state = { ended: 0 };
    const watch = await Effect.runPromise(
      startEditWatch([repository.checkout], baseline, {
        sessionId: "s-1",
        cwd: repository.dir,
        attachedTo: undefined,
        warn: (message) => Effect.sync(() => void warnings.push(message)),
        onEnded: () => void (state.ended += 1),
      }),
    );
    const run = (effect: Effect.Effect<void>) => Effect.runPromise(effect);
    return { repository, watch, warnings, state, run, baseline };
  };

  const write = (repository: { readonly dir: string }, name: string) =>
    writeFileSync(join(repository.dir, name), "x\n");

  it("sends a new file once, and only the new files in the next frame", async () => {
    const { repository, watch, warnings, run } = await start();
    const first = makeConnection();
    await run(watch.connectionAttached(first.connection, true));
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
    const { repository, watch, run } = await start();
    const connection = makeConnection();
    await run(watch.connectionAttached(connection.connection, true));
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
    const { repository, watch, run } = await start();
    const gate = Deferred.makeUnsafe<void>();
    const connection = makeConnection(gate);
    await run(watch.connectionAttached(connection.connection, true));
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

  it("sends the files again on a new connection, with no command after it", async () => {
    const { repository, watch, run } = await start();
    const first = makeConnection();
    await run(watch.connectionAttached(first.connection, true));
    write(repository, "a.txt");
    await run(watch.commandFinished());
    await vi.waitFor(() => expect(first.paths()).toEqual(["a.txt"]));
    // The first connection ends before the next one attaches.
    await Effect.runPromise(Scope.close(first.scope, Exit.void));

    const second = makeConnection();
    await run(watch.connectionAttached(second.connection, true));
    await vi.waitFor(() => expect(second.paths()).toEqual(["a.txt"]));
  });

  it("checks on the next connection when a command finished while none was up", async () => {
    const { repository, watch, run } = await start();
    write(repository, "a.txt");
    await run(watch.commandFinished());
    const connection = makeConnection();
    await run(watch.connectionAttached(connection.connection, true));
    await vi.waitFor(() => expect(connection.paths()).toEqual(["a.txt"]));
  });

  it("still sends the files when the session exits during the check, and ends after it", async () => {
    const { repository, watch, state, run } = await start();
    const gate = Deferred.makeUnsafe<void>();
    const connection = makeConnection(gate);
    await run(watch.connectionAttached(connection.connection, true));
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
    const { repository, watch, state, run } = await start();
    // This gate never opens: the check stays inside its write until the scope closes.
    const cutOff = makeConnection(Deferred.makeUnsafe<void>());
    await run(watch.connectionAttached(cutOff.connection, true));
    write(repository, "a.txt");
    await run(watch.commandFinished());
    await vi.waitFor(() => expect(cutOff.state.writing).toBe(1));
    watch.sessionExited();
    await Effect.runPromise(Scope.close(cutOff.scope, Exit.void));
    expect(cutOff.paths()).toEqual([]);
    expect(state.ended).toBe(0);

    const next = makeConnection();
    await run(watch.connectionAttached(next.connection, true));
    await vi.waitFor(() => expect(state.ended).toBe(1));
    expect(next.paths()).toEqual(["a.txt"]);
  });

  it("ends at once when the session exits with nothing owed", async () => {
    const { watch, state } = await start();
    watch.sessionExited();
    expect(state.ended).toBe(1);
  });

  it("sends no frame to a controller without the capability, and warns once", async () => {
    const { repository, watch, warnings, run } = await start();
    const connection = makeConnection();
    await run(watch.connectionAttached(connection.connection, false));
    write(repository, "a.txt");
    await run(watch.commandFinished());
    await run(watch.commandFinished());
    expect(connection.frames).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("controller does not read them");
  });

  it("does not wait for a controller that cannot read the files when its session exits", async () => {
    const { watch, state, run } = await start();
    await run(watch.commandFinished());
    await run(watch.connectionAttached(makeConnection().connection, false));
    watch.sessionExited();
    expect(state.ended).toBe(1);
  });

  it("warns once, naming the checkout and git's first error line, when git cannot read it", async () => {
    const repository = makeRepository();
    // HEAD names a branch with no commit, so git cannot compare with it.
    runGitOrThrow(repository.dir, "checkout", "--orphan", "unborn");
    const { watch, warnings, run } = await start({ repository });
    const connection = makeConnection();
    await run(watch.connectionAttached(connection.connection, true));
    await run(watch.commandFinished());
    await run(watch.commandFinished());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(repository.dir);
    expect(warnings[0]).toContain("git failed");
    expect(connection.frames).toEqual([]);
  });

  it("stops observing for good when the workspace is shared, and warns once", async () => {
    const { repository, watch, warnings, run } = await start();
    const connection = makeConnection();
    await run(watch.connectionAttached(connection.connection, true));
    watch.workspaceShared();
    write(repository, "a.txt");
    await run(watch.commandFinished());
    await run(watch.commandFinished());
    expect(connection.frames).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("shared");
  });

  it("warns only while a connection is up", async () => {
    const { watch, warnings, run } = await start();
    watch.workspaceShared();
    await run(watch.commandFinished());
    expect(warnings).toEqual([]);
    await run(watch.connectionAttached(makeConnection().connection, true));
    await run(watch.commandFinished());
    expect(warnings).toHaveLength(1);
  });

  it("observes nothing and warns of nothing in a session without checkouts", async () => {
    const warnings: Array<string> = [];
    const watch = await Effect.runPromise(
      startEditWatch(
        [],
        { _tag: "taken", checkouts: [] },
        {
          sessionId: "s-1",
          cwd: "/",
          attachedTo: undefined,
          warn: (message) => Effect.sync(() => void warnings.push(message)),
          onEnded: () => undefined,
        },
      ),
    );
    const connection = makeConnection();
    await Effect.runPromise(watch.connectionAttached(connection.connection, false));
    await Effect.runPromise(watch.commandFinished());
    expect(connection.frames).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
