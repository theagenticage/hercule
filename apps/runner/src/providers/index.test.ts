/**
 * What this runner build carries, and what the session supervisor is handed.
 * The registry is the one place a provider id becomes an adapter, so a provider
 * missing from it reads to the whole product as "no adapter in this build".
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { RunnerToController } from "@hydra/protocol";
import type { Machine } from "../sessions/context";
import { makeWorkspaces } from "../workspaces";
import { supervising } from "../sessions/supervisor";
import { ADAPTER_IDS, adapterFor, adapters } from "./index";

describe("the adapters this runner build carries", () => {
  it("answers for Codex, by the id and the binary name the plugin declares", () => {
    const codex = adapterFor("codex");

    expect(codex?.providerId).toBe("codex");
    expect(codex?.binaryName).toBe("codex");
    expect(ADAPTER_IDS).toContain("codex");
    // The adapter that was there before it is still there.
    expect(ADAPTER_IDS).toContain("claude-code");
  });

  it("puts the Codex adapter on the stream the supervisor relays", async () => {
    const codex = adapterFor("codex");
    // `supervising` merges the events of every adapter it is given, and the
    // runner gives it this array: an adapter outside it publishes to nobody.
    expect(adapters).toContain(codex);

    const sent: Array<RunnerToController> = [];
    // Nothing is started here, so nothing under these paths is made.
    const machine: Machine = {
      providersDir: "/var/hydra/runner/providers",
      scratchDir: "/var/hydra/runner/scratch",
      controllerUrl: "https://controller.example:4938",
      baseEnv: { PATH: "/usr/bin" },
      binaryOf: () => undefined,
      workspaces: makeWorkspaces({ storageDir: "/var/hydra/runner" }),
      socketPath: "/var/hydra/runner/daemon.sock",
    };
    const supervisor = supervising(adapters).forConnection({
      machine,
      send: (frame) => Effect.sync(() => void sent.push(frame)),
    });

    // Reaches every adapter in the array, Codex included, for what it hosts.
    await Effect.runPromise(supervisor.report);
    expect(sent).toHaveLength(1);
  });
});
