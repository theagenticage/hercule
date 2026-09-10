import { describe, expect, it } from "vitest";
import type { Runner } from "@hydra/contract";
import { runnerFactsReading } from "./runner-facts";

const GIB = 1024 * 1024 * 1024;

const SILENT: Runner = {
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "moss",
  connectivity: "offline",
  lifecycle: "active",
  reserved: false,
  version: null,
  labels: [],
  facts: null,
  watermark: null,
  maxConcurrentSessions: 1,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: null,
};

const REPORTED: Runner = {
  ...SILENT,
  connectivity: "online",
  version: "0.4.2",
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 64 * GIB,
    docker: true,
    toolchains: [
      { name: "git", version: "2.50.1", path: "/usr/bin/git" },
      { name: "gh", version: "2.99.0", path: "/opt/homebrew/bin/gh" },
    ],
    providers: [
      { name: "claude", present: true },
      { name: "codex", present: false },
      { name: "pi", present: true },
    ],
    adapters: ["claude-code"],
    identityPort: 4939,
  },
  watermark: {
    diskFreeBytes: 128 * GIB,
    availableMemoryBytes: 32 * GIB,
  },
};

describe("runnerFactsReading", () => {
  it("reads a machine that has reported", () => {
    expect(runnerFactsReading(REPORTED)).toEqual({
      machine: "darwin · arm64",
      memory: "64 GiB",
      diskFree: "128 GiB",
      toolchains: "git 2.50.1 · gh 2.99.0",
      providers: "claude · pi",
      docker: "installed",
      binary: "0.4.2",
    });
  });

  it("reads every fact as absent when the machine has said nothing", () => {
    expect(runnerFactsReading(SILENT)).toEqual({
      machine: null,
      memory: null,
      diskFree: null,
      toolchains: null,
      providers: null,
      docker: null,
      binary: null,
    });
  });

  it("tells a machine that found no provider from one that has not looked", () => {
    const none = { ...REPORTED, facts: { ...REPORTED.facts!, providers: [] } };
    expect(runnerFactsReading(none).providers).toBe("none installed");
    expect(runnerFactsReading(SILENT).providers).toBeNull();
  });

  it("says so when Docker is not installed", () => {
    expect(
      runnerFactsReading({ ...REPORTED, facts: { ...REPORTED.facts!, docker: false } }).docker,
    ).toBe("not installed");
  });

  it("has nothing to say about a machine that probed no toolchain", () => {
    expect(
      runnerFactsReading({ ...REPORTED, facts: { ...REPORTED.facts!, toolchains: [] } }).toolchains,
    ).toBeNull();
  });

  it("reads the disk off the watermark, which arrives apart from the facts", () => {
    expect(runnerFactsReading({ ...REPORTED, watermark: null }).diskFree).toBeNull();
    expect(runnerFactsReading({ ...REPORTED, watermark: null }).memory).toBe("64 GiB");
  });
});
