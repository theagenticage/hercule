/**
 * Intake settings: which of a plugin's event kinds triage may read, and which
 * of its signal kinds are raised.
 *
 * A value can be set at three levels, each storing only the kinds where it
 * differs from the level below:
 *
 * 1. `default`: what the plugin declares in code;
 * 2. `plugin`: the user's choice for the plugin, for all its Connections;
 * 3. `connection`: the user's choice for one Connection.
 *
 * Writes send `IntakeOverrides`, the stored entries of one level. Reads return
 * `IntakeSettings`, the value in effect for every kind with the level it comes
 * from. The server works out the levels, so no client merges them (spec 05
 * section 8.2).
 */
import { Schema } from "effect";
import { closedStruct } from "../closed";
import { EventKind } from "./event";
import { SignalKind } from "./signal";

/**
 * The most entries one level can store per switch. A plugin declares a few
 * dozen kinds at most, so the bound only stops a request that is not a real
 * choice from filling a row.
 */
export const MAX_INTAKE_OVERRIDES = 256;

/**
 * The user's choices at one level, replaced whole on every write. Each map
 * goes from a kind to on (`true`) or off (`false`). The server drops an entry
 * equal to the value the level below gives, and refuses a kind the plugin does
 * not declare.
 */
export const IntakeOverrides = closedStruct({
  /** Event kind to whether triage may read its events. */
  eventKinds: Schema.Record(EventKind, Schema.Boolean).check(
    Schema.isMaxProperties(MAX_INTAKE_OVERRIDES),
  ),
  /** Signal kind to whether it is raised. */
  signalKinds: Schema.Record(SignalKind, Schema.Boolean).check(
    Schema.isMaxProperties(MAX_INTAKE_OVERRIDES),
  ),
});

export type IntakeOverrides = Schema.Schema.Type<typeof IntakeOverrides>;

/** The level a value in effect comes from. */
export const IntakeSettingLevel = Schema.Literals(["default", "plugin", "connection"]);

export type IntakeSettingLevel = Schema.Schema.Type<typeof IntakeSettingLevel>;

/**
 * One event kind and whether triage may read its events. A plugin declares
 * no label for an event kind, so its description is the only text.
 */
export const EventKindIntakeSetting = Schema.Struct({
  kind: EventKind,
  description: Schema.String,
  on: Schema.Boolean,
  level: IntakeSettingLevel,
});

export type EventKindIntakeSetting = Schema.Schema.Type<typeof EventKindIntakeSetting>;

/** One signal kind and whether it is raised. */
export const SignalKindIntakeSetting = Schema.Struct({
  kind: SignalKind,
  label: Schema.String,
  description: Schema.String,
  on: Schema.Boolean,
  level: IntakeSettingLevel,
});

export type SignalKindIntakeSetting = Schema.Schema.Type<typeof SignalKindIntakeSetting>;

/**
 * The value in effect for every kind a plugin declares, in the order the
 * plugin declares them. Both lists are empty for a plugin with no event source.
 */
export const IntakeSettings = Schema.Struct({
  eventKinds: Schema.Array(EventKindIntakeSetting),
  signalKinds: Schema.Array(SignalKindIntakeSetting),
});

export type IntakeSettings = Schema.Schema.Type<typeof IntakeSettings>;
