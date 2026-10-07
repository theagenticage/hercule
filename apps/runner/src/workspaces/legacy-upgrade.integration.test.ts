import { makeTestWorkspaces } from "./testing";
import * as Effect from "effect/Effect";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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

const readCommonDirectory = (path: string): string =>
  realpathSync(runGitOrThrow(path, "rev-parse", "--path-format=absolute", "--git-common-dir"));

/** Creates the standalone main clone and separate cache worktree used before repository selection. */
const createLegacyInstallation = () => {
  const remote = makeRemote();
  const storageDir = createTemporaryDir("hercule-legacy-upgrade-home-");
  const resourceId = createId();
  const mainId = createId();
  const ephemeralId = createId();
  const mainCheckoutId = createId();
  const ephemeralCheckoutId = createId();
  const mainRoot = join(storageDir, "primaries", mainId);
  const ephemeralRoot = join(storageDir, "workspaces", ephemeralId);
  const cache = join(storageDir, "cache", `${resourceId}.git`);
  mkdirSync(join(storageDir, "primaries"));
  mkdirSync(join(storageDir, "workspaces"));
  mkdirSync(join(storageDir, "cache"));
  runGitOrThrow(storageDir, "clone", remote.url, mainRoot);
  runGitOrThrow(storageDir, "clone", "--bare", remote.url, cache);
  runGitOrThrow(mainRoot, "checkout", "-b", "unpublished-main");
  writeFileSync(join(mainRoot, "local.txt"), "unpublished main commit\n");
  writeFileSync(join(mainRoot, ".gitignore"), "private-cache/\n");
  runGitOrThrow(mainRoot, "add", ".");
  runGitOrThrow(mainRoot, "commit", "-m", "Unpublished main work");
  const mainHead = runGitOrThrow(mainRoot, "rev-parse", "HEAD");
  runGitOrThrow(cache, "worktree", "add", "-b", "old-cache-work", ephemeralRoot, "main");
  writeFileSync(join(ephemeralRoot, "cache-commit.txt"), "committed only in the old cache\n");
  runGitOrThrow(ephemeralRoot, "add", ".");
  runGitOrThrow(ephemeralRoot, "commit", "-m", "Historical cache work");
  const ephemeralHead = runGitOrThrow(ephemeralRoot, "rev-parse", "HEAD");
  writeFileSync(join(mainRoot, "README.md"), "dirty human main\n");
  writeFileSync(join(mainRoot, "staged.txt"), "staged human main\n");
  runGitOrThrow(mainRoot, "add", "staged.txt");
  writeFileSync(join(mainRoot, "untracked.txt"), "private untracked main\n");
  mkdirSync(join(mainRoot, "private-cache"));
  writeFileSync(join(mainRoot, "private-cache", "secret.txt"), "private ignored main\n");
  runGitOrThrow(mainRoot, "config", "upgrade.sentinel", "preserve-local-config");
  writeFileSync(join(mainRoot, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  writeFileSync(join(ephemeralRoot, "unfinished.txt"), "unfinished old cache work\n");
  const entries = [
    {
      workspaceId: mainId,
      kind: "primary",
      root: mainRoot,
      checkouts: [{ checkoutId: mainCheckoutId, resourceId, remote: remote.url, path: mainRoot }],
    },
    {
      workspaceId: ephemeralId,
      kind: "ephemeral",
      root: ephemeralRoot,
      checkouts: [
        { checkoutId: ephemeralCheckoutId, resourceId, remote: remote.url, path: ephemeralRoot },
      ],
    },
  ];
  writeFileSync(join(storageDir, "workspaces.json"), JSON.stringify(entries));
  return {
    remote,
    storageDir,
    resourceId,
    mainId,
    ephemeralId,
    mainCheckoutId,
    ephemeralCheckoutId,
    mainRoot,
    ephemeralRoot,
    cache,
    mainHead,
    ephemeralHead,
  };
};

describe("upgrading a legacy array registry", () => {
  it("preserves working files, HEADs, local Git configuration and clone form during inspect and completed replay", async () => {
    const fixture = createLegacyInstallation();
    const before = {
      main: hashContents(fixture.mainRoot),
      ephemeral: hashContents(fixture.ephemeralRoot),
      cache: hashContents(fixture.cache),
    };
    const manager = makeTestWorkspaces({ storageDir: fixture.storageDir });
    for (const [workspaceId, checkoutId, form, head, root] of [
      [fixture.mainId, fixture.mainCheckoutId, "clone", fixture.mainHead, fixture.mainRoot],
      [
        fixture.ephemeralId,
        fixture.ephemeralCheckoutId,
        "worktree",
        fixture.ephemeralHead,
        fixture.ephemeralRoot,
      ],
    ] as const) {
      const observed = await Effect.runPromise(manager.inspect(workspaceId));
      expect(observed.status, observed.message).toBe("ready");
      expect(observed.checkouts?.[0]).toMatchObject({ checkoutId, form, headCommit: head });
      expect(Effect.runSync(manager.resolve(workspaceId))?.cwd).toBe(root);
      const replay = await Effect.runPromise(
        manager.provision(
          buildProvisionFrame({
            workspaceId,
            kind: form === "clone" ? "primary" : "ephemeral",
            checkouts: [
              buildCheckout({
                checkoutId,
                resourceId: fixture.resourceId,
                remote: fixture.remote.url,
                setupCommand: "echo unsafe-repeat > setup-repeated; exit 1",
              }),
            ],
          }),
        ),
      );
      expect(replay.status, replay.message).toBe("ready");
      expect(existsSync(join(root, "setup-repeated"))).toBe(false);
      expect(runGitOrThrow(root, "rev-parse", "HEAD")).toBe(head);
    }
    expect(hashContents(fixture.mainRoot)).toBe(before.main);
    expect(hashContents(fixture.ephemeralRoot)).toBe(before.ephemeral);
    expect(hashContents(fixture.cache)).toBe(before.cache);
    expect(existsSync(join(fixture.mainRoot, ".git", "objects"))).toBe(true);
    expect(runGitOrThrow(fixture.mainRoot, "diff", "--cached", "--name-only")).toBe("staged.txt");
  });

  it("creates new local work in the standalone main while preserving the old ephemeral cache binding across restart and removal", async () => {
    const fixture = createLegacyInstallation();
    const trace = join(fixture.storageDir, "git-trace");
    const manager = makeTestWorkspaces({
      storageDir: fixture.storageDir,
      gitEnv: { GIT_TRACE: trace },
    });
    const fresh = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: fixture.resourceId,
          remote: fixture.remote.url,
          branch: "new-local-work",
          startingRevision: { kind: "local", branch: "unpublished-main" },
        }),
      ],
    });
    const report = await Effect.runPromise(manager.provision(fresh));
    expect(report.status, report.message).toBe("ready");
    expect(report.checkouts?.[0]?.baseCommit).toBe(fixture.mainHead);
    const freshRoot = Effect.runSync(manager.resolve(fresh.workspaceId))!.cwd;
    expect(readCommonDirectory(freshRoot)).toBe(readCommonDirectory(fixture.mainRoot));
    expect(readCommonDirectory(fixture.ephemeralRoot)).toBe(realpathSync(fixture.cache));
    expect(readFileSync(trace, "utf8")).not.toMatch(/built-in: git (?:fetch|clone)/);
    const mainAfterCreation = hashContents(fixture.mainRoot);
    const restarted = makeTestWorkspaces({ storageDir: fixture.storageDir });
    expect(Effect.runSync(restarted.resolve(fixture.ephemeralId))?.checkouts[0]?.checkoutId).toBe(
      fixture.ephemeralCheckoutId,
    );
    expect(runGitOrThrow(fixture.ephemeralRoot, "rev-parse", "HEAD")).toBe(fixture.ephemeralHead);
    const ordinary = await Effect.runPromise(
      restarted.dispose({
        _tag: "workspaceDispose",
        workspaceId: fixture.ephemeralId,
        requestId: createId(),
      }),
    );
    expect(ordinary.status).toBe("failed");
    expect(readFileSync(join(fixture.ephemeralRoot, "unfinished.txt"), "utf8")).toBe(
      "unfinished old cache work\n",
    );
    const removed = await Effect.runPromise(
      restarted.dispose({
        _tag: "workspaceDispose",
        workspaceId: fixture.ephemeralId,
        requestId: createId(),
        discardChanges: true,
      }),
    );
    expect(removed.status, removed.message).toBe("deleted");
    expect(existsSync(fixture.ephemeralRoot)).toBe(false);
    expect(runGitOrThrow(fixture.cache, "rev-parse", "old-cache-work")).toBe(fixture.ephemeralHead);
    expect(runGitOrThrow(freshRoot, "rev-parse", "HEAD")).toBe(fixture.mainHead);
    expect(hashContents(fixture.mainRoot)).toBe(mainAfterCreation);
    expect(
      Effect.runSync(
        makeTestWorkspaces({ storageDir: fixture.storageDir }).resolve(fresh.workspaceId),
      )?.cwd,
    ).toBe(freshRoot);
  });
});

