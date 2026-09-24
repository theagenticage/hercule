import { describe, expect, it } from "vitest";
import type { Runner } from "@hercule/contract";
import { describeRunnerFacts } from "./runner-facts";

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

describe("describeRunnerFacts", () => {
  it("formats the facts of a runner that has reported", () => {
    expect(describeRunnerFacts(REPORTED)).toEqual({
      machine: "darwin · arm64",
      memory: "64 GiB",
      diskFree: "128 GiB",
      toolchains: "git 2.50.1 · gh 2.99.0",
      providers: "claude · pi",
      docker: "installed",
      binary: "0.4.2",
    });
  });

  it("returns null for every fact when the runner has reported nothing", () => {
    expect(describeRunnerFacts(SILENT)).toEqual({
      machine: null,
      memory: null,
      diskFree: null,
      toolchains: null,
      providers: null,
      docker: null,
      binary: null,
    });
  });

  it("tells a runner that found no provider apart from one that has not reported", () => {
    const none = { ...REPORTED, facts: { ...REPORTED.facts!, providers: [] } };
    expect(describeRunnerFacts(none).providers).toBe("none installed");
    expect(describeRunnerFacts(SILENT).providers).toBeNull();
  });

  it("shows when Docker is not installed", () => {
    expect(
      describeRunnerFacts({ ...REPORTED, facts: { ...REPORTED.facts!, docker: false } }).docker,
    ).toBe("not installed");
  });

  it("returns null for toolchains when the runner found none", () => {
    expect(
      describeRunnerFacts({ ...REPORTED, facts: { ...REPORTED.facts!, toolchains: [] } })
        .toolchains,
    ).toBeNull();
  });

  it("reads free disk space from the watermark, which is reported separately from the facts", () => {
    expect(describeRunnerFacts({ ...REPORTED, watermark: null }).diskFree).toBeNull();
    expect(describeRunnerFacts({ ...REPORTED, watermark: null }).memory).toBe("64 GiB");
  });
});
