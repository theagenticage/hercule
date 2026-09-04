/**
 * Settings.
 *
 * Two scopes, one closed key set each: `controller` holds the controller's
 * operational settings seeded at first run, `user` holds the user settings
 * store, which is keyed by user id so a later multi-user concept is a `WHERE`
 * clause rather than a table rebuild. A key that is not set is absent rather
 * than defaulted, so the default lives in exactly one place.
 *
 * `SETTING_VALUES` is the single declaration of what a key holds: the two
 * structs here are derived from it, and the controller's settings store reads
 * the same map to encode a value into its JSON column. A key declared once
 * cannot drift between the wire and the row.
 *
 * Unknown keys are rejected, in the schema itself: `closedStruct` says why.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct, optional } from "../closed";
import { Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { Authenticated } from "../security";

/** A retention window or a snapshot count, in whole days or whole snapshots. */
const PositiveDays = Schema.Int.check(Schema.isGreaterThan(0));

/** A time of day in the user timezone setting, `HH:MM` on a 24-hour clock. */
const TimeOfDay = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));

/** The session-level permission axis a provider adapter enforces. */
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

/** How much a thread row in the sidebar shows. */
export const ThreadRows = Schema.Literals(["meta", "plain"]);

export type ThreadRows = Schema.Schema.Type<typeof ThreadRows>;

/** What every settings key holds, per scope. The one declaration of a key. */
export const SETTING_VALUES = {
  controller: {
    /** TTL for the event log and per-session streams, in days. */
    "retention.events": PositiveDays,
    /** Minimum retention for security events and actor-stamped mutations, in days. */
    "retention.security": PositiveDays,
    /** Retention for conversation messages, in days. */
    "retention.conversations": PositiveDays,
    /** When the daily backup snapshot runs, in the user timezone setting. */
    "backup.time": TimeOfDay,
    /** How many daily snapshots to keep. */
    "backup.keep": PositiveDays,
  },
  user: {
    /** The IANA zone the user reads times in, chosen during setup. */
    timezone: Schema.NonEmptyString,
    "topics.order": Schema.Array(Schema.NonEmptyString),
    "notifications.muted": Schema.Array(MuteTarget),
    "lastChecked.intake": Timestamp,
    "lastChecked.checkin": Timestamp,
    "lastChecked.notifications": Timestamp,
    "onboarding.completedSteps": Schema.Array(Schema.NonEmptyString),
    "thread.instanceId": Id,
    "thread.model": Schema.NonEmptyString,
    "thread.accessMode": AccessMode,
    "thread.profileId": Id,
    /** The density of a thread row in the sidebar: `meta` unless set otherwise. */
    "ui.threadRows": ThreadRows,
  },
} as const;

/** The controller's operational settings, edited in Settings > System. */
export const ControllerSettings = closedStruct(optional(SETTING_VALUES.controller));

/** The user settings store: preference and presentation state. */
export const UserSettings = closedStruct(optional(SETTING_VALUES.user));

/** Everything that is set, in both scopes. */
export const SettingsState = closedStruct({
  controller: ControllerSettings,
  user: UserSettings,
});

export type SettingsState = Schema.Schema.Type<typeof SettingsState>;

/** A partial write over the same closed key set. */
export const SettingsPatch = closedStruct({
  controller: Schema.optionalKey(ControllerSettings),
  user: Schema.optionalKey(UserSettings),
});

export type SettingsPatch = Schema.Schema.Type<typeof SettingsPatch>;

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
