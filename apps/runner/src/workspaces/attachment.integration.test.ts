import { makeTestWorkspaces } from "./testing";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import type { SessionStart, WorkspaceProvision, WorkspaceReport } from "@hercule/protocol";
import { resolveSessionContext, type Machine } from "../sessions/context";

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
import { makeAttachmentCache } from "../attachments";
import { NO_CONTROLLER_UPLOADER } from "../providers/testing";

afterAll(cleanTemporaries);

type AttachmentFrame = WorkspaceProvision & {
  readonly attachment: { readonly path: string; readonly remoteName: string };
};

const createAttachment = (linked = false, remoteName = "origin") => {
  const remote = makeRemote();
  const world = createTemporaryDir("hercule-existing-");
  const original = join(world, "user checkout with spaces");
  runGitOrThrow(world, "clone", remote.url, original);
  const resourceId = createId();
  const remoteUrl = `https://fixture.invalid/acme/${resourceId}`;
  runGitOrThrow(original, "remote", "set-url", "origin", remoteUrl);
  if (remoteName !== "origin") {
    runGitOrThrow(original, "remote", "add", remoteName, remoteUrl);
    runGitOrThrow(original, "remote", "set-url", "origin", "https://fixture.invalid/other/repo");
  }
  runGitOrThrow(original, "checkout", "-b", "private-local-commit");
  writeFileSync(join(original, ".gitignore"), "private.env\n");
  writeFileSync(join(original, "local-only.txt"), "unpushed local commit\n");
  runGitOrThrow(original, "add", ".");
  runGitOrThrow(original, "commit", "-m", "local work");
  let path = original;
  if (linked) {
    path = join(world, "linked checkout with spaces");
    runGitOrThrow(original, "worktree", "add", "-b", "private-linked-branch", path, "HEAD");
  }
  path = realpathSync(path);
  mkdirSync(join(path, "src"));
  writeFileSync(join(path, "README.md"), "dirty tracked content\n");
  writeFileSync(join(path, "untracked.txt"), "untracked content\n");
  writeFileSync(join(path, "private.env"), "fixture-private-content\n");
  runGitOrThrow(original, "config", "alias.user-command", "status --short");
  runGitOrThrow(original, "config", "core.autocrlf", "false");
  const commonDirectory = runGitOrThrow(
    path,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  writeFileSync(join(commonDirectory, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  const storageDir = createTemporaryDir("hercule-attachment-storage-");
  const setupMarker = join(storageDir, "must-not-run-setup");
  const frame: AttachmentFrame = {
    ...buildProvisionFrame({
      kind: "primary",
      checkouts: [
        buildCheckout({
          resourceId,
          remote: remoteUrl,
          setupCommand: `echo setup > '${setupMarker}'`,
        }),
      ],
    }),
    attachment: { path: join(path, "src"), remoteName },
  };
  const gitEnv = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
    GIT_CONFIG_VALUE_0: remoteUrl,
    GIT_TRACE: join(storageDir, "git-trace"),
  };
  return { world, original, path, storageDir, setupMarker, frame, gitEnv };
};

describe("registering an existing checkout", () => {
  it.each([false, true])(
    "preserves all files and Git state, including a linked worktree=%s, and normalizes a subdirectory",
    async (linked) => {
      const fixture = createAttachment(linked);
      const before = hashContents(fixture.world);
      const head = runGitOrThrow(fixture.path, "rev-parse", "HEAD");
      const branch = runGitOrThrow(fixture.path, "branch", "--show-current");
      const manager = makeTestWorkspaces({
        storageDir: fixture.storageDir,
        gitEnv: fixture.gitEnv,
      });

      const report: WorkspaceReport & { readonly path?: string } = await Effect.runPromise(
        manager.provision(fixture.frame),
      );

      expect(report.status, report.message).toBe("ready");
      expect(report.path).toBe(fixture.path);
      expect(Effect.runSync(manager.resolve(fixture.frame.workspaceId))?.cwd).toBe(fixture.path);
      expect(report.checkouts?.[0]?.branch).toBe(branch);
      expect(runGitOrThrow(fixture.path, "rev-parse", "HEAD")).toBe(head);
      expect(hashContents(fixture.world)).toBe(before);
      expect(existsSync(fixture.setupMarker)).toBe(false);
      expect(existsSync(join(fixture.storageDir, "cache"))).toBe(false);
      expect(readFileSync(fixture.gitEnv.GIT_TRACE, "utf8")).not.toMatch(
        /built-in: git (?:clone|fetch|checkout|switch|reset)|remote set-url/,
      );
    },
  );

  it("uses the explicitly selected remote without rewriting origin or running setup", async () => {
    const fixture = createAttachment(false, "upstream");
    const before = hashContents(fixture.world);

    const report = await Effect.runPromise(
      makeTestWorkspaces({
        storageDir: fixture.storageDir,
        gitEnv: fixture.gitEnv,
      }).provision(fixture.frame),
    );

    expect(report.status, report.message).toBe("ready");
    expect(hashContents(fixture.world)).toBe(before);
    expect(existsSync(fixture.setupMarker)).toBe(false);
  });

  it("repeats the same attachment in place after a manager restart", async () => {
    const fixture = createAttachment();
    const before = hashContents(fixture.world);
    const manager = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });
    const first = await Effect.runPromise(manager.provision(fixture.frame));
    expect(first.status, first.message).toBe("ready");

    const duplicate = await Effect.runPromise(manager.provision(fixture.frame));
    const restarted = await Effect.runPromise(
      makeTestWorkspaces({
        storageDir: fixture.storageDir,
        gitEnv: fixture.gitEnv,
      }).provision(fixture.frame),
    );

    expect(duplicate).toEqual(first);
    expect(restarted).toEqual(first);
    expect(
      Effect.runSync(
        makeTestWorkspaces({ storageDir: fixture.storageDir }).resolve(fixture.frame.workspaceId),
      )?.cwd,
    ).toBe(fixture.path);
    expect(hashContents(fixture.world)).toBe(before);
  });

  it.each(["wrong remote", "missing path", "non-Git directory"] as const)(
    "rejects %s and preserves every candidate file",
    async (failure) => {
      const fixture = createAttachment();
      const plain = join(fixture.world, "plain folder");
      mkdirSync(plain);
      writeFileSync(join(plain, "keep.txt"), "keep this\n");
      if (failure === "wrong remote") {
        runGitOrThrow(
          fixture.path,
          "remote",
          "set-url",
          "origin",
          "https://fixture.invalid/unrelated/repo",
        );
      }
      const path =
        failure === "missing path"
          ? join(fixture.world, "absent")
          : failure === "non-Git directory"
            ? plain
            : fixture.path;
      const before = hashContents(fixture.world);
      const manager = makeTestWorkspaces({
        storageDir: fixture.storageDir,
        gitEnv: fixture.gitEnv,
      });

      const report = await Effect.runPromise(
        manager.provision({
          ...fixture.frame,
          attachment: { ...fixture.frame.attachment, path },
        }),
      );

      expect(report.status).toBe("failed");
      expect(report.message).toMatch(/remote|repository|checkout|path|directory/i);
      expect(Effect.runSync(manager.resolve(fixture.frame.workspaceId))).toBeUndefined();
      expect(hashContents(fixture.world)).toBe(before);
      expect(existsSync(fixture.setupMarker)).toBe(false);
      expect(existsSync(join(fixture.storageDir, "cache"))).toBe(false);
    },
  );

  it("refuses concurrent conflicting paths for one resource and leaves both folders unchanged", async () => {
    const first = createAttachment();
    const secondPath = join(first.world, "second candidate");
    runGitOrThrow(first.world, "clone", first.original, secondPath);
    runGitOrThrow(secondPath, "remote", "set-url", "origin", first.frame.checkouts[0]!.remote);
    const before = hashContents(first.world);
    const manager = makeTestWorkspaces({ storageDir: first.storageDir, gitEnv: first.gitEnv });
    const competing: AttachmentFrame = {
      ...first.frame,
      workspaceId: createId(),
      attachment: { path: secondPath, remoteName: "origin" },
    };

    const reports = await Promise.all([
      Effect.runPromise(manager.provision(first.frame)),
      Effect.runPromise(manager.provision(competing)),
    ]);

    expect(reports.map((report) => report.status).sort()).toEqual(["failed", "ready"]);
    expect(reports.find((report) => report.status === "failed")?.message).toMatch(
      /conflict|already|selected/i,
    );
    expect(hashContents(first.world)).toBe(before);
    expect(existsSync(first.setupMarker)).toBe(false);
  });

  it("refuses to reinterpret an existing selection as managed mode or another path", async () => {
    const fixture = createAttachment();
    const manager = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });
    expect((await Effect.runPromise(manager.provision(fixture.frame))).status).toBe("ready");
    const before = hashContents(fixture.world);
    const managed = buildProvisionFrame({
      kind: "primary",
      checkouts: fixture.frame.checkouts,
    });

    const changedMode = await Effect.runPromise(
      manager.provision({ ...managed, workspaceId: createId() }),
    );
    const changedPath = await Effect.runPromise(
      manager.provision({
        ...fixture.frame,
        attachment: { path: fixture.original, remoteName: "different" },
      }),
    );

    expect(changedMode.status).toBe("failed");
    expect(changedPath.status).toBe("failed");
    expect(hashContents(fixture.world)).toBe(before);
  });
});

