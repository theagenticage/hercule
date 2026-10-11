import { useState } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  applyIntakeChange,
  buildIntakeOverrides,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
  type IntakeChange,
  type IntakeEditedLevel,
} from "@hercule/client-core";
import type { IntakeSettings } from "@hercule/contract";
import { connectionQuery, pluginsQuery } from "../../../../app/queries";

/** What a saved Intake section edits: all Connections of a plugin, or one Connection. */
export type IntakeTarget =
  | { readonly level: "plugin"; readonly pluginId: string }
  | { readonly level: "connection"; readonly connectionId: string };

/** The Intake settings of one target, as its section shows and saves them. */
export interface SavedIntake {
  /** The saved settings, with every change still saving applied, so a toggle shows its new value at once. */
  readonly settings: IntakeSettings;
  /** The message of the last failed save of each row, keyed as `buildIntakeRowKey` does. */
  readonly errors: ReadonlyMap<string, string>;
  /** Saves `change`. */
  readonly save: (change: IntakeChange) => void;
}

/**
 * Returns the key that tells one row apart from another in `SavedIntake.errors`:
 * the list the row belongs to, and its kind.
 */
export const buildIntakeRowKey = (change: Pick<IntakeChange, "list" | "kind">): string =>
  `${change.list}:${change.kind}`;

/**
 * Saves `change` at the plugin's level with `plugin.updateIntake`, built on
 * the plugin as it is in the cache now, and puts the settings the controller
 * returns in the cache. Saves nothing when the plugin is gone from the list.
 * Then reads the plugins again, and every Connection, because a write at the
 * plugin's level changes what each of them resolves to.
 */
const savePluginLevel = async (
  client: HerculeClient,
  queryClient: QueryClient,
  pluginId: string,
  change: IntakeChange,
): Promise<void> => {
  const { queryKey } = pluginsQuery(client);
  const plugin = queryClient.getQueryData(queryKey)?.find(({ id }) => id === pluginId);
  if (plugin === undefined) return;
  const saved = await client.plugin.updateIntake({
    params: { id: pluginId },
    payload: { intake: buildIntakeOverrides(plugin.intake, "plugin", change) },
  });
  queryClient.setQueryData(queryKey, (plugins) =>
    plugins?.map((each) => (each.id === pluginId ? { ...each, intake: saved } : each)),
  );
  await Promise.all([
    queryClient.invalidateQueries({ queryKey }),
    queryClient.invalidateQueries({ queryKey: queryKeys.connection() }),
  ]);
};

/**
 * Saves `change` at one Connection's level with `connection.update`, built on
 * the Connection as it is in the cache now, and puts the Connection the
 * controller returns in the cache. Saves nothing when the Connection is not
 * in the cache. Then reads the Connection again.
 */
const saveConnectionLevel = async (
  client: HerculeClient,
  queryClient: QueryClient,
  connectionId: string,
  change: IntakeChange,
): Promise<void> => {
  const { queryKey } = connectionQuery(client, connectionId);
  const connection = queryClient.getQueryData(queryKey);
  if (connection === undefined) return;
  const saved = await client.connection.update({
    params: { id: connectionId },
    payload: { intake: buildIntakeOverrides(connection.intake, "connection", change) },
  });
  queryClient.setQueryData(queryKey, saved);
  await queryClient.invalidateQueries({ queryKey });
};

/**
 * Returns the Intake settings of a plugin's level or of one Connection, whose
 * toggles save on every change (spec 17 §Settings, The frame, Saving).
 * `stored` is the saved value, which the caller reads from the cache.
 *
 * - A new value shows at once, while its save runs. Taking a choice back
 *   (Reset) shows nothing at once, because the value the level below gives is
 *   not known here: the row changes when the save ends.
 * - A save sends every choice the level stores, with the change applied. It is
 *   built from the settings in the cache when the save starts, so a save does
 *   not put back a choice that an earlier save changed.
 * - Every save of one plugin or one Connection shares one mutation scope, so
 *   its saves run one after another, in the order they were made.
 * - A failed save puts the toggle back to its saved value. The error is kept
 *   for the row that failed, and stays until the next change of that row.
 *   The mutation cache drops a failed mutation nothing observes, so each
 *   error is kept here when it happens.
 * - A successful save puts the settings the controller returns in the cache,
 *   so every screen that shows them shows the new value at once, and then
 *   reads them again. The save counts as running until that read answers, so
 *   the toggle never shows the old value in between, and a save queued behind
 *   it builds on the settings that read returned.
 */
export function useSavedIntake(
  client: HerculeClient,
  target: IntakeTarget,
  stored: IntakeSettings,
): SavedIntake {
  const queryClient = useQueryClient();
  const level: IntakeEditedLevel = target.level;
  const targetId = target.level === "plugin" ? target.pluginId : target.connectionId;
  const mutationKey = ["saved-intake", level, targetId];
  const pending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (each) => each.state.variables as IntakeChange,
  });
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const mutation = useMutation({
    mutationKey,
    scope: { id: `intake:${level}:${targetId}` },
    mutationFn: (change: IntakeChange): Promise<void> =>
      target.level === "plugin"
        ? savePluginLevel(client, queryClient, target.pluginId, change)
        : saveConnectionLevel(client, queryClient, target.connectionId, change),
    onError: (error, change) => {
      setErrors((current) =>
        new Map(current).set(
          buildIntakeRowKey(change),
          `Could not save: ${readErrorMessage(error)}`,
        ),
      );
    },
  });
  return {
    settings: pending.reduce(
      (settings, change) => applyIntakeChange(settings, level, change),
      stored,
    ),
    errors,
    save: (change) => {
      setErrors((current) => {
        const next = new Map(current);
        next.delete(buildIntakeRowKey(change));
        return next;
      });
      mutation.mutate(change);
    },
  };
}
