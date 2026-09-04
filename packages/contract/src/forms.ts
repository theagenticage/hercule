/**
 * The payload schemas again, as Standard Schema validators.
 *
 * A form validates what it is about to send with the same schema the API will
 * validate it with, so the two can never disagree. The web app writes no Effect
 * code, and the Standard Schema interface is the whole surface it needs: one
 * `validate(value)` that answers with the decoded value or a list of issues,
 * each carrying the field path and a message the form can show.
 *
 * These validators are synchronous for every schema here - no filter of theirs
 * is effectful - so a caller may treat the answer as a value rather than a
 * promise.
 */
import { Schema } from "effect";
import { LoginPayload } from "./groups/auth";
import { SetupPayload } from "./groups/setup";

/** The setup screen's payload: username, password, and the browser's timezone. */
export const SetupForm = Schema.toStandardSchemaV1(SetupPayload);

/** The login screen's payload. */
export const LoginForm = Schema.toStandardSchemaV1(LoginPayload);
