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
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { AccessMode, MAX_FACT_LENGTH } from "@hercule/protocol";
import { closedStruct, optional } from "../closed";
import { Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { atMost, Timezone } from "../strings";
import { Authenticated } from "../security";
import { MuteKey } from "./notification";
import { SpawnBound } from "./workflow-definition";

/**
 * The session-level access mode a harness adapter enforces. Re-exported so
 * that the wire shape and the modes a harness declares support for
 * cannot drift apart.
 */
export { AccessMode };

/**
 * The longest list a single user setting may hold. The two that are lists, the
 * mutes and the onboarding steps, are both short by nature and are replaced
 * whole on every write, so one generous bound covers them.
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

/**
 * The workspace a thread opens in, unless the draft chooses another. There are
 * two values, not three. A former third value, `none`, could never be read
 * back as itself: a project with repos does not offer "no workspace" at all
 * (spec 14 §The composer), and a project without repos offers nothing else.
 * So a stored `none` always behaved as unset. Nothing is migrated: a row that
 * still holds `none` fails to decode and is treated as unset, which is how it
 * already behaved.
 */
export const ThreadWorkspace = Schema.Literals(["primary", "ephemeral"]);

export type ThreadWorkspace = Schema.Schema.Type<typeof ThreadWorkspace>;

/** How much a thread row in the sidebar shows. */
export const ThreadRows = Schema.Literals(["meta", "plain"]);

export type ThreadRows = Schema.Schema.Type<typeof ThreadRows>;

/**
 * The model's slug in a Provider Account's model list. It is at most as long
 * as the protocol allows a model name to be, so a name that fits here can
 * always be sent to a runner.
 */
export const ModelSlug = Schema.String.check(Schema.isBetweenLength(1, MAX_FACT_LENGTH));

/**
 * A model from a Provider Account, run in one harness. `harnessId` left out
 * means the account's default harness.
 */
export const ProviderAccountModel = closedStruct({
  providerAccountId: Id,
  harnessId: Schema.optionalKey(Schema.String),
  model: ModelSlug,
});

export type ProviderAccountModel = Schema.Schema.Type<typeof ProviderAccountModel>;

/** A model from a Provider Account in a named harness: `ProviderAccountModel` with the harness worked out. */
export const ProviderAccountHarnessModel = closedStruct({
  providerAccountId: Id,
  harnessId: Schema.String,
  model: ModelSlug,
});

export type ProviderAccountHarnessModel = Schema.Schema.Type<typeof ProviderAccountHarnessModel>;

/**
 * Which model makes text generations: small model calls such as naming a
 * Thread (spec 06 section 14).
 *
 * - `automatic`: the first Provider Account whose Provider suggests a text
 *   generation model, and that can run somewhere now, in its default harness.
 *   With no such account, text generation is off.
 * - `off`: nothing makes text generations.
 * - an account, optionally a harness, and a model: that model from that
 *   account, and never another. A call that cannot run there fails rather
 *   than switching account.
 *
 * Unset reads as `automatic`.
 */
export const TextGenerationModel = Schema.Union([
  Schema.Literals(["automatic", "off"]),
  ProviderAccountModel,
]);

export type TextGenerationModel = Schema.Schema.Type<typeof TextGenerationModel>;

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
    /**
     * The spawn bound of every start trigger whose source sets none. Unset
     * reads as `DEFAULT_SPAWN_BOUND`, 30 runs per hour.
     */
    "spawnBound.default": SpawnBound,
    /** Which model makes text generations. Unset reads as `automatic`. */
    "textGeneration.model": TextGenerationModel,
  },
  user: {
    /** The IANA zone the user reads times in, chosen during setup. */
    timezone: Timezone,
    "notifications.muted": atMost(MuteKey, MAX_SETTING_LIST),
    "lastChecked.checkin": Timestamp,
    "lastChecked.notifications": Timestamp,
    "onboarding.completedSteps": atMost(Schema.NonEmptyString, MAX_SETTING_LIST),
    "thread.providerAccountId": Id,
    /** `null` runs a new Thread in the account's default harness. */
    "thread.harnessId": Schema.NullOr(Schema.NonEmptyString),
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
