/**
 * Intake's source tabs, which every view draws in its bar.
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildIntakeTabs,
  countWaitingTrackingRows,
  type IntakeTab,
  type PluginIdentity,
} from "@hercule/client-core";
import { pluginsQuery, signalsToDoQuery } from "../../app/queries";
import { useTrackingRows } from "../../app/tracking";

/**
 * Returns the tabs of Intake's bar and the plugins they name. The tabs come
 * from the plugins' Intake settings and the To do signals, which every view
 * reads, so a switch between views keeps the same tabs (see
 * `buildIntakeTabs`). The rows of Tracking that wait on the user count in
 * All's count.
 *
 * `pressedPluginId` is the tab pressed. Its tab is drawn even when no setting
 * or signal asks for it.
 */
export function useIntakeTabs(pressedPluginId: string | null): {
  readonly tabs: ReadonlyArray<IntakeTab>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
} {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: toDo } = useSuspenseQuery(signalsToDoQuery(client));
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const waitingTrackingRows = countWaitingTrackingRows(useTrackingRows());
  return {
    tabs: buildIntakeTabs(toDo, plugins, pressedPluginId, waitingTrackingRows),
    plugins,
  };
}
