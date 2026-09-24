import { describe, expect, it } from "vitest";
import { LoginForm, type StandardSchemaV1 } from "@hercule/contract";
import { FORM_ERROR, validate } from "./form";

/** Returns a schema that rejects every value without a field path. No v1 form schema does this yet. */
const buildRefusingSchema = (message: string): StandardSchemaV1<unknown, never> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: () => ({ issues: [{ message }] }),
  },
});

describe("validate", () => {
  it("returns the value when the schema accepts it", () => {
    const credentials = { username: "rogier", password: "hunter2hunter2" };
    const checked = validate(LoginForm, credentials);

    if (checked.errors !== undefined) throw new Error("the schema rejected a valid login");
    expect(checked.value).toEqual(credentials);
  });

  it("puts each message under the field in its path", () => {
    const checked = validate(LoginForm, { username: "", password: "" });

    expect(checked.errors).toEqual({
      username: "Enter your username.",
      password: "Enter your password.",
    });
  });

  it("puts a message with no field path under the form", () => {
    const checked = validate(buildRefusingSchema("These two do not go together."), {});

    expect(checked.errors).toEqual({ [FORM_ERROR]: "These two do not go together." });
  });
});
