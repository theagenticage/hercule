import { makeWorkspaces } from "../workspaces";
/**
 * Tests which adapters this runner build includes, and which the session
 * supervisor receives. The registry is the only place a provider id becomes an
 * adapter, so a provider missing from it shows up everywhere in the product as
 * "no adapter in this build".
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Scope } from "effect";
import type { RunnerToController } from "@hercule/protocol";
import type { Machine } from "../sessions/context";

import { makeSupervising } from "../sessions/supervisor";
import { ADAPTER_IDS, findAdapter, adapters } from "./index";
import { makeAttachmentCache } from "../attachments";

describe("the adapters in this runner build", () => {
  it("finds Codex by the provider id and binary name its plugin declares", () => {
    const codex = findAdapter("codex");

    expect(codex?.providerId).toBe("codex");
    expect(codex?.binaryName).toBe("codex");
    expect(ADAPTER_IDS).toContain("codex");
    // The existing Claude Code adapter is still registered.
    expect(ADAPTER_IDS).toContain("claude-code");
  });

  it("includes the Codex adapter in the events the supervisor forwards", async () => {
    const codex = findAdapter("codex");
    // `makeSupervising` merges the events of every adapter it is given, and the
    // runner gives it this array. An adapter missing from the array would have
    // no subscriber.
    expect(adapters).toContain(codex);

    const sent: Array<RunnerToController> = [];
    // Nothing is started, so none of these paths are created.
    const scope = Effect.runSync(Scope.make());
    const machine: Machine = {
      providersDir: "/var/hercule/runner/providers",
      scratchDir: "/var/hercule/runner/scratch",
      attachmentsDir: "/var/hercule/runner/attachments",
      attachments: makeAttachmentCache({
        controllerUrl: "https://controller.example:4938",
        credential: "test",
      }),
      binDir: "/var/hercule/runner/bin",
      herculeTool: { skill: "", claudePluginDir: "/var/hercule/runner/storage/claude-plugin" },
      controllerUrl: "https://controller.example:4938",
      baseEnv: { PATH: "/usr/bin" },
      findBinary: () => undefined,
      workspaces: Effect.runSync(
        makeWorkspaces({ storageDir: "/var/hercule/runner" }).pipe(Scope.provide(scope)),
      ),
      socketPath: "/var/hercule/runner/daemon.sock",
    };
    const supervisor = makeSupervising(adapters).forConnection({
      scope,
      machine,
      send: (frame) => Effect.sync(() => void sent.push(frame)),
      // No session runs, so no agent step begins.
      workspaceSteps: {
        beginAgentStep: () => Effect.succeed(true),
        finishAgentStep: () => Effect.void,
        forgetAgentStep: () => undefined,
      },
    });

    // The report asks every adapter in the array, Codex included, for its sessions.
    await Effect.runPromise(supervisor.report.pipe(Effect.ensuring(Scope.close(scope, Exit.void))));
    expect(sent).toHaveLength(1);
  });
});

describe("the pi adapter in this runner build", () => {
  it("finds pi by the provider id and binary name its plugin declares", () => {
    const pi = findAdapter("pi");

    expect(pi?.providerId).toBe("pi");
    expect(pi?.binaryName).toBe("pi");
    expect(ADAPTER_IDS).toContain("pi");
    // The existing adapters are still registered.
    expect(ADAPTER_IDS).toContain("claude-code");
    expect(ADAPTER_IDS).toContain("codex");
    // An adapter missing from this array would have no subscriber for its events.
    expect(adapters).toContain(pi);
  });

  it("can install the harness on a machine that does not have it", () => {
    expect(findAdapter("pi")?.install).toBeDefined();
  });
});
