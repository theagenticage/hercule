import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeWorkspaces } from "./index";
import { makeRegistry } from "./registry";
import {
  buildCheckout,
  buildProvisionFrame,
  cleanTemporaries,
  createId,
  createTemporaryDir,
  hashContents,
  makeRemote,
  runGitOrThrow,
} from "./testing";

afterAll(cleanTemporaries);

const createManaged = async () => {
  const remote = makeRemote();
  writeFileSync(join(remote.work, ".gitignore"), "private-cache/\n");
  runGitOrThrow(remote.work, "add", ".gitignore");
  runGitOrThrow(remote.work, "commit", "-m", "Ignore private cache");
  runGitOrThrow(remote.work, "push", remote.path, "main");
  const storageDir = createTemporaryDir("hercule-lifecycle-managed-home-");
  const manager = makeWorkspaces({ storageDir });
  const frame = buildProvisionFrame({
    kind: "ephemeral",
    checkouts: [
      buildCheckout({ resourceId: createId(), remote: remote.url, branch: `work-${createId()}` }),
    ],
  });
  const report = await manager.provision(frame);
  expect(report.status, report.message).toBe("ready");
  const cwd = manager.resolve(frame.workspaceId)!.cwd;
  const common = realpathSync(
    runGitOrThrow(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  return { remote, storageDir, manager, frame, cwd, common };
};

const makeRemainingFile = (cwd: string, kind: "tracked" | "untracked" | "ignored"): string => {
  const path =
    kind === "tracked"
      ? join(cwd, "README.md")
      : kind === "untracked"
        ? join(cwd, "human-notes.txt")
        : join(cwd, "private-cache", "secret.txt");
  if (kind === "ignored") mkdirSync(join(cwd, "private-cache"));
  writeFileSync(path, `unfinished ${kind} work\n`);
  return path;
};

describe("safe managed disposal", () => {
  it("refuses a mismatched pending removal snapshot without deleting another workspace", async () => {
    const fixture = await createManaged();
    writeFileSync(join(fixture.cwd, "human-notes.txt"), "preserve this workspace\n");
    const registry = makeRegistry(fixture.storageDir);
    const victim = registry.held(fixture.frame.workspaceId)!;
    const before = hashContents(victim.root);
    const sourceBefore = hashContents(fixture.common);
    const instruction = {
      _tag: "workspaceDispose" as const,
      workspaceId: createId(),
      discardChanges: true,
    };
    await registry.recordRemoval({
      workspaceId: instruction.workspaceId,
      instruction,
      phase: "pending",
      workspace: victim,
    });

    const restarted = makeWorkspaces({ storageDir: fixture.storageDir });
    const report = await restarted.dispose(instruction);
    expect(report.workspaceId).toBe(instruction.workspaceId);
    expect(report.status, report.message).toBe("failed");
    expect(report.message).toMatch(/record|registry|workspace|match|preserve/i);
    expect(hashContents(victim.root)).toBe(before);
    expect(hashContents(fixture.common)).toBe(sourceBefore);
    expect(restarted.resolve(victim.workspaceId)?.cwd).toBe(fixture.cwd);
  });

  it("refuses a legacy workspace record that points at a source cache instead of its own root", async () => {
    const storageDir = createTemporaryDir("hercule-misbound-cache-home-");
    const cache = join(storageDir, "cache");
    runGitOrThrow(storageDir, "init", "--bare", cache);
    writeFileSync(join(cache, "source-notes.txt"), "preserve the source repository\n");
    const before = hashContents(cache);
    const workspaceId = createId();
    writeFileSync(
      join(storageDir, "workspaces.json"),
      JSON.stringify([{ workspaceId, kind: "ephemeral", root: cache, checkouts: [] }]),
    );

    const report = await makeWorkspaces({ storageDir }).dispose({
      _tag: "workspaceDispose",
      workspaceId,
      discardChanges: true,
    });
    expect(report.status, report.message).toBe("failed");
    expect(report.message).toMatch(/record|registry|root|ownership|managed|preserve/i);
    expect(hashContents(cache)).toBe(before);
    expect(runGitOrThrow(cache, "rev-parse", "--is-bare-repository")).toBe("true");
  });

  it("refuses a workspace record that points at another managed workspace's root", async () => {
    const fixture = await createManaged();
    writeFileSync(join(fixture.cwd, "human-notes.txt"), "the other workspace owns these files\n");
    const root = fixture.manager.resolve(fixture.frame.workspaceId)!.root;
    const before = hashContents(root);
    const sourceBefore = hashContents(fixture.common);
    const workspaceId = createId();
    writeFileSync(
      join(fixture.storageDir, "workspaces.json"),
      JSON.stringify([
        ...makeRegistry(fixture.storageDir).all(),
        { workspaceId, kind: "ephemeral", root, checkouts: [] },
      ]),
    );

    const restarted = makeWorkspaces({ storageDir: fixture.storageDir });
    const report = await restarted.dispose({
      _tag: "workspaceDispose",
      workspaceId,
      discardChanges: true,
    });
    expect(report.status, report.message).toBe("failed");
    expect(report.message).toMatch(/record|registry|root|ownership|managed|preserve/i);
    expect(hashContents(root)).toBe(before);
    expect(hashContents(fixture.common)).toBe(sourceBefore);
    expect(restarted.resolve(fixture.frame.workspaceId)?.cwd).toBe(fixture.cwd);
  });

  it.each(["tracked", "untracked", "ignored"] as const)(
    "retains %s files on ordinary removal and removes them only after explicit discard",
    async (kind) => {
      const fixture = await createManaged();
      const path = makeRemainingFile(fixture.cwd, kind);
      const before = hashContents(fixture.cwd);
      const branch = runGitOrThrow(fixture.cwd, "branch", "--show-current");
      const commit = runGitOrThrow(fixture.cwd, "rev-parse", "HEAD");
      const refusal = await fixture.manager.dispose({
        _tag: "workspaceDispose",
        workspaceId: fixture.frame.workspaceId,
      });
      expect(refusal.status).toBe("failed");
      expect(refusal.message).toMatch(/changes|files|dirty|preserve|discard|ignored/i);
      expect(hashContents(fixture.cwd)).toBe(before);
      expect(readFileSync(path, "utf8")).toBe(`unfinished ${kind} work\n`);
      expect(fixture.manager.resolve(fixture.frame.workspaceId)?.cwd).toBe(fixture.cwd);

      const discarded = await fixture.manager.dispose({
        _tag: "workspaceDispose",
        workspaceId: fixture.frame.workspaceId,
        discardChanges: true,
      });
      expect(discarded.status, discarded.message).toBe("deleted");
      expect(existsSync(fixture.cwd)).toBe(false);
      expect(existsSync(fixture.common)).toBe(true);
      expect(runGitOrThrow(fixture.common, "rev-parse", `refs/heads/${branch}`)).toBe(commit);
      expect(runGitOrThrow(fixture.common, "worktree", "list", "--porcelain")).not.toContain(
        `worktree ${fixture.cwd}`,
      );
      expect(
        await fixture.manager.dispose({
          _tag: "workspaceDispose",
          workspaceId: fixture.frame.workspaceId,
          discardChanges: true,
        }),
      ).toMatchObject({ status: "deleted" });
    },
  );

  it.each(["dirty second checkout", "root file"] as const)(
    "preflights every checkout and root before removing anything with a %s",
    async (kind) => {
      const remotes = [makeRemote(), makeRemote()];
      const storageDir = createTemporaryDir("hercule-lifecycle-multi-home-");
      const manager = makeWorkspaces({ storageDir });
      const frame = buildProvisionFrame({
        kind: "ephemeral",
        checkouts: remotes.map((remote, index) => ({
          ...buildCheckout({
            resourceId: createId(),
            remote: remote.url,
            branch: `work-${createId()}`,
          }),
          subdirectory: `repo-${index}`,
        })),
      });
      expect((await manager.provision(frame)).status).toBe("ready");
      const root = manager.resolve(frame.workspaceId)!.root;
      const path =
        kind === "root file" ? join(root, "human-notes.txt") : join(root, "repo-1", "README.md");
      writeFileSync(path, "unfinished human work\n");
      const before = hashContents(root);
      const refused = await manager.dispose({
        _tag: "workspaceDispose",
        workspaceId: frame.workspaceId,
      });
      expect(refused.status).toBe("failed");
      expect(refused.message).toMatch(/changes|files|root|dirty|preserve|discard/i);
      expect(hashContents(root)).toBe(before);
      expect(existsSync(join(root, "repo-0", ".git"))).toBe(true);
      expect(existsSync(join(root, "repo-1", ".git"))).toBe(true);
      expect(manager.resolve(frame.workspaceId)).toBeDefined();
    },
  );

  it("reports a partial removal honestly when a later checkout changes after clean preflight", async () => {
    const remotes = [makeRemote(), makeRemote()];
    const storageDir = createTemporaryDir("hercule-removal-race-home-");
    const original = makeWorkspaces({ storageDir });
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: remotes.map((remote, index) => ({
        ...buildCheckout({
          resourceId: createId(),
          remote: remote.url,
          branch: `partial-${createId()}`,
        }),
        subdirectory: `repo-${index}`,
      })),
    });
    expect((await original.provision(frame)).status).toBe("ready");
    const root = original.resolve(frame.workspaceId)!.root;
    const first = join(root, "repo-0");
    const second = join(root, "repo-1");
    const firstCommon = runGitOrThrow(
      first,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const firstBranch = runGitOrThrow(first, "branch", "--show-current");
    const firstCommit = runGitOrThrow(first, "rev-parse", "HEAD");
    const bin = join(storageDir, "bin");
    mkdirSync(bin);
    const entered = join(storageDir, "second-removal-entered");
    const release = join(storageDir, "release-second-removal");
    const git = Bun.which("git")!;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in\n*' worktree remove '*${quote(second)}*)\nprintf '%s\\n' "$$" > ${quote(entered)}\nwhile [ ! -f ${quote(release)} ]; do sleep 0.01; done\n;;\nesac\nexec ${quote(git)} "$@"\n`,
      { mode: 0o700 },
    );
    const manager = makeWorkspaces({
      storageDir,
      gitEnv: { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
    });
    const pending = manager.dispose({ _tag: "workspaceDispose", workspaceId: frame.workspaceId });
    let completed: Awaited<typeof pending> | undefined;
    void pending.then((report) => {
      completed = report;
    });
    try {
      const until = Date.now() + 5000;
      while (!existsSync(entered)) {
        if (completed !== undefined)
          throw new Error(completed.message ?? "Removal did not reach its real Git barrier");
        if (Date.now() > until) throw new Error("Git never reached second removal");
        await Bun.sleep(10);
      }
      expect(existsSync(first)).toBe(false);
      writeFileSync(join(second, "README.md"), "changed during removal\n");
    } finally {
      writeFileSync(release, "release\n");
      await pending;
    }
    const refused = await pending;
    expect(refused.status).toBe("failed");
    expect(refused.message).toMatch(/partial|removed|missing|unavailable/i);
    expect(existsSync(first)).toBe(false);
    expect(readFileSync(join(second, "README.md"), "utf8")).toBe("changed during removal\n");
    expect(runGitOrThrow(firstCommon, "rev-parse", `refs/heads/${firstBranch}`)).toBe(firstCommit);
    expect(manager.resolve(frame.workspaceId)).toBeUndefined();
    expect((await manager.inspect(frame.workspaceId)).status).toBe("failed");
  });

  it("refuses forced deletion when the runner lost the registry that proves ownership", async () => {
    const fixture = await createManaged();
    writeFileSync(join(fixture.cwd, "human-notes.txt"), "preserve without ownership record\n");
    const before = hashContents(fixture.cwd);
    rmSync(join(fixture.storageDir, "workspaces.json"));
    const restarted = makeWorkspaces({ storageDir: fixture.storageDir });
    const refused = await restarted.dispose({
      _tag: "workspaceDispose",
      workspaceId: fixture.frame.workspaceId,
      discardChanges: true,
    });
    expect(refused.status).toBe("failed");
    expect(refused.message).toMatch(/record|registry|known|ownership|preserve|files/i);
    expect(hashContents(fixture.cwd)).toBe(before);
    expect(readFileSync(join(fixture.cwd, "human-notes.txt"), "utf8")).toBe(
      "preserve without ownership record\n",
    );
  });

  it("removes a clean generated worktree while keeping its committed branch and neighboring files", async () => {
    const fixture = await createManaged();
    const neighboring = join(fixture.storageDir, "workspaces", "neighboring-human-files");
    mkdirSync(neighboring);
    writeFileSync(join(neighboring, "notes.txt"), "neighbor stays\n");
    writeFileSync(join(fixture.cwd, "committed.txt"), "committed work\n");
    runGitOrThrow(fixture.cwd, "add", "committed.txt");
    runGitOrThrow(fixture.cwd, "commit", "-m", "Keep the committed branch");
    const branch = runGitOrThrow(fixture.cwd, "branch", "--show-current");
    const commit = runGitOrThrow(fixture.cwd, "rev-parse", "HEAD");
    const removed = await fixture.manager.dispose({
      _tag: "workspaceDispose",
      workspaceId: fixture.frame.workspaceId,
    });
    expect(removed.status, removed.message).toBe("deleted");
    expect(existsSync(fixture.cwd)).toBe(false);
    expect(runGitOrThrow(fixture.common, "rev-parse", `refs/heads/${branch}`)).toBe(commit);
    expect(readFileSync(join(neighboring, "notes.txt"), "utf8")).toBe("neighbor stays\n");
  });
});

describe("attached sources and detachment", () => {
  it("observes derived workspace IDs by the adopted source repository and drops disposed worktrees", async () => {
    const remote = makeRemote();
    const world = createTemporaryDir("hercule-derived-observation-source-");
    const source = join(world, "selected checkout");
    const unrelatedSource = join(world, "unrelated checkout");
    runGitOrThrow(world, "clone", remote.url, source);
    runGitOrThrow(world, "clone", remote.url, unrelatedSource);
    const remoteUrl = `https://fixture.invalid/acme/${createId()}`;
    for (const path of [source, unrelatedSource])
      runGitOrThrow(path, "remote", "set-url", "origin", remoteUrl);
    const storageDir = createTemporaryDir("hercule-derived-observation-home-");
    const manager = makeWorkspaces({ storageDir });
    const derivedIds: Array<string> = [];
    const primaries: Array<string> = [];
    for (const path of [source, unrelatedSource]) {
      const resourceId = createId();
      const primary = {
        ...buildProvisionFrame({
          kind: "primary",
          checkouts: [buildCheckout({ resourceId, remote: remoteUrl })],
        }),
        attachment: { path, remoteName: "origin" },
      };
      expect((await manager.provision(primary)).status).toBe("ready");
      primaries.push(primary.workspaceId);
      const derived = buildProvisionFrame({
        kind: "ephemeral",
        checkouts: [
          {
            ...buildCheckout({ resourceId, remote: remoteUrl, branch: `derived-${createId()}` }),
            repositoryWorkspaceId: primary.workspaceId,
            startingRevision: { kind: "current" },
          },
        ],
      });
      expect((await manager.provision(derived)).status).toBe("ready");
      derivedIds.push(derived.workspaceId);
    }
    expect(await manager.inspect(primaries[0]!)).toMatchObject({
      status: "ready",
      derivedWorkspaceIds: [derivedIds[0]],
    });
    expect(await manager.inspect(primaries[1]!)).toMatchObject({
      status: "ready",
      derivedWorkspaceIds: [derivedIds[1]],
    });
    expect(
      (
        await manager.dispose({
          _tag: "workspaceDispose",
          workspaceId: derivedIds[0]!,
        })
      ).status,
    ).toBe("deleted");
    expect(await manager.inspect(primaries[0]!)).toMatchObject({
      status: "ready",
      derivedWorkspaceIds: [],
    });
  });

  it("never disposes attached files, and detaches only registration while derived work remains usable", async () => {
    const remote = makeRemote();
    const world = createTemporaryDir("hercule-lifecycle-attached-source-");
    const source = join(world, "selected checkout");
    runGitOrThrow(world, "clone", remote.url, source);
    const remoteUrl = `https://fixture.invalid/acme/${createId()}`;
    runGitOrThrow(source, "remote", "set-url", "origin", remoteUrl);
    runGitOrThrow(source, "config", "user.preservation", "keep this config");
    writeFileSync(join(source, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    writeFileSync(join(source, "README.md"), "unfinished tracked source work\n");
    const storageDir = createTemporaryDir("hercule-lifecycle-attached-home-");
    const gitEnv = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
      GIT_CONFIG_VALUE_0: remoteUrl,
    };
    const manager = makeWorkspaces({ storageDir, gitEnv });
    const resourceId = createId();
    const primary = {
      ...buildProvisionFrame({
        kind: "primary",
        checkouts: [buildCheckout({ resourceId, remote: remoteUrl })],
      }),
      attachment: { path: source, remoteName: "origin" },
    };
    expect((await manager.provision(primary)).status).toBe("ready");
    const derived = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        {
          ...buildCheckout({ resourceId, remote: remoteUrl, branch: `derived-${createId()}` }),
          repositoryWorkspaceId: primary.workspaceId,
          startingRevision: { kind: "current" },
        },
      ],
    });
    expect((await manager.provision(derived)).status).toBe("ready");
    const derivedRoot = manager.resolve(derived.workspaceId)!.cwd;
    const sourceBefore = hashContents(source);
    for (const discardChanges of [false, true]) {
      const refused = await manager.dispose({
        _tag: "workspaceDispose",
        workspaceId: primary.workspaceId,
        discardChanges,
      });
      expect(refused.status).toBe("failed");
      expect(refused.message).toMatch(/attach|existing|detach|user-owned/i);
      expect(hashContents(source)).toBe(sourceBefore);
    }
    const detached = await manager.detach({
      _tag: "workspaceDetach",
      workspaceId: primary.workspaceId,
    });
    expect(detached.status, detached.message).toBe("deleted");
    expect(hashContents(source)).toBe(sourceBefore);
    expect(manager.resolve(primary.workspaceId)).toBeUndefined();
    expect(manager.resolve(derived.workspaceId)?.cwd).toBe(derivedRoot);
    expect((await manager.inspect(derived.workspaceId)).status).toBe("ready");
    const restarted = makeWorkspaces({ storageDir, gitEnv });
    expect(restarted.resolve(primary.workspaceId)).toBeUndefined();
    expect(restarted.resolve(derived.workspaceId)?.cwd).toBe(derivedRoot);
    const fresh = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        {
          ...buildCheckout({ resourceId, remote: remoteUrl, branch: `after-detach-${createId()}` }),
          startingRevision: { kind: "current" },
        },
      ],
    });
    const blocked = await restarted.provision(fresh);
    expect(blocked.status).toBe("failed");
    expect(blocked.message).toMatch(/reattach|registration|selected.*unavailable|restore/i);
    expect(hashContents(source)).toBe(sourceBefore);
    const derivedBranch = runGitOrThrow(derivedRoot, "branch", "--show-current");
    const derivedCommit = runGitOrThrow(derivedRoot, "rev-parse", "HEAD");
    writeFileSync(join(derivedRoot, "README.md"), "explicitly discarded derived changes\n");
    const removed = await restarted.dispose({
      _tag: "workspaceDispose",
      workspaceId: derived.workspaceId,
      discardChanges: true,
    });
    expect(removed.status, removed.message).toBe("deleted");
    expect(existsSync(source)).toBe(true);
    expect(existsSync(join(source, ".git", "objects"))).toBe(true);
    expect(runGitOrThrow(source, "rev-parse", `refs/heads/${derivedBranch}`)).toBe(derivedCommit);
    expect(readFileSync(join(source, "README.md"), "utf8")).toBe(
      "unfinished tracked source work\n",
    );
    expect(runGitOrThrow(source, "config", "user.preservation")).toBe("keep this config");
  });
});

