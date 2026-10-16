import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
  appendFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { buildSubstrateEnv } from "../workspaces";
import {
  cleanTemporaries,
  cloneUserCheckout,
  createTemporaryDir,
  makeRemote,
  runGitOrThrow,
} from "../workspaces/testing";
import { listChangesSince, takeInitialState, type CheckoutState } from "./checkout-edits";

afterAll(cleanTemporaries);

const ENV = buildSubstrateEnv({ PATH: process.env["PATH"], HOME: process.env["HOME"] });

const commit = (dir: string, message: string) => {
  runGitOrThrow(dir, "add", ".");
  runGitOrThrow(dir, "-c", "commit.gpgsign=false", "commit", "-m", message);
};

/** Makes a repository with `kept.txt` and `dirty.txt` committed and `.gitignore` ignoring `*.log`. */
const makeRepository = () => {
  const dir = realpathSync(createTemporaryDir("hercule-checkout-edits-"));
  runGitOrThrow(dir, "init", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), "*.log\n");
  writeFileSync(join(dir, "kept.txt"), "kept\n");
  writeFileSync(join(dir, "dirty.txt"), "dirty\n");
  commit(dir, "first");
  return { dir, checkout: { resourceId: "r-1", path: dir } };
};

/**
 * Takes the first state of a checkout. `listChanges` lists what changed since
 * the previous call and moves the state on, as the edit watch does.
 */
const takeFirstState = async (checkout: { resourceId: string; path: string }) => {
  const initial = await Effect.runPromise(takeInitialState([checkout], ENV));
  if (initial._tag !== "taken") throw new Error(`no state: ${initial.reason}`);
  return { states: initial.checkouts };
};

const listEdits = async (tracker: { states: ReadonlyArray<CheckoutState> }) => {
  const listed = await Effect.runPromise(listChangesSince(tracker.states, ENV));
  tracker.states = listed.states;
  // Absolute paths read better in a test than a resource id and a relative path.
  const checkouts = new Map(tracker.states.map(({ checkout }) => [checkout.resourceId, checkout]));
  return listed.files.map((file) => join(checkouts.get(file.resourceId)!.path, file.path)).sort();
};

