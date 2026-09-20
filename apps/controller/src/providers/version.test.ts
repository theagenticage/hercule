/**
 * The floor is the CLI version the compiled-in SDK was built against - the
 * newest anybody tested, not a policy. It moves only when the dependency moves.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_VERSION, CODEX_VERSION, PI_VERSION } from "@hercule/home/version";
import { floorFor, versionVerdict } from "./version";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("the verdict on a harness version", () => {
  it("says nothing with no version to read, or no floor to read it against", () => {
    expect(versionVerdict(null, "2.1.263")).toBe("unknown");
    expect(versionVerdict("1.2.3", null)).toBe("unknown");
    expect(versionVerdict(null, null)).toBe("unknown");
  });

  it("reads a version below the floor as below it, on every component", () => {
    expect(versionVerdict("2.1.262", "2.1.263")).toBe("below-floor");
    expect(versionVerdict("2.0.999", "2.1.263")).toBe("below-floor");
    expect(versionVerdict("1.9.9", "2.1.263")).toBe("below-floor");
    // Numbers rather than text, so 10 comes after 9.
    expect(versionVerdict("2.1.9", "2.1.10")).toBe("below-floor");
  });

  it("reads the floor itself as the version to be on", () => {
    expect(versionVerdict("2.1.263", "2.1.263")).toBe("ok");
  });

  it("reads anything past the floor as past what anybody tested", () => {
    // Not a refusal: the pair almost certainly works. It is the honest label
    // for a machine running a CLI newer than the SDK in this binary.
    expect(versionVerdict("2.1.264", "2.1.263")).toBe("above-tested-max");
    expect(versionVerdict("2.2.0", "2.1.263")).toBe("above-tested-max");
    expect(versionVerdict("3.0.0", "2.1.263")).toBe("above-tested-max");
    expect(versionVerdict("2.10.0", "2.9.0")).toBe("above-tested-max");
  });

  it("says nothing about a version it cannot read as one", () => {
    expect(versionVerdict("nightly", "2.1.263")).toBe("unknown");
    expect(versionVerdict("2.1", "2.1.263")).toBe("unknown");
  });
});

describe("the floor each provider is held to", () => {
  it("holds Claude Code to the SDK's CLI version, and a provider nobody pinned to none", () => {
    expect(floorFor("claude-code")).toBe(CLAUDE_CODE_VERSION);
    expect(floorFor("nobody-pinned-this")).toBeNull();
  });

  // pi is pre-1.0 with recorded breaking changes in its RPC mode, so its floor
  // and the newest anyone tested are the same release.
  it("holds pi to the release this build was verified against", () => {
    expect(floorFor("pi")).toBe(PI_VERSION);
    expect(PI_VERSION).toBe("0.85.1");
    expect(versionVerdict("0.85.1", floorFor("pi"))).toBe("ok");
    expect(versionVerdict("0.84.3", floorFor("pi"))).toBe("below-floor");
    expect(versionVerdict("0.86.0", floorFor("pi"))).toBe("above-tested-max");
  });

  it("holds Codex to the release this build's types were generated from", () => {
    expect(floorFor("codex")).toBe(CODEX_VERSION);
  });

  it("is written down in one generated file and nowhere else in the source", () => {
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

  it("writes the Codex release down in the generated file and the script that writes it", () => {
    // Built from the constant rather than spelled out, so this file is not
    // itself a second place the release is written down.
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
