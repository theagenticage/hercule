import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { ProvisionCheckout, StartingRevision, WorkspaceReport } from "@hercule/protocol";
import { makeWorkspaces } from "./index";
import {
  addBranch,
  buildCheckout,
  buildProvisionFrame,
  cleanTemporaries,
  createId,
  createTemporaryDir,
  makeRemote,
  runGitOrThrow,
} from "./testing";

afterAll(cleanTemporaries);

type ReportedCheckout = NonNullable<WorkspaceReport["checkouts"]>[number];
const checkoutReport = (report: WorkspaceReport): ReportedCheckout => {
  expect(report.status, report.message).toBe("ready");
  expect(report.checkouts).toHaveLength(1);
  return report.checkouts![0]!;
};
const commonDirectory = (path: string): string =>
  realpathSync(runGitOrThrow(path, "rev-parse", "--path-format=absolute", "--git-common-dir"));
const revisionCheckout = (
  resourceId: string,
  remote: string,
  startingRevision?: StartingRevision,
  repositoryWorkspaceId?: string,
): ProvisionCheckout => ({
  ...buildCheckout({ resourceId, remote, branch: `test/work-${createId()}` }),
  ...(startingRevision === undefined ? {} : { startingRevision }),
  ...(repositoryWorkspaceId === undefined ? {} : { repositoryWorkspaceId }),
});
const createExisting = async () => {
  const remote = makeRemote();
  const world = createTemporaryDir("hercule-revision-source-");
  const source = join(world, "selected checkout");
  runGitOrThrow(world, "clone", remote.url, source);
  runGitOrThrow(source, "checkout", "-b", "local-work");
  writeFileSync(join(source, "local.txt"), "unpushed local state\n");
  runGitOrThrow(source, "add", ".");
  runGitOrThrow(source, "commit", "-m", "Unpushed local work");
  const localCommit = runGitOrThrow(source, "rev-parse", "HEAD");
  const resourceId = createId();
  const remoteUrl = `https://fixture.invalid/acme/${resourceId}`;
  runGitOrThrow(source, "remote", "set-url", "origin", remoteUrl);
  const storageDir = createTemporaryDir("hercule-revision-home-");
  const trace = join(storageDir, "git-trace");
  const gitEnv = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
    GIT_CONFIG_VALUE_0: remoteUrl,
    GIT_TRACE: trace,
  };
  const manager = makeWorkspaces({ storageDir, gitEnv });
  const attachment = {
    ...buildProvisionFrame({
      kind: "primary",
      checkouts: [buildCheckout({ resourceId, remote: remoteUrl })],
    }),
    attachment: { path: source, remoteName: "origin" },
  };
  expect((await manager.provision(attachment)).status).toBe("ready");
  return {
    remote,
    source,
    world,
    resourceId,
    remoteUrl,
    storageDir,
    trace,
    gitEnv,
    manager,
    attachment,
    localCommit,
  };
};
const quoteShell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const waitForMarker = async (
  marker: string,
  completed?: () => WorkspaceReport | undefined,
): Promise<void> => {
  const until = Date.now() + 5_000;
  while (!existsSync(marker)) {
    const report = completed?.();
    if (report !== undefined)
      throw new Error(
        report.message ?? "Provisioning completed without reaching the real Git barrier",
      );
    if (Date.now() > until) throw new Error(`Git did not reach barrier ${marker}`);
    await Bun.sleep(10);
  }
};

