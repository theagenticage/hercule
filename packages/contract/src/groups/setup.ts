/**
 * The setup gate.
 *
 * Before setup completes these two operations and the static bundle are all
 * that can be reached; every other request fails with 401.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Internal, InvalidState, Unauthenticated, Validation } from "../errors";
import { NewPassword, Timezone, Username } from "../strings";
import { SetupToken } from "../security";

/** Whether the first run has been completed. Unauthenticated, so the web app can route. */
export const SetupState = Schema.Struct({ complete: Schema.Boolean });

/** The bearer token that setup returns, so the user is logged in once setup completes. */
export const SetupResult = Schema.Struct({ token: Schema.NonEmptyString });

/** What the setup screen sends. The timezone comes from the browser, not the form. */
export const SetupPayload = Schema.Struct({
  username: Username,
  password: NewPassword,
  timezone: Timezone,
});

export const setup = HttpApiGroup.make("setup").add(
  HttpApiEndpoint.get("read", "/setup", {
    success: SetupState,
    error: [Internal],
  }),
  HttpApiEndpoint.post("complete", "/setup/complete", {
    payload: SetupPayload,
    success: SetupResult,
    error: [Unauthenticated, Validation, InvalidState, Internal],
  }).middleware(SetupToken),
);