describe("recovering attachment availability", () => {
  it("refuses a replacement repository at the recorded path during resolution, start and resume", async () => {
    const fixture = createAttachment();
    const manager = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });
    expect((await Effect.runPromise(manager.provision(fixture.frame))).status).toBe("ready");
    renameSync(fixture.path, `${fixture.path}.original`);
    const replacement = makeRemote();
    runGitOrThrow(fixture.world, "clone", replacement.url, fixture.path);
    runGitOrThrow(fixture.path, "remote", "set-url", "origin", fixture.frame.checkouts[0]!.remote);
    writeFileSync(join(fixture.path, "replacement-work.txt"), "replacement files must stay\n");
    const before = hashContents(fixture.world);

    expect(Effect.runSync(manager.resolve(fixture.frame.workspaceId))).toBeUndefined();
    const machine: Machine = {
      providersDir: join(fixture.storageDir, "providers"),
      scratchDir: join(fixture.storageDir, "scratch"),
      attachmentsDir: join(fixture.storageDir, "attachments"),
      attachmentUploader: NO_CONTROLLER_UPLOADER,
      attachments: makeAttachmentCache({
        controllerUrl: "https://controller.example:4938",
        credential: "test",
      }),
      binDir: join(fixture.storageDir, "bin"),
      herculeTool: {
        skill: "# fixture",
        claudePluginDir: join(fixture.storageDir, "claude-plugin"),
      },
      controllerUrl: "http://controller.invalid",
      baseEnv: {},
      findBinary: () => undefined,
      workspaces: manager,
      socketPath: join(fixture.storageDir, "credential.sock"),
    };
    const frame: SessionStart = {
      _tag: "sessionStart",
      requestId: createId(),
      sessionId: createId(),
      input: { text: "hello" },
      providerId: "claude-code",
      config: {},
      secrets: {},
      token: "fixture-session-token",
      spec: {
        instanceId: createId(),
        workspaceId: fixture.frame.workspaceId,
        modelSelection: { model: "fixture", options: {} },
        accessMode: "approval-required",
        timeouts: { inactivityMs: 60_000, absoluteMs: 60_000 },
      },
    };
    const specifications: ReadonlyArray<SessionStart["spec"]> = [
      frame.spec,
      { ...frame.spec, continue: { nativeSessionId: "saved-provider-transcript", mode: "resume" } },
    ];
    for (const spec of specifications) {
      const outcome = await Effect.runPromise(
        Effect.result(resolveSessionContext({ ...frame, spec }, machine, "claude")),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) expect(outcome.failure).toContain(fixture.frame.workspaceId);
    }
    expect(existsSync(machine.scratchDir)).toBe(false);
    expect(hashContents(fixture.world)).toBe(before);
  });

  it("does not replace a disappeared checkout and validates the same restored path on explicit attachment", async () => {
    const fixture = createAttachment();
    const manager = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });
    expect((await Effect.runPromise(manager.provision(fixture.frame))).status).toBe("ready");
    const before = hashContents(fixture.world);
    const missing = `${fixture.path}.saved`;
    renameSync(fixture.path, missing);

    const unavailable = await Effect.runPromise(
      makeTestWorkspaces({
        storageDir: fixture.storageDir,
        gitEnv: fixture.gitEnv,
      }).provision(fixture.frame),
    );

    expect(unavailable.status).toBe("failed");
    expect(
      Effect.runSync(
        makeTestWorkspaces({ storageDir: fixture.storageDir }).resolve(fixture.frame.workspaceId),
      ),
    ).toBeUndefined();
    expect(existsSync(fixture.path)).toBe(false);
    renameSync(missing, fixture.path);
    const recovered = await Effect.runPromise(
      makeTestWorkspaces({
        storageDir: fixture.storageDir,
        gitEnv: fixture.gitEnv,
      }).provision(fixture.frame),
    );
    expect(recovered.status, recovered.message).toBe("ready");
    expect(hashContents(fixture.world)).toBe(before);
    expect(existsSync(fixture.setupMarker)).toBe(false);
  });

  it("rebuilds a missing local registry from valid attachment intent without cloning or setup", async () => {
    const fixture = createAttachment();
    expect(
      (
        await Effect.runPromise(
          makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv }).provision(
            fixture.frame,
          ),
        )
      ).status,
    ).toBe("ready");
    const before = hashContents(fixture.world);
    renameSync(
      join(fixture.storageDir, "workspaces.json"),
      join(fixture.storageDir, "saved-registry.json"),
    );

    const manager = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });
    const rebuilt = await Effect.runPromise(manager.provision(fixture.frame));

    expect(rebuilt.status, rebuilt.message).toBe("ready");
    expect(Effect.runSync(manager.resolve(fixture.frame.workspaceId))?.cwd).toBe(fixture.path);
    expect(hashContents(fixture.world)).toBe(before);
    expect(existsSync(fixture.setupMarker)).toBe(false);
  });

  it("reports a corrupt registry as a recovery error while preserving the registry and existing files", async () => {
    const fixture = createAttachment();
    const registry = join(fixture.storageDir, "workspaces.json");
    writeFileSync(registry, "{broken-registry");
    const standingFiles = join(fixture.storageDir, "existing-managed-files");
    mkdirSync(standingFiles);
    writeFileSync(join(standingFiles, "keep.txt"), "keep this work\n");
    const before = hashContents(fixture.world);
    const storageBefore = hashContents(fixture.storageDir);

    const report = await Effect.runPromise(
      makeTestWorkspaces({
        storageDir: fixture.storageDir,
        gitEnv: fixture.gitEnv,
      }).provision(fixture.frame),
    );

    expect(report.status).toBe("failed");
    expect(report.message).toMatch(/registry.*(?:recover|corrupt|unreadable|valid)/i);
    expect(readFileSync(registry, "utf8")).toBe("{broken-registry");
    expect(hashContents(fixture.world)).toBe(before);
    expect(hashContents(fixture.storageDir)).toBe(storageBefore);
    expect(existsSync(fixture.setupMarker)).toBe(false);
  });
});

