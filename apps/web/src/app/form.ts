/**
 * Form validation and error text.
 *
 * A form is validated with the same schema the API validates it with, through
 * the Standard Schema interface, so no Effect code enters the app. Every schema
 * a form uses is synchronous, so validation returns a value. A promise would
 * mean a schema gained an asynchronous filter, and `validate` throws.
 */
import type { StandardSchemaV1 } from "@hercule/contract";

/** One message per field that failed, keyed by the field name. */
export type FieldErrors = Readonly<Record<string, string>>;

/**
 * The key for a message about the form as a whole. A schema can reject a value
 * without pointing at one field - for example a check across two fields - and
 * that message belongs to the form rather than to any one field.
 */
export const FORM_ERROR = "form";

/**
 * Validates `value` against `schema`. Returns the decoded value, or the first
 * error message per field. Throws if the schema is asynchronous.
 */
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