it.each([
  { replayed: false, startingRevision: { kind: "current" as const } },
  { replayed: false, startingRevision: { kind: "local" as const, branch: "unpublished-main" } },
  { replayed: true, startingRevision: { kind: "current" as const } },
  { replayed: true, startingRevision: { kind: "local" as const, branch: "unpublished-main" } },
])(
  "honors an explicit legacy main binding from %j without remote access or conversion",
  async ({ replayed, startingRevision }) => {
    const fixture = createLegacyInstallation();
    const trace = join(fixture.storageDir, "bound-git-trace");
    const marker = join(fixture.mainRoot, "setup-repeated");
    const manager = makeTestWorkspaces({
      storageDir: fixture.storageDir,
      gitEnv: { GIT_TRACE: trace },
    });
    if (replayed) {
      const report = await Effect.runPromise(
        manager.provision(
          buildProvisionFrame({
            workspaceId: fixture.mainId,
            kind: "primary",
            checkouts: [
              buildCheckout({
                checkoutId: fixture.mainCheckoutId,
                resourceId: fixture.resourceId,
                remote: fixture.remote.url,
                setupCommand: "echo unsafe > setup-repeated",
              }),
            ],
          }),
        ),
      );
      expect(report.status, report.message).toBe("ready");
    } else {
      expect((await Effect.runPromise(manager.inspect(fixture.mainId))).status).toBe("ready");
    }
    expect(existsSync(marker)).toBe(false);
    const oldBefore = hashContents(fixture.ephemeralRoot);
    renameSync(fixture.remote.path, `${fixture.remote.path}.offline`);
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: fixture.resourceId,
          remote: fixture.remote.url,
          branch: "bound-local-work",
          startingRevision,
          repositoryWorkspaceId: fixture.mainId,
        }),
      ],
    });
    const report = await Effect.runPromise(manager.provision(frame));
    expect(report.status, report.message).toBe("ready");
    expect(report.checkouts?.[0]).toMatchObject({
      baseCommit: fixture.mainHead,
      headCommit: fixture.mainHead,
      startingRevision,
    });
    expect(readCommonDirectory(Effect.runSync(manager.resolve(frame.workspaceId))!.cwd)).toBe(
      readCommonDirectory(fixture.mainRoot),
    );
    expect(readCommonDirectory(fixture.ephemeralRoot)).toBe(realpathSync(fixture.cache));
    expect(hashContents(fixture.ephemeralRoot)).toBe(oldBefore);
    expect(runGitOrThrow(fixture.mainRoot, "rev-parse", "HEAD")).toBe(fixture.mainHead);
    expect(existsSync(join(fixture.mainRoot, ".git", "objects"))).toBe(true);
    expect(readFileSync(join(fixture.mainRoot, "README.md"), "utf8")).toBe("dirty human main\n");
    expect(readFileSync(join(fixture.mainRoot, "private-cache", "secret.txt"), "utf8")).toBe(
      "private ignored main\n",
    );
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(trace, "utf8")).not.toMatch(/built-in: git (?:fetch|clone)/);
  },
);

