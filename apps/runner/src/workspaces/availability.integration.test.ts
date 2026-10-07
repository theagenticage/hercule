import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionStart, WorkspaceKind } from "@hercule/protocol";
import { resolveSessionContext, type Machine } from "../sessions/context";
import { makeWorkspaces, type Workspaces } from "./index";
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

const refuseSessionPlacement = async (
  workspaces: Workspaces,
  storageDir: string,
  workspaceId: string,
): Promise<void> => {
  const machine: Machine = {
    providersDir: join(storageDir, "providers"),
    scratchDir: join(storageDir, "scratch"),
    binDir: join(storageDir, "bin"),
    herculeTool: { skill: "# fixture", claudePluginDir: join(storageDir, "claude-plugin") },
    controllerUrl: "http://controller.invalid",
    baseEnv: {},
    findBinary: () => undefined,
    workspaces,
    socketPath: join(storageDir, "credential.sock"),
  };
  const frame: SessionStart = {
    _tag: "sessionStart",
    requestId: createId(),
    sessionId: createId(),
    input: { text: "hello" },
    providerId: "claude-code",
    config: {},
    secrets: {},
    token: "fixture-token",
    spec: {
      instanceId: createId(),
      workspaceId,
      modelSelection: { model: "fixture", options: {} },
      accessMode: "approval-required",
      timeouts: { inactivityMs: 60_000, absoluteMs: 60_000 },
    },
  };
  for (const spec of [
    frame.spec,
    {
      ...frame.spec,
      continue: { nativeSessionId: "saved-provider-transcript", mode: "resume" as const },
    },
  ]) {
    const outcome = await Effect.runPromise(
      Effect.result(resolveSessionContext({ ...frame, spec }, machine, "claude")),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) expect(outcome.failure).toContain(workspaceId);
  }
  expect(existsSync(machine.scratchDir)).toBe(false);
};

describe("managed checkout availability", () => {
  it.each(["primary", "ephemeral"] satisfies ReadonlyArray<WorkspaceKind>)(
    "refuses missing Git metadata in a %s and preserves its files during start and resume",
    async (kind) => {
      const remote = makeRemote();
      const storageDir = createTemporaryDir("hercule-managed-availability-home-");
      const manager = makeWorkspaces({ storageDir });
      const frame = buildProvisionFrame({
        kind,
        checkouts: [
          buildCheckout({
            resourceId: createId(),
            remote: remote.url,
            branch: kind === "primary" ? null : "work",
          }),
        ],
      });
      expect((await manager.provision(frame)).status).toBe("ready");
      const cwd = manager.resolve(frame.workspaceId)!.cwd;
      writeFileSync(join(cwd, "human-sentinel"), "unfinished human work\n");
      rmSync(join(cwd, ".git"));
      const before = hashContents(cwd);
      const restarted = makeWorkspaces({ storageDir });

      expect(restarted.resolve(frame.workspaceId)).toBeUndefined();
      const observed = await restarted.inspect(frame.workspaceId);
      expect(observed.status).toBe("failed");
      expect(observed.message).toMatch(/Git|repository|checkout|unavailable/i);
      await refuseSessionPlacement(restarted, storageDir, frame.workspaceId);
      expect(readFileSync(join(cwd, "human-sentinel"), "utf8")).toBe("unfinished human work\n");
      expect(hashContents(cwd)).toBe(before);
    },
  );

  it("refuses a replaced managed common directory without changing the surviving checkout", async () => {
    const remote = makeRemote();
    const storageDir = createTemporaryDir("hercule-managed-replacement-home-");
    const manager = makeWorkspaces({ storageDir });
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [buildCheckout({ resourceId: createId(), remote: remote.url, branch: "work" })],
    });
    expect((await manager.provision(frame)).status).toBe("ready");
    const cwd = manager.resolve(frame.workspaceId)!.cwd;
    const commonDirectory = realpathSync(
      runGitOrThrow(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    renameSync(commonDirectory, `${commonDirectory}.original`);
    runGitOrThrow(storageDir, "clone", "--bare", remote.url, commonDirectory);
    writeFileSync(join(cwd, "human-sentinel"), "surviving checkout\n");
    const before = hashContents(storageDir);
    const restarted = makeWorkspaces({ storageDir });

    expect(restarted.resolve(frame.workspaceId)).toBeUndefined();
    expect((await restarted.inspect(frame.workspaceId)).status).toBe("failed");
    await refuseSessionPlacement(restarted, storageDir, frame.workspaceId);
    expect(hashContents(storageDir)).toBe(before);
  });

  it("refuses a generated root replaced by a symlink to another worktree in the same repository", async () => {
    const remote = makeRemote();
    const storageDir = createTemporaryDir("hercule-managed-alias-home-");
    const manager = makeWorkspaces({ storageDir });
    const resourceId = createId();
    const first = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [buildCheckout({ resourceId, remote: remote.url, branch: "first-work" })],
    });
    const second = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [buildCheckout({ resourceId, remote: remote.url, branch: "second-work" })],
    });
    expect((await manager.provision(first)).status).toBe("ready");
    expect((await manager.provision(second)).status).toBe("ready");
    const cwd = manager.resolve(first.workspaceId)!.cwd;
    const other = manager.resolve(second.workspaceId)!.cwd;
    writeFileSync(join(cwd, "human-sentinel"), "first original work\n");
    renameSync(cwd, `${cwd}.original`);
    symlinkSync(other, cwd);
    const before = hashContents(storageDir);
    const restarted = makeWorkspaces({ storageDir });

    expect(restarted.resolve(first.workspaceId)).toBeUndefined();
    expect((await restarted.inspect(first.workspaceId)).status).toBe("failed");
    expect(restarted.resolve(second.workspaceId)?.cwd).toBe(other);
    await refuseSessionPlacement(restarted, storageDir, first.workspaceId);
    expect(hashContents(storageDir)).toBe(before);
  });
});
