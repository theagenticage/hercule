/**
 * Unit tests for `listConnectionParams`: which values of a `run.start` step
 * count as connection params, for a workflow named by its id, a workflow
 * named by a template, and a workflow that does not exist.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@hercule/contract";
import { listConnectionParams, type ConnectionParamReferences } from "./validation";

const FORGE_TYPE = "forge/forge";
const TARGET_ID = "wf_target";

/** The references of a controller with one stored workflow, `TARGET_ID`, which has a Connection input `account` and a string input `label`. */
const REFERENCES: ConnectionParamReferences = {
  actions: new Map(),
  startedWorkflowInputsById: new Map([
    [
      TARGET_ID,
      [
        { name: "account", connection: { type: FORGE_TYPE }, required: false },
        { name: "label", schema: { type: "string" }, required: false },
      ],
    ],
  ]),
};

type ActionStep = Extract<WorkflowDefinition["steps"][number], { readonly kind: "action" }>;

/** Builds a workflow with one `run.start` step whose params are `params`. */
const buildRunStartDefinition = (
  params: NonNullable<ActionStep["params"]>,
): WorkflowDefinition => ({
  name: "Start a run",
  steps: [{ id: "start", kind: "action", action: "run.start", params }],
});

const INPUTS_PATH = ["steps", "0", "params", "inputs"];

describe("listConnectionParams for a run.start step", () => {
  it("returns only the values for the Connection inputs of a workflow named by its id", () => {
    const params = listConnectionParams(
      buildRunStartDefinition({
        workflowId: TARGET_ID,
        inputs: { account: "{{ inputs.acc }}", label: "Review" },
      }),
      REFERENCES,
    );

    expect(params).toEqual([
      {
        path: [...INPUTS_PATH, "account"],
        value: "{{ inputs.acc }}",
        target: { kind: "started-input", name: "account", type: FORGE_TYPE },
      },
    ]);
  });

  it("returns every value when the workflow is named by a template or does not exist", () => {
    for (const workflowId of ["{{ inputs.child }}", "wf_absent"]) {
      const params = listConnectionParams(
        buildRunStartDefinition({ workflowId, inputs: { account: "acc_1", label: "Review" } }),
        REFERENCES,
      );

      expect(params, workflowId).toEqual([
        {
          path: [...INPUTS_PATH, "account"],
          value: "acc_1",
          target: { kind: "unknown-started-input", name: "account" },
        },
        {
          path: [...INPUTS_PATH, "label"],
          value: "Review",
          target: { kind: "unknown-started-input", name: "label" },
        },
      ]);
    }
  });

  it("returns an inputs template as one param for an unknown input, unless the workflow is known to take no Connection", () => {
    for (const workflowId of [TARGET_ID, "{{ inputs.child }}"]) {
      expect(
        listConnectionParams(
          buildRunStartDefinition({ workflowId, inputs: "{{ inputs.payload }}" }),
          REFERENCES,
        ),
        workflowId,
      ).toEqual([
        {
          path: INPUTS_PATH,
          value: "{{ inputs.payload }}",
          target: { kind: "unknown-started-input", name: undefined },
        },
      ]);
    }

    const withoutConnectionInputs: ConnectionParamReferences = {
      ...REFERENCES,
      startedWorkflowInputsById: new Map([
        [TARGET_ID, [{ name: "label", schema: { type: "string" }, required: false }]],
      ]),
    };
    expect(
      listConnectionParams(
        buildRunStartDefinition({ workflowId: TARGET_ID, inputs: "{{ inputs.payload }}" }),
        withoutConnectionInputs,
      ),
    ).toEqual([]);
  });
});