describe("the files that changed since the previous check", () => {
  it("lists uncommitted, untracked and deleted files, and not ignored ones", async () => {
    const { dir, checkout } = makeRepository();
    const tracker = await takeFirstState(checkout);
    expect(await listEdits(tracker)).toEqual([]);

    writeFileSync(join(dir, "kept.txt"), "changed\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "new file.txt"), "new\n");
    writeFileSync(join(dir, "debug.log"), "ignored\n");
    rmSync(join(dir, "dirty.txt"));

    expect(await listEdits(tracker)).toEqual(
      [join(dir, "dirty.txt"), join(dir, "kept.txt"), join(dir, "sub", "new file.txt")].sort(),
    );
  });

  it("does not list a file that already differed and is committed unchanged", async () => {
    const { dir, checkout } = makeRepository();
    writeFileSync(join(dir, "kept.txt"), "the user's work\n");
    const tracker = await takeFirstState(checkout);
    commit(dir, "the user's work, committed by a session");
    expect(await listEdits(tracker)).toEqual([]);
  });

  it("lists a changed symbolic link as itself, not as its target", async () => {
    const { dir, checkout } = makeRepository();
    symlinkSync("kept.txt", join(dir, "link.txt"));
    commit(dir, "link");
    const tracker = await takeFirstState(checkout);
    rmSync(join(dir, "link.txt"));
    symlinkSync("dirty.txt", join(dir, "link.txt"));
    expect(await listEdits(tracker)).toEqual([join(dir, "link.txt")]);
  });

  it("still lists a file that was changed and then committed, even in one command", async () => {
    const { dir, checkout } = makeRepository();
    const tracker = await takeFirstState(checkout);
    // Like `sed -i ... && git commit -am ...`: no check happens in between.
    writeFileSync(join(dir, "kept.txt"), "changed\n");
    commit(dir, "second");
    expect(await listEdits(tracker)).toEqual([join(dir, "kept.txt")]);
    // The file was listed once, so the next check has nothing new.
    expect(await listEdits(tracker)).toEqual([]);
  });

  it("lists a file again when it changes again after it was listed", async () => {
    const { dir, checkout } = makeRepository();
    const tracker = await takeFirstState(checkout);
    writeFileSync(join(dir, "kept.txt"), "changed\n");
    expect(await listEdits(tracker)).toEqual([join(dir, "kept.txt")]);
    expect(await listEdits(tracker)).toEqual([]);
    writeFileSync(join(dir, "kept.txt"), "changed again, longer\n");
    expect(await listEdits(tracker)).toEqual([join(dir, "kept.txt")]);
  });

  it("keeps a space at the start of a file name", async () => {
    const { dir, checkout } = makeRepository();
    const tracker = await takeFirstState(checkout);
    writeFileSync(join(dir, " leading.txt"), "new\n");
    expect(await listEdits(tracker)).toEqual([join(dir, " leading.txt")]);
  });

  it("lists only what an amend changed, not the files of the commit it replaced", async () => {
    const { dir, checkout } = makeRepository();
    writeFileSync(join(dir, "prior.txt"), "work from before the first state\n");
    commit(dir, "prior");
    const tracker = await takeFirstState(checkout);

    runGitOrThrow(dir, "-c", "commit.gpgsign=false", "commit", "--amend", "-m", "message only");
    expect(await listEdits(tracker)).toEqual([]);

    writeFileSync(join(dir, "added.txt"), "added\n");
    runGitOrThrow(dir, "add", "added.txt");
    runGitOrThrow(dir, "-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit");
    expect(await listEdits(tracker)).toEqual([join(dir, "added.txt")]);
  });

  it("lists paths relative to a linked worktree's own root", async () => {
    const { dir } = makeRepository();
    const worktree = join(realpathSync(createTemporaryDir("hercule-worktree-")), "wt");
    runGitOrThrow(dir, "worktree", "add", "-b", "other", worktree);
    const tracker = await takeFirstState({ resourceId: "r-1", path: worktree });
    writeFileSync(join(worktree, "kept.txt"), "changed\n");
    writeFileSync(join(worktree, "added.txt"), "added\n");
    expect(await listEdits(tracker)).toEqual(
      [join(worktree, "added.txt"), join(worktree, "kept.txt")].sort(),
    );
  });
});

describe("a file that was already changed at the first state", () => {
  it("is not listed until it changes", async () => {
    const { dir, checkout } = makeRepository();
    writeFileSync(join(dir, "kept.txt"), "the user's work\n");
    writeFileSync(join(dir, "untracked.txt"), "the user's file\n");
    const tracker = await takeFirstState(checkout);
    expect(await listEdits(tracker)).toEqual([]);

    writeFileSync(join(dir, "kept.txt"), "the new work, longer\n");
    expect(await listEdits(tracker)).toEqual([join(dir, "kept.txt")]);

    // The same size, only the modification time moves.
    utimesSync(join(dir, "untracked.txt"), new Date(), new Date(Date.now() + 60_000));
    expect(await listEdits(tracker)).toEqual([join(dir, "untracked.txt")]);
  });

  it("is listed when it is deleted", async () => {
    const { dir, checkout } = makeRepository();
    writeFileSync(join(dir, "kept.txt"), "the user's work\n");
    const tracker = await takeFirstState(checkout);
    rmSync(join(dir, "kept.txt"));
    expect(await listEdits(tracker)).toEqual([join(dir, "kept.txt")]);
  });

  it("is listed when it is restored to HEAD", async () => {
    const { dir, checkout } = makeRepository();
    writeFileSync(join(dir, "kept.txt"), "the user's work\n");
    const tracker = await takeFirstState(checkout);
    runGitOrThrow(dir, "checkout", "--", "kept.txt");
    expect(await listEdits(tracker)).toEqual([join(dir, "kept.txt")]);
  });
});

describe("commits that were not made in the checkout", () => {
  /** A clone of a remote that has a commit of its own, with the first state taken. */
  const startInClone = async () => {
    const remote = makeRemote();
    const dir = realpathSync(cloneUserCheckout(remote));
    const tracker = await takeFirstState({ resourceId: "r-1", path: dir });
    const pushUpstream = (file: string) => {
      writeFileSync(join(remote.work, file), "upstream\n");
      commit(remote.work, `upstream ${file}`);
      runGitOrThrow(remote.work, "push", remote.path, "main");
    };
    return { remote, dir, tracker, pushUpstream };
  };

  it("are not listed after a pull", async () => {
    const { dir, tracker, pushUpstream } = await startInClone();
    pushUpstream("upstream.txt");
    runGitOrThrow(dir, "pull");
    expect(await listEdits(tracker)).toEqual([]);
  });

  it("are not listed after a rebase, while an own commit is", async () => {
    const { dir, tracker, pushUpstream } = await startInClone();
    writeFileSync(join(dir, "mine.txt"), "mine\n");
    commit(dir, "mine");
    pushUpstream("upstream.txt");
    runGitOrThrow(dir, "pull", "--rebase");
    expect(await listEdits(tracker)).toEqual([join(dir, "mine.txt")]);
  });

  it("are not listed after a checkout of another branch", async () => {
    const { remote, dir, tracker } = await startInClone();
    runGitOrThrow(remote.work, "checkout", "-b", "other");
    writeFileSync(join(remote.work, "other.txt"), "other\n");
    commit(remote.work, "other");
    runGitOrThrow(remote.work, "push", remote.path, "other");
    runGitOrThrow(dir, "fetch");
    runGitOrThrow(dir, "checkout", "other");
    expect(await listEdits(tracker)).toEqual([]);
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
    const tracker = await takeFirstState(checkout);
    writeFileSync(join(dir, "kept.txt"), "changed\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    expect(await listEdits(tracker)).toEqual([join(dir, "kept.txt"), join(dir, "new.txt")]);
    expect(existsSync(fsmonitorMarker)).toBe(false);
    expect(existsSync(filterMarker)).toBe(false);
  });
});

describe("the first state of a checkout that cannot be observed", () => {
  it("is unavailable, naming the checkout and git's first error line, outside a repository", async () => {
    const dir = realpathSync(createTemporaryDir("hercule-not-a-repository-"));
    const baseline = await Effect.runPromise(
      takeInitialState([{ resourceId: "r-1", path: dir }], ENV),
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
    const baseline = await Effect.runPromise(takeInitialState([checkout], ENV));
    expect(baseline).toMatchObject({ _tag: "unavailable" });
    expect(baseline._tag === "unavailable" ? baseline.reason : "").toContain("10000");
  });
});
