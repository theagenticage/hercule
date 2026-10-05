/** Tests for the step results store. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { WorkspaceStepKey, WorkspaceStepOutcome } from "@hercule/protocol";
import { cleanTemporaries, createId, createTemporaryDir } from "../workspaces/testing";
import { buildStepName, deleteStepResult, readStepResult, writeStepResult } from "./results";

afterAll(cleanTemporaries);

const OUTCOME: WorkspaceStepOutcome = { status: "completed", output: { text: "done" } };

const buildKey = (): WorkspaceStepKey => ({ runId: createId(), stepId: "implement", iteration: 2 });

describe("step results", () => {
  it("names a step after its run, its step and its iteration", () => {
    const key = buildKey();
    expect(buildStepName(key)).toBe(`${key.runId}-implement-2`);
  });

  it("reads back the result written for a step in a workspace", () => {
    const storage = createTemporaryDir("results-");
    const key = buildKey();
    writeStepResult(storage, "ws-1", key, OUTCOME);
    expect(readStepResult(storage, "ws-1", key)).toEqual(OUTCOME);
    expect(existsSync(join(storage, "step-results", "ws-1", `${buildStepName(key)}.json`))).toBe(
      true,
    );
    // Another workspace's directory holds no result for the step.
    expect(readStepResult(storage, "ws-2", key)).toBeUndefined();
  });

  it("keeps the result of a step with no workspace in a directory no workspace id can name", () => {
    const storage = createTemporaryDir("results-");
    const key = buildKey();
    writeStepResult(storage, null, key, OUTCOME);
    expect(readStepResult(storage, null, key)).toEqual(OUTCOME);
    expect(
      existsSync(join(storage, "step-results", ".no-workspace", `${buildStepName(key)}.json`)),
    ).toBe(true);
  });

  it("reads no result for a step that has none, or whose file does not decode", () => {
    const storage = createTemporaryDir("results-");
    const key = buildKey();
    expect(readStepResult(storage, null, key)).toBeUndefined();
    const directory = join(storage, "step-results", "ws-1");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${buildStepName(key)}.json`), '{"status":"half"}');
    expect(readStepResult(storage, "ws-1", key)).toBeUndefined();
  });

  it("deletes a step's result whether or not the step had a workspace", () => {
    const storage = createTemporaryDir("results-");
    const inWorkspace = buildKey();
    const withoutWorkspace = buildKey();
    writeStepResult(storage, "ws-1", inWorkspace, OUTCOME);
    writeStepResult(storage, null, withoutWorkspace, OUTCOME);
    deleteStepResult(storage, inWorkspace);
    deleteStepResult(storage, withoutWorkspace);
    expect(readStepResult(storage, "ws-1", inWorkspace)).toBeUndefined();
    expect(readStepResult(storage, null, withoutWorkspace)).toBeUndefined();
  });

  it("deletes nothing, and does not fail, when no step has a result yet", () => {
    const storage = createTemporaryDir("results-");
    expect(() => deleteStepResult(storage, buildKey())).not.toThrow();
  });
});
