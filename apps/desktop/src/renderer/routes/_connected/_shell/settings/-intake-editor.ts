import {
  useMutation,
  useMutationState,
  useQueries,
  useQueryClient,
  useSuspenseQuery,
  type Mutation,
  type QueryClient,
} from "@tanstack/react-query";
import {
  applyIntakeChange,
  buildIntakeOverrides,
  readErrorMessage,
  type HerculeClient,
  type IntakeChange,
  type IntakeEditedLevel,
  type IntakeKindList,
} from "@hercule/client-core";
import type { IntakeSettings } from "@hercule/contract";
import { connectionQuery, pluginsQuery } from "../../../../app/queries";

/**
 * How long a finished save stays in the query client, in milliseconds. The
 * app removes a finished mutation at once, but the editor reads a row's error
 * from the latest save of that row, so a failed save must outlive the saves
 * of other rows and the section being left and opened again.
 */
const FINISHED_SAVE_KEPT_MS = 5 * 60_000;

/** What the last save of one row did, which the row shows. */
export interface IntakeRowSave {
  /** Why the save failed, as "Could not save: ...", or `null` when the row's last save did not fail. */
  readonly error: string | null;
  /** Whether the row's last save is still running and takes back the level's choice (Reset). */
  readonly resetting: boolean;
}

/**
 * The Intake settings of a plugin's level or of one Connection's level,
 * which the lists of the section show and save. Reading a Connection's
 * settings takes a request, so the editor can still be reading, or have
 * failed to read.
 */
export type IntakeEditor =
  | { readonly status: "reading" }
  | { readonly status: "unreadable"; readonly message: string }
  | {
      readonly status: "ready";
      /** The level this editor writes: the plugin's own, or one Connection's. */
      readonly level: IntakeEditedLevel;
      /** The saved settings, with every change still saving applied, so a toggle shows its new value at once. */
      readonly settings: IntakeSettings;
      /** Returns what the last save of the kind in `list` did. */
      readonly findRowSave: (list: IntakeKindList, kind: string) => IntakeRowSave;
      /** Saves `change`. */
      readonly save: (change: IntakeChange) => void;
    };

/** One save of this editor, as the query client holds it. */
interface IntakeSave {
  readonly change: IntakeChange;
  readonly pending: boolean;
  /** "Could not save: ..." when the save failed, else `null`. */
  readonly failure: string | null;
}

/**
 * Saves `change` at the plugin's level with `plugin.updateIntake`, built on
 * the plugin as it is in the cache now, and puts the settings the controller
 * returns in the cache. Fails when the plugin is not in the cache, because
 * there is then nothing to build the write on.
 *
 * The controller's push on the `plugin` topic reads the plugin list and every
 * Connection's page again, because a write at the plugin's level changes what
 * each of them resolves to.
 */
const savePluginLevel = async (
  client: HerculeClient,
  queryClient: QueryClient,
  pluginId: string,
  change: IntakeChange,
): Promise<void> => {
  const { queryKey } = pluginsQuery(client);
  const plugin = queryClient.getQueryData(queryKey)?.find(({ id }) => id === pluginId);
  if (plugin === undefined) {
    throw new Error(
      "this plugin's Intake settings are not loaded, so nothing was sent. Open Settings again and retry.",
    );
  }
  const saved = await client.plugin.updateIntake({
    params: { id: pluginId },
    payload: { intake: buildIntakeOverrides(plugin.intake, "plugin", change) },
  });
  queryClient.setQueryData(queryKey, (plugins) =>
    plugins?.map((each) => (each.id === pluginId ? { ...each, intake: saved } : each)),
  );
};

/**
 * Saves `change` at one Connection's level with `connection.update`, built on
 * the Connection as it is in the cache now, and puts the Connection the
 * controller returns in the cache. Fails when the Connection is not in the
 * cache, because there is then nothing to build the write on.
 *
 * The controller's push on the `connection` topic reads the Connection again.
 */
