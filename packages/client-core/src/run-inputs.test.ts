import { assert, describe, it } from "vitest";
import type { Connection } from "@hercule/contract";
import { ApiError } from "./errors";
import {
  buildRunInputDraft,
  buildRunInputs,
  decideRunFormIssues,
  hasConnectionField,
  buildRunForm,
  buildRunFormLoadIssues,
  buildRunInputIssues,
  UNREADABLE_NUMBER,
  type RunInputDraft,
  type RunInputField,
} from "./run-inputs";

const connection = (
  id: string,
  type: string,
  label: string,
  status: Connection["status"],
): Connection => ({
  id,
  type,
  label,
  displayName: "octocat",
  status,
  labels: [],
  config: {},
  credentials: [],
  createdAt: "2026-09-24T12:00:00.000Z",
  updatedAt: "2026-09-24T12:00:00.000Z",
});

const CONNECTIONS = [
  connection("c1", "github/github", "work", "connected"),
  connection("c2", "github/github", "old", "disabled"),
  connection("c3", "gmail/gmail", "mail", "connected"),
];

const STEPS = `steps:
  - id: a
    kind: action
    action: task.query
`;

const SOURCE = `name: Release
inputs:
  - name: title
    schema: { type: string, description: The task's title. }
    required: true
  - name: priority
    schema: { type: string, enum: [low, high] }
    required: false
  - name: count
    schema: { type: integer }
    required: false
    default: 3
  - name: urgent
    schema: { type: boolean }
    required: false
  - name: notify
    schema: { type: boolean }
    required: false
    default: true
  - name: labels
    schema: { type: array }
    required: false
    default: [ci]
  - name: account
    connection: { type: github/github }
    required: true
${STEPS}`;

/** Reads the form of `SOURCE`, which parses, so the reading has fields. */
const readFields = (): ReadonlyArray<RunInputField> => {
  const reading = buildRunForm(SOURCE, CONNECTIONS);
  if (!("fields" in reading)) throw new Error(reading.refusal);
  return reading.fields;
};

describe("buildRunForm", () => {
  it("gives each input the widget of its type, in declaration order", () => {
    const fields = readFields();
    assert.deepStrictEqual(
      fields.map((field) => [field.name, field.kind, field.required]),
      [
        ["title", "text", true],
        ["priority", "enum", false],
        ["count", "number", false],
        ["urgent", "boolean", false],
        ["notify", "boolean", false],
        ["labels", "json", false],
        ["account", "connection", true],
      ],
    );
    assert.strictEqual(fields[0]?.description, "The task's title.");
    const priority = fields[1];
    assert.deepStrictEqual(priority?.kind === "enum" ? priority.options : [], ["low", "high"]);
  });

  it("offers the Connections of the input's type, a disabled one marked", () => {
    const account = readFields()[6];
    assert.deepStrictEqual(account?.kind === "connection" ? account.connections : [], [
      { id: "c1", label: "work · octocat", disabled: false },
      { id: "c2", label: "old · octocat", disabled: true },
    ]);
  });

  it("has no fields for a workflow with no inputs", () => {
    assert.deepStrictEqual(buildRunForm(`name: x\n${STEPS}`, []), { fields: [] });
  });

  it("says why when the stored source does not parse", () => {
    const reading = buildRunForm("name: [unclosed", []);
    assert.isTrue("refusal" in reading);
  });
});

describe("buildRunInputDraft", () => {
  it("fills in each default, and leaves a checkbox with no default untouched", () => {
    assert.deepStrictEqual(buildRunInputDraft(readFields()), {
      title: "",
      priority: "",
      count: "3",
      urgent: undefined,
      notify: true,
      labels: '["ci"]',
      account: "",
    });
  });
});