it("keeps an absent neighboring worktree registered when removing its own worktree", async () => {
  const fixture = await createManaged();
  const neighbor = join(fixture.storageDir, "neighboring-user-worktree");
  const branch = `neighbor-${createId()}`;
  runGitOrThrow(fixture.common, "worktree", "add", "-b", branch, neighbor, "main");
  const canonicalNeighbor = realpathSync(neighbor);
  const commit = runGitOrThrow(neighbor, "rev-parse", "HEAD");
  rmSync(neighbor, { recursive: true });
  expect(runGitOrThrow(fixture.common, "worktree", "list", "--porcelain")).toContain(
    `worktree ${canonicalNeighbor}`,
  );

  const report = await fixture.manager.dispose({
    _tag: "workspaceDispose",
    workspaceId: fixture.frame.workspaceId,
  });

  expect(report.status, report.message).toBe("deleted");
  expect(runGitOrThrow(fixture.common, "worktree", "list", "--porcelain")).toContain(
    `worktree ${canonicalNeighbor}`,
  );
  expect(runGitOrThrow(fixture.common, "rev-parse", `refs/heads/${branch}`)).toBe(commit);
});

it("explicitly discards a generated managed main while preserving shared storage and another worktree", async () => {
  const fixture = await createManaged();
  const resourceId = fixture.frame.checkouts[0]!.resourceId;
  const main = buildProvisionFrame({
    kind: "primary",
    checkouts: [buildCheckout({ resourceId, remote: fixture.remote.url })],
  });
  expect((await fixture.manager.provision(main)).status).toBe("ready");
  const root = fixture.manager.resolve(main.workspaceId)!.root;
  writeFileSync(join(root, "README.md"), "main changes explicitly discarded\n");

  const report = await fixture.manager.dispose({
    _tag: "workspaceDispose",
    workspaceId: main.workspaceId,
    discardChanges: true,
  });

  expect(report.status, report.message).toBe("deleted");
  expect(existsSync(root)).toBe(false);
  expect(existsSync(fixture.common)).toBe(true);
  expect(fixture.manager.resolve(fixture.frame.workspaceId)?.cwd).toBe(fixture.cwd);
  expect((await fixture.manager.inspect(fixture.frame.workspaceId)).status).toBe("ready");
});

