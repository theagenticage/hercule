/**
 * How Settings > Intake reads the Intake settings of a plugin and of its
 * Connections: which plugins get a section, which Connections the section's
 * segments switch between, what a row says about where its value comes from,
 * when it offers Reset, and the payload a change sends. Spec 17 §Settings
 * owns the section, and spec 05 §8.2 owns what the three levels mean.
 *
 * The controller works out the levels, so nothing here merges them: a row
 * arrives with the value in effect and the level it comes from. These
 * functions only decide what to show and what to write.
 */
import type {
  Connection,
  IntakeOverrides,
  IntakeSettingLevel,
  IntakeSettings,
  PluginDetail,
} from "@hercule/contract";
import { readJsonObject } from "./json-shape";

/** The two lists of kinds a plugin's Intake settings hold. */
export type IntakeKindList = keyof IntakeOverrides;

/**
 * The level a segment edits: the plugin's own, for all its Connections, or
 * one Connection's. The controller also reports `default`, which no segment
 * edits.
 */
export type IntakeEditedLevel = Exclude<IntakeSettingLevel, "default">;

/** What a row of either list holds: the kind, and the value in effect with the level it comes from. */
export interface IntakeKindValue {
  readonly kind: string;
  readonly on: boolean;
  readonly level: IntakeSettingLevel;
}

/**
 * One change the user makes to a kind: a new value, or `null` to take back
 * the choice made at the edited level, so the kind follows the level below.
 */
export interface IntakeChange {
  readonly list: IntakeKindList;
  readonly kind: string;
  readonly on: boolean | null;
}

/**
 * One segment of the control above a plugin's lists: all the plugin's
 * Connections when `connectionId` is `undefined`, else the one Connection it
 * names.
 */
export interface IntakeSegment {
  readonly connectionId: string | undefined;
  readonly label: string;
}

/**
 * Returns the plugins that get a section on Settings > Intake: those that
 * declare at least one signal kind or event kind, in the order given.
 */
export const listPluginsWithIntake = (
  plugins: ReadonlyArray<PluginDetail>,
): ReadonlyArray<PluginDetail> =>
  plugins.filter(({ intake }) => intake.eventKinds.length > 0 || intake.signalKinds.length > 0);

/**
 * Returns the Connections whose type the plugin declares, in the order
 * given. The plugin declares a type as a `connection-type` contribution, and
 * a Connection names its type, so the two are matched on that name. A type's
 * name is never parsed for the plugin's id.
 */
const listPluginConnections = (
  plugin: PluginDetail,
  connections: ReadonlyArray<Connection>,
): ReadonlyArray<Connection> => {
  const types = new Set(
    plugin.contributions
      .filter((contribution) => contribution.extensionPoint === "connection-type")
      .map((contribution) => readJsonObject(contribution.definition)?.["type"]),
  );
  return connections.filter((connection) => types.has(connection.type));
};

/**
 * Returns the segments of the control above a plugin's lists: "All <plugin>
 * connections", then one per Connection of the plugin. A plugin with no
 * Connection has nothing to switch between, so the list is empty and the
 * section draws no control.
 */
export const listIntakeSegments = (
  plugin: PluginDetail,
  connections: ReadonlyArray<Connection>,
): ReadonlyArray<IntakeSegment> => {
  const own = listPluginConnections(plugin, connections);
  if (own.length === 0) return [];
  return [
    { connectionId: undefined, label: `All ${plugin.displayName} connections` },
    ...own.map(({ id, label }): IntakeSegment => ({ connectionId: id, label })),
  ];
};

/**
 * Returns the line under a row that says where its value comes from, such as
 * "Off · all GitHub connections", or `null` for a value that is the plugin's
 * own default, which needs no line.
 */
export const describeIntakeSource = (
  row: Pick<IntakeKindValue, "on" | "level">,
  pluginName: string,
): string | null => {
  if (row.level === "default") return null;
  const value = row.on ? "On" : "Off";
  return row.level === "plugin"
    ? `${value} · all ${pluginName} connections`
    : `${value} · this connection`;
};

/**
 * Checks whether a row offers Reset: its value is a choice made at the level
 * the segment edits, so taking it back changes what the row shows. A choice
 * made at another level is not the segment's to take back.
 */
export const canResetIntakeRow = (
  row: Pick<IntakeKindValue, "level">,
  editedLevel: IntakeEditedLevel,
): boolean => row.level === editedLevel;

/** Returns the choices stored at `editedLevel`: the rows whose value comes from that level. */
const readStoredChoices = (
  rows: ReadonlyArray<IntakeKindValue>,
  editedLevel: IntakeEditedLevel,
): Record<string, boolean> =>
  Object.fromEntries(
    rows.filter((row) => row.level === editedLevel).map((row) => [row.kind, row.on]),
  );

/**
 * Builds the payload that writes `change` at `editedLevel`: every choice the
 * level already stores, with the change applied. The write replaces the
 * level's choices whole, so the choices it keeps must be sent again.
 *
 * - A new value sets the kind's choice.
 * - `null` leaves the kind out, so the level makes no choice for it.
 */
export const buildIntakeOverrides = (
  settings: IntakeSettings,
  editedLevel: IntakeEditedLevel,
  change: IntakeChange,
): IntakeOverrides => {
  const stored = {
    eventKinds: readStoredChoices(settings.eventKinds, editedLevel),
    signalKinds: readStoredChoices(settings.signalKinds, editedLevel),
  };
  const kept = Object.fromEntries(
    Object.entries(stored[change.list]).filter(([kind]) => kind !== change.kind),
  );
  return {
    ...stored,
    [change.list]: change.on === null ? kept : { ...kept, [change.kind]: change.on },
  };
};

/**
 * Returns `settings` as they read while `change` is still saving: the kind
 * shows the new value, as a choice of `editedLevel`. A change that takes a
 * choice back returns `settings` unchanged, because the value the level
 * below gives is not known here; the row keeps its value until the save ends.
 */
export const applyIntakeChange = (
  settings: IntakeSettings,
  editedLevel: IntakeEditedLevel,
  change: IntakeChange,
): IntakeSettings => {
  if (change.on === null) return settings;
  const on = change.on;
  const write = <Row extends IntakeKindValue>(rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
    rows.map((row) => (row.kind === change.kind ? { ...row, on, level: editedLevel } : row));
  return change.list === "eventKinds"
    ? { ...settings, eventKinds: write(settings.eventKinds) }
    : { ...settings, signalKinds: write(settings.signalKinds) };
};