describe("buildRunInputs", () => {
  it("converts each value to its type and leaves empty fields and untouched checkboxes out", () => {
    const fields = readFields();
    const draft = { ...buildRunInputDraft(fields), title: "Fix login", account: "c1" };
    assert.deepStrictEqual(buildRunInputs(fields, draft), {
      inputs: { title: "Fix login", count: 3, notify: true, labels: ["ci"], account: "c1" },
    });
  });

  it("sends a checkbox once the user has set it, false too", () => {
    const fields = readFields();
    const draft = { ...buildRunInputDraft(fields), urgent: false, notify: false };
    const reading = buildRunInputs(fields, draft);
    assert.deepStrictEqual(
      "inputs" in reading ? [reading.inputs["urgent"], reading.inputs["notify"]] : [],
      [false, false],
    );
  });

  it("sends whitespace-only text as typed, and leaves whitespace-only number and JSON text out", () => {
    const fields = readFields();
    const draft = {
      ...buildRunInputDraft(fields),
      title: "  ",
      count: " ",
      labels: "\n ",
      account: "c1",
    };
    assert.deepStrictEqual(buildRunInputs(fields, draft), {
      inputs: { title: "  ", notify: true, account: "c1" },
    });
  });

  it("reports a number or JSON text it cannot read on its field", () => {
    const fields = readFields();
    const typed = { ...buildRunInputDraft(fields), count: "three", labels: "[ci" };
    assert.deepStrictEqual(buildRunInputs(fields, typed), {
      errors: { count: "Enter a number.", labels: "This is not valid JSON." },
    });
    // The browser reports text like `1.2.3` in a number field as empty.
    const unreadable: RunInputDraft = { ...buildRunInputDraft(fields), count: UNREADABLE_NUMBER };
    assert.deepStrictEqual(buildRunInputs(fields, unreadable), {
      errors: { count: "Enter a number." },
    });
  });
});

describe("buildRunInputIssues", () => {
  it("puts an issue at inputs.<name> on its field and every other issue under a summary", () => {
    const error = new ApiError("validation", "the inputs are not valid", {
      issues: [
        { path: ["inputs", "title"], message: "Required." },
        { path: ["inputs", "title"], message: "Second." },
        { path: ["steps", "0", "action"], message: "Unknown action." },
      ],
    });
    assert.deepStrictEqual(buildRunInputIssues(error, readFields()), {
      perField: { title: "Required." },
      summary: "Not started: the inputs are not valid.",
      general: ["steps.0.action: Unknown action."],
    });
  });

  it("needs no summary when every issue is on a field", () => {
    const error = new ApiError("validation", "the inputs are not valid", {
      issues: [{ path: ["inputs", "title"], message: "Required." }],
    });
    assert.strictEqual(buildRunInputIssues(error, readFields()).summary, undefined);
  });

  it("has only a summary for an error that lists no issues, and nothing without an error", () => {
    assert.deepStrictEqual(
      buildRunInputIssues(new ApiError("not_found", "no such workflow."), []),
      {
        perField: {},
        summary: "Not started: no such workflow.",
        general: [],
      },
    );
    assert.deepStrictEqual(buildRunInputIssues(null, []), {
      perField: {},
      summary: undefined,
      general: [],
    });
  });
});

describe("hasConnectionField", () => {
  it("tells a form that needs the Connections from one that does not", () => {
    assert.isTrue(hasConnectionField(readFields()));
    assert.isFalse(hasConnectionField(readFields().filter((field) => field.kind !== "connection")));
  });
});

describe("buildRunFormLoadIssues", () => {
  it("says the form could not be read, not that a run was not started", () => {
    assert.deepStrictEqual(buildRunFormLoadIssues(new Error("cannot reach the controller")), {
      perField: {},
      summary: "The form could not be read: cannot reach the controller.",
      general: [],
    });
  });
});

describe("decideRunFormIssues", () => {
  const refused = new ApiError("validation", "the inputs are not valid", {
    issues: [{ path: ["inputs", "title"], message: "Required." }],
  });

  it("shows a refused start before a read that failed since", () => {
    const issues = decideRunFormIssues({
      startError: refused,
      loadError: new Error("cannot reach the controller"),
      form: { fields: readFields() },
    });
    assert.deepStrictEqual(issues.perField, { title: "Required." });
  });

  it("says a read failed, or the workflow does not parse, before anything was started", () => {
    assert.strictEqual(
      decideRunFormIssues({ startError: null, loadError: new Error("lost"), form: undefined })
        .summary,
      "The form could not be read: lost.",
    );
    assert.match(
      decideRunFormIssues({ startError: null, loadError: null, form: { refusal: "no parse" } })
        .summary ?? "",
      /^The form could not be read: no parse\.$/,
    );
    assert.strictEqual(
      decideRunFormIssues({ startError: null, loadError: null, form: { fields: [] } }).summary,
      undefined,
    );
  });
});