describe("normalized attachment recovery", () => {
  it("replays the canonical root after the originally selected subdirectory disappears", async () => {
    const fixture = createAttachment();
    const initial = await Effect.runPromise(
      makeTestWorkspaces({
        storageDir: fixture.storageDir,
        gitEnv: fixture.gitEnv,
      }).provision(fixture.frame),
    );
    expect(initial.status, initial.message).toBe("ready");
    rmSync(fixture.frame.attachment.path, { recursive: true });
    const before = hashContents(fixture.world);
    const manager = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });

    const recovered = await Effect.runPromise(
      manager.provision({
        ...fixture.frame,
        attachment: { ...fixture.frame.attachment, path: fixture.path },
      }),
    );

    expect(recovered).toEqual(initial);
    expect(Effect.runSync(manager.resolve(fixture.frame.workspaceId))?.cwd).toBe(fixture.path);
    expect(hashContents(fixture.world)).toBe(before);
    expect(existsSync(fixture.setupMarker)).toBe(false);
  });

  it("accepts a delayed original subdirectory instruction after a canonical-root replay", async () => {
    const fixture = createAttachment();
    const manager = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });
    const initial = await Effect.runPromise(manager.provision(fixture.frame));
    expect(initial.status, initial.message).toBe("ready");
    expect(
      await Effect.runPromise(
        manager.provision({
          ...fixture.frame,
          attachment: { ...fixture.frame.attachment, path: fixture.path },
        }),
      ),
    ).toEqual(initial);
    const before = hashContents(fixture.world);

    const delayed = await Effect.runPromise(
      makeTestWorkspaces({
        storageDir: fixture.storageDir,
        gitEnv: fixture.gitEnv,
      }).provision(fixture.frame),
    );

    expect(delayed).toEqual(initial);
    expect(hashContents(fixture.world)).toBe(before);
    expect(existsSync(fixture.setupMarker)).toBe(false);
  });
});

