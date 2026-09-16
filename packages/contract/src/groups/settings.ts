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
import { AccessMode } from "@hydra/protocol";
import { closedStruct, optional } from "../closed";
import { Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { atMost, Timezone } from "../strings";
import { Authenticated } from "../security";

/**
 * The session-level permission axis a provider adapter enforces, re-exported so
 * the wire shape and the support a provider plugin declares per mode cannot
 * drift apart.
 */
export { AccessMode };

/**
 * The longest list a single user setting may hold. The three that are lists -
 * the topic order, the mutes and the onboarding steps - are all short by nature
 * and are replaced whole on every write, so one generous bound covers them.
 */
export const MAX_SETTING_LIST = 256;

/** A retention window or a snapshot count, in whole days or whole snapshots. */
const PositiveDays = Schema.Int.check(Schema.isGreaterThan(0));

/** An expiry window in whole hours. */
const PositiveHours = Schema.Int.check(Schema.isGreaterThan(0));

/** A session timeout, in whole minutes: the wire carries the milliseconds this turns into. */
const PositiveMinutes = Schema.Int.check(Schema.isGreaterThan(0));

/** A time of day in the user timezone setting, `HH:MM` on a 24-hour clock. */
const TimeOfDay = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));

/** What a notification mute names. */
const MuteTarget = Schema.NonEmptyString.check(
  Schema.isPattern(/^(workflow|plugin|assistant):.+$/, {
    description: "`workflow:<id>`, `plugin:<id>` or `assistant:<id>`",
  }),
);

/**
 * What a thread opens in unless the draft says otherwise. Two values, not
 * three: `none` was a third that could never be read back as itself, because a
 * project with repos does not offer "no workspace" at all (spec 14 §The
 * composer, amended 2026-09-16, [#72]) and a project without them has nothing
 * else to offer - so a stored `none` always read as unset, and unset is what
 * it is. Nothing migrates: a row still holding it fails to decode and reads
 * unset, which is the same answer it already gave.
 */
export const ThreadWorkspace = Schema.Literals(["primary", "ephemeral"]);

export type ThreadWorkspace = Schema.Schema.Type<typeof ThreadWorkspace>;

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
    /** How long a session may sit with no event before the runner ends it. */
    "session.inactivityTimeoutMinutes": PositiveMinutes,
    /** How long a session may run in total before the runner ends it. */
    "session.absoluteTimeoutMinutes": PositiveMinutes,
    /** How long an ephemeral workspace nothing references is kept, in hours. */
    "workspace.orphanTtlHours": PositiveHours,
    /** How long an ephemeral workspace nothing has worked in is kept, in days. */
    "workspace.idleTtlDays": PositiveDays,
  },
  user: {
    /** The IANA zone the user reads times in, chosen during setup. */
    timezone: Timezone,
    "topics.order": atMost(Schema.NonEmptyString, MAX_SETTING_LIST),
    "notifications.muted": atMost(MuteTarget, MAX_SETTING_LIST),
    "lastChecked.intake": Timestamp,
    "lastChecked.checkin": Timestamp,
    "lastChecked.notifications": Timestamp,
    "onboarding.completedSteps": atMost(Schema.NonEmptyString, MAX_SETTING_LIST),
    "thread.instanceId": Id,
    "thread.model": Schema.NonEmptyString,
    "thread.accessMode": AccessMode,
    "thread.profileId": Id,
    /**
     * What a thread opens in: the repo's main workspace or a worktree of its
     * own. Unset follows the project - one repo takes the main workspace,
     * several take a worktree - and a project with no repos opens with no
     * workspace whatever this says.
     */
    "thread.workspace": ThreadWorkspace,
    /** The GitHub Connection a thread with no checkout of its own acts through. */
    "thread.githubConnectionId": Schema.NullOr(Id),
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
