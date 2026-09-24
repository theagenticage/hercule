/**
 * The payload schemas of the web app's forms, converted to Standard Schema
 * validators.
 *
 * A form validates what it is about to send with the same schema the API
 * validates it with, so the two can never disagree. The web app writes no
 * Effect code, and the Standard Schema interface is all it needs: one
 * `validate(value)` that returns the decoded value or a list of issues, each
 * with the field path and a message the form can show.
 *
 * These validators are synchronous, because none of these schemas has an
 * effectful filter. So a caller may treat the result as a value rather than a
 * promise.
 */
import { Schema } from "effect";
import { LoginPayload } from "./groups/auth";
import { SetupPayload } from "./groups/setup";
import { TaskCreateInput } from "./groups/task";

/** The setup screen's payload: username, password, and the browser's timezone. */
export const SetupForm = Schema.toStandardSchemaV1(SetupPayload);

/** The login screen's payload. */
export const LoginForm = Schema.toStandardSchemaV1(LoginPayload);

/** What the Tasks screen's composer writes. */
export const TaskCreateForm = Schema.toStandardSchemaV1(TaskCreateInput);