it.each([{ kind: "current" as const }, { kind: "local" as const, branch: "unpublished-main" }])(
  "refuses a legacy pending %j instruction before creating work or running setup when the selected remote changed",
  async (startingRevision) => {
    const fixture = createLegacyInstallation();
    const manager = makeTestWorkspaces({ storageDir: fixture.storageDir });
    const replay = await Effect.runPromise(
      manager.provision(
        buildProvisionFrame({
          workspaceId: fixture.mainId,
          kind: "primary",
          checkouts: [
            buildCheckout({
              checkoutId: fixture.mainCheckoutId,
              resourceId: fixture.resourceId,
              remote: fixture.remote.url,
            }),
          ],
        }),
      ),
    );
    expect(replay.status, replay.message).toBe("ready");
    runGitOrThrow(
      fixture.mainRoot,
      "remote",
      "set-url",
      "origin",
      "https://fixture.invalid/a-different-repository",
    );
    const before = hashContents(fixture.mainRoot);
    const counter = join(fixture.storageDir, "unsafe-setup-count");
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: fixture.resourceId,
          remote: fixture.remote.url,
          branch: "must-not-be-created",
          startingRevision,
          setupCommand: `echo unsafe >> '${counter}'`,
        }),
      ],
    });
    const report = await Effect.runPromise(manager.provision(frame));
    expect(report.status).toBe("failed");
    expect(report.message).toMatch(/remote|repository|selected|restore/i);
    expect(existsSync(counter)).toBe(false);
    expect(existsSync(join(fixture.storageDir, "workspaces", frame.workspaceId))).toBe(false);
    expect(hashContents(fixture.mainRoot)).toBe(before);
    expect(runGitOrThrow(fixture.mainRoot, "branch", "--list", "must-not-be-created")).toBe("");
  },
);

