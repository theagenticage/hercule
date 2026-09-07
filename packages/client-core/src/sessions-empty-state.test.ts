import { describe, expect, it } from "vitest";
import type { ProviderInstance, Runner } from "@hydra/contract";
import { sessionsEmptyState } from "./sessions-empty-state";

const GIB = 1024 * 1024 * 1024;

/** The machine this browser is on, with nothing installed on it yet. */
const BARE: Runner = {
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "moss",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.4.2",
  labels: [],
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 64 * GIB,
    docker: true,
    toolchains: [],
    providers: [
      { name: "claude", present: false },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ],
    adapters: ["claude-code"],
    identityPort: 4939,
  },
  watermark: null,
  maxConcurrentSessions: 4,
  lastSeenAt: "2026-09-05T09:14:00.000Z",
};

/** The same machine with the Claude harness on it. */
const WITH_CLAUDE: Runner = {
  ...BARE,
  facts: {
    ...BARE.facts!,
    providers: [
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ],
  },
};

const DECLARED: ProviderInstance["declared"] = {
  steering: "native",
  fork: "native",
  modelSwitch: "in-session",
  accessModes: {
    "approval-required": "native",
    "auto-accept-edits": "native",
    auto: "native",
    "full-access": "native",
  },
  mcpPassthrough: "native",
  disallowedTools: "native",
  structuredOutput: "supported",
};

const instance = (
  id: string,
  providerId: string,
  displayName: string,
  snapshots: ProviderInstance["snapshots"] = [],
): ProviderInstance => ({
  id,
  providerId,
  name: displayName,
  config: {},
  displayName,
  declared: DECLARED,
  snapshots,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

const snapshot = (
  runnerId: string,
  auth: ProviderInstance["snapshots"][number]["auth"],
): ProviderInstance["snapshots"][number] => ({
  runnerId,
  probedAt: "2026-09-05T09:10:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth,
  models: [{ slug: "default", name: "Default", options: [] }],
});

const CLAUDE = "01a06d02-1000-7000-8000-000000000001";
const CODEX = "01a06d02-1000-7000-8000-000000000002";

/** A machine that has the harness and has never been logged in on it. */
const waiting = instance(CLAUDE, "claude-code", "Claude Code", [
  snapshot(BARE.id, { status: "unauthenticated" }),
]);

/** The same instance, logged in. */
const loggedIn = instance(CLAUDE, "claude-code", "Claude Code", [
  snapshot(BARE.id, { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" }),
]);

/** A provider this runner build cannot drive at all. */
const undrivable = instance(CODEX, "codex", "Codex", [
  snapshot(BARE.id, {
    status: "error",
    message: "no adapter for codex in this runner build",
  }),
]);

describe("sessionsEmptyState", () => {
  it("has nothing to offer when no runner answered on this machine", () => {
    expect(sessionsEmptyState(null, [waiting])).toEqual({ kind: "no-runner" });
  });

  it("reads a local runner that is not connected as no runner at all", () => {
    // The screen offers a login, and a login runs on the machine: a row that
    // says `offline` can no more be logged in to than one that is absent.
    expect(sessionsEmptyState({ ...WITH_CLAUDE, connectivity: "offline" }, [waiting])).toEqual({
      kind: "no-runner",
    });
  });

  it("says the machine has no harness when it reported none", () => {
    expect(sessionsEmptyState(BARE, [waiting, undrivable])).toEqual({ kind: "no-harness" });
  });

  it("offers a login for every harness that is there and not logged in", () => {
    expect(sessionsEmptyState(WITH_CLAUDE, [waiting, undrivable])).toEqual({
      kind: "log-in",
      instances: [waiting],
    });
  });

  it("still offers the login when the last probe of a harness that is here failed", () => {
    // A probe that timed out says nothing about whether the harness can be
    // logged in, and telling the user to install what is already there would
    // send them nowhere.
    const stale = instance(CLAUDE, "claude-code", "Claude Code", [
      snapshot(BARE.id, { status: "error", message: "the harness did not answer within 15s" }),
    ]);
    expect(sessionsEmptyState(WITH_CLAUDE, [stale])).toEqual({
      kind: "log-in",
      instances: [stale],
    });
  });

  it("is ready once one instance on this machine is logged in", () => {
    expect(sessionsEmptyState(WITH_CLAUDE, [loggedIn])).toEqual({
      kind: "ready",
      name: "Claude Code",
    });
  });

  it("is ready even when another instance is still waiting for a login", () => {
    // One usable harness is what the screen is about; the rest is Fleet's
    // business, and a "log in" headline over a working install reads as broken.
    const second = instance(CODEX, "codex", "Codex", [
      snapshot(BARE.id, { status: "unauthenticated" }),
    ]);
    expect(sessionsEmptyState(WITH_CLAUDE, [second, loggedIn])).toEqual({
      kind: "ready",
      name: "Claude Code",
    });
  });
});
