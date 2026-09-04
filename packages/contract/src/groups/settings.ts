/**
 * Settings (spec 11 section 2, Settings).
 *
 * Two scopes, one closed key set each: `controller` holds the controller's
 * operational settings seeded at first run, `user` holds the user settings
 * store, keyed by user id from day one so a later user concept is a `WHERE`
 * clause. A key that is not set is absent rather than defaulted, so the default
 * lives in exactly one place.
 *
 * Unknown keys are rejected. That is a decoding option the transport sets, not
 * something a schema can carry, so the closed shape here is only half of it.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { Authenticated } from "../security";

/** A retention window or a snapshot count, in whole days or whole snapshots. */
const PositiveDays = Schema.Int.check(Schema.isGreaterThan(0));

/** A time of day in the user timezone setting, `HH:MM` on a 24-hour clock. */
const TimeOfDay = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));

/** The session-level permission axis a provider adapter enforces (spec 06). */
export const AccessMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

export type AccessMode = Schema.Schema.Type<typeof AccessMode>;

/** What a notification mute names. */
const MuteTarget = Schema.NonEmptyString.check(
  Schema.isPattern(/^(workflow|plugin|assistant):.+$/, {
    description: "`workflow:<id>`, `plugin:<id>` or `assistant:<id>`",
  }),
);

/** The controller's operational settings, edited in Settings > System. */
export const ControllerSettings = Schema.Struct({
  "retention.events": Schema.optionalKey(PositiveDays),
  "retention.security": Schema.optionalKey(PositiveDays),
  "retention.conversations": Schema.optionalKey(PositiveDays),
  "backup.time": Schema.optionalKey(TimeOfDay),
  "backup.keep": Schema.optionalKey(PositiveDays),
});

/** The user settings store: preference and presentation state. */
export const UserSettings = Schema.Struct({
  timezone: Schema.optionalKey(Schema.NonEmptyString),
  "topics.order": Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  "notifications.muted": Schema.optionalKey(Schema.Array(MuteTarget)),
  "lastChecked.intake": Schema.optionalKey(Timestamp),
  "lastChecked.checkin": Schema.optionalKey(Timestamp),
  "lastChecked.notifications": Schema.optionalKey(Timestamp),
  "onboarding.completedSteps": Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  "thread.instanceId": Schema.optionalKey(Id),
  "thread.model": Schema.optionalKey(Schema.NonEmptyString),
  "thread.accessMode": Schema.optionalKey(AccessMode),
  "thread.profileId": Schema.optionalKey(Id),
});

/** Everything that is set, in both scopes. */
export const SettingsState = Schema.Struct({
  controller: ControllerSettings,
  user: UserSettings,
});

export type SettingsState = Schema.Schema.Type<typeof SettingsState>;

/** A partial write over the same closed key set. */
export const SettingsPatch = Schema.Struct({
  controller: Schema.optionalKey(ControllerSettings),
  user: Schema.optionalKey(UserSettings),
});

export const settings = HttpApiGroup.make("settings")
  .add(
    HttpApiEndpoint.get("read", "/settings", {
      success: SettingsState,
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.patch("update", "/settings", {
      payload: SettingsPatch,
      success: SettingsState,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
  )
  .middleware(Authenticated);
