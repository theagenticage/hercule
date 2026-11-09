import { describe, expect, it } from "vitest";
import { buildImageName, readImageName, readImageVersions } from "./image.ts";

const versions = { BUN_VERSION: "1.4.4", PNPM_VERSION: "10.12.1", PLAYWRIGHT_VERSION: "1.63.0" };

describe("buildImageName", () => {
  it("names the same inputs the same", () => {
    expect(buildImageName("FROM ubuntu", versions)).toBe(
      buildImageName("FROM ubuntu", { ...versions }),
    );
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
    expect(buildImageName(dockerfile, changed)).not.toBe(buildImageName("FROM ubuntu", versions));
  });
});

describe("readImageVersions", () => {
  it("reads exact versions from the repository", () => {
    for (const version of Object.values(readImageVersions()))
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readImageName()).toMatch(/^hercule-desktop-linux:[0-9a-f]{16}$/);
  });
});