it("persists successful removal before acknowledgement and never deletes a recreated path on replay", async () => {
  const fixture = await createManaged();
  const instruction = {
    _tag: "workspaceDispose",
    workspaceId: fixture.frame.workspaceId,
    requestId: "disposal-ack-loss",
    discardChanges: true,
  } as const;
  const removed = await fixture.manager.dispose(instruction);
  expect(removed).toMatchObject({ status: "deleted", requestId: instruction.requestId });
  const receipt = makeRegistry(fixture.storageDir).readRemoval(fixture.frame.workspaceId);
  expect(receipt).toMatchObject({ phase: "terminal", instruction, report: removed });
  mkdirSync(fixture.cwd);
  writeFileSync(join(fixture.cwd, "human.txt"), "new files after old removal\n");
  const before = hashContents(fixture.cwd);
  const restarted = makeWorkspaces({ storageDir: fixture.storageDir });

  const replayed = await restarted.dispose(instruction);

  expect(replayed).toMatchObject({ status: "failed", requestId: instruction.requestId });
  expect(replayed.message).toMatch(/reappear|new files|receipt|preserve/i);
  expect((await restarted.provision(fixture.frame)).status).toBe("failed");
  expect(hashContents(fixture.cwd)).toBe(before);
});

it("refuses a different removal intent while the original persisted request is pending", async () => {
  const fixture = await createManaged();
  const registry = makeRegistry(fixture.storageDir);
  const workspace = registry.held(fixture.frame.workspaceId)!;
  const instruction = {
    _tag: "workspaceDispose",
    workspaceId: fixture.frame.workspaceId,
    requestId: "original-pending-disposal",
  } as const;
  await registry.recordRemoval({
    workspaceId: fixture.frame.workspaceId,
    phase: "pending",
    instruction,
    workspace,
  });
  const before = hashContents(fixture.storageDir);
  const restarted = makeWorkspaces({ storageDir: fixture.storageDir });
  expect(restarted.resolve(fixture.frame.workspaceId)).toBeUndefined();

  const conflict = await restarted.dispose({
    ...instruction,
    requestId: "conflicting-disposal",
    discardChanges: true,
  });

  expect(conflict).toMatchObject({ status: "failed", requestId: "conflicting-disposal" });
  expect(conflict.message).toMatch(/pending|original/i);
  expect(hashContents(fixture.storageDir)).toBe(before);
  expect((await restarted.provision(fixture.frame)).status).toBe("failed");
  expect((await restarted.dispose(instruction)).status).toBe("deleted");
});

