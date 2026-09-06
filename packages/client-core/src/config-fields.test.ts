import { describe, expect, it } from "vitest";
import { configDraft, configFields, configIssues, configPayload } from "./config-fields";
import { ApiError } from "./errors";

/**
 * The schemas here are written the way the controller serves them: the derived
 * JSON Schema document a plugin's config schema becomes, carried as the open
 * record the wire declares. A field model built from anything narrower would
 * not be reachable from what the screen actually holds.
 */
const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

describe("configFields", () => {
  it("gives one field per property, in schema order, with the kind its type names", () => {
    const fields = configFields(
      objectSchema({
        endpoint: { type: "string" },
        timeout: { type: "number" },
        retries: { type: "integer" },
        verbose: { type: "boolean" },
        mode: { type: "string", enum: ["fast", "slow"] },
        tags: { type: "array", items: { type: "string" } },
      }),
    );

    expect(fields).toEqual([
      { name: "endpoint", kind: "string", label: "endpoint", required: false },
      { name: "timeout", kind: "number", label: "timeout", required: false },
      { name: "retries", kind: "integer", label: "retries", required: false },
      { name: "verbose", kind: "boolean", label: "verbose", required: false },
      {
        name: "mode",
        kind: "enum",
        label: "mode",
        required: false,
        options: ["fast", "slow"],
      },
      { name: "tags", kind: "stringList", label: "tags", required: false },
    ]);
  });

  it("marks required exactly the properties the schema requires", () => {
    const fields = configFields(
      objectSchema(
        {
          endpoint: { type: "string" },
          timeout: { type: "number" },
        },
        ["endpoint"],
      ),
    );

    expect(fields.map((field) => [field.name, field.required])).toEqual([
      ["endpoint", true],
      ["timeout", false],
    ]);
  });

  it("reads the label off the title where there is one, and the description through", () => {
    const fields = configFields(
      objectSchema({
        endpoint: {
          type: "string",
          title: "Endpoint",
          description: "Where the plugin sends its calls.",
        },
        retries: { type: "integer" },
      }),
    );

    expect(fields[0]).toEqual({
      name: "endpoint",
      kind: "string",
      label: "Endpoint",
      description: "Where the plugin sends its calls.",
      required: false,
    });
    expect(fields[1]?.label).toBe("retries");
    expect(fields[1]?.description).toBeUndefined();
  });

  it("has nothing to show for a plugin with nothing to configure", () => {
    expect(configFields(objectSchema({}))).toEqual([]);
  });
});

describe("configDraft", () => {
  const fields = configFields(
    objectSchema({
      endpoint: { type: "string" },
      retries: { type: "integer" },
      verbose: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
    }),
  );

  it("reads the stored config into what each widget holds", () => {
    expect(
      configDraft(fields, {
        endpoint: "https://notes.test",
        retries: 3,
        verbose: true,
        tags: ["alpha"],
      }),
    ).toEqual({
      endpoint: "https://notes.test",
      retries: "3",
      verbose: true,
      tags: ["alpha"],
    });
  });

  it("gives an unset setting the empty form of its own kind", () => {
    expect(configDraft(fields, {})).toEqual({
      endpoint: "",
      retries: "",
      verbose: false,
      tags: [],
    });
  });
});

describe("configPayload", () => {
  const fields = configFields(
    objectSchema({
      endpoint: { type: "string" },
      timeout: { type: "number" },
      retries: { type: "integer" },
      verbose: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
    }),
  );

  it("sends each setting as the type its schema names", () => {
    expect(
      configPayload(
        fields,
        {
          endpoint: "https://notes.test",
          timeout: "1.5",
          retries: "3",
          verbose: true,
          tags: ["alpha", "beta"],
        },
        {},
      ),
    ).toEqual({
      endpoint: "https://notes.test",
      timeout: 1.5,
      retries: 3,
      verbose: true,
      tags: ["alpha", "beta"],
    });
  });

  it("leaves out what nobody filled in, rather than sending an empty one", () => {
    expect(
      configPayload(
        fields,
        { endpoint: "", timeout: "", retries: "", verbose: false, tags: [] },
        {},
      ),
    ).toEqual({});
  });

  it("keeps writing a checkbox and a list the stored config already has an answer for", () => {
    expect(
      configPayload(fields, { verbose: false, tags: [] }, { verbose: true, tags: ["alpha"] }),
    ).toEqual({ verbose: false, tags: [] });
  });

  it("sends a required checkbox and list even where nothing is stored", () => {
    const required = configFields(
      objectSchema({ verbose: { type: "boolean" }, tags: { type: "array" } }, ["verbose", "tags"]),
    );

    expect(configPayload(required, { verbose: false, tags: [] }, {})).toEqual({
      verbose: false,
      tags: [],
    });
  });
});

describe("configIssues", () => {
  const fields = configFields(
    objectSchema({ endpoint: { type: "string" }, retries: { type: "integer" } }),
  );

  it("keys a refused write's messages by the setting each blamed", () => {
    const refusal = new ApiError("validation", "the config does not match", {
      issues: [
        { path: ["endpoint"], message: "must be an https URL" },
        { path: ["retries"], message: "must be at least 1" },
      ],
    });

    expect(configIssues(refusal, fields)).toEqual({
      perField: { endpoint: "must be an https URL", retries: "must be at least 1" },
      rest: false,
    });
  });

  it("leaves the form to say what no rendered setting carries", () => {
    expect(configIssues(new ApiError("internal", "the database is locked"), fields)).toEqual({
      perField: {},
      rest: true,
    });
    expect(configIssues(new Error("the controller could not be reached"), fields)).toEqual({
      perField: {},
      rest: true,
    });
    // A refusal about the payload as a whole belongs to the form, not a field.
    expect(
      configIssues(
        new ApiError("validation", "no", { issues: [{ path: [], message: "no" }] }),
        fields,
      ),
    ).toEqual({ perField: {}, rest: true });
    // A setting this form does not render would otherwise be shown nowhere.
    expect(
      configIssues(
        new ApiError("validation", "no", { issues: [{ path: ["gone"], message: "unknown key" }] }),
        fields,
      ),
    ).toEqual({ perField: {}, rest: true });
  });

  it("says nothing at all when the write was not refused", () => {
    expect(configIssues(null, fields)).toEqual({ perField: {}, rest: false });
  });
});
