import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createAgentFolder, makeModelFilesWriter } from "./agent-folder";
import { cleanupHomes, createPiHome } from "./testing";

describe("a private agent folder", () => {
  it("is readable by this user only", () => {
    const folder = createAgentFolder();
    try {
      expect(statSync(folder.path).mode & 0o777).toBe(0o700);
    } finally {
      folder.discard();
    }
  });

  it("stays until every process that borrowed it has released it", () => {
    const folder = createAgentFolder();
    const releaseRoot = folder.borrow();
    const releaseSubagent = folder.borrow();

    releaseRoot();
    expect(existsSync(folder.path)).toBe(true);
    releaseSubagent();
    expect(existsSync(folder.path)).toBe(false);
  });

  it("refuses a borrow once it is removed", () => {
    const folder = createAgentFolder();
    folder.borrow()();

    expect(() => folder.borrow()).toThrow("already removed");
  });

  it("is removed at once when a launch discards it before any process borrowed it", () => {
    const folder = createAgentFolder();

    folder.discard();

    expect(existsSync(folder.path)).toBe(false);
  });
});

describe("the model files writer", () => {
  // No catalog models, so the writer never starts pi.
  const write = makeModelFilesWriter(() => {
    throw new Error("pi must not start");
  });

  const writeInto = (home: string): { folder: string; discard: () => void } => {
    const folder = createAgentFolder();
    Effect.runSync(write(folder.path, "pi", { home, modelArgument: "openrouter/x" }, {}));
    return { folder: folder.path, discard: folder.discard };
  };

  it("makes the tools the home holds visible in the folder", () => {
    const home = createPiHome();
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "fd"), "#!/bin/sh\n");
    const { folder, discard } = writeInto(home);
    try {
      expect(existsSync(join(folder, "bin", "fd"))).toBe(true);
    } finally {
      discard();
      cleanupHomes();
    }
  });

  it("leaves the tools folder out when the home has none", () => {
    const home = createPiHome();
    const { folder, discard } = writeInto(home);
    try {
      expect(existsSync(join(folder, "bin"))).toBe(false);
    } finally {
      discard();
      cleanupHomes();
    }
  });

  it("keeps the home's tools when the folder is removed", () => {
    const home = createPiHome();
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "fd"), "#!/bin/sh\n");
    const { discard } = writeInto(home);
    discard();
    try {
      expect(existsSync(join(home, "bin", "fd"))).toBe(true);
    } finally {
      cleanupHomes();
    }
  });
});