it("preflights a redirected step-results parent before removing any managed checkout", async () => {
  const fixture = await createManaged();
  const external = createTemporaryDir("hercule-step-results-human-files-");
  const results = join(external, fixture.frame.workspaceId);
  mkdirSync(results);
  writeFileSync(join(results, "human-work.txt"), "outside the runner's authority\n");
  symlinkSync(external, join(fixture.storageDir, "step-results"));
  const checkoutBefore = hashContents(fixture.cwd);
  const externalBefore = hashContents(external);

  const report = await fixture.manager.dispose({
    _tag: "workspaceDispose",
    workspaceId: fixture.frame.workspaceId,
  });

  expect(report.status).toBe("failed");
  expect(report.message).toMatch(/redirect|parent|managed|preserve/i);
  expect(hashContents(external)).toBe(externalBefore);
  expect(hashContents(fixture.cwd)).toBe(checkoutBefore);
  expect(fixture.manager.resolve(fixture.frame.workspaceId)?.cwd).toBe(fixture.cwd);
});

it("reserves an active removal before late provisioning of the same new workspace can create files", async () => {
  const remote = makeRemote();
  const storageDir = createTemporaryDir("hercule-cold-removal-provision-race-");
  const manager = makeWorkspaces({ storageDir });
  const frame = buildProvisionFrame({
    kind: "ephemeral",
    checkouts: [
      buildCheckout({ resourceId: createId(), remote: remote.url, branch: `late-${createId()}` }),
    ],
  });

  const [removed, provisioned] = await Promise.all([
    manager.dispose({
      _tag: "workspaceDispose",
      workspaceId: frame.workspaceId,
      requestId: "cold-removal-first",
    }),
    manager.provision(frame),
  ]);

  expect(removed).toMatchObject({ status: "deleted", requestId: "cold-removal-first" });
  expect(provisioned.status).toBe("failed");
  expect(provisioned.message).toMatch(/remov|progress|fresh/i);
  expect(existsSync(join(storageDir, "workspaces", frame.workspaceId))).toBe(false);
  expect(existsSync(join(storageDir, "cache"))).toBe(false);
  expect(manager.resolve(frame.workspaceId)).toBeUndefined();
});

