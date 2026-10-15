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
import { listSessionEdits, takeChangeBaseline, type CheckoutBaseline } from "./command-edits";

afterAll(cleanTemporaries);

const ENV = buildSubstrateEnv({ PATH: process.env["PATH"], HOME: process.env["HOME"] });

const commit = (dir: string, message: string) => {
  runGitOrThrow(dir, "add", ".");
  runGitOrThrow(dir, "-c", "commit.gpgsign=false", "commit", "-m", message);
};

/** Makes a repository with `kept.txt` and `dirty.txt` committed and `.gitignore` ignoring `*.log`. */
const makeRepository = () => {
  const dir = realpathSync(createTemporaryDir("hercule-command-edits-"));
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
