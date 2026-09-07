import { describe, expect, it } from "vitest";
import type { ProviderInstance, Runner } from "@hydra/contract";
import { providerRows } from "./provider-rows";

const RUNNER: Runner = {
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
    totalMemoryBytes: 68719476736,
    docker: true,
    toolchains: [],
    providers: [
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: false },
    ],
    adapters: ["claude-code"],
    identityPort: 4939,
  },
  watermark: null,
  maxConcurrentSessions: 4,
  lastSeenAt: "2026-09-05T09:14:00.000Z",
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
  providerId: string,
  displayName: string,
  snapshots: ProviderInstance["snapshots"] = [],
): ProviderInstance => ({
  id: `instance-${providerId}`,
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
  fields: Partial<ProviderInstance["snapshots"][number]>,
): ProviderInstance["snapshots"][number] => ({
  runnerId: RUNNER.id,
  probedAt: "2026-09-05T09:10:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
  models: [{ slug: "default", name: "Default", options: [] }],
  ...fields,
});

const only = (runner: Runner, one: ProviderInstance) => providerRows(runner, [one])[0]!;

describe("providerRows", () => {
  it("reads a logged-in harness as what it is holding and what it offers", () => {
    const row = only(RUNNER, instance("claude-code", "Claude Code", [snapshot({})]));

    expect(row).toMatchObject({
      name: "Claude Code",
      version: "2.1.263",
      verdict: null,
      account: "rogier@example.com · Claude Max",
      models: "1 model",
      install: "none",
      logIn: true,
      logInLabel: "Log in again",
      probe: true,
    });
  });

  it("names a version this build was not tested against", () => {
    const row = only(
      RUNNER,
      instance("claude-code", "Claude Code", [
        snapshot({ harnessVersion: "2.0.9", versionVerdict: "below-floor" }),
      ]),
    );

    expect(row.verdict).toMatch(/below/);
  });

  it("offers the install, and no login, for a harness that is not on the machine", () => {
    const row = only(RUNNER, instance("codex", "Codex", []));

    expect(row).toMatchObject({ install: "blocked", logIn: false, version: "not reported" });
    // Dimmed with the reason: the machine already said which providers its
    // build carries an adapter for.
    expect(row.account).toBe("no adapter in this runner build");
  });

  it("offers nothing on a machine that is not holding a connection", () => {
    const row = only(
      { ...RUNNER, connectivity: "offline" },
      instance("claude-code", "Claude Code", [snapshot({})]),
    );

    expect(row).toMatchObject({ install: "none", logIn: false, probe: false });
  });
});