const saveConnectionLevel = async (
  client: HerculeClient,
  queryClient: QueryClient,
  connectionId: string,
  change: IntakeChange,
): Promise<void> => {
  const { queryKey } = connectionQuery(client, connectionId);
  const connection = queryClient.getQueryData(queryKey);
  if (connection === undefined) {
    throw new Error(
      "this Connection's Intake settings are not loaded, so nothing was sent. Pick its segment again and retry.",
    );
  }
  const saved = await client.connection.update({
    params: { id: connectionId },
    payload: { intake: buildIntakeOverrides(connection.intake, "connection", change) },
  });
  queryClient.setQueryData(queryKey, saved);
};

/**
 * Returns the Intake settings of a plugin's level, or of one Connection's
 * level when `connectionId` is given, whose toggles save on every change
 * (spec 17 §Settings, The frame, Saving). The editor reads the settings
 * itself: the plugin's from the plugin list the shell holds, a Connection's
 * from a read of that Connection.
 *
 * - A new value shows at once, while its save runs. Taking a choice back
 *   (Reset) shows nothing at once, because the value the level below gives is
 *   not known here: the row changes when the save ends.
 * - A save sends every choice the level stores, with the change applied. It is
 *   built from the settings in the cache when the save starts, so a save does
 *   not put back a choice that an earlier save changed.
 * - Every save of one plugin or one Connection shares one mutation scope, so
 *   its saves run one after another, in the order they were made.
 * - A failed save puts the toggle back to its saved value. A row shows the
 *   error only while its latest save is the one that failed, so a later save
 *   of the same row, once it runs, replaces the error. The saves are read from
 *   the query client, not kept here, so an error holds when the section is
 *   left and opened again, for `FINISHED_SAVE_KEPT_MS`.
 * - A successful save puts the settings the controller returns in the cache,
 *   so every screen that shows them shows the new value at once. The
 *   controller's push for the write then reads them again.
 */
export function useIntakeEditor(
  client: HerculeClient,
  pluginId: string,
  connectionId: string | undefined,
): IntakeEditor {
  const queryClient = useQueryClient();
  const level: IntakeEditedLevel = connectionId === undefined ? "plugin" : "connection";
  const targetId = connectionId ?? pluginId;
  const plugin = useSuspenseQuery(pluginsQuery(client)).data.find(({ id }) => id === pluginId);
  // The Connection is read only while its segment is shown, so the list of
  // reads is empty for the plugin's level.
  const connectionReads: Array<ReturnType<typeof connectionQuery>> =
    connectionId === undefined ? [] : [connectionQuery(client, connectionId)];
  const [connection] = useQueries({ queries: connectionReads });
  const mutationKey = ["intake-save", level, targetId];
  const saves = useMutationState({
    filters: { mutationKey },
    select: (each: Mutation<void, Error, IntakeChange>): IntakeSave | null =>
      each.state.variables === undefined
        ? null
        : {
            change: each.state.variables,
            pending: each.state.status === "pending",
            failure:
              each.state.status === "error"
                ? `Could not save: ${readErrorMessage(each.state.error)}`
                : null,
          },
  }).filter((save) => save !== null);
  const mutation = useMutation({
    mutationKey,
    gcTime: FINISHED_SAVE_KEPT_MS,
    scope: { id: `intake:${level}:${targetId}` },
    mutationFn: (change: IntakeChange): Promise<void> =>
      connectionId === undefined
        ? savePluginLevel(client, queryClient, pluginId, change)
        : saveConnectionLevel(client, queryClient, connectionId, change),
  });

  const stored = connectionId === undefined ? plugin?.intake : connection?.data?.intake;
  if (stored === undefined) {
    // A plugin missing from the list has no section to draw this editor in,
    // so only a Connection's read can leave the settings missing.
    const readError = connection?.error ?? null;
    return readError === null
      ? { status: "reading" }
      : { status: "unreadable", message: readErrorMessage(readError) };
  }
  return {
    status: "ready",
    level,
    settings: saves
      .filter(({ pending }) => pending)
      .reduce((settings, { change }) => applyIntakeChange(settings, level, change), stored),
    findRowSave: (list, kind) => {
      const latest = saves.findLast(({ change }) => change.list === list && change.kind === kind);
      return {
        error: latest?.failure ?? null,
        resetting: latest?.pending === true && latest.change.on === null,
      };
    },
    save: (change) => {
      mutation.mutate(change);
    },
  };
}
