/**
 * `computeThreadDefaults` is the one rule the composer and Settings > Threads both
 * prefill a new thread from, and `computeInstanceDefaults` is the runner-then-model
 * order it resolves in. What matters here: a stored setting always wins, a
 * stale instance id falls back, the model is read from the runner the thread
 * would actually be placed on, and nothing picked is `null` rather than "".
 */
import { describe, expect, it } from "vitest";
import type { Profile, ProviderInstance, Runner, SettingsState } from "@hercule/contract";
import { BARE, buildInstance, buildSnapshot } from "../providers.testing";
import { computeInstanceDefaults, computeThreadDefaults } from "./thread-defaults";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

const LOCAL = buildRunner({ id: "r-local", name: "moss" });
const REMOTE = buildRunner({ id: "r-remote", name: "cove" });

const buildProfile = (id: string, name: string): Profile => ({
  id,
  name,
  grants: [],
  shipped: true,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

const UNRESTRICTED = buildProfile("p-unrestricted", "unrestricted");
const WORKER = buildProfile("p-worker", "worker");

/** One instance, logged in on `runnerId` with the models given. */
const buildSnapshotOn = (
  runnerId: string,
  models: ProviderInstance["snapshots"][number]["models"],
): ProviderInstance["snapshots"][number] => buildSnapshot({ runnerId, models });

const SONNET = { slug: "claude-sonnet-5", name: "Sonnet", isDefault: true, options: [] };
const OPUS = { slug: "claude-opus-5", name: "Opus", options: [] };
const HAIKU = { slug: "claude-haiku-5", name: "Haiku", options: [] };

const NO_SETTINGS: SettingsState["user"] = {};

describe("computeInstanceDefaults", () => {
  it("resolves the runner first and reads the model from that runner's own catalog", () => {
    // The local machine is not logged in, so the thread lands on the remote
    // one - and the model must come from the remote one's catalog, not from
    // whichever snapshot happens to be first.
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [SONNET] }),
      buildSnapshotOn(REMOTE.id, [HAIKU]),
    ]);

    expect(computeInstanceDefaults(claude, [LOCAL, REMOTE], LOCAL.id)).toEqual({
      runnerId: REMOTE.id,
      model: "claude-haiku-5",
    });
  });

  it("prefers the local runner and the catalog's own default model", () => {
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshotOn(REMOTE.id, [HAIKU]),
      buildSnapshotOn(LOCAL.id, [OPUS, SONNET]),
    ]);

    expect(computeInstanceDefaults(claude, [LOCAL, REMOTE], LOCAL.id)).toEqual({
      runnerId: LOCAL.id,
      model: "claude-sonnet-5",
    });
  });

  it("falls back to the catalog's first model when none is marked default", () => {
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshotOn(LOCAL.id, [OPUS, HAIKU]),
    ]);

    expect(computeInstanceDefaults(claude, [LOCAL], LOCAL.id).model).toBe("claude-opus-5");
  });

  it("has no runner and no model when no runner is logged in to the instance", () => {
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [SONNET] }),
    ]);

    expect(computeInstanceDefaults(claude, [LOCAL], LOCAL.id)).toEqual({
      runnerId: null,
      model: null,
    });
  });
});

describe("computeThreadDefaults", () => {
  const claude = buildInstance("claude-code", "Claude Code", [
    buildSnapshotOn(LOCAL.id, [SONNET, OPUS]),
  ]);
  const codex = buildInstance("codex", "Codex", [buildSnapshotOn(LOCAL.id, [HAIKU])]);

  it("prefills from the shipped fallbacks when no thread setting is stored", () => {
    expect(
      computeThreadDefaults(
        NO_SETTINGS,
        [claude, codex],
        [LOCAL],
        [UNRESTRICTED, WORKER],
        LOCAL.id,
      ),
    ).toEqual({
      instanceId: claude.id,
      model: "claude-sonnet-5",
      accessMode: "approval-required",
      runnerId: LOCAL.id,
      profileId: UNRESTRICTED.id,
    });
  });

  it("lets every stored thread setting win over the fallback", () => {
    const stored: SettingsState["user"] = {
      "thread.instanceId": codex.id,
      "thread.model": "claude-haiku-5",
      "thread.accessMode": "full-access",
      "thread.profileId": WORKER.id,
    };

    expect(
      computeThreadDefaults(stored, [claude, codex], [LOCAL], [UNRESTRICTED, WORKER], LOCAL.id),
    ).toEqual({
      instanceId: codex.id,
      model: "claude-haiku-5",
      accessMode: "full-access",
      runnerId: LOCAL.id,
      profileId: WORKER.id,
    });
  });

  it("falls back to the shipped instance when the stored id names none, rather than leaving nothing picked", () => {
    const stale: SettingsState["user"] = { "thread.instanceId": "instance-that-went-away" };

    expect(
      computeThreadDefaults(stale, [claude, codex], [LOCAL], [UNRESTRICTED], LOCAL.id).instanceId,
    ).toBe(claude.id);
  });

  it("keeps a stored model the resolved runner does not offer, rather than swapping it silently", () => {
    const stored: SettingsState["user"] = { "thread.model": "claude-haiku-5" };

    expect(computeThreadDefaults(stored, [claude], [LOCAL], [UNRESTRICTED], LOCAL.id).model).toBe(
      "claude-haiku-5",
    );
  });

  it("takes the first profile when none is named unrestricted", () => {
    expect(
      computeThreadDefaults(NO_SETTINGS, [claude], [LOCAL], [WORKER], LOCAL.id).profileId,
    ).toBe(WORKER.id);
  });

  it("is null all the way down when nothing exists to pick", () => {
    expect(computeThreadDefaults(NO_SETTINGS, [], [], [], null)).toEqual({
      instanceId: null,
      model: null,
      accessMode: "approval-required",
      runnerId: null,
      profileId: null,
    });
  });
});
