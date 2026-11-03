import { describe, expect, it } from "vitest";
import { compareReleaseVersions } from "./versions";

describe("compareReleaseVersions", () => {
  it("compares the three numbers as numbers, not as text", () => {
    expect(compareReleaseVersions("0.9.3", "0.10.0")).toBe(-1);
    expect(compareReleaseVersions("0.10.0", "0.9.3")).toBe(1);
    expect(compareReleaseVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareReleaseVersions("1.2.3", "1.2.10")).toBe(-1);
    expect(compareReleaseVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("keeps a number longer than a safe integer exact", () => {
    expect(compareReleaseVersions("1.0.9007199254740993", "1.0.9007199254740992")).toBe(1);
  });

  it("ignores a leading v and build metadata", () => {
    expect(compareReleaseVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareReleaseVersions("1.2.3+aaaa", "1.2.3+bbbb")).toBe(0);
    expect(compareReleaseVersions("1.2.3+zzz", "1.2.4+aaa")).toBe(-1);
    expect(compareReleaseVersions("1.2.3-rc.1+build.5", "1.2.3-rc.1")).toBe(0);
  });

  it("ranks a pre-release below its release", () => {
    expect(compareReleaseVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareReleaseVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareReleaseVersions("1.0.0-rc.1", "0.9.9")).toBe(1);
  });

  it("orders the pre-release examples of the semantic-versioning specification", () => {
    const ascending = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let index = 1; index < ascending.length; index += 1) {
      expect(compareReleaseVersions(ascending[index - 1]!, ascending[index]!)).toBe(-1);
      expect(compareReleaseVersions(ascending[index]!, ascending[index - 1]!)).toBe(1);
    }
  });

  it("returns undefined when either version does not parse", () => {
    for (const version of [
      "go1.25",
      "2.43",
      "edge",
      "",
      "1.2.3.4",
      "1.2.3-",
      "1.2.3 (Claude Code)",
    ]) {
      expect(compareReleaseVersions(version, "1.2.3")).toBeUndefined();
      expect(compareReleaseVersions("1.2.3", version)).toBeUndefined();
    }
  });
});
