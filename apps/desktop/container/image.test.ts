import { describe, expect, it } from "vitest";
import { buildImageName, parsePlatformOption, readImageName, readImageVersions } from "./image.ts";

const versions = { BUN_VERSION: "1.4.4", PNPM_VERSION: "10.12.1", PLAYWRIGHT_VERSION: "1.63.0" };

describe("buildImageName", () => {
  it("names the same inputs the same", () => {
    expect(buildImageName("linux/amd64", "FROM ubuntu", versions)).toBe(
      buildImageName("linux/amd64", "FROM ubuntu", { ...versions }),
    );
  });

  it("names the image of each platform apart, with its architecture in the tag", () => {
    const amd64 = buildImageName("linux/amd64", "FROM ubuntu", versions);
    const arm64 = buildImageName("linux/arm64", "FROM ubuntu", versions);
    expect(amd64).toMatch(/^hercule-desktop-linux:amd64-[0-9a-f]{16}$/);
    expect(arm64).toMatch(/^hercule-desktop-linux:arm64-[0-9a-f]{16}$/);
    expect(amd64.slice(-16)).not.toBe(arm64.slice(-16));
  });

  it.each([
    ["the Dockerfile", "FROM ubuntu:26.04", versions],
    ["Bun", "FROM ubuntu", { ...versions, BUN_VERSION: "1.4.5" }],
    ["pnpm", "FROM ubuntu", { ...versions, PNPM_VERSION: "10.13.0" }],
    [
      "Playwright, which decides the Chromium in the image",
      "FROM ubuntu",
      { ...versions, PLAYWRIGHT_VERSION: "1.64.0" },
    ],
  ])("names another image when %s changes", (_input, dockerfile, changed) => {
    expect(buildImageName("linux/amd64", dockerfile, changed)).not.toBe(
      buildImageName("linux/amd64", "FROM ubuntu", versions),
    );
  });
});

describe("readImageVersions", () => {
  it("reads exact versions from the repository", () => {
    for (const version of Object.values(readImageVersions()))
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readImageName("linux/amd64")).toMatch(/^hercule-desktop-linux:amd64-[0-9a-f]{16}$/);
  });
});

describe("parsePlatformOption", () => {
  it("reads the platform after --platform", () => {
    expect(parsePlatformOption(["--platform", "linux/arm64"])).toBe("linux/arm64");
  });

  it("refuses a platform the image does not build for", () => {
    expect(() => parsePlatformOption(["--platform", "linux/riscv64"])).toThrow(
      "--platform must be linux/amd64 or linux/arm64, not linux/riscv64.",
    );
  });
});
