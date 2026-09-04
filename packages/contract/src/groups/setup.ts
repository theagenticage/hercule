/**
 * The setup gate (spec 11 section 2, spec 15 section 7).
 *
 * Before setup completes these two operations and the static bundle are all
 * that is reachable; everything else answers 401.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Internal, InvalidState, Unauthenticated, Validation } from "../errors";
import { SetupToken } from "../security";

/** Whether the first run has been completed. Unauthenticated, so the web app can route. */
export const SetupState = Schema.Struct({ complete: Schema.Boolean });

/** The bearer token setup hands back: the user is logged in when it returns. */
export const SetupResult = Schema.Struct({ token: Schema.NonEmptyString });

export const setup = HttpApiGroup.make("setup").add(
  HttpApiEndpoint.get("read", "/setup", {
    success: SetupState,
    error: [Internal],
  }),
  HttpApiEndpoint.post("complete", "/setup/complete", {
    payload: Schema.Struct({
      username: Schema.NonEmptyString,
      password: Schema.NonEmptyString,
      timezone: Schema.NonEmptyString,
    }),
    success: SetupResult,
    error: [Unauthenticated, Validation, InvalidState, Internal],
  }).middleware(SetupToken),
);
