/**
 * Intake's source tabs, which every view draws in its bar.
 */
import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildIntakeTabs, type IntakeTab, type PluginIdentity } from "@hercule/client-core";
import type { Signal } from "@hercule/contract";
import { pluginsQuery, signalsToDoQuery } from "../../app/queries";

/**
 * Returns the tabs of Intake's bar, the plugins they name, and the signals on
 * To do. A tab stays once its plugin has had a signal on To do, so a tab does
 * not vanish under the pointer when its last signal is done.
 *
 * `pressedPluginId` is the tab pressed when the screen opens. Its tab is
 * drawn even when To do holds none of its signals, such as when the user
 * presses it on one view and opens another.
 */
export function useIntakeTabs(pressedPluginId: string | null): {
  readonly tabs: ReadonlyArray<IntakeTab>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly toDo: ReadonlyArray<Signal>;
} {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: toDo } = useSuspenseQuery(signalsToDoQuery(client));
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const [seenSourceIds, setSeenSourceIds] = useState<ReadonlySet<string>>(
    () => new Set(pressedPluginId === null ? [] : [pressedPluginId]),
  );
  const built = buildIntakeTabs(toDo, plugins, seenSourceIds);
  if (built.seenSourceIds !== seenSourceIds) setSeenSourceIds(built.seenSourceIds);
  return { tabs: built.tabs, plugins, toDo };
}
