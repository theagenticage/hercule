/**
 * The floor is the CLI version the compiled-in SDK was built against - the
 * newest version anybody tested, not a policy. It changes only when the
 * dependency changes.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_VERSION, CODEX_VERSION, PI_VERSION } from "@hercule/home/version";
import { findVersionFloor, computeVersionVerdict } from "./version";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("computeVersionVerdict", () => {
  it("returns unknown when there is no version, or no floor to compare it with", () => {
    expect(computeVersionVerdict(null, "2.1.263")).toBe("unknown");
    expect(computeVersionVerdict("1.2.3", null)).toBe("unknown");
    expect(computeVersionVerdict(null, null)).toBe("unknown");
  });

  it("returns below-floor for a version lower than the floor in any component", () => {
    expect(computeVersionVerdict("2.1.262", "2.1.263")).toBe("below-floor");
    expect(computeVersionVerdict("2.0.999", "2.1.263")).toBe("below-floor");
    expect(computeVersionVerdict("1.9.9", "2.1.263")).toBe("below-floor");
    // Numbers rather than text, so 10 comes after 9.
    expect(computeVersionVerdict("2.1.9", "2.1.10")).toBe("below-floor");
  });

  it("returns ok for the floor itself", () => {
    expect(computeVersionVerdict("2.1.263", "2.1.263")).toBe("ok");
  });

  it("returns above-tested-max for any version newer than the floor", () => {
    // Not an error: the pair almost certainly works. It is the accurate label
    // for a runner with a CLI newer than the SDK in this binary.
    expect(computeVersionVerdict("2.1.264", "2.1.263")).toBe("above-tested-max");
    expect(computeVersionVerdict("2.2.0", "2.1.263")).toBe("above-tested-max");
    expect(computeVersionVerdict("3.0.0", "2.1.263")).toBe("above-tested-max");
    expect(computeVersionVerdict("2.10.0", "2.9.0")).toBe("above-tested-max");
  });

  it("returns unknown for a version it cannot parse", () => {
    expect(computeVersionVerdict("nightly", "2.1.263")).toBe("unknown");
    expect(computeVersionVerdict("2.1", "2.1.263")).toBe("unknown");
  });
});

describe("findVersionFloor", () => {
  it("returns the SDK's CLI version for Claude Code, and null for a provider with no pin", () => {
    expect(findVersionFloor("claude-code")).toBe(CLAUDE_CODE_VERSION);
    expect(findVersionFloor("nobody-pinned-this")).toBeNull();
  });

  // pi is pre-1.0 with recorded breaking changes in its RPC mode, so its floor
  // and the newest anyone tested are the same release.
  it("returns the pi release this build was verified against", () => {
    expect(findVersionFloor("pi")).toBe(PI_VERSION);
    expect(PI_VERSION).toBe("0.85.1");
    expect(computeVersionVerdict("0.85.1", findVersionFloor("pi"))).toBe("ok");
    expect(computeVersionVerdict("0.84.3", findVersionFloor("pi"))).toBe("below-floor");
    expect(computeVersionVerdict("0.86.0", findVersionFloor("pi"))).toBe("above-tested-max");
  });

  it("returns the Codex release this build's types were generated from", () => {
    expect(findVersionFloor("codex")).toBe(CODEX_VERSION);
  });

  it("writes the Claude Code floor in one generated file and nowhere else in the source", () => {
    // Fixtures in test files are not the source this rule is about, so they
    // are excluded.
    const found = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'grep -rn "2\\.1\\.[0-9]" apps packages plugins scripts --include=*.ts' +
          ' | grep -v "/version\\.ts:" | grep -vE "\\.(test|testing)\\.ts:" || true',
      ],
      cwd: root,
    }).stdout.toString();

    expect(found.trim()).toBe("");
  });

  it("writes the Codex release only in the generated file and the script that generates it", () => {
    // The pattern is built from the constant rather than written out, so this
    // file is not itself a second place the release is written.
    const [major, minor] = CODEX_VERSION.split(".");
    const found = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `grep -rn "${major ?? ""}\\.${minor ?? ""}\\.[0-9]" apps packages plugins scripts --include=*.ts || true`,
      ],
      cwd: root,
    })
      .stdout.toString()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(0, line.indexOf(":")))
      // Fixtures in test files are not the source this rule is about.
      .filter((path) => !/(\.(test|testing)|\/testing)\.ts$/.test(path));

    expect([...new Set(found)].sort()).toEqual([
      "packages/home/src/version.ts",
      "scripts/gen-version.ts",
    ]);
  });
});
