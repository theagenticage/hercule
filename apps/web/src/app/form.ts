/**
 * Form validation and error text.
 *
 * A form is checked with the very schema the API will check it with, reached
 * through the Standard Schema interface so no Effect code enters the app. Every
 * schema a form uses is synchronous, so the answer is a value; a promise here
 * would mean a schema grew an effectful filter, which the assertion catches.
 */
import type { StandardSchemaV1 } from "@hercule/contract";

/** One message per field that failed, keyed by the field name. */
export type FieldErrors = Readonly<Record<string, string>>;

/**
 * Where a message about the form as a whole is filed. A schema can refuse a
 * value without blaming one field - a check across two of them - and that
 * message belongs to the form rather than to a field that does not exist.
 */
export const FORM_ERROR = "form";

export const validate = <Value>(
  schema: StandardSchemaV1<unknown, Value>,
  value: unknown,
): { readonly value: Value; readonly errors?: undefined } | { readonly errors: FieldErrors } => {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("a form schema must validate synchronously");
  if (result.issues === undefined) return { value: result.value };

  const errors: Record<string, string> = {};
  for (const issue of result.issues) {
    const segment = issue.path?.[0];
    const field =
      segment === undefined
        ? FORM_ERROR
        : typeof segment === "object" && segment !== null
          ? String(segment.key)
          : String(segment);
    errors[field] ??= issue.message;
  }
  return { errors };
};