describe("worktrees in the selected repository", () => {
  it("creates managed work without a main working copy, then adds main to the same repository", async () => {
    const remote = makeRemote();
    const storageDir = createTemporaryDir("hercule-workflow-first-home-");
    const resourceId = createId();
    const manager = makeWorkspaces({ storageDir });
    const first = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [revisionCheckout(resourceId, remote.url)],
    });
    expect((await manager.provision(first)).status).toBe("ready");
    expect(existsSync(join(storageDir, "primaries"))).toBe(false);
    const workPath = manager.resolve(first.workspaceId)!.cwd;
    const primary = buildProvisionFrame({
      kind: "primary",
      checkouts: [buildCheckout({ resourceId, remote: remote.url })],
    });

    const mainReport = await manager.provision(primary);
    expect(checkoutReport(mainReport).baseCommit).toBe(
      runGitOrThrow(remote.work, "rev-parse", "HEAD"),
    );

    const mainPath = manager.resolve(primary.workspaceId)!.cwd;
    expect(commonDirectory(mainPath)).toBe(commonDirectory(workPath));
    expect(runGitOrThrow(mainPath, "branch", "--show-current")).not.toBe("main");
    expect(runGitOrThrow(mainPath, "branch", "--show-current")).not.toBe(
      runGitOrThrow(workPath, "branch", "--show-current"),
    );
    const registrations = runGitOrThrow(workPath, "worktree", "list", "--porcelain");
    expect(registrations).toContain(`worktree ${realpathSync(mainPath)}`);
    expect(registrations).toContain(`worktree ${realpathSync(workPath)}`);
    expect(runGitOrThrow(mainPath, "rev-parse", "--is-bare-repository")).toBe("false");
  });

  it.each([
    { kind: "current" },
    { kind: "local", branch: "local-work" },
  ] satisfies ReadonlyArray<StartingRevision>)(
    "starts from exact unpushed local commit for %j without fetching or copying dirty files",
    async (startingRevision) => {
      const fixture = await createExisting();
      writeFileSync(join(fixture.source, "README.md"), "dirty tracked only in source\n");
      writeFileSync(join(fixture.source, "untracked.txt"), "private source work\n");
      renameSync(fixture.remote.path, `${fixture.remote.path}.unavailable`);
      writeFileSync(fixture.trace, "");
      const frame = buildProvisionFrame({
        kind: "ephemeral",
        checkouts: [
          revisionCheckout(
            fixture.resourceId,
            fixture.remoteUrl,
            startingRevision,
            fixture.attachment.workspaceId,
          ),
        ],
      });

      const report = await fixture.manager.provision(frame);

      expect(checkoutReport(report)).toMatchObject({
        baseCommit: fixture.localCommit,
        headCommit: fixture.localCommit,
        startingRevision,
      });
      const cwd = fixture.manager.resolve(frame.workspaceId)!.cwd;
      expect(commonDirectory(cwd)).toBe(commonDirectory(fixture.source));
      expect(runGitOrThrow(cwd, "rev-parse", "HEAD")).toBe(fixture.localCommit);
      expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("the repository\n");
      expect(existsSync(join(cwd, "untracked.txt"))).toBe(false);
      expect(readFileSync(join(fixture.source, "README.md"), "utf8")).toBe(
        "dirty tracked only in source\n",
      );
      expect(readFileSync(join(fixture.source, "untracked.txt"), "utf8")).toBe(
        "private source work\n",
      );
      expect(runGitOrThrow(cwd, "branch", "--show-current")).not.toBe("local-work");
      expect(readFileSync(fixture.trace, "utf8")).not.toMatch(/built-in: git (?:fetch|clone)/);
    },
  );

  it("uses a legacy standalone main repository's unpushed local revision without converting or fetching it", async () => {
    const remote = makeRemote();
    const storageDir = createTemporaryDir("hercule-legacy-revision-home-");
    const source = join(storageDir, "old standalone main");
    runGitOrThrow(storageDir, "clone", remote.url, source);
    runGitOrThrow(source, "checkout", "-b", "legacy-local");
    writeFileSync(join(source, "legacy.txt"), "unpublished legacy commit\n");
    runGitOrThrow(source, "add", ".");
    runGitOrThrow(source, "commit", "-m", "Legacy local work");
    const localCommit = runGitOrThrow(source, "rev-parse", "HEAD");
    writeFileSync(join(source, "README.md"), "unfinished legacy work\n");
    const resourceId = createId();
    const primaryId = createId();
    writeFileSync(
      join(storageDir, "workspaces.json"),
      JSON.stringify([
        {
          workspaceId: primaryId,
          kind: "primary",
          root: source,
          checkouts: [{ checkoutId: createId(), resourceId, remote: remote.url, path: source }],
        },
      ]),
    );
    const trace = join(storageDir, "git-trace");
    const manager = makeWorkspaces({ storageDir, gitEnv: { GIT_TRACE: trace } });
    renameSync(remote.path, `${remote.path}.unavailable`);
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        revisionCheckout(resourceId, remote.url, { kind: "local", branch: "legacy-local" }),
      ],
    });

    const report = await manager.provision(frame);

    expect(checkoutReport(report)).toMatchObject({
      baseCommit: localCommit,
      headCommit: localCommit,
    });
    expect(commonDirectory(manager.resolve(frame.workspaceId)!.cwd)).toBe(commonDirectory(source));
    expect(existsSync(join(source, ".git", "objects"))).toBe(true);
    expect(readFileSync(join(source, "README.md"), "utf8")).toBe("unfinished legacy work\n");
    expect(readFileSync(trace, "utf8")).not.toMatch(/built-in: git (?:fetch|clone)/);
  });

  it("uses the selected checkout's current commit when an existing-mode starting revision is omitted", async () => {
    const fixture = await createExisting();
    renameSync(fixture.remote.path, `${fixture.remote.path}.unavailable`);
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        revisionCheckout(
          fixture.resourceId,
          fixture.remoteUrl,
          undefined,
          fixture.attachment.workspaceId,
        ),
      ],
    });
    const report = await fixture.manager.provision(frame);
    expect(checkoutReport(report).baseCommit).toBe(fixture.localCommit);
    expect(
      runGitOrThrow(fixture.manager.resolve(frame.workspaceId)!.cwd, "rev-parse", "HEAD"),
    ).toBe(fixture.localCommit);
  });

  it("keeps the resolved base on duplicate delivery after the source branch advances", async () => {
    const fixture = await createExisting();
    const startingRevision: StartingRevision = { kind: "local", branch: "local-work" };
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        revisionCheckout(
          fixture.resourceId,
          fixture.remoteUrl,
          startingRevision,
          fixture.attachment.workspaceId,
        ),
      ],
    });
    const first = await fixture.manager.provision(frame);
    expect(checkoutReport(first).baseCommit).toBe(fixture.localCommit);
    writeFileSync(join(fixture.source, "next.txt"), "new local commit\n");
    runGitOrThrow(fixture.source, "add", ".");
    runGitOrThrow(fixture.source, "commit", "-m", "Advance source");
    const restarted = makeWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });
    const replay = await restarted.provision(frame);
    expect(replay).toEqual(first);
    expect(runGitOrThrow(restarted.resolve(frame.workspaceId)!.cwd, "rev-parse", "HEAD")).toBe(
      fixture.localCommit,
    );
  });

  it("resolves remote and local names separately and fetches the actual remote commit", async () => {
    const fixture = await createExisting();
    const remoteCommit = addBranch(fixture.remote, "local-work", "different remote state\n");
    const startingRevision: StartingRevision = { kind: "remote", branch: "local-work" };
    writeFileSync(fixture.trace, "");
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        revisionCheckout(
          fixture.resourceId,
          fixture.remoteUrl,
          startingRevision,
          fixture.attachment.workspaceId,
        ),
      ],
    });
    const report = await fixture.manager.provision(frame);
    expect(checkoutReport(report)).toMatchObject({
      baseCommit: remoteCommit,
      headCommit: remoteCommit,
      startingRevision,
    });
    expect(remoteCommit).not.toBe(fixture.localCommit);
    expect(
      runGitOrThrow(fixture.manager.resolve(frame.workspaceId)!.cwd, "rev-parse", "HEAD"),
    ).toBe(remoteCommit);
    expect(readFileSync(fixture.trace, "utf8")).toMatch(/built-in: git fetch/);
    expect(runGitOrThrow(fixture.source, "rev-parse", "refs/heads/local-work")).toBe(
      fixture.localCommit,
    );
  });

  it.each(["fetch unavailable", "remote branch absent"])(
    "refuses %s without falling back to an identically named local branch",
    async (failure) => {
      const fixture = await createExisting();
      if (failure === "fetch unavailable")
        renameSync(fixture.remote.path, `${fixture.remote.path}.unavailable`);
      const frame = buildProvisionFrame({
        kind: "ephemeral",
        checkouts: [
          revisionCheckout(
            fixture.resourceId,
            fixture.remoteUrl,
            { kind: "remote", branch: "local-work" },
            fixture.attachment.workspaceId,
          ),
        ],
      });
      const report = await fixture.manager.provision(frame);
      expect(report.status).toBe("failed");
      expect(report.message).toMatch(/fetch|remote|branch|revision/i);
      expect(fixture.manager.resolve(frame.workspaceId)).toBeUndefined();
      expect(runGitOrThrow(fixture.source, "rev-parse", "HEAD")).toBe(fixture.localCommit);
    },
  );

  it("refreshes a changed remote default rather than retaining origin/HEAD from an earlier fetch", async () => {
    const remote = makeRemote();
    const resourceId = createId();
    const manager = makeWorkspaces({
      storageDir: createTemporaryDir("hercule-remote-default-home-"),
    });
    const first = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [revisionCheckout(resourceId, remote.url, { kind: "remote" })],
    });
    expect((await manager.provision(first)).status).toBe("ready");
    const newDefault = addBranch(remote, "next-default");
    runGitOrThrow(remote.path, "symbolic-ref", "HEAD", "refs/heads/next-default");
    const second = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [revisionCheckout(resourceId, remote.url, { kind: "remote" })],
    });
    const report = await manager.provision(second);
    expect(checkoutReport(report)).toMatchObject({
      baseCommit: newDefault,
      defaultBranch: "next-default",
    });
    expect(runGitOrThrow(manager.resolve(second.workspaceId)!.cwd, "rev-parse", "HEAD")).toBe(
      newDefault,
    );
  });

  it("observes external branch renames and HEAD changes after turns in primary and ephemeral workspaces", async () => {
    const fixture = await createExisting();
    const generated = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        revisionCheckout(
          fixture.resourceId,
          fixture.remoteUrl,
          { kind: "current" },
          fixture.attachment.workspaceId,
        ),
      ],
    });
    expect((await fixture.manager.provision(generated)).status).toBe("ready");
    for (const id of [fixture.attachment.workspaceId, generated.workspaceId]) {
      const cwd = fixture.manager.resolve(id)!.cwd;
      const renamed = `external-${createId()}`;
      runGitOrThrow(cwd, "branch", "-m", renamed);
      writeFileSync(join(cwd, "external.txt"), "committed outside the runner\n");
      runGitOrThrow(cwd, "add", "external.txt");
      runGitOrThrow(cwd, "commit", "-m", "External commit");
      const headCommit = runGitOrThrow(cwd, "rev-parse", "HEAD");
      const observation = await fixture.manager.reportAfterSession(id);
      expect(observation).toBeDefined();
      expect(checkoutReport(observation!)).toMatchObject({ branch: renamed, headCommit });
      expect(checkoutReport(observation!).branches).toContain(renamed);
      expect(fixture.manager.resolve(id)?.cwd).toBe(cwd);
    }
  });

  it("explicitly inspects every workspace kind without fetching, setup or rewriting files", async () => {
    const fixture = await createExisting();
    const generated = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        revisionCheckout(
          fixture.resourceId,
          fixture.remoteUrl,
          { kind: "current" },
          fixture.attachment.workspaceId,
        ),
      ],
    });
    expect((await fixture.manager.provision(generated)).status).toBe("ready");
    renameSync(fixture.remote.path, `${fixture.remote.path}.unavailable`);
    writeFileSync(fixture.trace, "");
    for (const id of [fixture.attachment.workspaceId, generated.workspaceId]) {
      const cwd = fixture.manager.resolve(id)!.cwd;
      const renamed = `inspection-${createId()}`;
      runGitOrThrow(cwd, "branch", "-m", renamed);
      const headCommit = runGitOrThrow(cwd, "rev-parse", "HEAD");
      const report = await fixture.manager.inspect(id);
      expect(checkoutReport(report)).toMatchObject({ branch: renamed, headCommit });
      expect(checkoutReport(report).branches).toContain(renamed);
    }
    expect(readFileSync(fixture.trace, "utf8")).not.toMatch(
      /built-in: git (?:fetch|clone|checkout|switch|reset)/,
    );
  });

  it("keeps missing-source include warnings visible when the worktree succeeds", async () => {
    const remote = makeRemote();
    const manager = makeWorkspaces({
      storageDir: createTemporaryDir("hercule-include-warning-home-"),
    });
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [{ ...revisionCheckout(createId(), remote.url), workspaceInclude: true }],
    });
    const report = await manager.provision(frame);
    expect(report.status, report.message).toBe("ready");
    expect(report.warnings?.join(" ")).toMatch(
      /(?:main|primary|source).*(?:missing|absent|unavailable|not.*(?:found|exist))/i,
    );
    expect(await manager.provision(frame)).toEqual(report);
  });
});