it("recovers an inspected unavailable attachment after restart while preserving its original preparation receipt", async () => {
  const fixture = createAttachment();
  const manager = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });
  const prepared = await Effect.runPromise(manager.provision(fixture.frame));
  expect(prepared.status).toBe("ready");
  const saved = `${fixture.path}.saved`;
  renameSync(fixture.path, saved);
  const unavailable = await Effect.runPromise(manager.inspect(fixture.frame.workspaceId));
  expect(unavailable.status).toBe("failed");
  renameSync(saved, fixture.path);
  await Bun.sleep(2);
  const restarted = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });

  const restored = await Effect.runPromise(restarted.provision(fixture.frame));

  expect(restored.status, restored.message).toBe("ready");
  expect(Date.parse(restored.observedAt!)).toBeGreaterThan(Date.parse(unavailable.observedAt!));
  expect(restored.checkouts).toEqual(prepared.checkouts);
  expect(existsSync(fixture.setupMarker)).toBe(false);
  const receipt = Effect.runSync(
    makeRegistry(fixture.storageDir).held(fixture.frame.workspaceId),
  )?.preparation;
  expect(receipt?.phase).toBe("terminal");
  if (receipt?.phase === "terminal") expect(receipt.report).toEqual(prepared);
  expect(await Effect.runPromise(restarted.provision(fixture.frame))).toEqual(prepared);
});

