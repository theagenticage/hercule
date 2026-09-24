import { describe, expect, it } from "vitest";
import { LoginForm, type StandardSchemaV1 } from "@hercule/contract";
import { FORM_ERROR, validate } from "./form";

/** A schema that refuses everything without naming a field, which no v1 form does yet. */
const buildRefusingSchema = (message: string): StandardSchemaV1<unknown, never> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: () => ({ issues: [{ message }] }),
  },
});

describe("validate", () => {
  it("hands back the checked value when the schema accepts it", () => {
    const credentials = { username: "rogier", password: "hunter2hunter2" };
    const checked = validate(LoginForm, credentials);

    if (checked.errors !== undefined) throw new Error("the schema refused a valid login");
    expect(checked.value).toEqual(credentials);
  });

  it("files a message under the field it names", () => {
    const checked = validate(LoginForm, { username: "", password: "" });

    expect(checked.errors).toEqual({
      username: "Enter your username.",
      password: "Enter your password.",
    });
  });

  it("files a message that names no field under the form", () => {
    const checked = validate(buildRefusingSchema("These two do not go together."), {});

    expect(checked.errors).toEqual({ [FORM_ERROR]: "These two do not go together." });
  });
});
