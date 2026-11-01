import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAgentFolder } from "./agent-folder";

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