it("timestamps genuine attachment loss while refusing wrong intent without an availability observation", async () => {
  const fixture = createAttachment();
  const manager = makeTestWorkspaces({ storageDir: fixture.storageDir, gitEnv: fixture.gitEnv });
  const prepared = await Effect.runPromise(manager.provision(fixture.frame));
  expect(prepared.status).toBe("ready");
  const wrong = await Effect.runPromise(
    manager.provision({
      ...fixture.frame,
      attachment: { path: join(fixture.world, "wrong missing path"), remoteName: "origin" },
    }),
  );
  expect(wrong.status).toBe("failed");
  expect(wrong.observedAt).toBeUndefined();
  expect(await Effect.runPromise(manager.provision(fixture.frame))).toEqual(prepared);
  const saved = `${fixture.path}.saved`;
  renameSync(fixture.path, saved);
  await Bun.sleep(2);

  const unavailable = await Effect.runPromise(manager.provision(fixture.frame));

  expect(unavailable.status).toBe("failed");
  expect(Date.parse(unavailable.observedAt!)).toBeGreaterThan(Date.parse(prepared.observedAt!));
  renameSync(saved, fixture.path);
  await Bun.sleep(2);
  const restored = await Effect.runPromise(
    makeTestWorkspaces({
      storageDir: fixture.storageDir,
      gitEnv: fixture.gitEnv,
    }).provision(fixture.frame),
  );
  expect(restored.status, restored.message).toBe("ready");
  expect(Date.parse(restored.observedAt!)).toBeGreaterThan(Date.parse(unavailable.observedAt!));
  expect(existsSync(fixture.setupMarker)).toBe(false);
});