it("keeps the historical bare cache as the source when the legacy array has only cache-derived workspaces", async () => {
  const fixture = createLegacyInstallation();
  const registryPath = join(fixture.storageDir, "workspaces.json");
  const entries = JSON.parse(readFileSync(registryPath, "utf8")) as Array<{ workspaceId: string }>;
  writeFileSync(
    registryPath,
    JSON.stringify(entries.filter((entry) => entry.workspaceId === fixture.ephemeralId)),
  );
  const trace = join(fixture.storageDir, "cache-only-trace");
  renameSync(fixture.remote.path, `${fixture.remote.path}.offline`);
  const manager = makeTestWorkspaces({
    storageDir: fixture.storageDir,
    gitEnv: { GIT_TRACE: trace },
  });
  const frame = buildProvisionFrame({
    kind: "ephemeral",
    checkouts: [
      buildCheckout({
        resourceId: fixture.resourceId,
        remote: fixture.remote.url,
        branch: "new-from-old-cache",
        startingRevision: { kind: "local", branch: "old-cache-work" },
      }),
    ],
  });
  const report = await Effect.runPromise(manager.provision(frame));
  expect(report.status, report.message).toBe("ready");
  expect(report.checkouts?.[0]?.baseCommit).toBe(fixture.ephemeralHead);
  expect(readCommonDirectory(Effect.runSync(manager.resolve(frame.workspaceId))!.cwd)).toBe(
    realpathSync(fixture.cache),
  );
  expect(runGitOrThrow(fixture.mainRoot, "rev-parse", "HEAD")).toBe(fixture.mainHead);
  expect(readFileSync(join(fixture.ephemeralRoot, "unfinished.txt"), "utf8")).toBe(
    "unfinished old cache work\n",
  );
  expect(readFileSync(trace, "utf8")).not.toMatch(/built-in: git (?:fetch|clone)/);
});

it("refuses a changed managed-cache remote before creating a new local worktree or running setup", async () => {
  const remote = makeRemote();
  const storageDir = createTemporaryDir("hercule-cache-remote-identity-home-");
  const resourceId = createId();
  const manager = makeTestWorkspaces({ storageDir });
  const initial = buildProvisionFrame({
    kind: "ephemeral",
    checkouts: [buildCheckout({ resourceId, remote: remote.url, branch: "warm-cache" })],
  });
  expect((await Effect.runPromise(manager.provision(initial))).status).toBe("ready");
  const cache = readCommonDirectory(Effect.runSync(manager.resolve(initial.workspaceId))!.cwd);
  runGitOrThrow(
    cache,
    "remote",
    "set-url",
    "origin",
    "https://fixture.invalid/changed-managed-repository",
  );
  const before = hashContents(cache);
  const counter = join(storageDir, "unsafe-setup-count");
  const frame = buildProvisionFrame({
    kind: "ephemeral",
    checkouts: [
      buildCheckout({
        resourceId,
        remote: remote.url,
        branch: "must-not-be-created",
        startingRevision: { kind: "local", branch: "main" },
        setupCommand: `echo unsafe >> '${counter}'`,
      }),
    ],
  });
  const report = await Effect.runPromise(manager.provision(frame));
  expect(report.status).toBe("failed");
  expect(report.message).toMatch(/remote|repository|selected|restore/i);
  expect(existsSync(counter)).toBe(false);
  expect(existsSync(join(storageDir, "workspaces", frame.workspaceId))).toBe(false);
  expect(hashContents(cache)).toBe(before);
  expect(runGitOrThrow(cache, "branch", "--list", "must-not-be-created")).toBe("");
});

