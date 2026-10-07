import { makeTestWorkspaces } from "./testing";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { makeWorkspaces } from "./index";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildCheckout,
  buildProvisionFrame,
  cleanTemporaries,
  createId,
  createTemporaryDir,
  makeRemote,
} from "./testing";

afterAll(cleanTemporaries);

const quoteShell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`preparation never wrote ${path}`);
    await Bun.sleep(10);
  }
};

const waitForProcessGone = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`proof process ${String(pid)} did not exit`);
};

describe("durable preparation outcomes", () => {
  it.each(["creation", "before setup"] as const)(
    "keeps interrupted %s failed when a process dies at a controlled Git barrier",
    async (stage) => {
      const remote = makeRemote();
      const storageDir = createTemporaryDir("hercule-preparation-");
      const counter = join(storageDir, "setup-count");
      const marker = join(storageDir, "blocked-git-pid");
      const barrier = join(storageDir, "git-barrier");
      const made = Bun.spawnSync(["mkfifo", barrier]);
      expect(made.exitCode, made.stderr.toString()).toBe(0);
      const executables = join(storageDir, "bin");
      mkdirSync(executables);
      const git = Bun.which("git");
      expect(git).toBeTruthy();
      const block = `echo $$ > ${quoteShell(marker)}; read release < ${quoteShell(barrier)}`;
      const invokeGit = `${quoteShell(git!)} "$@"`;
      writeFileSync(
        join(executables, "git"),
        "#!/bin/sh\ncase \" $* \" in\n*' worktree add '*)\n" +
          (stage === "creation"
            ? `${block}\nexec ${invokeGit}\n`
            : `${invokeGit} || exit $?\n${block}\nexit 0\n`) +
          `;;\n*) exec ${invokeGit};;\nesac\n`,
        { mode: 0o700 },
      );
      const frame = buildProvisionFrame({
        kind: "ephemeral",
        checkouts: [
          buildCheckout({
            resourceId: createId(),
            remote: remote.url,
            branch: "test/interrupted-creation",
            setupCommand: `printf 'called\\n' >> ${quoteShell(counter)}`,
          }),
        ],
      });
      const instruction = join(storageDir, "instruction.json");
      writeFileSync(instruction, JSON.stringify(frame));
      const code =
        `import { Effect } from "effect"; import { makeWorkspaces } from ${JSON.stringify(join(import.meta.dirname, "index.ts"))}; ` +
        `const frame = await Bun.file(${JSON.stringify(instruction)}).json(); ` +
        `await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const manager = yield* makeWorkspaces({ storageDir: ${JSON.stringify(storageDir)} }); return yield* manager.provision(frame); })));`;
      const child = Bun.spawn([process.execPath, "--eval", code], {
        env: {
          ...process.env,
          HERCULE_HOME: join(storageDir, "proof-home"),
          PATH: `${executables}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      let capturedGitPid: number | undefined;
      try {
        await waitForFile(marker);
        capturedGitPid = Number(readFileSync(marker, "utf8").trim());
        expect(capturedGitPid).toBeGreaterThan(0);
        child.kill("SIGKILL");
        await child.exited;
        process.kill(capturedGitPid, "SIGKILL");
        await waitForProcessGone(capturedGitPid);
        capturedGitPid = undefined;
        expect(existsSync(counter)).toBe(false);

        const report = await Effect.runPromise(makeTestWorkspaces({ storageDir }).provision(frame));

        expect(report.status).toBe("failed");
        expect(report.message).toMatch(
          /preparation (?:was |is )?interrupted|interrupted preparation|preparation.*incomplete/i,
        );
        expect(existsSync(counter)).toBe(false);
        expect(
          Effect.runSync(makeTestWorkspaces({ storageDir }).resolve(frame.workspaceId)),
        ).toBeUndefined();
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        await waitForProcessGone(child.pid);
        if (capturedGitPid !== undefined) {
          try {
            process.kill(capturedGitPid, "SIGKILL");
          } catch {
            // The barrier process may already have exited with its parent.
          }
          await waitForProcessGone(capturedGitPid);
        }
      }
    },
  );

  it("keeps preparation alive after cancelling a waiter and stops setup when its manager scope closes", async () => {
    const remote = makeRemote();
    const storageDir = createTemporaryDir("hercule-preparation-");
    const counter = join(storageDir, "setup-count");
    const setupPid = join(storageDir, "setup-pid");
    const descendantPid = join(storageDir, "descendant-pid");
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: createId(),
          remote: remote.url,
          branch: "test/scoped-preparation",
          setupCommand: `printf 'called\\n' >> ${quoteShell(counter)}; sleep 60 & echo $! > ${quoteShell(descendantPid)}; echo $$ > ${quoteShell(setupPid)}; wait`,
        }),
      ],
    });
    const scope = Scope.makeUnsafe();
    const manager = Effect.runSync(makeWorkspaces({ storageDir }).pipe(Scope.provide(scope)));
    const waiter = Effect.runFork(manager.provision(frame));
    let capturedSetupPid: number | undefined;
    let capturedDescendantPid: number | undefined;
    try {
      await waitForFile(setupPid);
      capturedSetupPid = Number(readFileSync(setupPid, "utf8").trim());
      capturedDescendantPid = Number(readFileSync(descendantPid, "utf8").trim());
      expect(capturedSetupPid).toBeGreaterThan(0);
      expect(capturedDescendantPid).toBeGreaterThan(0);

      await Effect.runPromise(Fiber.interrupt(waiter));
      expect(() => process.kill(capturedSetupPid!, 0)).not.toThrow();
      expect(() => process.kill(capturedDescendantPid!, 0)).not.toThrow();

      await Effect.runPromise(Scope.close(scope, Exit.void));
      await waitForProcessGone(capturedSetupPid);
      await waitForProcessGone(capturedDescendantPid);
      capturedSetupPid = undefined;
      capturedDescendantPid = undefined;
      const restarted = makeTestWorkspaces({ storageDir });
      const report = await Effect.runPromise(restarted.provision(frame));
      expect(report.status).toBe("failed");
      expect(report.message).toMatch(/preparation.*interrupted/i);
      expect(readFileSync(counter, "utf8")).toBe("called\n");
      expect(Effect.runSync(restarted.resolve(frame.workspaceId))).toBeUndefined();
    } finally {
      await Effect.runPromise(Fiber.interrupt(waiter));
      await Effect.runPromise(Scope.close(scope, Exit.void));
      for (const pid of [capturedSetupPid, capturedDescendantPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* The scoped cleanup may already have stopped it. */
        }
        await waitForProcessGone(pid);
      }
    }
  });

  it("stops a redirected background child before reporting failed setup", async () => {
    const remote = makeRemote();
    const storageDir = createTemporaryDir("hercule-preparation-");
    const descendantPid = join(storageDir, "descendant-pid");
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: createId(),
          remote: remote.url,
          branch: "test/failed-setup-background-child",
          setupCommand: `sleep 60 >/dev/null 2>&1 & echo $! > ${quoteShell(descendantPid)}; echo setup-failed; exit 3`,
        }),
      ],
    });
    let capturedPid: number | undefined;
    try {
      const report = await Effect.runPromise(makeTestWorkspaces({ storageDir }).provision(frame));
      expect(report.status).toBe("failed");
      expect(report.message).toContain("exit code 3");
      expect(report.message).toContain("setup-failed");
      capturedPid = Number(readFileSync(descendantPid, "utf8").trim());
      expect(capturedPid).toBeGreaterThan(0);
      await waitForProcessGone(capturedPid);
      capturedPid = undefined;
    } finally {
      if (capturedPid !== undefined) {
        try {
          process.kill(capturedPid, "SIGKILL");
        } catch {
          /* Cleanup may already have stopped it. */
        }
        await waitForProcessGone(capturedPid);
      }
    }
  }, 10_000);

  it("replays a failed setup in the same manager and after restart without running it again", async () => {
    const remote = makeRemote();
    const storageDir = createTemporaryDir("hercule-preparation-");
    const counter = join(storageDir, "setup-count");
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: createId(),
          remote: remote.url,
          branch: "test/failed-preparation",
          setupCommand: `printf 'called\\n' >> ${quoteShell(counter)}; echo install-failed; exit 7`,
        }),
      ],
    });
    const manager = makeTestWorkspaces({ storageDir });
    const first = await Effect.runPromise(manager.provision(frame));
    expect(first.status).toBe("failed");
    expect(first.message).toContain("install-failed");
    const replay = await Effect.runPromise(manager.provision(frame));
    const restarted = await Effect.runPromise(makeTestWorkspaces({ storageDir }).provision(frame));

    expect(replay).toEqual(first);
    expect(restarted).toEqual(first);
    expect(readFileSync(counter, "utf8")).toBe("called\n");
    expect(
      Effect.runSync(makeTestWorkspaces({ storageDir }).resolve(frame.workspaceId)),
    ).toBeUndefined();
    expect(
      Effect.runSync(makeTestWorkspaces({ storageDir }).hasFailedProvisioning(frame.workspaceId)),
    ).toBe(true);
  });

  it("replays a successful lost report with its warnings without running setup again", async () => {
    const remote = makeRemote();
    const storageDir = createTemporaryDir("hercule-preparation-");
    const counter = join(storageDir, "setup-count");
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: createId(),
          remote: remote.url,
          branch: "test/finished-preparation",
          workspaceInclude: true,
          setupCommand: `printf 'called\\n' >> ${quoteShell(counter)}`,
        }),
      ],
    });
    const first = await Effect.runPromise(makeTestWorkspaces({ storageDir }).provision(frame));
    expect(first.status, first.message).toBe("ready");
    expect(first.warnings?.length).toBeGreaterThan(0);

    const replay = await Effect.runPromise(makeTestWorkspaces({ storageDir }).provision(frame));

    expect(replay).toEqual(first);
    expect(readFileSync(counter, "utf8")).toBe("called\n");
  });

  it("reports interrupted setup after the runner process dies instead of trusting the directory", async () => {
    const remote = makeRemote();
    const storageDir = createTemporaryDir("hercule-preparation-");
    const home = createTemporaryDir("hercule-proof-home-");
    const counter = join(storageDir, "setup-count");
    const setupPid = join(storageDir, "setup-pid");
    const barrier = join(storageDir, "setup-barrier");
    const made = Bun.spawnSync(["mkfifo", barrier]);
    expect(made.exitCode, made.stderr.toString()).toBe(0);
    const frame = buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: createId(),
          remote: remote.url,
          branch: "test/interrupted-preparation",
          setupCommand:
            `printf 'called\\n' >> ${quoteShell(counter)}; ` +
            `echo $$ > ${quoteShell(setupPid)}; read release < ${quoteShell(barrier)}`,
        }),
      ],
    });
    const instruction = join(storageDir, "instruction.json");
    writeFileSync(instruction, JSON.stringify(frame));
    const modulePath = join(import.meta.dirname, "index.ts");
    const code =
      `import { Effect } from "effect"; import { makeWorkspaces } from ${JSON.stringify(modulePath)}; ` +
      `const frame = await Bun.file(${JSON.stringify(instruction)}).json(); ` +
      `console.log(JSON.stringify(await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const manager = yield* makeWorkspaces({ storageDir: ${JSON.stringify(storageDir)} }); return yield* manager.provision(frame); })))));`;
    const child = Bun.spawn([process.execPath, "--eval", code], {
      env: { ...process.env, HERCULE_HOME: home },
      stdout: "ignore",
      stderr: "ignore",
    });
    let capturedSetupPid: number | undefined;
    try {
      await waitForFile(setupPid);
      capturedSetupPid = Number(readFileSync(setupPid, "utf8").trim());
      expect(capturedSetupPid).toBeGreaterThan(0);
      child.kill("SIGKILL");
      await child.exited;
      process.kill(capturedSetupPid, "SIGKILL");
      await waitForProcessGone(capturedSetupPid);
      capturedSetupPid = undefined;

      const report = await Effect.runPromise(makeTestWorkspaces({ storageDir }).provision(frame));

      expect(report.status).toBe("failed");
      expect(report.message).toMatch(
        /preparation (?:was |is )?interrupted|interrupted preparation|preparation.*incomplete/i,
      );
      expect(readFileSync(counter, "utf8")).toBe("called\n");
      expect(
        Effect.runSync(makeTestWorkspaces({ storageDir }).resolve(frame.workspaceId)),
      ).toBeUndefined();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await waitForProcessGone(child.pid);
      if (capturedSetupPid !== undefined) {
        try {
          process.kill(capturedSetupPid, "SIGKILL");
        } catch {
          // A setup that exited before the assertion has no process left to stop.
        }
        await waitForProcessGone(capturedSetupPid);
      }
    }
  });
});

describe("setup in each fresh managed working copy", () => {
  it.each(["primary", "ephemeral"] as const)(
    "runs once in a fresh %s with a scrubbed environment and skips completed replay",
    async (kind) => {
      const remote = makeRemote();
      const storageDir = createTemporaryDir("hercule-preparation-");
      const counter = join(storageDir, "setup-count");
      const frame = buildProvisionFrame({
        kind,
        checkouts: [
          buildCheckout({
            resourceId: createId(),
            remote: remote.url,
            branch: kind === "primary" ? null : "test/fresh-preparation",
            setupCommand:
              `printf 'called\\n' >> ${quoteShell(counter)}; pwd > setup-cwd; ` +
              'printf "%s|%s|%s" "$GIT_TERMINAL_PROMPT" "$HERCULE_RUNNER_SOCKET" "$HERCULE_HOME" > setup-environment',
          }),
        ],
      });
      const manager = makeTestWorkspaces({
        storageDir,
        gitEnv: { HERCULE_RUNNER_SOCKET: join(storageDir, "credential.sock") },
      });
      const first = await Effect.runPromise(manager.provision(frame));
      expect(first.status, first.message).toBe("ready");
      expect(existsSync(counter), "fresh working copy never ran its setup").toBe(true);
      expect(readFileSync(counter, "utf8")).toBe("called\n");
      const resolved = Effect.runSync(manager.resolve(frame.workspaceId));
      expect(resolved).toBeDefined();
      expect(readFileSync(join(resolved!.cwd, "setup-cwd"), "utf8").trim()).toBe(
        realpathSync(resolved!.cwd),
      );
      expect(readFileSync(join(resolved!.cwd, "setup-environment"), "utf8")).toBe("0||");

      expect(await Effect.runPromise(makeTestWorkspaces({ storageDir }).provision(frame))).toEqual(
        first,
      );
      expect(readFileSync(counter, "utf8")).toBe("called\n");
    },
  );

  it.each(["primary", "ephemeral"] as const)(
    "enforces the setup deadline in a fresh %s and preserves failure on replay",
    async (kind) => {
      const remote = makeRemote();
      const storageDir = createTemporaryDir("hercule-preparation-");
      const frame = buildProvisionFrame({
        kind,
        checkouts: [
          buildCheckout({
            resourceId: createId(),
            remote: remote.url,
            branch: kind === "primary" ? null : "test/deadline-preparation",
            setupCommand: "echo deadline-preparation; sleep 60",
          }),
        ],
      });
      const first = await Effect.runPromise(
        makeTestWorkspaces({ storageDir, setupDeadlineMs: 100 }).provision(frame),
      );

      expect(first.status).toBe("failed");
      expect(first.message).toMatch(/still running|deadline/i);
      expect(await Effect.runPromise(makeTestWorkspaces({ storageDir }).provision(frame))).toEqual(
        first,
      );
    },
  );
});