describe("repository coordination", () => {
  it.each([0, 1, 2])(
    "bootstraps an absent repository exactly once for concurrent workspaces, trial %s",
    async () => {
      const remote = makeRemote();
      const storageDir = createTemporaryDir("hercule-concurrent-first-home-");
      const bin = join(storageDir, "bin");
      mkdirSync(bin);
      const entered = join(storageDir, "bootstrap-entered");
      const release = join(storageDir, "release-bootstrap");
      const log = join(storageDir, "clone-calls");
      const git = Bun.which("git")!;
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\ncase " $* " in\n*' clone '*)\nprintf 'clone\\n' >> ${quoteShell(log)}\nprintf '%s\\n' "$$" > ${quoteShell(entered)}\nwhile [ ! -f ${quoteShell(release)} ]; do sleep 0.01; done\n;;\nesac\nexec ${quoteShell(git)} "$@"\n`,
        { mode: 0o700 },
      );
      const manager = makeWorkspaces({
        storageDir,
        gitEnv: { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
      });
      const resourceId = createId();
      const first = buildProvisionFrame({
        kind: "ephemeral",
        checkouts: [revisionCheckout(resourceId, remote.url)],
      });
      const second = buildProvisionFrame({
        kind: "ephemeral",
        checkouts: [revisionCheckout(resourceId, remote.url)],
      });
      const pendingFirst = manager.provision(first);
      let pendingSecond: Promise<WorkspaceReport> | undefined;
      let pendingDuplicate: Promise<WorkspaceReport> | undefined;
      try {
        await waitForMarker(entered);
        pendingSecond = manager.provision(second);
        pendingDuplicate = manager.provision(first);
      } finally {
        writeFileSync(release, "release\n");
      }
      const reports = await Promise.all([pendingFirst, pendingSecond, pendingDuplicate]);
      expect(reports.map((report) => report.status)).toEqual(["ready", "ready", "ready"]);
      expect(reports[2]).toEqual(reports[0]);
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
      const firstPath = manager.resolve(first.workspaceId)!.cwd;
      const secondPath = manager.resolve(second.workspaceId)!.cwd;
      expect(commonDirectory(firstPath)).toBe(commonDirectory(secondPath));
      expect(
        runGitOrThrow(firstPath, "worktree", "list", "--porcelain").match(/^worktree /gm),
      ).toHaveLength(3);
    },
  );

  it("coordinates linked and symlinked aliases of one common directory while an independent repository completes", async () => {
    const first = await createExisting();
    const independent = makeRemote();
    const linked = join(first.world, "linked source");
    runGitOrThrow(first.source, "worktree", "add", "-b", "alias-source", linked, "HEAD");
    const alias = join(first.world, "linked alias");
    symlinkSync(linked, alias);
    const aliasResource = createId();
    const aliasAttachment = {
      ...buildProvisionFrame({
        kind: "primary",
        checkouts: [buildCheckout({ resourceId: aliasResource, remote: first.remoteUrl })],
      }),
      attachment: { path: alias, remoteName: "origin" },
    };
    expect((await first.manager.provision(aliasAttachment)).status).toBe("ready");
    const bin = join(first.storageDir, "bin");
    mkdirSync(bin);
    const entered = join(first.storageDir, "worktree-entered");
    const release = join(first.storageDir, "release-worktree");
    const calls = join(first.storageDir, "worktree-calls");
    const git = Bun.which("git")!;
    const shared = commonDirectory(first.source);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/bash\nprefix=()\nfor arg in "$@"; do\n  if [ "$arg" = worktree ]; then break; fi\n  prefix+=("$arg")\ndone\ncase " $* " in\n*' worktree add '*)\ncommon=$(${quoteShell(git)} "\${prefix[@]}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)\ncommon=$(cd "$common" 2>/dev/null && pwd -P)\nif [ "$common" = ${quoteShell(shared)} ]; then\nprintf 'shared\\n' >> ${quoteShell(calls)}\nif [ ! -f ${quoteShell(entered)} ]; then\nprintf '%s\\n' "$$" > ${quoteShell(entered)}\nwhile [ ! -f ${quoteShell(release)} ]; do sleep 0.01; done\nfi\nfi\n;;\nesac\nexec ${quoteShell(git)} "$@"\n`,
      { mode: 0o700 },
    );
    const manager = makeWorkspaces({
      storageDir: first.storageDir,
      gitEnv: { ...first.gitEnv, PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
    });
    const a = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        revisionCheckout(
          first.resourceId,
          first.remoteUrl,
          { kind: "current" },
          first.attachment.workspaceId,
        ),
      ],
    });
    const aliasA = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        revisionCheckout(
          aliasResource,
          first.remoteUrl,
          { kind: "current" },
          aliasAttachment.workspaceId,
        ),
      ],
    });
    const b = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [revisionCheckout(createId(), independent.url)],
    });
    const pendingA = manager.provision(a);
    let completedA: WorkspaceReport | undefined;
    void pendingA.then((report) => {
      completedA = report;
    });
    let pendingAlias: Promise<WorkspaceReport> | undefined;
    try {
      await waitForMarker(entered, () => completedA);
      pendingAlias = manager.provision(aliasA);
      const reportB = await manager.provision(b);
      expect(reportB.status, reportB.message).toBe("ready");
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      writeFileSync(release, "release\n");
      await Promise.allSettled([pendingA, ...(pendingAlias === undefined ? [] : [pendingAlias])]);
    }
    expect((await pendingA).status).toBe("ready");
    expect((await pendingAlias).status).toBe("ready");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
    expect(commonDirectory(manager.resolve(a.workspaceId)!.cwd)).toBe(
      commonDirectory(manager.resolve(aliasA.workspaceId)!.cwd),
    );
  }, 15_000);
});

