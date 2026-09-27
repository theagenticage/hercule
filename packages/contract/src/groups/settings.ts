/**
 * Settings.
 *
 * There are two scopes, each with a closed set of keys:
 *
 * - `controller` holds the controller's operational settings, seeded at first
 *   run;
 * - `user` holds the user settings store, which is keyed by user id, so adding
 *   multiple users later means a `WHERE` clause rather than a table rebuild.
 *
 * A key that is not set is absent rather than filled with its default, so the
 * default is defined in exactly one place.
 *
 * `SETTING_VALUES` is the only declaration of what each key holds: the two
 * structs here are derived from it, and the controller's settings store uses
 * the same map to encode a value into its JSON column. So a key cannot differ
 * between the wire and the database row.
 *
 * The schema itself rejects unknown keys; `closedStruct` explains why.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { AccessMode } from "@hercule/protocol";
import { closedStruct, optional } from "../closed";
import { Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { atMost, Timezone } from "../strings";
import { Authenticated } from "../security";

/**
 * The session-level access mode a provider adapter enforces. Re-exported so
 * that the wire shape and the modes a provider plugin declares support for
 * cannot drift apart.
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

/** A session timeout, in whole minutes. It is converted to milliseconds before it is sent to a runner. */
const PositiveMinutes = Schema.Int.check(Schema.isGreaterThan(0));

/** A count of at least one. */
const PositiveCount = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * A time of day, `HH:MM` on a 24-hour clock. The timezone it is read in is set
 * by the field that holds it, and documented there.
 */
export const TimeOfDay = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));

/** The target of a notification mute. */
const MuteTarget = Schema.NonEmptyString.check(
  Schema.isPattern(/^(workflow|plugin|assistant):.+$/, {
    description: "`workflow:<id>`, `plugin:<id>` or `assistant:<id>`",
  }),
);

/**
 * The workspace a thread opens in, unless the draft chooses another. There are
 * two values, not three. A former third value, `none`, could never be read
 * back as itself: a project with repos does not offer "no workspace" at all
 * (spec 14 §The composer, amended 2026-09-16, [#72]), and a project without
 * repos offers nothing else. So a stored `none` always behaved as unset.
 * Nothing is migrated: a row that still holds `none` fails to decode and is
 * treated as unset, which is how it already behaved.
 */
export const ThreadWorkspace = Schema.Literals(["primary", "ephemeral"]);

export type ThreadWorkspace = Schema.Schema.Type<typeof ThreadWorkspace>;

/** How much a thread row in the sidebar shows. */
export const ThreadRows = Schema.Literals(["meta", "plain"]);

export type ThreadRows = Schema.Schema.Type<typeof ThreadRows>;

/** What every settings key holds, per scope. This is the only declaration of each key. */
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
    /**
     * How long a session that unloads when idle may sit with no turn before
     * its runner stops it, to be resumed at the next message.
     */
    "session.idleUnloadMinutes": PositiveMinutes,
    /**
     * How long a session that cannot be resumed keeps its ephemeral workspace
     * after it exits, in hours. Applies to sessions that exit after a change.
     */
    "workspace.orphanTtlHours": PositiveHours,
    /**
     * How long a session that can still be resumed keeps its ephemeral
     * workspace after it exits, in days. Applies to sessions that exit after
     * a change.
     */
    "workspace.idleTtlDays": PositiveDays,
    /**
     * How long a failed run, or a run cancelled with its workspace kept,
     * keeps its ephemeral workspace for inspection after it ends, in days.
     * Applies to runs that end after a change.
     */
    "workspace.inspectionTtlDays": PositiveDays,
    /**
     * How deep runs may nest. A run started by hand or by a program is 1
     * deep, and a run that a step of another run starts is one deeper than
     * that run. A workflow that starts itself, directly or through another
     * workflow, stops here instead of starting runs without end.
     */
    "run.nestingLimit": PositiveCount,
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
     * own. When unset, the project decides: a project with one repo uses the
     * main workspace, and one with several uses a worktree. A project with no
     * repos opens with no workspace, whatever this setting holds.
     */
    "thread.workspace": ThreadWorkspace,
    /**
     * The GitHub Connection that a Thread with no workspace, and an
     * assistant's conversation session, act through.
     */
    "github.defaultConnectionId": Schema.NullOr(Id),
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
