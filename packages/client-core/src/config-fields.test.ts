import { describe, expect, it } from "vitest";
import {
  buildConfigDraft,
  buildConfigFields,
  readConfigHeading,
  readConfigIssues,
  buildConfigPayload,
  CONFIG_NUMBER_UNREADABLE,
  CONFIG_WHOLE_NUMBER_UNREADABLE,
} from "./config-fields";
import { ApiError } from "./errors";

/**
 * The schemas here have the form the controller sends: the JSON Schema
 * document derived from a plugin's config schema, typed as the open record
 * the contract declares. Fields built from a narrower type would not match
 * what the screen actually receives.
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
  it("returns one field per property, in schema order, with the kind from its type", () => {
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

  it("marks as required exactly the properties the schema requires", () => {
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

  it("uses the title as the label when there is one, and passes the description through", () => {
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

  it("passes a text or number field's default through as text", () => {
    const fields = buildConfigFields(
      buildObjectSchema({
        endpoint: { type: "string", default: "https://notes.test" },
        timeout: { type: "number", default: 1.5 },
        days: { type: "integer", minimum: 1, maximum: 30, default: 7 },
        retries: { type: "integer" },
      }),
    );

    expect(fields.map((field) => [field.name, field.defaultValue])).toEqual([
      ["endpoint", "https://notes.test"],
      ["timeout", "1.5"],
      ["days", "7"],
      ["retries", undefined],
    ]);
  });

  it("gives no default to a kind whose widget has no placeholder", () => {
    const fields = buildConfigFields(
      buildObjectSchema({
        verbose: { type: "boolean", default: true },
        mode: { type: "string", enum: ["fast", "slow"], default: "fast" },
        tags: { type: "array", items: { type: "string" }, default: ["alpha"] },
      }),
    );

    expect(fields.every((field) => field.defaultValue === undefined)).toBe(true);
  });

  it("returns no fields for a plugin with nothing to configure", () => {
    expect(buildConfigFields(buildObjectSchema({}))).toEqual([]);
  });
});

describe("readConfigHeading", () => {
  it("returns the schema's title", () => {
    expect(readConfigHeading({ ...buildObjectSchema({}), title: "Watching" })).toBe("Watching");
  });

  it("falls back to Configuration for a schema with no title, or an empty one", () => {
    expect(readConfigHeading(buildObjectSchema({}))).toBe("Configuration");
    expect(readConfigHeading({ ...buildObjectSchema({}), title: "" })).toBe("Configuration");
    expect(readConfigHeading(undefined)).toBe("Configuration");
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

  it("converts the stored config into each widget's value", () => {
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

  it("gives an unset setting the empty value of its kind", () => {
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

  it("sends each setting as the type its schema declares", () => {
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
      config: {
        endpoint: "https://notes.test",
        timeout: 1.5,
        retries: 3,
        verbose: true,
        tags: ["alpha", "beta"],
      },
    });
  });

  it("leaves out empty fields rather than sending an empty value", () => {
    expect(
      buildConfigPayload(
        fields,
        { endpoint: "", timeout: " ", retries: "  ", verbose: false, tags: [] },
        {},
      ),
    ).toEqual({ config: {} });
  });

  it("keeps sending a checkbox and a list that the stored config already has a value for", () => {
    expect(
      buildConfigPayload(fields, { verbose: false, tags: [] }, { verbose: true, tags: ["alpha"] }),
    ).toEqual({ config: { verbose: false, tags: [] } });
  });

  it("sends a required checkbox and list even when nothing is stored", () => {
    const required = buildConfigFields(
      buildObjectSchema({ verbose: { type: "boolean" }, tags: { type: "array" } }, [
        "verbose",
        "tags",
      ]),
    );

    expect(buildConfigPayload(required, { verbose: false, tags: [] }, {})).toEqual({
      config: { verbose: false, tags: [] },
    });
  });

  it("reads a number field's text with spaces around it", () => {
    expect(buildConfigPayload(fields, { timeout: " -2.5 ", retries: " 7 " }, {})).toEqual({
      config: { timeout: -2.5, retries: 7 },
    });
  });

  it("refuses an integer field's text that is not a whole number, and sends nothing", () => {
    for (const typed of ["abc", "1.5", "-5", "1e3", "0x10"]) {
      expect(
        buildConfigPayload(fields, { endpoint: "https://notes.test", retries: typed }, {}),
      ).toEqual({ errors: { retries: CONFIG_WHOLE_NUMBER_UNREADABLE } });
    }
  });

  it("refuses a number field's text that is not a number, on the field that holds it", () => {
    for (const typed of ["abc", "1e3", "0x10", "1.", "1,5"]) {
      expect(buildConfigPayload(fields, { timeout: typed, retries: "x" }, {})).toEqual({
        errors: { timeout: CONFIG_NUMBER_UNREADABLE, retries: CONFIG_WHOLE_NUMBER_UNREADABLE },
      });
    }
  });
});

describe("readConfigIssues", () => {
  const fields = buildConfigFields(
    buildObjectSchema({ endpoint: { type: "string" }, retries: { type: "integer" } }),
  );

  it("keys a rejected write's error messages by field", () => {
    const refusal = new ApiError("validation", "the config does not match", {
      issues: [
        { path: ["endpoint"], message: "must be an https URL" },
        { path: ["retries"], message: "must be at least 1" },
      ],
    });

    expect(readConfigIssues(refusal, fields)).toEqual({
      perField: { endpoint: "must be an https URL", retries: "must be at least 1" },
      perEntry: {},
      rest: false,
    });
  });

  it("sets rest for an error that belongs to no rendered field", () => {
    expect(readConfigIssues(new ApiError("internal", "the database is locked"), fields)).toEqual({
      perField: {},
      perEntry: {},
      rest: true,
    });
    expect(readConfigIssues(new Error("the controller could not be reached"), fields)).toEqual({
      perField: {},
      perEntry: {},
      rest: true,
    });
    // An error about the payload as a whole belongs to the form, not a field.
    expect(
      readConfigIssues(
        new ApiError("validation", "no", { issues: [{ path: [], message: "no" }] }),
        fields,
      ),
    ).toEqual({ perField: {}, perEntry: {}, rest: true });
    // Without `rest`, an error on a setting this form does not render would be shown nowhere.
    expect(
      readConfigIssues(
        new ApiError("validation", "no", { issues: [{ path: ["gone"], message: "unknown key" }] }),
        fields,
      ),
    ).toEqual({ perField: {}, perEntry: {}, rest: true });
  });

  it("puts an error about one entry of a list field under that entry", () => {
    const listFields = buildConfigFields(
      buildObjectSchema({ tags: { type: "array", items: { type: "string" } } }),
    );
    const refusal = new ApiError("validation", "the config does not match", {
      issues: [
        { path: ["tags", "2"], message: "must not be empty" },
        { path: ["tags", "2"], message: "a second error for the same entry" },
        { path: ["tags"], message: "at most 5 tags" },
      ],
    });

    expect(readConfigIssues(refusal, listFields)).toEqual({
      perField: { tags: "at most 5 tags" },
      perEntry: { tags: { 2: "must not be empty" } },
      rest: false,
    });
  });

  it("puts an error deeper than an entry under its field, so it is still shown", () => {
    const refusal = new ApiError("validation", "no", {
      issues: [{ path: ["endpoint", "host", "0"], message: "unreadable host" }],
    });

    expect(readConfigIssues(refusal, fields)).toEqual({
      perField: { endpoint: "unreadable host" },
      perEntry: {},
      rest: false,
    });
  });

  it("returns no errors when the write did not fail", () => {
    expect(readConfigIssues(null, fields)).toEqual({ perField: {}, perEntry: {}, rest: false });
  });

  it("reads a group's fields from paths that start with the group's name", () => {
    const refusal = new ApiError("validation", "the credentials were refused", {
      issues: [
        { path: ["credentials", "token"], message: "that token was rejected" },
        { path: ["config", "endpoint"], message: "must be an https URL" },
      ],
    });

    expect(readConfigIssues(refusal, [{ name: "token" }], "credentials")).toEqual({
      perField: { token: "that token was rejected" },
      perEntry: {},
      // The settings error matches no field this form renders.
      rest: true,
    });
    expect(readConfigIssues(refusal, fields, "config")).toEqual({
      perField: { endpoint: "must be an https URL" },
      perEntry: {},
      rest: true,
    });
  });

  it("sets rest for an error on a field the form does not render, in a group or not", () => {
    const refusal = new ApiError("validation", "refused", {
      issues: [{ path: ["config", "endpoint"], message: "must be an https URL" }],
    });

    // The type is gone, so this form renders no fields. Without `rest`, the
    // message would belong to a field nobody can see and never be shown.
    expect(readConfigIssues(refusal, [], "config")).toEqual({
      perField: {},
      perEntry: {},
      rest: true,
    });
  });
});