it("refuses buffered session resolution immediately when removal is requested before its checkpoint", async () => {
  const fixture = await createManaged();

  const pending = fixture.manager.dispose({
    _tag: "workspaceDispose",
    workspaceId: fixture.frame.workspaceId,
    requestId: "resolve-after-removal",
  });

  expect(fixture.manager.resolve(fixture.frame.workspaceId)).toBeUndefined();
  expect((await pending).status).toBe("deleted");
});

it("preserves a legacy standalone main because its source Git repository is inside the recorded root", async () => {
  const remote = makeRemote();
  const storageDir = createTemporaryDir("hercule-legacy-main-discard-");
  const root = join(storageDir, "legacy standalone main");
  runGitOrThrow(storageDir, "clone", remote.url, root);
  writeFileSync(join(root, "README.md"), "unfinished legacy main work\n");
  const workspaceId = createId();
  writeFileSync(
    join(storageDir, "workspaces.json"),
    JSON.stringify([
      {
        workspaceId,
        kind: "primary",
        root,
        checkouts: [
          { checkoutId: createId(), resourceId: createId(), remote: remote.url, path: root },
        ],
      },
    ]),
  );
  const before = hashContents(root);
  const manager = makeWorkspaces({ storageDir });

  const refused = await manager.dispose({
    _tag: "workspaceDispose",
    workspaceId,
    requestId: "legacy-main-refusal",
    discardChanges: true,
  });

  expect(refused.status).toBe("failed");
  expect(refused.message).toMatch(/source Git repository|standalone|preserve/i);
  expect(hashContents(root)).toBe(before);
  expect(manager.resolve(workspaceId)?.cwd).toBe(root);
});