describe("revision and coordination recovery boundaries", () => {
  it.each([
    { kind: "current" },
    { kind: "local", branch: "main" },
  ] satisfies ReadonlyArray<StartingRevision>)(
    "rejects cold managed %j before cloning, fetching or initializing a cache",
    async (startingRevision) => {
      const remote = makeRemote();
      const storageDir = createTemporaryDir("hercule-cold-local-home-");
      const trace = join(storageDir, "git-trace");
      const manager = makeWorkspaces({ storageDir, gitEnv: { GIT_TRACE: trace } });
      const resourceId = createId();
      const frame = buildProvisionFrame({
        kind: "ephemeral",
        checkouts: [revisionCheckout(resourceId, remote.url, startingRevision)],
      });
      const report = await manager.provision(frame);
      expect(report.status).toBe("failed");
      expect(report.message).toMatch(/local.*repository|remote.*establish/i);
      expect(existsSync(join(storageDir, "cache", `${resourceId}.git`))).toBe(false);
      expect(existsSync(join(storageDir, "workspaces", frame.workspaceId))).toBe(false);
      expect(manager.resolve(frame.workspaceId)).toBeUndefined();
      expect(readFileSync(trace, "utf8")).not.toMatch(/built-in: git (?:clone|fetch|init)/);
      const restarted = makeWorkspaces({ storageDir, gitEnv: { GIT_TRACE: trace } });
      expect(await restarted.provision(frame)).toEqual(report);
    },
  );

  it("preserves a human file at the workspace root when a later repository cannot be created", async () => {
    const first = makeRemote();
    const second = makeRemote();
    renameSync(second.path, `${second.path}.unavailable`);
    const storageDir = createTemporaryDir("hercule-partial-root-home-");
    const bin = join(storageDir, "bin");
    mkdirSync(bin);
    const entered = join(storageDir, "second-clone-entered");
    const release = join(storageDir, "release-second-clone");
    const git = Bun.which("git")!;
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in\n*' clone '*${quoteShell(second.url)}*)\nprintf '%s\\n' "$$" > ${quoteShell(entered)}\nwhile [ ! -f ${quoteShell(release)} ]; do sleep 0.01; done\n;;\nesac\nexec ${quoteShell(git)} "$@"\n`,
      { mode: 0o700 },
    );
    const manager = makeWorkspaces({
      storageDir,
      gitEnv: { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
    });
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        { ...revisionCheckout(createId(), first.url), subdirectory: "first" },
        { ...revisionCheckout(createId(), second.url), subdirectory: "second" },
      ],
    });
    const root = join(storageDir, "workspaces", frame.workspaceId);
    const humanFile = join(root, "human-notes.txt");
    const pending = manager.provision(frame);
    let completed: WorkspaceReport | undefined;
    void pending.then((report) => {
      completed = report;
    });
    try {
      await waitForMarker(entered, () => completed);
      expect(existsSync(join(root, "first", ".git"))).toBe(true);
      writeFileSync(humanFile, "unfinished human notes\n");
    } finally {
      writeFileSync(release, "release\n");
      await pending;
    }
    const report = await pending;
    expect(report.status).toBe("failed");
    expect(readFileSync(humanFile, "utf8")).toBe("unfinished human notes\n");
    expect(report.message).toMatch(/retained|clean removal.*refused/i);
    expect(existsSync(join(root, "first"))).toBe(false);
    expect(manager.resolve(frame.workspaceId)).toBeUndefined();
    expect(await manager.provision(frame)).toEqual(report);
    expect(readFileSync(humanFile, "utf8")).toBe("unfinished human notes\n");
  });

  it("serializes actual index work through checkout aliases and linked common directories while another repository proceeds", async () => {
    const fixture = await createExisting();
    const sameCheckoutAlias = join(fixture.world, "same checkout alias");
    symlinkSync(fixture.source, sameCheckoutAlias);
    const linked = join(fixture.world, "linked checkout");
    runGitOrThrow(fixture.source, "worktree", "add", "-b", "linked-lock-source", linked, "HEAD");
    const aliases = [];
    for (const path of [sameCheckoutAlias, linked]) {
      const frame = {
        ...buildProvisionFrame({
          kind: "primary",
          checkouts: [buildCheckout({ resourceId: createId(), remote: fixture.remoteUrl })],
        }),
        attachment: { path, remoteName: "origin" },
      };
      expect((await fixture.manager.provision(frame)).status).toBe("ready");
      aliases.push(frame.workspaceId);
    }
    expect(commonDirectory(linked)).toBe(commonDirectory(fixture.source));
    const independentRemote = makeRemote();
    const independent = buildProvisionFrame({
      kind: "primary",
      checkouts: [buildCheckout({ resourceId: createId(), remote: independentRemote.url })],
    });
    expect((await fixture.manager.provision(independent)).status).toBe("ready");
    const independentRoot = fixture.manager.resolve(independent.workspaceId)!.cwd;
    const lockFile = join(fixture.source, ".git", "index.lock");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sharedEntries: string[] = [];
    const started = Effect.runPromise(
      fixture.manager.runExclusively(
        fixture.attachment.workspaceId,
        Effect.promise(async () => {
          writeFileSync(lockFile, "held by this test\n", { flag: "wx" });
          entered();
          try {
            await gate;
          } finally {
            rmSync(lockFile);
          }
          writeFileSync(join(fixture.source, "first-index.txt"), "first index write\n");
          runGitOrThrow(fixture.source, "add", "first-index.txt");
        }),
      ),
    );
    let queuedAliases: Promise<void>[] = [];
    try {
      await enteredGate;
      queuedAliases = aliases.map((workspaceId, index) =>
        Effect.runPromise(
          fixture.manager.runExclusively(
            workspaceId,
            Effect.sync(() => {
              const path = fixture.manager.resolve(workspaceId)!.cwd;
              sharedEntries.push(workspaceId);
              writeFileSync(join(path, `alias-index-${index}.txt`), "alias index write\n");
              runGitOrThrow(path, "add", `alias-index-${index}.txt`);
            }),
          ),
        ),
      );
      // Retain rejections until every captured operation has settled.
      for (const pending of queuedAliases) void pending.catch(() => undefined);
      await Effect.runPromise(
        fixture.manager.runExclusively(
          independent.workspaceId,
          Effect.sync(() => {
            writeFileSync(join(independentRoot, "independent-index.txt"), "independent work\n");
            runGitOrThrow(independentRoot, "add", "independent-index.txt");
          }),
        ),
      );
      expect(sharedEntries).toEqual([]);
      expect(runGitOrThrow(independentRoot, "diff", "--cached", "--name-only")).toBe(
        "independent-index.txt",
      );
    } finally {
      release();
      await Promise.allSettled([started, ...queuedAliases]);
    }
    await Promise.all([started, ...queuedAliases]);
    expect(sharedEntries).toEqual(aliases);
    expect(runGitOrThrow(fixture.source, "diff", "--cached", "--name-only")).toContain(
      "first-index.txt",
    );
    expect(runGitOrThrow(fixture.source, "diff", "--cached", "--name-only")).toContain(
      "alias-index-0.txt",
    );
    expect(runGitOrThrow(linked, "diff", "--cached", "--name-only")).toContain("alias-index-1.txt");
  });
});

describe(".workspaceinclude preserves tracked files", () => {
  it("skips an included symlink to dirty tracked source files", async () => {
    const { manager, source, resourceId, remoteUrl, attachment } = await createExisting();
    writeFileSync(join(source, "README.md"), "dirty tracked source\n");
    symlinkSync("README.md", join(source, "local-settings"));
    writeFileSync(join(source, ".workspaceinclude"), "local-settings\n");
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        {
          ...revisionCheckout(resourceId, remoteUrl, { kind: "current" }, attachment.workspaceId),
          workspaceInclude: true,
        },
      ],
    });
    const report = await manager.provision(frame);
    expect(report.status, report.message).toBe("ready");
    expect(report.warnings?.join(" ")).toContain("skipped tracked files");
    expect(existsSync(join(manager.resolve(frame.workspaceId)!.cwd, "local-settings"))).toBe(false);
    expect(readFileSync(join(source, "README.md"), "utf8")).toBe("dirty tracked source\n");
  });

  it.each([
    ["managed", "current"],
    ["managed", "local"],
    ["existing", "current"],
    ["existing", "local"],
  ] as const)(
    "copies only listed untracked files from %s main with a %s starting revision",
    async (mode, revisionKind) => {
      const attached = mode === "existing" ? await createExisting() : undefined;
      const remote = attached?.remote ?? makeRemote();
      const resourceId = attached?.resourceId ?? createId();
      const remoteUrl = attached?.remoteUrl ?? remote.url;
      const manager =
        attached?.manager ??
        makeWorkspaces({ storageDir: createTemporaryDir("hercule-include-home-") });
      const primary =
        attached?.attachment ??
        buildProvisionFrame({
          kind: "primary",
          checkouts: [buildCheckout({ resourceId, remote: remoteUrl })],
        });
      if (attached === undefined) expect((await manager.provision(primary)).status).toBe("ready");
      const source = manager.resolve(primary.workspaceId)!.cwd;
      const sourceBranch = `include-source-${createId()}`;
      runGitOrThrow(source, "checkout", "-b", sourceBranch);
      mkdirSync(join(source, "mixed"));
      writeFileSync(join(source, "mixed", "tracked.txt"), "committed nested file\n");
      writeFileSync(join(source, ".gitignore"), ".env\n");
      runGitOrThrow(source, "add", "mixed/tracked.txt", ".gitignore");
      runGitOrThrow(source, "commit", "-m", "Track files beside included local files");
      const baseCommit = runGitOrThrow(source, "rev-parse", "HEAD");
      const committedReadme = readFileSync(join(source, "README.md"), "utf8");
      writeFileSync(join(source, "README.md"), "dirty tracked readme stays in main\n");
      writeFileSync(join(source, "mixed", "tracked.txt"), "staged tracked changes stay in main\n");
      runGitOrThrow(source, "add", "mixed/tracked.txt");
      writeFileSync(
        join(source, "mixed", "tracked.txt"),
        "unstaged tracked changes stay in main\n",
      );
      writeFileSync(join(source, "mixed", "untracked.txt"), "explicit local file\n");
      writeFileSync(join(source, ".env"), "EXPLICIT_IGNORED=local\n");
      writeFileSync(join(source, "unlisted.txt"), "not included\n");
      writeFileSync(join(source, ".workspaceinclude"), "README.md\nmixed\n.env\n");
      const sourceStatus = runGitOrThrow(source, "status", "--porcelain=v1");
      const sourceIndex = runGitOrThrow(source, "write-tree");
      const sourceFiles = [
        "README.md",
        "mixed/tracked.txt",
        "mixed/untracked.txt",
        ".env",
        "unlisted.txt",
        ".workspaceinclude",
        ".gitignore",
      ];
      const sourceContents = sourceFiles.map((path) => readFileSync(join(source, path)));
      const startingRevision: StartingRevision =
        revisionKind === "current" ? { kind: "current" } : { kind: "local", branch: sourceBranch };
      const work = buildProvisionFrame({
        kind: "ephemeral",
        checkouts: [
          {
            ...revisionCheckout(resourceId, remoteUrl, startingRevision, primary.workspaceId),
            workspaceInclude: true,
          },
        ],
      });

      const report = checkoutReport(await manager.provision(work));
      const destination = manager.resolve(work.workspaceId)!.cwd;
      expect.soft(report.baseCommit).toBe(baseCommit);
      expect.soft(report.headCommit).toBe(baseCommit);
      expect.soft(readFileSync(join(destination, "README.md"), "utf8")).toBe(committedReadme);
      expect
        .soft(readFileSync(join(destination, "mixed", "tracked.txt"), "utf8"))
        .toBe("committed nested file\n");
      expect
        .soft(readFileSync(join(destination, "mixed", "untracked.txt"), "utf8"))
        .toBe("explicit local file\n");
      expect.soft(readFileSync(join(destination, ".env"), "utf8")).toBe("EXPLICIT_IGNORED=local\n");
      expect.soft(existsSync(join(destination, "unlisted.txt"))).toBe(false);
      expect
        .soft(readFileSync(join(source, "README.md"), "utf8"))
        .toBe("dirty tracked readme stays in main\n");
      expect
        .soft(readFileSync(join(source, "mixed", "tracked.txt"), "utf8"))
        .toBe("unstaged tracked changes stay in main\n");
      expect.soft(runGitOrThrow(source, "rev-parse", "HEAD")).toBe(baseCommit);
      expect.soft(runGitOrThrow(source, "write-tree")).toBe(sourceIndex);
      expect.soft(runGitOrThrow(source, "status", "--porcelain=v1")).toBe(sourceStatus);
      expect
        .soft(sourceFiles.map((path) => readFileSync(join(source, path))))
        .toEqual(sourceContents);
    },
  );
});
