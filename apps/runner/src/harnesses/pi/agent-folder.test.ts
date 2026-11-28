import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeRecordedFolders, sweepRecordedFolders } from "../../recorded-folders";
import { unrecordedFolders } from "../../recorded-folders.testing";
import { createAgentFolder, makeModelFilesBuilder, removeAgentFolder } from "./agent-folder";
import { cleanupHomes, createPiHome } from "./testing";

describe("a private agent folder", () => {
  const NO_FILES = { store: undefined, modelsText: undefined, toolsFolder: undefined };

  it("is readable by this user only", () => {
    const folder = createAgentFolder(unrecordedFolders, NO_FILES);
    try {
      expect(statSync(folder).mode & 0o777).toBe(0o700);
    } finally {
      removeAgentFolder(unrecordedFolders, folder);
    }
  });

  it("is a new folder each time", () => {
    const first = createAgentFolder(unrecordedFolders, NO_FILES);
    const second = createAgentFolder(unrecordedFolders, NO_FILES);

    expect(second).not.toBe(first);
    removeAgentFolder(unrecordedFolders, first);
    expect(existsSync(second)).toBe(true);
    removeAgentFolder(unrecordedFolders, second);
  });

  it("is recorded, so the next start of a runner that crashed removes it", async () => {
    const recordsDir = mkdtempSync(join(tmpdir(), "hercule-pi-records-"));
    try {
      const folder = createAgentFolder(makeRecordedFolders(recordsDir), NO_FILES);
      expect(readdirSync(recordsDir)).toHaveLength(1);

      await Effect.runPromise(sweepRecordedFolders(recordsDir));

      expect(existsSync(folder)).toBe(false);
    } finally {
      rmSync(recordsDir, { recursive: true, force: true });
    }
  });

  it("is removed with what is in it", () => {
    const folder = createAgentFolder(unrecordedFolders, { ...NO_FILES, modelsText: "{}" });

    removeAgentFolder(unrecordedFolders, folder);

    expect(existsSync(folder)).toBe(false);
  });
});

describe("the model files", () => {
  // No catalog models, so the builder never starts pi.
  const build = makeModelFilesBuilder(() => {
    throw new Error("pi must not start");
  });

  const createFolderFor = (home: string): string =>
    createAgentFolder(
      unrecordedFolders,
      Effect.runSync(build("pi", { home, modelArgument: "openrouter/x" }, {})),
    );

  it("makes the tools the home holds visible in the folder", () => {
    const home = createPiHome();
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "fd"), "#!/bin/sh\n");
    const folder = createFolderFor(home);
    try {
      expect(existsSync(join(folder, "bin", "fd"))).toBe(true);
    } finally {
      removeAgentFolder(unrecordedFolders, folder);
      cleanupHomes();
    }
  });

  it("leaves the tools folder out when the home has none", () => {
    const home = createPiHome();
    const folder = createFolderFor(home);
    try {
      expect(existsSync(join(folder, "bin"))).toBe(false);
    } finally {
      removeAgentFolder(unrecordedFolders, folder);
      cleanupHomes();
    }
  });

  it("keeps the home's tools when the folder is removed", () => {
    const home = createPiHome();
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "fd"), "#!/bin/sh\n");
    removeAgentFolder(unrecordedFolders, createFolderFor(home));
    try {
      expect(existsSync(join(home, "bin", "fd"))).toBe(true);
    } finally {
      cleanupHomes();
    }
  });

  it("writes the same files into every folder, whatever happened to the home since", () => {
    const home = createPiHome();
    writeFileSync(join(home, "models.json"), '{"providers":{}}');
    const files = Effect.runSync(build("pi", { home, modelArgument: "openrouter/x" }, {}));
    const first = createAgentFolder(unrecordedFolders, files);
    writeFileSync(join(home, "models.json"), "CHANGED");
    const second = createAgentFolder(unrecordedFolders, files);
    try {
      expect(readFileSync(join(first, "models.json"), "utf8")).toBe('{"providers":{}}');
      expect(readFileSync(join(second, "models.json"), "utf8")).toBe('{"providers":{}}');
    } finally {
      removeAgentFolder(unrecordedFolders, first);
      removeAgentFolder(unrecordedFolders, second);
      cleanupHomes();
    }
  });
});
