/**
 * The verdict the controller puts on a harness version a runner reported.
 *
 * The floor is a compatibility number, not a policy: the SDK compiled into this
 * binary talks to the CLI it was built against and to anything newer, so the
 * floor is that CLI's version and it is also the newest one anybody has tested.
 * It moves when the dependency moves, which is a reviewed change - so this file
 * also states that the number lives in one generated place and is written down
 * nowhere else in the source.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_VERSION } from "@hydra/home/version";
import { floorFor, versionVerdict } from "./version";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe("the verdict on a harness version", () => {
  it("says nothing about a machine that never reported a version", () => {
    expect(versionVerdict(null, "2.1.263")).toBe("unknown");
  });

  it("says nothing about a provider nobody has pinned a floor for", () => {
    // Codex and pi have no adapter in this build and no tested version, so a
    // version they report is a fact with nothing to compare it against.
    expect(versionVerdict("1.2.3", null)).toBe("unknown");
    expect(versionVerdict(null, null)).toBe("unknown");
  });

  it("reads a version below the floor as below it, on every component", () => {
    expect(versionVerdict("2.1.262", "2.1.263")).toBe("below-floor");
    expect(versionVerdict("2.0.999", "2.1.263")).toBe("below-floor");
    expect(versionVerdict("1.9.9", "2.1.263")).toBe("below-floor");
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
  });

  it("says nothing about a version it cannot read as one", () => {
    // What `--version` prints is the binary's business, so an answer nobody can
    // compare is a fact with nothing to compare it against rather than a
    // machine refused.
    expect(versionVerdict("nightly", "2.1.263")).toBe("unknown");
    expect(versionVerdict("2.1", "2.1.263")).toBe("unknown");
  });

  it("compares numbers rather than text, so 10 comes after 9", () => {
    expect(versionVerdict("2.1.9", "2.1.10")).toBe("below-floor");
    expect(versionVerdict("2.10.0", "2.9.0")).toBe("above-tested-max");
  });
});

describe("the floor each provider is held to", () => {
  it("holds Claude Code to the CLI version the compiled-in SDK was built against", () => {
    expect(floorFor("claude-code")).toBe(CLAUDE_CODE_VERSION);
  });

  it("holds the providers with no adapter to nothing", () => {
    expect(floorFor("codex")).toBeNull();
    expect(floorFor("pi")).toBeNull();
  });

  it("is written down in one generated file and nowhere else in the source", () => {
    // A second copy is a number that silently stops matching the dependency the
    // day the dependency moves. Fixtures, whether in a test file or in one a
    // test reads, are not the source the rule is about, so they are excluded
    // rather than counted.
    const found = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'grep -rn "2\\.1\\.[0-9]" apps packages plugins scripts --include=*.ts' +
          ' | grep -v "/version\\.ts:" | grep -vE "\\.(test|fixture)\\.ts:" || true',
      ],
      cwd: root,
    }).stdout.toString();

    expect(found.trim()).toBe("");
  });
});
