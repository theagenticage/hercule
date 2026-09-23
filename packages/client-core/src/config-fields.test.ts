import { describe, expect, it } from "vitest";
import {
  buildConfigDraft,
  buildConfigFields,
  readConfigIssues,
  buildConfigPayload,
} from "./config-fields";
import { ApiError } from "./errors";

/**
 * The schemas here are written the way the controller serves them: the derived
 * JSON Schema document a plugin's config schema becomes, carried as the open
 * record the wire declares. A field model built from anything narrower would
 * not be reachable from what the screen actually holds.
 */
const buildObjectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

describe("buildConfigFields", () => {
  it("gives one field per property, in schema order, with the kind its type names", () => {
    const fields = buildConfigFields(
      buildObjectSchema({
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
    const fields = buildConfigFields(
      buildObjectSchema(
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
    const fields = buildConfigFields(
      buildObjectSchema({
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
    expect(buildConfigFields(buildObjectSchema({}))).toEqual([]);
  });
});

describe("buildConfigDraft", () => {
  const fields = buildConfigFields(
    buildObjectSchema({
      endpoint: { type: "string" },
      retries: { type: "integer" },
      verbose: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
    }),
  );

  it("reads the stored config into what each widget holds", () => {
    expect(
      buildConfigDraft(fields, {
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
    expect(buildConfigDraft(fields, {})).toEqual({
      endpoint: "",
      retries: "",
      verbose: false,
      tags: [],
    });
  });
});

describe("buildConfigPayload", () => {
  const fields = buildConfigFields(
    buildObjectSchema({
      endpoint: { type: "string" },
      timeout: { type: "number" },
      retries: { type: "integer" },
      verbose: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
    }),
  );

  it("sends each setting as the type its schema names", () => {
    expect(
      buildConfigPayload(
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
      buildConfigPayload(
        fields,
        { endpoint: "", timeout: "", retries: "", verbose: false, tags: [] },
        {},
      ),
    ).toEqual({});
  });

  it("keeps writing a checkbox and a list the stored config already has an answer for", () => {
    expect(
      buildConfigPayload(fields, { verbose: false, tags: [] }, { verbose: true, tags: ["alpha"] }),
    ).toEqual({ verbose: false, tags: [] });
  });

  it("sends a required checkbox and list even where nothing is stored", () => {
    const required = buildConfigFields(
      buildObjectSchema({ verbose: { type: "boolean" }, tags: { type: "array" } }, [
        "verbose",
        "tags",
      ]),
    );

    expect(buildConfigPayload(required, { verbose: false, tags: [] }, {})).toEqual({
      verbose: false,
      tags: [],
    });
  });
});

describe("readConfigIssues", () => {
  const fields = buildConfigFields(
    buildObjectSchema({ endpoint: { type: "string" }, retries: { type: "integer" } }),
  );

  it("keys a refused write's messages by the setting each blamed", () => {
    const refusal = new ApiError("validation", "the config does not match", {
      issues: [
        { path: ["endpoint"], message: "must be an https URL" },
        { path: ["retries"], message: "must be at least 1" },
      ],
    });

    expect(readConfigIssues(refusal, fields)).toEqual({
      perField: { endpoint: "must be an https URL", retries: "must be at least 1" },
      rest: false,
    });
  });

  it("leaves the form to say what no rendered setting carries", () => {
    expect(readConfigIssues(new ApiError("internal", "the database is locked"), fields)).toEqual({
      perField: {},
      rest: true,
    });
    expect(readConfigIssues(new Error("the controller could not be reached"), fields)).toEqual({
      perField: {},
      rest: true,
    });
    // A refusal about the payload as a whole belongs to the form, not a field.
    expect(
      readConfigIssues(
        new ApiError("validation", "no", { issues: [{ path: [], message: "no" }] }),
        fields,
      ),
    ).toEqual({ perField: {}, rest: true });
    // A setting this form does not render would otherwise be shown nowhere.
    expect(
      readConfigIssues(
        new ApiError("validation", "no", { issues: [{ path: ["gone"], message: "unknown key" }] }),
        fields,
      ),
    ).toEqual({ perField: {}, rest: true });
  });

  it("says nothing at all when the write was not refused", () => {
    expect(readConfigIssues(null, fields)).toEqual({ perField: {}, rest: false });
  });

  it("reads a group's own fields out of a path that names the group", () => {
    const refusal = new ApiError("validation", "the credentials were refused", {
      issues: [
        { path: ["credentials", "token"], message: "that token was rejected" },
        { path: ["config", "endpoint"], message: "must be an https URL" },
      ],
    });

    expect(readConfigIssues(refusal, [{ name: "token" }], "credentials")).toEqual({
      perField: { token: "that token was rejected" },
      // The settings issue lands on no field this form draws.
      rest: true,
    });
    expect(readConfigIssues(refusal, fields, "config")).toEqual({
      perField: { endpoint: "must be an https URL" },
      rest: true,
    });
  });

  it("leaves the form to say what it draws no field for, group or not", () => {
    const refusal = new ApiError("validation", "refused", {
      issues: [{ path: ["config", "endpoint"], message: "must be an https URL" }],
    });

    // The type is gone, so this form draws nothing: without this the message
    // would be filed under a field nobody can see and never shown.
    expect(readConfigIssues(refusal, [], "config")).toEqual({ perField: {}, rest: true });
  });
});