it("reattaches the same reserved source under a new logical workspace without changing Git or setup", async () => {
  const remote = makeRemote();
  const world = createTemporaryDir("hercule-detached-source-reattach-");
  const source = join(world, "user source");
  runGitOrThrow(world, "clone", remote.url, source);
  const storageDir = createTemporaryDir("hercule-reattach-home-");
  const manager = makeWorkspaces({ storageDir });
  const primary = {
    ...buildProvisionFrame({
      kind: "primary",
      checkouts: [buildCheckout({ resourceId: createId(), remote: remote.url })],
    }),
    attachment: { path: source, remoteName: "origin" },
  };
  expect((await manager.provision(primary)).status).toBe("ready");
  expect(
    (
      await manager.detach({
        _tag: "workspaceDetach",
        workspaceId: primary.workspaceId,
        requestId: "detach-before-reattach",
      })
    ).status,
  ).toBe("deleted");
  const before = hashContents(source);
  const replacement = {
    ...primary,
    workspaceId: createId(),
    checkouts: primary.checkouts.map((checkout) => ({ ...checkout, checkoutId: createId() })),
  };

  const report = await manager.provision(replacement);

  expect(report.status, report.message).toBe("ready");
  expect(manager.resolve(primary.workspaceId)).toBeUndefined();
  expect(manager.resolve(replacement.workspaceId)?.cwd).toBe(realpathSync(source));
  expect(hashContents(source)).toBe(before);
});

it("keeps an explicit request identifier bound to its original non-forced refusal", async () => {
  const fixture = await createManaged();
  writeFileSync(join(fixture.cwd, "README.md"), "remaining changes\n");
  const original = {
    _tag: "workspaceDispose",
    workspaceId: fixture.frame.workspaceId,
    requestId: "fixed-refusal-intent",
  } as const;
  const refused = await fixture.manager.dispose(original);
  expect(refused.status).toBe("failed");
  const before = hashContents(fixture.cwd);

  const changed = await fixture.manager.dispose({ ...original, discardChanges: true });

  expect(changed.status).toBe("failed");
  expect(changed.message).toMatch(/request ID|frozen|different.*instruction/i);
  expect(hashContents(fixture.cwd)).toBe(before);
  expect(
    (
      await fixture.manager.dispose({
        ...original,
        requestId: "fresh-explicit-discard",
        discardChanges: true,
      })
    ).status,
  ).toBe("deleted");
});