it("refuses unavailable recorded standalone main storage instead of silently selecting its old cache", async () => {
  const fixture = createLegacyInstallation();
  const savedMain = `${fixture.mainRoot}.unavailable`;
  renameSync(fixture.mainRoot, savedMain);
  const before = {
    main: hashContents(savedMain),
    cache: hashContents(fixture.cache),
    ephemeral: hashContents(fixture.ephemeralRoot),
  };
  const counter = join(fixture.storageDir, "must-not-run-fallback-setup");
  const manager = makeTestWorkspaces({ storageDir: fixture.storageDir });
  const frame = buildProvisionFrame({
    kind: "ephemeral",
    checkouts: [
      buildCheckout({
        resourceId: fixture.resourceId,
        remote: fixture.remote.url,
        branch: "must-not-use-old-cache",
        startingRevision: { kind: "local", branch: "old-cache-work" },
        setupCommand: `echo unsafe >> '${counter}'`,
      }),
    ],
  });

  const report = await Effect.runPromise(manager.provision(frame));

  expect(report.status).toBe("failed");
  expect(report.message).toMatch(/unavailable|restore|selected|source|checkout/i);
  expect(existsSync(counter)).toBe(false);
  expect(existsSync(join(fixture.storageDir, "workspaces", frame.workspaceId))).toBe(false);
  expect(hashContents(savedMain)).toBe(before.main);
  expect(hashContents(fixture.cache)).toBe(before.cache);
  expect(hashContents(fixture.ephemeralRoot)).toBe(before.ephemeral);
  expect(Effect.runSync(manager.resolve(fixture.ephemeralId))?.cwd).toBe(fixture.ephemeralRoot);
});

it("replays a healthy old cache workspace through its own topology when the separate main is unavailable", async () => {
  const fixture = createLegacyInstallation();
  renameSync(fixture.mainRoot, `${fixture.mainRoot}.unavailable`);
  const before = {
    cache: hashContents(fixture.cache),
    workspace: hashContents(fixture.ephemeralRoot),
  };
  const manager = makeTestWorkspaces({ storageDir: fixture.storageDir });
  expect((await Effect.runPromise(manager.inspect(fixture.ephemeralId))).status).toBe("ready");
  const replay = buildProvisionFrame({
    workspaceId: fixture.ephemeralId,
    kind: "ephemeral",
    checkouts: [
      buildCheckout({
        checkoutId: fixture.ephemeralCheckoutId,
        resourceId: fixture.resourceId,
        remote: fixture.remote.url,
        branch: "old-cache-work",
        setupCommand: "echo unsafe > setup-repeated",
      }),
    ],
  });

  const report = await Effect.runPromise(manager.provision(replay));

  expect(report.status, report.message).toBe("ready");
  expect(report.checkouts?.[0]).toMatchObject({
    checkoutId: fixture.ephemeralCheckoutId,
    headCommit: fixture.ephemeralHead,
    form: "worktree",
  });
  expect(Effect.runSync(manager.resolve(fixture.ephemeralId))?.cwd).toBe(fixture.ephemeralRoot);
  expect(existsSync(join(fixture.ephemeralRoot, "setup-repeated"))).toBe(false);
  expect(hashContents(fixture.cache)).toBe(before.cache);
  expect(hashContents(fixture.ephemeralRoot)).toBe(before.workspace);
});
