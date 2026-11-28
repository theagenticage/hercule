/**
 * Integration tests for a workflow's `entity` input, driven over HTTP against
 * a real controller with real External Entity rows:
 *
 * - saving: a workflow holds at most one entity input;
 * - `run.start`: the value must be the External Ref of a known External
 *   Entity of a listed kind, and a signal id never fills an entity input nor
 *   does a ref fill a signal input;
 * - `run.rerun` in both modes keeps the ref the run started with.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mintUuid, withTransaction } from "../db";
import { post, readErrorBody, type ServerHarness } from "../http/testing";
import { createWorkflowOrFail, withSetUpController } from "../workflows/testing";
import {
  buildCreateStep,
  countRuns,
  readRun,
  requestRun,
  startRun,
  waitForRunToFinish,
} from "./testing";

const PULL_REQUEST_REF = "acme:pull-request:northwind/api#7";
const ISSUE_REF = "acme:issue:northwind/api#8";

/** Writes the External Entity row of `ref`, of the qualified kind `kind`. */
const insertEntity = (harness: ServerHarness, ref: string, kind: string): Promise<void> => {
  const now = new Date().toISOString();
  return Effect.runPromise(
    Effect.asVoid(
      Effect.orDie(
        withTransaction(
          harness.sql,
          harness.sql`
          INSERT INTO external_entities
            (id, ref, kind, noun, completeness, title, first_observed_at, updated_at)
          VALUES (${mintUuid()}, ${ref}, ${kind}, 'Item', 'full', 'Retry failed webhooks',
                  ${now}, ${now})`,
        ),
      ),
    ),
  );
};

/** Returns a workflow definition with the given inputs and one step that files a task. */
const buildDefinition = (name: string, inputs: ReadonlyArray<object>) => ({
  name,
  inputs,
  steps: [buildCreateStep("file")],
});

const PULL_REQUEST_INPUT = {
  name: "item",
  entity: { kinds: ["acme/pull-request"] },
  required: true,
};

describe("saving a workflow with entity inputs", () => {
  it("refuses a second entity input at its own path, and says to keep one", async () => {
    await withSetUpController(async ({ base, token }) => {
      const response = await post(
        base,
        "/api/v1/workflows",
        {
          definition: buildDefinition("Two entities", [
            PULL_REQUEST_INPUT,
            { name: "other", entity: { kinds: ["acme/issue"] }, required: false },
          ]),
        },
        token,
      );

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.issues).toEqual([["inputs", "1", "entity"]]);
      expect(refusal.text).toContain("Keep one entity input");
    });
  });
});

describe("run.start of a workflow with an entity input", () => {
  it("starts a run for the ref of a known entity of a listed kind, and the run keeps the ref", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      await insertEntity(harness, PULL_REQUEST_REF, "acme/pull-request");
      const workflow = await createWorkflowOrFail(base, token, {
        definition: buildDefinition("Review a pull request", [PULL_REQUEST_INPUT]),
      });

      const runId = await startRun(base, token, workflow.id, {
        inputs: { item: PULL_REQUEST_REF },
      });

      expect((await readRun(base, token, runId)).inputs).toEqual({ item: PULL_REQUEST_REF });
    });
  });

  it("refuses a ref no entity has, an entity of another kind, and an id, each naming the kinds the input takes", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      await insertEntity(harness, ISSUE_REF, "acme/issue");
      const workflow = await createWorkflowOrFail(base, token, {
        definition: buildDefinition("Review a pull request", [PULL_REQUEST_INPUT]),
      });

      for (const [value, message] of [
        ["acme:pull-request:northwind/api#404", "No External Entity has this ref"],
        [ISSUE_REF, "This entity is of kind acme/issue"],
        ["0199e0e7-9999-7000-8000-000000000000", "No External Entity has this ref"],
        [42, "No External Entity has this ref"],
      ] as const) {
        const response = await requestRun(base, token, workflow.id, { inputs: { item: value } });
        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.issues).toEqual([["inputs", "item"]]);
        expect(refusal.text).toContain(message);
        expect(refusal.text).toContain("acme/pull-request");
      }
      expect(await countRuns(harness)).toBe(0);
    });
  });

  it("never lets a ref fill a signal input", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      await insertEntity(harness, PULL_REQUEST_REF, "acme/pull-request");
      const workflow = await createWorkflowOrFail(base, token, {
        definition: buildDefinition("Answer a signal", [
          { name: "signal", signal: { kinds: ["acme/review-requested"] }, required: true },
        ]),
      });

      const response = await requestRun(base, token, workflow.id, {
        inputs: { signal: PULL_REQUEST_REF },
      });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.text).toContain("No signal has this id");
      expect(await countRuns(harness)).toBe(0);
    });
  });
});

describe("run.rerun of a run with an entity input", () => {
  it("starts the new run with the ref the original run froze, in both modes", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      await insertEntity(harness, PULL_REQUEST_REF, "acme/pull-request");
      const workflow = await createWorkflowOrFail(base, token, {
        definition: buildDefinition("Review a pull request", [PULL_REQUEST_INPUT]),
      });
      const originalId = await startRun(base, token, workflow.id, {
        inputs: { item: PULL_REQUEST_REF },
      });
      await waitForRunToFinish(base, token, originalId);

      for (const mode of ["re-stamp", "replay"] as const) {
        const response = await post(base, `/api/v1/runs/${originalId}/rerun`, { mode }, token);
        expect(response.status, await response.clone().text()).toBe(200);
        const { runId } = (await response.json()) as { runId: string };
        expect((await readRun(base, token, runId)).inputs).toEqual({ item: PULL_REQUEST_REF });
      }
    });
  });
});

describe("run.rerun after the entity was pruned", () => {
  it("starts the new run with the same ref in both modes, because the run froze the ref", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      await insertEntity(harness, PULL_REQUEST_REF, "acme/pull-request");
      const workflow = await createWorkflowOrFail(base, token, {
        definition: buildDefinition("Review a pull request", [PULL_REQUEST_INPUT]),
      });
      const originalId = await startRun(base, token, workflow.id, {
        inputs: { item: PULL_REQUEST_REF },
      });
      await waitForRunToFinish(base, token, originalId);
      await Effect.runPromise(
        Effect.asVoid(
          Effect.orDie(
            withTransaction(
              harness.sql,
              harness.sql`DELETE FROM external_entities WHERE ref = ${PULL_REQUEST_REF}`,
            ),
          ),
        ),
      );

      const fresh = await requestRun(base, token, workflow.id, {
        inputs: { item: PULL_REQUEST_REF },
      });
      expect(fresh.status).toBe(400);
      for (const mode of ["re-stamp", "replay"] as const) {
        const response = await post(base, `/api/v1/runs/${originalId}/rerun`, { mode }, token);
        expect(response.status, await response.clone().text()).toBe(200);
        const { runId } = (await response.json()) as { runId: string };
        expect((await readRun(base, token, runId)).inputs).toEqual({ item: PULL_REQUEST_REF });
      }
    });
  });
});
